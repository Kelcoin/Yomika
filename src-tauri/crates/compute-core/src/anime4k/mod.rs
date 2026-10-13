//! Anime4K upscaling.
//!
//! Anime4K is not a model: it is a chain of fragment shaders written for mpv's
//! `--glsl-shaders` option. Each pass reads one or more textures, writes a
//! texture, and declares its output size with `//!WIDTH` / `//!HEIGHT`; a later
//! pass reads what an earlier one saved. The reference port in
//! `docs/mihon_img_upscale-master` does the same thing through an OpenGL ES
//! context.
//!
//! 这一份住在**计算核心**里（docs/71 §11 Task 2：纯算法随核心走），不认 Tauri、
//! 不认数据库：解析器只吃 GLSL 文本，解释器只吃 RGBA 缓冲、尺寸和一块取消牌。
//! 宿主与 worker 因此编的是**同一份**解析结果——同一串 GLSL 在两边解出两个网络
//! 这种事故没有发生的余地。
//!
//! 执行有两条路：这里的 CPU 解释器（任何目标都能跑，也是 GPU 那条路的参照实现）
//! 与 [`gpu`] 子模块里按 feature 打开的 GPU 执行体（WGSL 由同一份解析结果生成）。
//! 没有 GPU、没开 feature 或开了却拿不到设备时，回落的是这一条。
//!
//! The shaders are shipped verbatim under `src-tauri/resources/anime4k/` and compiled into
//! a small program at load time. Only the subset of the shader language that
//! those files use is understood — a `vec4 hook()` built from `mat4(...) * <tap>`
//! terms, or the depth-to-space pass — and anything else is an error rather than
//! a guess. The subset is fixed because the shader files are pinned; a parser
//! that silently ignored what it did not recognise would produce a page that
//! looks upscaled and is not.

use std::collections::HashMap;

use crate::error::ComputeError;
use crate::upscale::{UpscaleEngine, DEFAULT_TILE_PADDING};

// GPU 执行体：与下面这份 CPU 解释器共用**同一份**解析结果（`compile_chain`），
// 只是把每个 pass 翻成一条 WGSL 计算管道。门在 feature 后面，没开就只剩 CPU。
#[cfg(feature = "anime4k-gpu")]
pub mod gpu;

// 相对路径按**本源文件**算：这一份住在 `src-tauri/crates/compute-core/src/anime4k/`，
// 钉住的 GLSL 仍在 `src-tauri/resources/anime4k/`（随仓库、随每个编它的二进制走进来，
// 所以宿主与 worker 解的是同一份文本）。
const UPSCALE_CNN_X2_M: &str =
    include_str!("../../../../resources/anime4k/Anime4K_Upscale_CNN_x2_M.glsl");
const UPSCALE_CNN_X2_VL: &str =
    include_str!("../../../../resources/anime4k/Anime4K_Upscale_CNN_x2_VL.glsl");
const RESTORE_CNN_VL: &str =
    include_str!("../../../../resources/anime4k/Anime4K_Restore_CNN_VL.glsl");
const CLAMP_HIGHLIGHTS: &str =
    include_str!("../../../../resources/anime4k/Anime4K_Clamp_Highlights.glsl");

/// One named Anime4K chain, offered to the reader as a built-in upscaler.
pub struct Anime4kPreset {
    /// Id the reader stores in preferences and sends back with each page.
    pub id: &'static str,
    /// Version reported by `inference_list_models` and recorded in the enhanced
    /// rendition key. Bump it whenever `shaders` changes so cached pages from the
    /// previous chain are not served as if they were this one's output.
    pub version: &'static str,
    /// Output factor. Checked against the parsed chain at load time; a mismatch
    /// means the shader files changed under the presets.
    pub scale: u32,
    shaders: &'static [&'static str],
}

/// The chains. `M` is the small network and the default; `VL` is the wide one
/// and costs roughly four times the arithmetic for a sharper result; `ultra`
/// runs the wide restore network before the wide upscaler, which is mihon's
/// Ultra mode and costs about twice the wide chain.
///
/// Every chain starts with `Clamp_Highlights`, which is how upstream uses it:
/// two statistics passes read the source image, and a third pass hooking
/// `PREKERNEL` clamps the luma of the *finished* image against those statistics,
/// so it has to run after the upscalers even though the file is listed first.
pub static ANIME4K_PRESETS: &[Anime4kPreset] = &[
    Anime4kPreset {
        id: "anime4k",
        version: "2",
        scale: 2,
        shaders: &[CLAMP_HIGHLIGHTS, UPSCALE_CNN_X2_M],
    },
    Anime4kPreset {
        id: "anime4k-hq",
        version: "2",
        scale: 2,
        shaders: &[CLAMP_HIGHLIGHTS, UPSCALE_CNN_X2_VL],
    },
    Anime4kPreset {
        id: "anime4k-ultra",
        version: "1",
        scale: 2,
        shaders: &[CLAMP_HIGHLIGHTS, RESTORE_CNN_VL, UPSCALE_CNN_X2_VL],
    },
];

/// Pixel budget for a built-in chain. The same ceiling the ONNX path uses when a
/// manifest does not lower it.
pub const ANIME4K_MAX_PIXELS: usize = 64_000_000;

pub fn preset_by_id(id: &str) -> Option<&'static Anime4kPreset> {
    ANIME4K_PRESETS.iter().find(|preset| preset.id == id)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Activation {
    Identity,
    /// `max(x, 0.0)`, the positive half of a leaky ReLU pair.
    Relu,
    /// `max(-x, 0.0)`, the negative half. Anime4K keeps both halves as separate
    /// input channels; throwing one away would halve the information the next
    /// layer has to work with.
    NegRelu,
}

impl Activation {
    fn apply(self, value: [f32; 4]) -> [f32; 4] {
        match self {
            Self::Identity => value,
            Self::Relu => value.map(|channel| channel.max(0.0)),
            Self::NegRelu => value.map(|channel| (-channel).max(0.0)),
        }
    }
}

/// One `mat4 * tap` term of a convolution pass.
struct Term {
    /// The 16 values in `mat4(...)` order, which GLSL reads column by column.
    weights: [f32; 16],
    texture: usize,
    activation: Activation,
    /// Tap offset in the source texture's pixels.
    offset: [f32; 2],
}

/// `//!WIDTH` / `//!HEIGHT` are postfix ("RPN") expressions: `MAIN.w 2 *` is
/// twice MAIN's width.
enum SizeToken {
    Width(usize),
    Height(usize),
    Number(f32),
    Multiply,
    Add,
    Divide,
}

enum PassKind {
    Conv {
        terms: Vec<Term>,
        bias: [f32; 4],
        /// A texture added on top of the result, as in Anime4K's residual
        /// connections.
        residual: Option<usize>,
    },
    /// Packs a 2x2 block of the source's channels into one output pixel, which is
    /// what turns the network's per-pixel convolution result into an x2 image.
    DepthToSpace {
        sources: Vec<usize>,
        residual: Option<usize>,
    },
    /// One direction of a separable maximum-luma window: `kernel` samples along
    /// `horizontal`, taking the largest luma (or the largest first channel when
    /// the source already holds one). `Anime4K_Clamp_Highlights` runs it
    /// horizontally and then vertically to build a 5x5 statistic.
    MaxLuma {
        source: usize,
        kernel: u32,
        horizontal: bool,
        luma: bool,
    },
    /// Lowers the source's luma to the ceiling the statistics pass found and
    /// subtracts the difference from every channel, which is Anime4K's de-ring
    /// step.
    ClampLuma { source: usize, stats: usize },
}

/// Which stage of mpv's pipeline a pass hooks.
///
/// mpv runs every `MAIN` hook before every `PREKERNEL` hook, whatever order the
/// files were listed in — and Anime4K's de-ring pass depends on that: it clamps
/// the finished image, and clamping the source image against its own 5x5 maximum
/// would always be a no-op.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    Main,
    Post,
}

struct Pass {
    output: usize,
    width: Vec<SizeToken>,
    height: Vec<SizeToken>,
    kind: PassKind,
    stage: Stage,
}

/// A compiled chain: texture slots by name, the passes in order, and the
/// receptive field the tiler has to keep around each tile.
pub struct Program {
    slots: Vec<String>,
    passes: Vec<Pass>,
    output: usize,
    scale: u32,
    padding: u32,
}

impl Program {
    fn slot_name(&self, slot: usize) -> &str {
        self.slots.get(slot).map(String::as_str).unwrap_or("?")
    }
}

enum MacroDef {
    /// `#define go_0(x_off, y_off) (...)`
    Function { args: Vec<String>, body: String },
    /// `#define g_0 (...)`
    Object { body: String },
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Compiler {
    slots: Vec<String>,
    by_name: HashMap<String, usize>,
    passes: Vec<Pass>,
}

impl Compiler {
    fn new() -> Self {
        let mut compiler = Self::default();
        // Slot zero is the image the chain starts from. mpv calls it MAIN.
        compiler.intern("MAIN");
        compiler
    }

    fn intern(&mut self, name: &str) -> usize {
        if let Some(&slot) = self.by_name.get(name) {
            return slot;
        }
        let slot = self.slots.len();
        self.slots.push(name.to_string());
        self.by_name.insert(name.to_string(), slot);
        slot
    }

    fn add_shader(&mut self, source: &str) -> Result<(), ComputeError> {
        for block in split_passes(source)? {
            self.add_pass(&block)?;
        }
        Ok(())
    }

    fn add_pass(&mut self, block: &str) -> Result<(), ComputeError> {
        let mut hook = String::new();
        let mut save: Option<String> = None;
        let mut width: Option<String> = None;
        let mut height: Option<String> = None;
        let mut binds: Vec<String> = Vec::new();
        let mut defines: HashMap<String, MacroDef> = HashMap::new();
        let mut body = String::new();

        for line in block.lines() {
            let trimmed = line.trim();
            if let Some(directive) = trimmed.strip_prefix("//!") {
                let (name, value) = match directive.find(char::is_whitespace) {
                    Some(index) => (&directive[..index], directive[index..].trim()),
                    None => (directive, ""),
                };
                match name {
                    "DESC" | "COMPONENTS" => {}
                    "HOOK" => hook = value.to_string(),
                    "BIND" => binds.push(value.to_string()),
                    "SAVE" => save = Some(value.to_string()),
                    "WIDTH" => width = Some(value.to_string()),
                    "HEIGHT" => height = Some(value.to_string()),
                    // `//!WHEN` gates a pass on the output size, which is exactly
                    // the x2 case these chains are built for; mpv's own Anime4K
                    // configs run them unconditionally for an upscale.
                    "WHEN" => {}
                    other => {
                        return Err(unsupported(format!("unknown shader directive //!{other}")))
                    }
                }
            } else {
                // Strip line comments before looking for a define or keeping the
                // code: `#define KERNELSIZE 5 //Kernel size, ...` has to read as
                // `5`, and the de-ring pass comments its loop body.
                let code = line.split("//").next().unwrap_or("").trim_end();
                if let Some(define) = code.trim_start().strip_prefix("#define") {
                    let (name, definition) = parse_define(define)?;
                    defines.insert(name, definition);
                } else {
                    body.push_str(code);
                    body.push('\n');
                }
            }
        }

        // A hook names either a texture this chain has (MAIN, or something a
        // previous pass saved) or a pipeline stage such as PREKERNEL. Our chain
        // has exactly one image, so both resolve to it — but a stage name must
        // not be interned as a texture, and it means the pass runs after every
        // MAIN pass rather than in file order.
        let (hooked, stage) = if hook.is_empty() {
            (0, Stage::Main)
        } else if let Some(&slot) = self.by_name.get(&hook) {
            (slot, Stage::Main)
        } else if hook == "HOOKED" {
            (0, Stage::Main)
        } else {
            (0, Stage::Post)
        };
        // `//!BIND HOOKED` means "whatever this pass hooks", so it stands for the
        // hooked texture's own name when the bind list is checked.
        let hooked_name = self.slots[hooked].clone();
        let binds: Vec<String> = binds
            .into_iter()
            .map(|bind| {
                if bind == "HOOKED" {
                    hooked_name.clone()
                } else {
                    bind
                }
            })
            .collect();

        let body = extract_hook_body(&body)?;
        let kind = if body.contains("for") && body.contains("max(") {
            parse_max_luma(&body, &defines, &self.by_name, hooked)?
        } else if body.contains("current_luma") {
            parse_clamp_luma(&body, &self.by_name, hooked)?
        } else if body.contains("fract(") {
            parse_depth_to_space(&body, &self.by_name, hooked)?
        } else {
            parse_conv(&body, &defines, &self.by_name, hooked)?
        };
        self.validate_binds(&kind, &binds)?;

        // A pass that saves nothing overwrites the texture it hooks, which is how
        // Anime4K's de-ring pass hands its result back. Only that pass is allowed
        // to omit the directive: a convolution without one is a parse that lost
        // the target, not a shader that writes in place.
        let output = match save {
            Some(save) => self.intern(&save),
            None if matches!(kind, PassKind::ClampLuma { .. }) => {
                if hook.is_empty() {
                    return Err(unsupported(
                        "shader pass writes in place without hooking anything".to_string(),
                    ));
                }
                hooked
            }
            None => return Err(unsupported("shader pass has no //!SAVE target".to_string())),
        };

        // A pass without an explicit size keeps the size of the texture it hooks.
        let width = match &width {
            Some(expression) => parse_size(expression, &self.by_name)?,
            None => vec![SizeToken::Width(hooked)],
        };
        let height = match &height {
            Some(expression) => parse_size(expression, &self.by_name)?,
            None => vec![SizeToken::Height(hooked)],
        };
        self.passes.push(Pass {
            output,
            width,
            height,
            kind,
            stage,
        });
        Ok(())
    }

    /// Every texture a pass reads has to appear in its `//!BIND` list. mpv uses
    /// the list to work out the dependencies; here it is a check that the parser
    /// resolved the same names the shader author declared.
    fn validate_binds(&self, kind: &PassKind, binds: &[String]) -> Result<(), ComputeError> {
        let mut referenced: Vec<usize> = match kind {
            PassKind::Conv {
                terms,
                residual,
                bias: _,
            } => {
                let mut slots: Vec<usize> = terms.iter().map(|term| term.texture).collect();
                slots.extend(residual.iter().copied());
                slots
            }
            PassKind::DepthToSpace { sources, residual } => {
                let mut slots = sources.clone();
                slots.extend(residual.iter().copied());
                slots
            }
            PassKind::MaxLuma { source, .. } => vec![*source],
            PassKind::ClampLuma { source, stats } => vec![*source, *stats],
        };
        referenced.sort_unstable();
        referenced.dedup();
        for slot in referenced {
            let name = self.slots[slot].as_str();
            if !binds.iter().any(|bind| bind == name) {
                return Err(unsupported(format!(
                    "pass reads {name}, which its //!BIND list does not declare"
                )));
            }
        }
        Ok(())
    }

    /// Resolves sizes and the receptive field by walking the chain, and refuses
    /// to hand back a chain whose output factor is not the one the preset claims.
    fn finish(mut self, expected_scale: u32) -> Result<Program, ComputeError> {
        const NOMINAL: u32 = 8;
        // mpv runs every MAIN hook before every PREKERNEL hook, so the order the
        // files were listed in is not quite the order they execute in. The sort
        // is stable, so passes inside a stage keep the file's order.
        self.passes.sort_by_key(|pass| match pass.stage {
            Stage::Main => 0,
            Stage::Post => 1,
        });
        let mut sizes: Vec<Option<(u32, u32)>> = vec![None; self.slots.len()];
        sizes[0] = Some((NOMINAL, NOMINAL));
        for pass in &self.passes {
            let width = eval_size(&pass.width, &sizes)?;
            let height = eval_size(&pass.height, &sizes)?;
            if width == 0 || height == 0 {
                return Err(unsupported("shader pass produced an empty texture".into()));
            }
            sizes[pass.output] = Some((width, height));
        }
        let output = self
            .passes
            .last()
            .map(|pass| pass.output)
            .ok_or_else(|| unsupported("shader chain has no passes".into()))?;
        let (width, height) = sizes[output].ok_or_else(|| unsupported("missing output".into()))?;
        if width % NOMINAL != 0 || height % NOMINAL != 0 || width / NOMINAL != height / NOMINAL {
            return Err(unsupported(
                "shader chain does not scale both axes by a whole factor".into(),
            ));
        }
        let scale = width / NOMINAL;
        if scale != expected_scale {
            return Err(unsupported(format!(
                "shader chain scales x{scale}, but the preset declares x{expected_scale}"
            )));
        }

        // The receptive field in source pixels: a 3x3 layer widens it by one, and
        // the depth-to-space pass doubles what the convolutions accumulated
        // before the residual is added at the output scale.
        let mut radius = vec![0_u32; self.slots.len()];
        for pass in &self.passes {
            let pass_radius = match &pass.kind {
                PassKind::Conv { terms, .. } => terms
                    .iter()
                    .map(|term| {
                        radius[term.texture]
                            + term.offset[0].abs().max(term.offset[1].abs()).ceil() as u32
                    })
                    .max()
                    .unwrap_or(0),
                PassKind::DepthToSpace { sources, residual } => {
                    let from_sources = sources
                        .iter()
                        .map(|&slot| radius[slot].saturating_mul(2))
                        .max()
                        .unwrap_or(0);
                    let from_residual = residual.map(|slot| radius[slot]).unwrap_or(0);
                    from_sources.max(from_residual)
                }
                PassKind::MaxLuma { source, kernel, .. } => {
                    // Conservative on purpose: the two passes of a separable max
                    // are treated as adding up, which asks for a little more
                    // margin than the window actually needs.
                    radius[*source] + kernel / 2
                }
                PassKind::ClampLuma { source, stats } => radius[*source].max(radius[*stats]),
            };
            radius[pass.output] = pass_radius;
        }
        let padding = radius[output].div_ceil(scale).max(DEFAULT_TILE_PADDING);

        Ok(Program {
            slots: self.slots,
            passes: self.passes,
            output,
            scale,
            padding,
        })
    }
}

/// Splits a shader file into its passes. Anime4K's generated shaders start every
/// pass with `//!DESC`; anything before the first one is the licence header.
fn split_passes(source: &str) -> Result<Vec<String>, ComputeError> {
    let mut blocks: Vec<String> = Vec::new();
    let mut current: Option<String> = None;
    for line in source.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("//!DESC") {
            if let Some(block) = current.take() {
                blocks.push(block);
            }
            current = Some(format!("//!DESC{rest}\n"));
            continue;
        }
        match current.as_mut() {
            Some(block) => {
                block.push_str(line);
                block.push('\n');
            }
            None => {
                if trimmed.is_empty() || trimmed.starts_with("//") {
                    continue;
                }
                return Err(unsupported(format!(
                    "shader content before the first //!DESC: {trimmed}"
                )));
            }
        }
    }
    if let Some(block) = current {
        blocks.push(block);
    }
    if blocks.is_empty() {
        return Err(unsupported("shader file has no passes".into()));
    }
    Ok(blocks)
}

/// Parses the text after `#define`, with any trailing `//` comment already
/// removed by the caller.
fn parse_define(declaration: &str) -> Result<(String, MacroDef), ComputeError> {
    let rest = declaration.trim();
    let name_end = rest
        .find(|character: char| character == '(' || character.is_whitespace())
        .ok_or_else(|| unsupported(format!("define without a body: {rest}")))?;
    let name = rest[..name_end].to_string();
    let after = &rest[name_end..];
    if let Some(args) = after.strip_prefix('(') {
        let close = find_matching(after, 0)?;
        let args = args[..close - 1]
            .split(',')
            .map(|arg| arg.trim().to_string())
            .collect();
        Ok((
            name,
            MacroDef::Function {
                args,
                body: after[close + 1..].trim().to_string(),
            },
        ))
    } else {
        Ok((
            name,
            MacroDef::Object {
                body: after.trim().to_string(),
            },
        ))
    }
}

/// The text between the braces of `vec4 hook() { ... }`.
fn extract_hook_body(body: &str) -> Result<String, ComputeError> {
    let start = body
        .find("vec4 hook()")
        .ok_or_else(|| unsupported("pass has no `vec4 hook()`".into()))?;
    let open = body[start..]
        .find('{')
        .map(|index| index + start)
        .ok_or_else(|| unsupported("hook has no body".into()))?;
    let close = find_matching_brace(body, open)?;
    Ok(body[open + 1..close].to_string())
}

fn parse_conv(
    body: &str,
    defines: &HashMap<String, MacroDef>,
    slots: &HashMap<String, usize>,
    hooked: usize,
) -> Result<PassKind, ComputeError> {
    let mut terms = Vec::new();
    let mut bias = None;
    let mut residual = None;
    for statement in body.split(';') {
        let statement = statement.trim();
        if statement.is_empty() {
            continue;
        }
        match statement.find("mat4(") {
            Some(index) => terms.push(parse_term(&statement[index..], defines, slots, hooked)?),
            None if statement.starts_with("return") => {
                residual = parse_residual(statement, slots, hooked)?;
            }
            None if statement.starts_with("result") && statement.contains("vec4(") => {
                bias = Some(parse_vec4(statement)?);
            }
            None => {
                return Err(unsupported(format!(
                    "unsupported statement in a convolution pass: {statement}"
                )))
            }
        }
    }
    if terms.is_empty() {
        return Err(unsupported("convolution pass has no terms".into()));
    }
    Ok(PassKind::Conv {
        terms,
        bias: bias.unwrap_or([0.0; 4]),
        residual,
    })
}

fn parse_term(
    statement: &str,
    defines: &HashMap<String, MacroDef>,
    slots: &HashMap<String, usize>,
    hooked: usize,
) -> Result<Term, ComputeError> {
    let open = statement
        .find("mat4(")
        .ok_or_else(|| unsupported("term without mat4".into()))?
        + 4;
    let close = find_matching(statement, open)?;
    let weights = parse_floats(&statement[open + 1..close])?;
    let weights: [f32; 16] = weights
        .try_into()
        .map_err(|_| unsupported("mat4 term does not have 16 weights".into()))?;

    let rest = statement[close + 1..].trim();
    let rest = rest
        .strip_prefix('*')
        .ok_or_else(|| unsupported(format!("expected `mat4(...) * tap`, found: {rest}")))?
        .trim();

    // `go_0(-1.0, 0.0)` names a function-like macro and passes the tap offset;
    // `g_3` names an object-like one and reads the texture at the same position.
    let (name, call) = match rest.find('(') {
        Some(paren) => {
            let end = find_matching(rest, paren)?;
            if !rest[end + 1..].trim().is_empty() {
                return Err(unsupported(format!("unexpected text after tap: {rest}")));
            }
            (
                rest[..paren].to_string(),
                Some(rest[paren + 1..end].to_string()),
            )
        }
        None => (rest.to_string(), None),
    };
    let definition = defines
        .get(&name)
        .ok_or_else(|| unsupported(format!("tap macro {name} is not defined")))?;

    let (texture, activation, offset) = match definition {
        MacroDef::Function { args, body } => {
            let call = call.ok_or_else(|| unsupported(format!("{name} called without offsets")))?;
            let offsets = parse_floats(&call)?;
            if offsets.len() != args.len() || offsets.len() != 2 {
                return Err(unsupported(format!(
                    "{name} takes {} offsets, not {}",
                    args.len(),
                    offsets.len()
                )));
            }
            let expected = format!("vec2({})", args.join(","));
            let normalized: String = body.chars().filter(|c| !c.is_whitespace()).collect();
            if !normalized.contains(&expected) {
                return Err(unsupported(format!(
                    "{name} does not forward its offsets to vec2(): {body}"
                )));
            }
            let (texture, activation) = parse_macro_body(body)?;
            (texture, activation, [offsets[0], offsets[1]])
        }
        MacroDef::Object { body } => {
            if call.is_some() {
                return Err(unsupported(format!("{name} is not a function")));
            }
            let (texture, activation) = parse_macro_body(body)?;
            (texture, activation, [0.0, 0.0])
        }
    };
    let texture = resolve_texture(&texture, slots, hooked)?;
    Ok(Term {
        weights,
        texture,
        activation,
        offset,
    })
}

/// Recognises the five macro bodies Anime4K's generator emits and returns the
/// texture they read together with the activation applied to the sample.
fn parse_macro_body(body: &str) -> Result<(String, Activation), ComputeError> {
    let normalized: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    let (inner, activation) = if let Some(rest) = normalized.strip_prefix("(max(-(") {
        (rest.strip_suffix("),0.0))"), Activation::NegRelu)
    } else if let Some(rest) = normalized.strip_prefix("(max((") {
        (rest.strip_suffix("),0.0))"), Activation::Relu)
    } else if let Some(rest) = normalized.strip_prefix('(') {
        (rest.strip_suffix(')'), Activation::Identity)
    } else {
        (None, Activation::Identity)
    };
    let inner = inner.ok_or_else(|| unsupported(format!("unrecognised tap macro body: {body}")))?;
    let (texture, _) = split_texture_call(inner)?;
    Ok((texture, activation))
}

/// Splits `conv2d_tf_tex(conv2d_tf_pos)` into its texture name and the call it
/// makes. Only the name is needed: the call site already says which coordinate.
fn split_texture_call(call: &str) -> Result<(String, &str), ComputeError> {
    let marker = if call.contains("_texOff(") {
        "_texOff("
    } else if call.contains("_tex(") {
        "_tex("
    } else {
        return Err(unsupported(format!("not a texture sample: {call}")));
    };
    let index = call
        .find(marker)
        .ok_or_else(|| unsupported(format!("not a texture sample: {call}")))?;
    let name: String = call[..index]
        .trim()
        .chars()
        .take_while(|character| character.is_ascii_alphanumeric() || *character == '_')
        .collect();
    if name.is_empty() {
        return Err(unsupported(format!("texture sample has no name: {call}")));
    }
    Ok((name, &call[index..]))
}

/// One direction of `Anime4K_Clamp_Highlights`'s separable 5x5 maximum.
///
/// The pass is not a convolution: it loops a fixed number of times over one
/// axis, takes the largest luma (or the largest first channel, once an earlier
/// pass has already stored luma), and writes it to `.x`. Recognising it beats
/// interpreting it — the loop, the `get_luma` helper and the `#define`d kernel
/// size are all pinned by the file we ship.
fn parse_max_luma(
    body: &str,
    defines: &HashMap<String, MacroDef>,
    slots: &HashMap<String, usize>,
    hooked: usize,
) -> Result<PassKind, ComputeError> {
    let marker = body
        .find("_texOff(")
        .ok_or_else(|| unsupported("statistics pass samples no texture".into()))?;
    let name = name_before(body, marker);
    let source = resolve_texture(&name, slots, hooked)?;

    // `_texOff(vec2(i - KERNELHALFSIZE, 0))`: one component carries the loop
    // variable, the other is the literal 0 that says which axis it walks.
    let open = body[marker..]
        .find('(')
        .map(|index| marker + index)
        .ok_or_else(|| unsupported("statistics pass has no _texOff call".into()))?;
    let close = find_matching(body, open)?;
    let arguments = body[open + 1..close].trim();
    let inner_open = arguments
        .find('(')
        .map(|index| index + 1)
        .ok_or_else(|| unsupported("statistics pass offsets are not a vec2".into()))?;
    let inner_close = find_matching(&arguments, inner_open - 1)?;
    let components: Vec<&str> = arguments[inner_open..inner_close]
        .split(',')
        .map(str::trim)
        .collect();
    if components.len() != 2 {
        return Err(unsupported("statistics pass offsets are not a vec2".into()));
    }
    let horizontal = match (components[0], components[1]) {
        (_, "0") => true,
        ("0", _) => false,
        _ => {
            return Err(unsupported(
                "statistics pass offsets are not axis aligned".into(),
            ))
        }
    };

    // The loop bound names a `#define`; the pass walks `kernel` samples centred
    // on the current pixel.
    let head = &body[body
        .find("for")
        .ok_or_else(|| unsupported("statistics pass has no loop".into()))?..];
    let head = &head[..head
        .find('{')
        .ok_or_else(|| unsupported("statistics pass loop has no body".into()))?];
    if !head.contains("int i") {
        return Err(unsupported(
            "statistics pass loop does not count in `i`".into(),
        ));
    }
    let bound = head
        .split('<')
        .nth(1)
        .and_then(|rest| rest.split(';').next())
        .map(str::trim)
        .ok_or_else(|| unsupported("statistics pass loop has no bound".into()))?;
    let kernel = match defines.get(bound) {
        Some(MacroDef::Object { body }) => body.trim().parse::<u32>().ok(),
        _ => None,
    }
    .ok_or_else(|| {
        unsupported(format!(
            "statistics pass kernel size {bound} is not a number"
        ))
    })?;
    if kernel < 3 || kernel % 2 == 0 {
        return Err(unsupported(
            "statistics pass kernel size must be odd and at least 3".into(),
        ));
    }

    Ok(PassKind::MaxLuma {
        source,
        kernel,
        horizontal,
        luma: body.contains("get_luma("),
    })
}

/// `Anime4K_Clamp_Highlights`'s last pass: keep the source pixel's luma below
/// the ceiling the statistics passes found, and take the difference off every
/// channel.
fn parse_clamp_luma(
    body: &str,
    slots: &HashMap<String, usize>,
    hooked: usize,
) -> Result<PassKind, ComputeError> {
    let mut names: Vec<String> = Vec::new();
    let mut cursor = 0;
    while let Some(found) = body[cursor..].find("_tex(") {
        let at = cursor + found;
        let name = name_before(body, at);
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
        cursor = at + "_tex(".len();
    }
    if names.len() != 2 {
        return Err(unsupported(format!(
            "clamp pass samples {} textures, expected the image and its statistics",
            names.len()
        )));
    }
    Ok(PassKind::ClampLuma {
        source: resolve_texture(&names[0], slots, hooked)?,
        stats: resolve_texture(&names[1], slots, hooked)?,
    })
}

fn parse_depth_to_space(
    body: &str,
    slots: &HashMap<String, usize>,
    hooked: usize,
) -> Result<PassKind, ComputeError> {
    let mut sources = Vec::new();
    let mut residual = None;
    for statement in body.split(';') {
        let statement = statement.trim();
        if statement.is_empty() {
            continue;
        }
        if statement.starts_with("return") {
            residual = parse_residual(statement, slots, hooked)?;
            continue;
        }
        let Some((left, right)) = statement.split_once('=') else {
            continue;
        };
        // `float c0 = conv2d_last_tf_tex(...)[...]` pulls one channel out of a
        // source texture. `float c1 = c0;` only copies an earlier channel, and
        // `vec2 f0 = ...` / `ivec2 i0 = ...` are coordinates.
        if !left.trim().starts_with("float") || !right.contains("_tex(") {
            continue;
        }
        let (name, _) = split_texture_call(right.trim())?;
        sources.push(resolve_texture(&name, slots, hooked)?);
    }
    if sources.is_empty() {
        return Err(unsupported("depth-to-space pass names no source".into()));
    }
    if sources.len() > 4 {
        return Err(unsupported(format!(
            "depth-to-space pass has {} sources, more than the four channels it returns",
            sources.len()
        )));
    }
    // The shader copies the last channel into the remaining components
    // (`c1 = c0` for the medium chain, `c3 = c2` for the wide one), which is the
    // same as sampling that source again.
    while sources.len() < 4 {
        sources.push(sources[sources.len() - 1]);
    }
    Ok(PassKind::DepthToSpace { sources, residual })
}

/// Reads `result + MAIN_tex(MAIN_pos)` (or a bare `result`) and returns the
/// texture added on top, if any.
fn parse_residual(
    statement: &str,
    slots: &HashMap<String, usize>,
    hooked: usize,
) -> Result<Option<usize>, ComputeError> {
    let Some((_, tail)) = statement.rsplit_once('+') else {
        return Ok(None);
    };
    let tail = tail.trim().trim_end_matches(';').trim();
    if !tail.contains("_tex(") {
        return Ok(None);
    }
    let (name, _) = split_texture_call(tail)?;
    Ok(Some(resolve_texture(&name, slots, hooked)?))
}

/// Resolves the name a shader samples to one of the chain's textures. `HOOKED`
/// is mpv's alias for whatever the pass hooks, which in a chain with a single
/// image is always the image itself.
fn resolve_texture(
    name: &str,
    slots: &HashMap<String, usize>,
    hooked: usize,
) -> Result<usize, ComputeError> {
    if name == "HOOKED" {
        return Ok(hooked);
    }
    slots
        .get(name)
        .copied()
        .ok_or_else(|| unsupported(format!("reads unknown texture {name}")))
}

/// The identifier immediately before `marker` in `body`.
fn name_before(body: &str, marker: usize) -> String {
    let prefix = &body[..marker];
    let start = prefix
        .rfind(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
        .map(|index| index + 1)
        .unwrap_or(0);
    prefix[start..].to_string()
}

fn parse_vec4(statement: &str) -> Result<[f32; 4], ComputeError> {
    let open = statement
        .find("vec4(")
        .ok_or_else(|| unsupported("bias is not a vec4".into()))?
        + 4;
    let close = find_matching(statement, open)?;
    let values = parse_floats(&statement[open + 1..close])?;
    values
        .try_into()
        .map_err(|_| unsupported("vec4 bias does not have four values".into()))
}

fn parse_size(
    expression: &str,
    slots: &HashMap<String, usize>,
) -> Result<Vec<SizeToken>, ComputeError> {
    if expression.trim().is_empty() {
        return Err(unsupported("pass has no //!WIDTH or //!HEIGHT".into()));
    }
    let mut tokens = Vec::new();
    for token in expression.split_whitespace() {
        match token {
            "*" => tokens.push(SizeToken::Multiply),
            "+" => tokens.push(SizeToken::Add),
            "/" => tokens.push(SizeToken::Divide),
            _ => {
                if let Ok(value) = token.parse::<f32>() {
                    tokens.push(SizeToken::Number(value));
                    continue;
                }
                let (name, axis) = token.rsplit_once('.').ok_or_else(|| {
                    unsupported(format!("size expression has an unknown token: {token}"))
                })?;
                let slot = *slots
                    .get(name)
                    .ok_or_else(|| unsupported(format!("size reads unknown texture {name}")))?;
                match axis {
                    "w" => tokens.push(SizeToken::Width(slot)),
                    "h" => tokens.push(SizeToken::Height(slot)),
                    other => {
                        return Err(unsupported(format!(
                            "size expression uses .{other}, not .w or .h"
                        )))
                    }
                }
            }
        }
    }
    Ok(tokens)
}

fn eval_size(tokens: &[SizeToken], sizes: &[Option<(u32, u32)>]) -> Result<u32, ComputeError> {
    let mut stack: Vec<f32> = Vec::new();
    for token in tokens {
        match token {
            SizeToken::Width(slot) | SizeToken::Height(slot) => {
                let size = sizes
                    .get(*slot)
                    .and_then(|size| *size)
                    .ok_or_else(|| unsupported("size expression reads a missing texture".into()))?;
                stack.push(match token {
                    SizeToken::Width(_) => size.0 as f32,
                    _ => size.1 as f32,
                });
            }
            SizeToken::Number(value) => stack.push(*value),
            operator => {
                let right = stack
                    .pop()
                    .ok_or_else(|| unsupported("size expression is unbalanced".into()))?;
                let left = stack
                    .pop()
                    .ok_or_else(|| unsupported("size expression is unbalanced".into()))?;
                stack.push(match operator {
                    SizeToken::Multiply => left * right,
                    SizeToken::Add => left + right,
                    SizeToken::Divide => left / right,
                    _ => unreachable!(),
                });
            }
        }
    }
    let value = match stack.as_slice() {
        [value] => *value,
        _ => return Err(unsupported("size expression is unbalanced".into())),
    };
    let rounded = value.round();
    if !rounded.is_finite() || rounded < 1.0 || (value - rounded).abs() > 1e-3 {
        return Err(unsupported(format!(
            "size expression is not a positive whole number: {value}"
        )));
    }
    Ok(rounded as u32)
}

/// Index of the closing brace matching the one at `open`. Hook bodies have to be
/// matched on braces, not parentheses: the body of a convolution pass is full of
/// balanced `mat4(...)` calls that would confuse a paren matcher.
fn find_matching_brace(text: &str, open: usize) -> Result<usize, ComputeError> {
    let mut depth = 0_i32;
    for (offset, character) in text[open..].char_indices() {
        match character {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(open + offset);
                }
            }
            _ => {}
        }
    }
    Err(unsupported("unbalanced braces in shader".into()))
}

/// Index of the closing paren matching the one at `open`.
fn find_matching(text: &str, open: usize) -> Result<usize, ComputeError> {
    let mut depth = 0_i32;
    for (offset, character) in text[open..].char_indices() {
        match character {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(open + offset);
                }
            }
            _ => {}
        }
    }
    Err(unsupported("unbalanced parentheses in shader".into()))
}

fn parse_floats(text: &str) -> Result<Vec<f32>, ComputeError> {
    text.split(',')
        .map(|value| {
            value
                .trim()
                .parse::<f32>()
                .map_err(|_| unsupported(format!("not a number: {value}")))
        })
        .collect()
}

fn unsupported(message: String) -> ComputeError {
    ComputeError::InvalidInput(format!("Anime4K shader not supported: {message}"))
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

struct Texture {
    width: u32,
    height: u32,
    /// RGBA, one `f32` per channel, in `[0, 1]` as far as the shaders are
    /// concerned — convolution results run outside that range and are clamped
    /// when the image is written back.
    pixels: Vec<f32>,
}

impl Texture {
    fn from_rgba(rgba: &[u8], width: u32, height: u32) -> Self {
        let mut pixels = Vec::with_capacity(rgba.len());
        for pixel in rgba.chunks_exact(4) {
            pixels.push(f32::from(pixel[0]) / 255.0);
            pixels.push(f32::from(pixel[1]) / 255.0);
            pixels.push(f32::from(pixel[2]) / 255.0);
            // The first layer convolves all four channels and mpv hands it an
            // opaque frame, so the fourth input is a constant 1.0. Feeding the
            // page's own alpha instead would change every weight that touches it.
            pixels.push(1.0);
        }
        Self {
            width,
            height,
            pixels,
        }
    }

    fn texel(&self, x: i32, y: i32) -> [f32; 4] {
        let x = x.clamp(0, self.width as i32 - 1) as usize;
        let y = y.clamp(0, self.height as i32 - 1) as usize;
        let index = (y * self.width as usize + x) * 4;
        [
            self.pixels[index],
            self.pixels[index + 1],
            self.pixels[index + 2],
            self.pixels[index + 3],
        ]
    }

    /// Bilinear sample with edge clamping, which is what a GL `GL_LINEAR` +
    /// `GL_CLAMP_TO_EDGE` texture does. Every Anime4K tap lands exactly on a
    /// texel centre, so this only interpolates where the shader deliberately
    /// samples between texels.
    fn sample(&self, u: f32, v: f32) -> [f32; 4] {
        let x = u * self.width as f32 - 0.5;
        let y = v * self.height as f32 - 0.5;
        let x0 = x.floor();
        let y0 = y.floor();
        let fx = x - x0;
        let fy = y - y0;
        let (x0, y0) = (x0 as i32, y0 as i32);
        let top_left = self.texel(x0, y0);
        let top_right = self.texel(x0 + 1, y0);
        let bottom_left = self.texel(x0, y0 + 1);
        let bottom_right = self.texel(x0 + 1, y0 + 1);
        let mut out = [0_f32; 4];
        for channel in 0..4 {
            let top = top_left[channel] + (top_right[channel] - top_left[channel]) * fx;
            let bottom = bottom_left[channel] + (bottom_right[channel] - bottom_left[channel]) * fx;
            out[channel] = top + (bottom - top) * fy;
        }
        out
    }
}

/// `M * v` with `M` in GLSL's column-major `mat4(a, b, c, ...)` order.
fn multiply(weights: &[f32; 16], vector: [f32; 4]) -> [f32; 4] {
    let mut out = [0_f32; 4];
    for row in 0..4 {
        out[row] = weights[row] * vector[0]
            + weights[4 + row] * vector[1]
            + weights[8 + row] * vector[2]
            + weights[12 + row] * vector[3];
    }
    out
}

fn run_conv(
    terms: &[Term],
    bias: &[f32; 4],
    slots: &[Option<Texture>],
    width: u32,
    height: u32,
    names: &[String],
) -> Result<Vec<f32>, ComputeError> {
    let mut out = vec![0_f32; width as usize * height as usize * 4];
    for y in 0..height {
        let v = (y as f32 + 0.5) / height as f32;
        for x in 0..width {
            let u = (x as f32 + 0.5) / width as f32;
            let mut accumulated = *bias;
            for term in terms {
                let texture = slots[term.texture].as_ref().ok_or_else(|| {
                    unsupported(format!("texture {} was never written", names[term.texture]))
                })?;
                let sample = texture.sample(
                    u + term.offset[0] / texture.width as f32,
                    v + term.offset[1] / texture.height as f32,
                );
                let sample = term.activation.apply(sample);
                let contribution = multiply(&term.weights, sample);
                for channel in 0..4 {
                    accumulated[channel] += contribution[channel];
                }
            }
            let index = (y as usize * width as usize + x as usize) * 4;
            out[index..index + 4].copy_from_slice(&accumulated);
        }
    }
    Ok(out)
}

fn run_depth_to_space(
    sources: &[usize],
    residual: Option<usize>,
    slots: &[Option<Texture>],
    width: u32,
    height: u32,
    names: &[String],
) -> Result<Vec<f32>, ComputeError> {
    let mut out = vec![0_f32; width as usize * height as usize * 4];
    for y in 0..height {
        let v = (y as f32 + 0.5) / height as f32;
        for x in 0..width {
            let u = (x as f32 + 0.5) / width as f32;
            let mut value = [0_f32; 4];
            for (channel, &slot) in sources.iter().enumerate() {
                let texture = slots[slot].as_ref().ok_or_else(|| {
                    unsupported(format!("texture {} was never written", names[slot]))
                })?;
                if channel >= 4 {
                    return Err(unsupported(
                        "depth-to-space has more sources than channels".into(),
                    ));
                }
                let source_x = u * texture.width as f32;
                let source_y = v * texture.height as f32;
                let base_x = source_x.floor();
                let base_y = source_y.floor();
                let sub_x = ((source_x - base_x) * 2.0).floor() as i32;
                let sub_y = ((source_y - base_y) * 2.0).floor() as i32;
                let texel = texture.texel(base_x as i32, base_y as i32);
                let component = (sub_y * 2 + sub_x).clamp(0, 3) as usize;
                value[channel] = texel[component];
            }
            if let Some(slot) = residual {
                let texture = slots[slot].as_ref().ok_or_else(|| {
                    unsupported(format!("texture {} was never written", names[slot]))
                })?;
                let sample = texture.sample(u, v);
                for channel in 0..4 {
                    value[channel] += sample[channel];
                }
            }
            let index = (y as usize * width as usize + x as usize) * 4;
            out[index..index + 4].copy_from_slice(&value);
        }
    }
    Ok(out)
}

fn add_residual(
    out: &mut [f32],
    residual: usize,
    slots: &[Option<Texture>],
    width: u32,
    height: u32,
    names: &[String],
) -> Result<(), ComputeError> {
    let texture = slots[residual]
        .as_ref()
        .ok_or_else(|| unsupported(format!("texture {} was never written", names[residual])))?;
    for y in 0..height {
        let v = (y as f32 + 0.5) / height as f32;
        for x in 0..width {
            let u = (x as f32 + 0.5) / width as f32;
            let sample = texture.sample(u, v);
            let index = (y as usize * width as usize + x as usize) * 4;
            for channel in 0..4 {
                out[index + channel] += sample[channel];
            }
        }
    }
    Ok(())
}

/// BT.601 luma with the same weights as Anime4K's `get_luma`.
fn luma_of(rgba: [f32; 4]) -> f32 {
    0.299 * rgba[0] + 0.587 * rgba[1] + 0.114 * rgba[2]
}

/// One direction of the separable maximum-luma window.
fn run_max_luma(
    source: usize,
    kernel: u32,
    horizontal: bool,
    luma: bool,
    slots: &[Option<Texture>],
    width: u32,
    height: u32,
    names: &[String],
) -> Result<Vec<f32>, ComputeError> {
    let texture = slots[source]
        .as_ref()
        .ok_or_else(|| unsupported(format!("texture {} was never written", names[source])))?;
    let half = (kernel as f32 - 1.0) / 2.0;
    let mut out = vec![0_f32; width as usize * height as usize * 4];
    for y in 0..height {
        let v = (y as f32 + 0.5) / height as f32;
        for x in 0..width {
            let u = (x as f32 + 0.5) / width as f32;
            // The shader starts from 0.0, so a negative sample cannot win.
            let mut best = 0.0_f32;
            for tap in 0..kernel {
                let offset = (tap as f32 - half)
                    / if horizontal {
                        texture.width as f32
                    } else {
                        texture.height as f32
                    };
                let sample = if horizontal {
                    texture.sample(u + offset, v)
                } else {
                    texture.sample(u, v + offset)
                };
                let value = if luma { luma_of(sample) } else { sample[0] };
                best = best.max(value);
            }
            let index = (y as usize * width as usize + x as usize) * 4;
            out[index] = best;
        }
    }
    Ok(out)
}

/// Lowers the source's luma to the statistics ceiling and subtracts the excess
/// from every channel, which is the de-ring step.
fn run_clamp_luma(
    source: usize,
    stats: usize,
    slots: &[Option<Texture>],
    width: u32,
    height: u32,
    names: &[String],
) -> Result<Vec<f32>, ComputeError> {
    let image = slots[source]
        .as_ref()
        .ok_or_else(|| unsupported(format!("texture {} was never written", names[source])))?;
    let statistics = slots[stats]
        .as_ref()
        .ok_or_else(|| unsupported(format!("texture {} was never written", names[stats])))?;
    let mut out = vec![0_f32; width as usize * height as usize * 4];
    for y in 0..height {
        let v = (y as f32 + 0.5) / height as f32;
        for x in 0..width {
            let u = (x as f32 + 0.5) / width as f32;
            let pixel = image.sample(u, v);
            let excess = luma_of(pixel) - luma_of(pixel).min(statistics.sample(u, v)[0]);
            let index = (y as usize * width as usize + x as usize) * 4;
            for channel in 0..4 {
                out[index + channel] = pixel[channel] - excess;
            }
        }
    }
    Ok(out)
}

/// 把一份预设的 shader 文件编成一条 pass 链。**只有这一处解析**：CPU 解释器、GPU
/// 生成器、测试都从它拿 `Program`，所以「同一串 GLSL 在两边解出两个网络」不存在。
pub(crate) fn compile_chain(preset: &Anime4kPreset) -> Result<Program, ComputeError> {
    let mut compiler = Compiler::new();
    for shader in preset.shaders {
        compiler.add_shader(shader)?;
    }
    compiler.finish(preset.scale)
}

/// Nearest-neighbour source alpha, so the page's transparency (if any)
/// survives a network that only knows about opaque colour.
pub(crate) fn carry_alpha(
    rgba: &[u8],
    source_width: u32,
    source_height: u32,
    width: u32,
    height: u32,
    scale: u32,
) -> Vec<u8> {
    let mut alpha = vec![0_u8; width as usize * height as usize * 4];
    for y in 0..height {
        let source_y = (y / scale).min(source_height.saturating_sub(1));
        for x in 0..width {
            let source_x = (x / scale).min(source_width.saturating_sub(1));
            let source = ((source_y * source_width + source_x) * 4 + 3) as usize;
            let target = ((y * width + x) * 4 + 3) as usize;
            alpha[target] = rgba[source];
        }
    }
    alpha
}

/// 一条链跑完之后的那一步：RGB 从 f32 画布量化回 8 位（clamp 到 `[0, 1]` 再 round，
/// 与 GPU 那条路**逐字节**共用），alpha 走最近邻搬运。两条执行体都从这里出图。
#[allow(clippy::too_many_arguments)]
pub(crate) fn quantize_tile(
    source: &[u8],
    source_width: u32,
    source_height: u32,
    pixels: &[f32],
    width: u32,
    height: u32,
    scale: u32,
) -> Vec<u8> {
    let mut result = carry_alpha(source, source_width, source_height, width, height, scale);
    for (index, pixel) in pixels.chunks_exact(4).enumerate() {
        for channel in 0..3 {
            result[index * 4 + channel] = (pixel[channel].clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }
    result
}

/// A compiled Anime4K chain, ready to run over a tile.
pub struct Anime4kEngine {
    program: Program,
}

impl Anime4kEngine {
    pub fn open(preset: &Anime4kPreset) -> Result<Self, ComputeError> {
        Ok(Self {
            program: compile_chain(preset)?,
        })
    }
}

impl UpscaleEngine for Anime4kEngine {
    fn scale(&self) -> u32 {
        self.program.scale
    }

    fn tile_padding(&self) -> u32 {
        self.program.padding
    }

    fn upscale_tile(
        &self,
        rgba: &[u8],
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, ComputeError> {
        if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 {
            return Err(ComputeError::InvalidInput(
                "RGBA tile dimensions do not match".into(),
            ));
        }
        let mut slots: Vec<Option<Texture>> = (0..self.program.slots.len()).map(|_| None).collect();
        slots[0] = Some(Texture::from_rgba(rgba, width, height));
        let mut sizes: Vec<Option<(u32, u32)>> = vec![None; slots.len()];
        sizes[0] = Some((width, height));

        for pass in &self.program.passes {
            let out_width = eval_size(&pass.width, &sizes)?;
            let out_height = eval_size(&pass.height, &sizes)?;
            let pixels = match &pass.kind {
                PassKind::Conv {
                    terms,
                    bias,
                    residual,
                } => {
                    let mut pixels = run_conv(
                        terms,
                        bias,
                        &slots,
                        out_width,
                        out_height,
                        &self.program.slots,
                    )?;
                    if let Some(slot) = residual {
                        add_residual(
                            &mut pixels,
                            *slot,
                            &slots,
                            out_width,
                            out_height,
                            &self.program.slots,
                        )?;
                    }
                    pixels
                }
                PassKind::DepthToSpace { sources, residual } => run_depth_to_space(
                    sources,
                    *residual,
                    &slots,
                    out_width,
                    out_height,
                    &self.program.slots,
                )?,
                PassKind::MaxLuma {
                    source,
                    kernel,
                    horizontal,
                    luma,
                } => run_max_luma(
                    *source,
                    *kernel,
                    *horizontal,
                    *luma,
                    &slots,
                    out_width,
                    out_height,
                    &self.program.slots,
                )?,
                PassKind::ClampLuma { source, stats } => run_clamp_luma(
                    *source,
                    *stats,
                    &slots,
                    out_width,
                    out_height,
                    &self.program.slots,
                )?,
            };
            slots[pass.output] = Some(Texture {
                width: out_width,
                height: out_height,
                pixels,
            });
            sizes[pass.output] = Some((out_width, out_height));
        }

        let output = slots[self.program.output].as_ref().ok_or_else(|| {
            unsupported(format!(
                "chain produced no {}",
                self.program.slot_name(self.program.output)
            ))
        })?;
        if output.width != width * self.program.scale
            || output.height != height * self.program.scale
        {
            return Err(unsupported(format!(
                "chain produced {}x{}, expected {}x{}",
                output.width,
                output.height,
                width * self.program.scale,
                height * self.program.scale
            )));
        }
        Ok(quantize_tile(
            rgba,
            width,
            height,
            &output.pixels,
            output.width,
            output.height,
            self.program.scale,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(id: &str) -> Anime4kEngine {
        Anime4kEngine::open(preset_by_id(id).expect("preset exists")).expect("chain compiles")
    }

    fn term_counts(engine: &Anime4kEngine) -> Vec<usize> {
        engine
            .program
            .passes
            .iter()
            .filter_map(|pass| match &pass.kind {
                PassKind::Conv { terms, .. } => Some(terms.len()),
                _ => None,
            })
            .collect()
    }

    /// The pass kinds in execution order.
    fn kinds(engine: &Anime4kEngine) -> Vec<&'static str> {
        engine
            .program
            .passes
            .iter()
            .map(|pass| match &pass.kind {
                PassKind::Conv { .. } => "conv",
                PassKind::DepthToSpace { .. } => "depth-to-space",
                PassKind::MaxLuma { .. } => "max-luma",
                PassKind::ClampLuma { .. } => "clamp-luma",
            })
            .collect()
    }

    fn depth_to_space(engine: &Anime4kEngine) -> &Pass {
        engine
            .program
            .passes
            .iter()
            .find(|pass| matches!(pass.kind, PassKind::DepthToSpace { .. }))
            .expect("depth-to-space pass")
    }

    #[test]
    fn every_preset_compiles_and_declares_the_scale_it_produces() {
        for preset in ANIME4K_PRESETS {
            let engine = Anime4kEngine::open(preset)
                .unwrap_or_else(|error| panic!("{} did not compile: {error:?}", preset.id));
            assert_eq!(engine.scale(), preset.scale);
            assert!(engine.tile_padding() >= DEFAULT_TILE_PADDING);
        }
        // Seven 3x3 layers reach 7 source pixels, which the default margin of 8
        // already covers; the de-ring clamp runs *after* the upscalers, so its
        // own 5-tap window never widens the convolution chain. The wide restore
        // step doubles that chain and does need a wider margin.
        assert_eq!(engine("anime4k").tile_padding(), DEFAULT_TILE_PADDING);
        assert_eq!(engine("anime4k-hq").tile_padding(), DEFAULT_TILE_PADDING);
        assert_eq!(engine("anime4k-ultra").tile_padding(), 15);
    }

    #[test]
    fn the_de_ring_pass_runs_last_and_writes_over_the_image() {
        // The clamp pass is the first file in the chain but hooks PREKERNEL, and
        // mpv runs every MAIN hook before it. Running it in file order would
        // clamp the source image against its own 5x5 maximum, which is a no-op —
        // a whole feature that silently does nothing.
        for id in ["anime4k", "anime4k-hq", "anime4k-ultra"] {
            let engine = engine(id);
            let kinds = kinds(&engine);
            assert_eq!(
                kinds.iter().filter(|kind| **kind == "clamp-luma").count(),
                1,
                "{id}"
            );
            assert_eq!(kinds.last().copied(), Some("clamp-luma"), "{id}");
            assert_eq!(
                kinds[..2],
                ["max-luma", "max-luma"],
                "{id}: the statistics passes still come first"
            );
            let last = engine.program.passes.last().expect("a pass");
            assert_eq!(last.output, 0, "{id}: the clamp writes back to MAIN");
            assert_eq!(last.stage, Stage::Post, "{id}");
        }
    }

    #[test]
    fn the_statistics_passes_walk_one_axis_each() {
        let engine = engine("anime4k");
        let directions: Vec<(bool, bool)> = engine
            .program
            .passes
            .iter()
            .filter_map(|pass| match &pass.kind {
                PassKind::MaxLuma {
                    horizontal, luma, ..
                } => Some((*horizontal, *luma)),
                _ => None,
            })
            .collect();
        // Horizontal first (from the image's colour), then vertical (from the
        // half-finished statistic, which is already luma).
        assert_eq!(directions, vec![(true, true), (false, false)]);
    }

    #[test]
    fn the_medium_chain_parses_every_pass_the_file_declares() {
        let engine = engine("anime4k");
        assert_eq!(
            kinds(&engine),
            vec![
                "max-luma",
                "max-luma",
                "conv",
                "conv",
                "conv",
                "conv",
                "conv",
                "conv",
                "conv",
                "conv",
                "depth-to-space",
                "clamp-luma",
            ],
            "8 convolution passes and the pixel shuffle, with de-ring statistics before and the clamp after"
        );
        assert_eq!(
            engine.program.slots.len(),
            10,
            "MAIN, the statistics texture and seven saved convolutions"
        );
        // Nine taps in the first layer, eighteen (both ReLU halves) in each of the
        // six that follow, then the combine and the pixel shuffle.
        assert_eq!(term_counts(&engine), vec![9, 18, 18, 18, 18, 18, 18, 14]);
        let PassKind::DepthToSpace { sources, residual } = &depth_to_space(&engine).kind else {
            panic!("expected depth-to-space");
        };
        assert_eq!(sources.len(), 4, "one channel copied into all four");
        assert!(residual.is_some(), "the depth-to-space pass adds MAIN back");
    }

    #[test]
    fn the_wide_chain_is_branching_and_shuffles_three_sources() {
        let engine = engine("anime4k-hq");
        assert_eq!(engine.program.passes.len(), 21, "18 + the de-ring passes");
        assert_eq!(
            engine.program.slots.len(),
            19,
            "18 + the statistics texture"
        );
        assert_eq!(
            term_counts(&engine),
            vec![9, 9, 36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 28, 28, 28]
        );
        let PassKind::DepthToSpace { sources, .. } = &depth_to_space(&engine).kind else {
            panic!("expected depth-to-space");
        };
        assert_eq!(sources.len(), 4);
        // The wide chain runs three parallel branches into the shuffle, so three
        // different conv2d_last_* textures feed it and the fourth channel repeats
        // the third.
        assert_eq!(sources[3], sources[2]);
        assert_ne!(sources[0], sources[1]);
        assert_ne!(sources[1], sources[2]);
    }

    #[test]
    fn the_maximum_luma_window_keeps_the_largest_sample_along_its_axis() {
        // A 5x1 grey image with one bright texel.
        let mut pixels = Vec::new();
        for value in [0.0_f32, 0.0, 1.0, 0.0, 0.0] {
            pixels.extend_from_slice(&[value, value, value, 1.0]);
        }
        let slots = vec![Some(Texture {
            width: 5,
            height: 1,
            pixels,
        })];
        let names = vec!["MAIN".to_string()];
        let out = run_max_luma(0, 3, true, true, &slots, 5, 1, &names).expect("max luma");
        let luma: Vec<f32> = out.chunks_exact(4).map(|pixel| pixel[0]).collect();
        assert_eq!(luma, vec![0.0, 1.0, 1.0, 1.0, 0.0]);
        assert!(
            out.chunks_exact(4)
                .all(|pixel| pixel[1] == 0.0 && pixel[2] == 0.0),
            "the statistic lives in .x only"
        );
    }

    #[test]
    fn the_clamp_lowers_only_luma_above_its_ceiling() {
        let image = Texture {
            width: 2,
            height: 1,
            pixels: vec![1.0, 1.0, 1.0, 1.0, 0.2, 0.2, 0.2, 1.0],
        };
        let statistics = Texture {
            width: 2,
            height: 1,
            pixels: vec![0.5, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0],
        };
        let slots = vec![Some(image), Some(statistics)];
        let names = vec!["MAIN".to_string(), "STATSMAX".to_string()];
        let out = run_clamp_luma(0, 1, &slots, 2, 1, &names).expect("clamp");
        // The bright pixel loses exactly the excess on every channel — the
        // shader subtracts a float from a vec4 — while the dark one is under the
        // ceiling and keeps its value.
        assert!((out[0] - 0.5).abs() < 1e-6);
        assert!((out[3] - 0.5).abs() < 1e-6);
        assert!((out[4] - 0.2).abs() < 1e-6);
        assert!((out[7] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn the_restore_stage_changes_what_the_wide_chain_produces() {
        let source = gradient_rgba(24, 24);
        let plain = engine("anime4k-hq")
            .upscale_tile(&source, 24, 24)
            .expect("hq");
        let restored = engine("anime4k-ultra")
            .upscale_tile(&source, 24, 24)
            .expect("ultra");
        assert_eq!(plain.len(), restored.len());
        assert_ne!(
            plain, restored,
            "the restore network runs before the upscaler and has to show in the result"
        );
        assert!(restored.chunks_exact(4).all(|pixel| pixel[3] == 200));
    }

    fn line_art_rgba(width: u32, height: u32) -> Vec<u8> {
        // Mid grey with thin dark strokes: sharpening overshoots *inside* the
        // value range just outside them, which is the halo de-ring removes.
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let stroke =
                    y % 6 == 0 || (x % 7 == 0 && y > 8) || x.abs_diff(y) < 1 || x + y == width;
                let value = if stroke { 20 } else { 128 };
                rgba.extend_from_slice(&[value, value, value, 255]);
            }
        }
        rgba
    }

    #[test]
    fn the_de_ring_pass_lowers_in_range_overshoot_and_never_raises_anything() {
        let mut compiler = Compiler::new();
        compiler
            .add_shader(UPSCALE_CNN_X2_M)
            .expect("medium chain without de-ring");
        let bare = Anime4kEngine {
            program: compiler.finish(2).expect("x2"),
        };
        let source = line_art_rgba(48, 48);
        let plain = bare.upscale_tile(&source, 48, 48).expect("plain");
        let deringed = engine("anime4k")
            .upscale_tile(&source, 48, 48)
            .expect("de-ringed");
        assert_eq!(plain.len(), deringed.len());
        let lowered = plain
            .iter()
            .zip(&deringed)
            .filter(|(before, after)| after < before)
            .count();
        let raised = plain
            .iter()
            .zip(&deringed)
            .filter(|(before, after)| after > before)
            .count();
        assert!(lowered > 0, "the clamp has to catch the halo it exists for");
        assert_eq!(raised, 0, "de-ring only ever lowers luma");
    }

    #[test]
    fn matrix_vector_multiply_follows_glsl_column_major_order() {
        // `mat4(a, b, c, d, e, ...)` lists columns, so the first four values are
        // the weights of the first vector component.
        let mut weights = [0_f32; 16];
        weights[0] = 1.0;
        weights[5] = 1.0;
        weights[10] = 1.0;
        weights[12] = 5.0;
        weights[15] = 1.0;
        assert_eq!(
            multiply(&weights, [2.0, 3.0, 4.0, 1.0]),
            [7.0, 3.0, 4.0, 1.0]
        );

        let mut weights = [0_f32; 16];
        weights[0] = 1.0;
        weights[4] = 10.0;
        weights[8] = 100.0;
        weights[12] = 1000.0;
        assert_eq!(
            multiply(&weights, [1.0, 2.0, 4.0, 8.0]),
            [1.0 + 20.0 + 400.0 + 8000.0, 0.0, 0.0, 0.0]
        );
    }

    fn flat_rgba(width: u32, height: u32, colour: [u8; 4]) -> Vec<u8> {
        colour
            .iter()
            .copied()
            .cycle()
            .take(width as usize * height as usize * 4)
            .collect()
    }

    fn gradient_rgba(width: u32, height: u32) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                rgba.extend_from_slice(&[
                    ((x * 5) % 256) as u8,
                    ((y * 5) % 256) as u8,
                    (((x + y) * 3) % 256) as u8,
                    200,
                ]);
            }
        }
        rgba
    }

    #[test]
    fn a_flat_tile_comes_back_flat_and_opaque() {
        // Anime4K keeps flat areas flat: the residual connection and the biases
        // cancel a constant input exactly. That is the cheapest proof that the
        // weights are read in the right order — transposed weights would tint a
        // flat colour.
        for id in ["anime4k", "anime4k-hq"] {
            let engine = engine(id);
            let source = flat_rgba(24, 24, [120, 130, 140, 255]);
            let output = engine.upscale_tile(&source, 24, 24).expect(id);
            assert_eq!(output.len(), 48 * 48 * 4);
            let first = &output[..4];
            assert!(output.chunks_exact(4).all(|pixel| pixel == first), "{id}");
            assert_eq!(first, &[120, 130, 140, 255], "{id}");
        }
    }

    #[test]
    fn a_tile_is_upscaled_by_two_and_not_by_repeating_pixels() {
        let engine = engine("anime4k");
        let source = gradient_rgba(32, 32);
        let output = engine.upscale_tile(&source, 32, 32).expect("upscale");
        assert_eq!(output.len(), 64 * 64 * 4);
        assert!(
            output.chunks_exact(4).all(|pixel| pixel[3] == 200),
            "the network only sees opaque colour, so alpha has to be carried across"
        );
        let nearest = crate::cpu_scale::cpu_scale_rgba(&source, 32, 32, 2, 64_000_000)
            .expect("nearest reference")
            .rgba;
        assert_ne!(
            output, nearest,
            "the chain must actually run, not fall back to pixel repetition"
        );
    }

    #[test]
    fn a_tap_that_the_pass_does_not_bind_is_refused() {
        // The second pass reads a texture the first one saved but forgets to bind
        // it; mpv would order the passes by that list, so a missing entry is a
        // parse that got the shader wrong.
        let shader = "\
//!DESC save one
//!HOOK MAIN
//!BIND MAIN
//!SAVE saved
//!WIDTH MAIN.w
//!HEIGHT MAIN.h
#define go_0(x_off, y_off) (MAIN_texOff(vec2(x_off, y_off)))
vec4 hook() {
    vec4 result = mat4(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0) * go_0(0.0, 0.0);
    return result;
}
//!DESC read it without binding it
//!HOOK MAIN
//!BIND MAIN
//!SAVE again
//!WIDTH MAIN.w
//!HEIGHT MAIN.h
#define go_0(x_off, y_off) (saved_texOff(vec2(x_off, y_off)))
vec4 hook() {
    vec4 result = mat4(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0) * go_0(0.0, 0.0);
    return result;
}
";
        let mut compiler = Compiler::new();
        let error = compiler.add_shader(shader).expect_err("unbound texture");
        assert!(matches!(error, ComputeError::InvalidInput(_)));
    }

    #[test]
    fn a_pass_without_a_save_target_is_refused() {
        let shader = "\
//!DESC no save
//!HOOK MAIN
//!BIND MAIN
//!WIDTH MAIN.w
//!HEIGHT MAIN.h
#define go_0(x_off, y_off) (MAIN_texOff(vec2(x_off, y_off)))
vec4 hook() {
    vec4 result = mat4(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0) * go_0(0.0, 0.0);
    return result;
}
";
        let mut compiler = Compiler::new();
        assert!(compiler.add_shader(shader).is_err());
    }

    #[test]
    fn an_unknown_directive_is_refused_rather_than_ignored() {
        let shader = "\
//!DESC unsupported
//!HOOK MAIN
//!BIND MAIN
//!SAVE out
//!WIDTH MAIN.w
//!HEIGHT MAIN.h
//!FILTER bilinear
vec4 hook() {
    return MAIN_tex(MAIN_pos);
}
";
        let mut compiler = Compiler::new();
        assert!(compiler.add_shader(shader).is_err());
    }
}

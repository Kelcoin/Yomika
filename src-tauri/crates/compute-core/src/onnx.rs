//! ONNX 超分执行体：把一张 RGBA 瓦片过模型，并把「这条运行库算得对不对」问出来。
//!
//! 这里是宿主与 worker **共用**的那一份（docs/71 §5.1）。搬运时一个字节的算法都没改
//! ——分块、裁剪、回贴、预算全都还在 [`crate::upscale`]，本模块只做「一张瓦片进、
//! 一张瓦片出」。变的只有三处：错误类型换成核心的 [`ComputeError`]、运行库策略换成
//! [`crate::runtime`]、以及**会话缓存不再在这里**（进程级缓存是宿主生命周期的事：
//! worker 里同时只有一个模型，缓存反而会挡住 idle 释放）。
//!
//! 超分模型只认 NCHW 的浮点 RGB，没有 alpha 的概念；alpha 由同一条最近邻兜底路径
//! 单独带过去，所以模型的回答永远不可能带来一个尺寸对不上的缓冲区。

use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use crate::cancel::CancelToken;
use crate::cpu_scale::cpu_scale_rgba;
use crate::engine::{outputs_agree, ValidationVerdict};
use crate::error::ComputeError;
use crate::inputs::file_fingerprint;
use crate::probe::{self, ProbeKey, ProbeKind};
use crate::runtime::{available_runtimes, open_session, platform_preference, RuntimeId};
use crate::tensor::{nchw_over_rgba, pad_rgba_edges, preserve_neutral_chroma, rgba_to_nchw};
use crate::upscale::UpscaleEngine;

/// 探针用的瓦片尺寸（源像素）。72×64 是历史值：够大能跨过 Real-CUGAN 图内那 18 px
/// 反射垫边，够小不至于让探针本身变成一次真实的显存占用。
const PROBE_WIDTH: usize = 72;
const PROBE_HEIGHT: usize = 64;

/// 这一次「谁在算」的完整交代：想要谁、实际用了谁、实测结论是什么。
///
/// 它与 [`crate::engine::EngineResolution`] 不是一回事：那一个是「拿到平台事实表之后
/// 怎么选后端」，翻的是**事实**；这一条是**实测**出来的——「这份模型在这条运行库上算
/// 得对不对」只能跑一次才知道，而且这条交代要随产物一起回到宿主与用户眼前。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeChoice {
    /// 平台偏好里排第一的那条（Windows 是 directml，苹果 coreml，安卓 nnapi，其余
    /// cpu）。它只表达「想用哪个」，不代表这台机器/这份构建真的有。
    pub requested: RuntimeId,
    /// 真的用来跑的那条。
    pub used: RuntimeId,
    /// 对 `used` 的实测结论。`used != requested` 时它就是回退原因。
    pub verdict: ValidationVerdict,
}

impl RuntimeChoice {
    /// 用户要的没给上，就是回退了。
    pub fn fell_back(&self) -> bool {
        self.used != self.requested
    }

    /// 给用户看的一句话：想用谁、为什么没用上。没回退就没什么可说的。
    pub fn fallback_reason(&self) -> Option<&str> {
        if !self.fell_back() {
            return None;
        }
        Some(match &self.verdict {
            ValidationVerdict::Failed { reason } => reason.as_str(),
            ValidationVerdict::NotTested => "这条运行库在这台机器上不可用（没装上，或没有可用设备）",
            // 探针通过就不会被换掉，所以这一条到不了；留着只是为了让 match 穷尽。
            ValidationVerdict::Passed => "这份构建只能给 CPU",
        })
    }
}

/// 一个已经装载好的 ONNX 超分模型。
///
/// `Session::run` 要 `&mut`，而 [`UpscaleEngine::upscale_tile`] 拿的是 `&self`（整幅图
/// 期间管道一直握着这个引擎），所以这里必须有一个互斥量。实际不会争用：一次只放
/// 大一张图。
pub struct OnnxEngine {
    session: Mutex<ort::session::Session>,
    /// **实际**用上的那条运行库（不是「想要」的那条）。两个运行库算出来的东西不一样，
    /// 缓存键与给用户看的报告都要用这个值，不许用偏好顺序。
    runtime: RuntimeId,
    scale: u32,
    max_pixels: usize,
    /// 图自己能接受的最小边（源像素）。Real-CUGAN 图内反射 18 px、边小于 20 就报错，
    /// 而分块器在页面右缘真的会递过来一条 9 px 的窄条；小于这个值时瓦片先按边缘复制
    /// 长大，答完再裁回来。
    min_input_edge: u32,
    fixed_input: Option<(u32, u32)>,
}

// NNAPI graph compilation needs concrete dimensions. Keep a reusable, bounded
// input tile and pad edge tiles to it; dynamic page dimensions stay in the tiler.
const NNAPI_TILE_EDGE: u32 = 128;

fn nnapi_overrides(shape: &[i64], symbols: &[&str], min_edge: u32) -> Result<Vec<(String, i64)>, String> {
    if shape.len() != 4 || symbols.len() != 4 {
        return Err("NNAPI upscale input must be NCHW".into());
    }
    let edge = i64::from(NNAPI_TILE_EDGE.max(min_edge));
    let desired = [1, 3, edge, edge];
    let mut overrides = Vec::<(String, i64)>::new();
    for axis in 0..4 {
        if shape[axis] > 0 { continue; }
        let symbol = symbols[axis];
        if symbol.is_empty() { return Err(format!("NNAPI input axis {axis} is dynamic without a symbolic name")); }
        if let Some((_, previous)) = overrides.iter().find(|(name, _)| name == symbol) {
            if *previous != desired[axis] { return Err("NNAPI model reuses an input symbol for incompatible axes".into()); }
        } else {
            overrides.push((symbol.to_string(), desired[axis]));
        }
    }
    Ok(overrides)
}

fn specialize_nnapi(mut builder: ort::session::builder::SessionBuilder, path: &Path, min_edge: u32) -> Result<ort::session::builder::SessionBuilder, String> {
    // Inspect with CPU before hardware compilation, then release its weights.
    let metadata = open_session(path, RuntimeId::Cpu)?;
    let overrides = match metadata.inputs().first().map(|input| input.dtype()) {
        Some(ort::value::ValueType::Tensor { shape, dimension_symbols, .. }) => {
            let symbols: Vec<&str> = dimension_symbols.iter().map(String::as_str).collect();
            nnapi_overrides(shape, &symbols, min_edge)?
        }
        _ => return Err("NNAPI model has no tensor input".into()),
    };
    drop(metadata);
    for (name, size) in overrides {
        builder = builder.with_dimension_override(name, size).map_err(|error| error.to_string())?;
    }
    Ok(builder)
}

fn model_builder(path: &Path, runtime: RuntimeId, min_edge: u32) -> Result<ort::session::builder::SessionBuilder, String> {
    let builder = crate::runtime::builder(runtime)?;
    if runtime == RuntimeId::Nnapi { specialize_nnapi(builder, path, min_edge) } else { Ok(builder) }
}

impl OnnxEngine {
    /// 用**指定**的运行库打开，不换也不回退。调用方要自己确保这条运行库对这份模型
    /// 实测通过（[`validate_runtime`]）——「点的是显卡、跑的是 CPU」正是这轮要消灭的
    /// 那类谎话。
    pub fn open_with_runtime(
        path: &Path,
        runtime: RuntimeId,
        scale: u32,
        max_pixels: usize,
        min_input_edge: u32,
    ) -> Result<Self, ComputeError> {
        Self::open_with_runtime_cancel(path, runtime, scale, max_pixels, min_input_edge, &CancelToken::none())
    }

    pub fn open_with_runtime_cancel(
        path: &Path, runtime: RuntimeId, scale: u32, max_pixels: usize, min_input_edge: u32,
        cancel: &CancelToken,
    ) -> Result<Self, ComputeError> {
        cancel.check()?;
        if scale == 0 {
            return Err(ComputeError::InvalidManifest(
                "model scale must be at least 1".into(),
            ));
        }
        let mut builder = model_builder(path, runtime, min_input_edge)
            .map_err(|error| ComputeError::InvalidInput(format!("ONNX session failed: {error}")))?;
        cancel.check()?;
        let session = builder.commit_from_file(path)
            .map_err(|error| ComputeError::InvalidInput(format!("ONNX session failed: {error}")))?;
        cancel.check()?;
        let fixed_input = session.inputs().first().and_then(|input| input.dtype().tensor_shape())
            .and_then(|shape| static_input_dimensions(shape));
        Ok(Self {
            session: Mutex::new(session),
            runtime,
            scale,
            max_pixels,
            min_input_edge: min_input_edge.max(1),
            fixed_input,
        })
    }

    /// 首选运行库 + 一次实测探针：探针不过就用 CPU 参照（并留一条日志），并把
    /// 「想要谁 / 用了谁 / 为什么」原样交出去。
    ///
    /// 这是宿主一路沿用下来的行为，也是 docs/71 §5.3 的落地方式：`scale` 与最小边
    /// 来自清单而不是图，而「这条运行库对这份模型算得对不对」只能实测。
    ///
    /// 实测结论走 [`validate_runtime_cached`]：同一份模型（内容指纹）问第二遍不再重探
    /// ——docs/71 对这条的要求是「GPU probe 只在冷 model/新环境执行」，而每一页都重探
    /// 会让一次会话等两次会话的装载。
    pub fn open_choice(
        path: &Path,
        scale: u32,
        max_pixels: usize,
        min_input_edge: u32,
    ) -> Result<(Self, RuntimeChoice), ComputeError> {
        Self::open_choice_observed(path, scale, max_pixels, min_input_edge, &CancelToken::none(), &|_| {})
    }

    /// Report cold-model work and stop between native calls when the page leaves.
    /// Session compilation itself cannot be safely interrupted in-process.
    pub fn open_choice_observed(
        path: &Path, scale: u32, max_pixels: usize, min_input_edge: u32,
        cancel: &CancelToken, progress: &dyn Fn(u32),
    ) -> Result<(Self, RuntimeChoice), ComputeError> {
        cancel.check()?;
        if scale == 0 {
            return Err(ComputeError::InvalidManifest(
                "model scale must be at least 1".into(),
            ));
        }
        let requested = *platform_preference()
            .first()
            .unwrap_or(&RuntimeId::Cpu);
        let candidate = available_runtimes()
            .into_iter()
            .find(|id| id.is_hardware_accelerated());
        let (used, verdict) = match candidate {
            // 探针自己也要把一块图跑完，所以配置离谱时不做实测（`scale` 不在 1..=4、
            // 最小边大于 256）：直接用谁都能跑的 CPU。
            Some(_) if !(1..=4).contains(&scale) || min_input_edge > 256 => (
                RuntimeId::Cpu,
                ValidationVerdict::Failed {
                    reason: format!(
                        "scale {scale} / 最小边 {min_input_edge} 超出可实测范围（1..=4 且 ≤256）"
                    ),
                },
            ),
            Some(runtime) => match validate_runtime_cached_observed(path, runtime, scale, min_input_edge, cancel, progress)? {
                ValidationVerdict::Passed => (runtime, ValidationVerdict::Passed),
                verdict => {
                    eprintln!(
                        "yomika: ONNX {} provider={} 实测不通过（{verdict:?}）；改用 CPU 参照",
                        path.display(),
                        runtime.as_str()
                    );
                    (RuntimeId::Cpu, verdict)
                }
            },
            // 这份构建/这台机器连一条硬件运行库都没有：没得问，也就没得测。
            None => (RuntimeId::Cpu, ValidationVerdict::NotTested),
        };
        progress(28);
        cancel.check()?;
        let opened = Self::open_with_runtime_cancel(path, used, scale, max_pixels, min_input_edge, cancel);
        cancel.check()?;
        let (engine, used, verdict) = match opened {
            Ok(engine) => (engine, used, verdict),
            Err(error) if used.is_hardware_accelerated() => {
                let reason = format!("{} session failed after successful probe: {error}; using CPU reference", used.as_str());
                eprintln!("yomika: {reason}");
                (Self::open_with_runtime_cancel(path, RuntimeId::Cpu, scale, max_pixels, min_input_edge, cancel)?,
                    RuntimeId::Cpu, ValidationVerdict::Failed { reason })
            }
            Err(error) => return Err(error),
        };
        Ok((
            engine,
            RuntimeChoice {
                requested,
                used,
                verdict,
            },
        ))
    }

    /// 只要引擎、不要交代的那条路（宿主里大量既有调用点用它）。
    pub fn open(
        path: &Path,
        scale: u32,
        max_pixels: usize,
        min_input_edge: u32,
    ) -> Result<Self, ComputeError> {
        Self::open_choice(path, scale, max_pixels, min_input_edge).map(|(engine, _)| engine)
    }

    /// 实际用上的运行库。
    pub fn runtime(&self) -> RuntimeId {
        self.runtime
    }

    pub fn max_pixels(&self) -> usize {
        self.max_pixels
    }
}

/// 让一小块梯度图同时过 `runtime` 与 CPU，比较两者的输出。
///
/// 为什么要探针而不是只看「注册成功、跑得出数」：实测里 Real-CUGAN 在 DirectML 上
/// 运行库可用、设备可用、`run` 也不报错，但负垫边 `Pad` 被算错，输出 mean 0.2705
/// ——形状合法、数值错误。所以「能跑」不算证据，「与 CPU 参照一致」才算。
///
/// 点 `RuntimeId::Cpu` 时返回 [`ValidationVerdict::Passed`]：它**就是**参照实现，
/// 没有第二条可以对照的路。真正需要证明的是硬件那几条。
fn static_input_dimensions(shape: &[i64]) -> Option<(u32, u32)> {
    if shape.len() != 4 { return None; }
    let width = if shape[3] > 0 { u32::try_from(shape[3]).ok()? } else { 0 };
    let height = if shape[2] > 0 { u32::try_from(shape[2]).ok()? } else { 0 };
    (width > 0 || height > 0).then_some((width, height))
}

fn resolve_input_dimensions(fixed: Option<(u32,u32)>, width: u32, height: u32) -> (u32,u32) {
    match fixed {
        Some((w,h)) => (if w == 0 { width } else { w }, if h == 0 { height } else { h }),
        None => (width,height),
    }
}

fn profile_has_provider_nodes(profile: &str, runtime: RuntimeId) -> bool {
    let provider = match runtime {
        RuntimeId::DirectMl => "DmlExecutionProvider",
        RuntimeId::CoreMl => "CoreMLExecutionProvider",
        RuntimeId::Nnapi => "NnapiExecutionProvider",
        RuntimeId::Cpu => "CPUExecutionProvider",
    };
    serde_json::from_str::<serde_json::Value>(profile).ok()
        .and_then(|value| value.as_array().cloned())
        .is_some_and(|events| events.iter().any(|event| {
            event.get("cat").and_then(|v| v.as_str()) == Some("Node")
                && event.pointer("/args/provider").and_then(|v| v.as_str()) == Some(provider)
        }))
}

pub fn validate_runtime(
    path: &Path,
    runtime: RuntimeId,
    scale: u32,
    min_input_edge: u32,
) -> ValidationVerdict {
    validate_runtime_observed(path, runtime, scale, min_input_edge, &CancelToken::none(), &|_| {})
        .unwrap_or_else(|error| ValidationVerdict::Failed { reason: error.to_string() })
}

fn validate_runtime_observed(
    path: &Path, runtime: RuntimeId, scale: u32, min_input_edge: u32,
    cancel: &CancelToken, progress: &dyn Fn(u32),
) -> Result<ValidationVerdict, ComputeError> {
    cancel.check()?;
    if runtime == RuntimeId::Cpu {
        return Ok(ValidationVerdict::Passed);
    }
    if scale == 0 || !(1..=4).contains(&scale) {
        return Ok(ValidationVerdict::Failed {
            reason: format!("scale {scale} is outside the probe range 1..=4"),
        });
    }
    let probe_edge = if runtime == RuntimeId::Nnapi { Some(NNAPI_TILE_EDGE.max(min_input_edge)) } else { None };
    let probe = |runtime: RuntimeId| -> Result<Vec<f32>, String> {
        progress(if runtime == RuntimeId::Cpu { 22 } else { 14 });
        cancel.check().map_err(|error| error.to_string())?;
        probe::note_probe_opened();
        // Each probe owns a unique profile prefix; never reuse another model's evidence.
        static PROFILE_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let profile_prefix = crate::runtime::profile_directory().join(format!("yomika-ort-probe-{}-{}", std::process::id(),
            PROFILE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        let builder = model_builder(path, runtime, min_input_edge)?;
        cancel.check().map_err(|error| error.to_string())?;
        let mut session = builder
            .with_profiling(&profile_prefix).map_err(|error| error.to_string())?
            .commit_from_file(path).map_err(|error| error.to_string())?;
        let fixed = session.inputs().first().and_then(|input| input.dtype().tensor_shape())
            .and_then(|shape| static_input_dimensions(shape));
        let (width, height) = resolve_input_dimensions(fixed, probe_edge.unwrap_or(PROBE_WIDTH.max(min_input_edge as usize) as u32), probe_edge.unwrap_or(PROBE_HEIGHT.max(min_input_edge as usize) as u32));
        let (width, height) = (width as usize, height as usize);
        // A probe must remain bounded even for a malformed static model contract.
        if width.saturating_mul(height).saturating_mul(scale as usize).saturating_mul(scale as usize) > 64_000_000 {
            return Err("fixed model input exceeds probe pixel budget".to_string());
        }
    let mut input = vec![0.0_f32; width * height * 3];
    for y in 0..height {
        for x in 0..width {
            input[y * width + x] = x as f32 / (width - 1).max(1) as f32;
            input[width * height + y * width + x] = y as f32 / (height - 1).max(1) as f32;
            input[2 * width * height + y * width + x] = 0.5;
        }
    }
    let expected_shape = [
        1_i64,
        3,
        (height * scale as usize) as i64,
        (width * scale as usize) as i64,
    ];
        let tensor = ort::value::Tensor::from_array(([1_usize, 3, height, width], input.clone()))
            .map_err(|error| error.to_string())?;
        progress(if runtime == RuntimeId::Cpu { 24 } else { 18 });
        cancel.check().map_err(|error| error.to_string())?;
        let started = Instant::now();
        let outputs = session
            .run(ort::inputs![tensor])
            .map_err(|error| error.to_string())?;
        let (shape, values) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|error| error.to_string())?;
        if shape.as_ref() != expected_shape {
            return Err(format!(
                "{} answered with shape {shape:?}, expected {expected_shape:?}",
                runtime.as_str()
            ));
        }
        eprintln!(
            "yomika: ONNX probe provider={} {:?}",
            runtime.as_str(),
            started.elapsed()
        );
        let result = values.to_vec();
        drop(outputs);
        let profile_path = session.end_profiling().map_err(|error| error.to_string())?;
        let profile = std::fs::read_to_string(&profile_path).map_err(|error| error.to_string());
        let _ = std::fs::remove_file(&profile_path);
        if runtime.is_hardware_accelerated() && !profile_has_provider_nodes(&profile?, runtime) {
            return Err(format!("{} registered but no computing node was executed by this provider; CPU-only graph fallback rejected", runtime.as_str()));
        }
        eprintln!("yomika: ONNX provider={} actual graph assignment verified (CPU operator fallback permitted)", runtime.as_str());
        Ok(result)
    };
    let actual = probe(runtime);
    cancel.check()?;
    let actual = match actual {
        Ok(values) => values,
        Err(reason) => return Ok(ValidationVerdict::Failed { reason }),
    };
    let expected = probe(RuntimeId::Cpu);
    cancel.check()?;
    let expected = match expected {
        Ok(values) => values,
        Err(reason) => {
            return Ok(ValidationVerdict::Failed {
                reason: format!("CPU reference failed: {reason}"),
            })
        }
    };
    if outputs_agree(&actual, &expected) {
        return Ok(ValidationVerdict::Passed);
    }
    let mean = actual
        .iter()
        .zip(&expected)
        .map(|(a, b)| f64::from((a - b).abs()))
        .sum::<f64>()
        / actual.len().max(1) as f64;
    Ok(ValidationVerdict::Failed {
        reason: format!(
            "mean {mean:.9} > {} over {} values",
            crate::engine::PROBE_MEAN_ABS_TOLERANCE,
            actual.len()
        ),
    })
}

/// 带记账的 [`validate_runtime`]：同一份字节、同一条运行库、同一组参数只真探一次。
///
/// 指纹读不出来（路径不存在、权限不够）就不记账——没有内容可以指认，硬记一条只会把
/// 「这个路径当时的样子」当成「这份模型的样子」，而下次拿到的可能是另一份文件。
pub fn validate_runtime_cached(
    path: &Path, runtime: RuntimeId, scale: u32, min_input_edge: u32,
) -> ValidationVerdict {
    validate_runtime_cached_observed(path, runtime, scale, min_input_edge, &CancelToken::none(), &|_| {})
        .unwrap_or_else(|error| ValidationVerdict::Failed { reason: error.to_string() })
}

fn validate_runtime_cached_observed(
    path: &Path, runtime: RuntimeId, scale: u32, min_input_edge: u32,
    cancel: &CancelToken, progress: &dyn Fn(u32),
) -> Result<ValidationVerdict, ComputeError> {
    cancel.check()?;
    if runtime == RuntimeId::Cpu { return Ok(ValidationVerdict::Passed); }
    let Ok((byte_length, content_hash)) = file_fingerprint(path) else {
        return validate_runtime_observed(path, runtime, scale, min_input_edge, cancel, progress);
    };
    cancel.check()?;
    let key = ProbeKey { content_hash, byte_length, kind: ProbeKind::Upscale, runtime, scale, min_input_edge };
    if let Some(record) = probe::recall(&key) { return Ok(record.verdict); }
    let before = probe::probes_opened();
    // Cancelled probes must not poison the process-wide model verdict cache.
    let verdict = validate_runtime_observed(path, runtime, scale, min_input_edge, cancel, progress)?;
    probe::remember(key, verdict.clone(), probe::probes_opened() - before);
    Ok(verdict)
}

/// 瓦片长度必须与声明的宽高一致。拦在模型之前：不然它拿到的是一段撕裂的缓冲区，
/// 而 ONNX 只会照着声明的形状去读，越界读出来的东西不会有任何报错。
fn check_tile_shape(rgba: &[u8], width: u32, height: u32) -> Result<(), ComputeError> {
    if rgba.len() != width as usize * height as usize * 4 {
        return Err(ComputeError::InvalidInput(
            "RGBA tile dimensions do not match".into(),
        ));
    }
    Ok(())
}

impl UpscaleEngine for OnnxEngine {
    fn fixed_input_size(&self) -> Option<(u32, u32)> { self.fixed_input }
    fn scale(&self) -> u32 {
        self.scale
    }

    fn upscale_tile(
        &self,
        rgba: &[u8],
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, ComputeError> {
        check_tile_shape(rgba, width, height)?;
        // 最近邻结果既是 alpha 载体、也是调用方期待的形状，所以模型答了一个错尺寸
        // 也造不出对不上的缓冲区。
        let mut output = cpu_scale_rgba(rgba, width, height, self.scale, self.max_pixels)?.rgba;

        let (input_width, input_height) = resolve_input_dimensions(self.fixed_input,
            width.max(self.min_input_edge),
            height.max(self.min_input_edge),
        );
        if width > input_width || height > input_height {
            return Err(ComputeError::InvalidInput("tile exceeds fixed model input shape".into()));
        }
        let grown;
        let source = if (input_width, input_height) == (width, height) {
            rgba
        } else {
            grown = pad_rgba_edges(rgba, width, height, input_width, input_height);
            &grown[..]
        };

        let input = ort::value::Tensor::from_array((
            vec![
                1_i64,
                3,
                i64::from(input_height),
                i64::from(input_width),
            ],
            rgba_to_nchw(source, input_width, input_height),
        ))
        .map_err(|error| ComputeError::InvalidInput(format!("ONNX input failed: {error}")))?;

        let mut session = self
            .session
            .lock()
            .map_err(|_| ComputeError::InvalidInput("ONNX session lock poisoned".into()))?;
        let outputs = session
            .run(ort::inputs![input])
            .map_err(|error| ComputeError::InvalidInput(format!("ONNX run failed: {error}")))?;
        let (shape, values) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|error| ComputeError::InvalidInput(format!("ONNX output failed: {error}")))?;

        let expected = [
            1_i64,
            3,
            i64::from(input_height) * i64::from(self.scale),
            i64::from(input_width) * i64::from(self.scale),
        ];
        if shape.as_ref() != expected {
            // 几乎总是清单里的 `scale` 与图对不上，或者图不保持它拿到的尺寸。
            return Err(ComputeError::InvalidManifest(format!(
                "ONNX output shape {shape:?} does not match the declared x{} scale",
                self.scale
            )));
        }
        if values.iter().any(|value| !value.is_finite()) {
            return Err(ComputeError::InvalidInput("ONNX returned non-finite pixels".into()));
        }
        nchw_over_rgba(
            values,
            (input_width * self.scale) as usize,
            (input_height * self.scale) as usize,
            (width * self.scale) as usize,
            (height * self.scale) as usize,
            &mut output,
        );
        preserve_neutral_chroma(rgba, width, height, self.scale, &mut output);
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelling_model_probe_stops_before_opening_or_falling_back() {
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cancel = crate::cancel::CancelToken::watch(flag.clone());
        let result = validate_runtime_observed(Path::new("does-not-exist.onnx"), RuntimeId::Nnapi, 2, 1,
            &cancel, &|_| { flag.store(true, std::sync::atomic::Ordering::Relaxed); });
        assert_eq!(result, Err(ComputeError::Cancelled));
        let result = OnnxEngine::open_choice_observed(Path::new("does-not-exist.onnx"), 2, 1000, 1, &cancel, &|_| {});
        assert!(matches!(result, Err(ComputeError::Cancelled)));
    }

    #[cfg(not(feature = "directml"))]
    #[test]
    fn cancellation_before_final_session_load_does_not_touch_the_model() {
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cancel = CancelToken::watch(flag.clone());
        let result = OnnxEngine::open_choice_observed(Path::new("does-not-exist.onnx"), 2, 1000, 1, &cancel,
            &|percent| { if percent == 28 { flag.store(true, std::sync::atomic::Ordering::Relaxed); } });
        assert!(matches!(result, Err(ComputeError::Cancelled)));
    }

    #[cfg(all(windows, feature = "directml"))]
    #[test]
    #[ignore = "requires an installed x2 ONNX model and real DirectML GPU"]
    fn adaptive_gpu_tiles_benchmark_against_default_tiles() {
        let path = std::env::var_os("YOMIKA_UPSCALE_MODEL").map(std::path::PathBuf::from)
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/release/data/models/waifu2x-upconv7/1/model.onnx"));
        assert!(path.is_file(), "set YOMIKA_UPSCALE_MODEL to an installed x2 model");
        assert_eq!(validate_runtime(&path, RuntimeId::DirectMl, 2, 1), ValidationVerdict::Passed);
        let engine = OnnxEngine::open_with_runtime(&path, RuntimeId::DirectMl, 2, 64_000_000, 1).unwrap();
        let memory = crate::dlssnr::gpu::video_memory_for_device_index(0).map(|m| crate::resources::GpuMemory { budget_bytes: m.budget_bytes, used_bytes: m.used_bytes });
        let padding = crate::upscale::DEFAULT_TILE_PADDING.max(engine.tile_padding());
        let adaptive = crate::resources::auto_tile_size(memory, 2, padding, 1, engine.fixed_input_size());
        let mut rgba = vec![0; 256 * 256 * 4];
        for y in 0..256 { for x in 0..256 {
            let index = (y * 256 + x) * 4;
            rgba[index..index+4].copy_from_slice(&[x as u8,y as u8,((x+y)/2) as u8,255]);
        }}
        // Warm the session before timing the two tile plans.
        engine.upscale_tile(&vec![128; 32*32*4],32,32).unwrap();
        let run = |tile_size| {
            let start = Instant::now();
            let output = crate::upscale::upscale_rgba(&engine,&rgba,256,256,crate::upscale::UpscaleOptions { tile_size, tile_padding: padding, ..Default::default() }).unwrap();
            (output,start.elapsed())
        };
        let (baseline,baseline_time) = run(crate::upscale::DEFAULT_TILE_SIZE);
        let (actual,adaptive_time) = run(adaptive);
        let mean = baseline.rgba.iter().zip(&actual.rgba).map(|(a,b)| f64::from(a.abs_diff(*b))).sum::<f64>() / baseline.rgba.len() as f64;
        let max = baseline.rgba.iter().zip(&actual.rgba).map(|(a,b)| a.abs_diff(*b)).max().unwrap();
        eprintln!("adaptive upscale GPU memory={memory:?} default_tiles={} adaptive_tile={adaptive} adaptive_tiles={} baseline={baseline_time:?} adaptive={adaptive_time:?} mean_byte_difference={mean:.6} max_byte_difference={max}",baseline.tiles,actual.tiles);
        assert_eq!((actual.width,actual.height),(baseline.width,baseline.height));
        assert!(mean <= 2.0,"tile seam average exceeded 2/255: {mean}");
    }

    #[test]
    fn nnapi_specializes_named_dynamic_axes_and_preserves_static_axes() {
        let dims = nnapi_overrides(&[1, 3, -1, -1], &["", "", "height", "width"], 20).unwrap();
        assert_eq!(dims, vec![("height".to_string(), 128), ("width".to_string(), 128)]);
        assert!(nnapi_overrides(&[1, 3, 64, 96], &["", "", "", ""], 20).unwrap().is_empty());
        assert!(nnapi_overrides(&[1, 3, -1, -1], &["", "", "", "width"], 20).is_err());
    }

    #[test]
    fn nnapi_tile_contract_compiles_a_real_model_and_pads_narrow_edge_tiles() {
        let path = bundled_model();
        assert!(path.is_file(), "bundled model required: {}", path.display());
        // Exercise the same graph specialization on the CPU runtime, so this
        // contract is verified even on a machine without an Android device.
        let session = specialize_nnapi(crate::runtime::builder(RuntimeId::Cpu).unwrap(), &path, 1)
            .unwrap().commit_from_file(&path).unwrap();
        let shape = session.inputs()[0].dtype().tensor_shape().unwrap();
        assert_eq!(shape.as_ref(), &[1, 3, 128, 128]);
        let engine = OnnxEngine {
            fixed_input: static_input_dimensions(shape), session: Mutex::new(session),
            runtime: RuntimeId::Cpu, scale: 2, max_pixels: 64_000_000, min_input_edge: 1,
        };
        let output = engine.upscale_tile(&vec![128; 9 * 17 * 4], 9, 17).unwrap();
        assert_eq!(output.len(), 18 * 34 * 4);
    }

    #[test]
    fn fixed_and_partial_model_axes_control_probe_and_tile_dimensions() {
        assert_eq!(static_input_dimensions(&[1, 3, 256, 384]), Some((384, 256)));
        assert_eq!(static_input_dimensions(&[1, 3, -1, 256]), Some((256, 0)));
        assert_eq!(static_input_dimensions(&[1, 3, 128, -1]), Some((0, 128)));
        assert_eq!(static_input_dimensions(&[1, 3, -1, -1]), None);
        assert_eq!(resolve_input_dimensions(Some((384, 256)), 72, 64), (384, 256));
        assert_eq!(resolve_input_dimensions(Some((256, 0)), 72, 64), (256, 64));
    }

    /// CPU 就是参照，所以「对 CPU 做实测」只能有一个结论：通过。这条看着像废话，但它
    /// 挡住的是「探针在 CPU 上也硬要比一次、比完还可能判失败」那种自相矛盾。
    #[test]
    fn assignment_evidence_requires_a_computing_node_on_the_requested_provider() {
        assert!(profile_has_provider_nodes(r#"[{"cat":"Node","args":{"provider":"NnapiExecutionProvider"}}]"#, RuntimeId::Nnapi));
        assert!(!profile_has_provider_nodes(r#"[{"cat":"Node","args":{"provider":"CPUExecutionProvider"}}]"#, RuntimeId::Nnapi));
        assert!(!profile_has_provider_nodes(r#"[{"cat":"Session","args":{"provider":"CoreMLExecutionProvider"}}]"#, RuntimeId::CoreMl));
    }

    #[test]
    fn the_reference_runtime_is_always_a_pass() {
        let verdict = validate_runtime(Path::new("does-not-exist.onnx"), RuntimeId::Cpu, 2, 20);
        assert_eq!(verdict, ValidationVerdict::Passed);
    }

    /// 一个声明就错了的 `scale` 不许去开探针（探针要按 `scale` 算期望形状）。
    #[test]
    fn a_scale_outside_the_probe_range_fails_before_any_session_opens() {
        let verdict = validate_runtime(Path::new("does-not-exist.onnx"), RuntimeId::DirectMl, 9, 1);
        assert!(matches!(verdict, ValidationVerdict::Failed { .. }), "{verdict:?}");
        assert!(!outputs_agree(&[0.0], &[0.27]), "阈值不许被放宽");
    }

    #[test]
    fn a_zero_scale_is_refused_before_the_model_is_opened() {
        // 路径不存在也要先因为 scale 被拒：开一次会话要几百毫秒 + 一笔显存。
        let error = match OnnxEngine::open_with_runtime(
            Path::new("does-not-exist.onnx"),
            RuntimeId::Cpu,
            0,
            1_000,
            1,
        ) {
            Ok(_) => panic!("零倍放大不许开会话"),
            Err(error) => error,
        };
        assert!(matches!(error, ComputeError::InvalidManifest(_)), "{error:?}");
    }

    /// 尺寸对不上的瓦片在碰模型之前就被拒（不然模型会拿到一个撕裂的缓冲区）。
    #[test]
    fn a_tile_whose_length_disagrees_with_its_shape_is_refused() {
        let error = check_tile_shape(&[0, 0, 0, 255], 4, 4).expect_err("长度对不上");
        assert!(matches!(error, ComputeError::InvalidInput(_)), "{error:?}");
        assert!(check_tile_shape(&vec![0_u8; 4 * 4 * 4], 4, 4).is_ok());
    }

    fn bundled_model() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../resources/models/waifu2x-upconv7/model.onnx")
    }

    /// 「没得问」也要说出来：这份构建/这台机器没有硬件运行库时，交代里不许出现一条
    /// 没人测过却说「用了显卡」的结论——`NotTested` 的意思正是「不等于通过」。
    #[cfg(not(all(windows, feature = "directml")))]
    #[test]
    fn a_choice_nobody_could_test_is_reported_as_untested() {
        let _guard = crate::probe::test_lock();
        let path = bundled_model();
        if !path.is_file() {
            eprintln!("skipping: {} is not present", path.display());
            return;
        }
        let (engine, choice) = OnnxEngine::open_choice(&path, 2, 64_000_000, 1).expect("engine");
        // 报告与实际用上的那条必须一致：报告撒谎比回退更糟。
        assert_eq!(engine.runtime(), choice.used);
        assert_eq!(choice.used, RuntimeId::Cpu);
        // 这条构建里没有硬件运行库 ⇒ 平台偏好（Windows 上是 directml）没给上。
        assert_eq!(choice.verdict, ValidationVerdict::NotTested);
        #[cfg(windows)]
        {
            assert_eq!(choice.requested, RuntimeId::DirectMl);
            assert!(choice.fell_back(), "想要 directml 却只能给 cpu，就是回退了");
            let reason = choice.fallback_reason().expect("回退必须有原因");
            assert!(reason.contains("不可用"), "{reason}");
        }
        // 没回退就没有原因可说（苹果/安卓构建里 requested 本来就是 cpu）。
        #[cfg(not(windows))]
        assert!(!choice.fell_back() && choice.fallback_reason().is_none());
    }

    /// 有显卡可问时：同一份模型问第二遍不许再开会话——docs/71 对这条的要求是
    /// 「GPU probe 只在冷 model/新环境执行」，而每页重探会让一次任务的等待翻倍。
    /// 这条要真的 DML：不带 `directml` 的构建里它编译不进来（也就没证据）。
    #[cfg(all(windows, feature = "directml"))]
    #[test]
    fn the_same_question_is_not_probed_twice_and_a_new_one_is() {
        let _guard = crate::probe::test_lock();
        let path = bundled_model();
        if !path.is_file() {
            eprintln!("skipping: {} is not present", path.display());
            return;
        }
        crate::probe::forget_all();
        let before = crate::probe::probes_opened();
        let first = validate_runtime_cached(&path, RuntimeId::DirectMl, 2, 1);
        let after_first = crate::probe::probes_opened();
        assert!(
            after_first > before,
            "第一次必须真的探过（不然这条测试什么都没证明）"
        );

        let second = validate_runtime_cached(&path, RuntimeId::DirectMl, 2, 1);
        assert_eq!(second, first, "同一个问题必须给同一个结论");
        assert_eq!(
            crate::probe::probes_opened(),
            after_first,
            "同一份字节问第二遍不该再开会话"
        );

        // 换一个参数就是另一个问题：必须重新实测（否则「测过」会被错用到别的配置上）。
        let _ = validate_runtime_cached(&path, RuntimeId::DirectMl, 2, 33);
        assert!(crate::probe::probes_opened() > after_first);

        // 走完公开路径时，交代与实际会话仍然一致。
        let (engine, choice) = OnnxEngine::open_choice(&path, 2, 64_000_000, 1).expect("engine");
        assert_eq!(engine.runtime(), choice.used);
        match choice.verdict {
            ValidationVerdict::Passed => {
                assert_eq!(choice.used, RuntimeId::DirectMl);
                assert!(!choice.fell_back(), "探针过了就没有回退可言");
            }
            _ => {
                assert_eq!(choice.used, RuntimeId::Cpu);
                assert!(choice.fell_back());
                assert!(choice.fallback_reason().is_some(), "回退必须给原因");
            }
        }
    }
}

//! Anime4K 的 GPU 执行体。
//!
//! 与 [`super::Anime4kEngine`]（CPU 解释器）**共用同一份解析结果**：`compile_chain`
//! 把钉住的 GLSL 解成一条 pass 链，这里把每个 pass 翻成一条 WGSL 计算管道，逐 pass
//! 派发到显卡上。两条路的差别只有「谁来算」，规则（双线性采样 + 边缘钳制、列主序
//! `mat4 * tap`、`PREKERNEL` 排在 `MAIN` 之后、量化回 8 位与 alpha 最近邻搬运）
//! 一模一样——判据是 `crates/compute-core/tests/anime4k_gpu.rs` 里的逐像素比对。
//!
//! 为什么是 wgpu 而不是「宿主那套 D3D12」：这条路同时要能在 worker 进程里跑，而
//! worker 是**只带编进去的东西**的单文件载荷，宿主与 worker 又不许各抄一套。wgpu 的
//! DX12 后端要 `d3dcompiler_47.dll` 在运行时把 HLSL 编出来，Vulkan 后端直接出
//! SPIR-V；由它去挑后端，比我们自己钉死一套驱动接口更省事，`adapter_description()`
//! 会把真挑中的那一个报出来（这台机器上是 Vulkan）。
//!
//! 数据布局：**一条链的所有层住同一个存储缓冲**（RGBA 交错、每层一个元素基址），
//! 参数（输出层的基址、尺寸，以及每一层的基址与尺寸）走一个 uniform 缓冲。为什么
//! 不是「一层一个绑定」：`Anime4K_Upscale_CNN_x2_VL` 里那条 `Conv-4x1x1x56` 一层就
//! 要读 14 路来路，而 `maxStorageBuffersPerShaderStage` 的 WebGPU 上限是 10——层数
//! 一多，绑定方案在规范里就不成立。合成一条缓冲之后每个 pass 只有两个绑定（参数 +
//! 像素池），层数再多也只是参数里多一行。
//!
//! 没有采样器、没有纹理格式：这里的双线性是**自己写的**，为的是和 CPU 那份逐位对齐
//! （见 WGSL 里的 `load` / `sample`）。
//!
//! 设备只开一次（[`CONTEXT`]），三条预设的管道各自编一次并缓存；拿不到设备时
//! [`Anime4kGpuEngine::open`] 返回错误，调用方回落到 CPU 解释器。

use std::sync::{Arc, Mutex, OnceLock};

use wgpu::util::DeviceExt;

use super::{compile_chain, quantize_tile, Activation, Anime4kPreset, PassKind, Program};
use crate::error::ComputeError;
use crate::upscale::UpscaleEngine;

/// 每个线程块覆盖 `8x8` 个输出像素。
const WORKGROUP: u32 = 8;

/// 一层的一次「版本」在那条像素池里的位置：元素基址（`f32` 计数，不是字节）与尺寸。
///
/// 同名的层可以同时存在多个版本——mpv 里一个 hook 读的是当前帧、写的是下一帧；见
/// `upscale_tile` 里那段分配注释。
#[derive(Clone, Copy)]
struct Region {
    base: u32,
    width: u32,
    height: u32,
}

static CONTEXT: OnceLock<Result<SharedContext, String>> = OnceLock::new();

struct SharedContext {
    device: wgpu::Device,
    queue: wgpu::Queue,
    adapter: String,
    limits: wgpu::Limits,
    /// 每条预设一次：解析结果 + 已经编好的管道。
    chains: Mutex<std::collections::HashMap<&'static str, Arc<Chain>>>,
}

struct Chain {
    program: Program,
    passes: Vec<CompiledPass>,
}

struct CompiledPass {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
    /// 这一层读了哪些层——派发前要照 CPU 那条路的口径检查它们都被写过。
    inputs: Vec<usize>,
}

/// 这条来路的名字。报告与回退交代里用它（`EngineReport.device_id` 那一栏用的是
/// [`adapter_description`] 里那句更像样的「哪块卡」）。
pub const ENGINE_LABEL: &str = "wgpu";

/// 这份构建能不能真拿到一块显卡。拿不到时返回原因（调用方据此回落 CPU，并把原因
/// 说给用户听）。
pub fn adapter_description() -> Result<String, String> {
    match context() {
        Ok(context) => Ok(context.adapter.clone()),
        Err(error) => Err(error.to_string()),
    }
}

/// 一次都没问过的时候不建设备：`is_available` 只回答「问过而且成了」。
pub fn is_available() -> bool {
    matches!(CONTEXT.get(), Some(Ok(_)))
}

fn context() -> Result<&'static SharedContext, ComputeError> {
    CONTEXT
        .get_or_init(open_context)
        .as_ref()
        .map_err(|reason| ComputeError::InvalidInput(format!("Anime4K GPU 用不了：{reason}")))
}

fn open_context() -> Result<SharedContext, String> {
    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
        ..Default::default()
    }))
    .map_err(|error| format!("没有可用的显卡适配器：{error}"))?;
    let info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("anime4k-gpu"),
        ..Default::default()
    }))
    .map_err(|error| format!("开不了计算设备：{error}"))?;
    let limits = adapter.limits();
    Ok(SharedContext {
        device,
        queue,
        adapter: format!(
            "{} ({:?}, {} {})",
            info.name, info.backend, info.driver, info.driver_info
        ),
        limits,
        chains: Mutex::new(std::collections::HashMap::new()),
    })
}

/// 一条预设的 GPU 执行体。`open` 会解析并编译（每条预设第一次才真的编），之后
/// `upscale_tile` 每次只是建缓冲、派发、取回。
pub struct Anime4kGpuEngine {
    chain: Arc<Chain>,
}

impl Anime4kGpuEngine {
    pub fn open(preset: &Anime4kPreset) -> Result<Self, ComputeError> {
        let context = context()?;
        let mut chains = context
            .chains
            .lock()
            .map_err(|_| ComputeError::InvalidInput("Anime4K 管道缓存被毒死".into()))?;
        if let Some(chain) = chains.get(preset.id) {
            return Ok(Self {
                chain: Arc::clone(chain),
            });
        }
        let program = compile_chain(preset)?;
        let passes = compile_passes(&context.device, &program)?;
        let chain = Arc::new(Chain { program, passes });
        chains.insert(preset.id, Arc::clone(&chain));
        Ok(Self { chain })
    }

    /// 这一档现在真的跑在哪块设备上（探针与轮次记录用它当证据）。
    pub fn adapter(&self) -> Result<String, ComputeError> {
        Ok(context()?.adapter.clone())
    }
}

impl UpscaleEngine for Anime4kGpuEngine {
    fn scale(&self) -> u32 {
        self.chain.program.scale
    }

    fn tile_padding(&self) -> u32 {
        self.chain.program.padding
    }

    fn upscale_tile(&self, rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, ComputeError> {
        let program = &self.chain.program;
        if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 {
            return Err(ComputeError::InvalidInput(
                "RGBA tile dimensions do not match".into(),
            ));
        }
        let context = context()?;

        // 每条 pass 的输出尺寸只取决于上一层，与像素内容无关——所以整条链的层尺寸、
        // 每一层每一次版本的区域基址，在派发之前就能全部算出来（这正是「一条池子
        // 装下所有层」的前提）。
        //
        // 「版本」是必须的：mpv 里一个 hook 读的是当前帧、写的是下一帧，同一个名字
        // 的读写**不走同一块内存**。这条链的最后一笔就是「读 16x16 的 MAIN、写
        // 32x32 的 MAIN」，真按一块内存算，先跑的调用会把后跑的调用还要读的残差盖
        // 掉——实测差到 255 档。所以：一条 pass 只要读它自己写的那个名字，就给它一
        // 块新区域；否则那一层沿用现有的区域（尺寸没变就地覆盖也安全，因为它不读
        // 自己）。
        if program.slots.is_empty() {
            return Err(super::unsupported("chain has no textures".into()));
        }
        let mut elements: u64 = 0;
        let mut allocate = |width: u32, height: u32| -> Result<Region, ComputeError> {
            let count = u64::from(width) * u64::from(height) * 4;
            if elements + count > u32::MAX as u64 {
                return Err(super::unsupported(format!(
                    "GPU 的像素池要 {} 个元素，超过基址能表示的范围",
                    elements + count
                )));
            }
            let region = Region {
                base: elements as u32,
                width,
                height,
            };
            elements += count;
            Ok(region)
        };
        let mut sizes: Vec<Option<(u32, u32)>> = vec![None; program.slots.len()];
        let mut current: Vec<Option<Region>> = vec![None; program.slots.len()];
        // 第 0 层就是 MAIN，与 CPU 那条路同一个约定。
        sizes[0] = Some((width, height));
        current[0] = Some(allocate(width, height)?);
        let main_region = current[0].expect("MAIN 刚分配过");
        let mut snapshots: Vec<Vec<Option<Region>>> = Vec::with_capacity(program.passes.len());
        let mut outputs: Vec<Region> = Vec::with_capacity(program.passes.len());
        for (index, pass) in program.passes.iter().enumerate() {
            let pass_width = super::eval_size(&pass.width, &sizes)?;
            let pass_height = super::eval_size(&pass.height, &sizes)?;
            let snapshot = current.clone();
            let reads_itself = self.chain.passes[index].inputs.contains(&pass.output);
            let region = match current[pass.output] {
                Some(region)
                    if !reads_itself
                        && region.width == pass_width
                        && region.height == pass_height =>
                {
                    region
                }
                _ => allocate(pass_width, pass_height)?,
            };
            current[pass.output] = Some(region);
            sizes[pass.output] = Some((pass_width, pass_height));
            snapshots.push(snapshot);
            outputs.push(region);
        }
        let bytes = elements * 4;
        if bytes > u64::from(context.limits.max_storage_buffer_binding_size)
            || bytes > context.limits.max_buffer_size
        {
            return Err(super::unsupported(format!(
                "这一块 {width}x{height} 的层加起来要 {bytes} 字节，超过这块设备能给单个绑定的上限"
            )));
        }

        // 池子一次建好：MAIN 的像素从上传队列写进去，其余层留零——但那是无所谓的，
        // 每一层都在被读之前先被写（派发之前会逐层查一遍），没人读得到没写过的格子。
        let pool = context.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("anime4k-pool"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut main_pixels: Vec<f32> = Vec::with_capacity(width as usize * height as usize * 4);
        for pixel in rgba.chunks_exact(4) {
            main_pixels.push(f32::from(pixel[0]) / 255.0);
            main_pixels.push(f32::from(pixel[1]) / 255.0);
            main_pixels.push(f32::from(pixel[2]) / 255.0);
            // 与 CPU 的 `Texture::from_rgba` 同源：mpv 交给第一条卷积的是一帧不透明
            // 画面，喂页面自己的 alpha 会让每个碰它的权重走味。
            main_pixels.push(1.0);
        }
        context.queue.write_buffer(
            &pool,
            u64::from(main_region.base) * 4,
            bytemuck::cast_slice(&main_pixels),
        );

        // 派发之前先把「每一层都有人写」这件事查完：错误作用域一旦压上，退出路径上
        // 就必须有人 pop 掉它，所以能在派发前判的全在派发前判。
        for (index, pass) in program.passes.iter().enumerate() {
            if sizes[pass.output].is_none() {
                return Err(super::unsupported(format!(
                    "{} was never sized",
                    program.slot_name(pass.output)
                )));
            }
            for slot in self.chain.passes[index].inputs.iter() {
                if sizes[*slot].is_none() {
                    return Err(super::unsupported(format!(
                        "texture {} was never written",
                        program.slot_name(*slot)
                    )));
                }
            }
        }

        let scope = context
            .device
            .push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = context
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("anime4k-gpu"),
            });
        for (index, compiled) in self.chain.passes.iter().enumerate() {
            let write = outputs[index];
            let (out_width, out_height) = (write.width, write.height);
            for slot in compiled.inputs.iter() {
                if sizes[*slot].is_none() {
                    return Err(super::unsupported(format!(
                        "texture {} was never written",
                        program.slot_name(*slot)
                    )));
                }
            }
            let params = context
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("anime4k-params"),
                    contents: &params_bytes(write, &snapshots[index]),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
            let bind_group = context.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("anime4k-pass"),
                layout: &compiled.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: params.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: pool.as_entire_binding(),
                    },
                ],
            });
            {
                let mut compute = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("anime4k-pass"),
                    timestamp_writes: None,
                });
                compute.set_pipeline(&compiled.pipeline);
                compute.set_bind_group(0, &bind_group, &[]);
                compute.dispatch_workgroups(
                    out_width.div_ceil(WORKGROUP),
                    out_height.div_ceil(WORKGROUP),
                    1,
                );
            }
        }

        let final_region = current[program.output].ok_or_else(|| {
            super::unsupported(format!(
                "chain produced no {}",
                program.slot_name(program.output)
            ))
        })?;
        let (out_width, out_height) = (final_region.width, final_region.height);
        if out_width != width * program.scale || out_height != height * program.scale {
            return Err(super::unsupported(format!(
                "chain produced {out_width}x{out_height}, expected {}x{}",
                width * program.scale,
                height * program.scale
            )));
        }
        let out_bytes = u64::from(out_width) * u64::from(out_height) * 16;
        let readback = context.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("anime4k-readback"),
            size: out_bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_buffer_to_buffer(
            &pool,
            u64::from(final_region.base) * 4,
            &readback,
            0,
            out_bytes,
        );
        context.queue.submit(Some(encoder.finish()));

        let mapped = map_read(&context.device, &readback)?;
        let validation = pollster::block_on(scope.pop());
        if let Some(error) = validation {
            return Err(ComputeError::InvalidInput(format!(
                "Anime4K 的派发没通过校验：{error}"
            )));
        }
        let bytes: &[u8] = &mapped;
        let pixels: &[f32] = bytemuck::cast_slice(bytes);
        let result = quantize_tile(
            rgba,
            width,
            height,
            pixels,
            out_width,
            out_height,
            program.scale,
        );
        drop(mapped);
        readback.unmap();
        Ok(result)
    }
}

/// `Params` 的字节布局必须与 WGSL 里那个结构体一致：输出层的基址与尺寸，然后
/// **每一层**一行 `vec4<u32>`（基址、宽、高、0）。没有尺寸的层写 0——它一旦被某条
/// pass 读到，派发之前就报错了。
fn params_bytes(out: Region, regions: &[Option<Region>]) -> Vec<u8> {
    let mut words = Vec::with_capacity(4 + regions.len() * 4);
    words.extend_from_slice(&[out.base, out.width, out.height, 0]);
    for region in regions.iter() {
        let (base, width, height) = match region {
            Some(region) => (region.base, region.width, region.height),
            None => (0, 0, 0),
        };
        words.extend_from_slice(&[base, width, height, 0]);
    }
    bytemuck::cast_slice(&words).to_vec()
}

/// 等 GPU 算完并把结果映射回来。
///
/// `map_async` 的回调**由 `poll` 驱动**，而 `poll` 只保证「等的那次提交完成、已排队的
/// 回调被调用」。同一块设备上若有别的线程在派发（worker 里前后台各算一页），一次
/// `Wait` 有可能在回调排到队尾之前就回来了——所以这里除了等，还在回报为空时补
/// 非阻塞的 `Poll` 把它抽干，而不是把「还没轮到回调」当成「GPU 没交结果」。
fn map_read(
    device: &wgpu::Device,
    buffer: &wgpu::Buffer,
) -> Result<wgpu::BufferView, ComputeError> {
    let slice = buffer.slice(..);
    let (sender, receiver) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = sender.send(result);
    });
    let mut wait = Some(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(std::time::Duration::from_millis(500)),
    });
    for _ in 0..64 {
        if let Err(error) = device.poll(wait.take().unwrap_or(wgpu::PollType::Poll)) {
            // 超时不是失败：它只是说这一趟还没算完，接着等下一趟。
            if !matches!(error, wgpu::PollError::Timeout) {
                return Err(ComputeError::InvalidInput(format!(
                    "等 GPU 算完失败了：{error}"
                )));
            }
        }
        match receiver.try_recv() {
            Ok(verdict) => {
                verdict.map_err(|error| {
                    ComputeError::InvalidInput(format!("取回结果失败了：{error}"))
                })?;
                return slice.get_mapped_range().map_err(|error| {
                    ComputeError::InvalidInput(format!("读不了映射区：{error}"))
                });
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => std::thread::yield_now(),
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                return Err(ComputeError::InvalidInput(
                    "GPU 的取回回调没落地就断了".into(),
                ))
            }
        }
    }
    Err(ComputeError::InvalidInput(
        "GPU 提交之后一直没交回结果".into(),
    ))
}

fn compile_passes(
    device: &wgpu::Device,
    program: &Program,
) -> Result<Vec<CompiledPass>, ComputeError> {
    let mut passes = Vec::with_capacity(program.passes.len());
    for pass in &program.passes {
        let (source, inputs) = generate(program, pass)?;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("anime4k-pass"),
            source: wgpu::ShaderSource::Wgsl(source.into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("anime4k-pass"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("anime4k-pass"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("anime4k-pass"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        passes.push(CompiledPass {
            pipeline,
            layout,
            inputs,
        });
    }
    Ok(passes)
}

/// 把一个 pass 翻成 WGSL，并给出它读了哪些层（按首次出现的顺序）。
fn generate(program: &Program, pass: &super::Pass) -> Result<(String, Vec<usize>), ComputeError> {
    let kind = match &pass.kind {
        PassKind::Conv { .. } => "conv",
        PassKind::DepthToSpace { .. } => "depth-to-space",
        PassKind::MaxLuma { .. } => "max-luma",
        PassKind::ClampLuma { .. } => "clamp-luma",
    };
    let mut inputs: Vec<usize> = Vec::new();
    let mut body = String::new();
    let mut declarations = String::new();
    match &pass.kind {
        PassKind::Conv {
            terms,
            bias,
            residual,
        } => {
            let mut head = Vec::with_capacity(4);
            for value in bias.iter() {
                head.push(float(*value)?);
            }
            body.push_str(&format!("    var value = vec4<f32>({});\n", head.join(", ")));
            for (index, term) in terms.iter().enumerate() {
                note_slot(&mut inputs, term.texture);
                declarations.push_str(&matrix_constant(index, &term.weights)?);
                let tap = tap_expression(term.texture, term.offset)?;
                let sampled = format!("let s{index} = {tap};");
                let activated = match term.activation {
                    Activation::Identity => format!("{sampled}\n        let a{index} = s{index};"),
                    Activation::Relu => {
                        format!("{sampled}\n        let a{index} = max(s{index}, vec4<f32>(0.0));")
                    }
                    Activation::NegRelu => {
                        format!("{sampled}\n        let a{index} = max(-s{index}, vec4<f32>(0.0));")
                    }
                };
                body.push_str(&format!(
                    "    {{\n        {activated}\n        value = value + W{index} * a{index};\n    }}\n"
                ));
            }
            if let Some(residual) = residual {
                note_slot(&mut inputs, *residual);
                body.push_str(&format!(
                    "    value = value + sample({residual}u, u, v);\n"
                ));
            }
        }
        PassKind::DepthToSpace { sources, residual } => {
            if sources.len() > 4 {
                return Err(super::unsupported(
                    "depth-to-space has more sources than channels".into(),
                ));
            }
            let mut channels = Vec::with_capacity(4);
            for (channel, slot) in sources.iter().enumerate() {
                note_slot(&mut inputs, *slot);
                body.push_str(&format!(
                    "    let d{channel} = vec2<f32>(params.slots[{slot}u].yz) * vec2<f32>(u, v);\n    \
                     let b{channel} = floor(d{channel});\n    \
                     let f{channel} = d{channel} - b{channel};\n    \
                     let sub{channel} = i32(f{channel}.y * 2.0) * 2 + i32(f{channel}.x * 2.0);\n    \
                     let t{channel} = load({slot}u, i32(b{channel}.x), i32(b{channel}.y));\n    \
                     let v{channel} = pick(t{channel}, clamp(sub{channel}, 0, 3));\n"
                ));
                channels.push(format!("v{channel}"));
            }
            while channels.len() < 4 {
                channels.push("0.0".to_string());
            }
            body.push_str(&format!(
                "    var value = vec4<f32>({});\n",
                channels.join(", ")
            ));
            if let Some(residual) = residual {
                note_slot(&mut inputs, *residual);
                body.push_str(&format!(
                    "    value = value + sample({residual}u, u, v);\n"
                ));
            }
        }
        PassKind::MaxLuma {
            source,
            kernel,
            horizontal,
            luma,
        } => {
            note_slot(&mut inputs, *source);
            let half = (*kernel as f32 - 1.0) / 2.0;
            body.push_str("    var best = 0.0;\n");
            for tap in 0..*kernel {
                let offset = tap as f32 - half;
                let axis = if *horizontal { "y" } else { "z" };
                let sample = if *horizontal {
                    format!(
                        "sample({source}u, u + {} / f32(params.slots[{source}u].{axis}), v)",
                        float(offset)?
                    )
                } else {
                    format!(
                        "sample({source}u, u, v + {} / f32(params.slots[{source}u].{axis}))",
                        float(offset)?
                    )
                };
                let value = if *luma {
                    format!("luma(s{tap})")
                } else {
                    format!("s{tap}.x")
                };
                body.push_str(&format!(
                    "    let s{tap} = {sample};\n    best = max(best, {value});\n"
                ));
            }
            body.push_str("    var value = vec4<f32>(best, 0.0, 0.0, 0.0);\n");
        }
        PassKind::ClampLuma { source, stats } => {
            note_slot(&mut inputs, *source);
            note_slot(&mut inputs, *stats);
            body.push_str(&format!(
                "    let pixel = sample({source}u, u, v);\n    \
                 let ceiling = sample({stats}u, u, v).x;\n    \
                 let l = luma(pixel);\n    \
                 let excess = l - min(l, ceiling);\n    \
                 var value = pixel - vec4<f32>(excess, excess, excess, excess);\n"
            ));
        }
    }

    let mut source = String::new();
    source.push_str(&format!(
        "// 由 anime4k::gpu 生成：{}（读 {} 层，链上共 {} 层）\n",
        kind,
        inputs.len(),
        program.slots.len()
    ));
    source.push_str("struct Params {\n    out_base: u32,\n    out_w: u32,\n    out_h: u32,\n    _pad: u32,\n");
    source.push_str(&format!(
        "    slots: array<vec4<u32>, {}>,\n}};\n\n",
        program.slots.len()
    ));
    source.push_str("@group(0) @binding(0) var<uniform> params: Params;\n");
    source.push_str("@group(0) @binding(1) var<storage, read_write> pool: array<f32>;\n\n");
    // `load` / `sample` 与 CPU 的 `Texture::texel` / `Texture::sample` 逐句对应：边缘
    // 钳制、`u * W - 0.5` 再 floor 取整、双线性插值，一个都不能少。
    source.push_str(
        "fn load(slot: u32, x: i32, y: i32) -> vec4<f32> {\n    \
         let d = vec2<i32>(params.slots[slot].yz);\n    \
         let c = vec2<i32>(clamp(x, 0, d.x - 1), clamp(y, 0, d.y - 1));\n    \
         let base = params.slots[slot].x + u32((c.y * d.x + c.x) * 4);\n    \
         return vec4<f32>(pool[base], pool[base + 1u], pool[base + 2u], pool[base + 3u]);\n}\n\n",
    );
    source.push_str(
        "fn sample(slot: u32, u: f32, v: f32) -> vec4<f32> {\n    \
         let d = vec2<f32>(params.slots[slot].yz);\n    \
         let p = vec2<f32>(u, v) * d - vec2<f32>(0.5, 0.5);\n    \
         let base = floor(p);\n    \
         let f = p - base;\n    \
         let i0 = vec2<i32>(base);\n    \
         let tl = load(slot, i0.x, i0.y);\n    \
         let tr = load(slot, i0.x + 1, i0.y);\n    \
         let bl = load(slot, i0.x, i0.y + 1);\n    \
         let br = load(slot, i0.x + 1, i0.y + 1);\n    \
         return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);\n}\n\n",
    );
    source.push_str(
        "fn luma(value: vec4<f32>) -> f32 {\n    return 0.299 * value.x + 0.587 * value.y + 0.114 * value.z;\n}\n\n",
    );
    source.push_str(
        "fn pick(value: vec4<f32>, index: i32) -> f32 {\n    \
         if (index == 0) { return value.x; }\n    \
         if (index == 1) { return value.y; }\n    \
         if (index == 2) { return value.z; }\n    \
         return value.w;\n}\n\n",
    );
    source.push_str(&declarations);
    source.push_str(&format!(
        "\n@compute @workgroup_size({WORKGROUP}, {WORKGROUP})\nfn main(@builtin(global_invocation_id) gid: vec3<u32>) {{\n    \
         if (gid.x >= params.out_w || gid.y >= params.out_h) {{ return; }}\n    \
         let u = (f32(gid.x) + 0.5) / f32(params.out_w);\n    \
         let v = (f32(gid.y) + 0.5) / f32(params.out_h);\n\
         {body}    \
         let base = params.out_base + (gid.y * params.out_w + gid.x) * 4u;\n    \
         pool[base] = value.x;\n    \
         pool[base + 1u] = value.y;\n    \
         pool[base + 2u] = value.z;\n    \
         pool[base + 3u] = value.w;\n}}\n"
    ));
    Ok((source, inputs))
}

fn note_slot(inputs: &mut Vec<usize>, slot: usize) {
    if !inputs.contains(&slot) {
        inputs.push(slot);
    }
}

/// 一个 tap 的采样表达式：`sample(slot, u + dx / W, v + dy / H)`，偏移量是**源层自己
/// 的像素数**，除以源层自己的尺寸——与 CPU 那句 `u + term.offset[0] / texture.width`
/// 逐字对应。
fn tap_expression(slot: usize, offset: [f32; 2]) -> Result<String, ComputeError> {
    Ok(format!(
        "sample({slot}u, u + {} / f32(params.slots[{slot}u].y), v + {} / f32(params.slots[{slot}u].z))",
        float(offset[0])?,
        float(offset[1])?
    ))
}

/// `mat4(...)` 在 GLSL 里是按列读的，WGSL 的 `mat4x4<f32>` 构造也是按列——所以第 j 列
/// 就是 `weights[4j..4j+4]`，`W * v` 与 CPU 的 `multiply` 同一个算式。
fn matrix_constant(index: usize, weights: &[f32; 16]) -> Result<String, ComputeError> {
    let mut columns = Vec::with_capacity(4);
    for column in 0..4 {
        let mut values = Vec::with_capacity(4);
        for row in 0..4 {
            values.push(float(weights[column * 4 + row])?);
        }
        columns.push(format!("vec4<f32>({})", values.join(", ")));
    }
    Ok(format!(
        "const W{index}: mat4x4<f32> = mat4x4<f32>({});\n",
        columns.join(", ")
    ))
}

/// f32 字面量：Rust 的 `{:?}` 给的是能原样读回来的最短十进制（整数值带 `.0`，极小值
/// 走指数），WGSL 两种都收。非有限值不进着色器——那是解析出了岔子，宁可报错。
fn float(value: f32) -> Result<String, ComputeError> {
    if !value.is_finite() {
        return Err(ComputeError::InvalidInput(format!(
            "Anime4K 的权重里出现了非有限值：{value}"
        )));
    }
    Ok(format!("{value:?}"))
}

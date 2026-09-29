//! 一张图的 DLSS5 处理：上传 → 跑 1–3 个 NGX pass → 读回。
//!
//! 顺序（照 NGX 对这几个参数的读法来，反汇编复核过）：
//! 输入颜色按 `NON_PIXEL_SHADER_RESOURCE`、输出按 `UNORDERED_ACCESS`，运动与深度
//! 按零引导（静态图片没有运动；深度是「零契约」），每张图第一帧都要 `Reset=1`
//! ——没有上一帧的历史，NGX 的时间性从这一帧开始。
//!
//! 多层就是同一张图串行跑几个 feature：第 N 层的输入是第 N-1 层的输出。

use std::ffi::c_void;
use std::path::Path;

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D12::*;
use windows::Win32::Graphics::Dxgi::Common::*;

use super::device::with_context;
use super::ngx::Parameters;
use super::settings::DlssnrSettings;

/// 一张待处理的图：紧凑的 RGBA8。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DlssnrImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl DlssnrImage {
    pub fn new(width: u32, height: u32, rgba: Vec<u8>) -> Result<Self, String> {
        if width == 0 || height == 0 {
            return Err("图片尺寸为空".to_string());
        }
        let expected = width as usize * height as usize * 4;
        if rgba.len() != expected {
            return Err(format!(
                "图片字节数与尺寸对不上：{}x{} 需要 {} 字节，给了 {}",
                width,
                height,
                expected,
                rgba.len()
            ));
        }
        Ok(Self {
            width,
            height,
            rgba,
        })
    }
}

/// NGX 的尺寸下限：太小的图它自己会拒绝，先挡下来并给出人话。
const MIN_EDGE: u32 = 32;

/// 把一张图跑一遍 DLSS5。
pub fn apply(
    data_dir: &Path,
    image: &DlssnrImage,
    settings: &DlssnrSettings,
) -> Result<DlssnrImage, String> {
    if image.width < MIN_EDGE || image.height < MIN_EDGE {
        return Err(format!(
            "图太小（{}x{}）：DLSS5 至少要 {MIN_EDGE}×{MIN_EDGE}",
            image.width, image.height
        ));
    }
    let settings = settings.clone().normalized();
    with_context(data_dir, |context| run(context, image, &settings))
}

/// 与 [`apply`] 相同，但 DLL 由调用方点名。
///
/// 测试用它指着 `docs/DLSSNR-DLL-Options-310.8.0.0/…` 里的那一份 165MB 的 DLL
/// （拷进临时数据目录太浪费）；应用自己走的是数据目录里用户导入的那一份。
pub fn apply_with_dll(
    data_dir: &Path,
    dll: &Path,
    image: &DlssnrImage,
    settings: &DlssnrSettings,
) -> Result<DlssnrImage, String> {
    if image.width < MIN_EDGE || image.height < MIN_EDGE {
        return Err(format!(
            "图太小（{}x{}）：DLSS5 至少要 {MIN_EDGE}×{MIN_EDGE}",
            image.width, image.height
        ));
    }
    let settings = settings.clone().normalized();
    super::device::with_context_at(data_dir, dll, |context| run(context, image, &settings))
}

fn run(
    context: &mut super::device::GpuContext,
    image: &DlssnrImage,
    settings: &DlssnrSettings,
) -> Result<DlssnrImage, String> {
    let width = image.width;
    let height = image.height;
    // 颜色：输入按 SRV 用，输出要能写（UAV）。两张都带
    // `ALLOW_UNORDERED_ACCESS`：输入那张不需要，但多一个标志无害，而且换层数时
    // 输入/输出会互换位置。
    let color_flags = D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;
    let input = context.create_texture(width, height, DXGI_FORMAT_R8G8B8A8_UNORM, color_flags)?;
    context.upload_rgba(&input, width, height, &image.rgba)?;

    // 零引导：运动 R16G16_FLOAT、深度 R32_FLOAT，尺寸与颜色一致。
    let motion = context.create_zero_guide(width, height, DXGI_FORMAT_R16G16_FLOAT, 4)?;
    let depth = context.create_zero_guide(width, height, DXGI_FORMAT_R32_FLOAT, 4)?;

    let pass_count = settings.pass_count() as usize;
    let mut intermediates = Vec::new();
    for _ in 0..pass_count.saturating_sub(1) {
        intermediates.push(context.create_texture(width, height, DXGI_FORMAT_R8G8B8A8_UNORM, color_flags)?);
    }
    let output = context.create_texture(width, height, DXGI_FORMAT_R8G8B8A8_UNORM, color_flags)?;

    eprintln!("[dlssnr] 纹理就绪，开始建 feature");
    ensure_features(context, width, height, pass_count)?;

    for index in 0..pass_count {
        let pass = settings.passes[index];
        // 这一层的输出：不是最后一层就写中间图。
        let target = if index + 1 == pass_count {
            &output
        } else {
            &intermediates[index]
        };
        let source = if index == 0 {
            &input
        } else {
            &intermediates[index - 1]
        };

        if index > 0 {
            // 上一层的输出这一层当输入读。
            context.transition(source, D3D12_RESOURCE_STATE_UNORDERED_ACCESS, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
        }
        context.transition(target, D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);

        // 就用创建时那张参数表（NGX 在里面放了内部句柄）。
        let handle = context.features[index].handle;
        let parameters = &context.features[index].parameters;
        fill_evaluate_parameters(parameters, source, target, &motion, &depth, width, height, pass);
        context
            .core
            .evaluate_feature(context.list.as_raw(), handle, parameters)?;
    }

    eprintln!("[dlssnr] 提交（回读里会等 GPU）");
    let rgba = context.read_back_rgba(&output, width, height)?;
    eprintln!("[dlssnr] 回读完成");
    Ok(DlssnrImage {
        width,
        height,
        rgba,
    })
}

/// 取这一尺寸的 feature（每个 pass 一个）。尺寸变了就重建——NGX 的 feature 是跟
/// 宽高绑定的。每个 feature 带着**它创建时的那张参数表**：评估要用同一张（创建那
/// 一步 NGX 会往里放内部句柄）。
fn ensure_features(
    context: &mut super::device::GpuContext,
    width: u32,
    height: u32,
    pass_count: usize,
) -> Result<(), String> {
    if context.feature_size != Some((width, height)) || context.features.len() < pass_count {
        for slot in std::mem::take(&mut context.features) {
            context.core.release_feature(slot.handle);
        }
        for _ in 0..pass_count {
            // 创建参数一个都不能少（尺寸、缩放比、回调、质量档……），少一个片段就
            // 回「参数缺失或类型不对」。
            let parameters = create_parameters(context, width, height)?;
            let handle = context
                .core
                .create_feature(context.list.as_raw(), &parameters)?;
            context.features.push(super::device::FeatureSlot {
                handle,
                parameters,
            });
        }
        context.feature_size = Some((width, height));
    }
    Ok(())
}

/// 创建 feature 时的参数：同分辨率、不放大、缩放比 1、预设 0、质量档 Balanced。
///
/// 一个都不能少：少一个片段就回「参数缺失或类型不对」。`Set` 的重载也要按类型选
/// （整数走 int、尺寸走 unsigned、比例走 float）——NGX 按重载记类型，混了它读不到。
fn create_parameters(context: &super::device::GpuContext, width: u32, height: u32) -> Result<Parameters, String> {
    let parameters = context.allocate_parameters()?;
    parameters.set_u32("DLSSNR.Width", width);
    parameters.set_u32("DLSSNR.Height", height);
    parameters.set_u32("DLSSNR.InputWidth", width);
    parameters.set_u32("DLSSNR.InputHeight", height);
    parameters.set_u32("DLSSNR.OutputWidth", width);
    parameters.set_u32("DLSSNR.OutputHeight", height);
    parameters.set_u32("DLSSNR.Output.Width", width);
    parameters.set_u32("DLSSNR.Output.Height", height);
    parameters.set_u32("DLSSNR.Upscaling", 0);
    parameters.set_f32("DLSSNR.Scale", 1.0);
    parameters.set_f32("DLSSNR.ScalingRatio", 1.0);
    // 缩放比回调：NGX 会拿它问一遍。
    parameters.set_pointer(
        "DLSSNRComputeScalingRatioCallback",
        super::ngx::dlssnr_scaling_ratio_callback as *mut c_void,
    );
    parameters.set_i32("DLSSNR.Hint.Render.Preset", 0);
    parameters.set_u32("Width", width);
    parameters.set_u32("Height", height);
    parameters.set_i32("PerfQualityValue", 1); // Balanced
    parameters.set_u32("CreationNodeMask", 1);
    parameters.set_u32("VisibilityNodeMask", 1);
    #[cfg(any(test, debug_assertions))]
    if std::env::var_os("YOMIKA_NGX_LOG").is_some() {
        for name in [
            "DLSSNR.Width",
            "DLSSNR.Height",
            "DLSSNR.Upscaling",
            "DLSSNR.Scale",
            "DLSSNR.ScalingRatio",
            "DLSSNR.Hint.Render.Preset",
            "Width",
            "Height",
            "PerfQualityValue",
            "CreationNodeMask",
            "VisibilityNodeMask",
            "DLSSNRComputeScalingRatioCallback",
        ] {
            eprintln!("[参数] {}", parameters.read_back(name));
        }
    }
    Ok(parameters)
}

/// 每次评估的参数（创建那张表继续用，另加每层的风格）。
fn fill_evaluate_parameters(
    parameters: &Parameters,
    color: &ID3D12Resource,
    output: &ID3D12Resource,
    motion: &ID3D12Resource,
    depth: &ID3D12Resource,
    width: u32,
    height: u32,
    pass: super::settings::PassSettings,
) {
    // 资源按 **u64 那一格**给：片段读 Color/Output/MVec/Depth 用的是
    // `Get(name, unsigned long long*)`（反汇编 `0x18001A07C` 那一段：槽位 8），而参数表
    // 是按类型记的——用 D3D12 那一格存进去，u64 读回来是「类型不对」，片段就把指针
    // 当成缺失，直接跳过评估（0xBAD00005）。存成 u64 它就能拿到指针本身。
    parameters.set_u64("DLSSNR.Color", color.as_raw() as usize as u64);
    parameters.set_u64("DLSSNR.Output", output.as_raw() as usize as u64);
    parameters.set_u64("DLSSNR.MVec", motion.as_raw() as usize as u64);
    parameters.set_u64("DLSSNR.Depth", depth.as_raw() as usize as u64);
    parameters.set_u32("DLSSNR.ColorSubrectBaseX", 0);
    parameters.set_u32("DLSSNR.ColorSubrectBaseY", 0);
    parameters.set_u32("DLSSNR.ColorSubrectWidth", width);
    parameters.set_u32("DLSSNR.ColorSubrectHeight", height);
    parameters.set_u32("DLSSNR.OutputSubrectBaseX", 0);
    parameters.set_u32("DLSSNR.OutputSubrectBaseY", 0);
    parameters.set_u32("DLSSNR.OutputSubrectWidth", width);
    parameters.set_u32("DLSSNR.OutputSubrectHeight", height);
    parameters.set_u32("DLSSNR.MVecSubrectBaseX", 0);
    parameters.set_u32("DLSSNR.MVecSubrectBaseY", 0);
    parameters.set_u32("DLSSNR.MVecSubrectWidth", width);
    parameters.set_u32("DLSSNR.MVecSubrectHeight", height);
    parameters.set_u32("DLSSNR.DepthSubrectBaseX", 0);
    parameters.set_u32("DLSSNR.DepthSubrectBaseY", 0);
    parameters.set_u32("DLSSNR.DepthSubrectWidth", width);
    parameters.set_u32("DLSSNR.DepthSubrectHeight", height);
    parameters.set_f32("DLSSNR.MVecScaleX", 1.0);
    parameters.set_f32("DLSSNR.MVecScaleY", 1.0);
    parameters.set_i32("DLSSNR.DepthInverted", 1);
    parameters.set_i32("DLSS.Indicator.Invert.X.Axis", 0);
    parameters.set_i32("DLSS.Indicator.Invert.Y.Axis", 0);
    parameters.set_i32("DLSSNR.Enabled", 1);
    // 静态图片：没有上一帧，每次都从头开始（这就是「第一帧」）。
    parameters.set_i32("DLSSNR.Reset", 1);

    parameters.set_i32("DLSSNR.Style", pass.style);
    parameters.set_f32("DLSSNR.Intensity", pass.intensity);
    parameters.set_f32("DLSSNR.LocalToneStrength", pass.local_tone_strength);
    parameters.set_f32("DLSSNR.LocalStructureStrength", pass.local_structure_strength);
    parameters.set_f32("DLSSNR.SkinStructureStrength", pass.skin_structure_strength);
    parameters.set_i32("DLSSNR.UseAutoMask", i32::from(pass.auto_mask));
    parameters.set_i32("DLSSNR.UICorrection", i32::from(pass.ui_correction));

    #[cfg(any(test, debug_assertions))]
    if std::env::var_os("YOMIKA_NGX_LOG").is_some() {
        // 只读回看，不改值：参数槽位错一格片段就读不到（它就是照槽位取的），
        // 排查时这几行能直接指出是哪一格。
        for name in ["DLSSNR.Color", "DLSSNR.Intensity", "DLSSNR.Style"] {
            eprintln!("[参数] {}", parameters.read_back(name));
        }
    }
}

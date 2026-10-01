//! 一张图的 DLSSNR 处理：上传 → 跑 1–5 个 NGX pass → 回读。
//!
//! 顺序（照 NGX 对这几个参数的读法来，反汇编复核过）：
//! 输入颜色按 `NON_PIXEL_SHADER_RESOURCE`、输出按 `UNORDERED_ACCESS`，运动与深度
//! 按零引导（静态图片没有运动；深度是「零契约」），每张图第一帧都要 `Reset=1`
//! ——没有上一帧的历史，NGX 的时间性从这一帧开始。
//!
//! 多层就是同一张图串行跑几个 feature：第 N 层的输入是第 N-1 层的输出。
//!
//! **纹理与 feature 不在这里建**：它们按量化尺寸缓存在 [`Workspace`] 里（换尺寸
//! 重建 feature 是这条链路上最大的单项开销，同一 bucket 内换页不再重建）。这一层
//! 只负责把一页的整套命令记进同一张命令表——上传 → 各层 → 回读——**一次提交、
//! 一次等待**，以前那一页四次提交加四次轮询也在这里收掉了。

use std::path::Path;

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D12::*;

use crate::inference::cancel::CancelToken;

use super::device::{with_context, GpuContext};
use super::ngx::Parameters;
use super::settings::DlssnrSettings;
use super::workspace::Workspace;

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

/// 取消时返回的错误串。这条链路的错误类型是 `String`，所以用一句可辨认的串，
/// 由调用方翻译成 `INFERENCE_CANCELLED`。
pub const CANCELLED: &str = "dlssnr: cancelled";

/// 测试用：让下一次 `record_page` 在记完上传之后报一次取消。
///
/// 真实的「层间取消」要另一个线程掐着时间置 flag（`apply_with_dll_bucket` 开头就有
/// 一次早退，赛跑要么早退要么跑完，不可复现），所以这里注入同一条错误路径。
#[cfg(test)]
static FAIL_RECORD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
pub fn fail_next_record(fail: bool) {
    FAIL_RECORD.store(fail, std::sync::atomic::Ordering::SeqCst);
}

/// 把一张图跑一遍 DLSSNR。
pub fn apply(
    data_dir: &Path,
    image: &DlssnrImage,
    settings: &DlssnrSettings,
) -> Result<DlssnrImage, String> {
    apply_with_token(data_dir, image, settings, &CancelToken::none())
}

/// 同上，但带取消牌：层与层之间查一次。阅读器用它——一张 4K 图一层几百毫秒，
/// 切页之后没必要把剩下的层跑完。
pub fn apply_with_token(
    data_dir: &Path,
    image: &DlssnrImage,
    settings: &DlssnrSettings,
    cancel: &CancelToken,
) -> Result<DlssnrImage, String> {
    if image.width < MIN_EDGE || image.height < MIN_EDGE {
        return Err(format!(
            "图太小（{}x{}）：DLSSNR 至少要 {MIN_EDGE}×{MIN_EDGE}",
            image.width, image.height
        ));
    }
    let settings = settings.clone().normalized();
    with_context(data_dir, |context| run(context, image, &settings, cancel, None))
}

/// 与 [`apply`] 相同，但 DLL 由调用方点名。**只有测试用**：它指着
/// `docs/DLSSNR-DLL-Options-310.8.0.0/…` 里那一份 165MB 的 DLL（拷进临时数据目录太
/// 浪费）；应用自己走的是数据目录里用户导入的那一份（[`apply`]）。
#[cfg(test)]
pub fn apply_with_dll(
    data_dir: &Path,
    dll: &Path,
    image: &DlssnrImage,
    settings: &DlssnrSettings,
) -> Result<DlssnrImage, String> {
    apply_with_dll_token(data_dir, dll, image, settings, &CancelToken::none())
}

#[cfg(test)]
pub fn apply_with_dll_token(
    data_dir: &Path,
    dll: &Path,
    image: &DlssnrImage,
    settings: &DlssnrSettings,
    cancel: &CancelToken,
) -> Result<DlssnrImage, String> {
    apply_with_dll_bucket(data_dir, dll, image, settings, cancel, None)
}

/// 试验用：点名工作区的创建尺寸，绕开 bucket 策略。
///
/// `forced = Some((w, h))`（要装得下这一页）时按这个尺寸建/取工作区，于是还能跑
/// 「按页尺寸建 feature」那条老路，与 bucket 那一路对比输出（见 `mod.rs` 里的
/// `a_bucket_workspace_matches_a_per_page_feature`）。
#[cfg(test)]
pub fn apply_with_dll_bucket(
    data_dir: &Path,
    dll: &Path,
    image: &DlssnrImage,
    settings: &DlssnrSettings,
    cancel: &CancelToken,
    forced: Option<(u32, u32)>,
) -> Result<DlssnrImage, String> {
    if image.width < MIN_EDGE || image.height < MIN_EDGE {
        return Err(format!(
            "图太小（{}x{}）：DLSSNR 至少要 {MIN_EDGE}×{MIN_EDGE}",
            image.width, image.height
        ));
    }
    if cancel.cancelled() {
        return Err(CANCELLED.to_string());
    }
    let settings = settings.clone().normalized();
    super::device::with_context_at(data_dir, dll, |context| run(context, image, &settings, cancel, forced))
}

/// 测试用：读全局上下文上「建过几个工作区 / 建过几次 feature」的计数。
///
/// 同一进程里所有 GPU 测试共用这个上下文（GPU 侧本来就串行），所以差值是个上界。
#[cfg(test)]
pub fn context_counts(data_dir: &Path, dll: &Path) -> Result<(u64, u64), String> {
    super::device::with_context_at(data_dir, dll, |context| {
        Ok((context.workspace_builds, context.feature_builds))
    })
}

fn run(
    context: &mut GpuContext,
    image: &DlssnrImage,
    settings: &DlssnrSettings,
    cancel: &CancelToken,
    forced: Option<(u32, u32)>,
) -> Result<DlssnrImage, String> {
    let width = image.width;
    let height = image.height;
    let pass_count = settings.pass_count() as usize;
    debug_assert!(pass_count <= settings.passes.len(), "层数比参数表还多");
    let timing = std::env::var_os("YOMIKA_DLSSNR_TIMING").is_some();
    let mut mark = std::time::Instant::now();
    let phase = |label: &str, mark: &mut std::time::Instant| {
        if timing {
            eprintln!("[dlssnr 耗时] {label}: {}ms", mark.elapsed().as_millis());
        }
        *mark = std::time::Instant::now();
    };

    // 工作区：装得下就复用（同一 bucket **不重建 feature**），装不下或太浪费就新建。
    let mut workspace = context.acquire_workspace(width, height, pass_count, forced)?;
    phase("取/建工作区（含 feature）", &mut mark);

    // 一页的整套命令走同一张命令表：上传 → 各层 → 回读，末尾一次提交一次等待。
    let recorded = record_page(context, &mut workspace, image, settings, cancel);
    // 上传缓冲要活到提交之后（提交的命令里还要从它拷进纹理）：下划线前缀的绑定照样
    // 活到作用域结束，裸 `_` 会立刻析构。
    let (_upload, readback) = match recorded {
        Ok(buffers) => buffers,
        Err(error) => {
            // 出错了：一条命令都还没提交，丢掉就是（已记录的 barrier 一条都没执行，
            // 纹理在 GPU 上的实际状态还是上一页收尾时的样子，而 `workspace` 模块保证
            // 每页收尾都摆回开场状态，所以这份工作区下回照样能用）。
            // 收不回去（reset 失败）时上下文已经中毒，那就整份丢掉——还给一个已经
            // 作废的上下文没有意义；否则把**工作区**交回缓存：取消在后台预扫被前台
            // 抢断时是常态，`Workspace::release` 会把 feature 还掉、工作区跟着销毁，
            // 于是每次取消都要重建一遍（120ms 级）。
            if let Err(reset) = context.discard_recorded() {
                drop(workspace);
                return Err(reset);
            }
            context.release_workspace(workspace);
            return Err(error);
        }
    };
    phase("记录（上传 + 各层 + 回读）", &mut mark);

    if let Err(error) = context.execute_and_wait() {
        // 提交期失败：GPU 有没有停下不知道（`execute_and_wait` 已经把上下文标中毒，
        // `with_context_at` 会把它从缓存里摘掉）。这时候**不能**把工作区还回缓存，
        // 也不该去调 NGX 释放 feature——整份工作区跟着上下文一起丢掉。
        if context.poisoned.is_some() {
            drop(workspace);
        } else {
            workspace.release(&context.core);
        }
        return Err(error);
    }
    phase("提交 + 等 GPU（含全部推理）", &mut mark);

    let rgba = match context.map_read_back(&readback, width, height) {
        Ok(rgba) => rgba,
        Err(error) => {
            // 命令已经提交并跑完了：整套 barrier 都执行过，收尾已经把纹理摆回开场
            // 状态（见 `workspace` 模块头），所以工作区是真好的，交回缓存就行——
            // 以前这里 `Workspace::release` 会连 feature 一起还掉，下一页白重建一遍。
            context.release_workspace(workspace);
            return Err(error);
        }
    };
    phase("映射回读", &mut mark);
    context.release_workspace(workspace);
    Ok(DlssnrImage {
        width,
        height,
        rgba,
    })
}

/// 把一页的整套命令记进命令表：上传 → 各层 → 回读。**不提交**。
///
/// 返回（上传缓冲, 回读缓冲）：两张都被这一批命令引用，要活到提交之后。
fn record_page(
    context: &mut GpuContext,
    workspace: &mut Workspace,
    image: &DlssnrImage,
    settings: &DlssnrSettings,
    cancel: &CancelToken,
) -> Result<(ID3D12Resource, ID3D12Resource), String> {
    let width = image.width;
    let height = image.height;
    let (bucket_width, bucket_height) = workspace.size;
    let pass_count = settings.pass_count() as usize;

    // 颜色：这一页贴在左上角，纹理可能比它大（bucket）。拷完回到 SRV，正好接着给
    // 第一层当输入（`input` 每页开场就是 SRV，见 `workspace` 模块头的状态机）。
    let upload = context.record_upload_rgba(
        &workspace.input,
        D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE,
        width,
        height,
        &image.rgba,
    )?;

    // 层与层之间仍是取消点。（整页只有一次提交，所以这里的取消等于整页作废：
    // 一条命令都还没发出去，已经花掉的只有记录的时间和一次上传的行拷贝。）
    #[cfg(test)]
    if FAIL_RECORD.swap(false, std::sync::atomic::Ordering::SeqCst) {
        return Err(CANCELLED.to_string());
    }
    for index in 0..pass_count {
        // 层与层之间仍是取消点。（整页只有一次提交，所以这里的取消等于整页作废：
        // 一条命令都还没发出去，已经花掉的只有记录的时间和一次上传的行拷贝。）
        if cancel.cancelled() {
            return Err(CANCELLED.to_string());
        }
        let pass = settings.passes[index];
        let last = index + 1 == pass_count;
        let source = if index == 0 {
            &workspace.input
        } else {
            &workspace.intermediates[index - 1]
        };
        let target = if last {
            &workspace.output
        } else {
            &workspace.intermediates[index]
        };

        if index > 0 {
            // 上一层的输出这一层当输入读。
            context.transition(
                source,
                D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
                D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE,
            );
        }
        // 目标图每页开场：输出是 COMMON（上一页收尾摆回来的），中间图是 SRV。
        let from = if last {
            D3D12_RESOURCE_STATE_COMMON
        } else {
            D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE
        };
        context.transition(target, from, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);

        // 就用创建时那张参数表（NGX 在里面放了内部句柄）。尺寸参数保持工作区的
        // 尺寸，这一页多大只由 subrect 说明——实测两者输出一致（差 0.012/255）。
        let parameters = &workspace.features[index].parameters;
        fill_evaluate_parameters(
            parameters,
            source,
            target,
            &workspace.motion,
            &workspace.depth,
            width,
            height,
            pass,
        );
        context
            .core
            .evaluate_feature(context.list.as_raw(), workspace.features[index].handle, parameters)?;
    }

    let readback = context.record_read_back(&workspace.output, width, height, bucket_width, bucket_height)?;
    // 输出收尾摆回 COMMON：下一页开场就还是「COMMON → UAV」。
    context.transition(
        &workspace.output,
        D3D12_RESOURCE_STATE_COPY_SOURCE,
        D3D12_RESOURCE_STATE_COMMON,
    );
    Ok((upload, readback))
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

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
//! 一页只上传和回读一次；层间等待 fence 后复用同一个 feature，避免每层独立模型驻留。

use std::path::Path;

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D12::*;

use crate::cancel::CancelToken;

use super::device::{with_context, GpuContext};
use super::ngx::Parameters;
use super::settings::DlssnrSettings;
use super::workspace::Workspace;

// 图这个数据结构（以及尺寸下限）住在元数据那一半：探针要合成一张图、比像素差，摘掉
// 引擎之后宿主仍然要走那段，所以它不能跟着滤镜一起被门掉。这里只借个路径，让
// `filter::DlssnrImage` / `filter::MIN_EDGE` 这些老名字继续成立（`animation.rs` 与
// worker 的 DLSSNR 阶段都按 `filter::DlssnrImage` 找它）。
pub use super::{DlssnrImage, MIN_EDGE};

/// 取消时返回的错误串。这条链路的错误类型是 `String`，所以用一句可辨认的串，
/// 由调用方翻译成 `INFERENCE_CANCELLED`。
pub const CANCELLED: &str = "dlssnr: cancelled";

/// 评估把输入原样交回时返回的错误串。
///
/// 真机缓存里抓到过这种产物：内容与起点页逐像素相同（三例，全是某一次参数调整之后的
/// 头三页，并且被阅读器读走显示过）。它不是「滤镜选择了保守」，而是这一页**根本没被
/// 评估**——把这种结果当产物写进缓存，用户那一页就会一直停在未处理的样子，只有再动
/// 一次参数才会重算。所以调用方要把它当「这次没处理」：原图交回、不写产物缓存。
pub const PASSTHROUGH: &str = "dlssnr: passthrough";

/// 评估什么都没写出来（产物整幅透明）时返回的错误串。
///
/// 与 [`PASSTHROUGH`] 是同一类结局——「这一页没算过」——但成因完全不同，所以分开报：
/// 真机产物缓存里抓到过一例 **3000×4000 全透明**的产物（242,617 字节，2026-10-12
/// 13:39:58，键是 `dlssnr:v3:…`）。用户那一页从此只剩背景：产物是真的、能解码、
/// `naturalWidth/Height` 都对，只是每一像素的 alpha 都是 0，而它每次都从缓存里被端回来。
///
/// 为什么不能交出去：DLSSNR 的输入是不透明的页面，输出整幅透明只可能是这一页**没被
/// 写出来**（上传没生效、UAV 没落盘、feature 空转都会长成这个样子），它不是「滤镜算
/// 得保守」。以前只挡了「与输入逐像素相同」那一种，全透明与输入不同，于是被当成产物
/// 收下、写进缓存、每次翻到都端出来。判据是 alpha 全 0：不透明页面过一遍 DLSSNR 不该
/// 变成看不见的东西，而「看不见」正是用户看到的那一页。
pub const BLANK: &str = "dlssnr: blank";

/// 这条错误是不是「这一页没算过」——调用方该原图交回、且**不写产物缓存**。
///
/// 两个成因（原样交回 [`PASSTHROUGH`]、什么都没写出来 [`BLANK`]）在调用方眼里是同一条
/// 结局，判据集中在这里：worker 的两条路（静态页与动图）都问它。分散成两处 `==` 比较，
/// 迟早只剩一处——2026-10-14 补 `BLANK` 时正是这么发现的：只挡了原样交回，全透明那一种
/// 谁都没拦。
pub fn is_not_computed(error: &str) -> bool {
    error == PASSTHROUGH || error == BLANK
}

/// 测试用：让下一次 `record_page` 在记完上传之后报一次取消。
///
/// 真实的「层间取消」要另一个线程掐着时间置 flag（`apply_with_dll_bucket` 开头就有
/// 一次早退，赛跑要么早退要么跑完，不可复现），所以这里注入同一条错误路径。
#[cfg(test)]
static FAIL_RECORD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(test)]
static FAIL_AFTER_LAYER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
pub fn cancel_after_first_layer() {
    FAIL_AFTER_LAYER.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[cfg(test)]
pub fn fail_next_record(fail: bool) {
    FAIL_RECORD.store(fail, std::sync::atomic::Ordering::SeqCst);
}

/// 测试用：把接下来 `times` 次评估伪装成「网络把输入原样交回」。
///
/// 真机上撞见这条路径要看运气（本机是在用户的产物缓存里抓到的三例），所以注入：
/// `run` 的「重试一次」与「两次都交回就如实报 [`PASSTHROUGH`]」两条路都得走到。
#[cfg(test)]
static FORCE_PASSTHROUGH: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
pub fn force_passthrough(times: usize) {
    FORCE_PASSTHROUGH.store(times, std::sync::atomic::Ordering::SeqCst);
}

#[cfg(test)]
fn take_forced_passthrough() -> bool {
    use std::sync::atomic::Ordering;
    let mut left = FORCE_PASSTHROUGH.load(Ordering::SeqCst);
    while left > 0 {
        match FORCE_PASSTHROUGH.compare_exchange(
            left,
            left - 1,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => return true,
            Err(now) => left = now,
        }
    }
    false
}

/// 测试用：把接下来 `times` 次评估伪装成「什么都没写出来」（产物整幅透明）。
///
/// 真机上撞见这条路径同样要看运气（本机是在用户的产物缓存里抓到的那一例 3000×4000
/// 全透明产物），所以注入：`run` 的「重试一次」与「两次都空就如实报 [`BLANK`]」两条
/// 路都得走到。
#[cfg(test)]
static FORCE_BLANK: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
pub fn force_blank(times: usize) {
    FORCE_BLANK.store(times, std::sync::atomic::Ordering::SeqCst);
}

#[cfg(test)]
fn take_forced_blank() -> bool {
    use std::sync::atomic::Ordering;
    let mut left = FORCE_BLANK.load(Ordering::SeqCst);
    while left > 0 {
        match FORCE_BLANK.compare_exchange(
            left,
            left - 1,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => return true,
            Err(now) => left = now,
        }
    }
    false
}

/// 产物是不是「整幅看不见」：每个像素的 alpha 都是 0。
///
/// 只看 alpha，不看 RGB：用户看到的是「那一页只剩背景」，而不是「那一页变黑了」。
/// 抽成纯函数是为了能不碰 GPU 就守住这条判据（见本文件末尾的用例）。
fn is_blank(image: &DlssnrImage) -> bool {
    !image.rgba.is_empty() && image.rgba.chunks_exact(4).all(|pixel| pixel[3] == 0)
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
    if cancel.cancelled() { return Err(CANCELLED.to_string()); }
    // Intensity=0 is the verified identity transform, not a failed Evaluate.
    // Do not allocate up to five NGX features or retry the same no-op twice.
    if settings.passes.iter().all(|pass| pass.intensity == 0.0) {
        return Err(PASSTHROUGH.to_string());
    }
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
    if cancel.cancelled() { return Err(CANCELLED.to_string()); }
    // Intensity=0 is the verified identity transform, not a failed Evaluate.
    // Do not allocate up to five NGX features or retry the same no-op twice.
    if settings.passes.iter().all(|pass| pass.intensity == 0.0) {
        return Err(PASSTHROUGH.to_string());
    }
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

/// 一张图跑一遍 DLSSNR：评估一次，必要时再评估一次。
///
/// 网络偶尔会把输入原样交回（真机产物缓存里抓到过三例：内容与起点页逐像素相同）。
/// 那不是「滤镜选择保守」，而是这一页根本没被评估；当产物交出去又写进缓存，用户那一页
/// 就一直停在未处理的样子。所以这里再看一眼：与输入逐像素相同就**再评估一次**（一次
/// 评估本来就是翻页路径上的开销，重评不至于让这一次翻页变得难等），第二次仍然相同就
/// 如实报 [`PASSTHROUGH`]，由调用方决定「原图交回、不写缓存」。
///
/// **整幅透明**（[`BLANK`]）走同一条路，判据也一样：先再评估一次，两次都空就如实报错。
/// 这一条是 2026-10-14 补的——在那之前只挡了「与输入逐像素相同」，而全透明与输入不同，
/// 于是被当产物收下并写进缓存，用户那一页（3000×4000）此后每次翻到都只剩背景。
fn run(
    context: &mut GpuContext,
    image: &DlssnrImage,
    settings: &DlssnrSettings,
    cancel: &CancelToken,
    forced: Option<(u32, u32)>,
) -> Result<DlssnrImage, String> {
    let first = evaluate(context, image, settings, cancel, forced)?;
    if first.rgba != image.rgba && !is_blank(&first) {
        return Ok(first);
    }
    let second = evaluate(context, image, settings, cancel, forced)?;
    // 先判空：一份整幅透明的产物同时也不等于输入，两个判据会同时成立，报哪一个得说清楚
    // ——「没写出来」比「原样交回」更贴近当时的实际。
    if is_blank(&second) {
        return Err(BLANK.to_string());
    }
    if second.rgba == image.rgba {
        return Err(PASSTHROUGH.to_string());
    }
    Ok(second)
}

/// 一次评估：取/建工作区 → 把一页的整套命令记进命令表 → 提交并等 GPU → 映射回读。
fn evaluate(
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

    // 上传一次，各层通过 fence 隔离同一 feature 的内部状态，最后回读。
    let recorded = record_page(context, &mut workspace, image, settings, cancel);
    // 上传缓冲要活到提交之后（提交的命令里还要从它拷进纹理）：下划线前缀的绑定照样
    // 活到作用域结束，裸 `_` 会立刻析构。
    let (_upload, readback) = match recorded {
        Ok(buffers) => buffers,
        Err(error) => {
            // Discard unsubmitted commands. If a layer already completed,
            // dispose of its partial texture states instead of caching them.
            if context.poisoned.is_some() {
                drop(workspace);
                return Err(error);
            }
            if let Err(reset) = context.discard_recorded() {
                drop(workspace);
                return Err(reset);
            }
            if workspace.partial_submission {
                workspace.release(&context.core);
            } else {
                context.release_workspace(workspace);
            }
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
    workspace.partial_submission = false;

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
    #[cfg(test)]
    let rgba = if take_forced_passthrough() {
        // 伪装成「网络原样交回」（见 `force_passthrough`）：重试与如实报错两条路都靠它覆盖。
        image.rgba.clone()
    } else if take_forced_blank() {
        // 伪装成「什么都没写出来」（见 `force_blank`）：产物整幅透明，RGB 与 alpha 都是 0。
        vec![0u8; rgba.len()]
    } else {
        rgba
    };
    Ok(DlssnrImage {
        width,
        height,
        rgba,
    })
}

/// 上传与回读各一次；非末层提交并等待后复用 feature。
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

    // 测试用：模拟「记录这一页时出错」，看不写产物的那条路走得通不通。
    #[cfg(test)]
    if FAIL_RECORD.swap(false, std::sync::atomic::Ordering::SeqCst) {
        return Err(CANCELLED.to_string());
    }
    for index in 0..pass_count {
        // Layers are cancellation points; completed layers are fenced already.
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
        let parameters = &workspace.features[0].parameters;
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
            .evaluate_feature(context.list.as_raw(), workspace.features[0].handle, parameters)?;
        if !last {
            // NGX's internal scratch/history belong to the feature. Complete
            // this pass before resetting and reusing it for the next layer.
            workspace.partial_submission = true;
            context.execute_and_wait()?;
            #[cfg(test)]
            if FAIL_AFTER_LAYER.swap(false, std::sync::atomic::Ordering::SeqCst) {
                return Err(CANCELLED.to_string());
            }
        }
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

#[cfg(test)]
mod acceptance_tests {
    use super::*;

    /// 判据：整幅看不见 = 这一页没被写出来。
    ///
    /// 这是用户那一页（3000×4000）消失的直接原因：真机产物缓存里那一份 242,617 字节的
    /// `dlssnr:v3` 产物 alpha 全 0、亮度 0，而它每次都从缓存里被端回来。纯函数、不碰 GPU
    /// ——判据要在一台没有 DLSSNR 片段的机器上也守得住。
    #[test]
    fn a_fully_transparent_product_is_blank_and_a_visible_one_is_not() {
        let invisible = DlssnrImage::new(2, 2, vec![0; 2 * 2 * 4]).unwrap();
        assert!(is_blank(&invisible), "全 0 的 RGBA 是空产物");

        // RGB 有内容但 alpha 全 0：用户看到的同样是「只剩背景」，照样算空。
        let mut ghost = Vec::new();
        for _ in 0..4 {
            ghost.extend_from_slice(&[255, 128, 64, 0]);
        }
        assert!(
            is_blank(&DlssnrImage::new(2, 2, ghost).unwrap()),
            "看不见的产物也是空产物"
        );

        // 一个不透明像素就不算空：别把「大部分透明」的合法产物也拦掉。
        let mut mostly = vec![0u8; 3 * 4];
        mostly.extend_from_slice(&[10, 20, 30, 255]);
        assert!(
            !is_blank(&DlssnrImage::new(2, 2, mostly).unwrap()),
            "有内容就不算空"
        );
    }

    /// 「这一页没算过」的判据必须把两种成因都算进去，且不能把别的错误卷进来。
    ///
    /// worker 两条路（静态页、动图）都问 [`is_not_computed`]：漏掉 `BLANK` 就回到用户
    /// 那一页只剩背景的状态，把 `CANCELLED` 卷进来则会把「切页」当成「没算过」——取消要
    /// 让任务作废，不是原图交回。
    #[test]
    fn not_computed_covers_both_reasons_and_nothing_else() {
        assert!(is_not_computed(PASSTHROUGH), "原样交回算没算过");
        assert!(is_not_computed(BLANK), "什么都没写出来也算没算过");
        assert!(!is_not_computed(CANCELLED), "取消不是「没算过」");
        assert!(!is_not_computed("dlssnr: 别的错"), "别的错误不该被当成没算过");
        assert!(!is_not_computed(""), "空串不该被当成没算过");
    }

    #[test]
    fn a_disabled_neural_pass_does_not_require_a_dll_or_gpu_context() {
        let dir = tempfile::tempdir().unwrap();
        let image = DlssnrImage::new(64, 64, vec![128; 64*64*4]).unwrap();
        let settings = DlssnrSettings { passes: vec![super::super::settings::PassSettings {
            intensity: 0.0, ..Default::default()
        }; 5] };
        assert_eq!(apply_with_token(dir.path(), &image, &settings, &CancelToken::none()).unwrap_err(), PASSTHROUGH,
            "all disabled layers must avoid NGX initialization and allocations");
    }

    #[test]
    fn real_ngx_parameter_slots_match_the_static_page_contract_and_refresh_every_control() {
        let _gpu = super::super::tests::gpu_test_lock();
        let Some(dll) = super::super::tests::test_dll() else {
            eprintln!("SKIP: no DLSSNR DLL for parameter slot test"); return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).unwrap();
        super::super::device::with_context_at(&dir, &dll, |context| {
            let workspace = context.acquire_workspace(65, 97, 1, Some((128, 128)))?;
            context.execute_and_wait()?;
            let parameters = &workspace.features[0].parameters;
            assert_eq!(parameters.get_u32("DLSSNR.Width"), Some(128));
            assert_eq!(parameters.get_u32("DLSSNR.OutputHeight"), Some(128));
            assert_eq!(parameters.get_f32("DLSSNR.Scale"), Some(1.0));
            let tuned = super::super::settings::PassSettings {
                style: 2, intensity: 0.75, local_tone_strength: 0.5,
                local_structure_strength: 1.5, skin_structure_strength: 0.25,
                auto_mask: true, ui_correction: true,
            };
            for pass in [tuned, super::super::settings::PassSettings::default()] {
                fill_evaluate_parameters(parameters, &workspace.input, &workspace.output,
                    &workspace.motion, &workspace.depth, 65, 97, pass);
                for (name, resource) in [("Color", &workspace.input), ("Output", &workspace.output), ("MVec", &workspace.motion), ("Depth", &workspace.depth)] {
                    assert_eq!(parameters.get_u64(&format!("DLSSNR.{name}")), Some(resource.as_raw() as usize as u64));
                    assert_eq!(parameters.get_u32(&format!("DLSSNR.{name}SubrectBaseX")), Some(0));
                    assert_eq!(parameters.get_u32(&format!("DLSSNR.{name}SubrectWidth")), Some(65));
                    assert_eq!(parameters.get_u32(&format!("DLSSNR.{name}SubrectHeight")), Some(97));
                }
                for (name, value) in [("Intensity", pass.intensity), ("LocalToneStrength", pass.local_tone_strength),
                    ("LocalStructureStrength", pass.local_structure_strength), ("SkinStructureStrength", pass.skin_structure_strength)] {
                    assert_eq!(parameters.get_f32(&format!("DLSSNR.{name}")), Some(value));
                }
                assert_eq!(parameters.get_i32("DLSSNR.Style"), Some(pass.style));
                assert_eq!(parameters.get_i32("DLSSNR.UseAutoMask"), Some(i32::from(pass.auto_mask)));
                assert_eq!(parameters.get_i32("DLSSNR.UICorrection"), Some(i32::from(pass.ui_correction)));
                assert_eq!(parameters.get_i32("DLSSNR.Reset"), Some(1));
                assert_eq!(parameters.get_i32("DLSSNR.Enabled"), Some(1));
                assert_eq!(parameters.get_f32("DLSSNR.MVecScaleX"), Some(1.0));
                assert_eq!(parameters.get_i32("DLSSNR.DepthInverted"), Some(1));
                // Changing subrect must not overwrite creation dimensions.
                assert_eq!(parameters.get_u32("DLSSNR.Width"), Some(128));
            }
            context.release_workspace(workspace);
            Ok(())
        }).expect("real NGX typed parameters");
    }

}

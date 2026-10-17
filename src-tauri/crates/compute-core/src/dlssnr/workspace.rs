//! 按「量化尺寸」复用的 GPU 工作区：纹理、零引导、feature 都住在这里。
//!
//! **为什么要有这个东西**：NGX 的 feature 与宽高绑定，换尺寸就得整批重建
//! （实测 115–360ms 一次，而推理本身只要 7–54ms）。漫画页又页页尺寸不同，于是
//! 「按页尺寸建 feature」等于每页付一次重建，是这条链路上最大的单项开销。
//!
//! 实测确认了一件事：**一个建在更大尺寸上的 feature，可以用 subrect 评估更小的
//! 页**——同一张图，输出与「按页尺寸建 feature」逐通道平均差 0.012/255（同一张图
//! 跑两遍的噪声底是 0.000），DLL 也没有报任何参数错误。于是尺寸向上量化到
//! [`BUCKET_STEP`] 的倍数后复用：1478×2100 与 1500×2100 会落进同一个 1536×2112，
//! 页与页之间不再重建。
//!
//! 两条实测得出的约束写在这里：
//!
//! - **bucket 不能开太大**：3.1MP 的页放在 25MP 的 bucket 里要 85–103ms，放在
//!   4MP 的 bucket 里只要 31ms（评估耗时跟着 bucket 走，不完全是跟着 subrect）。
//!   所以「装得下但面积超过这一页 [`WASTE_RATIO`] 倍」的旧工作区不直接用，宁可
//!   按这一页新建一个——见 [`choose`]。
//! - 缓存规模随显存和系统提交余量变化：量不到就只留当前尺寸；余量不足时
//!   在新工作区创建之前释放旧档，NGX 内部资源也计入观测预算。
//!
//! 顺带把另外两笔每页开销也收进来了：零引导（8 字节/像素的零，恒零，建一次就够）
//! 和「纹理每页新建」，并让一页的整套命令（上传 → 各层 → 回读）逐层提交，共用一份 feature。
//!
//! **状态机**（D3D12 的 `StateBefore` 必须写对，这里刻意写成每页都一样）：
//!
//! - `input`：建好后摆进 `NON_PIXEL_SHADER_RESOURCE`；每页 `→ COPY_DEST →（拷贝）→
//!   NON_PIXEL_SHADER_RESOURCE`（见 [`GpuContext::record_upload_rgba`]）。
//! - `intermediates`：开场 `NON_PIXEL_SHADER_RESOURCE`（被某一层当 UAV 写、被下一层
//!   当 SRV 读，一页结束时又回到 SRV）。
//! - `output`：开场 `COMMON`，每页收尾 `COPY_SOURCE → COMMON`（见 `filter::run`）。
//! - 引导图恒为 `NON_PIXEL_SHADER_RESOURCE`，从不换。

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D12::{
    ID3D12Resource, D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS, D3D12_RESOURCE_STATE_COMMON,
    D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_R16G16_FLOAT, DXGI_FORMAT_R32_FLOAT,
};

use super::device::GpuContext;
use super::ngx::Parameters;

/// 尺寸量化的步子：向上取整到它的倍数。
///
/// 漫画页的差异多半只有十几像素（扫描/裁边），量化之后它们就是同一个 bucket。
pub const BUCKET_STEP: u32 = 64;

/// 条数用于防止小尺寸缓存无限增长；实际资源预算优先。
pub const MAX_WORKSPACES: usize = 4;

/// Cached buckets may coexist only when there is room for the next allocation
/// in BOTH budgets. Unknown telemetry cannot justify keeping a spare bucket.
pub fn spare_allocation_fits(
    gpu: Option<super::gpu::VideoMemory>,
    system: Option<crate::resources::SystemMemory>,
    predicted_gpu: u64,
    predicted_commit: u64,
) -> bool {
    let (Some(gpu), Some(system)) = (gpu, system) else { return false; };
    let gpu_headroom = gpu.budget_bytes.saturating_sub(gpu.budget_bytes / 4).saturating_sub(gpu.used_bytes);
    let commit_reserve = (system.physical_bytes / 8).max(512 << 20);
    predicted_gpu <= gpu_headroom
        && gpu.used_bytes <= gpu.budget_bytes.saturating_sub(gpu.budget_bytes / 4)
        && predicted_commit <= system.available_commit_bytes.saturating_sub(commit_reserve)
        && system.available_commit_bytes >= commit_reserve
        && system.private_commit_bytes.saturating_add(predicted_commit) <= system.physical_bytes / 4
}

/// 装得下但面积超过这一页这么多倍的旧工作区不值得用（实测 3 倍就开始明显变慢）。
pub const WASTE_RATIO: u64 = 3;


/// 一个 pass：特性句柄 + 它的参数表。
///
/// 句柄与它的**参数表绑在一起**：创建与评估共用同一个参数对象——创建那一步
/// NGX 会往表里放内部句柄，评估时还要用。
pub struct FeatureSlot {
    pub handle: *mut std::ffi::c_void,
    pub parameters: Parameters,
}

#[cfg(test)]
static FAIL_GUIDE_ALLOCATION: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(test)]
pub fn fail_next_guide_allocation() {
    FAIL_GUIDE_ALLOCATION.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// 一套按某个尺寸建好的 GPU 资源 + feature：一页跑完不用扔，下一页接着用。
pub struct Workspace {
    /// 创建尺寸（量化过的 bucket）。纹理比这一页大时，页贴在左上角。
    pub size: (u32, u32),
    pub input: ID3D12Resource,
    pub output: ID3D12Resource,
    /// 层与层之间的中转图（层数 − 1 张）。
    pub intermediates: Vec<ID3D12Resource>,
    /// 零引导：运动 R16G16_FLOAT、深度 R32_FLOAT。恒零，所以建一次就够。
    pub motion: ID3D12Resource,
    pub depth: ID3D12Resource,
    pub features: Vec<FeatureSlot>,
    /// A fence completed inside a multi-layer page. Cancellation must dispose
    /// of these textures rather than assume the old opening states.
    pub partial_submission: bool,
}

impl Workspace {
    /// 按 `size` 建一整套资源与 feature。整套只提交一次，且只在换 bucket 时发生。
    pub fn create(context: &mut GpuContext, size: (u32, u32), passes: usize) -> Result<Self, String> {
        let (width, height) = size;
        let color_flags = D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;
        let input = context.create_texture(width, height, DXGI_FORMAT_R8G8B8A8_UNORM, color_flags)?;
        let output = context.create_texture(width, height, DXGI_FORMAT_R8G8B8A8_UNORM, color_flags)?;
        let mut intermediates = Vec::new();
        for _ in 0..passes.saturating_sub(1) {
            intermediates.push(context.create_texture(width, height, DXGI_FORMAT_R8G8B8A8_UNORM, color_flags)?);
        }
        // 零引导：恒零的一对图（运动、深度），跟页面内容无关。以前每页都要重新铺
        // 一遍 8 字节/像素的零，25MP 的页上一次就是 200MB 的 memset + 上传。
        let (motion, _motion_upload) = context.record_zero_guide(width, height, DXGI_FORMAT_R16G16_FLOAT, 4)?;
        #[cfg(test)]
        if FAIL_GUIDE_ALLOCATION.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return Err("E_OUTOFMEMORY: injected guide allocation failure".into());
        }
        let (depth, _depth_upload) = context.record_zero_guide(width, height, DXGI_FORMAT_R32_FLOAT, 4)?;

        // 把「每页开场时该在的状态」在这里一次性摆好，这样第一页与后面每一页走的是
        // 同一条状态机：input 与中间图都以 SRV 状态开场（见模块头的状态机说明）。
        // output 不用动：它本来就是 COMMON，正是每页开场要的状态。
        context.transition(&input, D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
        for intermediate in &intermediates {
            context.transition(intermediate, D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
        }
        context.execute_and_wait()?;

        let mut workspace = Self {
            size,
            input,
            output,
            intermediates,
            motion,
            depth,
            features: Vec::new(),
            partial_submission: false,
        };
        if let Err(error) = workspace.ensure_features(context, passes) {
            if context.poisoned.is_none() {
                context.discard_recorded()?;
                workspace.release(&context.runtime);
            }
            return Err(error);
        }
        context.workspace_builds += 1;
        Ok(workspace)
    }

    /// 每个 bucket 保留一个 feature；层数变化只调整中间纹理。
    ///
    /// 只在「刚建好工作区」或「层数变多」时走到；同一 bucket 内的换页**不会**重建
    /// ——这正是这层存在的理由。
    pub fn ensure_features(&mut self, context: &mut GpuContext, passes: usize) -> Result<(), String> {
        let passes = passes.clamp(1, super::settings::MAX_PASS_COUNT as usize);
        // Layer fences and Reset=1 let one feature serve all passes.
        for slot in self.features.drain(1.min(self.features.len())..) {
            context.runtime.release(slot.handle);
        }
        self.intermediates.truncate(passes.saturating_sub(1));
        if self.intermediates.len() + 1 < passes {
            for _ in self.intermediates.len() + 1..passes {
                let texture = context.create_texture(
                    self.size.0,
                    self.size.1,
                    DXGI_FORMAT_R8G8B8A8_UNORM,
                    D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS,
                )?;
                // 新图是 COMMON 出生的，而每页开场要求中间图是 SRV（见 `create` 与
                // 模块头的状态机）。
                context.transition(
                    &texture,
                    D3D12_RESOURCE_STATE_COMMON,
                    D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE,
                );
                self.intermediates.push(texture);
            }
            context.execute_and_wait()?;
        }
        if !self.features.is_empty() {
            return Ok(());
        }
        // Parameters and the single feature handle remain paired.
        for _ in self.features.len()..1 {
            // 创建参数一个都不能少（尺寸、缩放比、回调、质量档……），少一个片段就
            // 回「参数缺失或类型不对」。
            let parameters = create_parameters(context, self.size.0, self.size.1)?;
            // SDK 的流程：建 feature 之前先让**片段自己**把客户端设的值读进它的状态
            // （`PopulateParameters_Impl`）。交给核心那一路时是核心替我们调的；直连这一路
            // 不调的话，评估阶段再读参数表就晚了（`ngx.rs` 的 `populate_parameters` 那条
            // 注释记着实测）。尺寸/缩放/质量档就是从这里进网络的。
            context.runtime.populate_parameters(&parameters)?;
            // 走**片段自己**的 `CreateFeature`（`DlssnrRuntime`），不走核心垫片那一路。
            //
            // 核心在 `CreateFeature` 之前会调 `nvLoadSignedLibraryW()` 验签，改过一个
            // 字节的片段一律加载不起来（0xBAD0000B，见 `mod.rs` 的 `SignatureVerdict`
            // 与 docs/144）。社区兼容版（签名对不上）与 FP16 版（根本没签名）都死在
            // 那一步。片段自己的导出不做这道校验，Magpie / Veyra 就是这么跑它们的。
            let handle = context.runtime.create(context.list.as_raw(), &parameters)?;
            self.features.push(FeatureSlot { handle, parameters });
        }
        context.feature_builds += 1;
        Ok(())
    }

    /// 把句柄还给 NGX（纹理靠 D3D12 的引用计数，drop 就行）。
    ///
    /// 还给**片段**（而不是核心垫片）：句柄本来就是片段发出来的，两边的释放必须成对。
    pub fn release(&mut self, runtime: &super::ngx::DlssnrRuntime) {
        for slot in self.features.drain(..) {
            runtime.release(slot.handle);
        }
    }

    /// 这一套资源占的显存（估算：颜色输入/输出/中转 + 两张引导）。
    pub fn bytes(&self) -> u64 {
        let pixels = self.size.0 as u64 * self.size.1 as u64;
        let color_textures = 2 + self.intermediates.len() as u64;
        pixels * color_textures * 4 + pixels * 8
    }
}

/// 尺寸向上量化到 [`BUCKET_STEP`]。
pub fn bucket_size(width: u32, height: u32) -> (u32, u32) {
    let round = |value: u32| value.max(1).div_ceil(BUCKET_STEP) * BUCKET_STEP;
    (round(width), round(height))
}

/// 挑哪个工作区来跑这一页。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    /// 用现成的（下标）。
    Reuse(usize),
    /// 按这个尺寸新建一个。
    Create((u32, u32)),
}

/// 从现有工作区里挑一个装得下这一页、又不算浪费的；没有就按这一页新建。
///
/// 「浪费」是实测出来的：评估耗时跟着 bucket 走，25MP 的 bucket 跑 3MP 的页要
/// 85–103ms，4MP 的只要 31ms。所以宁可多建一个小档，也不拿大档凑合——缓存里
/// 不合适的旧档在创建新档之前释放，不把长条页的 feature 一直留着。
pub fn choose(cached: &[(u32, u32)], page: (u32, u32)) -> Choice {
    let page_area = page.0 as u64 * page.1 as u64;
    let exact = bucket_size(page.0, page.1);
    let mut tightest: Option<(usize, u64)> = None;
    for (index, size) in cached.iter().enumerate() {
        if size.0 < page.0 || size.1 < page.1 {
            continue;
        }
        let area = size.0 as u64 * size.1 as u64;
        // 正好是这一页的 bucket 时永远可用：小页（比如 65×65 → 128×128，面积是页的
        // 4 倍）不能被自己的比例判据挡在门外，否则每次都要重建。
        if area > page_area.saturating_mul(WASTE_RATIO) && *size != exact {
            continue;
        }
        let better = match tightest {
            None => true,
            Some((_, best)) => area < best,
        };
        if better {
            tightest = Some((index, area));
        }
    }
    match tightest {
        Some((index, _)) => Choice::Reuse(index),
        None => Choice::Create(bucket_size(page.0, page.1)),
    }
}

/// 创建 feature 时的参数：同分辨率、不放大、缩放比 1、预设 0、质量档 Balanced。
///
/// 尺寸给的是**工作区的尺寸**（bucket）；这一页多大由评估时的 subrect 说明
/// （实测两者输出一致，差 0.012/255，见模块头）。
fn create_parameters(context: &GpuContext, width: u32, height: u32) -> Result<Parameters, String> {
    use std::ffi::c_void;

    let parameters = context.allocate_parameters()?;
    set_size_parameters(&parameters, width, height);
    parameters.set_u32("DLSSNR.Upscaling", 0);
    parameters.set_f32("DLSSNR.Scale", 1.0);
    parameters.set_f32("DLSSNR.ScalingRatio", 1.0);
    // 缩放比回调：NGX 会拿它问一遍。
    parameters.set_pointer(
        "DLSSNRComputeScalingRatioCallback",
        super::ngx::dlssnr_scaling_ratio_callback as *mut c_void,
    );
    parameters.set_i32("DLSSNR.Hint.Render.Preset", 0);
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

/// 尺寸那一组参数：创建时按工作区尺寸给，评估时同一张表还在用。
pub fn set_size_parameters(parameters: &Parameters, width: u32, height: u32) {
    parameters.set_u32("DLSSNR.Width", width);
    parameters.set_u32("DLSSNR.Height", height);
    parameters.set_u32("DLSSNR.InputWidth", width);
    parameters.set_u32("DLSSNR.InputHeight", height);
    parameters.set_u32("DLSSNR.OutputWidth", width);
    parameters.set_u32("DLSSNR.OutputHeight", height);
    parameters.set_u32("DLSSNR.Output.Width", width);
    parameters.set_u32("DLSSNR.Output.Height", height);
    parameters.set_u32("Width", width);
    parameters.set_u32("Height", height);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spare_buckets_follow_both_live_budgets() {
        let system = crate::resources::SystemMemory { physical_bytes: 32 << 30, available_commit_bytes: 20 << 30, private_commit_bytes: 1 << 30 };
        let roomy = super::super::gpu::VideoMemory { budget_bytes: 24 << 30, used_bytes: 4 << 30 };
        assert!(spare_allocation_fits(Some(roomy), Some(system), 2 << 30, 2 << 30));
        let tight = super::super::gpu::VideoMemory { budget_bytes: 2 << 30, used_bytes: 1 << 30 };
        assert!(!spare_allocation_fits(Some(tight), Some(system), 2 << 30, 2 << 30));
        let commit_tight = crate::resources::SystemMemory { available_commit_bytes: 1 << 30, ..system };
        assert!(!spare_allocation_fits(Some(roomy), Some(commit_tight), 1 << 30, 2 << 30));
        assert!(!spare_allocation_fits(None, Some(system), 0, 0));
    }

    #[test]
    fn sizes_quantize_to_the_step() {
        // 1478 与 1500 落进同一个 bucket：漫画页之间的十几像素差异不该换来一次重建。
        assert_eq!(bucket_size(1478, 2100), (1536, 2112));
        assert_eq!(bucket_size(1500, 2100), (1536, 2112));
        assert_eq!(bucket_size(64, 64), (64, 64));
        assert_eq!(bucket_size(1, 1), (64, 64));
        assert_eq!(bucket_size(0, 0), (64, 64));
        assert_eq!(bucket_size(1800, 14000), (1856, 14016));
    }

    #[test]
    fn a_page_without_a_workspace_creates_one() {
        assert_eq!(choose(&[], (1478, 2100)), Choice::Create((1536, 2112)));
    }

    #[test]
    fn a_fitting_workspace_is_reused_instead_of_rebuilt() {
        let cached = [(1536, 2112)];
        assert_eq!(choose(&cached, (1478, 2100)), Choice::Reuse(0));
        // 差二十几像素的那一页同样落在这个 bucket 里。
        assert_eq!(choose(&cached, (1500, 2100)), Choice::Reuse(0));
        // 略小一点的页同样复用（面积没到「浪费」的程度）。
        assert_eq!(choose(&cached, (1200, 1800)), Choice::Reuse(0));
        // 小太多就另建一档：1536×2112 的 bucket 跑 1024×1024 是 3.1 倍浪费。
        assert_eq!(choose(&cached, (1024, 1024)), Choice::Create((1024, 1024)));
    }

    #[test]
    fn a_workspace_much_bigger_than_the_page_is_not_worth_reusing() {
        // 25MP 的 bucket 跑 3MP 的页要 85–103ms，而 4MP 的只要 31ms：面积超过
        // 这一页 3 倍就不凑合，按这一页另建一个小档（另一档还留着，见下一条）。
        let cached = [(1856, 14016)];
        assert_eq!(choose(&cached, (1478, 2100)), Choice::Create((1536, 2112)));
    }

    #[test]
    fn both_tiers_stay_usable_after_a_long_strip_page() {
        // 先有普通页那一档，再有长条页那一档：之后各用各的。
        let cached = [(1536, 2112), (1856, 14016)];
        assert_eq!(choose(&cached, (1478, 2100)), Choice::Reuse(0));
        assert_eq!(choose(&cached, (1800, 14000)), Choice::Reuse(1));
        // 装不下的页只能新建。
        let cached = [(1536, 2112)];
        assert_eq!(choose(&cached, (2000, 3000)), Choice::Create((2048, 3008)));
    }

    #[test]
    fn the_tightest_fitting_workspace_wins() {
        let cached = [(1536, 2112), (2048, 3008), (1856, 14016)];
        assert_eq!(choose(&cached, (1400, 2000)), Choice::Reuse(0));
        assert_eq!(choose(&cached, (2000, 3000)), Choice::Reuse(1));
        assert_eq!(choose(&cached, (1800, 14000)), Choice::Reuse(2));
    }

    #[test]
    fn changing_pass_count_preserves_the_prefix_and_releases_the_unused_suffix() {
        let _gpu = crate::dlssnr::tests::gpu_test_lock();
        let Some(dll) = crate::dlssnr::tests::test_dll() else { return; };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).unwrap();
        super::super::device::with_context_at(&dir, &dll, |context| {
            let mut workspace = context.acquire_workspace(192, 256, 1, Some((192, 256)))?;
            context.execute_and_wait()?;
            // Keep the public output contract: changing 1->3->1 must not alter
            // the later one-pass output or rebuild the surviving feature.
            let first = workspace.features[0].handle;
            let grow_started = std::time::Instant::now();
            workspace.ensure_features(context, 3)?;
            context.execute_and_wait()?;
            eprintln!("DLSSNR 1->3 append took {}ms (first feature retained)", grow_started.elapsed().as_millis());
            assert_eq!(workspace.features[0].handle, first, "growing passes must not rebuild an unchanged prefix");
            assert_eq!(workspace.features.len(), 1, "layers share a single reset feature");
            fn private_commit() -> usize {
                use windows::Win32::System::{ProcessStatus::*, Threading::GetCurrentProcess};
                let mut memory = PROCESS_MEMORY_COUNTERS_EX::default();
                unsafe { GetProcessMemoryInfo(GetCurrentProcess(), (&mut memory as *mut PROCESS_MEMORY_COUNTERS_EX).cast(), std::mem::size_of_val(&memory) as u32) }.unwrap();
                memory.PrivateUsage
            }
            let before_shrink = private_commit();
            workspace.ensure_features(context, 1)?;
            eprintln!("DLSSNR 3->1 private commit {} -> {} MiB", before_shrink / 1048576, private_commit() / 1048576);
            assert_eq!(workspace.features.len(), 1, "removed NGX passes must give their large allocations back immediately");
            assert_eq!(workspace.intermediates.len(), 0);
            assert_eq!(workspace.features[0].handle, first);
            context.release_workspace(workspace);
            Ok(())
        }).expect("grow then shrink one workspace");
    }

}

//! 资源预算（docs/71 §8.4）。
//!
//! 这里只有算术：阈值、档位、退避表、宽限期。**不碰进程、不读系统信息**——物理内存、
//! 已用显存、当前私有提交都由调用方量好再传进来。这样这些规则能在没有 GPU、没有 worker
//! 的测试里逐条钉住，而不是靠「跑一遍看看会不会炸」。
//!
//! 为什么阈值要写在一处：宿主和 worker 对同一个数字有两种理解时，先崩的永远是用户的机器。

/// 单页像素上限（§8.4 沿用既有的 64M）。超过它说明这张图不是「一页」，是别的什么。
pub const PAGE_PIXEL_LIMIT: u64 = 64 * 1024 * 1024;

/// worker 重任务的 CPU 线程上限。再多就是和界面抢核，而重任务已经在 GPU 上了。
pub const MAX_WORKER_INTRA_THREADS: usize = 2;


/// 长闲置多久可以先收回 worker（§8.4）。
pub const IDLE_SHUTDOWN_MS: u64 = 120_000;

/// 长闲置多久先把**能交回的东西**交回去：缓存的工作区与模型（§12.4「idle30 秒释放
/// 模型/workspace」）。
///
/// 为什么比 [`IDLE_SHUTDOWN_MS`] 早这么多、又为什么是两件事：收摊是**换一个进程**——下次
/// 点开一页要从 `spawn` + 握手 + 装模型重新来过；交回只是把缓存里的原生内存（NGX 的
/// 工作区、ONNX 会话和它挂着的权重）放掉，下一件任务自己会把要用到的那一份再装回来。
/// 于是「用户离开两三分钟」这个最常见的局面不必付进程重建的代价，而真的走远了也会有
/// [`IDLE_SHUTDOWN_MS`] 那一支把进程端掉。两条钟都要，缺一个要么内存白占着、要么每次
/// 回来都冷启动。
pub const IDLE_RELEASE_MS: u64 = 30_000;

/// 合作取消的宽限期。过点还在跑就终止进程，但许可要等它真的退出才还（§8.2）。
pub const CANCEL_GRACE_MS: u64 = 2_000;

/// 单页默认 deadline。
pub const DEFAULT_DEADLINE_MS: u64 = 120_000;

/// ping 周期与「心跳没了」的判定。
pub const PING_INTERVAL_MS: u64 = 2_000;
pub const HEARTBEAT_MISS_LIMIT: u32 = 3;

/// 重启退避表：1s / 3s / 10s，60 秒内最多 3 次（§8.3）。
pub const RESTART_BACKOFF_MS: [u64; 3] = [1_000, 3_000, 10_000];

/// worker 从 spawn 到握手完成的上限（§8.2）。超了就是「起不来了」，不是「慢」。
pub const HANDSHAKE_TIMEOUT_MS: u64 = 15_000;

/// 送 shutdown 之后等它自己退出的宽限（§8.2）。过点就收族。
pub const SHUTDOWN_GRACE_MS: u64 = 2_000;

/// 重启退避的观察窗口：窗口内最多 [`MAX_RESTARTS_PER_WINDOW`] 次（§8.3）。
pub const RESTART_WINDOW_MS: u64 = 60_000;
pub const MAX_RESTARTS_PER_WINDOW: usize = 3;

/// 进度回前端的最小间隔＝5 Hz（§8.2）。worker 侧那份 10 ms 节流只管它自己喘得过气，
/// 宿主要按界面能承受的节奏再压一次。
pub const PROGRESS_MIN_INTERVAL_MS: u64 = 200;

/// 私有提交超过了就说明有东西在漏。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitPressure {
    Normal,
    /// 过了软阈值：应该先把后台任务丢掉，别等到分配失败。
    Soft,
    /// 过了硬阈值：这次计算随时会失败，必须开始收尾。
    Hard,
}

/// 重任务用几个 CPU 线程：`min(2, max(1, 核数 - 1))`（§8.4）。
/// **给界面留一个核**，线程内 spin 也要关掉（那是线程池那边的事）。
pub fn worker_intra_threads(available_cores: usize) -> u32 {
    available_cores
        .saturating_sub(1)
        .clamp(1, MAX_WORKER_INTRA_THREADS) as u32
}

/// Private commit follows physical memory, independently from GPU budget.
pub fn soft_commit_limit(physical_ram_bytes: u64) -> u64 {
    physical_ram_bytes / 4
}

/// 私有提交硬限：软值 × 1.25。
pub fn hard_commit_limit(physical_ram_bytes: u64) -> u64 {
    let soft = soft_commit_limit(physical_ram_bytes);
    soft + soft / 4
}

/// 当前私有提交处在哪一档。「刚好到阈值」算没过——阈值是给下一档留的余地。
pub fn commit_pressure(private_commit_bytes: u64, physical_ram_bytes: u64) -> CommitPressure {
    if private_commit_bytes > hard_commit_limit(physical_ram_bytes) {
        CommitPressure::Hard
    } else if private_commit_bytes > soft_commit_limit(physical_ram_bytes) {
        CommitPressure::Soft
    } else {
        CommitPressure::Normal
    }
}

/// 页像素是否还在上限内（宽高相乘，不是输出像素）。
pub fn pixels_within_page_limit(width: u32, height: u32) -> bool {
    // 两个 u32 直接相乘会在 4G 像素附近溢出，先升到 u64——溢出成小数会让超限的页通过。
    u64::from(width) * u64::from(height) <= PAGE_PIXEL_LIMIT
}

/// 一页按某个倍率放大之后会有多少像素。
///
/// 与 [`pixels_within_page_limit`] 是**同一笔预算的两端**：宿主转发给 worker 的
/// `Budgets.max_pixels` 就是它，worker 侧用 `max_pixels / scale²` 反推源图上限，宿主这一侧拿
/// 同一个数正推。两边判的是同一件事，所以这份乘法也只写一处。
///
/// 溢出取饱和：能乘到 `u64::MAX` 的倍率只可能来自坏输入，而饱和的结果无论如何都过不了预算
/// ——「溢出成小数，于是一张装不下的图通过了」是这条算术唯一不能有的失败方式。
pub fn projected_output_pixels(source_pixels: u64, scale: u32) -> u64 {
    let factor = u64::from(scale);
    source_pixels.saturating_mul(factor.saturating_mul(factor))
}

/// 这一页乘上倍率之后是否还装得进预算（§12.4 的 budget 那一栏）。
///
/// 调用方传入整页缓冲的倍率。worker 已按交付倍率逐块缩小后拼接，
/// 原生倍率只作用于当前带边缘的块，不再分配同倍率的完整中间帧。
pub fn output_pixels_within_budget(source_pixels: u64, scale: u32) -> bool {
    projected_output_pixels(source_pixels, scale) <= PAGE_PIXEL_LIMIT
}

/// 一条流水线走完之后会有多少像素：把每个阶段的倍率**一阶一阶**乘上去。
///
/// 链是接着算的：第二阶段的输入就是第一阶段交出来的那张图（`worker/src/executor.rs` 里的
/// `previous`）。所以「worker 会不会在这条链上拒」看的是乘积——只看某一个阶段的倍率，会漏掉
/// 两阶都是 x2 时那个 x16。
pub fn chain_output_pixels(source_pixels: u64, scales: &[u32]) -> u64 {
    let mut pixels = source_pixels;
    for scale in scales {
        pixels = projected_output_pixels(pixels, *scale);
    }
    pixels
}

/// 显存是否还留着至少 25% 的余量（§8.4：GPU 预留 ≥25%）。
pub fn gpu_reserve_satisfied(free_bytes: u64, total_bytes: u64) -> bool {
    free_bytes >= total_bytes / 4
}

/// 一次压力读数：调用方量到什么就填什么，量不到的留 `None`（§8.4）。
///
/// 三个字段都是**读数**而不是估计：宿主用 `GetProcessMemoryInfo` 拿 worker 的私有提交、
/// 用 DXGI 拿显存预算与用量。量不到就是「不知道」——它既不算「有压力」，也不算「没压力」，
/// 只是不参与那一条判断。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PressureReading {
    pub private_commit_bytes: Option<u64>,
    pub gpu_free_bytes: Option<u64>,
    pub gpu_total_bytes: Option<u64>,
}

impl PressureReading {
    /// 什么都没量到。用它算出来的准入是 [`Admission::Run`]。
    pub fn unknown() -> Self {
        Self::default()
    }
}

/// 现在这一件任务收不收（§8.1 软阈值让后台让路、§8.4 显存预留）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    /// 照收。
    Run,
    /// 只收前台的：后台预扫先停下，等压力过去（用户点开的那一页不该为预扫排队）。
    ForegroundOnly,
    /// 连前台也不收：这次计算随时会失败，让界面先报一个能重试的错。
    Refuse,
}

/// 按读数决定准入档位。
///
/// 顺序是「硬的先说话」：提交内存过了硬阈值 ⇒ [`Admission::Refuse`]（收下也会失败）；
/// 过了软阈值，或显存余量不足 25% ⇒ [`Admission::ForegroundOnly`]；两个读数量不到
/// ⇒ [`Admission::Run`]。显存那一条比的是**预算里的余量**（DXGI 的 `Budget - CurrentUsage`）
/// 与**卡的总容量**（适配器描述里的 `DedicatedVideoMemory`）——都不是猜的数。
pub fn admission(reading: &PressureReading, physical_ram_bytes: u64) -> Admission {
    admission_with_available_commit(reading, physical_ram_bytes, None)
}

/// Preserve OS/UI commit headroom even when this worker itself is small.
pub fn admission_with_available_commit(reading: &PressureReading, physical_ram_bytes: u64, available_commit_bytes: Option<u64>) -> Admission {
    if let Some(available) = available_commit_bytes {
        let reserve = (physical_ram_bytes / 16).max(256 * 1024 * 1024);
        if available < reserve / 2 { return Admission::Refuse; }
        if available < reserve { return Admission::ForegroundOnly; }
    }
    if let Some(commit) = reading.private_commit_bytes {
        match commit_pressure(commit, physical_ram_bytes) {
            CommitPressure::Hard => return Admission::Refuse,
            CommitPressure::Soft => return Admission::ForegroundOnly,
            CommitPressure::Normal => {}
        }
    }
    if let (Some(free), Some(total)) = (reading.gpu_free_bytes, reading.gpu_total_bytes) {
        if !gpu_reserve_satisfied(free, total) {
            return Admission::ForegroundOnly;
        }
    }
    Admission::Run
}

/// 这一段的闲置够久了没有。**含端点**：到点就算，不差这一拍。
///
/// 阈值**由调用方给**（生产那条路由 [`crate::compute::manager::SupervisorConfig`] 从
/// [`IDLE_RELEASE_MS`]/[`IDLE_SHUTDOWN_MS`] 取，集成测试可以把它缩到几百毫秒）。
/// 条这里不藏第二份阈值：两条钟（先交回、再收摊）共用这一条判据，只有调用处那两行
/// 才知道现在问的是哪一条——所以「谁先谁后」在调用点一眼能看见，而边界规则只有一处。
pub fn idle_due(idle_ms: u64, threshold_ms: u64) -> bool {
    idle_ms >= threshold_ms
}

/// 这次计算已经超过它的 deadline。
pub fn deadline_exceeded(elapsed_ms: u64, deadline_ms: u64) -> bool {
    elapsed_ms > deadline_ms
}

/// 取消请求已经等过了合作宽限期 → 该终止进程了。
pub fn cancel_grace_exceeded(elapsed_ms: u64) -> bool {
    elapsed_ms > CANCEL_GRACE_MS
}

/// 第 `attempt` 次重启前该等多久；`None` = 到上限了，别再自动重启（§8.3）。
/// `attempt` 从 1 开始。
pub fn restart_backoff(attempt: u32) -> Option<u64> {
    if attempt == 0 {
        return None;
    }
    RESTART_BACKOFF_MS.get(attempt as usize - 1).copied()
}

/// 连续缺失 `misses` 次心跳之后才算失去 worker。
pub fn heartbeat_lost(misses: u32) -> bool {
    misses >= HEARTBEAT_MISS_LIMIT
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn a_heavy_task_leaves_one_core_for_the_interface() {
        assert_eq!(worker_intra_threads(1), 1, "只有一个核也不能是 0 个线程");
        assert_eq!(worker_intra_threads(2), 1);
        assert_eq!(worker_intra_threads(3), 2);
        assert_eq!(worker_intra_threads(16), 2, "线程数不跟着核数一直涨");
        assert_eq!(worker_intra_threads(256), MAX_WORKER_INTRA_THREADS as u32);
    }

    #[test]
    fn the_soft_commit_limit_scales_past_four_gib() {
        // Large machines may use more than the former fixed 4 GiB ceiling.
        assert_eq!(soft_commit_limit(64 * GIB), 16 * GIB);
        // 8 GiB 的小机器：25% 只有 2 GiB，那才是它该用的数。
        assert_eq!(soft_commit_limit(8 * GIB), 2 * GIB);
        assert_eq!(soft_commit_limit(GIB), GIB / 4);
    }

    #[test]
    fn system_commit_pressure_is_independent_of_worker_usage() {
        assert_eq!(admission_with_available_commit(&PressureReading::unknown(), 16 * GIB, Some(GIB / 4)), Admission::Refuse);
        assert_eq!(admission_with_available_commit(&PressureReading::unknown(), 16 * GIB, Some(3 * GIB / 4)), Admission::ForegroundOnly);
        assert_eq!(admission_with_available_commit(&PressureReading::unknown(), 16 * GIB, Some(2 * GIB)), Admission::Run);
    }

    #[test]
    fn the_hard_limit_is_a_quarter_above_the_soft_one() {
        assert_eq!(hard_commit_limit(8 * GIB), 2 * GIB + 2 * GIB / 4);
        assert!(hard_commit_limit(63 * GIB) > soft_commit_limit(63 * GIB));
    }

    #[test]
    fn commit_pressure_has_exactly_two_trip_points() {
        let ram = 8 * GIB;
        let soft = soft_commit_limit(ram);
        let hard = hard_commit_limit(ram);
        assert_eq!(commit_pressure(0, ram), CommitPressure::Normal);
        assert_eq!(
            commit_pressure(soft, ram),
            CommitPressure::Normal,
            "刚好到软阈值不算过"
        );
        assert_eq!(commit_pressure(soft + 1, ram), CommitPressure::Soft);
        assert_eq!(commit_pressure(hard, ram), CommitPressure::Soft);
        assert_eq!(commit_pressure(hard + 1, ram), CommitPressure::Hard);
    }

    #[test]
    fn a_page_over_the_pixel_limit_is_refused_at_the_boundary() {
        assert!(pixels_within_page_limit(8192, 8192), "恰好 64M 像素是允许的");
        assert!(pixels_within_page_limit(1, 1));
        assert!(!pixels_within_page_limit(8192, 8193), "多一行也不行");
        // 相乘要按 u64 算：32K×32K 的 u32 乘积还没溢出，但再大就会。
        assert!(!pixels_within_page_limit(u32::MAX, u32::MAX));
    }

    /// 一页自己装得下、乘上倍率就装不下——这条边界与 worker 那边是同一个数，所以这里钉的是
    /// 「两侧算的是不是同一件事」，不是「宿主自己新立了一个上限」。
    #[test]
    fn a_scaled_page_is_refused_at_the_same_boundary_the_worker_uses() {
        assert!(
            output_pixels_within_budget(4096 * 4096, 2),
            "4096×4096 x2 恰好 67 108 864 像素：与源图那一侧一样，卡在线上是允许的"
        );
        assert!(
            !output_pixels_within_budget(4096 * 4097, 2),
            "多一行也过不去"
        );
        assert!(
            !output_pixels_within_budget(5000 * 4000, 2),
            "20 MP 自己没超、x2 之后超了：这正是宿主以前不判的那一格"
        );
        assert!(output_pixels_within_budget(8192 * 8192, 1), "x1 就是源图自己");
        assert!(
            output_pixels_within_budget(u64::from(u32::MAX) * u64::from(u32::MAX), 0),
            "倍率 0 是「没声明倍率」，不是「无穷大」"
        );
        assert!(
            !output_pixels_within_budget(1, u32::MAX),
            "坏倍率乘出来的饱和值只可能更大，不许溢出成小数字溜过去"
        );
        // 这一条钉的是**溢出**那一半：2^32 × 2^32 在 u64 里正好绕回 0，而 0 一定「装得下」。
        // 只有饱和（或者 debug 下的溢出 panic）拦得住它——绕回来当通过，等于把一张算不了的
        // 页放进去，代价是 worker 那边的几十秒 GPU 时间。
        assert!(
            !output_pixels_within_budget(1 << 32, 65_536),
            "溢出的乘积（这里正好绕回 0）不许被当成「装得下」"
        );
    }

    #[test]
    fn the_chain_multiplies_stage_by_stage() {
        assert_eq!(chain_output_pixels(1_000, &[]), 1_000);
        assert_eq!(chain_output_pixels(1_000, &[1]), 1_000);
        assert_eq!(chain_output_pixels(1_000, &[2]), 4_000);
        assert_eq!(
            chain_output_pixels(1_000, &[2, 2]),
            16_000,
            "两阶都是 x2 时是 x16，不是 x4"
        );
    }

    #[test]
    fn the_gpu_reserve_keeps_a_quarter_of_vram_free() {
        assert!(gpu_reserve_satisfied(8 * GIB, 32 * GIB));
        assert!(
            gpu_reserve_satisfied(8 * GIB, 32 * GIB),
            "恰好 25% 算满足"
        );
        assert!(!gpu_reserve_satisfied(8 * GIB - 1, 32 * GIB));
        assert!(gpu_reserve_satisfied(GIB, GIB));
    }

    #[test]
    fn a_machine_under_pressure_lets_the_background_go_before_it_refuses_everything() {
        let ram = 8 * GIB; // 软 2 GiB / 硬 2.5 GiB
        let soft = soft_commit_limit(ram);
        let hard = hard_commit_limit(ram);
        let roomy = |commit: u64| PressureReading {
            private_commit_bytes: Some(commit),
            gpu_free_bytes: Some(16 * GIB),
            gpu_total_bytes: Some(32 * GIB),
        };

        assert_eq!(admission(&roomy(0), ram), Admission::Run, "没压力就照收");
        assert_eq!(
            admission(&roomy(soft), ram),
            Admission::Run,
            "刚好到软阈值不算过——和 commit_pressure 同一条边界"
        );
        assert_eq!(
            admission(&roomy(soft + 1), ram),
            Admission::ForegroundOnly,
            "过了软阈值：后台先停下，用户点开的那一页还收"
        );
        assert_eq!(
            admission(&roomy(hard + 1), ram),
            Admission::Refuse,
            "过了硬阈值：连前台也不收——收下也是失败，不如让界面报一个能重试的错"
        );
    }

    #[test]
    fn a_scarce_gpu_stops_the_background_without_stopping_the_page_the_user_opened() {
        let ram = 8 * GIB;
        let total = 32 * GIB;
        let with_vram = |free: u64| PressureReading {
            private_commit_bytes: Some(0),
            gpu_free_bytes: Some(free),
            gpu_total_bytes: Some(total),
        };
        assert_eq!(
            admission(&with_vram(total / 4), ram),
            Admission::Run,
            "恰好 25% 算留着余量"
        );
        assert_eq!(
            admission(&with_vram(total / 4 - 1), ram),
            Admission::ForegroundOnly
        );
        assert_eq!(admission(&with_vram(0), ram), Admission::ForegroundOnly);
    }

    #[test]
    fn a_reading_we_could_not_take_does_not_block_anything() {
        let ram = 8 * GIB;
        assert_eq!(admission(&PressureReading::unknown(), ram), Admission::Run);

        // 只量到一半：量到的那一半单独也说得清自己的事。
        let commit_only = PressureReading {
            private_commit_bytes: Some(hard_commit_limit(ram) + 1),
            gpu_free_bytes: None,
            gpu_total_bytes: None,
        };
        assert_eq!(
            admission(&commit_only, ram),
            Admission::Refuse,
            "量不到显存不代表量不到提交内存"
        );
        let vram_only = PressureReading {
            private_commit_bytes: None,
            gpu_free_bytes: Some(0),
            gpu_total_bytes: Some(32 * GIB),
        };
        assert_eq!(admission(&vram_only, ram), Admission::ForegroundOnly);

        // 只有余量、没有总量：比例算不出来，不拦。
        let half_vram = PressureReading {
            private_commit_bytes: None,
            gpu_free_bytes: Some(0),
            gpu_total_bytes: None,
        };
        assert_eq!(admission(&half_vram, ram), Admission::Run, "比例算不出来就别拦人");
    }

    #[test]
    fn the_hard_commit_threshold_wins_over_a_roomy_gpu() {
        let ram = 8 * GIB;
        let reading = PressureReading {
            private_commit_bytes: Some(hard_commit_limit(ram) + 1),
            gpu_free_bytes: Some(32 * GIB),
            gpu_total_bytes: Some(32 * GIB),
        };
        assert_eq!(
            admission(&reading, ram),
            Admission::Refuse,
            "内存要炸的时候显存再空也救不了"
        );
    }

    #[test]
    fn idle_and_deadlines_are_inclusive_at_the_boundary() {
        // 闲置那条钟的阈值由调用方给（配置能缩），但「到点就算」这条规矩在这里钉住：
        // 差一毫秒不算，正好到点算。
        assert!(!idle_due(IDLE_SHUTDOWN_MS - 1, IDLE_SHUTDOWN_MS));
        assert!(idle_due(IDLE_SHUTDOWN_MS, IDLE_SHUTDOWN_MS));
        assert!(!deadline_exceeded(DEFAULT_DEADLINE_MS, DEFAULT_DEADLINE_MS));
        assert!(deadline_exceeded(DEFAULT_DEADLINE_MS + 1, DEFAULT_DEADLINE_MS));
        assert!(!cancel_grace_exceeded(CANCEL_GRACE_MS));
        assert!(cancel_grace_exceeded(CANCEL_GRACE_MS + 1));
    }

    #[test]
    fn the_idle_release_comes_before_the_idle_shutdown() {
        // 两条钟用的是同一条判据（`idle_due`），这里量的是它俩的**先后**：阈值一个 30 秒、
        // 一个 120 秒，而调用点先问交回、再问收摊。
        assert!(!idle_due(IDLE_RELEASE_MS - 1, IDLE_RELEASE_MS));
        assert!(
            idle_due(IDLE_RELEASE_MS, IDLE_RELEASE_MS),
            "到点就交：与收摊同一条边界规矩（含端点）"
        );
        assert_eq!(IDLE_RELEASE_MS, 30_000, "§12.4：idle 30 秒释放");
        assert!(
            IDLE_RELEASE_MS < IDLE_SHUTDOWN_MS,
            "交回必须比收摊早：晚了就永远轮不到它——收摊先把整个进程端掉了"
        );
        // 两条钟各问各的：闲置到 120 秒的时候两支都亮，交回那支不该因为收摊那支亮过就不亮。
        assert!(idle_due(IDLE_SHUTDOWN_MS, IDLE_SHUTDOWN_MS));
        assert!(idle_due(IDLE_SHUTDOWN_MS, IDLE_RELEASE_MS));
    }

    #[test]
    fn the_restart_backoff_is_one_three_ten_and_then_never() {
        assert_eq!(restart_backoff(1), Some(1_000));
        assert_eq!(restart_backoff(2), Some(3_000));
        assert_eq!(restart_backoff(3), Some(10_000));
        assert_eq!(restart_backoff(4), None, "60 秒内最多 3 次");
        assert_eq!(restart_backoff(0), None, "次数从 1 开始");
    }

    #[test]
    fn a_worker_is_lost_only_after_three_missed_heartbeats() {
        assert!(!heartbeat_lost(0));
        assert!(!heartbeat_lost(1));
        assert!(!heartbeat_lost(2));
        assert!(heartbeat_lost(3));
        assert!(heartbeat_lost(4));
    }

    #[test]
    fn the_supervision_numbers_are_the_ones_in_the_spec() {
        assert_eq!(HANDSHAKE_TIMEOUT_MS, 15_000, "§8.2 握手 15 秒");
        assert_eq!(SHUTDOWN_GRACE_MS, 2_000, "§8.2 shutdown 宽限 2 秒");
        assert_eq!(RESTART_WINDOW_MS, 60_000, "§8.3 退避看 60 秒窗口");
        assert_eq!(MAX_RESTARTS_PER_WINDOW, 3, "§8.3 窗口内最多 3 次");
        assert_eq!(PING_INTERVAL_MS * HEARTBEAT_MISS_LIMIT as u64, 6_000, "§8.2 连续 3 次≥6 秒");
        assert_eq!(
            PROGRESS_MIN_INTERVAL_MS,
            1_000 / 5,
            "§8.2 进度节流 ≤5 Hz：200 ms 一条"
        );
    }
}

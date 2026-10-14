//! Yomika 计算 worker（docs/71 §5.1、§11 Task 3）。
//!
//! 这个进程**不启动 Tauri**、不碰数据库、不读凭据：它从宿主创建的私有命名管道上
//! 收任务帧、串行跑一个重任务、把产物的**元数据**报回去，产物本身写在宿主授权的
//! staging 目录里（§7.3 第 1 步：先在 staging 写 `.part`，close 后 rename 成完整文件）。
//!
//! 三件事刻意分开：
//!
//! - [`protocol`] 是**会话状态机**，对 `Read`/`Write` 泛型——所以它能被内存双工完整
//!   测到（握手、version 不符、一帧跨两次读、双 run busy、边算边 ping/cancel），
//!   不需要真管道；真管道只是 `main.rs` 里传给它的一个 `Read + Write`。
//! - [`executor`] 是**串行执行器**：同一时刻只有一个重任务，第二个 `run` 明说 busy，
//!   不藏一条无限 FIFO（§6.3）。控制面（ping/cancel/shutdown）由会话主线程处理，
//!   不受执行器阻塞。
//! - [`engine`] 是**算法边界**：`echo` 引擎不加载任何模型（进程测试与协议测试靠它），
//!   [`upscale`] 是 Task 7-b-ii 接进来的真超分引擎（解授权图 → core 的 `upscale_rgba`
//!   → 编码 PNG 写 staging）。引擎不直接写管道，只回产物元数据，进度通过回调给执行器。
//!
//! 退出语义（§6.1）：父进程关闭管道（EOF）就退出。执行器线程是**分离**的——重任务
//! 没法被安全打断，宿主按 §6.5 超时杀进程，而不是等 worker 自己体面收尾。

#[cfg(windows)]
pub mod dlssnr;
pub mod engine;
pub mod executor;
pub mod pipeline;
pub mod protocol;
pub mod stage_io;
pub mod upscale;

/// 这份 worker 是谁编的：与主 exe 用同一个环境变量、同一段「缺省取 git」的逻辑
/// （`worker/build.rs` 抄的就是 `src-tauri/build.rs` 那一段），所以一次 release 构建里
/// 两半天然是同一个戳。`main.rs` 把它填进握手报的 `BuildInfo`，宿主拿它和自己的对，
/// 对不上就不拼起来用（docs/71 §13 Task 10 第 2 条）。
pub const BUILD_COMMIT: &str = env!("YOMIKA_BUILD_COMMIT");

/// 上面那串的**字节形态**，专门留给打包核查：`.github/scripts/verify-build-stamp.ps1`
/// 是按字节在可执行文件里找那 12 个字符的（Task 10 第 1 条要求「对着文件能核戳」）。
///
/// 为什么不能只写 `BUILD_COMMIT.to_string()`：那一句会被 LLVM 折成几条寄存器立即数，
/// release 二进制的 `.rdata` 里**根本不会留下这一串明文**（debug 构建不会折，所以这个洞
/// 只在交付构建上露头）。`#[used]` + `#[no_mangle]` 让它以外部链接躺在 `.rdata` 里，
/// `/OPT:REF` 收不走。
#[used]
#[no_mangle]
pub static YOMIKA_BUILD_COMMIT_STAMP: [u8; BUILD_COMMIT.len()] = build_commit_bytes();

const fn build_commit_bytes() -> [u8; BUILD_COMMIT.len()] {
    let source = BUILD_COMMIT.as_bytes();
    let mut out = [0u8; BUILD_COMMIT.len()];
    let mut index = 0;
    while index < source.len() {
        out[index] = source[index];
        index += 1;
    }
    out
}

/// 把这一代 worker 进程里缓存的引擎工作区交回系统（docs/71 §8.4），返回交回了几份。
///
/// 为什么这件事只能在**这里**发生：NGX 的 D3D12 设备与「一份尺寸/变体一格」的工作区
/// 缓存都是这个进程里的东西，而宿主那一侧已经没有引擎了（8-g④-a1～b2b 把 DLSSNR 的
/// 入口全搬进了核心，宿主只剩命令壳）。别的目标上没有这套东西，恒 0——但会话仍然会把
/// 这个 0 报回去：「交回 0 份」与「没交回」在宿主那边必须能分开。
pub fn release_workspaces() -> u32 {
    // 进程测试的钩子：真工作区只有真 NGX 跑过才数得出来，而集成测试要证的是「数字走完了
    // 整条路」，所以得能注入一个非零数。宿主 spawn 时 `env_clear()` 之后只传它想传的
    // 变量，生产路径上没有门能打开它——与 `YOMIKA_WORKER_TEST_*` 其它钩子同一个理由。
    if let Ok(raw) = std::env::var("YOMIKA_WORKER_TEST_RELEASED_WORKSPACES") {
        if let Ok(count) = raw.trim().parse::<u32>() {
            return count;
        }
    }
    #[cfg(windows)]
    {
        yomika_compute_core::dlssnr::release_cached_workspaces() as u32
    }
    #[cfg(not(windows))]
    {
        0
    }
}

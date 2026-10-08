//! 宿主与计算 worker 之间的传输层（docs/71 §6.1）。
//!
//! 为什么单独一个 crate、而不是让一端复制另一端：管道两端必须是同一份实现。把重叠 IO
//! 抄成两份，等于让「读在飞时同一个连接上的写会死锁」（见 `pipe.rs` 的模块文档与
//! `tests/pipe_probe.rs`）这个坑有两个各自演化的地方；反过来让宿主依赖 worker 的库，
//! 又会把 worker 的引擎与执行器塞进主进程的依赖图里——那是 docs/71 §5.2 明确不许的。
//! 传输既不认识算法也不认识协议消息，只搬字节，所以它待在两者中间。
//!
//! 只依赖 windows-rs，且只在 `cfg(windows)` 下用；非 Windows 目标上是同名空壳
//! （worker 会被 Android 目标编到，空壳让跨目标 `cargo check` 能过）。

pub mod pipe;
pub mod server;

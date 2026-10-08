//! 兼容层：分块放大管道住在 [`yomika_compute_core::upscale`]。
//!
//! docs/71 §11 Task 2 把「纯算法」抽进计算核心：规划/裁剪/回贴/预算/取消点都不
//! 认 ORT、不认 Tauri、也不认数据库，所以它们必须能在一个没有 UI 的进程里跑。
//! 宿主只保留 `inference::upscale::*` 这个路径，`onnx.rs` 与 `anime4k.rs` 里的
//! `impl UpscaleEngine` 照旧写在这里的名字上。
//!
//! 唯一的签名变化：`UpscaleOptions::cancel` 从裸 `Arc<AtomicBool>` 换成了
//! [`CancelToken`]（核心不认识宿主的 `TaskGuard`，用 `CancelToken::watch` 包一张
//! 外部旗子即可）；相应的断言已经搬到 `crates/compute-core/tests/upscale.rs`，
//! 编号不丢。

// 与取消牌同理：`blit_tile`/`crop_rgba`/`Tile`/`UpscaledImage` 现在是管道内部
// 的东西，宿主不直接点名，但路径要保持与核心一致，方便回溯这两处定义。
#[allow(unused_imports)]
pub use yomika_compute_core::upscale::{
    blit_tile, crop_rgba, plan_tiles, upscale_rgba, NearestNeighbourEngine, Tile, UpscaleEngine,
    UpscaleOptions, UpscaledImage, DEFAULT_TILE_PADDING, DEFAULT_TILE_SIZE,
};

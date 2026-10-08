//! 兼容层：修补执行体住在 [`yomika_compute_core::inpaint`]，与 [`super::upscale`] 同理。
//!
//! docs/71 §11 Task 8 把去码搬进计算核心，第一段搬的就是「与具体调用方无关的执行体」：
//! 张量约定、`[-1, 1]` 换算、mask 的反向约定、以及「alpha 永远是页面的」都不认 Tauri、
//! 不认数据库，也不认这是宿主还是 worker 在跑。宿主只保留 `inference::inpaint::*` 这个
//! 路径（`DecensorEngines` 那层会话已经随 8-g③-iii 一起走了，`run_decensor_bytes` 不再存在）。
//!
//! 4 条断言（3 条张量单测 + 真模型那条）跟着代码搬去了
//! `crates/compute-core/src/inpaint.rs` 的 `#[cfg(test)] mod tests`——测试跟着代码走，
//! 不是弱化：真模型那条仍然是唯一拿真实图核对 mask 约定与值域的地方。

#[allow(unused_imports)]
pub use yomika_compute_core::inpaint::{InpaintEngine, INPAINT_SIDE};

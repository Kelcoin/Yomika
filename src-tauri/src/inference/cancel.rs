//! 兼容层：取消牌的实现在 [`yomika_compute_core::cancel`]。
//!
//! docs/71 §11 Task 2 ⑤ 要求抽取「先让宿主继续可执行，每小步可构建，最后再删
//! 兼容调用」。这里只留 `inference::cancel::*` 这个路径，现有调用点一行不用改；
//! `Cancelled` → `InferenceError` 的映射由核心的 `ComputeError` 自带（宿主的
//! `InferenceError` 现在就是它的别名），所以这里再写一遍会撞 E0119。

// 留下来的名字宿主眼下并不直接点名（`Cancelled` 只出现在错误匹配的注释里，
// `pending_count`/`TaskGuard` 是给 Task 3 的 worker 骨架与诊断用的），但兼容层
// 的意义就是「路径等于核心的 API」，所以一处不删。
#[allow(unused_imports)]
pub use yomika_compute_core::cancel::{
    begin, cancel, pending_count, CancelToken, Cancelled, TaskGuard, MAX_PENDING_CANCELS,
};

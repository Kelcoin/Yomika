//! 计算错误的统一词汇。
//!
//! 这些错误全都属于「一次计算为什么不成功」，与 Tauri、数据库、凭据无关，所以
//! 归核心所有（docs/71 §5.3：错误语义随算法一起搬）。宿主保留自己的名字
//! `InferenceError`，但那只是一个别名——两边不会出现两套语义。
//!
//! 唯一需要小心的语义是 [`ComputeError::Cancelled`]：它**不是**失败。切页、关
//! 开关、离开阅读器都会产生它，调用方要据此回「已取消」而不是记一条错误日志，
//! 更不要把它写进任何缓存。

use crate::cancel::Cancelled;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComputeError {
    InvalidInput(String),
    PixelBudgetExceeded { pixels: usize, max_pixels: usize },
    InvalidManifest(String),
    /// 同一个缓存的会话正被别的请求重建：重试一次就对了，不是失败。
    CacheBusy,
    Cancelled,
}

impl std::fmt::Display for ComputeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ComputeError::InvalidInput(message) => write!(formatter, "invalid input: {message}"),
            ComputeError::PixelBudgetExceeded { pixels, max_pixels } => write!(
                formatter,
                "pixel budget exceeded: {pixels} > {max_pixels}"
            ),
            ComputeError::InvalidManifest(message) => {
                write!(formatter, "invalid manifest: {message}")
            }
            ComputeError::CacheBusy => formatter.write_str("the cache is busy"),
            ComputeError::Cancelled => formatter.write_str("cancelled"),
        }
    }
}

impl std::error::Error for ComputeError {}

/// 取消点统一返回 `Cancelled`；翻成计算错误后调用方不用再认识第二个取消类型。
impl From<Cancelled> for ComputeError {
    fn from(_: Cancelled) -> Self {
        ComputeError::Cancelled
    }
}

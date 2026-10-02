use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum CommandResult<T> {
    Success { ok: bool, value: T },
    Failure { ok: bool, error: DomainError },
}

#[derive(Debug, Serialize)]
pub struct DomainError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl<T> CommandResult<T> {
    pub fn success(value: T) -> Self {
        Self::Success { ok: true, value }
    }

    #[allow(dead_code)]
    pub fn failure(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self::Failure {
            ok: false,
            error: DomainError {
                code,
                message: message.into(),
                retryable,
            },
        }
    }
}

/// Sends image bytes over IPC as a binary body instead of a JSON array of
/// numbers (a 2 MB page became ~2 million JSON numbers, inflating the payload
/// several times over and forcing per-element validation on the frontend).
/// Failures keep the existing `{ ok: false, error }` JSON envelope, so the
/// frontend can tell the two apart by the response type alone.
///
/// 出站这一处是阅读器拿到的所有图片字节的**唯一共同关口**：磁盘缓存命中、服务器刚
/// 取回、超分与去码把动图原样当成功交回、DLSSNR 的旧产物、帧数或预算超限时的原图、
/// 远端引擎的回声，全都从这里出去。动图的循环次数（用户报「动图只播一遍」）就在这
/// 里统一成「一直播」，见 [`crate::cache::force_infinite_loop`]。
pub fn into_binary_response(result: CommandResult<Vec<u8>>) -> tauri::ipc::Response {
    match result {
        CommandResult::Success { value, .. } => {
            tauri::ipc::Response::new(crate::cache::force_infinite_loop(value))
        }
        failure => tauri::ipc::Response::new(serde_json::to_string(&failure).unwrap_or_else(|_| {
            r#"{"ok":false,"error":{"code":"UNKNOWN","message":"Failed to serialize error","retryable":true}}"#.to_string()
        })),
    }
}

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

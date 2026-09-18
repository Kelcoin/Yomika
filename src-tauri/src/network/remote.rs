//! 远端同步文档的通用形状与错误。
//!
//! 两个后端（WebDAV 与 S3 兼容对象存储）做的事完全一样：读一份文件、条件写回、
//! 删掉它。共用的部分放这里，各自的协议细节留在 `webdav.rs` / `s3.rs`。
use reqwest::StatusCode;

#[derive(Debug)]
pub enum RemoteError {
    InvalidUrl(String),
    Request(String),
    /// 别人先写了一版：调用方要重新拉取、重新合并再写。
    StateConflict,
    Http(StatusCode),
    Verification(String),
}

impl std::fmt::Display for RemoteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl(value) | Self::Request(value) | Self::Verification(value) => {
                formatter.write_str(value)
            }
            Self::StateConflict => formatter.write_str("远端同步文档已被别的设备改过"),
            Self::Http(status) => write!(formatter, "远端返回 HTTP {status}"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct RemoteState {
    pub ciphertext: Vec<u8>,
    pub etag: Option<String>,
}

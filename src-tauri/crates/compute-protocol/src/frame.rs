//! 计算 worker 的帧格式（docs/71 §6.2）：`u32` 小端长度 + UTF-8 JSON 正文，
//! 长度不含那 4 字节前缀。
//!
//! 这里只做「一行一帧」的边界，不做消息语义：语义在 [`crate::messages`]。
//! 顺序很重要——**先看长度再分配**：一个宣称 4 GiB 的前缀必须在我们申请内存
//! 之前就被拒掉，否则对端一句谎话就能让宿主 OOM。

use std::fmt;
use std::io::{Read, Write};

/// 单帧正文上限 64 KiB。超过的一律在分配前拒绝。
pub const MAX_FRAME_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// 长度前缀超过 [`MAX_FRAME_BYTES`]。
    TooLarge { declared: u32 },
    /// 前缀或正文中途断掉。
    Truncated { declared: u32, read: usize },
    /// 正文不是合法 UTF-8。
    NotUtf8,
    /// 读/写本身失败（管道断开等）。
    Io(String),
}

impl fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { declared } => write!(
                formatter,
                "frame body of {declared} bytes exceeds the {MAX_FRAME_BYTES} byte limit"
            ),
            Self::Truncated { declared, read } => write!(
                formatter,
                "frame body of {declared} bytes was cut short after {read} bytes"
            ),
            Self::NotUtf8 => formatter.write_str("frame body is not valid UTF-8"),
            Self::Io(message) => write!(formatter, "frame io failed: {message}"),
        }
    }
}

impl std::error::Error for FrameError {}

/// 读一帧。返回 `Ok(None)` 只在**帧边界上的干净 EOF**（对端正常关闭）时出现；
/// 读到一半断开是 [`FrameError::Truncated`]，不是 EOF。
pub fn read_frame<R: Read>(reader: &mut R) -> Result<Option<Vec<u8>>, FrameError> {
    let mut prefix = [0u8; 4];
    let mut filled = 0usize;
    while filled < prefix.len() {
        match reader.read(&mut prefix[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(FrameError::Io(error.to_string())),
        }
    }
    if filled == 0 {
        return Ok(None);
    }
    if filled < prefix.len() {
        return Err(FrameError::Truncated {
            declared: 0,
            read: filled,
        });
    }
    let declared = u32::from_le_bytes(prefix);
    // 先看长度再看正文：否则对端只要写一个假的 4 GiB 前缀就能让宿主先去申请
    // 4 GiB 内存，谎话变成了攻击面。
    if declared as usize > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge { declared });
    }
    let mut body = vec![0u8; declared as usize];
    let mut read = 0usize;
    while read < body.len() {
        match reader.read(&mut body[read..]) {
            Ok(0) => {
                return Err(FrameError::Truncated { declared, read });
            }
            Ok(count) => read += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(FrameError::Io(error.to_string())),
        }
    }
    // 正文按契约是 UTF-8 JSON。在这里判而不是留给 JSON 解析器，是为了让「编码
    // 就不是文本」有一个明确的错误，而不是一个含糊的语法错。
    if std::str::from_utf8(&body).is_err() {
        return Err(FrameError::NotUtf8);
    }
    Ok(Some(body))
}

/// 写一帧。正文超过上限时拒绝写（不写前缀，避免对端读到半帧）。
pub fn write_frame<W: Write>(writer: &mut W, body: &[u8]) -> Result<(), FrameError> {
    if body.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge {
            declared: body.len() as u32,
        });
    }
    writer
        .write_all(&(body.len() as u32).to_le_bytes())
        .and_then(|()| writer.write_all(body))
        .map_err(|error| FrameError::Io(error.to_string()))
}

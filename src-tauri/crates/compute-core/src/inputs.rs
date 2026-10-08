//! 宿主授权的**只读输入**：一份相对路径怎么变成一条可以放心打开的路（docs/71 §7.1、§7.2）。
//!
//! 计算要有像素，像素在宿主的缓存里。§7.1 允许宿主「pin 住就不复制整图」，把它
//! 手里的文件**只读授权**给 worker；于是 worker 会拿到一个「相对授权根」的字符串。
//! 这个字符串是跨进程来的，与用户输入一样不可信。
//!
//! 为什么不能只用字符串前缀判断（§7.2 明写这一条）：
//!
//! * Windows 把 `/` 和 `\` 当同一个分隔符，把大小写当同一个名字；
//! * `page.png:stream` 是同一个文件上的**另一条数据流**，字符串上看仍然在根里；
//! * `sub` 可能是 junction / 符号链接，指到根外的任何地方，而名字毫无破绽；
//! * 段尾的空格与点在 Windows 上会被悄悄去掉，于是「检查的名字」与「真正
//!   打开的文件」不是同一个——这是最好用的一种绕过。
//!
//! 所以这里逐段走真实文件系统：每一段都拒重解析点，末段必须是普通文件，最后
//! 再用解析后的**真实路径**确认仍在授权根之内（纵深防御：万一上面哪天少查一段）。
//! 光拒绝还不够——就算路径完全合法，内容也可能与宿主声明的不符（半途被替换、
//! 或者宿主自己算错了），所以 `verify_file` 要按声明复核长度与内容 hash。
//!
//! 这里**不**做权限判断：哪张图能算、属于哪个档案，是宿主在进程里用数据库查的
//! （§7.2），核心 crate 不认识数据库，也不该认识。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// 输入不可用（路径非法、对不上声明、读不出来）。这条码会一路走到前端。
pub const INPUT_INVALID_CODE: &str = "COMPUTE_INPUT_INVALID";

/// 相对路径的字节上限。授权根下面的名字是宿主自己造的内容寻址名（
/// `<hash 前 2 位>/<hash><扩展名>`），几百字节已经宽得离谱了。
pub const MAX_RELATIVE_PATH_BYTES: usize = 200;

/// 单个路径段的字节上限。NTFS 自己限 255，这里也只允许到那里。
pub const MAX_SEGMENT_BYTES: usize = 255;

/// 读输入时一次读多少：与宿主复核产物用同一档大小，不为了「快一点」把整图
/// 读进内存——这张图可能上百 MB，而 worker 是要长驻的。
const READ_CHUNK_BYTES: usize = 64 * 1024;

/// 输入不可用的各种原因。全部翻成一条对外的码，因为对渲染器来说「这份输入不能用」
/// 就是一件事；细节留在 `message` 里给人看、给日志留。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputError {
    Empty,
    TooLong {
        limit: usize,
    },
    /// 路径形状不对（空段、`.`、`..`、段尾空格点、前导分隔符……）。
    NotRelative {
        why: &'static str,
    },
    ForbiddenChar {
        ch: char,
    },
    DeviceName {
        segment: String,
    },
    EscapesRoot {
        relative: String,
    },
    NotFound {
        path: PathBuf,
    },
    NotAFile {
        path: PathBuf,
    },
    NotADirectory {
        path: PathBuf,
    },
    Reparse {
        path: PathBuf,
    },
    LengthMismatch {
        expected: u64,
        actual: u64,
    },
    HashMismatch {
        expected: String,
        actual: String,
    },
    Io {
        path: PathBuf,
        detail: String,
    },
}

impl InputError {
    /// 对外的错误码。宿主就按这个码回报给前端，前端有一张闭集表要对上。
    pub fn code(&self) -> &'static str {
        INPUT_INVALID_CODE
    }

    /// 给人看的说明。这条串会进日志、也会进前端错误对象，所以全程中文、说清是哪一段。
    pub fn message(&self) -> String {
        match self {
            Self::Empty => "授权的输入路径是空的".to_string(),
            Self::TooLong { limit } => format!("输入路径太长了：上限 {limit} 字节"),
            Self::NotRelative { why } => format!("输入路径不是可用的相对路径：{why}"),
            Self::ForbiddenChar { ch } => format!("输入路径里有不允许的字符 {ch:?}"),
            Self::DeviceName { segment } => {
                format!("输入路径里的 {segment} 是 Windows 设备名，不是普通文件")
            }
            Self::EscapesRoot { relative } => {
                format!("输入路径解析后跑出了授权根：{relative}")
            }
            Self::NotFound { path } => format!("授权根里没有这份输入：{}", path.display()),
            Self::NotAFile { path } => format!("授权输入不是普通文件：{}", path.display()),
            Self::NotADirectory { path } => {
                format!("授权输入路径中间那一段不是目录：{}", path.display())
            }
            Self::Reparse { path } => format!(
                "授权输入经过重解析点（符号链接或 junction）：{}",
                path.display()
            ),
            Self::LengthMismatch { expected, actual } => {
                format!("输入长度与声明不符：声明 {expected} 字节，实际 {actual} 字节")
            }
            Self::HashMismatch { expected, actual } => format!(
                "输入内容与声明不符：声明 {expected}，实际 {actual}"
            ),
            Self::Io { path, detail } => {
                format!("读授权输入出错（{}）：{detail}", path.display())
            }
        }
    }
}

/// 把一份授权输入解析成可以打开的真实路径。
///
/// 返回的是 `canonicalize` 之后的路（已经不含重解析点），调用方应当用它去读。
pub fn resolve_granted(root: &Path, relative: &str) -> Result<PathBuf, InputError> {
    let segments = split_relative(relative)?;
    let root = fs::canonicalize(root).map_err(|error| InputError::Io {
        path: root.to_path_buf(),
        detail: format!("授权根不可用：{error}"),
    })?;

    let mut current = root.clone();
    let last = segments.len() - 1;
    for (index, segment) in segments.iter().enumerate() {
        current.push(segment);
        let meta = fs::symlink_metadata(&current).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                InputError::NotFound {
                    path: current.clone(),
                }
            } else {
                InputError::Io {
                    path: current.clone(),
                    detail: error.to_string(),
                }
            }
        })?;
        if is_reparse_point(&meta) {
            return Err(InputError::Reparse { path: current });
        }
        if index == last {
            if !meta.is_file() {
                return Err(InputError::NotAFile { path: current });
            }
        } else if !meta.is_dir() {
            return Err(InputError::NotADirectory { path: current });
        }
    }

    // 逐段查过重解析点了，这一条是兜底：真出问题说明上面漏了，宁可不给算。
    let real = fs::canonicalize(&current).map_err(|error| InputError::Io {
        path: current.clone(),
        detail: error.to_string(),
    })?;
    if !real.starts_with(&root) {
        return Err(InputError::EscapesRoot {
            relative: relative.to_string(),
        });
    }
    Ok(real)
}

/// 一份文件的**内容指纹**：字节数 + blake3。
///
/// 两样都要：只看长度认不出长度相同的另一份文件；只看 hash 又得把整份读完才知道长度
/// 对不上，而长度先比一次便宜得多（能挡住绝大多数张冠李戴）。
///
/// 它也是「这份模型测过没有」那个记账表（[`crate::probe`]）的键来源——进键的必须是
/// 内容而不是路径或修改时间，理由见那个模块的头注释。
pub fn file_fingerprint(path: &Path) -> Result<(u64, String), InputError> {
    let mut file = fs::File::open(path).map_err(|error| InputError::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })?;
    let byte_length = file
        .metadata()
        .map_err(|error| InputError::Io {
            path: path.to_path_buf(),
            detail: error.to_string(),
        })?
        .len();

    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0u8; READ_CHUNK_BYTES];
    loop {
        let read = file.read(&mut buffer).map_err(|error| InputError::Io {
            path: path.to_path_buf(),
            detail: error.to_string(),
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok((byte_length, hasher.finalize().to_hex().to_string()))
}

/// 按宿主的声明复核一份输入：长度先比（便宜，能挡住绝大多数张冠李戴），
/// 再分块算 blake3 与声明的 hash 比。
///
/// 长度/hash 都由宿主在 pin 住那份文件的那一刻记录（§7.1），所以这里的比对
/// 是「worker 独立确认它读到的就是宿主说的那一份」，不是重复劳动。
///
/// 与 [`file_fingerprint`] 共用同一把尺子：两处各写一遍的话，「探针认的这份」与
/// 「干活时认的这份」迟早会岔开。
pub fn verify_file(path: &Path, expected_hash: &str, expected_length: u64) -> Result<(), InputError> {
    let (actual_length, actual_hash) = file_fingerprint(path)?;
    if actual_length != expected_length {
        return Err(InputError::LengthMismatch {
            expected: expected_length,
            actual: actual_length,
        });
    }
    let expected = expected_hash.to_ascii_lowercase();
    if actual_hash != expected {
        return Err(InputError::HashMismatch {
            expected,
            actual: actual_hash,
        });
    }
    Ok(())
}

/// 把相对路径切成若干段，顺便把「名字层面」的坑全挡掉。
fn split_relative(relative: &str) -> Result<Vec<&str>, InputError> {
    if relative.is_empty() {
        return Err(InputError::Empty);
    }
    if relative.len() > MAX_RELATIVE_PATH_BYTES {
        return Err(InputError::TooLong {
            limit: MAX_RELATIVE_PATH_BYTES,
        });
    }
    for ch in relative.chars() {
        // `:` 既可能是盘符也可能是同文件上的备用数据流；两者都不该出现。
        if ch == '\0' || ch.is_control() || ch == ':' || matches!(ch, '?' | '*' | '"' | '<' | '>' | '|')
        {
            return Err(InputError::ForbiddenChar { ch });
        }
    }

    let mut segments = Vec::new();
    for segment in relative.split(['/', '\\']) {
        if segment.is_empty() {
            return Err(InputError::NotRelative {
                why: "有多余的分隔符（空路径段或前导分隔符）",
            });
        }
        if segment == "." || segment == ".." {
            return Err(InputError::NotRelative {
                why: "路径段不许是 . 或 ..",
            });
        }
        if segment.len() > MAX_SEGMENT_BYTES {
            return Err(InputError::TooLong {
                limit: MAX_SEGMENT_BYTES,
            });
        }
        if segment.ends_with([' ', '.']) {
            return Err(InputError::NotRelative {
                why: "路径段的末尾不许是空格或点（Windows 会把它去掉）",
            });
        }
        if is_device_name(segment) {
            return Err(InputError::DeviceName {
                segment: segment.to_string(),
            });
        }
        segments.push(segment);
    }
    Ok(segments)
}

/// Windows 的 DOS 设备名（`CON`、`NUL`、`COM1`……）在任何目录下都会打开设备
/// 而不是文件，且扩展名不影响判定（`NUL.txt` 仍是 NUL）。要显式拒掉。
fn is_device_name(segment: &str) -> bool {
    let stem = segment.split_once('.').map_or(segment, |(stem, _)| stem);
    let upper = stem.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    if upper.len() == 4 {
        let bytes = upper.as_bytes();
        let numbered = matches!(bytes[3], b'1'..=b'9');
        if numbered && (upper.starts_with("COM") || upper.starts_with("LPT")) {
            return true;
        }
    }
    false
}

/// 符号链接、junction、挂载点都带这个属性。只看 `is_symlink()` 会漏掉 junction，
/// 而 junction 恰好是不需要特权就能造出来的那一种。
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        return meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

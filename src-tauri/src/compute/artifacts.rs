//! 产物交接：从 worker 的 staging 到正式缓存之间那道闸门（docs/71 §11 Task 5）。
//!
//! 这一层只做四件事，每件都能单独测：
//!
//! 1. 判一条**相对路径**能不能用（越界、UNC、驱动器前缀、ADS、设备名、尾点尾空格、控制字符）
//! 2. 解析到数据根之下，并拒绝路上任何一个 reparse point（symlink / junction）
//! 3. **流式**核长度与 blake3——不把整份产物读进内存
//! 4. 内容寻址发布：先写临时文件再 rename，正式缓存里永不出现半文件
//!
//! 为什么内容寻址：缓存条目的路径由内容决定，同一个字节序列永远落同一个文件。
//! 于是「这一页的产物盖掉了那一页的产物」在结构上不可能发生，evict/clear 也只需要按
//! 引用计数删文件。代价是每次发布多算一次 hash——那份 hash 本来就要算（宿主必须自己
//! 核 worker 的声明，不能听 worker 说自己写对了），所以等于没多花。
//!
//! 这一层**不碰数据库、不碰 Tauri**：调用方拿这里的 `PublishedBlob` 再去开短事务。

use std::fmt;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use yomika_compute_protocol::SCRATCH_DIR_NAME;

/// 单份产物上限。与 `MAX_OUTPUT_BYTES`（协议里的预算）同值：协议那边是「你不该申请更多」，
/// 这边是「你就送到这儿为止」。
pub const MAX_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// blake3 十六进制摘要的长度。
pub const HASH_HEX_BYTES: usize = 64;

/// 内容寻址的根前缀（相对数据根）。与既有图片缓存同一套布局：
/// 一份字节序列在磁盘上只有一份，谁引用它由数据库记。
pub const BLOB_PREFIX: &str = "cache/images";

/// 读文件算 hash 的缓冲。64 KiB 是 Windows 上顺序读的甜点，且小到不会成为内存事件。
const READ_BUFFER_BYTES: usize = 64 * 1024;

/// 相对路径的长度上限。真实布局最深是 `cache/images/<2>/<64>.bin`（约 90 字节），
/// 给足余量但仍要有个上限——路径不该是攻击面也无法是。
const MAX_RELATIVE_BYTES: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactError {
    /// 这条相对路径不能用。`why` 是给日志看的一句话，不是给用户看的。
    UnsafeRelative { relative: String, why: &'static str },
    /// 数据根本身不合格（不是绝对路径）。
    UnsafeRoot { root: String, why: &'static str },
    /// 摘要不是 64 位十六进制。
    InvalidHash { hash: String },
    NotFound { path: String },
    NotAFile { path: String },
    TooLarge { bytes: u64, limit: u64 },
    LengthMismatch { expected: u64, actual: u64 },
    HashMismatch { expected: String, actual: String },
    /// 发布申请的那一代已经过去了（取消之后迟到、缓存被清过、worker 换了代）。
    StaleEpoch { publish: u64, current: u64 },
    Io { path: String, detail: String },
}

impl fmt::Display for ArtifactError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsafeRelative { relative, why } => {
                write!(f, "产物相对路径不可用（{why}）：{relative}")
            }
            Self::UnsafeRoot { root, why } => write!(f, "数据根不可用（{why}）：{root}"),
            Self::InvalidHash { hash } => write!(f, "摘要不是 64 位十六进制：{hash}"),
            Self::NotFound { path } => write!(f, "找不到产物：{path}"),
            Self::NotAFile { path } => write!(f, "产物不是普通文件：{path}"),
            Self::TooLarge { bytes, limit } => {
                write!(f, "产物 {bytes} 字节，超过上限 {limit}")
            }
            Self::LengthMismatch { expected, actual } => {
                write!(f, "产物长度不符：期望 {expected}，实际 {actual}")
            }
            Self::HashMismatch { expected, actual } => {
                write!(f, "产物内容不符：声明 {expected}，实际 {actual}")
            }
            Self::StaleEpoch { publish, current } => write!(
                f,
                "这一代（{publish}）已经过期，现在是 {current} 代，产物不再接受"
            ),
            Self::Io { path, detail } => write!(f, "文件操作失败（{path}）：{detail}"),
        }
    }
}

impl std::error::Error for ArtifactError {}

/// 已发布的产物：调用方拿它去落数据库条目（短事务）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedBlob {
    /// 相对数据根的路径，直接可以进 `cache_entries.path`。
    pub relative: String,
    pub path: PathBuf,
    pub byte_length: u64,
    pub content_hash: String,
}

/// 缓存修订号的组成（§11 Task 5 第 6 条）。
///
/// 少了任何一项都可能**误命中**：换了模型却拿到旧模型的结果、换了后端却拿到另一个
/// 后端的图、换了精度（fp16/fp32）却拿到另一个精度的图。这里的字段是「结果由什么产生」
/// 的最小集合。
#[derive(Debug, Clone, Copy)]
pub struct CacheRevisionParts<'a> {
    pub model_spec_id: &'a str,
    /// 源文件修订（文件变了，旧结果必须作废）。
    pub source_revision: &'a str,
    pub backend: &'a str,
    /// 运行库标识与版本（ORT/NGX/NCNN 的哪个版本算出来的）。
    pub runtime_id: &'a str,
    pub precision: &'a str,
    /// 流水线定义本身（阶段顺序、参数）。
    pub pipeline_revision: &'a str,
}

/// 这条相对路径能不能用。
///
/// 拒绝的东西都能在 Windows 上把「数据根之下的一个文件名」变成别的东西：
/// `..` 与绝对路径直接越界；`\` 让路径离开 `/` 分隔的语义；`:` 是 ADS
/// （`x.bin:evil` 会写进一个影子流）；设备名（`CON`、`NUL`、`COM1`…）会被
/// 内核当成设备而不是文件；结尾的点和空格会被 Win32 悄悄剪掉，于是「写进去的名字」
/// 与「读出来的名字」不是同一个。
pub fn is_safe_relative(relative: &str) -> bool {
    if relative.is_empty() || relative.len() > MAX_RELATIVE_BYTES {
        return false;
    }
    // `\` 让路径离开 `/` 分隔的语义（Windows 上两者等价，于是 "a\..\b" 变成一次爬升）；
    // `:` 是 ADS 与驱动器前缀共用的字符，两者都该拒。
    if relative.contains(['\\', ':']) || relative.chars().any(|c| c.is_control()) {
        return false;
    }
    if relative.starts_with('/') {
        return false;
    }
    let mut parts = relative.split('/');
    // 固定前缀把「产物缓存」限定在数据根下自己那一块，别处（设置、密钥、数据库）
    // 不因为一条产物路径而被写。
    if parts.next() != Some("cache") {
        return false;
    }
    parts.all(|part| {
        !part.is_empty()
            && part != "."
            && part != ".."
            // Win32 会把结尾的点和空格剪掉：写进去的名字与读出来的名字就不是同一个
            && !part.ends_with(['.', ' '])
            && !is_device_name(part)
    })
}

/// 是不是 Windows 保留设备名。
///
/// 内核把 `CON`/`NUL`/`COM1` 当设备而不是文件：`create` 它可能成功，写进去的字节
/// 却去了控制台或虚空。带扩展名一样算（`con.txt` 仍然是 `CON`），比较也不分大小写。
fn is_device_name(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or(part);
    let upper = stem.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let bytes = upper.as_bytes();
    bytes.len() == 4
        && (upper.starts_with("COM") || upper.starts_with("LPT"))
        && bytes[3].is_ascii_digit()
        && bytes[3] != b'0'
}

/// 内容寻址的相对路径：`cache/images/<前两位>/<完整摘要>.bin`。
pub fn artifact_relative(content_hash: &str) -> Result<String, ArtifactError> {
    let valid = content_hash.len() == HASH_HEX_BYTES
        && content_hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !valid {
        return Err(ArtifactError::InvalidHash {
            hash: content_hash.to_string(),
        });
    }
    Ok(format!(
        "{BLOB_PREFIX}/{}/{content_hash}.bin",
        &content_hash[..2]
    ))
}

/// 把一条相对路径解析到数据根之下，并拒绝路上任何一个 reparse point。
///
/// 只判字符串不够：`cache/images/ab/x.bin` 每个分量都合法，但如果 `cache/images` 是一个
/// junction，实际写入的就在别处了。所以每个**已经存在**的分量都要看它的属性。
pub fn resolve_under(root: &Path, relative: &str) -> Result<PathBuf, ArtifactError> {
    let unsafe_relative = |why: &'static str| ArtifactError::UnsafeRelative {
        relative: relative.to_string(),
        why,
    };
    if !is_safe_relative(relative) {
        return Err(unsafe_relative("不是数据根之下的安全相对路径"));
    }
    // 相对根的话「之下」由进程当前目录决定，那就不是一个可以判定的边界了。
    if !root.is_absolute() {
        return Err(ArtifactError::UnsafeRoot {
            root: root.display().to_string(),
            why: "必须是绝对路径",
        });
    }

    let mut current = root.to_path_buf();
    for part in relative.split('/') {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if is_reparse_point(&metadata) {
                    return Err(unsafe_relative("路径经过了 reparse point（symlink/junction）"));
                }
            }
            // 还不存在是正常的：发布时才会把中间目录建出来
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(&current, error)),
        }
    }
    Ok(current)
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT：symlink、junction、mount point 都带这一位
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn io_error(path: &Path, error: io::Error) -> ArtifactError {
    let path = path.display().to_string();
    if error.kind() == io::ErrorKind::NotFound {
        ArtifactError::NotFound { path }
    } else {
        ArtifactError::Io {
            path,
            detail: error.to_string(),
        }
    }
}

fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
}

/// 流式算长度与 blake3。返回 `(字节数, 十六进制摘要)`。
pub fn hash_file(path: &Path) -> Result<(u64, String), ArtifactError> {
    let mut file = fs::File::open(path).map_err(|error| io_error(path, error))?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0u8; READ_BUFFER_BYTES];
    let mut total = 0u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| io_error(path, error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((total, hasher.finalize().to_hex().to_string()))
}

/// 核一份 worker 送来的 staging 产物：路径、普通文件、长度、内容。
///
/// 顺序是刻意的：先把便宜且能一眼看出的（路径、是不是普通文件、长度）判掉，最后才读
/// 整个文件算 hash。绝大多数伪造声明不必付一次全文件读。
pub fn verify_staged(
    root: &Path,
    relative: &str,
    expected_len: u64,
    expected_hash: &str,
) -> Result<PathBuf, ArtifactError> {
    let path = resolve_under(root, relative)?;
    verify_file(&path, expected_len, expected_hash)
}

/// worker 的 staging 产物名：**裸文件名**，不带任何目录。
///
/// 与 [`is_safe_relative`] 分开是因为这里是另一片地：worker 只被允许在 staging 根下写
/// 一个平铺的文件，所以连 `/` 都不该出现——出现就说明有人在拼路径。
pub fn is_safe_staged_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
        && !name.chars().any(|c| c.is_control())
}

/// 核一个 staging 里的裸文件名。
pub fn verify_staged_name(
    root: &Path,
    name: &str,
    expected_len: u64,
    expected_hash: &str,
) -> Result<PathBuf, ArtifactError> {
    let unsafe_name = |why: &'static str| ArtifactError::UnsafeRelative {
        relative: name.to_string(),
        why,
    };
    if !is_safe_staged_name(name) {
        return Err(unsafe_name("staging 产物名必须是裸文件名"));
    }
    if !root.is_absolute() {
        return Err(ArtifactError::UnsafeRoot {
            root: root.display().to_string(),
            why: "必须是绝对路径",
        });
    }
    verify_file(&root.join(name), expected_len, expected_hash)
}

/// 长度与内容的共同核验：staging 产物与已发布文件走同一段。
fn verify_file(
    path: &Path,
    expected_len: u64,
    expected_hash: &str,
) -> Result<PathBuf, ArtifactError> {
    // symlink_metadata：产物本身若是链接，我们核的就是链接指向的东西，那就等于没核
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(path, error))?;
    if !metadata.is_file() {
        return Err(ArtifactError::NotAFile {
            path: path.display().to_string(),
        });
    }
    if metadata.len() > MAX_ARTIFACT_BYTES {
        return Err(ArtifactError::TooLarge {
            bytes: metadata.len(),
            limit: MAX_ARTIFACT_BYTES,
        });
    }
    if metadata.len() != expected_len {
        return Err(ArtifactError::LengthMismatch {
            expected: expected_len,
            actual: metadata.len(),
        });
    }

    let (actual_len, actual_hash) = hash_file(path)?;
    // 长度在 metadata 与读之间可能被改过（worker 还在写同一个文件），所以以读到的为准
    if actual_len != expected_len {
        return Err(ArtifactError::LengthMismatch {
            expected: expected_len,
            actual: actual_len,
        });
    }
    if !actual_hash.eq_ignore_ascii_case(expected_hash) {
        return Err(ArtifactError::HashMismatch {
            expected: expected_hash.to_string(),
            actual: actual_hash,
        });
    }
    Ok(path.to_path_buf())
}

/// 把一份已经核过的内容发布进内容寻址存储。
///
/// `expected_hash` 是**宿主自己**认可的摘要（来自它核过的 staging 文件），不是 worker 说的。
/// 目标已存在且长度一致就不再写——内容寻址路径的名字就是摘要，同名的字节序列必然相同。
pub fn publish_blob(
    root: &Path,
    source: &Path,
    expected_hash: &str,
) -> Result<PublishedBlob, ArtifactError> {
    let (byte_length, content_hash) = hash_file(source)?;
    if byte_length > MAX_ARTIFACT_BYTES {
        return Err(ArtifactError::TooLarge {
            bytes: byte_length,
            limit: MAX_ARTIFACT_BYTES,
        });
    }
    if !content_hash.eq_ignore_ascii_case(expected_hash) {
        // 声明与实际不符：一个字都不写进正式目录
        return Err(ArtifactError::HashMismatch {
            expected: expected_hash.to_string(),
            actual: content_hash,
        });
    }

    let relative = artifact_relative(&content_hash)?;
    let target = resolve_under(root, &relative)?;
    let parent = target.parent().ok_or(ArtifactError::UnsafeRelative {
        relative: relative.clone(),
        why: "内容寻址路径没有父目录",
    })?;

    // 建目录之前先核一遍：`create_dir_all` 会跟着 junction 走
    let parent_relative = format!("{BLOB_PREFIX}/{}", &content_hash[..2]);
    resolve_under(root, &parent_relative)?;
    fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    // 建完再解析一次，拿到最终路径（也顺带再看一眼新目录不是链接）
    let target = resolve_under(root, &relative)?;

    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.is_file() && metadata.len() == byte_length {
            return Ok(PublishedBlob {
                relative,
                path: target,
                byte_length,
                content_hash,
            });
        }
    }

    // 临时文件必须与目标同目录：rename 才是同卷的原子替换
    let temp = parent.join(format!(
        ".{}.part-{}-{}",
        &content_hash[..16],
        std::process::id(),
        nanos()
    ));
    let copied = (|| -> Result<(), ArtifactError> {
        let mut input = fs::File::open(source).map_err(|error| io_error(source, error))?;
        let mut output = fs::File::create(&temp).map_err(|error| io_error(&temp, error))?;
        io::copy(&mut input, &mut output).map_err(|error| io_error(&temp, error))?;
        output.flush().map_err(|error| io_error(&temp, error))?;
        Ok(())
    })();
    if let Err(error) = copied {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }

    if let Err(error) = fs::rename(&temp, &target) {
        let _ = fs::remove_file(&temp);
        // 可能是另一路刚刚发布了同一份内容——那正是我们想要的结果
        match fs::metadata(&target) {
            Ok(metadata) if metadata.is_file() && metadata.len() == byte_length => {}
            _ => return Err(io_error(&target, error)),
        }
    }

    Ok(PublishedBlob {
        relative,
        path: target,
        byte_length,
        content_hash,
    })
}

/// 这一代还允许发布吗。
///
/// 取消之后迟到的产物、缓存被清过之后旧任务想回写、worker 换代之后上一代的产物——
/// 都靠这个判。**不靠时间戳猜**：代是宿主自己维护的整数，谁清谁加一。
pub fn publish_allowed(publish_epoch: u64, current_epoch: u64) -> Result<(), ArtifactError> {
    if publish_epoch == current_epoch {
        Ok(())
    } else {
        Err(ArtifactError::StaleEpoch {
            publish: publish_epoch,
            current: current_epoch,
        })
    }
}

/// 把「结果由什么产生」折成一个修订号。
pub fn cache_revision(parts: &CacheRevisionParts<'_>) -> String {
    let mut hasher = blake3::Hasher::new();
    for field in [
        parts.model_spec_id,
        parts.source_revision,
        parts.backend,
        parts.runtime_id,
        parts.precision,
        parts.pipeline_revision,
    ] {
        // 带长度前缀：不然 ("ab","c") 与 ("a","bc") 会折成同一个串，换模型却不换修订号
        hasher.update(&(field.len() as u32).to_le_bytes());
        hasher.update(field.as_bytes());
    }
    format!("rev:v1:{}", hasher.finalize().to_hex())
}

/// 一次 staging 清扫的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StagingSweep {
    pub removed_files: usize,
    pub bytes_freed: u64,
}

/// 清掉 staging 里上一代留下的半成品（§11 Task 5 第 5 条）。
///
/// staging 与正式缓存的分工是「worker 只能在这儿写，正式目录只有宿主核过才进」，
/// 所以这里没有 DB 可查引用——**整棵目录里的东西都是可疑的**，只有正在飞的那一件
/// 例外。调用点在 worker 握手成功那一刻与会话收摊之后：此时还没有任何 job 被派发
/// （有 job 就有正在飞的产物）或 worker 已经不在了，这是唯一「确定没有写者」的两个
/// 时刻，所以宽限期在生产路径上传 `ZERO`；参数留着是为了让「不确定」的调用点能传
/// 一个更保守的值。
///
/// 收两样东西：
///
/// ① 顶层的普通文件，名字必须过 [`is_safe_staged_name`]：worker 只被允许在 staging
///    根下平铺写一个产物，出现怪名字说明不是我们写的东西，宁可不碰；
/// ② worker 自己那棵暂存子树 [`SCRATCH_DIR_NAME`]——里面放的是 NGX 片段这类跨阶段
///    复用的东西（`worker/src/dlssnr.rs` 拿它当数据目录）。**只按名字认这一棵**：
///    别的子目录是谁的我们不知道，一根手指都不碰。
///
/// 两样都不是 reparse point 才算数：symlink / junction 的名字可以长得跟我们的一样，
/// 指向哪儿我们不知道，跟着走一次就可能是在删别人的文件（判据与 [`resolve_under`] 同源）。
///
/// 子树的宽限期与顶层同一条：生产路径传 `ZERO`（那两个调用点都是「确定没有写者」的
/// 时刻），保守的调用点连这棵子树也一起保守。收不干净（里面有链接、有陌生形状）就整个
/// 留着，下次再试。
pub fn sweep_staging(root: &Path, temp_grace: Duration) -> Result<StagingSweep, ArtifactError> {
    if !root.is_absolute() {
        return Err(ArtifactError::UnsafeRoot {
            root: root.display().to_string(),
            why: "staging 根必须是绝对路径",
        });
    }
    let mut sweep = StagingSweep {
        removed_files: 0,
        bytes_freed: 0,
    };
    let Ok(entries) = fs::read_dir(root) else {
        // 目录还没建：没有东西可扫，不是错误（`main` 会自己建它）。
        return Ok(sweep);
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        let kind = metadata.file_type();
        // reparse point（symlink / junction / mount point）一概不碰：名字可以长得像我们的，
        // 指向哪儿我们不知道，跟进一次就可能是在删别人的文件（`is_reparse_point` 与
        // `resolve_under` 用的是同一条判据）。
        if is_reparse_point(&metadata) {
            continue;
        }
        if kind.is_dir() && name == SCRATCH_DIR_NAME {
            if !sweep_scratch_dir(&path, &mut sweep, now, temp_grace, 0) {
                // 壳空了就一起删掉：留一个空目录会让下一次「这儿有没有东西」的判断
                // 失真（看似有、实际是空的）。删不掉就算了，下次再试。
                let _ = fs::remove_dir(&path);
            }
            continue;
        }
        if !kind.is_file() || !is_safe_staged_name(name) {
            continue;
        }
        if is_old_enough(&metadata, now, temp_grace) && fs::remove_file(&path).is_ok() {
            sweep.removed_files += 1;
            sweep.bytes_freed = sweep.bytes_freed.saturating_add(metadata.len());
        }
    }
    Ok(sweep)
}

/// 这棵树里的文件够老了吗（顶层与子树用同一条判据）。
fn is_old_enough(metadata: &fs::Metadata, now: SystemTime, temp_grace: Duration) -> bool {
    metadata
        .modified()
        .ok()
        .and_then(|modified| now.duration_since(modified).ok())
        .is_some_and(|age| age >= temp_grace)
}

/// 暂存子树允许多深。
///
/// worker 在里面只铺一层（`dlssnr-ngx/dlssnr/<一份片段>`），留富余是免得将来加一层
/// 目录就把回收变成「只收一半」；有上限是因为这棵树是**按名字**认的，不能顺着链接或
/// 无限深的结构走——那会把一次收摊变成无界遍历。
const SCRATCH_MAX_DEPTH: usize = 4;

/// 递归收 `dir` 里的普通文件，返回「收完之后这棵树里还有东西吗」。
///
/// 只删普通文件：symlink / junction、陌生形状一律留着（宁可不碰，见 [`sweep_staging`]）。
/// 子目录收空了才删它自己，删不掉就留着；**绝不用 `remove_dir_all`**——它跟着链接删。
/// 宽限期对整棵树一样适用：生产路径传 `ZERO`，保守的调用点连这棵子树也一起保守。
fn sweep_scratch_dir(
    dir: &Path,
    sweep: &mut StagingSweep,
    now: SystemTime,
    temp_grace: Duration,
    depth: usize,
) -> bool {
    if depth > SCRATCH_MAX_DEPTH {
        return true;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        // 读不动的目录当作「还有东西」：这次不删它，也不当成收干净了。
        return true;
    };
    let mut left_behind = false;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            left_behind = true;
            continue;
        };
        let kind = metadata.file_type();
        if is_reparse_point(&metadata) {
            // 链接指向哪儿我们不知道，既不跟过去也不删它（删了可能是在删别人的入口）。
            left_behind = true;
            continue;
        }
        if kind.is_dir() {
            if sweep_scratch_dir(&path, sweep, now, temp_grace, depth + 1)
                || fs::remove_dir(&path).is_err()
            {
                left_behind = true;
            }
            continue;
        }
        if kind.is_file() && is_old_enough(&metadata, now, temp_grace) {
            if fs::remove_file(&path).is_ok() {
                sweep.removed_files += 1;
                sweep.bytes_freed = sweep.bytes_freed.saturating_add(metadata.len());
            } else {
                left_behind = true;
            }
            continue;
        }
        left_behind = true;
    }
    left_behind
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn stamp() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("时钟在 1970 之后")
            .as_nanos()
    }

    /// 一次测试一个临时目录；`Drop` 里删掉。
    struct Sandbox {
        root: PathBuf,
    }

    impl Sandbox {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "yomika-artifacts-{name}-{}-{}",
                std::process::id(),
                stamp()
            ));
            fs::create_dir_all(&root).expect("建沙箱");
            Self { root }
        }

        fn root(&self) -> &Path {
            &self.root
        }

        /// 按一条相对路径落一份文件（中间目录自动建）。
        fn write(&self, relative: &str, bytes: &[u8]) -> PathBuf {
            let path = self.root.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("建中间目录");
            }
            fs::write(&path, bytes).expect("写文件");
            path
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn blake3_hex(bytes: &[u8]) -> String {
        blake3::hash(bytes).to_hex().to_string()
    }

    /// ①路径越界
    #[test]
    fn a_relative_path_that_climbs_out_is_refused() {
        for bad in [
            "",
            ".",
            "..",
            "cache/../x.bin",
            "cache/images/../../x.bin",
            "cache//x.bin",
            "cache/images/./x.bin",
            "/cache/x.bin",
            "../cache/x.bin",
            "other/x.bin",
        ] {
            assert!(!is_safe_relative(bad), "这条不该被接受：{bad:?}");
        }
        for good in [
            "cache/images/ab/x.bin",
            "cache/artifacts/job-1/stage-a.bin",
            &format!("cache/images/{}/{}.bin", "ab", "a".repeat(64)),
        ] {
            assert!(is_safe_relative(good), "这条该被接受：{good:?}");
        }
        // 太长也不行：路径不该是攻击面，也不该是无限长
        assert!(!is_safe_relative(&format!("cache/{}", "x".repeat(600))));
    }

    /// ①UNC 与驱动器前缀
    #[test]
    fn an_unc_path_or_a_drive_letter_is_refused() {
        for bad in [
            "\\\\server\\share\\x.bin",
            "C:\\cache\\x.bin",
            "C:cache/x.bin",
            "//server/share/x.bin",
            "cache\\x.bin",
            "cache/images/ab/x.bin\\..\\..\\evil",
        ] {
            assert!(!is_safe_relative(bad), "这条不该被接受：{bad:?}");
        }
    }

    /// ①ADS：`x.bin:evil` 会写进一个影子流，大小与内容都不受 `x.bin` 的约束
    #[test]
    fn an_alternate_data_stream_is_refused() {
        for bad in [
            "cache/images/ab/x.bin:evil",
            "cache/images/ab/:evil",
            "cache/images/ab/x.bin::$DATA",
        ] {
            assert!(!is_safe_relative(bad), "这条不该被接受：{bad:?}");
        }
    }

    /// ①设备名：内核会把 `CON`/`NUL`/`COM1` 当设备而不是文件
    #[test]
    fn a_reserved_device_name_is_refused() {
        for bad in [
            "cache/images/ab/CON",
            "cache/images/ab/con.txt",
            "cache/images/ab/NUL.bin",
            "cache/images/ab/COM1",
            "cache/images/ab/LPT9.bin",
            "cache/images/ab/AUX",
        ] {
            assert!(!is_safe_relative(bad), "这条不该被接受：{bad:?}");
        }
        // 只是以这些字母开头的不算
        assert!(is_safe_relative("cache/images/ab/CONSOLE.bin"));
        assert!(is_safe_relative("cache/images/ab/NULL.bin"));
    }

    /// ①尾点/尾空格会被 Win32 悄悄剪掉，于是「写进去的」与「读出来的」不是同一个名字
    #[test]
    fn a_trailing_dot_or_space_is_refused() {
        for bad in [
            "cache/images/ab/x.",
            "cache/images/ab/x ",
            "cache/images/ab/x.bin.",
            "cache/images/ab/sub. /x.bin",
        ] {
            assert!(!is_safe_relative(bad), "这条不该被接受：{bad:?}");
        }
    }

    /// ①reparse point：字符串全合法，但路上有个 junction，实际写的是别处
    #[cfg(windows)]
    #[test]
    fn a_reparse_point_on_the_way_is_refused() {
        let sandbox = Sandbox::new("reparse");
        let outside = std::env::temp_dir().join(format!(
            "yomika-artifacts-outside-{}-{}",
            std::process::id(),
            stamp()
        ));
        fs::create_dir_all(&outside).expect("建外部目录");
        let link = sandbox.root().join("cache");
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .status()
            .expect("跑 mklink");
        // junction 不需要管理员权限；建不起来的话这个测试就失去意义，必须响
        assert!(status.success(), "junction 没建起来，测试前提不成立");

        let error = resolve_under(sandbox.root(), "cache/images/ab/x.bin")
            .expect_err("路上有 junction，必须拒");
        assert!(
            matches!(error, ArtifactError::UnsafeRelative { .. }),
            "拒的理由该是路径不安全，实际 {error:?}"
        );

        // 先摘掉 junction 再删沙箱：否则删沙箱可能顺着它走进外部目录
        fs::remove_dir(&link).expect("摘掉 junction");
        let _ = fs::remove_dir_all(&outside);
    }

    /// ②数据根必须是绝对路径，否则「根」是谁说了算
    #[test]
    fn a_root_that_is_not_absolute_is_refused() {
        let error = resolve_under(Path::new("data"), "cache/images/ab/x.bin")
            .expect_err("相对根必须拒");
        assert!(
            matches!(error, ArtifactError::UnsafeRoot { .. }),
            "实际 {error:?}"
        );
        // 正常的绝对根要能解析
        let sandbox = Sandbox::new("resolve-ok");
        let resolved = resolve_under(sandbox.root(), "cache/images/ab/x.bin").expect("解析");
        assert!(resolved.starts_with(sandbox.root()));
    }

    /// ①假长度
    #[test]
    fn a_file_whose_length_is_a_lie_is_refused() {
        let sandbox = Sandbox::new("len-lie");
        let relative = "cache/images/ab/x.bin";
        sandbox.write(relative, b"hello");
        let hash = blake3_hex(b"hello");

        let error = verify_staged(sandbox.root(), relative, 6, &hash).expect_err("长度不符必须拒");
        assert!(
            matches!(
                error,
                ArtifactError::LengthMismatch {
                    expected: 6,
                    actual: 5
                }
            ),
            "实际 {error:?}"
        );
        assert_eq!(
            verify_staged(sandbox.root(), relative, 5, &hash).expect("对的长度该过"),
            sandbox.root().join(relative)
        );
    }

    /// ①假 hash
    #[test]
    fn a_file_whose_content_hash_is_a_lie_is_refused() {
        let sandbox = Sandbox::new("hash-lie");
        let relative = "cache/images/ab/x.bin";
        sandbox.write(relative, b"hello");

        let error = verify_staged(sandbox.root(), relative, 5, &blake3_hex(b"other"))
            .expect_err("内容不符必须拒");
        assert!(
            matches!(error, ArtifactError::HashMismatch { .. }),
            "实际 {error:?}"
        );

        // 不存在 / 不是普通文件 / 路径不安全，三种都要各自有话说
        let missing = verify_staged(sandbox.root(), "cache/images/ab/none.bin", 1, &blake3_hex(b"x"))
            .expect_err("不存在必须拒");
        assert!(matches!(missing, ArtifactError::NotFound { .. }), "实际 {missing:?}");

        fs::create_dir_all(sandbox.root().join("cache/images/cd/dir.bin")).expect("建目录");
        let not_file = verify_staged(sandbox.root(), "cache/images/cd/dir.bin", 1, &blake3_hex(b"x"))
            .expect_err("目录必须拒");
        assert!(matches!(not_file, ArtifactError::NotAFile { .. }), "实际 {not_file:?}");

        let unsafe_path = verify_staged(sandbox.root(), "../escape.bin", 1, &blake3_hex(b"x"))
            .expect_err("越界必须拒");
        assert!(
            matches!(unsafe_path, ArtifactError::UnsafeRelative { .. }),
            "实际 {unsafe_path:?}"
        );
    }

    /// staging 产物名必须是裸文件名：worker 只被允许往 staging 根下平铺写一个文件。
    #[test]
    fn a_staging_name_that_is_not_a_plain_file_name_is_refused() {
        let sandbox = Sandbox::new("staged-name");
        sandbox.write("stage-a.bin", b"hello");
        let hash = blake3_hex(b"hello");

        assert!(is_safe_staged_name("stage-a.bin"));
        for bad in [
            "",
            ".",
            "..",
            "sub/stage-a.bin",
            "sub\\stage-a.bin",
            "C:stage-a.bin",
            "bad\nname",
        ] {
            assert!(!is_safe_staged_name(bad), "这条不该被接受：{bad:?}");
        }
        assert!(!is_safe_staged_name(&"x".repeat(129)));

        assert_eq!(
            verify_staged_name(sandbox.root(), "stage-a.bin", 5, &hash).expect("核过"),
            sandbox.root().join("stage-a.bin")
        );
        let traversal = verify_staged_name(sandbox.root(), "../escape.bin", 5, &hash)
            .expect_err("穿越必须拒");
        assert!(
            matches!(traversal, ArtifactError::UnsafeRelative { .. }),
            "实际 {traversal:?}"
        );
    }

    /// 摘要必须正好是 64 位十六进制，否则内容寻址的名字就是假的
    #[test]
    fn a_hash_that_is_not_sixty_four_hex_digits_is_refused() {
        for bad in ["", "abc", "A".repeat(64).as_str(), &"g".repeat(64), &"a".repeat(65)] {
            let error = artifact_relative(bad).expect_err("这个摘要必须拒");
            assert!(matches!(error, ArtifactError::InvalidHash { .. }), "实际 {error:?}");
        }
        let hash = "a".repeat(64);
        let relative = artifact_relative(&hash).expect("合法摘要");
        assert_eq!(relative, format!("cache/images/aa/{hash}.bin"));
        assert!(is_safe_relative(&relative));
    }

    /// ③同一份内容只落一个文件；路径由内容决定
    #[test]
    fn publishing_twice_lands_on_one_content_addressed_file() {
        let sandbox = Sandbox::new("publish-twice");
        let first = sandbox.write("staging/a.bin", b"same bytes");
        let hash = blake3_hex(b"same bytes");

        let one = publish_blob(sandbox.root(), &first, &hash).expect("第一次发布");
        let second = sandbox.write("staging/b.bin", b"same bytes");
        let two = publish_blob(sandbox.root(), &second, &hash).expect("第二次发布");

        assert_eq!(one.path, two.path, "同内容必须落同一个路径");
        assert_eq!(one.relative, format!("cache/images/{}/{hash}.bin", &hash[..2]));
        assert_eq!(fs::read(&one.path).expect("读回来"), b"same bytes");
        assert_eq!(one.byte_length, 10);
        assert_eq!(one.content_hash, hash);
        let entries = fs::read_dir(one.path.parent().expect("父目录"))
            .expect("列目录")
            .count();
        assert_eq!(entries, 1, "同一个内容只该有一个文件，实际 {entries} 个");
    }

    /// ④正式缓存里不许出现半文件：上一轮掉电留下的短文件要被整份换掉
    #[test]
    fn a_half_written_blob_is_replaced_not_merged() {
        let sandbox = Sandbox::new("half-written");
        let source = sandbox.write("staging/a.bin", b"complete content");
        let hash = blake3_hex(b"complete content");
        let relative = artifact_relative(&hash).expect("路径");
        // 名字对、内容短的半文件，模拟掉电
        sandbox.write(&relative, b"half");

        let published = publish_blob(sandbox.root(), &source, &hash).expect("发布");
        assert_eq!(
            fs::read(&published.path).expect("读回来"),
            b"complete content"
        );
        let parent = published.path.parent().expect("父目录");
        let names: Vec<String> = fs::read_dir(parent)
            .expect("列目录")
            .map(|entry| entry.expect("条目").file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec![format!("{hash}.bin")], "临时文件不许留下：{names:?}");
    }

    /// ③发布只认宿主自己核过的内容：源文件与声明的摘要不符就不发
    #[test]
    fn a_blob_that_does_not_match_its_own_hash_is_not_published() {
        let sandbox = Sandbox::new("bad-source");
        let source = sandbox.write("staging/a.bin", b"liar");
        let error = publish_blob(sandbox.root(), &source, &blake3_hex(b"truth"))
            .expect_err("源与声明不符必须拒");
        assert!(matches!(error, ArtifactError::HashMismatch { .. }), "实际 {error:?}");
        assert!(
            !sandbox.root().join("cache").exists(),
            "拒了就不该在正式目录里留下任何东西"
        );
    }

    /// ⑤取消之后迟到、缓存被清过、worker 换代：都由世代判，不靠时间戳猜
    #[test]
    fn a_publish_from_a_dead_epoch_is_refused() {
        assert!(publish_allowed(7, 7).is_ok());
        let stale = publish_allowed(6, 7).expect_err("上一代必须拒");
        assert!(
            matches!(
                stale,
                ArtifactError::StaleEpoch {
                    publish: 6,
                    current: 7
                }
            ),
            "实际 {stale:?}"
        );
        assert!(publish_allowed(8, 7).is_err(), "未来的代同样不算数");
    }

    /// ⑥换了模型/后端/运行库/精度/流水线/源文件，修订号必须变
    #[test]
    fn the_cache_revision_changes_when_the_engine_changes() {
        let base = CacheRevisionParts {
            model_spec_id: "realcugan-2x-conservative",
            source_revision: "rev-1",
            backend: "gpu",
            runtime_id: "directml@17.67",
            precision: "fp32",
            pipeline_revision: "pipeline-v1",
        };
        let baseline = cache_revision(&base);
        assert_eq!(baseline, cache_revision(&base), "同样的输入必须同样的修订号");
        assert!(baseline.starts_with("rev:v1:"), "形状要对：{baseline}");

        let mut model = base;
        model.model_spec_id = "realcugan-2x-denoise3x";
        let mut source = base;
        source.source_revision = "rev-2";
        let mut backend = base;
        backend.backend = "cpu";
        let mut runtime = base;
        runtime.runtime_id = "directml@17.68";
        let mut precision = base;
        precision.precision = "fp16";
        let mut pipeline = base;
        pipeline.pipeline_revision = "pipeline-v2";

        for (name, other) in [
            ("模型", model),
            ("源文件", source),
            ("后端", backend),
            ("运行库", runtime),
            ("精度", precision),
            ("流水线", pipeline),
        ] {
            assert_ne!(
                baseline,
                cache_revision(&other),
                "换了{name}，修订号必须变"
            );
        }

        // 长度前缀：不然 ("ab","c") 与 ("a","bc") 会折成同一个串
        let left = CacheRevisionParts {
            model_spec_id: "ab",
            source_revision: "c",
            ..base
        };
        let right = CacheRevisionParts {
            model_spec_id: "a",
            source_revision: "bc",
            ..base
        };
        assert_ne!(cache_revision(&left), cache_revision(&right));
    }

    #[test]
    fn staging_is_swept_of_plain_files_only() {
        let sandbox = Sandbox::new("staging-sweep");
        let staged = sandbox.root.join("stage-a.bin");
        fs::write(&staged, b"half").expect("写文件");
        let nested = sandbox.root.join("sub");
        fs::create_dir_all(&nested).expect("建子目录");
        fs::write(nested.join("keep.bin"), b"nested").expect("写子目录里的文件");

        // 宽限期一小时：握手前刚写下的东西仍旧不动（保守的一侧）。
        let sweep = sweep_staging(&sandbox.root, Duration::from_secs(3600)).expect("清扫");
        assert_eq!(sweep.removed_files, 0);
        assert!(staged.is_file());

        let sweep = sweep_staging(&sandbox.root, Duration::ZERO).expect("清扫");
        assert_eq!(sweep.removed_files, 1);
        assert_eq!(sweep.bytes_freed, 4);
        assert!(!staged.exists());
        assert!(
            nested.join("keep.bin").is_file(),
            "只认自己那棵子树与顶层文件——这个子目录不是我们认得的名字，不该碰"
        );

        // 相对路径当根：这不是 staging，拒绝而不是「就地扫一扫」。
        assert!(matches!(
            sweep_staging(Path::new("staging"), Duration::ZERO),
            Err(ArtifactError::UnsafeRoot { .. })
        ));
    }

    /// worker 自己那棵暂存子树（NGX 的数据目录，里面躺着那份一百多 MB 的片段）**要收回去**。
    ///
    /// 与上一条是一对：上一条证明「不认识的名字一概不碰」，这一条证明「自己人那棵不许
    /// 留着」。只做前者，片段会永远攒在暂存目录里（按内容寻址不串味，但换一次多留一份）；
    /// 只做后者，会把别人的东西删掉。
    #[test]
    fn staging_sweep_takes_the_workers_own_scratch_tree_and_leaves_strangers_alone() {
        let sandbox = Sandbox::new("staging-scratch");
        let scratch = sandbox.root.join(SCRATCH_DIR_NAME);
        let dll = scratch.join("dlssnr").join("nvngx_dlssnr.dll");
        fs::create_dir_all(dll.parent().expect("片段目录")).expect("建片段目录");
        fs::write(&dll, vec![7_u8; 2048]).expect("写片段");
        let stranger = sandbox.root.join("someone-elses").join("keep.bin");
        fs::create_dir_all(stranger.parent().expect("陌生目录")).expect("建陌生目录");
        fs::write(&stranger, b"keep").expect("写陌生文件");
        let staged = sandbox.root.join("stage-a.bin");
        fs::write(&staged, b"half").expect("写顶层文件");

        // 宽限期一小时：什么都不动（保守的一侧）。
        let sweep = sweep_staging(&sandbox.root, Duration::from_secs(3600)).expect("清扫");
        assert_eq!(sweep.removed_files, 0);
        assert!(dll.is_file());

        let sweep = sweep_staging(&sandbox.root, Duration::ZERO).expect("清扫");
        assert_eq!(sweep.removed_files, 2, "顶层那件 + 片段那件");
        assert_eq!(sweep.bytes_freed, 4 + 2048);
        assert!(!dll.exists(), "片段不该留在暂存目录里");
        assert!(!scratch.exists(), "整棵子树该收回去，不留空壳");
        assert!(stranger.is_file(), "不认识的名字一概不碰");
        assert!(!staged.exists(), "顶层那件照旧要清");
    }

    /// 暂存子树里有一个 junction 时：不跟进去，也不删它（名字对不等于指向对）。
    ///
    /// `staging/dlssnr-ngx` 是**按名字**认下来的，而 Windows 上的 junction 长得就像普通
    /// 目录——只看 `is_dir()` 就会顺着它走进别人的目录里删东西。这条用的是与
    /// `resolve_under` 同一条判据（`FILE_ATTRIBUTE_REPARSE_POINT`）。
    #[cfg(windows)]
    #[test]
    fn a_junction_in_the_scratch_tree_is_not_walked_into() {
        let sandbox = Sandbox::new("staging-scratch-junction");
        let outside = std::env::temp_dir().join(format!(
            "yomika-artifacts-scratch-outside-{}-{}",
            std::process::id(),
            stamp()
        ));
        let kept = outside.join("keep.bin");
        fs::create_dir_all(&outside).expect("建外部目录");
        fs::write(&kept, b"not ours").expect("写外部文件");

        let scratch = sandbox.root.join(SCRATCH_DIR_NAME);
        fs::create_dir_all(scratch.join("dlssnr")).expect("建片段目录");
        let dll = scratch.join("dlssnr").join("nvngx_dlssnr.dll");
        fs::write(&dll, vec![7_u8; 2048]).expect("写片段");
        let link = scratch.join("elsewhere");
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .status()
            .expect("跑 mklink");
        assert!(status.success(), "junction 没建起来，测试前提不成立");

        let sweep = sweep_staging(&sandbox.root, Duration::ZERO).expect("清扫");
        assert_eq!(sweep.removed_files, 1, "只该收掉那份片段");
        assert!(!dll.exists());
        assert!(kept.is_file(), "junction 那一头不是我们的东西，一根手指都不碰");
        assert!(scratch.is_dir(), "收不干净就把壳留着，下次再试");

        // 先摘掉 junction 再删沙箱：否则删沙箱可能顺着它走进外部目录
        fs::remove_dir(&link).expect("摘掉 junction");
        let _ = fs::remove_dir_all(&outside);
    }
}

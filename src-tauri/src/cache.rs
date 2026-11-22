//! 统一的图片缓存：一份字节、多个身份（rendition）。
//!
//! 每个身份 = (scope, archive, page, rendition, model, 资源修订号)，所以同一页可以同时
//! 有原图、超分、DLSSNR 三份产物而不互相覆盖。`IMAGE_KIND_SQL` 与 `IMAGE_RENDITIONS`
//! 必须永远相等（有契约条款钉着）：漏一个身份，「清空缓存」就删不掉那一类产物——2026-10-13
//! 的 `dlssnr` 漏项就是这么攒下 2.97 GiB 的。配额与淘汰在这里；租借（lease）只保护
//! 路径不被删，它不拥有字节（见 `compute/leases.rs`）。

use crate::{db::Database, domain::result::CommandResult};
use rusqlite::OptionalExtension;

/// `enhanced` is the upscaler output and `dlssnr` the neural filter's, both keyed by
/// what produced them in the identity revision so a model or DLL change cannot serve
/// a stale image.
const IMAGE_RENDITIONS: [&str; 5] = [
    "cover",
    "page-thumbnail",
    "reader-page",
    "enhanced",
    "dlssnr",
];

/// 几条 SQL 都要枚举「缓存里那些图片版本」。原先这些名字在每一处各写一遍，`dlssnr`
/// 加进来时就漏了五处——真机上 2.84 GiB 的 DLSSNR 产物因此既清不掉（「清空缓存」对
/// 它们一个文件都不删）、也统计不到（算进 `other`）、按档案作废还放过它们，直到把
/// 4 GiB 的配额吃到 90% 让 LRU 去挤别人的封面。拼成一份，谁要枚举就引用它。
const IMAGE_KIND_SQL: &str =
    "'cover','page-thumbnail','reader-page','enhanced','dlssnr'";

/// 一次阅读会话里才有的「成品」：超分与 DLSSNR 的产物。
///
/// 它们只在会话内有意义，而一份动图产物可以大到一百多兆——真机上 2.84 GiB 的 DLSSNR
/// 产物是这么攒起来的。所以进出阅读器各清一次（[`purge_reader_renditions`]），别指望
/// 配额与 LRU 兜底：那是「满了才动手」，而这里要的是「离开就动手」。
pub const READER_SESSION_RENDITIONS: [&str; 2] = ["enhanced", "dlssnr"];
const DEFAULT_CACHE_QUOTA_BYTES: u64 = 2 * 1_073_741_824;
const CACHE_EVICTION_TRIGGER_PERCENT: u64 = 90;
const CACHE_EVICTION_TARGET_PERCENT: u64 = 75;

/// 数据库锁拿不到时对外的说法。取不到锁是「这一下没拿到」，重试有意义。
///
/// 公开给调用点：它要靠这个字符串把「这一下没抢到锁」与「磁盘/权限真的不行」分开，
/// 前者重试有意义、后者没有。
pub const LOCK_FAILED: &str = "数据库正被占用";

/// 缓存代：**这一条缓存根**被清空过几次。
///
/// 它管住的是「清空」与「正在写的那些任务」之间的竞速。写缓存分成两步——先在锁外
/// 把文件落盘（这一步可能很长），再在锁内写一行——如果这中间用户点了清空，那一步
/// 落盘的产物就属于**上一代**：它不该再把自己的行塞回来，否则用户看到的「已清空」
/// 会被一件早就开始的任务悄悄推翻。条目是内容寻址的，所以晚到的产物**不删**（同一
/// 份内容可能还有别的行在引用它），只是不再挂新行；没有行引用的文件由孤儿清扫收走。
/// 代是**按缓存根**记的，不是整个进程一个数：真机上只有一条缓存根，两者等价；而测试里
/// 每个用例各开一条临时根，共用一个数会让「A 清空缓存」把 B 手里正要挂行的产物判成上一代
/// （见 `clearing_one_cache_root_does_not_drop_a_write_in_flight_on_another`）。
static CACHE_EPOCHS: std::sync::Mutex<Vec<(std::path::PathBuf, u64)>> =
    std::sync::Mutex::new(Vec::new());

fn with_epochs<T>(work: impl FnOnce(&mut Vec<(std::path::PathBuf, u64)>) -> T) -> T {
    let mut epochs = CACHE_EPOCHS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    work(&mut epochs)
}

/// 当前缓存代。读它不需要锁：它只用来做「我动手前是这一代吗」的比较。
pub fn cache_epoch(app_data: &std::path::Path) -> u64 {
    with_epochs(|epochs| {
        epochs
            .iter()
            .find(|(root, _)| root == app_data)
            .map(|(_, epoch)| *epoch)
            .unwrap_or(0)
    })
}

/// 作废这一代（清空缓存时调用），返回新的代。
fn bump_cache_epoch(app_data: &std::path::Path) -> u64 {
    with_epochs(|epochs| {
        if let Some((_, epoch)) = epochs.iter_mut().find(|(root, _)| root == app_data) {
            *epoch += 1;
            return *epoch;
        }
        epochs.push((app_data.to_path_buf(), 1));
        1
    })
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheImageIdentity {
    pub scope_id: String,
    pub archive_id: String,
    pub rendition: String,
    pub page_index: i64,
    pub revision: Option<String>,
    pub transform: Option<String>,
}

impl CacheImageIdentity {
    pub fn new(scope_id: &str, archive_id: &str, rendition: &str, page_index: i64) -> Self {
        Self {
            scope_id: scope_id.into(),
            archive_id: archive_id.into(),
            rendition: rendition.into(),
            page_index,
            revision: None,
            transform: None,
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.scope_id.trim().is_empty()
            || self.archive_id.trim().is_empty()
            || self.page_index < 0
            || !IMAGE_RENDITIONS.contains(&self.rendition.as_str())
            || self
                .revision
                .as_ref()
                .is_some_and(|value| value.len() > 256)
            || self
                .transform
                .as_ref()
                .is_some_and(|value| value.len() > 256)
        {
            return Err("Invalid image cache identity".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedImage {
    pub bytes: Vec<u8>,
    pub mime: String,
}

pub fn image_cache_key(identity: &CacheImageIdentity) -> String {
    let mut hasher = blake3::Hasher::new();
    for component in [
        identity.scope_id.as_str(),
        identity.archive_id.as_str(),
        identity.rendition.as_str(),
        &identity.page_index.to_string(),
        identity.revision.as_deref().unwrap_or(""),
        identity.transform.as_deref().unwrap_or(""),
    ] {
        hasher.update(&(component.len() as u64).to_le_bytes());
        hasher.update(component.as_bytes());
    }
    format!("image:v2:{}", hasher.finalize().to_hex())
}

/// 一行缓存条目的元数据。**只有 DB 里的东西**，不含任何文件 IO。
struct CacheEntryRow {
    relative: String,
    size: i64,
    content_hash: String,
    mime: Option<String>,
}

/// 取那一行（锁内：一次主键查询）。
fn read_entry_row(
    connection: &rusqlite::Connection,
    key: &str,
    identity: &CacheImageIdentity,
) -> Result<Option<CacheEntryRow>, String> {
    connection
        .query_row(
            "SELECT path,size,content_hash,mime FROM cache_entries WHERE key=?1 AND source_scope=?2 AND kind=?3",
            rusqlite::params![key, identity.scope_id, identity.rendition],
            |row| {
                Ok(CacheEntryRow {
                    relative: row.get(0)?,
                    size: row.get(1)?,
                    content_hash: row.get(2)?,
                    mime: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

/// 内容寻址的路径：摘要说了算。摘要不像样就没有「它该在哪儿」这一说。
fn relative_for_hash(hash: &str) -> Option<String> {
    (hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| format!("cache/images/{}/{hash}.bin", &hash[..2]))
}

/// 读文件并核对「它确实是那一行说的那一份」。**锁外**：这是整条路径上最慢的一步。
#[cfg(test)]
thread_local! {
    // Scoped to the test's IO thread so parallel tests cannot consume the probe.
    static BLOB_IO_PROBE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn probe_blob_io() {
    BLOB_IO_PROBE.with(|probe| {
        if let Some(probe) = probe.borrow_mut().take() {
            probe();
        }
    });
}

fn read_verified_blob(app_data: &std::path::Path, row: &CacheEntryRow) -> Option<Vec<u8>> {
    #[cfg(test)]
    probe_blob_io();
    if relative_for_hash(&row.content_hash).as_deref() != Some(row.relative.as_str()) {
        return None;
    }
    let path = controlled_cache_path(app_data, &row.relative)?;
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() as i64 != row.size {
        return None;
    }
    if blake3::hash(&bytes).to_hex().as_str() != row.content_hash {
        return None;
    }
    Some(bytes)
}

fn touch_entry(connection: &rusqlite::Connection, key: &str) -> Result<(), String> {
    connection
        .execute(
            "UPDATE cache_entries SET last_accessed_at=CURRENT_TIMESTAMP WHERE key=?1",
            [key],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn forget_entry(connection: &rusqlite::Connection, relative: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM cache_entries WHERE path=?1", [relative])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn default_mime() -> String {
    "application/octet-stream".into()
}

/// 一次读的开始：只把那一行取出来（锁内，一次主键查询），并把当前的缓存代记下。
struct PendingRead {
    key: String,
    row: CacheEntryRow,
    epoch: u64,
}

/// 等锁的最小查询：`SELECT 1`。产品里没有它的调用点，探针用它量锁的占用。
#[cfg(test)]
const LOCK_PROBE_QUERY: &str = "SELECT 1";

fn begin_read(
    database: &Database,
    app_data: &std::path::Path,
    identity: &CacheImageIdentity,
) -> Result<Option<PendingRead>, String> {
    let key = image_cache_key(identity);
    let connection = database.connection.lock().map_err(|_| LOCK_FAILED.to_string())?;
    let row = read_entry_row(&connection, &key, identity)?;
    let epoch = cache_epoch(app_data);
    Ok(row.map(|row| PendingRead { key, row, epoch }))
}

/// 一次读的收尾：**锁外**把文件读回来并核验，锁内只更新那一行的时间戳。
fn finish_read(
    database: &Database,
    app_data: &std::path::Path,
    pending: PendingRead,
) -> Result<Option<CachedImage>, String> {
    let PendingRead { key, row, epoch } = pending;
    if let Some(bytes) = read_verified_blob(app_data, &row) {
        let connection = database.connection.lock().map_err(|_| LOCK_FAILED.to_string())?;
        // 行要是刚被清掉，这条 UPDATE 影响 0 行：不会被它复活。
        touch_entry(&connection, &key)?;
        return Ok(Some(CachedImage {
            bytes,
            mime: row.mime.unwrap_or_else(default_mime),
        }));
    }
    if cache_epoch(app_data) != epoch {
        // 代变了：这一行是上一代的账。行是按**路径**删的，而路径是内容寻址的——
        // 清了缓存之后新一代完全可能把同一份内容贴回同一个文件上，照着旧账删行
        // 就会删掉新一代那一行；删文件同理。所以这里什么都不做：没有行引用的
        // 文件由孤儿清扫收走。
        return Ok(None);
    }
    {
        let connection = database.connection.lock().map_err(|_| LOCK_FAILED.to_string())?;
        forget_entry(&connection, &row.relative)?;
    }
    if let Some(path) = controlled_cache_path(app_data, &row.relative) {
        let _ = std::fs::remove_file(path);
    }
    Ok(None)
}

/// 取一份缓存：**锁只覆盖取行与更新时间戳**，读文件与算哈希都在锁外。
///
/// 为什么要这样拆：全局 DB 锁是偏好、书架、搜索这些轻查询的必经之路，而这条路径
/// 搬的是一整页图（1.5MB 起，超分产物更大）并且要算一次 blake3。之前这两件事都在
/// 锁内，等于每翻一页都把「读偏好」堵几十到几百毫秒。
pub fn read_cached_image(
    database: &Database,
    app_data: &std::path::Path,
    identity: &CacheImageIdentity,
) -> Result<Option<CachedImage>, String> {
    identity.validate()?;
    let Some(pending) = begin_read(database, app_data, identity)? else {
        return Ok(None);
    };
    finish_read(database, app_data, pending)
}

/// 调用方自己拿着锁的那一版：语义与 `read_cached_image` 完全一致，只是整段都在
/// 调用方的锁里（测试与「锁已经拿在手上」的调用点用这一版）。
///
/// 这一版不需要比缓存代：清空缓存必须在持锁时发生（`clear_image_cache` 收的就是
/// `&Connection`），所以从取行到删行之间代不可能变。
pub fn load_image_cache(
    connection: &rusqlite::Connection,
    app_data: &std::path::Path,
    identity: &CacheImageIdentity,
) -> Result<Option<CachedImage>, String> {
    identity.validate()?;
    let key = image_cache_key(identity);
    let Some(row) = read_entry_row(connection, &key, identity)? else {
        return Ok(None);
    };
    if let Some(bytes) = read_verified_blob(app_data, &row) {
        touch_entry(connection, &key)?;
        return Ok(Some(CachedImage {
            bytes,
            mime: row.mime.unwrap_or_else(default_mime),
        }));
    }
    forget_entry(connection, &row.relative)?;
    if let Some(path) = controlled_cache_path(app_data, &row.relative) {
        let _ = std::fs::remove_file(path);
    }
    Ok(None)
}

/// 一份缓存**在磁盘上的位置**：位置 + 索引里说的那一份（哈希与长度）。
///
/// 它不读文件、不算哈希——这正是与 [`read_cached_image`] 的区别。调用方
/// （`compute::commands` 把一页解析成提交的源图）要的是「把这一页交给派发前准备那一侧」，
/// 而算哈希、硬链接/复制几十 MB 那件事必须在 supervisor 线程上做（`manager::prepare_run`），
/// 不能挂在 WebView2 的消息循环上（docs/71 §8.1）。这里只查一次主键索引。
///
/// 因此它**不保证**文件里的字节就是哈希说的那一份：它只保证「这一行与这个位置」自洽。
/// 字节对不对由 `prepare_run` 拿 `content_hash` 再算一次来判——它本来就要算。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedBlobLocation {
    pub path: std::path::PathBuf,
    pub content_hash: String,
    pub byte_length: u64,
}

/// 取一份缓存的位置，**不读它**。找不到、或者这一行与内容寻址的路径不自洽，都回 `None`。
pub fn cached_blob_location(
    database: &Database,
    app_data: &std::path::Path,
    identity: &CacheImageIdentity,
) -> Result<Option<CachedBlobLocation>, String> {
    identity.validate()?;
    let key = image_cache_key(identity);
    let row = {
        let connection = database.connection.lock().map_err(|_| LOCK_FAILED.to_string())?;
        read_entry_row(&connection, &key, identity)?
    };
    let Some(row) = row else {
        return Ok(None);
    };
    // 与 `read_verified_blob` 同一条不变式：内容寻址的位置必须由这一行的哈希推出来。
    // 推不出来说明这一行不是我们写下的那种（旧格式、被人改过），宁可不认，也不去猜。
    if relative_for_hash(&row.content_hash).as_deref() != Some(row.relative.as_str()) {
        return Ok(None);
    }
    let Some(path) = controlled_cache_path(app_data, &row.relative) else {
        return Ok(None);
    };
    Ok(Some(CachedBlobLocation {
        path,
        content_hash: row.content_hash,
        byte_length: row.size.max(0) as u64,
    }))
}

/// LANraragi does not always label thumbnails as `image/*` (some builds answer
/// `application/octet-stream`), and rejecting those payloads meant the disk
/// cache stayed empty and every cover was re-fetched. Sniff the magic bytes and
/// only refuse a payload that is not an image at all.
pub fn sniff_image_mime(mime: &str, bytes: &[u8]) -> Option<String> {
    if mime.starts_with("image/") {
        return Some(mime.to_string());
    }
    let detected = match bytes {
        [0xff, 0xd8, 0xff, ..] => "image/jpeg",
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [b'B', b'M', ..] => "image/bmp",
        _ if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" => {
            "image/webp"
        }
        _ if bytes.len() > 12 && &bytes[4..8] == b"ftyp" && &bytes[8..12] == b"avif" => {
            "image/avif"
        }
        _ => return None,
    };
    Some(detected.to_string())
}

/// 动图判定：只看容器头，不解码像素。实现搬到了 `yomika-compute-core` 的
/// [`image_kind`](yomika_compute_core::image_kind)。
///
/// 为什么不在宿主自己留一份：worker 也必须在这一步**之前**认出「这一页会动」，而它拿不到
/// 宿主这份代码（docs/71 §5.2 的边界）。两边各写一份的话，同一张图会在宿主被当成动图、
/// 在 worker 被当成静态首帧——症状正是「超分之后动画没了」，也就是这条判定存在的理由。
pub use yomika_compute_core::image_kind::is_animated_image;

/// 数 GIF 帧数的实现同样在核心（原因见 [`is_animated_image`]）。
///
/// `pub(crate)`：动图 DLSSNR 要在动手之前拿帧数判预算（见
/// `src-tauri/src/dlssnr/animation.rs`），而 `gif` crate 没有帧数 API。
pub(crate) use yomika_compute_core::image_kind::gif_frame_count;

/// PNG 的 8 字节签名。核心那一份是唯一的定义，这里只再导出一次，省得两处各留一个常量。
use yomika_compute_core::image_kind::PNG_SIGNATURE;

/// 动图的循环次数统一成「一直播」（0），返回可以照原样送出去的字节。
///
/// 为什么在字节层面做，而不是在解码 / 编码那几层：送给阅读器的图片字节有六七条来路
/// （磁盘缓存命中、服务器刚取回、超分把动图原样当成功交回、DLSSNR 的旧产物、
/// 帧数或预算超限时的原图、远端引擎的回声），它们唯一的共同必经之路是 IPC 出站
/// （[`crate::domain::result::into_binary_response`]）。用户报「动图只播一遍」时每一条
/// 路都要救——只有收在这里才不会漏。
///
/// 只认 [`is_animated_image`] 认得的三类容器；认不出、读不下去、或者改动会破坏结构时
/// 一律原样返回：宁可只播一遍，也不能把一张图改坏。
pub fn force_infinite_loop(mut bytes: Vec<u8>) -> Vec<u8> {
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        if matches!(gif_frame_count(&bytes), Some(frames) if frames >= 2) {
            gif_force_infinite_loop(&mut bytes);
        }
        return bytes;
    }
    if bytes.starts_with(&PNG_SIGNATURE) {
        png_force_infinite_loop(&mut bytes);
        return bytes;
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        webp_force_infinite_loop(&mut bytes);
    }
    bytes
}

/// GIF 的 Netscape 应用扩展块：`21 FF 0B` + `"NETSCAPE2.0"` + `03 01` + loop(u16 LE) + `00`。
///
/// 有这一块就改它的 loop；没有就**插到全局色表之后**（第一个块之前）。浏览器对没有
/// 这一块的 GIF 只播一遍，而下载器写出来的动图里相当一部分根本没有这块——只改字段
/// 救不了它们。
fn gif_force_infinite_loop(bytes: &mut Vec<u8>) {
    const NETSCAPE: &[u8] = b"NETSCAPE2.0";
    /// 标准写法的 Netscape 块，循环次数写 0：`21 FF 0B` + 标签 + `03 01` + `00 00` + `00`。
    const INFINITE_EXTENSION: [u8; 19] = [
        0x21, 0xFF, 0x0B, b'N', b'E', b'T', b'S', b'C', b'A', b'P', b'E', b'2', b'.', b'0', 0x03,
        0x01, 0x00, 0x00, 0x00,
    ];
    if let Some(at) = bytes
        .windows(NETSCAPE.len())
        .position(|window| window == NETSCAPE)
    {
        // 标签之后是子块长度与子块 id（标准写法 03 01），再两字节才是循环次数。写法
        // 不是这样就不猜了——宁可不动，也不要改到别的字段上。
        let field = at + NETSCAPE.len();
        if bytes.get(field) == Some(&0x03)
            && bytes.get(field + 1) == Some(&0x01)
            && field + 4 <= bytes.len()
        {
            bytes[field + 2..field + 4].copy_from_slice(&0u16.to_le_bytes());
        }
        return;
    }
    if let Some(at) = gif_first_block_offset(bytes) {
        bytes.splice(at..at, INFINITE_EXTENSION);
    }
}

/// 第一个块的起点：头部 6 字节 + 逻辑屏幕描述符 7 字节 + （有的话）全局色表。
fn gif_first_block_offset(bytes: &[u8]) -> Option<usize> {
    let packed = *bytes.get(10)?;
    let mut at = 13usize;
    if packed & 0x80 != 0 {
        at = at.checked_add(3usize << ((packed & 0x07) + 1))?;
    }
    (at <= bytes.len()).then_some(at)
}

/// APNG 的 `acTL`：载荷是 `num_frames u32 BE` + `num_plays u32 BE`，0 就是一直播。
///
/// 改完必须重算这一块的 CRC：浏览器（libpng）会直接丢掉 CRC 不对的**辅助块**，那样
/// acTL 一没整张图就退化成静态图——比只播一遍更糟。
fn png_force_infinite_loop(bytes: &mut Vec<u8>) {
    let mut cursor = PNG_SIGNATURE.len();
    while cursor + 12 <= bytes.len() {
        let length = u32::from_be_bytes([
            bytes[cursor],
            bytes[cursor + 1],
            bytes[cursor + 2],
            bytes[cursor + 3],
        ]) as usize;
        // 4 字节长度 + 4 字节类型 + 数据 + 4 字节 CRC。
        let next = match (cursor + 12).checked_add(length) {
            Some(next) if next <= bytes.len() => next,
            _ => return,
        };
        if &bytes[cursor + 4..cursor + 8] == b"acTL" {
            // 数据从 cursor + 8 起：num_frames 在 +8..+12，num_plays 在 +12..+16。
            if length >= 8 && bytes[cursor + 12..cursor + 16] != [0, 0, 0, 0] {
                bytes[cursor + 12..cursor + 16].copy_from_slice(&[0, 0, 0, 0]);
                // CRC 覆盖「类型 + 数据」，也就是校验和字段之前的 4 字节起的 length+4 字节。
                let crc = png_crc32(&bytes[cursor + 4..next - 4]);
                bytes[next - 4..next].copy_from_slice(&crc.to_be_bytes());
            }
            return;
        }
        cursor = next;
    }
}

/// 动画 WebP 的 `ANIM`：载荷 = 背景色 u32 LE + Loop Count u16 LE（0 就是一直播）。
///
/// 这一条是用户手上那几张图的主因：Chromium 的 `webp_image_decoder.cc` 把 WebP 的
/// Loop Count 读成**圈数**（`repetition_count_ = count == 0 ? kAnimationLoopInfinite
/// : count - 1`），于是下载器写死的 `Loop Count = 1` 到浏览器里就是「播一遍就停」。
fn webp_force_infinite_loop(bytes: &mut Vec<u8>) {
    let mut cursor = 12usize;
    while cursor + 8 <= bytes.len() {
        let length = u32::from_le_bytes([
            bytes[cursor + 4],
            bytes[cursor + 5],
            bytes[cursor + 6],
            bytes[cursor + 7],
        ]) as usize;
        if &bytes[cursor..cursor + 4] == b"ANIM" {
            // 载荷从 cursor + 8 起：背景色在 +8..+12，Loop Count 在 +12..+14。
            if length >= 6 && cursor + 14 <= bytes.len() && bytes[cursor + 12..cursor + 14] != [0, 0] {
                bytes[cursor + 12..cursor + 14].copy_from_slice(&[0, 0]);
            }
            return;
        }
        // RIFF 块按偶数字节对齐，块之间可能有一个填充字节。
        let next = (cursor + 8).saturating_add(length + (length & 1));
        if next <= cursor || next > bytes.len() {
            return;
        }
        cursor = next;
    }
}

/// PNG 块用的 CRC-32（IEEE，反射多项式 `0xEDB88320`）。
///
/// `png` crate 没有公开的 CRC 实现，为一个 8 字节块的重算引一个依赖不值得。
fn png_crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// 一份**已经落好盘、但还没挂行**的内容。
///
/// 写缓存被拆成「锁外落盘」（`prepare_blob`）与「锁内挂行」（`commit_blob`）两步，
/// 中间这一步就是握在手里的凭据。它自己记着动手那一刻的缓存代，用来判断这中间
/// 有没有人清空过。
struct PendingBlob {
    key: String,
    relative: String,
    content_hash: String,
    mime: String,
    byte_length: i64,
    epoch: u64,
    identity: CacheImageIdentity,
}

/// **锁外**：嗅 mime、算摘要、建目录、落盘。这一整段可能很长（一页 1.5MB 起，
/// 超分产物更大），所以它绝不能拿着全局 DB 锁做。
fn prepare_blob(
    app_data: &std::path::Path,
    identity: &CacheImageIdentity,
    mime: &str,
    bytes: &[u8],
) -> Result<PendingBlob, String> {
    identity.validate()?;
    #[cfg(test)]
    probe_blob_io();
    if bytes.is_empty() {
        return Err("Invalid image cache payload".into());
    }
    let mime = sniff_image_mime(mime, bytes)
        .ok_or_else(|| format!("Refusing to cache a non-image payload (content-type: {mime})"))?;
    let content_hash = blake3::hash(bytes).to_hex().to_string();
    let relative =
        relative_for_hash(&content_hash).ok_or_else(|| "Invalid image cache path".to_string())?;
    let target = controlled_cache_path(app_data, &relative)
        .ok_or_else(|| "Invalid image cache path".to_string())?;
    let parent = target
        .parent()
        .ok_or_else(|| "Invalid image cache path".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    // 内容寻址路径：目标存在且长度一致即视为同一份内容，不再把整个文件
    // 读回来重算 hash——每次写多付一整次读+hash 没有买到正确性。
    let target_is_valid = std::fs::metadata(&target)
        .map(|meta| meta.len() == bytes.len() as u64)
        .unwrap_or(false);
    if !target_is_valid {
        let _ = std::fs::remove_file(&target);
        use std::io::Write;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        let temporary = parent.join(format!(
            ".{content_hash}.tmp-{}-{nonce}",
            std::process::id()
        ));
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        // 不 fsync：这是可再生的缓存，掉电丢一页的代价远小于每次写都强制刷盘
        // （Windows 上 10-100ms）。rename 仍保证读者看到的是完整文件。
        if let Err(error) = output.write_all(bytes) {
            drop(output);
            let _ = std::fs::remove_file(&temporary);
            return Err(error.to_string());
        }
        drop(output);
        if let Err(error) = std::fs::rename(&temporary, &target) {
            let _ = std::fs::remove_file(&temporary);
            if !target.exists() {
                return Err(error.to_string());
            }
        }
    }
    Ok(PendingBlob {
        key: image_cache_key(identity),
        relative,
        content_hash,
        mime,
        byte_length: bytes.len() as i64,
        epoch: cache_epoch(app_data),
        identity: identity.clone(),
    })
}

/// **锁内**：把那一行挂上去。调用方负责拿锁。
fn insert_entry(
    connection: &rusqlite::Connection,
    blob: &PendingBlob,
) -> Result<(), String> {
    connection.execute(
        "INSERT INTO cache_entries (key,kind,path,size,mime,source_scope,source_archive,content_hash,model_id,resource_revision) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL,?9) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,path=excluded.path,size=excluded.size,mime=excluded.mime,last_accessed_at=CURRENT_TIMESTAMP,source_scope=excluded.source_scope,source_archive=excluded.source_archive,content_hash=excluded.content_hash,model_id=NULL,resource_revision=excluded.resource_revision",
        rusqlite::params![blob.key, blob.identity.rendition, blob.relative, blob.byte_length, blob.mime, blob.identity.scope_id, blob.identity.archive_id, blob.content_hash, blob.identity.revision],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

/// 收尾：锁内挂行。文件已经落好了，所以这里的锁只覆盖两次轻查询。
fn commit_blob(
    database: &Database,
    app_data: &std::path::Path,
    blob: PendingBlob,
) -> Result<(), String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| LOCK_FAILED.to_string())?;
    if cache_epoch(app_data) != blob.epoch {
        // 这一份写入开始之后用户清空过缓存：它属于上一代，不挂行。
        // 文件留着（内容寻址，可能还有别的行引用它），没行引用的由孤儿清扫收。
        return Ok(());
    }
    insert_entry(&connection, &blob)?;
    maintain_image_cache_quota(&connection, app_data)
}

/// 写一份缓存：**锁只覆盖挂行与配额检查**，建目录、写文件、算摘要都在锁外。
pub fn write_cached_image(
    database: &Database,
    app_data: &std::path::Path,
    identity: &CacheImageIdentity,
    mime: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let blob = prepare_blob(app_data, identity, mime, bytes)?;
    commit_blob(database, app_data, blob)
}

/// **已经发布好的**内容（compute 那一侧落的盘）→ 索引里的一行。
///
/// 与 [`write_cached_image`] 的差别只有一件事：**它不搬字节**。产物已经在
/// `cache/images/xx/<hash>.bin` 上（`compute::artifacts::publish_blob` 用的布局与
/// [`relative_for_hash`] 逐字同形），这里补的只是索引那一行——没有行，按修订号取起点的那几条
/// 路（DLSSNR、旧超分、远端代理）就永远查不到这一版。
///
/// 它**不重算摘要**：发布侧已经在自己的线程里流式核过长度与 blake3，而这条调用挂在界面取产物
/// 那条路上（WebView2 的消息循环里不许等几百毫秒）。这里只做便宜校验——身份合法、路径由摘要
/// 推得出来、文件在、长度与记录相符——对不上就拒绝**而不是**记一行假账。
pub fn adopt_published_blob(
    database: &Database,
    app_data: &std::path::Path,
    identity: &CacheImageIdentity,
    mime: &str,
    relative: &str,
    content_hash: &str,
    byte_length: u64,
) -> Result<(), String> {
    let blob = pending_from_published(app_data, identity, mime, relative, content_hash, byte_length)?;
    commit_blob(database, app_data, blob)
}

/// 把一份「已经发布好的」声明凑成挂行要的那份凭据。校验全在这里，且全是便宜项。
fn pending_from_published(
    app_data: &std::path::Path,
    identity: &CacheImageIdentity,
    mime: &str,
    relative: &str,
    content_hash: &str,
    byte_length: u64,
) -> Result<PendingBlob, String> {
    identity.validate()?;
    if mime.trim().is_empty() {
        return Err("Invalid published artifact mime".into());
    }
    let byte_length =
        i64::try_from(byte_length).map_err(|_| "Invalid published artifact length".to_string())?;
    if byte_length <= 0 {
        return Err("Invalid published artifact length".into());
    }
    // 位置必须**由摘要推出来**：登记一行「路径与哈希各自为政」的账，就等于把「读哪儿」
    // 交给了一个随便谁都能写的字段（与 `a_row_whose_path_does_not_match_its_hash_is_not_a_location`
    // 钉的是同一条规矩）。
    let expected =
        relative_for_hash(content_hash).ok_or_else(|| "Invalid published artifact hash".to_string())?;
    if expected != relative {
        return Err(format!(
            "Published artifact path does not match its hash: {relative}"
        ));
    }
    let path = controlled_cache_path(app_data, relative)
        .ok_or_else(|| "Invalid image cache path".to_string())?;
    let actual = std::fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();
    if actual != byte_length as u64 {
        return Err(format!(
            "Published artifact length mismatch: expected {byte_length}, found {actual}"
        ));
    }
    Ok(PendingBlob {
        key: image_cache_key(identity),
        relative: relative.to_string(),
        content_hash: content_hash.to_string(),
        mime: mime.to_string(),
        byte_length,
        epoch: cache_epoch(app_data),
        identity: identity.clone(),
    })
}

/// 调用方自己拿着锁的那一版：语义与 `write_cached_image` 完全一致，只是整段都在
/// 调用方的锁里。这里不做缓存代比较——锁在手上时别人清不了，代不可能中途变。
//
// 本轮之后宿主的生产写入点都改走 `write_cached_image`（不再为一次写单独拿锁），所以
// 这个入口目前只有测试在用。留着它是因为「锁本来就在手上」的调用方仍然需要同一套语义
// （去重那条路今天仍这样读），而 `#[allow(dead_code)]` 只是承认「暂时没有生产调用点」，
// 不是承认它可以坏——`store_image_cache` 与 `write_cached_image` 的行为由测试钉成一致。
#[allow(dead_code)]
pub fn store_image_cache(
    connection: &rusqlite::Connection,
    app_data: &std::path::Path,
    identity: &CacheImageIdentity,
    mime: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let blob = prepare_blob(app_data, identity, mime, bytes)?;
    insert_entry(connection, &blob)?;
    maintain_image_cache_quota(connection, app_data)
}

/// 孤儿清扫的结果。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanSweep {
    pub removed_files: usize,
    pub bytes_freed: u64,
    pub kept_files: usize,
}

/// 清掉没人引用的图片缓存文件（以及早就死掉的临时文件）。
///
/// 为什么需要它：内容是内容寻址的，而写入又被拆成「先落盘、再挂行」两步，于是有两条
/// 路径会留下没人引用的文件——一是清了缓存之后才收尾的那份写入（它属于上一代，不挂行），
/// 二是写到一半就断电/被杀的临时文件。它们不占 DB 行，可配额是按 DB 行算的，光靠
/// `evict_cache_batch` 永远收不到它们：那是缓存泄漏，不是缓存回收。
///
/// 只扫 `cache/images/<两位>/` 这一层的普通文件，**不跟随** reparse point（那是另一棵树，
/// 不是我们的缓存）。`temp_grace`：一条**没有行引用**的文件也可能是别的写者刚落盘、
/// 还没挂行的那一份（写入是分两步的），所以「没引用」不足以判死——只有比宽限期更老的
/// 才动。这个宽限期是参数而不是常量，因为「确定没有写者正在飞」只有调用点知道
/// （启动时传一小时就够，测试传 `ZERO` 才有确定性）。
pub fn sweep_orphan_cache_files(
    connection: &rusqlite::Connection,
    app_data: &std::path::Path,
    temp_grace: std::time::Duration,
) -> Result<OrphanSweep, String> {
    if !app_data.is_absolute() {
        return Err("Invalid cache root".into());
    }
    let referenced: std::collections::HashSet<String> = {
        let mut statement = connection
            .prepare("SELECT DISTINCT path FROM cache_entries")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<std::collections::HashSet<String>, _>>()
            .map_err(|error| error.to_string())?
    };
    let mut sweep = OrphanSweep {
        removed_files: 0,
        bytes_freed: 0,
        kept_files: 0,
    };
    let Ok(buckets) = std::fs::read_dir(app_data.join("cache").join("images")) else {
        // 从来没有写过缓存：没有东西可扫，这不是错误。
        return Ok(sweep);
    };
    let now = std::time::SystemTime::now();
    for bucket in buckets.flatten() {
        let bucket_path = bucket.path();
        let Ok(bucket_meta) = std::fs::symlink_metadata(&bucket_path) else {
            continue;
        };
        if !bucket_meta.is_dir() || bucket_meta.file_type().is_symlink() {
            continue;
        }
        let Some(bucket_name) = bucket_path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Ok(files) = std::fs::read_dir(&bucket_path) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if !meta.is_file() || meta.file_type().is_symlink() {
                continue;
            }
            let relative = format!("cache/images/{bucket_name}/{name}");
            let old_enough = meta
                .modified()
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age >= temp_grace);
            if old_enough && !referenced.contains(&relative) {
                if std::fs::remove_file(&path).is_ok() {
                    sweep.removed_files += 1;
                    sweep.bytes_freed = sweep.bytes_freed.saturating_add(meta.len());
                }
            } else {
                sweep.kept_files += 1;
            }
        }
    }
    Ok(sweep)
}

/// async：命令体是整文件读 + hash + SQL，原先是同步命令、跑在主线程上，
/// 阅读器预取的每一页都会在那里停一下 UI。
///
/// 命中时回的是**二进制体**，不是 JSON 信封：一页 1.5MB 的 JPEG 走 JSON 就是上百万
/// 个数字，前端还得用 zod 逐个校验（int、0–255…），实测每次命中在主线程上留下一个
/// 200–280ms 的 long task，阅读器一次开三页，加载动画就在那里一顿一顿的。二进制体
/// 直接进 `Uint8Array`，一个字段都不用验。
///
/// 没有缓存条目回**空体**：图片不会是 0 字节，`mime` 由前端按字节自己认（`cache/CachedImage`
/// 里那份 mime 仍然给推理与缩略图那几条路径用）。
#[tauri::command(async)]
pub fn cache_read_image(
    identity: CacheImageIdentity,
    app: tauri::AppHandle,
    database: tauri::State<'_, Database>,
) -> Result<tauri::ipc::Response, String> {
    let app_data = match crate::data_paths::data_dir(&app) {
        Ok(value) => value,
        Err(_) => {
            return Ok(crate::domain::result::into_binary_response(
                CommandResult::failure(
                    "PLATFORM_UNAVAILABLE",
                    "App data directory unavailable",
                    true,
                ),
            ))
        }
    };
    // 读盘与算摘要都在锁外：这条命令被阅读器一次开三页地调，而全局 DB 锁是偏好、
    // 书架、搜索的必经之路——锁着它读几兆的图，别人就得排队。
    match read_cached_image(&database, &app_data, &identity) {
        Ok(Some(image)) => Ok(crate::domain::result::into_binary_response(
            CommandResult::success(image.bytes),
        )),
        Ok(None) => Ok(crate::domain::result::into_binary_response(
            CommandResult::success(Vec::new()),
        )),
        Err(error) => Ok(crate::domain::result::into_binary_response(
            CommandResult::failure("INVALID_RESPONSE", error, false),
        )),
    }
}

/// 写缓存是 Rust 自己的事：`load_reader_page` 取回一页就写，推理产出派生图也写
/// （都走 `store_image_cache`）。这里曾经有一条 `cache_store_image` IPC 命令，前端
/// 谁也没调用它，而它的协议是把整张图摊成 JSON 数字数组——和 `cache_read_image`
/// 刚去掉的那条一样，所以整条删掉，不留一个只能以错误方式使用的入口。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEvictionResult {
    pub removed_entries: usize,
    pub removed_files: usize,
    pub bytes_freed: u64,
    pub remaining_bytes: u64,
    pub quota_satisfied: bool,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub bytes: u64,
    pub entries: usize,
    pub by_rendition: std::collections::BTreeMap<String, CacheBreakdown>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheBreakdown {
    pub bytes: u64,
    pub entries: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearResult {
    pub removed_entries: usize,
    pub removed_files: usize,
    pub bytes_freed: u64,
    pub protected_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInvalidateResult {
    pub removed_entries: usize,
    pub removed_files: usize,
    pub bytes_freed: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEvictionInput {
    pub max_bytes: u64,
    pub batch_limit: usize,
}

fn indexed_cache_bytes(connection: &rusqlite::Connection) -> Result<u64, String> {
    let bytes: i64 = connection.query_row(
        "SELECT COALESCE(SUM(size),0) FROM (SELECT path,MAX(size) AS size FROM cache_entries GROUP BY path)",
        [],
        |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    u64::try_from(bytes).map_err(|_| "Invalid cache size".to_string())
}

fn read_cache_stats(connection: &rusqlite::Connection) -> Result<CacheStats, String> {
    let entries: i64 = connection
        .query_row("SELECT COUNT(*) FROM cache_entries", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let mut by_rendition = std::collections::BTreeMap::new();
    for kind in [
        "cover",
        "page-thumbnail",
        "reader-page",
        "enhanced",
        "dlssnr",
        "inference",
        "other",
    ] {
        by_rendition.insert(
            kind.to_string(),
            CacheBreakdown {
                bytes: 0,
                entries: 0,
            },
        );
    }
    let mut statement = connection
        .prepare(&format!(
            "SELECT CASE WHEN kind IN ({IMAGE_KIND_SQL}) THEN kind ELSE 'other' END, COUNT(*) FROM cache_entries GROUP BY 1"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let kind: String = row.get(0)?;
            let entries: i64 = row.get(1)?;
            Ok((kind, entries))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (kind, entries) = row.map_err(|error| error.to_string())?;
        if let Some(value) = by_rendition.get_mut(&kind) {
            value.entries =
                usize::try_from(entries).map_err(|_| "Invalid cache entry count".to_string())?;
        }
    }
    let mut statement = connection.prepare("SELECT path, MAX(size), MIN(CASE kind WHEN 'cover' THEN 0 WHEN 'page-thumbnail' THEN 1 WHEN 'reader-page' THEN 2 WHEN 'enhanced' THEN 3 WHEN 'dlssnr' THEN 4 WHEN 'inference' THEN 5 ELSE 6 END) FROM cache_entries GROUP BY path")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)))
        .map_err(|error| error.to_string())?;
    // 这一遍扫描同时给出总量：每条路径只算一次 MAX(size)，把它们加起来就是
    // `indexed_cache_bytes`——原来这里再跑一遍同样的聚合（19k 条实测 124ms），
    // 而两次的答案必然相同。
    let mut bytes = 0_u64;
    for row in rows {
        let (size, priority) = row.map_err(|error| error.to_string())?;
        let size = u64::try_from(size).map_err(|_| "Invalid cache size".to_string())?;
        bytes = bytes.saturating_add(size);
        let kind = match priority {
            0 => "cover",
            1 => "page-thumbnail",
            2 => "reader-page",
            3 => "enhanced",
            4 => "dlssnr",
            5 => "inference",
            _ => "other",
        };
        if let Some(value) = by_rendition.get_mut(kind) {
            value.bytes = value.bytes.saturating_add(size);
        }
    }
    Ok(CacheStats {
        bytes,
        entries: usize::try_from(entries).map_err(|_| "Invalid cache entry count".to_string())?,
        by_rendition,
    })
}

/// async：这条查询在实测的 210MB 库（19k 条缓存记录）上要 273ms。同步命令的命令体
/// 是在 **WebView2 的 UI 线程**上就地跑的（tauri 的 `body_blocking`），而状态栏每
/// 10 秒、每次窗口获得焦点、以及每次有图片落缓存都要问它一次——窗口拖动/缩放的消息
/// 就排在这 273ms 后面，表现正是「拖不动，过一会儿才响应」。
#[tauri::command(async)]
pub fn cache_stats(database: tauri::State<'_, Database>) -> CommandResult<CacheStats> {
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", LOCK_FAILED, true),
    };
    match read_cache_stats(&connection) {
        Ok(value) => CommandResult::success(value),
        Err(_) => CommandResult::failure("UNKNOWN", "Cache statistics unavailable", true),
    }
}

fn controlled_cache_path(app_data: &std::path::Path, relative: &str) -> Option<std::path::PathBuf> {
    if !app_data.is_absolute() || relative.contains('\\') {
        return None;
    }
    let parts: Vec<&str> = relative.split('/').collect();
    if parts.len() < 3
        || parts[0] != "cache"
        || parts
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == ".." || part.contains(':'))
    {
        return None;
    }
    let mut path = app_data.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        if index + 1 < parts.len() {
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                    return None
                }
                Ok(_) | Err(_) => {}
            }
        }
    }
    Some(path)
}

fn isolate_cache_file(
    app_data: &std::path::Path,
    relative: &str,
) -> Result<Option<(std::path::PathBuf, std::path::PathBuf)>, String> {
    let Some(path) = controlled_cache_path(app_data, relative) else {
        return Ok(None);
    };
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.file_type().is_file() && !metadata.file_type().is_symlink() {
        return Ok(None);
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let quarantine = path.with_file_name(format!(
        ".{}.deleting-{}-{nonce}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
    ));
    std::fs::rename(&path, &quarantine).map_err(|error| error.to_string())?;
    Ok(Some((path, quarantine)))
}

fn finish_isolated_file(
    isolated: Option<(std::path::PathBuf, std::path::PathBuf)>,
    restore: bool,
) -> Result<bool, String> {
    let Some((path, quarantine)) = isolated else {
        return Ok(false);
    };
    if restore {
        std::fs::rename(&quarantine, &path).map_err(|error| error.to_string())?;
        return Ok(false);
    }
    std::fs::remove_file(&quarantine).map_err(|error| error.to_string())?;
    Ok(true)
}

/// 钉住一份缓存字节：正在读它的那个重活结束之前，配额回收与清空都不许动它。
///
/// `pinned` 这一列一直在迁移里，`evict_cache_batch` / `clear_image_cache` 也一直按它
/// 筛选（`HAVING MAX(pinned)=0`、`pinned=0`），只是**生产代码里从来没有写过它**——
/// 于是「正在被读的字节」与「随手可回收的字节」在数据库看来是同一堆。这里补上写入侧。
///
/// 为什么是布尔而不是计数：迁移里这条列带 `CHECK (pinned IN (0, 1))`，而且宿主侧同一
/// 时刻只允许一个重任务（调度器的单许可不变量），所以「有人钉着」这一个比特就够表达
/// 「这一份现在是别人的输入」。真需要多个持有者各记一笔时，该另开一张 pins 表，而不是
/// 把这个比特当计数器用——那是 Task 6 的 `compute_artifact_acquire/release` 一起做的事。
/// 返回受影响的行数：0 表示这条路径上没有条目（还没落盘，或者已经被回收了）。
//
// 生产侧还没有调用点：真正「宿主把这一份交给 worker 之前钉住、拿到产物之后放掉」的时序
// 要与 Task 6 的 `compute_artifact_acquire/release` 一起落地（那时输入才真的离开宿主）。
// 本轮先把这一对与 `evict`/`clear` 的配合测到，`#[allow(dead_code)]` 只是承认这一点。
#[allow(dead_code)]
pub fn pin_cache_path(
    connection: &rusqlite::Connection,
    relative: &str,
) -> Result<usize, String> {
    connection
        .execute(
            "UPDATE cache_entries SET pinned = 1 WHERE path = ?1",
            [relative],
        )
        .map_err(|error| error.to_string())
}

/// 放掉一次钉住。见 [`pin_cache_path`]：一个比特，置回 0 即可。
#[allow(dead_code)]
pub fn unpin_cache_path(
    connection: &rusqlite::Connection,
    relative: &str,
) -> Result<usize, String> {
    connection
        .execute(
            "UPDATE cache_entries SET pinned = 0 WHERE path = ?1",
            [relative],
        )
        .map_err(|error| error.to_string())
}

pub fn clear_image_cache(
    connection: &rusqlite::Connection,
    app_data: &std::path::Path,
) -> Result<CacheClearResult, String> {
    if !app_data.is_absolute() {
        return Err("Invalid cache root".into());
    }
    // 作废这一代：这一下之后才收尾的那份写入不许再挂行（见 CACHE_EPOCH 的注释）。
    bump_cache_epoch(app_data);
    let candidates = {
        let mut statement = connection
            .prepare(&format!(
                "SELECT path,MAX(size) FROM cache_entries WHERE kind IN ({IMAGE_KIND_SQL}) AND pinned=0 GROUP BY path"
            ))
            .map_err(|error| error.to_string())?;
        let values = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        values
    };
    let mut removed_entries = 0;
    let mut removed_files = 0;
    let mut bytes_freed = 0_u64;
    // 有别的条目（其它 kind 或 pinned）共用的路径不能删文件：一次查询把
    // 这些受保护路径问齐，省掉循环里每条一个 COUNT 的回查。
    let protected_paths: std::collections::HashSet<String> = {
        let mut statement = connection
            .prepare(&format!(
                "SELECT DISTINCT path FROM cache_entries WHERE NOT(kind IN ({IMAGE_KIND_SQL}) AND pinned=0)"
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<std::collections::HashSet<String>, _>>()
            .map_err(|error| error.to_string())?
    };
    for (relative, size) in candidates {
        let isolated = if !protected_paths.contains(&relative) {
            isolate_cache_file(app_data, &relative)?
        } else {
            None
        };
        match connection.execute(&format!("DELETE FROM cache_entries WHERE path=?1 AND kind IN ({IMAGE_KIND_SQL}) AND pinned=0"), [&relative]) {
            Ok(count) => removed_entries += count,
            Err(error) => {
                let _ = finish_isolated_file(isolated, true);
                return Err(error.to_string());
            }
        }
        if finish_isolated_file(isolated, false)? {
            removed_files += 1;
            bytes_freed = bytes_freed.saturating_add(u64::try_from(size).unwrap_or(0));
        }
    }
    // `pinned > 0` 而不是 `pinned = 1`：这一列今天被迁移的 CHECK 限成 0/1，两者等价；
    // 写成「有主」的谓词，将来真上了多持有者的表也不会悄悄漏掉。
    let protected: i64 = connection.query_row(
        &format!(
            "SELECT COALESCE(SUM(size),0) FROM (SELECT path,MAX(size) AS size FROM cache_entries WHERE kind IN ({IMAGE_KIND_SQL}) AND pinned>0 GROUP BY path)"
        ),
        [], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    Ok(CacheClearResult {
        removed_entries,
        removed_files,
        bytes_freed,
        protected_bytes: u64::try_from(protected)
            .map_err(|_| "Invalid protected cache size".to_string())?,
    })
}

pub fn invalidate_archive_cache(
    connection: &rusqlite::Connection,
    app_data: &std::path::Path,
    scope_id: &str,
    archive_id: &str,
) -> Result<CacheInvalidateResult, String> {
    if !app_data.is_absolute() || scope_id.trim().is_empty() || archive_id.trim().is_empty() {
        return Err("Invalid archive cache identity".into());
    }
    // 同 clear_image_cache：作废这一代，晚到的写入不再挂行。
    bump_cache_epoch(app_data);
    let candidates = {
        let mut statement = connection
            .prepare(&format!(
                "SELECT path,MAX(size) FROM cache_entries WHERE source_scope=?1 AND source_archive=?2 AND kind IN ({IMAGE_KIND_SQL}) GROUP BY path"
            ))
            .map_err(|error| error.to_string())?;
        let values = statement
            .query_map(rusqlite::params![scope_id, archive_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        values
    };
    let mut removed_entries = 0;
    let mut removed_files = 0;
    let mut bytes_freed = 0_u64;
    // 同 clear_image_cache：受其它 scope/档案条目共用的路径一次问齐。
    let protected_paths: std::collections::HashSet<String> = {
        let mut statement = connection
            .prepare(&format!(
                "SELECT DISTINCT path FROM cache_entries WHERE NOT(source_scope=?1 AND source_archive=?2 AND kind IN ({IMAGE_KIND_SQL}))"
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params![scope_id, archive_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<std::collections::HashSet<String>, _>>()
            .map_err(|error| error.to_string())?
    };
    for (relative, size) in candidates {
        let isolated = if !protected_paths.contains(&relative) {
            isolate_cache_file(app_data, &relative)?
        } else {
            None
        };
        match connection.execute(
            &format!(
                "DELETE FROM cache_entries WHERE path=?1 AND source_scope=?2 AND source_archive=?3 AND kind IN ({IMAGE_KIND_SQL})"
            ),
            rusqlite::params![relative, scope_id, archive_id],
        ) {
            Ok(count) => removed_entries += count,
            Err(error) => {
                let _ = finish_isolated_file(isolated, true);
                return Err(error.to_string());
            }
        }
        if finish_isolated_file(isolated, false)? {
            removed_files += 1;
            bytes_freed = bytes_freed.saturating_add(u64::try_from(size).unwrap_or(0));
        }
    }
    Ok(CacheInvalidateResult {
        removed_entries,
        removed_files,
        bytes_freed,
    })
}

/// 一次阅读会话的坐标。产物只在「这一本的这一次」里有意义，所以清理也按它划范围。
///
/// 不带范围地清会误伤：`RetainedPage` 允许同时挂着两本阅读器（`MAX_RETAINED_READERS = 2`），
/// 进出 A 时把 B 的产物一起删了，B 的下一页就要重算；更糟的是开第三本触发淘汰时，
/// 那次清理会删掉**正在读的那一本**的产物。
#[derive(Debug, Clone)]
pub struct ReaderSessionScope {
    pub scope_id: String,
    pub archive_id: String,
}

/// 清掉一次阅读会话的「成品」（[`READER_SESSION_RENDITIONS`]：超分与 DLSSNR 的产物）。
///
/// 与 `clear_image_cache` 的差别有三点：**只碰成品**（封面、缩略图、原页留着——它们下一
/// 趟还要用，也不是这一趟算出来的）；**只看这一本**（见 [`ReaderSessionScope`]）；以及
/// **不看 `pinned`**（被钉住的是原页那一类；产物不进置顶）。内容寻址意味着一个文件可能被
/// 别的行共用，所以沿用同一条保护规则：还有别人引用就只删行、不删文件。
///
/// 还有一条时间条件：`created_at < CURRENT_TIMESTAMP`。调用方是 fire-and-forget 挂在阅读
/// 器上的，而派生队列同一提交里就开始写产物了——不加这条，这次会话刚算出来的那几页会被
/// 自己下一次清理顺手删掉（可见页靠内存句柄还活着，所以看不到，但缓存全变成未命中）。
/// `created_at` 的默认值是 `CURRENT_TIMESTAMP`，所以这条只会命中「语句执行那一刻已经在
/// 表里」的行：本次会话随后写的那些（同一秒或更晚）一律留着。
///
/// 为什么要有这条而不是只靠配额与 LRU：那是「满了才动手」，而用户要的是「离开就动手」。
/// 真机上 2.84 GiB 的 DLSSNR 产物把 4 GiB 的配额吃到 90%，LRU 只好去挤别人的封面——
/// 而那些产物只在这次阅读会话里有意义。
pub fn purge_reader_renditions(
    connection: &rusqlite::Connection,
    app_data: &std::path::Path,
    session: &ReaderSessionScope,
) -> Result<CacheInvalidateResult, String> {
    if !app_data.is_absolute() {
        return Err("Invalid cache root".into());
    }
    // 与另外两条一样：作废这一代，晚到的写入不再挂行。
    bump_cache_epoch(app_data);
    let kinds = READER_SESSION_RENDITIONS
        .iter()
        .map(|kind| format!("'{kind}'"))
        .collect::<Vec<_>>()
        .join(",");
    let candidates = {
        let mut statement = connection
            .prepare(&format!(
                "SELECT path,MAX(size) FROM cache_entries WHERE kind IN ({kinds}) \
                 AND source_scope=?1 AND source_archive=?2 AND created_at < CURRENT_TIMESTAMP \
                 GROUP BY path"
            ))
            .map_err(|error| error.to_string())?;
        let values = statement
            .query_map(
                rusqlite::params![session.scope_id, session.archive_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        values
    };
    if candidates.is_empty() {
        return Ok(CacheInvalidateResult {
            removed_entries: 0,
            removed_files: 0,
            bytes_freed: 0,
        });
    }
    let protected_paths: std::collections::HashSet<String> = {
        let mut statement = connection
            .prepare(&format!(
                "SELECT DISTINCT path FROM cache_entries WHERE NOT(kind IN ({kinds}))"
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<std::collections::HashSet<String>, _>>()
            .map_err(|error| error.to_string())?
    };
    let mut removed_entries = 0;
    let mut removed_files = 0;
    let mut bytes_freed = 0_u64;
    for (relative, size) in candidates {
        let isolated = if !protected_paths.contains(&relative) {
            isolate_cache_file(app_data, &relative)?
        } else {
            None
        };
        match connection.execute(
            &format!(
                "DELETE FROM cache_entries WHERE path=?1 AND kind IN ({kinds}) \
                 AND source_scope=?2 AND source_archive=?3 AND created_at < CURRENT_TIMESTAMP"
            ),
            rusqlite::params![&relative, &session.scope_id, &session.archive_id],
        ) {
            Ok(count) => removed_entries += count,
            Err(error) => {
                let _ = finish_isolated_file(isolated, true);
                return Err(error.to_string());
            }
        }
        if finish_isolated_file(isolated, false)? {
            removed_files += 1;
            bytes_freed = bytes_freed.saturating_add(u64::try_from(size).unwrap_or(0));
        }
    }
    Ok(CacheInvalidateResult {
        removed_entries,
        removed_files,
        bytes_freed,
    })
}

/// async：命令体是逐个 `rename` + `remove_file` 的循环，全程还持着全局 DB 锁。
/// 同步命令就地跑在 WebView2 的 UI 线程上，几千个文件的删除期间窗口拖动与缩放
/// （以及任何要读库的命令）都会排在它后面。
#[tauri::command(async)]
pub fn cache_clear_images(
    app: tauri::AppHandle,
    database: tauri::State<'_, Database>,
) -> CommandResult<CacheClearResult> {
    let app_data = match crate::data_paths::data_dir(&app) {
        Ok(value) => value,
        Err(_) => {
            return CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                "App data directory unavailable",
                true,
            )
        }
    };
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", LOCK_FAILED, true),
    };
    match clear_image_cache(&connection, &app_data) {
        Ok(value) => {
            sweep_orphans_quietly(&connection, &app_data);
            CommandResult::success(value)
        }
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

/// async：进/出阅读器都要走这条路，命令体同样是一次删文件循环。
///
/// 这里**不做孤儿清扫**：清扫的宽限期是一小时（留给「已落盘、还没挂行」的写入），对刚
/// 写出来的孤儿本来就无效，而它要遍历整棵缓存树——进出阅读器各来一次不合适。
/// 把命令的两个参数收成一次阅读会话的坐标。
///
/// 空着就是「没说是哪一本」。这条命令的语义是「清掉**这一本**这一次的成品」，范围空着
/// 等于「清掉所有档案的成品」——两本阅读器可以同时挂在保留里（`MAX_RETAINED_READERS = 2`），
/// 收下空范围就会把另一本还在读的产物删掉。宁可什么都不做，也不做一件错的事。
fn reader_session_scope(
    scope_id: String,
    archive_id: String,
) -> Result<ReaderSessionScope, String> {
    if scope_id.is_empty() || archive_id.is_empty() {
        return Err("这一条清理必须带上是哪一本（scope + archive）".into());
    }
    Ok(ReaderSessionScope {
        scope_id,
        archive_id,
    })
}

/// async：同 `cache_clear_images`——同样是持着全局 DB 锁的删文件循环。
#[tauri::command(async)]
pub fn cache_purge_reader_renditions(
    scope_id: String,
    archive_id: String,
    app: tauri::AppHandle,
    database: tauri::State<'_, Database>,
) -> CommandResult<CacheInvalidateResult> {
    // 没有坐标就不清（理由见 `reader_session_scope`）。
    let session = match reader_session_scope(scope_id, archive_id) {
        Ok(value) => value,
        Err(message) => return CommandResult::failure("COMPUTE_BAD_REQUEST", message, false),
    };
    let app_data = match crate::data_paths::data_dir(&app) {
        Ok(value) => value,
        Err(_) => {
            return CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                "App data directory unavailable",
                true,
            )
        }
    };
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", LOCK_FAILED, true),
    };
    match purge_reader_renditions(&connection, &app_data, &session) {
        Ok(value) => CommandResult::success(value),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

/// 生产用的清扫宽限期：写入是「先落盘、再挂行」两步，一份刚落盘、还没挂行的文件
/// 也「没有行引用」，宽限期就是留给它的（真正的写路径几毫秒内就挂上行）。
pub const ORPHAN_SWEEP_GRACE: std::time::Duration = std::time::Duration::from_secs(3600);

/// 用户主动清缓存之后顺手收一遍没人引用的文件。这里最可能攒下孤儿：上一代那些
/// 「盘已经落了、代却在清空时翻过去了」的收尾写入（`commit_blob` 会拒绝挂行）。
/// 清扫失败不算清缓存失败——盘上的字节可以留着下次再收，用户要的那件事已经做完了。
fn sweep_orphans_quietly(connection: &rusqlite::Connection, app_data: &std::path::Path) {
    match sweep_orphan_cache_files(connection, app_data, ORPHAN_SWEEP_GRACE) {
        Ok(sweep) if sweep.removed_files > 0 => {
            eprintln!(
                "yomika: 清掉 {} 个没人引用的缓存文件（{} 字节）",
                sweep.removed_files, sweep.bytes_freed
            );
        }
        Ok(_) => {}
        Err(error) => eprintln!("yomika: 孤儿缓存清扫失败：{error}"),
    }
}

/// async：同 `cache_clear_images`——同样是持着全局 DB 锁的删文件循环。
#[tauri::command(async)]
pub fn cache_invalidate_archive(
    scope_id: String,
    archive_id: String,
    app: tauri::AppHandle,
    database: tauri::State<'_, Database>,
) -> CommandResult<CacheInvalidateResult> {
    let app_data = match crate::data_paths::data_dir(&app) {
        Ok(value) => value,
        Err(_) => {
            return CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                "App data directory unavailable",
                true,
            )
        }
    };
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", LOCK_FAILED, true),
    };
    match invalidate_archive_cache(&connection, &app_data, &scope_id, &archive_id) {
        Ok(value) => {
            sweep_orphans_quietly(&connection, &app_data);
            CommandResult::success(value)
        }
        Err(error) => CommandResult::failure("INVALID_RESPONSE", error, false),
    }
}

pub fn evict_cache_batch(
    connection: &rusqlite::Connection,
    app_data: &std::path::Path,
    max_bytes: u64,
    batch_limit: usize,
) -> Result<CacheEvictionResult, String> {
    if !app_data.is_absolute() || !(1..=256).contains(&batch_limit) {
        return Err("Invalid cache eviction input".into());
    }
    let before = indexed_cache_bytes(connection)?;
    if before <= max_bytes {
        return Ok(CacheEvictionResult {
            removed_entries: 0,
            removed_files: 0,
            bytes_freed: 0,
            remaining_bytes: before,
            quota_satisfied: true,
            has_more: false,
        });
    }

    let candidates = {
        // Keys can share a physical file. Count its bytes once and use the
        // latest access through any of its keys.
        let mut statement = connection.prepare(
            "SELECT path,MAX(size) FROM cache_entries GROUP BY path HAVING MAX(pinned)=0 ORDER BY MAX(last_accessed_at),path LIMIT ?1"
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([batch_limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };

    let mut removed_entries = 0;
    let mut removed_files = 0;
    let mut bytes_freed = 0_u64;
    let mut current_bytes = before;
    for (relative, indexed_size) in candidates {
        if current_bytes <= max_bytes {
            break;
        }
        let Some(path) = controlled_cache_path(app_data, &relative) else {
            removed_entries += connection
                .execute("DELETE FROM cache_entries WHERE path=?1", [&relative])
                .map_err(|error| error.to_string())?;
            current_bytes = current_bytes.saturating_sub(u64::try_from(indexed_size).unwrap_or(0));
            continue;
        };
        let quarantine = path.with_file_name(format!(
            ".{}.evicting-{}",
            path.file_name().unwrap_or_default().to_string_lossy(),
            std::process::id(),
        ));
        let isolated = match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
                if quarantine.exists() {
                    return Err("Cache eviction already pending".into());
                }
                std::fs::rename(&path, &quarantine)
                    .map_err(|_| "Cache file isolation failed".to_string())?;
                true
            }
            Ok(_) | Err(_) => false,
        };
        match connection.execute("DELETE FROM cache_entries WHERE path=?1", [&relative]) {
            Ok(count) => {
                removed_entries += count;
                current_bytes = current_bytes.saturating_sub(u64::try_from(indexed_size).unwrap_or(0));
            }
            Err(error) => {
                if isolated {
                    let _ = std::fs::rename(&quarantine, &path);
                }
                return Err(error.to_string());
            }
        }
        if isolated {
            std::fs::remove_file(&quarantine)
                .map_err(|_| "Cache file removal failed".to_string())?;
            removed_files += 1;
            bytes_freed = bytes_freed.saturating_add(u64::try_from(indexed_size).unwrap_or(0));
        }
    }

    let remaining_bytes = indexed_cache_bytes(connection)?;
    let has_evictable: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM cache_entries GROUP BY path HAVING MAX(pinned)=0 LIMIT 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(CacheEvictionResult {
        removed_entries,
        removed_files,
        bytes_freed,
        remaining_bytes,
        quota_satisfied: remaining_bytes <= max_bytes,
        has_more: remaining_bytes > max_bytes && has_evictable,
    })
}

pub fn maintain_image_cache_quota(
    connection: &rusqlite::Connection,
    app_data: &std::path::Path,
) -> Result<(), String> {
    let quota = connection
        .query_row(
            "SELECT value_json FROM settings WHERE key='preferences.cache_max_bytes'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .and_then(|value| serde_json::from_str::<u64>(&value).ok())
        .unwrap_or(DEFAULT_CACHE_QUOTA_BYTES);
    let trigger = quota.saturating_mul(CACHE_EVICTION_TRIGGER_PERCENT) / 100;
    if indexed_cache_bytes(connection)? < trigger {
        return Ok(());
    }
    let target = quota.saturating_mul(CACHE_EVICTION_TARGET_PERCENT) / 100;
    for _ in 0..16 {
        let result = evict_cache_batch(connection, app_data, target, 256)?;
        if result.quota_satisfied || !result.has_more {
            break;
        }
    }
    Ok(())
}

/// async：配额回收一个批次最多 256 条路径，每条都要 `symlink_metadata` + `rename`
/// + `remove_file`，而且全程持着全局 DB 锁。同步跑就是让 UI 线程陪着它一起等磁盘。
#[tauri::command(async)]
pub fn cache_evict(
    input: CacheEvictionInput,
    app: tauri::AppHandle,
    database: tauri::State<'_, Database>,
) -> CommandResult<CacheEvictionResult> {
    let app_data = match crate::data_paths::data_dir(&app) {
        Ok(value) => value,
        Err(_) => {
            return CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                "App data directory unavailable",
                true,
            )
        }
    };
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", LOCK_FAILED, true),
    };
    match evict_cache_batch(&connection, &app_data, input.max_bytes, input.batch_limit) {
        Ok(value) => CommandResult::success(value),
        Err(_) if !(1..=256).contains(&input.batch_limit) => {
            CommandResult::failure("INVALID_RESPONSE", "Invalid cache eviction input", false)
        }
        Err(_) => CommandResult::failure("CACHE_QUOTA_EXCEEDED", "Cache eviction failed", true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // `loop_count` 是 `AnimationDecoder` 上的方法，不是三个解码器的固有方法。
    use image::AnimationDecoder;

    fn cache_db() -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../migrations/0001_initial.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/0002_local_library.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/0010_cache_path_sharing.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/0013_unified_image_cache.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/0014_cache_archive_scope.sql"))
            .unwrap();
        connection
    }

    fn temp_app_data(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("yomika-{name}-{}-{nonce}", std::process::id()))
    }

    fn online_db() -> Database {
        Database {
            connection: std::sync::Mutex::new(cache_db()),
        }
    }

    /// Assert inside the real file-IO path that a second thread can use the DB.
    /// A fixed acquisition count measured disk speed and Windows timer resolution,
    /// rather than lock ownership (fast writes could finish before 20 samples).
    fn assert_database_unlocked_during_io(database: &std::sync::Arc<Database>, work: impl FnOnce()) {
        let observed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = observed.clone();
        let database = database.clone();
        BLOB_IO_PROBE.with(|probe| {
            *probe.borrow_mut() = Some(Box::new(move || {
                std::thread::spawn(move || {
                    let connection = database.connection.try_lock().expect("blob IO must not hold the global DB lock");
                    let answer: i64 = connection.query_row(LOCK_PROBE_QUERY, [], |row| row.get(0)).unwrap();
                    assert_eq!(answer, 1);
                    seen.store(true, std::sync::atomic::Ordering::SeqCst);
                }).join().expect("DB probe thread");
            }));
        });
        work();
        assert!(observed.load(std::sync::atomic::Ordering::SeqCst), "the actual blob IO path must execute the probe");
    }

    fn big_payload(fill: u8) -> Vec<u8> {
        // 32 MiB：足够让「写一次」量得出来，又不是大到拖慢测试。
        let mut bytes = Vec::with_capacity(32 * 1024 * 1024);
        bytes.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        bytes.resize(32 * 1024 * 1024, fill);
        bytes
    }

    #[test]
    fn the_database_lock_is_free_while_a_blob_is_written() {
        let database = std::sync::Arc::new(online_db());
        let app_data = tempfile::tempdir().unwrap();
        let identity = CacheImageIdentity::new("scope", "archive", "reader-page", 1);
        let payload = big_payload(0x5b);
        assert_database_unlocked_during_io(&database, || {
            write_cached_image(&database, app_data.path(), &identity, "image/png", &payload).unwrap();
        });
    }

    #[test]
    fn the_database_lock_is_free_while_a_blob_is_read() {
        let database = std::sync::Arc::new(online_db());
        let app_data = tempfile::tempdir().unwrap();
        let identity = CacheImageIdentity::new("scope", "archive", "reader-page", 0);
        let payload = big_payload(0x5c);
        write_cached_image(&database, app_data.path(), &identity, "image/png", &payload).unwrap();
        assert_database_unlocked_during_io(&database, || {
            let hit = read_cached_image(&database, app_data.path(), &identity).unwrap().unwrap();
            assert_eq!(hit.bytes.len(), payload.len());
        });
    }

    /// 一份写入如果在清空**之后**才收尾，不许把自己的行挂回来。
    ///
    /// 这是「清空缓存」与「正在算的那些任务」之间的竞速：落盘（可能几十毫秒到几秒）
    /// 发生在锁外，落完再挂行。中间用户点了清空，这一份就属于上一代。
    #[test]
    fn a_write_that_finishes_after_a_clear_does_not_hang_a_row() {
        let database = online_db();
        let app_data = temp_app_data("cache-epoch-write");
        std::fs::create_dir_all(app_data.join("cache/images")).expect("建缓存目录");
        let identity = CacheImageIdentity::new("scope", "archive", "reader-page", 0);
        let payload = big_payload(0x5d);

        // 落盘属于这一代，挂行之前用户清空了缓存。
        let blob = prepare_blob(&app_data, &identity, "image/png", &payload).expect("落盘");
        let file = controlled_cache_path(&app_data, &blob.relative).expect("缓存路径");
        {
            let connection = database.connection.lock().expect("拿锁");
            clear_image_cache(&connection, &app_data).expect("清空缓存");
        }
        commit_blob(&database, &app_data, blob).expect("挂行");

        let connection = database.connection.lock().expect("拿锁");
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM cache_entries", [], |row| row.get(0))
            .expect("数行");
        assert_eq!(rows, 0, "上一代的写入把行挂回来了");
        assert!(file.is_file(), "内容寻址的文件不该被删：同一份内容可能还有别的行引用它");
    }

    /// 一份**陈旧**的读不能按路径去删行或删文件。
    ///
    /// 行是按 `path` 删的，而路径是内容寻址的：清空之后新一代完全可能把**同一份内容**
    /// 重新贴回同一个文件上。这时一张上一代的旧账（它记录的还是那个路径）如果照着
    /// 自己的账本去删，删掉的就是新一代那一行的家。
    #[test]
    fn a_stale_read_does_not_delete_the_next_generations_entry() {
        let database = online_db();
        let app_data = temp_app_data("cache-epoch-read");
        std::fs::create_dir_all(app_data.join("cache/images")).expect("建缓存目录");
        let first = CacheImageIdentity::new("scope", "archive", "reader-page", 0);
        let payload = big_payload(0x5e);
        write_cached_image(&database, &app_data, &first, "image/png", &payload).expect("写缓存");

        // 读开了个头（拿到行 + 记下代），还没收尾。
        let pending = begin_read(&database, &app_data, &first).expect("开始读").expect("有行");

        // 中间清空了一代，然后新一代用**同一份内容**把它贴了回来。
        {
            let connection = database.connection.lock().expect("拿锁");
            clear_image_cache(&connection, &app_data).expect("清空缓存");
        }
        let second = CacheImageIdentity::new("scope", "archive", "reader-page", 1);
        write_cached_image(&database, &app_data, &second, "image/png", &payload).expect("写缓存");

        // 新一代那个文件坏掉了（同长度、不同内容）：陈旧读的核验会失败。
        let relative = relative_for_hash(&blake3::hash(&payload).to_hex().to_string()).expect("路径");
        let file = controlled_cache_path(&app_data, &relative).expect("缓存路径");
        let mut corrupt = payload.clone();
        corrupt[0] = 0x7f;
        std::fs::write(&file, &corrupt).expect("弄坏文件");

        let stale = finish_read(&database, &app_data, pending).expect("收尾");
        assert!(stale.is_none(), "文件核不过就不该报命中");

        let connection = database.connection.lock().expect("拿锁");
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM cache_entries", [], |row| row.get(0))
            .expect("数行");
        assert_eq!(rows, 1, "陈旧读按路径把新一代那一行删掉了");
        assert!(file.is_file(), "陈旧读把新一代的文件删掉了");
    }

    /// 没人引用的缓存文件与死在半路的临时文件要被扫掉；有行引用的、还新鲜的都不动。
    #[test]
    fn orphan_cache_files_are_swept_and_referenced_ones_are_kept() {
        let connection = cache_db();
        let app_data = temp_app_data("cache-orphan-sweep");
        std::fs::create_dir_all(app_data.join("cache/images/aa")).expect("建目录");
        let identity = CacheImageIdentity::new("scope", "archive", "reader-page", 0);
        let kept_payload: Vec<u8> = {
            let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
            bytes.resize(64, 0x11);
            bytes
        };
        store_image_cache(&connection, &app_data, &identity, "image/png", &kept_payload)
            .expect("写缓存");
        let referenced = relative_for_hash(&blake3::hash(&kept_payload).to_hex().to_string())
            .expect("路径");
        let orphan = app_data
            .join("cache/images/aa")
            .join(format!("{}.bin", "b".repeat(64)));
        std::fs::write(&orphan, b"orphaned").expect("写孤儿文件");
        let temporary = app_data
            .join("cache/images/aa")
            .join(format!(".{}.tmp-1-2", "c".repeat(64)));
        std::fs::write(&temporary, b"half").expect("写临时文件");

        // 宽限期一小时：刚写下的东西都还新鲜——「没有行引用」也可能是别人刚落盘、
        // 还没挂行的那一份，宽限期就是为它留的。
        let sweep = sweep_orphan_cache_files(
            &connection,
            &app_data,
            std::time::Duration::from_secs(3600),
        )
        .expect("清扫");
        assert_eq!(sweep.removed_files, 0, "还新鲜的文件一个都不该动");
        assert_eq!(sweep.kept_files, 3);
        assert!(orphan.is_file() && temporary.is_file());

        // 宽限期为零：没人引用的与死在半路的都算够老了。
        let sweep =
            sweep_orphan_cache_files(&connection, &app_data, std::time::Duration::ZERO)
                .expect("清扫");
        assert_eq!(sweep.removed_files, 2);
        assert_eq!(sweep.bytes_freed, 8 + 4);
        assert!(!orphan.exists() && !temporary.exists());
        assert!(
            controlled_cache_path(&app_data, &referenced)
                .expect("路径")
                .is_file(),
            "有行引用的一个字节都不该动"
        );
    }

    /// SQL 里那份 kind 名单必须与 [`IMAGE_RENDITIONS`] **一字不差**。
    ///
    /// 这两份东西各自手写：一份给校验用（`CacheImageIdentity::validate`），一份给 SQL 用
    /// （统计、清空缓存、受保护路径、pin 求和、按档案作废）。2026-10-13 的真机症状正是它们
    /// 走散了——`dlssnr` 进了能写的集合，却没进 SQL 名单，于是设置里「清空缓存」删不掉那
    /// 2.97 GiB 的产物、统计里也看不见它们，用户以为清过了其实一份没少。判据钉「两份集合
    /// 相等」：将来再加一种渲染而忘了改 SQL，这条会先红。
    #[test]
    fn the_sql_kind_list_is_exactly_the_set_a_cache_identity_may_use() {
        let listed: std::collections::BTreeSet<String> = IMAGE_KIND_SQL
            .split(',')
            .map(|kind| kind.trim().trim_matches('\'').to_string())
            .collect();
        let writable: std::collections::BTreeSet<String> = IMAGE_RENDITIONS
            .iter()
            .map(|kind| kind.to_string())
            .collect();
        assert_eq!(listed, writable, "SQL 名单与 IMAGE_RENDITIONS 必须相等");
        assert_eq!(
            IMAGE_KIND_SQL.matches('\'').count(),
            IMAGE_RENDITIONS.len() * 2,
            "名单里每个 kind 都要带引号"
        );
        // 反过来也要成立：SQL 名单里的每一个都真的能通过身份校验——不然它清得掉、
        // 却写不进去，清单与实际内容会对不上。
        for kind in &listed {
            let identity = CacheImageIdentity {
                scope_id: "scope-a".into(),
                archive_id: "archive-a".into(),
                page_index: 1,
                rendition: kind.clone(),
                revision: None,
                transform: None,
            };
            assert!(identity.validate().is_ok(), "{kind} 该被身份校验接受");
        }
    }

    #[test]
    fn quota_eviction_counts_shared_files_once_and_preserves_pinned_lru() {
        let connection = cache_db();
        let app_data = temp_app_data("cache-evict");
        let cache = app_data.join("cache/images");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("old.bin"), b"123456").unwrap();
        std::fs::write(cache.join("new.bin"), b"1234").unwrap();
        std::fs::write(cache.join("pinned.bin"), b"1234567890").unwrap();
        connection.execute_batch("INSERT INTO cache_entries (key,kind,path,size,source_scope,content_hash,pinned,last_accessed_at) VALUES
          ('old-a','image','cache/images/old.bin',6,'a','old',0,'2026-01-01'),
          ('old-b','image','cache/images/old.bin',6,'b','old',0,'2026-01-02'),
          ('new','image','cache/images/new.bin',4,'a','new',0,'2026-02-01'),
          ('pin','image','cache/images/pinned.bin',10,'a','pin',1,'2025-01-01');").unwrap();

        let result = evict_cache_batch(&connection, &app_data, 14, 1).expect("evicted batch");

        assert_eq!(
            result,
            CacheEvictionResult {
                removed_entries: 2,
                removed_files: 1,
                bytes_freed: 6,
                remaining_bytes: 14,
                quota_satisfied: true,
                has_more: false
            }
        );
        assert!(!cache.join("old.bin").exists());
        assert!(cache.join("new.bin").exists());
        assert!(cache.join("pinned.bin").exists());
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn cache_stats_separates_enhancement_outputs_from_other() {
        let connection = cache_db();
        connection
            .execute_batch(
                "INSERT INTO cache_entries (key,kind,path,size,source_scope,content_hash) VALUES
          ('up','enhanced','cache/images/up.bin',120,'scope','up'),
          ('nr','dlssnr','cache/images/nr.bin',30,'scope','nr'),
          ('old','inference','cache/inference/old.bin',10,'scope','old'),
          ('misc','image','cache/images/misc.bin',5,'scope','misc')",
            )
            .unwrap();
        let stats = read_cache_stats(&connection).unwrap();
        assert_eq!(stats.bytes, 165);
        assert_eq!(stats.by_rendition["enhanced"].bytes, 120);
        assert_eq!(stats.by_rendition["dlssnr"].bytes, 30);
        assert_eq!(stats.by_rendition["inference"].bytes, 10);
        assert_eq!(stats.by_rendition["other"].bytes, 5);
    }

    #[test]
    fn cache_stats_counts_shared_file_bytes_once() {
        let connection = cache_db();
        connection.execute_batch("INSERT INTO cache_entries (key,kind,path,size,source_scope,source_archive,content_hash) VALUES
          ('a','cover','cache/images/shared.bin',12,'scope','a','a'),
          ('b','reader-page','cache/images/shared.bin',12,'scope','b','b')").unwrap();
        let stats = read_cache_stats(&connection).unwrap();
        assert_eq!(stats.bytes, 12);
        assert_eq!(stats.entries, 2);
        assert_eq!(
            stats
                .by_rendition
                .values()
                .map(|value| value.bytes)
                .sum::<u64>(),
            12
        );
        assert_eq!(
            stats.by_rendition["cover"],
            CacheBreakdown {
                bytes: 12,
                entries: 1
            }
        );
        assert_eq!(
            stats.by_rendition["reader-page"],
            CacheBreakdown {
                bytes: 0,
                entries: 1
            }
        );
    }

    #[test]
    fn clear_images_preserves_pinned_entries_and_reports_protected_bytes() {
        let connection = cache_db();
        let app_data = temp_app_data("cache-clear-images");
        let cache = app_data.join("cache/images");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("free.bin"), b"free").unwrap();
        std::fs::write(cache.join("enhanced.bin"), b"enhanced").unwrap();
        std::fs::write(cache.join("dlssnr.bin"), b"dlssnr").unwrap();
        std::fs::write(cache.join("pinned.bin"), b"pinned").unwrap();
        connection.execute_batch("INSERT INTO cache_entries (key,kind,path,size,source_scope,source_archive,content_hash,pinned) VALUES
          ('free','cover','cache/images/free.bin',4,'scope','a','free',0),
          ('enhanced','enhanced','cache/images/enhanced.bin',8,'scope','a','enhanced',0),
          ('dlssnr','dlssnr','cache/images/dlssnr.bin',9,'scope','a','dlssnr',0),
          ('pin','reader-page','cache/images/pinned.bin',6,'scope','a','pin',1)").unwrap();

        let result = clear_image_cache(&connection, &app_data).unwrap();

        assert_eq!(
            result,
            CacheClearResult {
                removed_entries: 3,
                removed_files: 3,
                bytes_freed: 21,
                protected_bytes: 6
            }
        );
        assert!(!cache.join("free.bin").exists());
        assert!(!cache.join("enhanced.bin").exists());
        assert!(!cache.join("dlssnr.bin").exists());
        assert!(cache.join("pinned.bin").exists());
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn a_pinned_path_survives_clearing_until_it_is_released() {
        let connection = cache_db();
        let app_data = temp_app_data("cache-pin");
        let identity = CacheImageIdentity::new("scope-a", "archive-a", "reader-page", 3);
        store_image_cache(&connection, &app_data, &identity, "image/png", b"pinned-page").unwrap();
        let relative: String = connection
            .query_row("SELECT path FROM cache_entries", [], |row| row.get(0))
            .unwrap();
        let file = app_data.join(&relative);
        assert!(file.exists());

        // 钉一个不存在的路径不算错，只是没动到任何行。
        assert_eq!(pin_cache_path(&connection, &"cache/images/ff/missing.bin").unwrap(), 0);

        assert_eq!(pin_cache_path(&connection, &relative).unwrap(), 1);
        let pinned: i64 = connection
            .query_row("SELECT pinned FROM cache_entries", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pinned, 1);

        // 清空：被钉住的那一份一个字节都不动，而且报出来的「护住了多少」要对得上。
        let cleared = clear_image_cache(&connection, &app_data).unwrap();
        assert_eq!(cleared.removed_entries, 0);
        assert_eq!(cleared.protected_bytes, 11);
        assert!(file.exists());

        // 放掉：这一下才真的可以被回收。
        assert_eq!(unpin_cache_path(&connection, &relative).unwrap(), 1);
        assert_eq!(pin_cache_path(&connection, &"cache/images/ff/missing.bin").unwrap(), 0);
        let cleared = clear_image_cache(&connection, &app_data).unwrap();
        assert_eq!(cleared.removed_entries, 1);
        assert_eq!(cleared.protected_bytes, 0);
        assert_eq!(cleared.bytes_freed, 11);
        assert!(!file.exists());

        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn archive_invalidation_keeps_shared_blobs_referenced_by_other_archives() {
        let connection = cache_db();
        let app_data = temp_app_data("cache-invalidate-archive");
        let cache = app_data.join("cache/images");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("shared.bin"), b"shared").unwrap();
        connection.execute_batch("INSERT INTO cache_entries (key,kind,path,size,source_scope,source_archive,content_hash) VALUES
          ('target','cover','cache/images/shared.bin',6,'scope-a','archive-a','shared'),
          ('keep','cover','cache/images/shared.bin',6,'scope-b','archive-b','shared')").unwrap();

        let result =
            invalidate_archive_cache(&connection, &app_data, "scope-a", "archive-a").unwrap();

        assert_eq!(
            result,
            CacheInvalidateResult {
                removed_entries: 1,
                removed_files: 0,
                bytes_freed: 0
            }
        );
        assert!(cache.join("shared.bin").exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM cache_entries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn quota_eviction_never_deletes_outside_controlled_cache_root() {
        let connection = cache_db();
        let app_data = temp_app_data("cache-escape");
        std::fs::create_dir_all(app_data.join("cache")).unwrap();
        let outside = app_data.join("keep.bin");
        std::fs::write(&outside, b"keep").unwrap();
        connection.execute("INSERT INTO cache_entries (key,kind,path,size,source_scope,content_hash) VALUES ('bad','image','cache/../keep.bin',4,'a','bad')", []).unwrap();

        let result =
            evict_cache_batch(&connection, &app_data, 0, 8).expect("invalid index discarded");

        assert!(outside.exists());
        assert_eq!(result.removed_entries, 1);
        assert_eq!(result.removed_files, 0);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn quota_eviction_reports_more_batches_or_pinned_quota_floor() {
        let connection = cache_db();
        let app_data = temp_app_data("cache-batches");
        let cache = app_data.join("cache/images");
        std::fs::create_dir_all(&cache).unwrap();
        for name in ["one", "two"] {
            std::fs::write(cache.join(format!("{name}.bin")), b"1234").unwrap();
        }
        std::fs::write(cache.join("pin.bin"), b"1234567890").unwrap();
        connection.execute_batch("INSERT INTO cache_entries (key,kind,path,size,source_scope,content_hash,pinned,last_accessed_at) VALUES
          ('one','image','cache/images/one.bin',4,'a','one',0,'2026-01-01'),
          ('two','image','cache/images/two.bin',4,'a','two',0,'2026-01-02'),
          ('pin','image','cache/images/pin.bin',10,'a','pin',1,'2025-01-01');").unwrap();

        let first = evict_cache_batch(&connection, &app_data, 10, 1).unwrap();
        assert!(!first.quota_satisfied);
        assert!(first.has_more);
        let second = evict_cache_batch(&connection, &app_data, 0, 8).unwrap();
        assert!(!second.quota_satisfied);
        assert!(!second.has_more);
        assert_eq!(second.remaining_bytes, 10);
        assert!(cache.join("pin.bin").exists());
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn unified_image_keys_isolate_scope_rendition_and_page() {
        let cover = CacheImageIdentity::new("scope-a", "archive-a", "cover", 0);
        let other_scope = CacheImageIdentity::new("scope-b", "archive-a", "cover", 0);
        let page = CacheImageIdentity::new("scope-a", "archive-a", "page-thumbnail", 1);

        assert_ne!(image_cache_key(&cover), image_cache_key(&other_scope));
        assert_ne!(image_cache_key(&cover), image_cache_key(&page));
        assert_eq!(
            image_cache_key(&cover),
            image_cache_key(&CacheImageIdentity::new("scope-a", "archive-a", "cover", 0))
        );
    }

    #[test]
    fn unified_image_cache_persists_and_shares_identical_content() {
        let connection = cache_db();
        let app_data = temp_app_data("unified-image");
        let first = CacheImageIdentity::new("scope-a", "archive-a", "cover", 0);
        let second = CacheImageIdentity::new("scope-b", "archive-b", "page-thumbnail", 2);

        store_image_cache(&connection, &app_data, &first, "image/jpeg", b"same-image").unwrap();
        store_image_cache(&connection, &app_data, &second, "image/jpeg", b"same-image").unwrap();

        let loaded = load_image_cache(&connection, &app_data, &first)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.bytes, b"same-image");
        assert_eq!(loaded.mime, "image/jpeg");
        assert_eq!(read_cache_stats(&connection).unwrap().bytes, 10);
        let distinct_paths: i64 = connection
            .query_row(
                "SELECT COUNT(DISTINCT path) FROM cache_entries",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(distinct_paths, 1);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn a_purge_without_a_reader_scope_is_refused_before_it_touches_the_cache() {
        // 空范围等于「清掉所有档案的成品」。前端有两条路会传空：进阅读器时 `scopeId`
        // 还没从服务器列表里解出来，以及路由参数缺失。两者都不该变成「把另一本的产物
        // 一起删掉」，所以这一层自己也要拒绝。
        assert!(reader_session_scope(String::new(), "archive-a".into()).is_err());
        assert!(reader_session_scope("scope-a".into(), String::new()).is_err());
        assert!(reader_session_scope(String::new(), String::new()).is_err());
        let session = reader_session_scope("scope-a".into(), "archive-a".into()).unwrap();
        assert_eq!(session.scope_id, "scope-a");
        assert_eq!(session.archive_id, "archive-a");
    }

    /// 把这几类行的写入时间往前挪一小时，让它们变成「上一趟留下的」。
    ///
    /// 清理只认 `created_at < CURRENT_TIMESTAMP`（见 `purge_reader_renditions` 的文档），
    /// 而 `created_at` 的默认值就是语句执行那一刻——测试里 `store_image_cache` 与
    /// `purge_reader_renditions` 之间没有真实的时间流逝，不挪时间就一条都删不掉。
    /// 真机上这条条件挡的是「本次会话刚算出来的那几页被自己的清理顺手带走」：
    /// `React.StrictMode` 会把进入阅读器时的那次清理跑两遍，两遍之间落下的产物被第二遍
    /// 删掉，用户看到的就是「图片消失」。
    fn age_entries(connection: &rusqlite::Connection, kinds: &[&str]) {
        for kind in kinds {
            let changed = connection
                .execute(
                    "UPDATE cache_entries SET created_at = datetime('now', '-1 hour') WHERE kind = ?1",
                    [kind],
                )
                .unwrap();
            assert!(changed > 0, "{kind} 一行都没挪到");
        }
    }

    #[test]
    fn purging_a_reader_session_removes_that_archive_s_products_and_keeps_everything_else() {
        // 用户的口径：超分 / DLSSNR 的产物「只在这次阅读会话里有意义，离开就清掉」。
        // 这条判据同时钉住四件事：
        //   ①这一趟算出来的成品真的走了；
        //   ②原页与封面**没被顺手带走**（下一趟还要用，也不是这一趟算出来的）；
        //   ③**别的档案 / 别的服务器**的产物没被带走——两本阅读器可以同时挂在保留里
        //     （`MAX_RETAINED_READERS = 2`），从前那条清理不带范围，进出一本会把另一本
        //     还在读的产物一起删掉；
        //   ④这一秒里刚落下的行留着（见 `age_entries`）。
        let connection = cache_db();
        let app_data = temp_app_data("purge-reader");
        let page = CacheImageIdentity::new("scope-a", "archive-a", "reader-page", 3);
        let cover = CacheImageIdentity::new("scope-a", "archive-a", "cover", 0);
        let enhanced = CacheImageIdentity::new("scope-a", "archive-a", "enhanced", 3);
        let dlssnr = CacheImageIdentity::new("scope-a", "archive-a", "dlssnr", 3);
        let other_archive = CacheImageIdentity::new("scope-a", "archive-b", "enhanced", 3);
        let other_scope = CacheImageIdentity::new("scope-b", "archive-a", "enhanced", 3);
        let this_second = CacheImageIdentity::new("scope-a", "archive-a", "enhanced", 9);
        store_image_cache(&connection, &app_data, &page, "image/jpeg", b"the-page").unwrap();
        store_image_cache(&connection, &app_data, &cover, "image/jpeg", b"the-cover").unwrap();
        store_image_cache(&connection, &app_data, &enhanced, "image/png", b"upscaled-page").unwrap();
        store_image_cache(&connection, &app_data, &dlssnr, "image/png", b"dlssnr-page").unwrap();
        store_image_cache(&connection, &app_data, &other_archive, "image/png", b"other-archive")
            .unwrap();
        store_image_cache(&connection, &app_data, &other_scope, "image/png", b"other-scope")
            .unwrap();

        // 统计里也得看得见它：从前 `dlssnr` 不在任何一张 kind 名单里，2.84 GiB 的产物
        // 被报成 `other`，用户在设置里既看不到也删不掉。
        let before = read_cache_stats(&connection).unwrap();
        assert_eq!(before.by_rendition["dlssnr"].entries, 1);
        assert_eq!(before.by_rendition["enhanced"].entries, 3);

        age_entries(&connection, &["enhanced", "dlssnr"]);
        // 挪完时间之后才落下的这一行是「这一趟」的：清理不该碰它。
        store_image_cache(&connection, &app_data, &this_second, "image/png", b"just-written")
            .unwrap();

        let session = ReaderSessionScope {
            scope_id: "scope-a".into(),
            archive_id: "archive-a".into(),
        };
        let result = purge_reader_renditions(&connection, &app_data, &session).unwrap();
        assert_eq!(result.removed_entries, 2, "只该删这一本的两件成品");
        assert_eq!(result.removed_files, 2);
        assert!(load_image_cache(&connection, &app_data, &enhanced)
            .unwrap()
            .is_none());
        assert!(load_image_cache(&connection, &app_data, &dlssnr)
            .unwrap()
            .is_none());
        assert!(load_image_cache(&connection, &app_data, &page)
            .unwrap()
            .is_some(), "原页留着");
        assert!(load_image_cache(&connection, &app_data, &cover)
            .unwrap()
            .is_some(), "封面留着");
        assert!(load_image_cache(&connection, &app_data, &other_archive)
            .unwrap()
            .is_some(), "别的档案的产物留着");
        assert!(load_image_cache(&connection, &app_data, &other_scope)
            .unwrap()
            .is_some(), "别的服务器的产物留着");
        assert!(load_image_cache(&connection, &app_data, &this_second)
            .unwrap()
            .is_some(), "这一秒刚写的留着");
        let after = read_cache_stats(&connection).unwrap();
        assert_eq!(after.by_rendition["dlssnr"].entries, 0);
        assert_eq!(after.by_rendition["reader-page"].entries, 1);
        assert_eq!(after.by_rendition["enhanced"].entries, 3, "别的档案、别的服务器、以及这一秒刚写的都还在");
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn a_product_that_shares_its_bytes_with_a_page_is_only_forgotten() {
        // 内容寻址：产物与别人的页字节相同时**共用同一个文件**。这时只能删行——
        // 真删文件会把原页一起弄丢，而原页下一趟还要用（这是 `path_sharing` 那张
        // 迁移表的由来）。
        let connection = cache_db();
        let app_data = temp_app_data("purge-shared");
        let page = CacheImageIdentity::new("scope-a", "archive-a", "reader-page", 1);
        let dlssnr = CacheImageIdentity::new("scope-a", "archive-a", "dlssnr", 1);
        store_image_cache(&connection, &app_data, &page, "image/png", b"identical-bytes").unwrap();
        store_image_cache(&connection, &app_data, &dlssnr, "image/png", b"identical-bytes").unwrap();
        let shared: i64 = connection
            .query_row("SELECT COUNT(DISTINCT path) FROM cache_entries", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(shared, 1, "两份字节相同，本来就该共用一份文件");

        age_entries(&connection, &["dlssnr"]);
        let session = ReaderSessionScope {
            scope_id: "scope-a".into(),
            archive_id: "archive-a".into(),
        };
        let result = purge_reader_renditions(&connection, &app_data, &session).unwrap();
        assert_eq!(result.removed_entries, 1);
        assert_eq!(result.removed_files, 0, "还有别人引用，文件不能删");
        assert_eq!(result.bytes_freed, 0);
        assert!(load_image_cache(&connection, &app_data, &page)
            .unwrap()
            .is_some());
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn image_cache_accepts_an_octet_stream_that_is_really_an_image() {
        // LANraragi builds that answer application/octet-stream used to have
        // every thumbnail refused, so the disk cache stayed empty forever.
        assert_eq!(
            sniff_image_mime("application/octet-stream", &[0xff, 0xd8, 0xff, 0xe0, 1, 2])
                .as_deref(),
            Some("image/jpeg")
        );
        assert_eq!(
            sniff_image_mime("", &[0x89, b'P', b'N', b'G', 1]).as_deref(),
            Some("image/png")
        );
        assert_eq!(
            sniff_image_mime("image/webp", &[1, 2, 3]).as_deref(),
            Some("image/webp")
        );
        assert_eq!(
            sniff_image_mime("text/html", b"<html>not an image</html>"),
            None
        );

        let connection = cache_db();
        let app_data = temp_app_data("octet-stream-image");
        let identity = CacheImageIdentity::new("scope-a", "archive-a", "cover", 0);
        store_image_cache(
            &connection,
            &app_data,
            &identity,
            "application/octet-stream",
            &[0xff, 0xd8, 0xff, 0xe0, 9, 9],
        )
        .unwrap();

        let stored = load_image_cache(&connection, &app_data, &identity)
            .unwrap()
            .expect("cached cover");
        assert_eq!(stored.mime, "image/jpeg");
        assert!(store_image_cache(
            &connection,
            &app_data,
            &identity,
            "text/html",
            b"<html></html>"
        )
        .is_err());
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn unified_image_cache_discards_corrupt_content() {
        let connection = cache_db();
        let app_data = temp_app_data("unified-corrupt");
        let identity = CacheImageIdentity::new("scope-a", "archive-a", "reader-page", 3);
        store_image_cache(&connection, &app_data, &identity, "image/png", b"valid").unwrap();
        let relative: String = connection
            .query_row(
                "SELECT path FROM cache_entries WHERE key=?1",
                [image_cache_key(&identity)],
                |row| row.get(0),
            )
            .unwrap();
        std::fs::write(app_data.join(relative), b"broken").unwrap();

        assert!(load_image_cache(&connection, &app_data, &identity)
            .unwrap()
            .is_none());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM cache_entries", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn automatic_maintenance_evicts_at_ninety_percent_to_seventy_five_percent() {
        let connection = cache_db();
        let app_data = temp_app_data("automatic-maintenance");
        connection.execute("INSERT INTO settings (key,value_json) VALUES ('preferences.cache_max_bytes','100')", []).unwrap();
        let cache = app_data.join("cache/images");
        std::fs::create_dir_all(&cache).unwrap();
        for name in ["old", "new"] {
            std::fs::write(cache.join(format!("{name}.bin")), vec![1_u8; 50]).unwrap();
        }
        connection.execute_batch("INSERT INTO cache_entries (key,kind,path,size,source_scope,content_hash,last_accessed_at) VALUES
          ('old','cover','cache/images/old.bin',50,'scope','old','2026-01-01'),
          ('new','cover','cache/images/new.bin',50,'scope','new','2026-02-01');").unwrap();

        maintain_image_cache_quota(&connection, &app_data).unwrap();

        assert_eq!(read_cache_stats(&connection).unwrap().bytes, 50);
        assert!(!cache.join("old.bin").exists());
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn quota_preserves_a_shared_file_recently_read_through_either_key() {
        let connection = cache_db();
        let app_data = temp_app_data("cache-shared-recency");
        let cache = app_data.join("cache/images");
        std::fs::create_dir_all(&cache).unwrap();
        for name in ["shared", "cold", "older"] {
            std::fs::write(cache.join(format!("{name}.bin")), b"123456").unwrap();
        }
        connection.execute_batch("INSERT INTO cache_entries (key,kind,path,size,source_scope,content_hash,last_accessed_at) VALUES
          ('shared-a','image','cache/images/shared.bin',6,'a','shared','2025-01-01'),
          ('shared-b','image','cache/images/shared.bin',6,'b','shared','2026-03-01'),
          ('cold','image','cache/images/cold.bin',6,'a','cold','2026-02-01'),
          ('older','image','cache/images/older.bin',6,'a','older','2026-01-01');").unwrap();
        let result = evict_cache_batch(&connection, &app_data, 6, 8).unwrap();
        assert_eq!(result.bytes_freed, 12);
        assert!(result.quota_satisfied);
        assert!(cache.join("shared.bin").exists());
        assert!(!cache.join("cold.bin").exists());
        assert!(!cache.join("older.bin").exists());
        std::fs::remove_dir_all(app_data).unwrap();
    }

    /// 「这一页在哪儿」这件事必须能在**不读它**的前提下答出来：提交那一侧要把它交给
    /// 派发前准备（算哈希、硬链接/复制）去做，读图的代价不能落在命令体上。
    #[test]
    fn a_cached_page_can_be_located_without_being_read() {
        let database = online_db();
        let app_data = temp_app_data("cache-locate");
        let identity = CacheImageIdentity::new("scope-a", "archive-a", "reader-page", 3);
        let payload = b"a page that is already on disk".to_vec();
        write_cached_image(&database, &app_data, &identity, "image/png", &payload).expect("写缓存");

        let located = cached_blob_location(&database, &app_data, &identity)
            .expect("查位置")
            .expect("这一页在缓存里");
        let expected = blake3::hash(&payload).to_hex().to_string();
        assert_eq!(located.content_hash, expected, "索引里说的哈希");
        assert_eq!(located.byte_length, payload.len() as u64, "索引里说的长度");
        // 位置是内容寻址**推出来**的，不是行里那串字符串照抄的。
        assert_eq!(
            located.path,
            app_data.join(format!(
                "cache/images/{}/{}.bin",
                &expected[..2],
                expected
            ))
        );
        assert_eq!(std::fs::read(&located.path).expect("文件该在"), payload);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn an_identity_that_was_never_cached_has_no_location() {
        let database = online_db();
        let app_data = temp_app_data("cache-locate-missing");
        let identity = CacheImageIdentity::new("scope-a", "archive-a", "reader-page", 9);

        assert!(cached_blob_location(&database, &app_data, &identity)
            .expect("查位置")
            .is_none());
        // 参数不合法是**另一件事**：调用点要能把「没这页」与「请求本身不对」分开。
        let mut broken = CacheImageIdentity::new("scope-a", "archive-a", "reader-page", 9);
        broken.page_index = -1;
        assert!(cached_blob_location(&database, &app_data, &broken).is_err());
    }

    /// 内容寻址的行必须「路径由哈希推出来」。对不上时宁可不认：认了就等于照着一行
    /// 来路不明的账去读一个任意位置。
    #[test]
    fn a_row_whose_path_does_not_match_its_hash_is_not_a_location() {
        let database = online_db();
        let app_data = temp_app_data("cache-locate-mismatch");
        // 这是唯一一条什么都不写的用例。`temp_app_data` 只给路径、不建目录，所以这里
        // 手动建一个——不是给断言铺路（对不上的账根本不该去看文件系统），只是末尾好收摊。
        std::fs::create_dir_all(&app_data).expect("建数据目录");
        let identity = CacheImageIdentity::new("scope-a", "archive-a", "reader-page", 4);
        let claimed = "a".repeat(64);
        let elsewhere = format!("cache/images/bb/{}.bin", "b".repeat(64));
        database
            .connection
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO cache_entries (key,kind,path,size,source_scope,content_hash,last_accessed_at)
                 VALUES (?1,?2,?3,?4,?5,?6,CURRENT_TIMESTAMP)",
                rusqlite::params![
                    image_cache_key(&identity),
                    identity.rendition,
                    elsewhere,
                    12_i64,
                    identity.scope_id,
                    claimed
                ],
            )
            .unwrap();

        assert!(cached_blob_location(&database, &app_data, &identity)
            .expect("查位置")
            .is_none());
        std::fs::remove_dir_all(app_data).unwrap();
    }

    /// 缓存代属于**这一个缓存根**，不是整个进程。
///
/// 旧写法是进程级 `AtomicU64`：测试里每个用例各自开一个内存库与临时目录，却在共享同一
/// 个代——A 用例清一次缓存，B 用例手里那份「已经落盘、正要挂行」的产物就被判成上一代而
/// 悄悄不挂行（`a_published_artifact_is_registered_without_copying_its_bytes` 因此偶发
/// 红在「挂完行之后按修订号查得到这一版」）。真机只有一个缓存根，所以这条隔离在线上
/// 不可见，只有并行跑测试时才露出来。
#[test]
fn clearing_one_cache_root_does_not_drop_a_write_in_flight_on_another() {
    let database = online_db();
    let written_root = temp_app_data("cache-epoch-isolated-write");
    let cleared_root = temp_app_data("cache-epoch-isolated-clear");
    std::fs::create_dir_all(&cleared_root).unwrap();
    let identity = CacheImageIdentity::new("scope-a", "archive-a", "enhanced", 9);
    let payload = b"a page that is already on disk".to_vec();
    // 落盘发生在这条缓存根上：真机上就是「清空缓存」按下之前的那一刻。
    let blob = prepare_blob(&written_root, &identity, "image/png", &payload).expect("落盘");
    // 另一条缓存根被清空：它不该把这一份写入判成上一代。
    clear_image_cache(&database.connection.lock().unwrap(), &cleared_root).expect("清空另一条");
    commit_blob(&database, &written_root, blob).expect("挂行");
    let located = cached_blob_location(&database, &written_root, &identity)
        .expect("查位置")
        .expect("另一条缓存根被清空，不该影响这一份写入");
    assert_eq!(located.byte_length, payload.len() as u64);
    std::fs::remove_dir_all(&written_root).unwrap();
    std::fs::remove_dir_all(&cleared_root).unwrap();
}

/// 8-g①：产物已经在**内容寻址**的位置上了，这一版还必须能被按修订号查回来。
    ///
    /// 这是 compute 那条路与缓存索引之间唯一的那道缝：`compute::artifacts::publish_blob` 落的
    /// 路径与 `relative_for_hash` 逐字同形，缺的只是**索引那一行**——没有行，按修订号取起点的
    /// 那几条路（DLSSNR、旧超分、远端代理）就永远查不到这一版，用户那边表现为一直
    /// 「这一页还没算好」（docs/94 欠账②）。
    ///
    /// 挂行**不搬字节**：同一份内容可能已经被别的行引用，复制一份既浪费又让「同一份内容只有
    /// 一份落点」这句话不再成立。
    #[test]
    fn a_published_artifact_is_registered_without_copying_its_bytes() {
        let database = online_db();
        let app_data = temp_app_data("cache-adopt");
        let payload = b"an artifact that is already published".to_vec();
        let content_hash = blake3::hash(&payload).to_hex().to_string();
        let relative = format!("cache/images/{}/{content_hash}.bin", &content_hash[..2]);
        let published = app_data.join(&relative);
        std::fs::create_dir_all(published.parent().expect("有父目录")).expect("建目录");
        std::fs::write(&published, &payload).expect("产物已经在盘上了");
        let identity = {
            let mut identity = CacheImageIdentity::new("scope-a", "archive-a", "enhanced", 7);
            identity.revision = Some("rev:enhanced:abc".to_string());
            identity
        };
        // 挂行之前：文件在、索引里没有。这正是 compute 产物今天的样子，也是这道缝的起点。
        assert!(
            cached_blob_location(&database, &app_data, &identity)
                .expect("查位置")
                .is_none(),
            "还没挂行就不该查得到"
        );

        adopt_published_blob(
            &database,
            &app_data,
            &identity,
            "image/png",
            &relative,
            &content_hash,
            payload.len() as u64,
        )
        .expect("把已经发布的产物登记成这一版");

        let located = cached_blob_location(&database, &app_data, &identity)
            .expect("查位置")
            .expect("挂完行之后按修订号查得到这一版");
        assert_eq!(located.path, published, "还是同一个文件，没有复制");
        assert_eq!(located.content_hash, content_hash);
        assert_eq!(located.byte_length, payload.len() as u64);
        assert_eq!(std::fs::read(&located.path).expect("读回来"), payload);

        // 再挂一次是幂等的：同一行、同一个位置（不是「多出一条」）。
        adopt_published_blob(
            &database,
            &app_data,
            &identity,
            "image/png",
            &relative,
            &content_hash,
            payload.len() as u64,
        )
        .expect("再挂一次");
        let rows: i64 = database
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM cache_entries WHERE key = ?1",
                rusqlite::params![image_cache_key(&identity)],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1, "同一版只该有一条行");

        // 账对不上就**拒绝登记**，宁可不认也不记一行假账。
        for (what, relative, hash, byte_length) in [
            (
                "路径不是由摘要推出来的",
                "cache/images/aa/aa.bin",
                content_hash.as_str(),
                payload.len() as u64,
            ),
            (
                "长度与记录不符",
                relative.as_str(),
                content_hash.as_str(),
                payload.len() as u64 + 1,
            ),
            (
                "摘要不是十六进制",
                relative.as_str(),
                "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
                payload.len() as u64,
            ),
            (
                "长度为零",
                relative.as_str(),
                content_hash.as_str(),
                0,
            ),
        ] {
            assert!(
                adopt_published_blob(
                    &database,
                    &app_data,
                    &identity,
                    "image/png",
                    relative,
                    hash,
                    byte_length
                )
                .is_err(),
                "{what}的时候该拒绝登记"
            );
        }
        let mut broken = identity.clone();
        broken.page_index = -1;
        assert!(
            adopt_published_blob(
                &database,
                &app_data,
                &broken,
                "image/png",
                &relative,
                &content_hash,
                payload.len() as u64
            )
            .is_err(),
            "身份本身不合法时该拒绝登记"
        );
        // 被拒的那几次不该污染已经挂好的那一行。
        assert!(cached_blob_location(&database, &app_data, &identity)
            .expect("查位置")
            .is_some());
        std::fs::remove_dir_all(app_data).unwrap();
    }

    /// 一帧 GIF：`0x2C` 图像描述符 + 无局部色表 + LZW 最小码长与一个已结束的子块链。
    fn gif_frame() -> Vec<u8> {
        let mut bytes = vec![0x2C];
        bytes.extend_from_slice(&[0, 0, 0, 0, 1, 0, 1, 0, 0]);
        bytes.extend_from_slice(&[0x02, 0x02, 0x44, 0x01, 0x00]);
        bytes
    }

    fn gif_with_frames(frames: usize) -> Vec<u8> {
        let mut bytes = Vec::from(*b"GIF89a");
        // 逻辑屏幕描述符：宽高各 2 字节 + packed 0x80（带 2 色全局色表）+ 背景色 + 宽高比。
        // 色表要在：真实 GIF 基本都带，且它把「描述符长度算错」这类的偏差暴露出来——
        // 用不带色表的骨架测过一版，错位恰好被骨架的字节对齐掩盖了。
        bytes.extend_from_slice(&[1, 0, 1, 0, 0x80, 0, 0]);
        bytes.extend_from_slice(&[0xff, 0xff, 0xff, 0x00, 0x00, 0x00]);
        for _ in 0..frames {
            bytes.extend_from_slice(&gif_frame());
        }
        bytes.push(0x3B);
        bytes
    }

    fn png_with_chunks(chunks: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        for (kind, data) in chunks {
            bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
            bytes.extend_from_slice(*kind);
            bytes.extend_from_slice(data);
            bytes.extend_from_slice(&[0, 0, 0, 0]); // 只走容器结构，不校验 CRC。
        }
        bytes
    }

    fn webp_with_vp8x_flag(flag: u8) -> Vec<u8> {
        let mut bytes = Vec::from(*b"RIFF");
        bytes.extend_from_slice(&[0x16, 0, 0, 0]);
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(b"VP8X");
        bytes.extend_from_slice(&10u32.to_le_bytes());
        bytes.push(flag);
        bytes.extend_from_slice(&[0; 9]);
        bytes
    }

    #[test]
    fn a_gif_with_two_frames_is_animated() {
        assert!(is_animated_image(&gif_with_frames(2)));
    }

    #[test]
    fn a_gif_with_one_frame_is_still_an_image() {
        assert!(!is_animated_image(&gif_with_frames(1)));
    }

    #[test]
    fn a_truncated_gif_header_is_not_animated() {
        // 只有头部、没有逻辑屏幕描述符：读不出来就当静态，不能 panic。
        assert!(!is_animated_image(b"GIF89a"));
        assert!(!is_animated_image(b"GIF89a\x01\x00"));
    }

    #[test]
    fn a_png_carrying_an_actl_chunk_is_animated() {
        let bytes = png_with_chunks(&[
            (b"IHDR", &[0; 13]),
            (b"acTL", &[2, 0, 0, 0, 0, 0, 0, 0]),
            (b"IDAT", &[1, 2, 3]),
        ]);
        assert!(is_animated_image(&bytes));
    }

    #[test]
    fn a_png_without_an_actl_chunk_is_not_animated() {
        let bytes = png_with_chunks(&[(b"IHDR", &[0; 13]), (b"IDAT", &[1, 2, 3])]);
        assert!(!is_animated_image(&bytes));
        // acTL 出现在 IDAT 之后就不是「第一个 IDAT 之前」，也不算动图。
        let late = png_with_chunks(&[
            (b"IHDR", &[0; 13]),
            (b"IDAT", &[1, 2, 3]),
            (b"acTL", &[2, 0, 0, 0, 0, 0, 0, 0]),
        ]);
        assert!(!is_animated_image(&late));
    }

    #[test]
    fn a_webp_with_the_vp8x_animation_bit_is_animated() {
        assert!(is_animated_image(&webp_with_vp8x_flag(0x02)));
    }

    #[test]
    fn a_webp_without_the_animation_bit_is_not_animated() {
        assert!(!is_animated_image(&webp_with_vp8x_flag(0x00)));
    }

    #[test]
    fn a_webp_carrying_an_anim_chunk_is_animated() {
        let mut bytes = Vec::from(*b"RIFF");
        bytes.extend_from_slice(&[0x16, 0, 0, 0]);
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(b"VP8X");
        bytes.extend_from_slice(&10u32.to_le_bytes());
        bytes.extend_from_slice(&[0; 10]); // 位清空，只有 ANIM 块能说明它是动图。
        bytes.extend_from_slice(b"ANIM");
        bytes.extend_from_slice(&4u32.to_le_bytes());
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        assert!(is_animated_image(&bytes));
    }

    #[test]
    fn bytes_that_are_not_an_image_are_not_animated() {
        assert!(!is_animated_image(b"<html>not an image</html>"));
        assert!(!is_animated_image(&[]));
    }

    // ---- 动图循环次数归一（用户报「动图只播一遍」）----
    //
    // 夹具就是动图 DLSSNR 那三份（`dlssnr/testdata/animated.*`，3 帧、无限循环），
    // 用例先把循环字段改成有限圈数，再看 [`force_infinite_loop`] 能不能归一。

    const ANIMATED_GIF: &[u8] = include_bytes!("dlssnr/testdata/animated.gif");
    const ANIMATED_PNG: &[u8] = include_bytes!("dlssnr/testdata/animated.png");
    const ANIMATED_WEBP: &[u8] = include_bytes!("dlssnr/testdata/animated.webp");

    fn loop_plays(loops: image::metadata::LoopCount) -> u32 {
        match loops {
            image::metadata::LoopCount::Infinite => 0,
            image::metadata::LoopCount::Finite(value) => value.get(),
        }
    }

    fn gif_plays(bytes: &[u8]) -> u32 {
        let decoder = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(bytes)).unwrap();
        loop_plays(decoder.loop_count())
    }

    fn png_plays(bytes: &[u8]) -> u32 {
        let decoder = image::codecs::png::PngDecoder::new(std::io::Cursor::new(bytes)).unwrap();
        loop_plays(decoder.apng().unwrap().loop_count())
    }

    fn webp_plays(bytes: &[u8]) -> u32 {
        let decoder = image::codecs::webp::WebPDecoder::new(std::io::Cursor::new(bytes)).unwrap();
        loop_plays(decoder.loop_count())
    }

    fn has_netscape(bytes: &[u8]) -> bool {
        bytes
            .windows(b"NETSCAPE2.0".len())
            .any(|window| window == b"NETSCAPE2.0")
    }

    fn netscape_at(bytes: &[u8]) -> usize {
        bytes
            .windows(b"NETSCAPE2.0".len())
            .position(|window| window == b"NETSCAPE2.0")
            .expect("夹具里应当有 Netscape 块")
    }

    /// 把夹具的 Netscape 块整段摘掉（`21 FF 0B` + 标签 + `03 01` + loop + `00`，19 字节），
    /// 做出「下载器没写循环次数」的那种 GIF。
    fn gif_without_netscape() -> Vec<u8> {
        let mut bytes = ANIMATED_GIF.to_vec();
        let at = netscape_at(&bytes);
        bytes.drain(at - 3..at + 16);
        assert!(!has_netscape(&bytes), "摘干净了才做得了这条用例");
        assert_eq!(gif_frame_count(&bytes), Some(3), "摘掉 Netscape 块不能改变帧数");
        bytes
    }

    /// 夹具 APNG 的 `acTL` 改成「播 N 遍」。CRC 必须跟着重算——解码器根本不认校验
    /// 不过的辅助块，那样连用例的前置断言都过不去。
    fn png_with_plays(count: u32) -> Vec<u8> {
        let mut bytes = ANIMATED_PNG.to_vec();
        let at = bytes
            .windows(4)
            .position(|window| window == b"acTL")
            .expect("夹具是 APNG");
        bytes[at + 8..at + 12].copy_from_slice(&count.to_be_bytes());
        let length = u32::from_be_bytes([
            bytes[at - 4],
            bytes[at - 3],
            bytes[at - 2],
            bytes[at - 1],
        ]) as usize;
        let crc = png_crc32(&bytes[at..at + 4 + length]);
        bytes[at + 4 + length..at + 8 + length].copy_from_slice(&crc.to_be_bytes());
        bytes
    }

    #[test]
    fn a_gif_that_counts_its_loops_plays_forever() {
        let mut source = ANIMATED_GIF.to_vec();
        let at = netscape_at(&source);
        source[at + 13..at + 15].copy_from_slice(&3u16.to_le_bytes());
        assert_eq!(gif_plays(&source), 3, "夹具里写的圈数要真的被解码器读出来");

        let patched = force_infinite_loop(source);
        assert_eq!(gif_plays(&patched), 0);
        assert_eq!(gif_frame_count(&patched), Some(3), "只改循环字段，不该动帧数");
    }

    #[test]
    fn a_gif_without_a_loop_block_gains_one_that_plays_forever() {
        let source = gif_without_netscape();

        let patched = force_infinite_loop(source.clone());
        assert!(has_netscape(&patched), "没有 Netscape 块的 GIF 只会播一遍，得补一块");
        assert_eq!(patched.len(), source.len() + 19, "补的就是标准那 19 字节");
        assert_eq!(gif_frame_count(&patched), Some(3), "补块不能改变帧数");
        assert_eq!(gif_plays(&patched), 0);
    }

    #[test]
    fn a_webp_loop_count_of_one_plays_forever() {
        let mut source = ANIMATED_WEBP.to_vec();
        let at = source
            .windows(4)
            .position(|window| window == b"ANIM")
            .expect("夹具是动画 WebP");
        source[at + 12..at + 14].copy_from_slice(&1u16.to_le_bytes());
        assert_eq!(
            u16::from_le_bytes([source[at + 12], source[at + 13]]),
            1,
            "夹具里写的 Loop Count 要真的是 1"
        );
        assert_eq!(
            webp_plays(&source),
            1,
            "WebP 的 Loop Count 就是圈数，1 到 Chromium 里就是播一遍"
        );

        let patched = force_infinite_loop(source);
        assert_eq!(
            u16::from_le_bytes([patched[at + 12], patched[at + 13]]),
            0
        );
        assert_eq!(webp_plays(&patched), 0);
    }

    #[test]
    fn an_apng_that_counts_its_plays_plays_forever_and_keeps_the_chunk_crc() {
        let source = png_with_plays(2);
        assert_eq!(png_plays(&source), 2, "夹具里写的遍数要真的被解码器读出来");

        let patched = force_infinite_loop(source);
        assert_eq!(png_plays(&patched), 0);
        let at = patched
            .windows(4)
            .position(|window| window == b"acTL")
            .unwrap();
        let length = u32::from_be_bytes([
            patched[at - 4],
            patched[at - 3],
            patched[at - 2],
            patched[at - 1],
        ]) as usize;
        let expected = png_crc32(&patched[at..at + 4 + length]);
        assert_eq!(
            u32::from_be_bytes([
                patched[at + 4 + length],
                patched[at + 5 + length],
                patched[at + 6 + length],
                patched[at + 7 + length],
            ]),
            expected,
            "acTL 改过就得重算 CRC：libpng 会丢掉校验不过的辅助块，acTL 一没整张图就成静态"
        );
    }

    #[test]
    fn normalizing_twice_is_the_same_as_normalizing_once() {
        let once = force_infinite_loop(png_with_plays(4));
        let twice = force_infinite_loop(once.clone());
        assert_eq!(once, twice);
    }

    #[test]
    fn a_static_image_and_a_non_image_are_left_alone() {
        let jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F'];
        assert_eq!(force_infinite_loop(jpeg.clone()), jpeg);
        let zip = b"PK\x03\x04\x14\x00\x00\x00\x08\x00".to_vec();
        assert_eq!(force_infinite_loop(zip.clone()), zip);
        assert_eq!(force_infinite_loop(Vec::new()), Vec::<u8>::new());
    }

    #[test]
    fn the_ipc_binary_boundary_normalizes_the_loop() {
        // 出站那一步是把「服务器刚取回」「增强层原样交回」「DLSSNR 旧产物」等所有来路
        // 收成一条的地方；这条断言只是不让人把接线拆掉（真正的行为用例在上面）。
        assert!(include_str!("domain/result.rs").contains("cache::force_infinite_loop"));
    }
}

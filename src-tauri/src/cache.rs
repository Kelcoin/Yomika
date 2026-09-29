use crate::{db::Database, domain::result::CommandResult};
use rusqlite::OptionalExtension;

/// `enhanced` is the upscaler output and `decensored` the de-censoring pipeline's,
/// both keyed by model version in the identity revision so a model change cannot
/// serve a stale image.
const IMAGE_RENDITIONS: [&str; 5] = [
    "cover",
    "page-thumbnail",
    "reader-page",
    "enhanced",
    "decensored",
];
const DEFAULT_CACHE_QUOTA_BYTES: u64 = 2 * 1_073_741_824;
const CACHE_EVICTION_TRIGGER_PERCENT: u64 = 90;
const CACHE_EVICTION_TARGET_PERCENT: u64 = 75;

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

pub fn load_image_cache(
    connection: &rusqlite::Connection,
    app_data: &std::path::Path,
    identity: &CacheImageIdentity,
) -> Result<Option<CachedImage>, String> {
    identity.validate()?;
    let key = image_cache_key(identity);
    let entry: Option<(String, i64, String, Option<String>)> = connection.query_row(
        "SELECT path,size,content_hash,mime FROM cache_entries WHERE key=?1 AND source_scope=?2 AND kind=?3",
        rusqlite::params![key, identity.scope_id, identity.rendition],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional().map_err(|error| error.to_string())?;
    let Some((relative, expected_size, expected_hash, mime)) = entry else {
        return Ok(None);
    };
    let expected_relative = if expected_hash.len() == 64
        && expected_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        format!("cache/images/{}/{}.bin", &expected_hash[..2], expected_hash)
    } else {
        String::new()
    };
    let path = controlled_cache_path(app_data, &relative);
    let bytes = path.as_ref().and_then(|path| std::fs::read(path).ok());
    let valid = relative == expected_relative
        && bytes.as_ref().is_some_and(|bytes| {
            bytes.len() as i64 == expected_size
                && blake3::hash(bytes).to_hex().as_str() == expected_hash
        });
    if valid {
        connection
            .execute(
                "UPDATE cache_entries SET last_accessed_at=CURRENT_TIMESTAMP WHERE key=?1",
                [&key],
            )
            .map_err(|error| error.to_string())?;
        return Ok(Some(CachedImage {
            bytes: bytes.unwrap_or_default(),
            mime: mime.unwrap_or_else(|| "application/octet-stream".into()),
        }));
    }
    connection
        .execute("DELETE FROM cache_entries WHERE path=?1", [&relative])
        .map_err(|error| error.to_string())?;
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
    Ok(None)
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

pub fn store_image_cache(
    connection: &rusqlite::Connection,
    app_data: &std::path::Path,
    identity: &CacheImageIdentity,
    mime: &str,
    bytes: &[u8],
) -> Result<(), String> {
    identity.validate()?;
    if bytes.is_empty() {
        return Err("Invalid image cache payload".into());
    }
    let mime = sniff_image_mime(mime, bytes)
        .ok_or_else(|| format!("Refusing to cache a non-image payload (content-type: {mime})"))?;
    let mime = mime.as_str();
    let content_hash = blake3::hash(bytes).to_hex().to_string();
    let relative = format!("cache/images/{}/{}.bin", &content_hash[..2], content_hash);
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
        // 不 fsync：这是可再生的缓存，掉电丢一页的代价远小于每次写都
        // 强制刷盘（Windows 上 10-100ms，且此刻持有全局 DB 锁）。
        // rename 仍保证读者看到的是完整文件。
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
    connection.execute(
        "INSERT INTO cache_entries (key,kind,path,size,mime,source_scope,source_archive,content_hash,model_id,resource_revision) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL,?9) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,path=excluded.path,size=excluded.size,mime=excluded.mime,last_accessed_at=CURRENT_TIMESTAMP,source_scope=excluded.source_scope,source_archive=excluded.source_archive,content_hash=excluded.content_hash,model_id=NULL,resource_revision=excluded.resource_revision",
        rusqlite::params![image_cache_key(identity), identity.rendition, relative, bytes.len() as i64, mime, identity.scope_id, identity.archive_id, content_hash, identity.revision],
    ).map_err(|error| error.to_string())?;
    maintain_image_cache_quota(connection, app_data)
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
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => {
            return Ok(crate::domain::result::into_binary_response(
                CommandResult::failure("UNKNOWN", "Database lock failed", true),
            ))
        }
    };
    match load_image_cache(&connection, &app_data, &identity) {
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
        "decensored",
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
    let mut statement = connection.prepare("SELECT CASE WHEN kind IN ('cover','page-thumbnail','reader-page','enhanced','decensored','inference') THEN kind ELSE 'other' END, COUNT(*) FROM cache_entries GROUP BY 1")
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
    let mut statement = connection.prepare("SELECT path, MAX(size), MIN(CASE kind WHEN 'cover' THEN 0 WHEN 'page-thumbnail' THEN 1 WHEN 'reader-page' THEN 2 WHEN 'enhanced' THEN 3 WHEN 'decensored' THEN 4 WHEN 'inference' THEN 5 ELSE 6 END) FROM cache_entries GROUP BY path")
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
            4 => "decensored",
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
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
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

pub fn clear_image_cache(
    connection: &rusqlite::Connection,
    app_data: &std::path::Path,
) -> Result<CacheClearResult, String> {
    if !app_data.is_absolute() {
        return Err("Invalid cache root".into());
    }
    let candidates = {
        let mut statement = connection.prepare("SELECT path,MAX(size) FROM cache_entries WHERE kind IN ('cover','page-thumbnail','reader-page','enhanced','decensored') AND pinned=0 GROUP BY path")
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
            .prepare("SELECT DISTINCT path FROM cache_entries WHERE NOT(kind IN ('cover','page-thumbnail','reader-page','enhanced','decensored') AND pinned=0)")
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
        match connection.execute("DELETE FROM cache_entries WHERE path=?1 AND kind IN ('cover','page-thumbnail','reader-page','enhanced','decensored') AND pinned=0", [&relative]) {
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
    let protected: i64 = connection.query_row(
        "SELECT COALESCE(SUM(size),0) FROM (SELECT path,MAX(size) AS size FROM cache_entries WHERE kind IN ('cover','page-thumbnail','reader-page','enhanced','decensored') AND pinned=1 GROUP BY path)",
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
    let candidates = {
        let mut statement = connection.prepare("SELECT path,MAX(size) FROM cache_entries WHERE source_scope=?1 AND source_archive=?2 AND kind IN ('cover','page-thumbnail','reader-page','enhanced','decensored') GROUP BY path")
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
            .prepare("SELECT DISTINCT path FROM cache_entries WHERE NOT(source_scope=?1 AND source_archive=?2 AND kind IN ('cover','page-thumbnail','reader-page','enhanced','decensored'))")
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
            "DELETE FROM cache_entries WHERE path=?1 AND source_scope=?2 AND source_archive=?3 AND kind IN ('cover','page-thumbnail','reader-page','enhanced','decensored')",
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
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match clear_image_cache(&connection, &app_data) {
        Ok(value) => CommandResult::success(value),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
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
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match invalidate_archive_cache(&connection, &app_data, &scope_id, &archive_id) {
        Ok(value) => CommandResult::success(value),
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
        // SUM 而不是 MAX：DELETE 按路径删掉全部行，字节账本（递减与
        // bytes_freed）要的就是这个路径上的总字节。
        let mut statement = connection.prepare(
            "SELECT path,SUM(size) FROM cache_entries GROUP BY path HAVING MAX(pinned)=0 ORDER BY MIN(last_accessed_at),path LIMIT ?1"
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
    // 全表 SUM 聚合只算一次，循环内按删掉的条目递减：原来每个候选都重跑
    // 一遍聚合（最多 4096 次全表扫描），而且此时多半持有全局 DB 锁。
    // 近似误差由收尾的精确 remaining_bytes 与外层的多批循环兜底。
    let mut current_bytes = indexed_cache_bytes(connection)?;
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
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
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
                // 共享路径的两行各 6 字节，DELETE 按路径删掉两行，
                // 实际释放 12 字节——SUM(size)，不是 MAX(size) 的 6。
                bytes_freed: 12,
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
          ('de','decensored','cache/images/de.bin',30,'scope','de'),
          ('old','inference','cache/inference/old.bin',10,'scope','old'),
          ('misc','image','cache/images/misc.bin',5,'scope','misc')",
            )
            .unwrap();
        let stats = read_cache_stats(&connection).unwrap();
        assert_eq!(stats.bytes, 165);
        assert_eq!(stats.by_rendition["enhanced"].bytes, 120);
        assert_eq!(stats.by_rendition["decensored"].bytes, 30);
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
        std::fs::write(cache.join("decensored.bin"), b"decensored").unwrap();
        std::fs::write(cache.join("pinned.bin"), b"pinned").unwrap();
        connection.execute_batch("INSERT INTO cache_entries (key,kind,path,size,source_scope,source_archive,content_hash,pinned) VALUES
          ('free','cover','cache/images/free.bin',4,'scope','a','free',0),
          ('enhanced','enhanced','cache/images/enhanced.bin',8,'scope','a','enhanced',0),
          ('decensored','decensored','cache/images/decensored.bin',9,'scope','a','decensored',0),
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
        assert!(!cache.join("decensored.bin").exists());
        assert!(cache.join("pinned.bin").exists());
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
}

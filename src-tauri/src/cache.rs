use crate::{db::Database, domain::result::CommandResult};

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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEvictionInput { pub max_bytes: u64, pub batch_limit: usize }

fn indexed_cache_bytes(connection: &rusqlite::Connection) -> Result<u64, String> {
    let bytes: i64 = connection.query_row(
        "SELECT COALESCE(SUM(size),0) FROM (SELECT path,MAX(size) AS size FROM cache_entries GROUP BY path)",
        [],
        |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    u64::try_from(bytes).map_err(|_| "Invalid cache size".to_string())
}

fn controlled_cache_path(app_data: &std::path::Path, relative: &str) -> Option<std::path::PathBuf> {
    if !app_data.is_absolute() || relative.contains('\\') { return None; }
    let parts: Vec<&str> = relative.split('/').collect();
    if parts.len() < 3
        || parts[0] != "cache"
        || parts.iter().any(|part| part.is_empty() || *part == "." || *part == ".." || part.contains(':'))
    {
        return None;
    }
    let mut path = app_data.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        if index + 1 < parts.len() {
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => return None,
                Ok(_) | Err(_) => {}
            }
        }
    }
    Some(path)
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
            removed_entries: 0, removed_files: 0, bytes_freed: 0,
            remaining_bytes: before, quota_satisfied: true, has_more: false,
        });
    }

    let candidates = {
        let mut statement = connection.prepare(
            "SELECT path,MAX(size) FROM cache_entries GROUP BY path HAVING MAX(pinned)=0 ORDER BY MIN(last_accessed_at),path LIMIT ?1"
        ).map_err(|error| error.to_string())?;
        let rows = statement.query_map([batch_limit as i64], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        rows
    };

    let mut removed_entries = 0;
    let mut removed_files = 0;
    let mut bytes_freed = 0_u64;
    for (relative, indexed_size) in candidates {
        if indexed_cache_bytes(connection)? <= max_bytes { break; }
        let Some(path) = controlled_cache_path(app_data, &relative) else {
            removed_entries += connection.execute("DELETE FROM cache_entries WHERE path=?1", [&relative])
                .map_err(|error| error.to_string())?;
            continue;
        };
        let quarantine = path.with_file_name(format!(
            ".{}.evicting-{}",
            path.file_name().unwrap_or_default().to_string_lossy(),
            std::process::id(),
        ));
        let isolated = match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
                if quarantine.exists() { return Err("Cache eviction already pending".into()); }
                std::fs::rename(&path, &quarantine).map_err(|_| "Cache file isolation failed".to_string())?;
                true
            }
            Ok(_) | Err(_) => false,
        };
        match connection.execute("DELETE FROM cache_entries WHERE path=?1", [&relative]) {
            Ok(count) => removed_entries += count,
            Err(error) => {
                if isolated { let _ = std::fs::rename(&quarantine, &path); }
                return Err(error.to_string());
            }
        }
        if isolated {
            std::fs::remove_file(&quarantine).map_err(|_| "Cache file removal failed".to_string())?;
            removed_files += 1;
            bytes_freed = bytes_freed.saturating_add(u64::try_from(indexed_size).unwrap_or(0));
        }
    }

    let remaining_bytes = indexed_cache_bytes(connection)?;
    let has_evictable: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM cache_entries GROUP BY path HAVING MAX(pinned)=0 LIMIT 1)",
        [],
        |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    Ok(CacheEvictionResult {
        removed_entries,
        removed_files,
        bytes_freed,
        remaining_bytes,
        quota_satisfied: remaining_bytes <= max_bytes,
        has_more: remaining_bytes > max_bytes && has_evictable,
    })
}

#[tauri::command]
pub fn cache_evict(
    input: CacheEvictionInput,
    app: tauri::AppHandle,
    database: tauri::State<'_, Database>,
) -> CommandResult<CacheEvictionResult> {
    use tauri::Manager;

    let app_data = match app.path().app_data_dir() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("PLATFORM_UNAVAILABLE", "App data directory unavailable", true),
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
        connection.execute_batch(include_str!("../migrations/0001_initial.sql")).unwrap();
        connection.execute_batch(include_str!("../migrations/0002_local_library.sql")).unwrap();
        connection.execute_batch(include_str!("../migrations/0010_cache_path_sharing.sql")).unwrap();
        connection
    }

    fn temp_app_data(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
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

        assert_eq!(result, CacheEvictionResult { removed_entries: 2, removed_files: 1, bytes_freed: 6, remaining_bytes: 14, quota_satisfied: true, has_more: false });
        assert!(!cache.join("old.bin").exists());
        assert!(cache.join("new.bin").exists());
        assert!(cache.join("pinned.bin").exists());
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

        let result = evict_cache_batch(&connection, &app_data, 0, 8).expect("invalid index discarded");

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
        for name in ["one", "two"] { std::fs::write(cache.join(format!("{name}.bin")), b"1234").unwrap(); }
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
}

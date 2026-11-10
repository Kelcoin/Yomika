use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{db::Database, domain::result::CommandResult, settings::get_or_create_device_id};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyExport {
    #[serde(default)]
    history: Vec<LegacyHistory>,
    #[serde(default)]
    watchlist: Vec<LegacyWatchlist>,
    #[serde(default, alias = "dedupe")]
    non_duplicate: Vec<LegacyDedupe>,
    // The unified envelope (Yomika's own export, schemaVersion 1) instead
    // carries merged per-archive items plus tombstone id lists; both shapes
    // share this importer, and the unified fields stay empty for old files.
    #[serde(default)]
    items: Vec<UnifiedItem>,
    #[serde(default)]
    deleted: Vec<String>,
    #[serde(default)]
    reading_list: Vec<UnifiedListEntry>,
    #[serde(default)]
    reading_list_deleted: Vec<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyHistory {
    archive_id: String,
    page_index: i64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyWatchlist {
    archive_id: String,
    deleted: bool,
}
#[derive(Debug, Deserialize)]
struct LegacyDedupe {
    path: String,
    hash: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnifiedItem {
    archive_id: String,
    #[serde(default)]
    page_index: Option<i64>,
    #[serde(default)]
    visited_at: Option<String>,
    #[serde(default)]
    added_at: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnifiedListEntry {
    archive_id: String,
    added_at: String,
}

pub fn import_legacy_export_record(
    connection: &mut Connection,
    scope_id: &str,
    supplied_device_id: Option<&str>,
    serialized: &str,
) -> Result<usize, String> {
    if scope_id.trim().is_empty() || supplied_device_id.is_some_and(|value| value.trim().is_empty())
    {
        return Err("Invalid legacy import scope".to_string());
    }
    let export: LegacyExport =
        serde_json::from_str(serialized).map_err(|_| "Invalid legacy export".to_string())?;
    for record in &export.history {
        if record.archive_id.trim().is_empty() || record.page_index < 0 {
            return Err("Invalid legacy export".to_string());
        }
    }
    for record in &export.watchlist {
        if record.archive_id.trim().is_empty() {
            return Err("Invalid legacy export".to_string());
        }
    }
    for record in &export.non_duplicate {
        if record.path.trim().is_empty() || record.hash.trim().is_empty() {
            return Err("Invalid legacy export".to_string());
        }
    }
    for record in &export.items {
        if record.archive_id.trim().is_empty()
            || record.page_index.is_some_and(|page| page < 0)
        {
            return Err("Invalid legacy export".to_string());
        }
    }
    for id in &export.deleted {
        if id.trim().is_empty() {
            return Err("Invalid legacy export".to_string());
        }
    }
    for record in &export.reading_list {
        if record.archive_id.trim().is_empty() || record.added_at.trim().is_empty() {
            return Err("Invalid legacy export".to_string());
        }
    }
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let device_id = match supplied_device_id {
        Some(value) => value.to_string(),
        None => get_or_create_device_id(&transaction)?,
    };
    // Unified envelope items: one entry may carry reading progress, a watchlist
    // star, or both, depending on which lists the export saw the archive in.
    let mut unified_count = 0usize;
    for record in &export.items {
        if let Some(page_index) = record.page_index {
            let visited_at = record.visited_at.clone().unwrap_or_default();
            transaction.execute(
                "INSERT INTO reading_history (scope_id,archive_id,page_index,visited_at,device_id,revision)
                 VALUES (?1,?2,?3,CASE WHEN ?4='' THEN CURRENT_TIMESTAMP ELSE ?4 END,?5,1)
                 ON CONFLICT(scope_id,archive_id) DO UPDATE SET
                   page_index=MAX(reading_history.page_index,excluded.page_index),
                   visited_at=MAX(reading_history.visited_at,excluded.visited_at),
                   device_id=excluded.device_id, revision=reading_history.revision+1",
                params![scope_id, record.archive_id, page_index, visited_at.trim(), device_id],
            )
            .map_err(|e| e.to_string())?;

            unified_count += 1;
        }
        if let Some(added_at) = record.added_at.as_deref() {
            transaction.execute(
                "INSERT INTO watchlist (scope_id,archive_id,added_at,updated_at,device_id,deleted_at,revision)
                 VALUES (?1,?2,CASE WHEN ?3='' THEN CURRENT_TIMESTAMP ELSE ?3 END,CURRENT_TIMESTAMP,?4,NULL,1)
                 ON CONFLICT(scope_id,archive_id) DO UPDATE SET
                   added_at=excluded.added_at, deleted_at=NULL, device_id=excluded.device_id,
                   revision=watchlist.revision+1, updated_at=CURRENT_TIMESTAMP",
                params![scope_id, record.archive_id, added_at.trim(), device_id],
            )
            .map_err(|e| e.to_string())?;
            unified_count += 1;
        }
    }
    for id in &export.deleted {
        transaction.execute(
            "INSERT INTO watchlist (scope_id,archive_id,added_at,updated_at,device_id,deleted_at,revision)
             VALUES (?1,?2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?3,?4,1)
             ON CONFLICT(scope_id,archive_id) DO UPDATE SET
               deleted_at=excluded.deleted_at, device_id=excluded.device_id,
               revision=watchlist.revision+1, updated_at=CURRENT_TIMESTAMP",
            params![scope_id, id.trim(), device_id, id.trim()],
        )
        .map_err(|e| e.to_string())?;
        unified_count += 1;
    }
    for record in &export.reading_list {
        transaction.execute(
            "INSERT INTO reading_list (scope_id,archive_id,added_at,updated_at,device_id,deleted_at,revision)
             VALUES (?1,?2,?3,CURRENT_TIMESTAMP,?4,NULL,1)
             ON CONFLICT(scope_id,archive_id) DO UPDATE SET
               added_at=excluded.added_at, deleted_at=NULL, device_id=excluded.device_id,
               revision=reading_list.revision+1, updated_at=CURRENT_TIMESTAMP",
            params![scope_id, record.archive_id, record.added_at.trim(), device_id],
        )
        .map_err(|e| e.to_string())?;

        unified_count += 1;
    }
    for id in &export.reading_list_deleted {
        transaction.execute(
            "INSERT INTO reading_list (scope_id,archive_id,added_at,updated_at,device_id,deleted_at,revision)
             VALUES (?1,?2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?3,?4,1)
             ON CONFLICT(scope_id,archive_id) DO UPDATE SET
               deleted_at=excluded.deleted_at, device_id=excluded.device_id,
               revision=reading_list.revision+1, updated_at=CURRENT_TIMESTAMP",
            params![scope_id, id.trim(), device_id, id.trim()],
        )
        .map_err(|e| e.to_string())?;

        unified_count += 1;
    }
    for record in &export.history {
        transaction.execute("INSERT INTO reading_history (scope_id,archive_id,page_index,device_id,revision) VALUES (?1,?2,?3,?4,1) ON CONFLICT(scope_id,archive_id) DO UPDATE SET page_index=MAX(reading_history.page_index,excluded.page_index),device_id=excluded.device_id,revision=reading_history.revision+1,visited_at=CURRENT_TIMESTAMP", params![scope_id, record.archive_id, record.page_index, &device_id]).map_err(|e| e.to_string())?;

    }
    for record in &export.watchlist {
        transaction.execute("INSERT INTO watchlist (scope_id,archive_id,device_id,deleted_at,revision) VALUES (?1,?2,?3,CASE WHEN ?4 THEN NULL ELSE CURRENT_TIMESTAMP END,1) ON CONFLICT(scope_id,archive_id) DO UPDATE SET device_id=excluded.device_id,deleted_at=excluded.deleted_at,revision=watchlist.revision+1,updated_at=CURRENT_TIMESTAMP", params![scope_id, record.archive_id, &device_id, !record.deleted]).map_err(|e| e.to_string())?;
    }
    for record in &export.non_duplicate {
        transaction.execute("INSERT INTO dedup_features (scope_id,path,exact_hash,algorithm_version,size) VALUES (?1,?2,?3,'legacy-import',0) ON CONFLICT(scope_id,path) DO UPDATE SET exact_hash=excluded.exact_hash,algorithm_version=excluded.algorithm_version,updated_at=CURRENT_TIMESTAMP", params![scope_id, record.path, record.hash]).map_err(|e| e.to_string())?;

    }
    let count = unified_count
        + export.history.len()
        + export.watchlist.len()
        + export.non_duplicate.len();
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

pub fn import_legacy_export_for_local_device(
    connection: &mut Connection,
    scope_id: &str,
    serialized: &str,
) -> Result<usize, String> {
    import_legacy_export_record(connection, scope_id, None, serialized)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportInput {
    pub scope_id: String,
    pub serialized: String,
}

/// One normalized slice of the Readoshi worker's v3 export (see
/// `parseWorkerV3Export` in dataMigration.ts): history entries with their
/// visit timestamps, history removals, alive watchlist rows with `addedAt`,
/// and watchlist tombstones with `deletedAt`. The dedupe pairs travel through
/// the existing `dedup_import_readoshi` command instead.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerHistoryEntry {
    pub archive_id: String,
    pub page_index: i64,
    pub visited_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerTombstone {
    pub archive_id: String,
    pub deleted_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerWatchlistEntry {
    pub archive_id: String,
    pub added_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerHistorySection {
    #[serde(default)]
    pub entries: Vec<WorkerHistoryEntry>,
    #[serde(default)]
    pub deleted_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerWatchlistSection {
    #[serde(default)]
    pub entries: Vec<WorkerWatchlistEntry>,
    #[serde(default)]
    pub tombstones: Vec<WorkerTombstone>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerImportInput {
    pub scope_id: String,
    pub history: WorkerHistorySection,
    pub watchlist: WorkerWatchlistSection,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerImportReport {
    pub history: usize,
    pub history_removed: usize,
    pub watchlist: usize,
    pub watchlist_removed: usize,
}

/// Import the Readoshi worker v3 history/watchlist sections for one server
/// scope. The export is an authoritative snapshot. Readoshi's watchlist is its
/// "待看档案" view (its UI labels the watchlist page exactly that), so it maps
/// to Yomika's reading_list, not the watchlist (收藏夹). Alive rows clear their
/// tombstones, and removed history ids delete their rows outright — the local
/// table has no history tombstones, so a delete has to happen now or the
/// visited_at MAX merge would resurrect the row on the next sync.
pub fn import_worker_sections(
    connection: &mut Connection,
    input: WorkerImportInput,
) -> Result<WorkerImportReport, String> {
    if input.scope_id.trim().is_empty() {
        return Err("Invalid worker import scope".to_string());
    }
    for record in &input.history.entries {
        if record.archive_id.trim().is_empty()
            || record.page_index < 0
            || record.visited_at.trim().is_empty()
        {
            return Err("Invalid worker export".to_string());
        }
    }
    for id in &input.history.deleted_ids {
        if id.trim().is_empty() {
            return Err("Invalid worker export".to_string());
        }
    }
    for record in &input.watchlist.entries {
        if record.archive_id.trim().is_empty() || record.added_at.trim().is_empty() {
            return Err("Invalid worker export".to_string());
        }
    }
    for record in &input.watchlist.tombstones {
        if record.archive_id.trim().is_empty() || record.deleted_at.trim().is_empty() {
            return Err("Invalid worker export".to_string());
        }
    }
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let device_id = get_or_create_device_id(&transaction)?;
    let mut history_removed = 0;
    for id in &input.history.deleted_ids {
        history_removed += transaction
            .execute(
                "DELETE FROM reading_history WHERE scope_id=?1 AND archive_id=?2",
                params![input.scope_id, id.trim()],
            )
            .map_err(|e| e.to_string())?;
    }
    let mut history_imported = 0;
    for record in &input.history.entries {
        // Removals win over same-id entries: the export's tombstones are the
        // authoritative state, and a journaled upsert would resurrect the
        // deleted row remotely on the next sync.
        if input
            .history
            .deleted_ids
            .iter()
            .any(|id| id.trim() == record.archive_id.trim())
        {
            continue;
        }
        let visited_at = record.visited_at.trim();
        transaction.execute(
            "INSERT INTO reading_history (scope_id,archive_id,page_index,visited_at,device_id,revision)
             VALUES (?1,?2,?3,?4,?5,1)
             ON CONFLICT(scope_id,archive_id) DO UPDATE SET
               page_index=MAX(reading_history.page_index,excluded.page_index),
               visited_at=MAX(reading_history.visited_at,excluded.visited_at),
               device_id=excluded.device_id, revision=reading_history.revision+1",
            params![input.scope_id, record.archive_id, record.page_index, visited_at, device_id],
        )
        .map_err(|e| e.to_string())?;

        history_imported += 1;
    }
    // Readoshi's watchlist is its 待看 view (see the doc comment), so the
    // worker's watchlist section lands in the reading_list table. The journal
    // type is the sync vocabulary's `watchlist` — the table name is not an
    // object type: writing `reading_list` here left a name no exporter knows,
    // so everything imported this way was invisible to sync and to the
    // data export/import (the shelves showed it, nothing carried it).
    for record in &input.watchlist.entries {
        let added_at = record.added_at.trim();
        transaction.execute(
            "INSERT INTO reading_list (scope_id,archive_id,added_at,updated_at,device_id,deleted_at,revision)
             VALUES (?1,?2,?3,CURRENT_TIMESTAMP,?4,NULL,1)
             ON CONFLICT(scope_id,archive_id) DO UPDATE SET
               added_at=excluded.added_at, deleted_at=NULL, device_id=excluded.device_id,
               revision=reading_list.revision+1, updated_at=CURRENT_TIMESTAMP",
            params![input.scope_id, record.archive_id, added_at, device_id],
        )
        .map_err(|e| e.to_string())?;

    }
    for record in &input.watchlist.tombstones {
        let deleted_at = record.deleted_at.trim();
        // added_at is NOT NULL locally; a tombstone-only export entry reuses
        // its deletedAt there, while the conflict branch keeps the original.
        transaction.execute(
            "INSERT INTO reading_list (scope_id,archive_id,added_at,updated_at,device_id,deleted_at,revision)
             VALUES (?1,?2,?3,CURRENT_TIMESTAMP,?4,?5,1)
             ON CONFLICT(scope_id,archive_id) DO UPDATE SET
               deleted_at=excluded.deleted_at, device_id=excluded.device_id,
               revision=reading_list.revision+1, updated_at=CURRENT_TIMESTAMP",
            params![input.scope_id, record.archive_id, deleted_at, device_id, deleted_at],
        )
        .map_err(|e| e.to_string())?;

    }
    let report = WorkerImportReport {
        history: history_imported,
        history_removed,
        watchlist: input.watchlist.entries.len(),
        watchlist_removed: input.watchlist.tombstones.len(),
    };
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(report)
}

#[tauri::command(async)]
pub fn import_worker_export(
    input: WorkerImportInput,
    database: State<'_, Database>,
) -> CommandResult<WorkerImportReport> {
    let mut connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match import_worker_sections(&mut connection, input) {
        Ok(report) => CommandResult::success(report),
        Err(error) => CommandResult::failure("INVALID_RESPONSE", error, false),
    }
}

#[tauri::command(async)]
pub fn import_legacy_export(
    input: LegacyImportInput,
    database: State<'_, Database>,
) -> CommandResult<usize> {
    let mut connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match import_legacy_export_for_local_device(&mut connection, &input.scope_id, &input.serialized)
    {
        Ok(count) => CommandResult::success(count),
        Err(error) => CommandResult::failure("INVALID_RESPONSE", error, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        for migration in [
            "0001_initial.sql",
            "0002_local_library.sql",
            "0004_watchlist.sql",
            "0005_reading_history.sql",
            "0008_dedup_features.sql",
            "0017_reading_list.sql",
        ] {
            c.execute_batch(match migration {
                "0001_initial.sql" => include_str!("../../migrations/0001_initial.sql"),
                "0002_local_library.sql" => include_str!("../../migrations/0002_local_library.sql"),
                "0004_watchlist.sql" => include_str!("../../migrations/0004_watchlist.sql"),
                "0005_reading_history.sql" => {
                    include_str!("../../migrations/0005_reading_history.sql")
                }
                "0017_reading_list.sql" => include_str!("../../migrations/0017_reading_list.sql"),
                _ => include_str!("../../migrations/0008_dedup_features.sql"),
            })
            .unwrap();
        }
        c
    }
    #[test]
    fn import_is_atomic_and_writes_allowed_records_only() {
        let mut c = db();
        let count = import_legacy_export_record(
            &mut c,
            "scope-a",
            Some("device-a"),
            r#"{"history":[{"archiveId":"a1","pageIndex":4}],"watchlist":[{"archiveId":"a2","deleted":false}],"nonDuplicate":[{"path":"x.cbz","hash":"abc"}],"apiKey":"secret"}"#,
        ).unwrap();
        assert_eq!(count, 3);
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM reading_history", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM dedup_features", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn legacy_file_shape_still_imports() {
        let mut c = db();
        let count = import_legacy_export_record(
            &mut c,
            "scope-a",
            Some("device-a"),
            r#"{"history":[{"archiveId":"a1","pageIndex":4}],"watchlist":[{"archiveId":"a2","deleted":false}]}"#,
        )
        .unwrap();
        assert_eq!(count, 2);
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM reading_history", [], |row| row.get::<_, i64>(0)).unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM watchlist", [], |row| row.get::<_, i64>(0)).unwrap(),
            1
        );
    }
}

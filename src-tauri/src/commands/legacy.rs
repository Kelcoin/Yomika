use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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

fn append_import_journal(
    transaction: &Transaction<'_>,
    scope_id: &str,
    object_id: &str,
    object_type: &str,
    operation: &str,
    device_id: &str,
    logical_clock: i64,
    payload: serde_json::Value,
) -> Result<(), String> {
    let payload_json = payload.to_string();
    let payload_hash = format!("{:x}", Sha256::digest(payload_json.as_bytes()));
    transaction
        .execute(
            "INSERT INTO sync_journal (
            scope_id,object_id,object_type,operation,device_id,
            logical_clock,payload_hash,payload_json
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                scope_id,
                object_id,
                object_type,
                operation,
                device_id,
                logical_clock,
                payload_hash,
                payload_json
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
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
            let (stored_page, stored_visited, revision): (i64, String, i64) = transaction.query_row(
                "SELECT page_index,visited_at,revision FROM reading_history WHERE scope_id=?1 AND archive_id=?2",
                params![scope_id, record.archive_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| error.to_string())?;
            append_import_journal(
                &transaction,
                scope_id,
                &format!("{scope_id}/{}", record.archive_id),
                "history",
                "upsert",
                &device_id,
                revision,
                serde_json::json!({
                    "archiveId": record.archive_id,
                    "pageIndex": stored_page,
                    "visitedAt": stored_visited,
                }),
            )?;
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
        let revision: i64 = transaction
            .query_row(
                "SELECT revision FROM reading_list WHERE scope_id=?1 AND archive_id=?2",
                params![scope_id, record.archive_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        append_import_journal(
            &transaction,
            scope_id,
            &format!("{scope_id}/{}", record.archive_id),
            "watchlist",
            "upsert",
            &device_id,
            revision,
            serde_json::json!({ "archiveId": record.archive_id, "deleted": false }),
        )?;
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
        let revision: i64 = transaction
            .query_row(
                "SELECT revision FROM reading_list WHERE scope_id=?1 AND archive_id=?2",
                params![scope_id, id.trim()],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        append_import_journal(
            &transaction,
            scope_id,
            &format!("{scope_id}/{}", id.trim()),
            "watchlist",
            "delete",
            &device_id,
            revision,
            serde_json::json!({ "archiveId": id.trim(), "deleted": true }),
        )?;
        unified_count += 1;
    }
    for record in &export.history {
        transaction.execute("INSERT INTO reading_history (scope_id,archive_id,page_index,device_id,revision) VALUES (?1,?2,?3,?4,1) ON CONFLICT(scope_id,archive_id) DO UPDATE SET page_index=MAX(reading_history.page_index,excluded.page_index),device_id=excluded.device_id,revision=reading_history.revision+1,visited_at=CURRENT_TIMESTAMP", params![scope_id, record.archive_id, record.page_index, &device_id]).map_err(|e| e.to_string())?;
        let (page_index, visited_at, revision): (i64, String, i64) = transaction.query_row(
            "SELECT page_index,visited_at,revision FROM reading_history WHERE scope_id=?1 AND archive_id=?2",
            params![scope_id, record.archive_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).map_err(|error| error.to_string())?;
        append_import_journal(
            &transaction,
            scope_id,
            &format!("{scope_id}/{}", record.archive_id),
            "history",
            "upsert",
            &device_id,
            revision,
            serde_json::json!({
                "archiveId": record.archive_id,
                "pageIndex": page_index,
                "visitedAt": visited_at,
            }),
        )?;
    }
    for record in &export.watchlist {
        transaction.execute("INSERT INTO watchlist (scope_id,archive_id,device_id,deleted_at,revision) VALUES (?1,?2,?3,CASE WHEN ?4 THEN NULL ELSE CURRENT_TIMESTAMP END,1) ON CONFLICT(scope_id,archive_id) DO UPDATE SET device_id=excluded.device_id,deleted_at=excluded.deleted_at,revision=watchlist.revision+1,updated_at=CURRENT_TIMESTAMP", params![scope_id, record.archive_id, &device_id, !record.deleted]).map_err(|e| e.to_string())?;
    }
    for record in &export.non_duplicate {
        transaction.execute("INSERT INTO dedup_features (scope_id,path,exact_hash,algorithm_version,size) VALUES (?1,?2,?3,'legacy-import',0) ON CONFLICT(scope_id,path) DO UPDATE SET exact_hash=excluded.exact_hash,algorithm_version=excluded.algorithm_version,updated_at=CURRENT_TIMESTAMP", params![scope_id, record.path, record.hash]).map_err(|e| e.to_string())?;
        let object_id = format!("{scope_id}/{}", record.path);
        let logical_clock: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(logical_clock),0)+1 FROM sync_journal WHERE scope_id=?1 AND object_id=?2",
            params![scope_id, object_id],
            |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        append_import_journal(
            &transaction,
            scope_id,
            &object_id,
            "legacy_non_duplicate",
            "upsert",
            &device_id,
            logical_clock,
            serde_json::json!({ "path": record.path, "hash": record.hash }),
        )?;
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
        let (page_index, stored_visited_at, revision): (i64, String, i64) = transaction.query_row(
            "SELECT page_index,visited_at,revision FROM reading_history WHERE scope_id=?1 AND archive_id=?2",
            params![input.scope_id, record.archive_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;
        append_import_journal(
            &transaction,
            &input.scope_id,
            &format!("{}/{}", input.scope_id, record.archive_id),
            "history",
            "upsert",
            &device_id,
            revision,
            serde_json::json!({
                "archiveId": record.archive_id,
                "pageIndex": page_index,
                "visitedAt": stored_visited_at,
            }),
        )?;
        history_imported += 1;
    }
    // Readoshi's watchlist is its 待看 view (see the doc comment), so the
    // worker's watchlist section lands in the reading_list table.
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
        let revision: i64 = transaction
            .query_row(
                "SELECT revision FROM reading_list WHERE scope_id=?1 AND archive_id=?2",
                params![input.scope_id, record.archive_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        append_import_journal(
            &transaction,
            &input.scope_id,
            &format!("{}/{}", input.scope_id, record.archive_id),
            "reading_list",
            "upsert",
            &device_id,
            revision,
            serde_json::json!({ "archiveId": record.archive_id, "deleted": false }),
        )?;
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
        let revision: i64 = transaction
            .query_row(
                "SELECT revision FROM reading_list WHERE scope_id=?1 AND archive_id=?2",
                params![input.scope_id, record.archive_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        append_import_journal(
            &transaction,
            &input.scope_id,
            &format!("{}/{}", input.scope_id, record.archive_id),
            "reading_list",
            "delete",
            &device_id,
            revision,
            serde_json::json!({ "archiveId": record.archive_id, "deleted": true }),
        )?;
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
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
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
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
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
            "0003_sync_journal.sql",
            "0004_watchlist.sql",
            "0005_reading_history.sql",
            "0008_dedup_features.sql",
            "0017_reading_list.sql",
        ] {
            c.execute_batch(match migration {
                "0001_initial.sql" => include_str!("../../migrations/0001_initial.sql"),
                "0002_local_library.sql" => include_str!("../../migrations/0002_local_library.sql"),
                "0003_sync_journal.sql" => include_str!("../../migrations/0003_sync_journal.sql"),
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
    fn imported_records_enter_pending_sync_journal_in_same_transaction() {
        let mut c = db();
        import_legacy_export_record(
            &mut c,
            "scope-a",
            Some("device-a"),
            r#"{"history":[{"archiveId":"a1","pageIndex":4}],"watchlist":[{"archiveId":"a2","deleted":true}],"nonDuplicate":[{"path":"x.cbz","hash":"abc"}]}"#,
        ).unwrap();

        let mut statement = c.prepare(
            "SELECT object_id,object_type,operation,device_id,logical_clock,payload_hash,payload_json,status FROM sync_journal ORDER BY sequence"
        ).unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        // 历史 + 待看两类可同步对象；收藏夹（导入时叫 watchlist）不进日志。
        assert_eq!(rows.len(), 2);
        assert_eq!(
            (&rows[0].0, &rows[0].1, &rows[0].2, &rows[0].3, rows[0].4, &rows[0].7),
            (
                &"scope-a/a1".to_string(),
                &"history".to_string(),
                &"upsert".to_string(),
                &"device-a".to_string(),
                1,
                &"pending".to_string()
            )
        );
        // 收藏夹那行已经不写日志了（它是服务器收藏分类的镜像），剩下非重复标记。
        assert_eq!(
            (&rows[1].0, &rows[1].1, &rows[1].2),
            (
                &"scope-a/x.cbz".to_string(),
                &"legacy_non_duplicate".to_string(),
                &"upsert".to_string()
            )
        );
        for row in rows {
            let payload: serde_json::Value = serde_json::from_str(&row.6).unwrap();
            assert!(payload.is_object());
            let expected = format!(
                "{:x}",
                <sha2::Sha256 as sha2::Digest>::digest(row.6.as_bytes())
            );
            assert_eq!(row.5, expected);
        }
    }

    #[test]
    fn journal_failure_rolls_back_imported_records() {
        let mut c = db();
        c.execute_batch(
            "CREATE TRIGGER reject_legacy_journal BEFORE INSERT ON sync_journal
             BEGIN SELECT RAISE(ABORT, 'journal rejected'); END;",
        )
        .unwrap();

        let result = import_legacy_export_record(
            &mut c,
            "scope-a",
            Some("device-a"),
            r#"{"history":[{"archiveId":"a1","pageIndex":4}]}"#,
        );

        assert!(result.is_err());
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM reading_history", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM sync_journal", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn local_import_uses_stable_internal_device_identity() {
        let mut c = db();
        c.execute(
            "INSERT INTO settings (key,value_json) VALUES ('sync.device_id','\"device-stable\"')",
            [],
        )
        .unwrap();

        import_legacy_export_for_local_device(
            &mut c,
            "scope-a",
            r#"{"history":[{"archiveId":"a1","pageIndex":4}]}"#,
        )
        .unwrap();

        let row_device: String = c.query_row(
            "SELECT device_id FROM reading_history WHERE scope_id='scope-a' AND archive_id='a1'",
            [],
            |row| row.get(0),
        ).unwrap();
        let journal_device: String = c
            .query_row(
                "SELECT device_id FROM sync_journal WHERE scope_id='scope-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            (row_device.as_str(), journal_device.as_str()),
            ("device-stable", "device-stable")
        );
    }

    #[test]
    fn worker_import_upserts_history_and_watchlist_with_timestamps() {
        let mut c = db();
        c.execute(
            "INSERT INTO reading_history (scope_id,archive_id,page_index,visited_at,device_id,revision)
             VALUES ('scope-a','a1',2,'2026-01-01 00:00:00','device-x',1)",
            [],
        )
        .unwrap();
        let report = import_worker_sections(
            &mut c,
            WorkerImportInput {
                scope_id: "scope-a".into(),
                history: WorkerHistorySection {
                    entries: vec![
                        WorkerHistoryEntry { archive_id: "a1".into(), page_index: 8, visited_at: "2026-09-13 10:00:00.000".into() },
                        WorkerHistoryEntry { archive_id: "a2".into(), page_index: 1, visited_at: "2026-09-12 09:00:00.000".into() },
                    ],
                    deleted_ids: vec!["a2".into()],
                },
                watchlist: WorkerWatchlistSection {
                    entries: vec![WorkerWatchlistEntry { archive_id: "w1".into(), added_at: "2026-09-01 08:00:00.000".into() }],
                    tombstones: vec![WorkerTombstone { archive_id: "w2".into(), deleted_at: "2026-09-02 08:00:00.000".into() }],
                },
            },
        )
        .unwrap();
        assert_eq!(
            (report.history, report.history_removed, report.watchlist, report.watchlist_removed),
            // a2 appears in both lists: removals run first (nothing to delete
            // yet) and the upsert is skipped, so the row never lands at all.
            (1, 0, 1, 1)
        );
        // The visited_at MAX merge keeps the newer visit for a known row.
        let (page, visited): (i64, String) = c.query_row(
            "SELECT page_index,visited_at FROM reading_history WHERE scope_id='scope-a' AND archive_id='a1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
        assert_eq!((page, visited.as_str()), (8, "2026-09-13 10:00:00.000"));
        // A removed history id deletes its row outright.
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM reading_history WHERE archive_id='a2'", [], |row| row.get::<_, i64>(0)).unwrap(),
            0
        );
        let (added, deleted): (String, Option<String>) = c.query_row(
            "SELECT added_at,deleted_at FROM reading_list WHERE scope_id='scope-a' AND archive_id='w1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
        assert_eq!(added.as_str(), "2026-09-01 08:00:00.000");
        assert!(deleted.is_none());
        let tombstone: String = c.query_row(
            "SELECT deleted_at FROM reading_list WHERE scope_id='scope-a' AND archive_id='w2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
        assert_eq!(tombstone.as_str(), "2026-09-02 08:00:00.000");
        // Journal entries follow the shared payload/hash rules so WebDAV sync
        // propagates the import like any local mutation. 这份样例里只有历史是
        // 可同步对象：它的 watchlist 段是收藏夹（服务器分类的镜像，不进日志），
        // 待看段才是 watchlist 词汇。
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM sync_journal WHERE scope_id='scope-a' AND object_type='history' AND operation='upsert'", [], |row| row.get::<_, i64>(0)).unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM sync_journal WHERE scope_id='scope-a' AND object_type='watchlist' AND operation='delete'", [], |row| row.get::<_, i64>(0)).unwrap(),
            0,
            "收藏夹的导入不写同步日志"
        );
    }

    #[test]
    fn worker_import_rejects_malformed_rows_atomically() {
        let mut c = db();
        c.execute(
            "INSERT INTO reading_history (scope_id,archive_id,page_index,visited_at,device_id,revision) VALUES ('scope-a','keep',1,'2026-01-01 00:00:00','device-x',1)",
            [],
        )
        .unwrap();
        let result = import_worker_sections(
            &mut c,
            WorkerImportInput {
                scope_id: "scope-a".into(),
                history: WorkerHistorySection {
                    entries: vec![WorkerHistoryEntry { archive_id: "   ".into(), page_index: 1, visited_at: "2026-09-13 10:00:00.000".into() }],
                    deleted_ids: vec![],
                },
                watchlist: WorkerWatchlistSection { entries: vec![], tombstones: vec![] },
            },
        );
        assert!(result.is_err());
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM sync_journal", [], |row| row.get::<_, i64>(0)).unwrap(),
            0
        );
    }

    /// The unified envelope Yomika exports must import back — the 0-item
    /// round-trip regression: the envelope's items/deleted/readingList were
    /// silently ignored by the legacy-only deserializer.
    #[test]
    fn unified_envelope_round_trips_through_the_legacy_importer() {
        let mut c = db();
        let serialized = r#"{
            "schemaVersion": 1,
            "exportedAt": "2026-09-13T12:00:00.000Z",
            "scopeId": "scope-a",
            "items": [
                {"archiveId": "a1", "pageIndex": 4, "visitedAt": "2026-09-01 10:00:00", "addedAt": "2026-08-30 10:00:00"},
                {"archiveId": "a2", "addedAt": "2026-08-29 10:00:00"}
            ],
            "deleted": ["gone"],
            "lastSync": 0,
            "readingList": [{"archiveId": "r1", "addedAt": "2026-09-05 13:51:56"}],
            "readingListDeleted": ["rgone"]
        }"#;
        let count = import_legacy_export_record(&mut c, "scope-a", Some("device-a"), serialized).unwrap();
        // a1 写阅读+收藏、a2 收藏、gone 收藏墓碑、r1 待看、rgone 待看墓碑。
        assert_eq!(count, 6);
        let (page, visited): (i64, String) = c.query_row(
            "SELECT page_index,visited_at FROM reading_history WHERE scope_id='scope-a' AND archive_id='a1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
        assert_eq!((page, visited.as_str()), (4, "2026-09-01 10:00:00"));
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM watchlist WHERE archive_id='a2' AND deleted_at IS NULL", [], |row| row.get::<_, i64>(0)).unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM watchlist WHERE archive_id='gone' AND deleted_at IS NOT NULL", [], |row| row.get::<_, i64>(0)).unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM reading_list WHERE archive_id='r1' AND deleted_at IS NULL", [], |row| row.get::<_, i64>(0)).unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM reading_list WHERE archive_id='rgone' AND deleted_at IS NOT NULL", [], |row| row.get::<_, i64>(0)).unwrap(),
            1
        );
        // journal 覆盖两类可同步对象（历史、待看）；收藏夹不进同步日志。
        assert_eq!(
            c.query_row("SELECT COUNT(DISTINCT object_type) FROM sync_journal WHERE scope_id='scope-a'", [], |row| row.get::<_, i64>(0)).unwrap(),
            2
        );
    }

    /// Old Readoshi file exports (history/watchlist/nonDuplicate keys) keep
    /// importing unchanged next to the unified fields.
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

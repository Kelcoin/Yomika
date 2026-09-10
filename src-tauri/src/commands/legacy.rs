use rusqlite::{params, Connection, Transaction};
use serde::Deserialize;
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
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let device_id = match supplied_device_id {
        Some(value) => value.to_string(),
        None => get_or_create_device_id(&transaction)?,
    };
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
        let revision: i64 = transaction
            .query_row(
                "SELECT revision FROM watchlist WHERE scope_id=?1 AND archive_id=?2",
                params![scope_id, record.archive_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        append_import_journal(
            &transaction,
            scope_id,
            &format!("{scope_id}/{}", record.archive_id),
            "watchlist",
            if record.deleted { "delete" } else { "upsert" },
            &device_id,
            revision,
            serde_json::json!({
                "archiveId": record.archive_id,
                "deleted": record.deleted,
            }),
        )?;
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
            "dedupe",
            "upsert",
            &device_id,
            logical_clock,
            serde_json::json!({ "path": record.path, "hash": record.hash }),
        )?;
    }
    let count = export.history.len() + export.watchlist.len() + export.non_duplicate.len();
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

#[tauri::command]
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
        ] {
            c.execute_batch(match migration {
                "0001_initial.sql" => include_str!("../../migrations/0001_initial.sql"),
                "0002_local_library.sql" => include_str!("../../migrations/0002_local_library.sql"),
                "0003_sync_journal.sql" => include_str!("../../migrations/0003_sync_journal.sql"),
                "0004_watchlist.sql" => include_str!("../../migrations/0004_watchlist.sql"),
                "0005_reading_history.sql" => {
                    include_str!("../../migrations/0005_reading_history.sql")
                }
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

        assert_eq!(rows.len(), 3);
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
        assert_eq!(
            (&rows[1].0, &rows[1].1, &rows[1].2),
            (
                &"scope-a/a2".to_string(),
                &"watchlist".to_string(),
                &"delete".to_string()
            )
        );
        assert_eq!(
            (&rows[2].0, &rows[2].1, &rows[2].2),
            (
                &"scope-a/x.cbz".to_string(),
                &"dedupe".to_string(),
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
}

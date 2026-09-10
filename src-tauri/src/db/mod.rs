use std::{fs, path::Path, sync::Mutex};

use rusqlite::Connection;
use tauri::AppHandle;

pub struct Database {
    pub connection: Mutex<Connection>,
}

impl Database {
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let path = crate::data_paths::data_dir(app)
            .map_err(|error| error.to_string())?
            .join("yomika.sqlite3");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        Self::open_path(path)
    }

    fn open_path(path: impl AsRef<Path>) -> Result<Self, String> {
        let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
            .map_err(|error| error.to_string())?;
        run_migrations(&mut connection)?;
        crate::commands::library::recover_interrupted_tasks(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
}

fn run_migrations(connection: &mut Connection) -> Result<(), String> {
    const MIGRATIONS: &[(i64, &str)] = &[
        (1, include_str!("../../migrations/0001_initial.sql")),
        (2, include_str!("../../migrations/0002_local_library.sql")),
        (3, include_str!("../../migrations/0003_sync_journal.sql")),
        (4, include_str!("../../migrations/0004_watchlist.sql")),
        (5, include_str!("../../migrations/0005_reading_history.sql")),
        (6, include_str!("../../migrations/0006_webdav_accounts.sql")),
        (7, include_str!("../../migrations/0007_eh_accounts.sql")),
        (8, include_str!("../../migrations/0008_dedup_features.sql")),
        (9, include_str!("../../migrations/0009_inference_jobs.sql")),
        (
            10,
            include_str!("../../migrations/0010_cache_path_sharing.sql"),
        ),
        (11, include_str!("../../migrations/0011_task_runtime.sql")),
        (
            12,
            include_str!("../../migrations/0012_archive_categories.sql"),
        ),
        (
            13,
            include_str!("../../migrations/0013_unified_image_cache.sql"),
        ),
        (
            14,
            include_str!("../../migrations/0014_cache_archive_scope.sql"),
        ),
        (15, include_str!("../../migrations/0015_dedup_sessions.sql")),
        (
            16,
            include_str!("../../migrations/0016_archive_added_at.sql"),
        ),
        (17, include_str!("../../migrations/0017_reading_list.sql")),
        (18, include_str!("../../migrations/0018_search_presets.sql")),
        (
            19,
            include_str!("../../migrations/0019_reading_progress_cover_alone.sql"),
        ),
        (
            20,
            include_str!("../../migrations/0020_eh_health_cache.sql"),
        ),
    ];
    let current: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;

    for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version > current) {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(sql)
            .map_err(|error| error.to_string())?;
        transaction
            .pragma_update(None, "user_version", version)
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn open_path_applies_all_migrations_and_can_reopen_idempotently() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "yomika-migration-{}-{unique}.sqlite3",
            std::process::id()
        ));

        let database = Database::open_path(&path).expect("first database open");
        {
            let connection = database.connection.lock().expect("database lock");
            let version: i64 = connection
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .expect("schema version");
            let foreign_keys: i64 = connection
                .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                .expect("foreign key setting");
            let server_table: String = connection
                .query_row(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'servers'",
                    [],
                    |row| row.get(0),
                )
                .expect("servers table");
            let webdav_table: String = connection
                .query_row(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webdav_accounts'",
                    [],
                    |row| row.get(0),
                )
                .expect("webdav accounts table");
            let archive_categories_table: String = connection
                .query_row(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archive_categories'",
                    [],
                    |row| row.get(0),
                )
                .expect("archive categories table");
            let archive_categories_index: String = connection
                .query_row(
                    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'archive_categories_lookup_idx'",
                    [],
                    |row| row.get(0),
                )
                .expect("archive categories index");
            let cache_archive_column: String = connection
                .query_row(
                    "SELECT name FROM pragma_table_info('cache_entries') WHERE name='source_archive'",
                    [],
                    |row| row.get(0),
                )
                .expect("cache archive column");
            let cache_archive_index: String = connection
                .query_row(
                    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'cache_entries_archive_idx'",
                    [],
                    |row| row.get(0),
                )
                .expect("cache archive index");
            let eh_health_columns: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('eh_accounts') WHERE name IN ('gp','credits','hath','exhentai_access')",
                    [],
                    |row| row.get(0),
                )
                .expect("eh health columns");
            let mut archive_categories_fk_statement = connection
                .prepare("PRAGMA foreign_key_list(archive_categories)")
                .expect("archive categories foreign keys");
            let mut archive_categories_fk_rows = archive_categories_fk_statement
                .query([])
                .expect("archive categories foreign key rows");
            let mut archive_categories_fk_count = 0_i64;
            while archive_categories_fk_rows
                .next()
                .expect("archive categories foreign key row")
                .is_some()
            {
                archive_categories_fk_count += 1;
            }
            assert_eq!(
                (
                    version,
                    foreign_keys,
                    server_table.as_str(),
                    webdav_table.as_str(),
                    archive_categories_table.as_str(),
                    archive_categories_index.as_str(),
                    archive_categories_fk_count,
                    cache_archive_column.as_str(),
                    cache_archive_index.as_str(),
                    eh_health_columns,
                ),
                (
                    20,
                    1,
                    "servers",
                    "webdav_accounts",
                    "archive_categories",
                    "archive_categories_lookup_idx",
                    2,
                    "source_archive",
                    "cache_entries_archive_idx",
                    4
                )
            );
            connection.execute(
                "INSERT INTO tasks (id,kind,label,status,progress,cancelable,retryable) VALUES ('restart-task','download','Restart','running',0.4,1,1)",
                [],
            ).expect("interrupted task fixture");
        }
        drop(database);

        let reopened = Database::open_path(&path).expect("second database open");
        let migration_count: i64 = reopened
            .connection
            .lock()
            .expect("database lock")
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("migration count");
        assert_eq!(migration_count, 19);
        let recovered_status: String = reopened
            .connection
            .lock()
            .expect("database lock")
            .query_row(
                "SELECT status FROM tasks WHERE id='restart-task'",
                [],
                |row| row.get(0),
            )
            .expect("recovered task");
        assert_eq!(recovered_status, "queued");
        drop(reopened);
        std::fs::remove_file(path).expect("remove test database");
    }
}

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

pub struct Database {
    pub connection: Mutex<Connection>,
}

impl Database {
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let path = resolve_database_path(app_data)?;
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

fn resolve_database_path(app_data: PathBuf) -> Result<PathBuf, String> {
    if cfg!(all(target_os = "windows", not(debug_assertions))) {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let parent = executable
            .parent()
            .ok_or_else(|| "Executable directory unavailable".to_string())?;
        return Ok(parent.join("data").join("yomika.sqlite3"));
    }
    Ok(app_data.join("yomika.sqlite3"))
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn default_database_path_stays_under_app_data_in_tests() {
        let path = resolve_database_path(PathBuf::from("C:/Users/test/AppData/Yomika")).unwrap();
        assert_eq!(path, PathBuf::from("C:/Users/test/AppData/Yomika/yomika.sqlite3"));
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
        (10, include_str!("../../migrations/0010_cache_path_sharing.sql")),
        (11, include_str!("../../migrations/0011_task_runtime.sql")),
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
            assert_eq!(
                (
                    version,
                    foreign_keys,
                    server_table.as_str(),
                    webdav_table.as_str()
                ),
            (11, 1, "servers", "webdav_accounts")
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
        assert_eq!(migration_count, 11);
        let recovered_status: String = reopened.connection.lock().expect("database lock")
            .query_row("SELECT status FROM tasks WHERE id='restart-task'", [], |row| row.get(0))
            .expect("recovered task");
        assert_eq!(recovered_status, "queued");
        drop(reopened);
        std::fs::remove_file(path).expect("remove test database");
    }
}

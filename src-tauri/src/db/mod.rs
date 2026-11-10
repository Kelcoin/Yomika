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

    pub(crate) fn open_path(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref();
        let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
            .map_err(|error| error.to_string())?;
        run_migrations(&mut connection, path)?;
        crate::commands::library::recover_interrupted_tasks(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
}

/// 升级前那一份副本落在哪儿：`yomika.sqlite3` ⇒ `yomika.sqlite3.pre-v10.bak`。
///
/// 名字里带档位，是为了不打开它也知道它对应哪一版；同一档只留一份（`run_migrations` 见到
/// 文件在就不再复制），否则每次启动都要把几百兆的库再拷一遍。
fn backup_path_for(path: &Path, current: i64) -> std::path::PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "yomika.sqlite3".to_string());
    path.with_file_name(format!("{name}.pre-v{current}.bak"))
}

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
    (
        21,
        include_str!("../../migrations/0021_sync_pull_state.sql"),
    ),
    (22, include_str!("../../migrations/0022_eh_my_tags.sql")),
    (
        23,
        include_str!("../../migrations/0023_servers_enabled.sql"),
    ),
    (24, include_str!("../../migrations/0024_sync_scope.sql")),
    (
        25,
        include_str!("../../migrations/0025_webdav_last_sync.sql"),
    ),
    (26, include_str!("../../migrations/0026_sync_accounts.sql")),
    (
        27,
        include_str!("../../migrations/0027_sync_account_active.sql"),
    ),
    (28, include_str!("../../migrations/0028_local_archives.sql")),
    (
        29,
        include_str!("../../migrations/0029_local_archive_metadata.sql"),
    ),
    (
        30,
        include_str!("../../migrations/0030_hot_path_indexes.sql"),
    ),
    (
        31,
        include_str!("../../migrations/0031_cache_quota_covering_index.sql"),
    ),
    (32, include_str!("../../migrations/0032_dedup_manual_save.sql")),
    (33, include_str!("../../migrations/0033_retire_cloud_sync.sql")),
];

fn run_migrations(connection: &mut Connection, path: &Path) -> Result<(), String> {
    let current: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;

    // 先把升级前那一份原样留在旁边，再动手。迁移脚本只往前写，升级本身不可逆，
    // 而用户的数据目录里没有第二个副本 —— 所以备份失败就不升：宁可这一次起不来，
    // 也不要悄悄升上去之后回不去。
    let last = MIGRATIONS.last().map(|(version, _)| *version).unwrap_or(0);
    if current > 0 && current < last {
        let backup = backup_path_for(path, current);
        if !backup.exists() {
            vacuum_into(connection, &backup).map_err(|error| {
                format!(
                    "升级前没能把数据库备份到 {}：{error}；这一版没动这个库",
                    backup.display()
                )
            })?;
        }
    }

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

/// 用 `VACUUM INTO` 复制一份：出来的是一份独立的库文件（不是 WAL 的一条尾巴），
/// 不打开它也能按 SQLite 文件头读出 `user_version` —— 冷启动那一侧就是靠这一点，
/// 在没有 SQLite 库的机器上核对「备下来的还是升级前那一版」。
fn vacuum_into(connection: &Connection, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    connection
        .execute("VACUUM INTO ?1", [target.to_string_lossy().into_owned()])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::OpenFlags;

    use super::*;

    #[test]
    fn cache_quota_uses_a_covering_index_after_migrations() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open_path(directory.path().join("quota.sqlite3")).unwrap();
        let connection = database.connection.lock().unwrap();
        let mut statement = connection.prepare("EXPLAIN QUERY PLAN SELECT COALESCE(SUM(size),0) FROM (SELECT path,MAX(size) AS size FROM cache_entries GROUP BY path)").unwrap();
        let plan = statement.query_map([], |row| row.get::<_, String>(3)).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap().join("\n");
        assert!(plan.contains("COVERING INDEX cache_entries_path_size_idx"), "{plan}");
    }

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
            let sync_table: String = connection
                .query_row(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reading_resets'",
                    [],
                    |row| row.get(0),
                )
                .expect("local reading reset table");
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
            // 本地档案行自带元数据：离线（没有 archives 镜像可借）也读得出标签和页数。
            let local_archive_metadata_columns: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('local_archives') WHERE name IN ('page_count','tags_json','scope_id')",
                    [],
                    |row| row.get(0),
                )
                .expect("local archive metadata columns");
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
                    sync_table.as_str(),
                    archive_categories_table.as_str(),
                    archive_categories_index.as_str(),
                    archive_categories_fk_count,
                    cache_archive_column.as_str(),
                    cache_archive_index.as_str(),
                    eh_health_columns,
                    local_archive_metadata_columns
                ),
                (
                    33,
                    1,
                    "servers",
                    "reading_resets",
                    "archive_categories",
                    "archive_categories_lookup_idx",
                    2,
                    "source_archive",
                    "cache_entries_archive_idx",
                    4,
                    3
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
        assert_eq!(migration_count, 30);
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

    /// 造一个「旧机器上留下来的库」：只跑到 `up_to` 档，再塞一行设置。
    ///
    /// 逐档跑的是仓库自己的 `MIGRATIONS`，所以夹具跟着迁移脚本一起变 —— 手抄一份建表语句，
    /// 迟早会和真正的老库长得不一样。
    fn write_legacy_database(path: &Path, up_to: i64) -> String {
        let connection = Connection::open(path).expect("legacy database");
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .expect("legacy foreign keys");
        for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version <= up_to) {
            connection
                .execute_batch(sql)
                .unwrap_or_else(|error| panic!("legacy migration {version}: {error}"));
            connection
                .pragma_update(None, "user_version", version)
                .expect("legacy version");
        }
        let left_over = r#"{"left_over":"这台机器上原来就有"}"#.to_string();
        connection
            .execute(
                "INSERT INTO settings (key, value_json) VALUES ('legacy-marker', ?1)",
                [left_over.as_str()],
            )
            .expect("legacy row");
        left_over
    }

    fn scratch_path(tag: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "yomika-{tag}-{}-{unique}.sqlite3",
            std::process::id()
        ))
    }

    fn version_and_marker(connection: &Connection) -> (i64, String) {
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("fixture version");
        let marker: String = connection
            .query_row(
                "SELECT value_json FROM settings WHERE key='legacy-marker'",
                [],
                |row| row.get(0),
            )
            .expect("fixture marker");
        (version, marker)
    }

    #[test]
    fn an_older_database_is_copied_beside_the_new_one_before_it_is_migrated() {
        let path = scratch_path("legacy-backup");
        let left_over = write_legacy_database(&path, 10);
        let backup = backup_path_for(&path, 10);
        assert!(
            !backup.exists(),
            "夹具自己先备过一份就不算数了：{}",
            backup.display()
        );

        let database = Database::open_path(&path).expect("upgrade the legacy database");
        {
            let connection = database.connection.lock().expect("database lock");
            let (version, marker) = version_and_marker(&connection);
            assert_eq!(version, 33, "升完该是这一版的档位");
            assert_eq!(marker, left_over, "那台机器上的数据要跟着一起升上来");
        }
        drop(database);

        // 备份要真的在，而且里面还是升级前那一版 —— 「回退」靠的就是它。
        assert!(
            backup.exists(),
            "升级前该把库整个备一份到 {}",
            backup.display()
        );
        let copy = Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("backup database");
        let (backup_version, backup_marker) = version_and_marker(&copy);
        assert_eq!(backup_version, 10, "备份里该还是升级前那一档");
        assert_eq!(backup_marker, left_over, "备份里该还有那台机器的数据");
        drop(copy);

        std::fs::remove_file(&path).expect("remove test database");
        std::fs::remove_file(&backup).expect("remove test backup");
    }

    #[test]
    fn a_database_from_a_newer_build_is_left_alone() {
        // 回退那一半：这一版遇到比自己新的档位时，一个迁移都不许 apply，更不能把
        // `user_version` 改回去 —— 否则旧包会把新库「降级」成自己认识的样子。
        let path = scratch_path("newer-database");
        let database = Database::open_path(&path).expect("first database open");
        {
            let connection = database.connection.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO settings (key, value_json) VALUES ('legacy-marker', ?1)",
                    [r#"{"from":"a newer build"}"#],
                )
                .expect("newer row");
            connection
                .pragma_update(None, "user_version", 99)
                .expect("pretend a newer build migrated this");
        }
        drop(database);

        let reopened = Database::open_path(&path).expect("older build opens a newer database");
        {
            let connection = reopened.connection.lock().expect("database lock");
            let (version, marker) = version_and_marker(&connection);
            assert_eq!(version, 99, "别人写下的档位不许被改小");
            assert_eq!(marker, r#"{"from":"a newer build"}"#);
        }
        drop(reopened);
        assert!(
            !backup_path_for(&path, 99).exists(),
            "没有要升的档就不该凭空多一份备份"
        );
        std::fs::remove_file(path).expect("remove test database");
    }
    #[test]
    fn retiring_cloud_sync_preserves_records_and_local_reset_intent() {
        let connection = Connection::open_in_memory().unwrap();
        for (_, sql) in MIGRATIONS.iter().filter(|(version,_)| *version <= 32) {
            connection.execute_batch(sql).unwrap();
        }
        connection.execute_batch(r#"INSERT INTO reading_history(scope_id,archive_id,page_index,device_id) VALUES('scope','kept',4,'device'); INSERT INTO sync_journal(scope_id,object_id,object_type,operation,device_id,logical_clock,payload_hash,payload_json) VALUES('scope','scope/reset','reading_progress','delete','device',3,'hash','{"archiveId":"reset","deleted":true}');"#).unwrap();
        connection.execute_batch(include_str!("../../migrations/0033_retire_cloud_sync.sql")).unwrap();
        assert_eq!(connection.query_row("SELECT page_index FROM reading_history WHERE archive_id='kept'", [], |r|r.get::<_,i64>(0)).unwrap(),4);
        assert_eq!(connection.query_row("SELECT archive_id FROM reading_resets WHERE scope_id='scope'", [], |r|r.get::<_,String>(0)).unwrap(),"reset");
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('sync_journal','sync_accounts','sync_applied_segments','webdav_accounts')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }

}

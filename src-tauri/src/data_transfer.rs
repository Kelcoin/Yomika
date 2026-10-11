//! 数据迁移的条目词表（docs/30 重构后的形态）。
//!
//! 导出不再有「范围偏好」：要什么在导出/导入的弹层里当场勾。这里的词表只回答
//! 「条目名认不认识」——未知条目在命令入口就被丢掉，而不是被当成数据落地。
//!
//! 条目分两组：记录类（六个目录，与同步范围同名，因为它们命名的是同一批数据）
//! 与凭据类（三类，只在本机）。记录类的 id 与词表本体都在 `commands::sync` 的
//! `SYNC_SCOPE_CATEGORIES`，这里只引用，不再重复一份。
//!
//! `records` 是记录类的旧 id：旧文件与旧界面只有它，含义是「六个目录全都要」。
//! 它继续被接受，新导出则按目录逐个列清单——只导「阅读进度」这种选择才回得来。

use crate::commands::sync::SYNC_SCOPE_CATEGORIES;

/// 记录类的旧 id（整包）。
pub(crate) const DATA_RECORDS_ITEM: &str = "records";

/// 凭据类的三个条目。它们不进同步：凭据库按设备各存各的。
pub(crate) const DATA_CREDENTIAL_ITEMS: [&str; 3] = ["lrr_servers", "eh_account", "sync_accounts"];

pub(crate) fn is_known_item(item: &str) -> bool {
    item == DATA_RECORDS_ITEM
        || SYNC_SCOPE_CATEGORIES.contains(&item)
        || DATA_CREDENTIAL_ITEMS.contains(&item)
}

/// 未知条目直接丢掉（旧版本可能存着已经改名的 id）。
pub(crate) fn normalize_items(items: &[String]) -> Vec<String> {
    items
        .iter()
        .filter(|item| is_known_item(item))
        .cloned()
        .collect()
}

/// 勾选的记录类条目 → 这次要导出/导入的目录，按 `SYNC_SCOPE_CATEGORIES` 的固定
/// 顺序去重。`records` 展开成全部六个目录，所以旧文件照旧整包能用。
pub(crate) fn record_categories(items: &[String]) -> Vec<String> {
    if items.iter().any(|item| item == DATA_RECORDS_ITEM) {
        return SYNC_SCOPE_CATEGORIES
            .iter()
            .map(|category| category.to_string())
            .collect();
    }
    SYNC_SCOPE_CATEGORIES
        .iter()
        .filter(|category| items.iter().any(|item| item.as_str() == **category))
        .map(|category| category.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 导入一份文件必须把「记录与设置」里的应用设置也落到读设置读的那张表上。
    ///
    /// 曾经的缺口：远端来的应用设置只写了一份名叫 `preferences` 的整块 JSON，而读设置的
    /// 那一半（`load_preferences_from`）读的是 `preferences.*` 的逐字段行——写的那份谁也
    /// 不读，于是阅读设置、SFW 模式永远搬不过去，报告还报「applied: 1」。
    ///
    /// 这条用例的 B 机先自己存过几次设置（本地时钟比文件里那一版高），是最难落地的那种
    /// 局面；A 机那一侧顺带钉住导出里真的有 `sfwMode`（缺了就是等价的反方向缺口）。
    #[test]
    fn importing_a_file_lands_the_reading_settings_and_sfw_mode() {
        let items: Vec<String> = SYNC_SCOPE_CATEGORIES
            .iter()
            .map(|category| category.to_string())
            .collect();
        let categories = record_categories(&items);

        let (value, objects) = {
            let mut source =
                crate::db::Database::open_path(":memory:").expect("in-memory database");
            let mut connection = source.connection.lock().expect("database lock");
            let mut preferences =
                crate::settings::load_preferences_from(&connection).expect("load preferences");
            preferences.sfw_mode = true;
            preferences.default_layout = "webtoon".to_string();
            crate::settings::save_preferences_to(&mut connection, preferences).expect("save");
            let (value, objects) =
                crate::commands::sync::export_scoped_document(&connection, &categories)
                    .expect("export");
            assert!(value.to_string().contains("sfwMode"), "导出里就没有 sfwMode：{value}");
            (value, objects)
        };
        assert_eq!(objects, 1, "那份文件里该只有偏好这一个对象：{value}");

        let mut target = crate::db::Database::open_path(":memory:").expect("in-memory database");
        let mut connection = target.connection.lock().expect("database lock");
        // B 机自己改过五次设置：它的本地时钟已经比文件里那一版高。
        for _ in 0..5 {
            let preferences =
                crate::settings::load_preferences_from(&connection).expect("load preferences");
            crate::settings::save_preferences_to(&mut connection, preferences).expect("save");
        }
        let report = crate::commands::sync::import_scoped_document(
            &mut connection,
            value,
            &categories,
        )
        .expect("import");
        assert_eq!(report.applied, 1, "报告说没应用，用户就看不到「导入成功」：{report:?}");
        let landed = crate::settings::load_preferences_from(&connection).expect("load preferences");
        assert!(
            landed.sfw_mode && landed.default_layout == "webtoon",
            "文件里的阅读设置与 SFW 模式没落地：sfw_mode={} default_layout={}",
            landed.sfw_mode,
            landed.default_layout
        );
    }

    /// 从 Readoshi worker 文件导进来的待看，也要能被「记录与设置」搬走。
    ///
    /// 曾经的缺口：worker 导入路径把待看写进 `reading_list` 表之后，同步日志里的对象类型
    /// 写的是**表名** `reading_list`，而词表里待看的类型叫 `watchlist`——导出只折日志、按
    /// `scope_includes` 过滤，这个类型谁都不认，于是那批待看既进不了导出文档，到了对面也
    /// 会被当未知对象跳过。用户在书架上看得到、搬不走（docs/progress.md 教的正是「重新
    /// 导入同一份 worker JSON 就能把待看填上」，所以这条路径上的待看最多）。
    #[test]
    fn worker_imported_to_read_records_travel_through_a_data_export() {
        let items: Vec<String> = SYNC_SCOPE_CATEGORIES
            .iter()
            .map(|category| category.to_string())
            .collect();
        let categories = record_categories(&items);

        let (value, objects) = {
            let mut source =
                crate::db::Database::open_path(":memory:").expect("in-memory database");
            let mut connection = source.connection.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Home', 'https://lrr.test', 'scope-a')",
                    [],
                )
                .expect("insert server");
            let report = crate::commands::legacy::import_worker_sections(
                &mut connection,
                crate::commands::legacy::WorkerImportInput {
                    scope_id: "scope-a".to_string(),
                    history: crate::commands::legacy::WorkerHistorySection {
                        entries: Vec::new(),
                        deleted_ids: Vec::new(),
                    },
                    watchlist: crate::commands::legacy::WorkerWatchlistSection {
                        entries: vec![crate::commands::legacy::WorkerWatchlistEntry {
                            archive_id: "archive-w".to_string(),
                            added_at: "2026-09-01 08:00:00".to_string(),
                        }],
                        tombstones: Vec::new(),
                    },
                },
            )
            .expect("worker import");
            assert_eq!(report.watchlist, 1, "worker 导入本身要认下这条待看");
            let (value, objects) =
                crate::commands::sync::export_scoped_document(&connection, &categories)
                    .expect("export");
            (value, objects)
        };
        assert!(
            value.to_string().contains("archive-w"),
            "worker 导进来的待看没进导出文档：{value}"
        );
        assert_eq!(objects, 1, "那份文件里该只有这一条待看：{value}");

        let mut target = crate::db::Database::open_path(":memory:").expect("in-memory database");
        let mut connection = target.connection.lock().expect("database lock");
        let report =
            crate::commands::sync::import_scoped_document(&mut connection, value, &categories)
                .expect("import");
        assert_eq!(report.applied, 1, "报告说没应用，用户就看不到「导入成功」：{report:?}");
        let landed: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM reading_list WHERE scope_id='scope-a' AND archive_id='archive-w' AND deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count reading_list");
        assert_eq!(landed, 1, "待看到了对面没落进 reading_list");
    }

    /// 老库里已经躺着的那批待看（日志类型写的是表名 `reading_list`）也要能搬走。
    ///
    /// 这条钉的是词表的两端：导出侧要认这个别名（否则对象根本进不了文档），导入侧也要认
    /// （否则文档里带着一个收端会跳过的对象，往返比搬不走更糟）。修 `legacy.rs` 只让**新**
    /// 导入用上规范名字，用户机器上已经有的那批旧日志只能靠这里的别名。
    #[test]
    fn journal_rows_that_carry_the_old_reading_list_name_still_travel() {
        let items: Vec<String> = SYNC_SCOPE_CATEGORIES
            .iter()
            .map(|category| category.to_string())
            .collect();
        let categories = record_categories(&items);
        let payload = r#"{"archiveId":"archive-old","deleted":false}"#;
        let payload_hash = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(payload.as_bytes()));

        let (value, objects) = {
            let mut source =
                crate::db::Database::open_path(":memory:").expect("in-memory database");
            let connection = source.connection.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Home', 'https://lrr.test', 'scope-a')",
                    [],
                )
                .expect("insert server");
            connection
                .execute(
                    "INSERT INTO sync_journal (scope_id,object_id,object_type,operation,device_id,
                     logical_clock,payload_hash,payload_json) VALUES ('scope-a','scope-a/archive-old',
                     'reading_list','upsert','device-old',1,?1,?2)",
                    rusqlite::params![payload_hash, payload],
                )
                .expect("insert legacy journal row");
            let (value, objects) =
                crate::commands::sync::export_scoped_document(&connection, &categories)
                    .expect("export");
            (value, objects)
        };
        assert!(
            value.to_string().contains("archive-old"),
            "老类型写法的待看没进导出文档：{value}"
        );
        assert_eq!(objects, 1, "那份文件里该只有这一条待看：{value}");

        let mut target = crate::db::Database::open_path(":memory:").expect("in-memory database");
        let mut connection = target.connection.lock().expect("database lock");
        let report =
            crate::commands::sync::import_scoped_document(&mut connection, value, &categories)
                .expect("import");
        assert_eq!(report.applied, 1, "收端把这条当未知对象跳过了：{report:?}");
        let landed: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM reading_list WHERE scope_id='scope-a' AND archive_id='archive-old' AND deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count reading_list");
        assert_eq!(landed, 1, "老类型写法的待看到了对面没落进 reading_list");
    }

    #[test]
    fn unknown_items_are_dropped() {
        let items = normalize_items(&[
            "records".to_string(),
            "lrr_servers".to_string(),
            "retired".to_string(),
        ]);
        assert_eq!(items, vec!["records".to_string(), "lrr_servers".to_string()]);
    }

    #[test]
    fn every_category_and_credential_id_is_known() {
        let mut all: Vec<String> = SYNC_SCOPE_CATEGORIES
            .iter()
            .map(|category| category.to_string())
            .collect();
        all.extend(DATA_CREDENTIAL_ITEMS.iter().map(|item| item.to_string()));
        all.push(DATA_RECORDS_ITEM.to_string());
        assert_eq!(normalize_items(&all).len(), all.len());
    }

    #[test]
    fn records_expands_to_every_category_while_a_subset_stays_a_subset() {
        let every_category = SYNC_SCOPE_CATEGORIES
            .iter()
            .map(|category| category.to_string())
            .collect::<Vec<_>>();
        assert_eq!(record_categories(&[DATA_RECORDS_ITEM.to_string()]), every_category);
        assert_eq!(
            record_categories(&["history".to_string(), "progress".to_string()]),
            vec!["progress".to_string(), "history".to_string()],
            "按词表顺序，勾选顺序不留痕"
        );
        assert_eq!(
            record_categories(&["progress".to_string(), "progress".to_string()]),
            vec!["progress".to_string()],
            "重复的勾选只算一次"
        );
        assert!(
            record_categories(&["lrr_servers".to_string()]).is_empty(),
            "凭据类不是记录目录"
        );
        assert!(record_categories(&["retired".to_string()]).is_empty());
    }
}

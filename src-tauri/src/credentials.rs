//! Explicit file export/import of selected records and local LANraragi/E-H credentials.
//! Secrets remain in the system credential store and enter files only when selected.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    commands::{
        eh::{save_eh_account_record, SaveEhAccountInput, SystemEhCookieStore},
        library::{
            save_server_record, set_server_enabled_record, CredentialStore, ServerInput,
            SystemCredentialStore,
        },
        data_transfer::import_scoped_document,

    },
    data_transfer::{normalize_items, record_categories, DATA_RECORDS_ITEM},
    db::Database,
    domain::result::CommandResult,
};

/// 信封上的类型标记，前端据此把这份文件与同步文档、Readoshi 导出区分开。
/// `yomika-credentials`（口令加密的旧格式）已不再生成；旧文件没有口令就解不开，
/// 口令链路移除后它们不再受支持。
pub(crate) const DATA_EXPORT_KIND: &str = "yomika-export";
const DATA_EXPORT_VERSION: i64 = 1;

/// 导出的信封：`items` 列出文件里实际装了哪几类（导入弹层的勾选框按它动态生成），
/// 其余字段与各类一一对应。`records` 是同步文档信封原样嵌入（含自己的 kind）。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DataExportEnvelope {
    kind: String,
    schema_version: i64,
    exported_at: String,
    items: Vec<String>,
    #[serde(default)]
    records: Option<serde_json::Value>,
    #[serde(default)]
    servers: Vec<ServerCredential>,
    #[serde(default)]
    eh_accounts: Vec<EhAccountCredential>,
    #[serde(default)]
    skipped: usize,
}

/// 只为了从**文本**里再取一次 `records`：`serde_json::Value` 会把同一键的重复项合成
/// 最后一条，而记录类要在文本上折叠（见 `data_transfer::parse_scoped_document`）。解析不出来
/// 就退回信封里那份 Value，老文件照旧能导入。
#[derive(Deserialize)]
struct DataExportRecords {
    #[serde(default)]
    records: Option<crate::commands::data_transfer::ScopedDataExport>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerCredential {
    scope_id: String,
    name: String,
    base_url: String,
    #[serde(default)]
    enabled: bool,
    api_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EhAccountCredential {
    id: String,
    label: String,
    host: String,
    #[serde(default)]
    username_hint: Option<String>,
    cookie: String,
}

/// 导出结果：那份文本、实际装进的条目，以及各类条目的条数（界面据此报数）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataExportReport {
    pub text: String,
    pub items: Vec<String>,
    pub records: usize,
    pub servers: usize,
    pub eh_accounts: usize,
    /// 凭据库里读不到的那几条（例如条目还在、密钥已被系统清理）。它们不会进文件，
    /// 所以报出来，而不是让使用者以为"全都带上了"。
    pub skipped: usize,
}

/// 导入结果：勾选的各类各落地了多少条，以及文件里有、这次却没落地的有多少条
/// （类没勾，或者那条记录的凭据读不出来）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataImportReport {
    pub records: usize,
    pub servers: usize,
    pub eh_accounts: usize,
    pub skipped: usize,
}

/// 收集这次要带走的条目。没勾的类连查都不查：没勾的东西不该从凭据库里被读出来
/// （哪怕只是为了丢掉）。信封的 `items` 由 `export_items` 拼——凭据类只上确实装了
/// 内容的，记录类按勾选的目录列；记录文档本身在 `export_data` 里嵌。
fn collect_bundle(
    connection: &Connection,
    items: &[String],
) -> Result<(DataExportEnvelope, usize), String> {
    let wanted = |item: &str| items.iter().any(|entry| entry == item);
    let mut envelope = DataExportEnvelope {
        kind: DATA_EXPORT_KIND.to_string(),
        schema_version: DATA_EXPORT_VERSION,
        exported_at: String::new(),
        items: Vec::new(),
        records: None,
        servers: Vec::new(),
        eh_accounts: Vec::new(),
        skipped: 0,
    };
    let mut skipped = 0;

    if wanted("lrr_servers") {
        let (servers, missed) = collect_servers(connection)?;
        envelope.servers = servers;
        skipped += missed;
    }
    if wanted("eh_account") {
        let (accounts, missed) = collect_eh_accounts(connection)?;
        envelope.eh_accounts = accounts;
        skipped += missed;
    }

    envelope.items = export_items(
        items,
        envelope.servers.len(),
        envelope.eh_accounts.len(),
    );
    envelope.skipped = skipped;
    Ok((envelope, skipped))
}

/// 信封上的条目清单，导入弹层的勾选框按它生成。
///
/// 记录类列的是**勾选的目录**（`records` 原样保留：旧界面与旧文件都认这个整包 id），
/// 凭据类只列确实装了内容的——空类不该给出一格空勾选框。两者的区别是有意的：
/// 一个目录这次没有内容，下次有新内容时它仍在这份文件的选择里；一条凭据读不出来，
/// 是「没带上」，如实报在 `skipped` 里。
fn export_items(
    items: &[String],
    servers: usize,
    eh_accounts: usize,
) -> Vec<String> {
    let mut listed = Vec::new();
    if items.iter().any(|item| item == DATA_RECORDS_ITEM) {
        listed.push(DATA_RECORDS_ITEM.to_string());
    } else {
        listed.extend(record_categories(items));
    }
    if servers > 0 {
        listed.push("lrr_servers".to_string());
    }
    if eh_accounts > 0 {
        listed.push("eh_account".to_string());
    }
    listed
}

/// 服务器条目 + 凭据库里的 API Key。读不到密钥的条目**跳过**（只搬半条在另一台机器上
/// 等于一行连不上的服务器），返回跳过了几条。
fn collect_servers(
    connection: &Connection,
) -> Result<(Vec<ServerCredential>, usize), String> {
    let credentials = SystemCredentialStore;
    let rows = {
        let mut statement = connection
            .prepare("SELECT name, base_url, scope_id, enabled FROM servers ORDER BY id")
            .map_err(|error| error.to_string())?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)? != 0,
                ))
            })
            .map_err(|error| error.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let mut entries = Vec::new();
    let mut skipped = 0;
    for (name, base_url, scope_id, enabled) in rows {
        match credentials.get_server_api_key(&scope_id) {
            Ok(api_key) if !api_key.trim().is_empty() => entries.push(ServerCredential {
                scope_id,
                name,
                base_url,
                enabled,
                api_key,
            }),
            _ => skipped += 1,
        }
    }
    Ok((entries, skipped))
}

/// E-H 账户条目 + 凭据库里的 Cookie。
fn collect_eh_accounts(
    connection: &Connection,
) -> Result<(Vec<EhAccountCredential>, usize), String> {
    let cookies = SystemEhCookieStore;
    let rows = {
        let mut statement = connection
            .prepare("SELECT id, label, host, username_hint, cookie_ref FROM eh_accounts ORDER BY id")
            .map_err(|error| error.to_string())?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let mut entries = Vec::new();
    let mut skipped = 0;
    for (id, label, host, username_hint, cookie_ref) in rows {
        match cookies.get_cookie(&cookie_ref) {
            Ok(cookie) if !cookie.trim().is_empty() => entries.push(EhAccountCredential {
                id,
                label,
                host,
                username_hint,
                cookie,
            }),
            _ => skipped += 1,
        }
    }
    Ok((entries, skipped))
}

/// Parse the explicit data export envelope.

fn parse_export_envelope(payload: &str) -> Result<DataExportEnvelope, String> {
    let value: serde_json::Value =
        serde_json::from_str(payload).map_err(|_| "导入内容不是有效的 JSON".to_string())?;
    if value.get("kind").and_then(|item| item.as_str()) != Some(DATA_EXPORT_KIND) {
        return Err("这不是本应用导出的数据文件".to_string());
    }
    let envelope: DataExportEnvelope = serde_json::from_value(value)
        .map_err(|error| format!("导出文件的结构不对：{error}"))?;
    if envelope.schema_version != DATA_EXPORT_VERSION {
        return Err(format!("不支持的导出文件版本：{}", envelope.schema_version));
    }
    if envelope.items.is_empty() {
        return Err("这份文件里没有任何可导入的数据".to_string());
    }
    Ok(envelope)
}

/// 导出：按勾选的条目收一份**明文**文件。勾了凭据时界面会提醒「包含敏感信息」——
/// 防泄漏的防线是导出前的知情确认，不再是一把口令。
#[tauri::command(async)]
pub fn export_data(
    items: Vec<String>,
    database: State<'_, Database>,
) -> CommandResult<DataExportReport> {
    let items = normalize_items(&items);
    if items.is_empty() {
        return CommandResult::failure("INVALID_INPUT", "没有勾选任何要导出的数据", false);
    }
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    let (mut envelope, skipped) = match collect_bundle(&connection, &items) {
        Ok(collected) => collected,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    // 记录与设置那一半是同步文档信封：折本机状态是同步那边的活，这里只负责把它
    // 原样嵌进文件（导入端直接交给 import_scoped_document）。勾了几个目录就只装
    // 几个——「只带走阅读进度」这类选择要在文件里成立。
    let categories = record_categories(&items);
    let mut records_count = 0;
    if !categories.is_empty() {
        match crate::commands::data_transfer::export_scoped_document(&connection, &categories) {
            Ok((value, objects)) => {
                records_count = objects;
                envelope.records = Some(value);
            }
            Err(error) => return CommandResult::failure("UNKNOWN", error, true),
        }
    }
    let exported_at = connection
        .query_row("SELECT CURRENT_TIMESTAMP", [], |row| row.get::<_, String>(0))
        .unwrap_or_default();
    envelope.exported_at = exported_at;

    match serde_json::to_string_pretty(&envelope) {
        Ok(text) => CommandResult::success(DataExportReport {
            text,
            items: envelope.items,
            records: records_count,
            servers: envelope.servers.len(),
            eh_accounts: envelope.eh_accounts.len(),
            skipped,
        }),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

/// 导入：把文件里的条目写回凭据库与各自的表。走的是与设置页同一批保存函数，
/// 所以校验、凭据库写入、`credential_ref` 的约定都只有那一份。
///
/// 已存在的条目按 id 覆盖（导入的用途就是「把这份凭据搬过来」）；覆盖只发生在这一次
/// 显式动作里，同步永远不会碰它们。勾选决定文件里哪几类落地——文件里有但没勾的类
/// 如实跳过并数进 `skipped`，而不是静默混进来。记录类是逐目录勾的（`records` 是
/// 旧文件的整包 id，展开成六个目录），服务器条目还会把文件里的 `enabled` 恢复回去。
#[tauri::command(async)]
pub fn import_data(
    payload: String,
    items: Vec<String>,
    database: State<'_, Database>,
) -> CommandResult<DataImportReport> {
    let items = normalize_items(&items);
    let envelope = match parse_export_envelope(&payload) {
        Ok(envelope) => envelope,
        Err(error) => return CommandResult::failure("INVALID_INPUT", error, false),
    };
    if items.is_empty() {
        return CommandResult::failure("INVALID_INPUT", "没有勾选任何要导入的数据", false);
    }

    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    let mut report = DataImportReport {
        records: 0,
        servers: 0,
        eh_accounts: 0,
        skipped: 0,
    };

    let wanted = |item: &str| items.iter().any(|entry| entry == item);

    for server in &envelope.servers {
        if !wanted("lrr_servers")
            || server.api_key.trim().is_empty()
            || server.scope_id.trim().is_empty()
        {
            report.skipped += 1;
            continue;
        }
        match import_server_record(&mut connection, &SystemCredentialStore, server) {
            Ok(true) => report.servers += 1,
            // `Ok(false)`：这一条不合法（超长 Key），跳过它、继续导入其余条目——与上面
            // 「文件里有但没勾/字段是空的」同一条既有风格。
            Ok(false) => report.skipped += 1,
            Err(message) => return CommandResult::failure("INVALID_INPUT", message, false),
        }
    }

    for account in envelope.eh_accounts {
        if !wanted("eh_account") || account.cookie.trim().is_empty() {
            report.skipped += 1;
            continue;
        }
        let label = account.label.clone();
        let result = save_eh_account_record(
            &mut connection,
            &SystemEhCookieStore,
            SaveEhAccountInput {
                id: account.id,
                label: account.label,
                host: account.host,
                username_hint: account.username_hint,
                cookie: account.cookie,
            },
        );
        match result {
            crate::domain::result::CommandResult::Success { .. } => report.eh_accounts += 1,
            crate::domain::result::CommandResult::Failure { error, .. } => {
                return CommandResult::failure(
                    "INVALID_INPUT",
                    format!("导入 E-H 账户「{label}」失败：{}", error.message),
                    false,
                )
            }
        }
    }

    // 记录与设置：文件里装着就按同步那套合并规则落地（同一份文件重复导入是幂等的）。
    // 目录没勾的条目一样是「文件里有、这次不要」，由导入核心数进 skipped，所以一条
    // 都没勾也照样走一趟——报出来的数才是诚实的。
    //
    // 认得出 records 的文本就再解析一遍：`parse_export_envelope` 走的是
    // `serde_json::Value`，那一步已经把 records 里同名的键合成最后一条了，文件内部
    // 有重复项时就比不出哪一条更新；文本这条路交给 记录文件的折叠反序列化。
    if let Some(value) = envelope.records.clone() {
        let categories = record_categories(&items);
        let parsed = serde_json::from_str::<DataExportRecords>(&payload)
            .ok()
            .and_then(|parsed| parsed.records)
            .map(|records| records.document);
        let outcome = match parsed {
            Some(document) => crate::commands::data_transfer::import_scoped_documents(
                &mut connection,
                document,
                &categories,
            ),
            None => import_scoped_document(&mut connection, value, &categories),
        };
        match outcome {
            Ok(applied) => {
                report.records = applied.applied;
                report.skipped += applied.skipped;
            }
            Err(error) => {
                return CommandResult::failure(
                    "INVALID_INPUT",
                    format!("记录与设置导入失败：{error}"),
                    false,
                )
            }
        }
    }

    CommandResult::success(report)
}

/// 导入一条服务器条目：写回走设置页那条保存路径（校验与 `credential_ref` 的约定
/// 只有那一份，凭据库由调用方传进来——测试要用一个记下来的假库，生产用系统凭据库），
/// 再把文件里的 `enabled` 按原样恢复回去。
///
/// 返回值：`Ok(true)` 落地了，`Ok(false)` 这一条**不合法、应当跳过**（调用方数进
/// `skipped`），`Err` 才是整包导入失败。目前只有一种跳过理由——文件里的 Key 长到超过
/// `MAX_API_KEY_CHARS`（多半是把一整段文本当 Key 导出过）；它不是「这份文件读不了」，
/// 一条坏数据不该让其余几十条服务器与记录一起失败。
fn import_server_record(
    connection: &mut Connection,
    credentials: &dyn CredentialStore,
    server: &ServerCredential,
) -> Result<bool, String> {
    let result = save_server_record(
        connection,
        credentials,
        ServerInput::new(&server.name, &server.base_url, &server.scope_id),
        server.api_key.clone(),
    );
    if let crate::domain::result::CommandResult::Failure { error, .. } = result {
        if error.code == "INVALID_API_KEY" {
            return Ok(false);
        }
        return Err(format!("导入服务器「{}」失败：{}", server.name, error.message));
    }
    restore_enabled_server(connection, server)?;
    Ok(true)
}

/// 按文件里的 `enabled` 原样落库：文件说启用就启用（别的自动关掉，默认数据源只有
/// 一台），说停用就明确写回停用。
///
/// 启用的一半交给 `set_server_enabled_record`——单启用规则就写在它里面，这里不再抄
/// 一遍。停用的一半则直接写这一行的标志，**故意绕过**它的「最后一台不许停用」守卫：
/// 那条守卫是给设置页用的（怕用户点着点着把数据源关光），而导入的语义是「回到文件里
/// 那台机器的状态」，文件说这条当时没启用，本机就不该把它当数据源。若本机原来启用的
/// 那台也在文件里，它自己的 `enabled: true` 条目会把它恢复回来；若文件里一条启用的
/// 都没有，落库就一台都不启用——文件说什么就是什么。
///
/// 不走 `save_server_record` 的「新条目在没别的启用时自动启用」是必须的：本机刚好
/// 没有启用的服务器时，那条规则会把文件里写着停用的条目反过来启用，导入后当数据源的
/// 就不是文件里那台了——本机上它对应的密钥可能根本不存在，用户报的「导入后读不到
/// 凭据」就是这么来的。
fn restore_enabled_server(
    connection: &mut Connection,
    server: &ServerCredential,
) -> Result<(), String> {
    if server.enabled {
        return match set_server_enabled_record(connection, &server.scope_id, true) {
            crate::domain::result::CommandResult::Success { .. } => Ok(()),
            crate::domain::result::CommandResult::Failure { error, .. } => Err(format!(
                "导入服务器「{}」失败：{}",
                server.name, error.message
            )),
        };
    }
    connection
        .execute(
            "UPDATE servers SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![server.scope_id],
        )
        .map(|_| ())
        .map_err(|error| format!("导入服务器「{}」失败：{error}", server.name))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用应用自己那条建库路径（`Database::open_path` 跑全部迁移），
    /// 免得测试里的迁移清单跟着 schema 一起漂。
    fn test_database() -> crate::db::Database {
        crate::db::Database::open_path(":memory:").expect("in-memory database")
    }

    #[test]
    fn the_envelope_is_recognised_by_its_kind_and_version() {
        let envelope = DataExportEnvelope {
            kind: DATA_EXPORT_KIND.to_string(),
            schema_version: DATA_EXPORT_VERSION,
            exported_at: "2026-09-22 10:00:00".to_string(),
            items: vec!["records".to_string()],
            records: None,
            servers: Vec::new(),
            eh_accounts: Vec::new(),
                skipped: 0,
        };
        let text = serde_json::to_string(&envelope).expect("serialize");
        assert!(parse_export_envelope(&text).is_ok());
        // 同步文档、Readoshi 导出、随便一段 JSON 都不是数据文件。
        assert!(parse_export_envelope("{\"kind\":\"yomika-scope-export\"}").is_err());
        assert!(parse_export_envelope("{\"version\":3}").is_err());
        assert!(parse_export_envelope("not json").is_err());
        let wrong_version = text.replace("\"schemaVersion\":1", "\"schemaVersion\":99");
        assert!(parse_export_envelope(&wrong_version).is_err());
        // 空清单的文件没有可导入的东西，直接拒收。
        let empty = text.replace("\"items\":[\"records\"]", "\"items\":[]");
        assert!(parse_export_envelope(&empty).is_err());
    }

    fn database_with_two_categories_of_records() -> crate::db::Database {
        let database = test_database();
        let mut connection = database.connection.lock().expect("database lock");
        connection
            .execute_batch(
                "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Home', 'https://lrr.test', 'scope-a');
                 INSERT INTO reading_progress (scope_id, archive_id, page_index, page_count, layout, direction, device_id, revision)
                   VALUES ('scope-a', 'archive-a', 4, 20, 'paged', 'ltr', 'device-a', 1);
                 INSERT INTO reading_history (scope_id, archive_id, page_index, visited_at, device_id, revision)
                   VALUES ('scope-a', 'archive-a', 1, '2026-09-01 08:00:00', 'device-a', 1);",
            )
            .expect("source rows");
        drop(connection);
        database
    }

    #[test]
    fn a_checked_category_subset_round_trips_only_those_categories() {
        // 只勾「阅读进度」：文件里的同步文档只有进度对象，清单也只列 progress，
        // 导进另一个库后历史一个字都不落。
        let source = database_with_two_categories_of_records();
        let items = vec!["progress".to_string()];
        let (document, listed) = {
            let connection = source.connection.lock().expect("database lock");
            let (bundle, _) = collect_bundle(&connection, &items).expect("bundle");
            let (document, objects) =
                crate::commands::data_transfer::export_scoped_document(&connection, &record_categories(&items))
                    .expect("export");
            assert_eq!(objects, 1, "只勾了进度，历史不该进文档");
            assert_eq!(bundle.items, vec!["progress".to_string()]);
            (document, bundle.items)
        };

        let target = test_database();
        let mut connection = target.connection.lock().expect("database lock");
        let report = crate::commands::data_transfer::import_scoped_document(
            &mut connection,
            document,
            &record_categories(&listed),
        )
        .expect("import");
        assert_eq!((report.applied, report.skipped), (1, 0));
        assert_eq!(record_counts(&connection), (1, 0), "没勾的历史不该落地");
    }

    #[test]
    fn records_that_are_not_checked_are_counted_as_skipped() {
        // 文件里两类记录都有，这次只勾进度：历史那条是「文件里有、这次不要」，
        // 由同步那边数进 skipped，而不是静默落地或静默消失。
        let source = database_with_two_categories_of_records();
        let document = {
            let connection = source.connection.lock().expect("database lock");
            let all = record_categories(&[DATA_RECORDS_ITEM.to_string()]);
            let (document, objects) =
                crate::commands::data_transfer::export_scoped_document(&connection, &all).expect("export");
            assert_eq!(objects, 3, "整包 id 展开成全部六个目录，两类记录都要在");
            document
        };

        let target = test_database();
        let mut connection = target.connection.lock().expect("database lock");
        let report = crate::commands::data_transfer::import_scoped_document(
            &mut connection,
            document,
            &["progress".to_string()],
        )
        .expect("import");
        assert_eq!((report.applied, report.skipped), (1, 2));
        assert_eq!(record_counts(&connection), (1, 0));
    }

    #[test]
    fn an_imported_enabled_server_becomes_the_only_enabled_one() {
        let database = test_database();
        let mut connection = database.connection.lock().expect("database lock");
        connection
            .execute_batch(
                "INSERT INTO servers (id, name, base_url, scope_id, enabled) VALUES ('old', 'Old', 'https://old.test', 'old', 1);
                 INSERT INTO servers (id, name, base_url, scope_id, enabled) VALUES ('new', 'New', 'https://new.test', 'new', 0);",
            )
            .expect("rows");

        // 导出端把 enabled 写进文件，这里是那条记录过一遍 JSON 再读回来——文件里说
        // 哪台启用，落地后就是哪台（其余自动关掉，默认数据源只有一台）。
        let imported: ServerCredential = serde_json::from_value(serde_json::json!({
            "scopeId": "new", "name": "New", "baseUrl": "https://new.test",
            "enabled": true, "apiKey": "key",
        }))
        .expect("parse server");
        // "old" 是本机原来启用的那台，文件里也有它、且写着停用——落地后它必须停用。
        let old: ServerCredential = serde_json::from_value(serde_json::json!({
            "scopeId": "old", "name": "Old", "baseUrl": "https://old.test",
            "enabled": false, "apiKey": "old-key",
        }))
        .expect("parse server");

        restore_enabled_server(&mut connection, &imported).expect("restore enabled");
        assert_eq!(enabled_server_ids(&connection), vec!["new".to_string()]);

        restore_enabled_server(&mut connection, &old).expect("restore disabled");
        assert_eq!(enabled_server_ids(&connection), vec!["new".to_string()]);

        // 文件说停用的条目要真的停用：本机只剩它一台启用时也不例外——导入的语义是
        // 「回到文件里那台机器的状态」，不是「无论如何保住一台数据源」。
        let only_enabled_disabled = ServerCredential {
            enabled: false,
            ..imported
        };
        restore_enabled_server(&mut connection, &only_enabled_disabled).expect("restore disabled");
        assert!(
            enabled_server_ids(&connection).is_empty(),
            "文件说没启用，就不能反过来把它启用"
        );
    }

    /// 记下写进凭据库的 (scope_id, api_key)，用来断言导入之后那台服务器的 Key
    /// 确实存在、且存的就是文件里那条——用户报的「导入后读不到凭据」正是这里的回归点。
    #[derive(Default)]
    struct RecordingCredentialStore {
        writes: std::sync::Mutex<Vec<(String, String)>>,
    }

    impl CredentialStore for RecordingCredentialStore {
        fn set_server_api_key(&self, scope_id: &str, api_key: &str) -> Result<(), String> {
            self.writes
                .lock()
                .expect("credential store lock")
                .push((scope_id.to_string(), api_key.to_string()));
            Ok(())
        }
    }

    impl RecordingCredentialStore {
        fn stored_key(&self, scope_id: &str) -> Option<String> {
            self.writes
                .lock()
                .expect("credential store lock")
                .iter()
                .rev()
                .find(|(id, _)| id == scope_id)
                .map(|(_, key)| key.clone())
        }
    }

    #[test]
    fn an_imported_enabled_server_keeps_a_readable_api_key() {
        let database = test_database();
        let mut connection = database.connection.lock().expect("database lock");
        let credentials = RecordingCredentialStore::default();
        let server: ServerCredential = serde_json::from_value(serde_json::json!({
            "scopeId": "scope-new", "name": "New", "baseUrl": "https://new.test",
            "enabled": true, "apiKey": "key-from-file",
        }))
        .expect("parse server");

        import_server_record(&mut connection, &credentials, &server).expect("import server");

        // 启用之后走的就是这一行，所以它的 scope_id 必须能在凭据库里读到密钥。
        assert_eq!(enabled_server_ids(&connection), vec!["scope-new".to_string()]);
        assert_eq!(
            credentials.stored_key("scope-new").as_deref(),
            Some("key-from-file"),
            "文件里的 API Key 要落在这一行的 scope_id 下"
        );
        // SQLite 只留指向凭据库的引用，明文密钥不进库。
        let stored_ref: Option<String> = connection
            .query_row(
                "SELECT api_key_ref FROM servers WHERE id = 'scope-new'",
                [],
                |row| row.get(0),
            )
            .expect("server row");
        assert_eq!(stored_ref.as_deref(), Some("scope-new"));
    }

    /// 文件里一条超长 Key 不该让整包导入失败：它是「这一条不合法」，数进 `skipped`
    /// 就好（`import_data` 的循环照这个返回值计数）。回归点：`431 Request Header Fields
    /// Too Large` 之所以出现，正是因为这种条目本来被当成合法服务器存了下来。
    #[test]
    fn an_over_long_key_in_the_file_is_skipped_rather_than_failing_the_import() {
        let database = test_database();
        let mut connection = database.connection.lock().expect("database lock");
        let credentials = RecordingCredentialStore::default();
        let server: ServerCredential = serde_json::from_value(serde_json::json!({
            "scopeId": "scope-too-long", "name": "Too long", "baseUrl": "https://long.test",
            "enabled": true, "apiKey": "k".repeat(crate::commands::library::MAX_API_KEY_CHARS + 1),
        }))
        .expect("parse server");

        assert!(
            !import_server_record(&mut connection, &credentials, &server).expect("skip"),
            "超长 Key 的条目应当是「跳过」，不是「导入成功」"
        );
        assert!(
            enabled_server_ids(&connection).is_empty(),
            "跳过的条目不许落库"
        );
        assert_eq!(credentials.stored_key("scope-too-long"), None);
    }

    fn enabled_server_ids(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("SELECT id FROM servers WHERE enabled = 1 ORDER BY id")
            .expect("statement");
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("rows");
        rows.collect::<Result<Vec<_>, _>>().expect("enabled ids")
    }

    /// (进度的条数, 历史的条数)。
    fn record_counts(connection: &Connection) -> (i64, i64) {
        connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM reading_progress), (SELECT COUNT(*) FROM reading_history)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("record counts")
    }
}

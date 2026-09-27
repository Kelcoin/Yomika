//! 数据迁移的凭据一半（docs/30 重构后）：把「账户与服务器」整份搬过去。
//!
//! 同步刻意不带凭据（同步密钥由账户口令派生，上传它等于把远端文档的钥匙一起交出去；
//! API Key 与 Cookie 是这台设备的授权，搬到第三方存储上等于放大泄漏面），但「换台机器
//! 就得重新配一遍」总得有个出口。
//!
//! 2026-09 重构：口令加密整条链路移除。凭据由使用者**显式勾选**后以明文进文件，
//! 勾选时界面提醒「包含敏感信息，切勿分享」——防泄漏的防线从「一把口令」挪到
//! 「导出前的知情确认」。文件里装的是三类东西：LANraragi 服务器条目与 API Key、
//! E-H 账户与 Cookie、同步账户与其口令；记录与设置那一半是同步文档信封，原样嵌入。
//! 导入与导出都走系统凭据库（`keyring`），SQLite 里依旧只留 `credential_ref`。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    commands::{
        eh::{save_eh_account_record, SaveEhAccountInput, SystemEhCookieStore},
        library::{save_server_record, ServerInput, SystemCredentialStore},
        sync::{
            import_scoped_document, save_sync_account_record, SaveSyncAccountInput,
            SystemWebdavCredentialStore, WebdavCredentialStore, SYNC_SCOPE_CATEGORIES,
        },
    },
    data_transfer::{normalize_items, DATA_EXPORT_ITEMS},
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
    sync_accounts: Vec<SyncAccountCredential>,
    #[serde(default)]
    skipped: usize,
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncAccountCredential {
    id: String,
    #[serde(default)]
    kind: String,
    label: String,
    base_url: String,
    #[serde(default)]
    bucket: String,
    username: String,
    #[serde(default)]
    sync_scope: Option<String>,
    credential: String,
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
    pub sync_accounts: usize,
    /// 凭据库里读不到的那几条（例如条目还在、密钥已被系统清理）。它们不会进文件，
    /// 所以报出来，而不是让使用者以为"全都带上了"。
    pub skipped: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataImportReport {
    pub records: usize,
    pub servers: usize,
    pub eh_accounts: usize,
    pub sync_accounts: usize,
}

/// 收集这次要带走的条目。没勾的类连查都不查：没勾的东西不该从凭据库里被读出来
/// （哪怕只是为了丢掉）。`items` 只记录**确实装了内容**的类——空类不上清单，
/// 导入弹层的勾选框才不会给出一格空东西。
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
        sync_accounts: Vec::new(),
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
    if wanted("sync_accounts") {
        let (accounts, missed) = collect_sync_accounts(connection)?;
        envelope.sync_accounts = accounts;
        skipped += missed;
    }

    envelope.items = DATA_EXPORT_ITEMS
        .iter()
        .filter(|item| {
            **item == "records"
                || (**item == "lrr_servers" && !envelope.servers.is_empty())
                || (**item == "eh_account" && !envelope.eh_accounts.is_empty())
                || (**item == "sync_accounts" && !envelope.sync_accounts.is_empty())
        })
        .map(|item| item.to_string())
        .collect();
    envelope.skipped = skipped;
    Ok((envelope, skipped))
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

/// 同步账户条目 + 凭据库里的口令。
fn collect_sync_accounts(
    connection: &Connection,
) -> Result<(Vec<SyncAccountCredential>, usize), String> {
    let credentials = SystemWebdavCredentialStore;
    let rows = {
        let mut statement = connection
            .prepare(
                "SELECT id, kind, label, base_url, bucket, username, credential_ref, sync_scope
                 FROM sync_accounts ORDER BY id",
            )
            .map_err(|error| error.to_string())?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let mut entries = Vec::new();
    let mut skipped = 0;
    for (id, kind, label, base_url, bucket, username, credential_ref, sync_scope) in rows {
        match credentials.get_credential(&credential_ref) {
            Ok(credential) if !credential.trim().is_empty() => {
                entries.push(SyncAccountCredential {
                    id,
                    kind,
                    label,
                    base_url,
                    bucket,
                    username,
                    sync_scope: sync_scope.filter(|value| !value.trim().is_empty()),
                    credential,
                })
            }
            _ => skipped += 1,
        }
    }
    Ok((entries, skipped))
}

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
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let (mut envelope, skipped) = match collect_bundle(&connection, &items) {
        Ok(collected) => collected,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    // 记录与设置那一半是同步文档信封：折本机状态是同步那边的活，这里只负责把它
    // 原样嵌进文件（导入端直接交给 import_scoped_document）。
    let mut records_count = 0;
    if items.iter().any(|item| item == "records") {
        match crate::commands::sync::export_scoped_document(&connection) {
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
    envelope.items = envelope
        .items
        .into_iter()
        .filter(|item| *item != "records" || envelope.records.is_some())
        .collect();

    match serde_json::to_string_pretty(&envelope) {
        Ok(text) => CommandResult::success(DataExportReport {
            text,
            items: envelope.items,
            records: records_count,
            servers: envelope.servers.len(),
            eh_accounts: envelope.eh_accounts.len(),
            sync_accounts: envelope.sync_accounts.len(),
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
/// 如实跳过，而不是静默混进来。
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
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let mut report = DataImportReport {
        records: 0,
        servers: 0,
        eh_accounts: 0,
        sync_accounts: 0,
    };

    let wanted = |item: &str| items.iter().any(|entry| entry == item);

    for server in envelope.servers {
        if !wanted("lrr_servers") || server.api_key.trim().is_empty() || server.scope_id.trim().is_empty() {
            continue;
        }
        let result = save_server_record(
            &mut connection,
            &SystemCredentialStore,
            ServerInput::new(&server.name, &server.base_url, &server.scope_id),
            server.api_key,
        );
        match result {
            crate::domain::result::CommandResult::Success { .. } => report.servers += 1,
            crate::domain::result::CommandResult::Failure { error, .. } => {
                return CommandResult::failure(
                    "INVALID_INPUT",
                    format!("导入服务器「{}」失败：{}", server.name, error.message),
                    false,
                )
            }
        }
    }

    for account in envelope.eh_accounts {
        if !wanted("eh_account") || account.cookie.trim().is_empty() {
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

    for account in envelope.sync_accounts {
        if !wanted("sync_accounts") || account.credential.trim().is_empty() {
            continue;
        }
        let label = account.label.clone();
        let result = save_sync_account_record(
            &mut connection,
            &SystemWebdavCredentialStore,
            SaveSyncAccountInput::new(
                &account.id,
                &account.kind,
                &account.label,
                &account.base_url,
                &account.bucket,
                &account.username,
                &account.credential,
                account.sync_scope,
            ),
        );
        match result {
            crate::domain::result::CommandResult::Success { .. } => report.sync_accounts += 1,
            crate::domain::result::CommandResult::Failure { error, .. } => {
                return CommandResult::failure(
                    "INVALID_INPUT",
                    format!("导入同步账户「{label}」失败：{}", error.message),
                    false,
                )
            }
        }
    }

    // 记录与设置：文件里装着、这次也勾了，就按同步那套合并规则落地（同一份文件
    // 重复导入是幂等的）。没勾就留在文件里——界面上说明它被跳过了。
    if let Some(value) = envelope.records {
        if wanted("records") {
            let all_categories = SYNC_SCOPE_CATEGORIES
                .iter()
                .map(|item| item.to_string())
                .collect::<Vec<_>>();
            match import_scoped_document(&mut connection, value, &all_categories) {
                Ok(applied) => report.records = applied.applied,
                Err(error) => {
                    return CommandResult::failure(
                        "INVALID_INPUT",
                        format!("记录与设置导入失败：{error}"),
                        false,
                    )
                }
            }
        }
    }

    CommandResult::success(report)
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
            sync_accounts: Vec::new(),
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

    #[test]
    fn the_bundle_reads_only_the_classes_in_scope() {
        // 三类条目各放一条，凭据库里都没有对应条目（测试进程没有真实的凭据库），
        // 所以断言的是「没勾的类根本不去查」与「读不到的如实报出来」。
        let database = test_database();
        let connection = database.connection.lock().expect("database lock");
        connection
            .execute_batch(
                "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Home', 'https://lrr.test', 'scope-a');
                 INSERT INTO eh_accounts (id, label, host, username_hint, cookie_ref) VALUES ('eh-a', '主账号', 'e-hentai.org', 'reader', 'cred-eh');
                 INSERT INTO sync_accounts (id, label, base_url, username, credential_ref) VALUES ('dav-a', 'NAS', 'https://dav.test/yomika', 'me', 'cred-sync');",
            )
            .expect("rows");

        let all = ["lrr_servers", "eh_account", "sync_accounts"].map(String::from).to_vec();
        let (bundle, skipped) = collect_bundle(&connection, &all).expect("bundle");
        assert!(
            bundle.servers.is_empty() && bundle.eh_accounts.is_empty() && bundle.sync_accounts.is_empty()
        );
        assert_eq!(skipped, 3, "三条都没有可读的凭据，要如实报出来");
        assert!(!bundle.items.iter().any(|item| item == "lrr_servers"));

        // 只勾服务器：另外两类连查都不查，所以跳过的只有那一条服务器。
        let servers_only = vec!["lrr_servers".to_string()];
        let (bundle, skipped) = collect_bundle(&connection, &servers_only).expect("bundle");
        assert_eq!(skipped, 1);
        assert!(bundle.eh_accounts.is_empty());
        assert!(bundle.sync_accounts.is_empty());

        // 一类都不勾：什么都不读，也不报跳过。
        let (_, skipped) = collect_bundle(&connection, &[]).expect("bundle");
        assert_eq!(skipped, 0);
    }
}

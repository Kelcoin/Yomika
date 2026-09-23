//! 凭据的导入导出：换台机器时把「账户与服务器」整份搬过去。
//!
//! 同步刻意不带凭据（同步密钥由账户口令派生，上传它等于把远端文档的钥匙一起交出去；
//! API Key 与 Cookie 是这台设备的授权，搬到第三方存储上等于放大泄漏面），但"换台机器
//! 就得重新配一遍"总得有个出口。出口是一个**口令加密的文件**：
//!
//! - 口令不上网、不进日志、不落盘，只在这两条命令的生命周期里存在；
//! - 文件本身没有口令就是一堆字节（PBKDF2-HMAC-SHA256 派生 + AES-256-GCM）；
//! - 导出与导入都走系统凭据库（`keyring`），SQLite 里依旧只留 `credential_ref`。
//!
//! 文件里装的是三类东西：LANraragi 服务器条目与 API Key、E-H 账户与 Cookie、同步
//! 账户与其口令。它们合起来就是设置里那一行「账户与服务器」——同步永远不碰它。

use std::num::NonZeroU32;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ring::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM},
    pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    data_transfer::is_credential_category,
    commands::{
        eh::{save_eh_account_record, SaveEhAccountInput, SystemEhCookieStore},
        library::{save_server_record, ServerInput, SystemCredentialStore},
        sync::{
            save_sync_account_record, SaveSyncAccountInput, SystemWebdavCredentialStore,
            WebdavCredentialStore,
        },
    },
    db::Database,
    domain::result::CommandResult,
};

/// 信封上的类型标记，前端据此把这份文件与同步文档、Readoshi 导出区分开。
pub(crate) const CREDENTIAL_EXPORT_KIND: &str = "yomika-credentials";
const CREDENTIAL_EXPORT_VERSION: i64 = 1;
/// 口令是这份文件唯一的门槛，所以迭代次数往高了取（OWASP 对 PBKDF2-HMAC-SHA256 的
/// 建议是 60 万）。这两条命令都是显式动作、不在热路径上，几百毫秒换一个够硬的 KDF
/// 是划算的；命令声明为 async，等待发生在别的线程上。
const PBKDF2_ITERATIONS: u32 = 600_000;
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 12;
/// 太短的口令在离线爆破面前等于没有：文件已经离开这台机器，唯一的防线就是它。
const MIN_PASSPHRASE_CHARS: usize = 8;

/// 加密后的那份文件：明文只在这里的 `payload` 里，且已用口令派生的密钥加密。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialEnvelope {
    kind: String,
    schema_version: i64,
    exported_at: String,
    /// 迭代次数随文件走：将来提高门槛时，旧文件仍然按它自己那份参数解得开。
    iterations: u32,
    salt: String,
    nonce: String,
    payload: String,
}

/// 明文（只在内存里存在）：三类条目，字段与各自的表单一一对应。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialBundle {
    #[serde(default)]
    servers: Vec<ServerCredential>,
    #[serde(default)]
    eh_accounts: Vec<EhAccountCredential>,
    #[serde(default)]
    sync_accounts: Vec<SyncAccountCredential>,
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

/// 导出结果：那份文本，以及各类条目的条数（界面据此报数）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialExportReport {
    pub text: String,
    pub servers: usize,
    pub eh_accounts: usize,
    pub sync_accounts: usize,
    /// 凭据库里读不到的那几条（例如条目还在、密钥已被系统清理）。它们不会进文件，
    /// 所以报出来，而不是让使用者以为"全都带上了"。
    pub skipped: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialImportReport {
    pub servers: usize,
    pub eh_accounts: usize,
    pub sync_accounts: usize,
}

fn random_bytes(length: usize) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0_u8; length];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "系统随机数不可用".to_string())?;
    Ok(bytes)
}

/// 口令 → 32 字节密钥。盐随文件走，所以同一个口令在两次导出里得到不同的密钥。
fn derive_key(passphrase: &str, salt: &[u8], iterations: u32) -> Result<[u8; 32], String> {
    let iterations =
        NonZeroU32::new(iterations).ok_or_else(|| "无效的迭代次数".to_string())?;
    let mut key = [0_u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        salt,
        passphrase.as_bytes(),
        &mut key,
    );
    Ok(key)
}

fn seal(key: &[u8; 32], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let unbound =
        UnboundKey::new(&AES_256_GCM, key).map_err(|_| "无效的加密密钥".to_string())?;
    let sealing = LessSafeKey::new(unbound);
    let nonce_bytes = random_bytes(NONCE_BYTES)?;
    let nonce = Nonce::assume_unique_for_key(
        nonce_bytes
            .as_slice()
            .try_into()
            .map_err(|_| "无效的随机数".to_string())?,
    );
    let mut output = plaintext.to_vec();
    sealing
        .seal_in_place_append_tag(nonce, Aad::empty(), &mut output)
        .map_err(|_| "加密失败".to_string())?;
    Ok((nonce_bytes, output))
}

fn open(key: &[u8; 32], nonce_bytes: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let unbound =
        UnboundKey::new(&AES_256_GCM, key).map_err(|_| "无效的加密密钥".to_string())?;
    let opening = LessSafeKey::new(unbound);
    let nonce = Nonce::assume_unique_for_key(
        nonce_bytes
            .try_into()
            .map_err(|_| "无效的随机数".to_string())?,
    );
    let mut buffer = ciphertext.to_vec();
    opening
        .open_in_place(nonce, Aad::empty(), &mut buffer)
        .map(|plaintext| plaintext.to_vec())
        .map_err(|_| "口令不对，或者文件已经损坏".to_string())
}

/// 凭据类的勾选：未知条目丢掉（同步范围那边的旧 id 也在这类里），只留凭据类。
fn parse_credential_scope(value: &str) -> Vec<String> {
    let parsed: Vec<String> = serde_json::from_str(value).unwrap_or_default();
    parsed
        .into_iter()
        .filter(|item| is_credential_category(item))
        .collect()
}

fn validate_passphrase(passphrase: &str) -> Result<(), String> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(format!("口令至少 {MIN_PASSPHRASE_CHARS} 个字符"));
    }
    Ok(())
}

/// 把本机凭据库里的三类条目读出来。读不到密钥的条目**跳过**：只搬半条（有地址没有
/// Key）在另一台机器上等于一行连不上的服务器，不如让使用者知道少了一条。
fn collect_bundle(
    connection: &Connection,
    enabled: &[String],
) -> Result<(CredentialBundle, usize), String> {
    // 范围之外的类连查都不查：没勾的东西不该从凭据库里被读出来（哪怕只是为了丢掉）。
    let wanted = |category: &str| enabled.iter().any(|item| item == category);
    let mut bundle = CredentialBundle::default();
    let mut skipped = 0;

    if wanted("lrr_servers") {
        let (servers, missed) = collect_servers(connection)?;
        bundle.servers = servers;
        skipped += missed;
    }
    if wanted("eh_account") {
        let (accounts, missed) = collect_eh_accounts(connection)?;
        bundle.eh_accounts = accounts;
        skipped += missed;
    }
    if wanted("sync_accounts") {
        let (accounts, missed) = collect_sync_accounts(connection)?;
        bundle.sync_accounts = accounts;
        skipped += missed;
    }

    Ok((bundle, skipped))
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

fn parse_envelope(payload: &str) -> Result<CredentialEnvelope, String> {
    let value: serde_json::Value =
        serde_json::from_str(payload).map_err(|_| "导入内容不是有效的 JSON".to_string())?;
    if value.get("kind").and_then(|item| item.as_str()) != Some(CREDENTIAL_EXPORT_KIND) {
        return Err("这不是本应用导出的凭据文件".to_string());
    }
    let envelope: CredentialEnvelope = serde_json::from_value(value)
        .map_err(|error| format!("凭据文件的结构不对：{error}"))?;
    if envelope.schema_version != CREDENTIAL_EXPORT_VERSION {
        return Err(format!("不支持的凭据文件版本：{}", envelope.schema_version));
    }
    Ok(envelope)
}

/// 导出：把本机的三类条目收成一份口令加密的文件。
#[tauri::command(async)]
pub fn export_credentials(
    passphrase: String,
    categories: String,
    database: State<'_, Database>,
) -> CommandResult<CredentialExportReport> {
    if let Err(error) = validate_passphrase(&passphrase) {
        return CommandResult::failure("INVALID_INPUT", error, false);
    }
    let enabled = parse_credential_scope(&categories);
    if enabled.is_empty() {
        return CommandResult::failure(
            "INVALID_INPUT",
            "没有勾选任何凭据类：先在「导入导出范围」里选要带走的类别",
            false,
        );
    }
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let (bundle, skipped) = match collect_bundle(&connection, &enabled) {
        Ok(collected) => collected,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let exported_at = connection
        .query_row("SELECT CURRENT_TIMESTAMP", [], |row| row.get::<_, String>(0))
        .unwrap_or_default();
    drop(connection);

    let plaintext = match serde_json::to_vec(&bundle) {
        Ok(bytes) => bytes,
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    let salt = match random_bytes(SALT_BYTES) {
        Ok(bytes) => bytes,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let key = match derive_key(&passphrase, &salt, PBKDF2_ITERATIONS) {
        Ok(key) => key,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let (nonce, ciphertext) = match seal(&key, &plaintext) {
        Ok(sealed) => sealed,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let envelope = CredentialEnvelope {
        kind: CREDENTIAL_EXPORT_KIND.to_string(),
        schema_version: CREDENTIAL_EXPORT_VERSION,
        exported_at,
        iterations: PBKDF2_ITERATIONS,
        salt: STANDARD.encode(&salt),
        nonce: STANDARD.encode(&nonce),
        payload: STANDARD.encode(&ciphertext),
    };
    match serde_json::to_string_pretty(&envelope) {
        Ok(text) => CommandResult::success(CredentialExportReport {
            text,
            servers: bundle.servers.len(),
            eh_accounts: bundle.eh_accounts.len(),
            sync_accounts: bundle.sync_accounts.len(),
            skipped,
        }),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

/// 导入：解开口令，把三类条目写回凭据库与各自的表。走的是与设置页同一批保存函数，
/// 所以校验、凭据库写入、`credential_ref` 的约定都只有那一份。
///
/// 已存在的条目按 id 覆盖（导入的用途就是「把这份凭据搬过来」）；覆盖只发生在这一次
/// 显式动作里，同步永远不会碰它们。
#[tauri::command(async)]
pub fn import_credentials(
    payload: String,
    passphrase: String,
    categories: String,
    database: State<'_, Database>,
) -> CommandResult<CredentialImportReport> {
    let enabled = parse_credential_scope(&categories);
    let envelope = match parse_envelope(&payload) {
        Ok(envelope) => envelope,
        Err(error) => return CommandResult::failure("INVALID_INPUT", error, false),
    };
    let salt = match STANDARD.decode(&envelope.salt) {
        Ok(bytes) => bytes,
        Err(_) => return CommandResult::failure("INVALID_INPUT", "凭据文件的盐无法解码", false),
    };
    let nonce = match STANDARD.decode(&envelope.nonce) {
        Ok(bytes) if bytes.len() == NONCE_BYTES => bytes,
        _ => return CommandResult::failure("INVALID_INPUT", "凭据文件的随机数无法解码", false),
    };
    let ciphertext = match STANDARD.decode(&envelope.payload) {
        Ok(bytes) => bytes,
        Err(_) => return CommandResult::failure("INVALID_INPUT", "凭据文件的密文无法解码", false),
    };
    let key = match derive_key(&passphrase, &salt, envelope.iterations) {
        Ok(key) => key,
        Err(error) => return CommandResult::failure("INVALID_INPUT", error, false),
    };
    // 口令不对时 AEAD 的校验标签就对不上，这里拿到的是「解不开」而不是乱码。
    let plaintext = match open(&key, &nonce, &ciphertext) {
        Ok(bytes) => bytes,
        Err(error) => return CommandResult::failure("INVALID_INPUT", error, false),
    };
    let bundle: CredentialBundle = match serde_json::from_slice(&plaintext) {
        Ok(bundle) => bundle,
        Err(_) => return CommandResult::failure("INVALID_INPUT", "凭据文件的内容无法解析", false),
    };

    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let mut report = CredentialImportReport {
        servers: 0,
        eh_accounts: 0,
        sync_accounts: 0,
    };

    // 文件里可能装着没勾的类（比如从别人的文件里导）：勾选是「要不要这类数据」的
    // 开关，导入不该绕过它。
    let wanted = |category: &str| enabled.iter().any(|item| item == category);

    for server in bundle.servers {
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

    for account in bundle.eh_accounts {
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

    for account in bundle.sync_accounts {
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

    CommandResult::success(report)
}

/// 只给测试用：确认「同一份文件重复导入」与「口令不对」这两种情况的边界。
#[cfg(test)]
mod tests {
    use super::*;

    /// 用应用自己那条建库路径（`Database::open_path` 跑全部迁移），
    /// 免得测试里的迁移清单跟着 schema 一起漂。
    fn test_database() -> crate::db::Database {
        crate::db::Database::open_path(":memory:").expect("in-memory database")
    }

    #[test]
    fn a_passphrase_round_trips_and_the_wrong_one_does_not() {
        let salt = random_bytes(SALT_BYTES).expect("salt");
        let key = derive_key("correct horse battery", &salt, PBKDF2_ITERATIONS).expect("key");
        let (nonce, ciphertext) = seal(&key, b"{\"servers\":[]}").expect("seal");

        let same = derive_key("correct horse battery", &salt, PBKDF2_ITERATIONS).expect("key");
        assert_eq!(open(&same, &nonce, &ciphertext).expect("open"), b"{\"servers\":[]}");

        // 口令错一位就解不开：AEAD 的标签会拒掉，而不是回一份乱码。
        let wrong = derive_key("correct horse batterz", &salt, PBKDF2_ITERATIONS).expect("key");
        assert!(open(&wrong, &nonce, &ciphertext).is_err());
        // 盐不同（也就是另一个文件）也解不开。
        let other_salt = random_bytes(SALT_BYTES).expect("salt");
        let other = derive_key("correct horse battery", &other_salt, PBKDF2_ITERATIONS).expect("key");
        assert!(open(&other, &nonce, &ciphertext).is_err());
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let salt = random_bytes(SALT_BYTES).expect("salt");
        let key = derive_key("passphrase-1234", &salt, PBKDF2_ITERATIONS).expect("key");
        let (nonce, mut ciphertext) = seal(&key, b"{\"servers\":[]}").expect("seal");
        ciphertext[0] ^= 0x01;
        assert!(open(&key, &nonce, &ciphertext).is_err());
    }

    #[test]
    fn short_passphrases_are_refused() {
        assert!(validate_passphrase("1234567").is_err());
        assert!(validate_passphrase("12345678").is_ok());
    }

    #[test]
    fn the_envelope_is_recognised_by_its_kind_and_version() {
        let envelope = CredentialEnvelope {
            kind: CREDENTIAL_EXPORT_KIND.to_string(),
            schema_version: CREDENTIAL_EXPORT_VERSION,
            exported_at: "2026-09-22 10:00:00".to_string(),
            iterations: PBKDF2_ITERATIONS,
            salt: STANDARD.encode(random_bytes(SALT_BYTES).expect("salt")),
            nonce: STANDARD.encode(random_bytes(NONCE_BYTES).expect("nonce")),
            payload: STANDARD.encode(b"ciphertext"),
        };
        let text = serde_json::to_string(&envelope).expect("serialize");
        assert!(parse_envelope(&text).is_ok());
        // 同步文档、Readoshi 导出、随便一段 JSON 都不是凭据文件。
        assert!(parse_envelope("{\"kind\":\"yomika-scope-export\"}").is_err());
        assert!(parse_envelope("{\"version\":3}").is_err());
        assert!(parse_envelope("not json").is_err());
        let wrong_version = text.replace("\"schemaVersion\":1", "\"schemaVersion\":99");
        assert!(parse_envelope(&wrong_version).is_err());
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
        assert!(bundle.servers.is_empty() && bundle.eh_accounts.is_empty() && bundle.sync_accounts.is_empty());
        assert_eq!(skipped, 3, "三条都没有可读的凭据，要如实报出来");

        // 只勾服务器：另外两类连查都不查，所以跳过的只有那一条服务器。
        let servers_only = vec!["lrr_servers".to_string()];
        let (_, skipped) = collect_bundle(&connection, &servers_only).expect("bundle");
        assert_eq!(skipped, 1);

        // 一类都不勾：什么都不读，也不报跳过。
        let (_, skipped) = collect_bundle(&connection, &[]).expect("bundle");
        assert_eq!(skipped, 0);
    }

    #[test]
    fn the_credential_scope_keeps_only_the_credential_classes() {
        assert_eq!(
            parse_credential_scope(r#"["lrr_servers","history","sync_accounts","credentials"]"#),
            vec!["lrr_servers".to_string(), "sync_accounts".to_string()],
        );
        assert!(parse_credential_scope("not json").is_empty());
        assert!(parse_credential_scope("[]").is_empty());
    }
}

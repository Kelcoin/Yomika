use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;
use url::Url;

use crate::{db::Database, domain::result::CommandResult, network::webdav::WebdavClient, settings::get_or_create_device_id};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncManifestSegment {
    pub hash: String,
    pub size: u64,
    pub sequence_start: i64,
    pub sequence_end: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncManifest {
    pub version: i64,
    pub epoch: i64,
    pub segments: Vec<SyncManifestSegment>,
    pub device_cursors: std::collections::BTreeMap<String, i64>,
}

fn merge_manifests(local: &SyncManifest, remote: &SyncManifest) -> SyncManifest {
    let mut segments = std::collections::BTreeMap::new();
    for segment in remote.segments.iter().chain(local.segments.iter()) {
        segments
            .entry(segment.hash.clone())
            .or_insert_with(|| segment.clone());
    }
    let mut device_cursors = remote.device_cursors.clone();
    for (device_id, cursor) in &local.device_cursors {
        device_cursors
            .entry(device_id.clone())
            .and_modify(|value| *value = (*value).max(*cursor))
            .or_insert(*cursor);
    }
    SyncManifest {
        version: local.version.max(remote.version),
        epoch: local.epoch.max(remote.epoch),
        segments: segments.into_values().collect(),
        device_cursors,
    }
}

#[tauri::command]
pub fn merge_sync_manifests(
    local: SyncManifest,
    remote: SyncManifest,
) -> CommandResult<SyncManifest> {
    CommandResult::success(merge_manifests(&local, &remote))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SyncWireObject {
    sequence: i64,
    object_id: String,
    object_type: String,
    operation: String,
    device_id: String,
    logical_clock: i64,
    wall_clock: String,
    base_hash: Option<String>,
    payload_hash: String,
    payload: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncSegmentEnvelope {
    version: i64,
    sequence_start: i64,
    sequence_end: i64,
    objects: Vec<SyncWireObject>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltSyncSegment {
    sequence_start: i64,
    sequence_end: i64,
    hash: String,
    size: usize,
    ciphertext: Vec<u8>,
}

fn encrypt_bytes(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let unbound = UnboundKey::new(&AES_256_GCM, key).map_err(|_| "Invalid sync key".to_string())?;
    let key = LessSafeKey::new(unbound);
    let mut nonce_bytes = [0_u8; 12];
    SystemRandom::new()
        .fill(&mut nonce_bytes)
        .map_err(|_| "Random nonce failed".to_string())?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let mut output = plaintext.to_vec();
    key.seal_in_place_append_tag(nonce, Aad::empty(), &mut output)
        .map_err(|_| "Sync encryption failed".to_string())?;
    let mut envelope = nonce_bytes.to_vec();
    envelope.extend(output);
    Ok(envelope)
}

fn decrypt_bytes(key: &[u8; 32], envelope: &[u8]) -> Result<Vec<u8>, String> {
    if envelope.len() < 12 + aead::AES_256_GCM.tag_len() {
        return Err("Invalid encrypted sync payload".to_string());
    }
    let mut nonce_bytes = [0_u8; 12];
    nonce_bytes.copy_from_slice(&envelope[..12]);
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let key = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, key).map_err(|_| "Invalid sync key".to_string())?,
    );
    key.open_in_place(nonce, Aad::empty(), &mut envelope[12..].to_vec())
        .map(|value| value.to_vec())
        .map_err(|_| "Sync authentication failed".to_string())
}

fn encode_encrypted_segment(
    key: &[u8; 32],
    segment: &SyncSegmentEnvelope,
) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(segment).map_err(|error| error.to_string())?;
    encrypt_bytes(key, &json)
}

fn decode_encrypted_segment(key: &[u8; 32], bytes: &[u8]) -> Result<SyncSegmentEnvelope, String> {
    let json = decrypt_bytes(key, bytes)?;
    serde_json::from_slice(&json).map_err(|error| error.to_string())
}

fn encode_encrypted_manifest(key: &[u8; 32], manifest: &SyncManifest) -> Result<Vec<u8>, String> {
    encrypt_bytes(
        key,
        &serde_json::to_vec(manifest).map_err(|error| error.to_string())?,
    )
}

fn decode_encrypted_manifest(key: &[u8; 32], bytes: &[u8]) -> Result<SyncManifest, String> {
    serde_json::from_slice(&decrypt_bytes(key, bytes)?).map_err(|error| error.to_string())
}

fn build_pending_segment(
    connection: &Connection,
    scope_id: &str,
    key: &[u8; 32],
) -> Result<Option<BuiltSyncSegment>, String> {
    let records = query_journal_entries(connection, scope_id, None)?;
    build_segment_from_records(
        records
            .into_iter()
            .filter(|record| matches!(record.status.as_str(), "pending" | "retryable"))
            .collect(),
        key,
    )
}

fn build_segment_from_records(
    records: Vec<SyncJournalRecord>,
    key: &[u8; 32],
) -> Result<Option<BuiltSyncSegment>, String> {
    let mut latest = std::collections::BTreeMap::new();
    for record in records {
        latest.insert((record.object_type.clone(), record.object_id.clone()), record);
    }
    if latest.is_empty() {
        return Ok(None);
    }
    let mut objects = latest
        .into_values()
        .map(|record| {
            Ok(SyncWireObject {
                sequence: record.sequence,
                object_id: record.object_id,
                object_type: record.object_type,
                operation: record.operation,
                device_id: record.device_id,
                logical_clock: record.logical_clock,
                wall_clock: record.wall_clock,
                base_hash: record.base_hash,
                payload_hash: record.payload_hash,
                payload: serde_json::from_str(&record.payload_json)
                    .map_err(|error| error.to_string())?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    objects.sort_by_key(|object| object.sequence);
    let sequence_start = objects.first().expect("non-empty segment").sequence;
    let sequence_end = objects.last().expect("non-empty segment").sequence;
    let ciphertext = encode_encrypted_segment(
        key,
        &SyncSegmentEnvelope {
            version: 1,
            sequence_start,
            sequence_end,
            objects,
        },
    )?;
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest as _;
    hasher.update(&ciphertext);
    Ok(Some(BuiltSyncSegment {
        sequence_start,
        sequence_end,
        hash: format!("{:x}", hasher.finalize()),
        size: ciphertext.len(),
        ciphertext,
    }))
}

const SYNC_KEYRING_SERVICE: &str = "app.yomika.sync";
const WEBDAV_KEYRING_SERVICE: &str = "app.yomika.webdav";

pub trait WebdavCredentialStore {
    fn set_credential(&self, credential_ref: &str, credential: &str) -> Result<(), String>;
    fn delete_credential(&self, credential_ref: &str) -> Result<(), String>;
    fn get_credential(&self, credential_ref: &str) -> Result<String, String>;
}

struct SystemWebdavCredentialStore;

impl WebdavCredentialStore for SystemWebdavCredentialStore {
    fn set_credential(&self, credential_ref: &str, credential: &str) -> Result<(), String> {
        keyring::Entry::new(WEBDAV_KEYRING_SERVICE, credential_ref)
            .map_err(|error| error.to_string())?
            .set_password(credential)
            .map_err(|error| error.to_string())
    }

    fn delete_credential(&self, credential_ref: &str) -> Result<(), String> {
        keyring::Entry::new(WEBDAV_KEYRING_SERVICE, credential_ref)
            .map_err(|error| error.to_string())?
            .delete_credential()
            .map_err(|error| error.to_string())
    }

    fn get_credential(&self, credential_ref: &str) -> Result<String, String> {
        keyring::Entry::new(WEBDAV_KEYRING_SERVICE, credential_ref)
            .map_err(|error| error.to_string())?
            .get_password()
            .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWebdavAccountInput {
    id: String,
    label: String,
    base_url: String,
    username: String,
    credential: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdavAccountRecord {
    id: String,
    label: String,
    base_url: String,
    username: String,
    credential_ref: String,
    status: String,
    last_probe_at: Option<String>,
    last_error_code: Option<String>,
    created_at: String,
    updated_at: String,
}

fn read_webdav_account(
    connection: &Connection,
    account_id: &str,
) -> Result<WebdavAccountRecord, String> {
    connection
        .query_row(
            "SELECT id, label, base_url, username, credential_ref, status,
                    last_probe_at, last_error_code, created_at, updated_at
             FROM webdav_accounts WHERE id = ?1",
            params![account_id],
            |row| {
                Ok(WebdavAccountRecord {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    base_url: row.get(2)?,
                    username: row.get(3)?,
                    credential_ref: row.get(4)?,
                    status: row.get(5)?,
                    last_probe_at: row.get(6)?,
                    last_error_code: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

pub fn save_webdav_account_record(
    connection: &mut Connection,
    credentials: &dyn WebdavCredentialStore,
    input: SaveWebdavAccountInput,
) -> CommandResult<WebdavAccountRecord> {
    let parsed_url = match Url::parse(&input.base_url) {
        Ok(url)
            if matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none() =>
        {
            url
        }
        _ => return CommandResult::failure("INVALID_RESPONSE", "Invalid WebDAV URL", false),
    };
    if input.id.is_empty()
        || !input
            .id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        || input.label.trim().is_empty()
        || input.credential.is_empty()
    {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid WebDAV account", false);
    }
    let mut credential_nonce = [0_u8; 12];
    if SystemRandom::new().fill(&mut credential_nonce).is_err() {
        return CommandResult::failure("UNKNOWN", "Credential reference generation failed", true);
    }
    let credential_ref = format!(
        "{}-{}",
        input.id,
        credential_nonce
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    if let Err(error) = credentials.set_credential(&credential_ref, &input.credential) {
        return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false);
    }

    let old_credential_ref: Option<String> = connection
        .query_row(
            "SELECT credential_ref FROM webdav_accounts WHERE id = ?1",
            params![input.id],
            |row| row.get(0),
        )
        .ok();

    let transaction = match connection.transaction() {
        Ok(transaction) => transaction,
        Err(error) => {
            let _ = credentials.delete_credential(&credential_ref);
            return CommandResult::failure("UNKNOWN", error.to_string(), true);
        }
    };
    if let Err(error) = transaction.execute(
        "INSERT INTO webdav_accounts
            (id, label, base_url, username, credential_ref)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            base_url = excluded.base_url,
            username = excluded.username,
            credential_ref = excluded.credential_ref,
            status = 'unverified',
            last_probe_at = NULL,
            last_error_code = NULL,
            updated_at = CURRENT_TIMESTAMP",
        params![
            input.id,
            input.label.trim(),
            parsed_url.as_str().trim_end_matches('/'),
            input.username.trim(),
            credential_ref,
        ],
    ) {
        let _ = credentials.delete_credential(&credential_ref);
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    let record = match read_webdav_account(&transaction, &input.id) {
        Ok(record) => record,
        Err(error) => {
            let _ = credentials.delete_credential(&credential_ref);
            return CommandResult::failure("UNKNOWN", error, true);
        }
    };
    if let Err(error) = transaction.commit() {
        let _ = credentials.delete_credential(&credential_ref);
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    if let Some(old_ref) = old_credential_ref {
        if old_ref != credential_ref {
            let _ = credentials.delete_credential(&old_ref);
        }
    }
    CommandResult::success(record)
}

#[tauri::command]
pub fn save_webdav_account(
    input: SaveWebdavAccountInput,
    database: State<'_, Database>,
) -> CommandResult<WebdavAccountRecord> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    save_webdav_account_record(&mut connection, &SystemWebdavCredentialStore, input)
}

fn query_webdav_accounts(connection: &Connection) -> Result<Vec<WebdavAccountRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, label, base_url, username, credential_ref, status,
                    last_probe_at, last_error_code, created_at, updated_at
             FROM webdav_accounts ORDER BY label COLLATE NOCASE, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(WebdavAccountRecord {
                id: row.get(0)?,
                label: row.get(1)?,
                base_url: row.get(2)?,
                username: row.get(3)?,
                credential_ref: row.get(4)?,
                status: row.get(5)?,
                last_probe_at: row.get(6)?,
                last_error_code: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_webdav_accounts(
    database: State<'_, Database>,
) -> CommandResult<Vec<WebdavAccountRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match query_webdav_accounts(&connection) {
        Ok(accounts) => CommandResult::success(accounts),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

fn load_sync_key(account_id: &str) -> Result<[u8; 32], String> {
    let encoded = keyring::Entry::new(SYNC_KEYRING_SERVICE, account_id)
        .map_err(|error| error.to_string())?
        .get_password()
        .map_err(|error| error.to_string())?;
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|error| error.to_string())?;
    bytes
        .try_into()
        .map_err(|_| "Invalid stored sync key".to_string())
}

#[tauri::command]
pub fn encrypt_sync_manifest(account_id: String, manifest: SyncManifest) -> CommandResult<Vec<u8>> {
    let key = match load_sync_key(&account_id) {
        Ok(key) => key,
        Err(error) => return CommandResult::failure("UNKNOWN", error, false),
    };
    match encode_encrypted_manifest(&key, &manifest) {
        Ok(ciphertext) => CommandResult::success(ciphertext),
        Err(error) => CommandResult::failure("UNKNOWN", error, false),
    }
}

#[tauri::command]
pub fn decrypt_sync_manifest(
    account_id: String,
    ciphertext: Vec<u8>,
) -> CommandResult<SyncManifest> {
    let key = match load_sync_key(&account_id) {
        Ok(key) => key,
        Err(error) => return CommandResult::failure("UNKNOWN", error, false),
    };
    match decode_encrypted_manifest(&key, &ciphertext) {
        Ok(manifest) => CommandResult::success(manifest),
        Err(error) => CommandResult::failure("INVALID_RESPONSE", error, false),
    }
}

#[tauri::command]
pub fn create_sync_key(account_id: String) -> CommandResult<String> {
    if account_id.is_empty()
        || !account_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid sync account ID", false);
    }
    let mut key = [0_u8; 32];
    if SystemRandom::new().fill(&mut key).is_err() {
        return CommandResult::failure("UNKNOWN", "Sync key generation failed", true);
    }
    let encoded = BASE64_STANDARD.encode(key);
    let result = keyring::Entry::new(SYNC_KEYRING_SERVICE, &account_id)
        .map_err(|error| error.to_string())
        .and_then(|entry| {
            entry
                .set_password(&encoded)
                .map_err(|error| error.to_string())
        });
    match result {
        Ok(()) => CommandResult::success(account_id),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command]
pub fn build_sync_segment(
    account_id: String,
    scope_id: String,
    database: State<'_, Database>,
) -> CommandResult<Option<BuiltSyncSegment>> {
    let key = match load_sync_key(&account_id) {
        Ok(key) => key,
        Err(error) => return CommandResult::failure("UNKNOWN", error, false),
    };
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match build_pending_segment(&connection, &scope_id, &key) {
        Ok(segment) => CommandResult::success(segment),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

fn set_journal_batch_state(
    connection: &mut Connection,
    scope_id: &str,
    sequences: &[i64],
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    for sequence in sequences {
        transaction.execute(
            "UPDATE sync_journal SET status = ?1,
                attempt_count = attempt_count + CASE WHEN ?1 IN ('retryable','failed') THEN 1 ELSE 0 END,
                last_error = ?2, updated_at = CURRENT_TIMESTAMP
             WHERE scope_id = ?3 AND sequence = ?4",
            params![status, error, scope_id, sequence],
        ).map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())
}

fn sync_error(error: impl std::fmt::Display) -> String { error.to_string() }

#[tauri::command]
pub fn sync_webdav_scope(
    account_id: String,
    scope_id: String,
    database: State<'_, Database>,
) -> CommandResult<usize> {
    tauri::async_runtime::block_on(async move {
    let (account, key, claimed, segment, device_id) = {
        let mut connection = match database.connection.lock() {
            Ok(connection) => connection,
            Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
        };
        let account = match read_webdav_account(&connection, &account_id) {
            Ok(account) => account,
            Err(error) => return CommandResult::failure("NOT_FOUND", error, false),
        };
        let key = match load_sync_key(&account_id) {
            Ok(key) => key,
            Err(error) => return CommandResult::failure("UNKNOWN", error, false),
        };
        let device_id = {
            let transaction = match connection.transaction() {
                Ok(transaction) => transaction,
                Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
            };
            let device_id = match get_or_create_device_id(&transaction) {
                Ok(device_id) => device_id,
                Err(error) => return CommandResult::failure("UNKNOWN", error, true),
            };
            if let Err(error) = transaction.commit() {
                return CommandResult::failure("UNKNOWN", error.to_string(), true);
            }
            device_id
        };
        let claimed = match claim_journal_entries(&mut connection, &scope_id, 256) {
            Ok(records) => records,
            Err(error) => return CommandResult::failure("UNKNOWN", error, true),
        };
        if claimed.is_empty() {
            return CommandResult::success(0);
        }
        let segment = match build_segment_from_records(claimed.clone(), &key) {
            Ok(Some(segment)) => segment,
            Ok(None) => return CommandResult::success(0),
            Err(error) => {
                let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
                let _ = set_journal_batch_state(&mut connection, &scope_id, &sequences, "retryable", Some(&error));
                return CommandResult::failure("INVALID_RESPONSE", error, false);
            }
        };
        (account, key, claimed, segment, device_id)
    };

    let credential = match SystemWebdavCredentialStore.get_credential(&account.credential_ref) {
        Ok(value) => value,
        Err(error) => {
            let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
            let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
            let _ = set_journal_batch_state(&mut connection, &scope_id, &sequences, "retryable", Some(&error));
            return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false);
        }
    };
    let client = match WebdavClient::new(&account.base_url, &account.username, &credential) {
        Ok(client) => client,
        Err(error) => {
            let message = sync_error(error);
            let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
            let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
            let _ = set_journal_batch_state(&mut connection, &scope_id, &sequences, "retryable", Some(&message));
            return CommandResult::failure("INVALID_RESPONSE", message, false);
        }
    };
    let upload = client.upload_segment(&account.id, &device_id, segment.sequence_start, segment.sequence_end, &segment.ciphertext).await;
    if let Err(error) = upload {
        let message = sync_error(error);
        let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
        let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
        let _ = set_journal_batch_state(&mut connection, &scope_id, &sequences, "retryable", Some(&message));
        return CommandResult::failure("NETWORK", message, true);
    }

    let remote = match client.get_manifest(&account.id).await {
        Ok(value) => value,
        Err(error) => {
            let message = sync_error(error);
            let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
            let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
            let _ = set_journal_batch_state(&mut connection, &scope_id, &sequences, "retryable", Some(&message));
            return CommandResult::failure("NETWORK", message, true);
        }
    };
    let local = SyncManifest {
        version: 1,
        epoch: 0,
        segments: vec![SyncManifestSegment { hash: segment.hash, size: segment.size as u64, sequence_start: segment.sequence_start, sequence_end: segment.sequence_end }],
        device_cursors: std::collections::BTreeMap::from([(device_id, segment.sequence_end)]),
    };
    let (initial, etag) = match remote {
        Some(remote) => match decode_encrypted_manifest(&key, &remote.ciphertext) {
            Ok(remote_manifest) => (merge_manifests(&local, &remote_manifest), remote.etag),
            Err(error) => {
                let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
                let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
                let _ = set_journal_batch_state(&mut connection, &scope_id, &sequences, "retryable", Some(&error));
                return CommandResult::failure("INVALID_RESPONSE", error, false);
            }
        },
        None => (local, None),
    };
    let ciphertext = match encode_encrypted_manifest(&key, &initial) { Ok(bytes) => bytes, Err(error) => return CommandResult::failure("UNKNOWN", error, true) };
    let result = client.update_manifest_with_retry(&account.id, ciphertext, etag, |remote_bytes| {
        let remote = decode_encrypted_manifest(&key, remote_bytes).map_err(crate::network::webdav::WebdavError::Verification)?;
        encode_encrypted_manifest(&key, &merge_manifests(&initial, &remote)).map_err(crate::network::webdav::WebdavError::Verification)
    }).await;
    if let Err(error) = result {
        let message = sync_error(error);
        let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
        let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
        let _ = set_journal_batch_state(&mut connection, &scope_id, &sequences, "retryable", Some(&message));
        return CommandResult::failure("NETWORK", message, true);
    }
    let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
    let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
    if let Err(error) = set_journal_batch_state(&mut connection, &scope_id, &sequences, "completed", None) {
        return CommandResult::failure("UNKNOWN", error, true);
    }
    CommandResult::success(claimed.len())
    })
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncJournalInput {
    scope_id: String,
    object_id: String,
    object_type: String,
    operation: String,
    device_id: String,
    logical_clock: i64,
    base_hash: Option<String>,
    payload_hash: String,
    payload_json: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncJournalRecord {
    sequence: i64,
    scope_id: String,
    object_id: String,
    object_type: String,
    operation: String,
    device_id: String,
    logical_clock: i64,
    wall_clock: String,
    base_hash: Option<String>,
    payload_hash: String,
    payload_json: String,
    status: String,
    attempt_count: i64,
    last_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncJournalStateInput {
    scope_id: String,
    sequence: i64,
    status: String,
    error: Option<String>,
}

fn validate_input(input: &SyncJournalInput) -> Result<(), String> {
    if input.scope_id.trim().is_empty()
        || input.object_id.trim().is_empty()
        || input.object_type.trim().is_empty()
        || input.device_id.trim().is_empty()
        || input.payload_hash.trim().is_empty()
        || input.logical_clock < 0
        || !matches!(input.operation.as_str(), "upsert" | "delete")
        || serde_json::from_str::<serde_json::Value>(&input.payload_json).is_err()
    {
        return Err("Invalid sync journal entry".to_string());
    }
    Ok(())
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncJournalRecord> {
    Ok(SyncJournalRecord {
        sequence: row.get(0)?,
        scope_id: row.get(1)?,
        object_id: row.get(2)?,
        object_type: row.get(3)?,
        operation: row.get(4)?,
        device_id: row.get(5)?,
        logical_clock: row.get(6)?,
        wall_clock: row.get(7)?,
        base_hash: row.get(8)?,
        payload_hash: row.get(9)?,
        payload_json: row.get(10)?,
        status: row.get(11)?,
        attempt_count: row.get(12)?,
        last_error: row.get(13)?,
    })
}

pub(crate) fn append_journal_entry(
    connection: &Connection,
    input: SyncJournalInput,
) -> Result<SyncJournalRecord, String> {
    validate_input(&input)?;
    connection
        .execute(
            "INSERT INTO sync_journal (
                scope_id, object_id, object_type, operation, device_id,
                logical_clock, base_hash, payload_hash, payload_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                input.scope_id,
                input.object_id,
                input.object_type,
                input.operation,
                input.device_id,
                input.logical_clock,
                input.base_hash,
                input.payload_hash,
                input.payload_json,
            ],
        )
        .map_err(|error| error.to_string())?;
    let sequence = connection.last_insert_rowid();
    connection
        .query_row(
            "SELECT sequence, scope_id, object_id, object_type, operation, device_id,
                    logical_clock, wall_clock, base_hash, payload_hash, payload_json,
                    status, attempt_count, last_error
             FROM sync_journal WHERE sequence = ?1",
            params![sequence],
            row_to_record,
        )
        .map_err(|error| error.to_string())
}

/// Append a dedup relation mutation to the shared sync journal.
/// Kept here so all sync records use the same device/clock/hash rules.
pub(crate) fn append_dedup_journal(
    connection: &mut Connection,
    scope_id: &str,
    pair_key: &str,
    operation: &str,
    left_archive_id: &str,
    right_archive_id: &str,
    tombstoned: bool,
) -> Result<(), String> {
    if scope_id.trim().is_empty() || pair_key.trim().is_empty() || !matches!(operation, "upsert" | "delete") {
        return Err("Invalid dedup sync relation".into());
    }
    let payload = serde_json::json!({
        "pairKey": pair_key,
        "leftArchiveId": left_archive_id,
        "rightArchiveId": right_archive_id,
        "tombstoned": tombstoned,
    });
    let payload_json = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    let payload_hash = format!("{:x}", sha2::Sha256::digest(payload_json.as_bytes()));
    use sha2::Digest as _;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let device_id = get_or_create_device_id(&transaction)?;
    let logical_clock: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(logical_clock), 0) + 1 FROM sync_journal WHERE scope_id=?1 AND object_id=?2",
        params![scope_id, pair_key],
        |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO sync_journal (scope_id,object_id,object_type,operation,device_id,logical_clock,payload_hash,payload_json)
         VALUES (?1,?2,'dedup_non_duplicate',?3,?4,?5,?6,?7)",
        params![scope_id, pair_key, operation, device_id, logical_clock, payload_hash, payload_json],
    ).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn query_journal_entries(
    connection: &Connection,
    scope_id: &str,
    status: Option<&str>,
) -> Result<Vec<SyncJournalRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT sequence, scope_id, object_id, object_type, operation, device_id,
                    logical_clock, wall_clock, base_hash, payload_hash, payload_json,
                    status, attempt_count, last_error
             FROM sync_journal
             WHERE scope_id = ?1 AND (?2 IS NULL OR status = ?2)
             ORDER BY sequence",
        )
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map(params![scope_id, status], row_to_record)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(records)
}

fn update_journal_state(
    connection: &Connection,
    scope_id: &str,
    sequence: i64,
    status: &str,
    error: Option<&str>,
) -> Result<SyncJournalRecord, String> {
    if !matches!(
        status,
        "pending" | "retryable" | "processing" | "completed" | "failed"
    ) {
        return Err("Invalid sync journal status".to_string());
    }
    let changed = connection
        .execute(
            "UPDATE sync_journal
             SET status = ?1,
                 attempt_count = attempt_count + CASE WHEN ?1 IN ('retryable', 'failed') THEN 1 ELSE 0 END,
                 last_error = ?2,
                 updated_at = CURRENT_TIMESTAMP
             WHERE scope_id = ?3 AND sequence = ?4",
            params![status, error, scope_id, sequence],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("Sync journal entry not found".to_string());
    }
    query_journal_entries(connection, scope_id, None)?
        .into_iter()
        .find(|entry| entry.sequence == sequence)
        .ok_or_else(|| "Sync journal entry not found".to_string())
}

fn claim_journal_entries(
    connection: &mut Connection,
    scope_id: &str,
    limit: i64,
) -> Result<Vec<SyncJournalRecord>, String> {
    if limit <= 0 || limit > 256 {
        return Err("Invalid sync journal claim limit".to_string());
    }
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let sequences = {
        let mut statement = transaction
            .prepare(
                "SELECT sequence FROM sync_journal
                 WHERE scope_id = ?1 AND status IN ('pending', 'retryable')
                 ORDER BY sequence LIMIT ?2",
            )
            .map_err(|error| error.to_string())?;
        let result = statement
            .query_map(params![scope_id, limit], |row| row.get::<_, i64>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        result
    };
    let mut records = Vec::with_capacity(sequences.len());
    for sequence in sequences {
        transaction
            .execute(
                "UPDATE sync_journal SET status = 'processing', updated_at = CURRENT_TIMESTAMP
                 WHERE scope_id = ?1 AND sequence = ?2 AND status IN ('pending', 'retryable')",
                params![scope_id, sequence],
            )
            .map_err(|error| error.to_string())?;
        records.push(
            transaction
                .query_row(
                    "SELECT sequence, scope_id, object_id, object_type, operation, device_id,
                            logical_clock, wall_clock, base_hash, payload_hash, payload_json,
                            status, attempt_count, last_error
                     FROM sync_journal WHERE scope_id = ?1 AND sequence = ?2",
                    params![scope_id, sequence],
                    row_to_record,
                )
                .map_err(|error| error.to_string())?,
        );
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(records)
}

#[tauri::command]
pub fn claim_sync_journal(
    scope_id: String,
    limit: i64,
    database: State<'_, Database>,
) -> CommandResult<Vec<SyncJournalRecord>> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match claim_journal_entries(&mut connection, &scope_id, limit) {
        Ok(records) => CommandResult::success(records),
        Err(error) => CommandResult::failure("INVALID_RESPONSE", error, false),
    }
}

#[tauri::command]
pub fn append_sync_journal(
    entry: SyncJournalInput,
    database: State<'_, Database>,
) -> CommandResult<SyncJournalRecord> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match append_journal_entry(&connection, entry) {
        Ok(record) => CommandResult::success(record),
        Err(error) => CommandResult::failure("INVALID_RESPONSE", error, false),
    }
}

#[tauri::command]
pub fn list_sync_journal(
    scope_id: String,
    status: Option<String>,
    database: State<'_, Database>,
) -> CommandResult<Vec<SyncJournalRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match query_journal_entries(&connection, &scope_id, status.as_deref()) {
        Ok(records) => CommandResult::success(records),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command]
pub fn set_sync_journal_state(
    input: SyncJournalStateInput,
    database: State<'_, Database>,
) -> CommandResult<SyncJournalRecord> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match update_journal_state(
        &connection,
        &input.scope_id,
        input.sequence,
        &input.status,
        input.error.as_deref(),
    ) {
        Ok(record) => CommandResult::success(record),
        Err(error) => CommandResult::failure("INVALID_RESPONSE", error, false),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use rusqlite::Connection;

    use super::*;

    fn migrated_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .expect("initial migration");
        connection
            .execute_batch(include_str!("../../migrations/0002_local_library.sql"))
            .expect("library migration");
        connection
            .execute_batch(include_str!("../../migrations/0003_sync_journal.sql"))
            .expect("sync journal migration");
        connection
            .execute_batch(include_str!("../../migrations/0006_webdav_accounts.sql"))
            .expect("webdav accounts migration");
        connection
    }

    struct MemoryWebdavCredentialStore {
        writes: Mutex<Vec<(String, String)>>,
        deletes: Mutex<Vec<String>>,
        failure: Option<&'static str>,
    }

    impl WebdavCredentialStore for MemoryWebdavCredentialStore {
        fn set_credential(&self, credential_ref: &str, credential: &str) -> Result<(), String> {
            if let Some(message) = self.failure {
                return Err(message.to_string());
            }
            self.writes
                .lock()
                .expect("credential store lock")
                .push((credential_ref.to_string(), credential.to_string()));
            Ok(())
        }

        fn delete_credential(&self, credential_ref: &str) -> Result<(), String> {
            self.deletes
                .lock()
                .expect("credential delete lock")
                .push(credential_ref.to_string());
            Ok(())
        }

        fn get_credential(&self, credential_ref: &str) -> Result<String, String> {
            self.writes
                .lock()
                .expect("credential store lock")
                .iter()
                .find(|(reference, _)| reference == credential_ref)
                .map(|(_, value)| value.clone())
                .ok_or_else(|| "credential not found".to_string())
        }
    }

    fn webdav_input(base_url: &str) -> SaveWebdavAccountInput {
        SaveWebdavAccountInput {
            id: "account-a".to_string(),
            label: "Personal WebDAV".to_string(),
            base_url: base_url.to_string(),
            username: "reader".to_string(),
            credential: "secret-token".to_string(),
        }
    }

    fn input(scope_id: &str, object_id: &str) -> SyncJournalInput {
        SyncJournalInput {
            scope_id: scope_id.to_string(),
            object_id: object_id.to_string(),
            object_type: "reading_progress".to_string(),
            operation: "upsert".to_string(),
            device_id: "device-a".to_string(),
            logical_clock: 1,
            base_hash: None,
            payload_hash: "hash-a".to_string(),
            payload_json: r#"{"page":3,"pageCount":10}"#.to_string(),
        }
    }

    #[test]
    fn journal_sequences_are_monotonic_and_scope_queries_are_isolated() {
        let connection = migrated_connection();
        let first = append_journal_entry(&connection, input("scope-a", "archive-a"))
            .expect("first journal entry");
        let second = append_journal_entry(&connection, input("scope-a", "archive-b"))
            .expect("second journal entry");
        append_journal_entry(&connection, input("scope-b", "archive-c"))
            .expect("other scope journal entry");

        assert!(second.sequence > first.sequence);
        let entries =
            query_journal_entries(&connection, "scope-a", None).expect("scope journal entries");
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|entry| entry.scope_id == "scope-a"));
    }

    #[test]
    fn journal_retry_state_and_attempt_count_survive_reopen() {
        let path = std::env::temp_dir().join(format!(
            "yomika-sync-journal-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        {
            let connection = Connection::open(&path).expect("database");
            connection
                .execute_batch(include_str!("../../migrations/0001_initial.sql"))
                .expect("initial migration");
            connection
                .execute_batch(include_str!("../../migrations/0002_local_library.sql"))
                .expect("library migration");
            connection
                .execute_batch(include_str!("../../migrations/0003_sync_journal.sql"))
                .expect("sync journal migration");
            let entry = append_journal_entry(&connection, input("scope-a", "archive-a"))
                .expect("journal entry");
            update_journal_state(
                &connection,
                "scope-a",
                entry.sequence,
                "retryable",
                Some("network unavailable"),
            )
            .expect("retryable state");
        }

        let reopened = Connection::open(&path).expect("reopened database");
        let entries = query_journal_entries(&reopened, "scope-a", Some("retryable"))
            .expect("retryable entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].attempt_count, 1);
        assert_eq!(
            entries[0].last_error.as_deref(),
            Some("network unavailable")
        );
        drop(reopened);
        std::fs::remove_file(path).expect("remove test database");
    }

    #[test]
    fn claim_journal_marks_bounded_scope_batch_processing_atomically() {
        let mut connection = migrated_connection();
        append_journal_entry(&connection, input("scope-a", "archive-a")).expect("first");
        append_journal_entry(&connection, input("scope-a", "archive-b")).expect("second");
        append_journal_entry(&connection, input("scope-b", "archive-c")).expect("other scope");
        let retryable = append_journal_entry(&connection, input("scope-a", "archive-d")).expect("retryable");
        update_journal_state(&connection, "scope-a", retryable.sequence, "retryable", Some("offline"))
            .expect("retryable state");

        let claimed = claim_journal_entries(&mut connection, "scope-a", 2).expect("claim batch");

        assert_eq!(claimed.len(), 2);
        assert_eq!(claimed.iter().map(|record| record.sequence).collect::<Vec<_>>(), vec![1, 2]);
        assert!(claimed.iter().all(|record| record.status == "processing"));
        assert_eq!(claimed[0].attempt_count, 0);
        let pending: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_journal WHERE scope_id = 'scope-a' AND status IN ('pending', 'retryable')",
                [],
                |row| row.get(0),
            )
            .expect("remaining pending count");
        assert_eq!(pending, 1);
    }

    #[test]
    fn encrypted_segment_round_trips_and_tampering_fails() {
        let key = [7_u8; 32];
        let segment = SyncSegmentEnvelope {
            version: 1,
            sequence_start: 1,
            sequence_end: 1,
            objects: vec![SyncWireObject {
                sequence: 1,
                object_id: "archive-a".to_string(),
                object_type: "reading_progress".to_string(),
                operation: "upsert".to_string(),
                device_id: "device-a".to_string(),
                logical_clock: 1,
                wall_clock: "2026-08-26T00:00:00Z".to_string(),
                base_hash: None,
                payload_hash: "hash-a".to_string(),
                payload: serde_json::json!({"page": 3}),
            }],
        };
        let encoded = encode_encrypted_segment(&key, &segment).expect("encode segment");
        assert_ne!(encoded, serde_json::to_vec(&segment).expect("plain json"));
        let decoded = decode_encrypted_segment(&key, &encoded).expect("decode segment");
        assert_eq!(decoded.objects.len(), 1);
        assert_eq!(decoded.objects[0].object_id, "archive-a");
        let mut tampered = encoded.clone();
        *tampered.last_mut().expect("ciphertext") ^= 1;
        assert!(decode_encrypted_segment(&key, &tampered).is_err());
    }

    #[test]
    fn encrypted_manifest_hides_device_and_round_trips() {
        let key = [9_u8; 32];
        let manifest = SyncManifest {
            version: 3,
            epoch: 4,
            segments: vec![SyncManifestSegment {
                hash: "abc".to_string(),
                size: 12,
                sequence_start: 1,
                sequence_end: 2,
            }],
            device_cursors: std::collections::BTreeMap::from([("device-a".to_string(), 2)]),
        };
        let encoded = encode_encrypted_manifest(&key, &manifest).expect("encode manifest");
        assert!(!String::from_utf8_lossy(&encoded).contains("device-a"));
        assert_eq!(
            decode_encrypted_manifest(&key, &encoded)
                .expect("decode manifest")
                .epoch,
            4
        );
    }

    #[test]
    fn pending_segment_coalesces_latest_object_and_keeps_range() {
        let connection = migrated_connection();
        append_journal_entry(&connection, input("scope-a", "archive-a")).expect("first");
        let mut newer = input("scope-a", "archive-a");
        newer.logical_clock = 2;
        newer.payload_json = r#"{"page":4}"#.to_string();
        append_journal_entry(&connection, newer).expect("newer");
        append_journal_entry(&connection, input("scope-a", "archive-b")).expect("second object");

        let segment = build_pending_segment(&connection, "scope-a", &[3_u8; 32])
            .expect("segment")
            .expect("pending segment");
        assert_eq!((segment.sequence_start, segment.sequence_end), (2, 3));
        let decoded = decode_encrypted_segment(&[3_u8; 32], &segment.ciphertext).expect("decode");
        assert_eq!(decoded.objects.len(), 2);
        assert_eq!(decoded.objects[0].logical_clock, 2);
        assert_eq!(segment.size, segment.ciphertext.len());
        assert_eq!(segment.hash.len(), 64);
    }

    #[test]
    fn pending_segment_keeps_distinct_object_types_with_same_object_id() {
        let connection = migrated_connection();
        append_journal_entry(&connection, input("scope-a", "scope-a/archive-a")).expect("progress");
        let mut history = input("scope-a", "scope-a/archive-a");
        history.object_type = "history".to_string();
        history.payload_json = r#"{"pageIndex":3}"#.to_string();
        append_journal_entry(&connection, history).expect("history");

        let segment = build_pending_segment(&connection, "scope-a", &[4_u8; 32])
            .expect("segment")
            .expect("pending segment");
        let decoded = decode_encrypted_segment(&[4_u8; 32], &segment.ciphertext).expect("decode");
        assert_eq!(decoded.objects.len(), 2);
        assert_eq!(
            decoded.objects.iter().map(|item| item.object_type.as_str()).collect::<Vec<_>>(),
            vec!["reading_progress", "history"],
        );
    }

    #[test]
    fn manifest_merge_unions_segments_and_takes_max_cursors() {
        let local = SyncManifest {
            version: 3,
            epoch: 4,
            segments: vec![SyncManifestSegment {
                hash: "a".to_string(),
                size: 10,
                sequence_start: 1,
                sequence_end: 2,
            }],
            device_cursors: std::collections::BTreeMap::from([("device-a".to_string(), 2)]),
        };
        let remote = SyncManifest {
            version: 2,
            epoch: 5,
            segments: vec![
                SyncManifestSegment {
                    hash: "a".to_string(),
                    size: 10,
                    sequence_start: 1,
                    sequence_end: 2,
                },
                SyncManifestSegment {
                    hash: "b".to_string(),
                    size: 20,
                    sequence_start: 3,
                    sequence_end: 4,
                },
            ],
            device_cursors: std::collections::BTreeMap::from([
                ("device-a".to_string(), 1),
                ("device-b".to_string(), 4),
            ]),
        };
        let merged = merge_manifests(&local, &remote);
        assert_eq!((merged.version, merged.epoch), (3, 5));
        assert_eq!(merged.segments.len(), 2);
        assert_eq!(merged.device_cursors["device-a"], 2);
        assert_eq!(merged.device_cursors["device-b"], 4);
    }

    #[test]
    fn webdav_credential_failure_leaves_sqlite_unchanged() {
        let mut connection = migrated_connection();
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(Vec::new()),
            deletes: Mutex::new(Vec::new()),
            failure: Some("secure storage unavailable"),
        };

        let result = save_webdav_account_record(
            &mut connection,
            &credentials,
            webdav_input("https://dav.example.com/Yomika"),
        );

        assert!(matches!(result, CommandResult::Failure { .. }));
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM webdav_accounts", [], |row| row.get(0))
            .expect("account count");
        assert_eq!(count, 0);
    }

    #[test]
    fn webdav_credential_failure_leaves_existing_account_unchanged() {
        let mut connection = migrated_connection();
        connection
            .execute(
                "INSERT INTO webdav_accounts
                    (id, label, base_url, username, credential_ref)
                 VALUES ('account-a', 'Old label', 'https://old.example.com', 'old-user', 'old-ref')",
                [],
            )
            .expect("seed account");
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(Vec::new()),
            deletes: Mutex::new(Vec::new()),
            failure: Some("secure storage unavailable"),
        };
        let mut changed = webdav_input("https://new.example.com/Yomika");
        changed.label = "New label".to_string();

        let result = save_webdav_account_record(&mut connection, &credentials, changed);

        assert!(matches!(result, CommandResult::Failure { .. }));
        let stored: (String, String, String, String) = connection
            .query_row(
                "SELECT label, base_url, username, credential_ref FROM webdav_accounts WHERE id = 'account-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("existing account");
        assert_eq!(
            stored,
            (
                "Old label".to_string(),
                "https://old.example.com".to_string(),
                "old-user".to_string(),
                "old-ref".to_string(),
            )
        );
    }

    #[test]
    fn sqlite_failure_removes_staged_webdav_credential() {
        let mut connection = migrated_connection();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_webdav_account
                 BEFORE INSERT ON webdav_accounts
                 BEGIN SELECT RAISE(ABORT, 'forced failure'); END;",
            )
            .expect("failure trigger");
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(Vec::new()),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };

        let result = save_webdav_account_record(
            &mut connection,
            &credentials,
            webdav_input("https://dav.example.com/Yomika"),
        );

        assert!(matches!(result, CommandResult::Failure { .. }));
        let writes = credentials.writes.lock().expect("credential writes");
        let deletes = credentials.deletes.lock().expect("credential deletes");
        assert_eq!(writes.len(), 1);
        assert_eq!(deletes.as_slice(), &[writes[0].0.clone()]);
    }

    #[test]
    fn saved_webdav_account_keeps_plaintext_credential_out_of_sqlite_and_response() {
        let mut connection = migrated_connection();
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(Vec::new()),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };

        let result = save_webdav_account_record(
            &mut connection,
            &credentials,
            webdav_input("https://dav.example.com/Yomika/"),
        );

        let account = match result {
            CommandResult::Success { value, .. } => value,
            CommandResult::Failure { error, .. } => panic!("save failed: {}", error.message),
        };
        let writes = credentials.writes.lock().expect("credential writes");
        assert_eq!(writes.len(), 1);
        assert!(writes[0].0.starts_with("account-a-"));
        assert_eq!(writes[0].1, "secret-token");
        assert_eq!(account.base_url, "https://dav.example.com/Yomika");
        let stored_text: String = connection
            .query_row(
                "SELECT id || label || base_url || username || credential_ref || status FROM webdav_accounts",
                [],
                |row| row.get(0),
            )
            .expect("stored account text");
        assert!(!stored_text.contains("secret-token"));
        let serialized = serde_json::to_string(&account).expect("serialize account");
        assert!(!serialized.contains("secret-token"));
        assert!(!serialized.contains("credential\""));
    }

    #[test]
    fn listed_webdav_accounts_expose_only_public_metadata() {
        let mut connection = migrated_connection();
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(Vec::new()),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };
        save_webdav_account_record(
            &mut connection,
            &credentials,
            webdav_input("https://dav.example.com/Yomika"),
        );

        let accounts = query_webdav_accounts(&connection).expect("list accounts");

        assert_eq!(accounts.len(), 1);
        let serialized = serde_json::to_string(&accounts).expect("serialize accounts");
        assert!(!serialized.contains("secret-token"));
        assert!(serialized.contains("credentialRef"));
    }

    #[test]
    fn webdav_account_rejects_non_http_and_embedded_credentials_before_keyring_write() {
        let mut connection = migrated_connection();
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(Vec::new()),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };

        for invalid_url in [
            "file:///tmp/Yomika",
            "https://reader:secret@dav.example.com/Yomika",
        ] {
            let result = save_webdav_account_record(
                &mut connection,
                &credentials,
                webdav_input(invalid_url),
            );
            assert!(matches!(result, CommandResult::Failure { .. }));
        }

        assert!(credentials
            .writes
            .lock()
            .expect("credential writes")
            .is_empty());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM webdav_accounts", [], |row| row.get(0))
            .expect("account count");
        assert_eq!(count, 0);
    }
}

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use url::Url;

use crate::{
    db::Database, domain::result::CommandResult, network::webdav::WebdavClient,
    settings::get_or_create_device_id,
};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncManifestSegment {
    pub hash: String,
    pub size: u64,
    pub sequence_start: i64,
    pub sequence_end: i64,
    /// Which device wrote the segment. The change files live under the
    /// device's directory, so pulling requires this; manifests written before
    /// the pull phase lack it and their segments stay undownloadable.
    #[serde(default)]
    pub device_id: Option<String>,
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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SyncSegmentEnvelope {
    version: i64,
    /// The journal scope every object in the segment belongs to. A sync run
    /// claims one scope, so the segment is homogeneous; the pull side needs
    /// the scope to route objects into the right local tables.
    scope_id: String,
    sequence_start: i64,
    sequence_end: i64,
    objects: Vec<SyncWireObject>,
}

/// Envelope layout this build writes and reads. Version 1 (pre-pull) carried
/// no scope, so its segments cannot be routed on merge — the pull side treats
/// them as undecodable and moves on.
const SYNC_SEGMENT_VERSION: i64 = 2;

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
    let envelope: SyncSegmentEnvelope =
        serde_json::from_slice(&json).map_err(|error| error.to_string())?;
    if envelope.version != SYNC_SEGMENT_VERSION {
        return Err(format!(
            "Unsupported sync segment version {}",
            envelope.version
        ));
    }
    Ok(envelope)
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
        scope_id,
        key,
    )
}

fn build_segment_from_records(
    records: Vec<SyncJournalRecord>,
    scope_id: &str,
    key: &[u8; 32],
) -> Result<Option<BuiltSyncSegment>, String> {
    let mut latest = std::collections::BTreeMap::new();
    for record in records {
        latest.insert(
            (record.object_type.clone(), record.object_id.clone()),
            record,
        );
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
            version: SYNC_SEGMENT_VERSION,
            scope_id: scope_id.to_string(),
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
    let encoded = SystemSyncKeyStore
        .get(account_id)
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

/// Where the per-account sync master key lives. The key encrypts everything a
/// device ever uploads, so it must be stable for the account's lifetime: a
/// regenerated key would leave every existing remote ciphertext undecryptable.
trait SyncKeyStore {
    fn get(&self, account_id: &str) -> Result<String, String>;
    fn set(&self, account_id: &str, encoded: &str) -> Result<(), String>;
}

struct SystemSyncKeyStore;

impl SyncKeyStore for SystemSyncKeyStore {
    fn get(&self, account_id: &str) -> Result<String, String> {
        keyring::Entry::new(SYNC_KEYRING_SERVICE, account_id)
            .map_err(|error| error.to_string())?
            .get_password()
            .map_err(|error| error.to_string())
    }

    fn set(&self, account_id: &str, encoded: &str) -> Result<(), String> {
        keyring::Entry::new(SYNC_KEYRING_SERVICE, account_id)
            .map_err(|error| error.to_string())?
            .set_password(encoded)
            .map_err(|error| error.to_string())
    }
}

fn valid_sync_key_encoding(encoded: &str) -> bool {
    BASE64_STANDARD
        .decode(encoded)
        .map(|bytes| bytes.len() == 32)
        .unwrap_or(false)
}

/// Creates the account's sync key exactly once. An existing, well-formed key is
/// kept as-is — recreating it would orphan every ciphertext already on the
/// remote. Only a missing or corrupt entry is (re)generated.
fn ensure_sync_key(store: &dyn SyncKeyStore, account_id: &str) -> Result<(), String> {
    if let Ok(encoded) = store.get(account_id) {
        if valid_sync_key_encoding(&encoded) {
            return Ok(());
        }
    }
    let mut key = [0_u8; 32];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "Sync key generation failed".to_string())?;
    store.set(account_id, &BASE64_STANDARD.encode(key))
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
    match ensure_sync_key(&SystemSyncKeyStore, &account_id) {
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

fn sync_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// True when a remote change should overwrite the local row: a strictly higher
/// logical clock wins, an equal clock falls back to the wall clock, and a
/// lower clock is a cross-device progress regression that is refused.
fn remote_change_wins(
    local_clock: i64,
    local_updated: &str,
    remote_clock: i64,
    remote_updated: &str,
) -> bool {
    match remote_clock.cmp(&local_clock) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Equal => remote_updated > local_updated,
        std::cmp::Ordering::Less => false,
    }
}

/// Applies one remote change segment's objects to the local tables, inside a
/// single transaction. Rows written here keep the winning clock, so later
/// merges keep comparing correctly, and nothing is re-journaled — the objects
/// came from the remote's journal and re-journaling them would echo them back.
/// The return value counts the rows that actually changed.
fn apply_remote_objects(
    connection: &mut Connection,
    envelope: &SyncSegmentEnvelope,
) -> Result<usize, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let mut applied = 0;
    for object in &envelope.objects {
        if apply_remote_object(&transaction, &envelope.scope_id, object)? {
            applied += 1;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(applied)
}

/// Merges one remote object by its type. Returns false when the object was
/// skipped (unknown type, or a remote clock that lost to the local row).
fn apply_remote_object(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &SyncWireObject,
) -> Result<bool, String> {
    match object.object_type.as_str() {
        "reading_progress" => {
            apply_remote_progress(transaction, scope_id, object, &object.payload)
        }
        "history" => apply_remote_history(transaction, scope_id, object, &object.payload),
        "watchlist" | "reading_list" => {
            apply_remote_list_entry(transaction, scope_id, object, &object.payload)
        }
        "search_preset" => {
            apply_remote_search_preset(transaction, scope_id, object, &object.payload)
        }
        "dedup_non_duplicate" => {
            apply_remote_dedup_relation(transaction, scope_id, object, &object.payload)
        }
        // Unknown types are forward-compatible noise: skip, don't fail.
        _ => Ok(false),
    }
}

fn payload_text(payload: &serde_json::Value, field: &str) -> Result<String, String> {
    payload
        .get(field)
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("Remote object payload is missing {field}"))
}

fn payload_bool(payload: &serde_json::Value, field: &str) -> Result<bool, String> {
    payload
        .get(field)
        .and_then(|value| value.as_bool())
        .ok_or_else(|| format!("Remote object payload is missing {field}"))
}

/// Reads `(clock, updated_at)` of the local row, `None` when it does not exist.
fn local_row_state(
    transaction: &rusqlite::Transaction<'_>,
    table: &str,
    scope_id: &str,
    archive_id: &str,
) -> Result<Option<(i64, String)>, String> {
    transaction
        .query_row(
            &format!(
                "SELECT revision, updated_at FROM {table} WHERE scope_id = ?1 AND archive_id = ?2"
            ),
            params![scope_id, archive_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn apply_remote_progress(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &SyncWireObject,
    payload: &serde_json::Value,
) -> Result<bool, String> {
    let archive_id = payload_text(payload, "archiveId")?;
    let page_index = payload
        .get("pageIndex")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| "Remote progress payload is missing pageIndex".to_string())?;
    let page_count = payload
        .get("pageCount")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| "Remote progress payload is missing pageCount".to_string())?;
    let layout = payload_text(payload, "layout")?;
    let direction = payload_text(payload, "direction")?;
    let cover_alone = payload.get("coverAlone").and_then(|value| value.as_bool());
    let gate = local_row_state(transaction, "reading_progress", scope_id, &archive_id)?
        .map(|(clock, updated)| {
            remote_change_wins(clock, &updated, object.logical_clock, &object.wall_clock)
        })
        .unwrap_or(true);
    if !gate {
        return Ok(false);
    }
    transaction
        .execute(
            "INSERT INTO reading_progress (scope_id, archive_id, page_index, page_count, layout, direction, cover_alone, device_id, revision, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(scope_id, archive_id) DO UPDATE SET
               page_index = excluded.page_index, page_count = excluded.page_count,
               layout = excluded.layout, direction = excluded.direction,
               cover_alone = COALESCE(excluded.cover_alone, reading_progress.cover_alone),
               device_id = excluded.device_id, updated_at = excluded.updated_at,
               revision = excluded.revision",
            params![
                scope_id,
                archive_id,
                page_index,
                page_count,
                layout,
                direction,
                cover_alone,
                object.device_id,
                object.logical_clock,
                object.wall_clock,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

/// History is a union, not a clock race: the merged row keeps the highest read
/// page and the latest visit, whatever device supplied them.
fn apply_remote_history(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &SyncWireObject,
    payload: &serde_json::Value,
) -> Result<bool, String> {
    let archive_id = payload_text(payload, "archiveId")?;
    let page_index = payload
        .get("pageIndex")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| "Remote history payload is missing pageIndex".to_string())?;
    let visited_at = payload_text(payload, "visitedAt")?;
    transaction
        .execute(
            "INSERT INTO reading_history (scope_id, archive_id, page_index, visited_at, device_id, revision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(scope_id, archive_id) DO UPDATE SET
               page_index = MAX(reading_history.page_index, excluded.page_index),
               visited_at = MAX(reading_history.visited_at, excluded.visited_at),
               device_id = excluded.device_id,
               revision = MAX(reading_history.revision, excluded.revision)",
            params![
                scope_id,
                archive_id,
                page_index,
                visited_at,
                object.device_id,
                object.logical_clock,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

/// Watchlist and reading list share the watchlist shape: a clocked tombstone
/// set, where an old device's add must not resurrect a newer removal.
fn apply_remote_list_entry(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &SyncWireObject,
    payload: &serde_json::Value,
) -> Result<bool, String> {
    let table = match object.object_type.as_str() {
        "watchlist" => "watchlist",
        _ => "reading_list",
    };
    let archive_id = payload_text(payload, "archiveId")?;
    let deleted = payload_bool(payload, "deleted")?;
    let gate = local_row_state(transaction, table, scope_id, &archive_id)?
        .map(|(clock, updated)| {
            remote_change_wins(clock, &updated, object.logical_clock, &object.wall_clock)
        })
        .unwrap_or(true);
    if !gate {
        return Ok(false);
    }
    transaction
        .execute(
            &format!(
                "INSERT INTO {table} (scope_id, archive_id, added_at, updated_at, device_id, deleted_at, revision)
                 VALUES (?1, ?2, CURRENT_TIMESTAMP, ?3, ?4, CASE WHEN ?5 THEN CURRENT_TIMESTAMP ELSE NULL END, ?6)
                 ON CONFLICT(scope_id, archive_id) DO UPDATE SET
                   updated_at = excluded.updated_at, device_id = excluded.device_id,
                   deleted_at = CASE WHEN ?5 THEN COALESCE({table}.deleted_at, CURRENT_TIMESTAMP) ELSE NULL END,
                   revision = excluded.revision"
            ),
            params![
                scope_id,
                archive_id,
                object.wall_clock,
                object.device_id,
                deleted,
                object.logical_clock
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

fn apply_remote_search_preset(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &SyncWireObject,
    payload: &serde_json::Value,
) -> Result<bool, String> {
    let preset_id = payload_text(payload, "presetId")?;
    let name = payload_text(payload, "name")?;
    let query = payload_text(payload, "query").unwrap_or_default();
    let sort_by = payload_text(payload, "sortBy").unwrap_or_else(|_| "added".to_string());
    let sort_order = payload_text(payload, "sortOrder").unwrap_or_else(|_| "desc".to_string());
    let category_id = payload.get("categoryId").and_then(|value| value.as_str());
    let deleted = payload_bool(payload, "deleted").unwrap_or(false);
    let gate = transaction
        .query_row(
            "SELECT revision, updated_at FROM search_presets WHERE scope_id = ?1 AND preset_id = ?2",
            params![scope_id, preset_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .map(|(clock, updated)| {
            remote_change_wins(clock, &updated, object.logical_clock, &object.wall_clock)
        })
        .unwrap_or(true);
    if !gate {
        return Ok(false);
    }
    transaction
        .execute(
            "INSERT INTO search_presets (scope_id, preset_id, name, query, sort_by, sort_order, category_id, device_id, deleted_at, revision, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CASE WHEN ?9 THEN CURRENT_TIMESTAMP ELSE NULL END, ?10, ?11)
             ON CONFLICT(scope_id, preset_id) DO UPDATE SET
               name = excluded.name, query = excluded.query, sort_by = excluded.sort_by,
               sort_order = excluded.sort_order, category_id = excluded.category_id,
               device_id = excluded.device_id, updated_at = excluded.updated_at,
               deleted_at = CASE WHEN ?9 THEN COALESCE(search_presets.deleted_at, CURRENT_TIMESTAMP) ELSE NULL END,
               revision = excluded.revision",
            params![
                scope_id,
                preset_id,
                name,
                query,
                sort_by,
                sort_order,
                category_id,
                object.device_id,
                deleted,
                object.logical_clock,
                object.wall_clock,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

fn apply_remote_dedup_relation(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &SyncWireObject,
    payload: &serde_json::Value,
) -> Result<bool, String> {
    let pair_key = payload_text(payload, "pairKey")?;
    let left_archive_id = payload_text(payload, "leftArchiveId")?;
    let right_archive_id = payload_text(payload, "rightArchiveId")?;
    let tombstoned = payload_bool(payload, "tombstoned")?;
    let gate: Option<(i64, String)> = transaction
        .query_row(
            "SELECT logical_clock, updated_at FROM dedup_non_duplicates
             WHERE scope_id = ?1 AND pair_key = ?2",
            params![scope_id, pair_key],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let wins = gate
        .map(|(clock, updated)| {
            remote_change_wins(clock, &updated, object.logical_clock, &object.wall_clock)
        })
        .unwrap_or(true);
    if !wins {
        return Ok(false);
    }
    transaction
        .execute(
            "INSERT INTO dedup_non_duplicates (scope_id, pair_key, left_archive_id, right_archive_id, tombstoned, updated_at, logical_clock)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(scope_id, pair_key) DO UPDATE SET
               tombstoned = excluded.tombstoned, updated_at = excluded.updated_at,
               logical_clock = excluded.logical_clock",
            params![
                scope_id,
                pair_key,
                left_archive_id,
                right_archive_id,
                i64::from(tombstoned),
                object.wall_clock,
                object.logical_clock,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

/// Reads whether an encrypted change segment has already been merged, and
/// records one after a successful apply — both for this sync account.
fn applied_segment_contains(
    connection: &Connection,
    account_id: &str,
    segment_hash: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_applied_segments WHERE account_id = ?1 AND segment_hash = ?2)",
            params![account_id, segment_hash],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())
}

fn record_applied_segment(
    connection: &mut Connection,
    account_id: &str,
    segment_hash: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO sync_applied_segments (account_id, segment_hash) VALUES (?1, ?2)
             ON CONFLICT(account_id, segment_hash) DO NOTHING",
            params![account_id, segment_hash],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Returns journal entries stranded in `processing` to the retry lane. A claim
/// flips rows to `processing` and only the same run completes them, so a crash
/// in between would otherwise make them invisible to every future claim.
pub(crate) fn recover_stuck_sync_journal(connection: &Connection) -> Result<usize, String> {
    let recovered = connection
        .execute(
            "UPDATE sync_journal SET status = 'retryable', updated_at = CURRENT_TIMESTAMP
             WHERE status = 'processing'",
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(recovered)
}

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
                    Err(error) => {
                        return CommandResult::failure("UNKNOWN", error.to_string(), true)
                    }
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
            let segment = if claimed.is_empty() {
                // Nothing local to push — the sync still pulls remote changes.
                None
            } else {
                match build_segment_from_records(claimed.clone(), &scope_id, &key) {
                    Ok(Some(segment)) => Some(segment),
                    Ok(None) => None,
                    Err(error) => {
                        let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
                        let _ = set_journal_batch_state(
                            &mut connection,
                            &scope_id,
                            &sequences,
                            "retryable",
                            Some(&error),
                        );
                        return CommandResult::failure("INVALID_RESPONSE", error, false);
                    }
                }
            };
            (account, key, claimed, segment, device_id)
        };

        sync_scope_impl(
            &database,
            &account,
            &key,
            &scope_id,
            &device_id,
            claimed,
            segment,
            &SystemWebdavCredentialStore,
        )
        .await
    })
}

/// The push + pull pipeline behind `sync_webdav_scope`, split from the command
/// so tests can drive it with an in-memory credential store against a local
/// mock server. Push: the claimed batch uploads as one immutable segment and
/// the manifest registers it with a conditional PUT (re-merge retries on
/// conflict). Pull: every manifest segment this device has not applied yet is
/// downloaded, decrypted and merged into the local tables. A pull failure is
/// not fatal — the segment stays unrecorded, so the next sync retries it.
#[allow(clippy::too_many_arguments)]
async fn sync_scope_impl(
    database: &Database,
    account: &WebdavAccountRecord,
    key: &[u8; 32],
    scope_id: &str,
    device_id: &str,
    claimed: Vec<SyncJournalRecord>,
    segment: Option<BuiltSyncSegment>,
    credentials: &dyn WebdavCredentialStore,
) -> CommandResult<usize> {
    let credential = match credentials.get_credential(&account.credential_ref) {
        Ok(value) => value,
        Err(error) => {
            let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
            let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
            let _ = set_journal_batch_state(
                &mut connection,
                scope_id,
                &sequences,
                "retryable",
                Some(&error),
            );
            return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false);
        }
    };
    let client = match WebdavClient::new(&account.base_url, &account.username, &credential) {
        Ok(client) => client,
        Err(error) => {
            let message = sync_error(error);
            let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
            let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
            let _ = set_journal_batch_state(
                &mut connection,
                scope_id,
                &sequences,
                "retryable",
                Some(&message),
            );
            return CommandResult::failure("INVALID_RESPONSE", message, false);
        }
    };
    // A device with nothing to push still pulls; the push half only runs when
    // the claim produced a segment.
    if let Some(segment) = &segment {
    let upload = client
        .upload_segment(
            &account.id,
            device_id,
            segment.sequence_start,
            segment.sequence_end,
            &segment.ciphertext,
        )
        .await;
    if let Err(error) = upload {
        let message = sync_error(error);
        let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
        let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
        let _ = set_journal_batch_state(
            &mut connection,
            scope_id,
            &sequences,
            "retryable",
            Some(&message),
        );
        return CommandResult::failure("NETWORK", message, true);
    }

    let remote = match client.get_manifest(&account.id).await {
        Ok(value) => value,
        Err(error) => {
            let message = sync_error(error);
            let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
            let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
            let _ = set_journal_batch_state(
                &mut connection,
                scope_id,
                &sequences,
                "retryable",
                Some(&message),
            );
            return CommandResult::failure("NETWORK", message, true);
        }
    };
    let local = SyncManifest {
        version: 1,
        epoch: 0,
        segments: vec![SyncManifestSegment {
            hash: segment.hash.clone(),
            size: segment.size as u64,
            sequence_start: segment.sequence_start,
            sequence_end: segment.sequence_end,
            device_id: Some(device_id.to_string()),
        }],
        device_cursors: std::collections::BTreeMap::from([(
            device_id.to_string(),
            segment.sequence_end,
        )]),
    };
    let (initial, etag) = match remote {
        Some(remote) => match decode_encrypted_manifest(key, &remote.ciphertext) {
            Ok(remote_manifest) => (merge_manifests(&local, &remote_manifest), remote.etag),
            Err(error) => {
                let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
                let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
                let _ = set_journal_batch_state(
                    &mut connection,
                    scope_id,
                    &sequences,
                    "retryable",
                    Some(&error),
                );
                return CommandResult::failure("INVALID_RESPONSE", error, false);
            }
        },
        None => (local, None),
    };
    let ciphertext = match encode_encrypted_manifest(key, &initial) {
        Ok(bytes) => bytes,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let result = client
        .update_manifest_with_retry(&account.id, ciphertext, etag, |remote_bytes| {
            let remote = decode_encrypted_manifest(key, remote_bytes)
                .map_err(crate::network::webdav::WebdavError::Verification)?;
            encode_encrypted_manifest(key, &merge_manifests(&initial, &remote))
                .map_err(crate::network::webdav::WebdavError::Verification)
        })
        .await;
    if let Err(error) = result {
        let message = sync_error(error);
        let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
        let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
        let _ = set_journal_batch_state(
            &mut connection,
            scope_id,
            &sequences,
            "retryable",
            Some(&message),
        );
        return CommandResult::failure("NETWORK", message, true);
    }
    let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
    let sequences = claimed.iter().map(|r| r.sequence).collect::<Vec<_>>();
    if let Err(error) =
        set_journal_batch_state(&mut connection, scope_id, &sequences, "completed", None)
    {
        return CommandResult::failure("UNKNOWN", error, true);
    }
    drop(connection);
    }

    // Pull phase: every manifest segment this device has not merged yet.
    let uploaded_hash = segment.as_ref().map(|segment| segment.hash.clone());
    let mut candidates = match client.get_manifest(&account.id).await {
        Ok(Some(remote)) => match decode_encrypted_manifest(key, &remote.ciphertext) {
            Ok(remote_manifest) => {
                let connection = match database.connection.lock() {
                    Ok(connection) => connection,
                    Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
                };
                remote_manifest
                    .segments
                    .iter()
                    .filter(|segment| Some(&segment.hash) != uploaded_hash.as_ref())
                    .filter(|segment| {
                        !applied_segment_contains(&connection, &account.id, &segment.hash)
                            .unwrap_or(true)
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            }
            Err(_) => Vec::new(),
        },
        _ => Vec::new(),
    };
    candidates.sort_by_key(|segment| segment.sequence_start);
    let mut pulled = 0usize;
    for segment in candidates {
        let Some(device) = segment.device_id.as_deref() else {
            continue;
        };
        let bytes = match client
            .download_segment(&account.id, device, segment.sequence_start, segment.sequence_end)
            .await
        {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let envelope = match decode_encrypted_segment(key, &bytes) {
            Ok(envelope) => envelope,
            Err(_) => continue,
        };
        let mut connection = match database.connection.lock() {
            Ok(connection) => connection,
            Err(_) => continue,
        };
        if let Ok(applied) = apply_remote_objects(&mut connection, &envelope) {
            let _ = record_applied_segment(&mut connection, &account.id, &segment.hash);
            pulled += applied;
        }
    }
    CommandResult::success(claimed.len() + pulled)
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
    if scope_id.trim().is_empty()
        || pair_key.trim().is_empty()
        || !matches!(operation, "upsert" | "delete")
    {
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
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
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
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
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
    use std::sync::{Arc, Mutex};

    use rusqlite::Connection;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
            .execute_batch(include_str!("../../migrations/0004_watchlist.sql"))
            .expect("watchlist migration");
        connection
            .execute_batch(include_str!("../../migrations/0005_reading_history.sql"))
            .expect("reading history migration");
        connection
            .execute_batch(include_str!("../../migrations/0006_webdav_accounts.sql"))
            .expect("webdav accounts migration");
        connection
            .execute_batch(include_str!("../../migrations/0008_dedup_features.sql"))
            .expect("dedup migration");
        connection
            .execute_batch(include_str!("../../migrations/0015_dedup_sessions.sql"))
            .expect("dedup sessions migration");
        connection
            .execute_batch(include_str!("../../migrations/0017_reading_list.sql"))
            .expect("reading list migration");
        connection
            .execute_batch(include_str!("../../migrations/0018_search_presets.sql"))
            .expect("search presets migration");
        connection
            .execute_batch(include_str!("../../migrations/0019_reading_progress_cover_alone.sql"))
            .expect("cover alone migration");
        connection
            .execute_batch(include_str!("../../migrations/0021_sync_pull_state.sql"))
            .expect("sync pull state migration");
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

    struct MemorySyncKeyStore {
        entries: Mutex<std::collections::BTreeMap<String, String>>,
    }

    impl MemorySyncKeyStore {
        fn new() -> Self {
            Self { entries: Mutex::new(std::collections::BTreeMap::new()) }
        }

        fn stored(&self, account_id: &str) -> Option<String> {
            self.entries
                .lock()
                .expect("sync key store lock")
                .get(account_id)
                .cloned()
        }
    }

    impl SyncKeyStore for MemorySyncKeyStore {
        fn get(&self, account_id: &str) -> Result<String, String> {
            self.stored(account_id).ok_or_else(|| "no key".to_string())
        }

        fn set(&self, account_id: &str, encoded: &str) -> Result<(), String> {
            self.entries
                .lock()
                .expect("sync key store lock")
                .insert(account_id.to_string(), encoded.to_string());
            Ok(())
        }
    }

    #[test]
    fn sync_key_creation_is_idempotent_across_saves() {
        // Re-saving the same account must not rotate the key: a rotated key
        // would leave every ciphertext already on the remote undecryptable.
        let store = MemorySyncKeyStore::new();
        ensure_sync_key(&store, "account-a").expect("first key");
        let first = store.stored("account-a").expect("stored key");
        ensure_sync_key(&store, "account-a").expect("second key");
        assert_eq!(store.stored("account-a").as_deref(), Some(first.as_str()));
    }

    #[test]
    fn corrupt_sync_key_is_repaired_with_a_fresh_valid_key() {
        let store = MemorySyncKeyStore::new();
        store.set("account-a", "not-a-key").expect("seed corrupt key");
        ensure_sync_key(&store, "account-a").expect("repair");
        let repaired = store.stored("account-a").expect("repaired key");
        assert!(valid_sync_key_encoding(&repaired));
        assert_ne!(repaired, "not-a-key");
    }

    #[test]
    fn startup_recovery_returns_stuck_processing_entries_to_retryable() {
        // A crash between claim (processing) and completion must not strand
        // entries forever: claim only picks pending/retryable, so stuck rows
        // would never upload again. Startup hands them back to the retry lane.
        let mut connection = migrated_connection();
        for scope in ["scope-a", "scope-b"] {
            append_journal_entry(&connection, input(scope, "archive-a"))
                .expect("journal entry");
        }
        connection
            .execute(
                "UPDATE sync_journal SET status='processing' WHERE scope_id='scope-a'",
                [],
            )
            .expect("stuck processing fixture");
        let recovered = recover_stuck_sync_journal(&connection).expect("recovery");
        assert_eq!(recovered, 1);
        let statuses = query_journal_entries(&connection, "scope-a", None)
            .expect("scope-a entries")
            .into_iter()
            .map(|record| record.status)
            .collect::<Vec<_>>();
        assert_eq!(statuses, vec!["retryable".to_string()]);
        // Pending entries in other scopes are untouched.
        let untouched = query_journal_entries(&connection, "scope-b", None)
            .expect("scope-b entries");
        assert_eq!(untouched[0].status, "pending");
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
        let retryable =
            append_journal_entry(&connection, input("scope-a", "archive-d")).expect("retryable");
        update_journal_state(
            &connection,
            "scope-a",
            retryable.sequence,
            "retryable",
            Some("offline"),
        )
        .expect("retryable state");

        let claimed = claim_journal_entries(&mut connection, "scope-a", 2).expect("claim batch");

        assert_eq!(claimed.len(), 2);
        assert_eq!(
            claimed
                .iter()
                .map(|record| record.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
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
            version: SYNC_SEGMENT_VERSION,
            scope_id: "scope-a".to_string(),
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
        assert_eq!(decoded.scope_id, "scope-a");
        assert_eq!(decoded.objects.len(), 1);
        assert_eq!(decoded.objects[0].object_id, "archive-a");
        let mut tampered = encoded.clone();
        *tampered.last_mut().expect("ciphertext") ^= 1;
        assert!(decode_encrypted_segment(&key, &tampered).is_err());
        // A pre-pull (v1) envelope carries no scope and must not decode.
        let mut legacy = segment.clone();
        legacy.version = 1;
        let legacy_encoded = encode_encrypted_segment(&key, &legacy).expect("encode legacy");
        assert!(decode_encrypted_segment(&key, &legacy_encoded).is_err());
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
                device_id: Some("device-a".to_string()),
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
            decoded
                .objects
                .iter()
                .map(|item| item.object_type.as_str())
                .collect::<Vec<_>>(),
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
                device_id: None,
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
                    device_id: None,
                },
                SyncManifestSegment {
                    hash: "b".to_string(),
                    size: 20,
                    sequence_start: 3,
                    sequence_end: 4,
                    device_id: None,
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

    fn remote_object(
        object_type: &str,
        object_id: &str,
        logical_clock: i64,
        wall_clock: &str,
        payload: serde_json::Value,
    ) -> SyncWireObject {
        SyncWireObject {
            sequence: 1,
            object_id: object_id.to_string(),
            object_type: object_type.to_string(),
            operation: "upsert".to_string(),
            device_id: "device-b".to_string(),
            logical_clock,
            wall_clock: wall_clock.to_string(),
            base_hash: None,
            payload_hash: "remote-hash".to_string(),
            payload,
        }
    }

    fn remote_envelope(scope_id: &str, objects: Vec<SyncWireObject>) -> SyncSegmentEnvelope {
        SyncSegmentEnvelope {
            version: SYNC_SEGMENT_VERSION,
            scope_id: scope_id.to_string(),
            sequence_start: 1,
            sequence_end: 1,
            objects,
        }
    }

    #[test]
    fn remote_progress_follows_the_logical_clock() {
        let mut connection = migrated_connection();
        connection
            .execute(
                "INSERT INTO reading_progress (scope_id, archive_id, page_index, page_count, layout, direction, device_id, revision, updated_at)
                 VALUES ('scope-a', 'archive-a', 3, 10, 'paged', 'ltr', 'device-a', 3, '2026-09-01 08:00:00')",
                [],
            )
            .expect("local progress");

        // Higher clock wins outright.
        let higher = remote_envelope(
            "scope-a",
            vec![remote_object(
                "reading_progress",
                "scope-a/archive-a",
                5,
                "2026-09-02 08:00:00",
                serde_json::json!({"archiveId": "archive-a", "pageIndex": 7, "pageCount": 10, "layout": "paged", "direction": "ltr", "coverAlone": null}),
            )],
        );
        assert_eq!(apply_remote_objects(&mut connection, &higher).expect("apply"), 1);
        let (page, revision): (i64, i64) = connection
            .query_row(
                "SELECT page_index, revision FROM reading_progress WHERE scope_id='scope-a' AND archive_id='archive-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("merged progress");
        assert_eq!((page, revision), (7, 5));

        // A lower clock is a cross-device regression and is refused.
        let lower = remote_envelope(
            "scope-a",
            vec![remote_object(
                "reading_progress",
                "scope-a/archive-a",
                4,
                "2026-09-03 08:00:00",
                serde_json::json!({"archiveId": "archive-a", "pageIndex": 1, "pageCount": 10, "layout": "paged", "direction": "ltr", "coverAlone": null}),
            )],
        );
        assert_eq!(apply_remote_objects(&mut connection, &lower).expect("apply"), 0);
        let page: i64 = connection
            .query_row(
                "SELECT page_index FROM reading_progress WHERE scope_id='scope-a' AND archive_id='archive-a'",
                [],
                |row| row.get(0),
            )
            .expect("kept progress");
        assert_eq!(page, 7);

        // Equal clock falls back to the wall clock.
        let equal_newer = remote_envelope(
            "scope-a",
            vec![remote_object(
                "reading_progress",
                "scope-a/archive-a",
                5,
                "2026-09-04 08:00:00",
                serde_json::json!({"archiveId": "archive-a", "pageIndex": 9, "pageCount": 10, "layout": "paged", "direction": "ltr", "coverAlone": null}),
            )],
        );
        assert_eq!(
            apply_remote_objects(&mut connection, &equal_newer).expect("apply"),
            1
        );
        let page: i64 = connection
            .query_row(
                "SELECT page_index FROM reading_progress WHERE scope_id='scope-a' AND archive_id='archive-a'",
                [],
                |row| row.get(0),
            )
            .expect("tie progress");
        assert_eq!(page, 9);
    }

    #[test]
    fn remote_history_keeps_the_max_page_and_latest_visit() {
        let mut connection = migrated_connection();
        connection
            .execute(
                "INSERT INTO reading_history (scope_id, archive_id, page_index, visited_at, device_id, revision)
                 VALUES ('scope-a', 'archive-a', 3, '2026-09-01 08:00:00', 'device-a', 4)",
                [],
            )
            .expect("local history");
        // A lower clock still merges: history is a union, not a race.
        let remote = remote_envelope(
            "scope-a",
            vec![remote_object(
                "history",
                "scope-a/archive-a",
                1,
                "2026-09-02 08:00:00",
                serde_json::json!({"archiveId": "archive-a", "pageIndex": 8, "visitedAt": "2026-09-02 09:30:00"}),
            )],
        );
        assert_eq!(apply_remote_objects(&mut connection, &remote).expect("apply"), 1);
        let (page, visited): (i64, String) = connection
            .query_row(
                "SELECT page_index, visited_at FROM reading_history WHERE scope_id='scope-a' AND archive_id='archive-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("merged history");
        assert_eq!(page, 8);
        assert_eq!(visited, "2026-09-02 09:30:00");
    }

    #[test]
    fn remote_watchlist_tombstone_beats_an_older_add() {
        let mut connection = migrated_connection();
        connection
            .execute(
                "INSERT INTO watchlist (scope_id, archive_id, device_id, deleted_at, revision, updated_at)
                 VALUES ('scope-a', 'archive-a', 'device-a', NULL, 2, '2026-09-01 08:00:00')",
                [],
            )
            .expect("local watchlist entry");
        // An older device's add must not resurrect the entry (lower clock).
        let older_add = remote_envelope(
            "scope-a",
            vec![remote_object(
                "watchlist",
                "scope-a/archive-a",
                1,
                "2026-09-02 08:00:00",
                serde_json::json!({"archiveId": "archive-a", "deleted": false}),
            )],
        );
        assert_eq!(
            apply_remote_objects(&mut connection, &older_add).expect("apply"),
            0
        );
        // A newer removal wins…
        let newer_delete = remote_envelope(
            "scope-a",
            vec![remote_object(
                "watchlist",
                "scope-a/archive-a",
                3,
                "2026-09-02 08:00:00",
                serde_json::json!({"archiveId": "archive-a", "deleted": true}),
            )],
        );
        assert_eq!(
            apply_remote_objects(&mut connection, &newer_delete).expect("apply"),
            1
        );
        // …and only an even newer add revives it.
        let revive = remote_envelope(
            "scope-a",
            vec![remote_object(
                "watchlist",
                "scope-a/archive-a",
                4,
                "2026-09-03 08:00:00",
                serde_json::json!({"archiveId": "archive-a", "deleted": false}),
            )],
        );
        assert_eq!(apply_remote_objects(&mut connection, &revive).expect("apply"), 1);
        let (deleted_at, revision): (Option<String>, i64) = connection
            .query_row(
                "SELECT deleted_at, revision FROM watchlist WHERE scope_id='scope-a' AND archive_id='archive-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("watchlist state");
        assert_eq!(deleted_at, None);
        assert_eq!(revision, 4);
    }

    #[test]
    fn remote_search_preset_applies_and_tombstones_by_clock() {
        let mut connection = migrated_connection();
        let upsert = remote_envelope(
            "scope-a",
            vec![remote_object(
                "search_preset",
                "scope-a/preset-a",
                2,
                "2026-09-02 08:00:00",
                serde_json::json!({"presetId": "preset-a", "name": "Fresh", "query": "female", "sortBy": "added", "sortOrder": "desc", "categoryId": null, "deleted": false}),
            )],
        );
        assert_eq!(apply_remote_objects(&mut connection, &upsert).expect("apply"), 1);
        let name: String = connection
            .query_row(
                "SELECT name FROM search_presets WHERE scope_id='scope-a' AND preset_id='preset-a'",
                [],
                |row| row.get(0),
            )
            .expect("preset");
        assert_eq!(name, "Fresh");

        let delete = remote_envelope(
            "scope-a",
            vec![remote_object(
                "search_preset",
                "scope-a/preset-a",
                3,
                "2026-09-03 08:00:00",
                serde_json::json!({"presetId": "preset-a", "name": "Fresh", "query": "female", "sortBy": "added", "sortOrder": "desc", "categoryId": null, "deleted": true}),
            )],
        );
        assert_eq!(apply_remote_objects(&mut connection, &delete).expect("apply"), 1);
        let deleted: Option<String> = connection
            .query_row(
                "SELECT deleted_at FROM search_presets WHERE scope_id='scope-a' AND preset_id='preset-a'",
                [],
                |row| row.get(0),
            )
            .expect("preset tombstone");
        assert!(deleted.is_some());
    }

    #[test]
    fn remote_dedup_relation_unions_and_tombstones_with_the_clock() {
        let mut connection = migrated_connection();
        let mark = remote_envelope(
            "scope-a",
            vec![remote_object(
                "dedup_non_duplicate",
                "archive-a|archive-b",
                2,
                "2026-09-02 08:00:00",
                serde_json::json!({"pairKey": "archive-a|archive-b", "leftArchiveId": "archive-a", "rightArchiveId": "archive-b", "tombstoned": false}),
            )],
        );
        assert_eq!(apply_remote_objects(&mut connection, &mark).expect("apply"), 1);
        let tombstoned: i64 = connection
            .query_row(
                "SELECT tombstoned, logical_clock FROM dedup_non_duplicates WHERE scope_id='scope-a' AND pair_key='archive-a|archive-b'",
                [],
                |row| Ok((row.get::<_, i64>(0)? * 0) + row.get::<_, i64>(1)? - row.get::<_, i64>(1)?),
            )
            .expect("dedup state");
        assert_eq!(tombstoned, 0);
        let clock: i64 = connection
            .query_row(
                "SELECT logical_clock FROM dedup_non_duplicates WHERE scope_id='scope-a' AND pair_key='archive-a|archive-b'",
                [],
                |row| row.get(0),
            )
            .expect("dedup clock");
        assert_eq!(clock, 2);
        // A higher-clock undo wins.
        let undo = remote_envelope(
            "scope-a",
            vec![remote_object(
                "dedup_non_duplicate",
                "archive-a|archive-b",
                3,
                "2026-09-03 08:00:00",
                serde_json::json!({"pairKey": "archive-a|archive-b", "leftArchiveId": "archive-a", "rightArchiveId": "archive-b", "tombstoned": true}),
            )],
        );
        assert_eq!(apply_remote_objects(&mut connection, &undo).expect("apply"), 1);
        let tombstoned: i64 = connection
            .query_row(
                "SELECT tombstoned FROM dedup_non_duplicates WHERE scope_id='scope-a' AND pair_key='archive-a|archive-b'",
                [],
                |row| row.get(0),
            )
            .expect("dedup undo");
        assert_eq!(tombstoned, 1);
    }

    #[test]
    fn unknown_remote_object_types_are_skipped_without_failing() {
        let mut connection = migrated_connection();
        let future = remote_envelope(
            "scope-a",
            vec![remote_object(
                "brand_new_type",
                "scope-a/whatever",
                1,
                "2026-09-02 08:00:00",
                serde_json::json!({"anything": true}),
            )],
        );
        assert_eq!(apply_remote_objects(&mut connection, &future).expect("apply"), 0);
    }

    /// A tiny stateful WebDAV server: PUT stores the body, GET serves it back
    /// with an ETag (404 when absent), MOVE renames. Enough to drive the full
    /// push + pull pipeline across two simulated devices.
    async fn stateful_dav_server(
    ) -> (String, Arc<Mutex<std::collections::BTreeMap<String, Vec<u8>>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let store: Arc<Mutex<std::collections::BTreeMap<String, Vec<u8>>>> =
            Arc::new(Mutex::new(std::collections::BTreeMap::new()));
        let shared = Arc::clone(&store);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let shared = Arc::clone(&shared);
                tokio::spawn(async move {
                    let mut buffer = vec![0_u8; 262_144];
                    let mut total = 0usize;
                    loop {
                        let read = stream.read(&mut buffer[total..]).await.expect("read request");
                        if read == 0 {
                            break;
                        }
                        total += read;
                        let text = String::from_utf8_lossy(&buffer[..total]);
                        let Some(head_end) = text.find("\r\n\r\n") else {
                            if total == buffer.len() {
                                break;
                            }
                            continue;
                        };
                        let length = text[..head_end]
                            .lines()
                            .find_map(|line| {
                                let value = line.strip_prefix("Content-Length:")?;
                                value.trim().parse::<usize>().ok()
                            })
                            .unwrap_or(0);
                        if total >= head_end + 4 + length {
                            break;
                        }
                        if total == buffer.len() {
                            break;
                        }
                    }
                    let text = String::from_utf8_lossy(&buffer[..total]).to_string();
                    let head_end = text.find("\r\n\r\n").unwrap_or(total);
                    let mut request_lines = text[..head_end].split("\r\n");
                    let request = request_lines.next().unwrap_or_default();
                    let mut parts = request.split_whitespace();
                    let method = parts.next().unwrap_or_default().to_string();
                    let path = parts.next().unwrap_or_default().to_string();
                    let destination = text[..head_end]
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("destination")
                                .then(|| value.trim().to_string())
                        })
                        .unwrap_or_default();
                    let body = buffer[head_end + 4..total].to_vec();

                    // All store work happens under a synchronous guard; the
                    // response is fully built here so no lock crosses an await.
                    let response = {
                        let mut store = shared.lock().expect("store");
                        let (status, headers, body): (String, String, Vec<u8>) =
                            match method.as_str() {
                                "PUT" => {
                                    store.insert(path.clone(), body);
                                    ("201 Created".to_string(), String::new(), Vec::new())
                                }
                                "MOVE" => {
                                    let destination_path = destination
                                        .split("://")
                                        .nth(1)
                                        .and_then(|rest| rest.split_once('/'))
                                        .map(|(_, path)| format!("/{path}"))
                                        .unwrap_or_default();
                                    match store.remove(&path) {
                                        Some(bytes) => {
                                            store.insert(destination_path, bytes);
                                            ("201 Created".to_string(), String::new(), Vec::new())
                                        }
                                        None => (
                                            "404 Not Found".to_string(),
                                            String::new(),
                                            Vec::new(),
                                        ),
                                    }
                                }
                                "GET" => match store.get(&path) {
                                    Some(bytes) => (
                                        "200 OK".to_string(),
                                        format!("ETag: \"etag-{}\"\r\n", path.len()),
                                        bytes.clone(),
                                    ),
                                    None => (
                                        "404 Not Found".to_string(),
                                        String::new(),
                                        Vec::new(),
                                    ),
                                },
                                _ => (
                                    "405 Method Not Allowed".to_string(),
                                    String::new(),
                                    Vec::new(),
                                ),
                            };
                        let mut response = format!(
                            "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .into_bytes();
                        response.extend_from_slice(&body);
                        response
                    };
                    stream.write_all(&response).await.expect("write response");
                });
            }
        });
        (format!("http://{address}"), store)
    }

    fn progress_journal_input(
        scope_id: &str,
        archive_id: &str,
        device_id: &str,
        logical_clock: i64,
        page_index: i64,
    ) -> SyncJournalInput {
        SyncJournalInput {
            scope_id: scope_id.to_string(),
            object_id: format!("{scope_id}/{archive_id}"),
            object_type: "reading_progress".to_string(),
            operation: "upsert".to_string(),
            device_id: device_id.to_string(),
            logical_clock,
            base_hash: None,
            payload_hash: "progress-hash".to_string(),
            payload_json: serde_json::json!({
                "archiveId": archive_id,
                "pageIndex": page_index,
                "pageCount": 10,
                "layout": "paged",
                "direction": "ltr",
                "coverAlone": null,
            })
            .to_string(),
        }
    }

    #[tokio::test]
    async fn sync_pushes_local_changes_and_pulls_remote_segments() {
        let (base_url, _store) = stateful_dav_server().await;
        let path = std::env::temp_dir().join(format!(
            "yomika-sync-e2e-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let database = crate::db::Database::open_path(&path).expect("database");
        let key = [11_u8; 32];
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(vec![("ref-a".to_string(), "token".to_string())]),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };

        {
            let mut connection = database.connection.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO webdav_accounts (id, label, base_url, username, credential_ref)
                     VALUES ('account-a', 'NAS', ?1, 'user', 'ref-a')",
                    params![base_url],
                )
                .expect("webdav account");
            // Device A's local activity lands in the journal (payload shape as
            // the real writers produce it).
            append_journal_entry(
                &connection,
                progress_journal_input("scope-a", "archive-a", "device-a", 3, 7),
            )
            .expect("progress journal entry");

            let claimed = claim_journal_entries(&mut connection, "scope-a", 256)
                .expect("device a claim");
            let segment = build_segment_from_records(claimed.clone(), "scope-a", &key)
                .expect("build")
                .expect("device a segment");
            let account =
                read_webdav_account(&connection, "account-a").expect("account record");
            drop(connection);

            let result = sync_scope_impl(
                &database,
                &account,
                &key,
                "scope-a",
                "device-a",
                claimed,
                Some(segment),
                &credentials,
            )
            .await;
            let CommandResult::Success { value: pushed, .. } = result else {
                panic!("device a sync failed");
            };
            assert_eq!(pushed, 1, "device a pushed its one change");
        }

        {
            // Device B (same account) has nothing local to push — it pulls.
            let account = {
                let connection = database.connection.lock().expect("database lock");
                read_webdav_account(&connection, "account-a").expect("account record")
            };
            let result = sync_scope_impl(
                &database,
                &account,
                &key,
                "scope-a",
                "device-b",
                Vec::new(),
                None,
                &credentials,
            )
            .await;
            let CommandResult::Success { value: pulled, .. } = result else {
                panic!("device b sync failed");
            };
            assert_eq!(pulled, 1, "device b merged device a's change");

            let connection = database.connection.lock().expect("database lock");
            let (page, revision): (i64, i64) = connection
                .query_row(
                    "SELECT page_index, revision FROM reading_progress
                     WHERE scope_id = 'scope-a' AND archive_id = 'archive-a'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("pulled progress");
            assert_eq!((page, revision), (7, 3));
            drop(connection);

            // A repeat sync is a no-op: the segment is already applied.
            let account = {
                let connection = database.connection.lock().expect("database lock");
                read_webdav_account(&connection, "account-a").expect("account record")
            };
            let repeat = sync_scope_impl(
                &database,
                &account,
                &key,
                "scope-a",
                "device-b",
                Vec::new(),
                None,
                &credentials,
            )
            .await;
            let CommandResult::Success { value: again, .. } = repeat else {
                panic!("repeat sync failed");
            };
            assert_eq!(again, 0, "already-applied segment is not re-merged");
        }

        drop(database);
        std::fs::remove_file(&path).expect("remove test database");
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }
}

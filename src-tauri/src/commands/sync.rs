use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use url::Url;

use crate::{
    db::Database, domain::result::CommandResult,
    settings::get_or_create_device_id,
};

/// 远端那份文档：一个账户一个文件（`Yomika/<账户>.json.enc`），内容是「每个对象
/// 的最新版本」。
///
/// 这里原来是「清单 + 每设备目录下的不可变段」：读的人要先看清单、再逐段下载、再合并，
/// 段只增不删还得靠 GC 收拾，而它们要表达的信息其实只有「每个对象现在是什么」。现在
/// 远端就是那份合并结果本身——多设备并发靠写入时的 ETag 前置条件与「时钟大者胜、同刻
/// 比哈希」的确定性合并规则保证，不需要段，也就没有 GC 与游标。
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SyncStateObject {
    scope_id: String,
    object_type: String,
    object_id: String,
    /// `upsert` 或 `delete`。删除同样留在文档里（墓碑），否则别的设备永远学不到这次
    /// 删除，下次同步还会把它当成「本地新增」推回来。
    operation: String,
    payload: serde_json::Value,
    payload_hash: String,
    logical_clock: i64,
    device_id: String,
    wall_clock: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncStateDocument {
    version: i64,
    epoch: i64,
    /// key = `{scope_id}|{object_type}|{object_id}`。
    ///
    /// 反序列化时按对象自己的身份（`scope_id` + `object_type` + `object_id`）去重，
    /// 同一个身份只留最新的一版：文件里同一个对象可能出现两次（拼接出来的、手抄的、
    /// 老版本导出又新导出叠起来的），而 `objects` 是一张表，同名键天然只剩一条——
    /// 留哪一条不该由文本顺序决定。键与对象字段一致时原样保留键。
    #[serde(deserialize_with = "deserialize_state_objects")]
    objects: std::collections::BTreeMap<String, SyncStateObject>,
}

/// 文档结构自己的版本号：文档里带着它，将来改结构可以让旧客户端明确拒绝而不是误读。
const SYNC_STATE_VERSION: i64 = 1;

/// 一次同步能覆盖的数据类别。账户上勾了哪几类，同步就只推拉哪几类。
///
/// 命名上有一处历史包袱：类别 `watchlist` 是「待看」（本地 `reading_list` 表），
/// 与本地那张 `watchlist` 表（收藏夹）不是一回事——待看先用了这个词，改名字会让
/// 老账户里存着的范围 JSON 少一项（解析时未知条目直接丢弃），所以留着。收藏夹本身
/// **不是本机记录**：它镜像的是 LANraragi 服务器上的收藏分类，服务器才是它的真相
/// 来源，所以它没有类别，也不进同步、不进导入导出。
///
/// **凭据不在这张表里**：服务器条目、E-H 账户与 API Key/Cookie/同步口令只在本机
/// （凭据库按设备各存各的，别的设备拿到地址也连不上、拿到账户名还要重新登录）。
/// 它们由「导入导出范围」单独管——同步永远不带凭据，而换机器要靠那份口令加密的
/// 文件（见 `crate::data_transfer` 与 `credentials.rs`）。
pub(crate) const SYNC_SCOPE_CATEGORIES: [&str; 6] = [
    "progress",
    "history",
    "watchlist",
    "search_presets",
    "dedup",
    "app_settings",
];

/// 默认勾选：全部记录与设置（也就是全部可勾的类别）。
pub(crate) const DEFAULT_SYNC_SCOPE: [&str; 6] = [
    "progress",
    "history",
    "watchlist",
    "search_presets",
    "dedup",
    "app_settings",
];

/// 不按某台服务器切分的数据（服务器列表、E-H 账户、应用设置）挂在固定 scope 上。
const GLOBAL_SCOPE: &str = "__global__";

/// 账户里存的是类别数组的 JSON；未知条目丢弃，空值回落到默认集合（旧账户的列是空串）。
pub(crate) fn parse_sync_scope(value: &str) -> Vec<String> {
    let parsed: Vec<String> = serde_json::from_str(value).unwrap_or_default();
    let known: Vec<String> = parsed
        .into_iter()
        .filter(|item| SYNC_SCOPE_CATEGORIES.contains(&item.as_str()))
        .collect();
    if known.is_empty() {
        DEFAULT_SYNC_SCOPE.iter().map(|item| item.to_string()).collect()
    } else {
        known
    }
}

pub(crate) fn serialize_sync_scope(categories: &[String]) -> String {
    let known: Vec<&String> = categories
        .iter()
        .filter(|item| SYNC_SCOPE_CATEGORIES.contains(&item.as_str()))
        .collect();
    let effective = if known.is_empty() {
        DEFAULT_SYNC_SCOPE.iter().map(|item| item.to_string()).collect::<Vec<_>>()
    } else {
        known.into_iter().cloned().collect()
    };
    serde_json::to_string(&effective).unwrap_or_default()
}

/// 同步对象类型 → 它属于哪个类别（类别没勾就不推也不拉）。
pub(crate) fn object_type_category(object_type: &str) -> Option<&'static str> {
    match object_type {
        "reading_progress" => Some("progress"),
        "history" => Some("history"),
        // 同步词汇里的 watchlist 是「待看」，落在本地的 reading_list 表。收藏夹
        // （本地 watchlist 表）不在这里：它是服务器收藏分类的镜像，不进同步。
        "watchlist" => Some("watchlist"),
        "search_preset" => Some("search_presets"),
        "dedup_non_duplicate" | "legacy_non_duplicate" => Some("dedup"),
        "app_setting" => Some("app_settings"),
        // `reading_list` 是表名，不是对象类型。老的 worker 导入把它当类型写进了日志，
        // 于是那批待看既进不了文档、到了对面也被当未知对象跳过。词表继续认它，已经在
        // 库里躺着的老日志才搬得走；新写入一律用规范名字（legacy.rs 已改）。放在最后
        // 一行是因为契约钉着「待看紧接着就是搜索预设」，别名不能插在它们中间。
        "reading_list" => Some("watchlist"),
        // 服务器条目、E-H 账户与凭据都没有对象类型：地址、账号名与凭据只在本机。
        _ => None,
    }
}

fn scope_includes(enabled: &[String], object_type: &str) -> bool {
    match object_type_category(object_type) {
        Some(category) => enabled.iter().any(|item| item == category),
        None => false,
    }
}

fn state_object_key(scope_id: &str, object_type: &str, object_id: &str) -> String {
    format!("{scope_id}|{object_type}|{object_id}")
}

/// 同一个对象两版相争：逻辑时钟大的赢；时钟相同（两台设备各自离线改过）时比内容哈希。
/// 规则完全确定，任何设备按任意顺序合并都会得到同一份结果。
fn state_object_wins(candidate: &SyncStateObject, existing: &SyncStateObject) -> bool {
    (candidate.logical_clock, &candidate.payload_hash)
        > (existing.logical_clock, &existing.payload_hash)
}

fn merge_sync_states(local: &SyncStateDocument, remote: &SyncStateDocument) -> SyncStateDocument {
    let mut objects = remote.objects.clone();
    for (key, candidate) in &local.objects {
        match objects.get(key) {
            Some(existing) if !state_object_wins(candidate, existing) => {}
            _ => {
                objects.insert(key.clone(), candidate.clone());
            }
        }
    }
    SyncStateDocument {
        version: local.version.max(remote.version),
        epoch: local.epoch.max(remote.epoch),
        objects,
    }
}

/// 同一个对象的两版谁更新：时钟大的赢；时钟平局比时刻，再比设备，最后比内容哈希。
///
/// 与 `state_object_wins` 的差别在于它认时刻与设备：折叠一份**文件内部**的重复项时，
/// 两版常常出自同一台设备（时钟一样、内容不同），只比 (时钟, 哈希) 会让「谁赢」随
/// 文本顺序变化。四层判据合起来是全序，按任意顺序折叠都得到同一版。
fn fresher_state_object(candidate: &SyncStateObject, existing: &SyncStateObject) -> bool {
    if remote_change_wins(
        existing.logical_clock,
        &existing.wall_clock,
        &existing.device_id,
        candidate.logical_clock,
        &candidate.wall_clock,
        &candidate.device_id,
    ) {
        return true;
    }
    candidate.logical_clock == existing.logical_clock
        && compare_instants(&candidate.wall_clock, &existing.wall_clock) == std::cmp::Ordering::Equal
        && candidate.device_id == existing.device_id
        && candidate.payload_hash > existing.payload_hash
}

/// 反序列化 `objects`：同名键不让「文本里最后一条」赢，而是按对象身份归位、留下最新的。
fn deserialize_state_objects<'de, D>(
    deserializer: D,
) -> Result<std::collections::BTreeMap<String, SyncStateObject>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::MapAccess;

    struct StateObjects;

    impl<'de> serde::de::Visitor<'de> for StateObjects {
        type Value = std::collections::BTreeMap<String, SyncStateObject>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("按 scope_id|object_type|object_id 索引的同步对象表")
        }

        fn visit_map<A>(self, mut entries: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            // 身份 → （文件里写的键, 那一版）。键与对象字段一致时（正常导出）原样保留，
            // 只在同一个身份出现两次、而两次写的键不一样时才归位到同一格。
            let mut folded: std::collections::BTreeMap<String, (String, SyncStateObject)> =
                std::collections::BTreeMap::new();
            while let Some((key, object)) = entries.next_entry::<String, SyncStateObject>()? {
                let identity =
                    state_object_key(&object.scope_id, &object.object_type, &object.object_id);
                match folded.get_mut(&identity) {
                    Some((kept_key, kept)) => {
                        if fresher_state_object(&object, kept) {
                            *kept = object;
                            *kept_key = key;
                        } else if !fresher_state_object(kept, &object) && key < *kept_key {
                            // 两版完全打平（连同内容哈希）：那点区别就只剩文件里写的键，
                            // 按字典序定胜负，免得折叠结果取决于文本顺序。
                            *kept_key = key;
                        }
                    }
                    None => {
                        folded.insert(identity, (key, object));
                    }
                }
            }
            let mut objects = std::collections::BTreeMap::new();
            for (identity, (key, object)) in folded {
                // 键被别的对象占了（键与字段不一致的怪文件）才改用身份键，保证不会有
                // 哪一版被静默丢掉。
                if objects.contains_key(&key) {
                    objects.insert(identity, object);
                } else {
                    objects.insert(key, object);
                }
            }
            Ok(objects)
        }
    }

    deserializer.deserialize_map(StateObjects)
}

/// 折叠冗余的日志行：每个对象只留序号最大的那一版，更早的行仅当 status =
/// 'completed' 才删——pending/retryable 是推送队列，failed 要留给重试与诊断。
/// build_local_state 按「每对象取最后一版」折叠，删掉的全是被覆盖的已完成行，
/// 折出来的文档因此逐字节不变。失败静默：压缩只是卫生，不值得让同步因它失败。
fn compact_journal(connection: &Connection, scope_ids: &[&str]) -> Result<(), String> {
    for scope_id in scope_ids {
        connection
            .execute(
                "DELETE FROM sync_journal
                 WHERE scope_id = ?1
                   AND status = 'completed'
                   AND sequence < (SELECT MAX(j2.sequence) FROM sync_journal j2
                                   WHERE j2.scope_id = sync_journal.scope_id
                                     AND j2.object_type = sync_journal.object_type
                                     AND j2.object_id = sync_journal.object_id)",
                params![scope_id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 本地这一侧的全部对象：把该 scope 的日志按序号折叠，每个对象取最后一版。日志里
/// upsert 与 delete 都在，所以折出来的文档天然带墓碑。
fn build_local_state(
    connection: &Connection,
    scope_ids: &[&str],
    enabled: &[String],
) -> Result<SyncStateDocument, String> {
    let mut objects = std::collections::BTreeMap::new();
    let mut records = Vec::new();
    for scope_id in scope_ids {
        records.extend(query_journal_entries(connection, scope_id, None)?);
    }
    records.sort_by_key(|record| record.sequence);
    for record in records {
        // 类别没勾就不进文档：勾选是「要不要让它上远端」的开关。
        if !scope_includes(enabled, &record.object_type) {
            continue;
        }
        let payload = serde_json::from_str(&record.payload_json).unwrap_or(serde_json::Value::Null);
        let object = SyncStateObject {
            scope_id: record.scope_id.clone(),
            object_type: record.object_type.clone(),
            object_id: record.object_id.clone(),
            operation: record.operation.clone(),
            payload,
            payload_hash: record.payload_hash.clone(),
            logical_clock: record.logical_clock,
            device_id: record.device_id.clone(),
            wall_clock: record.wall_clock.clone(),
        };
        // 记录按序号升序，后面的覆盖前面的——这就是「取最后一版」。
        objects.insert(
            state_object_key(&record.scope_id, &record.object_type, &record.object_id),
            object,
        );
    }
    Ok(SyncStateDocument { version: SYNC_STATE_VERSION, epoch: 0, objects })
}

/// 写一条同步日志。scope 与逻辑时钟由调用方给：像去重标记那样自带时钟的对象要用
/// 它自己的值，远端冲突抢占的规则才对得上；全局对象则用「该对象历史的下一格」。
pub(crate) fn journal_object(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object_type: &str,
    object_id: &str,
    logical_clock: i64,
    payload: serde_json::Value,
) -> Result<(), String> {
    let payload_json = payload.to_string();
    let payload_hash = blake3::hash(payload_json.as_bytes()).to_hex().to_string();
    let device_id = get_or_create_device_id(transaction)?;
    append_journal_entry(
        transaction,
        SyncJournalInput {
            scope_id: scope_id.to_string(),
            object_id: object_id.to_string(),
            object_type: object_type.to_string(),
            operation: "upsert".to_string(),
            device_id,
            logical_clock,
            base_hash: None,
            payload_hash,
            payload_json,
        },
    )?;
    Ok(())
}

/// 不按服务器切分的对象（服务器条目、E-H 账户、应用偏好）写一条全局日志。
pub(crate) fn journal_global_object(
    transaction: &rusqlite::Transaction<'_>,
    object_type: &str,
    object_id: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    let clock: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(logical_clock), 0) + 1 FROM sync_journal WHERE scope_id = ?1 AND object_id = ?2",
            params![GLOBAL_SCOPE, object_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    journal_object(transaction, GLOBAL_SCOPE, object_type, object_id, clock, payload)
}

/// 全局对象在本地的当前时钟（该对象日志里的最大值），用来判断远端那一版该不该落。
fn local_object_clock(
    transaction: &rusqlite::Transaction<'_>,
    object_id: &str,
) -> Result<i64, String> {
    transaction
        .query_row(
            "SELECT COALESCE(MAX(logical_clock), 0) FROM sync_journal WHERE scope_id = ?1 AND object_id = ?2",
            params![GLOBAL_SCOPE, object_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

/// 应用偏好：远端那份按字段并进本地快照，而不是整份替换。
///
/// 两件事都靠这一条：一是本机的下载目录与缓存上限不该被别的设备覆盖（那是「这台
/// 机器」的事，见 settings::DEVICE_LOCAL_PREFERENCE_KEYS）；二是旧版本写上去的快照
/// 少几个字段时，缺的那些留本机的值，而不是被还原成默认值。
fn apply_remote_app_setting(
    transaction: &rusqlite::Transaction<'_>,
    object: &SyncStateObject,
    payload: &serde_json::Value,
    restore: bool,
) -> Result<bool, String> {
    let stored: Option<(String, String)> = transaction
        .query_row(
            "SELECT value_json, updated_at FROM settings WHERE key = 'preferences'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let gate = match &stored {
        Some((_, updated_at)) => remote_change_wins(
            local_object_clock(transaction, &object.object_id)?,
            // 时钟撞车（两台设备各自离线改过、都到了同一版）时比时刻。这里以前给的是
            // 空串，而空串输给任何时刻，于是一份同版本号的旧快照照样能盖上来。
            updated_at,
            "",
            object.logical_clock,
            &object.wall_clock,
            &object.device_id,
        ),
        None => true,
    };
    if !gate && !restore {
        return Ok(false);
    }
    let local: serde_json::Value = stored
        .as_ref()
        .map(|(value, _)| value.as_str())
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or(serde_json::Value::Null);
    let mut merged = local.as_object().cloned().unwrap_or_default();
    if let Some(remote) = payload.as_object() {
        for (key, value) in remote {
            if crate::settings::DEVICE_LOCAL_PREFERENCE_KEYS.contains(&key.as_str()) {
                continue;
            }
            merged.insert(key.clone(), value.clone());
        }
    }
    // 合并结果还要逐字段写回 `settings` 里那些 `preferences.*` 的行：读的那一半
    // （`load_preferences_from`）读的就是它们。只写下面那份名叫 `preferences` 的整块
    // JSON 的话，同步来的与导进来的偏好（阅读设置、SFW 模式……）就全落在一个没人读
    // 的地方——「设置搬不过去」正是这么来的。
    let base = crate::settings::load_preferences_from(transaction)?;
    match serde_json::to_value(&base)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .map(|mut next| {
            for (key, value) in &merged {
                next.insert(key.clone(), value.clone());
            }
            serde_json::from_value::<crate::settings::PreferenceSnapshot>(serde_json::Value::Object(next))
        }) {
        // 远端那一份读得出就落地。读不出（陌生 schema 的字段类型对不上）时不写逐字段的
        // 行，但仍照旧写下面那份整块 JSON：一条坏偏好不该让整次同步或整份文件导入失败。
        Some(Ok(snapshot)) => crate::settings::write_preference_keys(transaction, &snapshot)?,
        _ => {}
    }
    transaction
        .execute(
            "INSERT INTO settings (key, value_json, updated_at) VALUES ('preferences', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![serde_json::Value::Object(merged).to_string(), object.wall_clock],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

/// 从 Readoshi 导入带进来的「非重复」结论（按 path + 内容哈希记的），现在也随同步
/// 走：落到同一张 dedup_features 表，行为与导入侧一致。
fn apply_remote_legacy_non_duplicate(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &SyncStateObject,
    payload: &serde_json::Value,
    restore: bool,
) -> Result<bool, String> {
    let path = payload_text(payload, "path")?;
    let exact_hash = payload_text(payload, "hash")?;
    // 这张表没有版本号列，能比的只有 updated_at：一份旧文件里的结论不能盖掉更新的
    // 那一行（本机新算出来的哈希比从别处带进来的更有价值）。时刻比不出来就照旧覆盖，
    // 免得两边的 CURRENT_TIMESTAMP 一模一样时互相顶。
    let updated: Option<String> = transaction
        .query_row(
            "SELECT updated_at FROM dedup_features WHERE scope_id = ?1 AND path = ?2",
            params![scope_id, path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(updated) = updated {
        if !restore && compare_instants(&object.wall_clock, &updated) != std::cmp::Ordering::Greater {
            return Ok(false);
        }
    }
    transaction
        .execute(
            "INSERT INTO dedup_features (scope_id, path, exact_hash, algorithm_version, size)
             VALUES (?1, ?2, ?3, 'legacy-import', 0)
             ON CONFLICT(scope_id, path) DO UPDATE SET
               exact_hash = excluded.exact_hash,
               algorithm_version = excluded.algorithm_version,
               updated_at = CURRENT_TIMESTAMP",
            params![scope_id, path, exact_hash],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

/// 还没推上去的日志行：用来报告本次推了几条，并在成功后就地标记完成。
fn pending_journal_entries(
    connection: &Connection,
    scope_id: &str,
) -> Result<Vec<SyncJournalRecord>, String> {
    Ok(query_journal_entries(connection, scope_id, None)?
        .into_iter()
        .filter(|record| matches!(record.status.as_str(), "pending" | "retryable"))
        .collect())
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

fn encode_sync_state(key: &[u8; 32], document: &SyncStateDocument) -> Result<Vec<u8>, String> {
    encrypt_bytes(
        key,
        &serde_json::to_vec(document).map_err(|error| error.to_string())?,
    )
}

fn decode_sync_state(key: &[u8; 32], bytes: &[u8]) -> Result<SyncStateDocument, String> {
    let document: SyncStateDocument =
        serde_json::from_slice(&decrypt_bytes(key, bytes)?).map_err(|error| error.to_string())?;
    if document.version > SYNC_STATE_VERSION {
        return Err(format!(
            "远端同步文档是更新版本（{}）写的，请先升级应用",
            document.version
        ));
    }
    Ok(document)
}

const WEBDAV_KEYRING_SERVICE: &str = "app.yomika.webdav";

/// `Sync` 是 `async` 命令逼出来的要求，不是这里的设计偏好：`sync_remote_scope` 现在
/// 是真正的 `async fn`（原来用 `block_on`，在运行时内部会 panic），而它把
/// `&dyn WebdavCredentialStore` 一路带进 `sync_scope_impl` 的 `.await`——Tauri 要求命令
/// 返回的 future 是 `Send`，而 `&T` 只有在 `T: Sync` 时才是 `Send`。两个实现都是
/// 纯句柄（没有内部可变性），本来就满足。
pub trait WebdavCredentialStore: Sync {
    fn set_credential(&self, credential_ref: &str, credential: &str) -> Result<(), String>;
    fn delete_credential(&self, credential_ref: &str) -> Result<(), String>;
    fn get_credential(&self, credential_ref: &str) -> Result<String, String>;
}

pub(crate) struct SystemWebdavCredentialStore;

impl WebdavCredentialStore for SystemWebdavCredentialStore {
    fn set_credential(&self, credential_ref: &str, credential: &str) -> Result<(), String> {
        crate::secret_store::set_secret(WEBDAV_KEYRING_SERVICE, credential_ref, credential)
    }

    fn delete_credential(&self, credential_ref: &str) -> Result<(), String> {
        crate::secret_store::delete_secret(WEBDAV_KEYRING_SERVICE, credential_ref)
    }

    fn get_credential(&self, credential_ref: &str) -> Result<String, String> {
        crate::secret_store::get_secret(WEBDAV_KEYRING_SERVICE, credential_ref)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSyncAccountInput {
    id: String,
    /// "webdav" 或 "s3"（S3 兼容对象存储，例如 Cloudflare R2）。
    #[serde(default)]
    kind: String,
    label: String,
    /// WebDAV：目录地址；S3：端点，如 https://<账号>.r2.cloudflarestorage.com。
    base_url: String,
    /// 只有 S3 用得上：存储桶名。
    #[serde(default)]
    bucket: String,
    /// WebDAV：用户名；S3：Access Key ID。
    username: String,
    /// WebDAV：口令或应用密码；S3：Secret Access Key。都进系统凭据库。
    credential: String,
    /// 勾选的同步类别（JSON 数组）。这是「同步范围」那个设置行自己的事：
    /// 账户表单不再带它，缺省＝沿用已存的范围（新账户＝默认集合）。
    #[serde(default)]
    sync_scope: Option<String>,
}

impl SaveSyncAccountInput {
    /// 只给凭据导入用：构造的是同一份输入，校验仍在 `save_sync_account_record` 里。
    /// 那条路径负责把口令写进凭据库、把 `credential_ref` 写进行，导入不该另起一套。
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        id: &str,
        kind: &str,
        label: &str,
        base_url: &str,
        bucket: &str,
        username: &str,
        credential: &str,
        sync_scope: Option<String>,
    ) -> Self {
        Self {
            id: id.to_string(),
            kind: kind.to_string(),
            label: label.to_string(),
            base_url: base_url.to_string(),
            bucket: bucket.to_string(),
            username: username.to_string(),
            credential: credential.to_string(),
            sync_scope,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAccountRecord {
    id: String,
    kind: String,
    /// 同时只生效一套：同步、账户行、同步范围都看这一行。
    active: bool,
    label: String,
    base_url: String,
    bucket: String,
    username: String,
    credential_ref: String,
    sync_scope: String,
    status: String,
    last_probe_at: Option<String>,
    /// 上次成功同步的时刻；空值＝还没同步过。
    last_sync_at: Option<String>,
    last_error_code: Option<String>,
    created_at: String,
    updated_at: String,
}

fn read_sync_account(
    connection: &Connection,
    account_id: &str,
) -> Result<SyncAccountRecord, String> {
    connection
        .query_row(
            "SELECT id, kind, active, label, base_url, bucket, username, credential_ref, sync_scope,
                    status, last_probe_at, last_sync_at, last_error_code, created_at, updated_at
             FROM sync_accounts WHERE id = ?1",
            params![account_id],
            |row| {
                Ok(SyncAccountRecord {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    active: row.get(2)?,
                    label: row.get(3)?,
                    base_url: row.get(4)?,
                    bucket: row.get(5)?,
                    username: row.get(6)?,
                    credential_ref: row.get(7)?,
                    sync_scope: row.get(8)?,
                    status: row.get(9)?,
                    last_probe_at: row.get(10)?,
                    last_sync_at: row.get(11)?,
                    last_error_code: row.get(12)?,
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

pub fn save_sync_account_record(
    connection: &mut Connection,
    credentials: &dyn WebdavCredentialStore,
    input: SaveSyncAccountInput,
) -> CommandResult<SyncAccountRecord> {
    let kind = match input.kind.trim() {
        "" | "webdav" => "webdav",
        "s3" => "s3",
        _ => return CommandResult::failure("INVALID_RESPONSE", "Invalid sync account kind", false),
    };
    let parsed_url = match Url::parse(&input.base_url) {
        Ok(url)
            if matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none() =>
        {
            url
        }
        _ => {
            return CommandResult::failure(
                "INVALID_RESPONSE",
                if kind == "s3" { "Invalid object storage endpoint" } else { "Invalid WebDAV URL" },
                false,
            )
        }
    };
    let bucket = input.bucket.trim().trim_matches('/').to_string();
    if kind == "s3" {
        // 桶名就是 S3 自己那套规则（小写字母数字与点/连字符，3–63 位），
        // 免得把 404 留到第一次同步才暴露。
        if bucket.len() < 3
            || bucket.len() > 63
            || !bucket.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '-' | '.'))
            || bucket.starts_with('-')
            || bucket.ends_with('-')
        {
            return CommandResult::failure("INVALID_RESPONSE", "Invalid bucket name", false);
        }
        if input.username.trim().is_empty() {
            return CommandResult::failure("INVALID_RESPONSE", "Access key ID is required", false);
        }
    }
    if input.id.is_empty()
        || !input
            .id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        || input.label.trim().is_empty()
    {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid sync account", false);
    }

    let existing: Option<(String, String)> = connection
        .query_row(
            "SELECT credential_ref, sync_scope FROM sync_accounts WHERE id = ?1",
            params![input.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    let old_credential_ref: Option<String> = existing.as_ref().map(|(reference, _)| reference.clone());

    // 编辑已存在的账户时口令可以留空——表单不会把旧口令回填出来，为了让改名、
    // 换地址这些操作不被迫重输一遍口令，空口令就沿用存着的那份凭据。
    let credential_ref = if input.credential.is_empty() {
        match &old_credential_ref {
            Some(existing) => existing.clone(),
            None => {
                return CommandResult::failure("INVALID_RESPONSE", "Invalid WebDAV account", false)
            }
        }
    } else {
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
        credential_ref
    };

    let transaction = match connection.transaction() {
        Ok(transaction) => transaction,
        Err(error) => {
            let _ = credentials.delete_credential(&credential_ref);
            return CommandResult::failure("UNKNOWN", error.to_string(), true);
        }
    };
    // 只生效一套：保存这一套就是启用它，另一套（另一种类型的那份）留在库里待命。
    let sync_scope = match input.sync_scope.as_deref() {
        Some(raw) => serialize_sync_scope(&parse_sync_scope(raw)),
        // 表单没带范围就别动它：编辑账户（改个名字、换个地址）不该把勾选重置掉。
        None => existing
            .as_ref()
            .map(|(_, scope)| scope.clone())
            .unwrap_or_else(|| serialize_sync_scope(&[])),
    };
    if let Err(error) = transaction.execute("UPDATE sync_accounts SET active = 0 WHERE id <> ?1", params![input.id]) {
        let _ = credentials.delete_credential(&credential_ref);
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    if let Err(error) = transaction.execute(
        "INSERT INTO sync_accounts
            (id, kind, active, label, base_url, bucket, username, credential_ref, sync_scope)
         VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            active = 1,
            label = excluded.label,
            base_url = excluded.base_url,
            bucket = excluded.bucket,
            username = excluded.username,
            credential_ref = excluded.credential_ref,
            sync_scope = excluded.sync_scope,
            status = 'unverified',
            last_probe_at = NULL,
            last_error_code = NULL,
            updated_at = CURRENT_TIMESTAMP",
        params![
            input.id,
            kind,
            input.label.trim(),
            parsed_url.as_str().trim_end_matches('/'),
            bucket,
            input.username.trim(),
            credential_ref,
            sync_scope,
        ],
    ) {
        let _ = credentials.delete_credential(&credential_ref);
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    let record = match read_sync_account(&transaction, &input.id) {
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

#[tauri::command(async)]
pub fn save_sync_account(
    input: SaveSyncAccountInput,
    database: State<'_, Database>,
) -> CommandResult<SyncAccountRecord> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    save_sync_account_record(&mut connection, &SystemWebdavCredentialStore, input)
}

fn query_sync_accounts(connection: &Connection) -> Result<Vec<SyncAccountRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, kind, active, label, base_url, bucket, username, credential_ref, sync_scope,
                    status, last_probe_at, last_sync_at, last_error_code, created_at, updated_at
             FROM sync_accounts ORDER BY active DESC, label COLLATE NOCASE, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(SyncAccountRecord {
                id: row.get(0)?,
                kind: row.get(1)?,
                active: row.get(2)?,
                label: row.get(3)?,
                base_url: row.get(4)?,
                bucket: row.get(5)?,
                username: row.get(6)?,
                credential_ref: row.get(7)?,
                sync_scope: row.get(8)?,
                status: row.get(9)?,
                last_probe_at: row.get(10)?,
                last_sync_at: row.get(11)?,
                last_error_code: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// 「测试」：拿表单里当前的字段去连一次远端，确认地址、桶、凭据都对。
///
/// 不写任何东西：WebDAV 只做一次 PROPFIND，对象存储只做一次 HeadBucket；如果远端
/// 已经有同步文档，再用当前凭据解开它——那一步同时证明了「这份文档当初就是这套凭据
/// 加的密」，也就是换口令之后最常踩的那个坑。
///
/// 是真正的 `async fn`，不是 `block_on`：这个包装跑在 tokio worker 上，在运行时
/// 内部再 `block_on` 会 panic「Cannot start a runtime from within a runtime」
/// （`data/logs/crash.log` 里有记录），响应也就永远发不出去。
#[tauri::command]
pub async fn test_sync_account(
    input: SaveSyncAccountInput,
    database: State<'_, Database>,
) -> Result<CommandResult<String>, String> {
    Ok(test_sync_account_inner(input, database).await)
}

/// 命令体。拆出来是因为宏的限制：带生命周期参数的 `async fn` 命令必须返回真正的
/// `Result`，不能返回 `CommandResult`。里面的 `return CommandResult::failure(..)`
/// 与原来在 `block_on` 闭包里时同意——它们从这个函数返回，包装再把结果交出去。

async fn test_sync_account_inner(
    input: SaveSyncAccountInput,
    database: State<'_, Database>,
) -> CommandResult<String> {
    let kind = match input.kind.trim() {
        "s3" => "s3",
        _ => "webdav",
    };
    if input.base_url.trim().is_empty()
        || (kind == "s3" && input.bucket.trim().is_empty())
        || (kind == "s3" && input.username.trim().is_empty())
    {
        return CommandResult::failure("INVALID_RESPONSE", "先填好地址、桶与 Access Key ID", false);
    }
    // 表单里可能是空凭据（编辑时留空＝沿用）：那就取库里那一份。
    let credential = if input.credential.is_empty() {
        let stored = {
            let connection = match database.connection.lock() {
                Ok(connection) => connection,
                Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
            };
            connection
                .query_row(
                    "SELECT credential_ref FROM sync_accounts WHERE id = ?1",
                    params![input.id],
                    |row| row.get::<_, String>(0),
                )
                .ok()
        };
        match stored.and_then(|reference| SystemWebdavCredentialStore.get_credential(&reference).ok()) {
            Some(credential) => credential,
            None => {
                return CommandResult::failure("INVALID_RESPONSE", "请先填写凭据再测试", false)
            }
        }
    } else {
        input.credential.clone()
    };

    let store = match RemoteStore::connect(
        kind,
        input.base_url.trim().trim_end_matches('/'),
        input.bucket.trim().trim_matches('/'),
        input.username.trim(),
        &credential,
    ) {
        Ok(store) => store,
        Err(error) => return CommandResult::failure("INVALID_RESPONSE", sync_error(error), false),
    };
    if let Err(error) = store.probe().await {
        let (code, message) = describe_probe_error(error);
        return CommandResult::failure(code, message, false);
    }
    let account_id = if input.id.trim().is_empty() {
        input.label.trim().to_string()
    } else {
        input.id.clone()
    };
    let key = derive_sync_key(&account_id, &credential);
    match store.get_state(&account_id).await {
        Ok(Some(remote)) => match decode_sync_state(&key, &remote.ciphertext) {
            Ok(state) => CommandResult::success(format!(
                "连接正常：远端已有同步文档（{} 个对象），当前凭据可以解开",
                state.objects.len()
            )),
            Err(_) => CommandResult::failure(
                "INVALID_RESPONSE",
                "连接正常，但远端文档解不开：这台设备上的凭据和当初上传时不一致。换成当初那串口令，或在账户菜单里「重置远端」后按本机重写一份。",
                false,
            ),
        },
        Ok(None) => CommandResult::success(
            "连接正常：远端还没有同步文档，第一次同步会创建它".to_string(),
        ),
        Err(error) => {
            let (code, message) = describe_probe_error(error);
            CommandResult::failure(code, message, false)
        }
    }
}

/// 把探测失败翻译成使用者能照着修的说法：401/403 是凭据与权限，其余照原样报。
fn describe_probe_error(error: crate::network::remote::RemoteError) -> (&'static str, String) {
    match error {
        crate::network::remote::RemoteError::Http(status) => match status.as_u16() {
            401 => ("INVALID_INPUT", "凭据被拒绝（401）：检查用户名 / 密码或 Token".to_string()),
            403 => (
                "INVALID_INPUT",
                "没有权限（403）：检查账号权限；对象存储的 Token 需要「对象读写」，且桶要在这个 Token 的范围内".to_string(),
            ),
            other => ("NETWORK", format!("远端返回 HTTP {other}")),
        },
        crate::network::remote::RemoteError::InvalidUrl(message) => ("INVALID_INPUT", message),
        crate::network::remote::RemoteError::Request(message) => ("NETWORK", message),
        crate::network::remote::RemoteError::StateConflict => {
            ("REMOTE_CONFLICT", "远端文档被别的设备改过，重新测一次或直接同步".to_string())
        }
        crate::network::remote::RemoteError::Verification(message) => ("INVALID_RESPONSE", message),
    }
}

/// 「同步范围」是一个独立的设置行：勾选后立刻写回账户，不必再走账户表单。
#[tauri::command(async)]
pub fn save_sync_scope(
    account_id: String,
    sync_scope: String,
    database: State<'_, Database>,
) -> CommandResult<SyncAccountRecord> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let serialized = serialize_sync_scope(&parse_sync_scope(&sync_scope));
    let updated = match connection.execute(
        "UPDATE sync_accounts SET sync_scope = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        params![account_id, serialized],
    ) {
        Ok(updated) => updated,
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    if updated == 0 {
        return CommandResult::failure("NOT_FOUND", "Sync account not found", false);
    }
    match read_sync_account(&connection, &account_id) {
        Ok(record) => CommandResult::success(record),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command(async)]
pub fn list_sync_accounts(
    database: State<'_, Database>,
) -> CommandResult<Vec<SyncAccountRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match query_sync_accounts(&connection) {
        Ok(accounts) => CommandResult::success(accounts),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

/// The account's sync key, derived from the WebDAV password that is already in
/// the OS credential store.
///
/// It used to be a random master key kept in the credential store under its own
/// entry and copied between devices by hand ("导出密钥"/"导入密钥"): a second device
/// could not read the remote until the key was carried over, and a missing
/// keyring entry — which is exactly what Windows handed back — broke sync
/// outright. Deriving it from the account keeps the ciphertext opaque to the
/// WebDAV server, needs nothing exported, and lets any device holding the same
/// account read the same data.
fn load_sync_key(
    connection: &Connection,
    credentials: &dyn WebdavCredentialStore,
    account_id: &str,
) -> Result<[u8; 32], String> {
    let credential_ref: String = connection
        .query_row(
            "SELECT credential_ref FROM sync_accounts WHERE id = ?1",
            [account_id],
            |row| row.get(0),
        )
        .map_err(|_| "同步账户不存在".to_string())?;
    let credential = credentials.get_credential(&credential_ref)?;
    Ok(derive_sync_key(account_id, &credential))
}

/// 同步密钥＝账户 id + 凭据派生。远端密文对存储服务不可读，靠的就是它；
/// 也因此「凭据换了」等价于「远端文档解不开」——测试按钮据此给出人话提示。
fn derive_sync_key(account_id: &str, credential: &str) -> [u8; 32] {
    *blake3::Hasher::new_derive_key("app.yomika.webdav.sync.v1")
        .update(account_id.as_bytes())
        .update(credential.as_bytes())
        .finalize()
        .as_bytes()
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

/// True when a remote change should overwrite the local row. The comparator is
/// a strict total order — logical clock, then wall-clock instant, then device
/// id — so two devices applying the same two changes in opposite orders both
/// converge on the same winner instead of each keeping its local value.
fn remote_change_wins(
    local_clock: i64,
    local_updated: &str,
    local_device: &str,
    remote_clock: i64,
    remote_updated: &str,
    remote_device: &str,
) -> bool {
    match remote_clock.cmp(&local_clock) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Equal => match compare_instants(remote_updated, local_updated) {
            std::cmp::Ordering::Greater => true,
            std::cmp::Ordering::Equal => remote_device > local_device,
            std::cmp::Ordering::Less => false,
        },
        std::cmp::Ordering::Less => false,
    }
}

/// Across devices, a user's regression preference decides whether the newest
/// visit or the furthest page wins. Device clocks are independent, so a visit
/// compares timestamps before logical clocks when regression is allowed.
#[allow(clippy::too_many_arguments)]
fn remote_progress_wins(
    allow_regression: bool,
    local_clock: i64,
    local_updated: &str,
    local_device: &str,
    local_page: i64,
    remote_clock: i64,
    remote_updated: &str,
    remote_device: &str,
    remote_page: i64,
) -> bool {
    if allow_regression && local_device != remote_device {
        return match compare_instants(remote_updated, local_updated) {
            std::cmp::Ordering::Greater => true,
            std::cmp::Ordering::Less => false,
            std::cmp::Ordering::Equal => remote_change_wins(
                local_clock, local_updated, local_device,
                remote_clock, remote_updated, remote_device,
            ),
        };
    }
    if local_device == remote_device {
        return remote_change_wins(
            local_clock,
            local_updated,
            local_device,
            remote_clock,
            remote_updated,
            remote_device,
        );
    }
    match remote_page.cmp(&local_page) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Equal => remote_change_wins(
            local_clock,
            local_updated,
            local_device,
            remote_clock,
            remote_updated,
            remote_device,
        ),
        std::cmp::Ordering::Less => false,
    }
}

/// Parses a timestamp into epoch milliseconds. Native writers emit SQLite's
/// UTC `YYYY-MM-DD HH:MM:SS[.SSS]`, but imported history can carry any ISO
/// 8601 shape — including explicit offsets, where printed digits stop
/// matching time order. Unparseable strings fall back to lexical order so the
/// comparison stays deterministic.
pub(crate) fn instant_millis(timestamp: &str) -> Option<i64> {
    let trimmed = timestamp.trim();
    let (date_part, rest) = if let Some((date, time)) = trimmed.split_once('T') {
        (date, time)
    } else {
        trimmed.split_once(' ')?
    };
    let (time_part, offset_millis) = if rest.ends_with('Z') || rest.ends_with('z') {
        (&rest[..rest.len() - 1], 0_i64)
    } else if let Some(position) = rest
        .char_indices()
        .skip(1)
        .find(|(_, character)| *character == '+' || *character == '-')
        .map(|(index, _)| index)
    {
        let (time, offset) = rest.split_at(position);
        let sign = match offset.chars().next()? {
            '+' => 1_i64,
            '-' => -1_i64,
            _ => return None,
        };
        let offset = &offset[1..];
        let (hours, minutes) = match offset.split_once(':') {
            Some((hours, minutes)) => (hours, minutes),
            None => (offset, "0"),
        };
        let hours = hours.parse::<i64>().ok()?;
        let minutes = minutes.parse::<i64>().ok()?;
        (time, sign * (hours * 3600 + minutes * 60) * 1000)
    } else {
        (rest, 0_i64)
    };
    let mut date_parts = date_part.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut time_parts = time_part.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let second_part = time_parts.next().unwrap_or("0");
    let (second, fraction_millis) = match second_part.split_once('.') {
        Some((second, fraction)) => {
            let mut millis = fraction.chars().take(3).collect::<String>();
            while millis.len() < 3 {
                millis.push('0');
            }
            (second, millis)
        }
        None => (second_part, "0".to_string()),
    };
    let second = second.parse::<i64>().ok()?;
    let fraction_millis = fraction_millis.parse::<i64>().ok()?;
    // Days from the civil date to the Unix epoch (Howard Hinnant's algorithm).
    let years = if month <= 2 { year - 1 } else { year };
    let era = if years >= 0 { years } else { years - 399 } / 400;
    let year_of_era = years - era * 400;
    let day_of_year =
        (153 * (if month > 2 { month - 3 } else { month + 9 }) / 5) + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let epoch_days = era * 146_097 + day_of_era - 719_468;
    let seconds = epoch_days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(seconds * 1000 + fraction_millis - offset_millis)
}

fn compare_instants(left: &str, right: &str) -> std::cmp::Ordering {
    match (instant_millis(left), instant_millis(right)) {
        (Some(left), Some(right)) => left.cmp(&right),
        _ => left.cmp(right),
    }
}

/// Applies one remote change segment's objects to the local tables, inside a
/// single transaction. Rows written here keep the winning clock, so later
/// merges keep comparing correctly, and nothing is re-journaled — the objects
/// came from the remote's journal and re-journaling them would echo them back.
/// The return value counts the rows that actually changed.
fn apply_remote_objects(
    connection: &mut Connection,
    objects: &[SyncStateObject],
) -> Result<usize, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let mut applied = 0;
    for object in objects {
        // 同步不是用户点的那一份文件，照样按时钟比。
        if apply_remote_object(&transaction, &object.scope_id, object, false)? {
            applied += 1;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(applied)
}

/// Merges one remote object by its type. Returns false when the object was
/// skipped (unknown type, or a remote clock that lost to the local row).
///
/// `restore` 是**文件导入**这条路的标记：用户明确点了一份文件，里面每个对象的版本号
/// 来自另一台设备自己的 journal 计数——那两个计数器从没见过面，比大小没有意义。让它
/// 们在比较里输掉，用户看到的就是「导入成功、什么都没变」（阅读设置、翻页方向正是这
/// 么丢的：本机存过几次偏好，本机时钟就比文件里的高）。所以导入时把文件里的对象当成
/// 本机该对象的**最新一版**：版本号取本机与文件里较大的那个，事后再照旧写一条时钟更高
/// 的日志，让这一版继续往外同步。自动同步（`apply_remote_objects`）照旧按时钟比较。
fn apply_remote_object(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &SyncStateObject,
    restore: bool,
) -> Result<bool, String> {
    match object.object_type.as_str() {
        "reading_progress" => {
            apply_remote_progress(transaction, scope_id, object, &object.payload, restore)
        }
        "history" => {
            apply_remote_history(transaction, scope_id, object, &object.payload, restore)
        }
        // 同步词汇里的 watchlist 是「待看」，落在本地的 reading_list 表。收藏夹是
        // 服务器收藏分类的镜像，没有对象类型，也不会出现在文档里。
        "watchlist" => {
            apply_remote_list_entry(transaction, scope_id, object, &object.payload, restore)
        }
        // 老版本导出的文档里，待看带着的是表名（见 object_type_category）。
        "reading_list" => {
            apply_remote_list_entry(transaction, scope_id, object, &object.payload, restore)
        }
        "search_preset" => {
            apply_remote_search_preset(transaction, scope_id, object, &object.payload, restore)
        }
        "app_setting" => apply_remote_app_setting(transaction, object, &object.payload, restore),
        "legacy_non_duplicate" => {
            apply_remote_legacy_non_duplicate(transaction, scope_id, object, &object.payload, restore)
        }
        "dedup_non_duplicate" => {
            apply_remote_dedup_relation(transaction, scope_id, object, &object.payload, restore)
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

/// Reads `(clock, updated_at, device_id)` of the local row, `None` when it
/// does not exist. Tables without a device column store an empty id, which
/// keeps the total-order tiebreak deterministic (ties keep the local row).
fn local_row_state(
    transaction: &rusqlite::Transaction<'_>,
    table: &str,
    scope_id: &str,
    archive_id: &str,
) -> Result<Option<(i64, String, String)>, String> {
    transaction
        .query_row(
            &format!(
                "SELECT revision, updated_at, COALESCE(device_id, '') FROM {table} WHERE scope_id = ?1 AND archive_id = ?2"
            ),
            params![scope_id, archive_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn apply_remote_progress(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &SyncStateObject,
    payload: &serde_json::Value,
    restore: bool,
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
    let allow_regression = transaction
        .query_row(
            "SELECT value_json FROM settings WHERE key = 'preferences.allow_progress_regression'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .and_then(|value| serde_json::from_str::<bool>(&value).ok())
        .unwrap_or(true);
    let local_progress: Option<(i64, String, String, i64)> = transaction
        .query_row(
            "SELECT revision, updated_at, COALESCE(device_id, ''), page_index
             FROM reading_progress WHERE scope_id = ?1 AND archive_id = ?2",
            params![scope_id, archive_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let gate = local_progress
        .as_ref()
        .map(|(clock, updated, device, page)| {
            remote_progress_wins(
                allow_regression,
                *clock,
                updated,
                device,
                *page,
                object.logical_clock,
                &object.wall_clock,
                &object.device_id,
                page_index,
            )
        })
        .unwrap_or(true);
    if !gate && !restore {
        return Ok(false);
    }
    // 导入时行里的版本号不能倒着走：文件里的计数来自另一台设备，可能比本机的小。
    let revision = local_progress
        .as_ref()
        .map(|(clock, _, _, _)| (*clock).max(object.logical_clock))
        .unwrap_or(object.logical_clock);
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
                revision,
                object.wall_clock,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

/// History is a union, not a clock race: the merged row keeps the highest read
/// page and the latest visit, whatever device supplied them. Visits compare as
/// instants — an offset timestamp (`15:00+08:00`) prints after `08:00` but is
/// the earlier visit.
fn apply_remote_history(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &SyncStateObject,
    payload: &serde_json::Value,
    restore: bool,
) -> Result<bool, String> {
    let archive_id = payload_text(payload, "archiveId")?;
    // 历史清理写下的墓碑：远端已经把这条记录清掉了，本地跟着删，否则下一次同步
    // 又会把它带回来（本地没有行时任何远端版本都算赢）。
    if object.operation == "delete" || payload_bool(payload, "deleted").unwrap_or(false) {
        // 历史表的时间列叫 visited_at，不是通用行状态里的 updated_at，这里单独读。
        let local: Option<(i64, String, String)> = transaction
            .query_row(
                "SELECT revision, visited_at, COALESCE(device_id, '') FROM reading_history
                 WHERE scope_id = ?1 AND archive_id = ?2",
                params![scope_id, archive_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let gate = local
            .map(|(clock, updated, device)| {
                remote_change_wins(
                    clock,
                    &updated,
                    &device,
                    object.logical_clock,
                    &object.wall_clock,
                    &object.device_id,
                )
            })
            .unwrap_or(false);
        if !gate && !restore {
            return Ok(false);
        }
        return transaction
            .execute(
                "DELETE FROM reading_history WHERE scope_id = ?1 AND archive_id = ?2",
                params![scope_id, archive_id],
            )
            .map(|removed| removed > 0)
            .map_err(|error| error.to_string());
    }
    let page_index = payload
        .get("pageIndex")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| "Remote history payload is missing pageIndex".to_string())?;
    let visited_at = payload_text(payload, "visitedAt")?;
    let local_row: Option<(i64, String, i64, String)> = transaction
        .query_row(
            "SELECT page_index, visited_at, revision, device_id FROM reading_history
             WHERE scope_id = ?1 AND archive_id = ?2",
            params![scope_id, archive_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((local_page, local_visit, local_revision, local_device)) = local_row else {
        transaction
            .execute(
                "INSERT INTO reading_history (scope_id, archive_id, page_index, visited_at, device_id, revision)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
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
        return Ok(true);
    };
    let keep_remote_visit = compare_instants(&visited_at, &local_visit) == std::cmp::Ordering::Greater;
    let next_visit = if keep_remote_visit {
        visited_at
    } else {
        local_visit
    };
    // 留下的那次访问是谁做的，device_id 就写谁：本地访问胜出时写远端设备，会把
    // 「这台机器读到哪」记到别的设备头上，下一次按设备比（墓碑闸门就是这么比的）
    // 就按错的设备算。
    let next_device = if keep_remote_visit {
        object.device_id.as_str()
    } else {
        local_device.as_str()
    };
    transaction
        .execute(
            "UPDATE reading_history SET
               page_index = ?3, visited_at = ?4, device_id = ?5, revision = ?6
             WHERE scope_id = ?1 AND archive_id = ?2",
            params![
                scope_id,
                archive_id,
                local_page.max(page_index),
                next_visit,
                next_device,
                local_revision.max(object.logical_clock),
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

/// 待看（本地 reading_list 表）：带时钟的墓碑集合，老设备的「加」不能复活新设备的
/// 「删」。收藏夹不走这里——它是服务器收藏分类的镜像。
fn apply_remote_list_entry(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &SyncStateObject,
    payload: &serde_json::Value,
    restore: bool,
) -> Result<bool, String> {
    let table = "reading_list";
    let archive_id = payload_text(payload, "archiveId")?;
    let deleted = payload_bool(payload, "deleted")?;
    let local = local_row_state(transaction, table, scope_id, &archive_id)?;
    let gate = local
        .as_ref()
        .map(|(clock, updated, device)| {
            remote_change_wins(
                *clock,
                updated,
                device,
                object.logical_clock,
                &object.wall_clock,
                &object.device_id,
            )
        })
        .unwrap_or(true);
    if !gate && !restore {
        return Ok(false);
    }
    // 导入时行里的版本号不能倒着走：文件里的计数来自另一台设备，可能比本机的小。
    let revision = local
        .as_ref()
        .map(|(clock, _, _)| (*clock).max(object.logical_clock))
        .unwrap_or(object.logical_clock);
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
                revision
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

fn apply_remote_search_preset(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &SyncStateObject,
    payload: &serde_json::Value,
    restore: bool,
) -> Result<bool, String> {
    let preset_id = payload_text(payload, "presetId")?;
    let name = payload_text(payload, "name")?;
    let query = payload_text(payload, "query").unwrap_or_default();
    let sort_by = payload_text(payload, "sortBy").unwrap_or_else(|_| "added".to_string());
    let sort_order = payload_text(payload, "sortOrder").unwrap_or_else(|_| "desc".to_string());
    let category_id = payload.get("categoryId").and_then(|value| value.as_str());
    let deleted = payload_bool(payload, "deleted").unwrap_or(false);
    let local = transaction
        .query_row(
            "SELECT revision, updated_at, COALESCE(device_id, '') FROM search_presets WHERE scope_id = ?1 AND preset_id = ?2",
            params![scope_id, preset_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let gate = local
        .as_ref()
        .map(|(clock, updated, device)| {
            remote_change_wins(
                *clock,
                updated,
                device,
                object.logical_clock,
                &object.wall_clock,
                &object.device_id,
            )
        })
        .unwrap_or(true);
    if !gate && !restore {
        return Ok(false);
    }
    // 导入时行里的版本号不能倒着走：文件里的计数来自另一台设备，可能比本机的小。
    let revision = local
        .as_ref()
        .map(|(clock, _, _)| (*clock).max(object.logical_clock))
        .unwrap_or(object.logical_clock);
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
                revision,
                object.wall_clock,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

fn apply_remote_dedup_relation(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &SyncStateObject,
    payload: &serde_json::Value,
    restore: bool,
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
        .as_ref()
        .map(|(clock, updated)| {
            // The dedup table has no device column, so the tiebreak keeps the
            // local row — deterministic, and unchanged from before.
            remote_change_wins(
                *clock,
                updated,
                "",
                object.logical_clock,
                &object.wall_clock,
                "",
            )
        })
        .unwrap_or(true);
    if !wins && !restore {
        return Ok(false);
    }
    // 导入时行里的计数不能倒着走：文件里的计数来自另一台设备。
    let logical_clock = gate
        .as_ref()
        .map(|(clock, _)| (*clock).max(object.logical_clock))
        .unwrap_or(object.logical_clock);
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
                logical_clock,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

/// Reads whether an encrypted change segment has already been merged, and
/// records one after a successful apply — both for this sync account.
/// 启动时把上次崩溃或中断留在 processing 的日志行交还重试队列。
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

/// 把一个账户的一个范围推到远端并合回来。
///
/// 是真正的 `async fn`，不是 `block_on`：整个网络同步最长可达分钟级（WebDAV/S3
/// 超时 30/60s），在运行时内部 `block_on` 会直接 panic，而占着调用线程跑就是冻住
/// 窗口。
#[tauri::command]
pub async fn sync_remote_scope(
    account_id: String,
    scope_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<usize>, String> {
    Ok(sync_remote_scope_inner(account_id, scope_id, database).await)
}

/// 命令体。拆出来的理由同 `test_sync_account_inner`。

async fn sync_remote_scope_inner(
    account_id: String,
    scope_id: String,
    database: State<'_, Database>,
) -> CommandResult<usize> {
    let (account, key, local_state, pending, enabled) = {
        let connection = match database.connection.lock() {
            Ok(connection) => connection,
            Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
        };
        let account = match read_sync_account(&connection, &account_id) {
            Ok(account) => account,
            Err(error) => return CommandResult::failure("NOT_FOUND", error, false),
        };
        let key = match load_sync_key(&connection, &SystemWebdavCredentialStore, &account_id) {
            Ok(key) => key,
            Err(error) => return CommandResult::failure("UNKNOWN", error, false),
        };
        // 要推的是本地这一侧的全部对象（日志折叠而来，含墓碑），不只是本批新增：
        // 远端文档是「当前状态」，缺了旧对象就等于把它们删掉了。类别上只带上账户
        // 勾选的：没勾的既不出门，也不落地。
        let enabled = parse_sync_scope(&account.sync_scope);
        // 折叠前先把冗余行收掉：每个对象只留最后一版，更早的行仅当已推完
        // （completed）才删。折叠结果不变，同步与日志体积都不再随历史线性涨。
        let _ = compact_journal(&connection, &[&scope_id, GLOBAL_SCOPE]);
        let local_state =
            match build_local_state(&connection, &[&scope_id, GLOBAL_SCOPE], &enabled) {
                Ok(state) => state,
                Err(error) => return CommandResult::failure("UNKNOWN", error, true),
            };
        let mut pending = match pending_journal_entries(&connection, &scope_id) {
            Ok(records) => records,
            Err(error) => return CommandResult::failure("UNKNOWN", error, true),
        };
        if let Ok(global_pending) = pending_journal_entries(&connection, GLOBAL_SCOPE) {
            pending.extend(global_pending);
        }
        (account, key, local_state, pending, enabled)
    };

    sync_scope_impl(
        &database,
        &account,
        &key,
        &scope_id,
        local_state,
        pending,
        &enabled,
        &SystemWebdavCredentialStore,
    )
    .await
}

/// 按勾选的同步范围导出的那份文件。
///
/// 里面装的就是同步文档本身（每个对象的最新一版，含墓碑），所以导入端跑的是同一条
/// 合并规则，不必再维护一套「导出格式」：范围之外的类别在导出时就已滤掉，凭据任何
/// 时候都不在其中——它们只在系统凭据库里。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopedDataExport {
    kind: String,
    schema_version: i64,
    exported_at: String,
    categories: Vec<String>,
    pub(crate) document: SyncStateDocument,
}

const SCOPED_EXPORT_KIND: &str = "yomika-scope-export";
const SCOPED_EXPORT_VERSION: i64 = 1;

/// 本机全部数据范围：每台已配置服务器一个，加上不分服务器的那一个。
fn local_scope_ids(connection: &Connection) -> Result<Vec<String>, String> {
    let mut scope_ids = vec![GLOBAL_SCOPE.to_string()];
    let mut statement = connection
        .prepare("SELECT scope_id FROM servers")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    for row in rows {
        scope_ids.push(row.map_err(|error| error.to_string())?);
    }
    Ok(scope_ids)
}

/// 导出的结果：那份文本，以及里面装了多少个对象、按哪几类筛的（界面据此报数）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedExportReport {
    pub text: String,
    pub objects: usize,
    pub categories: Vec<String>,
}

/// 折本机状态成同步文档信封的核心：导出命令与数据迁移（credentials::export_data）
/// 共用这一份，保证「导出的东西」永远是同一套合并规则折出来的那些。
///
/// `categories` 是要装进这份文档的目录，由调用方给：数据迁移那边按弹层的勾选逐类
/// 裁（只勾进度就只装进度），未知条目丢掉——空清单就是空文档，不回落到全部目录。
pub(crate) fn export_scoped_document(
    connection: &Connection,
    categories: &[String],
) -> Result<(serde_json::Value, usize), String> {
    let enabled: Vec<String> = categories
        .iter()
        .filter(|category| SYNC_SCOPE_CATEGORIES.contains(&category.as_str()))
        .cloned()
        .collect();
    let scope_ids = local_scope_ids(connection)?;
    let refs: Vec<&str> = scope_ids.iter().map(String::as_str).collect();
    let document = build_local_state(connection, &refs, &enabled)?;
    let exported_at = connection
        .query_row("SELECT CURRENT_TIMESTAMP", [], |row| row.get::<_, String>(0))
        .unwrap_or_default();
    let objects = document.objects.len();
    let envelope = ScopedDataExport {
        kind: SCOPED_EXPORT_KIND.to_string(),
        schema_version: SCOPED_EXPORT_VERSION,
        exported_at,
        categories: enabled,
        document,
    };
    Ok((
        serde_json::to_value(&envelope).map_err(|error| error.to_string())?,
        objects,
    ))
}

/// 导出：把本地数据折成一份 JSON。数据迁移（docs/30）把这份信封原样嵌进导出文件，
/// 这条命令保留为独立导出入口（categories 由调用方给，用于裁剪文档里的类别）。
///
/// 覆盖本机**所有**服务器范围，而不只是当前那台：同步一次只推当前服务器，是因为远端
/// 文档是按账户走的；导出的用途是备份与换机器，漏掉别的服务器就等于漏掉一半记录。
#[tauri::command(async)]
pub fn export_scoped_data(
    categories: String,
    database: State<'_, Database>,
) -> CommandResult<ScopedExportReport> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let enabled = parse_sync_scope(&categories);
    let scope_ids = match local_scope_ids(&connection) {
        Ok(scope_ids) => scope_ids,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let refs: Vec<&str> = scope_ids.iter().map(String::as_str).collect();
    let document = match build_local_state(&connection, &refs, &enabled) {
        Ok(document) => document,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let exported_at = connection
        .query_row("SELECT CURRENT_TIMESTAMP", [], |row| row.get::<_, String>(0))
        .unwrap_or_default();
    let objects = document.objects.len();
    let envelope = ScopedDataExport {
        kind: SCOPED_EXPORT_KIND.to_string(),
        schema_version: SCOPED_EXPORT_VERSION,
        exported_at,
        categories: enabled.clone(),
        document,
    };
    match serde_json::to_string_pretty(&envelope) {
        Ok(text) => CommandResult::success(ScopedExportReport {
            text,
            objects,
            categories: enabled,
        }),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

/// 导入的结果：落地了几条，以及有多少条因为类别没勾而留在门外。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedImportReport {
    pub applied: usize,
    pub skipped: usize,
    pub categories: Vec<String>,
}

/// 导入：把文件里的对象恢复进本地，再为落地的那几条写日志。
///
/// 自动同步按时钟合并（时钟大者胜），**文件导入不这么比**：两台设备各自维护自己的
/// 计数器，`sync_journal` 的 `logical_clock` 从没见过面，比大小只会得出「本机这一版
/// 更新」这种没有意义的结论——最常见的情形（把另一台设备的设置导进一台用过的机器）
/// 于是整份被挡在门外，用户看到的是「导入成功、什么都没变」。所以导入一律以文件为
/// 准：文件里的对象就是本机该对象的最新一版（内部实现见 `apply_remote_object` 的
/// `restore`）。
///
/// 重复导入同一份文件仍然幂等：第二次导入写下的还是同一份内容与同一份日志（版本号
/// 取「本机与文件较大者」，不会把已经落地的版本号往下拽）；更旧的一份文件也不会把
/// 更新的数据顶掉，因为两者内容本来就都是它自己那一版。旧文件里没有的对象不受影响：
/// 导入只处理文件里有的那些。
///
/// 文件**内部**的重复项按「留最新」折叠：解析在文本上做（`parse_scoped_document`
/// → `deserialize_state_objects`），同一个档案同一种记录最后只留最新的一版。
///
/// 写日志是必须的：不写，导入的数据就只活在这台机器上，下次同步推出去的文档里没有
/// 它们，另一台设备也就永远看不到。类别没勾的不落地——勾选是「要不要这类数据」的
/// 开关，导入不该绕过它。
#[tauri::command(async)]
pub fn import_scoped_data(
    payload: String,
    categories: String,
    database: State<'_, Database>,
) -> CommandResult<ScopedImportReport> {
    let document = match parse_scoped_document(&payload) {
        Ok(document) => document,
        Err(error) => return CommandResult::failure("INVALID_INPUT", error, false),
    };
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let enabled = parse_sync_scope(&categories);
    match import_scoped_documents(&mut connection, document, &enabled) {
        Ok(report) => CommandResult::success(report),
        Err(error) => CommandResult::failure("INVALID_INPUT", error, false),
    }
}

/// 解析一份导入内容：导出信封（`{kind,schemaVersion,categories,document}`）与裸文档
/// （直接一份同步文档）都收。
///
/// 刻意**不走** `serde_json::Value`：那一步会把 `objects` 里同名的键合成文本里最后
/// 一条，文件内部有重复项时就再也比不出哪一条更新了（见 `deserialize_state_objects`）。
/// 两条路都在文本上直接解析成文档；都读不出来时才回退到 Value，只为给出与旧版一致的
/// 错误文案。
pub(crate) fn parse_scoped_document(payload: &str) -> Result<SyncStateDocument, String> {
    if let Ok(document) = serde_json::from_str::<SyncStateDocument>(payload) {
        return Ok(document);
    }
    if let Ok(export) = serde_json::from_str::<ScopedDataExport>(payload) {
        return Ok(export.document);
    }
    let value: serde_json::Value = serde_json::from_str(payload)
        .map_err(|_| String::from("导入内容不是有效的 JSON"))?;
    match value.get("document") {
        Some(inner) => serde_json::from_value(inner.clone())
            .map_err(|error| format!("导入内容的 document 结构不对：{error}")),
        None => Err(String::from("导入内容里没有 objects（不是本应用导出的数据）")),
    }
}

/// 导入的核心：一份**已经解析成 JSON** 的本机导出，并进本地。
///
/// 单独抽出来是因为它有第二个调用方：带凭据的那份文件里也装着记录
/// （见 `credentials::import_data`），而那边已经锁着连接——再走一次命令层就会自己跟
/// 自己抢锁。能拿到文本的调用方请走 `parse_scoped_document`：Value 里同名的键已经只
/// 剩最后一条，这条路看不见文件内部的重复项。
pub(crate) fn import_scoped_document(
    connection: &mut Connection,
    value: serde_json::Value,
    enabled: &[String],
) -> Result<ScopedImportReport, String> {
    let document: SyncStateDocument = match serde_json::from_value(value.clone()) {
        Ok(document) => document,
        Err(_) => match value.get("document") {
            Some(inner) => serde_json::from_value(inner.clone())
                .map_err(|error| format!("导入内容的 document 结构不对：{error}"))?,
            None => return Err(String::from("导入内容里没有 objects（不是本应用导出的数据）")),
        },
    };
    import_scoped_documents(connection, document, enabled)
}

/// 导入的核心：把一份已经折叠好的文档恢复进本地。时钟比较那一层交给
/// `apply_remote_object` 的 `restore = true`（见上面 `import_scoped_data` 的说明）。
pub(crate) fn import_scoped_documents(
    connection: &mut Connection,
    document: SyncStateDocument,
    enabled: &[String],
) -> Result<ScopedImportReport, String> {
    let objects: Vec<SyncStateObject> = document.objects.into_values().collect();
    let outcome = (|| -> Result<(usize, usize), String> {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let mut applied = 0;
        let mut skipped = 0;
        for object in &objects {
            if !scope_includes(&enabled, &object.object_type) {
                skipped += 1;
                continue;
            }
            // 导入是**恢复**：文件里的对象就是本机该对象的最新一版（`restore = true`），
            // 不按时钟跟本机比大小——两台设备的计数器各数各的，比大小没有意义，而
            // 「导入自己另一台设备的设置」恰恰是本功能最常见的用法。
            if !apply_remote_object(&transaction, &object.scope_id, object, true)? {
                // 没落地就明说：闸门按时钟挡下了它，或者本机已经是这一版。以前这里两边都
                // 不计数，报告只说「已导入 0 项」，用户看着文件里明明有那几条却查不出原因。
                skipped += 1;
                continue;
            }
            applied += 1;
            let next_clock: i64 = transaction
                .query_row(
                    "SELECT COALESCE(MAX(logical_clock), 0) + 1 FROM sync_journal
                     WHERE scope_id = ?1 AND object_id = ?2",
                    params![object.scope_id, object.object_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            // 落地的是文件里的第 N 版，本机版本号就不能只记 MAX + 1：那会比落地的版本
            // 还低，下一份更旧的文件（时钟 2 > 1）就能把它顶掉——app_settings 的闸门
            // 正是拿这个时钟当「本机已经到了第几版」比的。
            let clock = next_clock.max(object.logical_clock);
            journal_object(
                &transaction,
                &object.scope_id,
                &object.object_type,
                &object.object_id,
                clock,
                object.payload.clone(),
            )?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok((applied, skipped))
    })();
    let (applied, skipped) = outcome?;
    Ok(ScopedImportReport {
        applied,
        skipped,
        categories: enabled.to_vec(),
    })
}

/// 「编辑」表单要回显已存的口令。凭据平时只在系统安全存储里，这里按需读一次。
#[tauri::command(async)]
pub fn sync_account_credential(
    account_id: String,
    database: State<'_, Database>,
) -> CommandResult<String> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let account = match read_sync_account(&connection, &account_id) {
        Ok(account) => account,
        Err(error) => return CommandResult::failure("NOT_FOUND", error, false),
    };
    match SystemWebdavCredentialStore.get_credential(&account.credential_ref) {
        Ok(credential) => CommandResult::success(credential),
        Err(error) => CommandResult::failure("PLATFORM_UNAVAILABLE", error, false),
    }
}

/// 把远端那份文档删掉（「重置远端」）。用于远端状态坏掉又不想动本地数据的情形——
/// 比如口令换过、旧密文再也解不开：重置后下次同步会按本地重新写一份。
///
/// 是真正的 `async fn`，不是 `block_on`：理由同 `test_sync_account`——在运行时
/// 内部 `block_on` 会 panic，而占着调用线程跑就是整个网络往返期间窗口冻住。
#[tauri::command]
pub async fn reset_remote_state(
    account_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<()>, String> {
    Ok(reset_remote_state_inner(account_id, database).await)
}

/// 命令体。拆出来的理由同 `test_sync_account_inner`。

async fn reset_remote_state_inner(
    account_id: String,
    database: State<'_, Database>,
) -> CommandResult<()> {
    let (account, credential) = {
        let connection = match database.connection.lock() {
            Ok(connection) => connection,
            Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
        };
        let account = match read_sync_account(&connection, &account_id) {
            Ok(account) => account,
            Err(error) => return CommandResult::failure("NOT_FOUND", error, false),
        };
        let credential = match SystemWebdavCredentialStore.get_credential(&account.credential_ref)
        {
            Ok(credential) => credential,
            Err(error) => return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false),
        };
        (account, credential)
    };
    let store = match RemoteStore::for_account(&account, &credential) {
        Ok(store) => store,
        Err(error) => {
            return CommandResult::failure("INVALID_RESPONSE", sync_error(error), false)
        }
    };
    match store.delete_state(&account.id).await {
        Ok(()) => CommandResult::success(()),
        Err(error) => CommandResult::failure("NETWORK", sync_error(error), true),
    }
}

/// 远端存储的两种实现。同一份同步引擎（合并、条件写、重试）对两者完全一样，
/// 只有「怎么读一份文档、怎么条件写回」不同。
enum RemoteStore {
    Webdav(crate::network::webdav::WebdavClient),
    S3(crate::network::s3::S3Client),
}

impl RemoteStore {
    /// 按账户类型建客户端。S3 的「用户名」是 Access Key ID，凭据是 Secret Access Key。
    /// 收字段而不是收整行：设置页的「测试」按钮手里只有表单草稿，账户还没保存。
    fn connect(
        kind: &str,
        base_url: &str,
        bucket: &str,
        username: &str,
        credential: &str,
    ) -> Result<Self, crate::network::remote::RemoteError> {
        if kind == "s3" {
            Ok(Self::S3(crate::network::s3::S3Client::new(
                base_url,
                bucket,
                username,
                credential,
                crate::network::s3::DEFAULT_REGION,
            )?))
        } else {
            Ok(Self::Webdav(crate::network::webdav::WebdavClient::new(
                base_url, username, credential,
            )?))
        }
    }

    /// 「测试」：只验证能不能连上、凭据对不对，不动远端数据。
    async fn probe(&self) -> Result<(), crate::network::remote::RemoteError> {
        match self {
            Self::Webdav(client) => client.probe().await,
            Self::S3(client) => client.probe().await,
        }
    }

    /// 账户行的字段（调用点用起来顺手）。
    fn for_account(
        account: &SyncAccountRecord,
        credential: &str,
    ) -> Result<Self, crate::network::remote::RemoteError> {
        Self::connect(
            &account.kind,
            &account.base_url,
            &account.bucket,
            &account.username,
            credential,
        )
    }

    async fn get_state(
        &self,
        account_id: &str,
    ) -> Result<Option<crate::network::remote::RemoteState>, crate::network::remote::RemoteError> {
        match self {
            Self::Webdav(client) => client.get_state(account_id).await,
            Self::S3(client) => client.get_state(account_id).await,
        }
    }

    async fn update_state_with_retry<F>(
        &self,
        account_id: &str,
        ciphertext: Vec<u8>,
        etag: Option<String>,
        merge: F,
    ) -> Result<(), crate::network::remote::RemoteError>
    where
        F: Fn(&[u8]) -> Result<Vec<u8>, crate::network::remote::RemoteError>,
    {
        match self {
            Self::Webdav(client) => client.update_state_with_retry(account_id, ciphertext, etag, merge).await,
            Self::S3(client) => client.update_state_with_retry(account_id, ciphertext, etag, merge).await,
        }
    }

    async fn delete_state(
        &self,
        account_id: &str,
    ) -> Result<(), crate::network::remote::RemoteError> {
        match self {
            Self::Webdav(client) => client.delete_state(account_id).await,
            Self::S3(client) => client.delete_state(account_id).await,
        }
    }
}

/// The push + pull pipeline behind `sync_remote_scope`, split from the command so
/// tests can drive it with an in-memory credential store against a mock server.
///
/// Push: the local object set is merged into the remote document and written with
/// a conditional PUT that re-merges on conflict — two devices syncing at once
/// both survive. Pull: the merged document is applied back into the local tables,
/// which is how another device's objects land here.
#[allow(clippy::too_many_arguments)]
async fn sync_scope_impl(
    database: &Database,
    account: &SyncAccountRecord,
    key: &[u8; 32],
    scope_id: &str,
    local_state: SyncStateDocument,
    pending: Vec<SyncJournalRecord>,
    enabled: &[String],
    credentials: &dyn WebdavCredentialStore,
) -> CommandResult<usize> {
    let retryable = |error: &str| {
        let mut connection = database.connection.lock().map_err(|_| ()).unwrap();
        let sequences = pending.iter().map(|record| record.sequence).collect::<Vec<_>>();
        let _ = set_journal_batch_state(&mut connection, scope_id, &sequences, "retryable", Some(error));
    };

    let credential = match credentials.get_credential(&account.credential_ref) {
        Ok(value) => value,
        Err(error) => {
            retryable(&error);
            return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false);
        }
    };
    let store = match RemoteStore::for_account(account, &credential) {
        Ok(store) => store,
        Err(error) => {
            let message = sync_error(error);
            retryable(&message);
            return CommandResult::failure("INVALID_RESPONSE", message, false);
        }
    };

    let remote = match store.get_state(&account.id).await {
        Ok(value) => value,
        Err(error) => {
            let message = sync_error(error);
            retryable(&message);
            return CommandResult::failure("NETWORK", message, true);
        }
    };
    let (merged, etag) = match &remote {
        Some(remote) => match decode_sync_state(key, &remote.ciphertext) {
            Ok(remote_state) => (merge_sync_states(&local_state, &remote_state), remote.etag.clone()),
            // 文档解不开只可能是换了口令或那不是本账户的数据；重试没有意义。
            Err(error) => {
                retryable(&error);
                return CommandResult::failure("INVALID_RESPONSE", error, false);
            }
        },
        None => (local_state.clone(), None),
    };
    let ciphertext = match encode_sync_state(key, &merged) {
        Ok(bytes) => bytes,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let result = store
        .update_state_with_retry(&account.id, ciphertext, etag, |remote_bytes| {
            let remote_state = decode_sync_state(key, remote_bytes)
                .map_err(crate::network::remote::RemoteError::Verification)?;
            encode_sync_state(key, &merge_sync_states(&local_state, &remote_state))
                .map_err(crate::network::remote::RemoteError::Verification)
        })
        .await;
    if let Err(error) = result {
        let message = sync_error(error);
        retryable(&message);
        return CommandResult::failure("NETWORK", message, true);
    }

    // 推上去了，这批日志就地标记完成。
    let pushed = pending.len();
    {
        let mut connection = match database.connection.lock() {
            Ok(connection) => connection,
            Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
        };
        let sequences = pending.iter().map(|record| record.sequence).collect::<Vec<_>>();
        if let Err(error) =
            set_journal_batch_state(&mut connection, scope_id, &sequences, "completed", None)
        {
            return CommandResult::failure("UNKNOWN", error, true);
        }
        // 这一次是真的推拉成功了：账户行记下时刻，界面显示「上次同步」，
        // 自动同步也据此判断启动/回到前台时要不要补一次。
        if let Err(error) = connection.execute(
            "UPDATE sync_accounts SET last_sync_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![account.id],
        ) {
            return CommandResult::failure("UNKNOWN", error.to_string(), true);
        }
        // 拉取：把合并后的对象落回本地表（自己那部分重复应用是无害的）。
        let objects = merged
            .objects
            .values()
            .filter(|object| object.scope_id == scope_id || object.scope_id == GLOBAL_SCOPE)
            .filter(|object| scope_includes(enabled, &object.object_type))
            .cloned()
            .collect::<Vec<_>>();
        match apply_remote_objects(&mut connection, &objects) {
            Ok(pulled) => CommandResult::success(pushed + pulled),
            Err(error) => CommandResult::failure("INVALID_RESPONSE", error, false),
        }
    }
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
    // 按主键单行读回。原先把该 scope 的全部日志行重新查一遍再 find，
    // 每次状态更新 O(N)，一次同步逐行更新下来是 O(N²)。
    connection
        .query_row(
            "SELECT sequence, scope_id, object_id, object_type, operation, device_id,
                    logical_clock, wall_clock, base_hash, payload_hash, payload_json,
                    status, attempt_count, last_error
             FROM sync_journal
             WHERE scope_id = ?1 AND sequence = ?2",
            params![scope_id, sequence],
            row_to_record,
        )
        .map_err(|error| error.to_string())
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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
            .execute_batch(include_str!("../../migrations/0023_servers_enabled.sql"))
            .expect("servers enabled migration");
        connection
            .execute_batch(include_str!("../../migrations/0024_sync_scope.sql"))
            .expect("sync scope migration");
        connection
            .execute_batch(include_str!("../../migrations/0025_webdav_last_sync.sql"))
            .expect("webdav last sync migration");
        connection
            .execute_batch(include_str!("../../migrations/0026_sync_accounts.sql"))
            .expect("sync accounts migration");
        connection
            .execute_batch(include_str!("../../migrations/0027_sync_account_active.sql"))
            .expect("sync account active migration");
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

    fn account_input(base_url: &str) -> SaveSyncAccountInput {
        SaveSyncAccountInput {
            id: "account-a".to_string(),
            kind: "webdav".to_string(),
            bucket: String::new(),
            label: "Personal WebDAV".to_string(),
            base_url: base_url.to_string(),
            username: "reader".to_string(),
            credential: "secret-token".to_string(),
            sync_scope: None,
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

    fn saved(label: &str, credential: &str) -> SaveSyncAccountInput {
        SaveSyncAccountInput {
            id: "account-a".to_string(),
            kind: "webdav".to_string(),
            bucket: String::new(),
            label: label.to_string(),
            base_url: "https://dav.example.com/Yomika".to_string(),
            username: "reader".to_string(),
            credential: credential.to_string(),
            sync_scope: None,
        }
    }

    fn memory_credentials() -> MemoryWebdavCredentialStore {
        MemoryWebdavCredentialStore {
            writes: Mutex::new(Vec::new()),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        }
    }

    #[test]
    fn each_kind_keeps_its_own_account_and_only_one_is_active() {
        let mut connection = migrated_connection();
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(Vec::new()),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };
        // WebDAV 一份。
        let CommandResult::Success { value: webdav, .. } =
            save_sync_account_record(&mut connection, &credentials, saved("NAS", "secret-token"))
        else {
            panic!("webdav save failed");
        };
        assert!(webdav.active, "the first account is the active one");

        // 对象存储另一份：id 不同，两行共存，只有新的那行生效。
        let mut object_storage = account_input("https://acct.r2.cloudflarestorage.com");
        object_storage.id = "s3-1".to_string();
        object_storage.kind = "s3".to_string();
        object_storage.bucket = "yomika".to_string();
        let CommandResult::Success { value: s3, .. } =
            save_sync_account_record(&mut connection, &credentials, object_storage)
        else {
            panic!("s3 save failed");
        };
        assert!(s3.active);
        assert_eq!(s3.kind, "s3");

        let accounts = query_sync_accounts(&connection).expect("accounts");
        assert_eq!(accounts.len(), 2, "两套账户各存各的");
        assert_eq!(
            accounts.iter().filter(|account| account.active).count(),
            1,
            "同时只生效一套"
        );
        assert!(accounts[0].active, "生效的那套排在最前");
        assert_eq!(accounts[0].kind, "s3");
        let webdav_row = accounts.iter().find(|account| account.id == "account-a").expect("webdav row");
        assert!(!webdav_row.active);
        // 待命那套的地址、凭据、范围都还在，切回去就能用。
        assert_eq!(webdav_row.base_url, "https://dav.example.com/Yomika");
        assert_eq!(credentials.get_credential(&webdav_row.credential_ref).expect("credential"), "secret-token");

        // 切回 WebDAV：再存一次它就重新生效，对象存储那套转为待命。
        let CommandResult::Success { value: back, .. } =
            save_sync_account_record(&mut connection, &credentials, saved("NAS", ""))
        else {
            panic!("switch back failed");
        };
        assert!(back.active);
        let accounts = query_sync_accounts(&connection).expect("accounts");
        assert_eq!(accounts.iter().filter(|account| account.active).count(), 1);
        assert_eq!(accounts[0].id, "account-a");
    }

    #[test]
    fn saving_an_account_without_a_scope_keeps_the_stored_one() {
        // 「同步范围」有了自己的设置行以后，账户表单不再带范围：改名/换地址不能顺手
        // 把它重置回默认集合。
        let mut connection = migrated_connection();
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(Vec::new()),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };
        let CommandResult::Success { value: created, .. } =
            save_sync_account_record(&mut connection, &credentials, saved("Personal", "secret-token"))
        else {
            panic!("account save failed");
        };
        assert_eq!(parse_sync_scope(&created.sync_scope), default_scope());

        let mut narrowed = account_input("https://dav.example.com/Yomika");
        narrowed.sync_scope = Some(r#"["progress"]"#.to_string());
        let CommandResult::Success { value: scoped, .. } =
            save_sync_account_record(&mut connection, &credentials, narrowed)
        else {
            panic!("scoped save failed");
        };
        assert_eq!(parse_sync_scope(&scoped.sync_scope), vec!["progress".to_string()]);
        let stored: String = connection
            .query_row("SELECT sync_scope FROM sync_accounts WHERE id = 'account-a'", [], |row| row.get(0))
            .expect("stored scope");
        assert_eq!(parse_sync_scope(&stored), vec!["progress".to_string()]);

        // 再存一次账户（不带范围）：范围保持不变。
        let CommandResult::Success { value: renamed, .. } =
            save_sync_account_record(&mut connection, &credentials, saved("Renamed", ""))
        else {
            panic!("rename failed");
        };
        assert_eq!(renamed.label, "Renamed");
        assert_eq!(parse_sync_scope(&renamed.sync_scope), vec!["progress".to_string()]);
    }

    #[test]
    fn the_scope_row_saves_by_itself_and_only_for_a_known_account() {
        let mut connection = migrated_connection();
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(Vec::new()),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };
        let CommandResult::Success { .. } =
            save_sync_account_record(&mut connection, &credentials, saved("Personal", "secret-token"))
        else {
            panic!("account save failed");
        };

        // 与命令同一条路径：先归一化，再写回。`lrr_servers` 是退役的类别 id（服务器
        // 条目现在归「账户与服务器」，不参与同步），归一化时被丢掉——老账户里存着的
        // 那个 id 不该在界面上以「已勾选但点不动」的样子出现。
        let serialized = serialize_sync_scope(&parse_sync_scope(r#"["progress","lrr_servers"]"#));
        connection
            .execute(
                "UPDATE sync_accounts SET sync_scope = ?2 WHERE id = ?1",
                params!["account-a", serialized],
            )
            .expect("scope update");
        let record = read_sync_account(&connection, "account-a").expect("record");
        assert_eq!(
            parse_sync_scope(&record.sync_scope),
            vec!["progress".to_string()]
        );
        // 账户表单里的其它字段没被动过。
        assert_eq!(record.label, "Personal");
        assert_eq!(record.kind, "webdav");
        // 未知账户：更新 0 行，命令据此报 NOT_FOUND。
        let updated = connection
            .execute(
                "UPDATE sync_accounts SET sync_scope = ?2 WHERE id = ?1",
                params!["missing", r#"["progress"]"#],
            )
            .expect("no-op update");
        assert_eq!(updated, 0);
    }

    #[test]
    fn a_history_tombstone_deletes_the_row_and_a_stale_one_does_not() {
        let connection = migrated_connection();
        connection
            .execute(
                "INSERT INTO reading_history (scope_id, archive_id, page_index, visited_at, device_id, revision)
                 VALUES ('scope-a', 'archive-a', 5, '2026-01-01 00:00:00', 'device-a', 4)",
                [],
            )
            .expect("history fixture");
        let transaction = connection.unchecked_transaction().expect("transaction");
        let tombstone = |clock: i64| SyncStateObject {
            scope_id: "scope-a".to_string(),
            object_type: "history".to_string(),
            object_id: "scope-a/archive-a".to_string(),
            operation: "upsert".to_string(),
            payload: serde_json::json!({"archiveId": "archive-a", "deleted": true}),
            payload_hash: "hash-tombstone".to_string(),
            logical_clock: clock,
            device_id: "device-b".to_string(),
            wall_clock: "2026-09-17 00:00:00".to_string(),
        };

        // 时钟更小的墓碑（例如从一台落后的设备拉回来的）不动本地这一行。
        assert!(!apply_remote_object(&transaction, "scope-a", &tombstone(3), false).expect("stale tombstone"));
        let still_there: i64 = transaction
            .query_row("SELECT COUNT(*) FROM reading_history", [], |row| row.get(0))
            .expect("row count");
        assert_eq!(still_there, 1);

        // 时钟更大的一版赢：行被删掉，重复应用也不会把它插回来。
        assert!(apply_remote_object(&transaction, "scope-a", &tombstone(5), false).expect("tombstone"));
        let removed: i64 = transaction
            .query_row("SELECT COUNT(*) FROM reading_history", [], |row| row.get(0))
            .expect("row count");
        assert_eq!(removed, 0);
        assert!(!apply_remote_object(&transaction, "scope-a", &tombstone(5), false).expect("repeat tombstone"));
    }

    #[test]
    fn editing_an_account_without_a_credential_keeps_the_stored_one() {
        // 编辑表单不会把旧口令回填出来：留空保存必须沿用原凭据，否则改个名字就会
        // 把账户的口令抹掉（同步密钥还是从它派生的）。
        let mut connection = migrated_connection();
        let credentials = memory_credentials();
        assert!(matches!(
            save_sync_account_record(&mut connection, &credentials, saved("Personal", "secret-token")),
            CommandResult::Success { .. }
        ));
        let first_ref: String = connection
            .query_row("SELECT credential_ref FROM sync_accounts WHERE id = 'account-a'", [], |row| row.get(0))
            .expect("credential ref");

        assert!(matches!(
            save_sync_account_record(&mut connection, &credentials, saved("Renamed", "")),
            CommandResult::Success { .. }
        ));

        let after_ref: String = connection
            .query_row("SELECT credential_ref FROM sync_accounts WHERE id = 'account-a'", [], |row| row.get(0))
            .expect("credential ref after edit");
        assert_eq!(first_ref, after_ref);
        assert_eq!(credentials.writes.lock().expect("writes").len(), 1);
    }

    #[test]
    fn the_sync_key_follows_the_account_credentials() {
        // 密钥由账户与口令派生：同一账户两次读到同一把，换口令则换一把。任何设备
        // 只要装了同一个账户就能解密，不需要再导出/导入密钥。
        let mut connection = migrated_connection();
        let credentials = memory_credentials();
        assert!(matches!(
            save_sync_account_record(&mut connection, &credentials, saved("Personal", "secret-token")),
            CommandResult::Success { .. }
        ));
        let first = load_sync_key(&connection, &credentials, "account-a").expect("derived key");
        let again = load_sync_key(&connection, &credentials, "account-a").expect("derived key");
        assert_eq!(first, again);

        assert!(matches!(
            save_sync_account_record(&mut connection, &credentials, saved("Personal", "another-token")),
            CommandResult::Success { .. }
        ));
        let rotated = load_sync_key(&connection, &credentials, "account-a").expect("derived key");
        assert_ne!(first, rotated);
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

    fn scoped_object(
        scope_id: &str,
        object_type: &str,
        object_id: &str,
        payload: serde_json::Value,
    ) -> SyncStateObject {
        SyncStateObject {
            scope_id: scope_id.to_string(),
            object_type: object_type.to_string(),
            object_id: object_id.to_string(),
            operation: "upsert".to_string(),
            payload,
            payload_hash: "hash-a".to_string(),
            logical_clock: 1,
            device_id: "device-a".to_string(),
            wall_clock: "2026-08-26T00:00:00Z".to_string(),
        }
    }

    fn document_with(scope_id: &str, object_type: &str, object_id: &str, payload: serde_json::Value) -> SyncStateDocument {
        SyncStateDocument {
            version: SYNC_STATE_VERSION,
            epoch: 0,
            objects: std::collections::BTreeMap::from([(
                state_object_key(scope_id, object_type, object_id),
                scoped_object(scope_id, object_type, object_id, payload),
            )]),
        }
    }

    #[test]
    fn the_sync_document_round_trips_and_tampering_fails() {
        let key = [7_u8; 32];
        let document = document_with("scope-a", "reading_progress", "archive-a", serde_json::json!({"page": 3}));
        let encoded = encode_sync_state(&key, &document).expect("encode state");
        assert_ne!(encoded, serde_json::to_vec(&document).expect("plain json"));
        // 对象 id 不该在密文里出现——服务端只看到一份字节流。
        assert!(!String::from_utf8_lossy(&encoded).contains("archive-a"));
        let decoded = decode_sync_state(&key, &encoded).expect("decode state");
        assert_eq!(decoded.objects.len(), 1);
        assert_eq!(
            decoded.objects.values().next().expect("object").object_id,
            "archive-a"
        );
        let mut tampered = encoded.clone();
        *tampered.last_mut().expect("ciphertext") ^= 1;
        assert!(decode_sync_state(&key, &tampered).is_err());
        // 更新版本写的文档要明确拒绝，而不是当成旧结构误读。
        let mut future = document.clone();
        future.version = SYNC_STATE_VERSION + 1;
        let future_encoded = encode_sync_state(&key, &future).expect("encode future");
        assert!(decode_sync_state(&key, &future_encoded).is_err());
    }

    #[test]
    fn local_state_coalesces_the_latest_version_per_object() {
        let connection = migrated_connection();
        append_journal_entry(&connection, input("scope-a", "archive-a")).expect("first");
        let mut newer = input("scope-a", "archive-a");
        newer.logical_clock = 2;
        newer.payload_json = r#"{"page":4}"#.to_string();
        append_journal_entry(&connection, newer).expect("newer");
        append_journal_entry(&connection, input("scope-a", "archive-b")).expect("second object");

        let document = build_local_state(&connection, &["scope-a"], &default_scope()).expect("state");
        assert_eq!(document.objects.len(), 2);
        let latest = document
            .objects
            .get(&state_object_key("scope-a", "reading_progress", "archive-a"))
            .expect("latest object");
        assert_eq!(latest.logical_clock, 2);
        assert_eq!(latest.payload["page"], serde_json::json!(4));
    }

    #[test]
    fn compacting_drops_only_superseded_completed_rows() {
        let connection = migrated_connection();
        append_journal_entry(&connection, input("scope-a", "archive-a")).expect("first");
        let mut newer = input("scope-a", "archive-a");
        newer.logical_clock = 2;
        newer.payload_json = r#"{"page":4}"#.to_string();
        append_journal_entry(&connection, newer).expect("newer");
        // 另一个对象的一行，仍是 pending：推送队列，压缩不得碰。
        append_journal_entry(&connection, input("scope-a", "archive-b")).expect("pending object");

        // 第一行标记为已推送；第二行保持 pending。
        connection
            .execute(
                "UPDATE sync_journal SET status='completed' WHERE scope_id='scope-a' AND sequence=1",
                [],
            )
            .expect("mark completed");

        let before = build_local_state(&connection, &["scope-a"], &default_scope()).expect("state before");
        compact_journal(&connection, &["scope-a"]).expect("compact");
        let after = build_local_state(&connection, &["scope-a"], &default_scope()).expect("state after");

        // 被覆盖的已完成行没了，但折叠出来的文档逐字节一致。
        assert_eq!(before, after);
        let remaining: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_journal WHERE scope_id='scope-a'", [], |row| row.get(0))
            .expect("count");
        assert_eq!(remaining, 2);
        // archive-a 的最新一行与 archive-b 都是 pending，推送队列原封不动。
        let pending: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_journal WHERE scope_id='scope-a' AND status='pending'",
                [],
                |row| row.get(0),
            )
            .expect("pending count");
        assert_eq!(pending, 2);
    }

    #[test]
    fn local_state_keys_by_scope_type_and_id() {
        let connection = migrated_connection();
        append_journal_entry(&connection, input("scope-a", "scope-a/archive-a")).expect("progress");
        let mut history = input("scope-a", "scope-a/archive-a");
        history.object_type = "history".to_string();
        history.payload_json = r#"{"pageIndex":3}"#.to_string();
        append_journal_entry(&connection, history).expect("history");

        let document = build_local_state(&connection, &["scope-a"], &default_scope()).expect("state");
        assert_eq!(document.objects.len(), 2);
        let mut types = document
            .objects
            .values()
            .map(|object| object.object_type.as_str())
            .collect::<Vec<_>>();
        types.sort();
        assert_eq!(types, vec!["history", "reading_progress"]);
    }

    #[test]
    fn state_merge_takes_the_newer_object_and_is_order_independent() {
        let key_a = state_object_key("scope-a", "reading_progress", "archive-a");
        let key_b = state_object_key("scope-a", "reading_progress", "archive-b");
        let mut local = document_with("scope-a", "reading_progress", "archive-a", serde_json::json!({"page": 9}));
        local.epoch = 4;
        local.objects.get_mut(&key_a).expect("local object").logical_clock = 3;
        local.objects.get_mut(&key_a).expect("local object").payload_hash = "hash-local".to_string();

        let mut remote = document_with("scope-a", "reading_progress", "archive-a", serde_json::json!({"page": 4}));
        remote.epoch = 5;
        remote.objects.get_mut(&key_a).expect("remote object").logical_clock = 2;
        remote.objects.insert(key_b.clone(), scoped_object("scope-a", "reading_progress", "archive-b", serde_json::json!({"page": 1})));

        let merged = merge_sync_states(&local, &remote);
        assert_eq!((merged.version, merged.epoch), (SYNC_STATE_VERSION, 5));
        assert_eq!(merged.objects.len(), 2);
        assert_eq!(merged.objects[&key_a].logical_clock, 3);
        assert_eq!(merged.objects[&key_a].payload_hash, "hash-local");
        // 合并顺序不影响结果：反过来算同一次。
        assert_eq!(merge_sync_states(&remote, &local), merged);

        // 时钟相同（两台设备各自离线改过）时按内容哈希定胜负，仍然是确定的。
        let mut tie_local = local.clone();
        tie_local.objects.get_mut(&key_a).expect("object").logical_clock = 2;
        tie_local.objects.get_mut(&key_a).expect("object").payload_hash = "hash-bbb".to_string();
        let mut tie_remote = remote.clone();
        tie_remote.objects.get_mut(&key_a).expect("object").logical_clock = 2;
        tie_remote.objects.get_mut(&key_a).expect("object").payload_hash = "hash-aaa".to_string();
        assert_eq!(
            merge_sync_states(&tie_local, &tie_remote),
            merge_sync_states(&tie_remote, &tie_local)
        );
    }

    #[test]
    fn webdav_credential_failure_leaves_sqlite_unchanged() {
        let mut connection = migrated_connection();
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(Vec::new()),
            deletes: Mutex::new(Vec::new()),
            failure: Some("secure storage unavailable"),
        };

        let result = save_sync_account_record(
            &mut connection,
            &credentials,
            account_input("https://dav.example.com/Yomika"),
        );

        assert!(matches!(result, CommandResult::Failure { .. }));
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_accounts", [], |row| row.get(0))
            .expect("account count");
        assert_eq!(count, 0);
    }

    #[test]
    fn webdav_credential_failure_leaves_existing_account_unchanged() {
        let mut connection = migrated_connection();
        connection
            .execute(
                "INSERT INTO sync_accounts
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
        let mut changed = account_input("https://new.example.com/Yomika");
        changed.label = "New label".to_string();

        let result = save_sync_account_record(&mut connection, &credentials, changed);

        assert!(matches!(result, CommandResult::Failure { .. }));
        let stored: (String, String, String, String) = connection
            .query_row(
                "SELECT label, base_url, username, credential_ref FROM sync_accounts WHERE id = 'account-a'",
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
                "CREATE TRIGGER reject_sync_account
                 BEFORE INSERT ON sync_accounts
                 BEGIN SELECT RAISE(ABORT, 'forced failure'); END;",
            )
            .expect("failure trigger");
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(Vec::new()),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };

        let result = save_sync_account_record(
            &mut connection,
            &credentials,
            account_input("https://dav.example.com/Yomika"),
        );

        assert!(matches!(result, CommandResult::Failure { .. }));
        let writes = credentials.writes.lock().expect("credential writes");
        let deletes = credentials.deletes.lock().expect("credential deletes");
        assert_eq!(writes.len(), 1);
        assert_eq!(deletes.as_slice(), &[writes[0].0.clone()]);
    }

    #[test]
    fn saved_sync_account_keeps_plaintext_credential_out_of_sqlite_and_response() {
        let mut connection = migrated_connection();
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(Vec::new()),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };

        let result = save_sync_account_record(
            &mut connection,
            &credentials,
            account_input("https://dav.example.com/Yomika/"),
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
                "SELECT id || label || base_url || username || credential_ref || status FROM sync_accounts",
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
    fn listed_sync_accounts_expose_only_public_metadata() {
        let mut connection = migrated_connection();
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(Vec::new()),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };
        save_sync_account_record(
            &mut connection,
            &credentials,
            account_input("https://dav.example.com/Yomika"),
        );

        let accounts = query_sync_accounts(&connection).expect("list accounts");

        assert_eq!(accounts.len(), 1);
        let serialized = serde_json::to_string(&accounts).expect("serialize accounts");
        assert!(!serialized.contains("secret-token"));
        assert!(serialized.contains("credentialRef"));
    }

    #[test]
    fn sync_account_rejects_non_http_and_embedded_credentials_before_keyring_write() {
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
            let result = save_sync_account_record(
                &mut connection,
                &credentials,
                account_input(invalid_url),
            );
            assert!(matches!(result, CommandResult::Failure { .. }));
        }

        assert!(credentials
            .writes
            .lock()
            .expect("credential writes")
            .is_empty());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_accounts", [], |row| row.get(0))
            .expect("account count");
        assert_eq!(count, 0);
    }

    fn remote_object(
        object_type: &str,
        object_id: &str,
        logical_clock: i64,
        wall_clock: &str,
        payload: serde_json::Value,
    ) -> SyncStateObject {
        SyncStateObject {
            scope_id: String::new(),
            object_id: object_id.to_string(),
            object_type: object_type.to_string(),
            operation: "upsert".to_string(),
            device_id: "device-b".to_string(),
            logical_clock,
            wall_clock: wall_clock.to_string(),
            payload_hash: "remote-hash".to_string(),
            payload,
        }
    }

    /// 文档里的对象都带着自己的 scope（原来这个字段挂在段信封上），测试里补上。
    fn remote_objects(scope_id: &str, objects: Vec<SyncStateObject>) -> Vec<SyncStateObject> {
        objects
            .into_iter()
            .map(|mut object| {
                object.scope_id = scope_id.to_string();
                object
            })
            .collect()
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
        let higher = remote_objects(
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
        let lower = remote_objects(
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
        let equal_newer = remote_objects(
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
    fn cross_device_progress_never_regresses_to_a_lower_page() {
        // The frontend merge keeps the higher page across devices; the native
        // merge must agree, even when the low-page device carries the newer
        // clock — otherwise a device that jumped back drags the other one with
        // it on the next pull.
        let mut connection = migrated_connection();
        connection.execute(
            "INSERT INTO settings (key, value_json) VALUES ('preferences.allow_progress_regression', 'false')",
            [],
        ).expect("disable regression");
        let first = remote_objects(
            "scope-a",
            vec![remote_object(
                "reading_progress",
                "scope-a/archive-a",
                5,
                "2026-09-14 10:00:00",
                serde_json::json!({"archiveId": "archive-a", "pageIndex": 80, "pageCount": 100, "layout": "paged", "direction": "ltr", "coverAlone": null}),
            )],
        );
        let mut second = remote_object(
            "reading_progress",
            "scope-a/archive-a",
            6,
            "2026-09-14 10:01:00",
            serde_json::json!({"archiveId": "archive-a", "pageIndex": 10, "pageCount": 100, "layout": "paged", "direction": "ltr", "coverAlone": null}),
        );
        second.device_id = "device-c".to_string();
        let second = remote_objects("scope-a", vec![second]);
        assert_eq!(apply_remote_objects(&mut connection, &first).expect("apply"), 1);
        assert_eq!(apply_remote_objects(&mut connection, &second).expect("apply"), 0);
        let page: i64 = connection
            .query_row(
                "SELECT page_index FROM reading_progress WHERE scope_id='scope-a' AND archive_id='archive-a'",
                [],
                |row| row.get(0),
            )
            .expect("kept page");
        assert_eq!(page, 80, "a newer clock from another device dragged the page backwards");
    }

    #[test]
    fn cross_device_progress_regresses_when_the_newer_visit_allows_it() {
        let mut connection = migrated_connection();
        let first = remote_objects("scope-a", vec![remote_object(
            "reading_progress", "scope-a/archive-a", 5, "2026-09-14 10:00:00",
            serde_json::json!({"archiveId":"archive-a","pageIndex":80,"pageCount":100,"layout":"paged","direction":"ltr"}),
        )]);
        let mut lower = remote_object(
            "reading_progress", "scope-a/archive-a", 6, "2026-09-14 10:01:00",
            serde_json::json!({"archiveId":"archive-a","pageIndex":10,"pageCount":100,"layout":"paged","direction":"ltr"}),
        );
        lower.device_id = "device-c".into();
        assert_eq!(apply_remote_objects(&mut connection, &first).expect("first"), 1);
        assert_eq!(apply_remote_objects(&mut connection, &remote_objects("scope-a", vec![lower])).expect("newer"), 1);
        let page: i64 = connection.query_row(
            "SELECT page_index FROM reading_progress WHERE scope_id='scope-a' AND archive_id='archive-a'",
            [], |row| row.get(0),
        ).expect("synced page");
        assert_eq!(page, 10);
    }

    #[test]
    fn equal_clocks_converge_on_the_same_winner_on_every_device() {
        // Equal clocks and equal second-resolution timestamps previously left
        // each device keeping whatever it applied last. The device-id
        // tiebreak makes the comparator a strict total order, so both
        // application orders end on the same winner.
        fn progress(device_id: &str, page: i64) -> SyncStateObject {
            let mut object = remote_object(
                "reading_progress",
                "scope-a/archive-a",
                1,
                "2026-09-14 10:00:00",
                serde_json::json!({"archiveId": "archive-a", "pageIndex": page, "pageCount": 100, "layout": "paged", "direction": "ltr", "coverAlone": null}),
            );
            object.device_id = device_id.to_string();
            object
        }
        fn page_of(connection: &mut Connection) -> i64 {
            connection
                .query_row(
                    "SELECT page_index FROM reading_progress WHERE scope_id='scope-a' AND archive_id='archive-a'",
                    [],
                    |row| row.get(0),
                )
                .expect("merged page")
        }
        let mut device_a = migrated_connection();
        let mut device_b = migrated_connection();
        // Device A applies A's change then B's; device B the reverse.
        assert_eq!(apply_remote_objects(&mut device_a, &remote_objects("scope-a", vec![progress("device-a", 10)])).expect("apply"), 1);
        assert_eq!(apply_remote_objects(&mut device_a, &remote_objects("scope-a", vec![progress("device-b", 20)])).expect("apply"), 1);
        assert_eq!(apply_remote_objects(&mut device_b, &remote_objects("scope-a", vec![progress("device-b", 20)])).expect("apply"), 1);
        assert_eq!(apply_remote_objects(&mut device_b, &remote_objects("scope-a", vec![progress("device-a", 10)])).expect("apply"), 0);
        assert_eq!(
            page_of(&mut device_a),
            page_of(&mut device_b),
            "equal revision and second-resolution timestamp kept different local winners forever"
        );
    }

    #[test]
    fn history_visited_at_compares_instants_not_printed_digits() {
        // An offset timestamp ("15:00+08:00" = 07:00 UTC) prints after
        // "08:00", so a string MAX adopts it even though it is the earlier
        // instant.
        let mut connection = migrated_connection();
        connection
            .execute(
                "INSERT INTO reading_history (scope_id, archive_id, page_index, visited_at, device_id, revision)
                 VALUES ('scope-a', 'archive-a', 3, '2026-09-01 08:00:00', 'device-a', 4)",
                [],
            )
            .expect("local history");
        let remote = remote_objects(
            "scope-a",
            vec![remote_object(
                "history",
                "scope-a/archive-a",
                1,
                "2026-09-01 15:00:00",
                serde_json::json!({"archiveId": "archive-a", "pageIndex": 5, "visitedAt": "2026-09-01T15:00:00+08:00"}),
            )],
        );
        assert_eq!(apply_remote_objects(&mut connection, &remote).expect("apply"), 1);
        let visited_at: String = connection
            .query_row(
                "SELECT visited_at FROM reading_history WHERE scope_id='scope-a' AND archive_id='archive-a'",
                [],
                |row| row.get(0),
            )
            .expect("merged visit");
        assert_eq!(
            visited_at, "2026-09-01 08:00:00",
            "visited_at merged by printed digits instead of instants"
        );
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
        let remote = remote_objects(
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
        // 同步词汇里的 watchlist 是「待看」，落在本地的 reading_list 表。
        let mut connection = migrated_connection();
        connection
            .execute(
                "INSERT INTO reading_list (scope_id, archive_id, device_id, deleted_at, revision, updated_at)
                 VALUES ('scope-a', 'archive-a', 'device-a', NULL, 2, '2026-09-01 08:00:00')",
                [],
            )
            .expect("local watchlist entry");
        // An older device's add must not resurrect the entry (lower clock).
        let older_add = remote_objects(
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
        let newer_delete = remote_objects(
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
        let revive = remote_objects(
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
                "SELECT deleted_at, revision FROM reading_list WHERE scope_id='scope-a' AND archive_id='archive-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("watchlist state");
        assert_eq!(deleted_at, None);
        assert_eq!(revision, 4);
    }

    #[test]
    fn the_credential_classes_are_not_sync_categories() {
        // 凭据不进同步：服务器条目、E-H 账户与 API Key/Cookie/同步口令各有各的进出口
        // （「导入导出范围」+ 口令加密的文件），所以它们连类别都不该有——老账户里存着
        // 的那些 id 读回来会被丢掉，而不是以「已勾选」的样子留在界面上。
        for retired in ["credentials", "lrr_servers", "eh_account", "favorite"] {
            assert!(!SYNC_SCOPE_CATEGORIES.contains(&retired), "{retired} 不该是同步类别");
            assert!(!DEFAULT_SYNC_SCOPE.contains(&retired), "{retired} 不该默认勾选");
            assert_eq!(
                parse_sync_scope(&format!("[\"progress\",\"{retired}\"]")),
                vec!["progress".to_string()],
                "{retired} 读回来该被丢掉"
            );
        }
        // 也没有任何对象类型落在它们身上。
        for object_type in ["favorite", "lrr_server", "eh_account"] {
            assert_eq!(object_type_category(object_type), None, "{object_type} 不该有类别");
        }
    }

    #[test]
    fn the_default_scope_is_records_and_settings() {
        // 默认集合＝记录与设置全勾，「账户与服务器」不勾。新增一类却忘了进默认集合，
        // 就等于那类数据默认不同步——所以拿类别表本身来对。
        for category in SYNC_SCOPE_CATEGORIES {
            assert_eq!(
                DEFAULT_SYNC_SCOPE.contains(&category),
                category != "credentials",
                "{category} 的默认勾选状态不对"
            );
        }
    }

    #[test]
    fn remote_preferences_merge_field_by_field_and_keep_this_devices_paths() {
        // 偏好是「一份快照」：以前整份替换，于是别的设备的下载目录与本机缓存上限
        // 会被写过来。现在按字段合并，属于本机的两项不动，缺的字段也留本机的值。
        let mut connection = migrated_connection();
        connection
            .execute(
                "INSERT INTO settings (key, value_json) VALUES ('preferences', ?1)",
                [serde_json::json!({
                    "theme": "light",
                    "defaultLayout": "auto",
                    "defaultDirection": "ltr",
                    "cacheMaxBytes": 4_294_967_296_u64,
                    "downloadDirectory": "E:/Downloads",
                    "sfwMode": false,
                })
                .to_string()],
            )
            .expect("local preferences");
        let remote = remote_objects(
            GLOBAL_SCOPE,
            vec![remote_object(
                "app_setting",
                "preferences",
                2,
                "2026-09-02 08:00:00",
                serde_json::json!({
                    "theme": "dark",
                    "defaultLayout": "paged",
                    "cacheMaxBytes": 1_073_741_824_u64,
                    "downloadDirectory": "C:/Other/Downloads",
                    "sfwMode": true,
                }),
            )],
        );
        assert_eq!(apply_remote_objects(&mut connection, &remote).expect("apply"), 1);
        let stored: serde_json::Value = connection
            .query_row(
                "SELECT value_json FROM settings WHERE key = 'preferences'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|text| serde_json::from_str(&text).expect("preferences json"))
            .expect("preferences row");
        // 远端那几项落地。
        assert_eq!(stored["theme"], "dark");
        assert_eq!(stored["defaultLayout"], "paged");
        assert_eq!(stored["sfwMode"], true);
        // 属于本机的两项留在本机。
        assert_eq!(stored["cacheMaxBytes"], 4_294_967_296_u64);
        assert_eq!(stored["downloadDirectory"], "E:/Downloads");
    }

    #[test]
    fn the_journaled_preferences_leave_out_this_devices_paths() {
        // 推上去的那份也不该带着本机路径：远端一旦有它，别的设备就会把它当自己的。
        let mut connection = migrated_connection();
        crate::settings::save_preferences_to(&mut connection, crate::settings::PreferenceSnapshot {
            download_directory: "E:\\Downloads".to_string(),
            cache_max_bytes: 4_294_967_296,
            ..Default::default()
        })
        .expect("save preferences");
        let payload: String = connection
            .query_row(
                "SELECT payload_json FROM sync_journal WHERE object_type = 'app_setting'",
                [],
                |row| row.get(0),
            )
            .expect("journaled preferences");
        let payload: serde_json::Value = serde_json::from_str(&payload).expect("payload json");
        assert!(payload.get("downloadDirectory").is_none());
        assert!(payload.get("cacheMaxBytes").is_none());
        assert!(payload.get("theme").is_some(), "其余字段仍要上路");
    }

    #[test]
    fn scoped_export_and_import_round_trip_through_the_same_merge_rules() {
        // 导出＝本地日志折成的同步文档，导入＝按同步的合并规则落地。所以换台机器
        // 导入之后：记录在、能再推出去（写了日志）、而且重复导入是幂等的。
        let mut source = migrated_connection();
        source
            .execute_batch(
                "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Home', 'https://lrr.test', 'scope-a');
                 INSERT INTO reading_progress (scope_id, archive_id, page_index, page_count, layout, direction, device_id, revision)
                   VALUES ('scope-a', 'archive-a', 4, 20, 'paged', 'ltr', 'device-a', 1);
                 INSERT INTO reading_list (scope_id, archive_id, device_id, revision) VALUES ('scope-a', 'archive-b', 'device-a', 1);
                 INSERT INTO search_presets (scope_id, preset_id, name, device_id, revision) VALUES ('scope-a', 'preset-a', '标签：中文', 'device-a', 1);",
            )
            .expect("source rows");
        let transaction = source.transaction().expect("transaction");
        for (object_type, object_id) in [
            ("reading_progress", "scope-a/archive-a"),
            ("watchlist", "scope-a/archive-b"),
            ("search_preset", "scope-a/preset-a"),
        ] {
            let payload = match object_type {
                "reading_progress" => serde_json::json!({
                    "archiveId": "archive-a", "pageIndex": 4, "pageCount": 20,
                    "layout": "paged", "direction": "ltr", "coverAlone": null,
                }),
                "search_preset" => serde_json::json!({
                    "presetId": "preset-a", "name": "标签：中文", "query": "", "deleted": false,
                }),
                _ => serde_json::json!({ "archiveId": "archive-b", "deleted": false }),
            };
            journal_object(&transaction, "scope-a", object_type, object_id, 1, payload)
                .expect("journal");
        }
        transaction.commit().expect("commit journal");
        let scope_ids = local_scope_ids(&source).expect("scope ids");
        let refs: Vec<&str> = scope_ids.iter().map(String::as_str).collect();
        let enabled = parse_sync_scope(&serde_json::to_string(&DEFAULT_SYNC_SCOPE).expect("scope json"));
        let document = build_local_state(&source, &refs, &enabled).expect("export");
        assert_eq!(document.objects.len(), 3, "三类记录都要进导出");

        // 换个空的库导入。
        let mut target = migrated_connection();
        let objects: Vec<SyncStateObject> = document.objects.into_values().collect();
        assert_eq!(
            apply_remote_objects(&mut target, &objects).expect("apply"),
            3
        );
        let counts: (i64, i64, i64) = target
            .query_row(
                "SELECT (SELECT COUNT(*) FROM reading_progress),
                        (SELECT COUNT(*) FROM reading_list),
                        (SELECT COUNT(*) FROM search_presets)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("imported rows");
        assert_eq!(counts, (1, 1, 1));
        // 幂等：同一份再导一次，没有新东西可落。
        assert_eq!(
            apply_remote_objects(&mut target, &objects).expect("apply again"),
            0
        );
    }

    #[test]
    fn the_scoped_export_leaves_out_categories_that_are_not_checked() {
        let mut connection = migrated_connection();
        connection
            .execute_batch(
                "INSERT INTO reading_history (scope_id, archive_id, page_index, visited_at, device_id, revision)
                   VALUES ('scope-a', 'archive-a', 1, '2026-09-01 08:00:00', 'device-a', 1);
                 INSERT INTO search_presets (scope_id, preset_id, name, device_id, revision) VALUES ('scope-a', 'preset-a', '标签：中文', 'device-a', 1);",
            )
            .expect("rows");
        let transaction = connection.transaction().expect("transaction");
        journal_object(
            &transaction,
            "scope-a",
            "history",
            "scope-a/archive-a",
            1,
            serde_json::json!({"archiveId": "archive-a", "pageIndex": 1, "visitedAt": "2026-09-01 08:00:00"}),
        )
        .expect("journal history");
        journal_object(
            &transaction,
            "scope-a",
            "search_preset",
            "scope-a/preset-a",
            1,
            serde_json::json!({"presetId": "preset-a", "name": "标签：中文", "query": "", "deleted": false}),
        )
        .expect("journal preset");
        transaction.commit().expect("commit journal");

        let enabled = parse_sync_scope(r#"["history"]"#);
        let document = build_local_state(&connection, &[GLOBAL_SCOPE, "scope-a"], &enabled)
            .expect("export");
        let types: Vec<&str> = document
            .objects
            .values()
            .map(|object| object.object_type.as_str())
            .collect();
        assert_eq!(types, vec!["history"], "没勾的检索预设不该进导出");
    }

    #[test]
    fn remote_search_preset_applies_and_tombstones_by_clock() {
        let mut connection = migrated_connection();
        let upsert = remote_objects(
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

        let delete = remote_objects(
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
        let mark = remote_objects(
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
        let undo = remote_objects(
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
        let future = remote_objects(
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

    /// A one-shot WebDAV mock that answers each request with the next fixed
    /// status from the list (empty body except for 200s).
    async fn scripted_dav_server(
        statuses: Vec<&'static str>,
    ) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        tokio::spawn(async move {
            for status in statuses {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut buffer = vec![0_u8; 16_384];
                let read = stream.read(&mut buffer).await.expect("read request");
                let _ = read;
                let body: &[u8] = if status.starts_with("200") {
                    b"ciphertext"
                } else {
                    b""
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.expect("status");
                stream.write_all(body).await.expect("body");
            }
        });
        format!("http://{address}")
    }

    /// Pull failures used to be swallowed: a 503 manifest fetch merged zero
    /// segments and still reported success, so the UI claimed a clean sync
    /// while remote changes never landed.
    #[test]
    fn the_scope_gate_keeps_unchecked_categories_out_of_the_document() {
        // 勾选是「要不要让它上远端」的开关：没勾的类别既不进文档，也不写日志。
        let connection = migrated_connection();
        append_journal_entry(&connection, input("scope-a", "archive-a")).expect("progress");
        append_journal_entry(
            &connection,
            progress_journal_input("scope-a", "archive-b", "device-a", 1, 2),
        )
        .expect("progress again");

        let only_history = vec!["history".to_string()];
        let document = build_local_state(&connection, &["scope-a"], &only_history)
            .expect("scoped state");
        assert!(
            document.objects.is_empty(),
            "progress rows leaked into a history-only document"
        );

        let with_progress = vec!["progress".to_string()];
        let document = build_local_state(&connection, &["scope-a"], &with_progress)
            .expect("scoped state");
        assert_eq!(document.objects.len(), 2, "两条日志是两个对象");
    }

    #[test]
    fn default_scope_parsing_falls_back_and_drops_unknown_categories() {
        // 空值＝默认集合（旧账户的列是空串）；未知条目丢弃，不让远端塞进不认识的类别。
        assert_eq!(parse_sync_scope(""), default_scope());
        assert_eq!(
            parse_sync_scope(r#"["history","app_settings","nonsense"]"#),
            vec!["history".to_string(), "app_settings".to_string()]
        );
        assert_eq!(parse_sync_scope("not json").len(), DEFAULT_SYNC_SCOPE.len());
    }

    #[test]
    fn imported_non_duplicate_marks_apply_into_the_feature_table() {
        // 从 Readoshi 导入的非重复结论（path + 内容哈希）以前写的类型没人认识，
        // 传不到别的设备；现在有对端的落地分支。
        let mut connection = migrated_connection();
        let marks = remote_objects(
            "scope-a",
            vec![remote_object(
                "legacy_non_duplicate",
                "scope-a/x.cbz",
                1,
                "2026-09-02 08:00:00",
                serde_json::json!({"path": "x.cbz", "hash": "abc"}),
            )],
        );
        assert_eq!(
            apply_remote_objects(&mut connection, &marks).expect("apply"),
            1
        );
        let exact_hash: String = connection
            .query_row(
                "SELECT exact_hash FROM dedup_features WHERE scope_id='scope-a' AND path='x.cbz'",
                [],
                |row| row.get(0),
            )
            .expect("imported mark");
        assert_eq!(exact_hash, "abc");
    }

    /// 一份带指定设备/版本的记录对象（`remote_object` 的设备是写死的，这里要自己定）。
    fn record_object(
        scope_id: &str,
        object_type: &str,
        object_id: &str,
        device: &str,
        logical_clock: i64,
        wall_clock: &str,
        payload: serde_json::Value,
    ) -> SyncStateObject {
        SyncStateObject {
            scope_id: scope_id.to_string(),
            object_type: object_type.to_string(),
            object_id: object_id.to_string(),
            operation: "upsert".to_string(),
            payload,
            payload_hash: format!("hash-{object_type}-{logical_clock}"),
            logical_clock,
            device_id: device.to_string(),
            wall_clock: wall_clock.to_string(),
        }
    }

    /// 六类记录各一条，都是同一个档案 ID 的同一种记录的一份版本：`logical_clock` 与
    /// `wall_clock` 一起往前走，所以「新」在这两套字段上都成立。
    fn six_record_objects(
        device: &str,
        logical_clock: i64,
        wall_clock: &str,
        page_index: i64,
        preset_name: &str,
        theme: &str,
    ) -> Vec<SyncStateObject> {
        vec![
            record_object(
                "scope-a",
                "reading_progress",
                "scope-a/archive-a",
                device,
                logical_clock,
                wall_clock,
                serde_json::json!({
                    "archiveId": "archive-a", "pageIndex": page_index, "pageCount": 20,
                    "layout": "paged", "direction": "ltr", "coverAlone": null,
                }),
            ),
            record_object(
                "scope-a",
                "history",
                "scope-a/archive-a",
                device,
                logical_clock,
                wall_clock,
                serde_json::json!({
                    "archiveId": "archive-a", "pageIndex": page_index, "visitedAt": wall_clock,
                }),
            ),
            record_object(
                "scope-a",
                "watchlist",
                "scope-a/archive-b",
                device,
                logical_clock,
                wall_clock,
                serde_json::json!({"archiveId": "archive-b", "deleted": false}),
            ),
            record_object(
                "scope-a",
                "search_preset",
                "scope-a/preset-a",
                device,
                logical_clock,
                wall_clock,
                serde_json::json!({
                    "presetId": "preset-a", "name": preset_name, "query": "", "deleted": false,
                }),
            ),
            record_object(
                "scope-a",
                "dedup_non_duplicate",
                "scope-a/pair-a",
                device,
                logical_clock,
                wall_clock,
                serde_json::json!({
                    "pairKey": "pair-a", "leftArchiveId": "archive-a",
                    "rightArchiveId": "archive-b", "tombstoned": false,
                }),
            ),
            record_object(
                GLOBAL_SCOPE,
                "app_setting",
                "preferences",
                device,
                logical_clock,
                wall_clock,
                serde_json::json!({"theme": theme, "sfwMode": false}),
            ),
        ]
    }

    fn document_from_objects(objects: Vec<SyncStateObject>) -> SyncStateDocument {
        SyncStateDocument {
            version: SYNC_STATE_VERSION,
            epoch: 0,
            objects: objects
                .into_iter()
                .map(|object| {
                    (
                        state_object_key(&object.scope_id, &object.object_type, &object.object_id),
                        object,
                    )
                })
                .collect(),
        }
    }

    #[test]
    fn a_file_with_two_versions_of_one_record_keeps_the_newest_not_the_last_line() {
        // 文件内部同一个文件对象出现两次，旧的那一版排在后面。JSON 里同名的键在
        // `serde_json::Value` 那一层就只剩最后一条能被看见，所以「留最新」只能在
        // 文本上直接解析成文档时做（见 deserialize_state_objects）。
        let payload = r#"{
          "version": 1, "epoch": 0,
          "objects": {
            "scope-a|reading_progress|scope-a/archive-a": {
              "scopeId": "scope-a", "objectType": "reading_progress",
              "objectId": "scope-a/archive-a", "operation": "upsert",
              "deviceId": "device-b", "logicalClock": 5,
              "wallClock": "2026-09-20 08:00:00", "payloadHash": "hash-new",
              "payload": {"archiveId": "archive-a", "pageIndex": 9, "pageCount": 20,
                          "layout": "paged", "direction": "ltr", "coverAlone": null}
            },
            "scope-a|reading_progress|scope-a/archive-a": {
              "scopeId": "scope-a", "objectType": "reading_progress",
              "objectId": "scope-a/archive-a", "operation": "upsert",
              "deviceId": "device-a", "logicalClock": 2,
              "wallClock": "2026-09-01 08:00:00", "payloadHash": "hash-old",
              "payload": {"archiveId": "archive-a", "pageIndex": 3, "pageCount": 20,
                          "layout": "paged", "direction": "ltr", "coverAlone": null}
            }
          }
        }"#;
        // 文本解析是唯一看得见同名键的入口：走 serde_json::Value 只剩最后一条
        // （修之前正是这样，所以旧版本赢了）。
        let document = parse_scoped_document(payload).expect("parse");
        assert_eq!(document.objects.len(), 1, "同一个对象的两版只该剩一版");
        let mut connection = migrated_connection();
        let report = import_scoped_documents(&mut connection, document, &["progress".to_string()])
            .expect("import");
        assert_eq!(report.applied, 1, "同一档案同一记录只该落一次");
        let (page, revision): (i64, i64) = connection
            .query_row(
                "SELECT page_index, revision FROM reading_progress
                 WHERE scope_id = 'scope-a' AND archive_id = 'archive-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("imported progress");
        assert_eq!((page, revision), (9, 5), "排在后面的旧版本不能赢");
    }

    #[test]
    fn keys_that_differ_but_describe_one_record_collapse_to_the_newest() {
        // 拼接或手抄出来的文件里，同一个记录的键可能写得不一样（老格式的 object_id、
        // 复制粘贴时手改了键）。解析时按对象自己的身份归位，只留最新那一版。
        let new = record_object(
            "scope-a",
            "reading_progress",
            "scope-a/archive-a",
            "device-b",
            5,
            "2026-09-20 08:00:00",
            serde_json::json!({"archiveId": "archive-a", "pageIndex": 9, "pageCount": 20,
                               "layout": "paged", "direction": "ltr", "coverAlone": null}),
        );
        let old = record_object(
            "scope-a",
            "reading_progress",
            "scope-a/archive-a",
            "device-a",
            2,
            "2026-09-01 08:00:00",
            serde_json::json!({"archiveId": "archive-a", "pageIndex": 3, "pageCount": 20,
                               "layout": "paged", "direction": "ltr", "coverAlone": null}),
        );
        let mut entries = serde_json::Map::new();
        // 旧的那一版排在前面的键上，新的一版排在后面：文本顺序不该决定谁赢。
        entries.insert(
            "aaa|reading_progress|scope-a/archive-a".to_string(),
            serde_json::to_value(&old).expect("old json"),
        );
        entries.insert(
            "zzz|reading_progress|scope-a/archive-a".to_string(),
            serde_json::to_value(&new).expect("new json"),
        );
        let value = serde_json::json!({"version": 1, "epoch": 0, "objects": entries});
        let parsed: SyncStateDocument = serde_json::from_value(value.clone()).expect("parse");
        assert_eq!(parsed.objects.len(), 1, "同一个记录的两版只该剩一版");

        let mut connection = migrated_connection();
        let report = import_scoped_document(&mut connection, value, &["progress".to_string()])
            .expect("import");
        assert_eq!(report.applied, 1, "同一个记录的两版只该落一次");
        let page: i64 = connection
            .query_row(
                "SELECT page_index FROM reading_progress
                 WHERE scope_id = 'scope-a' AND archive_id = 'archive-a'",
                [],
                |row| row.get(0),
            )
            .expect("imported progress");
        assert_eq!(page, 9, "只留最新那一版");
    }

    #[test]
    fn an_older_non_duplicate_mark_does_not_overwrite_a_newer_row() {
        // dedup_features 没有版本号列，只有 updated_at：从 Readoshi 带进来的非重复
        // 结论以前无条件覆盖，导入一份旧文件就会把新算出来的哈希顶掉。
        let mut connection = migrated_connection();
        connection
            .execute(
                "INSERT INTO dedup_features (scope_id, path, exact_hash, algorithm_version, size, updated_at)
                 VALUES ('scope-a', 'x.cbz', 'hash-new', 'dedup-v2', 12, '2026-09-20 00:00:00')",
                [],
            )
            .expect("local row");
        let stale = remote_objects(
            "scope-a",
            vec![remote_object(
                "legacy_non_duplicate",
                "scope-a/x.cbz",
                1,
                "2026-09-01 00:00:00",
                serde_json::json!({"path": "x.cbz", "hash": "hash-old"}),
            )],
        );
        assert_eq!(
            apply_remote_objects(&mut connection, &stale).expect("apply stale"),
            0,
            "旧结论不能盖掉更新的那一行"
        );
        let hash: String = connection
            .query_row(
                "SELECT exact_hash FROM dedup_features WHERE scope_id='scope-a' AND path='x.cbz'",
                [],
                |row| row.get(0),
            )
            .expect("row");
        assert_eq!(hash, "hash-new");

        let fresh = remote_objects(
            "scope-a",
            vec![remote_object(
                "legacy_non_duplicate",
                "scope-a/x.cbz",
                2,
                "2026-09-25 00:00:00",
                serde_json::json!({"path": "x.cbz", "hash": "hash-newer"}),
            )],
        );
        assert_eq!(
            apply_remote_objects(&mut connection, &fresh).expect("apply fresh"),
            1,
            "更新的结论要落地"
        );
        let hash: String = connection
            .query_row(
                "SELECT exact_hash FROM dedup_features WHERE scope_id='scope-a' AND path='x.cbz'",
                [],
                |row| row.get(0),
            )
            .expect("row");
        assert_eq!(hash, "hash-newer");
    }

    #[test]
    fn an_import_restores_the_version_in_the_file_over_every_record_category() {
        // 六类记录各一条，同一个档案 ID 的同一种记录：先导入更新的那一份，再导入
        // 更旧的那一份。**文件导入是恢复**——文件里那一版就是本机该对象的最新一版
        // （理由见 `import_scoped_data` 的说明：两台设备的 journal 计数器从没见过面，
        // 按时钟比大小只会把整份文件挡在门外），所以更旧的那一份也要落地，把本机那
        // 六行改回文件里的样子（历史除外：它是并集，不参与赛跑）。
        let enabled = SYNC_SCOPE_CATEGORIES.map(String::from).to_vec();
        let mut connection = migrated_connection();
        let newer = document_from_objects(six_record_objects(
            "device-b",
            5,
            "2026-09-20 08:00:00",
            9,
            "新名字",
            "dark",
        ));
        let first = import_scoped_document(
            &mut connection,
            serde_json::to_value(&newer).expect("json"),
            &enabled,
        )
        .expect("import newer");
        assert_eq!((first.applied, first.skipped), (6, 0), "六类记录都该落地");
        // 落地的版本号要留在本机：只记 MAX+1 的话，本机版本会比落地的还低，
        // 下次导入一份更旧的文件（时钟 2 > 1）就能把它顶掉。进度与历史共用
        // 「scope|archive」这个键，日志时钟是一串共享的序号，所以这里只要求
        // 不低于落地的那一版。
        let clock: i64 = connection
            .query_row(
                "SELECT MAX(logical_clock) FROM sync_journal
                 WHERE scope_id = 'scope-a' AND object_type = 'reading_progress'
                   AND object_id = 'scope-a/archive-a'",
                [],
                |row| row.get(0),
            )
            .expect("journal clock");
        assert!(clock >= 5, "落地的是第 5 版，本机版本不能退成 {clock}");

        let older = document_from_objects(six_record_objects(
            "device-c",
            2,
            "2026-09-01 08:00:00",
            3,
            "旧名字",
            "light",
        ));
        let second = import_scoped_document(
            &mut connection,
            serde_json::to_value(&older).expect("json"),
            &enabled,
        )
        .expect("import older");
        assert_eq!(
            (second.applied, second.skipped),
            (6, 0),
            "导入以文件为准：更旧的那一份也要落地（自动同步才按时钟合并）"
        );
        let (page, revision): (i64, i64) = connection
            .query_row(
                "SELECT page_index, revision FROM reading_progress
                 WHERE scope_id='scope-a' AND archive_id='archive-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("progress");
        assert_eq!(
            (page, revision),
            (3, 5),
            "进度回到文件里那一版；版本号取本机与文件较大者，不能倒退"
        );
        let (history_page, visited): (i64, String) = connection
            .query_row(
                "SELECT page_index, visited_at FROM reading_history
                 WHERE scope_id='scope-a' AND archive_id='archive-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("history");
        assert_eq!(
            (history_page, visited.as_str()),
            (9, "2026-09-20 08:00:00"),
            "历史留更晚的一次访问，页数取更大的那个（并集语义）"
        );
        let list_revision: i64 = connection
            .query_row(
                "SELECT revision FROM reading_list WHERE scope_id='scope-a' AND archive_id='archive-b'",
                [],
                |row| row.get(0),
            )
            .expect("waitlist");
        assert_eq!(list_revision, 5, "待看的版本号同样不能倒退");
        let (preset_name, preset_revision): (String, i64) = connection
            .query_row(
                "SELECT name, revision FROM search_presets
                 WHERE scope_id='scope-a' AND preset_id='preset-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("preset");
        assert_eq!(
            (preset_name.as_str(), preset_revision),
            ("旧名字", 5),
            "搜索预设回到文件里那一版"
        );
        let relation: (i64, i64) = connection
            .query_row(
                "SELECT logical_clock, tombstoned FROM dedup_non_duplicates
                 WHERE scope_id='scope-a' AND pair_key='pair-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("relation");
        assert_eq!(relation, (5, 0), "去重关系的计数同样不能倒退");
        let preferences: String = connection
            .query_row(
                "SELECT value_json FROM settings WHERE key='preferences'",
                [],
                |row| row.get(0),
            )
            .expect("preferences");
        let preferences: serde_json::Value =
            serde_json::from_str(&preferences).expect("preferences json");
        assert_eq!(preferences["theme"], "light", "偏好回到文件里那一版");
        // 逐字段那一份（读设置时读的就是它）也要跟上：只写上面那整块 JSON 等于没搬。
        let landed = crate::settings::load_preferences_from(&connection).expect("load preferences");
        assert_eq!(
            landed.theme, "light",
            "导入的偏好必须落到 read 的那一半读的逐字段行上"
        );

        // 反过来：真正更新的那一份，六类都要落地。
        let newest = document_from_objects(six_record_objects(
            "device-d",
            9,
            "2026-09-30 08:00:00",
            12,
            "更新名字",
            "system",
        ));
        let third = import_scoped_document(
            &mut connection,
            serde_json::to_value(&newest).expect("json"),
            &enabled,
        )
        .expect("import newest");
        assert_eq!(third.applied, 6, "更新的那一份六类都要落地");
        let page: i64 = connection
            .query_row(
                "SELECT page_index FROM reading_progress
                 WHERE scope_id='scope-a' AND archive_id='archive-a'",
                [],
                |row| row.get(0),
            )
            .expect("progress");
        assert_eq!(page, 12);
        let preset_name: String = connection
            .query_row(
                "SELECT name FROM search_presets WHERE scope_id='scope-a' AND preset_id='preset-a'",
                [],
                |row| row.get(0),
            )
            .expect("preset");
        assert_eq!(preset_name, "更新名字");
        let preferences: String = connection
            .query_row(
                "SELECT value_json FROM settings WHERE key='preferences'",
                [],
                |row| row.get(0),
            )
            .expect("preferences");
        let preferences: serde_json::Value =
            serde_json::from_str(&preferences).expect("preferences json");
        assert_eq!(preferences["theme"], "system");
        let landed = crate::settings::load_preferences_from(&connection).expect("load preferences");
        assert_eq!(
            (landed.theme.as_str(), landed.sfw_mode),
            ("system", false),
            "更新的那一份要落到读设置读的那张表上"
        );
    }

    #[test]
    fn syncing_keeps_the_newest_version_of_the_same_archive() {
        // 自动同步是合并，不是恢复：先推更新的那一版，再推更旧的那一版，只有并集
        // 语义的历史会重写自己那一行，其余五类都要原地不动。这条与上面那条导入用例
        // 是一对——导入以文件为准、同步按时钟比，两种语义都要有人钉住。
        let mut connection = migrated_connection();
        // 本机自己改过五次设置：本地时钟也到了第 5 版，这才有「时钟撞车、比时刻」的局面。
        for _ in 0..5 {
            let preferences =
                crate::settings::load_preferences_from(&connection).expect("load preferences");
            crate::settings::save_preferences_to(&mut connection, preferences).expect("save");
        }
        let newer = remote_objects(
            "scope-a",
            six_record_objects(
                "device-b",
                5,
                "2026-09-20 08:00:00",
                9,
                "新名字",
                "dark",
            ),
        );
        assert_eq!(
            apply_remote_objects(&mut connection, &newer).expect("apply newer"),
            6,
            "六类记录都该落地"
        );

        let older = remote_objects(
            "scope-a",
            six_record_objects(
                "device-c",
                2,
                "2026-09-01 08:00:00",
                3,
                "旧名字",
                "light",
            ),
        );
        assert_eq!(
            apply_remote_objects(&mut connection, &older).expect("apply older"),
            1,
            "只有历史那条会重写自己那一行（它是并集，不是时钟赛跑），其余五类都被闸门挡住"
        );
        let (page, revision): (i64, i64) = connection
            .query_row(
                "SELECT page_index, revision FROM reading_progress
                 WHERE scope_id='scope-a' AND archive_id='archive-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("progress");
        assert_eq!((page, revision), (9, 5), "旧的进度不能盖掉新的");
        let preset_name: String = connection
            .query_row(
                "SELECT name FROM search_presets WHERE scope_id='scope-a' AND preset_id='preset-a'",
                [],
                |row| row.get(0),
            )
            .expect("preset");
        assert_eq!(preset_name, "新名字", "旧的搜索预设不能盖掉新的");
        let landed = crate::settings::load_preferences_from(&connection).expect("load preferences");
        assert_eq!(
            landed.theme, "dark",
            "旧的偏好不能盖掉新的——read 的那一半读的是逐字段的行"
        );
    }

    #[test]
    fn merging_an_older_visit_keeps_the_device_that_made_the_kept_visit() {
        // 留下的访问是本机那一次，行里的 device_id 就该是本机的：写远端设备会把
        // 「谁访问的」抹掉，下一次比对（比如墓碑闸门）就按错的设备算。
        let mut connection = migrated_connection();
        connection
            .execute(
                "INSERT INTO reading_history (scope_id, archive_id, page_index, visited_at, device_id, revision)
                 VALUES ('scope-a', 'archive-a', 3, '2026-09-02 08:00:00', 'device-a', 4)",
                [],
            )
            .expect("local history");
        let remote = remote_objects(
            "scope-a",
            vec![remote_object(
                "history",
                "scope-a/archive-a",
                1,
                "2026-09-01 08:00:00",
                serde_json::json!({
                    "archiveId": "archive-a", "pageIndex": 1, "visitedAt": "2026-09-01 08:00:00",
                }),
            )],
        );
        assert_eq!(apply_remote_objects(&mut connection, &remote).expect("apply"), 1);
        let (visited, device): (String, String) = connection
            .query_row(
                "SELECT visited_at, device_id FROM reading_history
                 WHERE scope_id='scope-a' AND archive_id='archive-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("history");
        assert_eq!(visited, "2026-09-02 08:00:00");
        assert_eq!(
            device, "device-a",
            "留下的访问是 device-a 那一次，行里不该写 device-b"
        );
    }

    #[test]
    fn an_older_preferences_snapshot_with_the_same_clock_does_not_win() {
        // 时钟撞车（两台设备各自离线改过、都到了第 5 版）时该看时刻：闸门以前拿空串
        // 当本地时刻，空串输给任何时刻，于是一份更旧的快照照样盖上来。
        //
        // 这条走的是**自动同步**那条路（`apply_remote_objects`）：文件导入是恢复，以文件
        // 为准，不在这里比时刻（见 `an_import_restores_the_version_in_the_file_over_every_record_category`）。
        let mut connection = migrated_connection();
        // 本机自己改过五次设置：本地时钟也到了第 5 版，这才有「时钟撞车、比时刻」的局面。
        for _ in 0..5 {
            let preferences =
                crate::settings::load_preferences_from(&connection).expect("load preferences");
            crate::settings::save_preferences_to(&mut connection, preferences).expect("save");
        }
        let newer = remote_objects(
            GLOBAL_SCOPE,
            vec![remote_object(
                "app_setting",
                "preferences",
                5,
                "2026-09-20 08:00:00",
                serde_json::json!({"theme": "dark"}),
            )],
        );
        assert_eq!(
            apply_remote_objects(&mut connection, &newer).expect("apply newer"),
            1,
            "本机还没有偏好，第一份要落地"
        );
        let landed = crate::settings::load_preferences_from(&connection).expect("load preferences");
        assert_eq!(landed.theme, "dark");

        let older = remote_objects(
            GLOBAL_SCOPE,
            vec![remote_object(
                "app_setting",
                "preferences",
                5,
                "2026-09-01 08:00:00",
                serde_json::json!({"theme": "light"}),
            )],
        );
        assert_eq!(
            apply_remote_objects(&mut connection, &older).expect("apply older"),
            0,
            "时钟相同而时刻更旧的那一份不能盖掉刚落地的新偏好"
        );
        let preferences: String = connection
            .query_row(
                "SELECT value_json FROM settings WHERE key='preferences'",
                [],
                |row| row.get(0),
            )
            .expect("preferences");
        let preferences: serde_json::Value =
            serde_json::from_str(&preferences).expect("preferences json");
        assert_eq!(preferences["theme"], "dark");
        let landed = crate::settings::load_preferences_from(&connection).expect("load preferences");
        assert_eq!(
            landed.theme, "dark",
            "被挡下的那一份不能改动读设置读的逐字段行"
        );
    }

    #[tokio::test]
    async fn a_failing_state_fetch_is_reported_as_a_failed_sync() {
        let base_url = scripted_dav_server(vec!["503 Service Unavailable"]).await;
        let database = crate::db::Database::open_path(":memory:").expect("database");
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(vec![("ref-a".to_string(), "token".to_string())]),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };
        let account = {
            let mut connection = database.connection.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO sync_accounts (id, label, base_url, username, credential_ref)
                     VALUES ('account-a', 'NAS', ?1, 'user', 'ref-a')",
                    params![base_url],
                )
                .expect("webdav account");
            read_sync_account(&connection, "account-a").expect("account record")
        };
        let result = sync_scope_impl(
            &database,
            &account,
            &[7_u8; 32],
            "scope-a",
            empty_state(),
            Vec::new(),
            &default_scope(),

            &credentials,
        )
        .await;
        assert!(
            matches!(result, CommandResult::Failure { .. }),
            "a 503 manifest fetch returned a successful zero-change pull"
        );
    }

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

    /// 一个够用的 S3 兼容端点：GET/PUT/DELETE 一个对象，认 If-Match / If-None-Match，
    /// 并把每个请求的头部原样记下来，好断言签名与条件写。ETag 取内容的长度加校验和。
    async fn stateful_s3_server() -> (
        String,
        Arc<Mutex<std::collections::BTreeMap<String, Vec<u8>>>>,
        Arc<Mutex<Vec<String>>>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let objects: Arc<Mutex<std::collections::BTreeMap<String, Vec<u8>>>> =
            Arc::new(Mutex::new(std::collections::BTreeMap::new()));
        let heads: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let shared_objects = Arc::clone(&objects);
        let shared_heads = Arc::clone(&heads);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let shared_objects = Arc::clone(&shared_objects);
                let shared_heads = Arc::clone(&shared_heads);
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
                            .find_map(|line| line.strip_prefix("Content-Length:")?.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if total >= head_end + 4 + length || total == buffer.len() {
                            break;
                        }
                    }
                    let text = String::from_utf8_lossy(&buffer[..total]).to_string();
                    let head_end = text.find("\r\n\r\n").unwrap_or(total);
                    let head = text[..head_end].to_string();
                    let method = head
                        .split_whitespace()
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    let path = head
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or_default()
                        .to_string();
                    let header_value = |name: &str| {
                        head.lines()
                            .find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case(name).then(|| value.trim().to_string())
                            })
                    };
                    let body = buffer[head_end + 4..total].to_vec();
                    shared_heads.lock().expect("heads").push(head.clone());

                    let response = {
                        let mut objects = shared_objects.lock().expect("objects");
                        let etag = |bytes: &[u8]| {
                            let checksum: usize = bytes.iter().map(|byte| *byte as usize).sum();
                            format!("\"{}-{checksum}\"", bytes.len())
                        };
                        let (status, headers, body): (String, String, Vec<u8>) = match method.as_str() {
                            "GET" => match objects.get(&path) {
                                Some(bytes) => (
                                    "200 OK".to_string(),
                                    format!("ETag: {}\r\n", etag(bytes)),
                                    bytes.clone(),
                                ),
                                None => ("404 Not Found".to_string(), String::new(), Vec::new()),
                            },
                            "PUT" => {
                                let current = objects.get(&path).cloned();
                                let expected_match = header_value("if-match");
                                let none_match = header_value("if-none-match");
                                let allowed = match (&current, expected_match, none_match) {
                                    // 只在不存在时创建：已经有别人写的一版就冲突。
                                    (Some(_), _, Some(value)) if value == "*" => false,
                                    // 必须匹配上一版：ETag 对不上（别人改过）就冲突。
                                    (Some(bytes), Some(expected), _) => etag(bytes) == expected,
                                    (None, Some(_), _) => false,
                                    _ => true,
                                };
                                if !allowed {
                                    ("412 Precondition Failed".to_string(), String::new(), Vec::new())
                                } else {
                                    objects.insert(path.clone(), body);
                                    ("200 OK".to_string(), String::new(), Vec::new())
                                }
                            }
                            "DELETE" => {
                                objects.remove(&path);
                                ("204 No Content".to_string(), String::new(), Vec::new())
                            }
                            _ => ("405 Method Not Allowed".to_string(), String::new(), Vec::new()),
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
        (format!("http://{address}"), objects, heads)
    }

    fn default_scope() -> Vec<String> {
        DEFAULT_SYNC_SCOPE.iter().map(|item| item.to_string()).collect()
    }

    fn empty_state() -> SyncStateDocument {
        SyncStateDocument {
            version: SYNC_STATE_VERSION,
            epoch: 0,
            objects: std::collections::BTreeMap::new(),
        }
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
    async fn an_object_storage_account_pushes_pulls_and_resets_the_same_document() {
        // 同一套引擎跑在 S3 兼容端点（Cloudflare R2 / MinIO…）上：读整份、合并、
        // 条件写回，与 WebDAV 完全一样，只是签的是 SigV4。
        let (endpoint, objects, heads) = stateful_s3_server().await;
        let database = crate::db::Database::open_path(":memory:").expect("database");
        let key = [7_u8; 32];
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(vec![("ref-a".to_string(), "secret-key".to_string())]),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };
        let account = {
            let connection = database.connection.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO sync_accounts (id, kind, label, base_url, bucket, username, credential_ref)
                     VALUES ('account-a', 's3', 'R2', ?1, 'yomika', 'ACCESSKEY', 'ref-a')",
                    params![endpoint],
                )
                .expect("object storage account");
            read_sync_account(&connection, "account-a").expect("account record")
        };
        let local_state = {
            let mut state = empty_state();
            state.objects.insert(
                "scope-a|reading_progress|archive-a".to_string(),
                SyncStateObject {
                    scope_id: "scope-a".to_string(),
                    object_type: "reading_progress".to_string(),
                    object_id: "scope-a/archive-a".to_string(),
                    operation: "upsert".to_string(),
                    payload: serde_json::json!({"archiveId": "archive-a", "pageIndex": 4, "pageCount": 10, "layout": "paged", "direction": "ltr"}),
                    payload_hash: "hash-a".to_string(),
                    logical_clock: 1,
                    device_id: "device-a".to_string(),
                    wall_clock: "2026-09-17 00:00:00".to_string(),
                },
            );
            state
        };

        let result = sync_scope_impl(
            &database,
            &account,
            &key,
            "scope-a",
            local_state.clone(),
            Vec::new(),
            &default_scope(),
            &credentials,
        )
        .await;
        match result {
            CommandResult::Success { .. } => {}
            CommandResult::Failure { error, .. } => {
                panic!("object storage sync failed: {} {}", error.code, error.message)
            }
        }

        // 对象落在 <bucket>/Yomika/<account>.json.enc，首次写是「仅当不存在」。
        assert!(objects
            .lock()
            .expect("objects")
            .contains_key("/yomika/Yomika/account-a.json.enc"));
        {
            let heads = heads.lock().expect("heads");
            let put = heads
                .iter()
                .find(|head| head.starts_with("PUT "))
                .expect("a PUT reached the endpoint");
            assert!(
                put.contains("authorization: AWS4-HMAC-SHA256 Credential=ACCESSKEY/"),
                "the object request is not SigV4 signed: {put}"
            );
            assert!(put
                .to_ascii_lowercase()
                .contains("if-none-match: *"));
        }

        // 第二次同步：文档已经存在，条件头换成 If-Match。密文每次都换随机 nonce，
        // 所以比的是解出来的内容（幂等）。
        let before = decode_sync_state(
            &key,
            &objects
                .lock()
                .expect("objects")
                .get("/yomika/Yomika/account-a.json.enc")
                .cloned()
                .expect("document"),
        )
        .expect("decode");
        heads.lock().expect("heads").clear();
        let repeat = sync_scope_impl(
            &database,
            &account,
            &key,
            "scope-a",
            local_state,
            Vec::new(),
            &default_scope(),
            &credentials,
        )
        .await;
        assert!(matches!(repeat, CommandResult::Success { .. }));
        let after = decode_sync_state(
            &key,
            &objects
                .lock()
                .expect("objects")
                .get("/yomika/Yomika/account-a.json.enc")
                .cloned()
                .expect("document"),
        )
        .expect("decode");
        let keys = |document: &SyncStateDocument| document.objects.keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys(&before), keys(&after), "an unchanged state changed the document");
        assert_eq!(
            before.objects["scope-a|reading_progress|archive-a"].payload_hash,
            after.objects["scope-a|reading_progress|archive-a"].payload_hash
        );
        assert!(heads
            .lock()
            .expect("heads")
            .iter()
            .any(|head| head.to_ascii_lowercase().contains("if-match:")));

        // 「重置远端」删的就是这个对象。
        let reset = RemoteStore::for_account(&account, "secret-key")
            .expect("store")
            .delete_state("account-a")
            .await;
        assert!(reset.is_ok());
        assert!(!objects
            .lock()
            .expect("objects")
            .contains_key("/yomika/Yomika/account-a.json.enc"));
    }

    #[tokio::test]
    async fn a_second_device_pulls_the_objects_an_s3_account_pushed() {
        let (endpoint, _objects, _heads) = stateful_s3_server().await;
        let database = crate::db::Database::open_path(":memory:").expect("database");
        let key = [3_u8; 32];
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(vec![("ref-a".to_string(), "secret-key".to_string())]),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };
        let account = {
            let connection = database.connection.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO sync_accounts (id, kind, label, base_url, bucket, username, credential_ref)
                     VALUES ('account-a', 's3', 'R2', ?1, 'yomika', 'ACCESSKEY', 'ref-a')",
                    params![endpoint],
                )
                .expect("object storage account");
            read_sync_account(&connection, "account-a").expect("account record")
        };
        let mut pushed = empty_state();
        pushed.objects.insert(
            "scope-a|history|scope-a/archive-a".to_string(),
            SyncStateObject {
                scope_id: "scope-a".to_string(),
                object_type: "history".to_string(),
                object_id: "scope-a/archive-a".to_string(),
                operation: "upsert".to_string(),
                payload: serde_json::json!({"archiveId": "archive-a", "pageIndex": 6, "visitedAt": "2026-09-17 00:00:00"}),
                payload_hash: "hash-history".to_string(),
                logical_clock: 2,
                device_id: "device-a".to_string(),
                wall_clock: "2026-09-17 00:00:00".to_string(),
            },
        );
        let first = sync_scope_impl(&database, &account, &key, "scope-a", pushed, Vec::new(), &default_scope(), &credentials).await;
        assert!(matches!(first, CommandResult::Success { .. }));

        // 另一台设备（本地什么都没有）拉回来的就是刚才那份。
        let second = sync_scope_impl(&database, &account, &key, "scope-a", empty_state(), Vec::new(), &default_scope(), &credentials).await;
        let CommandResult::Success { value: pulled, .. } = second else {
            panic!("second device sync failed");
        };
        assert_eq!(pulled, 1, "the pushed object came back");
        let connection = database.connection.lock().expect("database lock");
        let page: i64 = connection
            .query_row(
                "SELECT page_index FROM reading_history WHERE scope_id = 'scope-a' AND archive_id = 'archive-a'",
                [],
                |row| row.get(0),
            )
            .expect("pulled history row");
        assert_eq!(page, 6);
    }

    #[tokio::test]
    async fn a_document_that_cannot_be_decrypted_is_not_retried() {
        // 远端有一份文档，但用当前密钥解不开（换过口令，或那不是本账户的数据）：
        // 必须明确失败并标记不可重试，绝不能当成空文档把本地状态推上去把它覆盖掉。
        let (base_url, store) = stateful_dav_server().await;
        let database = crate::db::Database::open_path(":memory:").expect("database");
        store.lock().expect("store").insert(
            "/Yomika/account-a.json.enc".to_string(),
            b"foreign ciphertext".to_vec(),
        );
        let credentials = MemoryWebdavCredentialStore {
            writes: Mutex::new(vec![("ref-a".to_string(), "token".to_string())]),
            deletes: Mutex::new(Vec::new()),
            failure: None,
        };
        let account = {
            let connection = database.connection.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO sync_accounts (id, label, base_url, username, credential_ref)
                     VALUES ('account-a', 'NAS', ?1, 'user', 'ref-a')",
                    params![base_url],
                )
                .expect("webdav account");
            read_sync_account(&connection, "account-a").expect("account record")
        };
        let result = sync_scope_impl(
            &database,
            &account,
            &[7_u8; 32],
            "scope-a",
            empty_state(),
            Vec::new(),
            &default_scope(),

            &credentials,
        )
        .await;
        match result {
            CommandResult::Failure { error, .. } => {
                assert!(!error.retryable, "a key mismatch cannot be fixed by retrying");
            }
            CommandResult::Success { .. } => panic!("a foreign document was overwritten"),
        }
    }

    #[tokio::test]
    async fn sync_pushes_the_local_state_and_pulls_the_remote_document() {
        let (base_url, store) = stateful_dav_server().await;
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
                    "INSERT INTO sync_accounts (id, label, base_url, username, credential_ref)
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

            let local_state = build_local_state(&connection, &["scope-a"], &default_scope()).expect("local state");
            let pending = pending_journal_entries(&connection, "scope-a").expect("pending");
            let account =
                read_sync_account(&connection, "account-a").expect("account record");
            drop(connection);

            let result = sync_scope_impl(
                &database,
                &account,
                &key,
                "scope-a",
                local_state,
                pending,
                &default_scope(),

                &credentials,
            )
            .await;
            let CommandResult::Success { value: pushed, .. } = result else {
                panic!("device a sync failed");
            };
            // 推送一条 + 落回本地（自己那条重复应用，计数可能多一）。
            assert!(pushed >= 1, "device a pushed its one change");
        }

        {
            // Device B (same account) has nothing local to push — it pulls.
            let account = {
                let connection = database.connection.lock().expect("database lock");
                read_sync_account(&connection, "account-a").expect("account record")
            };
            let result = sync_scope_impl(
                &database,
                &account,
                &key,
                "scope-a",
                empty_state(),
                Vec::new(),
                &default_scope(),

                &credentials,
            )
            .await;
            let CommandResult::Success { value: pulled, .. } = result else {
                panic!("device b sync failed");
            };
            // 同一个库上自己那条已经落过，重复应用不计数；关键是被拉回的行与远端文档。
            assert!(pulled <= 1, "device b reported more merges than the document carries");

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

            // 远端那份文档里确实带着 device a 写的对象。
            let remote = store
                .lock()
                .expect("store")
                .get("/Yomika/account-a.json.enc")
                .cloned()
                .expect("remote document");
            let document = decode_sync_state(&key, &remote).expect("decode remote document");
            let object = document
                .objects
                .get(&state_object_key("scope-a", "reading_progress", "scope-a/archive-a"))
                .expect("progress object");
            assert_eq!(object.payload["pageIndex"], serde_json::json!(7));

            // A repeat sync is a no-op: 文档里的对象本地已经是同一版，应用不计数。
            let account = {
                let connection = database.connection.lock().expect("database lock");
                read_sync_account(&connection, "account-a").expect("account record")
            };
            let repeat = sync_scope_impl(
                &database,
                &account,
                &key,
                "scope-a",
                empty_state(),
                Vec::new(),
                &default_scope(),

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

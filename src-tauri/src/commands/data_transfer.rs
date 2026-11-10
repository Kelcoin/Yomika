//! Explicit portable backups read authoritative tables and restore selected records atomically.
//! The versioned file shape stays compatible with prior exports. No cloud queue or network transport.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::{db::Database, domain::result::CommandResult};
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct RecordObject {
    scope_id: String,
    object_type: String,
    object_id: String,
    operation: String,
    payload: serde_json::Value,
    payload_hash: String,
    logical_clock: i64,
    device_id: String,
    wall_clock: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordDocument {
    version: i64,
    epoch: i64,
    #[serde(deserialize_with = "deserialize_state_objects")]
    objects: std::collections::BTreeMap<String, RecordObject>,
}

const RECORD_VERSION: i64 = 1;

const GLOBAL_SCOPE: &str = "__global__";
pub(crate) fn object_type_category(object_type: &str) -> Option<&'static str> {
    match object_type {
        "reading_progress" => Some("progress"),
        "history" => Some("history"),
        "watchlist" => Some("watchlist"),
        "search_preset" => Some("search_presets"),
        "dedup_non_duplicate" | "legacy_non_duplicate" => Some("dedup"),
        "app_setting" => Some("app_settings"),
        "reading_list" => Some("watchlist"),
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
fn fresher_state_object(candidate: &RecordObject, existing: &RecordObject) -> bool {
    if record_version_wins(
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
fn deserialize_state_objects<'de, D>(
    deserializer: D,
) -> Result<std::collections::BTreeMap<String, RecordObject>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::MapAccess;

    struct StateObjects;

    impl<'de> serde::de::Visitor<'de> for StateObjects {
        type Value = std::collections::BTreeMap<String, RecordObject>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("按 scope_id|object_type|object_id 索引的备份记录表")
        }

        fn visit_map<A>(self, mut entries: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut folded: std::collections::BTreeMap<String, (String, RecordObject)> =
                std::collections::BTreeMap::new();
            while let Some((key, object)) = entries.next_entry::<String, RecordObject>()? {
                let identity =
                    state_object_key(&object.scope_id, &object.object_type, &object.object_id);
                match folded.get_mut(&identity) {
                    Some((kept_key, kept)) => {
                        if fresher_state_object(&object, kept) {
                            *kept = object;
                            *kept_key = key;
                        } else if !fresher_state_object(kept, &object) && key < *kept_key {
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
fn restore_app_setting(
    transaction: &rusqlite::Transaction<'_>,
    object: &RecordObject,
    payload: &serde_json::Value,
) -> Result<bool, String> {
    let stored: Option<(String, String)> = transaction
        .query_row(
            "SELECT value_json, updated_at FROM settings WHERE key = 'preferences'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let local: serde_json::Value = stored
        .as_ref()
        .map(|(value, _)| value.as_str())
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or(serde_json::Value::Null);
    let mut merged = local.as_object().cloned().unwrap_or_default();
    if let Some(imported) = payload.as_object() {
        for (key, value) in imported {
            if crate::settings::DEVICE_LOCAL_PREFERENCE_KEYS.contains(&key.as_str()) {
                continue;
            }
            merged.insert(key.clone(), value.clone());
        }
    }
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
fn restore_legacy_non_duplicate(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &RecordObject,
    payload: &serde_json::Value,
) -> Result<bool, String> {
    let path = payload_text(payload, "path")?;
    let exact_hash = payload_text(payload, "hash")?;
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
fn record_version_wins(
    local_clock: i64,
    local_updated: &str,
    local_device: &str,
    imported_clock: i64,
    imported_updated: &str,
    imported_device: &str,
) -> bool {
    match imported_clock.cmp(&local_clock) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Equal => match compare_instants(imported_updated, local_updated) {
            std::cmp::Ordering::Greater => true,
            std::cmp::Ordering::Equal => imported_device > local_device,
            std::cmp::Ordering::Less => false,
        },
        std::cmp::Ordering::Less => false,
    }
}
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
fn remember_progress_candidate(
    target: &mut Vec<(String, String)>,
    scope_id: &str,
    object: &RecordObject,
) {
    if object.object_type != "reading_progress" {
        return;
    }
    let Ok(archive_id) = payload_text(&object.payload, "archiveId") else {
        return;
    };
    let candidate = (scope_id.to_string(), archive_id);
    if !target.contains(&candidate) {
        target.push(candidate);
    }
}
fn reconcile_progress_completion(
    transaction: &rusqlite::Transaction<'_>,
    candidates: &[(String, String)],
) -> Result<(), String> {
    for (scope_id, archive_id) in candidates {
        let effective: Option<(i64, i64)> = transaction
            .query_row(
                "SELECT page_index, page_count FROM reading_progress
                 WHERE scope_id = ?1 AND archive_id = ?2",
                params![scope_id, archive_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((page_index, page_count)) = effective else {
            continue;
        };
        if !crate::commands::library::progress_finishes_archive(page_index, page_count) {
            continue;
        }
        let listed: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM reading_list
                 WHERE scope_id = ?1 AND archive_id = ?2 AND deleted_at IS NULL)",
                params![scope_id, archive_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if listed {
            crate::commands::library::write_reading_list_entry(
                transaction, scope_id, archive_id, false,
            )?;
        }
    }
    Ok(())
}
fn restore_object(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &RecordObject,
) -> Result<bool, String> {
    if object_type_category(&object.object_type) != Some("app_settings") && super::lrr_bridge::enabled(transaction, scope_id) { return Err("此服务器的数据由插件托管，请先关闭托管再导入本地记录".into()); }
    match object.object_type.as_str() {
        "reading_progress" => {
            restore_progress(transaction, scope_id, object, &object.payload)
        }
        "history" => {
            restore_history(transaction, scope_id, object, &object.payload)
        }
        "watchlist" => {
            restore_list_entry(transaction, scope_id, object, &object.payload)
        }
        "reading_list" => {
            restore_list_entry(transaction, scope_id, object, &object.payload)
        }
        "search_preset" => {
            restore_search_preset(transaction, scope_id, object, &object.payload)
        }
        "app_setting" => restore_app_setting(transaction, object, &object.payload),
        "legacy_non_duplicate" => {
            restore_legacy_non_duplicate(transaction, scope_id, object, &object.payload)
        }
        "dedup_non_duplicate" => {
            restore_dedup_relation(transaction, scope_id, object, &object.payload)
        }
        _ => Ok(false),
    }
}
fn payload_text(payload: &serde_json::Value, field: &str) -> Result<String, String> {
    payload
        .get(field)
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("Imported record payload is missing {field}"))
}
fn payload_bool(payload: &serde_json::Value, field: &str) -> Result<bool, String> {
    payload
        .get(field)
        .and_then(|value| value.as_bool())
        .ok_or_else(|| format!("Imported record payload is missing {field}"))
}
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
fn apply_reading_reset(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &RecordObject,
    payload: &serde_json::Value,
) -> Result<Option<bool>, String> {
    let archive_id = payload_text(payload, "archiveId")?;
    let deleted = object.operation == "delete" || payload_bool(payload, "deleted").unwrap_or(false);
    if !deleted {
        return Ok(None);
    }
    let table = if object.object_type == "history" {
        "reading_history"
    } else {
        "reading_progress"
    };
    transaction
        .execute(
            &format!("DELETE FROM {table} WHERE scope_id=?1 AND archive_id=?2"),
            params![scope_id, archive_id],
        )
        .map_err(|error| error.to_string())?;
    if table == "reading_progress" {
        transaction.execute("INSERT OR IGNORE INTO reading_resets(scope_id,archive_id) VALUES(?1,?2)",params![scope_id,archive_id]).map_err(|e|e.to_string())?;
    }
    Ok(Some(true))
}
fn restore_progress(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &RecordObject,
    payload: &serde_json::Value,
) -> Result<bool, String> {
    if let Some(applied) = apply_reading_reset(transaction, scope_id, object, payload)? { return Ok(applied); }
    let archive_id = payload_text(payload, "archiveId")?;
    let page_index = payload
        .get("pageIndex")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| "Imported progress payload is missing pageIndex".to_string())?;
    let page_count = payload
        .get("pageCount")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| "Imported progress payload is missing pageCount".to_string())?;
    let layout = payload_text(payload, "layout")?;
    let direction = payload_text(payload, "direction")?;
    let cover_alone = payload.get("coverAlone").and_then(|value| value.as_bool());
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
fn restore_history(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &RecordObject,
    payload: &serde_json::Value,
) -> Result<bool, String> {
    if payload.get("clearProgress").and_then(|value| value.as_bool()).unwrap_or(false)
        || !(object.operation == "delete" || payload_bool(payload, "deleted").unwrap_or(false)) {
        if let Some(applied) = apply_reading_reset(transaction, scope_id, object, payload)? { return Ok(applied); }
    }
    let archive_id = payload_text(payload, "archiveId")?;
    if object.operation == "delete" || payload_bool(payload, "deleted").unwrap_or(false) {
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
        .ok_or_else(|| "Imported history payload is missing pageIndex".to_string())?;
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
    let keep_imported_visit = compare_instants(&visited_at, &local_visit) == std::cmp::Ordering::Greater;
    let next_visit = if keep_imported_visit {
        visited_at
    } else {
        local_visit
    };
    let next_device = if keep_imported_visit {
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
fn restore_list_entry(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &RecordObject,
    payload: &serde_json::Value,
) -> Result<bool, String> {
    let table = "reading_list";
    let archive_id = payload_text(payload, "archiveId")?;
    let deleted = payload_bool(payload, "deleted")?;
    let local = local_row_state(transaction, table, scope_id, &archive_id)?;
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
fn restore_search_preset(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &RecordObject,
    payload: &serde_json::Value,
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
fn restore_dedup_relation(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    object: &RecordObject,
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
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopedDataExport {
    kind: String,
    schema_version: i64,
    exported_at: String,
    categories: Vec<String>,
    pub(crate) document: RecordDocument,
}

const SCOPED_EXPORT_KIND: &str = "yomika-scope-export";
const SCOPED_EXPORT_VERSION: i64 = 1;


// Read the current records directly, so file backups never depend on a background queue.
fn build_local_state(connection: &Connection, enabled: &[String]) -> Result<RecordDocument, String> {
    let mut objects = std::collections::BTreeMap::new();
    let queries = [
        ("reading_progress", "SELECT scope_id, archive_id, 1, '', '', json_object('archiveId',archive_id,'deleted',json('true'),'clearProgress',json('true')) FROM reading_resets r WHERE NOT EXISTS(SELECT 1 FROM reading_progress p WHERE p.scope_id=r.scope_id AND p.archive_id=r.archive_id)"),
        ("reading_progress", "SELECT scope_id, archive_id, revision, COALESCE(device_id,''), updated_at, json_object('archiveId',archive_id,'pageIndex',page_index,'pageCount',page_count,'layout',layout,'direction',direction,'coverAlone',json(CASE WHEN cover_alone IS NULL THEN 'null' WHEN cover_alone THEN 'true' ELSE 'false' END)) FROM reading_progress"),
        ("history", "SELECT scope_id, archive_id, revision, COALESCE(device_id,''), visited_at, json_object('archiveId',archive_id,'pageIndex',page_index,'visitedAt',visited_at) FROM reading_history"),
        ("watchlist", "SELECT scope_id, archive_id, revision, COALESCE(device_id,''), updated_at, json_object('archiveId',archive_id,'deleted',json(CASE WHEN deleted_at IS NULL THEN 'false' ELSE 'true' END)) FROM reading_list"),
        ("search_preset", "SELECT scope_id, preset_id, revision, device_id, updated_at, json_object('presetId',preset_id,'name',name,'query',query,'sortBy',sort_by,'sortOrder',sort_order,'categoryId',category_id,'deleted',json(CASE WHEN deleted_at IS NULL THEN 'false' ELSE 'true' END)) FROM search_presets"),
        ("dedup_non_duplicate", "SELECT scope_id, pair_key, logical_clock, '', updated_at, json_object('pairKey',pair_key,'leftArchiveId',left_archive_id,'rightArchiveId',right_archive_id,'tombstoned',json(CASE WHEN tombstoned THEN 'true' ELSE 'false' END)) FROM dedup_non_duplicates"),
        ("legacy_non_duplicate", "SELECT scope_id, path, 1, '', updated_at, json_object('path',path,'hash',exact_hash) FROM dedup_features WHERE algorithm_version='legacy-import'"),
    ];
    for (object_type, query) in queries {
        if !scope_includes(enabled, object_type) { continue; }
        let mut statement = connection.prepare(query).map_err(|e| e.to_string())?;
        let rows = statement.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?))).map_err(|e| e.to_string())?;
        for row in rows {
            let (scope_id, id, clock, device_id, wall_clock, json) = row.map_err(|e| e.to_string())?;
            let object_id = format!("{scope_id}/{id}");
            let payload = serde_json::from_str(&json).map_err(|e| format!("Invalid stored record: {e}"))?;
            let object = RecordObject { scope_id: scope_id.clone(), object_type: object_type.into(), object_id: object_id.clone(), operation: "upsert".into(), payload, payload_hash: blake3::hash(json.as_bytes()).to_hex().to_string(), logical_clock: clock.max(1), device_id, wall_clock };
            objects.insert(state_object_key(&scope_id, object_type, &object_id), object);
        }
    }
    if scope_includes(enabled, "app_setting") {
        let mut payload = serde_json::to_value(crate::settings::load_preferences_from(connection)?).map_err(|e| e.to_string())?;
        if let Some(fields) = payload.as_object_mut() { fields.retain(|key,_| !crate::settings::DEVICE_LOCAL_PREFERENCE_KEYS.contains(&key.as_str())); }
        let object = RecordObject { scope_id: GLOBAL_SCOPE.into(), object_type: "app_setting".into(), object_id: "preferences".into(), operation: "upsert".into(), payload_hash: blake3::hash(payload.to_string().as_bytes()).to_hex().to_string(), payload, logical_clock: 1, device_id: String::new(), wall_clock: String::new() };
        objects.insert(state_object_key(GLOBAL_SCOPE, "app_setting", "preferences"), object);
    }
    Ok(RecordDocument { version: RECORD_VERSION, epoch: 0, objects })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedExportReport {
    pub text: String,
    pub objects: usize,
    pub categories: Vec<String>,
}

pub(crate) fn export_scoped_document(
    connection: &Connection,
    categories: &[String],
) -> Result<(serde_json::Value, usize), String> {
    let enabled: Vec<String> = categories
        .iter()
        .filter(|category| crate::data_transfer::RECORD_CATEGORIES.contains(&category.as_str()))
        .cloned()
        .collect();
    let document = build_local_state(connection, &enabled)?;
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

#[tauri::command(async)]
pub fn export_scoped_data(
    categories: String,
    database: State<'_, Database>,
) -> CommandResult<ScopedExportReport> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    let enabled = crate::data_transfer::parse_record_categories(&categories);
    let document = match build_local_state(&connection, &enabled) {
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedImportReport {
    pub applied: usize,
    pub skipped: usize,
    pub categories: Vec<String>,
}

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
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    let enabled = crate::data_transfer::parse_record_categories(&categories);
    match import_scoped_documents(&mut connection, document, &enabled) {
        Ok(report) => CommandResult::success(report),
        Err(error) => CommandResult::failure("INVALID_INPUT", error, false),
    }
}

pub(crate) fn parse_scoped_document(payload: &str) -> Result<RecordDocument, String> {
    if let Ok(document) = serde_json::from_str::<RecordDocument>(payload) {
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

pub(crate) fn import_scoped_document(
    connection: &mut Connection,
    value: serde_json::Value,
    enabled: &[String],
) -> Result<ScopedImportReport, String> {
    let document: RecordDocument = match serde_json::from_value(value.clone()) {
        Ok(document) => document,
        Err(_) => match value.get("document") {
            Some(inner) => serde_json::from_value(inner.clone())
                .map_err(|error| format!("导入内容的 document 结构不对：{error}"))?,
            None => return Err(String::from("导入内容里没有 objects（不是本应用导出的数据）")),
        },
    };
    import_scoped_documents(connection, document, enabled)
}

pub(crate) fn import_scoped_documents(
    connection: &mut Connection,
    document: RecordDocument,
    enabled: &[String],
) -> Result<ScopedImportReport, String> {
    if document.version > RECORD_VERSION { return Err("不支持的记录文件版本，请升级应用".into()); }
    let objects: Vec<RecordObject> = document.objects.into_values().collect();
    let outcome = (|| -> Result<(usize, usize), String> {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let mut applied = 0;
        let mut skipped = 0;
        let mut progressed: Vec<(String, String)> = Vec::new();
        for object in &objects {
            if !scope_includes(&enabled, &object.object_type) {
                skipped += 1;
                continue;
            }
            if !restore_object(&transaction, &object.scope_id, object)? {
                skipped += 1;
                continue;
            }
            applied += 1;
            remember_progress_candidate(&mut progressed, &object.scope_id, object);

        }
        reconcile_progress_completion(&transaction, &progressed)?;
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


#[cfg(test)]
mod tests {
    use super::*;
    fn connection() -> Connection {
        crate::db::Database::open_path(":memory:").unwrap().connection.into_inner().unwrap()
    }
    fn object(page: i64, clock: i64) -> serde_json::Value {
        serde_json::json!({"scopeId":"a","objectType":"reading_progress","objectId":"a/book","operation":"upsert","payload":{"archiveId":"book","pageIndex":page,"pageCount":20,"layout":"paged","direction":"ltr"},"payloadHash":format!("hash-{page}"),"logicalClock":clock,"deviceId":"device","wallClock":"2026-01-01 00:00:00"})
    }
    #[test]
    fn duplicate_file_keys_choose_the_latest_record_in_either_order() {
        for (a,b) in [(object(3,1),object(7,2)),(object(7,2),object(3,1))] {
            let text=format!(r#"{{"version":1,"epoch":0,"objects":{{"duplicate":{a},"duplicate":{b}}}}}"#);
            let document=parse_scoped_document(&text).unwrap();
            let mut db=connection();
            let report=import_scoped_documents(&mut db,document,&["progress".into()]).unwrap();
            assert_eq!(report.applied,1);
            assert_eq!(db.query_row("SELECT page_index FROM reading_progress",[],|r|r.get::<_,i64>(0)).unwrap(),7);
        }
    }
    #[test]
    fn import_is_atomic_when_a_later_record_is_invalid() {
        let mut db=connection();
        let mut bad=object(4,2); bad["objectId"]=serde_json::json!("a/invalid"); bad["payload"]=serde_json::json!({});
        let document=parse_scoped_document(&serde_json::json!({"version":1,"epoch":0,"objects":{"a":object(3,1),"z":bad}}).to_string()).unwrap();
        assert!(import_scoped_documents(&mut db,document,&["progress".into()]).is_err());
        assert_eq!(db.query_row("SELECT COUNT(*) FROM reading_progress",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[test]
    fn current_tables_export_without_a_cloud_queue_and_dedup_round_trips() {
        let source=connection();
        source.execute_batch("INSERT INTO search_presets(scope_id,preset_id,name,query,device_id) VALUES('a','p','Saved','tag:test','d'); INSERT INTO dedup_non_duplicates(scope_id,pair_key,left_archive_id,right_archive_id,tombstoned,logical_clock) VALUES('a','left|right','left','right',0,1);").unwrap();
        let categories=vec!["search_presets".into(),"dedup".into()];
        let (value,count)=export_scoped_document(&source,&categories).unwrap(); assert_eq!(count,2);
        let mut target=connection(); assert_eq!(import_scoped_document(&mut target,value,&categories).unwrap().applied,2);
        assert_eq!(target.query_row("SELECT name FROM search_presets",[],|r|r.get::<_,String>(0)).unwrap(),"Saved");
        assert_eq!(target.query_row("SELECT COUNT(*) FROM dedup_non_duplicates WHERE tombstoned=0",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(target.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('sync_journal','sync_accounts','sync_applied_segments','webdav_accounts')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
}

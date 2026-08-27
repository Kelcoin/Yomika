use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{db::Database, domain::result::CommandResult};

const THEME_KEY: &str = "preferences.theme";
const LAYOUT_KEY: &str = "preferences.default_layout";
const DIRECTION_KEY: &str = "preferences.default_direction";
const CACHE_MAX_BYTES_KEY: &str = "preferences.cache_max_bytes";

pub(crate) fn get_or_create_device_id(
    transaction: &rusqlite::Transaction<'_>,
) -> Result<String, String> {
    let existing: Option<String> = transaction
        .query_row(
            "SELECT value_json FROM settings WHERE key='sync.device_id'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(value_json) = existing {
        return serde_json::from_str(&value_json).map_err(|error| error.to_string());
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let device_id = format!("device-{}-{nonce}", std::process::id());
    transaction
        .execute(
            "INSERT INTO settings (key,value_json) VALUES ('sync.device_id',?1)",
            [serde_json::to_string(&device_id).map_err(|error| error.to_string())?],
        )
        .map_err(|error| error.to_string())?;
    Ok(device_id)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceSnapshot {
    pub theme: String,
    pub default_layout: String,
    pub default_direction: String,
    pub cache_max_bytes: u64,
}

impl Default for PreferenceSnapshot {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            default_layout: "auto".into(),
            default_direction: "ltr".into(),
            cache_max_bytes: 2_147_483_648,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPreferenceImport {
    pub preferences: PreferenceSnapshot,
    pub imported_count: u8,
}

fn validate_preferences(value: &PreferenceSnapshot) -> Result<(), String> {
    if !matches!(value.theme.as_str(), "system" | "light" | "dark")
        || !matches!(value.default_layout.as_str(), "auto" | "single" | "double" | "webtoon")
        || !matches!(value.default_direction.as_str(), "ltr" | "rtl")
        || value.cache_max_bytes == 0
        || value.cache_max_bytes > i64::MAX as u64
    {
        return Err("Invalid preference snapshot".into());
    }
    Ok(())
}

fn load_value<T: serde::de::DeserializeOwned>(
    connection: &Connection,
    key: &str,
    fallback: T,
) -> Result<T, String> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT value_json FROM settings WHERE key=?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match stored {
        Some(value) => serde_json::from_str(&value).map_err(|error| error.to_string()),
        None => Ok(fallback),
    }
}

pub fn load_preferences_from(connection: &Connection) -> Result<PreferenceSnapshot, String> {
    let defaults = PreferenceSnapshot::default();
    let value = PreferenceSnapshot {
        theme: load_value(connection, THEME_KEY, defaults.theme)?,
        default_layout: load_value(connection, LAYOUT_KEY, defaults.default_layout)?,
        default_direction: load_value(connection, DIRECTION_KEY, defaults.default_direction)?,
        cache_max_bytes: load_value(connection, CACHE_MAX_BYTES_KEY, defaults.cache_max_bytes)?,
    };
    validate_preferences(&value)?;
    Ok(value)
}

pub fn save_preferences_to(
    connection: &mut Connection,
    value: PreferenceSnapshot,
) -> Result<PreferenceSnapshot, String> {
    validate_preferences(&value)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    for (key, encoded) in [
        (THEME_KEY, serde_json::to_string(&value.theme)),
        (LAYOUT_KEY, serde_json::to_string(&value.default_layout)),
        (DIRECTION_KEY, serde_json::to_string(&value.default_direction)),
        (CACHE_MAX_BYTES_KEY, serde_json::to_string(&value.cache_max_bytes)),
    ] {
        transaction
            .execute(
                "INSERT INTO settings (key,value_json) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
                params![key, encoded.map_err(|error| error.to_string())?],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(value)
}

pub fn import_legacy_preferences_from(
    connection: &mut Connection,
    encoded: &str,
) -> Result<LegacyPreferenceImport, String> {
    let decoded = STANDARD
        .decode(encoded.trim())
        .map_err(|_| "Legacy configuration is not valid Base64".to_string())?;
    let root: Value = serde_json::from_slice(&decoded)
        .map_err(|_| "Legacy configuration is not valid JSON".to_string())?;
    let object = root
        .as_object()
        .ok_or_else(|| "Legacy configuration must be an object".to_string())?;

    let mut preferences = load_preferences_from(connection)?;
    let mut imported_count = 0_u8;

    if let Some(theme) = object.get("lrr_theme_mode").and_then(Value::as_str) {
        let mapped = match theme {
            "auto" => Some("system"),
            "light" => Some("light"),
            "dark" => Some("dark"),
            _ => None,
        };
        if let Some(theme) = mapped {
            preferences.theme = theme.into();
            imported_count += 1;
        }
    }

    if let Some(reader_settings) = object
        .get("lrr_reader_settings")
        .and_then(Value::as_str)
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .and_then(|value| value.as_object().cloned())
    {
        if let Some(layout @ ("auto" | "single" | "double" | "webtoon")) =
            reader_settings.get("readingLayout").and_then(Value::as_str)
        {
            preferences.default_layout = layout.into();
            imported_count += 1;
        }
        if let Some(direction @ ("ltr" | "rtl")) =
            reader_settings.get("direction").and_then(Value::as_str)
        {
            preferences.default_direction = direction.into();
            imported_count += 1;
        }
    }

    if imported_count == 0 {
        return Err("Legacy configuration has no supported ordinary preferences".into());
    }
    let preferences = save_preferences_to(connection, preferences)?;
    Ok(LegacyPreferenceImport {
        preferences,
        imported_count,
    })
}

#[tauri::command]
pub fn load_preferences(database: tauri::State<'_, Database>) -> CommandResult<PreferenceSnapshot> {
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match load_preferences_from(&connection) {
        Ok(value) => CommandResult::success(value),
        Err(_) => CommandResult::failure("INVALID_RESPONSE", "Stored preferences are invalid", false),
    }
}

#[tauri::command]
pub fn save_preferences(
    input: PreferenceSnapshot,
    database: tauri::State<'_, Database>,
) -> CommandResult<PreferenceSnapshot> {
    let mut connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match save_preferences_to(&mut connection, input) {
        Ok(value) => CommandResult::success(value),
        Err(_) => CommandResult::failure("INVALID_RESPONSE", "Preference snapshot is invalid", false),
    }
}

#[tauri::command]
pub fn import_legacy_preferences(
    encoded: String,
    database: tauri::State<'_, Database>,
) -> CommandResult<LegacyPreferenceImport> {
    let mut connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match import_legacy_preferences_from(&mut connection, &encoded) {
        Ok(value) => CommandResult::success(value),
        Err(_) => CommandResult::failure(
            "INVALID_RESPONSE",
            "Legacy ordinary preferences are invalid or unsupported",
            false,
        ),
    }
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use rusqlite::Connection;

    use super::{
        import_legacy_preferences_from, load_preferences_from, save_preferences_to,
        PreferenceSnapshot,
    };

    fn settings_db() -> Connection {
        let connection = Connection::open_in_memory().expect("settings database");
        connection
            .execute_batch(include_str!("../migrations/0001_initial.sql"))
            .expect("initial migration");
        connection
    }

    #[test]
    fn preferences_default_and_round_trip_without_exposing_unrelated_settings() {
        let mut connection = settings_db();
        connection
            .execute(
                "INSERT INTO settings (key,value_json) VALUES ('sync.device_id','\"secret-device\"')",
                [],
            )
            .expect("unrelated setting fixture");

        assert_eq!(load_preferences_from(&connection).expect("defaults"), PreferenceSnapshot::default());

        let wanted = PreferenceSnapshot {
            theme: "dark".into(),
            default_layout: "double".into(),
            default_direction: "rtl".into(),
            cache_max_bytes: 4_294_967_296,
        };
        save_preferences_to(&mut connection, wanted.clone()).expect("save preferences");
        assert_eq!(load_preferences_from(&connection).expect("saved preferences"), wanted);
        let device_id: String = connection
            .query_row(
                "SELECT value_json FROM settings WHERE key='sync.device_id'",
                [],
                |row| row.get(0),
            )
            .expect("unrelated setting preserved");
        assert_eq!(device_id, "\"secret-device\"");
    }

    #[test]
    fn preferences_reject_invalid_enum_and_quota_values() {
        let mut connection = settings_db();
        let invalid_theme = PreferenceSnapshot {
            theme: "sepia".into(),
            ..PreferenceSnapshot::default()
        };
        assert!(save_preferences_to(&mut connection, invalid_theme).is_err());

        let invalid_quota = PreferenceSnapshot {
            cache_max_bytes: 0,
            ..PreferenceSnapshot::default()
        };
        assert!(save_preferences_to(&mut connection, invalid_quota).is_err());
    }

    #[test]
    fn legacy_preferences_map_only_known_ordinary_fields() {
        let mut connection = settings_db();
        let encoded = STANDARD.encode(
            r#"{"lrr_theme_mode":"auto","lrr_reader_settings":"{\"readingLayout\":\"double\",\"direction\":\"rtl\"}","lrr_api_key":"secret-api-key","lrr_eh_cookie":"secret-cookie","lrr_sync_token":"secret-token","unknown":"ignored"}"#,
        );

        let imported = import_legacy_preferences_from(&mut connection, &encoded)
            .expect("legacy ordinary preferences");
        assert_eq!(imported.imported_count, 3);
        assert_eq!(
            imported.preferences,
            PreferenceSnapshot {
                theme: "system".into(),
                default_layout: "double".into(),
                default_direction: "rtl".into(),
                ..PreferenceSnapshot::default()
            }
        );
        let leaked: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE value_json LIKE '%secret%'",
                [],
                |row| row.get(0),
            )
            .expect("secret leak count");
        assert_eq!(leaked, 0);
    }

    #[test]
    fn legacy_preferences_reject_malformed_or_unmapped_exports() {
        let mut connection = settings_db();
        assert!(import_legacy_preferences_from(&mut connection, "not-base64").is_err());
        assert!(import_legacy_preferences_from(
            &mut connection,
            &STANDARD.encode("not-json")
        )
        .is_err());
        assert!(import_legacy_preferences_from(
            &mut connection,
            &STANDARD.encode(r#"{"lrr_api_key":"secret-only"}"#)
        )
        .is_err());
        assert_eq!(
            load_preferences_from(&connection).expect("unchanged defaults"),
            PreferenceSnapshot::default()
        );
    }
}

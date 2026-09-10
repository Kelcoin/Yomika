use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{db::Database, domain::result::CommandResult};

const THEME_KEY: &str = "preferences.theme";
const LAYOUT_KEY: &str = "preferences.default_layout";
const DIRECTION_KEY: &str = "preferences.default_direction";
const CACHE_MAX_BYTES_KEY: &str = "preferences.cache_max_bytes";
const CUSTOM_CSS_KEY: &str = "preferences.custom_css";
const PREFETCH_PAGES_KEY: &str = "preferences.prefetch_pages";
const COVER_CONCURRENCY_KEY: &str = "preferences.cover_concurrency";
const STARTUP_ROUTE_KEY: &str = "preferences.startup_route";
const CARD_STYLE_KEY: &str = "preferences.card_style";
const UPSCALE_BACKEND_KEY: &str = "preferences.upscale_backend";
const UPSCALE_MODEL_KEY: &str = "preferences.upscale_model";
const DECENSOR_MODEL_KEY: &str = "preferences.decensor_model";
const DOWNLOAD_DIRECTORY_KEY: &str = "preferences.download_directory";
const EH_FAVORITE_DELETE_SYNC_KEY: &str = "preferences.eh_favorite_delete_sync";
const CONFIRM_EH_FAVORITE_DELETE_KEY: &str = "preferences.confirm_eh_favorite_delete";
pub const GIB_BYTES: u64 = 1_073_741_824;
pub const MIN_CACHE_BYTES: u64 = GIB_BYTES;
pub const MAX_CACHE_BYTES: u64 = 32 * GIB_BYTES;
/// Pages either side of the current one the reader may preload. A page is a few
/// hundred KB from a server on the same LAN, so the old ceiling of 5 was
/// needlessly cautious.
pub const MAX_PREFETCH_PAGES: u8 = 10;

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
    /// How many pages either side of the current one the reader preloads.
    #[serde(default = "default_prefetch_pages")]
    pub prefetch_pages: u8,
    /// Concurrent cover requests; LANraragi queues thumbnail extraction.
    #[serde(default = "default_cover_concurrency")]
    pub cover_concurrency: u8,
    /// Which page the app opens at launch: "home" or "library".
    #[serde(default = "default_startup_route")]
    pub startup_route: String,
    /// How archive cards are drawn: "wide" (a list row) or "thumbnail" (a grid).
    /// A preference rather than view state because the shelves follow the same
    /// choice, and it used to reset to the default on every navigation.
    #[serde(default = "default_card_style")]
    pub card_style: String,
    #[serde(default = "default_upscale_backend")]
    pub upscale_backend: String,
    #[serde(default)]
    pub upscale_model: String,
    /// Installed de-censoring bundle to run on reader pages. Empty means off:
    /// there is no separate switch, because a bundle that is not chosen is the
    /// only sense in which the feature can be off.
    #[serde(default)]
    pub decensor_model: String,
    #[serde(default)]
    pub download_directory: String,
    #[serde(default)]
    pub eh_favorite_delete_sync: bool,
    #[serde(default = "default_true")]
    pub confirm_eh_favorite_delete: bool,
    /// Free-form CSS appended after the design tokens. This is the whole
    /// customisation surface: it superseded a single accent-colour preference,
    /// which could not express the themes people actually want and became one
    /// more thing to keep in step once this existed.
    #[serde(default)]
    pub custom_css: String,
}

fn default_prefetch_pages() -> u8 {
    1
}
fn default_true() -> bool {
    true
}
fn default_cover_concurrency() -> u8 {
    4
}
fn default_startup_route() -> String {
    "home".to_string()
}
fn default_card_style() -> String {
    "wide".to_string()
}
fn default_upscale_backend() -> String {
    "off".to_string()
}

impl Default for PreferenceSnapshot {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            default_layout: "auto".into(),
            default_direction: "ltr".into(),
            cache_max_bytes: 2_147_483_648,
            prefetch_pages: default_prefetch_pages(),
            cover_concurrency: default_cover_concurrency(),
            startup_route: default_startup_route(),
            card_style: default_card_style(),
            upscale_backend: default_upscale_backend(),
            upscale_model: String::new(),
            decensor_model: String::new(),
            download_directory: String::new(),
            eh_favorite_delete_sync: false,
            confirm_eh_favorite_delete: true,
            custom_css: String::new(),
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
        || !(MIN_CACHE_BYTES..=MAX_CACHE_BYTES).contains(&value.cache_max_bytes)
        || value.cache_max_bytes % GIB_BYTES != 0
        || value.prefetch_pages > MAX_PREFETCH_PAGES
        || !(1..=8).contains(&value.cover_concurrency)
        || !matches!(value.startup_route.as_str(), "home" | "library")
        || !matches!(value.card_style.as_str(), "wide" | "thumbnail")
        || !matches!(value.upscale_backend.as_str(), "off" | "cpu" | "auto")
        || value.upscale_model.len() > 128
        || value.decensor_model.len() > 128
        || value.download_directory.len() > 4096
        || (!value.download_directory.is_empty() && !std::path::Path::new(&value.download_directory).is_absolute())
        // Bounded so a paste cannot bloat the settings row; enough for a theme.
        || value.custom_css.len() > 20_000
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
        prefetch_pages: load_value(connection, PREFETCH_PAGES_KEY, defaults.prefetch_pages)?,
        cover_concurrency: load_value(
            connection,
            COVER_CONCURRENCY_KEY,
            defaults.cover_concurrency,
        )?,
        startup_route: load_value(connection, STARTUP_ROUTE_KEY, defaults.startup_route)?,
        card_style: load_value(connection, CARD_STYLE_KEY, defaults.card_style)?,
        upscale_backend: load_value(connection, UPSCALE_BACKEND_KEY, defaults.upscale_backend)?,
        upscale_model: load_value(connection, UPSCALE_MODEL_KEY, defaults.upscale_model)?,
        decensor_model: load_value(connection, DECENSOR_MODEL_KEY, defaults.decensor_model)?,
        download_directory: load_value(
            connection,
            DOWNLOAD_DIRECTORY_KEY,
            defaults.download_directory,
        )?,
        eh_favorite_delete_sync: load_value(
            connection,
            EH_FAVORITE_DELETE_SYNC_KEY,
            defaults.eh_favorite_delete_sync,
        )?,
        confirm_eh_favorite_delete: load_value(
            connection,
            CONFIRM_EH_FAVORITE_DELETE_KEY,
            defaults.confirm_eh_favorite_delete,
        )?,
        custom_css: load_value(connection, CUSTOM_CSS_KEY, defaults.custom_css)?,
    };
    validate_preferences(&value)?;
    Ok(value)
}

pub fn save_preferences_to(
    connection: &mut Connection,
    value: PreferenceSnapshot,
) -> Result<PreferenceSnapshot, String> {
    validate_preferences(&value)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for (key, encoded) in [
        (THEME_KEY, serde_json::to_string(&value.theme)),
        (LAYOUT_KEY, serde_json::to_string(&value.default_layout)),
        (
            DIRECTION_KEY,
            serde_json::to_string(&value.default_direction),
        ),
        (
            CACHE_MAX_BYTES_KEY,
            serde_json::to_string(&value.cache_max_bytes),
        ),
        (
            PREFETCH_PAGES_KEY,
            serde_json::to_string(&value.prefetch_pages),
        ),
        (
            COVER_CONCURRENCY_KEY,
            serde_json::to_string(&value.cover_concurrency),
        ),
        (
            STARTUP_ROUTE_KEY,
            serde_json::to_string(&value.startup_route),
        ),
        (CARD_STYLE_KEY, serde_json::to_string(&value.card_style)),
        (
            UPSCALE_BACKEND_KEY,
            serde_json::to_string(&value.upscale_backend),
        ),
        (
            UPSCALE_MODEL_KEY,
            serde_json::to_string(&value.upscale_model),
        ),
        (
            DECENSOR_MODEL_KEY,
            serde_json::to_string(&value.decensor_model),
        ),
        (
            DOWNLOAD_DIRECTORY_KEY,
            serde_json::to_string(&value.download_directory),
        ),
        (
            EH_FAVORITE_DELETE_SYNC_KEY,
            serde_json::to_string(&value.eh_favorite_delete_sync),
        ),
        (
            CONFIRM_EH_FAVORITE_DELETE_KEY,
            serde_json::to_string(&value.confirm_eh_favorite_delete),
        ),
        (CUSTOM_CSS_KEY, serde_json::to_string(&value.custom_css)),
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
        Err(_) => {
            CommandResult::failure("INVALID_RESPONSE", "Stored preferences are invalid", false)
        }
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
        Err(_) => {
            CommandResult::failure("INVALID_RESPONSE", "Preference snapshot is invalid", false)
        }
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
        PreferenceSnapshot, MAX_PREFETCH_PAGES,
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

        assert_eq!(
            load_preferences_from(&connection).expect("defaults"),
            PreferenceSnapshot::default()
        );

        let wanted = PreferenceSnapshot {
            theme: "dark".into(),
            default_layout: "double".into(),
            default_direction: "rtl".into(),
            cache_max_bytes: 4_294_967_296,
            prefetch_pages: 3,
            cover_concurrency: 6,
            startup_route: "library".into(),
            card_style: "thumbnail".into(),
            upscale_backend: "cpu".into(),
            upscale_model: "real-esrgan-anime-x2".into(),
            decensor_model: "aletheia-lens".into(),
            download_directory: std::env::temp_dir().to_string_lossy().into_owned(),
            eh_favorite_delete_sync: true,
            confirm_eh_favorite_delete: false,
            custom_css: ":root { --brand-vermilion: #1f6f8b; }".into(),
        };
        save_preferences_to(&mut connection, wanted.clone()).expect("save preferences");
        assert_eq!(
            load_preferences_from(&connection).expect("saved preferences"),
            wanted
        );
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
    fn custom_css_is_free_form_but_bounded() {
        // The CSS blob is the whole customisation surface — it replaced a single
        // accent-colour preference, which could not express a theme. The only
        // rule is that it cannot bloat the settings row.
        let mut connection = settings_db();
        let themed = PreferenceSnapshot {
            custom_css: "body { letter-spacing: 0.01em; }".into(),
            ..PreferenceSnapshot::default()
        };
        assert_eq!(
            save_preferences_to(&mut connection, themed.clone()).expect("save css"),
            themed
        );
        assert_eq!(
            load_preferences_from(&connection)
                .expect("load css")
                .custom_css,
            "body { letter-spacing: 0.01em; }"
        );

        assert!(save_preferences_to(
            &mut connection,
            PreferenceSnapshot {
                custom_css: "a".repeat(20_001),
                ..PreferenceSnapshot::default()
            }
        )
        .is_err());
    }

    #[test]
    fn preferences_reject_invalid_enum_and_quota_values() {
        let mut connection = settings_db();
        // Ten pages of prefetch is allowed now; eleven is not.
        assert!(save_preferences_to(
            &mut connection,
            PreferenceSnapshot {
                prefetch_pages: MAX_PREFETCH_PAGES,
                ..PreferenceSnapshot::default()
            }
        )
        .is_ok());
        assert!(save_preferences_to(
            &mut connection,
            PreferenceSnapshot {
                prefetch_pages: MAX_PREFETCH_PAGES + 1,
                ..PreferenceSnapshot::default()
            }
        )
        .is_err());
        assert!(save_preferences_to(
            &mut connection,
            PreferenceSnapshot {
                cover_concurrency: 0,
                ..PreferenceSnapshot::default()
            }
        )
        .is_err());
        assert!(save_preferences_to(
            &mut connection,
            PreferenceSnapshot {
                upscale_backend: "gpu".into(),
                ..PreferenceSnapshot::default()
            }
        )
        .is_err());
        assert!(save_preferences_to(
            &mut connection,
            PreferenceSnapshot {
                startup_route: "reader".into(),
                ..PreferenceSnapshot::default()
            }
        )
        .is_err());

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
        assert!(save_preferences_to(
            &mut connection,
            PreferenceSnapshot {
                cache_max_bytes: 1_073_741_823,
                ..PreferenceSnapshot::default()
            }
        )
        .is_err());
        assert!(save_preferences_to(
            &mut connection,
            PreferenceSnapshot {
                cache_max_bytes: 34_359_738_369,
                ..PreferenceSnapshot::default()
            }
        )
        .is_err());
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
        assert!(
            import_legacy_preferences_from(&mut connection, &STANDARD.encode("not-json")).is_err()
        );
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

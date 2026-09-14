use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use reqwest::Client;
use rusqlite::{params, params_from_iter, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::task::JoinSet;
use url::Url;

use crate::{db::Database, domain::result::CommandResult, settings::get_or_create_device_id};

const KEYRING_SERVICE: &str = "app.yomika.reader";

pub trait CredentialStore {
    fn set_server_api_key(&self, scope_id: &str, api_key: &str) -> Result<(), String>;
}

struct SystemCredentialStore;

impl CredentialStore for SystemCredentialStore {
    fn set_server_api_key(&self, scope_id: &str, api_key: &str) -> Result<(), String> {
        keyring::Entry::new(KEYRING_SERVICE, scope_id)
            .map_err(|error| error.to_string())?
            .set_password(api_key)
            .map_err(|error| error.to_string())
    }
}

impl SystemCredentialStore {
    fn get_server_api_key(&self, scope_id: &str) -> Result<String, String> {
        keyring::Entry::new(KEYRING_SERVICE, scope_id)
            .map_err(|error| error.to_string())?
            .get_password()
            .map_err(|error| error.to_string())
    }
}

fn credential_read_error(error: String) -> String {
    if error.contains("No matching entry found") || error.contains("secure storage") {
        "服务器凭据不可用，请重新保存 API Key".to_string()
    } else {
        format!("读取服务器凭据失败：{error}")
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInput {
    name: String,
    base_url: String,
    scope_id: String,
}

#[derive(Debug, Deserialize)]
struct ServerInfoWire {
    name: Option<String>,
    version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRecord {
    id: String,
    name: String,
    base_url: String,
    scope_id: String,
    /// The one server the home shelves, the library and every default-server
    /// fallback read from. At most one server is enabled at a time.
    enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatusRecord {
    server_id: String,
    online: bool,
    name: Option<String>,
    error: Option<String>,
}

#[derive(Debug)]
pub struct RemoteArchive {
    archive_id: String,
    title: String,
    summary: Option<String>,
    tags: Vec<String>,
    page_count: i64,
    size: i64,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct SearchArchiveWire {
    arcid: String,
    title: String,
    // Only arcid/title/tags/summary/pagecount/size are consumed. The rest is
    // optional on purpose: `progress` and `lastreadtime` only appear when the
    // server tracks progress, and a missing field used to fail the entire sync.
    #[serde(default)]
    filename: String,
    #[serde(default)]
    tags: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    isnew: serde_json::Value,
    #[serde(default)]
    extension: String,
    #[serde(default)]
    progress: i64,
    #[serde(default)]
    pagecount: i64,
    #[serde(default)]
    lastreadtime: i64,
    #[serde(default)]
    size: i64,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchResponseWire {
    data: Vec<SearchArchiveWire>,
    records_filtered: i64,
    records_total: i64,
}

#[derive(Debug, Deserialize)]
struct RandomResponseWire {
    #[serde(default)]
    data: Vec<SearchArchiveWire>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRecord {
    server_id: String,
    archive_id: String,
    title: String,
    page_count: i64,
    file_size: Option<i64>,
    summary: Option<String>,
    category: Option<String>,
    language: Option<String>,
    cover_page: Option<i64>,
    is_deleted: bool,
    updated_at: String,
    added_at: Option<i64>,
    tags: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePage {
    items: Vec<ArchiveRecord>,
    total: i64,
    has_more: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveQueryInput {
    server_id: String,
    query: String,
    sort_by: String,
    order: String,
    category_id: Option<String>,
    /// The offline half of LANraragi's `untaggedonly`. `tags_json` is the mirror's
    /// copy of the tag list, so "no tags" is answerable locally.
    #[serde(default)]
    untagged_only: Option<bool>,
    offset: i64,
    limit: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingProgressInput {
    scope_id: String,
    archive_id: String,
    page_index: i64,
    page_count: i64,
    layout: String,
    direction: String,
    /// Whether page 0 opens alone in double-page mode. `None` leaves whatever was
    /// stored alone, so a caller that does not care cannot erase the setting.
    #[serde(default)]
    cover_alone: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingProgressRecord {
    scope_id: String,
    archive_id: String,
    page_index: i64,
    page_count: i64,
    layout: String,
    direction: String,
    cover_alone: Option<bool>,
    updated_at: String,
    revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPresetRecord {
    pub scope_id: String,
    pub preset_id: String,
    pub name: String,
    pub query: String,
    pub sort_by: String,
    pub sort_order: String,
    pub category_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub device_id: String,
    pub revision: i64,
    pub deleted: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPresetInput {
    pub scope_id: String,
    pub preset_id: String,
    pub name: String,
    #[serde(default)]
    pub query: String,
    pub sort_by: String,
    pub sort_order: String,
    #[serde(default)]
    pub category_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistRecord {
    scope_id: String,
    archive_id: String,
    added_at: String,
    updated_at: String,
    device_id: String,
    deleted_at: Option<String>,
    revision: i64,
    deleted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingHistoryRecord {
    scope_id: String,
    archive_id: String,
    page_index: i64,
    visited_at: String,
    device_id: String,
    revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    kind: String,
    label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    id: String,
    kind: String,
    label: String,
    status: String,
    progress: f64,
    error: Option<String>,
    cancelable: bool,
    retryable: bool,
    created_at: String,
    updated_at: String,
}

fn read_task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskRecord> {
    Ok(TaskRecord {
        id: row.get(0)?,
        kind: row.get(1)?,
        label: row.get(2)?,
        status: row.get(3)?,
        progress: row.get(4)?,
        error: row.get(5)?,
        cancelable: row.get::<_, i64>(6)? != 0,
        retryable: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn read_task(connection: &rusqlite::Connection, id: &str) -> Result<TaskRecord, String> {
    connection.query_row(
        "SELECT id,kind,label,status,progress,error,cancelable,retryable,created_at,updated_at FROM tasks WHERE id=?1",
        [id],
        read_task_row,
    ).map_err(|error| error.to_string())
}

pub(crate) fn recover_interrupted_tasks(
    connection: &rusqlite::Connection,
) -> Result<usize, String> {
    connection.execute(
        "UPDATE tasks SET status=CASE WHEN retryable=1 THEN 'queued' ELSE 'failed' END,error=CASE WHEN retryable=1 THEN error ELSE 'Interrupted by application restart' END,updated_at=CURRENT_TIMESTAMP WHERE status='running'",
        [],
    ).map_err(|error| error.to_string())
}

fn transition_task(
    connection: &rusqlite::Connection,
    id: &str,
    requested_status: Option<&str>,
    requested_progress: Option<f64>,
    error: Option<&str>,
) -> Result<TaskRecord, String> {
    let current = read_task(connection, id)?;
    if matches!(
        current.status.as_str(),
        "completed" | "failed" | "cancelled"
    ) {
        return Err("Task is already terminal".into());
    }
    let status = requested_status.unwrap_or(&current.status);
    let progress = requested_progress.unwrap_or(current.progress);
    if !(0.0..=1.0).contains(&progress) || progress < current.progress {
        return Err("Task progress cannot decrease".into());
    }
    let allowed = matches!(
        (current.status.as_str(), status),
        ("queued", "queued" | "running" | "cancelled")
            | (
                "running",
                "running" | "paused" | "completed" | "failed" | "cancelled"
            )
            | ("paused", "paused" | "running" | "cancelled")
    );
    if !allowed
        || (status == "cancelled" && !current.cancelable)
        || (status == "completed" && progress != 1.0)
    {
        return Err("Invalid task state transition".into());
    }
    connection.execute(
        "UPDATE tasks SET status=?1,progress=?2,error=?3,updated_at=CURRENT_TIMESTAMP WHERE id=?4",
        params![status, progress, error, id],
    ).map_err(|error| error.to_string())?;
    read_task(connection, id)
}

fn retry_failed_task(connection: &rusqlite::Connection, id: &str) -> Result<TaskRecord, String> {
    let current = read_task(connection, id)?;
    if current.status != "failed" || !current.retryable {
        return Err("Task cannot be retried".into());
    }
    connection
        .execute(
            "UPDATE tasks SET status='queued',error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            [id],
        )
        .map_err(|error| error.to_string())?;
    read_task(connection, id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderManifest {
    archive_id: String,
    title: String,
    pages: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ReaderFileListWire {
    pages: Vec<String>,
    #[allow(dead_code)]
    job: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ArchiveMetadataWire {
    arcid: String,
    title: String,
    filename: String,
    tags: String,
    summary: Option<String>,
    extension: String,
    progress: i64,
    pagecount: i64,
    lastreadtime: i64,
    size: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMetadataRecord {
    archive_id: String,
    title: String,
    filename: String,
    tags: String,
    summary: Option<String>,
    extension: String,
    progress: i64,
    page_count: i64,
    last_read_time: i64,
    size: i64,
}

fn parse_reader_file_list(json: &str) -> Result<Vec<String>, String> {
    let response: ReaderFileListWire =
        serde_json::from_str(json).map_err(|error| error.to_string())?;
    if response.pages.is_empty() {
        return Err("LANraragi returned no reader pages".to_string());
    }
    response
        .pages
        .into_iter()
        .map(|page| normalize_reader_page_path(&page))
        .collect()
}

fn normalize_reader_page_path(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let candidate = trimmed.replace('\\', "/");
    let route = candidate.strip_prefix("./").unwrap_or(&candidate);
    let route_without_root = route.strip_prefix('/').unwrap_or(route);
    if route_without_root.starts_with("api/archives/") {
        let normalized_route =
            format!("/{route_without_root}").replacen("/page&path=", "/page?path=", 1);
        let parsed = Url::parse(&format!("http://lanraragi.local{normalized_route}"))
            .map_err(|_| "Invalid reader page path".to_string())?;
        let segments = parsed
            .path_segments()
            .map(|parts| parts.collect::<Vec<_>>())
            .unwrap_or_default();
        if segments.len() != 4
            || segments[0] != "api"
            || segments[1] != "archives"
            || segments[2].is_empty()
            || segments[3] != "page"
        {
            return Err("Invalid reader page path".to_string());
        }
        let paths = parsed
            .query_pairs()
            .filter_map(|(key, path)| (key == "path").then(|| path.into_owned()))
            .collect::<Vec<_>>();
        if paths.len() != 1 {
            return Err("Invalid reader page path".to_string());
        }
        return validate_reader_archive_path(&paths[0]);
    }
    validate_reader_archive_path(route)
}

fn validate_reader_archive_path(candidate: &str) -> Result<String, String> {
    if candidate.is_empty()
        || candidate.starts_with('/')
        || candidate.contains("://")
        || candidate
            .split('/')
            .any(|part| part.is_empty() || part == ".." || part == ".")
    {
        return Err("Invalid reader page path".to_string());
    }
    Ok(candidate.to_string())
}

fn reader_page_cache_key(scope_id: &str, archive_id: &str, page_index: i64) -> String {
    crate::cache::image_cache_key(&crate::cache::CacheImageIdentity::new(
        scope_id,
        archive_id,
        "reader-page",
        page_index,
    ))
}

fn load_reader_page_cache(
    connection: &rusqlite::Connection,
    app_data: &std::path::Path,
    scope_id: &str,
    archive_id: &str,
    page_index: i64,
) -> Result<Option<Vec<u8>>, String> {
    let identity =
        crate::cache::CacheImageIdentity::new(scope_id, archive_id, "reader-page", page_index);
    crate::cache::load_image_cache(connection, app_data, &identity)
        .map(|image| image.map(|image| image.bytes))
}

fn store_reader_page_cache(
    connection: &rusqlite::Connection,
    app_data: &std::path::Path,
    scope_id: &str,
    archive_id: &str,
    page_index: i64,
    mime: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let identity =
        crate::cache::CacheImageIdentity::new(scope_id, archive_id, "reader-page", page_index);
    crate::cache::store_image_cache(connection, app_data, &identity, mime, bytes)
}

fn server_connection(
    connection: &rusqlite::Connection,
    server_id: &str,
) -> Result<(String, String), String> {
    connection
        .query_row(
            "SELECT base_url, scope_id FROM servers WHERE id = ?1",
            [server_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())
}

fn reconcile_missing_archive_status(
    connection: &rusqlite::Connection,
    server_id: &str,
    archive_id: &str,
    status: reqwest::StatusCode,
) -> Result<bool, String> {
    if !matches!(
        status,
        reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::NOT_FOUND
    ) {
        return Ok(false);
    }
    connection.execute(
        "UPDATE archives SET is_deleted = 1, local_updated_at = CURRENT_TIMESTAMP WHERE server_id = ?1 AND archive_id = ?2",
        params![server_id, archive_id],
    ).map_err(|error| error.to_string())?;
    Ok(true)
}

async fn reader_request(
    method: reqwest::Method,
    url: String,
    api_key: String,
) -> Result<reqwest::Response, String> {
    reader_request_with_timeout(method, url, api_key, 10).await
}

async fn reader_request_with_timeout(
    method: reqwest::Method,
    url: String,
    api_key: String,
    timeout_seconds: u64,
) -> Result<reqwest::Response, String> {
    Client::builder()
        .connect_timeout(std::time::Duration::from_secs(3))
        .timeout(std::time::Duration::from_secs(timeout_seconds))
        .build()
        .map_err(|error| error.to_string())?
        .request(method, url)
        .header(
            reqwest::header::AUTHORIZATION,
            authorization_value(&api_key),
        )
        .send()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn list_categories(
    server_id: String,
    force: Option<bool>,
    database: State<'_, Database>,
) -> Result<CommandResult<Vec<CategoryRecord>>, String> {
    // Resolving dynamic categories costs one unpaged /api/search per category,
    // so a plain navigation must not trigger it. Serve the persisted snapshot
    // until it ages out, and only refetch when the caller asks for it.
    if !force.unwrap_or(false) {
        match read_category_cache(&database, &server_id) {
            Ok(Some(categories)) => return Ok(CommandResult::success(categories)),
            Ok(None) => {}
            Err(error) => return Ok(CommandResult::failure("LOCAL_DATABASE", error, true)),
        }
    }
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|c| server_connection(&c, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let response = match reader_request(
        reqwest::Method::GET,
        format!("{}/api/categories", base_url.trim_end_matches('/')),
        api_key.clone(),
    )
    .await
    {
        Ok(response) => response,
        Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
    };
    if !response.status().is_success() {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            format!("LANraragi request failed ({})", response.status()),
            response.status().is_server_error(),
        ));
    }
    let raw_categories: serde_json::Value = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                error.to_string(),
                false,
            ))
        }
    };
    let wire_result: Result<Vec<CategoryWire>, String> = match raw_categories {
        serde_json::Value::Array(items) => serde_json::from_value(serde_json::Value::Array(items)),
        serde_json::Value::Object(mut object) => {
            let items = object
                .remove("data")
                .or_else(|| object.remove("categories"))
                .unwrap_or(serde_json::Value::Array(Vec::new()));
            serde_json::from_value(items)
        }
        _ => serde_json::from_str("null"),
    }
    .map_err(|error| error.to_string());
    let wire = match wire_result {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("INVALID_RESPONSE", error, false)),
    };
    let mut categories: Vec<CategoryRecord> = wire
        .into_iter()
        .map(|category| {
            let pinned = category
                .pinned
                .as_bool()
                .or_else(|| category.pinned.as_i64().map(|value| value == 1))
                .or_else(|| category.pinned.as_str().map(|value| value == "1"))
                .unwrap_or(false);
            CategoryRecord {
                id: category.id,
                name: category.name,
                pinned,
                search: category.search,
                archives: normalize_category_archives(category.archives),
            }
        })
        .collect();
    // LANraragi leaves `archives` empty for dynamic categories. Resolve those
    // categories concurrently through their documented search expression so
    // one slow category cannot serialize the entire detail page.
    // Two at a time: each resolution is an unpaged full-library search, and a
    // library with many dynamic categories would otherwise fire them all at once.
    const MAX_PARALLEL_CATEGORY_SEARCHES: usize = 2;
    let mut dynamic_categories = JoinSet::new();
    let mut resolved = Vec::new();
    /// A whole-library search is not a page request. Ten seconds is enough for
    /// `/api/categories` and nowhere near enough for `start=-1` on a large
    /// library — and a timeout here is stored as an empty category, which reads
    /// as "nothing is in it".
    const CATEGORY_SEARCH_TIMEOUT_SECONDS: u64 = 45;
    let mut requested = 0usize;
    for (index, category) in categories.iter().enumerate() {
        if !category.archives.is_empty() {
            continue;
        }
        let Some(search) = category
            .search
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
        else {
            continue;
        };
        let base_url = base_url.clone();
        let api_key = api_key.clone();
        requested += 1;
        dynamic_categories.spawn(async move {
            let url = build_category_search_url(&base_url, &search).ok()?;
            let response = reader_request_with_timeout(
                reqwest::Method::GET,
                url,
                api_key,
                CATEGORY_SEARCH_TIMEOUT_SECONDS,
            )
            .await
            .ok()?;
            if !response.status().is_success() {
                return None;
            }
            let body = response.text().await.ok()?;
            let archives = parse_search_response(&body).ok()?;
            Some((
                index,
                archives
                    .into_iter()
                    .map(|archive| archive.archive_id)
                    .collect::<Vec<_>>(),
            ))
        });
        if dynamic_categories.len() >= MAX_PARALLEL_CATEGORY_SEARCHES {
            if let Some(Ok(Some(entry))) = dynamic_categories.join_next().await {
                resolved.push(entry);
            }
        }
    }
    while let Some(result) = dynamic_categories.join_next().await {
        if let Ok(Some(entry)) = result {
            resolved.push(entry);
        }
    }
    // A dynamic category that did not answer keeps an empty membership, which is
    // the same thing an empty category looks like. Remember that the snapshot is
    // incomplete so it is retried in minutes rather than in hours.
    let partial = resolved.len() < requested;
    for (index, archives) in resolved {
        if let Some(category) = categories.get_mut(index) {
            category.archives = archives;
        }
    }
    let sync_result = (|| -> Result<(), String> {
        let mut connection = database
            .connection
            .lock()
            .map_err(|_| "数据库锁定失败".to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("开启分类缓存事务失败：{error}"))?;
        transaction
            .execute(
                "DELETE FROM archive_categories WHERE server_id = ?1",
                [&server_id],
            )
            .map_err(|error| format!("清理分类缓存失败：{error}"))?;
        for category in &categories {
            for archive_id in &category.archives {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO archive_categories (server_id, category_id, archive_id)
                         SELECT ?1, ?2, ?3
                         WHERE EXISTS (SELECT 1 FROM archives WHERE server_id = ?1 AND archive_id = ?3)",
                        params![server_id, category.id, archive_id],
                    )
                    .map_err(|error| format!("写入分类缓存失败：{error}"))?;
            }
        }
        transaction
            .commit()
            .map_err(|error| format!("提交分类缓存失败：{error}"))?;
        write_category_cache(&connection, &server_id, &categories, partial)?;
        Ok(())
    })();
    if let Err(error) = sync_result {
        return Ok(CommandResult::failure("LOCAL_DATABASE", error, true));
    }
    Ok(CommandResult::success(categories))
}

#[tauri::command]
pub async fn add_archive_to_category(
    server_id: String,
    category_id: String,
    archive_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<OperationRecord>, String> {
    if category_id.len() != 14 || archive_id.is_empty() {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "Invalid category or archive ID",
            false,
        ));
    }
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|c| server_connection(&c, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let url = format!(
        "{}/api/categories/{}/{}",
        base_url.trim_end_matches('/'),
        category_id,
        archive_id
    );
    let response = match reader_request(reqwest::Method::PUT, url, api_key).await {
        Ok(response) => response,
        Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
    };
    if !response.status().is_success() {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            format!("LANraragi request failed ({})", response.status()),
            response.status().is_server_error(),
        ));
    }
    let record: OperationRecord = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                error.to_string(),
                false,
            ))
        }
    };
    if record.success != 1 {
        return Ok(CommandResult::failure(
            "REMOTE_CONFLICT",
            "LANraragi rejected category assignment",
            false,
        ));
    }
    if let Ok(connection) = database.connection.lock() {
        // Best effort: the assignment already succeeded on the server, so a
        // failure to drop the local snapshot must not turn into a failed call.
        // The stale window is 6 hours at worst, not permanent.
        let _ = invalidate_category_cache(&connection, &server_id);
    }
    Ok(CommandResult::success(record))
}

/// The removal twin of `add_archive_to_category` — the 收藏夹 shelf writes the
/// LANraragi 🔖 Favorites category through these two.
#[tauri::command]
pub async fn remove_archive_from_category(
    server_id: String,
    category_id: String,
    archive_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<OperationRecord>, String> {
    if category_id.len() != 14 || archive_id.is_empty() {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "Invalid category or archive ID",
            false,
        ));
    }
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|c| server_connection(&c, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let url = format!(
        "{}/api/categories/{}/{}",
        base_url.trim_end_matches('/'),
        category_id,
        archive_id
    );
    let response = match reader_request(reqwest::Method::DELETE, url, api_key).await {
        Ok(response) => response,
        Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
    };
    if !response.status().is_success() {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            format!("LANraragi request failed ({})", response.status()),
            response.status().is_server_error(),
        ));
    }
    let record: OperationRecord = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                error.to_string(),
                false,
            ))
        }
    };
    if record.success != 1 {
        return Ok(CommandResult::failure(
            "REMOTE_CONFLICT",
            "LANraragi rejected the category removal",
            false,
        ));
    }
    if let Ok(connection) = database.connection.lock() {
        let _ = invalidate_category_cache(&connection, &server_id);
    }
    Ok(CommandResult::success(record))
}

#[tauri::command]
pub async fn update_archive_metadata(
    server_id: String,
    archive_id: String,
    metadata: ArchiveMetadataUpdateInput,
    database: State<'_, Database>,
) -> Result<CommandResult<OperationRecord>, String> {
    if metadata.title.is_none() && metadata.tags.is_none() && metadata.summary.is_none() {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "Metadata update is empty",
            false,
        ));
    }
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|c| server_connection(&c, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let mut url = match Url::parse(&format!(
        "{}/api/archives/{}/metadata",
        base_url.trim_end_matches('/'),
        archive_id
    )) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                error.to_string(),
                false,
            ))
        }
    };
    {
        let mut query = url.query_pairs_mut();
        if let Some(title) = metadata.title.as_deref() {
            query.append_pair("title", title);
        }
        if let Some(tags) = metadata.tags.as_deref() {
            query.append_pair("tags", tags);
        }
        if let Some(summary) = metadata.summary.as_deref() {
            query.append_pair("summary", summary);
        }
    }
    let response = match reader_request(reqwest::Method::PUT, url.to_string(), api_key).await {
        Ok(response) => response,
        Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
    };
    if !response.status().is_success() {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            format!("LANraragi request failed ({})", response.status()),
            response.status().is_server_error(),
        ));
    }
    let record: OperationRecord = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                error.to_string(),
                false,
            ))
        }
    };
    if record.success != 1 {
        return Ok(CommandResult::failure(
            "REMOTE_CONFLICT",
            "LANraragi rejected metadata update",
            false,
        ));
    }
    if metadata.tags.is_some() {
        // Dynamic categories are saved searches over tags, so editing tags can
        // move an archive in or out of one.
        if let Ok(connection) = database.connection.lock() {
            let _ = invalidate_category_cache(&connection, &server_id);
        }
    }
    Ok(CommandResult::success(record))
}

#[tauri::command]
pub async fn list_metadata_plugins(
    server_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<serde_json::Value>, String> {
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|c| server_connection(&c, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let url = format!("{}/api/plugins/metadata", base_url.trim_end_matches('/'));
    let response = match reader_request(reqwest::Method::GET, url, api_key).await {
        Ok(response) => response,
        Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
    };
    if !response.status().is_success() {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            format!("LANraragi request failed ({})", response.status()),
            response.status().is_server_error(),
        ));
    }
    match response.json::<serde_json::Value>().await {
        Ok(value) => Ok(CommandResult::success(value)),
        Err(error) => Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            error.to_string(),
            false,
        )),
    }
}

#[tauri::command]
pub async fn use_metadata_plugin(
    server_id: String,
    archive_id: String,
    plugin: String,
    arg: String,
    database: State<'_, Database>,
) -> Result<CommandResult<serde_json::Value>, String> {
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|c| server_connection(&c, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let mut url = match Url::parse(&format!(
        "{}/api/plugins/use",
        base_url.trim_end_matches('/')
    )) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                error.to_string(),
                false,
            ))
        }
    };
    url.query_pairs_mut()
        .append_pair("id", &archive_id)
        .append_pair("plugin", &plugin)
        .append_pair("arg", &arg);
    let response = match reader_request(reqwest::Method::POST, url.to_string(), api_key).await {
        Ok(response) => response,
        Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
    };
    if !response.status().is_success() {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            format!("LANraragi request failed ({})", response.status()),
            response.status().is_server_error(),
        ));
    }
    match response.json::<serde_json::Value>().await {
        Ok(value) => Ok(CommandResult::success(value)),
        Err(error) => Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            error.to_string(),
            false,
        )),
    }
}

#[tauri::command]
pub async fn load_archive_metadata(
    server_id: String,
    archive_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<ArchiveMetadataRecord>, String> {
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|connection| server_connection(&connection, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let url = format!(
        "{}/api/archives/{}/metadata",
        base_url.trim_end_matches('/'),
        archive_id
    );
    let response = match reader_request(reqwest::Method::GET, url, api_key).await {
        Ok(response) => response,
        Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
    };
    let status = response.status();
    if matches!(
        status,
        reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::NOT_FOUND
    ) {
        let reconciliation = database
            .connection
            .lock()
            .map_err(|_| "Database lock failed".to_string())
            .and_then(|connection| {
                reconcile_missing_archive_status(&connection, &server_id, &archive_id, status)
            });
        if let Err(error) = reconciliation {
            return Ok(CommandResult::failure("UNKNOWN", error, true));
        }
        return Ok(CommandResult::failure(
            "LRR_NOT_FOUND",
            "该档案已从 LANraragi 移除",
            false,
        ));
    }
    if !response.status().is_success() {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            format!("LANraragi request failed ({})", response.status()),
            response.status().is_server_error(),
        ));
    }
    let wire: ArchiveMetadataWire = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                error.to_string(),
                false,
            ))
        }
    };
    if wire.progress < 0 || wire.pagecount < 0 || wire.lastreadtime < 0 || wire.size < 0 {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "Invalid LANraragi archive metadata",
            false,
        ));
    }
    Ok(CommandResult::success(ArchiveMetadataRecord {
        archive_id: wire.arcid,
        title: wire.title,
        filename: wire.filename,
        tags: wire.tags,
        summary: wire.summary,
        extension: wire.extension,
        progress: wire.progress,
        page_count: wire.pagecount,
        last_read_time: wire.lastreadtime,
        size: wire.size,
    }))
}

#[tauri::command]
pub async fn download_archive(
    app: tauri::AppHandle,
    server_id: String,
    archive_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<String>, String> {
    if archive_id.len() != 40 || !archive_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "Invalid archive ID",
            false,
        ));
    }
    let (base_url, scope_id, directory) = {
        let connection = database
            .connection
            .lock()
            .map_err(|_| "Database lock failed".to_string())?;
        let (base_url, scope_id) = server_connection(&connection, &server_id)?;
        let preferences = crate::settings::load_preferences_from(&connection)?;
        let directory = if preferences.download_directory.is_empty() {
            crate::inference::model_data_dir(&app)
                .map_err(|error| error.to_string())?
                .join("downloads")
        } else {
            std::path::PathBuf::from(preferences.download_directory)
        };
        (base_url, scope_id, directory)
    };
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let api_key = SystemCredentialStore
            .get_server_api_key(&scope_id)
            .map_err(credential_read_error)?;
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(3600))
            .build()
            .map_err(|error| error.to_string())?;
        let url = format!(
            "{}/api/archives/{}",
            base_url.trim_end_matches('/'),
            archive_id
        );
        let metadata: serde_json::Value = client
            .get(format!("{url}/metadata"))
            .header(
                reqwest::header::AUTHORIZATION,
                authorization_value(&api_key),
            )
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .and_then(reqwest::blocking::Response::json)
            .map_err(|error| error.to_string())?;
        let filename = archive_download_filename(&archive_id, &metadata);
        let mut response = client
            .get(format!("{url}/download"))
            .header(
                reqwest::header::AUTHORIZATION,
                authorization_value(&api_key),
            )
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| error.to_string())?;
        if response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("json") || value.contains("text/html"))
        {
            return Err("Server returned an error page instead of an archive".into());
        }
        save_archive_download(&mut response, &directory, &filename)
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(match result {
        Ok(path) => CommandResult::success(path),
        Err(error) => CommandResult::failure("REMOTE_UNAVAILABLE", error, true),
    })
}

fn archive_download_filename(archive_id: &str, metadata: &serde_json::Value) -> String {
    let filename = metadata["filename"].as_str().unwrap_or_default();
    let extension = std::path::Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .or_else(|| metadata["extension"].as_str())
        .unwrap_or("zip")
        .trim_start_matches('.');
    let extension = if !extension.is_empty()
        && extension.len() <= 10
        && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        extension
    } else {
        "zip"
    };
    let mut title = String::new();
    for ch in metadata["title"].as_str().unwrap_or("archive").chars() {
        let ch = if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
            '_'
        } else {
            ch
        };
        if title.len() + ch.len_utf8() > 160 {
            break;
        }
        title.push(ch);
    }
    format!(
        "{}-{}.{}",
        archive_id,
        title.trim_end_matches([' ', '.']),
        extension
    )
}

fn save_archive_download(
    source: &mut impl std::io::Read,
    directory: &std::path::Path,
    filename: &str,
) -> Result<String, String> {
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
    let bytes =
        std::io::copy(source, temporary.as_file_mut()).map_err(|error| error.to_string())?;
    if bytes == 0 {
        return Err("Server returned an empty archive".into());
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    publish_archive_download(temporary, directory, filename)
}

#[cfg(test)]
mod archive_download_tests {
    use super::*;

    #[test]
    fn filenames_keep_format_and_cannot_escape_directory() {
        let metadata = serde_json::json!({"filename": "original.cbr", "title": format!("../CON:<bad> {}", "漫画".repeat(100))});
        let filename = archive_download_filename(&"a".repeat(40), &metadata);
        assert!(filename.ends_with(".cbr"));
        assert!(filename.len() < 240);
        assert!(!filename.contains('/') && !filename.contains('\\') && !filename.contains(':'));
    }

    #[test]
    fn repeated_download_preserves_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let first =
            save_archive_download(&mut &b"first"[..], directory.path(), "archive.zip").unwrap();
        let second =
            save_archive_download(&mut &b"second"[..], directory.path(), "archive.zip").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(first).unwrap(), b"first");
        assert_eq!(std::fs::read(second).unwrap(), b"second");
    }

    #[test]
    fn failed_download_leaves_no_partial_archive() {
        struct Interrupted;
        impl std::io::Read for Interrupted {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("connection closed"))
            }
        }
        let directory = tempfile::tempdir().unwrap();
        assert!(save_archive_download(&mut Interrupted, directory.path(), "archive.zip").is_err());
        assert!(save_archive_download(&mut &b""[..], directory.path(), "archive.zip").is_err());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
}

fn publish_archive_download(
    temporary: tempfile::NamedTempFile,
    directory: &std::path::Path,
    filename: &str,
) -> Result<String, String> {
    let mut temporary = temporary;
    for suffix in 0..1000 {
        let name = if suffix == 0 {
            filename.to_string()
        } else {
            let path = std::path::Path::new(filename);
            format!(
                "{} ({suffix}).{}",
                path.file_stem().unwrap_or_default().to_string_lossy(),
                path.extension().unwrap_or_default().to_string_lossy()
            )
        };
        let destination = directory.join(name);
        match temporary.persist_noclobber(&destination) {
            Ok(_) => return Ok(destination.to_string_lossy().into_owned()),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                temporary = error.file
            }
            Err(error) => return Err(error.error.to_string()),
        }
    }
    Err("Too many existing copies of this archive".into())
}

#[tauri::command]
pub async fn delete_archive(
    server_id: String,
    archive_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<()>, String> {
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|connection| server_connection(&connection, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let url = format!(
        "{}/api/archives/{}",
        base_url.trim_end_matches('/'),
        archive_id
    );
    let response = match reader_request(reqwest::Method::DELETE, url, api_key).await {
        Ok(response) => response,
        Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
    };
    if !response.status().is_success() {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            format!("LANraragi request failed ({})", response.status()),
            response.status().is_server_error(),
        ));
    }
    let operation: serde_json::Value = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                error.to_string(),
                false,
            ))
        }
    };
    if operation["success"].as_i64() != Some(1) {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            operation["error"]
                .as_str()
                .unwrap_or("LANraragi did not confirm deletion"),
            false,
        ));
    }
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => {
            return Ok(CommandResult::failure(
                "UNKNOWN",
                "Database lock failed",
                true,
            ))
        }
    };
    if let Err(error) = connection.execute(
        "UPDATE archives SET is_deleted = 1, local_updated_at = CURRENT_TIMESTAMP WHERE server_id = ?1 AND archive_id = ?2",
        params![server_id, archive_id],
    ) {
        return Ok(CommandResult::failure("UNKNOWN", error.to_string(), true));
    }
    // A static category still lists the id it was holding.
    let _ = invalidate_category_cache(&connection, &server_id);
    Ok(CommandResult::success(()))
}

pub(crate) async fn delete_archive_with_favorite_sync(
    server_id: String,
    archive_id: String,
    sync_favorite: bool,
    database: State<'_, Database>,
) -> Result<CommandResult<()>, String> {
    if sync_favorite {
        let metadata =
            match load_archive_metadata(server_id.clone(), archive_id.clone(), database.clone())
                .await?
            {
                CommandResult::Success { value, .. } => value,
                CommandResult::Failure { error, .. } => {
                    return Ok(CommandResult::Failure { ok: false, error })
                }
            };
        if let Some((gallery_id, token)) = eh_gallery_from_tags(&metadata.tags) {
            let account_id = {
                let connection = database
                    .connection
                    .lock()
                    .map_err(|_| "Database lock failed".to_string())?;
                connection
                    .query_row(
                        "SELECT id FROM eh_accounts WHERE is_active=1 ORDER BY id LIMIT 1",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?
            };
            let Some(account_id) = account_id else {
                return Ok(CommandResult::failure(
                    "EH_REAUTH_REQUIRED",
                    "请先登录 E-Hentai，或关闭本次收藏同步删除",
                    false,
                ));
            };
            match crate::commands::eh::remove_eh_favorite(
                account_id,
                gallery_id,
                token,
                database.clone(),
            )
            .await?
            {
                CommandResult::Success { .. } => (),
                failure @ CommandResult::Failure { .. } => return Ok(failure),
            }
        }
    }
    delete_archive(server_id, archive_id, database).await
}

fn eh_gallery_from_tags(tags: &str) -> Option<(String, String)> {
    tags.split(',').find_map(|tag| {
        let (namespace, source) = tag.trim().split_once(':')?;
        if !namespace.trim().eq_ignore_ascii_case("source") {
            return None;
        }
        let source = source.trim();
        let source = if source.contains("://") {
            source.to_string()
        } else {
            format!("https://{source}")
        };
        let url = Url::parse(&source).ok()?;
        if !matches!(url.scheme(), "http" | "https")
            || !matches!(url.host_str(), Some("e-hentai.org" | "exhentai.org"))
        {
            return None;
        }
        let segments: Vec<_> = url.path().trim_matches('/').split('/').collect();
        if segments.len() != 3
            || segments[0] != "g"
            || segments[1].is_empty()
            || segments[2].is_empty()
            || !segments[1].bytes().all(|byte| byte.is_ascii_digit())
            || !segments[2].bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return None;
        }
        Some((segments[1].to_string(), segments[2].to_string()))
    })
}

#[tauri::command]
pub async fn load_reader_manifest(
    server_id: String,
    archive_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<ReaderManifest>, String> {
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|connection| server_connection(&connection, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let title = database
        .connection
        .lock()
        .ok()
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT title FROM archives WHERE server_id = ?1 AND archive_id = ?2",
                    params![server_id, archive_id],
                    |row| row.get(0),
                )
                .ok()
        })
        .unwrap_or_else(|| archive_id.clone());
    let url = format!(
        "{}/api/archives/{}/files",
        base_url.trim_end_matches('/'),
        archive_id
    );
    let response = match reader_request(reqwest::Method::GET, url, api_key).await {
        Ok(response) => response,
        Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
    };
    if !response.status().is_success() {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            format!("LANraragi request failed ({})", response.status()),
            response.status().is_server_error(),
        ));
    }
    let pages = match parse_reader_file_list(&match response.text().await {
        Ok(body) => body,
        Err(error) => {
            return Ok(CommandResult::failure(
                "REMOTE_UNAVAILABLE",
                error.to_string(),
                true,
            ))
        }
    }) {
        Ok(pages) => pages,
        Err(error) => return Ok(CommandResult::failure("INVALID_RESPONSE", error, false)),
    };
    Ok(CommandResult::success(ReaderManifest {
        archive_id,
        title,
        pages,
    }))
}

#[tauri::command]
pub async fn load_reader_page(
    server_id: String,
    archive_id: String,
    page_index: i64,
    path: String,
    database: State<'_, Database>,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    load_reader_page_bytes(server_id, archive_id, page_index, path, database, app)
        .await
        .map(crate::domain::result::into_binary_response)
}

async fn load_reader_page_bytes(
    server_id: String,
    archive_id: String,
    page_index: i64,
    path: String,
    database: State<'_, Database>,
    app: tauri::AppHandle,
) -> Result<CommandResult<Vec<u8>>, String> {
    if page_index < 0 {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "Invalid reader page index",
            false,
        ));
    }
    let path = match normalize_reader_page_path(&path) {
        Ok(path) => path,
        Err(error) => return Ok(CommandResult::failure("INVALID_RESPONSE", error, false)),
    };
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|connection| server_connection(&connection, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let app_data = match crate::data_paths::data_dir(&app) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                error.to_string(),
                true,
            ))
        }
    };
    let cached = database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|connection| {
            load_reader_page_cache(&connection, &app_data, &scope_id, &archive_id, page_index)
        });
    match cached {
        Ok(Some(bytes)) => return Ok(CommandResult::success(bytes)),
        Ok(None) => {}
        Err(error) => return Ok(CommandResult::failure("UNKNOWN", error, true)),
    }
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let mut url = match Url::parse(&format!(
        "{}/api/archives/{}/page",
        base_url.trim_end_matches('/'),
        archive_id
    )) {
        Ok(url) => url,
        Err(error) => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                error.to_string(),
                false,
            ))
        }
    };
    url.query_pairs_mut().append_pair("path", &path);
    let response = match reader_request(reqwest::Method::GET, url.to_string(), api_key).await {
        Ok(response) => response,
        Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
    };
    if !response.status().is_success() {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            format!("LANraragi request failed ({})", response.status()),
            response.status().is_server_error(),
        ));
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    match response.bytes().await {
        Ok(bytes) => {
            if let Ok(connection) = database.connection.lock() {
                // A failed cache write means every later read re-fetches, so it
                // must not vanish silently.
                if let Err(error) = store_reader_page_cache(
                    &connection,
                    &app_data,
                    &scope_id,
                    &archive_id,
                    page_index,
                    &mime,
                    &bytes,
                ) {
                    eprintln!("yomika: reader page cache write failed: {error}");
                }
            }
            Ok(CommandResult::success(bytes.to_vec()))
        }
        Err(error) => Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            error.to_string(),
            true,
        )),
    }
}

#[tauri::command]
pub async fn load_archive_thumbnail(
    server_id: String,
    archive_id: String,
    database: State<'_, Database>,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    load_archive_thumbnail_bytes(server_id, archive_id, database, app)
        .await
        .map(crate::domain::result::into_binary_response)
}

pub(crate) async fn load_archive_thumbnail_bytes(
    server_id: String,
    archive_id: String,
    database: State<'_, Database>,
    app: tauri::AppHandle,
) -> Result<CommandResult<Vec<u8>>, String> {
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|c| server_connection(&c, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let app_data = match crate::data_paths::data_dir(&app) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                error.to_string(),
                true,
            ))
        }
    };
    let cache_identity = crate::cache::CacheImageIdentity::new(&scope_id, &archive_id, "cover", 0);
    match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|connection| {
            crate::cache::load_image_cache(&connection, &app_data, &cache_identity)
        }) {
        Ok(Some(image)) => return Ok(CommandResult::success(image.bytes)),
        Ok(None) => {}
        Err(error) => return Ok(CommandResult::failure("UNKNOWN", error, true)),
    }
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    // Cover requests use the normal thumbnail endpoint. The
    // no_fallback flag is reserved for page thumbnails where extraction is
    // explicitly queued; cover requests should return an existing fallback
    // immediately instead of waiting for a Minion job.
    let url = format!(
        "{}/api/archives/{}/thumbnail",
        base_url.trim_end_matches('/'),
        archive_id
    );
    let response = match reader_request(reqwest::Method::GET, url.clone(), api_key.clone()).await {
        Ok(response) => response,
        Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
    };
    let response = if response.status().as_u16() == 202 {
        let job_id = response
            .bytes()
            .await
            .ok()
            .and_then(|body| serde_json::from_slice::<serde_json::Value>(&body).ok())
            .and_then(|value| {
                let job = value.get("job").cloned().unwrap_or(value);
                job.as_i64()
                    .or_else(|| job.as_str().and_then(|value| value.parse::<i64>().ok()))
            });
        if let Some(job_id) = job_id {
            let mut finished = false;
            for _ in 0..60 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let status_url =
                    format!("{}/api/minion/{}", base_url.trim_end_matches('/'), job_id);
                let status =
                    match reader_request(reqwest::Method::GET, status_url, api_key.clone()).await {
                        Ok(value) => value,
                        Err(_) => continue,
                    };
                let state = status
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|value| {
                        value
                            .get("state")
                            .and_then(|state| state.as_str())
                            .map(str::to_owned)
                    });
                if state.as_deref() == Some("finished") {
                    finished = true;
                    break;
                }
                if matches!(state.as_deref(), Some("failed") | Some("error")) {
                    return Ok(CommandResult::failure(
                        "REMOTE_UNAVAILABLE",
                        "LANraragi 缩略图生成失败",
                        true,
                    ));
                }
            }
            if !finished {
                return Ok(CommandResult::failure(
                    "REMOTE_UNAVAILABLE",
                    "LANraragi 缩略图生成超时",
                    true,
                ));
            }
            match reader_request(reqwest::Method::GET, url, api_key).await {
                Ok(value) => value,
                Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
            }
        } else {
            return Ok(CommandResult::failure(
                "REMOTE_UNAVAILABLE",
                "LANraragi 未返回缩略图任务编号",
                true,
            ));
        }
    } else {
        response
    };
    if !response.status().is_success() {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            format!("LANraragi request failed ({})", response.status()),
            response.status().is_server_error(),
        ));
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    match response.bytes().await {
        Ok(bytes) => {
            if let Ok(connection) = database.connection.lock() {
                if let Err(error) = crate::cache::store_image_cache(
                    &connection,
                    &app_data,
                    &cache_identity,
                    &mime,
                    &bytes,
                ) {
                    eprintln!("yomika: image cache write failed: {error}");
                }
            }
            Ok(CommandResult::success(bytes.to_vec()))
        }
        Err(error) => Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            error.to_string(),
            true,
        )),
    }
}

/// Load a single page thumbnail. LANraragi may queue extraction and return a
/// Minion job; wait for that job before retrying the binary request.
#[tauri::command]
pub async fn load_archive_page_thumbnail(
    server_id: String,
    archive_id: String,
    page: i64,
    database: State<'_, Database>,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    load_archive_page_thumbnail_bytes(server_id, archive_id, page, database, app)
        .await
        .map(crate::domain::result::into_binary_response)
}

async fn load_archive_page_thumbnail_bytes(
    server_id: String,
    archive_id: String,
    page: i64,
    database: State<'_, Database>,
    app: tauri::AppHandle,
) -> Result<CommandResult<Vec<u8>>, String> {
    if page < 1 {
        return Ok(CommandResult::failure(
            "INVALID_INPUT",
            "页码必须大于 0",
            false,
        ));
    }
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|c| server_connection(&c, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let app_data = match crate::data_paths::data_dir(&app) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                error.to_string(),
                true,
            ))
        }
    };
    let cache_identity =
        crate::cache::CacheImageIdentity::new(&scope_id, &archive_id, "page-thumbnail", page - 1);
    match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|connection| {
            crate::cache::load_image_cache(&connection, &app_data, &cache_identity)
        }) {
        Ok(Some(image)) => return Ok(CommandResult::success(image.bytes)),
        Ok(None) => {}
        Err(error) => return Ok(CommandResult::failure("UNKNOWN", error, true)),
    }
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let bytes = match fetch_page_thumbnail(&base_url, &archive_id, page, api_key, 60).await {
        Ok(CommandResult::Success { value, .. }) => value,
        other => return other,
    };
    if let Ok(connection) = database.connection.lock() {
        if let Err(error) = crate::cache::store_image_cache(
            &connection,
            &app_data,
            &cache_identity,
            "application/octet-stream",
            &bytes,
        ) {
            eprintln!("yomika: image cache write failed: {error}");
        }
    }
    Ok(CommandResult::success(bytes))
}

async fn fetch_page_thumbnail(
    base_url: &str,
    archive_id: &str,
    page: i64,
    api_key: String,
    poll_attempts: usize,
) -> Result<CommandResult<Vec<u8>>, String> {
    let thumbnail_url = format!(
        "{}/api/archives/{}/thumbnail?page={}&no_fallback=true",
        base_url.trim_end_matches('/'),
        archive_id,
        page
    );
    let response =
        match reader_request(reqwest::Method::GET, thumbnail_url.clone(), api_key.clone()).await {
            Ok(response) => response,
            Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
        };
    let response = if response.status().as_u16() == 202 {
        let job_id = response
            .bytes()
            .await
            .ok()
            .and_then(|body| serde_json::from_slice::<serde_json::Value>(&body).ok())
            .and_then(|value| {
                let job = value.get("job").cloned().unwrap_or(value);
                job.as_i64()
                    .or_else(|| job.as_str().and_then(|value| value.parse::<i64>().ok()))
            });
        if let Some(job_id) = job_id {
            let mut finished = false;
            for _ in 0..poll_attempts {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let status_url =
                    format!("{}/api/minion/{}", base_url.trim_end_matches('/'), job_id);
                let status =
                    match reader_request(reqwest::Method::GET, status_url, api_key.clone()).await {
                        Ok(value) => value,
                        Err(_) => continue,
                    };
                let state = status
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|value| {
                        value
                            .get("state")
                            .and_then(|state| state.as_str())
                            .map(str::to_owned)
                    });
                if matches!(state.as_deref(), Some("finished")) {
                    finished = true;
                    break;
                }
                if matches!(state.as_deref(), Some("failed") | Some("error")) {
                    return Ok(CommandResult::failure(
                        "REMOTE_UNAVAILABLE",
                        "LANraragi 缩略图生成失败",
                        true,
                    ));
                }
            }
            if !finished {
                return Ok(CommandResult::failure(
                    "REMOTE_UNAVAILABLE",
                    "LANraragi thumbnail generation timed out",
                    true,
                ));
            }
            match reader_request(reqwest::Method::GET, thumbnail_url, api_key).await {
                Ok(value) => value,
                Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
            }
        } else {
            return Ok(CommandResult::failure(
                "REMOTE_UNAVAILABLE",
                "LANraragi 未返回缩略图任务编号",
                true,
            ));
        }
    } else {
        response
    };
    if response.status() == reqwest::StatusCode::ACCEPTED {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            "LANraragi thumbnail is not ready",
            true,
        ));
    }
    if !response.status().is_success() {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            format!("LANraragi request failed ({})", response.status()),
            response.status().is_server_error(),
        ));
    }
    match response.bytes().await {
        Ok(bytes)
            if crate::cache::sniff_image_mime("application/octet-stream", &bytes).is_some() =>
        {
            Ok(CommandResult::success(bytes.to_vec()))
        }
        Ok(_) => Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "LANraragi thumbnail response is not an image",
            true,
        )),
        Err(error) => Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            error.to_string(),
            true,
        )),
    }
}

fn authorization_value(api_key: &str) -> String {
    format!("Bearer {}", BASE64_STANDARD.encode(api_key.as_bytes()))
}

/// The whole `/api/search` answer: the rows plus the counts a client needs to
/// page. `recordsFiltered` is the size of the result set the query selected, so
/// it — not a local `COUNT(*)` — is what "how many pages are there" means.
fn parse_search_page(json: &str) -> Result<(Vec<RemoteArchive>, i64, i64), String> {
    let response: SearchResponseWire =
        serde_json::from_str(json).map_err(|error| error.to_string())?;
    if response.records_filtered < 0 || response.records_total < 0 {
        return Err("Invalid LANraragi result counts".to_string());
    }
    let (filtered, total) = (response.records_filtered, response.records_total);
    Ok((parse_archive_entries(response.data)?, filtered, total))
}

fn parse_search_response(json: &str) -> Result<Vec<RemoteArchive>, String> {
    parse_search_page(json).map(|(archives, _, _)| archives)
}

/// `/api/search/random` answers with `{ "data": [...] }` and no result counts.
fn parse_random_response(json: &str) -> Result<Vec<RemoteArchive>, String> {
    let response: RandomResponseWire =
        serde_json::from_str(json).map_err(|error| error.to_string())?;
    parse_archive_entries(response.data)
}

fn parse_archive_entries(entries: Vec<SearchArchiveWire>) -> Result<Vec<RemoteArchive>, String> {
    entries
        .into_iter()
        .map(|archive| {
            let valid_id = (archive.arcid.len() == 40
                && archive
                    .arcid
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
                || (archive.arcid.len() == 15
                    && archive.arcid.starts_with("TANK_")
                    && archive.arcid[5..].bytes().all(|byte| byte.is_ascii_digit()));
            if !valid_id || archive.pagecount < 0 || archive.size < 0 {
                return Err("Invalid LANraragi archive metadata".to_string());
            }
            Ok(RemoteArchive {
                archive_id: archive.arcid,
                title: archive.title,
                summary: archive.summary,
                tags: archive
                    .tags
                    .split(',')
                    .map(str::trim)
                    .filter(|tag| !tag.is_empty())
                    .map(str::to_string)
                    .collect(),
                page_count: archive.pagecount,
                size: archive.size,
            })
        })
        .collect()
}

fn query_archive_records(
    connection: &rusqlite::Connection,
    server_id: &str,
) -> Result<Vec<ArchiveRecord>, String> {
    let mut statement = connection.prepare(
        "SELECT server_id, archive_id, title, page_count, file_size, summary, category, language, cover_page, is_deleted, local_updated_at, tags_json, COALESCE(added_at, first_seen_at)
         FROM archives WHERE server_id = ?1 AND is_deleted = 0
         ORDER BY COALESCE(added_at, first_seen_at, 0) DESC, archive_id ASC",
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([server_id], |row| {
            let tags = archive_tags(row.get::<_, String>(11)?);
            Ok(ArchiveRecord {
                server_id: row.get(0)?,
                archive_id: row.get(1)?,
                title: row.get(2)?,
                page_count: row.get(3)?,
                file_size: row.get::<_, Option<i64>>(4)?,
                summary: row.get(5)?,
                category: row.get(6)?,
                language: row.get(7)?,
                cover_page: row.get(8)?,
                is_deleted: row.get::<_, i64>(9)? != 0,
                updated_at: row.get(10)?,
                added_at: row
                    .get::<_, Option<i64>>(12)?
                    .or_else(|| archive_added_at(&tags)),
                tags,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn archive_tags(tags_json: String) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default()
}

fn archive_added_at(tags: &[String]) -> Option<i64> {
    tags.iter().find_map(|tag| {
        tag.strip_prefix("date_added:")
            .and_then(|value| value.parse::<i64>().ok())
    })
}

fn archive_search_token(value: &str) -> String {
    // SQLite's LOWER() only folds A-Z, so the pattern must fold the same way.
    // Rust's full Unicode to_lowercase() turned a typed "É" into "é" and then
    // never matched the stored "É" that LOWER() had left untouched.
    value
        .trim()
        .trim_end_matches('$')
        .to_ascii_lowercase()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn query_archive_page(
    connection: &rusqlite::Connection,
    input: &ArchiveQueryInput,
) -> Result<ArchivePage, String> {
    if !matches!(input.sort_by.as_str(), "title" | "added")
        || !matches!(input.order.as_str(), "asc" | "desc")
    {
        return Err("Invalid archive query ordering".to_string());
    }
    let safe_offset = input.offset.max(0);
    let safe_limit = input.limit.clamp(1, 200);
    let mut clauses = vec![
        "a.server_id = ?".to_string(),
        "a.is_deleted = 0".to_string(),
    ];
    let mut values = vec![input.server_id.clone()];
    if let Some(category_id) = input
        .category_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        clauses.push(
            "EXISTS (SELECT 1 FROM archive_categories ac WHERE ac.server_id = a.server_id AND ac.archive_id = a.archive_id AND ac.category_id = ?)"
                .to_string(),
        );
        values.push(category_id.to_string());
    }
    if input.untagged_only.unwrap_or(false) {
        // The column is NOT NULL and CHECK-constrained to valid JSON, so an
        // untagged archive is one whose array is empty — which is a length test,
        // not a string comparison against every way `[]` could be spelled.
        clauses.push("json_array_length(a.tags_json) = 0".to_string());
    }
    for token in input
        .query
        .split(',')
        .map(archive_search_token)
        .filter(|token| !token.is_empty())
    {
        let pattern = format!("%{token}%");
        if token.contains(':') {
            clauses.push("LOWER(a.tags_json) LIKE ? ESCAPE '\\'".to_string());
            values.push(pattern);
        } else {
            clauses.push(
                "(LOWER(a.title) LIKE ? ESCAPE '\\' OR LOWER(a.tags_json) LIKE ? ESCAPE '\\')"
                    .to_string(),
            );
            values.push(pattern.clone());
            values.push(pattern);
        }
    }
    let where_sql = clauses.join(" AND ");
    let total_sql = format!("SELECT COUNT(*) FROM archives a WHERE {where_sql}");
    let total: i64 = connection
        .query_row(&total_sql, params_from_iter(values.iter()), |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    let direction = if input.order == "asc" { "ASC" } else { "DESC" };
    let sort = if input.sort_by == "title" {
        "a.title_sort COLLATE NOCASE"
    } else {
        // Stored column, not a json_each scan over tags: the date_added
        // namespace can be excluded server-side, and per-row scanning made the
        // sort O(tags) for every archive.
        "COALESCE(a.added_at, a.first_seen_at, 0)"
    };
    let page_sql = format!(
        "SELECT a.server_id, a.archive_id, a.title, a.page_count, a.file_size, a.summary, a.category, a.language, a.cover_page, a.is_deleted, a.local_updated_at, a.tags_json, COALESCE(a.added_at, a.first_seen_at)
         FROM archives a WHERE {where_sql} ORDER BY {sort} {direction}, a.archive_id ASC LIMIT {safe_limit} OFFSET {safe_offset}"
    );
    let mut statement = connection
        .prepare(&page_sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(values.iter()), |row| {
            let tags = archive_tags(row.get::<_, String>(11)?);
            Ok(ArchiveRecord {
                server_id: row.get(0)?,
                archive_id: row.get(1)?,
                title: row.get(2)?,
                page_count: row.get(3)?,
                file_size: row.get::<_, Option<i64>>(4)?,
                summary: row.get(5)?,
                category: row.get(6)?,
                language: row.get(7)?,
                cover_page: row.get(8)?,
                is_deleted: row.get::<_, i64>(9)? != 0,
                updated_at: row.get(10)?,
                added_at: row
                    .get::<_, Option<i64>>(12)?
                    .or_else(|| archive_added_at(&tags)),
                tags,
            })
        })
        .map_err(|error| error.to_string())?;
    let items = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(ArchivePage {
        has_more: safe_offset + (items.len() as i64) < total,
        items,
        total,
    })
}

const ARCHIVE_UPSERT: &str = "INSERT INTO archives (
        server_id, archive_id, title, title_sort, summary, tags_json, page_count, file_size, local_updated_at, metadata_revision, is_deleted, added_at, first_seen_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP, 1, 0, ?9, unixepoch())
      ON CONFLICT(server_id, archive_id) DO UPDATE SET
        title = excluded.title, title_sort = excluded.title_sort, summary = excluded.summary,
        tags_json = excluded.tags_json, page_count = excluded.page_count, file_size = excluded.file_size,
        local_updated_at = CURRENT_TIMESTAMP, metadata_revision = archives.metadata_revision + 1, is_deleted = 0,
        added_at = COALESCE(excluded.added_at, archives.added_at),
        first_seen_at = COALESCE(archives.first_seen_at, excluded.first_seen_at)";

fn upsert_archive_rows(
    transaction: &rusqlite::Transaction<'_>,
    server_id: &str,
    archives: &[RemoteArchive],
) -> Result<(), String> {
    for archive in archives {
        let tags_json = serde_json::to_string(&archive.tags).map_err(|error| error.to_string())?;
        transaction
            .execute(
                ARCHIVE_UPSERT,
                params![
                    server_id,
                    archive.archive_id,
                    archive.title,
                    archive.title.to_lowercase(),
                    archive.summary,
                    tags_json,
                    archive.page_count,
                    archive.size,
                    archive_added_at(&archive.tags),
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn replace_server_archives(
    connection: &mut rusqlite::Connection,
    server_id: &str,
    archives: &[RemoteArchive],
) -> Result<Vec<ArchiveRecord>, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute("UPDATE archives SET is_deleted = 1, local_updated_at = CURRENT_TIMESTAMP WHERE server_id = ?1", [server_id])
        .map_err(|error| error.to_string())?;
    upsert_archive_rows(&transaction, server_id, archives)?;
    transaction.commit().map_err(|error| error.to_string())?;
    query_archive_records(connection, server_id)
}

/// Adds or updates rows without tombstoning anything else. `/api/search/random`
/// returns a handful of archives, so the full-replace path would wipe the index.
fn upsert_server_archives(
    connection: &mut rusqlite::Connection,
    server_id: &str,
    archives: &[RemoteArchive],
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    upsert_archive_rows(&transaction, server_id, archives)?;
    transaction.commit().map_err(|error| error.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceArchivesInput {
    server_id: String,
    search_response_json: String,
}

#[tauri::command]
pub fn replace_archives(
    input: ReplaceArchivesInput,
    database: State<'_, Database>,
) -> CommandResult<Vec<ArchiveRecord>> {
    let archives = match parse_search_response(&input.search_response_json) {
        Ok(archives) => archives,
        Err(error) => return CommandResult::failure("INVALID_RESPONSE", error, false),
    };
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match replace_server_archives(&mut connection, &input.server_id, &archives) {
        Ok(records) => CommandResult::success(records),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshSearchParams {
    filter: Option<String>,
    start: Option<i64>,
    sortby: Option<String>,
    order: Option<String>,
    newonly: Option<bool>,
    untaggedonly: Option<bool>,
    hidecompleted: Option<bool>,
    category: Option<String>,
    groupby_tanks: Option<bool>,
}

/// Dynamic categories are resolved through the same search endpoint, so they go
/// through the same builder: LANraragi reads `sortby` without a default, and a
/// missing one both floods its log with "uninitialized value $sortkey" and
/// defeats its search cache (every request becomes a full DB parse).
fn build_category_search_url(base_url: &str, filter: &str) -> Result<String, String> {
    let params = RefreshSearchParams {
        filter: Some(filter.to_string()),
        start: Some(-1),
        sortby: None,
        order: None,
        newonly: None,
        untaggedonly: None,
        hidecompleted: None,
        category: None,
        groupby_tanks: None,
    };
    build_refresh_search_url(base_url, &params)
}

/// How long a resolved category snapshot stays good. Long enough that browsing
/// never re-resolves, short enough that a category edited in LANraragi shows up
/// without a manual refresh.
const CATEGORY_CACHE_MAX_AGE_SECONDS: i64 = 6 * 60 * 60;
/// The same, for a snapshot in which at least one dynamic category could not be
/// resolved. A failed resolution is stored as an empty membership, which is
/// indistinguishable from "this category is empty" — keeping that for six hours
/// hides every archive in it, so it is retried sooner instead.
const PARTIAL_CATEGORY_CACHE_MAX_AGE_SECONDS: i64 = 10 * 60;

fn category_cache_key(server_id: &str) -> String {
    format!("categories.cache.{server_id}")
}

#[derive(Serialize, Deserialize)]
struct CategoryCacheEnvelope {
    synced_at: i64,
    categories: Vec<CategoryRecord>,
    /// Absent in snapshots written before this field existed; those were only
    /// written on a complete resolution, so treating them as complete is right.
    #[serde(default)]
    partial: bool,
}

fn read_category_cache(
    database: &State<'_, Database>,
    server_id: &str,
) -> Result<Option<Vec<CategoryRecord>>, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "数据库锁定失败".to_string())?;
    read_category_cache_from(&connection, server_id, current_unix_seconds())
}

fn read_category_cache_from(
    connection: &rusqlite::Connection,
    server_id: &str,
    now: i64,
) -> Result<Option<Vec<CategoryRecord>>, String> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT value_json FROM settings WHERE key = ?1",
            [category_cache_key(server_id)],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取分类缓存失败：{error}"))?;
    let Some(stored) = stored else {
        return Ok(None);
    };
    let envelope: CategoryCacheEnvelope = match serde_json::from_str(&stored) {
        Ok(value) => value,
        // A snapshot written by an older schema is simply refetched.
        Err(_) => return Ok(None),
    };
    let max_age = if envelope.partial {
        PARTIAL_CATEGORY_CACHE_MAX_AGE_SECONDS
    } else {
        CATEGORY_CACHE_MAX_AGE_SECONDS
    };
    let age = now.saturating_sub(envelope.synced_at);
    if age < 0 || age > max_age {
        return Ok(None);
    }
    Ok(Some(envelope.categories))
}

fn write_category_cache(
    connection: &rusqlite::Connection,
    server_id: &str,
    categories: &[CategoryRecord],
    partial: bool,
) -> Result<(), String> {
    let envelope = CategoryCacheEnvelope {
        synced_at: current_unix_seconds(),
        categories: categories.to_vec(),
        partial,
    };
    let payload =
        serde_json::to_string(&envelope).map_err(|error| format!("序列化分类缓存失败：{error}"))?;
    connection
        .execute(
            "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            params![category_cache_key(server_id), payload],
        )
        .map_err(|error| format!("写入分类缓存失败：{error}"))?;
    Ok(())
}

/// Assigning an archive to a category changes what that category holds, so the
/// snapshot taken for the 6-hour window is wrong the moment the assignment
/// lands. Dropping the row makes the next read refetch rather than serve a
/// category that is missing the archive just added to it.
fn invalidate_category_cache(
    connection: &rusqlite::Connection,
    server_id: &str,
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM settings WHERE key = ?1",
            [category_cache_key(server_id)],
        )
        .map(|_| ())
        .map_err(|error| format!("清除分类缓存失败：{error}"))
}

fn current_unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

fn build_refresh_search_url(
    base_url: &str,
    params: &RefreshSearchParams,
) -> Result<String, String> {
    let trimmed = base_url.trim_end_matches('/');
    let mut query: Vec<String> = Vec::new();

    // `start` is an item offset. `-1` is LANraragi's "the whole library, unpaged"
    // escape hatch, and it is never a safe default: against a large library the
    // response cannot finish inside the request timeout. Callers that genuinely
    // want every row ask for it explicitly.
    let start_value = params.start.unwrap_or(0);
    query.push(format!("start={}", start_value));

    if let Some(ref filter) = params.filter {
        query.push(format!(
            "filter={}",
            url::form_urlencoded::byte_serialize(filter.as_bytes()).collect::<String>()
        ));
    }
    // LANraragi reads `sortby`/`order` without defaulting them: a missing value
    // leaves $sortkey undefined, which floods the server log with
    // "Use of uninitialized value $sortkey" from Model/Search.pm and falls back
    // to title order. Always send both, defaulting to newest first.
    let sortby = params
        .sortby
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("date_added");
    query.push(format!(
        "sortby={}",
        url::form_urlencoded::byte_serialize(sortby.as_bytes()).collect::<String>()
    ));
    let order = match params.order.as_deref() {
        Some("asc") => "asc",
        _ => "desc",
    };
    query.push(format!("order={}", order));
    if let Some(newonly) = params.newonly {
        query.push(format!("newonly={}", newonly));
    }
    if let Some(untaggedonly) = params.untaggedonly {
        query.push(format!("untaggedonly={}", untaggedonly));
    }
    if let Some(hidecompleted) = params.hidecompleted {
        query.push(format!("hidecompleted={}", hidecompleted));
    }
    if let Some(ref category) = params.category {
        query.push(format!(
            "category={}",
            url::form_urlencoded::byte_serialize(category.as_bytes()).collect::<String>()
        ));
    }
    if let Some(groupby_tanks) = params.groupby_tanks {
        query.push(format!("groupby_tanks={}", groupby_tanks));
    }

    Ok(format!("{}/api/search?{}", trimmed, query.join("&")))
}

/// A failure shaped the way `CommandResult::failure` wants it, so the fetch
/// helpers can report HTTP, transport and decode problems through one channel.
type SearchFailure = (&'static str, String, bool);

/// One page of `/api/search`, plus `recordsFiltered` and `recordsTotal`.
async fn fetch_search_page(
    base_url: &str,
    api_key: &str,
    params: &RefreshSearchParams,
) -> Result<(Vec<RemoteArchive>, i64, i64), SearchFailure> {
    let url = build_refresh_search_url(base_url, params)
        .map_err(|error| ("INVALID_INPUT", error, false))?;
    let response = reader_request(reqwest::Method::GET, url, api_key.to_string())
        .await
        .map_err(|error| ("REMOTE_UNAVAILABLE", error, true))?;
    if let Some(failure) = search_status_failure(response.status()) {
        return Err(failure);
    }
    let body = response
        .text()
        .await
        .map_err(|error| ("INVALID_RESPONSE", error.to_string(), true))?;
    parse_search_page(&body).map_err(|error| ("INVALID_RESPONSE", error, false))
}

/// Walks every page of a query. A server that keeps answering with a full page
/// no matter the offset would otherwise loop forever, so the walk is capped.
const MAX_SYNC_PAGES: usize = 2_000;

/// Whether a page walk has reached the end of the result set.
///
/// A page shorter than the first one is the last one — LANraragi holds its page
/// size constant and only the tail is short. The count check covers the case
/// where every page comes back full because the walk has already consumed
/// everything `recordsFiltered` promised.
fn search_walk_is_done(
    received: usize,
    first_page_size: usize,
    collected: i64,
    filtered: i64,
) -> bool {
    received == 0 || received < first_page_size || collected >= filtered
}

/// Every row a query selects, gathered one page at a time.
///
/// The single-request alternative is `start=-1`, which asks LANraragi to
/// serialise the entire library into one response — for a ten-thousand-archive
/// library that never finishes inside the request timeout, so the pull failed
/// and the local index kept serving whatever it last managed to store. Page size
/// is a server-side preference the client cannot set, so it is learned from the
/// first response rather than assumed.
async fn fetch_all_search_pages(
    base_url: &str,
    api_key: &str,
    params: &RefreshSearchParams,
) -> Result<Vec<RemoteArchive>, SearchFailure> {
    let mut collected: Vec<RemoteArchive> = Vec::new();
    let mut page_size: Option<usize> = None;
    for _ in 0..MAX_SYNC_PAGES {
        let mut page_params = params.clone();
        page_params.start = Some(collected.len() as i64);
        let (archives, filtered, _) = fetch_search_page(base_url, api_key, &page_params).await?;
        let received = archives.len();
        collected.extend(archives);
        // `max(1)` keeps an empty first page from recording a size of zero, which
        // would read as "no page is ever short" and never end the walk.
        let size = *page_size.get_or_insert(received.max(1));
        if search_walk_is_done(received, size, collected.len() as i64, filtered) {
            return Ok(collected);
        }
    }
    Err((
        "REMOTE_UNAVAILABLE",
        "LANraragi search exceeded the page limit before completing the snapshot".into(),
        true,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshArchivesInput {
    server_id: String,
    params: RefreshSearchParams,
}

/// Rebuilds the local offline index from LANraragi.
///
/// This is no longer what makes the library list current — `search_archives_page`
/// reads the server directly for that. What is left is the offline mirror: the
/// rows the shelves and the duplicate finder read when the server is not
/// reachable, which is also the only reason a full walk is worth doing.
#[tauri::command]
pub async fn refresh_archives(
    input: RefreshArchivesInput,
    database: State<'_, Database>,
) -> Result<CommandResult<Vec<ArchiveRecord>>, String> {
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|c| server_connection(&c, &input.server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let archives = match fetch_all_search_pages(&base_url, &api_key, &input.params).await {
        Ok(value) => value,
        Err((code, message, retryable)) => {
            return Ok(CommandResult::failure(code, message, retryable))
        }
    };
    let mut connection = match database.connection.lock() {
        Ok(conn) => conn,
        Err(_) => {
            return Ok(CommandResult::failure(
                "UNKNOWN",
                "Database lock failed".to_string(),
                true,
            ))
        }
    };
    // Tombstoning happens once, after every page is in hand: doing it per page
    // would mark the rest of the library deleted between requests.
    match replace_server_archives(&mut connection, &input.server_id, &archives) {
        Ok(records) => Ok(CommandResult::success(records)),
        Err(error) => Ok(CommandResult::failure("LOCAL_DATABASE", error, true)),
    }
}

/// Shared HTTP status mapping for the LANraragi search endpoints.
fn search_status_failure(status: reqwest::StatusCode) -> Option<(&'static str, String, bool)> {
    match status {
        reqwest::StatusCode::NO_CONTENT => Some((
            "LRR_NOT_FOUND",
            "Search index not ready (204 No Content)".to_string(),
            true,
        )),
        reqwest::StatusCode::UNAUTHORIZED => {
            Some(("LRR_UNAUTHORIZED", "Invalid API key".to_string(), false))
        }
        reqwest::StatusCode::NOT_FOUND => {
            Some(("LRR_NOT_FOUND", "Server not found (404)".to_string(), false))
        }
        reqwest::StatusCode::CONFLICT => Some((
            "REMOTE_CONFLICT",
            "Server conflict (409)".to_string(),
            false,
        )),
        reqwest::StatusCode::TOO_MANY_REQUESTS => {
            Some(("REMOTE_RATE_LIMIT", "Rate limited (429)".to_string(), true))
        }
        _ if status.is_server_error() => Some((
            "REMOTE_UNAVAILABLE",
            format!("Server error ({})", status),
            true,
        )),
        _ if !status.is_success() => Some((
            "REMOTE_UNAVAILABLE",
            format!("Unexpected status ({})", status),
            false,
        )),
        _ => None,
    }
}

/// Newest-first first page, used to detect archives added in LANraragi without
/// paying for the offline index rebuild that `refresh_archives` performs.
fn build_probe_search_url(base_url: &str) -> Result<String, String> {
    build_refresh_search_url(
        base_url,
        &RefreshSearchParams {
            filter: None,
            start: Some(0),
            sortby: Some("date_added".to_string()),
            order: Some("desc".to_string()),
            newonly: None,
            untaggedonly: None,
            hidecompleted: None,
            category: None,
            groupby_tanks: None,
        },
    )
}

/// Archive ids from the probe page that the local index does not know yet.
fn unknown_probe_archive_ids(
    connection: &rusqlite::Connection,
    server_id: &str,
    archive_ids: &[String],
) -> Result<Vec<String>, String> {
    let mut unknown = Vec::new();
    let mut statement = connection
        .prepare(
            "SELECT 1 FROM archives WHERE server_id = ?1 AND archive_id = ?2 AND is_deleted = 0",
        )
        .map_err(|error| error.to_string())?;
    for archive_id in archive_ids {
        let known = statement
            .exists(params![server_id, archive_id])
            .map_err(|error| error.to_string())?;
        if !known {
            unknown.push(archive_id.clone());
        }
    }
    Ok(unknown)
}

/// Reports whether LANraragi holds archives the local index is missing, without
/// pulling the whole library.
#[tauri::command]
pub async fn probe_new_archives(
    server_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<bool>, String> {
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|c| server_connection(&c, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let url = match build_probe_search_url(&base_url) {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("INVALID_INPUT", error, false)),
    };
    let response = match reader_request(reqwest::Method::GET, url, api_key).await {
        Ok(response) => response,
        Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
    };
    if let Some((code, message, retryable)) = search_status_failure(response.status()) {
        return Ok(CommandResult::failure(code, message, retryable));
    }
    let body = match response.text().await {
        Ok(text) => text,
        Err(error) => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                error.to_string(),
                true,
            ))
        }
    };
    let archives = match parse_search_response(&body) {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("INVALID_RESPONSE", error, false)),
    };
    let archive_ids: Vec<String> = archives
        .into_iter()
        .map(|archive| archive.archive_id)
        .collect();
    let connection = match database.connection.lock() {
        Ok(conn) => conn,
        Err(_) => {
            return Ok(CommandResult::failure(
                "UNKNOWN",
                "Database lock failed".to_string(),
                true,
            ))
        }
    };
    match unknown_probe_archive_ids(&connection, &server_id, &archive_ids) {
        Ok(unknown) => Ok(CommandResult::success(!unknown.is_empty())),
        Err(error) => Ok(CommandResult::failure("LOCAL_DATABASE", error, true)),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSearchInput {
    server_id: String,
    #[serde(default)]
    query: String,
    sort_by: String,
    order: String,
    #[serde(default)]
    category_id: Option<String>,
    /// LANraragi's own "untagged only" switch. The library offers it as a
    /// synthetic category, because that is where a user looks for it, but it is
    /// not a category — an archive with no tags is in no category either, so
    /// resolving it as one would return nothing.
    #[serde(default)]
    untagged_only: Option<bool>,
    start: i64,
}

/// LANraragi's sort keys. The UI calls it "added"; the server calls it
/// `date_added`.
fn remote_sort_key(sort_by: &str) -> Option<&'static str> {
    match sort_by {
        "added" | "date_added" => Some("date_added"),
        "title" => Some("title"),
        _ => None,
    }
}

/// The library list, read from LANraragi one page at a time.
///
/// The local index used to *be* the list, so an archive added on the server
/// stayed invisible until a full-library pull happened to succeed — and with
/// `start=-1` against a large library that pull never finished. Here the server
/// owns ordering, filtering and paging, because it is the only party that knows
/// what it currently holds. Rows are upserted on the way through, so the local
/// index keeps working as a cache for covers, the shelves and offline reads.
///
/// `start` is an item offset. Page size is a LANraragi preference the client
/// cannot set, so callers learn it from the length of page zero rather than
/// asking for a size the server will ignore.
#[tauri::command]
pub async fn search_archives_page(
    input: RemoteSearchInput,
    database: State<'_, Database>,
) -> Result<CommandResult<ArchivePage>, String> {
    let Some(sortby) = remote_sort_key(&input.sort_by) else {
        return Ok(CommandResult::failure(
            "INVALID_INPUT",
            "Invalid archive sort key".to_string(),
            false,
        ));
    };
    if !matches!(input.order.as_str(), "asc" | "desc") {
        return Ok(CommandResult::failure(
            "INVALID_INPUT",
            "Invalid archive sort order".to_string(),
            false,
        ));
    }
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|c| server_connection(&c, &input.server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let start = input.start.max(0);
    // The filter and the category go to the server. LANraragi's own search syntax
    // ("$" for an exact tag, "-" to exclude) then works as documented instead of
    // being half-reimplemented in local SQL, and a dynamic category resolves
    // server-side instead of costing the client one unpaged search per category.
    let params = RefreshSearchParams {
        filter: Some(input.query.trim().to_string()).filter(|value| !value.is_empty()),
        start: Some(start),
        sortby: Some(sortby.to_string()),
        order: Some(input.order.clone()),
        newonly: None,
        untaggedonly: input.untagged_only.filter(|value| *value),
        hidecompleted: None,
        category: input.category_id.clone().filter(|value| !value.is_empty()),
        groupby_tanks: None,
    };
    let (archives, filtered, _) = match fetch_search_page(&base_url, &api_key, &params).await {
        Ok(value) => value,
        Err((code, message, retryable)) => {
            return Ok(CommandResult::failure(code, message, retryable))
        }
    };
    let archive_ids: Vec<String> = archives
        .iter()
        .map(|archive| archive.archive_id.clone())
        .collect();
    let mut connection = match database.connection.lock() {
        Ok(conn) => conn,
        Err(_) => {
            return Ok(CommandResult::failure(
                "UNKNOWN",
                "Database lock failed".to_string(),
                true,
            ))
        }
    };
    if let Err(error) = upsert_server_archives(&mut connection, &input.server_id, &archives) {
        return Ok(CommandResult::failure("LOCAL_DATABASE", error, true));
    }
    // Read the rows back instead of mapping the wire payload: `category`,
    // `language` and `first_seen_at` are local columns with no equivalent in a
    // search response, and the cards render them.
    match query_archive_records_by_ids(&connection, &input.server_id, &archive_ids) {
        Ok(items) => Ok(CommandResult::success(ArchivePage {
            // An empty page is the end, whatever the count claims. Reporting
            // `has_more` from the count alone let an offset past the end keep
            // saying "there is more", and the caller kept asking forever.
            has_more: !archive_ids.is_empty()
                && start.saturating_add(archive_ids.len() as i64) < filtered,
            total: filtered,
            items,
        })),
        Err(error) => Ok(CommandResult::failure("LOCAL_DATABASE", error, true)),
    }
}

fn query_archive_records_by_ids(
    connection: &rusqlite::Connection,
    server_id: &str,
    archive_ids: &[String],
) -> Result<Vec<ArchiveRecord>, String> {
    if archive_ids.is_empty() {
        return Ok(Vec::new());
    }
    // SQLite caps bound parameters (999 on older builds), and these lists come
    // from the history and watchlist tables, which have no upper bound.
    const CHUNK: usize = 500;
    let mut by_id: std::collections::HashMap<String, ArchiveRecord> =
        std::collections::HashMap::with_capacity(archive_ids.len());
    for chunk in archive_ids.chunks(CHUNK) {
        let placeholders = (0..chunk.len())
            .map(|index| format!("?{}", index + 2))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT server_id, archive_id, title, page_count, file_size, summary, category, language, cover_page, is_deleted, local_updated_at, tags_json, COALESCE(added_at, first_seen_at)
             FROM archives WHERE server_id = ?1 AND is_deleted = 0 AND archive_id IN ({placeholders})"
        );
        let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() + 1);
        values.push(&server_id);
        for id in chunk {
            values.push(id);
        }
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(values.as_slice(), |row| {
                let tags = archive_tags(row.get::<_, String>(11)?);
                Ok(ArchiveRecord {
                    server_id: row.get(0)?,
                    archive_id: row.get(1)?,
                    title: row.get(2)?,
                    page_count: row.get(3)?,
                    file_size: row.get::<_, Option<i64>>(4)?,
                    summary: row.get(5)?,
                    category: row.get(6)?,
                    language: row.get(7)?,
                    cover_page: row.get(8)?,
                    is_deleted: row.get::<_, i64>(9)? != 0,
                    updated_at: row.get(10)?,
                    added_at: row
                        .get::<_, Option<i64>>(12)?
                        .or_else(|| archive_added_at(&tags)),
                    tags,
                })
            })
            .map_err(|error| error.to_string())?;
        for record in rows {
            let record = record.map_err(|error| error.to_string())?;
            by_id.insert(record.archive_id.clone(), record);
        }
    }
    // Preserve the order the caller asked in: for a random pull that order *is*
    // the result, and for history it is already sorted by last visit.
    let mut ordered = Vec::with_capacity(by_id.len());
    for id in archive_ids {
        if let Some(record) = by_id.remove(id) {
            ordered.push(record);
        }
    }
    Ok(ordered)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RandomArchivesInput {
    server_id: String,
    count: Option<i64>,
    filter: Option<String>,
    category: Option<String>,
}

fn build_random_search_url(base_url: &str, input: &RandomArchivesInput) -> String {
    let trimmed = base_url.trim_end_matches('/');
    let count = input.count.unwrap_or(8).clamp(1, 100);
    let mut query = vec![format!("count={count}")];
    if let Some(filter) = input
        .filter
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        query.push(format!(
            "filter={}",
            url::form_urlencoded::byte_serialize(filter.as_bytes()).collect::<String>()
        ));
    }
    if let Some(category) = input
        .category
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        query.push(format!(
            "category={}",
            url::form_urlencoded::byte_serialize(category.as_bytes()).collect::<String>()
        ));
    }
    format!("{}/api/search/random?{}", trimmed, query.join("&"))
}

/// Randomly selected archives straight from LANraragi, instead of shuffling a
/// full local index client-side (which required pulling the whole library).
#[tauri::command]
pub async fn search_random_archives(
    input: RandomArchivesInput,
    database: State<'_, Database>,
) -> Result<CommandResult<Vec<ArchiveRecord>>, String> {
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|c| server_connection(&c, &input.server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let response = match reader_request(
        reqwest::Method::GET,
        build_random_search_url(&base_url, &input),
        api_key,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
    };
    if let Some((code, message, retryable)) = search_status_failure(response.status()) {
        return Ok(CommandResult::failure(code, message, retryable));
    }
    let body = match response.text().await {
        Ok(text) => text,
        Err(error) => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                error.to_string(),
                true,
            ))
        }
    };
    let archives = match parse_random_response(&body) {
        Ok(archives) => archives,
        Err(error) => return Ok(CommandResult::failure("INVALID_RESPONSE", error, false)),
    };
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => {
            return Ok(CommandResult::failure(
                "UNKNOWN",
                "Database lock failed".to_string(),
                true,
            ))
        }
    };
    if let Err(error) = upsert_server_archives(&mut connection, &input.server_id, &archives) {
        return Ok(CommandResult::failure("UNKNOWN", error, true));
    }
    let ids = archives
        .iter()
        .map(|archive| archive.archive_id.clone())
        .collect::<Vec<_>>();
    match query_archive_records_by_ids(&connection, &input.server_id, &ids) {
        Ok(records) => Ok(CommandResult::success(records)),
        Err(error) => Ok(CommandResult::failure("UNKNOWN", error, true)),
    }
}

pub fn save_server_record(
    connection: &mut rusqlite::Connection,
    credentials: &dyn CredentialStore,
    server: ServerInput,
    api_key: String,
) -> CommandResult<ServerRecord> {
    let parsed_url = match Url::parse(&server.base_url) {
        Ok(url)
            if matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none() =>
        {
            url
        }
        _ => return CommandResult::failure("INVALID_RESPONSE", "Invalid server URL", false),
    };
    if server.name.trim().is_empty() || server.scope_id.trim().is_empty() {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid server identity", false);
    }

    let api_key = api_key.trim();
    if api_key.is_empty() {
        return CommandResult::failure("INVALID_RESPONSE", "API Key is required", false);
    }
    if let Err(error) = credentials.set_server_api_key(&server.scope_id, api_key) {
        return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false);
    }
    let api_key_ref = Some(server.scope_id.as_str());

    let transaction = match connection.transaction() {
        Ok(transaction) => transaction,
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    // A brand-new server starts enabled only when nothing is enabled yet;
    // otherwise it would silently steal the shelves from the current one.
    // Edits keep the row's existing flag (the UPDATE never touches it).
    let any_other_enabled = match transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM servers WHERE enabled = 1 AND id != ?1)",
        params![server.scope_id],
        |row| row.get::<_, bool>(0),
    ) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    const UPSERT: &str = "INSERT INTO servers (id, name, base_url, api_key_ref, scope_id, enabled)
        VALUES (?1, ?2, ?3, ?4, ?1, ?5)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, base_url = excluded.base_url, api_key_ref = excluded.api_key_ref,
          scope_id = excluded.scope_id, updated_at = CURRENT_TIMESTAMP";
    if let Err(error) = transaction.execute(
        UPSERT,
        params![
            server.scope_id,
            server.name.trim(),
            parsed_url.as_str().trim_end_matches('/'),
            api_key_ref,
            !any_other_enabled,
        ],
    ) {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    let record = match transaction.query_row(
        "SELECT id, name, base_url, scope_id, enabled FROM servers WHERE id = ?1",
        params![server.scope_id],
        |row| {
            Ok(ServerRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                base_url: row.get(2)?,
                scope_id: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
            })
        },
    ) {
        Ok(record) => record,
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    if let Err(error) = transaction.commit() {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    CommandResult::success(record)
}

/// Flips the enabled flag with the one-at-a-time invariant: enabling a server
/// disables every other, and the last enabled server cannot be disabled (the
/// app would be left without a data source).
pub fn set_server_enabled_record(
    connection: &mut rusqlite::Connection,
    server_id: &str,
    enabled: bool,
) -> CommandResult<ServerRecord> {
    let transaction = match connection.transaction() {
        Ok(transaction) => transaction,
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    let exists: bool = match transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM servers WHERE id = ?1)",
        params![server_id],
        |row| row.get(0),
    ) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    if !exists {
        return CommandResult::failure("NOT_FOUND", "服务器不存在", false);
    }
    // Stopping the only enabled server would leave the app without a data
    // source: switch to another server instead of turning the last one off.
    if !enabled {
        let enabled_count: i64 = match transaction.query_row(
            "SELECT COUNT(*) FROM servers WHERE enabled = 1",
            [],
            |row| row.get(0),
        ) {
            Ok(count) => count,
            Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
        };
        if enabled_count <= 1 {
            return CommandResult::failure(
                "INVALID_RESPONSE",
                "至少需要启用一台服务器；请先启用另一台",
                false,
            );
        }
    }
    if let Err(error) = transaction.execute(
        "UPDATE servers SET enabled = CASE WHEN id = ?1 THEN ?2 ELSE 0 END, updated_at = CURRENT_TIMESTAMP",
        params![server_id, i64::from(enabled)],
    ) {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    let record = match transaction.query_row(
        "SELECT id, name, base_url, scope_id, enabled FROM servers WHERE id = ?1",
        params![server_id],
        |row| {
            Ok(ServerRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                base_url: row.get(2)?,
                scope_id: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
            })
        },
    ) {
        Ok(record) => record,
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    if let Err(error) = transaction.commit() {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    CommandResult::success(record)
}

#[tauri::command]
pub fn set_server_enabled(
    server_id: String,
    enabled: bool,
    database: State<'_, Database>,
) -> CommandResult<ServerRecord> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    set_server_enabled_record(&mut connection, &server_id, enabled)
}

#[tauri::command]
pub async fn save_server(
    server: ServerInput,
    api_key: String,
    database: State<'_, Database>,
) -> Result<CommandResult<ServerRecord>, String> {
    let parsed_url = match Url::parse(&server.base_url) {
        Ok(url)
            if matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none() =>
        {
            url
        }
        _ => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                "Invalid server URL",
                false,
            ))
        }
    };
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "API Key is required",
            false,
        ));
    }
    let url = format!("{}/api/info", parsed_url.as_str().trim_end_matches('/'));
    let response = match reader_request(reqwest::Method::GET, url, api_key.clone()).await {
        Ok(response) => response,
        Err(error) => {
            return Ok(CommandResult::failure(
                "REMOTE_UNAVAILABLE",
                format!("无法连接 LANraragi：{error}"),
                true,
            ))
        }
    };
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(CommandResult::failure(
            "LRR_UNAUTHORIZED",
            "API Key 无效",
            false,
        ));
    }
    if !status.is_success() {
        return Ok(CommandResult::failure(
            if status.is_server_error() {
                "REMOTE_UNAVAILABLE"
            } else {
                "INVALID_RESPONSE"
            },
            format!("LANraragi 请求失败 ({status})"),
            status.is_server_error(),
        ));
    }
    let info: ServerInfoWire = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                format!("LANraragi 返回了无效的服务器信息：{error}"),
                false,
            ))
        }
    };
    let resolved_name = if server.name.trim().is_empty() {
        info.name.unwrap_or_default().trim().to_string()
    } else {
        server.name.trim().to_string()
    };
    if resolved_name.is_empty() {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "LANraragi 未返回服务器名称，请手动填写名称",
            false,
        ));
    }
    let server = ServerInput {
        name: resolved_name,
        base_url: parsed_url.as_str().trim_end_matches('/').to_string(),
        scope_id: server.scope_id,
    };
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => {
            return Ok(CommandResult::failure(
                "UNKNOWN",
                "Database lock failed",
                true,
            ))
        }
    };
    Ok(save_server_record(
        &mut connection,
        &SystemCredentialStore,
        server,
        api_key,
    ))
}

/// 编辑已配置的服务器时把系统安全存储里的 API Key 读回来，让用户能看见自己
/// 之前配置的值。Key 只在本机弹窗中展示，不经过网络。
#[tauri::command]
pub fn read_server_api_key(scope_id: String) -> CommandResult<String> {
    match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => CommandResult::success(value),
        Err(error) => CommandResult::failure(
            "PLATFORM_UNAVAILABLE",
            credential_read_error(error),
            false,
        ),
    }
}

#[tauri::command]
pub fn list_servers(database: State<'_, Database>) -> CommandResult<Vec<ServerRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let mut statement = match connection.prepare(
        "SELECT id, name, base_url, scope_id, enabled FROM servers
         ORDER BY enabled DESC, name COLLATE NOCASE, id",
    ) {
        Ok(statement) => statement,
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    let rows = match statement.query_map([], |row| {
        Ok(ServerRecord {
            id: row.get(0)?,
            name: row.get(1)?,
            base_url: row.get(2)?,
            scope_id: row.get(3)?,
            enabled: row.get::<_, i64>(4)? != 0,
        })
    }) {
        Ok(rows) => rows,
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    match rows.collect::<Result<Vec<_>, _>>() {
        Ok(servers) => CommandResult::success(servers),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

#[tauri::command]
pub async fn check_server_status(
    database: State<'_, Database>,
) -> Result<CommandResult<Vec<ServerStatusRecord>>, String> {
    let servers = {
        let connection = match database.connection.lock() {
            Ok(connection) => connection,
            Err(_) => {
                return Ok(CommandResult::failure(
                    "UNKNOWN",
                    "Database lock failed",
                    true,
                ))
            }
        };
        let mut statement = match connection.prepare(
            "SELECT id, name, base_url, scope_id FROM servers ORDER BY name COLLATE NOCASE, id",
        ) {
            Ok(statement) => statement,
            Err(error) => return Ok(CommandResult::failure("UNKNOWN", error.to_string(), true)),
        };
        let rows = match statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        }) {
            Ok(rows) => rows,
            Err(error) => return Ok(CommandResult::failure("UNKNOWN", error.to_string(), true)),
        };
        match rows.collect::<Result<Vec<_>, _>>() {
            Ok(servers) => servers,
            Err(error) => return Ok(CommandResult::failure("UNKNOWN", error.to_string(), true)),
        }
    };

    let credentials = SystemCredentialStore;
    let mut statuses = Vec::with_capacity(servers.len());
    for (server_id, configured_name, base_url, scope_id) in servers {
        let offline = |error: String| ServerStatusRecord {
            server_id: server_id.clone(),
            online: false,
            name: Some(configured_name.clone()),
            error: Some(error),
        };
        let api_key = match credentials.get_server_api_key(&scope_id) {
            Ok(api_key) => api_key,
            Err(_) => {
                statuses.push(offline("服务器凭据不可用".to_string()));
                continue;
            }
        };
        let url = format!("{}/api/info", base_url.trim_end_matches('/'));
        let response = match reader_request(reqwest::Method::GET, url, api_key).await {
            Ok(response) => response,
            Err(_) => {
                statuses.push(offline("无法连接 LANraragi".to_string()));
                continue;
            }
        };
        let http_status = response.status();
        if !http_status.is_success() {
            statuses.push(offline(format!("LANraragi 请求失败 ({http_status})")));
            continue;
        }
        let info = match response.json::<ServerInfoWire>().await {
            Ok(info) => info,
            Err(_) => {
                statuses.push(offline("LANraragi 返回了无效的服务器信息".to_string()));
                continue;
            }
        };
        let valid_name = info
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let valid_version = info
            .version
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if valid_name.is_none() || valid_version.is_none() {
            statuses.push(offline("LANraragi 返回了不完整的服务器信息".to_string()));
            continue;
        }
        statuses.push(ServerStatusRecord {
            server_id,
            online: true,
            name: Some(valid_name.unwrap_or(&configured_name).to_string()),
            error: None,
        });
    }
    Ok(CommandResult::success(statuses))
}

#[tauri::command]
pub fn list_archives(
    server_id: String,
    database: State<'_, Database>,
) -> CommandResult<Vec<ArchiveRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match query_archive_records(&connection, &server_id) {
        Ok(archives) => CommandResult::success(archives),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command]
pub fn list_archives_page(
    input: ArchiveQueryInput,
    database: State<'_, Database>,
) -> CommandResult<ArchivePage> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match query_archive_page(&connection, &input) {
        Ok(page) => CommandResult::success(page),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

/// The shelves (home, history, favourites, to-read) hold a handful of archive
/// ids and need the records behind them. Reading the whole library to resolve
/// fourteen titles scaled with the library instead of with the shelf.
#[tauri::command]
pub fn list_archives_by_ids(
    server_id: String,
    archive_ids: Vec<String>,
    database: State<'_, Database>,
) -> CommandResult<Vec<ArchiveRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match query_archive_records_by_ids(&connection, &server_id, &archive_ids) {
        Ok(archives) => CommandResult::success(archives),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

/// How many ids one verification pass will check. The shelves show a handful of
/// cards; a cap keeps a long history from turning into a request storm.
const VERIFY_ARCHIVE_LIMIT: usize = 32;

/// Confirms that archives the local mirror is about to show still exist on the
/// server, tombstoning the ones that do not, and answers with those ids.
///
/// The mirror only learns about a deletion when a full refresh runs or when
/// something opens the archive and gets a 404. Since the library list moved to
/// server-side paging, nothing refreshes the mirror on its own, so the shelves
/// (history, favourites, to-read, the home rails) kept offering archives that
/// were gone — the user found out by clicking one.
///
/// Requests run one at a time and only a definite 400/404 counts: a timeout or a
/// server error must never tombstone an archive that is merely unreachable.
#[tauri::command]
pub async fn verify_archives_exist(
    server_id: String,
    archive_ids: Vec<String>,
    database: State<'_, Database>,
) -> Result<CommandResult<Vec<String>>, String> {
    if archive_ids.is_empty() {
        return Ok(CommandResult::success(Vec::new()));
    }
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|connection| server_connection(&connection, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let mut missing = Vec::new();
    for archive_id in archive_ids.iter().take(VERIFY_ARCHIVE_LIMIT) {
        let url = format!(
            "{}/api/archives/{}/metadata",
            base_url.trim_end_matches('/'),
            archive_id
        );
        let response = match reader_request(reqwest::Method::GET, url, api_key.clone()).await {
            Ok(response) => response,
            // Unreachable is not deleted.
            Err(_) => continue,
        };
        let status = response.status();
        if !matches!(
            status,
            reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::NOT_FOUND
        ) {
            continue;
        }
        let tombstoned = database
            .connection
            .lock()
            .map_err(|_| "Database lock failed".to_string())
            .and_then(|connection| {
                reconcile_missing_archive_status(&connection, &server_id, archive_id, status)
            });
        match tombstoned {
            Ok(_) => missing.push(archive_id.clone()),
            Err(error) => return Ok(CommandResult::failure("UNKNOWN", error, true)),
        }
    }
    Ok(CommandResult::success(missing))
}

#[tauri::command]
pub fn save_reading_progress(
    progress: ReadingProgressInput,
    database: State<'_, Database>,
) -> CommandResult<ReadingProgressRecord> {
    if progress.page_index < 0
        || progress.page_count < 0
        || !matches!(progress.layout.as_str(), "paged" | "continuous")
        || !matches!(progress.direction.as_str(), "ltr" | "rtl")
    {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid reading progress", false);
    }
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match persist_reading_progress(&mut connection, progress) {
        Ok(record) => CommandResult::success(record),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

fn persist_reading_progress(
    connection: &mut rusqlite::Connection,
    progress: ReadingProgressInput,
) -> Result<ReadingProgressRecord, String> {
    let transaction = match connection.transaction() {
        Ok(transaction) => transaction,
        Err(error) => return Err(error.to_string()),
    };
    let device_id = get_or_create_device_id(&transaction)?;
    // `cover_alone` uses COALESCE rather than `excluded`: a caller that omits it
    // (every ordinary page turn does) must not erase a setting the user made.
    const UPSERT: &str = "INSERT INTO reading_progress (scope_id, archive_id, page_index, page_count, layout, direction, cover_alone, device_id, revision)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
        ON CONFLICT(scope_id, archive_id) DO UPDATE SET
          page_index = excluded.page_index, page_count = excluded.page_count, layout = excluded.layout,
          direction = excluded.direction, device_id = excluded.device_id,
          cover_alone = COALESCE(excluded.cover_alone, reading_progress.cover_alone),
          updated_at = CURRENT_TIMESTAMP, revision = reading_progress.revision + 1";
    if let Err(error) = transaction.execute(
        UPSERT,
        params![
            progress.scope_id,
            progress.archive_id,
            progress.page_index,
            progress.page_count,
            progress.layout,
            progress.direction,
            progress.cover_alone,
            device_id
        ],
    ) {
        return Err(error.to_string());
    }
    let record = transaction.query_row(
        "SELECT scope_id, archive_id, page_index, page_count, layout, direction, cover_alone, updated_at, revision
         FROM reading_progress WHERE scope_id = ?1 AND archive_id = ?2",
        params![progress.scope_id, progress.archive_id],
        |row| Ok(ReadingProgressRecord {
            scope_id: row.get(0)?, archive_id: row.get(1)?, page_index: row.get(2)?, page_count: row.get(3)?,
            layout: row.get(4)?, direction: row.get(5)?, cover_alone: row.get(6)?,
            updated_at: row.get(7)?, revision: row.get(8)?,
        }),
    ).optional();
    let record = match record {
        Ok(Some(record)) => record,
        Ok(None) => return Err("Progress write was not visible".to_string()),
        Err(error) => return Err(error.to_string()),
    };
    let payload_json = serde_json::json!({
        "archiveId": record.archive_id,
        "pageIndex": record.page_index,
        "pageCount": record.page_count,
        "layout": record.layout,
        "direction": record.direction,
        "coverAlone": record.cover_alone,
    })
    .to_string();
    let mut hasher = Sha256::new();
    hasher.update(payload_json.as_bytes());
    let payload_hash = format!("{:x}", hasher.finalize());
    if let Err(error) = transaction.execute(
        "INSERT INTO sync_journal (
            scope_id, object_id, object_type, operation, device_id,
            logical_clock, payload_hash, payload_json
         ) VALUES (?1, ?2, 'reading_progress', 'upsert', ?3, ?4, ?5, ?6)",
        params![
            record.scope_id,
            format!("{}/{}", record.scope_id, record.archive_id),
            device_id,
            record.revision,
            payload_hash,
            payload_json,
        ],
    ) {
        return Err(error.to_string());
    }
    transaction
        .execute(
            "INSERT INTO reading_history (scope_id, archive_id, page_index, device_id, revision)
         VALUES (?1, ?2, ?3, ?4, 1)
         ON CONFLICT(scope_id, archive_id) DO UPDATE SET
           page_index = MAX(reading_history.page_index, excluded.page_index),
           visited_at = CURRENT_TIMESTAMP,
           device_id = excluded.device_id,
           revision = reading_history.revision + 1",
            params![
                record.scope_id,
                record.archive_id,
                record.page_index,
                device_id
            ],
        )
        .map_err(|error| error.to_string())?;
    let history: (i64, String, i64) = transaction
        .query_row(
            "SELECT page_index, visited_at, revision FROM reading_history
         WHERE scope_id = ?1 AND archive_id = ?2",
            params![record.scope_id, record.archive_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;
    let history_payload = serde_json::json!({
        "archiveId": record.archive_id,
        "pageIndex": history.0,
        "visitedAt": history.1,
    })
    .to_string();
    let mut history_hasher = Sha256::new();
    history_hasher.update(history_payload.as_bytes());
    transaction
        .execute(
            "INSERT INTO sync_journal (
            scope_id, object_id, object_type, operation, device_id,
            logical_clock, payload_hash, payload_json
         ) VALUES (?1, ?2, 'history', 'upsert', ?3, ?4, ?5, ?6)",
            params![
                record.scope_id,
                format!("{}/{}", record.scope_id, record.archive_id),
                device_id,
                history.2,
                format!("{:x}", history_hasher.finalize()),
                history_payload,
            ],
        )
        .map_err(|error| error.to_string())?;
    // Page indexes are zero-based. Strictly above 90%, never at exactly 90%.
    // Tombstone only existing active entries, and journal once in this transaction.
    if record.page_count > 0
        && (i128::from(record.page_index) + 1) * 10 > i128::from(record.page_count) * 9
    {
        let listed: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM reading_list WHERE scope_id=?1 AND archive_id=?2 AND deleted_at IS NULL)",
            params![record.scope_id, record.archive_id], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if listed {
            write_reading_list_entry(&transaction, &record.scope_id, &record.archive_id, false)?;
        }
    }
    if let Err(error) = transaction.commit() {
        return Err(error.to_string());
    }
    Ok(record)
}

fn set_watchlist_entry(
    connection: &mut rusqlite::Connection,
    scope_id: &str,
    archive_id: &str,
    added: bool,
) -> Result<WatchlistRecord, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let device_id = get_or_create_device_id(&transaction)?;
    transaction
        .execute(
            "INSERT INTO watchlist (scope_id, archive_id, device_id, deleted_at, revision)
         VALUES (?1, ?2, ?3, CASE WHEN ?4 THEN NULL ELSE CURRENT_TIMESTAMP END, 1)
         ON CONFLICT(scope_id, archive_id) DO UPDATE SET
           updated_at = CURRENT_TIMESTAMP, device_id = excluded.device_id,
           deleted_at = CASE WHEN ?4 THEN NULL ELSE CURRENT_TIMESTAMP END,
           revision = watchlist.revision + 1",
            params![scope_id, archive_id, device_id, added],
        )
        .map_err(|error| error.to_string())?;
    let record = transaction
        .query_row(
            "SELECT scope_id, archive_id, added_at, updated_at, device_id, deleted_at, revision
         FROM watchlist WHERE scope_id = ?1 AND archive_id = ?2",
            params![scope_id, archive_id],
            |row| {
                let deleted_at: Option<String> = row.get(5)?;
                Ok(WatchlistRecord {
                    scope_id: row.get(0)?,
                    archive_id: row.get(1)?,
                    added_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    device_id: row.get(4)?,
                    deleted: deleted_at.is_some(),
                    deleted_at,
                    revision: row.get(6)?,
                })
            },
        )
        .map_err(|error| error.to_string())?;
    let payload_json = serde_json::json!({
        "archiveId": record.archive_id,
        "deleted": record.deleted,
    })
    .to_string();
    let mut hasher = Sha256::new();
    hasher.update(payload_json.as_bytes());
    transaction.execute(
        "INSERT INTO sync_journal (
            scope_id, object_id, object_type, operation, device_id,
            logical_clock, payload_hash, payload_json
         ) VALUES (?1, ?2, 'watchlist', CASE WHEN ?3 THEN 'upsert' ELSE 'delete' END, ?4, ?5, ?6, ?7)",
        params![
            record.scope_id,
            format!("{}/{}", record.scope_id, record.archive_id),
            added,
            record.device_id,
            record.revision,
            format!("{:x}", hasher.finalize()),
            payload_json,
        ],
    ).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(record)
}

/// Reading list ("待看") is deliberately a second list, not a flag on the
/// watchlist: "I like this" and "I plan to read this" are different answers, and
/// both have to sync, so this mirrors the watchlist journal shape.
fn set_reading_list_entry(
    connection: &mut rusqlite::Connection,
    scope_id: &str,
    archive_id: &str,
    added: bool,
) -> Result<WatchlistRecord, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let record = write_reading_list_entry(&transaction, scope_id, archive_id, added)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(record)
}

fn write_reading_list_entry(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    archive_id: &str,
    added: bool,
) -> Result<WatchlistRecord, String> {
    let device_id = get_or_create_device_id(&transaction)?;
    transaction
        .execute(
            "INSERT INTO reading_list (scope_id, archive_id, device_id, deleted_at, revision)
         VALUES (?1, ?2, ?3, CASE WHEN ?4 THEN NULL ELSE CURRENT_TIMESTAMP END, 1)
         ON CONFLICT(scope_id, archive_id) DO UPDATE SET
           updated_at = CURRENT_TIMESTAMP, device_id = excluded.device_id,
           deleted_at = CASE WHEN ?4 THEN NULL ELSE CURRENT_TIMESTAMP END,
           revision = reading_list.revision + 1",
            params![scope_id, archive_id, device_id, added],
        )
        .map_err(|error| error.to_string())?;
    let record = transaction
        .query_row(
            "SELECT scope_id, archive_id, added_at, updated_at, device_id, deleted_at, revision
         FROM reading_list WHERE scope_id = ?1 AND archive_id = ?2",
            params![scope_id, archive_id],
            |row| {
                let deleted_at: Option<String> = row.get(5)?;
                Ok(WatchlistRecord {
                    scope_id: row.get(0)?,
                    archive_id: row.get(1)?,
                    added_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    device_id: row.get(4)?,
                    deleted: deleted_at.is_some(),
                    deleted_at,
                    revision: row.get(6)?,
                })
            },
        )
        .map_err(|error| error.to_string())?;
    let payload_json = serde_json::json!({
        "archiveId": record.archive_id,
        "deleted": record.deleted,
    })
    .to_string();
    let mut hasher = Sha256::new();
    hasher.update(payload_json.as_bytes());
    transaction.execute(
        "INSERT INTO sync_journal (
            scope_id, object_id, object_type, operation, device_id,
            logical_clock, payload_hash, payload_json
         ) VALUES (?1, ?2, 'reading_list', CASE WHEN ?3 THEN 'upsert' ELSE 'delete' END, ?4, ?5, ?6, ?7)",
        params![
            record.scope_id,
            format!("{}/{}", record.scope_id, record.archive_id),
            added,
            record.device_id,
            record.revision,
            format!("{:x}", hasher.finalize()),
            payload_json,
        ],
    ).map_err(|error| error.to_string())?;
    Ok(record)
}

fn journal_search_preset(
    connection: &rusqlite::Connection,
    record: &SearchPresetRecord,
    upsert: bool,
) -> Result<(), String> {
    let payload_json = serde_json::json!({
        "presetId": record.preset_id,
        "name": record.name,
        "query": record.query,
        "sortBy": record.sort_by,
        "sortOrder": record.sort_order,
        "categoryId": record.category_id,
        "deleted": record.deleted,
    })
    .to_string();
    let mut hasher = Sha256::new();
    hasher.update(payload_json.as_bytes());
    connection
        .execute(
            "INSERT INTO sync_journal (
                scope_id, object_id, object_type, operation, device_id,
                logical_clock, payload_hash, payload_json
             ) VALUES (?1, ?2, 'search_preset', CASE WHEN ?3 THEN 'upsert' ELSE 'delete' END, ?4, ?5, ?6, ?7)",
            params![
                record.scope_id,
                format!("{}/{}", record.scope_id, record.preset_id),
                upsert,
                record.device_id,
                record.revision,
                format!("{:x}", hasher.finalize()),
                payload_json,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn write_search_preset(
    connection: &mut rusqlite::Connection,
    input: &SearchPresetInput,
) -> Result<SearchPresetRecord, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let device_id = get_or_create_device_id(&transaction)?;
    transaction
        .execute(
            "INSERT INTO search_presets (scope_id, preset_id, name, query, sort_by, sort_order, category_id, device_id, deleted_at, revision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, 1)
             ON CONFLICT(scope_id, preset_id) DO UPDATE SET
               name = excluded.name, query = excluded.query, sort_by = excluded.sort_by,
               sort_order = excluded.sort_order, category_id = excluded.category_id,
               updated_at = CURRENT_TIMESTAMP, device_id = excluded.device_id,
               deleted_at = NULL, revision = search_presets.revision + 1",
            params![
                input.scope_id, input.preset_id, input.name.trim(), input.query,
                input.sort_by, input.sort_order, input.category_id, device_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    let record = read_search_preset(&transaction, &input.scope_id, &input.preset_id)?;
    journal_search_preset(&transaction, &record, true)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(record)
}

fn read_search_preset(
    connection: &rusqlite::Connection,
    scope_id: &str,
    preset_id: &str,
) -> Result<SearchPresetRecord, String> {
    connection
        .query_row(
            "SELECT scope_id, preset_id, name, query, sort_by, sort_order, category_id,
                    created_at, updated_at, device_id, revision, deleted_at
             FROM search_presets WHERE scope_id = ?1 AND preset_id = ?2",
            params![scope_id, preset_id],
            |row| {
                let deleted_at: Option<String> = row.get(11)?;
                Ok(SearchPresetRecord {
                    scope_id: row.get(0)?,
                    preset_id: row.get(1)?,
                    name: row.get(2)?,
                    query: row.get(3)?,
                    sort_by: row.get(4)?,
                    sort_order: row.get(5)?,
                    category_id: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                    device_id: row.get(9)?,
                    revision: row.get(10)?,
                    deleted: deleted_at.is_some(),
                })
            },
        )
        .map_err(|error| error.to_string())
}

/// Saved searches: the library toolbar state under a name. Stored per scope and
/// journalled like the watchlist, so a preset made on one device arrives on the
/// next sync instead of living only in local settings.
#[tauri::command]
pub fn save_search_preset(
    input: SearchPresetInput,
    database: State<'_, Database>,
) -> CommandResult<SearchPresetRecord> {
    if input.name.trim().is_empty() || input.preset_id.trim().is_empty() {
        return CommandResult::failure("INVALID_INPUT", "预设需要名称", false);
    }
    if !matches!(input.sort_by.as_str(), "title" | "added")
        || !matches!(input.sort_order.as_str(), "asc" | "desc")
    {
        return CommandResult::failure("INVALID_INPUT", "预设排序无效", false);
    }
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match write_search_preset(&mut connection, &input) {
        Ok(record) => CommandResult::success(record),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command]
pub fn delete_search_preset(
    scope_id: String,
    preset_id: String,
    database: State<'_, Database>,
) -> CommandResult<SearchPresetRecord> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let result = (|| -> Result<SearchPresetRecord, String> {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE search_presets SET deleted_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP, revision = revision + 1
                 WHERE scope_id = ?1 AND preset_id = ?2",
                params![scope_id, preset_id],
            )
            .map_err(|error| error.to_string())?;
        let record = read_search_preset(&transaction, &scope_id, &preset_id)?;
        journal_search_preset(&transaction, &record, false)?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(record)
    })();
    match result {
        Ok(record) => CommandResult::success(record),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command]
pub fn list_search_presets(
    scope_id: String,
    database: State<'_, Database>,
) -> CommandResult<Vec<SearchPresetRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let result = (|| -> Result<Vec<SearchPresetRecord>, String> {
        let mut statement = connection
            .prepare(
                "SELECT scope_id, preset_id, name, query, sort_by, sort_order, category_id,
                        created_at, updated_at, device_id, revision, deleted_at
                 FROM search_presets WHERE scope_id = ?1 AND deleted_at IS NULL
                 ORDER BY name COLLATE NOCASE",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![scope_id], |row| {
                Ok(SearchPresetRecord {
                    scope_id: row.get(0)?,
                    preset_id: row.get(1)?,
                    name: row.get(2)?,
                    query: row.get(3)?,
                    sort_by: row.get(4)?,
                    sort_order: row.get(5)?,
                    category_id: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                    device_id: row.get(9)?,
                    revision: row.get(10)?,
                    deleted: false,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    })();
    match result {
        Ok(records) => CommandResult::success(records),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command]
pub fn set_reading_list(
    scope_id: String,
    archive_id: String,
    added: bool,
    database: State<'_, Database>,
) -> CommandResult<WatchlistRecord> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match set_reading_list_entry(&mut connection, &scope_id, &archive_id, added) {
        Ok(record) => CommandResult::success(record),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command]
pub fn list_reading_list(
    scope_id: String,
    database: State<'_, Database>,
) -> CommandResult<Vec<WatchlistRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let result =
        (|| -> Result<Vec<WatchlistRecord>, String> {
            let mut statement = connection.prepare(
            "SELECT scope_id, archive_id, added_at, updated_at, device_id, deleted_at, revision
             FROM reading_list WHERE scope_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC"
        ).map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![scope_id], |row| {
                    Ok(WatchlistRecord {
                        scope_id: row.get(0)?,
                        archive_id: row.get(1)?,
                        added_at: row.get(2)?,
                        updated_at: row.get(3)?,
                        device_id: row.get(4)?,
                        deleted_at: row.get(5)?,
                        revision: row.get(6)?,
                        deleted: false,
                    })
                })
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())
        })();
    match result {
        Ok(records) => CommandResult::success(records),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command]
pub fn set_watchlist(
    scope_id: String,
    archive_id: String,
    added: bool,
    database: State<'_, Database>,
) -> CommandResult<WatchlistRecord> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match set_watchlist_entry(&mut connection, &scope_id, &archive_id, added) {
        Ok(record) => CommandResult::success(record),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command]
pub fn list_watchlist(
    scope_id: String,
    database: State<'_, Database>,
) -> CommandResult<Vec<WatchlistRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let result =
        (|| -> Result<Vec<WatchlistRecord>, String> {
            let mut statement = connection.prepare(
            "SELECT scope_id, archive_id, added_at, updated_at, device_id, deleted_at, revision
             FROM watchlist WHERE scope_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC"
        ).map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![scope_id], |row| {
                    Ok(WatchlistRecord {
                        scope_id: row.get(0)?,
                        archive_id: row.get(1)?,
                        added_at: row.get(2)?,
                        updated_at: row.get(3)?,
                        device_id: row.get(4)?,
                        deleted_at: row.get(5)?,
                        revision: row.get(6)?,
                        deleted: false,
                    })
                })
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())
        })();
    match result {
        Ok(records) => CommandResult::success(records),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command]
pub fn list_reading_history(
    scope_id: String,
    database: State<'_, Database>,
) -> CommandResult<Vec<ReadingHistoryRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let result = (|| -> Result<Vec<ReadingHistoryRecord>, String> {
        let mut statement = connection
            .prepare(
                "SELECT scope_id, archive_id, page_index, visited_at, device_id, revision
             FROM reading_history WHERE scope_id = ?1 ORDER BY visited_at DESC",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![scope_id], |row| {
                Ok(ReadingHistoryRecord {
                    scope_id: row.get(0)?,
                    archive_id: row.get(1)?,
                    page_index: row.get(2)?,
                    visited_at: row.get(3)?,
                    device_id: row.get(4)?,
                    revision: row.get(5)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    })();
    match result {
        Ok(records) => CommandResult::success(records),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command]
pub fn load_reading_progress(
    scope_id: String,
    archive_id: String,
    database: State<'_, Database>,
) -> CommandResult<Option<ReadingProgressRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match connection
        .query_row(
            "SELECT scope_id, archive_id, page_index, page_count, layout, direction, cover_alone, updated_at, revision
             FROM reading_progress WHERE scope_id = ?1 AND archive_id = ?2",
            params![scope_id, archive_id],
            |row| Ok(ReadingProgressRecord {
                scope_id: row.get(0)?, archive_id: row.get(1)?, page_index: row.get(2)?,
                page_count: row.get(3)?, layout: row.get(4)?, direction: row.get(5)?,
                cover_alone: row.get(6)?, updated_at: row.get(7)?, revision: row.get(8)?,
            }),
        )
        .optional()
    {
        Ok(record) => CommandResult::success(record),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

#[tauri::command]
pub fn create_task(task: TaskInput, database: State<'_, Database>) -> CommandResult<TaskRecord> {
    if !matches!(
        task.kind.as_str(),
        "download" | "sync" | "inference" | "maintenance"
    ) || task.label.trim().is_empty()
    {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid task", false);
    }
    let id = format!(
        "task-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    );
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let result = connection.execute(
        "INSERT INTO tasks (id, kind, label, status, progress) VALUES (?1, ?2, ?3, 'queued', 0)",
        params![id, task.kind, task.label.trim()],
    );
    if let Err(error) = result {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    match connection.query_row(
        "SELECT id,kind,label,status,progress,error,cancelable,retryable,created_at,updated_at FROM tasks WHERE id=?1",
        params![id],
        read_task_row,
    ) {
        Ok(record) => CommandResult::success(record),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

fn query_tasks(connection: &rusqlite::Connection) -> Result<Vec<TaskRecord>, String> {
    let mut statement = connection
        .prepare("SELECT id,kind,label,status,progress,error,cancelable,retryable,created_at,updated_at FROM tasks ORDER BY updated_at DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], read_task_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_tasks(database: State<'_, Database>) -> CommandResult<Vec<TaskRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match query_tasks(&connection) {
        Ok(tasks) => CommandResult::success(tasks),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdateInput {
    status: Option<String>,
    progress: Option<f64>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UploadArchiveWire {
    operation: String,
    success: i64,
    id: String,
}

#[derive(Debug, Serialize)]
pub struct UploadArchiveResult {
    operation: String,
    success: i64,
    id: String,
}

#[derive(Debug, Deserialize)]
struct CategoryWire {
    id: String,
    name: String,
    pinned: serde_json::Value,
    search: Option<String>,
    archives: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryRecord {
    id: String,
    name: String,
    pinned: bool,
    search: Option<String>,
    archives: Vec<String>,
}

fn normalize_category_archives(value: serde_json::Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(str::to_owned)
                        .or_else(|| {
                            item.get("arcid")
                                .and_then(|id| id.as_str())
                                .map(str::to_owned)
                        })
                        .or_else(|| item.get("id").and_then(|id| id.as_str()).map(str::to_owned))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRecord {
    operation: String,
    success: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMetadataUpdateInput {
    title: Option<String>,
    tags: Option<String>,
    summary: Option<String>,
}

fn validate_upload_path(file_path: &str) -> Result<(std::path::PathBuf, String), String> {
    let path = std::path::PathBuf::from(file_path);
    if !path.is_absolute() || !path.is_file() {
        return Err("Archive file not found".to_string());
    }
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Invalid archive filename".to_string())?
        .to_string();
    let allowed = ["zip", "rar", "7z", "tar", "gz", "cbz", "cbr", "cb7"];
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !allowed.contains(&extension.as_str()) {
        return Err("Unsupported archive type".to_string());
    }
    Ok((path, filename))
}

#[tauri::command]
pub fn update_task(
    id: String,
    update: TaskUpdateInput,
    database: State<'_, Database>,
) -> CommandResult<TaskRecord> {
    if update.status.as_ref().is_some_and(|status| {
        !matches!(
            status.as_str(),
            "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"
        )
    }) || update
        .progress
        .is_some_and(|progress| !(0.0..=1.0).contains(&progress))
    {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid task update", false);
    }
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match transition_task(
        &connection,
        &id,
        update.status.as_deref(),
        update.progress,
        update.error.as_deref(),
    ) {
        Ok(task) => CommandResult::success(task),
        Err(error) if error.contains("not found") => {
            CommandResult::failure("LRR_NOT_FOUND", error, false)
        }
        Err(error) => CommandResult::failure("REMOTE_CONFLICT", error, false),
    }
}

#[tauri::command]
pub fn retry_task(id: String, database: State<'_, Database>) -> CommandResult<TaskRecord> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match retry_failed_task(&connection, &id) {
        Ok(task) => CommandResult::success(task),
        Err(error) => CommandResult::failure("REMOTE_CONFLICT", error, false),
    }
}

#[tauri::command]
pub async fn upload_archive(
    server_id: String,
    task_id: String,
    file_path: String,
    database: State<'_, Database>,
) -> Result<CommandResult<UploadArchiveResult>, String> {
    let (path, filename) = match validate_upload_path(&file_path) {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("INVALID_RESPONSE", error, false)),
    };
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|connection| server_connection(&connection, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    {
        let connection = match database.connection.lock() {
            Ok(connection) => connection,
            Err(_) => {
                return Ok(CommandResult::failure(
                    "UNKNOWN",
                    "Database lock failed",
                    true,
                ))
            }
        };
        let changed = connection.execute(
            "UPDATE tasks SET status = 'running', progress = 0, error = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND status IN ('queued', 'paused')",
            params![task_id],
        );
        if !matches!(changed, Ok(1)) {
            return Ok(CommandResult::failure(
                "REMOTE_CONFLICT",
                "Upload task is unavailable",
                false,
            ));
        }
    }
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return Ok(CommandResult::failure(
                "LRR_NOT_FOUND",
                error.to_string(),
                false,
            ))
        }
    };
    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename);
    let form = reqwest::multipart::Form::new().part("file", part);
    let response = match Client::builder()
        .build()
        .map_err(|error| error.to_string())?
        .put(format!(
            "{}/api/archives/upload",
            base_url.trim_end_matches('/')
        ))
        .header(
            reqwest::header::AUTHORIZATION,
            authorization_value(&api_key),
        )
        .multipart(form)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            mark_task_failed(&database, &task_id, &error.to_string());
            return Ok(CommandResult::failure(
                "REMOTE_UNAVAILABLE",
                error.to_string(),
                true,
            ));
        }
    };
    if !response.status().is_success() {
        let message = format!("LANraragi request failed ({})", response.status());
        mark_task_failed(&database, &task_id, &message);
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            message,
            response.status().is_server_error(),
        ));
    }
    let wire: UploadArchiveWire = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            mark_task_failed(&database, &task_id, &error.to_string());
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                error.to_string(),
                false,
            ));
        }
    };
    if wire.operation != "upload" || wire.success != 1 || wire.id.is_empty() {
        mark_task_failed(&database, &task_id, "Invalid LANraragi upload response");
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "Invalid LANraragi upload response",
            false,
        ));
    }
    if let Ok(connection) = database.connection.lock() {
        let _ = connection.execute(
            "UPDATE tasks SET status = 'completed', progress = 1, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![task_id],
        );
    }
    Ok(CommandResult::success(UploadArchiveResult {
        operation: wire.operation,
        success: wire.success,
        id: wire.id,
    }))
}

fn mark_task_failed(database: &Database, task_id: &str, message: &str) {
    if let Ok(connection) = database.connection.lock() {
        let _ = connection.execute(
            "UPDATE tasks SET status = 'failed', error = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
            params![message, task_id],
        );
    }
}

#[derive(Debug, Deserialize)]
struct DownloadUrlWire {
    #[serde(default)]
    job: i64,
    #[serde(default)]
    success: i64,
    #[serde(default)]
    url: String,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadUrlResult {
    /// The Minion job LANraragi queued. Shown so the download can be followed on
    /// the server, which is where the work actually happens.
    pub job: i64,
    pub url: String,
}

/// Hands a URL to LANraragi's own downloader.
///
/// The server resolves which downloader plugin applies, so the client does not
/// have to fetch the plugin list and match URLs against each plugin's regex the
/// way a browser client must.
#[tauri::command]
pub async fn download_url(
    server_id: String,
    url: String,
    category_id: Option<String>,
    database: State<'_, Database>,
) -> Result<CommandResult<DownloadUrlResult>, String> {
    let target = match Url::parse(url.trim()) {
        Ok(value) if matches!(value.scheme(), "http" | "https") => value,
        _ => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                "只支持 http/https 链接",
                false,
            ))
        }
    };
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|connection| server_connection(&connection, &server_id))
    {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("LRR_NOT_FOUND", error, false)),
    };
    let api_key = match SystemCredentialStore.get_server_api_key(&scope_id) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                credential_read_error(error),
                false,
            ))
        }
    };
    let mut request_url = match Url::parse(&format!(
        "{}/api/download_url",
        base_url.trim_end_matches('/')
    )) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "INVALID_RESPONSE",
                error.to_string(),
                false,
            ))
        }
    };
    {
        let mut pairs = request_url.query_pairs_mut();
        pairs.append_pair("url", target.as_str());
        if let Some(category) = category_id.as_deref().filter(|value| !value.is_empty()) {
            pairs.append_pair("catid", category);
        }
    }
    let response =
        match reader_request(reqwest::Method::POST, request_url.to_string(), api_key).await {
            Ok(response) => response,
            Err(error) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", error, true)),
        };
    let status = response.status();
    let wire: DownloadUrlWire = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                if status.is_success() {
                    "INVALID_RESPONSE"
                } else {
                    "REMOTE_UNAVAILABLE"
                },
                error.to_string(),
                !status.is_success() && status.is_server_error(),
            ))
        }
    };
    // LANraragi answers 400 with the same envelope, and its `error` says why the
    // URL was refused — worth more than the status code alone.
    if !status.is_success() || wire.success != 1 || wire.job <= 0 {
        let message = wire
            .error
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("LANraragi 拒绝了下载请求（{status}）"));
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            message,
            status.is_server_error(),
        ));
    }
    Ok(CommandResult::success(DownloadUrlResult {
        job: wire.job,
        url: if wire.url.is_empty() {
            target.to_string()
        } else {
            wire.url
        },
    }))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use rusqlite::Connection;

    use super::*;

    async fn test_http_server(
        responses: Vec<(u16, String)>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut requests = 0;
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 8192];
                socket.read(&mut request).await.unwrap();
                let (status, body) = &responses[requests.min(responses.len() - 1)];
                requests += 1;
                let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (url, task)
    }

    #[tokio::test]
    async fn thumbnail_timeout_is_not_returned_as_image_bytes() {
        let (url, server) = test_http_server(vec![(202, r#"{"job":1}"#.into())]).await;
        let result = fetch_page_thumbnail(&url, "archive", 1, "key".into(), 0).await;
        server.abort();
        assert!(
            matches!(result, Ok(CommandResult::Failure { .. })),
            "unfinished thumbnail must fail: {result:?}"
        );
    }

    #[tokio::test]
    async fn thumbnail_retry_rejects_another_accepted_response() {
        let (url, server) = test_http_server(vec![
            (202, r#"{"job":1}"#.into()),
            (200, r#"{"state":"finished"}"#.into()),
            (202, r#"{"job":2}"#.into()),
        ])
        .await;
        let result = fetch_page_thumbnail(&url, "archive", 1, "key".into(), 1).await;
        server.abort();
        assert!(
            matches!(result, Ok(CommandResult::Failure { .. })),
            "accepted JSON must fail: {result:?}"
        );
    }

    #[tokio::test]
    async fn full_search_rejects_an_incomplete_page_walk() {
        let body = serde_json::json!({
            "data": [{ "arcid": "a".repeat(40), "title": "Archive", "tags": "", "pagecount": 1, "size": 1 }],
            "recordsFiltered": MAX_SYNC_PAGES + 1,
            "recordsTotal": MAX_SYNC_PAGES + 1,
        }).to_string();
        let (url, server) = test_http_server(vec![(200, body)]).await;
        let params: RefreshSearchParams = serde_json::from_str("{}").unwrap();
        let result = fetch_all_search_pages(&url, "key", &params).await;
        server.abort();
        assert!(
            result.is_err(),
            "the page cap must not produce a replaceable snapshot"
        );
    }

    struct MemoryCredentialStore {
        writes: Mutex<Vec<(String, String)>>,
        failure: Option<&'static str>,
    }

    impl CredentialStore for MemoryCredentialStore {
        fn set_server_api_key(&self, scope_id: &str, api_key: &str) -> Result<(), String> {
            if let Some(message) = self.failure {
                return Err(message.to_string());
            }
            self.writes
                .lock()
                .expect("credential store lock")
                .push((scope_id.to_string(), api_key.to_string()));
            Ok(())
        }
    }

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
            .execute_batch(include_str!("../../migrations/0010_cache_path_sharing.sql"))
            .expect("cache path sharing migration");
        connection
            .execute_batch(include_str!("../../migrations/0011_task_runtime.sql"))
            .expect("task runtime migration");
        connection
            .execute_batch(include_str!("../../migrations/0012_archive_categories.sql"))
            .expect("archive categories migration");
        connection
            .execute_batch(include_str!(
                "../../migrations/0013_unified_image_cache.sql"
            ))
            .expect("unified image cache migration");
        connection
            .execute_batch(include_str!(
                "../../migrations/0014_cache_archive_scope.sql"
            ))
            .expect("cache archive scope migration");
        connection
            .execute_batch(include_str!("../../migrations/0016_archive_added_at.sql"))
            .expect("archive added_at migration");
        connection
            .execute_batch(include_str!("../../migrations/0017_reading_list.sql"))
            .expect("reading list migration");
        connection
            .execute_batch(include_str!("../../migrations/0018_search_presets.sql"))
            .expect("search presets migration");
        connection
            .execute_batch(include_str!(
                "../../migrations/0019_reading_progress_cover_alone.sql"
            ))
            .expect("reading progress cover_alone migration");
        connection
            .execute_batch(include_str!("../../migrations/0023_servers_enabled.sql"))
            .expect("servers enabled migration");
        connection
    }

    #[test]
    fn reading_past_ninety_percent_removes_only_active_to_read_once() {
        let mut connection = migrated_connection();
        set_reading_list_entry(&mut connection, "scope-a", "archive-a", true).unwrap();
        set_reading_list_entry(&mut connection, "scope-b", "archive-a", true).unwrap();
        set_watchlist_entry(&mut connection, "scope-a", "archive-a", true).unwrap();
        for (index, expected_deleted) in [(89, false), (90, true), (99, true)] {
            persist_reading_progress(
                &mut connection,
                ReadingProgressInput {
                    scope_id: "scope-a".into(),
                    archive_id: "archive-a".into(),
                    page_index: index,
                    page_count: 100,
                    layout: "paged".into(),
                    direction: "ltr".into(),
                    cover_alone: None,
                },
            )
            .unwrap();
            let deleted: bool = connection
                .query_row(
                    "SELECT deleted_at IS NOT NULL FROM reading_list WHERE scope_id='scope-a'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(deleted, expected_deleted);
        }
        let deletes: i64 = connection.query_row("SELECT COUNT(*) FROM sync_journal WHERE object_type='reading_list' AND operation='delete'", [], |row| row.get(0)).unwrap();
        assert_eq!(deletes, 1);
        for sql in [
            "SELECT deleted_at IS NULL FROM reading_list WHERE scope_id='scope-b'",
            "SELECT deleted_at IS NULL FROM watchlist WHERE scope_id='scope-a'",
        ] {
            assert!(connection
                .query_row(sql, [], |row| row.get::<_, bool>(0))
                .unwrap());
        }
    }

    #[test]
    fn reading_progress_write_creates_same_scope_sync_journal_entry() {
        let mut connection = migrated_connection();
        let record = persist_reading_progress(
            &mut connection,
            ReadingProgressInput {
                scope_id: "scope-a".to_string(),
                archive_id: "archive-a".to_string(),
                page_index: 4,
                page_count: 10,
                layout: "paged".to_string(),
                direction: "ltr".to_string(),
                cover_alone: None,
            },
        )
        .expect("progress write");

        assert_eq!(record.revision, 1);
        let journal: (String, String, String, String, String) = connection
            .query_row(
                "SELECT scope_id, object_id, object_type, operation, device_id FROM sync_journal",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("journal entry");
        assert_eq!(
            (
                journal.0.as_str(),
                journal.1.as_str(),
                journal.2.as_str(),
                journal.3.as_str()
            ),
            ("scope-a", "scope-a/archive-a", "reading_progress", "upsert")
        );
        assert!(journal.4.starts_with("device-"));
        let progress_device: String = connection
            .query_row(
                "SELECT device_id FROM reading_progress WHERE scope_id = 'scope-a' AND archive_id = 'archive-a'",
                [],
                |row| row.get(0),
            )
            .expect("progress device");
        assert_eq!(progress_device, journal.4);
        let history: (i64, i64) = connection
            .query_row(
                "SELECT page_index, revision FROM reading_history WHERE scope_id = 'scope-a' AND archive_id = 'archive-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("history row");
        assert_eq!(history, (4, 1));
        let history_journal_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_journal WHERE scope_id = 'scope-a' AND object_type = 'history'",
                [],
                |row| row.get(0),
            )
            .expect("history journal");
        assert_eq!(history_journal_count, 1);
    }

    #[test]
    fn watchlist_toggle_writes_tombstone_and_journal_in_same_transaction() {
        let mut connection = migrated_connection();
        let added = set_watchlist_entry(&mut connection, "scope-a", "archive-a", true)
            .expect("watchlist add");
        assert!(!added.deleted);
        let removed = set_watchlist_entry(&mut connection, "scope-a", "archive-a", false)
            .expect("watchlist remove");
        assert!(removed.deleted);
        assert_eq!(removed.revision, 2);
        let journal_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_journal WHERE scope_id = 'scope-a' AND object_id = 'scope-a/archive-a' AND object_type = 'watchlist'",
                [],
                |row| row.get(0),
            )
            .expect("watchlist journal count");
        assert_eq!(journal_count, 2);
    }

    #[test]
    fn upload_path_requires_an_existing_supported_archive() {
        let directory =
            std::env::temp_dir().join(format!("yomika-upload-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("temp directory");
        let archive = directory.join("demo.CBZ");
        std::fs::write(&archive, b"archive").expect("fixture");

        let (_, filename) =
            validate_upload_path(archive.to_str().expect("utf8 path")).expect("valid archive");
        assert_eq!(filename, "demo.CBZ");

        let unsupported = directory.join("demo.exe");
        std::fs::write(&unsupported, b"not archive").expect("fixture");
        assert_eq!(
            validate_upload_path(unsupported.to_str().expect("utf8 path")).unwrap_err(),
            "Unsupported archive type"
        );
        assert_eq!(
            validate_upload_path("relative.cbz").unwrap_err(),
            "Archive file not found"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    fn server_input() -> ServerInput {
        ServerInput {
            name: "Home".to_string(),
            base_url: "https://example.com".to_string(),
            scope_id: "scope-a".to_string(),
        }
    }

    #[test]
    fn secret_store_failure_leaves_sqlite_unchanged() {
        let mut connection = migrated_connection();
        let credentials = MemoryCredentialStore {
            writes: Mutex::new(Vec::new()),
            failure: Some("secure storage unavailable"),
        };

        let result = save_server_record(
            &mut connection,
            &credentials,
            server_input(),
            "secret".to_string(),
        );

        assert!(matches!(result, CommandResult::Failure { .. }));
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM servers", [], |row| row.get(0))
            .expect("server count");
        assert_eq!(count, 0);
    }

    #[test]
    fn saved_server_uses_scope_reference_and_never_persists_plaintext_key() {
        let mut connection = migrated_connection();
        let credentials = MemoryCredentialStore {
            writes: Mutex::new(Vec::new()),
            failure: None,
        };

        let result = save_server_record(
            &mut connection,
            &credentials,
            server_input(),
            "secret".to_string(),
        );

        assert!(matches!(result, CommandResult::Success { .. }));
        assert_eq!(
            credentials
                .writes
                .lock()
                .expect("credential writes")
                .as_slice(),
            &[("scope-a".to_string(), "secret".to_string())]
        );
        let stored: (String, String) = connection
            .query_row(
                "SELECT api_key_ref, base_url FROM servers WHERE id = 'scope-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("stored server");
        assert_eq!(
            stored,
            ("scope-a".to_string(), "https://example.com".to_string())
        );
        let visible_text: String = connection
            .query_row(
                "SELECT id || name || base_url || COALESCE(api_key_ref, '') || scope_id FROM servers",
                [],
                |row| row.get(0),
            )
            .expect("visible server text");
        assert!(!visible_text.contains("secret"));
    }

    fn enabled_flags(connection: &Connection) -> Vec<(String, i64)> {
        let mut statement = connection
            .prepare("SELECT id, enabled FROM servers ORDER BY id")
            .expect("flags query");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("flags rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("flags")
    }

    #[test]
    fn a_second_saved_server_starts_disabled_and_edits_keep_the_flag() {
        let mut connection = migrated_connection();
        let credentials = MemoryCredentialStore {
            writes: Mutex::new(Vec::new()),
            failure: None,
        };

        let first = match save_server_record(&mut connection, &credentials, server_input(), "secret".into()) {
            CommandResult::Success { value, .. } => value,
            CommandResult::Failure { error, .. } => panic!("first save: {}", error.message),
        };
        assert!(first.enabled, "the first configured server is the enabled one");

        let mut second = server_input();
        second.name = "Office".to_string();
        second.scope_id = "scope-b".to_string();
        let second_record = match save_server_record(&mut connection, &credentials, second, "secret-b".into()) {
            CommandResult::Success { value, .. } => value,
            CommandResult::Failure { error, .. } => panic!("second save: {}", error.message),
        };
        assert!(
            !second_record.enabled,
            "a new server must not steal the shelves from the enabled one"
        );

        // Re-saving the same identity (edit) keeps each row's own flag.
        match save_server_record(&mut connection, &credentials, server_input(), "secret".into()) {
            CommandResult::Success { value, .. } => assert!(value.enabled),
            CommandResult::Failure { error, .. } => panic!("edit first: {}", error.message),
        }
        let mut second_again = server_input();
        second_again.name = "Office".to_string();
        second_again.scope_id = "scope-b".to_string();
        match save_server_record(&mut connection, &credentials, second_again, "secret-b".into()) {
            CommandResult::Success { value, .. } => assert!(!value.enabled),
            CommandResult::Failure { error, .. } => panic!("edit second: {}", error.message),
        }
    }

    #[test]
    fn enabling_a_server_disables_the_previous_one() {
        let mut connection = migrated_connection();
        let credentials = MemoryCredentialStore {
            writes: Mutex::new(Vec::new()),
            failure: None,
        };
        save_server_record(&mut connection, &credentials, server_input(), "secret".into());
        let mut second = server_input();
        second.name = "Office".to_string();
        second.scope_id = "scope-b".to_string();
        save_server_record(&mut connection, &credentials, second, "secret-b".into());

        let switched = match set_server_enabled_record(&mut connection, "scope-b", true) {
            CommandResult::Success { value, .. } => value,
            CommandResult::Failure { error, .. } => panic!("switch: {}", error.message),
        };
        assert!(switched.enabled);
        assert_eq!(
            enabled_flags(&connection),
            vec![
                ("scope-a".to_string(), 0),
                ("scope-b".to_string(), 1),
            ]
        );
    }

    #[test]
    fn the_last_enabled_server_cannot_be_disabled() {
        let mut connection = migrated_connection();
        let credentials = MemoryCredentialStore {
            writes: Mutex::new(Vec::new()),
            failure: None,
        };
        save_server_record(&mut connection, &credentials, server_input(), "secret".into());

        let refused = set_server_enabled_record(&mut connection, "scope-a", false);
        assert!(
            matches!(refused, CommandResult::Failure { .. }),
            "stopping the only enabled server left the app without a data source"
        );
        assert_eq!(
            enabled_flags(&connection),
            vec![("scope-a".to_string(), 1)]
        );
    }

    #[test]
    fn an_unknown_server_cannot_be_enabled() {
        let mut connection = migrated_connection();
        assert!(matches!(
            set_server_enabled_record(&mut connection, "scope-gone", true),
            CommandResult::Failure { .. }
        ));
    }

    #[test]
    fn empty_api_key_is_rejected_before_server_persistence() {
        let mut connection = migrated_connection();
        let credentials = MemoryCredentialStore {
            writes: Mutex::new(Vec::new()),
            failure: None,
        };

        let result = save_server_record(
            &mut connection,
            &credentials,
            server_input(),
            "  ".to_string(),
        );

        assert!(matches!(result, CommandResult::Failure { .. }));
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM servers", [], |row| row.get(0))
            .expect("server count");
        assert_eq!(count, 0);
        assert!(credentials
            .writes
            .lock()
            .expect("credential writes")
            .is_empty());
    }

    #[test]
    fn lanraragi_authentication_base64_encodes_utf8_key_bytes() {
        assert_eq!(authorization_value("secret"), "Bearer c2VjcmV0");
        assert_eq!(authorization_value("密钥"), "Bearer 5a+G6ZKl");
    }

    #[test]
    fn missing_secure_storage_key_has_recovery_message() {
        assert_eq!(
            credential_read_error("No matching entry found in secure storage".to_string()),
            "服务器凭据不可用，请重新保存 API Key"
        );
    }

    #[test]
    fn search_response_validation_maps_archive_metadata() {
        let json = format!(
            r#"{{"data":[{{"arcid":"{}","title":"Archive","filename":"a.zip","tags":"language:english, artist:test","summary":null,"isnew":false,"extension":"zip","progress":0,"pagecount":12,"lastreadtime":0,"size":10}}],"recordsFiltered":1,"recordsTotal":1}}"#,
            "a".repeat(40),
        );

        let archives = parse_search_response(&json).expect("valid search response");

        assert_eq!(archives.len(), 1);
        assert_eq!(archives[0].archive_id, "a".repeat(40));
        assert_eq!(archives[0].page_count, 12);
        assert_eq!(archives[0].tags, vec!["language:english", "artist:test"]);
        assert!(parse_search_response(
            r#"{"data":[{"arcid":"bad"}],"recordsFiltered":1,"recordsTotal":1}"#
        )
        .is_err());
    }

    #[test]
    fn archive_refresh_upserts_current_rows_and_tombstones_missing_rows() {
        let mut connection = migrated_connection();
        connection
            .execute(
                "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Home', 'https://example.com', 'scope-a')",
                [],
            )
            .expect("server row");
        let first = vec![
            RemoteArchive {
                archive_id: "a".repeat(40),
                title: "First".to_string(),
                summary: None,
                tags: vec!["artist:first".to_string()],
                page_count: 10,
                size: 100,
            },
            RemoteArchive {
                archive_id: "b".repeat(40),
                title: "Second".to_string(),
                summary: Some("summary".to_string()),
                tags: Vec::new(),
                page_count: 20,
                size: 200,
            },
        ];
        replace_server_archives(&mut connection, "scope-a", &first).expect("first refresh");

        let current = vec![RemoteArchive {
            archive_id: "a".repeat(40),
            title: "First updated".to_string(),
            summary: None,
            tags: vec!["artist:first".to_string()],
            page_count: 11,
            size: 110,
        }];
        let visible =
            replace_server_archives(&mut connection, "scope-a", &current).expect("second refresh");

        assert_eq!(visible.len(), 1);
        assert_eq!(
            (visible[0].title.as_str(), visible[0].page_count),
            ("First updated", 11)
        );
        let deleted: i64 = connection
            .query_row(
                "SELECT is_deleted FROM archives WHERE server_id = 'scope-a' AND archive_id = ?1",
                ["b".repeat(40)],
                |row| row.get(0),
            )
            .expect("tombstoned archive");
        assert_eq!(deleted, 1);
    }

    #[test]
    fn missing_metadata_status_tombstones_only_definitively_missing_archives() {
        let connection = migrated_connection();
        connection.execute(
            "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Home', 'https://example.com', 'scope-a')",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count, is_deleted) VALUES ('scope-a', 'archive-a', 'Stale', 'stale', '[]', 1, 0)",
            [],
        ).unwrap();

        assert!(!reconcile_missing_archive_status(
            &connection,
            "scope-a",
            "archive-a",
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
        )
        .unwrap());
        assert_eq!(connection.query_row(
            "SELECT is_deleted FROM archives WHERE server_id='scope-a' AND archive_id='archive-a'",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 0);

        assert!(reconcile_missing_archive_status(
            &connection,
            "scope-a",
            "archive-a",
            reqwest::StatusCode::BAD_REQUEST,
        )
        .unwrap());
        assert_eq!(connection.query_row(
            "SELECT is_deleted FROM archives WHERE server_id='scope-a' AND archive_id='archive-a'",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 1);
    }

    #[test]
    fn archive_query_searches_title_and_tags_beyond_the_first_page() {
        let connection = migrated_connection();
        connection.execute(
            "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Test', 'https://lrr.test', 'scope-a')",
            [],
        ).unwrap();
        for index in 0..150 {
            connection.execute(
                "INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count) VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                params!["scope-a", format!("archive-{index:03}"), format!("Unrelated {index:03}"), format!("unrelated {index:03}"), r#"["artist:other"]"#],
            ).unwrap();
        }
        connection.execute(
            "INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count) VALUES (?1, ?2, ?3, ?4, ?5, 12)",
            params!["scope-a", "target", "Moon Reader", "moon reader", r#"["artist:alpha","language:chinese","date_added:1756512000"]"#],
        ).unwrap();

        let page = query_archive_page(
            &connection,
            &ArchiveQueryInput {
                server_id: "scope-a".to_string(),
                query: "artist:alpha, moon".to_string(),
                sort_by: "title".to_string(),
                order: "asc".to_string(),
                category_id: None,
                untagged_only: None,
                offset: 0,
                limit: 100,
            },
        )
        .expect("full-library search");

        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].archive_id, "target");
        assert_eq!(
            page.items[0].tags,
            vec!["artist:alpha", "language:chinese", "date_added:1756512000"]
        );
    }

    #[test]
    fn archive_query_matches_non_ascii_uppercase_titles() {
        // SQLite's LOWER() leaves "É" alone. Folding the pattern with Rust's
        // full Unicode to_lowercase() produced "é" and the row never matched.
        let connection = migrated_connection();
        connection.execute_batch(
            "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Test', 'https://lrr.test', 'scope-a');
             INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count) VALUES
               ('scope-a', 'accented', 'Éclair Special', 'éclair special', '[]', 1);",
        ).unwrap();

        let page = query_archive_page(
            &connection,
            &ArchiveQueryInput {
                server_id: "scope-a".to_string(),
                query: "Éclair".to_string(),
                sort_by: "title".to_string(),
                order: "asc".to_string(),
                category_id: None,
                untagged_only: None,
                offset: 0,
                limit: 100,
            },
        )
        .expect("accented search");

        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].archive_id, "accented");
    }

    #[test]
    fn archive_query_filters_by_synced_category_membership() {
        let connection = migrated_connection();
        connection.execute_batch(
            "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Test', 'https://lrr.test', 'scope-a');
             INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count) VALUES
               ('scope-a', 'inside', 'Inside', 'inside', '[]', 1),
               ('scope-a', 'outside', 'Outside', 'outside', '[]', 1);
             INSERT INTO archive_categories (server_id, category_id, archive_id) VALUES ('scope-a', 'SET_1613080290', 'inside');",
        ).unwrap();

        let page = query_archive_page(
            &connection,
            &ArchiveQueryInput {
                server_id: "scope-a".to_string(),
                query: String::new(),
                sort_by: "title".to_string(),
                order: "asc".to_string(),
                category_id: Some("SET_1613080290".to_string()),
                untagged_only: None,
                offset: 0,
                limit: 100,
            },
        )
        .expect("category query");

        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].archive_id, "inside");
    }

    #[test]
    fn archive_query_can_ask_for_untagged_archives_only() {
        // The library offers this as a synthetic category because that is where a
        // user looks for it, but it cannot be resolved as one: an archive with no
        // tags is in no category either, so a category filter would return
        // nothing. LANraragi has its own `untaggedonly` switch; this is the
        // offline half of it.
        let connection = migrated_connection();
        connection.execute_batch(
            "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Test', 'https://lrr.test', 'scope-a');
             INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count) VALUES
               ('scope-a', 'bare', 'Bare', 'bare', '[]', 1),
               ('scope-a', 'spaced', 'Spaced', 'spaced', '[ ]', 1),
               ('scope-a', 'tagged', 'Tagged', 'tagged', '[\"artist:alpha\"]', 1);",
        ).unwrap();

        let page = query_archive_page(
            &connection,
            &ArchiveQueryInput {
                server_id: "scope-a".to_string(),
                query: String::new(),
                sort_by: "title".to_string(),
                order: "asc".to_string(),
                category_id: None,
                untagged_only: Some(true),
                offset: 0,
                limit: 100,
            },
        )
        .expect("untagged query");

        assert_eq!(page.total, 2);
        let ids: Vec<&str> = page
            .items
            .iter()
            .map(|item| item.archive_id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec!["bare", "spaced"],
            "an empty array is untagged however it was written"
        );
    }

    #[test]
    fn archive_query_sorts_by_stored_added_at() {
        let connection = migrated_connection();
        connection.execute_batch(
            "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Test', 'https://lrr.test', 'scope-a');
             INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count, local_updated_at, added_at) VALUES
               ('scope-a', 'a-old', 'Old', 'old', '[\"date_added:100\"]', 1, '2026-08-30 00:00:00', 100),
               ('scope-a', 'z-new', 'New', 'new', '[\"date_added:200\"]', 1, '2026-08-30 00:00:00', 200);
             INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count, local_updated_at) VALUES
               ('scope-a', 'm-legacy', 'Legacy', 'legacy', '[\"date_added:150\"]', 1, '2026-08-30 00:00:00');",
        ).unwrap();

        let page = query_archive_page(
            &connection,
            &ArchiveQueryInput {
                server_id: "scope-a".to_string(),
                query: String::new(),
                sort_by: "added".to_string(),
                order: "desc".to_string(),
                category_id: None,
                untagged_only: None,
                offset: 0,
                limit: 100,
            },
        )
        .expect("date-added query");

        // Stored values drive the order; a row with no stored value (only
        // possible before the 0016 backfill) sorts last but still reports the
        // date carried by its tags.
        assert_eq!(
            page.items
                .iter()
                .map(|item| item.archive_id.as_str())
                .collect::<Vec<_>>(),
            vec!["z-new", "a-old", "m-legacy"]
        );
        assert_eq!(
            page.items
                .iter()
                .map(|item| item.added_at)
                .collect::<Vec<_>>(),
            vec![Some(200), Some(100), Some(150)]
        );
    }

    #[test]
    fn archive_added_at_migration_backfills_the_date_added_tag() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .expect("initial");
        connection
            .execute_batch(include_str!("../../migrations/0002_local_library.sql"))
            .expect("library");
        connection.execute_batch(
            "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Test', 'https://lrr.test', 'scope-a');
             INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count) VALUES
               ('scope-a', 'legacy', 'Legacy', 'legacy', '[\"artist:someone\",\"date_added:1756512000\"]', 1);",
        ).expect("legacy row");

        connection
            .execute_batch(include_str!("../../migrations/0016_archive_added_at.sql"))
            .expect("added_at migration");

        let added: Option<i64> = connection
            .query_row(
                "SELECT added_at FROM archives WHERE archive_id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .expect("backfilled row");
        assert_eq!(added, Some(1_756_512_000));
    }

    #[test]
    fn reader_file_list_parses_pages_and_rejects_missing_pages() {
        let pages = parse_reader_file_list(r#"{"job":12,"pages":["00.jpg","01.jpg"]}"#)
            .expect("valid reader file list");
        assert_eq!(pages, vec!["00.jpg", "01.jpg"]);
        assert!(parse_reader_file_list(r#"{"job":12}"#).is_err());
    }

    #[test]
    fn reader_file_list_accepts_official_lanraragi_page_urls() {
        let archive_id = "28697b96f0ac5858be2614ed10ca47742c9522fd";
        let body = format!(
            r#"{{"job":561,"pages":["./api/archives/{archive_id}/page&path=00.jpg","./api/archives/{archive_id}/page?path=chapter%2F01.webp"]}}"#
        );

        let pages = parse_reader_file_list(&body).expect("official LANraragi page URLs");

        assert_eq!(pages, vec!["00.jpg", "chapter/01.webp"]);
    }

    #[test]
    fn reader_page_path_accepts_relative_image_path_only() {
        assert_eq!(normalize_reader_page_path("00.jpg").unwrap(), "00.jpg");
        assert_eq!(
            normalize_reader_page_path("./chapter/01.webp").unwrap(),
            "chapter/01.webp"
        );
        assert!(normalize_reader_page_path("/etc/passwd").is_err());
        assert!(normalize_reader_page_path("../secret.jpg").is_err());
        assert!(normalize_reader_page_path("https://evil.test/x").is_err());
    }

    #[test]
    fn reader_page_file_cache_is_content_addressed_scoped_and_self_healing() {
        let connection = migrated_connection();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let app_data = std::env::temp_dir().join(format!(
            "yomika-reader-cache-{}-{unique}",
            std::process::id()
        ));
        let bytes = b"reader page";

        store_reader_page_cache(
            &connection,
            &app_data,
            "scope-a",
            "archive-a",
            0,
            "image/jpeg",
            bytes,
        )
        .expect("stored page");
        assert_eq!(
            load_reader_page_cache(&connection, &app_data, "scope-a", "archive-a", 0).unwrap(),
            Some(bytes.to_vec())
        );
        assert_eq!(
            load_reader_page_cache(&connection, &app_data, "scope-b", "archive-a", 0).unwrap(),
            None
        );
        store_reader_page_cache(
            &connection,
            &app_data,
            "scope-b",
            "archive-a",
            0,
            "image/jpeg",
            bytes,
        )
        .expect("shared content stored for second scope");
        assert_eq!(
            load_reader_page_cache(&connection, &app_data, "scope-b", "archive-a", 0).unwrap(),
            Some(bytes.to_vec())
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM cache_entries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );

        let relative_path: String = connection
            .query_row(
                "SELECT path FROM cache_entries WHERE key=?1",
                [reader_page_cache_key("scope-a", "archive-a", 0)],
                |row| row.get(0),
            )
            .unwrap();
        assert!(relative_path.starts_with("cache/images/"));
        let stored_path = app_data.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        assert_eq!(std::fs::read(&stored_path).unwrap(), bytes);
        assert!(!stored_path
            .parent()
            .unwrap()
            .read_dir()
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp")));

        std::fs::write(&stored_path, b"corrupt").unwrap();
        assert_eq!(
            load_reader_page_cache(&connection, &app_data, "scope-a", "archive-a", 0).unwrap(),
            None
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM cache_entries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn task_runtime_recovers_interrupted_jobs_and_enforces_transitions() {
        let connection = migrated_connection();
        connection
            .execute_batch(
                "INSERT INTO tasks (id,kind,label,status,progress,cancelable,retryable) VALUES
          ('recover','download','Recover','running',0.4,1,1),
          ('stop','maintenance','Stop','running',0.2,0,0);",
            )
            .unwrap();

        assert_eq!(recover_interrupted_tasks(&connection).unwrap(), 2);
        assert_eq!(
            connection
                .query_row("SELECT status FROM tasks WHERE id='recover'", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "queued"
        );
        assert_eq!(
            connection
                .query_row("SELECT status FROM tasks WHERE id='stop'", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            "failed"
        );

        assert!(
            transition_task(&connection, "recover", Some("completed"), Some(0.5), None).is_err()
        );
        assert!(transition_task(&connection, "recover", Some("running"), Some(0.3), None).is_err());
        transition_task(&connection, "recover", Some("running"), Some(0.5), None).unwrap();
        transition_task(
            &connection,
            "recover",
            Some("failed"),
            None,
            Some("offline"),
        )
        .unwrap();
        assert_eq!(
            retry_failed_task(&connection, "recover").unwrap().status,
            "queued"
        );
        assert!(retry_failed_task(&connection, "stop").is_err());
    }

    #[test]
    fn refresh_archives_query_builder_constructs_correct_url_with_defaults() {
        let url = build_refresh_search_url(
            "https://lrr.example.com",
            &RefreshSearchParams {
                filter: None,
                start: None,
                sortby: None,
                order: None,
                newonly: None,
                untaggedonly: None,
                hidecompleted: None,
                category: None,
                groupby_tanks: None,
            },
        )
        .unwrap();
        assert!(url.contains("/api/search?"));
        // Defaulting to `start=-1` asked for the whole library unpaged, which no
        // caller should get by accident: it is the request that could not finish
        // inside the timeout. An omitted offset means the first page.
        assert!(url.contains("start=0"), "{url}");
        // LANraragi warns on every request when sortby is missing, so the
        // builder must always emit a sort key and order.
        assert!(url.contains("sortby=date_added"));
        assert!(url.contains("order=desc"));
        assert!(!url.contains("filter="));
        assert!(!url.contains("category="));
    }

    #[test]
    fn random_search_url_uses_the_native_endpoint_with_a_clamped_count() {
        let url = build_random_search_url(
            "https://lrr.example.com/",
            &RandomArchivesInput {
                server_id: "scope-a".to_string(),
                count: Some(8),
                filter: None,
                category: None,
            },
        );
        assert_eq!(url, "https://lrr.example.com/api/search/random?count=8");

        let clamped = build_random_search_url(
            "https://lrr.example.com",
            &RandomArchivesInput {
                server_id: "scope-a".to_string(),
                count: Some(9999),
                filter: Some("fate$".to_string()),
                category: Some("SET_1613080290".to_string()),
            },
        );
        assert!(clamped.contains("count=100"));
        assert!(clamped.contains("filter=fate%24"));
        assert!(clamped.contains("category=SET_1613080290"));
    }

    #[test]
    fn random_response_parses_without_result_counts() {
        let archives = parse_random_response(
            r#"{"data":[{"arcid":"0123456789012345678901234567890123456789","title":"Random","tags":"artist:someone, date_added:1756512000","pagecount":12,"size":2048,"summary":null}]}"#,
        ).expect("random payload");
        assert_eq!(archives.len(), 1);
        assert_eq!(archives[0].page_count, 12);
    }

    #[test]
    fn random_upsert_keeps_the_rest_of_the_index_alive() {
        let mut connection = migrated_connection();
        connection.execute_batch(
            "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Test', 'https://lrr.test', 'scope-a');
             INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count, added_at) VALUES
               ('scope-a', 'keep-me', 'Keep', 'keep', '[]', 1, 100);",
        ).unwrap();
        let random = vec![RemoteArchive {
            archive_id: "0123456789012345678901234567890123456789".to_string(),
            title: "Random".to_string(),
            summary: None,
            tags: vec!["date_added:200".to_string()],
            page_count: 3,
            size: 10,
        }];

        upsert_server_archives(&mut connection, "scope-a", &random).expect("upsert");

        let alive: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM archives WHERE server_id='scope-a' AND is_deleted=0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(alive, 2, "a random pull must not tombstone the library");

        let records = query_archive_records_by_ids(
            &connection,
            "scope-a",
            &[
                "0123456789012345678901234567890123456789".to_string(),
                "keep-me".to_string(),
            ],
        )
        .expect("records by id");
        assert_eq!(
            records
                .iter()
                .map(|record| record.archive_id.as_str())
                .collect::<Vec<_>>(),
            vec!["0123456789012345678901234567890123456789", "keep-me"]
        );
    }

    #[test]
    fn archives_by_ids_answers_in_order_past_the_parameter_cap() {
        // The shelves pass their whole id list, which has no upper bound, so the
        // query chunks. Order still has to follow the ids as asked, and ids the
        // local index has not seen are dropped rather than faked.
        let mut connection = migrated_connection();
        connection.execute(
            "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Test', 'https://lrr.test', 'scope-a')",
            [],
        ).unwrap();
        let total = 1_200;
        {
            let transaction = connection.transaction().unwrap();
            for index in 0..total {
                transaction.execute(
                    "INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count, added_at) VALUES ('scope-a', ?1, ?2, ?2, '[]', 1, ?3)",
                    rusqlite::params![format!("id-{index:04}"), format!("title {index}"), index as i64],
                ).unwrap();
            }
            transaction.commit().unwrap();
        }

        // Reversed, so a wrong answer would come back in insert or rowid order.
        let mut requested = (0..total)
            .rev()
            .map(|index| format!("id-{index:04}"))
            .collect::<Vec<_>>();
        requested.push("never-indexed".to_string());
        let records = query_archive_records_by_ids(&connection, "scope-a", &requested)
            .expect("records by id");

        assert_eq!(
            records.len(),
            total as usize,
            "the unknown id must not add a row"
        );
        assert_eq!(
            records.first().map(|record| record.archive_id.as_str()),
            Some("id-1199")
        );
        assert_eq!(
            records.last().map(|record| record.archive_id.as_str()),
            Some("id-0000")
        );
    }

    #[test]
    fn archives_by_ids_skips_tombstoned_rows() {
        let connection = migrated_connection();
        connection.execute_batch(
            "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Test', 'https://lrr.test', 'scope-a');
             INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count, added_at, is_deleted) VALUES
               ('scope-a', 'alive', 'Alive', 'alive', '[]', 1, 100, 0),
               ('scope-a', 'gone', 'Gone', 'gone', '[]', 1, 200, 1);",
        ).unwrap();

        let records = query_archive_records_by_ids(
            &connection,
            "scope-a",
            &["gone".to_string(), "alive".to_string()],
        )
        .expect("records by id");

        assert_eq!(
            records
                .iter()
                .map(|record| record.archive_id.as_str())
                .collect::<Vec<_>>(),
            vec!["alive"]
        );
    }

    #[test]
    fn search_presets_round_trip_tombstone_and_journal() {
        // Presets sync like every other user record, so saving one has to leave a
        // journal row; deleting is a tombstone, not a hard delete, or a delete
        // would never reach the other device.
        let mut connection = migrated_connection();
        connection.execute(
            "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Test', 'https://lrr.test', 'scope-a')",
            [],
        ).unwrap();

        let input = SearchPresetInput {
            scope_id: "scope-a".to_string(),
            preset_id: "preset-1".to_string(),
            name: "  中文汉化  ".to_string(),
            query: "language:chinese$".to_string(),
            sort_by: "added".to_string(),
            sort_order: "desc".to_string(),
            category_id: None,
        };
        let saved = write_search_preset(&mut connection, &input).expect("save preset");
        assert_eq!(saved.name, "中文汉化");
        assert_eq!(saved.revision, 1);
        assert!(!saved.deleted);

        let again = write_search_preset(&mut connection, &input).expect("update preset");
        assert_eq!(again.revision, 2);

        let journalled: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_journal WHERE object_type='search_preset'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(journalled, 2);
    }

    #[test]
    fn search_page_carries_the_result_counts() {
        let json = r#"{
            "data": [
                {"arcid":"aaaa1111bbbb2222cccc3333dddd4444eeee5555","title":"One","filename":"one","tags":"artist:test","isnew":false,"extension":"zip","progress":0,"pagecount":20,"lastreadtime":0,"size":2048}
            ],
            "recordsFiltered": 137,
            "recordsTotal": 9001
        }"#;
        // How many pages there are is `recordsFiltered`, not a local COUNT(*):
        // the query ran on the server, so only the server knows what it selected.
        let (archives, filtered, total) = parse_search_page(json).expect("page");
        assert_eq!(archives.len(), 1);
        assert_eq!(filtered, 137);
        assert_eq!(total, 9001);
    }

    #[test]
    fn a_page_walk_stops_on_a_short_page_or_a_satisfied_count() {
        // A full page is not the end, even when it is the only page seen so far.
        assert!(!search_walk_is_done(100, 100, 100, 250));
        // The tail is short.
        assert!(search_walk_is_done(50, 100, 250, 250));
        // Every page came back full and the count is satisfied, so there is
        // nothing left to ask for — without this the walk would keep requesting
        // offsets past the end of the result set.
        assert!(search_walk_is_done(100, 100, 200, 200));
        // An empty answer ends the walk whatever the server claimed to hold.
        assert!(search_walk_is_done(0, 100, 0, 500));
    }

    #[test]
    fn the_remote_list_sends_filter_and_category_to_the_server() {
        // The point of the rework: LANraragi resolves the search expression and
        // the category, so a dynamic category costs the client nothing and the
        // list shows what the server holds right now.
        let url = build_refresh_search_url(
            "https://lrr.example.com",
            &RefreshSearchParams {
                filter: Some("artist:someone$".to_string()),
                start: Some(240),
                sortby: Some("date_added".to_string()),
                order: Some("asc".to_string()),
                newonly: None,
                untaggedonly: None,
                hidecompleted: None,
                category: Some("SET_1613080290".to_string()),
                groupby_tanks: None,
            },
        )
        .expect("remote list url");
        assert!(url.contains("start=240"), "{url}");
        assert!(url.contains("filter=artist%3Asomeone%24"), "{url}");
        assert!(url.contains("category=SET_1613080290"), "{url}");
        assert!(url.contains("sortby=date_added"), "{url}");
        assert!(url.contains("order=asc"), "{url}");
    }

    #[test]
    fn the_ui_sort_key_maps_onto_the_lanraragi_one() {
        assert_eq!(remote_sort_key("added"), Some("date_added"));
        assert_eq!(remote_sort_key("title"), Some("title"));
        // An unknown key is rejected rather than quietly sorted by title, which
        // is what LANraragi itself falls back to.
        assert_eq!(remote_sort_key("size"), None);
        assert_eq!(remote_sort_key(""), None);
    }

    #[test]
    fn probe_only_asks_for_the_newest_page_and_flags_unknown_archives() {
        // The probe answers "is there anything new" and must stay on one page,
        // whatever the offline index rebuild happens to cost.
        let url = build_probe_search_url("https://lrr.example.com/").expect("probe url");
        assert!(url.contains("start=0"), "{url}");
        assert!(url.contains("sortby=date_added"), "{url}");
        assert!(url.contains("order=desc"), "{url}");
        assert!(!url.contains("filter="), "{url}");

        let connection = migrated_connection();
        connection.execute_batch(
            "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Test', 'https://lrr.test', 'scope-a');
             INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count) VALUES
               ('scope-a', 'known', 'Known', 'known', '[]', 1),
               ('scope-a', 'tombstoned', 'Gone', 'gone', '[]', 1);
             UPDATE archives SET is_deleted = 1 WHERE archive_id = 'tombstoned';",
        ).unwrap();

        let unknown = unknown_probe_archive_ids(
            &connection,
            "scope-a",
            &[
                "known".to_string(),
                "fresh".to_string(),
                "tombstoned".to_string(),
            ],
        )
        .expect("probe diff");

        assert_eq!(unknown, vec!["fresh".to_string(), "tombstoned".to_string()]);
        assert!(
            unknown_probe_archive_ids(&connection, "scope-a", &["known".to_string()])
                .expect("known only")
                .is_empty()
        );
    }

    #[test]
    fn invalidating_the_category_cache_only_drops_the_named_server() {
        // Assigning, retagging or deleting an archive changes what a category
        // holds, so the snapshot has to go — but only that server's, and asking
        // twice must not turn into an error.
        let connection = migrated_connection();
        let categories = vec![CategoryRecord {
            id: "SET_1613080290".to_string(),
            name: "Static".to_string(),
            pinned: false,
            search: None,
            archives: vec!["archive-a".to_string()],
        }];
        write_category_cache(&connection, "scope-a", &categories, false).expect("write a");
        write_category_cache(&connection, "scope-b", &categories, false).expect("write b");

        invalidate_category_cache(&connection, "scope-a").expect("invalidate");
        invalidate_category_cache(&connection, "scope-a").expect("invalidate again");

        assert!(
            read_category_cache_from(&connection, "scope-a", current_unix_seconds())
                .expect("read a")
                .is_none()
        );
        assert!(
            read_category_cache_from(&connection, "scope-b", current_unix_seconds())
                .expect("read b")
                .is_some(),
            "the other server's snapshot must survive"
        );
    }

    #[test]
    fn category_cache_serves_a_fresh_snapshot_and_expires_an_old_one() {
        // Every dynamic category costs one unpaged /api/search, so navigating
        // back to the library must read this snapshot instead of re-resolving.
        let connection = migrated_connection();
        let categories = vec![CategoryRecord {
            id: "SET_1613080290".to_string(),
            name: "Dynamic".to_string(),
            pinned: true,
            search: Some("artist:someone$".to_string()),
            archives: vec!["archive-a".to_string()],
        }];
        write_category_cache(&connection, "scope-a", &categories, false).expect("write");

        let fresh = read_category_cache_from(&connection, "scope-a", current_unix_seconds())
            .expect("read fresh");
        assert_eq!(fresh.as_ref().map(|items| items.len()), Some(1));
        assert_eq!(
            fresh.expect("snapshot")[0].search.as_deref(),
            Some("artist:someone$")
        );

        let stale = read_category_cache_from(
            &connection,
            "scope-a",
            current_unix_seconds() + CATEGORY_CACHE_MAX_AGE_SECONDS + 1,
        )
        .expect("read stale");
        assert!(stale.is_none(), "an aged snapshot must be refetched");
        assert!(
            read_category_cache_from(&connection, "scope-b", current_unix_seconds())
                .expect("read other scope")
                .is_none()
        );

        // A snapshot in which a dynamic category failed to resolve holds an empty
        // membership, which looks exactly like an empty category — so it ages out
        // in minutes rather than hiding those archives for six hours.
        write_category_cache(&connection, "scope-c", &categories, true).expect("write partial");
        assert!(
            read_category_cache_from(&connection, "scope-c", current_unix_seconds())
                .expect("read partial")
                .is_some()
        );
        assert!(
            read_category_cache_from(
                &connection,
                "scope-c",
                current_unix_seconds() + PARTIAL_CATEGORY_CACHE_MAX_AGE_SECONDS + 1,
            )
            .expect("read aged partial")
            .is_none(),
            "a partial snapshot must not last the full window"
        );
    }

    #[test]
    fn dynamic_category_search_always_carries_a_sort_key() {
        // LANraragi's Controller/Api/Search.pm reads `sortby` with no default,
        // so an omitted one logs "uninitialized value $sortkey" at
        // Model/Search.pm:51/52/57 and skips its search cache.
        let url = build_category_search_url("https://lrr.example.com/", "artist:someone$")
            .expect("dynamic category url");
        assert!(url.starts_with("https://lrr.example.com/api/search?"));
        assert!(url.contains("sortby=date_added"), "{url}");
        assert!(url.contains("order=desc"), "{url}");
        assert!(url.contains("start=-1"), "{url}");
        assert!(url.contains("filter=artist%3Asomeone%24"), "{url}");
    }

    #[test]
    fn refresh_archives_query_builder_rejects_a_blank_or_unknown_sort() {
        let blank = build_refresh_search_url(
            "https://lrr.example.com",
            &RefreshSearchParams {
                filter: None,
                start: None,
                sortby: Some("   ".to_string()),
                order: Some("sideways".to_string()),
                newonly: None,
                untaggedonly: None,
                hidecompleted: None,
                category: None,
                groupby_tanks: None,
            },
        )
        .unwrap();
        assert!(blank.contains("sortby=date_added"));
        assert!(blank.contains("order=desc"));
    }

    #[test]
    fn refresh_archives_query_builder_includes_all_parameters() {
        let url = build_refresh_search_url(
            "https://lrr.example.com/",
            &RefreshSearchParams {
                filter: Some("fate$".to_string()),
                start: Some(0),
                sortby: Some("title".to_string()),
                order: Some("asc".to_string()),
                newonly: Some(true),
                untaggedonly: Some(false),
                hidecompleted: Some(true),
                category: Some("a1b2c3d4e5f6g7".to_string()),
                groupby_tanks: Some(false),
            },
        )
        .unwrap();
        assert!(url.contains("filter=fate%24"));
        assert!(url.contains("start=0"));
        assert!(url.contains("sortby=title"));
        assert!(url.contains("order=asc"));
        assert!(url.contains("newonly=true"));
        assert!(url.contains("untaggedonly=false"));
        assert!(url.contains("hidecompleted=true"));
        assert!(url.contains("category=a1b2c3d4e5f6g7"));
        assert!(url.contains("groupby_tanks=false"));
        assert!(!url.ends_with('?'));
        assert!(!url.ends_with('&'));
    }

    #[test]
    fn refresh_archives_builds_auth_header_from_keyring_key() {
        let api_key = "test-api-key-123";
        let header = authorization_value(api_key);
        assert!(header.starts_with("Bearer "));
        let encoded = header.strip_prefix("Bearer ").unwrap();
        let decoded = BASE64_STANDARD.decode(encoded).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), api_key);
    }

    #[test]
    fn refresh_archives_preserves_old_snapshots_on_parse_failure() {
        let mut connection = migrated_connection();
        let creds = MemoryCredentialStore {
            writes: Mutex::new(vec![]),
            failure: None,
        };
        let result = save_server_record(
            &mut connection,
            &creds,
            ServerInput {
                name: "Test".to_string(),
                base_url: "https://lrr.example.com".to_string(),
                scope_id: "scope-refresh".to_string(),
            },
            "key123".to_string(),
        );
        assert!(matches!(result, CommandResult::Success { .. }));

        connection
            .execute(
                "INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count, file_size, local_updated_at, metadata_revision, is_deleted)
                 VALUES ('scope-refresh', 'abc123', 'Old Archive', 'old archive', '[]', 10, 1024, CURRENT_TIMESTAMP, 1, 0)",
                [],
            )
            .unwrap();

        let old_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM archives WHERE server_id = 'scope-refresh' AND is_deleted = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_count, 1);

        let result = parse_search_response("not valid json at all {{{").and_then(|archives| {
            replace_server_archives(&mut connection, "scope-refresh", &archives)
        });
        assert!(result.is_err());

        let still_old: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM archives WHERE server_id = 'scope-refresh' AND is_deleted = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            still_old, 1,
            "old snapshot must be preserved on parse failure"
        );
    }

    #[test]
    fn refresh_archives_success_replaces_index_atomically() {
        let mut connection = migrated_connection();
        let creds = MemoryCredentialStore {
            writes: Mutex::new(vec![]),
            failure: None,
        };
        let result = save_server_record(
            &mut connection,
            &creds,
            ServerInput {
                name: "S".to_string(),
                base_url: "https://lrr.test".to_string(),
                scope_id: "scope-atomic".to_string(),
            },
            "key".to_string(),
        );
        assert!(matches!(result, CommandResult::Success { .. }));

        connection
            .execute(
                "INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count, file_size, local_updated_at, metadata_revision, is_deleted)
                 VALUES ('scope-atomic', 'old1', 'Old', 'old', '[]', 5, 100, CURRENT_TIMESTAMP, 1, 0)",
                [],
            )
            .unwrap();

        let search_json = r#"{
            "data": [
                {"arcid":"aaaa1111bbbb2222cccc3333dddd4444eeee5555","title":"New Archive","filename":"new","tags":"artist:test","isnew":false,"extension":"zip","progress":0,"pagecount":20,"lastreadtime":0,"size":2048},
                {"arcid":"ffff6666aaaa7777bbbb8888cccc9999dddd0000","title":"Another","filename":"another","tags":"parody:series","isnew":true,"extension":"cbz","progress":0,"pagecount":15,"lastreadtime":0,"size":1024}
            ],
            "recordsFiltered": 2,
            "recordsTotal": 2
        }"#;

        let records = parse_search_response(search_json)
            .and_then(|archives| {
                replace_server_archives(&mut connection, "scope-atomic", &archives)
            })
            .unwrap();
        assert_eq!(records.len(), 2);

        let all_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM archives WHERE server_id = 'scope-atomic'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(all_count, 3, "old row tombstoned + 2 new upserted");

        let active_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM archives WHERE server_id = 'scope-atomic' AND is_deleted = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_count, 2);
    }
}

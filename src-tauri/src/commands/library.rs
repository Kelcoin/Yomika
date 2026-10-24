//! LANraragi 客户端命令：服务器、档案、分类、搜索、元数据、阅读进度与书架。
//!
//! 这一层是「远端服务器 + 本机镜像」两边的缝合处，规矩按数据归属分：远端是真相来源的
//! 东西以远端为准、失败就如实报错（`read_favorites_category` 不再拿本地缓存兜底），
//! 本机独有的东西落本地库、镜像只单向写回（`persist_archive_metadata` 不会反过来覆盖
//! 用户自己的整理）。所有同步命令都必须遵守 `command_dispatch` 的不变量：不许 `block_on`、
//! 不许锁那把全局库锁、不许等子进程。

use super::archive_publish::publish_archive_download;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use reqwest::Client;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use tauri::{Manager, State};
use tokio::task::JoinSet;
use url::Url;

use crate::{db::Database, domain::result::CommandResult, settings::get_or_create_device_id};

const KEYRING_SERVICE: &str = "app.yomika.reader";

/// `save_server_record` 收下的 API Key 的长度上限（字符数，不是字节数）。见那里的注释：
/// 上限只为了挡住「把一整段文本当 Key 粘进来」→ 431 这条路。
pub(crate) const MAX_API_KEY_CHARS: usize = 512;

pub trait CredentialStore {
    fn set_server_api_key(&self, scope_id: &str, api_key: &str) -> Result<(), String>;
}

pub(crate) struct SystemCredentialStore;

impl CredentialStore for SystemCredentialStore {
    fn set_server_api_key(&self, scope_id: &str, api_key: &str) -> Result<(), String> {
        // 桌面仍旧是系统凭据库里的那一条 `app.yomika.reader` / scope_id；移动端换成
        // 数据目录里的 secrets.json（见 `secret_store`）。条目名与格式没变。
        crate::secret_store::set_secret(KEYRING_SERVICE, scope_id, api_key)
    }
}

impl SystemCredentialStore {
    pub(crate) fn get_server_api_key(&self, scope_id: &str) -> Result<String, String> {
        crate::secret_store::get_secret(KEYRING_SERVICE, scope_id)
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

impl ServerInput {
    /// 只给凭据导入用：构造的是同一份输入，校验仍在 `save_server_record` 里，所以
    /// 「什么算一台合法的服务器」只有那一处。
    pub(crate) fn new(name: &str, base_url: &str, scope_id: &str) -> Self {
        Self {
            name: name.to_string(),
            base_url: base_url.to_string(),
            scope_id: scope_id.to_string(),
        }
    }
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
    #[serde(default = "default_allow_progress_regression")]
    allow_progress_regression: bool,
    /// Whether page 0 opens alone in double-page mode. `None` leaves whatever was
    /// stored alone, so a caller that does not care cannot erase the setting.
    #[serde(default)]
    cover_alone: Option<bool>,
}

fn default_allow_progress_regression() -> bool { true }

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
    /// 下载任务才有：对应哪一份档案、文件在哪、一共多少、收了多少、多快。
    archive_id: Option<String>,
    server_id: Option<String>,
    local_path: Option<String>,
    total_bytes: Option<i64>,
    received_bytes: i64,
    bytes_per_second: Option<i64>,
}

/// 任务行的列顺序，读它的地方都从这里取，免得加一列要改四处。
const TASK_COLUMNS: &str = "id,kind,label,status,progress,error,cancelable,retryable,created_at,updated_at,archive_id,server_id,local_path,total_bytes,received_bytes,bytes_per_second";

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
        archive_id: row.get(10)?,
        server_id: row.get(11)?,
        local_path: row.get(12)?,
        total_bytes: row.get(13)?,
        received_bytes: row.get(14)?,
        bytes_per_second: row.get(15)?,
    })
}

fn read_task(connection: &rusqlite::Connection, id: &str) -> Result<TaskRecord, String> {
    connection
        .query_row(
            &format!("SELECT {TASK_COLUMNS} FROM tasks WHERE id=?1"),
            [id],
            read_task_row,
        )
        .map_err(|error| error.to_string())
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

fn reader_page_identity(
    scope_id: &str,
    archive_id: &str,
    page_index: i64,
) -> crate::cache::CacheImageIdentity {
    crate::cache::CacheImageIdentity::new(scope_id, archive_id, "reader-page", page_index)
}

fn reader_page_cache_key(scope_id: &str, archive_id: &str, page_index: i64) -> String {
    crate::cache::image_cache_key(&reader_page_identity(scope_id, archive_id, page_index))
}

/// 这两条走的是「锁外落盘/读盘」的那一版：一页图可能上兆，读文件与算摘要都不该
/// 占着全局 DB 锁（偏好、书架、搜索都排在那把锁后面）。
fn load_reader_page_cache(
    database: &crate::db::Database,
    app_data: &std::path::Path,
    scope_id: &str,
    archive_id: &str,
    page_index: i64,
) -> Result<Option<Vec<u8>>, String> {
    let identity = reader_page_identity(scope_id, archive_id, page_index);
    crate::cache::read_cached_image(database, app_data, &identity)
        .map(|image| image.map(|image| image.bytes))
}

fn store_reader_page_cache(
    database: &crate::db::Database,
    app_data: &std::path::Path,
    scope_id: &str,
    archive_id: &str,
    page_index: i64,
    mime: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let identity = reader_page_identity(scope_id, archive_id, page_index);
    crate::cache::write_cached_image(database, app_data, &identity, mime, bytes)
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

#[derive(Debug)]
struct ReaderRequestError {
    code: &'static str,
    message: String,
}

impl ReaderRequestError {
    fn configuration(message: String) -> Self { Self { code: "UNKNOWN", message } }
    fn transport(error: reqwest::Error) -> Self {
        let code = if error.is_timeout() { "REMOTE_TIMEOUT" }
            else if error.is_builder() || error.is_decode() || error.is_redirect() { "REMOTE_UNAVAILABLE" }
            else { "NETWORK" };
        Self { code, message: error.to_string() }
    }
}

impl std::fmt::Display for ReaderRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { self.message.fmt(formatter) }
}
impl From<ReaderRequestError> for String {
    fn from(error: ReaderRequestError) -> Self { error.message }
}

fn reader_response_failure<T>(error: reqwest::Error) -> CommandResult<T> {
    // This is only for raw bytes/text reads, before any JSON/image decoding.
    // reqwest also marks an interrupted Content-Length transfer as is_decode(),
    // so that flag cannot distinguish transport from malformed application JSON.
    let code = if error.is_timeout() { "REMOTE_TIMEOUT" } else { "NETWORK" };
    CommandResult::failure(code, error.to_string(), true)
}

async fn reader_request(
    method: reqwest::Method,
    url: String,
    api_key: String,
) -> Result<reqwest::Response, ReaderRequestError> {
    reader_request_with_timeout(method, url, api_key, 10).await
}

async fn reader_request_with_timeout(
    method: reqwest::Method,
    url: String,
    api_key: String,
    timeout_seconds: u64,
) -> Result<reqwest::Response, ReaderRequestError> {
    lanraragi_client().map_err(ReaderRequestError::configuration)?
        .request(method, url)
        .timeout(std::time::Duration::from_secs(timeout_seconds))
        .header(
            reqwest::header::AUTHORIZATION,
            authorization_value(&api_key),
        )
        .send()
        .await
        .map_err(ReaderRequestError::transport)
}

/// 共享的 LANraragi HTTP 客户端：进程内一份，连接池跨请求复用，
/// TLS/TCP 握手与 keep-alive 不再每次重付。总超时按请求给
/// （RequestBuilder.timeout），连接超时在构建时固定。
fn lanraragi_client() -> Result<Client, String> {
    static CLIENT: std::sync::OnceLock<Result<Client, String>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(std::time::Duration::from_secs(3))
                .build()
                .map_err(|error| error.to_string())
        })
        .clone()
}

/// 阅读进度写回的地址：`PUT /api/archives/{id}/progress/{page}`。
///
/// 契约（using-lanraragi-api 技能，`references/endpoints.md:34`）要求 `page` 是**正
/// 整数**、且不超过总页数——也就是 **1 起算**；本地这一侧永远是 0 起算，所以这里加一。
fn progress_push_url(base_url: &str, archive_id: &str, page_index: i64) -> String {
    format!(
        "{}/api/archives/{}/progress/{}",
        base_url.trim().trim_end_matches('/'),
        archive_id,
        page_index + 1
    )
}

/// 这个 scope 是不是一台远端 LANraragi 服务器？是的话把地址拿出来。
///
/// `servers` 里有这一行才说明档案馆在一台服务器上；本地档案在 `local_archives` 里，
/// 没有对应的服务器行，于是这一步就把它跳过了——本地进度不需要往任何地方发。
///
/// **不**筛 `enabled`：那个标志是「谁的架子摆在首页」（见 `save_server_record`），不是
/// 「还连得上」。用户完全可以一边读着某台服务器的档案，一边把另一台设成默认。
fn progress_push_base_url(connection: &Connection, scope_id: &str) -> Option<String> {
    let base_url: String = connection
        .query_row(
            "SELECT base_url FROM servers WHERE scope_id = ?1",
            [scope_id],
            |row| row.get(0),
        )
        .optional()
        .ok()??;
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    (!base_url.is_empty()).then_some(base_url)
}

/// 能拿去发请求的 Key。空的（这台机器上还没有凭据）和长到不像 Key 的都放弃；
/// 512 是 `MAX_API_KEY_CHARS`，跟保存服务器时用的是同一条线——别让一个几 KB 的头
/// 打出去换回一个对用户毫无意义的 431。
fn usable_api_key(api_key: &str) -> Option<String> {
    let api_key = api_key.trim();
    if api_key.is_empty() || api_key.chars().count() > MAX_API_KEY_CHARS {
        return None;
    }
    Some(api_key.to_string())
}

/// 远端进度写回的合并器。
///
/// 翻页可以很快，但每一页都打一次服务器既没必要也不礼貌（技能的 Common mistakes 里
/// 写着「预加载时不要上报」——我们只在用户真的翻到某页时才走到这里，而这里的合并让
/// 「一分钟滚过三十页」只变成两次请求：在飞的那一次 + 最新那一页）。同一个档案的失败
/// 也只记一条日志，错误日志不会被翻页刷屏。
#[derive(Default)]
struct ProgressPushState {
    /// 正在飞的那些档案（键是 scope + archive）。
    inflight: std::collections::HashSet<String>,
    /// 在飞期间又翻到的页：只留最新那一页。
    pending: std::collections::HashMap<String, i64>,
    /// 被服务器拒过的档案（4xx：地址/Key/档案不对，或者服务端自己管进度）。
    blocked: std::collections::HashSet<String>,
    /// 已经为它写过日志的档案。
    warned: std::collections::HashSet<String>,
}

impl ProgressPushState {
    /// 交一页进来。返回 `true` 表示调用方该起一个 worker；`false` 表示已经有一次在飞
    /// （页码记进 pending，由它收尾）或者这个档案已经放弃。
    fn submit(&mut self, key: &str, page_index: i64) -> bool {
        if self.blocked.contains(key) {
            return false;
        }
        if self.inflight.contains(key) {
            self.pending.insert(key.to_string(), page_index);
            return false;
        }
        self.inflight.insert(key.to_string());
        true
    }

    /// 当前这一页发完了。给出下一个要发的页码；没有就清掉在飞标记。
    fn finish(&mut self, key: &str) -> Option<i64> {
        match self.pending.remove(key) {
            Some(page_index) => Some(page_index),
            None => {
                self.inflight.remove(key);
                None
            }
        }
    }

    /// 这个档案不再试了（4xx）。
    fn block(&mut self, key: &str) {
        self.inflight.remove(key);
        self.pending.remove(key);
        self.blocked.insert(key.to_string());
    }

    /// 这条错误要不要写进错误日志：一个档案只写第一条。
    fn should_warn(&mut self, key: &str) -> bool {
        self.warned.insert(key.to_string())
    }
}

fn progress_push_state() -> &'static std::sync::Mutex<ProgressPushState> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<ProgressPushState>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(ProgressPushState::default()))
}

#[derive(Debug)]
enum ProgressPushOutcome {
    Sent,
    /// 4xx：地址、Key 或档案本身不对，也可能服务端自己管进度
    /// （`/api/info` 的 `server_tracks_progress`）。重试多少次都一样。
    Rejected(String),
    /// 一时失败：网络、超时、5xx。下一次翻页再试。
    Failed(String),
}

async fn push_reading_progress_once(
    base_url: &str,
    api_key: &str,
    archive_id: &str,
    page_index: i64,
) -> ProgressPushOutcome {
    let url = progress_push_url(base_url, archive_id, page_index);
    let response = match reader_request(reqwest::Method::PUT, url, api_key.to_string()).await {
        Ok(response) => response,
        Err(error) => return ProgressPushOutcome::Failed(error.message),
    };
    let status = response.status();
    if status.is_success() {
        return ProgressPushOutcome::Sent;
    }
    let detail = format!("LANraragi 回 {status}");
    // 408 / 429 是「等会儿再来」，其余 4xx 是「别来了」。
    if status.is_client_error()
        && status != reqwest::StatusCode::REQUEST_TIMEOUT
        && status != reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        return ProgressPushOutcome::Rejected(detail);
    }
    ProgressPushOutcome::Failed(detail)
}

/// 顺手把进度打到服务器上。本地那一笔此刻已经落盘了，这里成不成功都不回头。
fn spawn_progress_push(
    app: tauri::AppHandle,
    base_url: String,
    api_key: String,
    archive_id: String,
    first_page_index: i64,
    key: String,
) {
    tauri::async_runtime::spawn(async move {
        let mut page_index = first_page_index;
        loop {
            match push_reading_progress_once(&base_url, &api_key, &archive_id, page_index).await {
                ProgressPushOutcome::Sent => {}
                ProgressPushOutcome::Rejected(detail) => {
                    report_progress_push(&app, &key, &archive_id, page_index, &detail, true);
                    if let Ok(mut state) = progress_push_state().lock() {
                        state.block(&key);
                    }
                    return;
                }
                ProgressPushOutcome::Failed(detail) => {
                    report_progress_push(&app, &key, &archive_id, page_index, &detail, false);
                }
            }
            let next = progress_push_state()
                .lock()
                .ok()
                .and_then(|mut state| state.finish(&key));
            match next {
                Some(value) => page_index = value,
                None => return,
            }
        }
    });
}

/// 失败只进错误日志，而且一个档案只写第一条：翻页很快时同一条错会连着来好几次，刷屏
/// 的会是日志本身。用户看得见的那个 toast 走的是本地保存的结果，不受这里影响。
fn report_progress_push(
    app: &tauri::AppHandle,
    key: &str,
    archive_id: &str,
    page_index: i64,
    detail: &str,
    permanent: bool,
) {
    let first = progress_push_state()
        .lock()
        .map(|mut state| state.should_warn(key))
        .unwrap_or(false);
    if !first {
        return;
    }
    let suffix = if permanent { "，不再重试" } else { "" };
    let _ = crate::error_log::error_log_append(
        app.clone(),
        crate::error_log::ErrorLogAppendInput {
            at: None,
            level: "warn".to_string(),
            source: "reader/progress".to_string(),
            message: format!(
                "阅读进度没能写回 LANraragi（{archive_id} 第 {} 页）{suffix}",
                page_index + 1
            ),
            detail: Some(detail.to_string()),
        },
    );
}

/// `/api/categories` 的回包：一个数组，或把它包在 `data` / `categories` 里的对象
/// （不同版本的写法）。`list_categories` 与 `read_favorites_category` 都吃这一份。
fn parse_category_list(raw: &serde_json::Value) -> Result<Vec<CategoryWire>, String> {
    let items = match raw {
        serde_json::Value::Array(items) => serde_json::Value::Array(items.clone()),
        serde_json::Value::Object(object) => {
            let mut object = object.clone();
            object
                .remove("data")
                .or_else(|| object.remove("categories"))
                .unwrap_or(serde_json::Value::Array(Vec::new()))
        }
        _ => serde_json::Value::Null,
    };
    if items.is_null() {
        return serde_json::from_str("null").map_err(|error| error.to_string());
    }
    serde_json::from_value(items).map_err(|error| error.to_string())
}

/// 线上表示到本地记录：`pinned` 在不同版本里是布尔、0/1 或 "0"/"1"。
fn category_record(category: CategoryWire) -> CategoryRecord {
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
        Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
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
    let wire = match parse_category_list(&raw_categories) {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("INVALID_RESPONSE", error, false)),
    };
    let mut categories: Vec<CategoryRecord> = wire.into_iter().map(category_record).collect();
    // LANraragi leaves `archives` empty for dynamic categories. Resolve those
    // categories concurrently through their documented search expression so
    // one slow category cannot serialize the entire detail page.
    // Two at a time: each resolution is an unpaged full-library search, and a
    // library with many dynamic categories would otherwise fire them all at once.
    let mut dynamic_categories = JoinSet::new();
    let mut resolved = Vec::new();
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
            resolve_category_archives(&base_url, &api_key, &search)
                .await
                .map(|archives| (index, archives))
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
        Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
        Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
        Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
        Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
        Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
        Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
    };
    let status = response.status();
    if matches!(
        status,
        reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::NOT_FOUND
    ) {
        let reconciliation = database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
    let persisted = database.connection.lock()
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
        .and_then(|mut connection| persist_archive_metadata(&mut connection, &server_id, &wire));
    if let Err(error) = persisted {
        return Ok(CommandResult::failure("LOCAL_DATABASE", error, true));
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
) -> Result<CommandResult<DownloadResult>, String> {
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
            .map_err(|_| crate::cache::LOCK_FAILED.to_string())?;
        let (base_url, scope_id) = server_connection(&connection, &server_id)?;
        let directory = resolved_download_directory(&app, &connection)?;
        (base_url, scope_id, directory)
    };
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<DownloadResult, String> {
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
        let database = app.state::<Database>();
        transfer_archive(
            &database,
            TransferRequest {
                client,
                api_key,
                base_url,
                server_id,
                scope_id,
                archive_id,
                directory,
                metadata,
                task: None,
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(match result {
        Ok(download) => CommandResult::success(download),
        Err(error) => CommandResult::failure("REMOTE_UNAVAILABLE", error, true),
    })
}

/// 下载对外报的结果：状态、落盘路径（中止时是空串）和任务 id。暂停不是失败，
/// 所以它和完成一样走成功分支。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    status: String,
    path: String,
    task_id: String,
}

/// 一次 HTTP 请求唯一能停下来的地方就是块与块之间：暂停与中止都是前端写这个
/// 信号、流式循环读它。
#[derive(Clone, Copy, PartialEq, Eq)]
enum DownloadSignal {
    Running,
    Paused,
    Aborted,
}

/// 信号表的上限。正常只有一个下载在跑，条目在循环结束时由 `clear_download_signal`
/// 删掉；但 `pause_download`/`cancel_download` 是拿前端给的任务 id 直接
/// `set_download_signal` 的，对一个早就不在传输的 id 也会在这里留下一条永不清理的
/// 条目——于是这张表会随历史任务一直涨。形状与 `MAX_PENDING_CANCELS`、
/// `MAX_TRACKED_SCANS` 一致：插入序就是淘汰序，超限从队首丢。
///
/// 淘汰只摘掉表里的登记，不影响正在跑的循环：循环自己握着 `download_signal` 返回的那
/// 个 `Arc`。要触发误伤，需要在一次下载期间出现 64 个不同的任务 id（单下载的任务模型
/// 下不可达）；真到了那一步，丢掉的也只是那条太久没人认领的信号。
const MAX_DOWNLOAD_SIGNALS: usize = 64;

/// 任务 id → 信号闸，外加一份插入序用于淘汰。两个字段的键集合始终一致：插入新键才
/// `push_back`，`clear` 两边都删，淘汰从队首摘。
#[derive(Default)]
struct DownloadSignals {
    by_task: std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<DownloadSignal>>>,
    order: std::collections::VecDeque<String>,
}

impl DownloadSignals {
    fn signal(&mut self, task_id: &str) -> std::sync::Arc<std::sync::Mutex<DownloadSignal>> {
        if let Some(handle) = self.by_task.get(task_id) {
            return handle.clone();
        }
        let handle = std::sync::Arc::new(std::sync::Mutex::new(DownloadSignal::Running));
        self.by_task.insert(task_id.to_string(), handle.clone());
        self.order.push_back(task_id.to_string());
        while self.order.len() > MAX_DOWNLOAD_SIGNALS {
            if let Some(oldest) = self.order.pop_front() {
                self.by_task.remove(&oldest);
            }
        }
        handle
    }

    fn clear(&mut self, task_id: &str) {
        self.by_task.remove(task_id);
        // 插入序里那条也要清：留着它会让淘汰白走一步——被摘掉的都是已经不在表里的 id，
        // 真正的条目反而永远轮不到，表就能一直涨过上限。
        if let Some(position) = self.order.iter().position(|id| id == task_id) {
            self.order.remove(position);
        }
    }
}

static DOWNLOAD_SIGNALS: std::sync::OnceLock<std::sync::Mutex<DownloadSignals>> = std::sync::OnceLock::new();

fn download_signals() -> &'static std::sync::Mutex<DownloadSignals> {
    DOWNLOAD_SIGNALS.get_or_init(|| std::sync::Mutex::new(DownloadSignals::default()))
}

/// 取（必要时新建）一个任务的信号闸。循环跑在阻塞线程上，拿不到 Tauri 状态，所以
/// 这份状态按任务 id 放在全局表里。
fn download_signal(task_id: &str) -> std::sync::Arc<std::sync::Mutex<DownloadSignal>> {
    match download_signals().lock() {
        Ok(mut signals) => signals.signal(task_id),
        Err(_) => std::sync::Arc::new(std::sync::Mutex::new(DownloadSignal::Running)),
    }
}

fn set_download_signal(task_id: &str, signal: DownloadSignal) {
    if let Ok(state) = download_signal(task_id).lock() {
        // 已经收到中止的下载，不会被后来的暂停改回来。
        if *state != DownloadSignal::Aborted {
            let mut state = state;
            *state = signal;
        }
    }
}

fn clear_download_signal(task_id: &str) {
    if let Ok(mut signals) = download_signals().lock() {
        signals.clear(task_id);
    }
}

fn read_download_signal(handle: &std::sync::Mutex<DownloadSignal>) -> DownloadSignal {
    // 锁坏了当作中止：下载这件事宁可停错，也不要卡在谁也动不了的状态里。
    handle.lock().map(|state| *state).unwrap_or(DownloadSignal::Aborted)
}

/// 传输结束的三种下场。中止和暂停都不是错误，所以从 `Result` 的成功分支回来，
/// 由调用方去写任务行和文件。
enum DownloadOutcome {
    Finished { received: u64 },
    Paused { received: u64 },
    Aborted { received: u64 },
}

/// 一次下载的输入。HTTP 那一半（密钥、客户端、元数据）在命令里准备好，这里只
/// 负责落盘、报进度、写任务行。
struct TransferRequest {
    client: reqwest::blocking::Client,
    api_key: String,
    base_url: String,
    server_id: String,
    /// 取封面要用的 scope：完成时连同元数据一起记进本地档案那一行。
    scope_id: String,
    archive_id: String,
    directory: std::path::PathBuf,
    metadata: serde_json::Value,
    /// 恢复或重试时带上已有的任务行；新下载是 None。
    task: Option<TaskTransfer>,
}

/// 任务行里与传输有关的那几列，恢复时全从这里读。
struct TaskTransfer {
    id: String,
    label: String,
    received: u64,
    total: Option<u64>,
    part: std::path::PathBuf,
    final_name: String,
}

fn transfer_archive(
    database: &Database,
    request: TransferRequest,
) -> Result<DownloadResult, String> {
    let TransferRequest {
        client,
        api_key,
        base_url,
        server_id,
        scope_id,
        archive_id,
        directory,
        metadata,
        task,
    } = request;
    let resume_from = task.as_ref().map(|task| task.received).unwrap_or(0);
    let request_url = format!(
        "{}/api/archives/{}/download",
        base_url.trim_end_matches('/'),
        archive_id
    );
    let mut transfer = client.get(&request_url).header(
        reqwest::header::AUTHORIZATION,
        authorization_value(&api_key),
    );
    if resume_from > 0 {
        transfer = transfer.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }
    let mut response = transfer
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
    let partial = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    // 206 必须说清它给的是哪一段。起点不是我们要的那个偏移时，把这段追加到 `.part`
    // 后面就是一份坏档案——宁可在这里报错，留下还能续的半份文件。
    let resumed = if partial {
        let range = parse_content_range(response.headers())
            .ok_or_else(|| "Server answered 206 without a usable Content-Range".to_string())?;
        if range.start != resume_from {
            return Err(format!(
                "Server resumed at byte {} instead of {resume_from}",
                range.start
            ));
        }
        // 有 Content-Length 时它必须正好是这一段：字节数对不上就说明服务端给的不是
        // 我们要的那一段，收下去只会少一截。
        if let Some(length) = response.content_length() {
            let expected = range.end - range.start + 1;
            if length != expected {
                return Err(format!(
                    "Server sent {length} bytes for the range {}-{}",
                    range.start, range.end
                ));
            }
        }
        Some(range)
    } else {
        None
    };
    let total = match &resumed {
        Some(range) => range
            .total
            .or_else(|| range.end.checked_add(1)),
        None => response.content_length(),
    };
    store_archive_response(
        database,
        &server_id,
        &scope_id,
        &archive_id,
        &metadata,
        &directory,
        &mut response,
        total,
        partial,
        task,
    )
}

/// 响应体到手之后的一切：建任务行、流式落盘、报进度、收尾（发布 / 暂停 / 中止 /
/// 失败）。HTTP 那一半留在 `transfer_archive` 里，所以这里脱网也能测。
#[allow(clippy::too_many_arguments)]
fn store_archive_response(
    database: &Database,
    server_id: &str,
    scope_id: &str,
    archive_id: &str,
    metadata: &serde_json::Value,
    directory: &std::path::Path,
    source: &mut impl Read,
    total: Option<u64>,
    partial: bool,
    task: Option<TaskTransfer>,
) -> Result<DownloadResult, String> {
    let filename = match &task {
        Some(task) => task.final_name.clone(),
        None => archive_download_filename(archive_id, metadata),
    };
    let part = match &task {
        Some(task) => task.part.clone(),
        None => directory.join(format!("{filename}.part")),
    };
    let resume_from = task.as_ref().map(|task| task.received).unwrap_or(0);
    // 服务端不认 Range（用 200 把整份重发过来）时必须从头写：否则前半段会和新收
    // 的字节叠在一起。
    let received = if partial { resume_from } else { 0 };
    if !partial && resume_from > 0 {
        let _ = std::fs::remove_file(&part);
    }
    let label = match &task {
        Some(task) => task.label.clone(),
        None => download_task_label(metadata),
    };
    let task_id = match &task {
        Some(task) => task.id.clone(),
        None => create_download_task(database, &label, server_id, archive_id, &part, total)?,
    };
    let signal = download_signal(&task_id);
    let started = std::time::Instant::now();
    let mut last_report = started;
    let mut last_percent = None;
    let mut speed: Option<u64> = None;
    // 速度要的是「这一段时间收了多少」：上一次的字节数和时刻都在这里。
    let traffic = std::sync::Mutex::new((received, started));
    let outcome = stream_archive_to_file(source, &part, received, &signal, |now| {
        let (previous, at) = match traffic.lock() {
            Ok(mut traffic) => {
                let state = (traffic.0, traffic.1);
                traffic.0 = now;
                traffic.1 = std::time::Instant::now();
                state
            }
            Err(_) => (now, started),
        };
        let elapsed = at.elapsed();
        if !elapsed.is_zero() && now > previous {
            let instant = (now - previous) as f64 / elapsed.as_secs_f64();
            speed = Some(match speed {
                // 平滑一下：单块的瞬时速度抖得没法看。
                Some(previous) => (previous as f64 * 0.6 + instant * 0.4) as u64,
                None => instant as u64,
            });
        }
        let percent = total
            .filter(|total| *total > 0)
            .map(|total| now.saturating_mul(100) / total);
        // 百分比变了才写；一直不动的（服务端没报总量）也每秒留一次心跳，速度才
        // 不会是几秒前的旧值。
        if percent == last_percent && last_report.elapsed() < std::time::Duration::from_secs(1) {
            return;
        }
        last_percent = percent;
        last_report = std::time::Instant::now();
        report_download_progress(database, &task_id, now, total, speed);
    });
    clear_download_signal(&task_id);
    match outcome {
        Ok(DownloadOutcome::Finished { received }) => {
            // 已知总量时必须收满：短读（服务端提前断流、Range 给少了）不能当完成发布，
            // 否则本地档案库里会多一份看着正常、其实是半截的文件，用户要等到解压失败
            // 才知道。半份 `.part` 留着，用户还能再续一次。
            if let Some(total) = total {
                if received != total {
                    let message =
                        format!("Archive download stopped short: {received} of {total} bytes");
                    mark_task_failed(database, &task_id, &message);
                    return Err(message);
                }
            }
            let path = publish_archive_download(&part, directory, &filename).map_err(|error| {
                mark_task_failed(database, &task_id, &error);
                error
            })?;
            finish_download_task(
                database,
                &task_id,
                std::path::Path::new(&path),
                received,
                total,
            );
            record_local_archive(
                database,
                std::path::Path::new(&path),
                server_id,
                scope_id,
                archive_id,
                metadata,
                &label,
                received,
            );
            Ok(DownloadResult {
                status: "completed".into(),
                path,
                task_id,
            })
        }
        Ok(DownloadOutcome::Paused { received }) => {
            pause_download_task(database, &task_id, received);
            Ok(DownloadResult {
                status: "paused".into(),
                path: part.to_string_lossy().into_owned(),
                task_id,
            })
        }
        Ok(DownloadOutcome::Aborted { .. }) => {
            let _ = std::fs::remove_file(&part);
            cancel_download_task(database, &task_id);
            Ok(DownloadResult {
                status: "cancelled".into(),
                path: String::new(),
                task_id,
            })
        }
        Err(error) => {
            // 半份档案留着：失败多半是网络断了，恢复时能接着收。
            mark_task_failed(database, &task_id, &error);
            Err(error)
        }
    }
}

/// `Content-Range: bytes 100-999/1000` 的三段。`*` 表示总量未知。
///
/// 只认 `bytes`；`end < start`、总量不大于 `end` 都属于拼错了，一律当作「没有可用的
/// 这一段」——调用方据此拒绝这次 206，而不是把字节追加到错误的偏移上。
struct ContentRange {
    start: u64,
    end: u64,
    total: Option<u64>,
}

fn parse_content_range(headers: &reqwest::header::HeaderMap) -> Option<ContentRange> {
    let value = headers.get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?;
    let (unit, rest) = value.split_once(' ')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (range, total) = rest.trim().split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start = start.trim().parse::<u64>().ok()?;
    let end = end.trim().parse::<u64>().ok()?;
    if end < start || end.checked_add(1).is_none() {
        return None;
    }
    let total = match total.trim() {
        "*" => None,
        value => Some(value.parse::<u64>().ok()?),
    };
    if total.is_some_and(|total| total <= end) {
        return None;
    }
    Some(ContentRange { start, end, total })
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

/// 收下的每一块都先落到 `<最终名>.part`；块大小同时也是进度回调的粒度。
const DOWNLOAD_CHUNK_BYTES: usize = 64 * 1024;

/// 把响应体写进 `.part` 文件，每收一块报一次累计字节数。暂停与中止都在这里生效：
/// 单次 HTTP 请求唯一能停下来的地方就是块与块之间。
fn stream_archive_to_file(
    source: &mut impl Read,
    part: &std::path::Path,
    received: u64,
    signal: &std::sync::Mutex<DownloadSignal>,
    mut on_chunk: impl FnMut(u64),
) -> Result<DownloadOutcome, String> {
    if let Some(parent) = part.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    // 续传时磁盘上的长度**必须**等于请求用的那个起点：进度写库是节流的，异常退出时
    // `.part` 可能比数据库记的 checkpoint 长（多出来的尾巴要切掉，那几块重新收），也可能
    // 更短（调用方本该已经按磁盘长度对齐过；真遇到就报错，绝不在一份不完整的文件上继续
    // 追加，否则中间会留一个洞）。`append(true)` 恰好绕过了这件事，所以这里显式 seek。
    let mut file = if received > 0 {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(part)
            .map_err(|error| error.to_string())?;
        let on_disk = file.metadata().map_err(|error| error.to_string())?.len();
        if on_disk < received {
            return Err(format!(
                "Partial file is shorter than the resume offset ({on_disk} < {received} bytes)"
            ));
        }
        if on_disk > received {
            file.set_len(received).map_err(|error| error.to_string())?;
        }
        file.seek(SeekFrom::Start(received))
            .map_err(|error| error.to_string())?;
        file
    } else {
        std::fs::File::create(part).map_err(|error| error.to_string())?
    };
    let mut buffer = vec![0u8; DOWNLOAD_CHUNK_BYTES];
    let mut received = received;
    loop {
        match read_download_signal(signal) {
            DownloadSignal::Running => {}
            DownloadSignal::Paused => return Ok(DownloadOutcome::Paused { received }),
            DownloadSignal::Aborted => return Ok(DownloadOutcome::Aborted { received }),
        }
        let read = source
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| error.to_string())?;
        received += read as u64;
        on_chunk(received);
    }
    if received == 0 {
        return Err("Server returned an empty archive".into());
    }
    file.sync_all().map_err(|error| error.to_string())?;
    Ok(DownloadOutcome::Finished { received })
}

/// 标题可以很长，任务行截到 80 字符；没有标题时就退回一个通用的说法。
fn download_task_label(metadata: &serde_json::Value) -> String {
    let title: String = metadata["title"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(80)
        .collect();
    if title.is_empty() {
        "下载档案".to_string()
    } else {
        format!("下载 {title}")
    }
}

/// 进度按已收字节算，封顶 0.99：进度条走满之前，文件必须真的已经落地。
fn download_progress(received: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    (received as f64 / total as f64).min(0.99)
}

/// 下载一开始就在任务表里留一行：文件落在哪、一共多少、收了多少都在这一行上，
/// 也就是本地档案页读的那一行。两把开关都打开——暂停、恢复、中止、重试都在这条
/// 路上。
fn create_download_task(
    database: &Database,
    label: &str,
    server_id: &str,
    archive_id: &str,
    part: &std::path::Path,
    total: Option<u64>,
) -> Result<String, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())?;
    let id = new_task_id();
    connection
        .execute(
            "INSERT INTO tasks (id, kind, label, status, progress, cancelable, retryable, archive_id, server_id, local_path, total_bytes, received_bytes)
             VALUES (?1, 'download', ?2, 'running', 0, 1, 1, ?3, ?4, ?5, ?6, 0)",
            params![
                id,
                label,
                archive_id,
                server_id,
                part.to_string_lossy(),
                total.map(|total| total as i64)
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(id)
}

/// 进度、已收字节、速度一起写：界面上的进度条、速度、总量都读这一行。
fn report_download_progress(
    database: &Database,
    task_id: &str,
    received: u64,
    total: Option<u64>,
    speed: Option<u64>,
) {
    if let Ok(connection) = database.connection.lock() {
        let progress = match total.filter(|total| *total > 0) {
            Some(total) => download_progress(received, total),
            None => 0.0,
        };
        let _ = connection.execute(
            "UPDATE tasks SET progress = ?1, received_bytes = ?2, bytes_per_second = ?3, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?4 AND status = 'running'",
            params![
                progress,
                received as i64,
                speed.map(|speed| speed as i64),
                task_id
            ],
        );
    }
}

fn finish_download_task(
    database: &Database,
    task_id: &str,
    path: &std::path::Path,
    received: u64,
    total: Option<u64>,
) {
    if let Ok(connection) = database.connection.lock() {
        let _ = connection.execute(
            "UPDATE tasks SET status = 'completed', progress = 1, error = NULL, received_bytes = ?1,
                    total_bytes = COALESCE(?2, ?1), bytes_per_second = NULL, local_path = ?3, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?4",
            params![
                received as i64,
                total.map(|total| total as i64),
                path.to_string_lossy(),
                task_id
            ],
        );
    }
}

fn pause_download_task(database: &Database, task_id: &str, received: u64) {
    if let Ok(connection) = database.connection.lock() {
        let _ = connection.execute(
            "UPDATE tasks SET status = 'paused', received_bytes = ?1, bytes_per_second = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?2 AND status IN ('running', 'queued')",
            params![received as i64, task_id],
        );
    }
}

fn cancel_download_task(database: &Database, task_id: &str) {
    if let Ok(connection) = database.connection.lock() {
        let _ = connection.execute(
            "UPDATE tasks SET status = 'cancelled', bytes_per_second = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND status IN ('running', 'queued', 'paused', 'failed')",
            params![task_id],
        );
    }
}

/// 下载时顺手抄下来的那几列。LANraragi 的 metadata 里 `tags` 是逗号分隔的一整串，
/// 落库时存成 JSON 数组，和 archives 表里的 `tags_json` 同形——读的时候两边可以
/// 直接互换。
struct MirroredArchiveMetadata {
    title: Option<String>,
    page_count: Option<i64>,
    tags_json: Option<String>,
}

fn mirrored_archive_metadata(metadata: &serde_json::Value) -> MirroredArchiveMetadata {
    let title = metadata["title"]
        .as_str()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string);
    let page_count = metadata["pagecount"].as_i64().filter(|count| *count > 0);
    let tags_json = metadata["tags"].as_str().map(|tags| {
        let tags: Vec<&str> = tags
            .split(',')
            .map(str::trim)
            .filter(|tag| !tag.is_empty())
            .collect();
        serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string())
    });
    MirroredArchiveMetadata {
        title,
        page_count,
        tags_json,
    }
}

/// 下载完成 → 磁盘上多了一份档案。以文件为主语记一行：外部删掉文件之后，扫描
/// 会把这一行一起收走（见 `reconcile_local_archives`）。
///
/// 标题、页数、标签、scope 都在这里落库，因为**现在**手上正好有服务器的元数据，
/// 而这一页以后要离线看：镜像是一条 JOIN，服务器换了、那份档案在服务器上被删了、
/// 或者压根没同步过，本地就只剩文件名。已经写好的值不会被空值覆盖（恢复时拿不到
/// 元数据的那一次不该把第一次下载抄下来的标签抹掉）。
#[allow(clippy::too_many_arguments)]
fn record_local_archive(
    database: &Database,
    path: &std::path::Path,
    server_id: &str,
    scope_id: &str,
    archive_id: &str,
    metadata: &serde_json::Value,
    fallback_title: &str,
    size: u64,
) {
    let Ok(connection) = database.connection.lock() else {
        return;
    };
    let mirrored = mirrored_archive_metadata(metadata);
    let from_name = local_archive_title(path);
    let title = mirrored
        .title
        .clone()
        .unwrap_or_else(|| if from_name.is_empty() { fallback_title.to_string() } else { from_name });
    let _ = connection.execute(
        "INSERT INTO local_archives (path, archive_id, server_id, scope_id, title, page_count, tags_json, file_size, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(path) DO UPDATE SET
             file_size = excluded.file_size,
             added_at = excluded.added_at,
             title = COALESCE(?10, local_archives.title),
             page_count = COALESCE(?6, local_archives.page_count),
             tags_json = COALESCE(?7, local_archives.tags_json),
             scope_id = COALESCE(?4, local_archives.scope_id),
             archive_id = COALESCE(local_archives.archive_id, ?2),
             server_id = COALESCE(?3, local_archives.server_id)",
        params![
            path.to_string_lossy(),
            archive_id,
            server_id,
            scope_id,
            title,
            mirrored.page_count,
            mirrored.tags_json,
            size as i64,
            now_millis(),
            mirrored.title,
        ],
    );
}

#[cfg(test)]
mod archive_download_tests {
    use super::*;

    fn download_metadata(title: &str) -> serde_json::Value {
        serde_json::json!({ "title": title, "filename": "a.cbz" })
    }

    fn only_task(database: &Database) -> TaskRecord {
        query_tasks(&database.connection.lock().unwrap())
            .unwrap()
            .into_iter()
            .next()
            .expect("task row")
    }

    /// 读到第几块时任务行长什么样：证明进度真的落在任务表上，而不是只在内存里
    /// 算过一遍。
    struct TaskWatcher<'a> {
        database: &'a Database,
        remaining: usize,
        observed: Vec<(String, f64, i64)>,
    }

    impl Read for TaskWatcher<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if let Ok(connection) = self.database.connection.lock() {
                if let Ok(tasks) = query_tasks(&connection) {
                    if let Some(task) = tasks.first() {
                        self.observed
                            .push((task.status.clone(), task.progress, task.received_bytes));
                    }
                }
            }
            if self.remaining == 0 {
                return Ok(0);
            }
            let written = self.remaining.min(buffer.len());
            buffer[..written].fill(9);
            self.remaining -= written;
            Ok(written)
        }
    }

    /// 读够 `after` 块之后拨一次下载信号——用户按下暂停或中止的那一刻。
    struct SignalReader<'a> {
        database: &'a Database,
        signal: DownloadSignal,
        after: usize,
        chunks: usize,
        remaining: usize,
    }

    impl Read for SignalReader<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.chunks == self.after {
                set_download_signal(&only_task(self.database).id, self.signal);
            }
            self.chunks += 1;
            if self.remaining == 0 {
                return Ok(0);
            }
            let written = self.remaining.min(buffer.len());
            buffer[..written].fill(7);
            self.remaining -= written;
            Ok(written)
        }
    }

    fn store(
        database: &Database,
        directory: &std::path::Path,
        source: &mut impl Read,
        total: Option<u64>,
    ) -> Result<DownloadResult, String> {
        store_archive_response(
            database,
            "scope-a",
            "scope-a",
            &"a".repeat(40),
            &download_metadata("测试档案"),
            directory,
            source,
            total,
            true,
            None,
        )
    }

    #[tokio::test]
    async fn remote_failure_reader_transport_preserves_an_explicit_network_code() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let error = reader_request(reqwest::Method::GET, url, String::new()).await.unwrap_err();
        assert_eq!(error.code, "NETWORK");
        let builder_error = Client::new().get("not a valid URL").build().unwrap_err();
        assert_eq!(ReaderRequestError::transport(builder_error).code, "REMOTE_UNAVAILABLE");
        assert_eq!(ReaderRequestError::configuration("TLS configuration failed".into()).code, "UNKNOWN");
    }

    #[test]
    fn filenames_keep_format_and_cannot_escape_directory() {
        let metadata = serde_json::json!({"filename": "original.cbr", "title": format!("../CON:<bad> {}", "漫画".repeat(100))});
        let filename = archive_download_filename(&"a".repeat(40), &metadata);
        assert!(filename.ends_with(".cbr"));
        assert!(filename.len() < 240);
        assert!(!filename.contains('/') && !filename.contains('\\') && !filename.contains(':'));
    }

    #[test]
    fn local_titles_and_ids_are_read_back_from_the_filename() {
        let id = "f6b58755f0aa4f02d4346592da9edfec0a22d349";
        let named = format!("E:\\x\\{id}-[ie] 标题 (1).zip");
        let path = std::path::Path::new(&named);
        assert_eq!(local_archive_id(path).as_deref(), Some(id));
        assert_eq!(local_archive_title(path), "[ie] 标题 (1)");
        // 认不出 id 的文件也有标题，只是没有档案 id。
        let plain = std::path::Path::new("E:\\x\\随手放进来的一份.cbz");
        assert_eq!(local_archive_id(plain), None);
        assert_eq!(local_archive_title(plain), "随手放进来的一份");
    }

    #[test]
    fn streaming_reports_every_chunk_and_keeps_a_part_file() {
        let directory = tempfile::tempdir().unwrap();
        let part = directory.path().join("archive.zip.part");
        let body = vec![9u8; 200 * 1024];
        let mut seen = Vec::new();
        let signal = std::sync::Mutex::new(DownloadSignal::Running);
        let outcome = stream_archive_to_file(&mut &body[..], &part, 0, &signal, |received| {
            seen.push(received)
        })
        .unwrap();
        assert_eq!(seen, vec![64 * 1024, 128 * 1024, 192 * 1024, 200 * 1024]);
        assert!(matches!(outcome, DownloadOutcome::Finished { received } if received == 200 * 1024));
        // 收完还是 `.part`：发布是下一步。
        assert_eq!(std::fs::read(&part).unwrap(), body);
    }

    #[test]
    fn publishing_never_overwrites_an_existing_archive() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("archive.zip.part");
        let second = directory.path().join("archive.zip.part");
        std::fs::write(&first, b"first").unwrap();
        let published = publish_archive_download(&first, directory.path(), "archive.zip").unwrap();
        std::fs::write(&second, b"second").unwrap();
        let other = publish_archive_download(&second, directory.path(), "archive.zip").unwrap();
        assert_ne!(published, other);
        assert_eq!(std::fs::read(published).unwrap(), b"first");
        assert_eq!(std::fs::read(other).unwrap(), b"second");
        // 发布之后没有留下半份文件。
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    }

    #[test]
    fn publication_failure_marks_the_download_task_failed() {
        struct LostPart {
            body: std::io::Cursor<Vec<u8>>,
            directory: std::path::PathBuf,
        }
        impl Read for LostPart {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                let count = self.body.read(bytes)?;
                if count == 0 {
                    // Model a file disappearing between streaming and publication.
                    for entry in std::fs::read_dir(&self.directory)? {
                        let path = entry?.path();
                        if path.extension().is_some_and(|extension| extension == "part") {
                            std::fs::remove_file(path)?;
                        }
                    }
                }
                Ok(count)
            }
        }
        let database = Database::open_path(":memory:").unwrap();
        let directory = tempfile::tempdir().unwrap();
        let mut source = LostPart {
            body: std::io::Cursor::new(vec![1, 2, 3]),
            directory: directory.path().to_path_buf(),
        };
        assert!(store(&database, directory.path(), &mut source, Some(3)).is_err());
        assert_eq!(only_task(&database).status, "failed");
    }

    #[test]
    fn a_finished_download_leaves_a_completed_task_and_a_local_archive() {
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let body = vec![9u8; 200 * 1024];
        let result = store(
            &database,
            directory.path(),
            &mut &body[..],
            Some(body.len() as u64),
        )
        .expect("download");
        assert_eq!(result.status, "completed");
        assert!(result.path.ends_with(".cbz"));
        assert_eq!(std::fs::read(&result.path).unwrap(), body);

        let task = only_task(&database);
        assert_eq!(task.kind, "download");
        assert_eq!(task.label, "下载 测试档案");
        assert_eq!(task.status, "completed");
        assert_eq!(task.progress, 1.0);
        assert_eq!(task.error, None);
        assert_eq!(task.received_bytes, body.len() as i64);
        assert_eq!(task.total_bytes, Some(body.len() as i64));
        // 能暂停、能恢复、能重试，界面上才有那三个按钮。
        assert!(task.cancelable && task.retryable);
        // 目标文件早就写进任务行了，恢复的时候才找得回来。
        assert_eq!(task.local_path.as_deref(), Some(result.path.as_str()));

        // 磁盘上多了一份档案，本地档案页读的就是它。
        let connection = database.connection.lock().unwrap();
        let records = reconcile_local_archives(&connection, directory.path()).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].title, "测试档案");
        assert_eq!(records[0].file_size, body.len() as i64);
        assert_eq!(
            records[0].archive_id.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
    }

    /// 元数据在下载时就得落库：本地档案页要能离线看，而服务器镜像是 archives 表上的
    /// 一条 JOIN——那份档案在服务器上被删了、或者这台机器压根没同步过它，标签和页数
    /// 就一起没了，本地只剩一个文件名。
    #[test]
    fn a_finished_download_keeps_the_metadata_it_was_served() {
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let metadata = serde_json::json!({
            "title": "被抄下来的标题",
            "filename": "original.zip",
            "pagecount": 42,
            "tags": "female:glasses, language:chinese, artist:somebody",
        });
        let body = vec![4u8; 32 * 1024];
        store_archive_response(
            &database,
            "server-a",
            "scope-a",
            &"b".repeat(40),
            &metadata,
            directory.path(),
            &mut &body[..],
            Some(body.len() as u64),
            true,
            None,
        )
        .expect("download");

        let connection = database.connection.lock().unwrap();
        // archives 表里空着：这一页不该依赖服务器镜像。
        let records = reconcile_local_archives(&connection, directory.path()).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].title, "被抄下来的标题");
        assert_eq!(records[0].page_count, Some(42));
        assert_eq!(records[0].scope_id.as_deref(), Some("scope-a"));
        assert_eq!(
            records[0].tags,
            vec!["female:glasses", "language:chinese", "artist:somebody"]
        );
    }

    /// 恢复那一次拿不到元数据（断网、服务器换了）时，不许把第一次下载抄下来的标签、
    /// 页数和 scope 抹成空。
    #[test]
    fn recording_without_metadata_keeps_what_the_first_download_stored() {
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(format!("{}-标题.cbz", "c".repeat(40)));
        let metadata = serde_json::json!({
            "title": "标题",
            "pagecount": 12,
            "tags": "female:glasses, artist:somebody",
        });
        record_local_archive(
            &database,
            &path,
            "server-a",
            "scope-a",
            &"c".repeat(40),
            &metadata,
            "标题",
            1024,
        );
        // 之后的一次收尾什么元数据都没有。
        record_local_archive(
            &database,
            &path,
            "server-a",
            "scope-a",
            &"c".repeat(40),
            &serde_json::json!({}),
            "标题",
            2048,
        );

        let connection = database.connection.lock().unwrap();
        let (title, page_count, tags, scope): (String, Option<i64>, Option<String>, Option<String>) =
            connection
                .query_row(
                    "SELECT title, page_count, tags_json, scope_id FROM local_archives WHERE path = ?1",
                    params![path.to_string_lossy()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .expect("local archive row");
        assert_eq!(title, "标题");
        assert_eq!(page_count, Some(12));
        assert_eq!(scope.as_deref(), Some("scope-a"));
        assert_eq!(
            tags.as_deref(),
            Some(r#"["female:glasses","artist:somebody"]"#)
        );
    }

    #[test]
    fn a_running_download_reports_progress_before_it_finishes() {
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let total = 200 * 1024;
        let mut watcher = TaskWatcher {
            database: &database,
            remaining: total,
            observed: Vec::new(),
        };
        store(&database, directory.path(), &mut watcher, Some(total as u64)).expect("download");

        assert!(
            watcher
                .observed
                .iter()
                .any(|(status, progress, _)| status == "running" && *progress > 0.0),
            "下载途中没有任何进度写进任务表：{:?}",
            watcher.observed
        );
        // 进度只增不减，而且走满之前不许读到 1.0。
        assert!(watcher.observed.iter().all(|(_, progress, _)| *progress < 1.0));
        // 已收字节也一路跟着涨，界面上才有「120 MiB / 356 MiB」。
        assert!(watcher
            .observed
            .iter()
            .any(|(_, _, received)| *received > 0 && *received < total as i64));
    }

    #[test]
    fn pausing_keeps_the_bytes_already_received() {
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let total = 200 * 1024;
        let mut reader = SignalReader {
            database: &database,
            signal: DownloadSignal::Paused,
            after: 1,
            chunks: 0,
            remaining: total,
        };
        let result =
            store(&database, directory.path(), &mut reader, Some(total as u64)).expect("download");

        assert_eq!(result.status, "paused");
        assert!(result.path.ends_with(".part"));
        let task = only_task(&database);
        assert_eq!(task.status, "paused");
        assert_eq!(task.received_bytes, 2 * 64 * 1024);
        assert!(task.progress > 0.0 && task.progress < 1.0);
        // 半份文件留在原处：恢复就是从这里接着收。
        assert_eq!(
            std::fs::metadata(&result.path).unwrap().len(),
            2 * 64 * 1024
        );
        // 没发布成正式档案，本地档案页也就不该多出一条。
        let connection = database.connection.lock().unwrap();
        assert!(reconcile_local_archives(&connection, directory.path())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn aborting_removes_the_partial_file() {
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let total = 200 * 1024;
        let mut reader = SignalReader {
            database: &database,
            signal: DownloadSignal::Aborted,
            after: 1,
            chunks: 0,
            remaining: total,
        };
        let result =
            store(&database, directory.path(), &mut reader, Some(total as u64)).expect("download");

        assert_eq!(result.status, "cancelled");
        assert!(result.path.is_empty());
        assert_eq!(only_task(&database).status, "cancelled");
        // 半份文件跟着消失，目录里不留东西。
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn resuming_appends_to_the_partial_file_and_publishes_it() {
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let filename = archive_download_filename(&"a".repeat(40), &download_metadata("测试档案"));
        let part = directory.path().join(format!("{filename}.part"));
        let received: u64 = 64 * 1024;
        std::fs::write(&part, vec![1u8; received as usize]).unwrap();
        let total = 128 * 1024;
        let task_id = create_download_task(
            &database,
            "下载 测试档案",
            "scope-a",
            &"a".repeat(40),
            &part,
            Some(total),
        )
        .unwrap();
        // 暂停过的任务行：恢复就是带着它继续跑。
        pause_download_task(&database, &task_id, received);
        let body = vec![2u8; (total - received) as usize];

        let result = store_archive_response(
            &database,
            "scope-a",
            "scope-a",
            &"a".repeat(40),
            &download_metadata("测试档案"),
            directory.path(),
            &mut &body[..],
            Some(total),
            true,
            Some(TaskTransfer {
                id: task_id.clone(),
                label: "下载 测试档案".into(),
                received,
                total: Some(total),
                part: part.clone(),
                final_name: filename.clone(),
            }),
        )
        .expect("resume");

        assert_eq!(result.status, "completed");
        let saved = std::fs::read(&result.path).unwrap();
        assert_eq!(saved.len(), total as usize);
        // 前半段是暂停前收下的字节，后半段是这次接上的——顺序没有错位。
        assert_eq!(&saved[..received as usize], vec![1u8; received as usize].as_slice());
        assert_eq!(&saved[received as usize..], body.as_slice());
        assert!(!part.exists());
        let task = only_task(&database);
        assert_eq!(task.status, "completed");
        assert_eq!(task.received_bytes, total as i64);
    }

    #[test]
    fn a_server_that_ignores_the_range_restarts_from_zero() {
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let filename = archive_download_filename(&"a".repeat(40), &download_metadata("测试档案"));
        let part = directory.path().join(format!("{filename}.part"));
        // 服务端用 200 把整份重发：半份文件必须丢掉，否则会和新收的叠在一起。
        std::fs::write(&part, vec![1u8; 64 * 1024]).unwrap();
        let task_id = create_download_task(
            &database,
            "下载 测试档案",
            "scope-a",
            &"a".repeat(40),
            &part,
            None,
        )
        .unwrap();
        pause_download_task(&database, &task_id, 64 * 1024);
        let body = vec![3u8; 64 * 1024];

        let result = store_archive_response(
            &database,
            "scope-a",
            "scope-a",
            &"a".repeat(40),
            &download_metadata("测试档案"),
            directory.path(),
            &mut &body[..],
            Some(body.len() as u64),
            false,
            Some(TaskTransfer {
                id: task_id,
                label: "下载 测试档案".into(),
                received: 64 * 1024,
                total: None,
                part,
                final_name: filename,
            }),
        )
        .expect("restart");

        assert_eq!(std::fs::read(&result.path).unwrap(), body);
        assert_eq!(only_task(&database).received_bytes, body.len() as i64);
    }

    /// 一份只回一次固定响应的 loopback HTTP 服务。下载那一半走的是阻塞 reqwest，所以
    /// 这里也用标准库线程，不掺 tokio。
    fn download_server(
        status: &'static str,
        extra_headers: String,
        body: Vec<u8>,
    ) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            let mut request = [0u8; 4096];
            let _ = socket.read(&mut request);
            let head = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/zip\r\nContent-Length: {}\r\n{extra_headers}Connection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(head.as_bytes());
            let _ = socket.write_all(&body);
            let _ = socket.flush();
        });
        (url, handle)
    }

    /// 一条「任务行已经在、要从 `checkpoint` 续」的下载请求。
    fn resume_request(
        url: String,
        directory: &std::path::Path,
        part: std::path::PathBuf,
        filename: String,
        task_id: String,
        checkpoint: u64,
        total: Option<u64>,
    ) -> TransferRequest {
        TransferRequest {
            client: reqwest::blocking::Client::new(),
            api_key: "key".into(),
            base_url: url,
            server_id: "scope-a".into(),
            scope_id: "scope-a".into(),
            archive_id: "a".repeat(40),
            directory: directory.to_path_buf(),
            metadata: download_metadata("测试档案"),
            task: Some(TaskTransfer {
                id: task_id,
                label: "下载 测试档案".into(),
                received: checkpoint,
                total,
                part,
                final_name: filename,
            }),
        }
    }

    /// R08 原因 A：进度写库是节流的，异常退出时 `.part` 比数据库记的 checkpoint 长。
    /// 续传请求是从 checkpoint 发的（`bytes=<checkpoint>-`），所以多出来的尾巴必须先
    /// 切掉——否则旧字节会和新字节叠在一起，发布出去的档案是坏的，任务却报完成。
    #[test]
    fn resuming_truncates_a_part_file_that_is_longer_than_the_checkpoint() {
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let filename = archive_download_filename(&"a".repeat(40), &download_metadata("测试档案"));
        let part = directory.path().join(format!("{filename}.part"));
        // 磁盘上 6 字节，数据库只记到 3：最后一块还没写进数据库就退出了。
        std::fs::write(&part, b"abcdef").unwrap();
        let checkpoint: u64 = 3;
        let total: u64 = 8;
        let task_id = create_download_task(
            &database,
            "下载 测试档案",
            "scope-a",
            &"a".repeat(40),
            &part,
            Some(total),
        )
        .unwrap();
        pause_download_task(&database, &task_id, checkpoint);
        // 服务端按 `bytes=3-` 从第 3 字节开始给，一直给到第 8 字节。
        let body = b"defgh";

        let result = store_archive_response(
            &database,
            "scope-a",
            "scope-a",
            &"a".repeat(40),
            &download_metadata("测试档案"),
            directory.path(),
            &mut &body[..],
            Some(total),
            true,
            Some(TaskTransfer {
                id: task_id,
                label: "下载 测试档案".into(),
                received: checkpoint,
                total: Some(total),
                part: part.clone(),
                final_name: filename,
            }),
        )
        .expect("resume");

        assert_eq!(result.status, "completed");
        // 逐字节等于原文件：`abcdef` 的尾巴被切掉，接上的是从第 3 字节起的 `defgh`。
        assert_eq!(std::fs::read(&result.path).unwrap(), b"abcdefgh");
        assert_eq!(only_task(&database).received_bytes, total as i64);
    }

    /// R08 原因 B：206 的起点必须就是请求的那个偏移。服务端从别处给（或者干脆没带
    /// Content-Range）时，追加下去只会拼出一份坏档案——宁可报错，留下可恢复的 `.part`。
    #[test]
    fn a_206_from_a_different_offset_is_refused_instead_of_appended() {
        let (url, server) = download_server(
            "206 Partial Content",
            "Content-Range: bytes 0-4/9\r\n".to_string(),
            b"01234".to_vec(),
        );
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let filename = archive_download_filename(&"a".repeat(40), &download_metadata("测试档案"));
        let part = directory.path().join(format!("{filename}.part"));
        std::fs::write(&part, b"abc").unwrap();
        let task_id = create_download_task(
            &database,
            "下载 测试档案",
            "scope-a",
            &"a".repeat(40),
            &part,
            Some(9),
        )
        .unwrap();
        pause_download_task(&database, &task_id, 3);

        let error = transfer_archive(
            &database,
            resume_request(
                url,
                directory.path(),
                part.clone(),
                filename,
                task_id,
                3,
                Some(9),
            ),
        )
        .expect_err("a 206 that starts somewhere else must not be appended");
        let _ = server.join();
        assert!(error.contains("206") || error.contains("resume"), "{error}");
        // 半份文件一字未动：用户还能再试一次。
        assert_eq!(std::fs::read(&part).unwrap(), b"abc");
        // 这一趟在动任务行之前就退出了，任务还停在暂停态，没有登记成本地档案。
        assert_eq!(only_task(&database).status, "paused");
    }

    #[test]
    fn acceptance_an_unrepresentable_content_range_is_refused() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::CONTENT_RANGE, "bytes 0-18446744073709551615/*".parse().unwrap());
        assert!(parse_content_range(&headers).is_none());
    }

    #[test]
    fn a_206_without_a_content_range_is_refused() {
        let (url, server) = download_server("206 Partial Content", String::new(), b"def".to_vec());
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let filename = archive_download_filename(&"a".repeat(40), &download_metadata("测试档案"));
        let part = directory.path().join(format!("{filename}.part"));
        std::fs::write(&part, b"abc").unwrap();
        let task_id = create_download_task(
            &database,
            "下载 测试档案",
            "scope-a",
            &"a".repeat(40),
            &part,
            None,
        )
        .unwrap();
        pause_download_task(&database, &task_id, 3);

        let error = transfer_archive(
            &database,
            resume_request(url, directory.path(), part, filename, task_id, 3, None),
        )
        .expect_err("a 206 without Content-Range cannot be trusted");
        let _ = server.join();
        assert!(error.contains("Content-Range"), "{error}");
    }

    /// 正向对照：起点正确的 206 照样续完并发布——校验不能把正常路径一起挡掉。
    #[test]
    fn a_206_from_the_requested_offset_finishes_the_archive() {
        let (url, server) = download_server(
            "206 Partial Content",
            "Content-Range: bytes 3-7/8\r\n".to_string(),
            b"defgh".to_vec(),
        );
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let filename = archive_download_filename(&"a".repeat(40), &download_metadata("测试档案"));
        let part = directory.path().join(format!("{filename}.part"));
        std::fs::write(&part, b"abc").unwrap();
        let task_id = create_download_task(
            &database,
            "下载 测试档案",
            "scope-a",
            &"a".repeat(40),
            &part,
            Some(8),
        )
        .unwrap();
        pause_download_task(&database, &task_id, 3);

        let result = transfer_archive(
            &database,
            resume_request(
                url,
                directory.path(),
                part.clone(),
                filename,
                task_id,
                3,
                Some(8),
            ),
        )
        .expect("a correct 206 resumes");
        let _ = server.join();

        assert_eq!(result.status, "completed");
        assert_eq!(std::fs::read(&result.path).unwrap(), b"abcdefgh");
        assert_eq!(only_task(&database).received_bytes, 8);
    }

    /// R08 收尾：已知总量时收不满不能当完成发布——半截档案混进本地档案库，比下载失败
    /// 更坏：它看着是成功的，用户要等到解压失败才知道。
    #[test]
    fn a_short_body_is_not_published_as_a_finished_archive() {
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let total = 128 * 1024u64;
        let body = vec![7u8; 64 * 1024];
        let error = store(&database, directory.path(), &mut &body[..], Some(total))
            .expect_err("a body shorter than the declared total must not publish");

        assert!(error.contains("65536") && error.contains("131072"), "{error}");
        // 没有发布出去的档案，只有那份还能续的 `.part`。
        for entry in std::fs::read_dir(directory.path()).unwrap() {
            let path = entry.unwrap().path();
            assert_eq!(path.extension().and_then(|value| value.to_str()), Some("part"));
        }
        assert_eq!(only_task(&database).status, "failed");
    }

    #[test]
    fn a_failed_download_keeps_its_part_file_for_a_resume() {
        struct Interrupted;
        impl Read for Interrupted {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("connection closed"))
            }
        }
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let error = store(
            &database,
            directory.path(),
            &mut Interrupted,
            Some(10),
        )
        .unwrap_err();

        let task = only_task(&database);
        assert_eq!(task.status, "failed");
        assert_eq!(task.error.as_deref(), Some(error.as_str()));
        // 半份文件留着，恢复（或重试）时能接着收；它不会出现在档案列表里。
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        let connection = database.connection.lock().unwrap();
        assert!(reconcile_local_archives(&connection, directory.path())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn download_progress_never_reads_full_before_the_file_is_closed() {
        assert_eq!(download_progress(50, 100), 0.5);
        assert_eq!(download_progress(100, 100), 0.99);
        assert_eq!(download_progress(100, 0), 0.0);
    }

    #[test]
    fn download_labels_fall_back_and_stay_short() {
        assert_eq!(download_task_label(&serde_json::json!({})), "下载档案");
        assert_eq!(
            download_task_label(&serde_json::json!({ "title": "   " })),
            "下载档案"
        );
        let label = download_task_label(&serde_json::json!({ "title": "漫".repeat(400) }));
        assert_eq!(label.chars().count(), "下载 ".chars().count() + 80);
    }

    #[test]
    fn scanning_follows_the_directory_not_the_database() {
        let database = Database::open_path(":memory:").expect("database");
        let connection = database.connection.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let kept = directory.path().join("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1-留下的.zip");
        let gone = directory.path().join("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2-删掉的.cbz");
        std::fs::write(&kept, b"kept").unwrap();
        std::fs::write(&gone, b"gone").unwrap();
        // 写一半的文件不算档案：它还没有名字，也没有内容。
        std::fs::write(directory.path().join("cccccccccccccccccccccccccccccccccccccccc-x.zip.part"), b"half").unwrap();

        let first = reconcile_local_archives(&connection, directory.path()).unwrap();
        assert_eq!(first.len(), 2);

        // 外部删掉一个文件之后，那一行也跟着走：页面上不会留一个点开才发现没有的条目。
        std::fs::remove_file(&gone).unwrap();
        let second = reconcile_local_archives(&connection, directory.path()).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].path, kept.to_string_lossy());
        assert_eq!(second[0].title, "留下的");
    }

    #[test]
    fn deleting_local_archives_removes_the_file_and_the_row() {
        let database = Database::open_path(":memory:").expect("database");
        let connection = database.connection.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let kept = directory.path().join("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1-留下的.zip");
        let doomed = directory.path().join("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2-删掉的.cbz");
        std::fs::write(&kept, b"kept").unwrap();
        std::fs::write(&doomed, b"gone").unwrap();
        reconcile_local_archives(&connection, directory.path()).unwrap();

        // 删除走的是「文件 + 行」两条腿：只剩行会让页面留一个点不开的条目，
        // 只剩文件则是下次扫描又冒出来。
        std::fs::remove_file(&doomed).unwrap();
        connection
            .execute(
                "DELETE FROM local_archives WHERE path = ?1",
                params![doomed.to_string_lossy()],
            )
            .unwrap();
        let left = reconcile_local_archives(&connection, directory.path()).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].path, kept.to_string_lossy());
        assert!(kept.exists());
    }

    #[test]
    fn orphaned_part_files_are_swept_and_claimed_ones_are_not() {
        let database = Database::open_path(":memory:").expect("database");
        let directory = tempfile::tempdir().unwrap();
        let claimed = directory.path().join("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1-在下的.zip.part");
        let orphan = directory.path().join("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-没人认领的.zip.part");
        std::fs::write(&claimed, b"half").unwrap();
        std::fs::write(&orphan, b"half").unwrap();
        // 任务行先建好，再拿锁去扫：`create_download_task` 自己也要这把锁。
        create_download_task(
            &database,
            "下载 在下的",
            "scope-a",
            &"a".repeat(40),
            &claimed,
            Some(10),
        )
        .unwrap();

        sweep_orphan_parts(&database.connection.lock().unwrap(), directory.path());

        assert!(claimed.exists());
        assert!(!orphan.exists());
    }
}

/// 下载目录里认得出的档案后缀。下载写的是 `.part`，扫描时按后缀跳过。
const LOCAL_ARCHIVE_EXTENSIONS: [&str; 9] = [
    "zip", "rar", "7z", "tar", "gz", "cbz", "cbr", "cb7", "cbt",
];

/// 下载落在哪个目录：设置里为空就回到程序数据目录下的 `downloads`。
fn resolved_download_directory(
    app: &tauri::AppHandle,
    connection: &Connection,
) -> Result<std::path::PathBuf, String> {
    let preferences = crate::settings::load_preferences_from(connection)?;
    if preferences.download_directory.is_empty() {
        Ok(crate::inference::model_data_dir(app)
            .map_err(|error| error.to_string())?
            .join("downloads"))
    } else {
        Ok(std::path::PathBuf::from(preferences.download_directory))
    }
}

/// 文件名里带着下载时写进去的档案 id。认得出，就能借本地镜像拿到标题、标签和
/// 封面；认不出，它就是一份普通的本地档案。
fn local_archive_id(path: &std::path::Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    if stem.len() <= 41 || !stem.is_char_boundary(40) {
        return None;
    }
    let (prefix, rest) = stem.split_at(40);
    (rest.starts_with('-') && prefix.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| prefix.to_ascii_lowercase())
}

/// `<40 位 id>-标题.ext` → 标题；认不出 id 就是去掉后缀的文件名。
fn local_archive_title(path: &std::path::Path) -> String {
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    match local_archive_id(path).and_then(|id| stem.get(id.len() + 1..).map(str::to_string)) {
        Some(title) => title.trim().to_string(),
        None => stem.trim().to_string(),
    }
}

fn local_archive_extension(path: &std::path::Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// 下载目录里现存的档案文件（路径、字节数、修改时间）。
fn scan_local_archive_files(directory: &std::path::Path) -> Vec<(std::path::PathBuf, u64, i64)> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(directory) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file()
            || !LOCAL_ARCHIVE_EXTENSIONS.contains(&local_archive_extension(&path).as_str())
        {
            continue;
        }
        let added_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or_else(now_millis);
        found.push((path, metadata.len(), added_at));
    }
    found
}

/// 没有任务认领的 `.part`：进程被杀掉、任务行早已收掉之后留下的半份文件。它们
/// 不进列表，也没人会去恢复，留着只是占地方。
fn sweep_orphan_parts(connection: &Connection, directory: &std::path::Path) {
    let claimed: std::collections::HashSet<String> = connection
        .prepare("SELECT local_path FROM tasks WHERE local_path IS NOT NULL")
        .and_then(|mut statement| {
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<std::collections::HashSet<_>, _>>()
        })
        .unwrap_or_default();
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("part") {
            continue;
        }
        if claimed.contains(path.to_string_lossy().as_ref()) {
            continue;
        }
        let _ = std::fs::remove_file(&path);
    }
}

/// 批量版镜像补缺：一次把本页出现的所有 archive_id 问齐（按 500 分块，
/// 尊重 SQLite 参数上限），原先每行一查，一页几百个本地档案就是几百次点查。
/// 每个 id 优先取本地行归属的那台服务器的记录，没有就取第一条。
fn query_mirror_local_archives(
    connection: &Connection,
    rows: &[LocalArchiveRow],
) -> std::collections::HashMap<String, (String, String, Option<i64>, String, String)> {
    let mut preferences: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut ids: Vec<String> = Vec::new();
    for (_, archive_id, server_id, ..) in rows {
        let Some(archive_id) = archive_id else { continue };
        preferences.entry(archive_id).or_insert(server_id.as_deref().unwrap_or(""));
        if seen.insert(archive_id) {
            ids.push(archive_id.clone());
        }
    }
    let mut mirrors: std::collections::HashMap<String, (String, String, Option<i64>, String, String)> =
        std::collections::HashMap::new();
    for chunk in ids.chunks(500) {
        let mut sql = String::from(
            "SELECT a.archive_id, a.server_id, s.scope_id, a.page_count, a.tags_json, a.title
             FROM archives a JOIN servers s ON s.id = a.server_id
             WHERE a.is_deleted = 0 AND a.archive_id IN (",
        );
        for (index, _) in chunk.iter().enumerate() {
            if index > 0 {
                sql.push(',');
            }
            sql.push_str(&format!("?{}", index + 1));
        }
        sql.push(')');
        let candidates = connection
            .prepare(&sql)
            .and_then(|mut statement| {
                let rows = statement.query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })?;
                rows.collect::<Result<Vec<_>, _>>()
            })
            .map_err(|error| error.to_string());
        let Ok(candidates) = candidates else { continue };
        for (archive_id, server_id, scope_id, page_count, tags_json, title) in candidates {
            let preferred = preferences
                .get(archive_id.as_str())
                .is_some_and(|pref| **pref == server_id);
            match mirrors.entry(archive_id) {
                std::collections::hash_map::Entry::Vacant(slot) => {
                    slot.insert((server_id, scope_id, page_count, tags_json, title));
                }
                std::collections::hash_map::Entry::Occupied(mut slot) => {
                    if preferred {
                        slot.insert((server_id, scope_id, page_count, tags_json, title));
                    }
                }
            }
        }
    }
    mirrors
}

/// 本地档案页上的一个条目。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalArchiveRecord {
    path: String,
    archive_id: Option<String>,
    server_id: Option<String>,
    scope_id: Option<String>,
    title: String,
    file_size: i64,
    added_at: i64,
    page_count: Option<i64>,
    tags: Vec<String>,
}

/// `local_archives` 一行读出来的样子：路径、档案 id、服务器、标题、大小、加入时间，
/// 以及下载时抄下来的那三列（页数、标签 JSON、取封面用的 scope）。
type LocalArchiveRow = (
    String,
    Option<String>,
    Option<String>,
    String,
    i64,
    i64,
    Option<i64>,
    Option<String>,
    Option<String>,
);

/// 扫一遍下载目录：文件才是主语，所以新增的记进来、已经不存在的行收掉，之后再
/// 读表。外部删掉一个文件，这一页下次刷新就跟着少了它。
fn reconcile_local_archives(
    connection: &Connection,
    directory: &std::path::Path,
) -> Result<Vec<LocalArchiveRecord>, String> {
    let files = scan_local_archive_files(directory);
    let live: std::collections::HashSet<String> = files
        .iter()
        .map(|(path, _, _)| path.to_string_lossy().into_owned())
        .collect();
    let stored: Vec<String> = connection
        .prepare("SELECT path FROM local_archives")
        .and_then(|mut statement| {
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    for path in stored {
        if !live.contains(&path) {
            connection
                .execute("DELETE FROM local_archives WHERE path = ?1", params![path])
                .map_err(|error| error.to_string())?;
        }
    }
    // 只有新文件或 size/mtime 变了才 UPSERT：这一页每十几秒刷一次，
    // 无条件重写每一行只是给 WAL 制造 churn。
    let stored_signatures: std::collections::HashMap<String, (i64, i64)> = connection
        .prepare("SELECT path, file_size, added_at FROM local_archives")
        .and_then(|mut statement| {
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
            })?;
            rows.collect::<Result<Vec<(String, i64, i64)>, _>>()
        })
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|(path, size, added)| (path, (size, added)))
        .collect();
    for (path, size, added_at) in files {
        if stored_signatures
            .get(path.to_string_lossy().as_ref())
            .is_some_and(|(stored_size, stored_added)| *stored_size == size as i64 && *stored_added == added_at)
        {
            continue;
        }
        connection
            .execute(
                "INSERT INTO local_archives (path, archive_id, title, file_size, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(path) DO UPDATE SET file_size = excluded.file_size, added_at = excluded.added_at",
                params![
                    path.to_string_lossy(),
                    local_archive_id(&path),
                    local_archive_title(&path),
                    size as i64,
                    added_at
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    let rows: Vec<LocalArchiveRow> = connection
        .prepare("SELECT path, archive_id, server_id, title, file_size, added_at, page_count, tags_json, scope_id FROM local_archives ORDER BY added_at DESC, path DESC")
        .and_then(|mut statement| {
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    let mirror = query_mirror_local_archives(connection, &rows);
    Ok(rows
        .into_iter()
        .map(
            |(path, archive_id, server_id, title, file_size, added_at, page_count, tags_json, scope_id)| {
                let mirror = archive_id.as_deref().and_then(|archive_id| mirror.get(archive_id)).cloned();
                // 服务器镜像只补缺：下载时抄下的那一份在，就不再要求 archives 表里
                // 正好有这一份。补到的东西写回行里——下一次断网也读得到，而不是每
                // 次都去问服务器上那份还在不在。
                let mut record_server = server_id;
                let mut record_scope = scope_id;
                let mut record_pages = page_count;
                let mut record_tags = tags_json;
                let mut record_title = title;
                if let Some((mirror_server, mirror_scope, mirror_pages, mirror_tags, mirror_title)) =
                    mirror
                {
                    let before = (
                        record_server.clone(),
                        record_scope.clone(),
                        record_pages,
                        record_tags.clone(),
                        record_title.clone(),
                    );
                    record_server = record_server.or(Some(mirror_server));
                    record_scope = record_scope.or(Some(mirror_scope));
                    record_pages = record_pages.or(mirror_pages);
                    record_tags = record_tags.or(Some(mirror_tags));
                    // 文件名拆出来的标题不算标题：认出了服务器上那一份就用它的。
                    if record_title.trim().is_empty()
                        || record_title == local_archive_title(std::path::Path::new(&path))
                    {
                        record_title = mirror_title;
                    }
                    // 只在真补到东西时写回：这一页每十几秒读一次，不能每次都对每行做
                    // 一遍无谓的 UPDATE。
                    if (
                        record_server.clone(),
                        record_scope.clone(),
                        record_pages,
                        record_tags.clone(),
                        record_title.clone(),
                    ) != before
                    {
                        let _ = connection.execute(
                            "UPDATE local_archives SET server_id = ?1, scope_id = ?2, page_count = ?3, tags_json = ?4, title = ?5 WHERE path = ?6",
                            params![record_server, record_scope, record_pages, record_tags, record_title, path],
                        );
                    }
                }
                LocalArchiveRecord {
                    archive_id,
                    server_id: record_server,
                    scope_id: record_scope,
                    title: record_title,
                    page_count: record_pages,
                    tags: record_tags
                        .as_deref()
                        .and_then(|tags| serde_json::from_str::<Vec<String>>(tags).ok())
                        .unwrap_or_default(),
                    path,
                    file_size,
                    added_at,
                }
            },
        )
        .collect())
}

/// 本地档案页读的就是这个：先跟磁盘对齐，再回一份带镜像信息的列表。
/// async：命令体里有目录 walk 与整表 UPSERT，必须离开主线程，
/// 否则每 10-15s 一次的轮询会卡 UI。
#[tauri::command(async)]
pub fn list_local_archives(
    app: tauri::AppHandle,
    database: State<'_, Database>,
) -> CommandResult<Vec<LocalArchiveRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    let directory = match resolved_download_directory(&app, &connection) {
        Ok(directory) => directory,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let _ = std::fs::create_dir_all(&directory);
    sweep_orphan_parts(&connection, &directory);
    match reconcile_local_archives(&connection, &directory) {
        Ok(records) => CommandResult::success(records),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

/// 删除选中的本地档案：删的是磁盘上的文件，服务器上的那份档案不动。只认下载
/// 目录里的直接子文件——这个命令的输入来自前端，不能变成「删任意路径」的接口。
#[tauri::command(async)]
pub fn delete_local_archives(
    app: tauri::AppHandle,
    paths: Vec<String>,
    database: State<'_, Database>,
) -> CommandResult<usize> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    let directory = match resolved_download_directory(&app, &connection) {
        Ok(directory) => directory,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let boundary = std::fs::canonicalize(&directory).unwrap_or_else(|_| directory.clone());
    let mut removed = 0;
    for path in &paths {
        let candidate = std::path::Path::new(path);
        let inside = std::fs::canonicalize(candidate)
            .map(|resolved| resolved.parent() == Some(boundary.as_path()))
            // 文件已经不在了也算「可以删」：要清掉的是那一行。
            .unwrap_or(true);
        if inside && std::fs::remove_file(candidate).is_ok() {
            removed += 1;
        }
        if let Err(error) = connection.execute(
            "DELETE FROM local_archives WHERE path = ?1",
            params![path],
        ) {
            return CommandResult::failure("UNKNOWN", error.to_string(), true);
        }
    }
    CommandResult::success(removed)
}

/// 暂停：写信号，正在跑的那次传输会在下一块之前停下来，半份文件留在 `.part`。
#[tauri::command(async)]
pub fn pause_download(task_id: String, database: State<'_, Database>) -> CommandResult<()> {
    set_download_signal(&task_id, DownloadSignal::Paused);
    // 没在跑的任务（比如重启之后停下的那些）也要落到 paused，界面上的状态和
    // 按钮才对得上。
    if let Ok(connection) = database.connection.lock() {
        let _ = connection.execute(
            "UPDATE tasks SET status = 'paused', bytes_per_second = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND status IN ('running', 'queued')",
            params![task_id],
        );
    }
    CommandResult::success(())
}

/// 中止：删掉半份文件，任务收成 cancelled。
#[tauri::command(async)]
pub fn cancel_download(task_id: String, database: State<'_, Database>) -> CommandResult<()> {
    set_download_signal(&task_id, DownloadSignal::Aborted);
    if let Ok(connection) = database.connection.lock() {
        let part: Option<String> = connection
            .query_row(
                "SELECT local_path FROM tasks WHERE id = ?1 AND status IN ('running', 'queued', 'paused', 'failed')",
                params![task_id],
                |row| row.get(0),
            )
            .ok();
        if let Some(part) = part.filter(|part| part.ends_with(".part")) {
            let _ = std::fs::remove_file(part);
        }
    }
    cancel_download_task(&database, &task_id);
    CommandResult::success(())
}

/// 恢复（失败的任务也走这条路）：从 `.part` 已有的字节往后要，服务端不认 Range
/// 就从头来。
#[tauri::command]
pub async fn resume_download(
    app: tauri::AppHandle,
    task_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<DownloadResult>, String> {
    let loaded = {
        let connection = database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.to_string())?;
        connection
            .query_row(
                "SELECT label, server_id, archive_id, local_path, received_bytes, total_bytes, status
                 FROM tasks WHERE id = ?1 AND kind = 'download'",
                params![task_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .ok()
    };
    let Some((label, server_id, archive_id, local_path, received, total, status)) = loaded else {
        return Ok(CommandResult::failure(
            "LRR_NOT_FOUND",
            "Download task not found",
            false,
        ));
    };
    if !matches!(status.as_str(), "paused" | "failed" | "queued") {
        return Ok(CommandResult::failure(
            "REMOTE_CONFLICT",
            "Download is not resumable",
            false,
        ));
    }
    let (Some(server_id), Some(archive_id), Some(local_path)) = (server_id, archive_id, local_path)
    else {
        return Ok(CommandResult::failure(
            "REMOTE_CONFLICT",
            "Download has no target file",
            false,
        ));
    };
    let part = std::path::PathBuf::from(&local_path);
    let directory = part
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_default();
    let final_name = part
        .file_name()
        .map(|name| name.to_string_lossy().trim_end_matches(".part").to_string())
        .unwrap_or_default();
    let (base_url, scope_id) = {
        let connection = database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.to_string())?;
        server_connection(&connection, &server_id)?
    };
    // 文件被外部删掉或者短了，就从它现在真正有的地方接。
    let on_disk = std::fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
    let resume_from = if on_disk == 0 {
        0
    } else {
        (received.max(0) as u64).min(on_disk)
    };
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<DownloadResult, String> {
        let api_key = SystemCredentialStore
            .get_server_api_key(&scope_id)
            .map_err(credential_read_error)?;
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(3600))
            .build()
            .map_err(|error| error.to_string())?;
        // 阻塞线程拿不到 `State`，跟 download_archive 一样从 AppHandle 里取。
        let database = app.state::<Database>();
        // 恢复也要把元数据带上：收完那一刻本地档案那一行要写标题、标签和页数，而
        // 这一路手上只有任务行的标签。拿不到不算失败——档案本身还是要收完的。
        let metadata = client
            .get(format!(
                "{}/api/archives/{}/metadata",
                base_url.trim_end_matches('/'),
                archive_id
            ))
            .header(
                reqwest::header::AUTHORIZATION,
                authorization_value(&api_key),
            )
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .and_then(reqwest::blocking::Response::json::<serde_json::Value>)
            .unwrap_or_else(|_| serde_json::json!({}));
        transfer_archive(
            &database,
            TransferRequest {
                client,
                api_key,
                base_url,
                server_id,
                scope_id,
                archive_id,
                directory,
                metadata,
                task: Some(TaskTransfer {
                    id: task_id,
                    label,
                    received: resume_from,
                    total: total.map(|total| total as u64),
                    part,
                    final_name,
                }),
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(match result {
        Ok(download) => CommandResult::success(download),
        Err(error) => CommandResult::failure("REMOTE_UNAVAILABLE", error, true),
    })
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
        Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
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
                crate::cache::LOCK_FAILED,
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

/// 一次删除里每个网络动作最多试几次（Readoshi 同样是三次，间隔递增）。
const DELETION_ATTEMPTS: usize = 3;
/// 第一次重试前的等待，之后按次数递增。
const DELETION_RETRY_DELAY_MS: u64 = 150;

/// 删除一个档案，必要时先删它的 E-Hentai 收藏。
///
/// 顺序与 Readoshi 一致：先收藏、后档案。反过来的话，档案一旦删掉，就再也读不到
/// 它标签里的画廊地址，收藏只能留在 E-Hentai 上变成孤儿。
///
/// 收藏删不掉就不删档案：设置里写的是「删除档案时一并删除对应的收藏」，做不到时
/// 宁可让用户先处理登录（或关掉这次同步），也不留一个删不掉的收藏。
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
                    .map_err(|_| crate::cache::LOCK_FAILED.to_string())?;
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
            let mut attempt = 0;
            loop {
                attempt += 1;
                match crate::commands::eh::remove_eh_favorite(
                    account_id.clone(),
                    gallery_id.clone(),
                    token.clone(),
                    database.clone(),
                )
                .await?
                {
                    CommandResult::Success { .. } => break,
                    failure => {
                        // 只有网络抖动这类可重试的失败才重来；登录失效、画廊被删
                        // 这些重试多少次都是同一个答案。
                        if !retryable_failure(&failure) || attempt >= DELETION_ATTEMPTS {
                            return Ok(failure);
                        }
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(
                    DELETION_RETRY_DELAY_MS * attempt as u64,
                ))
                .await;
            }
        }
    }
    let mut attempt = 0;
    loop {
        attempt += 1;
        let result = delete_archive(server_id.clone(), archive_id.clone(), database.clone()).await?;
        if !retryable_failure(&result) || attempt >= DELETION_ATTEMPTS {
            return Ok(result);
        }
        tokio::time::sleep(std::time::Duration::from_millis(
            DELETION_RETRY_DELAY_MS * attempt as u64,
        ))
        .await;
    }
}

fn retryable_failure<T>(result: &CommandResult<T>) -> bool {
    matches!(result, CommandResult::Failure { error, .. } if error.retryable)
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
        Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
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
            return Ok(reader_response_failure(error))
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
    let cached = load_reader_page_cache(&database, &app_data, &scope_id, &archive_id, page_index);
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
        Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
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
            // A failed cache write means every later read re-fetches, so it
            // must not vanish silently.
            if let Err(error) = store_reader_page_cache(
                &database,
                &app_data,
                &scope_id,
                &archive_id,
                page_index,
                &mime,
                &bytes,
            ) {
                eprintln!("yomika: reader page cache write failed: {error}");
            }
            Ok(CommandResult::success(bytes.to_vec()))
        }
        Err(error) => Ok(reader_response_failure(error)),
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
    load_archive_thumbnail_bytes_with_cache(server_id, archive_id, database, app, true).await
}

pub(crate) async fn load_archive_thumbnail_bytes_with_cache(
    server_id: String,
    archive_id: String,
    database: State<'_, Database>,
    app: tauri::AppHandle,
    use_cache: bool,
) -> Result<CommandResult<Vec<u8>>, String> {
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
    if use_cache {
        match crate::cache::read_cached_image(&database, &app_data, &cache_identity) {
            Ok(Some(image))
                if crate::cache::sniff_image_mime("application/octet-stream", &image.bytes)
                    .is_some() =>
            {
                return Ok(CommandResult::success(image.bytes))
            }
            Ok(Some(_)) => {}
            Ok(None) => {}
            Err(error) => return Ok(CommandResult::failure("UNKNOWN", error, true)),
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
    let result = fetch_cover_thumbnail(&base_url, &archive_id, api_key).await?;
    if let CommandResult::Success { value: bytes, .. } = &result {
        let mime = crate::cache::sniff_image_mime("application/octet-stream", bytes)
            .unwrap_or_else(|| "image/jpeg".into());
        if let Err(error) =
            crate::cache::write_cached_image(&database, &app_data, &cache_identity, &mime, bytes)
        {
            eprintln!("yomika: image cache write failed: {error}");
        }
    }
    Ok(result)
}

#[derive(Debug)]
pub(crate) enum CoverThumbnail {
    Ready(Vec<u8>),
    Queued(i64),
}

async fn fetch_cover_thumbnail(
    base_url: &str,
    archive_id: &str,
    api_key: String,
) -> Result<CommandResult<Vec<u8>>, String> {
    match fetch_cover_thumbnail_inner(base_url, archive_id, api_key, false, None).await? {
        CommandResult::Success {
            value: CoverThumbnail::Ready(bytes),
            ..
        } => Ok(CommandResult::success(bytes)),
        CommandResult::Failure { error, .. } => Ok(CommandResult::Failure { ok: false, error }),
        _ => unreachable!("waiting fetch never defers a job"),
    }
}

async fn fetch_cover_thumbnail_deferred(
    base_url: &str,
    archive_id: &str,
    api_key: String,
) -> Result<CommandResult<CoverThumbnail>, String> {
    fetch_cover_thumbnail_inner(base_url, archive_id, api_key, true, None).await
}

/// Scan probes release their download slot as soon as LRR queues generation.
/// The deferred pass retains the original job ID rather than enqueueing it again.
pub(crate) async fn load_scan_thumbnail(
    server_id: &str,
    archive_id: &str,
    database: &Database,
    app_data: &std::path::Path,
    pending_job: Option<(i64, tokio::time::Instant)>,
) -> Result<CommandResult<CoverThumbnail>, String> {
    let (base_url, scope_id) = {
        let connection = database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.to_string())?;
        server_connection(&connection, server_id)?
    };
    let api_key = SystemCredentialStore.get_server_api_key(&scope_id)?;
    if let Some((job, deadline)) = pending_job {
        if let Some(error) =
            wait_for_cover_thumbnail_job(&base_url, job, &api_key, Some(deadline)).await
        {
            return Ok(CommandResult::Failure { ok: false, error });
        }
    }
    let result = if pending_job.is_some() {
        fetch_cover_thumbnail_inner(&base_url, archive_id, api_key, false, pending_job.map(|(_, deadline)| deadline)).await?
    } else {
        fetch_cover_thumbnail_deferred(&base_url, archive_id, api_key).await?
    };
    if let CommandResult::Success {
        value: CoverThumbnail::Ready(bytes),
        ..
    } = &result
    {
        let identity = crate::cache::CacheImageIdentity::new(&scope_id, archive_id, "cover", 0);
        let mime = crate::cache::sniff_image_mime("application/octet-stream", bytes)
            .unwrap_or_else(|| "image/jpeg".into());
        if let Err(error) =
            crate::cache::write_cached_image(database, app_data, &identity, &mime, bytes)
        {
            eprintln!("yomika: image cache write failed: {error}");
        }
    }
    Ok(result)
}

async fn wait_for_cover_thumbnail_job(
    base_url: &str,
    job_id: i64,
    api_key: &str,
    deadline: Option<tokio::time::Instant>,
) -> Option<crate::domain::result::DomainError> {
    let deadline = deadline
        .unwrap_or_else(|| tokio::time::Instant::now() + std::time::Duration::from_secs(120));
    let failure = |code, message: String, retryable| crate::domain::result::DomainError {
        code,
        message,
        retryable,
    };
    let mut finished = false;
    // 2 分钟上限，和 Readoshi 等缩略图任务的口径一致。
    // 先查再等：任务常常转瞬就绪，上来先睡半秒是白付的；
    // 查重扫描会串行经过每个缺封面的档案，这笔就是 N×500ms。
    for _ in 0..240 {
        let status_url = format!("{}/api/minion/{}", base_url.trim_end_matches('/'), job_id);
        let status =
            match reader_request(reqwest::Method::GET, status_url, api_key.to_string()).await {
                Ok(value) => value,
                Err(error) => return Some(failure(error.code, error.message, true)),
            };
        let body = match status.bytes().await {
            Ok(body) => body,
            Err(error) => {
                return Some(match reader_response_failure::<Vec<u8>>(error) {
                    CommandResult::Failure { error, .. } => error,
                    _ => unreachable!(),
                })
            }
        };
        let payload: serde_json::Value = match serde_json::from_slice(&body) {
            Ok(payload) => payload,
            Err(error) => return Some(failure("INVALID_RESPONSE", error.to_string(), false)),
        };
        let state = payload
            .get("state")
            .and_then(|state| state.as_str())
            .map(str::to_owned);
        if state.as_deref() == Some("finished") {
            finished = true;
            break;
        }
        if matches!(state.as_deref(), Some("failed") | Some("error")) {
            return Some(failure(
                "REMOTE_UNAVAILABLE",
                "LANraragi 缩略图生成失败".into(),
                true,
            ));
        }
        // Probe once even after the deadline: a job may have finished
        // while other ready covers were being processed. Inactive jobs
        // do not get a fresh two-minute budget when their slot opens.
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep_until(
            deadline.min(tokio::time::Instant::now() + std::time::Duration::from_millis(500)),
        )
        .await;
    }
    if !finished {
        return Some(failure(
            "REMOTE_UNAVAILABLE",
            "LANraragi 缩略图生成超时".into(),
            true,
        ));
    }
    None
}

async fn fetch_cover_thumbnail_inner(
    base_url: &str,
    archive_id: &str,
    api_key: String,
    defer_generation: bool,
    deadline: Option<tokio::time::Instant>,
) -> Result<CommandResult<CoverThumbnail>, String> {
    let deadline = deadline.unwrap_or_else(|| tokio::time::Instant::now() + std::time::Duration::from_secs(120));
    // `no_fallback=true` 是必须的：不带它时，凡是缩略图尚未生成的档案都会拿到
    // 同一张占位图（HTTP 200），而那张图会被逐字节缓存下来——查重按封面比对时，
    // 所有待生成缩略图的档案封面完全相同，于是被判成一堆重复档案。带参数后
    // LRR 改为回 202 + Minion 任务号（图像已存在时照样直接给图），于是这里等
    // 任务完成再取真图，等不到就把该档案记作缺封面，而不是拿占位图去参与比对。
    // 语义见 LANraragi API：GET /archives/{id}/thumbnail。
    let url = format!(
        "{}/api/archives/{}/thumbnail?no_fallback=true",
        base_url.trim_end_matches('/'),
        archive_id
    );
    let mut response = None;
    // 任务结束与文件落盘之间有窗口期，重取可能又拿到 202；最多轮 3 轮。
    for attempt in 0..3 {
        let candidate =
            match reader_request(reqwest::Method::GET, url.clone(), api_key.clone()).await {
                Ok(value) => value,
                Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
            };
        if candidate.status().is_server_error() && attempt < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(150 * (attempt + 1))).await;
            continue;
        }
        if candidate.status().as_u16() != 202 {
            response = Some(candidate);
            break;
        }
        let job_body = match candidate.bytes().await {
            Ok(body) => body,
            Err(error) => return Ok(reader_response_failure(error)),
        };
        let job_id = serde_json::from_slice::<serde_json::Value>(&job_body)
            .ok()
            .and_then(|value| {
                let job = value.get("job").cloned().unwrap_or(value);
                job.as_i64()
                    .or_else(|| job.as_str().and_then(|value| value.parse::<i64>().ok()))
            });
        if let Some(job_id) = job_id {
            if defer_generation {
                return Ok(CommandResult::success(CoverThumbnail::Queued(job_id)));
            }
            if let Some(error) =
                wait_for_cover_thumbnail_job(base_url, job_id, &api_key, Some(deadline)).await
            {
                return Ok(CommandResult::Failure { ok: false, error });
            }
        } else {
            return Ok(CommandResult::failure(
                "REMOTE_UNAVAILABLE",
                "LANraragi 未返回缩略图任务编号",
                true,
            ));
        }
    }
    let Some(response) = response else {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            "LANraragi 缩略图生成超时",
            true,
        ));
    };
    // 兜底：202 的 JSON 体不能当图片缓存下去（Readoshi 也为此专门清理过缓存）。
    if response.status().as_u16() == 202 {
        return Ok(CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            "LANraragi 缩略图仍在生成",
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
            Ok(CommandResult::success(CoverThumbnail::Ready(
                bytes.to_vec(),
            )))
        }
        Ok(_) => Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "LANraragi thumbnail response is not an image",
            true,
        )),
        Err(error) => Ok(reader_response_failure(error)),
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
    match crate::cache::read_cached_image(&database, &app_data, &cache_identity) {
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
    if let Err(error) = crate::cache::write_cached_image(
        &database,
        &app_data,
        &cache_identity,
        "application/octet-stream",
        &bytes,
    ) {
        eprintln!("yomika: image cache write failed: {error}");
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
            Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
        };
    let response = if response.status().as_u16() == 202 {
        let job_body = match response.bytes().await {
            Ok(body) => body,
            Err(error) => return Ok(reader_response_failure(error)),
        };
        let job_id = serde_json::from_slice::<serde_json::Value>(&job_body).ok()
            .and_then(|value| {
                let job = value.get("job").cloned().unwrap_or(value);
                job.as_i64()
                    .or_else(|| job.as_str().and_then(|value| value.parse::<i64>().ok()))
            });
        if let Some(job_id) = job_id {
            let mut finished = false;
            // 先查再等：与 thumbnail 那边的口径一致，不白付首次的半秒。
            for _ in 0..poll_attempts {
                let status_url =
                    format!("{}/api/minion/{}", base_url.trim_end_matches('/'), job_id);
                let status =
                    match reader_request(reqwest::Method::GET, status_url, api_key.clone()).await {
                        Ok(value) => value,
                        Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
                    };
                let body = match status.bytes().await {
                    Ok(body) => body,
                    Err(error) => return Ok(reader_response_failure(error)),
                };
                let payload: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(payload) => payload,
                    Err(error) => return Ok(CommandResult::failure("INVALID_RESPONSE", error.to_string(), false)),
                };
                let state = payload.get("state").and_then(|state| state.as_str()).map(str::to_owned);
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
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
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
                Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
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
        Err(error) => Ok(reader_response_failure(error)),
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

// Metadata responses may omit optional facts. Preserve known summary and the
// existing upsert boundary's added_at/first_seen/category/local-overlay state.
fn persist_archive_metadata(
    connection: &mut rusqlite::Connection,
    server_id: &str,
    wire: &ArchiveMetadataWire,
) -> Result<(), String> {
    let summary = match &wire.summary {
        Some(summary) => Some(summary.clone()),
        None => connection.query_row(
            "SELECT summary FROM archives WHERE server_id=?1 AND archive_id=?2",
            params![server_id, wire.arcid], |row| row.get::<_, Option<String>>(0),
        ).optional().map_err(|error| error.to_string())?.flatten(),
    };
    upsert_server_archives(connection, server_id, &[RemoteArchive {
        archive_id: wire.arcid.clone(), title: wire.title.clone(), summary,
        tags: wire.tags.split(',').map(str::trim).filter(|tag| !tag.is_empty()).map(str::to_owned).collect(),
        page_count: wire.pagecount, size: wire.size,
    }])
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

#[tauri::command(async)]
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
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
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

/// 一条动态分类的会员名单：`/api/search` 带上它的过滤表达式，不分页（`start=-1`）。
///
/// **贵**：回包里是每个命中档案的完整元数据，1.5 万档案的库上单条约 2.5 秒，一条
/// 分类没有上限就是几十秒。所以只有真的要这条名单时才调它——静态分类的名单就在
/// `/api/categories` 的回包里（`CategoryMetadataJson.archives`），不必搜索。
async fn resolve_category_archives(
    base_url: &str,
    api_key: &str,
    search: &str,
) -> Option<Vec<String>> {
    let url = build_category_search_url(base_url, search).ok()?;
    let response = reader_request_with_timeout(
        reqwest::Method::GET,
        url,
        api_key.to_string(),
        CATEGORY_SEARCH_TIMEOUT_SECONDS,
    )
    .await
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.text().await.ok()?;
    let archives = parse_search_response(&body).ok()?;
    Some(
        archives
            .into_iter()
            .map(|archive| archive.archive_id)
            .collect::<Vec<_>>(),
    )
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
/// Two at a time: each resolution is an unpaged full-library search, and a
/// library with many dynamic categories would otherwise fire them all at once.
const MAX_PARALLEL_CATEGORY_SEARCHES: usize = 2;
/// A whole-library search is not a page request. Ten seconds is enough for
/// `/api/categories` and nowhere near enough for `start=-1` on a large
/// library — and a timeout here is stored as an empty category, which reads
/// as "nothing is in it".
const CATEGORY_SEARCH_TIMEOUT_SECONDS: u64 = 45;

/// The one category the shelves and the heart read: LANraragi's own 🔖 Favorites.
/// Matched by name because that is what the API carries; the id is generated per
/// server (`SET_…`), so it cannot be a constant.
const FAVORITES_CATEGORY_NAME: &str = "\u{1f516} Favorites";

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
            "DELETE FROM settings WHERE key IN (?1, ?2)",
            params![category_cache_key(server_id), favorites_cache_key(server_id)],
        )
        .map(|_| ())
        .map_err(|error| format!("清除分类缓存失败：{error}"))
}

/// 🔖 Favorites 这一条分类：书架、详情页的心、右键菜单与多选都只要它。
#[derive(Serialize, Deserialize, Clone)]
pub struct FavoritesCategoryRecord {
    pub id: String,
    pub archives: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct FavoritesCacheEnvelope {
    synced_at: i64,
    category: FavoritesCategoryRecord,
}

fn favorites_cache_key(server_id: &str) -> String {
    format!("categories.favorites.{server_id}")
}

fn favorites_from_categories(categories: &[CategoryRecord]) -> Option<FavoritesCategoryRecord> {
    categories
        .iter()
        .find(|category| category.name == FAVORITES_CATEGORY_NAME)
        .map(|category| FavoritesCategoryRecord {
            id: category.id.clone(),
            archives: category.archives.clone(),
        })
}

/// 收藏快照的读法有两种：新鲜（6 小时）与不论年龄。后者只用在网络取不到的时候——
/// 一份过期的收藏名单仍然能给出那条分类的 id（写入镜像要用），也仍然比「没有收藏」
/// 更接近事实。
fn read_favorites_cache_from(
    connection: &rusqlite::Connection,
    server_id: &str,
    now: i64,
    max_age: Option<i64>,
) -> Result<Option<FavoritesCategoryRecord>, String> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT value_json FROM settings WHERE key = ?1",
            [favorites_cache_key(server_id)],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取收藏夹缓存失败：{error}"))?;
    let Some(stored) = stored else {
        return Ok(None);
    };
    let envelope: FavoritesCacheEnvelope = match serde_json::from_str(&stored) {
        Ok(value) => value,
        // 旧结构（或写坏了）当作没有：下一次请求会重新取。
        Err(_) => return Ok(None),
    };
    if let Some(max_age) = max_age {
        let age = now.saturating_sub(envelope.synced_at);
        if age < 0 || age > max_age {
            return Ok(None);
        }
    }
    Ok(Some(envelope.category))
}

fn write_favorites_cache(
    connection: &rusqlite::Connection,
    server_id: &str,
    category: &FavoritesCategoryRecord,
) -> Result<(), String> {
    let envelope = FavoritesCacheEnvelope {
        synced_at: current_unix_seconds(),
        category: category.clone(),
    };
    let payload = serde_json::to_string(&envelope)
        .map_err(|error| format!("序列化收藏夹缓存失败：{error}"))?;
    connection
        .execute(
            "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            params![favorites_cache_key(server_id), payload],
        )
        .map_err(|error| format!("写入收藏夹缓存失败：{error}"))?;
    Ok(())
}

/// 本机已有的两份快照怎么回答「收藏是哪一条」：共享分类快照（新鲜，静态分类的名单
/// 就在里面）先答，它没有或过期了再问收藏自己那份。两个都没有才是 `None`——那才需要
/// 去网络取一次。
fn favorites_from_cached_snapshot(
    connection: &rusqlite::Connection,
    server_id: &str,
    now: i64,
) -> Result<Option<FavoritesCategoryRecord>, String> {
    if let Some(categories) = read_category_cache_from(connection, server_id, now)? {
        if let Some(favorites) = favorites_from_categories(&categories) {
            return Ok(Some(favorites));
        }
    }
    read_favorites_cache_from(
        connection,
        server_id,
        now,
        Some(CATEGORY_CACHE_MAX_AGE_SECONDS),
    )
}

/// Read the current server Favorites membership without resolving unrelated dynamic categories.
/// A missing category is a successful empty shelf; transport/schema failures remain failures.
/// Persisted snapshots are not authoritative for online favorites reads.
#[tauri::command]
pub async fn read_favorites_category(
    server_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<Option<FavoritesCategoryRecord>>, String> {
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
    let fetched = async {
        let response = reader_request(
            reqwest::Method::GET,
            format!("{}/api/categories", base_url.trim_end_matches('/')),
            api_key.clone(),
        )
        .await
        .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let raw: serde_json::Value = response.json().await.ok()?;
        Some(raw)
    }
    .await;
    let favorites = match fetched {
        None => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", "读取 LANraragi 分类失败", true)),
        Some(raw) => match parse_category_list(&raw) {
            Err(_) => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", "LANraragi 分类数据无效", true)),
            Ok(wire) => {
                let categories = wire.into_iter().map(category_record).collect::<Vec<_>>();
                // 静态收藏分类的名单是现成的；万一服务器上这条被改成了动态分类，
                // 就为它跑一次它自己的搜索——只有这一条，不是每一条。
                let mut found = favorites_from_categories(&categories);
                let search = categories
                    .iter()
                    .find(|category| category.name == FAVORITES_CATEGORY_NAME)
                    .and_then(|category| category.search.as_deref())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned);
                if let (Some(favorites), Some(search)) = (found.as_mut(), search) {
                    if favorites.archives.is_empty() {
                        match resolve_category_archives(&base_url, &api_key, &search).await {
                            Some(archives) => favorites.archives = archives,
                            None => return Ok(CommandResult::failure("REMOTE_UNAVAILABLE", "读取收藏分类成员失败", true)),
                        }
                    }
                }
                found.take()
            }
        },
    };
    if let Some(favorites) = favorites {
        if let Ok(connection) = database.connection.lock() {
            // 尽力而为：写不进快照只是下一次多取一回，不该让这次读取失败。
            let _ = write_favorites_cache(&connection, &server_id, &favorites);
        }
        return Ok(CommandResult::success(Some(favorites)));
    }
    Ok(CommandResult::success(None))
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
        .map_err(|error| (error.code, error.message, true))?;
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

/// Every row a query selects, gathered with bounded parallel page requests.
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
    // Learn the server's page size once, then fetch independent offsets in a
    // small bounded batch. A saved result must not pay one RTT per library page.
    const CONCURRENCY: usize = 4;
    let mut first_params = params.clone();
    first_params.start = Some(0);
    let (mut collected, filtered, _) = fetch_search_page(base_url, api_key, &first_params).await?;
    let page_size = collected.len().max(1);
    let expected = usize::try_from(filtered).map_err(|_| ("INVALID_RESPONSE", "Invalid archive count".into(), false))?;
    if expected.div_ceil(page_size) > MAX_SYNC_PAGES {
        return Err(("REMOTE_UNAVAILABLE", "LANraragi search exceeded the page limit before completing the snapshot".into(), true));
    }
    let mut seen = std::collections::HashSet::new();
    if collected.iter().any(|archive| !seen.insert(archive.archive_id.clone())) {
        return Err(("REMOTE_UNAVAILABLE", "LANraragi directory changed during synchronization; retry the scan".into(), true));
    }
    if search_walk_is_done(collected.len(), page_size, collected.len() as i64, filtered) {
        if collected.len() != expected {
            return Err(("REMOTE_UNAVAILABLE", "LANraragi returned an incomplete directory; local archives were kept unchanged".into(), true));
        }
        return Ok(collected);
    }
    let offsets: Vec<usize> = (collected.len()..expected).step_by(page_size).collect();
    for batch in offsets.chunks(CONCURRENCY) {
        let mut requests = JoinSet::new();
        for &offset in batch {
            let mut page_params = params.clone();
            page_params.start = Some(offset as i64);
            let base_url = base_url.to_owned();
            let api_key = api_key.to_owned();
            requests.spawn(async move {
                fetch_search_page(&base_url, &api_key, &page_params).await
                    .map(|(archives, count, _)| (offset, archives, count))
            });
        }
        let mut pages = Vec::with_capacity(batch.len());
        while let Some(page) = requests.join_next().await {
            pages.push(page.map_err(|_| ("REMOTE_UNAVAILABLE", "Archive index request interrupted".into(), true))??);
        }
        pages.sort_by_key(|(offset, _, _)| *offset);
        for (offset, archives, count) in pages {
            if count != filtered || archives.iter().any(|archive| !seen.insert(archive.archive_id.clone())) {
                return Err(("REMOTE_UNAVAILABLE", "LANraragi directory changed during synchronization; retry the scan".into(), true));
            }
            if archives.len() != page_size.min(expected - offset) {
                return Err(("REMOTE_UNAVAILABLE", "LANraragi returned an incomplete directory; local archives were kept unchanged".into(), true));
            }
            collected.extend(archives);
        }
    }
    Ok(collected)
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
    refresh_archives_impl(input, &database).await
}

async fn refresh_archives_impl(
    input: RefreshArchivesInput,
    database: &Database,
) -> Result<CommandResult<Vec<ArchiveRecord>>, String> {
    let (base_url, scope_id) = match database
        .connection
        .lock()
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
    Ok(refresh_archive_index_from_remote(database, &input.server_id, &base_url, &api_key, &input.params).await)
}

async fn refresh_archive_index_from_remote(
    database: &Database,
    server_id: &str,
    base_url: &str,
    api_key: &str,
    params: &RefreshSearchParams,
) -> CommandResult<Vec<ArchiveRecord>> {
    let archives = match fetch_all_search_pages(base_url, api_key, params).await {
        Ok(value) => value,
        Err((code, message, retryable)) => {
            return CommandResult::failure(code, message, retryable)
        }
    };
    let mut connection = match database.connection.lock() {
        Ok(conn) => conn,
        Err(_) => {
            return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true)
        }
    };
    // Tombstoning happens once, after every page is in hand: doing it per page
    // would mark the rest of the library deleted between requests.
    match replace_server_archives(&mut connection, server_id, &archives) {
        Ok(records) => {
            // A complete walk is the one moment the whole index is known to be
            // current, so it is also the cheapest moment to clean out the records
            // that point at archives the walk did not find — no per-id request, and
            // it covers ids a shelf visit never got round to verifying.
            let _ = prune_dangling_records_for_server(&mut connection, server_id);
            CommandResult::success(records)
        }
        Err(error) => CommandResult::failure("LOCAL_DATABASE", error, true),
    }
}

/// Dedup must enumerate an authoritative, unfiltered directory, never the
/// partial mirror populated by the library's server-side pages.
pub(crate) async fn refresh_dedup_archive_index(
    server_id: &str,
    database: &Database,
) -> CommandResult<()> {
    let input = RefreshArchivesInput {
        server_id: server_id.into(),
        params: RefreshSearchParams {
            filter: None, start: None, sortby: Some("title".into()), order: Some("asc".into()),
            newonly: Some(false), untaggedonly: Some(false), hidecompleted: Some(false),
            category: None, groupby_tanks: Some(false),
        },
    };
    match refresh_archives_impl(input, database).await {
        Ok(CommandResult::Success { .. }) => CommandResult::success(()),
        Ok(CommandResult::Failure { error, .. }) => CommandResult::Failure { ok: false, error },
        Err(error) => CommandResult::failure("REMOTE_UNAVAILABLE", error, true),
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
        Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
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
                crate::cache::LOCK_FAILED.to_string(),
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
                crate::cache::LOCK_FAILED.to_string(),
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
        Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
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
                crate::cache::LOCK_FAILED.to_string(),
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
    // `authorization_value` 只发一个 `Authorization: Bearer base64(key)` 头，别的什么都
    // 不带，所以 LANraragi 回 431 Request Header Fields Too Large 只可能是 Key 本身太长
    // ——用户把一整段文本当 Key 粘了进来。512 是宽松到不可能误伤真实 Key 的上限
    // （LANraragi 的 Key 是几十字符），在这里挡住比让请求带着一个几 KB 的头打出去好：
    // 431 的文案对用户毫无意义。
    let api_key_length = api_key.chars().count();
    if api_key_length > MAX_API_KEY_CHARS {
        return CommandResult::failure(
            "INVALID_API_KEY",
            format!("API Key 太长（{api_key_length} 字符），看起来不像一个 API Key"),
            false,
        );
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
    // 服务器条目**不进同步日志**：地址与启用状态属于「本机怎么连上它」，而 API Key
    // 在系统凭据库里按设备各存各的——条目本身在别的设备上不成立（没有 Key 就是一
    // 行连不上的服务器），所以它和凭据归同一类，不上远端。
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

/// The server list in the order the command layer hands it out: the enabled one
/// first, then by name. `delete_server` returns the same list so the frontend can
/// replace its state wholesale.
fn read_servers(connection: &Connection) -> CommandResult<Vec<ServerRecord>> {
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

/// Removes one `servers` row and hands back the scope id the credential was
/// stored under (keyring account = scope id, not the row id).
///
/// Only the row goes. `archives` — and through it `pages` and
/// `archive_categories` — carries `ON DELETE CASCADE` against `servers(id)`, and
/// `servers.id` *is* the scope id, so a plain DELETE would take the whole local
/// index with it. Archives, reading progress and reading history are keyed by
/// that scope id and stay on this device on purpose: re-adding a server at the
/// same address derives the same scope id and reconnects them. `delete_server`
/// therefore suspends the foreign keys around this call.
fn delete_server_row(connection: &mut Connection, server_id: &str) -> CommandResult<String> {
    let transaction = match connection.transaction() {
        Ok(transaction) => transaction,
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    let scope_id: String = match transaction
        .query_row(
            "SELECT scope_id FROM servers WHERE id = ?1",
            params![server_id],
            |row| row.get(0),
        )
        .optional()
    {
        Ok(Some(scope_id)) => scope_id,
        Ok(None) => return CommandResult::failure("NOT_FOUND", "服务器不存在", false),
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    if let Err(error) = transaction.execute("DELETE FROM servers WHERE id = ?1", params![server_id]) {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    if let Err(error) = transaction.commit() {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    CommandResult::success(scope_id)
}

/// Deletes a server configuration: its row, its stored credential, and nothing
/// else. When the removed server was the enabled one and others remain, the
/// first remaining server takes over as the data source instead of leaving the
/// app silently without one. Returns the fresh list, exactly like `list_servers`.
pub fn delete_server_record(
    connection: &mut Connection,
    server_id: &str,
    forget_credential: impl FnOnce(&str),
) -> CommandResult<Vec<ServerRecord>> {
    // 外键是连接级的开关，删除期间挂起、随后立刻装回去；这两步与删除共用
    // `database.connection` 的那把锁，别的语句插不进来。
    if let Err(error) = connection.execute_batch("PRAGMA foreign_keys = OFF") {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    let deleted = delete_server_row(connection, server_id);
    // 不论删成没删成都要装回去：漏掉它，之后所有删除都会失去级联。
    if let Err(error) = connection.execute_batch("PRAGMA foreign_keys = ON") {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    let scope_id = match deleted {
        CommandResult::Success { value, .. } => value,
        CommandResult::Failure { error, .. } => {
            return CommandResult::failure(error.code, error.message, error.retryable)
        }
    };
    forget_credential(&scope_id);
    // 删掉的若是当前启用的那台，而还有别的服务器，就立刻启用第一台：否则首页、书架与
    // 档案库会停在「没有数据源」上，界面上再没有东西能把它救回来。这里直接走
    // `set_server_enabled_record`，与手动切换共用同一套不变量。
    let enabled_count: i64 = match connection.query_row(
        "SELECT COUNT(*) FROM servers WHERE enabled = 1",
        [],
        |row| row.get(0),
    ) {
        Ok(count) => count,
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    if enabled_count == 0 {
        let next_id: Option<String> = match connection
            .query_row(
                "SELECT id FROM servers ORDER BY name COLLATE NOCASE, id LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
        {
            Ok(next_id) => next_id,
            Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
        };
        if let Some(next_id) = next_id {
            if let CommandResult::Failure { error, .. } =
                set_server_enabled_record(connection, &next_id, true)
            {
                return CommandResult::failure(error.code, error.message, error.retryable);
            }
        }
    }
    read_servers(connection)
}

#[tauri::command(async)]
pub fn set_server_enabled(
    server_id: String,
    enabled: bool,
    database: State<'_, Database>,
) -> CommandResult<ServerRecord> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
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
                error.code,
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
                crate::cache::LOCK_FAILED,
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
#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn list_servers(database: State<'_, Database>) -> CommandResult<Vec<ServerRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    read_servers(&connection)
}

/// 删除一台服务器的配置（连接信息与凭据）。档案馆藏、阅读进度与阅读记录按 scope id
/// 留在本机，重新添加同一地址即可接回（见 `delete_server_record`）。
#[tauri::command(async)]
pub fn delete_server(
    server_id: String,
    database: State<'_, Database>,
) -> CommandResult<Vec<ServerRecord>> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    delete_server_record(&mut connection, &server_id, |scope_id| {
        // 凭据条目挂在 scope id 上。删不到（本来就没存过）不算失败：目标状态是「没有
        // 这条凭据」，而 secret_store 对缺失条目一律报错（系统凭据库与文件存储都一样）。
        let _ = crate::secret_store::delete_secret(KEYRING_SERVICE, scope_id);
    })
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
                    crate::cache::LOCK_FAILED,
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

#[tauri::command(async)]
pub fn list_archives(
    server_id: String,
    database: State<'_, Database>,
) -> CommandResult<Vec<ArchiveRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match query_archive_records(&connection, &server_id) {
        Ok(archives) => CommandResult::success(archives),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveIdentity {
    pub archive_id: String,
    pub title: String,
    pub tags: Vec<String>,
    pub page_count: Option<i64>,
    pub file_size: Option<i64>,
    pub added_at: Option<i64>,
}

/// 查重页只读身份与卡片展示字段（含添加时间）。整库返回全字段记录
/// 会让序列化体积和前端的逐条 zod 校验跟着不相关的字段一起涨。
#[tauri::command(async)]
pub fn list_archive_identities(
    server_id: String,
    database: State<'_, Database>,
) -> CommandResult<Vec<ArchiveIdentity>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match query_archive_identities(&connection, &server_id) {
        Ok(identities) => CommandResult::success(identities),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

fn query_archive_identities(connection: &Connection, server_id: &str) -> Result<Vec<ArchiveIdentity>, String> {
    let mut statement = connection.prepare(
        "SELECT archive_id, title, tags_json, page_count, file_size, COALESCE(added_at, first_seen_at)
         FROM archives WHERE server_id = ?1 AND is_deleted = 0",
    )
    .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([server_id], |row| {
            let tags = archive_tags(row.get::<_, String>(2)?);
            Ok(ArchiveIdentity {
                archive_id: row.get(0)?,
                title: row.get(1)?,
                page_count: row.get(3)?,
                file_size: row.get(4)?,
                added_at: row.get::<_, Option<i64>>(5)?.or_else(|| archive_added_at(&tags)),
                tags,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn list_archives_page(
    input: ArchiveQueryInput,
    database: State<'_, Database>,
) -> CommandResult<ArchivePage> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match query_archive_page(&connection, &input) {
        Ok(page) => CommandResult::success(page),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

/// The shelves (home, history, favourites, to-read) hold a handful of archive
/// ids and need the records behind them. Reading the whole library to resolve
/// fourteen titles scaled with the library instead of with the shelf.
#[tauri::command(async)]
pub fn list_archives_by_ids(
    server_id: String,
    archive_ids: Vec<String>,
    database: State<'_, Database>,
) -> CommandResult<Vec<ArchiveRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match query_archive_records_by_ids(&connection, &server_id, &archive_ids) {
        Ok(archives) => CommandResult::success(archives),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

/// How many ids one verification pass will check. The shelves show a handful of
/// cards; a cap keeps a long history from turning into a request storm.
const VERIFY_ARCHIVE_LIMIT: usize = 64;

/// Confirms that archives the local mirror is about to show still exist on the
/// server, tombstoning the ones that do not, and answers with those ids.
///
/// The mirror only learns about a deletion when a full refresh runs or when
/// something opens the archive and gets a 404. Since the library list moved to
/// server-side paging, nothing refreshes the mirror on its own, so the shelves
/// (history, favourites, to-read, the home rails) kept offering archives that
/// were gone — the user found out by clicking one.
///
/// Requests run eight at a time (the probes are independent reads; serialized
/// probes paid one full RTT each) and only a definite 400/404 counts: a timeout
/// or a server error must never tombstone an archive that is merely unreachable.
/// Tombstone writes happen after the probes finish, so no database lock is held
/// across a network await.
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
    let ids: Vec<String> = archive_ids
        .iter()
        .take(VERIFY_ARCHIVE_LIMIT)
        .cloned()
        .collect();
    let mut tombstones = Vec::new();
    for chunk in ids.chunks(8) {
        let mut probes = JoinSet::new();
        for archive_id in chunk {
            let url = format!(
                "{}/api/archives/{}/metadata",
                base_url.trim_end_matches('/'),
                archive_id
            );
            let api_key = api_key.clone();
            let archive_id = archive_id.clone();
            probes.spawn(async move {
                match reader_request(reqwest::Method::GET, url, api_key).await {
                    Ok(response) => {
                        let status = response.status();
                        if matches!(
                            status,
                            reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::NOT_FOUND
                        ) {
                            Some((archive_id, status))
                        } else {
                            None
                        }
                    }
                    // Unreachable is not deleted.
                    Err(_) => None,
                }
            });
        }
        while let Some(probe) = probes.join_next().await {
            if let Ok(Some((archive_id, status))) = probe {
                tombstones.push((archive_id, status));
            }
        }
    }
    let mut missing = Vec::new();
    for (archive_id, status) in tombstones {
        let tombstoned = database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.to_string())
            .and_then(|connection| {
                reconcile_missing_archive_status(&connection, &server_id, &archive_id, status)
            });
        match tombstoned {
            Ok(_) => missing.push(archive_id),
            Err(error) => return Ok(CommandResult::failure("UNKNOWN", error, true)),
        }
    }
    if !missing.is_empty() {
        // The records that pointed at them are what the user actually sees: a
        // shelf card that only fails once it has been opened. Acting here is what
        // makes the cleanup prompt — no second round trip, and the local index was
        // just told these are gone.
        if let Ok(mut connection) = database.connection.lock() {
            let _ = prune_dangling_records_for_server(&mut connection, &server_id);
        }
    }
    Ok(CommandResult::success(missing))
}

/// async：翻一页写一次进度，还带着日志写入与 MAX(logical_clock) 查询，
/// 不许占主线程。
#[tauri::command(async)]
pub fn save_reading_progress(
    app: tauri::AppHandle,
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
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    let record = match persist_reading_progress(&mut connection, progress) {
        Ok(record) => record,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    // 本地这一笔已经落盘、也已经进同步日志了。下面只是顺手把它打到服务器上——
    // 成不成功都不改变上面那个结果，失败也只进错误日志（见 `spawn_progress_push`）。
    let base_url = progress_push_base_url(&connection, &record.scope_id);
    drop(connection);
    if let Some(base_url) = base_url {
        // 钥匙串不要一边握着库锁一边去读。
        if let Some(api_key) = usable_api_key(
            &SystemCredentialStore
                .get_server_api_key(&record.scope_id)
                .unwrap_or_default(),
        ) {
            let key = format!("{}\u{0}{}", record.scope_id, record.archive_id);
            let start = progress_push_state()
                .lock()
                .map(|mut state| state.submit(&key, record.page_index))
                .unwrap_or(false);
            if start {
                spawn_progress_push(
                    app,
                    base_url,
                    api_key,
                    record.archive_id.clone(),
                    record.page_index,
                    key,
                );
            }
        }
    }
    CommandResult::success(record)
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
          page_index = CASE WHEN ?9 THEN excluded.page_index ELSE MAX(reading_progress.page_index, excluded.page_index) END,
          page_count = excluded.page_count, layout = excluded.layout,
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
            device_id,
            progress.allow_progress_regression,
        ],
    ) {
        return Err(error.to_string());
    }
    transaction.execute(
        "UPDATE reading_progress SET revision = MAX(revision, COALESCE((SELECT MAX(logical_clock) + 1 FROM sync_journal WHERE scope_id=?1 AND object_id=?1 || '/' || ?2 AND object_type='reading_progress'), 1)) WHERE scope_id=?1 AND archive_id=?2",
        params![progress.scope_id, progress.archive_id],
    ).map_err(|error| error.to_string())?;
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
           page_index = excluded.page_index,
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
    transaction.execute(
        "UPDATE reading_history SET revision = MAX(revision, COALESCE((SELECT MAX(logical_clock) + 1 FROM sync_journal WHERE scope_id=?1 AND object_id=?1 || '/' || ?2 AND object_type='history'), 1)) WHERE scope_id=?1 AND archive_id=?2",
        params![record.scope_id, record.archive_id],
    ).map_err(|error| error.to_string())?;
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
    // 同一套判据也供同步/导入在批末对账用（sync::reconcile_progress_completion）：
    // 「本地读到这一页」和「远端同步进来这一页」对「看完没看完」只能有一个口径。
    if progress_finishes_archive(record.page_index, record.page_count) {
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
    // 收藏夹不写同步日志：它镜像的是 LRR 服务器上的收藏分类，服务器才是它的真相
    // 来源，本机这行只是那份镜像的落点。把它推给别的设备等于在两边各造一份本地记录，
    // 而服务器上的分类才是该看的那份（见 sync.rs 的 object_type_category）。
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

/// 「这一页算看完了」的唯一定义：严格超过 90% 才移出待看，正好 90% 不算。
/// 页序是 0 起的，所以口径是「已读到第 page_index + 1 页」。
/// 本地写进度（`persist_reading_progress`）与同步/导入批末的对账都调这一份，
/// 不要在第二个地方再手写一次比较。
pub(crate) fn progress_finishes_archive(page_index: i64, page_count: i64) -> bool {
    page_count > 0 && (i128::from(page_index) + 1) * 10 > i128::from(page_count) * 9
}

pub(crate) fn write_reading_list_entry(
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
#[tauri::command(async)]
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
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match write_search_preset(&mut connection, &input) {
        Ok(record) => CommandResult::success(record),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command(async)]
pub fn delete_search_preset(
    scope_id: String,
    preset_id: String,
    database: State<'_, Database>,
) -> CommandResult<SearchPresetRecord> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
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

#[tauri::command(async)]
pub fn list_search_presets(
    scope_id: String,
    database: State<'_, Database>,
) -> CommandResult<Vec<SearchPresetRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
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

#[tauri::command(async)]
pub fn set_reading_list(
    scope_id: String,
    archive_id: String,
    added: bool,
    database: State<'_, Database>,
) -> CommandResult<WatchlistRecord> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match set_reading_list_entry(&mut connection, &scope_id, &archive_id, added) {
        Ok(record) => CommandResult::success(record),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMembershipStatus {
    pub reading: bool,
    pub favorites: bool,
}

/// 右键菜单要的两个布尔（在待看？在收藏？）。原先为了它们把整个待看列表
/// 和整个收藏列表都拉过来——数据量跟着库走，而两个 PK 点查就够。
#[tauri::command(async)]
pub fn get_archive_membership(
    scope_id: String,
    archive_id: String,
    database: State<'_, Database>,
) -> CommandResult<ArchiveMembershipStatus> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    let probe = |table: &str| -> Result<bool, String> {
        connection
            .query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM {table} WHERE scope_id = ?1 AND archive_id = ?2 AND deleted_at IS NULL)"
                ),
                params![scope_id, archive_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|flag| flag != 0)
            .map_err(|error| error.to_string())
    };
    let result = (|| -> Result<ArchiveMembershipStatus, String> {
        Ok(ArchiveMembershipStatus {
            reading: probe("reading_list")?,
            favorites: probe("watchlist")?,
        })
    })();
    match result {
        Ok(status) => CommandResult::success(status),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command(async)]
pub fn list_reading_list(
    scope_id: String,
    database: State<'_, Database>,
) -> CommandResult<Vec<WatchlistRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
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

#[tauri::command(async)]
pub fn set_watchlist(
    scope_id: String,
    archive_id: String,
    added: bool,
    database: State<'_, Database>,
) -> CommandResult<WatchlistRecord> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match set_watchlist_entry(&mut connection, &scope_id, &archive_id, added) {
        Ok(record) => CommandResult::success(record),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

#[tauri::command(async)]
pub fn list_watchlist(
    scope_id: String,
    database: State<'_, Database>,
) -> CommandResult<Vec<WatchlistRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
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

/// 历史自动清理：读完的留 3 个月，没读完的留 1 年。
///
/// 历史表是「每部档案一条」，不清理就会一直长：翻过的每一部都留着。读完的判断与
/// 界面一致（`isArchiveFinished`：已读页数超过总页数的 95%），页数取自进度行；
/// 没有进度行的历史（例如导入的）按没读完算，留得更久。
pub(crate) const HISTORY_RETENTION_FINISHED_DAYS: i64 = 90;
pub(crate) const HISTORY_RETENTION_UNFINISHED_DAYS: i64 = 365;
const DAY_MILLIS: i64 = 24 * 60 * 60 * 1000;

fn history_is_finished(page_index: i64, page_count: Option<i64>) -> bool {
    match page_count {
        // 与前端同一条式子，整数比较免去浮点误差。
        Some(count) if count > 0 => (i128::from(page_index) + 1) * 100 > i128::from(count) * 95,
        _ => false,
    }
}

/// 删掉过期历史，并为每条写一个同步墓碑：别的设备下一次同步就跟着删，不会被它们
/// 那份文档再带回来。时间解析不了的行一律保留——清理宁可少删。
pub(crate) fn prune_reading_history(
    connection: &mut Connection,
    now_millis: i64,
) -> Result<usize, String> {
    let candidates: Vec<(String, String, String, i64, Option<i64>)> = {
        let mut statement = connection
            .prepare(
                "SELECT h.scope_id, h.archive_id, h.visited_at, h.page_index, p.page_count
                 FROM reading_history h
                 LEFT JOIN reading_progress p
                   ON p.scope_id = h.scope_id AND p.archive_id = h.archive_id",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let doomed = candidates
        .into_iter()
        .filter_map(|(scope_id, archive_id, visited_at, page_index, page_count)| {
            let visited = super::sync::instant_millis(&visited_at)?;
            let days = if history_is_finished(page_index, page_count) {
                HISTORY_RETENTION_FINISHED_DAYS
            } else {
                HISTORY_RETENTION_UNFINISHED_DAYS
            };
            (visited <= now_millis - days * DAY_MILLIS).then_some((scope_id, archive_id))
        })
        .collect::<Vec<_>>();
    if doomed.is_empty() {
        return Ok(0);
    }
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for (scope_id, archive_id) in &doomed {
        transaction
            .execute(
                "DELETE FROM reading_history WHERE scope_id = ?1 AND archive_id = ?2",
                params![scope_id, archive_id],
            )
            .map_err(|error| error.to_string())?;
        let object_id = format!("{scope_id}/{archive_id}");
        let clock: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(logical_clock), 0) + 1 FROM sync_journal
                 WHERE scope_id = ?1 AND object_id = ?2",
                params![scope_id, object_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        super::sync::journal_object(
            &transaction,
            scope_id,
            "history",
            &object_id,
            clock,
            serde_json::json!({ "archiveId": archive_id, "deleted": true }),
        )?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(doomed.len())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 删掉选中的历史记录，每条写一个同步墓碑：别的设备下一次同步就跟着删。
///
/// 与保留期清理（`prune_reading_history`）走同一条路：历史记录属于本机与其它设备的
/// 共同事实，删掉一条就必须留墓碑，否则对面的文档会把它带回来。清理的是**记录**，
/// 不是档案——档案本体与进度都不动。
pub(crate) fn delete_history_records_in(
    connection: &mut Connection,
    scope_id: &str,
    archive_ids: &[String],
) -> Result<usize, String> {
    if archive_ids.is_empty() {
        return Ok(0);
    }
    let mut removed = 0usize;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for archive_id in archive_ids {
        let deleted = transaction
            .execute(
                "DELETE FROM reading_history WHERE scope_id = ?1 AND archive_id = ?2",
                params![scope_id, archive_id],
            )
            .map_err(|error| error.to_string())?;
        if deleted == 0 {
            continue;
        }
        removed += deleted;
        let object_id = format!("{scope_id}/{archive_id}");
        let clock: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(logical_clock), 0) + 1 FROM sync_journal
                 WHERE scope_id = ?1 AND object_id = ?2",
                params![scope_id, object_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        super::sync::journal_object(
            &transaction,
            scope_id,
            "history",
            &object_id,
            clock,
            serde_json::json!({ "archiveId": archive_id, "deleted": true }),
        )?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(removed)
}

#[tauri::command(async)]
pub fn delete_history_records(
    scope_id: String,
    archive_ids: Vec<String>,
    database: State<'_, Database>,
) -> CommandResult<usize> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match delete_history_records_in(&mut connection, &scope_id, &archive_ids) {
        Ok(removed) => CommandResult::success(removed),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

/// Explicit reading reset; history-only deletion intentionally keeps progress.
pub(crate) fn clear_reading_progress_in(
    connection: &mut Connection,
    scope_id: &str,
    archive_id: &str,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let object_id = format!("{scope_id}/{archive_id}");
    // Both tombstones belong to this one transaction, including progress-only records.
    for (table, kind) in [
        ("reading_progress", "reading_progress"),
        ("reading_history", "history"),
    ] {
        let clock: i64 = transaction.query_row(
            &format!("SELECT MAX(COALESCE((SELECT MAX(logical_clock) FROM sync_journal WHERE scope_id=?1 AND object_id=?2), 0), COALESCE((SELECT revision FROM {table} WHERE scope_id=?1 AND archive_id=?3), 0)) + 1"),
            params![scope_id, object_id, archive_id], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        transaction
            .execute(
                &format!("DELETE FROM {table} WHERE scope_id=?1 AND archive_id=?2"),
                params![scope_id, archive_id],
            )
            .map_err(|error| error.to_string())?;
        super::sync::journal_object(
            &transaction,
            scope_id,
            kind,
            &object_id,
            clock,
            serde_json::json!({ "archiveId": archive_id, "deleted": true, "clearProgress": true }),
        )?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn clear_reading_progress(
    scope_id: String,
    archive_id: String,
    database: State<'_, Database>,
) -> CommandResult<()> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match clear_reading_progress_in(&mut connection, &scope_id, &archive_id) {
        Ok(()) => CommandResult::success(()),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

/// 历史自动清理的入口：启动后的巡检与设置里的「立即清理」都走它。
#[tauri::command(async)]
pub fn prune_history(database: State<'_, Database>) -> CommandResult<usize> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match prune_reading_history(&mut connection, now_millis()) {
        Ok(removed) => CommandResult::success(removed),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}

/// 清理指向已不在 LANraragi 的档案的记录，各自删掉了几条。
#[derive(Default, serde::Serialize)]
pub struct PrunedRecords {
    pub history: usize,
    pub reading_list: usize,
    pub watchlist: usize,
}

/// 一张记录表，以及它在同步日志里的对象类型。`None` 是「这张表不进同步」——收藏夹
/// 镜像的是服务器上的收藏分类，本机这份只是镜像的落点，所以清掉它时不留墓碑：留一条
/// 就意味着别的设备要跟着删，而它本来就没有别的设备那一份。这里写错类型的代价是实打
/// 实的：曾经 `("watchlist", "watchlist")` 写的是**待看**的对象类型，于是清掉一条
/// 收藏夹记录，别的设备上被删掉的是待看里同 id 的那条。
const DANGLING_RECORD_TABLES: [(&str, Option<&str>); 3] = [
    ("reading_history", Some("history")),
    ("reading_list", Some("watchlist")),
    ("watchlist", None),
];

/// 删掉指向「已确认不在 LANraragi」的档案的历史、待看与收藏夹记录。
///
/// 这三张表都是本地镜像的延伸：档案在 LRR 被删掉之后记录还留着，于是书架上会留下
/// 一张点进去才知道失效的卡。判据只有一条——**本地索引里那行存在，且 `is_deleted = 1`**。
/// 索引里根本没有这行时不动：那多半只是还没被索引（导入进来的记录正是这样），
/// 「没索引到」不是「被删了」的证据，清理宁可少删。
///
/// 索引只会在拿到确定答案时标记删除：`verify_archives_exist` 认的是 400/404，
/// `refresh_archives` 认的是成功走完整個库之后的缺席。所以这里不会因为一次网络抖动
/// 而删掉记录。
///
/// 删除与墓碑写在同一个事务里（与历史保留期清理同一条路径），别的设备下次同步就跟着
/// 删，而不是把它们那份文档再带回来。
fn prune_dangling_records_for_server(
    connection: &mut Connection,
    server_id: &str,
) -> Result<PrunedRecords, String> {
    let scope_id: String = connection
        .query_row(
            "SELECT scope_id FROM servers WHERE id = ?1",
            [server_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let mut pruned = PrunedRecords::default();
    let prune_table = |connection: &mut Connection,
                       table: &str,
                       object_type: Option<&str>|
     -> Result<usize, String> {
        let doomed: Vec<String> = {
            let mut statement = connection
                .prepare(&format!(
                    "SELECT r.archive_id FROM {table} r
                     JOIN archives a ON a.server_id = ?2 AND a.archive_id = r.archive_id
                     WHERE r.scope_id = ?1 AND a.is_deleted = 1"
                ))
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![scope_id, server_id], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<String>, _>>()
                .map_err(|error| error.to_string())?
        };
        if doomed.is_empty() {
            return Ok(0);
        }
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        for archive_id in &doomed {
            transaction
                .execute(
                    &format!("DELETE FROM {table} WHERE scope_id = ?1 AND archive_id = ?2"),
                    params![scope_id, archive_id],
                )
                .map_err(|error| error.to_string())?;
            // 不进同步的表删掉就走：留一条墓碑等于告诉别的设备「这条没了」，而它们
            // 本来就没有这一份（收藏夹的真相在服务器上）。
            let Some(object_type) = object_type else { continue };
            let object_id = format!("{scope_id}/{archive_id}");
            let clock: i64 = transaction
                .query_row(
                    "SELECT COALESCE(MAX(logical_clock), 0) + 1 FROM sync_journal
                     WHERE scope_id = ?1 AND object_id = ?2",
                    params![scope_id, object_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            super::sync::journal_object(
                &transaction,
                &scope_id,
                object_type,
                &object_id,
                clock,
                serde_json::json!({ "archiveId": archive_id, "deleted": true }),
            )?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(doomed.len())
    };
    for (table, object_type) in DANGLING_RECORD_TABLES {
        let removed = prune_table(connection, table, object_type)?;
        match table {
            "reading_history" => pruned.history = removed,
            "reading_list" => pruned.reading_list = removed,
            _ => pruned.watchlist = removed,
        }
    }
    Ok(pruned)
}

/// 手动清理一次失效记录。
///
/// 正常路径用不着它：`verify_archives_exist` 与 `refresh_archives` 各自在拿到确定
/// 答案之后顺手清理。留着它是为了让「清理」这件事本身可以被测试和手动触发。
#[tauri::command(async)]
pub fn prune_dangling_records(
    server_id: String,
    database: State<'_, Database>,
) -> CommandResult<PrunedRecords> {
    let mut connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match prune_dangling_records_for_server(&mut connection, &server_id) {
        Ok(pruned) => CommandResult::success(pruned),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
}


#[tauri::command(async)]
pub fn list_reading_history(
    scope_id: String,
    database: State<'_, Database>,
) -> CommandResult<Vec<ReadingHistoryRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    let result = (|| -> Result<Vec<ReadingHistoryRecord>, String> {
        let mut statement = connection
            .prepare(
                "SELECT h.scope_id, h.archive_id, COALESCE(p.page_index, h.page_index),
                        h.visited_at, h.device_id, h.revision
                 FROM reading_history h
                 LEFT JOIN reading_progress p ON p.scope_id = h.scope_id AND p.archive_id = h.archive_id
                 WHERE h.scope_id = ?1 ORDER BY h.visited_at DESC",
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

#[tauri::command(async)]
pub fn load_reading_progress(
    scope_id: String,
    archive_id: String,
    database: State<'_, Database>,
) -> CommandResult<Option<ReadingProgressRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
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

#[tauri::command(async)]
pub fn create_task(task: TaskInput, database: State<'_, Database>) -> CommandResult<TaskRecord> {
    if !matches!(
        task.kind.as_str(),
        "download" | "sync" | "inference" | "maintenance"
    ) || task.label.trim().is_empty()
    {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid task", false);
    }
    let id = new_task_id();
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    let result = connection.execute(
        "INSERT INTO tasks (id, kind, label, status, progress) VALUES (?1, ?2, ?3, 'queued', 0)",
        params![id, task.kind, task.label.trim()],
    );
    if let Err(error) = result {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    match connection.query_row(
        &format!("SELECT {TASK_COLUMNS} FROM tasks WHERE id=?1"),
        params![id],
        read_task_row,
    ) {
        Ok(record) => CommandResult::success(record),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

fn query_tasks(connection: &rusqlite::Connection) -> Result<Vec<TaskRecord>, String> {
    let mut statement = connection
        .prepare(&format!("SELECT {TASK_COLUMNS} FROM tasks ORDER BY updated_at DESC"))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], read_task_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn list_tasks(database: State<'_, Database>) -> CommandResult<Vec<TaskRecord>> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
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

#[tauri::command(async)]
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
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
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

#[tauri::command(async)]
pub fn retry_task(id: String, database: State<'_, Database>) -> CommandResult<TaskRecord> {
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
                    crate::cache::LOCK_FAILED,
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
    // 整文件读是几百 MB 的阻塞 IO，丢给阻塞线程池：不该让 async 运行时
    // 的工作线程（也不该让主线程）陪着读盘。
    let read_path = path.clone();
    let bytes = match tauri::async_runtime::spawn_blocking(move || std::fs::read(&read_path)).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => {
            return Ok(CommandResult::failure(
                "LRR_NOT_FOUND",
                error.to_string(),
                false,
            ))
        }
        Err(error) => {
            return Ok(CommandResult::failure(
                "UNKNOWN",
                error.to_string(),
                false,
            ))
        }
    };
    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename);
    let form = reqwest::multipart::Form::new().part("file", part);
    let response = match lanraragi_client()?
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
    complete_task(&database, &task_id);
    Ok(CommandResult::success(UploadArchiveResult {
        operation: wire.operation,
        success: wire.success,
        id: wire.id,
    }))
}

fn new_task_id() -> String {
    format!(
        "task-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    )
}

fn complete_task(database: &Database, task_id: &str) {
    if let Ok(connection) = database.connection.lock() {
        let _ = connection.execute(
            "UPDATE tasks SET status = 'completed', progress = 1, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![task_id],
        );
    }
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
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
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
            Err(error) => return Ok(CommandResult::failure(error.code, error.message, true)),
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

/// 测试里的 mock 服务器读一个请求头：读到 `\r\n\r\n` 为止（或读满上限、或对端关闭），
/// 返回这一次真的读到多少字节。
///
/// 「读一次就当请求读完了」并不成立：`read` 返回的是这一次读到的长度，请求可能分成
/// 几段到，丢掉这个长度既让 clippy 默认档的 `unused_io_amount` 拦下构建，也让记下来
/// 的请求原文可能只有半截。所以这里按上限与 EOF 两条边界收口，调用方拿到的长度就是
/// 已经落在 buffer 里的字节数。
#[cfg(test)]
pub(crate) async fn read_request_head(
    stream: &mut tokio::net::TcpStream,
    buffer: &mut [u8],
) -> usize {
    use tokio::io::AsyncReadExt;
    /// 请求头不该有这么大：到了上限就停，免得对端不发 `\r\n\r\n` 把我们一直挂着。
    const HEAD_LIMIT: usize = 64 * 1024;
    let limit = buffer.len().min(HEAD_LIMIT);
    let mut total = 0;
    while total < limit {
        let read = stream
            .read(&mut buffer[total..limit])
            .await
            .expect("read request");
        if read == 0 {
            break; // 对端关闭，读到的就是这些
        }
        total += read;
        if buffer[..total]
            .windows(4)
            .any(|window| window == b"\r\n\r\n".as_slice())
        {
            break; // 请求头到齐
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use rusqlite::Connection;

    use super::*;

    /// 用户报的第 ① 条：`pause_download`/`cancel_download` 是拿前端给的任务 id 直接
    /// `set_download_signal` 的，对一个早就不在传输的 id 也会登记一条永不清理的条目。
    /// 登记序因此必须有上限，且是「插入序即淘汰序」。
    #[test]
    fn the_download_signal_table_drops_the_oldest_task_instead_of_growing() {
        let mut signals = DownloadSignals::default();
        for index in 0..(MAX_DOWNLOAD_SIGNALS + 8) {
            let _ = signals.signal(&format!("task-{index}"));
        }
        assert_eq!(signals.by_task.len(), MAX_DOWNLOAD_SIGNALS);
        assert_eq!(signals.order.len(), MAX_DOWNLOAD_SIGNALS);
        assert!(!signals.by_task.contains_key("task-0"));
        assert!(signals.by_task.contains_key(&format!("task-{}", MAX_DOWNLOAD_SIGNALS + 7)));
        // 同一个任务重复取闸不重复占位，也不会被顶成队首。
        let first = signals.signal("task-8");
        let again = signals.signal("task-8");
        assert!(std::sync::Arc::ptr_eq(&first, &again));
        assert_eq!(signals.order.front().map(String::as_str), Some("task-8"));
        // 清理把两个字段一起摘干净（漏掉插入序那条，淘汰就会白走并且表能涨过上限）。
        signals.clear("task-8");
        assert!(!signals.by_task.contains_key("task-8"));
        assert!(!signals.order.iter().any(|id| id == "task-8"));
    }

    async fn test_http_server(
        responses: Vec<(u16, String)>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut requests = 0;
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 8192];
                read_request_head(&mut socket, &mut request).await;
                let (status, body) = &responses[requests.min(responses.len() - 1)];
                requests += 1;
                let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (url, task)
    }

    #[tokio::test]
    async fn reader_body_failures_separate_truncated_transport_from_invalid_content() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 8192];
            read_request_head(&mut stream, &mut request).await;
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort").await.unwrap();
            stream.shutdown().await.unwrap();
        });
        let result = fetch_page_thumbnail(&url, "archive", 1, "key".into(), 0).await.unwrap();
        server.await.unwrap();
        assert!(matches!(&result, CommandResult::Failure { error, .. } if error.code == "NETWORK"), "{result:?}");

        let (url, server) = test_http_server(vec![(200, "not an image".into())]).await;
        let result = fetch_page_thumbnail(&url, "archive", 1, "key".into(), 0).await.unwrap();
        server.abort();
        assert!(matches!(result, CommandResult::Failure { error, .. } if error.code == "INVALID_RESPONSE"));

        let (url, server) = test_http_server(vec![(202, r#"{"job":1}"#.into()), (200, "{broken".into())]).await;
        let result = fetch_page_thumbnail(&url, "archive", 1, "key".into(), 1).await.unwrap();
        server.abort();
        assert!(matches!(result, CommandResult::Failure { error, .. } if error.code == "INVALID_RESPONSE"));
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
    async fn deferred_cover_deadline_still_checks_completion_without_waiting_again() {
        let expired = tokio::time::Instant::now() - std::time::Duration::from_secs(1);
        for (state, succeeds) in [("inactive", false), ("finished", true), ("failed", false)] {
            let (url, server) = test_http_server(vec![(200, format!(r#"{{"state":"{state}"}}"#))]).await;
            let result = tokio::time::timeout(std::time::Duration::from_millis(500),
                wait_for_cover_thumbnail_job(&url, 42, "key", Some(expired))).await.unwrap();
            server.abort();
            assert_eq!(result.is_none(), succeeds);
        }
    }

    #[tokio::test]
    async fn scan_thumbnail_probes_continue_past_queued_generation_in_multiple_chunks() {
        use futures_util::{stream, StreamExt};
        let responses = (0..64).map(|index| {
            if index % 32 == 0 { (202, format!(r#"{{"job":{}}}"#, index + 1)) }
            else { (200, "GIF89a-test-image".into()) }
        }).collect();
        let (url, server) = test_http_server(responses).await;
        let work = async {
            let mut ready = 0;
            let mut queued = 0;
            for _ in 0..2 {
                let jobs = (0..32).map(|_| fetch_cover_thumbnail_deferred(&url, "archive", "key".into()));
                let mut pool = stream::iter(jobs).buffer_unordered(6);
                while let Some(result) = pool.next().await {
                    match result.unwrap() {
                        CommandResult::Success { value: CoverThumbnail::Ready(_), .. } => ready += 1,
                        CommandResult::Success { value: CoverThumbnail::Queued(_), .. } => queued += 1,
                        other => panic!("unexpected probe result: {other:?}"),
                    }
                }
            }
            (ready, queued)
        };
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), work).await;
        server.abort();
        assert_eq!(result.unwrap(), (62, 2));
    }

    #[tokio::test]
    async fn scan_thumbnail_defers_generation_without_polling() {
        let (url, server) = test_http_server(vec![
            (202, r#"{"job":42}"#.into()),
            (200, r#"{"state":"inactive"}"#.into()),
        ]).await;
        let result = tokio::time::timeout(std::time::Duration::from_millis(500),
            fetch_cover_thumbnail_deferred(&url, "archive", "key".into())).await;
        server.abort();
        assert!(matches!(result, Ok(Ok(CommandResult::Success { value: CoverThumbnail::Queued(42), .. }))));
    }

    #[tokio::test]
    async fn cover_thumbnail_rejects_json_and_handles_generation_job() {
        let (url, server) = test_http_server(vec![(200, r#"{"error":"missing"}"#.into())]).await;
        let result = fetch_cover_thumbnail(&url, "archive", "key".into()).await.unwrap();
        server.abort();
        assert!(matches!(result, CommandResult::Failure { error, .. } if error.code == "INVALID_RESPONSE"));

        let image = "GIF89a-test-image";
        let (url, server) = test_http_server(vec![
            (202, r#"{"job":"1"}"#.into()),
            (200, r#"{"state":"finished"}"#.into()),
            (200, image.into()),
        ]).await;
        let result = fetch_cover_thumbnail(&url, "archive", "key".into()).await.unwrap();
        server.abort();
        assert!(matches!(result, CommandResult::Success { value, .. } if value == image.as_bytes()));

        let (url, server) = test_http_server(vec![(503, "busy".into()), (200, image.into())]).await;
        let result = fetch_cover_thumbnail(&url, "archive", "key".into()).await.unwrap();
        server.abort();
        assert!(matches!(result, CommandResult::Success { value, .. } if value == image.as_bytes()));
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
    async fn directory_refresh_is_complete_scoped_and_failure_safe() {
        let connection = migrated_connection();
        connection.execute_batch("INSERT INTO servers (id,name,base_url,scope_id) VALUES
            ('server-a','A','https://example.com','scope-a'), ('server-b','B','https://example.org','scope-b');").unwrap();
        for server in ["server-a","server-b"] {
            for id in ["a","b"] {
                connection.execute("INSERT INTO archives (server_id,archive_id,title,title_sort,tags_json,page_count,is_deleted) VALUES (?1,?2,'Archive','archive','[]',1,0)",params![server,id.repeat(40)]).unwrap();
            }
        }
        let database = Database { connection: Mutex::new(connection) };
        let params: RefreshSearchParams = serde_json::from_str("{}").unwrap();
        for (status,body) in [(503,"busy".to_string()), (200,serde_json::json!({"data":[],"recordsFiltered":2,"recordsTotal":2}).to_string())] {
            let (url,server) = test_http_server(vec![(status,body)]).await;
            assert!(matches!(refresh_archive_index_from_remote(&database,"server-a",&url,"key",&params).await, CommandResult::Failure { .. }));
            server.abort();
            assert_eq!(database.connection.lock().unwrap().query_row("SELECT COUNT(*) FROM archives WHERE is_deleted=0",[],|row|row.get::<_,i64>(0)).unwrap(),4);
        }
        let body = serde_json::json!({"data":[{"arcid":"b".repeat(40),"title":"Current","tags":"","pagecount":9,"size":1}],"recordsFiltered":1,"recordsTotal":1}).to_string();
        let (url,server) = test_http_server(vec![(200,body)]).await;
        assert!(matches!(refresh_archive_index_from_remote(&database,"server-a",&url,"key",&params).await, CommandResult::Success { .. }));
        server.abort();
        let connection = database.connection.lock().unwrap();
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM archives WHERE server_id='server-a' AND is_deleted=0",[],|row|row.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM archives WHERE server_id='server-b' AND is_deleted=0",[],|row|row.get::<_,i64>(0)).unwrap(),2);
    }

    #[tokio::test]
    async fn full_search_fetches_remaining_pages_concurrently_and_preserves_order() {
        use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let server_peak = peak.clone();
        let server = tokio::spawn(async move {
            let mut requests = JoinSet::new();
            for _ in 0..7 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let active = active.clone();
                let peak = server_peak.clone();
                requests.spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        if stream.read(&mut byte).await.unwrap() == 0 { return; }
                        head.push(byte[0]);
                    }
                    let request = String::from_utf8(head).unwrap();
                    let target = request.split_whitespace().nth(1).unwrap();
                    let parsed = url::Url::parse(&format!("http://localhost{target}")).unwrap();
                    let offset: usize = parsed.query_pairs().find(|(key, _)| key == "start").unwrap().1.parse().unwrap();
                    peak.fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                    // Different completion times ensure results must be ordered by offset.
                    tokio::time::sleep(std::time::Duration::from_millis(if offset % 2 == 0 { 35 } else { 15 })).await;
                    let body = serde_json::json!({"data":[{"arcid":format!("{offset:040x}"),"title":format!("Archive {offset}"),"tags":"","pagecount":1,"size":1}],"recordsFiltered":7,"recordsTotal":7}).to_string();
                    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
                    active.fetch_sub(1, Ordering::SeqCst);
                });
            }
            while let Some(result) = requests.join_next().await { result.unwrap(); }
        });
        let params: RefreshSearchParams = serde_json::from_str("{}").unwrap();
        let archives = fetch_all_search_pages(&url, "key", &params).await.unwrap();
        server.await.unwrap();
        assert!(peak.load(Ordering::SeqCst) > 1, "serial page requests stall saved-result loading");
        assert!(peak.load(Ordering::SeqCst) <= 4, "do not flood LANraragi");
        assert_eq!(archives.iter().map(|item| item.archive_id.clone()).collect::<Vec<_>>(),(0..7).map(|offset|format!("{offset:040x}")).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn full_search_rejects_a_premature_empty_page() {
        let body = serde_json::json!({
            "data": [], "recordsFiltered": 2, "recordsTotal": 2,
        }).to_string();
        let (url, server) = test_http_server(vec![(200, body)]).await;
        let params: RefreshSearchParams = serde_json::from_str("{}").unwrap();
        let result = fetch_all_search_pages(&url, "key", &params).await;
        server.abort();
        assert!(result.is_err(), "an incomplete directory must never tombstone live archives");
    }

    #[tokio::test]
    async fn full_search_rejects_repeated_ids_between_pages() {
        let page = serde_json::json!({
            "data": [{ "arcid": "a".repeat(40), "title": "Archive", "tags": "", "pagecount": 1, "size": 1 }],
            "recordsFiltered": 2, "recordsTotal": 2,
        }).to_string();
        let (url, server) = test_http_server(vec![(200, page.clone()), (200, page)]).await;
        let params: RefreshSearchParams = serde_json::from_str("{}").unwrap();
        let result = fetch_all_search_pages(&url, "key", &params).await;
        server.abort();
        assert!(result.is_err(), "a repeated page must never stand in for the missing part of the directory");
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

    #[test]
    fn explicit_reading_reset_is_scoped_atomic_and_reading_can_restart() {
        let mut connection = migrated_connection();
        for scope in ["scope-a", "scope-b"] {
            persist_reading_progress(
                &mut connection,
                ReadingProgressInput {
                    scope_id: scope.into(),
                    archive_id: "archive-a".into(),
                    page_index: 8,
                    page_count: 10,
                    layout: "paged".into(),
                    direction: "ltr".into(),
                    cover_alone: None,
                    allow_progress_regression: true,
                },
            )
            .unwrap();
        }
        // The existing history delete keeps progress, including a first-page record.
        delete_history_records_in(&mut connection, "scope-a", &["archive-a".into()]).unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM reading_progress WHERE scope_id='scope-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        clear_reading_progress_in(&mut connection, "scope-a", "archive-a").unwrap();
        for table in ["reading_progress", "reading_history"] {
            let count: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE scope_id='scope-a'"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 0);
            let other: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE scope_id='scope-b'"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(other, 1);
        }
        let reset_clock: i64 = connection.query_row("SELECT MAX(logical_clock) FROM sync_journal WHERE scope_id='scope-a' AND object_type='reading_progress'", [], |row| row.get(0)).unwrap();
        let restarted = persist_reading_progress(
            &mut connection,
            ReadingProgressInput {
                scope_id: "scope-a".into(),
                archive_id: "archive-a".into(),
                page_index: 0,
                page_count: 10,
                layout: "paged".into(),
                direction: "ltr".into(),
                cover_alone: None,
                allow_progress_regression: false,
            },
        )
        .unwrap();
        assert_eq!(restarted.page_index, 0);
        assert!(restarted.revision > reset_clock);
        // A failing journal write rolls back both deletions.
        connection.execute_batch("CREATE TRIGGER fail_reset BEFORE INSERT ON sync_journal BEGIN SELECT RAISE(ABORT, 'test rollback'); END;").unwrap();
        assert!(clear_reading_progress_in(&mut connection, "scope-a", "archive-a").is_err());
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM reading_progress WHERE scope_id='scope-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
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
            .execute_batch(include_str!("../../migrations/0028_local_archives.sql"))
            .expect("local archives migration");
        connection
            .execute_batch(include_str!(
                "../../migrations/0029_local_archive_metadata.sql"
            ))
            .expect("local archive metadata migration");
        connection
    }

    #[test]
    fn resolved_favorite_metadata_persists_and_preserves_optional_facts() {
        let mut connection = migrated_connection();
        connection.execute("INSERT INTO servers (id,name,base_url,scope_id) VALUES ('scope-a','Home','https://example.com','scope-a')", []).unwrap();
        let wire = ArchiveMetadataWire {
            arcid: "remote-only".into(), title: "Remote favorite".into(), filename: "archive.cbz".into(),
            tags: "artist:sample, date_added:123".into(), summary: Some("Known summary".into()),
            extension: "cbz".into(), progress: 0, pagecount: 12, lastreadtime: 0, size: 1024,
        };
        persist_archive_metadata(&mut connection, "scope-a", &wire).unwrap();
        let records = query_archive_records(&connection, "scope-a").unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].archive_id, "remote-only");
        let wire = ArchiveMetadataWire { summary: None, tags: "artist:sample".into(), ..wire };
        persist_archive_metadata(&mut connection, "scope-a", &wire).unwrap();
        let preserved: (Option<String>, Option<i64>) = connection.query_row(
            "SELECT summary, added_at FROM archives WHERE archive_id='remote-only'", [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(preserved, (Some("Known summary".into()), Some(123)));
        let again = query_archive_records(&connection, "scope-a").unwrap();
        assert_eq!(again.len(), 1);
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
                    allow_progress_regression: true,
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
        let deletes: i64 = connection.query_row("SELECT COUNT(*) FROM sync_journal WHERE object_type='watchlist' AND operation='delete'", [], |row| row.get(0)).unwrap();
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
    fn history_prune_keeps_recent_rows_and_tombstones_the_rest() {
        let mut connection = migrated_connection();
        // 四行历史：读完/没读完 × 超过/没超过各自的保留窗口。时间直接写成偏移，
        // 清理只按 visited_at 与进度判断，不依赖写入顺序。
        let now = now_millis();
        let days_ago = |days: i64| {
            let millis = now - days * DAY_MILLIS;
            let seconds = millis / 1000;
            // SQLite 的 CURRENT_TIMESTAMP 形状：UTC 的 YYYY-MM-DD HH:MM:SS。
            let (year, month, day, hour, minute, second) = epoch_to_parts(seconds);
            format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
        };
        for (archive_id, page_index, page_count, visited_days) in [
            ("finished-old", 99, 100, 100),
            ("finished-recent", 99, 100, 10),
            ("unfinished-old", 3, 100, 200),
            ("unfinished-ancient", 3, 100, 400),
            // 没有进度行的历史（导入的）按没读完算。
            ("orphan-ancient", 1, 0, 400),
        ] {
            connection
                .execute(
                    "INSERT INTO reading_history (scope_id, archive_id, page_index, visited_at, device_id, revision)
                     VALUES ('scope-a', ?1, ?2, ?3, 'device-a', 1)",
                    params![archive_id, page_index, days_ago(visited_days)],
                )
                .unwrap();
            if page_count > 0 {
                connection
                    .execute(
                        "INSERT INTO reading_progress (scope_id, archive_id, page_index, page_count, layout, direction, device_id, revision)
                         VALUES ('scope-a', ?1, ?2, ?3, 'paged', 'ltr', 'device-a', 1)",
                        params![archive_id, page_index, page_count],
                    )
                    .unwrap();
            }
        }

        let removed = prune_reading_history(&mut connection, now).expect("prune");
        assert_eq!(removed, 3);

        let remaining: Vec<String> = {
            let mut statement = connection
                .prepare("SELECT archive_id FROM reading_history ORDER BY archive_id")
                .unwrap();
            let rows = statement.query_map([], |row| row.get(0)).unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(remaining, vec!["finished-recent", "unfinished-old"]);

        // 每条被清掉的都留下一个墓碑，别的设备下一次同步跟着删。
        let tombstones: Vec<(String, String)> = {
            let mut statement = connection
                .prepare(
                    "SELECT object_id, payload_json FROM sync_journal
                     WHERE object_type = 'history' ORDER BY object_id",
                )
                .unwrap();
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(tombstones.len(), 3);
        assert!(tombstones
            .iter()
            .all(|(_, payload)| payload.contains("\"deleted\":true")));
        assert!(tombstones
            .iter()
            .any(|(object_id, _)| object_id == "scope-a/unfinished-ancient"));
        // 时钟取该对象的下一格：墓碑一定压过被删掉的那一版。
        let clocks: Vec<i64> = tombstones
            .iter()
            .map(|(object_id, _)| {
                connection
                    .query_row(
                        "SELECT logical_clock FROM sync_journal WHERE object_id = ?1",
                        params![object_id],
                        |row| row.get(0),
                    )
                    .unwrap()
            })
            .collect();
        assert!(clocks.iter().all(|clock| *clock == 1));
    }

    fn epoch_to_parts(seconds: i64) -> (i64, i64, i64, i64, i64, i64) {
        // 只做测试用的日期分解：从 1970-01-01 起按天推进。
        let days = seconds.div_euclid(86_400);
        let remainder = seconds.rem_euclid(86_400);
        let (hour, minute, second) = (remainder / 3600, (remainder % 3600) / 60, remainder % 60);
        let mut year = 1970;
        let mut remaining = days;
        loop {
            let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
            let length = if leap { 366 } else { 365 };
            if remaining < length {
                break;
            }
            remaining -= length;
            year += 1;
        }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let lengths = [
            31,
            if leap { 29 } else { 28 },
            31,
            30,
            31,
            30,
            31,
            31,
            30,
            31,
            30,
            31,
        ];
        let mut month = 0;
        for (index, length) in lengths.iter().enumerate() {
            if remaining < *length {
                month = index as i64 + 1;
                break;
            }
            remaining -= *length;
        }
        (year, month, remaining + 1, hour, minute, second)
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
                allow_progress_regression: true,
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
    fn reading_history_follows_the_page_last_saved_for_resume() {
        let mut connection = migrated_connection();
        for page_index in [8, 2] {
            persist_reading_progress(&mut connection, ReadingProgressInput {
                scope_id: "scope-a".into(), archive_id: "archive-a".into(),
                page_index, page_count: 10, layout: "paged".into(),
                direction: "ltr".into(), allow_progress_regression: true, cover_alone: None,
            }).expect("save page");
        }
        let (resume, history): (i64, i64) = connection.query_row(
            "SELECT p.page_index, h.page_index FROM reading_progress p JOIN reading_history h
             ON h.scope_id = p.scope_id AND h.archive_id = p.archive_id
             WHERE p.scope_id = 'scope-a' AND p.archive_id = 'archive-a'",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).expect("matching progress");
        assert_eq!((resume, history), (2, 2));
    }

    #[test]
    fn progress_without_regression_keeps_resume_and_history_at_highest_page() {
        let mut connection = migrated_connection();
        for page_index in [8, 2] {
            persist_reading_progress(&mut connection, ReadingProgressInput {
                scope_id: "scope-a".into(), archive_id: "archive-a".into(),
                page_index, page_count: 10, layout: "paged".into(),
                direction: "ltr".into(), allow_progress_regression: false, cover_alone: None,
            }).expect("save page");
        }
        let (resume, history): (i64, i64) = connection.query_row(
            "SELECT p.page_index, h.page_index FROM reading_progress p JOIN reading_history h
             ON h.scope_id = p.scope_id AND h.archive_id = p.archive_id
             WHERE p.scope_id = 'scope-a' AND p.archive_id = 'archive-a'",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).expect("matching progress");
        assert_eq!((resume, history), (8, 8));
    }

    #[test]
    fn favlist_toggle_writes_tombstone_without_journal() {
        // 收藏夹镜像的是 LRR 服务器上的收藏分类，不是本机记录：本地墓碑与 revision 照旧
        // （列表要显示得出来、点掉要消失），但同步日志一笔都不写——它不上路，也不该在
        // 别的设备上凭空多出一份。
        let mut connection = migrated_connection();
        let added = set_watchlist_entry(&mut connection, "scope-a", "archive-a", true)
            .expect("favlist add");
        assert!(!added.deleted);
        let removed = set_watchlist_entry(&mut connection, "scope-a", "archive-a", false)
            .expect("favlist remove");
        assert!(removed.deleted);
        assert_eq!(removed.revision, 2);
        let journal_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_journal WHERE scope_id = 'scope-a' AND object_id = 'scope-a/archive-a'",
                [],
                |row| row.get(0),
            )
            .expect("journal count");
        assert_eq!(journal_count, 0, "收藏夹不进同步日志");
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

    /// 用户在服务器对话框里贴了一整段文本当 API Key，LANraragi 回的 `431 Request Header
    /// Fields Too Large` 就是这么来的（原生侧只发一个 `Authorization: Bearer base64(key)`
    /// 头，见 `authorization_value`）。超长必须在 `save_server_record`——「什么算一台合法
    /// 的服务器」的唯一校验点——就被挡住，不能既没落库、又让请求带着几 KB 的头打出去。
    #[test]
    fn an_over_long_api_key_is_rejected_before_it_reaches_the_vault() {
        let mut connection = migrated_connection();
        let credentials = MemoryCredentialStore {
            writes: Mutex::new(Vec::new()),
            failure: None,
        };

        let result = save_server_record(
            &mut connection,
            &credentials,
            server_input(),
            "k".repeat(MAX_API_KEY_CHARS + 1),
        );

        match result {
            CommandResult::Failure { error, .. } => {
                assert_eq!(error.code, "INVALID_API_KEY");
                assert!(
                    error.message.contains(&(MAX_API_KEY_CHARS + 1).to_string())
                        && error.message.contains("API Key 太长"),
                    "文案要说清太长了多少：{}",
                    error.message
                );
            }
            other => panic!("超长 Key 必须被拒：{other:?}"),
        }
        assert!(
            credentials.writes.lock().expect("credential writes").is_empty(),
            "被拒的 Key 不许先进凭据库"
        );
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM servers", [], |row| row.get(0))
            .expect("server count");
        assert_eq!(count, 0, "被拒的服务器不许落库");
    }

    /// 边界：上限本身是**收**的（判据是 `> 512`）。
    #[test]
    fn an_api_key_at_the_limit_is_still_accepted() {
        let mut connection = migrated_connection();
        let credentials = MemoryCredentialStore {
            writes: Mutex::new(Vec::new()),
            failure: None,
        };

        let result = save_server_record(
            &mut connection,
            &credentials,
            server_input(),
            "k".repeat(MAX_API_KEY_CHARS),
        );

        assert!(
            matches!(result, CommandResult::Success { .. }),
            "正好到上限的 Key 不该被拒：{result:?}"
        );
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
    fn deleting_a_server_removes_its_row_and_credential_and_returns_the_rest() {
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

        // 藏档、阅读进度与阅读记录按 scope id 留在本机：删除配置只是一句「怎么连上它」，
        // 它们必须活下来，之后用同一地址重新添加会算出同一个 scope id，自己接回去。
        connection
            .execute(
                "INSERT INTO archives (server_id, archive_id, title) VALUES ('scope-b', 'arc-1', 'Archive')",
                [],
            )
            .expect("archive row");
        connection
            .execute(
                "INSERT INTO reading_progress (scope_id, archive_id, page_index, page_count, layout, direction)
                 VALUES ('scope-b', 'arc-1', 3, 12, 'paged', 'ltr')",
                [],
            )
            .expect("progress row");
        connection
            .execute(
                "INSERT INTO reading_history (scope_id, archive_id, page_index, device_id)
                 VALUES ('scope-b', 'arc-1', 3, 'device-1')",
                [],
            )
            .expect("history row");

        let forgotten = Mutex::new(Vec::new());
        let remaining = match delete_server_record(&mut connection, "scope-b", |scope_id| {
            forgotten
                .lock()
                .expect("forgotten lock")
                .push(scope_id.to_string());
        }) {
            CommandResult::Success { value, .. } => value,
            CommandResult::Failure { error, .. } => panic!("delete: {}", error.message),
        };

        assert_eq!(
            forgotten.lock().expect("forgotten lock").as_slice(),
            ["scope-b".to_string()],
            "the credential is stored under the scope id"
        );
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "scope-a");
        assert!(remaining[0].enabled, "the untouched server keeps the data source");
        assert_eq!(
            enabled_flags(&connection),
            vec![("scope-a".to_string(), 1)]
        );

        for (table, query) in [
            ("archives", "SELECT COUNT(*) FROM archives WHERE server_id = 'scope-b'"),
            ("reading_progress", "SELECT COUNT(*) FROM reading_progress WHERE scope_id = 'scope-b'"),
            ("reading_history", "SELECT COUNT(*) FROM reading_history WHERE scope_id = 'scope-b'"),
        ] {
            let count: i64 = connection.query_row(query, [], |row| row.get(0)).expect(table);
            assert_eq!(count, 1, "{table} must survive the server deletion");
        }
        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign_keys pragma");
        assert_eq!(foreign_keys, 1, "the pragma has to be restored after the delete");
    }

    #[test]
    fn deleting_the_enabled_server_hands_the_data_source_to_the_first_remaining_one() {
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

        let remaining = match delete_server_record(&mut connection, "scope-a", |_| {}) {
            CommandResult::Success { value, .. } => value,
            CommandResult::Failure { error, .. } => panic!("delete: {}", error.message),
        };

        assert_eq!(remaining.len(), 1);
        assert_eq!(
            remaining[0].id, "scope-b",
            "the app must not be left without a data source"
        );
        assert!(remaining[0].enabled);
        assert_eq!(
            enabled_flags(&connection),
            vec![("scope-b".to_string(), 1)]
        );
    }

    #[test]
    fn deleting_an_unknown_server_reports_not_found_and_touches_nothing() {
        let mut connection = migrated_connection();
        let credentials = MemoryCredentialStore {
            writes: Mutex::new(Vec::new()),
            failure: None,
        };
        save_server_record(&mut connection, &credentials, server_input(), "secret".into());

        let result = delete_server_record(&mut connection, "scope-gone", |_| {});

        assert!(matches!(result, CommandResult::Failure { .. }));
        assert_eq!(
            enabled_flags(&connection),
            vec![("scope-a".to_string(), 1)]
        );
        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign_keys pragma");
        assert_eq!(foreign_keys, 1);
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
    fn archive_identities_include_added_time_without_deleted_or_other_server_rows() {
        let connection = migrated_connection();
        connection.execute_batch("INSERT INTO servers (id,name,base_url,scope_id) VALUES
            ('server-a','A','https://example.com','scope-a'),('server-b','B','https://example.org','scope-b');
            INSERT INTO archives (server_id,archive_id,title,title_sort,tags_json,page_count,file_size,added_at,first_seen_at,is_deleted) VALUES
            ('server-a','a','A','a','[]',24,100,1700000000,1701000000,0),
            ('server-a','b','B','b','[]',48,200,NULL,1702000000,0),
            ('server-a','gone','Gone','gone','[]',1,1,1700000000,1701000000,1),
            ('server-b','a','Other','other','[]',1,1,1600000000,1600000000,0);").unwrap();
        let rows = query_archive_identities(&connection,"server-a").unwrap();
        assert_eq!(rows.len(),2);
        let a = rows.iter().find(|row| row.archive_id == "a").unwrap();
        let b = rows.iter().find(|row| row.archive_id == "b").unwrap();
        assert_eq!(a.added_at,Some(1700000000));
        assert_eq!(b.added_at,Some(1702000000));
        assert_eq!(a.file_size,Some(100));
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
        // 走 `Database` 而不是裸连接：这两条助手现在是「自己拿锁、锁外读盘/落盘」
        // 的那一版，测试要量的就是产品实际走的那条路。
        let database = crate::db::Database {
            connection: std::sync::Mutex::new(migrated_connection()),
        };
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
            &database,
            &app_data,
            "scope-a",
            "archive-a",
            0,
            "image/jpeg",
            bytes,
        )
        .expect("stored page");
        assert_eq!(
            load_reader_page_cache(&database, &app_data, "scope-a", "archive-a", 0).unwrap(),
            Some(bytes.to_vec())
        );
        assert_eq!(
            load_reader_page_cache(&database, &app_data, "scope-b", "archive-a", 0).unwrap(),
            None
        );
        store_reader_page_cache(
            &database,
            &app_data,
            "scope-b",
            "archive-a",
            0,
            "image/jpeg",
            bytes,
        )
        .expect("shared content stored for second scope");
        assert_eq!(
            load_reader_page_cache(&database, &app_data, "scope-b", "archive-a", 0).unwrap(),
            Some(bytes.to_vec())
        );
        assert_eq!(
            database
                .connection
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM cache_entries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );

        let relative_path: String = database
            .connection
            .lock()
            .unwrap()
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
            load_reader_page_cache(&database, &app_data, "scope-a", "archive-a", 0).unwrap(),
            None
        );
        assert_eq!(
            database
                .connection
                .lock()
                .unwrap()
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
    fn dangling_records_are_pruned_only_when_the_archive_is_known_gone() {
        let mut connection = migrated_connection();
        connection
            .execute_batch(
                "INSERT INTO servers (id, name, base_url, scope_id) VALUES ('scope-a', 'Test', 'https://lrr.test', 'scope-a');
                 INSERT INTO archives (server_id, archive_id, title, title_sort, tags_json, page_count, added_at, is_deleted) VALUES
                   ('scope-a', 'alive', 'Alive', 'alive', '[]', 1, 100, 0),
                   ('scope-a', 'gone', 'Gone', 'gone', '[]', 1, 100, 1);
                 INSERT INTO reading_history (scope_id, archive_id, page_index, visited_at, device_id) VALUES
                   ('scope-a', 'alive', 1, '2026-09-17 12:00:00', 'dev-1'),
                   ('scope-a', 'gone', 1, '2026-09-17 12:00:00', 'dev-1'),
                   ('scope-a', 'never-indexed', 1, '2026-09-17 12:00:00', 'dev-1');
                 INSERT INTO reading_list (scope_id, archive_id, device_id) VALUES
                   ('scope-a', 'alive', 'dev-1'), ('scope-a', 'gone', 'dev-1');
                 INSERT INTO watchlist (scope_id, archive_id, device_id) VALUES
                   ('scope-a', 'gone', 'dev-1');",
            )
            .unwrap();

        let pruned =
            prune_dangling_records_for_server(&mut connection, "scope-a").expect("prune dangling");
        assert_eq!(
            (pruned.history, pruned.reading_list, pruned.watchlist),
            (1, 1, 1)
        );

        // 索引里根本没有的那条留着：「还没被索引到」不是「被删了」的证据——导入进来的
        // 记录正是这样，按缺失来判会把它们一次清空。
        let history: Vec<String> = {
            let mut statement = connection
                .prepare("SELECT archive_id FROM reading_history ORDER BY archive_id")
                .unwrap();
            let rows = statement.query_map([], |row| row.get(0)).unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(history, vec!["alive", "never-indexed"]);
        let lists: i64 = connection
            .query_row("SELECT COUNT(*) FROM reading_list", [], |row| row.get(0))
            .unwrap();
        assert_eq!(lists, 1, "the live one stays");

        // 每条被清掉的**同步中**记录都留下墓碑，别的设备下一次同步跟着删。
        let tombstones: Vec<(String, String)> = {
            let mut statement = connection
                .prepare("SELECT object_type, payload_json FROM sync_journal ORDER BY object_id, object_type")
                .unwrap();
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(tombstones.len(), 2, "历史与待看各一条；收藏夹不上路，没有墓碑");
        assert!(tombstones
            .iter()
            .all(|(_, payload)| payload.contains("\"deleted\":true")
                && payload.contains("\"gone\"")));
        // 两条墓碑的类型必须各归各的：待看与收藏夹曾经共用一个类型，于是清掉一条
        // 收藏夹记录，别的设备上被删掉的是待看里同 id 的那条。
        let mut types: Vec<&str> = tombstones.iter().map(|(object_type, _)| object_type.as_str()).collect();
        types.sort_unstable();
        assert_eq!(types, vec!["history", "watchlist"]);
        let favorite_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM watchlist", [], |row| row.get(0))
            .unwrap();
        assert_eq!(favorite_rows, 0, "收藏夹那条本地删掉，但不留墓碑");

        // 幂等：再跑一次没有可删的。
        let again =
            prune_dangling_records_for_server(&mut connection, "scope-a").expect("prune again");
        assert_eq!(
            (again.history, again.reading_list, again.watchlist),
            (0, 0, 0)
        );
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

    fn favorite_category(name: &str, id: &str, archives: &[&str], search: Option<&str>) -> CategoryRecord {
        CategoryRecord {
            id: id.to_string(),
            name: name.to_string(),
            pinned: false,
            search: search.map(str::to_string),
            archives: archives.iter().map(|value| value.to_string()).collect(),
        }
    }

    #[test]
    fn favorites_reads_the_shared_snapshot_without_resolving_dynamic_categories() {
        // 收藏那条是静态分类，名单就在共享快照里：这一路不发任何请求——动态分类
        // 在别处（list_categories）才解析，那才是 23 秒的来源。
        let connection = migrated_connection();
        let categories = vec![
            favorite_category("🔖 Favorites", "SET_fav", &["a1", "a2"], None),
            favorite_category("同人志", "SET_big", &[], Some("category:doujinshi")),
        ];
        write_category_cache(&connection, "scope-f", &categories, false).expect("write");

        let favorites = favorites_from_cached_snapshot(&connection, "scope-f", current_unix_seconds())
            .expect("read")
            .expect("favorites");
        assert_eq!(favorites.id, "SET_fav");
        assert_eq!(favorites.archives, vec!["a1".to_string(), "a2".to_string()]);
    }

    #[test]
    fn favorites_falls_back_to_its_own_snapshot_and_expires_an_old_one() {
        let connection = migrated_connection();
        let favorites = FavoritesCategoryRecord {
            id: "SET_fav".to_string(),
            archives: vec!["a1".to_string()],
        };
        write_favorites_cache(&connection, "scope-f", &favorites).expect("write");

        // 共享快照里没有收藏（或者整个快照过期）时，用收藏自己那份。
        let cached = favorites_from_cached_snapshot(&connection, "scope-f", current_unix_seconds())
            .expect("read")
            .expect("favorites");
        assert_eq!(cached.id, "SET_fav");

        // 收藏自己的快照也有保质期：过期后宁可去网络取一次，也不拿一份旧的当新的。
        let aged = favorites_from_cached_snapshot(
            &connection,
            "scope-f",
            current_unix_seconds() + CATEGORY_CACHE_MAX_AGE_SECONDS + 1,
        )
        .expect("read aged");
        assert!(aged.is_none(), "an aged favorites snapshot must be refetched");

        // 但断网时它仍然是最好的答案（命令的最后一手是它，不看年龄）。
        let stale = read_favorites_cache_from(
            &connection,
            "scope-f",
            current_unix_seconds() + CATEGORY_CACHE_MAX_AGE_SECONDS + 1,
            None,
        )
        .expect("read stale");
        assert_eq!(stale.map(|value| value.id), Some("SET_fav".to_string()));

        // 没有这条分类的服务器：两处都没有，就是 None（调用方退回本机收藏）。
        assert!(
            favorites_from_cached_snapshot(&connection, "scope-none", current_unix_seconds())
                .expect("read none")
                .is_none()
        );
    }

    #[test]
    fn adding_or_removing_a_category_drops_both_snapshots() {
        // 收藏那条分类的会员名单变了，两份快照都得作废：共享快照里也有它，
        // 收藏那份是它的快路径。
        let connection = migrated_connection();
        write_favorites_cache(
            &connection,
            "scope-f",
            &FavoritesCategoryRecord { id: "SET_fav".to_string(), archives: vec!["a1".to_string()] },
        )
        .expect("write favorites");
        write_category_cache(
            &connection,
            "scope-f",
            &[favorite_category("🔖 Favorites", "SET_fav", &["a1"], None)],
            false,
        )
        .expect("write shared");

        invalidate_category_cache(&connection, "scope-f").expect("invalidate");

        assert!(
            read_favorites_cache_from(&connection, "scope-f", current_unix_seconds(), None)
                .expect("read favorites")
                .is_none()
        );
        assert!(
            read_category_cache_from(&connection, "scope-f", current_unix_seconds())
                .expect("read shared")
                .is_none()
        );
    }

    #[test]
    fn deleting_history_records_leaves_tombstones_and_spares_other_rows() {
        let mut connection = migrated_connection();
        for archive_id in ["a1", "a2", "a3"] {
            connection
                .execute(
                    "INSERT INTO reading_history (scope_id, archive_id, page_index, visited_at, device_id, revision)
                     VALUES ('scope-h', ?1, 3, '2026-09-01T00:00:00Z', 'device-1', 1)",
                    [archive_id],
                )
                .expect("insert history");
        }
        connection
            .execute(
                "INSERT INTO reading_history (scope_id, archive_id, page_index, visited_at, device_id, revision)
                 VALUES ('scope-other', 'a1', 3, '2026-09-01T00:00:00Z', 'device-1', 1)",
                [],
            )
            .expect("insert other scope");

        let removed = delete_history_records_in(
            &mut connection,
            "scope-h",
            &["a1".to_string(), "a2".to_string(), "missing".to_string()],
        )
        .expect("delete");
        assert_eq!(removed, 2, "每条真的删掉的记录各算一条");

        let left: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM reading_history WHERE scope_id = 'scope-h'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(left, 1, "没选中的那条记录还在");
        let other: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM reading_history WHERE scope_id = 'scope-other'",
                [],
                |row| row.get(0),
            )
            .expect("count other");
        assert_eq!(other, 1, "别的设备那一份不能被本机的清理带走");

        let tombstones: Vec<(String, String)> = {
            let mut statement = connection
                .prepare("SELECT object_id, payload_json FROM sync_journal WHERE object_type = 'history'")
                .expect("prepare journal");
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .expect("journal rows");
            rows.collect::<Result<Vec<_>, _>>().expect("collect")
        };
        assert_eq!(tombstones.len(), 2, "每条删掉的记录各留一个墓碑");
        for (object_id, payload) in tombstones {
            assert!(object_id.starts_with("scope-h/"), "{object_id}");
            assert!(payload.contains("\"deleted\":true"), "{payload}");
        }
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

    #[test]
    fn progress_push_url_is_one_based_and_trims_the_trailing_slash() {
        assert_eq!(
            progress_push_url("https://lrr.example/", "abc", 0),
            "https://lrr.example/api/archives/abc/progress/1"
        );
        assert_eq!(
            progress_push_url("https://lrr.example", "abc", 232),
            "https://lrr.example/api/archives/abc/progress/233"
        );
    }

    #[test]
    fn a_fast_scroll_keeps_only_the_latest_page_for_the_remote_write() {
        let mut state = ProgressPushState::default();
        assert!(state.submit("k", 0), "第一次翻页要起一个 worker");
        assert!(!state.submit("k", 1), "在飞期间不再起新的");
        assert!(!state.submit("k", 7), "在飞期间只记最新那一页");
        assert_eq!(state.finish("k"), Some(7), "收尾时发的是最新那一页");
        assert_eq!(state.finish("k"), None, "排空之后就该收工");
        assert!(state.submit("k", 8), "收工之后还能再起一个");
        state.block("k");
        assert!(!state.submit("k", 9), "被服务器拒过的档案不再重试");
        assert_eq!(state.finish("k"), None);
    }

    #[test]
    fn only_the_first_failure_of_an_archive_reaches_the_error_log() {
        let mut state = ProgressPushState::default();
        assert!(state.should_warn("k"), "第一次失败要留一条日志");
        assert!(!state.should_warn("k"), "同一条错连着来会刷屏");
        assert!(!state.should_warn("k"));
        assert!(state.should_warn("other"), "另一个档案是另一条");
    }

    #[test]
    fn only_a_remote_scope_gets_a_progress_write_back() {
        let mut connection = migrated_connection();
        let credentials = MemoryCredentialStore {
            writes: Mutex::new(Vec::new()),
            failure: None,
        };
        let mut server = server_input();
        server.scope_id = "scope-lrr".to_string();
        server.base_url = "https://lrr.example/".to_string();
        match save_server_record(&mut connection, &credentials, server, "secret".to_string()) {
            CommandResult::Success { .. } => {}
            CommandResult::Failure { error, .. } => panic!("server save: {}", error.message),
        }

        assert_eq!(
            progress_push_base_url(&connection, "scope-lrr").as_deref(),
            Some("https://lrr.example")
        );
        // 本地档案的 scope 在 `servers` 里没有行（它们在 `local_archives`）：不发。
        assert_eq!(progress_push_base_url(&connection, "scope-local"), None);
        // `enabled` 是「谁的架子摆在首页」，不是「还连得上」：读着它的档案就照样要发。
        connection
            .execute("UPDATE servers SET enabled = 0", [])
            .expect("disable server");
        assert_eq!(
            progress_push_base_url(&connection, "scope-lrr").as_deref(),
            Some("https://lrr.example")
        );
    }

    #[test]
    fn a_pasted_document_is_not_sent_as_an_api_key() {
        assert_eq!(usable_api_key("  key-abc  ").as_deref(), Some("key-abc"));
        assert_eq!(usable_api_key(""), None);
        assert_eq!(usable_api_key("   "), None);
        assert_eq!(usable_api_key(&"x".repeat(MAX_API_KEY_CHARS + 1)), None);
        assert_eq!(
            usable_api_key(&"x".repeat(MAX_API_KEY_CHARS)).map(|key| key.len()),
            Some(MAX_API_KEY_CHARS),
            "512 这一道边界按字符数算"
        );
    }

    /// `test_http_server` 只回固定应答；这一个把请求原文留下来，好断言方法、路径与头。
    async fn recording_http_server(
        responses: Vec<(u16, String)>,
    ) -> (
        String,
        std::sync::Arc<Mutex<Vec<String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
        let recorded = std::sync::Arc::clone(&requests);
        let task = tokio::spawn(async move {
            let mut served = 0;
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 8192];
                let read = read_request_head(&mut socket, &mut request).await;
                recorded
                    .lock()
                    .expect("request log")
                    .push(String::from_utf8_lossy(&request[..read]).to_string());
                let (status, body) = &responses[served.min(responses.len() - 1)];
                served += 1;
                let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (url, requests, task)
    }

    #[tokio::test]
    async fn reading_progress_goes_back_to_lanraragi_one_based_with_a_base64_key() {
        let (url, requests, server) = recording_http_server(vec![(200, "{}".to_string())]).await;
        let outcome = push_reading_progress_once(&url, "key", "archive-a", 5).await;
        server.abort();
        assert!(matches!(outcome, ProgressPushOutcome::Sent), "{outcome:?}");
        let request = requests.lock().expect("request log")[0].clone();
        assert!(
            request.starts_with("PUT /api/archives/archive-a/progress/6 "),
            "{request}"
        );
        assert!(
            request.contains(&format!(
                "authorization: Bearer {}",
                BASE64_STANDARD.encode("key")
            )),
            "API Key 要先 base64 再放进 Bearer：{request}"
        );
    }

    #[tokio::test]
    async fn a_client_error_stops_the_archive_but_a_server_error_is_retried() {
        let (url, _requests, server) =
            recording_http_server(vec![(400, r#"{"error":"nope"}"#.to_string())]).await;
        let rejected = push_reading_progress_once(&url, "key", "archive-a", 0).await;
        server.abort();
        assert!(
            matches!(rejected, ProgressPushOutcome::Rejected(_)),
            "{rejected:?}"
        );

        let (url, _requests, server) = recording_http_server(vec![(500, "{}".to_string())]).await;
        let failed = push_reading_progress_once(&url, "key", "archive-a", 0).await;
        server.abort();
        assert!(
            matches!(failed, ProgressPushOutcome::Failed(_)),
            "5xx 只是一时失败，下一次翻页还要试：{failed:?}"
        );
    }
}

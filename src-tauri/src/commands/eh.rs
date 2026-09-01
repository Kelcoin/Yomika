use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;
use url::Url;

use crate::{db::Database, domain::result::CommandResult};

// ── HTTP helpers ──────────────────────────────────────────────────────────

trait EhCookieReader {
    fn get_cookie(&self, reference: &str) -> Result<String, String>;
}

struct SystemEhCookieReader;
impl EhCookieReader for SystemEhCookieReader {
    fn get_cookie(&self, reference: &str) -> Result<String, String> {
        keyring::Entry::new(COOKIE_SERVICE, reference)
            .map_err(|e| e.to_string())?
            .get_password()
            .map_err(|e| e.to_string())
    }
}

fn read_account_cookie(connection: &Connection, store: &dyn EhCookieReader, account_id: &str) -> Result<(String, String, String), String> {
    let row = connection.query_row(
        "SELECT cookie_ref, host FROM eh_accounts WHERE id=?1",
        params![account_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    );
    let (cookie_ref, host) = row.map_err(|e| e.to_string())?;
    let cookie = store.get_cookie(&cookie_ref)?;
    Ok((cookie, host, cookie_ref))
}

fn classify_eh_status(status: u16, body: &str) -> Option<(&'static str, String, bool)> {
    let lower = body.to_lowercase();
    // EH and ExHentai can return a non-gallery page with HTTP 200 or 404.
    // Inspect the body first so copyright removals are not reduced to 404.
    if lower.contains("copyright claim")
        || lower.contains("copyright infringement")
        || lower.contains("copyright complaint")
        || lower.contains("copyright holder")
        || lower.contains("dmca")
        || lower.contains("removed due to copyright")
        || lower.contains("unavailable due to a copyright")
    {
        return Some(("EH_GALLERY_COPYRIGHT_REMOVED", "E-Hentai gallery was removed due to a copyright claim".into(), false));
    }
    if lower.contains("cf-browser-verification")
        || lower.contains("_cf_chl_opt")
        || lower.contains("cf-challenge")
        || lower.contains("just a moment")
        || lower.contains("checking your browser")
    {
        return Some(("EH_CLOUDFLARE", "E-Hentai Cloudflare challenge blocked request".into(), false));
    }
    if status == 429 || lower.contains("rate limit") || lower.contains("too many requests") {
        return Some(("EH_RATE_LIMIT", "E-Hentai rate limit reached".into(), true));
    }
    if status == 403 && (lower.contains("cloudflare") || lower.contains("cf-chl") || lower.contains("captcha")) {
        return Some(("EH_CLOUDFLARE", "E-Hentai Cloudflare challenge blocked request".into(), false));
    }
    if status == 401
        || lower.contains("<title>login</title>")
        || lower.contains("please login")
        || lower.contains("you must be logged in")
        || lower.contains("not logged in")
        || lower.contains("login required")
        || lower.contains("your ip address has been temporarily banned")
    {
        return Some(("EH_REAUTH_REQUIRED", "E-Hentai login is required".into(), false));
    }
    if lower.contains("you are seeing this page because")
        || (lower.contains("content warning") && lower.contains("<h1"))
    {
        return Some(("EH_CONTENT_WARNING", "E-Hentai content warning requires confirmation or login".into(), false));
    }
    if status == 403 {
        return Some(("EH_ACCESS_BLOCKED", "E-Hentai access was blocked".into(), false));
    }
    if status == 404 || lower.contains("gallery not found") || lower.contains("gallery does not exist") || lower.contains("gallery has been removed") {
        return Some(("EH_GALLERY_DELETED", "E-Hentai gallery was deleted or not found".into(), false));
    }
    if status >= 500 || status < 200 {
        return Some(("EH_UNAVAILABLE", "E-Hentai is unavailable".into(), true));
    }
    None
}

const COOKIE_SERVICE: &str = "app.yomika.eh";

pub trait EhCookieStore {
    fn set_cookie(&self, reference: &str, cookie: &str) -> Result<(), String>;
    fn delete_cookie(&self, reference: &str) -> Result<(), String>;
}

struct SystemEhCookieStore;
impl EhCookieStore for SystemEhCookieStore {
    fn set_cookie(&self, reference: &str, cookie: &str) -> Result<(), String> {
        keyring::Entry::new(COOKIE_SERVICE, reference).map_err(|e| e.to_string())?.set_password(cookie).map_err(|e| e.to_string())
    }
    fn delete_cookie(&self, reference: &str) -> Result<(), String> {
        keyring::Entry::new(COOKIE_SERVICE, reference).map_err(|e| e.to_string())?.delete_credential().map_err(|e| e.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveEhAccountInput {
    pub id: String,
    pub label: String,
    pub host: String,
    pub username_hint: Option<String>,
    pub cookie: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EhAccountRecord {
    pub id: String,
    pub label: String,
    pub host: String,
    pub username_hint: Option<String>,
    pub cookie_ref: String,
    pub is_active: bool,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

fn read_account(connection: &Connection, id: &str) -> Result<EhAccountRecord, String> {
    connection.query_row(
        "SELECT id,label,host,username_hint,cookie_ref,is_active,status,created_at,updated_at FROM eh_accounts WHERE id=?1",
        params![id], |row| Ok(EhAccountRecord { id: row.get(0)?, label: row.get(1)?, host: row.get(2)?, username_hint: row.get(3)?, cookie_ref: row.get(4)?, is_active: row.get::<_, i64>(5)? != 0, status: row.get(6)?, created_at: row.get(7)?, updated_at: row.get(8)? }))
        .map_err(|e| e.to_string())
}

pub fn save_eh_account_record(connection: &mut Connection, store: &dyn EhCookieStore, input: SaveEhAccountInput) -> CommandResult<EhAccountRecord> {
    if input.id.trim().is_empty() || input.label.trim().is_empty() || input.cookie.is_empty() || !matches!(input.host.as_str(), "e-hentai.org" | "exhentai.org") {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid E-Hentai account", false);
    }
    let cookie_ref = format!("eh-{}-{}", input.id, uuid_suffix());
    if let Err(error) = store.set_cookie(&cookie_ref, &input.cookie) { return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false); }
    let old_ref: Option<String> = connection.query_row("SELECT cookie_ref FROM eh_accounts WHERE id=?1", params![input.id], |row| row.get(0)).ok();
    let transaction = match connection.transaction() { Ok(tx) => tx, Err(error) => { let _ = store.delete_cookie(&cookie_ref); return CommandResult::failure("UNKNOWN", error.to_string(), true); } };
    let result = transaction.execute("INSERT INTO eh_accounts (id,label,host,username_hint,cookie_ref) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET label=excluded.label,host=excluded.host,username_hint=excluded.username_hint,cookie_ref=excluded.cookie_ref,is_active=1,status='unverified',updated_at=CURRENT_TIMESTAMP", params![input.id, input.label.trim(), input.host, input.username_hint, cookie_ref]);
    if let Err(error) = result { let _ = store.delete_cookie(&cookie_ref); return CommandResult::failure("UNKNOWN", error.to_string(), true); }
    let account = match read_account(&transaction, &input.id) { Ok(value) => value, Err(error) => { let _ = store.delete_cookie(&cookie_ref); return CommandResult::failure("UNKNOWN", error, true); } };
    if let Err(error) = transaction.commit() { let _ = store.delete_cookie(&cookie_ref); return CommandResult::failure("UNKNOWN", error.to_string(), true); }
    if let Some(old_ref) = old_ref { if old_ref != account.cookie_ref { let _ = store.delete_cookie(&old_ref); } }
    CommandResult::success(account)
}

fn uuid_suffix() -> String {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0_u8; 8];
    let _ = SystemRandom::new().fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[tauri::command]
pub fn save_eh_account(input: SaveEhAccountInput, database: State<'_, Database>) -> CommandResult<EhAccountRecord> {
    let mut connection = match database.connection.lock() { Ok(value) => value, Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true) };
    save_eh_account_record(&mut connection, &SystemEhCookieStore, input)
}

#[tauri::command]
pub fn list_eh_accounts(database: State<'_, Database>) -> CommandResult<Vec<EhAccountRecord>> {
    let connection = match database.connection.lock() { Ok(value) => value, Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true) };
    let mut statement = match connection.prepare("SELECT id,label,host,username_hint,cookie_ref,is_active,status,created_at,updated_at FROM eh_accounts ORDER BY label COLLATE NOCASE,id") { Ok(value) => value, Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true) };
    let rows = match statement.query_map([], |row| Ok(EhAccountRecord { id: row.get(0)?, label: row.get(1)?, host: row.get(2)?, username_hint: row.get(3)?, cookie_ref: row.get(4)?, is_active: row.get::<_, i64>(5)? != 0, status: row.get(6)?, created_at: row.get(7)?, updated_at: row.get(8)? })) { Ok(value) => value, Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true) };
    CommandResult::success(rows.filter_map(Result::ok).collect())
}

// ── search_eh_galleries ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhSearchParams {
    pub category: Option<u32>,
    pub page: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EhSearchResult {
    pub gallery_key: String,
    pub url: String,
    pub title: String,
    pub category: String,
    pub uploader: String,
    pub page_count: u32,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EhSearchResponse {
    pub galleries: Vec<EhSearchResult>,
}

fn build_search_url(host: &str, query: &str, params: Option<EhSearchParams>) -> Result<Url, String> {
    if query.trim().is_empty() {
        return Err("E-Hentai search query must not be empty".into());
    }
    let mut url = Url::parse(&format!("https://{host}/")).map_err(|error| error.to_string())?;
    {
        let mut query_pairs = url.query_pairs_mut();
        query_pairs.append_pair("f_search", query.trim());
        if let Some(params) = params {
            if let Some(category) = params.category {
                query_pairs.append_pair("f_cat", &category.to_string());
            }
            if let Some(page) = params.page {
                query_pairs.append_pair("page", &page.to_string());
            }
        }
    }
    Ok(url)
}

fn eh_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())
}

async fn read_http_response(request: reqwest::RequestBuilder) -> Result<(u16, String), String> {
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| error.to_string())?;
    Ok((status, body))
}

async fn search_eh_galleries_request(cookie: &str, url: Url) -> CommandResult<EhSearchResponse> {
    let client = match eh_http_client() {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    let (status, body) = match read_http_response(client.get(url).header("Cookie", cookie)).await {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    if let Some((code, message, retryable)) = classify_eh_status(status, &body) {
        return CommandResult::failure(code, message, retryable);
    }
    if body.trim().is_empty() {
        return CommandResult::failure("EH_EMPTY_RESPONSE", "E-Hentai returned an empty response", true);
    }
    let galleries = parse_search_results(&body);
    CommandResult::success(EhSearchResponse { galleries })
}

#[cfg(test)]
async fn search_eh_galleries_impl(connection: &Connection, reader: &dyn EhCookieReader, account_id: &str, query: &str, params: Option<EhSearchParams>) -> CommandResult<EhSearchResponse> {
    if query.trim().is_empty() {
        return CommandResult::failure("INVALID_RESPONSE", "E-Hentai search query must not be empty", false);
    }
    let (cookie, host, _cookie_ref) = match read_account_cookie(connection, reader, account_id) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    let url = match build_search_url(&host, query, params) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("INVALID_RESPONSE", error, false),
    };
    search_eh_galleries_request(&cookie, url).await
}

fn parse_search_results(html: &str) -> Vec<EhSearchResult> {
    let mut results = Vec::new();
    let mut remaining = html;
    while let Some(start) = remaining.find("<div class=\"glg\">") {
        remaining = &remaining[start + "<div class=\"glg\">".len()..];
        let entry = match remaining.find("<div class=\"glg\">") {
            Some(next) => &remaining[..next],
            None => remaining,
        };
        let gallery_key = extract_between(entry, "/g/", "/").unwrap_or_default();
        let url = extract_between(entry, "href=\"", "\"").unwrap_or_default();
        let title = extract_between(entry, "<a href=\"", "</a>").and_then(|s| {
            let after_href = s.rsplit_once('\"').map(|(_, v)| v)?;
            Some(strip_tags(after_href))
        }).unwrap_or_default();
        let category = extract_between(entry, "class=\"gl5\">", "</span>").map(strip_tags).unwrap_or_default();
        let uploader = extract_between(entry, "class=\"gl6\">", "</div>").map(strip_tags).unwrap_or_default();
        let page_text = extract_between(entry, "class=\"gl7\">", "</div>").unwrap_or_default();
        let page_count = page_text.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0);
        if !gallery_key.is_empty() && !title.is_empty() {
            results.push(EhSearchResult { gallery_key: gallery_key.to_string(), url: url.to_string(), title, category, uploader, page_count, tags: Vec::new() });
        }
    }
    results
}

fn extract_between<'a>(haystack: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let after = haystack.find(start)? + start.len();
    let rest = &haystack[after..];
    let before = rest.find(end)?;
    Some(&rest[..before])
}

fn strip_tags(s: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    result.trim().to_string()
}

#[tauri::command]
pub async fn search_eh_galleries(account_id: String, query: String, params: Option<EhSearchParams>, database: State<'_, Database>) -> Result<CommandResult<EhSearchResponse>, String> {
    if query.trim().is_empty() {
        return Ok(CommandResult::failure("INVALID_RESPONSE", "E-Hentai search query must not be empty", false));
    }
    let (cookie, host, _cookie_ref) = {
        let connection = match database.connection.lock() { Ok(value) => value, Err(_) => return Ok(CommandResult::failure("UNKNOWN", "Database lock failed", true)) };
        match read_account_cookie(&connection, &SystemEhCookieReader, &account_id) {
            Ok(value) => value,
            Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
        }
    };
    let url = match build_search_url(&host, &query, params) {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("INVALID_RESPONSE", error, false)),
    };
    Ok(search_eh_galleries_request(&cookie, url).await)
}

// ── remove_eh_favorite ────────────────────────────────────────────────────

async fn remove_eh_favorite_request(cookie: &str, host: &str, gallery_id: &str, token: &str) -> CommandResult<()> {
    let url = format!("https://{host}/gallerypopups.php");
    let client = match eh_http_client() {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    let form = [("gid", gallery_id), ("t", token), ("act", "deletefav")];
    let (status, body) = match read_http_response(client.post(url).header("Cookie", cookie).form(&form)).await {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    if let Some((code, message, retryable)) = classify_eh_status(status, &body) {
        return CommandResult::failure(code, message, retryable);
    }
    CommandResult::success(())
}

#[cfg(test)]
async fn remove_eh_favorite_impl(connection: &Connection, reader: &dyn EhCookieReader, account_id: &str, gallery_id: &str, token: &str) -> CommandResult<()> {
    if !gallery_id.chars().all(|c| c.is_ascii_digit()) || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid E-Hentai favorite input", false);
    }
    let (cookie, host, _cookie_ref) = match read_account_cookie(connection, reader, account_id) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    remove_eh_favorite_request(&cookie, &host, gallery_id, token).await
}

#[tauri::command]
pub async fn remove_eh_favorite(account_id: String, gallery_id: String, token: String, database: State<'_, Database>) -> Result<CommandResult<()>, String> {
    if !gallery_id.chars().all(|c| c.is_ascii_digit()) || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(CommandResult::failure("INVALID_RESPONSE", "Invalid E-Hentai favorite input", false));
    }
    let (cookie, host, _cookie_ref) = {
        let connection = match database.connection.lock() { Ok(value) => value, Err(_) => return Ok(CommandResult::failure("UNKNOWN", "Database lock failed", true)) };
        match read_account_cookie(&connection, &SystemEhCookieReader, &account_id) {
            Ok(value) => value,
            Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
        }
    };
    Ok(remove_eh_favorite_request(&cookie, &host, &gallery_id, &token).await)
}

// ── vote_eh_comment ───────────────────────────────────────────────────────

async fn vote_eh_comment_request(cookie: &str, host: &str, gallery_id: &str, token: &str, comment_id: &str, vote: i32) -> CommandResult<()> {
    let url = format!("https://{host}/gallerypopups.php");
    let client = match eh_http_client() {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    let form = [
        ("gid", gallery_id.to_string()),
        ("t", token.to_string()),
        ("ac", comment_id.to_string()),
        ("act", "votecomment".to_string()),
        ("vote", vote.to_string()),
    ];
    let (status, body) = match read_http_response(client.post(url).header("Cookie", cookie).form(&form)).await {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    if let Some((code, message, retryable)) = classify_eh_status(status, &body) {
        return CommandResult::failure(code, message, retryable);
    }
    CommandResult::success(())
}

#[cfg(test)]
async fn vote_eh_comment_impl(connection: &Connection, reader: &dyn EhCookieReader, account_id: &str, gallery_id: &str, token: &str, comment_id: &str, vote: i32) -> CommandResult<()> {
    if !gallery_id.chars().all(|c| c.is_ascii_digit()) || !token.chars().all(|c| c.is_ascii_hexdigit()) || !comment_id.chars().all(|c| c.is_ascii_digit()) || (vote != 1 && vote != -1) {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid E-Hentai vote input", false);
    }
    let (cookie, host, _cookie_ref) = match read_account_cookie(connection, reader, account_id) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    vote_eh_comment_request(&cookie, &host, gallery_id, token, comment_id, vote).await
}

#[tauri::command]
pub async fn vote_eh_comment(account_id: String, gallery_id: String, token: String, comment_id: String, vote: i32, database: State<'_, Database>) -> Result<CommandResult<()>, String> {
    if !gallery_id.chars().all(|c| c.is_ascii_digit()) || !token.chars().all(|c| c.is_ascii_hexdigit()) || !comment_id.chars().all(|c| c.is_ascii_digit()) || (vote != 1 && vote != -1) {
        return Ok(CommandResult::failure("INVALID_RESPONSE", "Invalid E-Hentai vote input", false));
    }
    let (cookie, host, _cookie_ref) = {
        let connection = match database.connection.lock() { Ok(value) => value, Err(_) => return Ok(CommandResult::failure("UNKNOWN", "Database lock failed", true)) };
        match read_account_cookie(&connection, &SystemEhCookieReader, &account_id) {
            Ok(value) => value,
            Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
        }
    };
    Ok(vote_eh_comment_request(&cookie, &host, &gallery_id, &token, &comment_id, vote).await)
}

// ── check_eh_login_health ─────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginHealthResult {
    pub logged_in: bool,
}

async fn check_eh_login_health_request(cookie: &str, host: &str) -> CommandResult<LoginHealthResult> {
    let url = format!("https://{host}/");
    let client = match eh_http_client() {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    let (status, body) = match read_http_response(client.get(url).header("Cookie", cookie)).await {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    if let Some((code, message, retryable)) = classify_eh_status(status, &body) {
        return CommandResult::failure(code, message, retryable);
    }
    let lower = body.to_lowercase();
    let logged_in = lower.contains("logged in") || lower.contains("logout");
    CommandResult::success(LoginHealthResult { logged_in })
}

#[cfg(test)]
async fn check_eh_login_health_impl(connection: &Connection, reader: &dyn EhCookieReader, account_id: &str) -> CommandResult<LoginHealthResult> {
    let (cookie, host, _cookie_ref) = match read_account_cookie(connection, reader, account_id) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    check_eh_login_health_request(&cookie, &host).await
}

#[tauri::command]
pub async fn check_eh_login_health(account_id: String, database: State<'_, Database>) -> Result<CommandResult<LoginHealthResult>, String> {
    let (cookie, host, _cookie_ref) = {
        let connection = match database.connection.lock() { Ok(value) => value, Err(_) => return Ok(CommandResult::failure("UNKNOWN", "Database lock failed", true)) };
        match read_account_cookie(&connection, &SystemEhCookieReader, &account_id) {
            Ok(value) => value,
            Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
        }
    };
    Ok(check_eh_login_health_request(&cookie, &host).await)
}

// ── set_active_eh_account ─────────────────────────────────────────────────

pub fn set_active_eh_account_impl(connection: &mut Connection, account_id: &str) -> CommandResult<()> {
    let exists: bool = connection.query_row("SELECT COUNT(*) FROM eh_accounts WHERE id=?1", params![account_id], |row| row.get::<_, i64>(0)).map(|v| v > 0).unwrap_or(false);
    if !exists {
        return CommandResult::failure("UNKNOWN", "Account not found", false);
    }
    let transaction = match connection.transaction() {
        Ok(tx) => tx,
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    if let Err(error) = transaction.execute("UPDATE eh_accounts SET is_active=0", []) {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    if let Err(error) = transaction.execute("UPDATE eh_accounts SET is_active=1, updated_at=CURRENT_TIMESTAMP WHERE id=?1", params![account_id]) {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    if let Err(error) = transaction.commit() {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    CommandResult::success(())
}

#[tauri::command]
pub fn set_active_eh_account(account_id: String, database: State<'_, Database>) -> CommandResult<()> {
    let mut connection = match database.connection.lock() { Ok(value) => value, Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true) };
    set_active_eh_account_impl(&mut connection, &account_id)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use super::*;

    struct MemoryStore { writes: Mutex<Vec<(String, String)>>, deletes: Mutex<Vec<String>> }
    impl EhCookieStore for MemoryStore {
        fn set_cookie(&self, reference: &str, cookie: &str) -> Result<(), String> { self.writes.lock().unwrap().push((reference.to_string(), cookie.to_string())); Ok(()) }
        fn delete_cookie(&self, reference: &str) -> Result<(), String> { self.deletes.lock().unwrap().push(reference.to_string()); Ok(()) }
    }

    struct MemoryCookieReader { cookies: std::collections::HashMap<String, String> }
    impl EhCookieReader for MemoryCookieReader {
        fn get_cookie(&self, reference: &str) -> Result<String, String> {
            self.cookies.get(reference).cloned().ok_or_else(|| format!("cookie not found: {}", reference))
        }
    }

    fn db() -> Connection { let c = Connection::open_in_memory().unwrap(); c.execute_batch(include_str!("../../migrations/0001_initial.sql")).unwrap(); c.execute_batch(include_str!("../../migrations/0007_eh_accounts.sql")).unwrap(); c }

    fn insert_account(c: &Connection, id: &str, cookie_ref: &str, host: &str, is_active: bool) {
        c.execute("INSERT INTO eh_accounts (id,label,host,cookie_ref,is_active,status) VALUES (?1,?2,?3,?4,?5,'verified')", params![id, id, host, cookie_ref, is_active as i32]).unwrap();
    }

    #[test]
    fn account_keeps_cookie_out_of_sqlite_and_response() {
        let mut c = db(); let store = MemoryStore { writes: Mutex::new(vec![]), deletes: Mutex::new(vec![]) };
        let result = save_eh_account_record(&mut c, &store, SaveEhAccountInput { id: "eh-a".into(), label: "EH".into(), host: "e-hentai.org".into(), username_hint: Some("reader".into()), cookie: "ipb=secret".into() });
        let account = match result { CommandResult::Success { value, .. } => value, _ => panic!("save") };
        assert!(!serde_json::to_string(&account).unwrap().contains("secret"));
        let text: String = c.query_row("SELECT id||label||host||cookie_ref FROM eh_accounts", [], |r| r.get(0)).unwrap();
        assert!(!text.contains("secret")); assert_eq!(store.writes.lock().unwrap().len(), 1);
    }

    // ── search_eh_galleries tests ─────────────────────────────────────────

    #[tokio::test]
    async fn search_rejects_empty_query() {
        let c = db();
        let reader = MemoryCookieReader { cookies: std::collections::HashMap::new() };
        let result = search_eh_galleries_impl(&c, &reader, "eh-a", "", None).await;
        match result { CommandResult::Failure { ok: false, error } => { assert_eq!(error.code, "INVALID_RESPONSE"); } _ => panic!("expected failure") }
    }

    #[tokio::test]
    async fn search_rejects_missing_account() {
        let c = db();
        let reader = MemoryCookieReader { cookies: std::collections::HashMap::new() };
        let result = search_eh_galleries_impl(&c, &reader, "nonexistent", "test", None).await;
        match result { CommandResult::Failure { ok: false, error } => { assert_eq!(error.code, "EH_UNAVAILABLE"); } _ => panic!("expected failure") }
    }

    #[tokio::test]
    async fn search_rejects_when_cookie_missing() {
        let c = db();
        insert_account(&c, "eh-a", "ref-a", "e-hentai.org", true);
        let reader = MemoryCookieReader { cookies: std::collections::HashMap::new() };
        let result = search_eh_galleries_impl(&c, &reader, "eh-a", "test", None).await;
        match result { CommandResult::Failure { ok: false, error } => { assert!(error.message.contains("cookie not found")); } _ => panic!("expected failure") }
    }

    // ── remove_eh_favorite tests ──────────────────────────────────────────

    #[tokio::test]
    async fn remove_favorite_rejects_invalid_gallery_id() {
        let c = db();
        let reader = MemoryCookieReader { cookies: std::collections::HashMap::new() };
        let result = remove_eh_favorite_impl(&c, &reader, "eh-a", "not-a-number", "abc").await;
        match result { CommandResult::Failure { ok: false, error } => { assert_eq!(error.code, "INVALID_RESPONSE"); } _ => panic!("expected failure") }
    }

    #[tokio::test]
    async fn remove_favorite_rejects_invalid_token() {
        let c = db();
        let reader = MemoryCookieReader { cookies: std::collections::HashMap::new() };
        let result = remove_eh_favorite_impl(&c, &reader, "eh-a", "12345", "zzz!").await;
        match result { CommandResult::Failure { ok: false, error } => { assert_eq!(error.code, "INVALID_RESPONSE"); } _ => panic!("expected failure") }
    }

    #[tokio::test]
    async fn remove_favorite_rejects_missing_account() {
        let c = db();
        let reader = MemoryCookieReader { cookies: std::collections::HashMap::new() };
        let result = remove_eh_favorite_impl(&c, &reader, "nonexistent", "12345", "abc").await;
        match result { CommandResult::Failure { ok: false, error } => { assert_eq!(error.code, "EH_UNAVAILABLE"); } _ => panic!("expected failure") }
    }

    // ── vote_eh_comment tests ─────────────────────────────────────────────

    #[tokio::test]
    async fn vote_rejects_invalid_vote_value() {
        let c = db();
        let reader = MemoryCookieReader { cookies: std::collections::HashMap::new() };
        let result = vote_eh_comment_impl(&c, &reader, "eh-a", "12345", "abc", "777", 5).await;
        match result { CommandResult::Failure { ok: false, error } => { assert_eq!(error.code, "INVALID_RESPONSE"); } _ => panic!("expected failure") }
    }

    #[tokio::test]
    async fn vote_rejects_invalid_comment_id() {
        let c = db();
        let reader = MemoryCookieReader { cookies: std::collections::HashMap::new() };
        let result = vote_eh_comment_impl(&c, &reader, "eh-a", "12345", "abc", "not-a-number", 1).await;
        match result { CommandResult::Failure { ok: false, error } => { assert_eq!(error.code, "INVALID_RESPONSE"); } _ => panic!("expected failure") }
    }

    #[tokio::test]
    async fn vote_rejects_missing_account() {
        let c = db();
        let reader = MemoryCookieReader { cookies: std::collections::HashMap::new() };
        let result = vote_eh_comment_impl(&c, &reader, "nonexistent", "12345", "abc", "777", 1).await;
        match result { CommandResult::Failure { ok: false, error } => { assert_eq!(error.code, "EH_UNAVAILABLE"); } _ => panic!("expected failure") }
    }

    // ── check_eh_login_health tests ───────────────────────────────────────

    #[tokio::test]
    async fn login_health_rejects_missing_account() {
        let c = db();
        let reader = MemoryCookieReader { cookies: std::collections::HashMap::new() };
        let result = check_eh_login_health_impl(&c, &reader, "nonexistent").await;
        match result { CommandResult::Failure { ok: false, error } => { assert_eq!(error.code, "EH_UNAVAILABLE"); } _ => panic!("expected failure") }
    }

    #[tokio::test]
    async fn login_health_rejects_when_cookie_missing() {
        let c = db();
        insert_account(&c, "eh-a", "ref-a", "e-hentai.org", true);
        let reader = MemoryCookieReader { cookies: std::collections::HashMap::new() };
        let result = check_eh_login_health_impl(&c, &reader, "eh-a").await;
        match result { CommandResult::Failure { ok: false, error } => { assert!(error.message.contains("cookie not found")); } _ => panic!("expected failure") }
    }

    // ── set_active_eh_account tests ───────────────────────────────────────

    #[test]
    fn set_active_rejects_nonexistent_account() {
        let mut c = db();
        let result = set_active_eh_account_impl(&mut c, "nonexistent");
        match result { CommandResult::Failure { ok: false, error } => { assert_eq!(error.code, "UNKNOWN"); assert_eq!(error.message, "Account not found"); } _ => panic!("expected failure") }
    }

    #[test]
    fn set_active_deactivates_others_and_activates_target() {
        let mut c = db();
        insert_account(&c, "eh-a", "ref-a", "e-hentai.org", true);
        insert_account(&c, "eh-b", "ref-b", "exhentai.org", false);
        insert_account(&c, "eh-c", "ref-c", "e-hentai.org", true);
        let result = set_active_eh_account_impl(&mut c, "eh-b");
        match result { CommandResult::Success { .. } => {} _ => panic!("expected success") }
        let a_active: bool = c.query_row("SELECT is_active FROM eh_accounts WHERE id='eh-a'", [], |r| r.get::<_, i64>(0)).unwrap() != 0;
        let b_active: bool = c.query_row("SELECT is_active FROM eh_accounts WHERE id='eh-b'", [], |r| r.get::<_, i64>(0)).unwrap() != 0;
        let c_active: bool = c.query_row("SELECT is_active FROM eh_accounts WHERE id='eh-c'", [], |r| r.get::<_, i64>(0)).unwrap() != 0;
        assert!(!a_active);
        assert!(b_active);
        assert!(!c_active);
    }

    // ── classify_eh_status tests ──────────────────────────────────────────

    #[test]
    fn classify_recognizes_rate_limit() {
        let result = classify_eh_status(429, "too many requests");
        assert!(result.is_some());
        assert_eq!(result.unwrap().0, "EH_RATE_LIMIT");
    }

    #[test]
    fn classify_recognizes_cloudflare() {
        let result = classify_eh_status(403, "cf-chl-captcha");
        assert!(result.is_some());
        assert_eq!(result.unwrap().0, "EH_CLOUDFLARE");
    }

    #[test]
    fn classify_recognizes_unauthorized() {
        let result = classify_eh_status(401, "not logged in");
        assert!(result.is_some());
        assert_eq!(result.unwrap().0, "EH_REAUTH_REQUIRED");
    }

    #[test]
    fn classify_recognizes_gallery_deleted() {
        let result = classify_eh_status(404, "gallery does not exist");
        assert!(result.is_some());
        assert_eq!(result.unwrap().0, "EH_GALLERY_DELETED");
    }

    #[test]
    fn classify_prioritizes_copyright_removal_over_404() {
        let result = classify_eh_status(404, "This gallery is unavailable due to a copyright claim by FAKKU.");
        assert!(result.is_some());
        assert_eq!(result.unwrap().0, "EH_GALLERY_COPYRIGHT_REMOVED");
    }

    #[test]
    fn classify_recognizes_worker_non_gallery_pages() {
        assert_eq!(classify_eh_status(200, "<title>Just a moment...</title>").unwrap().0, "EH_CLOUDFLARE");
        assert_eq!(classify_eh_status(200, "<title>Login</title><p>Please login</p>").unwrap().0, "EH_REAUTH_REQUIRED");
        assert_eq!(classify_eh_status(200, "<h1>Content Warning</h1><p>You are seeing this page because</p>").unwrap().0, "EH_CONTENT_WARNING");
        assert_eq!(classify_eh_status(403, "Access Denied").unwrap().0, "EH_ACCESS_BLOCKED");
        assert_eq!(classify_eh_status(200, "<title>Gallery Not Found</title>").unwrap().0, "EH_GALLERY_DELETED");
    }

    #[test]
    fn classify_passes_200_ok() {
        let result = classify_eh_status(200, "You are logged in");
        assert!(result.is_none());
    }


    // ── parse_search_results tests ────────────────────────────────────────

    #[test]
    fn parse_extracts_gallery_entries() {
        let html = "<div class=\"glg\"><div class=\"glc\"><div class=\"gl3\"><a href=\"/g/12345/abc/\">Title</a></div><div class=\"gl4\"><span class=\"gl5\">Manga</span><div class=\"gl6\">Author</div><div class=\"gl7\">10 pages</div></div></div></div>";
        let results = parse_search_results(html);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].gallery_key, "12345");
        assert_eq!(results[0].title, "Title");
        assert_eq!(results[0].category, "Manga");
        assert_eq!(results[0].uploader, "Author");
        assert_eq!(results[0].page_count, 10);
    }

    #[test]
    fn parse_skips_entries_without_key() {
        let html = "<div class=\"glg\"><div class=\"glc\"><div class=\"gl3\"><a href=\"/invalid/\">Bad</a></div></div></div>";
        let results = parse_search_results(html);
        assert!(results.is_empty());
    }

    #[test]
    fn search_url_uses_standard_form_encoding() {
        let url = build_search_url(
            "e-hentai.org",
            "fate grand order",
            Some(EhSearchParams { category: Some(2), page: Some(1) }),
        )
        .unwrap();
        assert_eq!(url.as_str(), "https://e-hentai.org/?f_search=fate+grand+order&f_cat=2&page=1");
    }
}

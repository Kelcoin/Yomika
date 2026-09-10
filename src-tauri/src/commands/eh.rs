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

fn read_account_cookie(
    connection: &Connection,
    store: &dyn EhCookieReader,
    account_id: &str,
) -> Result<(String, String, String), String> {
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
        return Some((
            "EH_GALLERY_COPYRIGHT_REMOVED",
            "E-Hentai gallery was removed due to a copyright claim".into(),
            false,
        ));
    }
    if lower.contains("cf-browser-verification")
        || lower.contains("_cf_chl_opt")
        || lower.contains("cf-challenge")
        || lower.contains("just a moment")
        || lower.contains("checking your browser")
    {
        return Some((
            "EH_CLOUDFLARE",
            "E-Hentai Cloudflare challenge blocked request".into(),
            false,
        ));
    }
    if status == 429 || lower.contains("rate limit") || lower.contains("too many requests") {
        return Some(("EH_RATE_LIMIT", "E-Hentai rate limit reached".into(), true));
    }
    if status == 403
        && (lower.contains("cloudflare") || lower.contains("cf-chl") || lower.contains("captcha"))
    {
        return Some((
            "EH_CLOUDFLARE",
            "E-Hentai Cloudflare challenge blocked request".into(),
            false,
        ));
    }
    if status == 401
        || lower.contains("<title>login</title>")
        || lower.contains("please login")
        || lower.contains("you must be logged in")
        || lower.contains("not logged in")
        || lower.contains("login required")
        || lower.contains("your ip address has been temporarily banned")
    {
        return Some((
            "EH_REAUTH_REQUIRED",
            "E-Hentai login is required".into(),
            false,
        ));
    }
    if lower.contains("you are seeing this page because")
        || (lower.contains("content warning") && lower.contains("<h1"))
    {
        return Some((
            "EH_CONTENT_WARNING",
            "E-Hentai content warning requires confirmation or login".into(),
            false,
        ));
    }
    if status == 403 {
        return Some((
            "EH_ACCESS_BLOCKED",
            "E-Hentai access was blocked".into(),
            false,
        ));
    }
    if status == 404
        || lower.contains("gallery not found")
        || lower.contains("gallery does not exist")
        || lower.contains("gallery has been removed")
    {
        return Some((
            "EH_GALLERY_DELETED",
            "E-Hentai gallery was deleted or not found".into(),
            false,
        ));
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
        keyring::Entry::new(COOKIE_SERVICE, reference)
            .map_err(|e| e.to_string())?
            .set_password(cookie)
            .map_err(|e| e.to_string())
    }
    fn delete_cookie(&self, reference: &str) -> Result<(), String> {
        keyring::Entry::new(COOKIE_SERVICE, reference)
            .map_err(|e| e.to_string())?
            .delete_credential()
            .map_err(|e| e.to_string())
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
    pub assets: Option<EhAccountAssets>,
    pub exhentai_access: Option<bool>,
}

fn read_account(connection: &Connection, id: &str) -> Result<EhAccountRecord, String> {
    connection.query_row(
        "SELECT id,label,host,username_hint,cookie_ref,is_active,status,created_at,updated_at,gp,credits,hath,exhentai_access FROM eh_accounts WHERE id=?1",
        params![id], |row| Ok(EhAccountRecord { id: row.get(0)?, label: row.get(1)?, host: row.get(2)?, username_hint: row.get(3)?, cookie_ref: row.get(4)?, is_active: row.get::<_, i64>(5)? != 0, status: row.get(6)?, created_at: row.get(7)?, updated_at: row.get(8)?, assets: match (row.get(9)?, row.get(10)?, row.get(11)?) { (Some(gp), Some(credits), Some(hath)) => Some(EhAccountAssets { gp, credits, hath }), _ => None }, exhentai_access: row.get::<_, Option<i64>>(12)?.map(|value| value != 0) }))
        .map_err(|e| e.to_string())
}

pub fn save_eh_account_record(
    connection: &mut Connection,
    store: &dyn EhCookieStore,
    input: SaveEhAccountInput,
) -> CommandResult<EhAccountRecord> {
    if input.id.trim().is_empty()
        || input.label.trim().is_empty()
        || input.cookie.is_empty()
        || !matches!(input.host.as_str(), "e-hentai.org" | "exhentai.org")
    {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid E-Hentai account", false);
    }
    let cookie_ref = format!("eh-{}-{}", input.id, uuid_suffix());
    if let Err(error) = store.set_cookie(&cookie_ref, &input.cookie) {
        return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false);
    }
    let old_ref: Option<String> = connection
        .query_row(
            "SELECT cookie_ref FROM eh_accounts WHERE id=?1",
            params![input.id],
            |row| row.get(0),
        )
        .ok();
    let transaction = match connection.transaction() {
        Ok(tx) => tx,
        Err(error) => {
            let _ = store.delete_cookie(&cookie_ref);
            return CommandResult::failure("UNKNOWN", error.to_string(), true);
        }
    };
    // The cookie has already passed the same structural validation used by
    // JHenTai (member id + pass hash). A network health probe is deliberately
    // not part of saving: Cloudflare can reject that probe while the browser
    // session itself is valid.
    let result = transaction.execute("INSERT INTO eh_accounts (id,label,host,username_hint,cookie_ref,status) VALUES (?1,?2,?3,?4,?5,'verified') ON CONFLICT(id) DO UPDATE SET label=excluded.label,host=excluded.host,username_hint=excluded.username_hint,cookie_ref=excluded.cookie_ref,is_active=1,status='verified',updated_at=CURRENT_TIMESTAMP", params![input.id, input.label.trim(), input.host, input.username_hint, cookie_ref]);
    if let Err(error) = result {
        let _ = store.delete_cookie(&cookie_ref);
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    let account = match read_account(&transaction, &input.id) {
        Ok(value) => value,
        Err(error) => {
            let _ = store.delete_cookie(&cookie_ref);
            return CommandResult::failure("UNKNOWN", error, true);
        }
    };
    if let Err(error) = transaction.commit() {
        let _ = store.delete_cookie(&cookie_ref);
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    if let Some(old_ref) = old_ref {
        if old_ref != account.cookie_ref {
            let _ = store.delete_cookie(&old_ref);
        }
    }
    CommandResult::success(account)
}

fn uuid_suffix() -> String {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0_u8; 8];
    let _ = SystemRandom::new().fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[tauri::command]
pub fn save_eh_account(
    input: SaveEhAccountInput,
    database: State<'_, Database>,
) -> CommandResult<EhAccountRecord> {
    let mut connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    save_eh_account_record(&mut connection, &SystemEhCookieStore, input)
}

#[tauri::command]
pub fn list_eh_accounts(database: State<'_, Database>) -> CommandResult<Vec<EhAccountRecord>> {
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let mut statement = match connection.prepare("SELECT id,label,host,username_hint,cookie_ref,is_active,status,created_at,updated_at,gp,credits,hath,exhentai_access FROM eh_accounts ORDER BY label COLLATE NOCASE,id") { Ok(value) => value, Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true) };
    let rows = match statement.query_map([], |row| {
        Ok(EhAccountRecord {
            id: row.get(0)?,
            label: row.get(1)?,
            host: row.get(2)?,
            username_hint: row.get(3)?,
            cookie_ref: row.get(4)?,
            is_active: row.get::<_, i64>(5)? != 0,
            status: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
            assets: match (row.get(9)?, row.get(10)?, row.get(11)?) {
                (Some(gp), Some(credits), Some(hath)) => {
                    Some(EhAccountAssets { gp, credits, hath })
                }
                _ => None,
            },
            exhentai_access: row.get::<_, Option<i64>>(12)?.map(|value| value != 0),
        })
    }) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("UNKNOWN", error.to_string(), true),
    };
    CommandResult::success(rows.filter_map(Result::ok).collect())
}

#[tauri::command]
pub fn read_eh_account_cookie(
    account_id: String,
    database: State<'_, Database>,
) -> CommandResult<String> {
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match read_account_cookie(&connection, &SystemEhCookieReader, &account_id) {
        Ok((cookie, _, _)) => CommandResult::success(cookie),
        Err(error) => CommandResult::failure("EH_UNAVAILABLE", error, true),
    }
}

#[tauri::command]
pub fn remove_eh_account(account_id: String, database: State<'_, Database>) -> CommandResult<()> {
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let cookie_ref: Option<String> = connection
        .query_row(
            "SELECT cookie_ref FROM eh_accounts WHERE id=?1",
            params![account_id],
            |row| row.get(0),
        )
        .ok();
    let Some(cookie_ref) = cookie_ref else {
        return CommandResult::failure("UNKNOWN", "Account not found", false);
    };
    if let Err(error) =
        connection.execute("DELETE FROM eh_accounts WHERE id=?1", params![account_id])
    {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    let _ = SystemEhCookieStore.delete_cookie(&cookie_ref);
    CommandResult::success(())
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

fn build_search_url(
    host: &str,
    query: &str,
    params: Option<EhSearchParams>,
) -> Result<Url, String> {
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
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
        .build()
        .map_err(|error| error.to_string())
}

async fn read_http_response(request: reqwest::RequestBuilder) -> Result<(u16, String), String> {
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| error.to_string())?;
    Ok((status, body))
}

async fn read_http_response_with_cookies(
    request: reqwest::RequestBuilder,
) -> Result<(u16, String, Vec<String>), String> {
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let cookies = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect::<Vec<_>>();
    let body = response.text().await.map_err(|error| error.to_string())?;
    Ok((status, body, cookies))
}

fn cookie_header_from_all_pairs<'a>(
    pairs: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Option<String> {
    let mut values = Vec::<(String, String)>::new();
    for (name, value) in pairs {
        let name = name.trim();
        let value = value.trim();
        if name.is_empty()
            || value.is_empty()
            || value == "deleted"
            || name.eq_ignore_ascii_case("cookie")
        {
            continue;
        }
        if let Some(existing) = values
            .iter_mut()
            .find(|(existing, _)| existing.eq_ignore_ascii_case(name))
        {
            existing.1 = value.to_string();
        } else {
            values.push((name.to_string(), value.to_string()));
        }
    }
    (!values.is_empty()).then(|| {
        values
            .into_iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ")
    })
}

/// JHenTai's login state is based on the two authentication cookies, not on a
/// page's wording. Keep the same structural check here so a Cloudflare page
/// cannot turn a valid browser session into a false negative.
fn has_valid_authentication_cookie(cookie: &str) -> bool {
    let mut member_id = None;
    let mut pass_hash = None;
    for part in cookie.split(';') {
        let Some((name, value)) = part.trim().split_once('=') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "ipb_member_id" => member_id = Some(value.trim()),
            "ipb_pass_hash" => pass_hash = Some(value.trim()),
            _ => {}
        }
    }
    matches!((member_id, pass_hash), (Some(id), Some(hash))
        if id.chars().all(|c| c.is_ascii_digit())
            && !id.is_empty()
            && hash.len() == 32
            && hash.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn cookie_value(cookie: &str, wanted: &str) -> Option<String> {
    cookie.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name.trim().eq_ignore_ascii_case(wanted) && !value.trim().is_empty())
            .then(|| value.trim().to_string())
    })
}

/// ExHentai issues `igneous` from the EH authentication pair. Sending an old
/// `igneous` makes it answer with `mystery`, so the refresh request deliberately
/// omits every optional cookie, matching JHenTai's refresh flow.
fn eh_auth_cookie_for_ex_probe(cookie: &str) -> String {
    let member_id = cookie_value(cookie, "ipb_member_id").unwrap_or_default();
    let pass_hash = cookie_value(cookie, "ipb_pass_hash").unwrap_or_default();
    format!("ipb_member_id={member_id}; ipb_pass_hash={pass_hash}; nw=1")
}

fn merge_igneous_cookie(cookie: &str, set_cookie_values: &[String]) -> Option<String> {
    let igneous = set_cookie_values.iter().find_map(|header| {
        header.split(';').find_map(|part| {
            let (name, value) = part.trim().split_once('=')?;
            let value = value.trim();
            (name.eq_ignore_ascii_case("igneous")
                && !value.is_empty()
                && value != "mystery"
                && value != "deleted")
                .then(|| value.to_string())
        })
    })?;
    let mut pairs = cookie
        .split(';')
        .filter_map(|part| {
            let (name, value) = part.trim().split_once('=')?;
            (!name.eq_ignore_ascii_case("igneous"))
                .then(|| (name.trim().to_string(), value.trim().to_string()))
        })
        .collect::<Vec<_>>();
    pairs.push(("igneous".into(), igneous));
    cookie_header_from_all_pairs(
        pairs
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
    )
    .filter(|value| has_valid_authentication_cookie(value))
}

fn cookie_without_igneous(cookie: &str) -> String {
    cookie_header_from_all_pairs(cookie.split(';').filter_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (!name.trim().eq_ignore_ascii_case("igneous")).then_some((name, value))
    }))
    .unwrap_or_default()
}

fn should_retry_stale_igneous(cookie: &str, status: u16, body: &str) -> bool {
    let has_stale_igneous = cookie_value(cookie, "igneous").is_some_and(|value| {
        !value.eq_ignore_ascii_case("mystery") && !value.eq_ignore_ascii_case("deleted")
    });
    let lower = body.to_ascii_lowercase();
    has_stale_igneous
        && (lower.contains("sad panda")
            || matches!(
                classify_eh_status(status, body).map(|(code, _, _)| code),
                Some("EH_REAUTH_REQUIRED" | "EH_CONTENT_WARNING")
            ))
}

/// Keeps the browser's full EH cookie header current after an authenticated
/// response. `Set-Cookie` attributes are deliberately discarded: only the
/// first name/value pair belongs in a request Cookie header.
fn merge_cookie_headers(cookie: &str, set_cookie_values: &[String]) -> Option<String> {
    let mut pairs = cookie
        .split(';')
        .filter_map(|part| {
            let (name, value) = part.trim().split_once('=')?;
            (!name.trim().is_empty()).then(|| (name.trim().to_string(), value.trim().to_string()))
        })
        .collect::<Vec<_>>();
    let original = cookie_header_from_all_pairs(
        pairs
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
    );
    for header in set_cookie_values {
        let Some((name, value)) = header
            .split(';')
            .next()
            .and_then(|pair| pair.trim().split_once('='))
        else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if name.is_empty() {
            continue;
        }
        if value.is_empty() || value.eq_ignore_ascii_case("deleted") {
            pairs.retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
        } else if let Some(existing) = pairs
            .iter_mut()
            .find(|(existing, _)| existing.eq_ignore_ascii_case(name))
        {
            existing.1 = value.to_string();
        } else {
            pairs.push((name.to_string(), value.to_string()));
        }
    }
    let merged = cookie_header_from_all_pairs(
        pairs
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
    );
    (merged != original).then_some(merged).flatten()
}

/// Collects the two authentication cookies out of a login response's
/// `set-cookie` headers. Extracted so the parsing is testable without network.
fn extract_login_cookie(set_cookie_values: &[String]) -> Option<String> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    for header in set_cookie_values {
        let Some(pair) = header.split(';').next() else {
            continue;
        };
        let mut parts = pair.splitn(2, '=');
        pairs.push((
            parts.next().unwrap_or("").to_string(),
            parts.next().unwrap_or("").to_string(),
        ));
    }
    cookie_header_from_all_pairs(
        pairs
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
    )
    .filter(|cookie| has_valid_authentication_cookie(cookie))
}

/// Why a sign-in POST came back without the authentication cookies.
///
/// Every one of these used to be reported as `EH_REAUTH_REQUIRED`, which the UI
/// presents as "your E-Hentai login has expired, reconfigure the cookie" — twice
/// wrong on a first sign-in, since nothing was configured and nothing expired.
/// The login form page itself matches the generic classifier's login patterns,
/// so this cannot delegate to `classify_eh_status`.
fn classify_eh_login_failure(status: u16, body: &str) -> (&'static str, String, bool) {
    let lower = body.to_lowercase();
    if lower.contains("cf-browser-verification")
        || lower.contains("_cf_chl_opt")
        || lower.contains("cf-challenge")
        || lower.contains("just a moment")
        || lower.contains("checking your browser")
    {
        return (
            "EH_CLOUDFLARE",
            "Cloudflare 验证拦截了登录请求，请改用网页登录".into(),
            false,
        );
    }
    if lower.contains("ip address has been temporarily banned")
        || lower.contains("ip address has been banned")
    {
        return (
            "EH_ACCESS_BLOCKED",
            "E-Hentai 暂时封禁了当前 IP，请稍后再试".into(),
            false,
        );
    }
    if status == 429 || lower.contains("too many login attempts") || lower.contains("rate limit") {
        return ("EH_RATE_LIMIT", "登录尝试过于频繁，请稍后再试".into(), true);
    }
    if status >= 500 {
        return (
            "EH_UNAVAILABLE",
            "E-Hentai 论坛暂时不可用，请稍后再试".into(),
            true,
        );
    }
    ("EH_LOGIN_REJECTED", "用户名或密码不正确".into(), false)
}

/// Signs in on the E-Hentai forums and returns the cookie string the app stores.
/// Users should not have to copy cookies out of a browser by hand.
#[tauri::command]
pub async fn login_eh_account(
    username: String,
    password: String,
) -> Result<CommandResult<String>, String> {
    if username.trim().is_empty() || password.is_empty() {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "用户名与密码不能为空",
            false,
        ));
    }
    // No redirect following here, unlike every other request: the forums answer a
    // successful sign-in with a redirect, and the authentication cookies are set
    // on *that* response. Following it leaves only the destination's headers,
    // which carry no cookies — a successful login then looks like a rejected one.
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())
    {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "EH_UNAVAILABLE",
                format!("无法创建登录请求：{error}"),
                true,
            ))
        }
    };
    let response = client
        .post("https://forums.e-hentai.org/index.php?act=Login&CODE=01")
        .form(&[
            ("CookieDate", "1"),
            ("b", ""),
            ("bt", ""),
            ("UserName", username.trim()),
            ("PassWord", password.as_str()),
            ("ipb_login_submit", "Login!"),
        ])
        .send()
        .await;
    let response = match response {
        Ok(value) => value,
        Err(error) => {
            return Ok(CommandResult::failure(
                "EH_UNAVAILABLE",
                format!("无法连接 E-Hentai 论坛：{error}"),
                true,
            ))
        }
    };
    let status = response.status().as_u16();
    let cookies = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect::<Vec<_>>();
    match extract_login_cookie(&cookies) {
        Some(cookie) => Ok(CommandResult::success(cookie)),
        None => {
            let body = response.text().await.unwrap_or_default();
            let (code, message, retryable) = classify_eh_login_failure(status, &body);
            Ok(CommandResult::failure(code, message, retryable))
        }
    }
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
        return CommandResult::failure(
            "EH_EMPTY_RESPONSE",
            "E-Hentai returned an empty response",
            true,
        );
    }
    let galleries = parse_search_results(&body);
    CommandResult::success(EhSearchResponse { galleries })
}

// ── Web sign-in ───────────────────────────────────────────────────────────
//
// A Cloudflare challenge is a browser check. No credential makes a reqwest POST
// pass it, so `login_eh_account` had nothing to offer but "try again later" and
// the only way in was pasting cookies copied out of another browser by hand.
// JHenTai's answer is to show E-Hentai's own page, let the person clear the
// challenge and sign in there, and then read the cookies out of the webview —
// which is what these three commands are.

/// The sign-in window's label, so a second request focuses the window that is
/// already open instead of stacking another one on top of it.
const LOGIN_WINDOW_LABEL: &str = "eh-login";
const LOGIN_WINDOW_URL: &str = "https://forums.e-hentai.org/index.php?act=Login&CODE=00";
/// Where the session cookies live. The forums set them for the whole domain, and
/// `igneous` only ever comes from ExHentai.
const COOKIE_ORIGINS: [&str; 3] = [
    "https://forums.e-hentai.org",
    "https://e-hentai.org",
    "https://exhentai.org",
];

#[tauri::command]
pub async fn open_eh_login_window(app: tauri::AppHandle) -> Result<CommandResult<()>, String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(CommandResult::success(()));
    }
    let url = match LOGIN_WINDOW_URL.parse::<Url>() {
        Ok(url) => url,
        Err(error) => return Ok(CommandResult::failure("UNKNOWN", error.to_string(), false)),
    };
    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        LOGIN_WINDOW_LABEL,
        tauri::WebviewUrl::External(url),
    )
    .title("登录 E-Hentai")
    .inner_size(980.0, 780.0);
    // Keep this store across login attempts so a solved Cloudflare challenge
    // remains available, but isolate it from the application's own WebView
    // profile. Sharing `data/webview` made unrelated navigation and stale
    // credentials leak into the login window.
    #[cfg(target_os = "windows")]
    let builder = builder.data_directory(
        crate::data_paths::data_dir(&app)
            .map_err(|error| error.to_string())?
            .join("eh-login-webview"),
    );
    match builder.build() {
        Ok(_) => Ok(CommandResult::success(())),
        Err(error) => Ok(CommandResult::failure(
            "PLATFORM_UNAVAILABLE",
            error.to_string(),
            false,
        )),
    }
}

/// The cookie header if the sign-in window has one yet, `None` while it does not.
///
/// Async on purpose: reading the cookie store from a synchronous command
/// deadlocks on Windows (wry#583). The caller polls this while the window is
/// open rather than guessing when the user has finished.
#[tauri::command]
pub async fn capture_eh_login_cookies(
    app: tauri::AppHandle,
) -> Result<CommandResult<Option<String>>, String> {
    use tauri::Manager;
    let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) else {
        return Ok(CommandResult::failure(
            "EH_LOGIN_WINDOW_CLOSED",
            "登录窗口已关闭",
            false,
        ));
    };
    let mut pairs: Vec<(String, String)> = Vec::new();
    for origin in COOKIE_ORIGINS {
        let Ok(url) = origin.parse::<Url>() else {
            continue;
        };
        match window.cookies_for_url(url) {
            Ok(cookies) => pairs.extend(
                cookies
                    .into_iter()
                    .map(|cookie| (cookie.name().to_string(), cookie.value().to_string())),
            ),
            // A cookie store that cannot be read is not a failed sign-in; the
            // next poll tries again.
            Err(_) => continue,
        }
    }
    Ok(CommandResult::success(
        cookie_header_from_all_pairs(
            pairs
                .iter()
                .map(|(name, value)| (name.as_str(), value.as_str())),
        )
        .filter(|cookie| has_valid_authentication_cookie(cookie)),
    ))
}

#[tauri::command]
pub async fn close_eh_login_window(app: tauri::AppHandle) -> Result<CommandResult<()>, String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = window.close();
    }
    Ok(CommandResult::success(()))
}

#[cfg(test)]
async fn search_eh_galleries_impl(
    connection: &Connection,
    reader: &dyn EhCookieReader,
    account_id: &str,
    query: &str,
    params: Option<EhSearchParams>,
) -> CommandResult<EhSearchResponse> {
    if query.trim().is_empty() {
        return CommandResult::failure(
            "INVALID_RESPONSE",
            "E-Hentai search query must not be empty",
            false,
        );
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
        let title = extract_between(entry, "<a href=\"", "</a>")
            .and_then(|s| {
                let after_href = s.rsplit_once('\"').map(|(_, v)| v)?;
                Some(strip_tags(after_href))
            })
            .unwrap_or_default();
        let category = extract_between(entry, "class=\"gl5\">", "</span>")
            .map(strip_tags)
            .unwrap_or_default();
        let uploader = extract_between(entry, "class=\"gl6\">", "</div>")
            .map(strip_tags)
            .unwrap_or_default();
        let page_text = extract_between(entry, "class=\"gl7\">", "</div>").unwrap_or_default();
        let page_count = page_text
            .chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .unwrap_or(0);
        if !gallery_key.is_empty() && !title.is_empty() {
            results.push(EhSearchResult {
                gallery_key: gallery_key.to_string(),
                url: url.to_string(),
                title,
                category,
                uploader,
                page_count,
                tags: Vec::new(),
            });
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
pub async fn search_eh_galleries(
    account_id: String,
    query: String,
    params: Option<EhSearchParams>,
    database: State<'_, Database>,
) -> Result<CommandResult<EhSearchResponse>, String> {
    if query.trim().is_empty() {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "E-Hentai search query must not be empty",
            false,
        ));
    }
    let (cookie, host, _cookie_ref) = {
        let connection = match database.connection.lock() {
            Ok(value) => value,
            Err(_) => {
                return Ok(CommandResult::failure(
                    "UNKNOWN",
                    "Database lock failed",
                    true,
                ))
            }
        };
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

async fn remove_eh_favorite_request(
    cookie: &str,
    host: &str,
    gallery_id: &str,
    token: &str,
) -> CommandResult<()> {
    let url = format!("https://{host}/gallerypopups.php");
    let client = match eh_http_client() {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    let request = client
        .post(url)
        .query(&[("gid", gallery_id), ("t", token), ("act", "addfav")])
        .header("Cookie", cookie)
        .form(&[
            ("favcat", "favdel"),
            ("favnote", ""),
            ("apply", "Apply Changes"),
            ("update", "1"),
        ]);
    let (status, body) = match read_http_response(request).await {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    if let Some((code, message, retryable)) = classify_eh_status(status, &body) {
        return CommandResult::failure(code, message, retryable);
    }
    CommandResult::success(())
}

#[cfg(test)]
async fn remove_eh_favorite_impl(
    connection: &Connection,
    reader: &dyn EhCookieReader,
    account_id: &str,
    gallery_id: &str,
    token: &str,
) -> CommandResult<()> {
    if !gallery_id.chars().all(|c| c.is_ascii_digit())
        || !token.chars().all(|c| c.is_ascii_hexdigit())
    {
        return CommandResult::failure(
            "INVALID_RESPONSE",
            "Invalid E-Hentai favorite input",
            false,
        );
    }
    let (cookie, host, _cookie_ref) = match read_account_cookie(connection, reader, account_id) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    remove_eh_favorite_request(&cookie, &host, gallery_id, token).await
}

#[tauri::command]
pub async fn remove_eh_favorite(
    account_id: String,
    gallery_id: String,
    token: String,
    database: State<'_, Database>,
) -> Result<CommandResult<()>, String> {
    if gallery_id.is_empty()
        || token.is_empty()
        || !gallery_id.chars().all(|c| c.is_ascii_digit())
        || !token.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "Invalid E-Hentai favorite input",
            false,
        ));
    }
    let (cookie, host, _cookie_ref) = {
        let connection = match database.connection.lock() {
            Ok(value) => value,
            Err(_) => {
                return Ok(CommandResult::failure(
                    "UNKNOWN",
                    "Database lock failed",
                    true,
                ))
            }
        };
        match read_account_cookie(&connection, &SystemEhCookieReader, &account_id) {
            Ok(value) => value,
            Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
        }
    };
    Ok(remove_eh_favorite_request(&cookie, &host, &gallery_id, &token).await)
}

// ── vote_eh_comment ───────────────────────────────────────────────────────

fn vote_eh_comment_form(
    gallery_id: &str,
    token: &str,
    comment_id: &str,
    vote: i32,
) -> [(String, String); 5] {
    [
        ("gid".to_string(), gallery_id.to_string()),
        ("t".to_string(), token.to_string()),
        ("act".to_string(), "votecomment".to_string()),
        ("comment_id".to_string(), comment_id.to_string()),
        ("comment_vote".to_string(), vote.to_string()),
    ]
}

async fn vote_eh_comment_request(
    cookie: &str,
    host: &str,
    gallery_id: &str,
    token: &str,
    comment_id: &str,
    vote: i32,
) -> CommandResult<()> {
    let url = format!("https://{host}/gallerypopups.php");
    let client = match eh_http_client() {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    let form = vote_eh_comment_form(gallery_id, token, comment_id, vote);
    let (status, body) =
        match read_http_response(client.post(url).header("Cookie", cookie).form(&form)).await {
            Ok(value) => value,
            Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
        };
    if let Some((code, message, retryable)) = classify_eh_status(status, &body) {
        return CommandResult::failure(code, message, retryable);
    }
    CommandResult::success(())
}

#[cfg(test)]
async fn vote_eh_comment_impl(
    connection: &Connection,
    reader: &dyn EhCookieReader,
    account_id: &str,
    gallery_id: &str,
    token: &str,
    comment_id: &str,
    vote: i32,
) -> CommandResult<()> {
    if !gallery_id.chars().all(|c| c.is_ascii_digit())
        || !token.chars().all(|c| c.is_ascii_hexdigit())
        || !comment_id.chars().all(|c| c.is_ascii_digit())
        || (vote != 1 && vote != -1)
    {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid E-Hentai vote input", false);
    }
    let (cookie, host, _cookie_ref) = match read_account_cookie(connection, reader, account_id) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    vote_eh_comment_request(&cookie, &host, gallery_id, token, comment_id, vote).await
}

#[tauri::command]
pub async fn vote_eh_comment(
    account_id: String,
    gallery_id: String,
    token: String,
    comment_id: String,
    vote: i32,
    database: State<'_, Database>,
) -> Result<CommandResult<()>, String> {
    if !gallery_id.chars().all(|c| c.is_ascii_digit())
        || !token.chars().all(|c| c.is_ascii_hexdigit())
        || !comment_id.chars().all(|c| c.is_ascii_digit())
        || (vote != 1 && vote != -1)
    {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "Invalid E-Hentai vote input",
            false,
        ));
    }
    let (cookie, host, _cookie_ref) = {
        let connection = match database.connection.lock() {
            Ok(value) => value,
            Err(_) => {
                return Ok(CommandResult::failure(
                    "UNKNOWN",
                    "Database lock failed",
                    true,
                ))
            }
        };
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
    pub username: Option<String>,
    pub assets: EhAccountAssets,
    /// `None` means the ExHentai probe was inconclusive (network or challenge).
    /// It must not erase a previously known access state.
    pub exhentai_access: Option<bool>,
}

#[derive(Debug, Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EhAccountAssets {
    pub gp: String,
    pub credits: String,
    pub hath: String,
}

fn text_after_marker(html: &str, marker: &str, limit: usize) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(start) = lower.find(&marker.to_ascii_lowercase()) else {
        return String::new();
    };
    let end = (start + limit).min(html.len());
    let end = (start..=end)
        .rev()
        .find(|index| html.is_char_boundary(*index))
        .unwrap_or(start);
    decode_html_text(&strip_tags(&html[start..end]))
}

fn amount_before_label(text: &str, label: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let Some(label_start) = lower.find(&label.to_ascii_lowercase()) else {
        return String::new();
    };
    text[..label_start]
        .split_whitespace()
        .last()
        .filter(|value| value.chars().any(|ch| ch.is_ascii_digit()))
        .unwrap_or_default()
        .trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != ',' && ch != '.')
        .to_string()
}

fn amount_near_label(text: &str, label: &str) -> String {
    fn numeric_token(value: &str, reverse: bool) -> String {
        let bytes = value.as_bytes();
        let Some(seed) = (if reverse {
            bytes.iter().rposition(|byte| byte.is_ascii_digit())
        } else {
            bytes.iter().position(|byte| byte.is_ascii_digit())
        }) else {
            return String::new();
        };
        let mut start = seed;
        let mut end = seed + 1;
        while start > 0 && matches!(bytes[start - 1], b'0'..=b'9' | b',' | b'.') {
            start -= 1;
        }
        while end < bytes.len() && matches!(bytes[end], b'0'..=b'9' | b',' | b'.') {
            end += 1;
        }
        value[start..end].to_string()
    }
    let lower = text.to_ascii_lowercase();
    let label_lower = label.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find(&label_lower) {
        let start = cursor + relative;
        let end = (start + label.len()).min(text.len());
        let before_start = start.saturating_sub(96);
        let after_end = (end + 96).min(text.len());
        let before = &text[before_start..start];
        let after = &text[end..after_end];
        let after_number = numeric_token(after, false);
        if !after_number.is_empty() {
            return after_number;
        }
        let before_number = numeric_token(before, true);
        if !before_number.is_empty() {
            return before_number;
        }
        cursor = end;
    }
    String::new()
}

fn parse_forum_username(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find("<a") {
        let link = cursor + relative;
        let Some(gt_relative) = lower[link..].find('>') else {
            break;
        };
        let gt = link + gt_relative;
        let attrs = &lower[link..gt];
        let candidate = attrs.contains("class=\"home\"")
            || attrs.contains("class='home'")
            || attrs.contains("showuser=");
        let content_start = gt + 1;
        let Some(content_relative_end) = lower[content_start..].find("</a>") else {
            break;
        };
        let content_end = content_start + content_relative_end;
        if candidate {
            let username = decode_html_text(&strip_tags(&html[content_start..content_end]));
            if !username.trim().is_empty() && !username.to_ascii_lowercase().contains("login") {
                return Some(username.trim().to_string());
            }
        }
        cursor = content_end + 4;
    }
    None
}

fn parse_exchange_assets(html: &str) -> EhAccountAssets {
    let plain = decode_html_text(&strip_tags(html));
    let credits_text = text_after_marker(html, "id=\"buyform\"", 1400);
    let credits_text = if credits_text.is_empty() {
        text_after_marker(html, "id='buyform'", 1400)
    } else {
        credits_text
    };
    let gp_text = text_after_marker(html, "id=\"sellform\"", 1400);
    let gp_text = if gp_text.is_empty() {
        text_after_marker(html, "id='sellform'", 1400)
    } else {
        gp_text
    };
    let gp = amount_before_label(&gp_text, "GP");
    let credits = amount_before_label(&credits_text, "Credits");
    EhAccountAssets {
        gp: if gp.is_empty() {
            amount_near_label(&plain, "GP")
        } else {
            gp
        },
        credits: if credits.is_empty() {
            amount_near_label(&plain, "Credits")
        } else {
            credits
        },
        hath: String::new(),
    }
}

fn parse_hath_assets(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(start) = lower.find("you currently have") {
        let value = amount_before_label(&decode_html_text(&strip_tags(&html[start..])), "Hath");
        if !value.is_empty() {
            return value;
        }
    }
    amount_near_label(&decode_html_text(&strip_tags(html)), "Hath")
}

fn exhentai_page_accessible(status: u16, body: &str) -> bool {
    if !(200..300).contains(&status) || body.len() < 500 {
        return false;
    }
    let lower = body.to_ascii_lowercase();
    !lower.contains("sad panda")
        && !lower.contains("igneous=mystery")
        && classify_eh_login_health(status, body).is_none()
        && !lower.contains("cf-browser-verification")
        && !lower.contains("_cf_chl_opt")
        && !lower.contains("just a moment")
}

async fn get_text(client: &reqwest::Client, url: &str, cookie: &str) -> Option<(u16, String)> {
    read_http_response(client.get(url).header("Cookie", cookie))
        .await
        .ok()
}

fn classify_exhentai_probe(status: u16, body: &str) -> Option<bool> {
    if status < 200 || status >= 500 || body.trim().is_empty() {
        return None;
    }
    let lower = body.to_ascii_lowercase();
    if lower.contains("cf-browser-verification")
        || lower.contains("_cf_chl_opt")
        || lower.contains("cf-challenge")
        || lower.contains("just a moment")
        || lower.contains("checking your browser")
    {
        return None;
    }
    Some(exhentai_page_accessible(status, body))
}

async fn probe_exhentai(cookie: &str) -> (Option<bool>, Option<String>) {
    let auth_cookie = eh_auth_cookie_for_ex_probe(cookie);
    let probe_client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(value) => value,
        Err(_) => return (None, None),
    };
    let first = read_http_response_with_cookies(
        probe_client
            .get("https://exhentai.org/")
            .header("Cookie", &auth_cookie),
    )
    .await;
    let Ok((first_status, first_body, set_cookies)) = first else {
        return (None, None);
    };
    let refreshed_cookie = merge_igneous_cookie(cookie, &set_cookies);
    if let Some(accessible) = classify_exhentai_probe(first_status, &first_body) {
        if accessible {
            return (Some(true), refreshed_cookie);
        }
    }
    let Some(ref cookie_with_igneous) = refreshed_cookie else {
        return (classify_exhentai_probe(first_status, &first_body), None);
    };
    let retry = read_http_response_with_cookies(
        probe_client
            .get("https://exhentai.org/")
            .header("Cookie", cookie_with_igneous),
    )
    .await
    .ok();
    let refreshed_cookie = retry
        .as_ref()
        .and_then(|(_, _, set_cookies)| merge_igneous_cookie(cookie_with_igneous, set_cookies))
        .or(refreshed_cookie);
    let result = retry
        .as_ref()
        .and_then(|(status, body, _)| classify_exhentai_probe(*status, body))
        .or_else(|| classify_exhentai_probe(first_status, &first_body));
    (result, refreshed_cookie)
}

async fn check_eh_login_health_request(
    cookie: &str,
    member_id: &str,
) -> (CommandResult<LoginHealthResult>, Option<String>) {
    if !has_valid_authentication_cookie(cookie) {
        return (
            CommandResult::success(LoginHealthResult {
                logged_in: false,
                username: None,
                assets: EhAccountAssets::default(),
                exhentai_access: Some(false),
            }),
            None,
        );
    }
    let client = match eh_http_client() {
        Ok(value) => value,
        Err(error) => return (CommandResult::failure("EH_UNAVAILABLE", error, true), None),
    };
    let (status, body, set_cookies) = match read_http_response_with_cookies(
        client.get("https://e-hentai.org/").header("Cookie", cookie),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return (CommandResult::failure("EH_UNAVAILABLE", error, true), None),
    };
    // A health probe must not reuse the generic page classifier. The latter
    // intentionally treats phrases such as "not logged in" as an error for
    // gallery/search requests, but those phrases also occur in navigation,
    // help text, and Cloudflare interstitials. With a structurally valid
    // JHenTai cookie only an actual 401 or an unmistakable login page can
    // disprove the session; every other response keeps the account verified.
    if let Some((code, message, retryable)) = classify_eh_login_health(status, &body) {
        return (CommandResult::failure(code, message, retryable), None);
    }
    let refreshed_eh_cookie = merge_cookie_headers(cookie, &set_cookies);
    let cookie = refreshed_eh_cookie
        .clone()
        .unwrap_or_else(|| cookie.to_string());
    let profile_url = format!("https://forums.e-hentai.org/index.php?showuser={member_id}");
    let profile = get_text(&client, &profile_url, &cookie);
    let exchange = get_text(&client, "https://e-hentai.org/exchange.php?t=gp", &cookie);
    let hath = get_text(&client, "https://e-hentai.org/hathperks.php", &cookie);
    let ex = probe_exhentai(&cookie);
    let (profile, exchange, hath, (exhentai_access, refreshed_cookie)) =
        tokio::join!(profile, exchange, hath, ex);
    let username = profile.and_then(|(_, html)| parse_forum_username(&html));
    let mut assets = exchange
        .map(|(_, html)| parse_exchange_assets(&html))
        .unwrap_or_default();
    assets.hath = hath
        .map(|(_, html)| parse_hath_assets(&html))
        .unwrap_or_default();
    (
        CommandResult::success(LoginHealthResult {
            logged_in: true,
            username,
            assets,
            exhentai_access,
        }),
        refreshed_cookie.or(refreshed_eh_cookie),
    )
}

// ── get_eh_comments ──────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EhCommentRecord {
    pub id: String,
    pub author: String,
    pub body: String,
    pub score: i32,
    pub posted_at: String,
    pub is_uploader: bool,
    pub is_editable: bool,
    pub my_vote: i32,
}

fn decode_html_text(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn strip_comment_tags(value: &str) -> String {
    let normalized = value
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("</p>", "\n")
        .replace("</div>", "\n");
    decode_html_text(&strip_tags(&normalized))
}

fn div_inner_at(value: &str, start: usize) -> Option<(&str, usize)> {
    let open_end = value[start..].find('>')? + start + 1;
    let mut depth = 1_usize;
    let mut cursor = open_end;
    while depth > 0 {
        let next_open = value[cursor..].find("<div").map(|offset| cursor + offset);
        let next_close = value[cursor..].find("</div>").map(|offset| cursor + offset);
        match (next_open, next_close) {
            (_, None) => return None,
            (Some(open), Some(close)) if open < close => {
                depth += 1;
                cursor = value[open..].find('>')? + open + 1;
            }
            (_, Some(close)) => {
                depth -= 1;
                if depth == 0 {
                    return Some((&value[open_end..close], close + "</div>".len()));
                }
                cursor = close + "</div>".len();
            }
        }
    }
    None
}

fn comment_field<'a>(chunk: &'a str, class_name: &str) -> Option<&'a str> {
    let marker = format!("class=\"{class_name}\"");
    let start = chunk.find(&marker)?;
    let div_start = chunk[..start].rfind("<div")?;
    div_inner_at(chunk, div_start).map(|(inner, _)| inner)
}

fn comment_vote(chunk: &str, id: &str) -> i32 {
    for (suffix, vote) in [("up", 1), ("down", -1)] {
        let marker = format!("id=\"comment_vote_{suffix}_{id}\"");
        if let Some(position) = chunk.find(&marker) {
            let tag_start = chunk[..position].rfind('<').unwrap_or(position);
            let tag_end = chunk[position..]
                .find('>')
                .map(|offset| position + offset)
                .unwrap_or(position);
            let tag = &chunk[tag_start..=tag_end];
            if tag.contains("style=") || tag.contains("class=\"c2") || tag.contains("class=\"cv") {
                return vote;
            }
        }
    }
    0
}

fn parse_eh_comments(body: &str) -> Vec<EhCommentRecord> {
    let mut comments = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = body[cursor..].find("id=\"comment_") {
        let id_position = cursor + relative + "id=\"comment_".len();
        let Some(id_end) = body[id_position..]
            .find('"')
            .map(|offset| id_position + offset)
        else {
            break;
        };
        let id = body[id_position..id_end].to_string();
        if id.is_empty() || !id.chars().all(|character| character.is_ascii_digit()) {
            cursor = id_end + 1;
            continue;
        }
        let Some(c6_start) = body[..id_position].rfind("<div") else {
            cursor = id_end + 1;
            continue;
        };
        let Some((comment_html, comment_end)) = div_inner_at(body, c6_start) else {
            cursor = id_end + 1;
            continue;
        };
        let c1_marker = body[..c6_start].rfind("class=\"c1\"").unwrap_or(c6_start);
        let chunk_start = body[..c1_marker].rfind("<div").unwrap_or(c1_marker);
        let chunk = &body[chunk_start..comment_end];
        let c3 = comment_field(chunk, "c3").unwrap_or_default();
        let c3_text = strip_comment_tags(c3);
        let author = c3
            .rfind("<a")
            .and_then(|start| {
                let content_start = c3[start..].find('>')? + start + 1;
                let content_end = c3[content_start..].find("</a>")? + content_start;
                Some(strip_comment_tags(&c3[content_start..content_end]))
            })
            .unwrap_or_default();
        let posted_at = c3_text
            .strip_prefix("Posted on ")
            .and_then(|value| {
                value
                    .rsplit_once(" by ")
                    .map(|(date, _)| date.trim().to_string())
            })
            .unwrap_or_default();
        let score_text = comment_field(chunk, "c5").unwrap_or_default();
        let score = score_text
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == '-')
            .collect::<String>()
            .parse()
            .unwrap_or(0);
        let comment_body = strip_comment_tags(comment_html);
        if !id.is_empty() && !comment_body.is_empty() {
            let my_vote = comment_vote(chunk, &id);
            comments.push(EhCommentRecord {
                id,
                author,
                body: comment_body,
                score,
                posted_at,
                is_uploader: chunk.contains("name=\"ulcomment\"")
                    || chunk.contains("name='ulcomment'"),
                is_editable: chunk.contains("edit_comment(") || chunk.contains("editcomment"),
                my_vote,
            });
        }
        cursor = comment_end.max(id_end + 1);
    }
    comments
}

async fn get_eh_comments_request(
    cookie: &str,
    host: &str,
    gallery_id: &str,
    token: &str,
) -> (CommandResult<Vec<EhCommentRecord>>, Option<String>) {
    let client = match eh_http_client() {
        Ok(value) => value,
        Err(error) => return (CommandResult::failure("EH_UNAVAILABLE", error, true), None),
    };
    let url = format!("https://{host}/g/{gallery_id}/{token}/");
    let (status, body, set_cookies) =
        match read_http_response_with_cookies(client.get(&url).header("Cookie", cookie)).await {
            Ok(value) => value,
            Err(error) => return (CommandResult::failure("EH_UNAVAILABLE", error, true), None),
        };
    if should_retry_stale_igneous(cookie, status, &body) {
        let retry_cookie = cookie_without_igneous(cookie);
        if !retry_cookie.is_empty() {
            if let Ok((retry_status, retry_body, retry_set_cookies)) =
                read_http_response_with_cookies(client.get(&url).header("Cookie", &retry_cookie))
                    .await
            {
                if classify_eh_status(retry_status, &retry_body).is_none() {
                    return (
                        CommandResult::success(parse_eh_comments(&retry_body)),
                        merge_igneous_cookie(cookie, &retry_set_cookies),
                    );
                }
            }
        }
    }
    if let Some((code, message, retryable)) = classify_eh_status(status, &body) {
        return (CommandResult::failure(code, message, retryable), None);
    }
    (
        CommandResult::success(parse_eh_comments(&body)),
        merge_igneous_cookie(cookie, &set_cookies),
    )
}

#[tauri::command]
pub async fn get_eh_comments(
    account_id: String,
    gallery_id: String,
    token: String,
    database: State<'_, Database>,
) -> Result<CommandResult<Vec<EhCommentRecord>>, String> {
    if !gallery_id.chars().all(|c| c.is_ascii_digit())
        || !token.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "Invalid E-Hentai gallery input",
            false,
        ));
    }
    let (cookie, host, cookie_ref) = {
        let connection = match database.connection.lock() {
            Ok(value) => value,
            Err(_) => {
                return Ok(CommandResult::failure(
                    "UNKNOWN",
                    "Database lock failed",
                    true,
                ))
            }
        };
        match read_account_cookie(&connection, &SystemEhCookieReader, &account_id) {
            Ok(value) => value,
            Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
        }
    };
    let (result, refreshed_cookie) =
        get_eh_comments_request(&cookie, &host, &gallery_id, &token).await;
    if let Some(refreshed_cookie) = refreshed_cookie {
        if let Err(error) = SystemEhCookieStore.set_cookie(&cookie_ref, &refreshed_cookie) {
            return Ok(CommandResult::failure("PLATFORM_UNAVAILABLE", error, false));
        }
    }
    Ok(result)
}

async fn post_eh_comment_request(
    cookie: &str,
    host: &str,
    gallery_id: &str,
    token: &str,
    body: &str,
) -> CommandResult<()> {
    let client = match eh_http_client() {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    let url = format!("https://{host}/g/{gallery_id}/{token}/");
    let form = [("commenttext_new", body), ("post_comment", "Post Comment")];
    let (status, response_body) =
        match read_http_response(client.post(url).header("Cookie", cookie).form(&form)).await {
            Ok(value) => value,
            Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
        };
    if let Some((code, message, retryable)) = classify_eh_status(status, &response_body) {
        return CommandResult::failure(code, message, retryable);
    }
    CommandResult::success(())
}

#[tauri::command]
pub async fn post_eh_comment(
    account_id: String,
    gallery_id: String,
    token: String,
    body: String,
    database: State<'_, Database>,
) -> Result<CommandResult<()>, String> {
    if gallery_id.is_empty()
        || !gallery_id.chars().all(|c| c.is_ascii_digit())
        || token.is_empty()
        || !token.chars().all(|c| c.is_ascii_hexdigit())
        || body.trim().is_empty()
    {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "Invalid E-Hentai comment input",
            false,
        ));
    }
    let (cookie, host, _cookie_ref) = {
        let connection = match database.connection.lock() {
            Ok(value) => value,
            Err(_) => {
                return Ok(CommandResult::failure(
                    "UNKNOWN",
                    "Database lock failed",
                    true,
                ))
            }
        };
        match read_account_cookie(&connection, &SystemEhCookieReader, &account_id) {
            Ok(value) => value,
            Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
        }
    };
    Ok(post_eh_comment_request(&cookie, &host, &gallery_id, &token, body.trim()).await)
}

fn classify_eh_login_health(status: u16, body: &str) -> Option<(&'static str, String, bool)> {
    if status == 401 {
        return Some((
            "EH_REAUTH_REQUIRED",
            "E-Hentai login is required".into(),
            false,
        ));
    }
    let lower = body.to_ascii_lowercase();
    // EH's login page has a title and a login form. Requiring both avoids
    // treating ordinary copy containing “please login” as a failed session.
    let login_title = lower.contains("<title>login</title>")
        || lower.contains("<title> log in")
        || lower.contains("<title>e-hentai - login");
    let login_form = lower.contains("name=\"login\"")
        || lower.contains("name='login'")
        || lower.contains("act=login")
        || lower.contains("login.php")
        || lower.contains("name=\"password\"")
        || lower.contains("name='password'");
    if login_title && login_form {
        return Some((
            "EH_REAUTH_REQUIRED",
            "E-Hentai login is required".into(),
            false,
        ));
    }
    None
}

#[cfg(test)]
async fn check_eh_login_health_impl(
    connection: &Connection,
    reader: &dyn EhCookieReader,
    account_id: &str,
) -> CommandResult<LoginHealthResult> {
    let (cookie, _host, _cookie_ref) = match read_account_cookie(connection, reader, account_id) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    let member_id = cookie_value(&cookie, "ipb_member_id").unwrap_or_default();
    check_eh_login_health_request(&cookie, &member_id).await.0
}

#[tauri::command]
pub async fn check_eh_login_health(
    account_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<LoginHealthResult>, String> {
    let (cookie, _host, cookie_ref) = {
        let connection = match database.connection.lock() {
            Ok(value) => value,
            Err(_) => {
                return Ok(CommandResult::failure(
                    "UNKNOWN",
                    "Database lock failed",
                    true,
                ))
            }
        };
        match read_account_cookie(&connection, &SystemEhCookieReader, &account_id) {
            Ok(value) => value,
            Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
        }
    };
    let member_id = cookie_value(&cookie, "ipb_member_id").unwrap_or_default();
    let (result, refreshed_cookie) = check_eh_login_health_request(&cookie, &member_id).await;
    if let Some(refreshed_cookie) = refreshed_cookie {
        if let Err(error) = SystemEhCookieStore.set_cookie(&cookie_ref, &refreshed_cookie) {
            return Ok(CommandResult::failure("PLATFORM_UNAVAILABLE", error, false));
        }
    }
    if let CommandResult::Success { value, .. } = &result {
        if let Ok(connection) = database.connection.lock() {
            let _ = connection.execute(
                "UPDATE eh_accounts SET host=CASE WHEN ?1=1 THEN 'exhentai.org' WHEN ?1=0 THEN 'e-hentai.org' ELSE host END,username_hint=COALESCE(?2,username_hint),status=?3,gp=CASE WHEN length(?4)>0 THEN ?4 ELSE gp END,credits=CASE WHEN length(?5)>0 THEN ?5 ELSE credits END,hath=CASE WHEN length(?6)>0 THEN ?6 ELSE hath END,exhentai_access=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?7",
                params![value.exhentai_access.map(|access| access as i32), value.username, if value.logged_in { "verified" } else { "error" }, value.assets.gp, value.assets.credits, value.assets.hath, account_id],
            );
        }
    }
    Ok(result)
}

// ── set_active_eh_account ─────────────────────────────────────────────────

pub fn set_active_eh_account_impl(
    connection: &mut Connection,
    account_id: &str,
) -> CommandResult<()> {
    let exists: bool = connection
        .query_row(
            "SELECT COUNT(*) FROM eh_accounts WHERE id=?1",
            params![account_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|v| v > 0)
        .unwrap_or(false);
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
    if let Err(error) = transaction.execute(
        "UPDATE eh_accounts SET is_active=1, updated_at=CURRENT_TIMESTAMP WHERE id=?1",
        params![account_id],
    ) {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    if let Err(error) = transaction.commit() {
        return CommandResult::failure("UNKNOWN", error.to_string(), true);
    }
    CommandResult::success(())
}

#[tauri::command]
pub fn set_active_eh_account(
    account_id: String,
    database: State<'_, Database>,
) -> CommandResult<()> {
    let mut connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    set_active_eh_account_impl(&mut connection, &account_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn login_cookie_extraction_keeps_all_cookie_fields() {
        let headers = vec![
            "ipb_member_id=1234; path=/; domain=.e-hentai.org".to_string(),
            "ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90; path=/".to_string(),
            "igneous=abcdef1234; path=/".to_string(),
            "sl=dm_2; path=/".to_string(),
        ];
        assert_eq!(
            extract_login_cookie(&headers).as_deref(),
            Some("ipb_member_id=1234; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90; igneous=abcdef1234; sl=dm_2"),
        );
    }

    #[test]
    fn login_cookie_extraction_rejects_a_failed_sign_in() {
        // A rejected login answers with deletion cookies only.
        let headers = vec![
            "ipb_member_id=deleted; expires=Thu, 01-Jan-1970 00:00:00 GMT".to_string(),
            "ipb_pass_hash=deleted; expires=Thu, 01-Jan-1970 00:00:00 GMT".to_string(),
        ];
        assert_eq!(extract_login_cookie(&headers), None);
        assert_eq!(extract_login_cookie(&[]), None);
    }

    #[test]
    fn login_cookie_extraction_drops_the_mystery_igneous() {
        let headers = vec![
            "ipb_member_id=7; Path=/".to_string(),
            "ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90; Path=/".to_string(),
            "igneous=mystery; Path=/".to_string(),
        ];
        assert_eq!(
            extract_login_cookie(&headers).as_deref(),
            Some(
                "ipb_member_id=7; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90; igneous=mystery"
            ),
        );
    }

    #[test]
    fn login_health_uses_jhentai_cookie_shape_not_page_copy() {
        assert!(has_valid_authentication_cookie(
            "ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90"
        ));
        assert!(!has_valid_authentication_cookie(
            "ipb_member_id=42; ipb_pass_hash=short"
        ));
        assert!(!has_valid_authentication_cookie("igneous=mystery"));
    }

    #[test]
    fn account_profile_parser_reads_forum_username() {
        let html = r#"<div class="home"><b><a href="index.php?showuser=42">Reader &amp; Owner</a></b></div>"#;
        assert_eq!(
            parse_forum_username(html).as_deref(),
            Some("Reader & Owner")
        );
    }

    #[test]
    fn account_profile_parser_reads_username_link_without_home_wrapper() {
        let html = r#"<div id="userlinks"><a href="index.php?act=Login">Log in</a><a href="index.php?showuser=42" class="member-link"><span>Reader</span> &amp; Owner</a></div>"#;
        assert_eq!(
            parse_forum_username(html).as_deref(),
            Some("Reader & Owner")
        );
    }

    #[test]
    fn account_asset_parsers_follow_jhentai_pages() {
        let exchange = r#"
          <form id="buyform"></form><div></div><p>You currently have 6,789 Credits.</p>
          <form id="sellform"></form><div></div><p>You currently have 12,345 GP.</p>
        "#;
        let hath = r#"<div class="stuffbox"><div><p>a</p><p>b</p><p>c</p><p>You currently have 42 Hath available.</p></div></div>"#;
        let assets = parse_exchange_assets(exchange);
        assert_eq!(assets.gp, "12,345");
        assert_eq!(assets.credits, "6,789");
        assert_eq!(parse_hath_assets(hath), "42");
    }

    #[test]
    fn account_asset_parsers_accept_amount_after_currency_label() {
        let exchange =
            r#"<div>GP: <strong>12,345</strong></div><div>Credits: <strong>6,789</strong></div>"#;
        let hath = r#"<div>Hath balance: <strong>42</strong></div>"#;
        let assets = parse_exchange_assets(exchange);
        assert_eq!(assets.gp, "12,345");
        assert_eq!(assets.credits, "6,789");
        assert_eq!(parse_hath_assets(hath), "42");
    }

    #[test]
    fn exhentai_refresh_uses_only_eh_auth_cookies_and_absorbs_igneous() {
        let original = "ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90; igneous=stale; sl=dm_2";
        assert_eq!(
            eh_auth_cookie_for_ex_probe(original),
            "ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90; nw=1"
        );
        let refreshed = merge_igneous_cookie(
            original,
            &["igneous=fresh123; Path=/; Domain=.exhentai.org".into()],
        );
        assert_eq!(refreshed.as_deref(), Some("ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90; sl=dm_2; igneous=fresh123"));
        assert_eq!(
            merge_igneous_cookie(original, &["igneous=mystery; Path=/".into()]),
            None
        );
        assert!(!exhentai_page_accessible(302, ""));
        assert!(!exhentai_page_accessible(200, &"sad panda".repeat(100)));
    }

    #[test]
    fn stale_igneous_session_blocks_are_retryable_without_the_old_cookie() {
        let cookie =
            "ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90; igneous=stale";
        assert!(should_retry_stale_igneous(
            cookie,
            200,
            "<title>Login</title><form name=\"login\"></form>"
        ));
        assert!(should_retry_stale_igneous(
            cookie,
            200,
            "<title>Sad Panda</title>"
        ));
        assert!(!should_retry_stale_igneous(cookie, 403, "Just a moment..."));
        assert!(!should_retry_stale_igneous(
            "ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90",
            200,
            "<title>Login</title><form name=\"login\"></form>"
        ));
    }

    #[test]
    fn exhentai_probe_marks_challenges_unknown_but_real_denials_false() {
        assert_eq!(classify_exhentai_probe(403, "Just a moment..."), None);
        assert_eq!(classify_exhentai_probe(403, "Access denied"), Some(false));
        assert_eq!(classify_exhentai_probe(503, "maintenance"), None);
        assert_eq!(classify_exhentai_probe(200, "sad panda"), Some(false));
        assert_eq!(classify_exhentai_probe(200, ""), None);
    }

    #[test]
    fn health_probe_cookie_merge_keeps_existing_fields_and_absorbs_response_fields() {
        let original = "ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90; sl=dm_2";
        let merged = merge_cookie_headers(
            original,
            &[
                "nw=1; Path=/; Domain=.e-hentai.org".into(),
                "datatags=1; Path=/".into(),
                "sl=dm_3; Path=/".into(),
                "igneous=fresh123; Path=/; Domain=.exhentai.org".into(),
            ],
        );
        assert_eq!(
            merged.as_deref(),
            Some("ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90; sl=dm_3; nw=1; datatags=1; igneous=fresh123")
        );
    }

    #[test]
    fn the_sign_in_window_jar_keeps_all_fields_and_requires_authentication() {
        // The web sign-in path reads name/value pairs from the webview's cookie
        // store rather than `set-cookie` headers, and has to agree with the
        // password path about preserving every cookie field.
        let jar = [
            ("sl", "dm_2"),
            ("ipb_member_id", "42"),
            ("igneous", "mystery"),
            ("ipb_pass_hash", "a1b2c3d4e5f60718293a4b5c6d7e8f90"),
        ];
        let cookie = cookie_header_from_all_pairs(jar).unwrap();
        assert_eq!(cookie, "sl=dm_2; ipb_member_id=42; igneous=mystery; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90");
        assert!(has_valid_authentication_cookie(&cookie));
        // Still signed out: the window is open but nothing has been submitted.
        assert!(!has_valid_authentication_cookie(
            &cookie_header_from_all_pairs([("sl", "dm_2")]).unwrap()
        ));
        assert!(!has_valid_authentication_cookie(
            &cookie_header_from_all_pairs([("ipb_member_id", "42")]).unwrap()
        ));
    }

    #[test]
    fn a_refused_sign_in_never_reports_an_expired_session() {
        // The whole point of the separate code: a first sign-in has no session to
        // expire and no cookie to reconfigure, which is what EH_REAUTH_REQUIRED
        // tells the user to do.
        let cases = [
            (
                200,
                "<title>Login</title>The username or password you entered is incorrect",
                "EH_LOGIN_REJECTED",
            ),
            (
                200,
                "<div id=\"cf-browser-verification\">Just a moment...</div>",
                "EH_CLOUDFLARE",
            ),
            (
                200,
                "Your IP address has been temporarily banned for excessive requests",
                "EH_ACCESS_BLOCKED",
            ),
            (429, "slow down", "EH_RATE_LIMIT"),
            (503, "maintenance", "EH_UNAVAILABLE"),
        ];
        for (status, body, expected) in cases {
            let (code, message, _) = classify_eh_login_failure(status, body);
            assert_eq!(code, expected, "body: {body}");
            assert_ne!(code, "EH_REAUTH_REQUIRED");
            assert!(!message.is_empty());
        }
    }

    struct MemoryStore {
        writes: Mutex<Vec<(String, String)>>,
        deletes: Mutex<Vec<String>>,
    }
    impl EhCookieStore for MemoryStore {
        fn set_cookie(&self, reference: &str, cookie: &str) -> Result<(), String> {
            self.writes
                .lock()
                .unwrap()
                .push((reference.to_string(), cookie.to_string()));
            Ok(())
        }
        fn delete_cookie(&self, reference: &str) -> Result<(), String> {
            self.deletes.lock().unwrap().push(reference.to_string());
            Ok(())
        }
    }

    struct MemoryCookieReader {
        cookies: std::collections::HashMap<String, String>,
    }
    impl EhCookieReader for MemoryCookieReader {
        fn get_cookie(&self, reference: &str) -> Result<String, String> {
            self.cookies
                .get(reference)
                .cloned()
                .ok_or_else(|| format!("cookie not found: {}", reference))
        }
    }

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        c.execute_batch(include_str!("../../migrations/0007_eh_accounts.sql"))
            .unwrap();
        c.execute_batch(include_str!("../../migrations/0020_eh_health_cache.sql"))
            .unwrap();
        c
    }

    fn insert_account(c: &Connection, id: &str, cookie_ref: &str, host: &str, is_active: bool) {
        c.execute("INSERT INTO eh_accounts (id,label,host,cookie_ref,is_active,status) VALUES (?1,?2,?3,?4,?5,'verified')", params![id, id, host, cookie_ref, is_active as i32]).unwrap();
    }

    #[test]
    fn account_keeps_cookie_out_of_sqlite_and_response() {
        let mut c = db();
        let store = MemoryStore {
            writes: Mutex::new(vec![]),
            deletes: Mutex::new(vec![]),
        };
        let result = save_eh_account_record(
            &mut c,
            &store,
            SaveEhAccountInput {
                id: "eh-a".into(),
                label: "EH".into(),
                host: "e-hentai.org".into(),
                username_hint: Some("reader".into()),
                cookie: "ipb=secret".into(),
            },
        );
        let account = match result {
            CommandResult::Success { value, .. } => value,
            _ => panic!("save"),
        };
        assert!(!serde_json::to_string(&account).unwrap().contains("secret"));
        assert_eq!(account.status, "verified");
        let response = serde_json::to_value(CommandResult::success(account)).unwrap();
        assert_eq!(response["ok"], true);
        assert!(response["value"]["id"].is_string());
        assert!(response["value"]["cookieRef"].is_string());
        assert!(response["value"]["isActive"].is_boolean());
        assert!(response["value"]["createdAt"].is_string());
        assert!(response["value"]["updatedAt"].is_string());
        let text: String = c
            .query_row(
                "SELECT id||label||host||cookie_ref FROM eh_accounts",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!text.contains("secret"));
        assert_eq!(store.writes.lock().unwrap().len(), 1);
    }

    // ── search_eh_galleries tests ─────────────────────────────────────────

    #[tokio::test]
    async fn search_rejects_empty_query() {
        let c = db();
        let reader = MemoryCookieReader {
            cookies: std::collections::HashMap::new(),
        };
        let result = search_eh_galleries_impl(&c, &reader, "eh-a", "", None).await;
        match result {
            CommandResult::Failure { ok: false, error } => {
                assert_eq!(error.code, "INVALID_RESPONSE");
            }
            _ => panic!("expected failure"),
        }
    }

    #[tokio::test]
    async fn search_rejects_missing_account() {
        let c = db();
        let reader = MemoryCookieReader {
            cookies: std::collections::HashMap::new(),
        };
        let result = search_eh_galleries_impl(&c, &reader, "nonexistent", "test", None).await;
        match result {
            CommandResult::Failure { ok: false, error } => {
                assert_eq!(error.code, "EH_UNAVAILABLE");
            }
            _ => panic!("expected failure"),
        }
    }

    #[tokio::test]
    async fn search_rejects_when_cookie_missing() {
        let c = db();
        insert_account(&c, "eh-a", "ref-a", "e-hentai.org", true);
        let reader = MemoryCookieReader {
            cookies: std::collections::HashMap::new(),
        };
        let result = search_eh_galleries_impl(&c, &reader, "eh-a", "test", None).await;
        match result {
            CommandResult::Failure { ok: false, error } => {
                assert!(error.message.contains("cookie not found"));
            }
            _ => panic!("expected failure"),
        }
    }

    // ── remove_eh_favorite tests ──────────────────────────────────────────

    #[tokio::test]
    async fn remove_favorite_rejects_invalid_gallery_id() {
        let c = db();
        let reader = MemoryCookieReader {
            cookies: std::collections::HashMap::new(),
        };
        let result = remove_eh_favorite_impl(&c, &reader, "eh-a", "not-a-number", "abc").await;
        match result {
            CommandResult::Failure { ok: false, error } => {
                assert_eq!(error.code, "INVALID_RESPONSE");
            }
            _ => panic!("expected failure"),
        }
    }

    #[tokio::test]
    async fn remove_favorite_rejects_invalid_token() {
        let c = db();
        let reader = MemoryCookieReader {
            cookies: std::collections::HashMap::new(),
        };
        let result = remove_eh_favorite_impl(&c, &reader, "eh-a", "12345", "zzz!").await;
        match result {
            CommandResult::Failure { ok: false, error } => {
                assert_eq!(error.code, "INVALID_RESPONSE");
            }
            _ => panic!("expected failure"),
        }
    }

    #[tokio::test]
    async fn remove_favorite_rejects_missing_account() {
        let c = db();
        let reader = MemoryCookieReader {
            cookies: std::collections::HashMap::new(),
        };
        let result = remove_eh_favorite_impl(&c, &reader, "nonexistent", "12345", "abc").await;
        match result {
            CommandResult::Failure { ok: false, error } => {
                assert_eq!(error.code, "EH_UNAVAILABLE");
            }
            _ => panic!("expected failure"),
        }
    }

    // ── vote_eh_comment tests ─────────────────────────────────────────────

    #[tokio::test]
    async fn vote_rejects_invalid_vote_value() {
        let c = db();
        let reader = MemoryCookieReader {
            cookies: std::collections::HashMap::new(),
        };
        let result = vote_eh_comment_impl(&c, &reader, "eh-a", "12345", "abc", "777", 5).await;
        match result {
            CommandResult::Failure { ok: false, error } => {
                assert_eq!(error.code, "INVALID_RESPONSE");
            }
            _ => panic!("expected failure"),
        }
    }

    #[tokio::test]
    async fn vote_rejects_invalid_comment_id() {
        let c = db();
        let reader = MemoryCookieReader {
            cookies: std::collections::HashMap::new(),
        };
        let result =
            vote_eh_comment_impl(&c, &reader, "eh-a", "12345", "abc", "not-a-number", 1).await;
        match result {
            CommandResult::Failure { ok: false, error } => {
                assert_eq!(error.code, "INVALID_RESPONSE");
            }
            _ => panic!("expected failure"),
        }
    }

    #[tokio::test]
    async fn vote_rejects_missing_account() {
        let c = db();
        let reader = MemoryCookieReader {
            cookies: std::collections::HashMap::new(),
        };
        let result =
            vote_eh_comment_impl(&c, &reader, "nonexistent", "12345", "abc", "777", 1).await;
        match result {
            CommandResult::Failure { ok: false, error } => {
                assert_eq!(error.code, "EH_UNAVAILABLE");
            }
            _ => panic!("expected failure"),
        }
    }

    // ── check_eh_login_health tests ───────────────────────────────────────

    #[tokio::test]
    async fn login_health_rejects_missing_account() {
        let c = db();
        let reader = MemoryCookieReader {
            cookies: std::collections::HashMap::new(),
        };
        let result = check_eh_login_health_impl(&c, &reader, "nonexistent").await;
        match result {
            CommandResult::Failure { ok: false, error } => {
                assert_eq!(error.code, "EH_UNAVAILABLE");
            }
            _ => panic!("expected failure"),
        }
    }

    #[tokio::test]
    async fn login_health_rejects_when_cookie_missing() {
        let c = db();
        insert_account(&c, "eh-a", "ref-a", "e-hentai.org", true);
        let reader = MemoryCookieReader {
            cookies: std::collections::HashMap::new(),
        };
        let result = check_eh_login_health_impl(&c, &reader, "eh-a").await;
        match result {
            CommandResult::Failure { ok: false, error } => {
                assert!(error.message.contains("cookie not found"));
            }
            _ => panic!("expected failure"),
        }
    }

    // ── set_active_eh_account tests ───────────────────────────────────────

    #[test]
    fn set_active_rejects_nonexistent_account() {
        let mut c = db();
        let result = set_active_eh_account_impl(&mut c, "nonexistent");
        match result {
            CommandResult::Failure { ok: false, error } => {
                assert_eq!(error.code, "UNKNOWN");
                assert_eq!(error.message, "Account not found");
            }
            _ => panic!("expected failure"),
        }
    }

    #[test]
    fn set_active_deactivates_others_and_activates_target() {
        let mut c = db();
        insert_account(&c, "eh-a", "ref-a", "e-hentai.org", true);
        insert_account(&c, "eh-b", "ref-b", "exhentai.org", false);
        insert_account(&c, "eh-c", "ref-c", "e-hentai.org", true);
        let result = set_active_eh_account_impl(&mut c, "eh-b");
        match result {
            CommandResult::Success { .. } => {}
            _ => panic!("expected success"),
        }
        let a_active: bool = c
            .query_row(
                "SELECT is_active FROM eh_accounts WHERE id='eh-a'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
            != 0;
        let b_active: bool = c
            .query_row(
                "SELECT is_active FROM eh_accounts WHERE id='eh-b'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
            != 0;
        let c_active: bool = c
            .query_row(
                "SELECT is_active FROM eh_accounts WHERE id='eh-c'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
            != 0;
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
        let result = classify_eh_status(
            404,
            "This gallery is unavailable due to a copyright claim by FAKKU.",
        );
        assert!(result.is_some());
        assert_eq!(result.unwrap().0, "EH_GALLERY_COPYRIGHT_REMOVED");
    }

    #[test]
    fn classify_recognizes_worker_non_gallery_pages() {
        assert_eq!(
            classify_eh_status(200, "<title>Just a moment...</title>")
                .unwrap()
                .0,
            "EH_CLOUDFLARE"
        );
        assert_eq!(
            classify_eh_status(200, "<title>Login</title><p>Please login</p>")
                .unwrap()
                .0,
            "EH_REAUTH_REQUIRED"
        );
        assert_eq!(
            classify_eh_status(
                200,
                "<h1>Content Warning</h1><p>You are seeing this page because</p>"
            )
            .unwrap()
            .0,
            "EH_CONTENT_WARNING"
        );
        assert_eq!(
            classify_eh_status(403, "Access Denied").unwrap().0,
            "EH_ACCESS_BLOCKED"
        );
        assert_eq!(
            classify_eh_status(200, "<title>Gallery Not Found</title>")
                .unwrap()
                .0,
            "EH_GALLERY_DELETED"
        );
    }

    #[test]
    fn classify_passes_200_ok() {
        let result = classify_eh_status(200, "You are logged in");
        assert!(result.is_none());
    }

    #[test]
    fn login_health_ignores_navigation_copy() {
        assert!(classify_eh_login_health(200, "You are not logged in to the forums yet").is_none());
        assert!(classify_eh_login_health(403, "Just a moment... please login").is_none());
    }

    #[test]
    fn login_health_requires_real_login_page_or_401() {
        assert_eq!(
            classify_eh_login_health(401, "not logged in").unwrap().0,
            "EH_REAUTH_REQUIRED"
        );
        assert_eq!(
            classify_eh_login_health(
                200,
                "<title>Login</title><form action=\"login.php\" name=\"login\"></form>"
            )
            .unwrap()
            .0,
            "EH_REAUTH_REQUIRED"
        );
        assert!(classify_eh_login_health(200, "<title>Login</title><p>Please login</p>").is_none());
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
    fn parse_comments_reads_real_gallery_markup() {
        let html = r#"
          <div id="cdiv">
            <a name="c777"></a>
            <div class="c1">
              <div class="c3">Posted on 07 September 2026, 10:30 by <a href="/u/1">Reader</a></div>
              <div class="c4"><a id="comment_vote_up_777" style="color: green">+</a><a id="comment_vote_down_777">-</a></div>
              <div class="c5"><span>+4</span></div>
              <div class="c6" id="comment_777">Useful<br>comment</div>
            </div>
          </div>"#;
        let comments = parse_eh_comments(html);
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].id, "777");
        assert_eq!(comments[0].author, "Reader");
        assert_eq!(comments[0].body, "Useful\ncomment");
        assert_eq!(comments[0].score, 4);
        assert_eq!(comments[0].posted_at, "07 September 2026, 10:30");
        assert_eq!(comments[0].my_vote, 1);
    }

    #[test]
    fn parse_comments_marks_uploader_and_editable_comment() {
        let html = r#"<a name="c8"></a><div class="c1"><a name="ulcomment"></a><div class="c3">Posted on Today by <a>Uploader</a></div><div class="c4"><a onclick="edit_comment(8)">Edit</a></div><div class="c5"><span>0</span></div><div class="c6" id="comment_8">Mine</div></div>"#;
        let comments = parse_eh_comments(html);
        assert_eq!(comments.len(), 1);
        assert!(comments[0].is_uploader);
        assert!(comments[0].is_editable);
    }

    #[test]
    fn comment_vote_form_uses_eh_field_names() {
        let form = vote_eh_comment_form("123", "a1b2", "777", -1);
        assert_eq!(
            form,
            [
                ("gid".to_string(), "123".to_string()),
                ("t".to_string(), "a1b2".to_string()),
                ("act".to_string(), "votecomment".to_string()),
                ("comment_id".to_string(), "777".to_string()),
                ("comment_vote".to_string(), "-1".to_string()),
            ]
        );
    }

    #[test]
    fn search_url_uses_standard_form_encoding() {
        let url = build_search_url(
            "e-hentai.org",
            "fate grand order",
            Some(EhSearchParams {
                category: Some(2),
                page: Some(1),
            }),
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://e-hentai.org/?f_search=fate+grand+order&f_cat=2&page=1"
        );
    }
}

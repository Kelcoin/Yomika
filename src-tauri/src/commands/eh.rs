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
        crate::secret_store::get_secret(COOKIE_SERVICE, reference)
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

pub(crate) struct SystemEhCookieStore;
impl EhCookieStore for SystemEhCookieStore {
    fn set_cookie(&self, reference: &str, cookie: &str) -> Result<(), String> {
        crate::secret_store::set_secret(COOKIE_SERVICE, reference, cookie)
    }
    fn delete_cookie(&self, reference: &str) -> Result<(), String> {
        crate::secret_store::delete_secret(COOKIE_SERVICE, reference)
    }
}

impl SystemEhCookieStore {
    /// 读一条已存的 Cookie：导出凭据时要把它搬走。`EhCookieStore` 这个 trait 只有
    /// 写与删（运行时路径只需要那两件事），所以这里按需补一个只读入口。
    pub(crate) fn get_cookie(&self, reference: &str) -> Result<String, String> {
        crate::secret_store::get_secret(COOKIE_SERVICE, reference)
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
    // The cookie has already passed the same structural validation as a login
    // (member id + pass hash). A network health probe is deliberately
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
    // 账户条目**不进同步日志**：名字、站点与用户名提示与 Cookie 归同一类（都是这台
    // 机器上的登录状态），凭据库按设备各存各的，别的设备拉到条目也没法用——需要重新
    // 登录一次，所以它就不该上路。
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

#[tauri::command(async)]
pub fn save_eh_account(
    input: SaveEhAccountInput,
    database: State<'_, Database>,
) -> CommandResult<EhAccountRecord> {
    let mut connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    save_eh_account_record(&mut connection, &SystemEhCookieStore, input)
}

#[tauri::command(async)]
pub fn list_eh_accounts(database: State<'_, Database>) -> CommandResult<Vec<EhAccountRecord>> {
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
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

#[tauri::command(async)]
pub fn read_eh_account_cookie(
    account_id: String,
    database: State<'_, Database>,
) -> CommandResult<String> {
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match read_account_cookie(&connection, &SystemEhCookieReader, &account_id) {
        Ok((cookie, _, _)) => CommandResult::success(cookie),
        Err(error) => CommandResult::failure("EH_UNAVAILABLE", error, true),
    }
}

#[tauri::command(async)]
pub fn remove_eh_account(account_id: String, database: State<'_, Database>) -> CommandResult<()> {
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
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

/// The user agent every E-Hentai HTTP client and both webview windows (login,
/// username probe) present. Cloudflare binds a solved clearance cookie to the
/// agent it was issued for, so one shared value lets a clearance solved inside
/// either window replay from the plain HTTP clients.
const EH_CLIENT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

fn eh_http_client() -> Result<reqwest::Client, String> {
    // 进程内共享一个 Client：连接池与 TLS 会话跨命令复用。配置恒定
    // （超时 + UA），适合进程级缓存。
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .user_agent(EH_CLIENT_UA)
                .build()
                .map_err(|error| error.to_string())
        })
        .clone()
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

/// The login state is based on the two authentication cookies, not on a
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
/// omits every optional cookie, matching the site's own refresh flow.
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
// The answer is to show E-Hentai's own page, let the person clear the
// challenge and sign in there, and then read the cookies out of the webview —
// which is what these three commands are.

/// The sign-in window's label, so a second request focuses the window that is
/// already open instead of stacking another one on top of it.
const LOGIN_WINDOW_LABEL: &str = "eh-login";
/// 移动端那条路的轮询节奏与上限：与桌面窗口同一套感觉（宽限、间隔、总时长）。
const INAPP_LOGIN_POLL: std::time::Duration = std::time::Duration::from_millis(1_500);
const INAPP_LOGIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);
/// 主窗口的标签（应用自己那个 webview）。顶层导航那条路（非 Android）用它；Android
/// 走原生浮层，应用自己的 webview 一动不动，所以那边这个常量用不上。
#[cfg(not(target_os = "android"))]
const MAIN_WINDOW_LABEL: &str = "main";
/// 黑匣子的来源名：这几步都写进 `logs/crash.log`，下次启动在「错误日志」里能看到，
/// 用来回答「它到底停在哪一步」——Android 上的闪退是 Java/原生层的，panic hook 抓不到。
const INAPP_LOGIN_SOURCE: &str = "eh/in-app-login";

fn mark(app: &tauri::AppHandle, step: &str) {
    crate::error_log::record_step(app, INAPP_LOGIN_SOURCE, step);
}

/// 移动端的网页登录状态。
///
/// 两条实现，同一套「打开 → 后台读 Cookie → 结果放在这里等前端来领」：
///
/// - **Android**（`start_eh_in_app_login` 的应用内面板）：登录页在原生侧的另一层
///   WebView 里，应用自己的界面原样在下面活着，Cookie 由原生侧读（`mobile_host`）。
/// - **其余平台**（桌面、iOS）：应用自己的 webview 顶层导航到登录页，后台任务读它的
///   Cookie 罐，拿到会话就导航回来。桌面上这么做没有代价（页面回来时应用重载一次），
///   而 Android 上不行——那里的应用 webview 就是 activity 的内容视图，导航走等于把应用
///   自己换掉，实际表现是闪退。
#[derive(Default)]
pub struct InAppLoginState {
    /// 拿到手的会话 Cookie，等前端来取（取走即清）。
    cookie: std::sync::Mutex<Option<String>>,
    /// 登录期间要不要中止（用户点了取消）。
    cancel: std::sync::atomic::AtomicBool,
}
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
    // 移动端**不开第二个 webview**：Android 上 tao 只会把新窗口挂到当前那个 activity
    // （`next_available_activity` 永远返回主 activity——它的 `window_created` 从没被置位），
    // 而 wry 建 webview 时会对这个 activity 调 `setContentView`，也就是把应用自己的界面
    // 整个换成登录页；关掉登录窗口时那个 activity 就没有内容视图了，应用随即被系统杀掉
    // ——「点网页登录，应用闪退」。手机上的登录页也没法嵌进应用内：E-Hentai 给登录页发了
    // `X-Frame-Options: SAMEORIGIN`（加上 `default-src 'none'` 的 CSP），iframe 根本打不开。
    // 所以移动端不提供这条路（界面上那个标签页也不出现），这里再直接拒绝一次，作为防线。
    //
    // 用 `cfg!` 而不是 `#[cfg]`：两边都参与类型检查，手机上这条也照样编译。
    // 移动端走 `start_eh_in_app_login`，这里不开窗口。
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return Ok(CommandResult::failure(
            "PLATFORM_UNAVAILABLE",
            "移动端用应用内登录",
            false,
        ));
    }
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
    .inner_size(980.0, 780.0)
    // Same agent as the username probe and the HTTP replay clients: a
    // clearance solved in here is bound to this agent and stays replayable.
    .user_agent(EH_CLIENT_UA);
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
        session_from_pairs(
            pairs
                .iter()
                .map(|(name, value)| (name.as_str(), value.as_str())),
        ),
    ))
}

/// 在应用里打开登录页（移动端那条路）。Android 走原生浮层，其余平台走顶层导航。
///
/// 两边都是「打开 → 后台每 1.5 秒看一次会话 Cookie → 拿到就收工（关掉/导航回来），超时
/// 或取消也一样」，结果放在 `InAppLoginState` 里等前端来领：Android 上前端一直活着，领
/// 结果就是一次普通轮询；导航那条路上应用会整页重载，登录期间那个 promise 早就没了，所
/// 以前端重载后再领一次。
#[tauri::command]
pub async fn start_eh_in_app_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, InAppLoginState>,
) -> Result<CommandResult<()>, String> {
    mark(&app, "start：进入应用内登录");
    *state.cookie.lock().map_err(|error| error.to_string())? = None;
    state.cancel.store(false, std::sync::atomic::Ordering::SeqCst);
    #[cfg(target_os = "android")]
    {
        start_native_login_sheet(&app).await
    }
    #[cfg(not(target_os = "android"))]
    {
        start_login_navigation(&app).await
    }
}

/// Android：登录页画在原生侧的另一层 WebView 上（`MobileHost`），应用自己的 webview
/// 一动不动。之后每一轮问一次原生：看到会话了吗？还开着吗？
#[cfg(target_os = "android")]
async fn start_native_login_sheet(app: &tauri::AppHandle) -> Result<CommandResult<()>, String> {
    mark(app, "panel：请求原生登录面板");
    // 与桌面窗口、HTTP 重放同一套 UA：Cloudflare 的通行证是按 UA 绑定的，登录页用哪个
    // UA 过的验证，后面重放时就得用哪个。
    if let Err(error) =
        crate::mobile_host::login_open(app, LOGIN_WINDOW_URL, EH_CLIENT_UA).await
    {
        mark(app, &format!("panel：打开失败（{error}）"));
        return Ok(CommandResult::failure("PLATFORM_UNAVAILABLE", error, false));
    }
    mark(app, "panel：已打开，开始轮询 Cookie");
    let poller = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let deadline = std::time::Instant::now() + INAPP_LOGIN_TIMEOUT;
        let mut captured = false;
        loop {
            tokio::time::sleep(INAPP_LOGIN_POLL).await;
            let cancelled = poller
                .state::<InAppLoginState>()
                .cancel
                .load(std::sync::atomic::Ordering::SeqCst);
            if cancelled || std::time::Instant::now() >= deadline {
                break;
            }
            let Ok(poll) = crate::mobile_host::login_poll(&poller).await else {
                mark(&poller, "panel：问不到原生面板，收工");
                break;
            };
            if let Some(cookie) = poll.cookie.as_deref().and_then(session_from_header) {
                if let Ok(mut slot) = poller.state::<InAppLoginState>().cookie.lock() {
                    *slot = Some(cookie);
                }
                captured = true;
                break;
            }
            // 用户把面板关了：这次登录就到这里（结果可能是「没登录」）。
            if !poll.open {
                break;
            }
        }
        mark(&poller, if captured { "panel：拿到会话，关闭面板" } else { "panel：没有会话，关闭面板" });
        let _ = crate::mobile_host::login_close(&poller).await;
    });
    Ok(CommandResult::success(()))
}

/// 其余平台：应用自己的 webview 顶层导航到登录页，读完 Cookie 再导航回来。
#[cfg(not(target_os = "android"))]
async fn start_login_navigation(app: &tauri::AppHandle) -> Result<CommandResult<()>, String> {
    use tauri::Manager;
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        mark(app, "主窗口不可用");
        return Ok(CommandResult::failure("PLATFORM_UNAVAILABLE", "主窗口不可用", false));
    };
    let Ok(url) = LOGIN_WINDOW_URL.parse::<Url>() else {
        return Ok(CommandResult::failure("UNKNOWN", "登录地址无效", false));
    };
    let back = match window.url() {
        Ok(url) => url,
        Err(error) => return Ok(CommandResult::failure("PLATFORM_UNAVAILABLE", error.to_string(), false)),
    };
    mark(app, "navigate：准备导航到登录页");
    let navigated = window.navigate(url);
    mark(app, match &navigated { Ok(()) => "navigate 已发出", Err(_) => "navigate 失败" });
    if let Err(error) = navigated {
        return Ok(CommandResult::failure("PLATFORM_UNAVAILABLE", error.to_string(), false));
    }

    let home = back.origin().ascii_serialization();
    let poller = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        mark(&poller, "poller：开始轮询 Cookie");
        let deadline = std::time::Instant::now() + INAPP_LOGIN_TIMEOUT;
        let mut returned = false;
        loop {
            tokio::time::sleep(INAPP_LOGIN_POLL).await;
            let cancelled = poller.state::<InAppLoginState>().cancel.load(std::sync::atomic::Ordering::SeqCst);
            if cancelled || std::time::Instant::now() >= deadline {
                break;
            }
            let Some(window) = poller.get_webview_window(MAIN_WINDOW_LABEL) else { break };
            // 已经回到应用自己的页面了（用户按了系统返回键，或者我们上一轮导航回来了）：
            // 这次登录到此为止，别再导航一次打断人正在做的事。
            if window.url().map(|url| url.origin().ascii_serialization() == home).unwrap_or(false) {
                returned = true;
                break;
            }
            let Some(cookie) = read_session_cookie(&window) else { continue };
            if let Ok(mut slot) = poller.state::<InAppLoginState>().cookie.lock() {
                *slot = Some(cookie);
            }
            break;
        }
        // 无论哪条路都回到应用：留在登录页上等于把人困在里头。
        mark(&poller, if returned { "poller：已经回到应用，收工" } else { "poller：导航回应用" });
        if !returned {
            if let Some(window) = poller.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.navigate(back);
            }
        }
    });
    Ok(CommandResult::success(()))
}

/// 前端在应用重新起来（导航那条路）或原生面板关掉（Android）之后领网页登录的结果：
/// `Some(cookie)` 表示这次登录成了。
#[tauri::command]
pub async fn take_eh_in_app_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, InAppLoginState>,
) -> Result<CommandResult<Option<String>>, String> {
    if state.cookie.lock().map(|slot| slot.is_some()).unwrap_or(false) {
        mark(&app, "前端回来领结果：拿到会话");
    }
    let mut slot = state.cookie.lock().map_err(|error| error.to_string())?;
    let cookie = slot.take();
    Ok(CommandResult::success(cookie))
}

/// 放弃这次应用内登录：Android 上顺手把原生面板关掉，其余平台靠后台任务下一轮导航回来。
#[tauri::command]
pub async fn cancel_eh_in_app_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, InAppLoginState>,
) -> Result<CommandResult<()>, String> {
    state.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    #[cfg(target_os = "android")]
    {
        let _ = crate::mobile_host::login_close(&app).await;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
    }
    Ok(CommandResult::success(()))
}

/// 从一整段 Cookie 头里挑出会话（原生面板那边拿到的就是这个形状）。
#[cfg(target_os = "android")]
fn session_from_header(raw: &str) -> Option<String> {
    session_from_pairs(
        raw.split(';')
            .filter_map(|part| part.trim().split_once('='))
            .map(|(name, value)| (name.trim(), value.trim())),
    )
}

/// 「这份 Cookie 里有没有会话」只有这一处答案：窗口、原生面板、顶层导航三条路都走它。
fn session_from_pairs<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Option<String> {
    cookie_header_from_all_pairs(pairs).filter(|cookie| has_valid_authentication_cookie(cookie))
}

/// 读某个 webview 的 Cookie 罐里的会话 Cookie（三个域全读一遍，与窗口那条路同一套过滤）。
/// 只有顶层导航那条路要它：Android 的 Cookie 由原生浮层读出来（见 `mobile_host`）。
#[cfg(not(target_os = "android"))]
fn read_session_cookie(window: &tauri::WebviewWindow) -> Option<String> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    for origin in COOKIE_ORIGINS {
        let Ok(url) = origin.parse::<Url>() else {
            continue;
        };
        if let Ok(cookies) = window.cookies_for_url(url) {
            pairs.extend(
                cookies
                    .into_iter()
                    .map(|cookie| (cookie.name().to_string(), cookie.value().to_string())),
            );
        }
    }
    session_from_pairs(
        pairs
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
    )
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
                    crate::cache::LOCK_FAILED,
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
                    crate::cache::LOCK_FAILED,
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

/// Comment votes go through the api.php JSON endpoint, not
/// the gallerypopups.php form — the form page needs a browser context and the
/// vote silently did nothing without one. Both requests need the `apikey`
/// embedded in the gallery page and the member id carried by the cookie.
fn api_endpoint_for_host(host: &str) -> &'static str {
    if host.eq_ignore_ascii_case("exhentai.org") {
        "https://exhentai.org/api.php"
    } else {
        "https://api.e-hentai.org/api.php"
    }
}

fn apikey_from_page(body: &str) -> Option<&str> {
    let start = body.find(r#"var apikey = ""#)? + r#"var apikey = ""#.len();
    let rest = &body[start..];
    let end = rest.find('"')?;
    let key = &rest[..end];
    (!key.is_empty()).then_some(key)
}

fn apiuid_from_cookie(cookie: &str) -> Option<&str> {
    for part in cookie.split(';') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix("ipb_member_id=") {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

#[derive(Debug, serde::Deserialize)]
struct CommentVoteResponse {
    #[serde(default)]
    comment_score: Option<i32>,
}

async fn vote_eh_comment_request(
    cookie: &str,
    host: &str,
    gallery_id: &str,
    token: &str,
    comment_id: &str,
    vote: i32,
) -> CommandResult<i32> {
    // The apikey lives in the gallery page itself, so the vote is: fetch the
    // page, read the key, then call the JSON API with it and the member id.
    let client = match eh_http_client() {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    let page_url = format!("https://{host}/g/{gallery_id}/{token}/");
    let (page_status, page_body) = match read_http_response(client.get(&page_url).header("Cookie", cookie)).await {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    if let Some((code, message, retryable)) = classify_eh_status(page_status, &page_body) {
        return CommandResult::failure(code, message, retryable);
    }
    let Some(apikey) = apikey_from_page(&page_body) else {
        return CommandResult::failure(
            "EH_UNAVAILABLE",
            "Could not find the vote key on the gallery page",
            true,
        );
    };
    let Some(apiuid) = apiuid_from_cookie(cookie) else {
        return CommandResult::failure(
            "EH_UNAVAILABLE",
            "The account cookie carries no member id; sign in again",
            false,
        );
    };

    let payload = serde_json::json!({
        "apikey": apikey,
        "apiuid": apiuid.parse::<i64>().unwrap_or(0),
        "gid": gallery_id.parse::<i64>().unwrap_or(0),
        "method": "votecomment",
        "token": token,
        "comment_id": comment_id.parse::<i64>().unwrap_or(0),
        "comment_vote": vote,
    });
    let (status, body) = match read_http_response(
        client
            .post(api_endpoint_for_host(host))
            .header("Cookie", cookie)
            .json(&payload),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("EH_UNAVAILABLE", error, true),
    };
    if let Some((code, message, retryable)) = classify_eh_status(status, &body) {
        return CommandResult::failure(code, message, retryable);
    }
    match serde_json::from_str::<CommentVoteResponse>(&body) {
        Ok(response) if response.comment_score.is_some() => {
            CommandResult::success(response.comment_score.unwrap_or_default())
        }
        _ => CommandResult::failure(
            "EH_UNAVAILABLE",
            "The vote was not accepted; the comment score did not change",
            true,
        ),
    }
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
) -> CommandResult<i32> {
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
) -> Result<CommandResult<i32>, String> {
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
                    crate::cache::LOCK_FAILED,
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

/// JHenTai 的 exchangePage2Assets 语义：`#buyform`/`#sellform` 各自所在
/// `<div>` 的**下一个兄弟元素**的文本里带当前市场的 "Available: X Credits /
/// X kGP"——表单内部的 "GP"/"Credits" 字样和输入框默认值不是余额，必须
/// 跳过（这正是旧实现抓错 GP 的原因）。
fn exchange_segment_after_form(html: &str, form_marker: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(form_start) = lower.find(&form_marker.to_ascii_lowercase()) else {
        return String::new();
    };
    let Some(form_end) = lower[form_start..].find("</form>").map(|offset| form_start + offset) else {
        return String::new();
    };
    // form 所在 div 的收口（</form> 后第一个 </div>），其后即兄弟元素。
    let Some(parent_end) = lower[form_end..].find("</div>").map(|offset| form_end + offset) else {
        return String::new();
    };
    let end = (parent_end + 400).min(html.len());
    let end = (form_end..=end)
        .rev()
        .find(|index| html.is_char_boundary(*index))
        .unwrap_or(form_end);
    decode_html_text(&strip_tags(&html[parent_end..end]))
}

/// JHenTai 的正则 `([\d,k ]+)LABEL`：标签前按数字/逗号/k/空格回扫的金额串。
fn jhentai_amount_before_label(text: &str, label: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let Some(label_start) = lower.find(&label.to_ascii_lowercase()) else {
        return String::new();
    };
    let bytes = text.as_bytes();
    let mut start = label_start;
    while start > 0 {
        let byte = bytes[start - 1];
        if byte.is_ascii_digit() || byte == b',' || byte == b'k' || byte == b' ' {
            start -= 1;
        } else {
            break;
        }
    }
    text[start..label_start].trim().to_string()
}

fn parse_exchange_assets(html: &str) -> EhAccountAssets {
    let plain = decode_html_text(&strip_tags(html));
    // 表单内部（sellform 的 "Sell 5000 GP" 按钮、输入框默认值等）不是余额；
    // 取 form 结束后兄弟元素里的市场 "Available" 行，与 JHenTai 同源。
    let credit_desc = exchange_segment_after_form(html, "id=\"buyform\"");
    let credit_desc = if credit_desc.is_empty() {
        exchange_segment_after_form(html, "id='buyform'")
    } else {
        credit_desc
    };
    let gp_desc = exchange_segment_after_form(html, "id=\"sellform\"");
    let gp_desc = if gp_desc.is_empty() {
        exchange_segment_after_form(html, "id='sellform'")
    } else {
        gp_desc
    };
    let credits = jhentai_amount_before_label(&credit_desc, "Credits");
    let gp = jhentai_amount_before_label(&gp_desc, "GP");    EhAccountAssets {
        gp: if gp.is_empty() {
            amount_near_label(&plain, "kGP")
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

/// JHenTai 的 hathperks 语义：首个 `.stuffbox` 的第 4 个 `<p>` 携带
/// "You currently have X Hath."。
fn parse_hath_assets(html: &str) -> String {
    let stuffbox_index = html.to_ascii_lowercase().find("class=\"stuffbox\"");
    if let Some(stuffbox_start) = stuffbox_index {
        let segment = &html[stuffbox_start..];
        let p_positions: Vec<usize> = segment
            .match_indices("<p")
            .take(4)
            .map(|(index, _)| index)
            .collect();
        if let Some(&fourth) = p_positions.get(3) {
            let fourth_text = decode_html_text(&strip_tags(&segment[fourth..]));
            if fourth_text.to_ascii_lowercase().contains("you currently have") {
                let value = amount_before_label(&fourth_text, "Hath");
                if !value.is_empty() {
                    return value;
                }
            }
        }
    }
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
        .user_agent(EH_CLIENT_UA)
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
    // structurally valid cookie only an actual 401 or an unmistakable login page can
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

fn open_tag_has_class(open_tag: &str, class_name: &str) -> bool {
    let Some(start) = open_tag.find("class=\"") else {
        return false;
    };
    let rest = &open_tag[start + "class=\"".len()..];
    let Some(end) = rest.find('"') else {
        return false;
    };
    rest[..end].split_whitespace().any(|token| token == class_name)
}

/// The first `<div>` or `<span>` in the chunk whose class attribute carries the
/// token, and its inner HTML. E-Hentai renders these header fields as either
/// element flavour (and the score block is `class="c5 nosel"`, which the old
/// exact-string marker never matched), so the lookup matches the class token on
/// both. Spans end at their first close — their content here never nests one.
fn comment_field<'a>(chunk: &'a str, class_name: &str) -> Option<&'a str> {
    let mut cursor = 0;
    while let Some(offset) = chunk[cursor..].find('<') {
        let tag_start = cursor + offset;
        let rest = &chunk[tag_start..];
        let is_div = rest.starts_with("<div");
        let is_span = !is_div && rest.starts_with("<span");
        if !is_div && !is_span {
            cursor = tag_start + 1;
            continue;
        }
        let Some(open_end) = chunk[tag_start..].find('>').map(|value| tag_start + value) else {
            break;
        };
        if !open_tag_has_class(&chunk[tag_start..=open_end], class_name) {
            cursor = open_end + 1;
            continue;
        }
        if is_span {
            let inner_start = open_end + 1;
            let Some(close) = chunk[inner_start..].find("</span>") else {
                break;
            };
            return Some(&chunk[inner_start..inner_start + close]);
        }
        return div_inner_at(chunk, tag_start).map(|(inner, _)| inner);
    }
    None
}

/// The site renders the score as `Score <span …>+28</span>`; the first signed
/// number in the stripped text is the score, and an empty vote shows as 0.
/// Thousands separators are tolerated and dropped.
fn parse_comment_score(block: &str) -> i32 {
    let text = strip_tags(block);
    let bytes = text.as_bytes();
    for start in 0..bytes.len() {
        let character = bytes[start] as char;
        if character == '+' || character == '-' || character.is_ascii_digit() {
            let mut end = start + 1;
            while end < bytes.len()
                && ((bytes[end] as char).is_ascii_digit() || bytes[end] == b',')
            {
                end += 1;
            }
            let digits: String = text[start..end].chars().filter(|c| *c != ',').collect();
            return digits.parse().unwrap_or(0);
        }
    }
    0
}

/// "11 August 2026, 09:44" (`dd MMMM yyyy, HH:mm`, en_US) →
/// "2026-08-11 09:44". Relative or unparseable lines keep their raw text.
fn normalize_eh_date(raw: &str) -> Option<String> {
    let (date, time) = raw.split_once(',')?;
    let mut parts = date.split_whitespace();
    let day: u32 = parts.next()?.parse().ok()?;
    if day == 0 || day > 31 {
        return None;
    }
    let month = match parts.next()?.get(0..3)?.to_ascii_lowercase().as_str() {
        "jan" => 1,
        "feb" => 2,
        "mar" => 3,
        "apr" => 4,
        "may" => 5,
        "jun" => 6,
        "jul" => 7,
        "aug" => 8,
        "sep" => 9,
        "oct" => 10,
        "nov" => 11,
        "dec" => 12,
        _ => return None,
    };
    let year: i32 = parts.next()?.parse().ok()?;
    let (hour, minute) = time.trim().split_once(':')?;
    let hour: u32 = hour.parse().ok()?;
    let minute: u32 = minute.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}"))
}

/// The header line reads `Posted on 11 August 2026, 09:44 by:&nbsp;…` — the
/// "by" carries a colon, which the old `… by ` split never matched.
fn normalize_eh_posted_time(block: &str) -> String {
    let text = strip_comment_tags(block);
    let Some(rest) = text.trim().strip_prefix("Posted on") else {
        return String::new();
    };
    let rest = rest.trim_start();
    let cut = rest
        .find(" by:")
        .or_else(|| rest.find(" by "))
        .unwrap_or(rest.len());
    let raw = rest[..cut].trim();
    normalize_eh_date(raw).unwrap_or_else(|| raw.to_string())
}

/// A vote link the account has cast carries `style="color:blue"` (the site's
/// selector); every uncast link has a style attribute too, so matching bare
/// `style=` marked every comment as up-voted.
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
            let flat = tag.replace(' ', "").to_ascii_lowercase();
            if flat.contains("color:blue") {
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
        // The header links the poster's name first; a PM link with an image
        // follows it, so the anchor search has to take the first match.
        let author = c3
            .find("<a")
            .and_then(|start| {
                let content_start = c3[start..].find('>')? + start + 1;
                let content_end = c3[content_start..].find("</a>")? + content_start;
                Some(strip_comment_tags(&c3[content_start..content_end]))
            })
            .unwrap_or_default();
        let posted_at = normalize_eh_posted_time(c3);
        let score = parse_comment_score(comment_field(chunk, "c5").unwrap_or_default());
        let comment_body = strip_comment_tags(comment_html);
        if !id.is_empty() && !comment_body.is_empty() {
            let my_vote = comment_vote(chunk, &id);
            comments.push(EhCommentRecord {
                id,
                author,
                body: comment_body,
                score,
                posted_at,
                // The real marker is the `ulcomment` anchor inside the comment's
                // own c4 block ("Uploader Comment"); the poster link itself is
                // /uploader/<name> for EVERY commenter, so it proves nothing.
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
                    crate::cache::LOCK_FAILED,
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
                    crate::cache::LOCK_FAILED,
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
                    crate::cache::LOCK_FAILED,
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

// ── fetch_eh_forum_username ───────────────────────────────────────────────

// ── fetch_eh_forum_username ───────────────────────────────────────────────

/// 解析资料页的 `<h1 id="profilename">Name</h1>`；失败时回退导航链接。
fn parse_profilename(html: &str) -> Option<String> {
    let marker = html.find(r#"id="profilename""#).or_else(|| html.find("id=profilename"))?;
    let after = &html[marker..];
    let gt = after.find('>')? + marker;
    let text_start = gt + 1;
    let text_end = html[text_start..].find('<')? + text_start;
    let name = decode_html_text(&html[text_start..text_end]).trim().to_string();
    (!name.is_empty()).then_some(name).or_else(|| parse_forum_username(html))
}

/// Resolves the account's forum username with a single plain HTTP fetch of the
/// profile page. Cloudflare challenges every non-browser client on that
/// subdomain, so this usually fails — that is fine: the UI falls back to
/// manual entry. No webview, no clearance machinery.
#[tauri::command]
pub async fn fetch_eh_forum_username(
    account_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<Option<String>>, String> {
    if !matches!(database.connection.lock().map(|c| c.query_row("SELECT COUNT(*) FROM eh_accounts WHERE id=?1", params![account_id], |row| row.get::<_, i64>(0)).unwrap_or(0) > 0), Ok(true)) {
        return Ok(CommandResult::failure("UNKNOWN", "Account not found", false));
    }
    let cookie = {
        let connection = match database.connection.lock() {
            Ok(value) => value,
            Err(_) => return Ok(CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true)),
        };
        match read_account_cookie(&connection, &SystemEhCookieReader, &account_id) {
            Ok((cookie, _, _)) => cookie,
            Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
        }
    };
    let member_id = cookie_value(&cookie, "ipb_member_id").unwrap_or_default();
    if member_id.is_empty() || !member_id.chars().all(|c| c.is_ascii_digit()) {
        return Ok(CommandResult::failure(
            "INVALID_RESPONSE",
            "The account cookie carries no member id",
            false,
        ));
    }
    let client = match eh_http_client() {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
    };
    let profile_url = format!("https://forums.e-hentai.org/index.php?showuser={member_id}");
    let (_status, body) = match read_http_response(client.get(&profile_url).header("Cookie", &cookie)).await {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
    };
    let Some(username) = parse_profilename(&body) else {
        return Ok(CommandResult::success(None));
    };
    if let Ok(connection) = database.connection.lock() {
        let _ = connection.execute(
            "UPDATE eh_accounts SET username_hint=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2",
            params![username, account_id],
        );
    }
    Ok(CommandResult::success(Some(username)))
}

/// 手动设定账户显示名（网页登录抓取失败或用其它方式登录时，用户自行填写）。
#[tauri::command(async)]
pub fn set_eh_username_hint(
    account_id: String,
    username: String,
    database: State<'_, Database>,
) -> CommandResult<()> {
    let name = username.trim().to_string();
    if name.is_empty() {
        return CommandResult::failure("INVALID_RESPONSE", "Username must not be empty", false);
    }
    let connection = match database.connection.lock() {
        Ok(connection) => connection,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match connection.execute(
        "UPDATE eh_accounts SET username_hint=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2",
        params![name, account_id],
    ) {
        Ok(_) => CommandResult::success(()),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

// ── My Tags (https://e-hentai.org/mytags) ─────────────────────────────────

/// One entry of the account's own tag list. `watched` is what ranks a tag
/// first on cards and detail pages; `color` is the preset the account gave it
/// on the site, painted onto the chip as-is (an opaque `#RRGGBB`).
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EhMyTagRecord {
    pub tag_id: i64,
    pub namespace: String,
    pub tag_key: String,
    pub watched: bool,
    pub hidden: bool,
    pub weight: i32,
    pub color: Option<String>,
}

/// The value of `attr` inside the element that carries `id="<marker>"`.
///
/// The mytags page emits one flat control per tag with fixed ids
/// (`tagpreview_<n>`, `tagwatch_<n>`, `tagcolor_<n>`, `tagweight_<n>`), so
/// locating the element by its id and reading the attribute inside the same
/// tag is the whole parser — no HTML dependency, same approach as the comment
/// parser below.
fn element_attribute_around(body: &str, marker: &str, attr: &str) -> Option<String> {
    let id_pattern = format!("id=\"{marker}\"");
    let start = body.find(&id_pattern)?;
    let element_start = body[..start].rfind('<')? + 1;
    let element_end = start + body[start..].find('>')?;
    let element = &body[element_start..element_end];
    let attr_pattern = format!("{attr}=\"");
    let attr_start = element.find(&attr_pattern)?;
    let value_start = attr_start + attr_pattern.len();
    let value_end = element[value_start..].find('"')? + value_start;
    Some(decode_html_text(&element[value_start..value_end]))
}

fn element_has_flag_around(body: &str, marker: &str, flag: &str) -> bool {
    let id_pattern = format!("id=\"{marker}\"");
    let Some(start) = body.find(&id_pattern) else {
        return false;
    };
    let Some(element_start) = body[..start].rfind('<') else {
        return false;
    };
    let Some(element_end) = body[start..].find('>') else {
        return false;
    };
    body[element_start..start + element_end].contains(flag)
}

/// Parses the signed-in account's mytags page. Only the currently selected tag
/// set is on the page, which is the set JHenTai reads too; the other sets stay
/// on the site until the user switches and re-fetches.
fn parse_eh_my_tags(body: &str) -> Vec<EhMyTagRecord> {
    let mut tags = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = body[cursor..].find("id=\"usertag_") {
        let id_position = cursor + relative + "id=\"usertag_".len();
        let Some(id_end) = body[id_position..].find('"').map(|offset| id_position + offset) else {
            break;
        };
        let raw_id = &body[id_position..id_end];
        cursor = id_end + 1;
        let Ok(tag_id) = raw_id.parse::<i64>() else {
            continue;
        };
        // `usertag_0` is the page's "you have no tags" placeholder div.
        if tag_id == 0 {
            continue;
        }
        let title = element_attribute_around(body, &format!("tagpreview_{tag_id}"), "title")
            .unwrap_or_default();
        if title.is_empty() {
            continue;
        }
        let (namespace, tag_key) = match title.split_once(':') {
            Some((namespace, key)) if !namespace.trim().is_empty() && !key.trim().is_empty() => {
                (namespace.trim().to_lowercase(), key.trim().to_string())
            }
            // A bare tag has no namespace; the app's catch-all is `general`,
            // same bucket `categorizeSearchableTags` puts non-namespaced tags in.
            _ => ("general".to_string(), title.trim().to_string()),
        };
        let weight = element_attribute_around(body, &format!("tagweight_{tag_id}"), "value")
            .and_then(|value| value.trim().parse::<i32>().ok())
            .unwrap_or(0);
        let color = element_attribute_around(body, &format!("tagcolor_{tag_id}"), "value")
            .map(|value| {
                let hex = value.trim().trim_start_matches('#');
                // EH hands back `#RRGGBB`; accept an alpha-prefixed 8-digit form
                // the way JHenTai's parser does and keep the opaque colour.
                if hex.len() == 8 {
                    format!("#{}", &hex[2..])
                } else if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
                    format!("#{hex}")
                } else {
                    String::new()
                }
            })
            .filter(|color| !color.is_empty());
        tags.push(EhMyTagRecord {
            tag_id,
            namespace,
            tag_key,
            watched: element_has_flag_around(body, &format!("tagwatch_{tag_id}"), "checked"),
            hidden: element_has_flag_around(body, &format!("taghide_{tag_id}"), "checked"),
            weight,
            color,
        });
    }
    tags
}

/// Replaces the account's cached tag list wholesale: the site's list is the
/// source of truth and there is no sync story for it.
fn store_eh_my_tags(connection: &mut Connection, account_id: &str, tags: &[EhMyTagRecord]) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM eh_my_tags WHERE account_id=?1", params![account_id])
        .map_err(|error| error.to_string())?;
    for tag in tags {
        transaction
            .execute(
                "INSERT INTO eh_my_tags (account_id,tag_id,namespace,tag_key,watched,hidden,weight,color,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,datetime('now'))",
                params![account_id, tag.tag_id, tag.namespace, tag.tag_key, tag.watched, tag.hidden, tag.weight, tag.color],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn read_eh_my_tags(connection: &Connection, account_id: &str) -> Result<Vec<EhMyTagRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT tag_id,namespace,tag_key,watched,hidden,weight,color FROM eh_my_tags
             WHERE account_id=?1 ORDER BY weight DESC, tag_id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![account_id], |row| {
            Ok(EhMyTagRecord {
                tag_id: row.get(0)?,
                namespace: row.get(1)?,
                tag_key: row.get(2)?,
                watched: row.get::<_, i64>(3)? != 0,
                hidden: row.get::<_, i64>(4)? != 0,
                weight: row.get(5)?,
                color: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub async fn fetch_eh_my_tags(
    account_id: String,
    database: State<'_, Database>,
) -> Result<CommandResult<Vec<EhMyTagRecord>>, String> {
    let (cookie, host, _) = {
        let connection = match database.connection.lock() {
            Ok(value) => value,
            Err(_) => return Ok(CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true)),
        };
        match read_account_cookie(&connection, &SystemEhCookieReader, &account_id) {
            Ok(value) => value,
            Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
        }
    };
    let client = match eh_http_client() {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
    };
    let url = format!("https://{host}/mytags");
    let (status, body) = match read_http_response(client.get(url).header("Cookie", cookie)).await {
        Ok(value) => value,
        Err(error) => return Ok(CommandResult::failure("EH_UNAVAILABLE", error, true)),
    };
    if let Some((code, message, retryable)) = classify_eh_status(status, &body) {
        return Ok(CommandResult::failure(code, message, retryable));
    }
    let tags = parse_eh_my_tags(&body);
    let mut connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return Ok(CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true)),
    };
    match store_eh_my_tags(&mut connection, &account_id, &tags) {
        Ok(()) => Ok(CommandResult::success(tags)),
        Err(error) => Ok(CommandResult::failure("UNKNOWN", error, true)),
    }
}

#[tauri::command(async)]
pub fn list_eh_my_tags(
    account_id: String,
    database: State<'_, Database>,
) -> CommandResult<Vec<EhMyTagRecord>> {
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", crate::cache::LOCK_FAILED, true),
    };
    match read_eh_my_tags(&connection, &account_id) {
        Ok(tags) => CommandResult::success(tags),
        Err(error) => CommandResult::failure("UNKNOWN", error, true),
    }
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
    fn my_tags_parser_reads_jhentai_page_shapes() {
        // 与 JHenTai 的解析目标一致：每个 usertag 块携带 preview/watch/hide/
        // color/weight 五个控件，id 共用同一个数字。checked 是布尔属性，
        // 颜色与权重是 value 属性，标题带命名空间。
        let html = r##"
          <div id="usertags_outer">
            <div id="usertag_0">You have no tags.</div>
            <div id="usertag_15">
              <div id="tagpreview_15" title="artist:some_one">…</div>
              <input type="checkbox" id="tagwatch_15" checked="checked" />
              <input type="checkbox" id="taghide_15" />
              <input type="color" id="tagcolor_15" value="#ff8800" />
              <input type="text" id="tagweight_15" value="2" />
            </div>
            <div id="usertag_23">
              <div id="tagpreview_23" title="female:glasses">…</div>
              <input type="checkbox" id="tagwatch_23" />
              <input type="checkbox" id="taghide_23" checked="checked" />
              <input type="color" id="tagcolor_23" value="#00aabb" />
              <input type="text" id="tagweight_23" value="-1" />
            </div>
            <div id="usertag_31">
              <div id="tagpreview_31" title="plain_tag">…</div>
              <input type="checkbox" id="tagwatch_31" checked />
              <input type="color" id="tagcolor_31" value="#AABBCCDD" />
            </div>
          </div>
        "##;
        let tags = parse_eh_my_tags(html);
        assert_eq!(tags.len(), 3);
        assert_eq!(
            tags[0],
            EhMyTagRecord {
                tag_id: 15,
                namespace: "artist".into(),
                tag_key: "some_one".into(),
                watched: true,
                hidden: false,
                weight: 2,
                color: Some("#ff8800".into()),
            }
        );
        assert_eq!(tags[1].namespace, "female");
        assert_eq!(tags[1].tag_key, "glasses");
        assert!(!tags[1].watched);
        assert!(tags[1].hidden);
        assert_eq!(tags[1].weight, -1);
        // 无命名空间的裸标签进 general；8 位 AARRGGBB 去掉 alpha 前两位。
        assert_eq!(tags[2].namespace, "general");
        assert_eq!(tags[2].tag_key, "plain_tag");
        assert!(tags[2].watched);
        assert_eq!(tags[2].weight, 0);
        assert_eq!(tags[2].color.as_deref(), Some("#BBCCDD"));
    }

    #[test]
    fn my_tags_store_replaces_the_accounts_list_wholesale() {
        let mut c = db();
        let first = vec![EhMyTagRecord {
            tag_id: 1,
            namespace: "artist".into(),
            tag_key: "a".into(),
            watched: true,
            hidden: false,
            weight: 3,
            color: Some("#112233".into()),
        }];
        store_eh_my_tags(&mut c, "acc-1", &first).unwrap();
        let second = vec![
            EhMyTagRecord {
                tag_id: 2,
                namespace: "female".into(),
                tag_key: "glasses".into(),
                watched: false,
                hidden: false,
                weight: 0,
                color: None,
            },
            EhMyTagRecord {
                tag_id: 3,
                namespace: "general".into(),
                tag_key: "plain".into(),
                watched: true,
                hidden: false,
                weight: 9,
                color: None,
            },
        ];
        store_eh_my_tags(&mut c, "acc-1", &second).unwrap();
        // 另一个账户的缓存互不影响。
        store_eh_my_tags(&mut c, "acc-2", &first).unwrap();
        let rows = read_eh_my_tags(&c, "acc-1").unwrap();
        // 权重降序：weight 9 的裸标签排在最前。
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].tag_id, 3);
        assert_eq!(rows[1].tag_id, 2);
        assert!(rows[0].watched);
        let other = read_eh_my_tags(&c, "acc-2").unwrap();
        assert_eq!(other.len(), 1);
        assert_eq!(other[0].tag_id, 1);
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
        // 真实页面结构（实测 exchange.php?t=gp / hathperks.php）：
        // 表单之后的兄弟元素携带市场 "Available" 行；JHenTai 用 nextElementSibling
        // 取它，绕开表单内部的 "GP"/"Credits" 字样与输入框。
        let exchange = r##"
          <div class="outer">
            <div>
              <h2>Buy GP</h2>
              <div>
                <form id="buyform" action="" method="post">
                  Count: <input type="text" id="bid_count" value="0" /> kGP &nbsp;
                  Bid Price per kGP: <input type="text" id="bid_price" value="0" /> C &nbsp;
                  <a href="#">Buy GP!</a>
                </form>
              </div>
              <div style="margin-top:5px; font-weight:bold">Available: 6,859,678 Credits</div>
            </div>
            <div>
              <h2>Sell GP</h2>
              <div>
                <form id="sellform" action="" method="post">
                  Count: <input type="text" id="ask_count" value="0" /> kGP &nbsp;
                  Ask Price per kGP: <input type="text" id="ask_price" value="0" /> C &nbsp;
                  <a href="#">Sell GP!</a>
                </form>
              </div>
              <div style="margin-top:5px; font-weight:bold">Available: 323,844 kGP</div>
            </div>
          </div>
        "##;
        let hath = r#"<div class="stuffbox"><h1>Hath Perks</h1><div style="font-size:9pt">
          <p>By running the Hentai@Home client, you will over time gain special bonus points known as Hath.</p>
          <p>If running H@H is not an option, you can exchange Credits for Hath at the Hath Exchange.</p>
          <p>While the Hath Perks for the HentaiVerse cannot be obtained in any other way, most of the ones that are specific for Galleries will also get unlocked there.</p>
          <p style="margin-top:5px; text-align:center">You currently have <span style="font-weight:bold">0.6</span> Hath.</p>
        </div></div>"#;
        let assets = parse_exchange_assets(exchange);
        assert_eq!(assets.gp, "323,844 k");
        assert_eq!(assets.credits, "6,859,678");
        assert_eq!(parse_hath_assets(hath), "0.6");
    }

    #[test]
    fn account_asset_parsers_survive_quoted_and_missing_forms() {
        // 单引号形式与缺表单：解析降级而不是崩。
        let exchange = r#"<form id='buyform'></form><div>Available: 1,234 Credits</div>"#;
        let assets = parse_exchange_assets(exchange);
        assert_eq!(assets.credits, "1,234");
        assert_eq!(parse_exchange_assets("<div>nothing here</div>").gp, "");
        assert_eq!(parse_hath_assets("<p>no hath here</p>"), "");
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
        c.execute_batch(include_str!("../../migrations/0022_eh_my_tags.sql"))
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
        // Mirrors the live page: header fields are divs/spans with compound
        // classes (`c5 nosel`), the poster line ends in `by:` and carries a PM
        // image link after the name, and the score text is prefixed by "Score ".
        let html = r#"
          <div id="cdiv">
            <a name="c777"></a>
            <div class="c1">
              <div class="c2">
                <div class="c4 nosel"><a id="comment_vote_up_777" style="color: blue"></a><a id="comment_vote_down_777"></a></div>
                <div class="c3">Posted on 07 September 2026, 10:30 by: &nbsp; <a href="https://forums.e-hentai.org/index.php?showuser=1234">Reader</a>&nbsp; &nbsp; <a href="https://forums.e-hentai.org/index.php?showuser=1234"><img class="ygm" src="https://ehgt.org/g/ygm.png" alt="PM" title="Contact Poster" /></a></div>
                <div class="c5 nosel" onmouseover="document.getElementById('cvotes_777').style.display=''">Score <span id="comment_score_777" style="opacity:1.0">+4</span></div>
                <div class="c"></div>
              </div>
              <div class="c6" id="comment_777">Useful<br>comment</div>
              <div class="c7" id="cvotes_777" style="display:none">Base +4</div>
            </div>
          </div>"#;
        let comments = parse_eh_comments(html);
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].id, "777");
        assert_eq!(comments[0].author, "Reader");
        assert_eq!(comments[0].body, "Useful\ncomment");
        assert_eq!(comments[0].score, 4);
        assert_eq!(comments[0].posted_at, "2026-09-07 10:30");
        assert_eq!(comments[0].my_vote, 1);
        assert!(!comments[0].is_uploader);
        assert!(!comments[0].is_editable);
    }

    #[test]
    fn parse_comments_do_not_inherit_a_vote_from_any_style_attribute() {
        // Real vote links carry a style attribute whether or not the account
        // voted — only `color:blue` marks a cast vote. Bare `style=` matching
        // once marked every comment in the list as up-voted.
        let html = r#"<div class="c1"><div class="c4 nosel"><a id="comment_vote_up_9" style="display:none"></a><a id="comment_vote_down_9" style="display:none"></a></div><div class="c3">Posted on 21 October 2023, 15:12 by: <a>x</a></div><div class="c6" id="comment_9">Body</div></div>"#;
        let comments = parse_eh_comments(html);
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].my_vote, 0);
    }

    #[test]
    fn parse_comments_marks_uploader_and_editable_comment() {
        // The real uploader marker is the `ulcomment` anchor inside the c4
        // block ("Uploader Comment"), and an own comment carries Edit there.
        let html = r#"<div class="c1"><div class="c2"><div class="c4 nosel"><a name="ulcomment"></a>Uploader Comment <a onclick="edit_comment(8)">Edit</a></div><div class="c3">Posted on Today by: &nbsp; <a href="https://e-hentai.org/uploader/Uploader">Uploader</a></div><div class="c5 nosel">Score <span id="comment_score_8"></span></div><div class="c"></div></div><div class="c6" id="comment_8">Mine</div></div>"#;
        let comments = parse_eh_comments(html);
        assert_eq!(comments.len(), 1);
        assert!(comments[0].is_uploader);
        assert!(comments[0].is_editable);
        assert_eq!(comments[0].score, 0);
        assert_eq!(comments[0].posted_at, "Today");
    }

    #[test]
    fn parse_comments_does_not_mark_every_poster_as_uploader() {
        // Every commenter's name links to /uploader/<name> — it is just the
        // profile link and must not imply the gallery uploader.
        let html = r#"<div class="c1"><div class="c2"><div class="c3">Posted on 21 October 2023, 15:12 by: &nbsp; <a href="https://e-hentai.org/uploader/dxf19971218">dxf19971218</a></div><div class="c5 nosel">Score <span id="comment_score_9">+1</span></div><div class="c"></div></div><div class="c6" id="comment_9">Hello</div></div>"#;
        let comments = parse_eh_comments(html);
        assert_eq!(comments.len(), 1);
        assert!(!comments[0].is_uploader);
        assert_eq!(comments[0].score, 1);
    }

    #[test]
    fn comment_scores_handle_signed_and_grouped_numbers() {
        assert_eq!(parse_comment_score("Score <span id=\"comment_score_1\" style=\"opacity:1.0\">+1,337</span>"), 1337);
        assert_eq!(parse_comment_score("Score <span id=\"comment_score_2\">-3</span>"), -3);
        assert_eq!(parse_comment_score("Score <span id=\"comment_score_3\"></span>"), 0);
    }

    #[test]
    fn posted_times_normalize_to_sortable_format() {
        assert_eq!(normalize_eh_posted_time("Posted on 11 August 2026, 09:44 by: &nbsp; <a>cirrostratus</a>"), "2026-08-11 09:44");
        assert_eq!(normalize_eh_posted_time("Posted on 1 January 2025, 00:05 by: <a>x</a>"), "2025-01-01 00:05");
        assert_eq!(normalize_eh_posted_time("Posted on Yesterday 13:00 by: <a>x</a>"), "Yesterday 13:00");
        assert_eq!(normalize_eh_posted_time(""), "");
    }

    #[test]
    fn comment_vote_key_material_comes_from_page_and_cookie() {
        assert_eq!(apikey_from_page("<script>var apikey = \"a1b2c3d4e5\";</script>"), Some("a1b2c3d4e5"));
        assert_eq!(apikey_from_page("<p>no key here</p>"), None);
        assert_eq!(apiuid_from_cookie("ipb_member_id=3670848; ipb_pass_hash=abc"), Some("3670848"));
        assert_eq!(apiuid_from_cookie("ipb_pass_hash=abc"), None);
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

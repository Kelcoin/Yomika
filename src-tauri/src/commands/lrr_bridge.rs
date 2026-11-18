//! Optional LANraragi-owned reading state. Local tables are disposable mirrors;
//! the durable outbox never claims a queued operation was remotely committed.
mod collections;
use super::library::SystemCredentialStore;
use crate::domain::result::CommandResult;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

fn schema(c: &Connection) -> Result<(), String> {
    collections::schema(c)?;
    c.execute_batch("CREATE TABLE IF NOT EXISTS lrr_bridge_config(scope_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, server_id TEXT, epoch TEXT);
CREATE TABLE IF NOT EXISTS lrr_bridge_states(scope_id TEXT, archive_id TEXT, state TEXT NOT NULL, PRIMARY KEY(scope_id,archive_id));
CREATE TABLE IF NOT EXISTS lrr_bridge_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope_id TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,archive_id TEXT NOT NULL,operation TEXT NOT NULL,conflict INTEGER NOT NULL DEFAULT 0,attempted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS lrr_bridge_list_snapshot(scope_id TEXT,kind TEXT,archive_id TEXT,PRIMARY KEY(scope_id,kind,archive_id));
CREATE TABLE IF NOT EXISTS lrr_bridge_list_cursor(scope_id TEXT,kind TEXT,next_offset INTEGER,version INTEGER,PRIMARY KEY(scope_id,kind));
CREATE TABLE IF NOT EXISTS lrr_bridge_baseline(scope_id TEXT,table_name TEXT,row_json TEXT);") .map_err(|e|e.to_string())
}
pub(crate) fn enabled(c: &Connection, scope: &str) -> bool {
    c.query_row(
        "SELECT enabled FROM lrr_bridge_config WHERE scope_id=?1",
        [scope],
        |r| r.get::<_, bool>(0),
    )
    .unwrap_or(false)
}
pub(crate) fn queue_nonduplicate(
    c: &Connection,
    scope: &str,
    left: &str,
    right: &str,
    present: bool,
) -> Result<(), String> {
    schema(c)?;
    let (a, b) = if left < right {
        (left, right)
    } else {
        (right, left)
    };
    collections::queue_in(
        c,
        scope,
        json!({"collection":"non_duplicates","key":format!("{a}:{b}"),"value":if present{json!({"archiveIdA":a,"archiveIdB":b})}else{Value::Null}}),
    )?;
    Ok(())
}
fn config(c: &Connection, scope: &str) -> Result<Value, String> {
    schema(c)?;
    let id: Option<String> = c
        .query_row(
            "SELECT server_id FROM lrr_bridge_config WHERE scope_id=?1",
            [scope],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let (pending, conflicts): (i64, i64) = c
        .query_row(
            "SELECT COUNT(*),COALESCE(SUM(conflict),0) FROM lrr_bridge_outbox WHERE scope_id=?1",
            [scope],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(json!({"enabled":enabled(c,scope),"serverId":id,"pending":pending,"conflicts":conflicts}))
}
async fn db<T: Send + 'static>(
    app: &tauri::AppHandle,
    f: impl FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let path = crate::data_paths::data_dir(app)
        .map_err(|e| e.to_string())?
        .join("yomika.sqlite3");
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = Connection::open(path).map_err(|e| e.to_string())?;
        c.busy_timeout(std::time::Duration::from_secs(3))
            .map_err(|e| e.to_string())?;
        schema(&c)?;
        f(&mut c)
    })
    .await
    .map_err(|_| "Bridge database task failed".to_string())?
}
fn reply(result: Result<Value, String>) -> CommandResult<Value> {
    match result {
        Ok(v) => CommandResult::success(v),
        Err(e) => {
            let code = if e.contains("conflict")
                || e.contains("changed during pagination")
                || e == "Invalid bridge pagination"
            {
                "REMOTE_CONFLICT"
            } else if e.contains("Invalid")
                || e.contains("Missing")
                || e.contains("exceeds")
                || e.contains("disabled")
            {
                "INVALID_INPUT"
            } else {
                "REMOTE_UNAVAILABLE"
            };
            let retryable = e.contains("network") || e.contains("task failed");
            CommandResult::failure(code, e, retryable)
        }
    }
}
fn gate() -> &'static tokio::sync::Mutex<()> {
    static G: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    G.get_or_init(|| tokio::sync::Mutex::new(()))
}
fn request_url(base: &str, action: &str, input: Value) -> Result<url::Url, String> {
    let mut request = input
        .as_object()
        .cloned()
        .ok_or("Bridge input must be an object")?;
    request.insert("protocol".into(), json!(1));
    request.insert("action".into(), json!(action));
    let arg = serde_json::to_string(&request).map_err(|_| "Invalid bridge request")?;
    let encoded: String = url::form_urlencoded::byte_serialize(arg.as_bytes()).collect();
    if encoded.len() > 5900 {
        return Err("Bridge request exceeds 6000 encoded bytes".into());
    }
    let mut url = url::Url::parse(&format!("{}/api/plugins/use", base.trim_end_matches('/')))
        .map_err(|_| "Invalid server URL")?;
    url.query_pairs_mut()
        .append_pair("plugin", "yomikabridge")
        .append_pair("arg", &arg);
    Ok(url)
}

fn plugin_error(code: &str) -> String {
    match code {
        "BRIDGE_INVALID_REQUEST"
        | "BRIDGE_TOO_LARGE"
        | "BRIDGE_ARCHIVE_NOT_FOUND"
        | "BRIDGE_OPERATION_REUSED" => format!("Bridge plugin rejected request: {code}"),
        _ => "Bridge network request failed".into(),
    }
}
async fn remote(
    app: &tauri::AppHandle,
    scope: &str,
    action: &str,
    input: Value,
    detect: bool,
) -> Result<Value, String> {
    let s = scope.to_owned();
    let (base, id, epoch) = db(app, move |c| {
        if !detect && !enabled(c, &s) {
            return Err("LANraragi bridge is disabled".into());
        }
        let base: String = c
            .query_row(
                "SELECT base_url FROM servers WHERE scope_id=?1",
                [&s],
                |r| r.get(0),
            )
            .map_err(|_| "Unknown server scope".to_string())?;
        let identity: (Option<String>, Option<String>) = c
            .query_row(
                "SELECT server_id,epoch FROM lrr_bridge_config WHERE scope_id=?1",
                [&s],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        Ok((base, identity.0, identity.1))
    })
    .await?;
    let url = request_url(&base, action, input)?;
    let s = scope.to_owned();
    let key =
        tauri::async_runtime::spawn_blocking(move || SystemCredentialStore.get_server_api_key(&s))
            .await
            .map_err(|_| "Credential task failed")?
            .map_err(|_| "Server credentials unavailable")?;
    let mut response = super::library::reader_request_with_timeout(
        reqwest::Method::POST,
        url.to_string(),
        key,
        12,
    )
    .await
    .map_err(|_| "Bridge network request failed")?;
    if !response.status().is_success() {
        return Err(
            if response.status().is_server_error() || response.status().as_u16() == 429 {
                "Bridge network request failed"
            } else {
                "Bridge HTTP request rejected"
            }
            .into(),
        );
    }
    let length = response.content_length().unwrap_or(0);
    if length > 2_000_000 {
        return Err("Bridge response too large".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Bridge network request failed")?
    {
        if bytes.len() + chunk.len() > 2_000_000 {
            return Err("Bridge response too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let wire: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid bridge response")?;
    let data = wire
        .get("data")
        .cloned()
        .ok_or("Bridge plugin is unavailable")?;
    if wire["success"] != 1 && data["errorCode"] != "BRIDGE_CONFLICT" {
        let code = data["errorCode"]
            .as_str()
            .filter(|v| {
                v.starts_with("BRIDGE_") && v.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
            })
            .unwrap_or("BRIDGE_REJECTED");
        return Err(plugin_error(code));
    }
    if data["protocol"] != 1
        || data["serverId"].as_str().is_none_or(|s| s.is_empty())
        || data["epoch"].as_str().is_none_or(|s| s.is_empty())
        || data["version"].as_i64().is_none_or(|v| v < 0)
    {
        return Err("Unsupported bridge protocol".into());
    }
    if action == "hello" && data["capabilities"]["collections"] != true {
        return Err("Bridge plugin upgrade required for hosted user data".into());
    }
    if id
        .as_deref()
        .is_some_and(|v| Some(v) != data["serverId"].as_str())
        || epoch
            .as_ref()
            .is_some_and(|v| v != &data["epoch"].to_string())
    {
        return Err("Bridge server identity changed; reconnect explicitly".into());
    }
    Ok(data)
}
fn state(c: &Connection, scope: &str, id: &str) -> Result<Value, String> {
    let raw: Option<String> = c
        .query_row(
            "SELECT state FROM lrr_bridge_states WHERE scope_id=?1 AND archive_id=?2",
            params![scope, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|v|serde_json::from_str(&v).map_err(|e|e.to_string())).unwrap_or_else(||Ok(json!({"archiveId":id,"version":0,"generation":0,"progress":null,"historyAt":null,"watchlistAt":null})))
}

fn validate_state(s: &Value) -> Result<(), String> {
    let id = s["archiveId"]
        .as_str()
        .ok_or("Invalid bridge archive state")?;
    if id.len() != 40
        || !id
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
        || s["version"].as_i64().is_none_or(|v| v < 0)
        || s["generation"].as_i64().is_none_or(|v| v < 0)
    {
        return Err("Invalid bridge state identity".into());
    }
    for key in ["historyAt", "watchlistAt"] {
        if s.get(key).is_none() || (!s[key].is_null() && !s[key].is_string()) {
            return Err("Invalid bridge state timestamp".into());
        }
    }
    if let Some(page) = s.get("historyPageIndex") {
        if page.as_i64().is_none_or(|v| !(0..1_000_000).contains(&v)) || s["historyAt"].is_null() {
            return Err("Invalid bridge history page".into());
        }
    }
    let p = s.get("progress").ok_or("Invalid bridge state progress")?;
    if !p.is_null() {
        let page = p["pageIndex"].as_i64().ok_or("Invalid bridge page")?;
        let count = p["pageCount"].as_i64().ok_or("Invalid bridge page count")?;
        if page < 0
            || count <= 0
            || count > 1_000_000
            || page >= count
            || !matches!(p["layout"].as_str(), Some("paged" | "continuous"))
            || !matches!(p["direction"].as_str(), Some("ltr" | "rtl"))
            || p["updatedAt"].as_str().is_none()
            || p.get("coverAlone").is_none()
            || (!p["coverAlone"].is_null() && !p["coverAlone"].is_boolean())
        {
            return Err("Invalid bridge progress".into());
        }
    }
    Ok(())
}

fn mirror(c: &Connection, scope: &str, s: &Value) -> Result<(), String> {
    let id = s["archiveId"]
        .as_str()
        .ok_or("Invalid bridge archive state")?;
    c.execute("INSERT INTO lrr_bridge_states VALUES(?1,?2,?3) ON CONFLICT(scope_id,archive_id) DO UPDATE SET state=excluded.state",params![scope,id,s.to_string()]).map_err(|e|e.to_string())?;
    for table in ["reading_progress", "reading_history", "reading_list"] {
        c.execute(
            &format!("DELETE FROM {table} WHERE scope_id=?1 AND archive_id=?2"),
            params![scope, id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(p) = s["progress"].as_object() {
        c.execute("INSERT INTO reading_progress(scope_id,archive_id,page_index,page_count,layout,direction,cover_alone,updated_at,revision,hidden_from_history) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![scope,id,p.get("pageIndex").and_then(Value::as_i64).unwrap_or(0),p.get("pageCount").and_then(Value::as_i64).unwrap_or(0),p.get("layout").and_then(Value::as_str).unwrap_or("paged"),p.get("direction").and_then(Value::as_str).unwrap_or("ltr"),p.get("coverAlone").and_then(Value::as_bool),p.get("updatedAt").and_then(Value::as_str).unwrap_or("1970-01-01"),s["version"].as_i64().unwrap_or(0).max(1),s["historyAt"].is_null()]).map_err(|e|e.to_string())?;
    }
    if let Some(at) = s["historyAt"].as_str() {
        c.execute("INSERT INTO reading_history(scope_id,archive_id,page_index,visited_at,device_id) VALUES(?1,?2,?3,?4,'lrr-bridge')",params![scope,id,s["historyPageIndex"].as_i64().or_else(|| s["progress"]["pageIndex"].as_i64()).unwrap_or(0),at]).map_err(|e|e.to_string())?;
    }
    if let Some(at) = s["watchlistAt"].as_str() {
        c.execute("INSERT INTO reading_list(scope_id,archive_id,added_at,updated_at,device_id) VALUES(?1,?2,?3,?3,'lrr-bridge')",params![scope,id,at]).map_err(|e|e.to_string())?;
    }
    Ok(())
}
fn queue(c: &mut Connection, scope: &str, mut operation: Value) -> Result<Value, String> {
    if !enabled(c, scope) {
        return Err("LANraragi bridge is disabled".into());
    }
    let id = operation["archiveId"]
        .as_str()
        .ok_or("Missing archive ID")?
        .to_owned();
    if id.len() != 40
        || !id
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
    {
        return Err("Invalid archive ID".into());
    }
    if !matches!(
        operation["kind"].as_str(),
        Some(
            "progress" | "watchlist_add" | "watchlist_remove" | "history_delete" | "progress_clear"
        )
    ) {
        return Err("Invalid bridge operation".into());
    }
    if let Some(flag) = operation["progress"]
        .get("allowProgressRegression")
        .cloned()
    {
        if operation.get("allowProgressRegression").is_none() {
            operation["allowProgressRegression"] = flag;
        }
        if let Some(p) = operation["progress"].as_object_mut() {
            p.remove("allowProgressRegression");
        }
    }
    if operation["kind"] == "progress" && operation.get("allowProgressRegression").is_none() {
        operation["allowProgressRegression"] = json!(true);
    }
    if operation
        .get("allowProgressRegression")
        .is_some_and(|v| !v.is_boolean())
        || operation["progress"]
            .get("coverAlone")
            .is_some_and(|v| !v.is_null() && !v.is_boolean())
    {
        return Err("Invalid progress preference".into());
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    if !enabled(&tx, scope) {
        return Err("LANraragi bridge is disabled".into());
    }
    let mut s = state(&tx, scope, &id)?;
    let busy: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM lrr_bridge_outbox WHERE scope_id=?1 AND archive_id=?2)",
            params![scope, id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if busy {
        let conflict:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM lrr_bridge_outbox WHERE scope_id=?1 AND archive_id=?2 AND conflict=1)",params![scope,id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if conflict {
            return Err("Bridge conflict requires explicit resolution".into());
        }
    }
    let previous:Option<(i64,String,bool)>=tx.query_row("SELECT seq,operation,attempted FROM lrr_bridge_outbox WHERE scope_id=?1 AND archive_id=?2 ORDER BY seq DESC LIMIT 1",params![scope,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
    let coalesce = previous.and_then(|(seq, raw, attempted)| {
        serde_json::from_str::<Value>(&raw)
            .ok()
            .filter(|v| {
                !attempted
                    && v["kind"] == "progress"
                    && operation["kind"] == "progress"
                    && v["progress"]["pageCount"] == operation["progress"]["pageCount"]
                    && operation["progress"]["pageIndex"].as_i64()
                        >= v["progress"]["pageIndex"].as_i64()
            })
            .map(|v| (seq, v))
    });
    let op_id = operation["id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "{}-{}",
                crate::settings::get_or_create_device_id(&tx).unwrap_or_else(|_| "device".into()),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            )
        });
    if op_id.is_empty()
        || op_id.len() > 96
        || !op_id
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"_.:-".contains(&v))
    {
        return Err("Invalid operation ID".into());
    }
    operation["id"] = json!(op_id);
    operation["expectedVersion"] = s["version"].clone();
    operation["generation"] = s["generation"].clone();
    if let Some((_, ref prior)) = coalesce {
        operation["expectedVersion"] = prior["expectedVersion"].clone();
    }
    let now = tx
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?;
    match operation["kind"].as_str().unwrap() {
        "progress" => {
            let mut p = operation["progress"].clone();
            if p.get("coverAlone").is_none_or(Value::is_null) {
                p["coverAlone"] = s["progress"]["coverAlone"].clone();
            }
            if p.get("updatedAt").and_then(Value::as_str).is_none() {
                p["updatedAt"] = json!(now);
            }
            if operation["allowProgressRegression"] != true {
                if let (Some(old), Some(new)) =
                    (s["progress"]["pageIndex"].as_i64(), p["pageIndex"].as_i64())
                {
                    p["pageIndex"] = json!(old.max(new));
                    if old > new {
                        p["pageCount"] = s["progress"]["pageCount"].clone();
                    }
                }
            }
            if let Some(map) = p.as_object_mut() {
                map.retain(|key, _| {
                    matches!(
                        key.as_str(),
                        "pageIndex"
                            | "pageCount"
                            | "layout"
                            | "direction"
                            | "coverAlone"
                            | "updatedAt"
                    )
                });
            }
            operation["progress"] = p.clone();
            let page = p["pageIndex"].as_i64().ok_or("Invalid page index")?;
            let count = p["pageCount"].as_i64().ok_or("Invalid page count")?;
            if page < 0
                || count <= 0
                || count > 1_000_000
                || page >= count
                || !matches!(p["layout"].as_str(), Some("paged" | "continuous"))
                || !matches!(p["direction"].as_str(), Some("ltr" | "rtl"))
            {
                return Err("Invalid progress".into());
            }
            s["progress"] = p.clone();
            s["historyAt"] = json!(now);
            s.as_object_mut().unwrap().remove("historyPageIndex");
            if count > 0 && (page + 1) as f64 / count as f64 > 0.9 {
                s["watchlistAt"] = Value::Null;
            }
        }
        "watchlist_add" => {
            if s["watchlistAt"].is_null() {
                s["watchlistAt"] = json!(now);
            }
        }
        "watchlist_remove" => s["watchlistAt"] = Value::Null,
        "history_delete" => {
            s["historyAt"] = Value::Null;
            s.as_object_mut().unwrap().remove("historyPageIndex");
        }
        _ => {
            s["progress"] = Value::Null;
            s["historyAt"] = Value::Null;
            s.as_object_mut().unwrap().remove("historyPageIndex");
            s["generation"] = json!(s["generation"].as_i64().unwrap_or(0) + 1);
        }
    }
    let wire = json!({"protocol":1,"action":"apply","operation":operation});
    let encoded: String =
        url::form_urlencoded::byte_serialize(wire.to_string().as_bytes()).collect();
    if encoded.len() > 5900 {
        return Err("Bridge request exceeds 5900 encoded bytes".into());
    }
    if let Some((seq, _)) = coalesce {
        tx.execute("DELETE FROM lrr_bridge_outbox WHERE seq=?1", [seq])
            .map_err(|e| e.to_string())?;
    }
    tx.execute("INSERT INTO lrr_bridge_outbox(scope_id,operation_id,archive_id,operation) VALUES(?1,?2,?3,?4)",params![scope,op_id,id,operation.to_string()]).map_err(|e|e.to_string())?;
    s["version"] = json!(operation["expectedVersion"].as_i64().unwrap_or(0) + 1);
    mirror(&tx, scope, &s)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"queued":true,"state":s}))
}

fn reconcile_list(c: &Connection, scope: &str, input: &Value, data: &Value) -> Result<(), String> {
    let kind = input["kind"].as_str().ok_or("Invalid list kind")?;
    match kind {
        "history" | "watchlist" => {}
        _ => return Err("Invalid list kind".into()),
    };
    let offset = input["offset"].as_i64().unwrap_or(0);
    let states = data["states"].as_array().ok_or("Invalid list states")?;
    if offset == 0 {
        c.execute(
            "DELETE FROM lrr_bridge_list_snapshot WHERE scope_id=?1 AND kind=?2",
            params![scope, kind],
        )
        .map_err(|e| e.to_string())?;
        c.execute("INSERT INTO lrr_bridge_list_cursor VALUES(?1,?2,0,?3) ON CONFLICT(scope_id,kind) DO UPDATE SET next_offset=0,version=excluded.version",params![scope,kind,data["version"].as_i64().unwrap_or(0)]).map_err(|e|e.to_string())?;
    }
    let next: Option<i64> = c
        .query_row(
            "SELECT next_offset FROM lrr_bridge_list_cursor WHERE scope_id=?1 AND kind=?2",
            params![scope, kind],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let version: i64 = c
        .query_row(
            "SELECT version FROM lrr_bridge_list_cursor WHERE scope_id=?1 AND kind=?2",
            params![scope, kind],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(-1);
    if next.is_some() && version != data["version"].as_i64().unwrap_or(0) {
        return Err("Bridge list changed during pagination; retry from first page".into());
    }
    if next != Some(offset) {
        return Ok(());
    }
    for state in states {
        c.execute(
            "INSERT OR IGNORE INTO lrr_bridge_list_snapshot VALUES(?1,?2,?3)",
            params![scope, kind, state["archiveId"].as_str()],
        )
        .map_err(|e| e.to_string())?;
    }
    let end = offset + states.len() as i64;
    c.execute(
        "UPDATE lrr_bridge_list_cursor SET next_offset=?3 WHERE scope_id=?1 AND kind=?2",
        params![scope, kind, end],
    )
    .map_err(|e| e.to_string())?;
    // Missing membership is not evidence of cleared progress or generation.
    // refresh_missing_list_states fetches the actual authoritative records.
    Ok(())
}

fn missing_list_ids(
    c: &Connection,
    scope: &str,
    kind: &str,
    field: &str,
    offset: i64,
    page_ids: &std::collections::HashSet<String>,
) -> Result<Vec<String>, String> {
    let sql=format!("SELECT archive_id FROM lrr_bridge_states WHERE scope_id=?1 AND (json_extract(state,'$.{field}') IS NOT NULL OR ('{field}'='historyAt' AND json_type(state,'$.progress')='object')) AND (?3=0 OR archive_id NOT IN(SELECT archive_id FROM lrr_bridge_list_snapshot WHERE scope_id=?1 AND kind=?2)) AND archive_id NOT IN(SELECT archive_id FROM lrr_bridge_outbox WHERE scope_id=?1)");
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map(params![scope, kind, offset], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ids
        .into_iter()
        .filter(|id| !page_ids.contains(id))
        .collect())
}
async fn refresh_missing_list_states(
    app: &tauri::AppHandle,
    scope: &str,
    input: &Value,
    data: &Value,
) -> Result<(), String> {
    let rows = data["states"].as_array().ok_or("Invalid list states")?;
    let offset = input["offset"].as_i64().unwrap_or(0);
    if offset + (rows.len() as i64) < data["total"].as_i64().ok_or("Invalid list total")? {
        return Ok(());
    }
    let kind = input["kind"]
        .as_str()
        .ok_or("Invalid list kind")?
        .to_owned();
    let field = match kind.as_str() {
        "history" => "historyAt",
        "watchlist" => "watchlistAt",
        _ => return Err("Invalid list kind".into()),
    };
    let page_ids = rows
        .iter()
        .filter_map(|v| v["archiveId"].as_str().map(str::to_owned))
        .collect::<std::collections::HashSet<_>>();
    let owned = scope.to_owned();
    let ids = db(app, move |c| {
        missing_list_ids(c, &owned, &kind, field, offset, &page_ids)
    })
    .await?;
    for chunk in ids.chunks(32) {
        let data = remote(app, scope, "states", json!({"ids":chunk}), false).await?;
        let rows = data["states"]
            .as_array()
            .ok_or("Invalid missing archive states")?
            .clone();
        if rows.len() != chunk.len() {
            return Err("Incomplete missing archive states".into());
        }
        let requested = chunk.to_vec();
        for r in &rows {
            validate_state(r)?;
            if !requested
                .iter()
                .any(|id| Some(id.as_str()) == r["archiveId"].as_str())
            {
                return Err("Unexpected missing archive state".into());
            }
        }
        let owned = scope.to_owned();
        db(app,move|c|{
            let tx=c.transaction().map_err(|e|e.to_string())?;
            for r in rows{let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM lrr_bridge_outbox WHERE scope_id=?1 AND archive_id=?2)",params![owned,r["archiveId"].as_str()],|r|r.get(0)).map_err(|e|e.to_string())?;if !pending{mirror(&tx,&owned,&r)?;}}
            tx.commit().map_err(|e|e.to_string())?;Ok(())
        }).await?;
    }
    Ok(())
}

fn cached(c: &Connection, scope: &str, action: &str, input: &Value) -> Result<Value, String> {
    if !enabled(c, scope) {
        return Err("LANraragi bridge is disabled".into());
    }
    let (id, epoch): (String, String) = c
        .query_row(
            "SELECT server_id,epoch FROM lrr_bridge_config WHERE scope_id=?1",
            [scope],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let mut states = Vec::new();
    if action == "states" {
        for id in input["ids"].as_array().ok_or("Invalid archive IDs")? {
            states.push(state(c, scope, id.as_str().ok_or("Invalid archive ID")?)?);
        }
    } else {
        let mut stmt = c
            .prepare("SELECT state FROM lrr_bridge_states WHERE scope_id=?1")
            .map_err(|e| e.to_string())?;
        for raw in stmt
            .query_map([scope], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
        {
            let v: Value = serde_json::from_str(&raw.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let key = if input["kind"] == "watchlist" {
                "watchlistAt"
            } else {
                "historyAt"
            };
            if action == "export" || !v[key].is_null() {
                states.push(v);
            }
        }
        let key = if input["kind"] == "watchlist" {
            "watchlistAt"
        } else {
            "historyAt"
        };
        states.sort_by(|a, b| b[key].as_str().cmp(&a[key].as_str()));
    }
    let total = states.len();
    if action != "states" {
        states = states
            .into_iter()
            .skip(input["offset"].as_u64().unwrap_or(0) as usize)
            .take(input["limit"].as_u64().unwrap_or(100).min(100) as usize)
            .collect();
    }
    Ok(
        json!({"protocol":1,"serverId":id,"epoch":serde_json::from_str::<Value>(&epoch).unwrap_or(json!(epoch)),"version":0,"states":states,"total":total,"offline":true}),
    )
}

#[tauri::command]
pub async fn lrr_bridge_config(app: tauri::AppHandle, scope_id: String) -> CommandResult<Value> {
    reply(db(&app, move |c| config(c, &scope_id)).await)
}
fn configure_in(
    c: &Connection,
    scope_id: String,
    enabled: bool,
    hello: Option<Value>,
) -> Result<Value, String> {
    if !enabled && config(c, &scope_id)?["pending"].as_i64().unwrap_or(0) > 0 {
        return Err("Flush or resolve pending bridge operations before disabling".into());
    }
    let old = super::lrr_bridge::enabled(c, &scope_id);
    if old != enabled {
        for table in [
            "reading_progress",
            "reading_history",
            "reading_list",
            "search_presets",
            "dedup_non_duplicates",
        ] {
            if enabled {
                // Preserve every original column and restore it on disable; no upload/migration.
                let mut stmt = c
                    .prepare(&format!("SELECT * FROM {table} WHERE scope_id=?1"))
                    .map_err(|e| e.to_string())?;
                let columns: Vec<String> =
                    stmt.column_names().iter().map(|v| v.to_string()).collect();
                let rows = stmt
                    .query_map([&scope_id], |r| {
                        let mut map = serde_json::Map::new();
                        for (i, name) in columns.iter().enumerate() {
                            let v = r.get_ref(i)?;
                            map.insert(
                                name.clone(),
                                match v {
                                    rusqlite::types::ValueRef::Null => Value::Null,
                                    rusqlite::types::ValueRef::Integer(v) => json!(v),
                                    rusqlite::types::ValueRef::Real(v) => json!(v),
                                    rusqlite::types::ValueRef::Text(v) => {
                                        json!(String::from_utf8_lossy(v))
                                    }
                                    _ => Value::Null,
                                },
                            );
                        }
                        Ok(Value::Object(map))
                    })
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                for row in rows {
                    c.execute(
                        "INSERT INTO lrr_bridge_baseline VALUES(?1,?2,?3)",
                        params![scope_id, table, row.to_string()],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            c.execute(
                &format!("DELETE FROM {table} WHERE scope_id=?1"),
                [&scope_id],
            )
            .map_err(|e| e.to_string())?;
            if !enabled {
                let mut stmt=c.prepare("SELECT row_json FROM lrr_bridge_baseline WHERE scope_id=?1 AND table_name=?2").map_err(|e|e.to_string())?;
                let rows = stmt
                    .query_map(params![scope_id, table], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                for raw in rows {
                    let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                    let m = v.as_object().ok_or("Invalid bridge baseline")?;
                    let cols = m.keys().cloned().collect::<Vec<_>>();
                    let vals = m
                        .values()
                        .map(|v| match v {
                            Value::Null => rusqlite::types::Value::Null,
                            Value::Number(n) => {
                                rusqlite::types::Value::Integer(n.as_i64().unwrap_or(0))
                            }
                            _ => rusqlite::types::Value::Text(v.as_str().unwrap_or("").into()),
                        })
                        .collect::<Vec<_>>();
                    c.execute(
                        &format!(
                            "INSERT INTO {table}({}) VALUES({})",
                            cols.join(","),
                            vec!["?"; cols.len()].join(",")
                        ),
                        rusqlite::params_from_iter(vals),
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
        if enabled {
            c.execute(
                "DELETE FROM lrr_bridge_collections WHERE scope_id=?1",
                [&scope_id],
            )
            .map_err(|e| e.to_string())?;
            c.execute(
                "DELETE FROM lrr_bridge_states WHERE scope_id=?1",
                [&scope_id],
            )
            .map_err(|e| e.to_string())?;
        }
        if !enabled {
            c.execute(
                "DELETE FROM lrr_bridge_baseline WHERE scope_id=?1",
                [&scope_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    c.execute("INSERT INTO lrr_bridge_config(scope_id,enabled,server_id,epoch) VALUES(?1,?2,?3,?4) ON CONFLICT(scope_id) DO UPDATE SET enabled=excluded.enabled,server_id=COALESCE(excluded.server_id,server_id),epoch=COALESCE(excluded.epoch,epoch)",params![scope_id,enabled,hello.as_ref().and_then(|v|v["serverId"].as_str()),hello.as_ref().map(|v|v["epoch"].to_string())]).map_err(|e|e.to_string())?;
    config(c, &scope_id)
}
fn configure_local(
    c: &mut Connection,
    scope_id: String,
    enabled: bool,
    hello: Option<Value>,
) -> Result<Value, String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let value = configure_in(&tx, scope_id, enabled, hello)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(value)
}
fn abandon_pending(c: &mut Connection, scope: String) -> Result<Value, String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM lrr_bridge_outbox WHERE scope_id=?1", [&scope])
        .map_err(|e| e.to_string())?;
    configure_in(&tx, scope.clone(), false, None)?;
    for table in [
        "lrr_bridge_states",
        "lrr_bridge_collections",
        "lrr_bridge_list_snapshot",
        "lrr_bridge_list_cursor",
    ] {
        tx.execute(&format!("DELETE FROM {table} WHERE scope_id=?1"), [&scope])
            .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE lrr_bridge_config SET server_id=NULL,epoch=NULL WHERE scope_id=?1",
        [&scope],
    )
    .map_err(|e| e.to_string())?;
    let value = config(&tx, &scope)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(value)
}

#[tauri::command]
pub async fn lrr_bridge_configure(
    app: tauri::AppHandle,
    scope_id: String,
    enabled: bool,
) -> CommandResult<Value> {
    let _guard = gate().lock().await;
    let result = async {
        let hello = if enabled {
            Some(remote(&app, &scope_id, "hello", json!({}), true).await?)
        } else {
            None
        };
        db(&app, move |c| configure_local(c, scope_id, enabled, hello)).await
    }
    .await;
    reply(result)
}
#[tauri::command]
pub async fn lrr_bridge_request(
    app: tauri::AppHandle,
    scope_id: String,
    action: String,
    input: Value,
) -> CommandResult<Value> {
    if action == "collection_apply" {
        return reply(
            db(&app, move |c| {
                collections::queue(c, &scope_id, input["operation"].clone())
            })
            .await,
        );
    }
    if action == "apply" {
        return reply(
            db(&app, move |c| {
                queue(c, &scope_id, input["operation"].clone())
            })
            .await,
        );
    }
    let _guard = gate().lock().await;
    let result=async{
        if !matches!(action.as_str(),"hello"|"list"|"states"|"export"|"workspace_get"|"workspace_put"|"collection_list"|"discard_conflicts"|"abandon_pending"){return Err("Unsupported bridge action".into());}
        if action=="collection_list"{return collections::list(&app,&scope_id,input).await;}
        if action=="abandon_pending"{return db(&app,move|c|abandon_pending(c,scope_id)).await;}
        if action=="discard_conflicts"{
            let scope=scope_id.clone();let ids=db(&app,move|c|{let mut stmt=c.prepare("SELECT DISTINCT archive_id FROM lrr_bridge_outbox WHERE scope_id=?1 AND conflict=1 ORDER BY archive_id LIMIT 50").map_err(|e|e.to_string())?;let rows=stmt.query_map([scope],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;Ok(rows)}).await?;
            let mut reading_ids=Vec::new();
            for id in ids {if id.starts_with("collection:"){collections::discard(&app,&scope_id,&id).await?;}else{reading_ids.push(id);}}
            let ids=reading_ids;
            if !ids.is_empty(){let authoritative=remote(&app,&scope_id,"states",json!({"ids":ids}),false).await?;let scope=scope_id.clone();db(&app,move|c|{let tx=c.transaction().map_err(|e|e.to_string())?;let states=authoritative["states"].as_array().ok_or("Invalid bridge states")?;if states.len()!=ids.len(){return Err("Incomplete conflict states".into());}for state in states{let id=state["archiveId"].as_str().ok_or("Invalid archive ID")?;if !ids.iter().any(|i|i==id){return Err("Unexpected conflict archive state".into());}tx.execute("DELETE FROM lrr_bridge_outbox WHERE scope_id=?1 AND archive_id=?2",params![scope,id]).map_err(|e|e.to_string())?;mirror(&tx,&scope,state)?;}tx.commit().map_err(|e|e.to_string())?;Ok(())}).await?;}
            return db(&app,move|c|config(c,&scope_id)).await;
        }
        if action=="list"{
            let scope=scope_id.clone();let pending=db(&app,move|c|Ok(config(c,&scope)?["pending"].as_i64().unwrap_or(0)>0)).await?;
            if pending{
                let kind=input["kind"].clone();let mut offset=0;let mut stamp=None;
                for _ in 0..32 {
                    let page_input=json!({"kind":kind,"offset":offset,"limit":100});
                    let page=match remote(&app,&scope_id,"list",page_input.clone(),false).await{Ok(v)=>v,Err(e)=>{if e=="Bridge network request failed"{return db(&app,move|c|cached(c,&scope_id,"list",&input)).await;}return Err(e);}};
                    let version=page["version"].clone();if stamp.as_ref().is_some_and(|v|v!=&version){return Err("Bridge list changed during pagination; retry from first page".into());}stamp=Some(version.clone());let final_stamp=version;
                    let count=page["states"].as_array().ok_or("Invalid list states")?.len();let total=page["total"].as_u64().ok_or("Invalid list total")?;
                    refresh_missing_list_states(&app,&scope_id,&page_input,&page).await?;
                    let scope=scope_id.clone();db(&app,move|c|{let tx=c.transaction().map_err(|e|e.to_string())?;reconcile_list(&tx,&scope,&page_input,&page)?;for s in page["states"].as_array().ok_or("Invalid states")?{let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM lrr_bridge_outbox WHERE scope_id=?1 AND archive_id=?2)",params![scope,s["archiveId"].as_str()],|r|r.get(0)).map_err(|e|e.to_string())?;if !pending{mirror(&tx,&scope,s)?;}}tx.commit().map_err(|e|e.to_string())?;Ok(())}).await?;
                    offset+=count as u64;if offset>=total{let scope=scope_id.clone();return db(&app,move|c|{let mut v=cached(c,&scope,"list",&input)?;v["offline"]=json!(false);v["version"]=final_stamp;Ok(v)}).await;}if count==0{return Err("Invalid bridge pagination".into());}
                }
                return Err("Bridge list exceeds bounded snapshot; flush pending operations first".into());
            }
        }
        let request_input=input.clone();let list_action=action=="list";
        let mut data=match remote(&app,&scope_id,&action,input.clone(),action=="hello").await{Ok(v)=>v,Err(e)=>{if matches!(action.as_str(),"states"|"list"|"export") && e=="Bridge network request failed"{return db(&app,move|c|cached(c,&scope_id,&action,&input)).await;}return Err(e);}};
        if let Some(states)=data["states"].as_array_mut(){let scope=scope_id.clone();let copy=states.clone();*states=db(&app,move|c|{copy.into_iter().map(|v|{let id=v["archiveId"].as_str().ok_or("Invalid archive state")?;let pending:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM lrr_bridge_outbox WHERE scope_id=?1 AND archive_id=?2)",params![scope,id],|r|r.get(0)).map_err(|e|e.to_string())?;if pending{state(c,&scope,id)}else{Ok(v)}}).collect::<Result<Vec<_>,String>>()}).await?;}
        if list_action{refresh_missing_list_states(&app,&scope_id,&request_input,&data).await?;}
        let copy=data.clone();db(&app,move|c|{let tx=c.transaction().map_err(|e|e.to_string())?;if let Some(states)=copy["states"].as_array(){if list_action{reconcile_list(&tx,&scope_id,&request_input,&copy)?;}for s in states{let id=s["archiveId"].as_str().ok_or("Invalid bridge state")?;let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM lrr_bridge_outbox WHERE scope_id=?1 AND archive_id=?2)",params![scope_id,id],|r|r.get(0)).map_err(|e|e.to_string())?;if !pending{mirror(&tx,&scope_id,s)?;}}}tx.commit().map_err(|e|e.to_string())?;Ok(())}).await?;Ok(data)
    }.await;
    reply(result)
}
#[tauri::command]
pub async fn lrr_bridge_flush(app: tauri::AppHandle, scope_id: String) -> CommandResult<Value> {
    let _guard = gate().lock().await;
    let result=async{
        let s=scope_id.clone();let cfg=db(&app,move|c|config(c,&s)).await?;if cfg["enabled"]!=true{return Ok(cfg);}
        for _ in 0..8{
            let s=scope_id.clone();let next=db(&app,move|c|{let tx=c.transaction().map_err(|e|e.to_string())?;let next=tx.query_row("SELECT operation_id,operation FROM lrr_bridge_outbox WHERE scope_id=?1 AND conflict=0 AND archive_id NOT IN (SELECT archive_id FROM lrr_bridge_outbox WHERE scope_id=?1 AND conflict=1) ORDER BY seq LIMIT 1",[s],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(|e|e.to_string())?;if let Some((ref id,_))=next{tx.execute("UPDATE lrr_bridge_outbox SET attempted=1 WHERE operation_id=?1",[id]).map_err(|e|e.to_string())?;}tx.commit().map_err(|e|e.to_string())?;Ok(next)}).await?;
            let Some((id,raw))=next else{break};let operation:Value=serde_json::from_str(&raw).map_err(|_|"Invalid queued operation")?;
            let action=if operation.get("collection").is_some(){"collection_apply"}else{"apply"};
            let mut data=match remote(&app,&scope_id,action,json!({"operation":operation}),false).await{Ok(v)=>v,Err(e)=>{if e.starts_with("Bridge plugin rejected request:"){let operation_id=id.clone();db(&app,move|c|{c.execute("UPDATE lrr_bridge_outbox SET conflict=1 WHERE operation_id=?1",[operation_id]).map_err(|e|e.to_string())?;Ok(())}).await?;break;}return Err(e);}};
            if data["errorCode"]!="BRIDGE_CONFLICT"{
                // A permanent retry ledger returns the ORIGINAL acknowledgement.
                // Re-read current authority before mirroring, especially after archive deletion.
                if action=="collection_apply"{
                    data["currentRecord"]=remote(&app,&scope_id,"collection_get",json!({"collection":operation["collection"],"key":operation["key"]}),false).await?["record"].clone();
                }else{
                    let current=remote(&app,&scope_id,"states",json!({"ids":[operation["archiveId"]]}),false).await?;
                    let states=current["states"].as_array().ok_or("Invalid acknowledgement states")?;
                    if states.len()!=1||states[0]["archiveId"]!=operation["archiveId"]{return Err("Invalid acknowledgement state identity".into());}
                    validate_state(&states[0])?;if states[0]["version"].as_i64()<data["state"]["version"].as_i64(){return Err("Invalid current state version".into());}data["currentState"]=states[0].clone();
                }
            }
            if action=="collection_apply"{let s=scope_id.clone();db(&app,move|c|collections::acknowledge(c,&s,&id,&operation,&data)).await?;continue;}
            let s=scope_id.clone();db(&app,move|c|{let tx=c.transaction().map_err(|e|e.to_string())?;if data["errorCode"]=="BRIDGE_CONFLICT"{tx.execute("UPDATE lrr_bridge_outbox SET conflict=1 WHERE operation_id=?1",[id]).map_err(|e|e.to_string())?;}else{validate_state(&data["state"])?;if data["state"]["archiveId"]!=operation["archiveId"]||data["state"]["version"].as_i64()!=operation["expectedVersion"].as_i64().map(|v|v+1)||data["state"]["generation"].as_i64()!=operation["generation"].as_i64().map(|v|v+if operation["kind"]=="progress_clear"{1}else{0}){return Err("Invalid bridge apply response".into());}tx.execute("DELETE FROM lrr_bridge_outbox WHERE operation_id=?1",[id]).map_err(|e|e.to_string())?;let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM lrr_bridge_outbox WHERE scope_id=?1 AND archive_id=?2)",params![s,data["state"]["archiveId"].as_str()],|r|r.get(0)).map_err(|e|e.to_string())?;if !pending{mirror(&tx,&s,&data["currentState"])?;}}tx.commit().map_err(|e|e.to_string())?;Ok(())}).await?;
        }
        db(&app,move|c|config(c,&scope_id)).await
    }.await;
    reply(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queued_wire_is_accepted_by_perl_plugin() {
        // Opt in on hosts with Perl. This exercises both implementations rather
        // than duplicating the server's transition logic in a Rust mock.
        let Ok(perl) = std::env::var("YOMIKA_TEST_PERL") else {
            return;
        };
        let mut c = connection();
        let id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        queue(
            &mut c,
            "s",
            json!({"id":"add","archiveId":id,"kind":"watchlist_add"}),
        )
        .unwrap();
        queue(&mut c, "s", progress("p1", 3)).unwrap();
        queue(&mut c, "s", progress("p2", 4)).unwrap();
        queue(
            &mut c,
            "s",
            json!({"id":"delete","archiveId":id,"kind":"history_delete"}),
        )
        .unwrap();
        queue(
            &mut c,
            "s",
            json!({"id":"clear","archiveId":id,"kind":"progress_clear"}),
        )
        .unwrap();
        let mut p = progress("reread", 1);
        p["progress"]["allowProgressRegression"] = json!(true);
        queue(&mut c, "s", p).unwrap();
        let operations: Vec<Value> = c
            .prepare("SELECT operation FROM lrr_bridge_outbox ORDER BY seq")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|row| serde_json::from_str(&row.unwrap()).unwrap())
            .collect();
        let plugin = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("plugins/lanraragi/YomikaBridge.pm");
        let fixture = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(fixture.path(), serde_json::to_vec(&operations).unwrap()).unwrap();
        let code = r#"use JSON::PP; require $ARGV[0]; open my $f,'<',$ARGV[1] or die $!; local $/; my $ops=decode_json(<$f>); my $s=LANraragi::Plugin::Scripts::YomikaBridge::default_state($ops->[0]{archiveId}); for my $op (@$ops) { $s=LANraragi::Plugin::Scripts::YomikaBridge::transition($s,$op,'server-time'); die 'unexpected conflict' unless $s; } print encode_json($s);"#;
        let output = std::process::Command::new(perl)
            .arg("-e")
            .arg(code)
            .arg(plugin)
            .arg(fixture.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let server: Value = serde_json::from_slice(&output.stdout).unwrap();
        let local = state(&c, "s", id).unwrap();
        assert_eq!(server["version"], local["version"]);
        assert_eq!(server["generation"], 1);
        assert_eq!(server["progress"]["pageIndex"], 1);
        assert_eq!(
            server["watchlistAt"].is_null(),
            local["watchlistAt"].is_null()
        );
    }
    fn connection() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE reading_progress(scope_id TEXT,archive_id TEXT,page_index INTEGER,page_count INTEGER,layout TEXT,direction TEXT,cover_alone INTEGER,updated_at TEXT,revision INTEGER,hidden_from_history INTEGER);CREATE TABLE reading_history(scope_id TEXT,archive_id TEXT,page_index INTEGER,visited_at TEXT,device_id TEXT);CREATE TABLE reading_list(scope_id TEXT,archive_id TEXT,added_at TEXT,updated_at TEXT,device_id TEXT);").unwrap();
        c.execute_batch(
            include_str!("../../migrations/0018_search_presets.sql")
                .split("INSERT INTO schema_migrations")
                .next()
                .unwrap(),
        )
        .unwrap();
        c.execute_batch("CREATE TABLE dedup_non_duplicates(scope_id TEXT,pair_key TEXT,left_archive_id TEXT,right_archive_id TEXT,tombstoned INTEGER,updated_at TEXT,logical_clock INTEGER,PRIMARY KEY(scope_id,pair_key));").unwrap();
        schema(&c).unwrap();
        c.execute(
            "INSERT INTO lrr_bridge_config VALUES('s',1,'server','\"epoch\"')",
            [],
        )
        .unwrap();
        c
    }
    fn progress(id: &str, page: i64) -> Value {
        json!({"id":id,"archiveId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"progress","progress":{"pageIndex":page,"pageCount":10,"layout":"paged","direction":"ltr"}})
    }
    #[test]
    fn transient_plugin_storage_errors_preserve_retryable_queue_semantics() {
        assert_eq!(
            plugin_error("BRIDGE_INTERNAL_ERROR"),
            "Bridge network request failed"
        );
        assert_eq!(
            plugin_error("BRIDGE_REJECTED"),
            "Bridge network request failed"
        );
        assert!(
            plugin_error("BRIDGE_INVALID_REQUEST").starts_with("Bridge plugin rejected request:")
        );
    }
    #[test]
    fn api_adapter_encodes_plugin_query_and_bounds_request() {
        let url = request_url(
            "http://127.0.0.1:1234/lrr/",
            "states",
            json!({"ids":["a&b"]}),
        )
        .unwrap();
        assert_eq!(url.path(), "/lrr/api/plugins/use");
        let pairs = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(pairs.get("plugin").unwrap(), "yomikabridge");
        let arg: Value = serde_json::from_str(pairs.get("arg").unwrap()).unwrap();
        assert_eq!(arg["protocol"], 1);
        assert_eq!(arg["ids"][0], "a&b");
        assert!(request_url(
            "http://localhost",
            "states",
            json!({"ids":["x".repeat(6000)]})
        )
        .is_err());
    }
    #[test]
    fn queue_captures_versions_generations_and_mirrors_without_commit() {
        let mut c = connection();
        let a = queue(&mut c, "s", progress("one", 3)).unwrap();
        assert_eq!(a["queued"], true);
        assert_eq!(a["state"]["version"], 1);
        queue(
            &mut c,
            "s",
            json!({"id":"two","archiveId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"progress_clear"}),
        )
        .unwrap();
        queue(&mut c, "s", progress("three", 1)).unwrap();
        let raw: String = c
            .query_row(
                "SELECT operation FROM lrr_bridge_outbox WHERE operation_id='three'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let op: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(op["expectedVersion"], 2);
        assert_eq!(op["generation"], 1);
        assert_eq!(config(&c, "s").unwrap()["pending"], 3);
        assert_eq!(
            state(&c, "s", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap()["historyAt"]
                .is_string(),
            true
        );
    }
    #[test]
    fn disabled_and_conflict_guard_preserve_outbox() {
        let mut c = connection();
        queue(&mut c, "s", progress("one", 3)).unwrap();
        c.execute("UPDATE lrr_bridge_outbox SET conflict=1", [])
            .unwrap();
        assert!(queue(&mut c, "s", progress("two", 4)).is_err());
        assert_eq!(config(&c, "s").unwrap()["conflicts"], 1);
        c.execute("UPDATE lrr_bridge_config SET enabled=0", [])
            .unwrap();
        assert!(queue(&mut c, "s", progress("three", 4)).is_err());
        assert!(cached(
            &c,
            "s",
            "states",
            &json!({"ids":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]})
        )
        .is_err());
    }
    #[test]
    fn outbox_and_cache_survive_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queue.sqlite");
        let mut c = connection();
        c.backup(rusqlite::DatabaseName::Main, &path, None).unwrap();
        drop(c);
        c = Connection::open(&path).unwrap();
        queue(&mut c, "s", progress("one", 5)).unwrap();
        drop(c);
        let c = Connection::open(path).unwrap();
        assert_eq!(config(&c, "s").unwrap()["pending"], 1);
        assert_eq!(
            cached(
                &c,
                "s",
                "states",
                &json!({"ids":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]})
            )
            .unwrap()["states"][0]["progress"]["pageIndex"],
            5
        );
    }
    #[test]
    fn list_membership_alone_never_fabricates_progress_or_generation() {
        let mut c = connection();
        let mut a = state(&c, "s", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
        a["historyAt"] = json!("2026-01-01");
        mirror(&c, "s", &a).unwrap();
        let mut b = a.clone();
        b["archiveId"] = json!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        mirror(&c, "s", &b).unwrap();
        queue(
            &mut c,
            "s",
            json!({"id":"one","archiveId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","kind":"watchlist_add"}),
        )
        .unwrap();
        reconcile_list(
            &c,
            "s",
            &json!({"kind":"history","offset":0}),
            &json!({"states":[],"total":0}),
        )
        .unwrap();
        assert!(
            state(&c, "s", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap()["historyAt"]
                .is_string()
        );
        assert!(
            !state(&c, "s", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").unwrap()["historyAt"]
                .is_null()
        );
    }
    #[test]
    fn absent_history_still_refreshes_hidden_progress_and_respects_pending_writes() {
        let mut c = connection();
        let id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let mut hidden = state(&c, "s", id).unwrap();
        hidden["version"] = json!(3);
        hidden["progress"] = json!({"pageIndex":2,"pageCount":10,"layout":"paged","direction":"ltr","coverAlone":null,"updatedAt":"now"});
        mirror(&c, "s", &hidden).unwrap();
        let absent = std::collections::HashSet::new();
        assert_eq!(
            missing_list_ids(&c, "s", "history", "historyAt", 0, &absent).unwrap(),
            vec![id]
        );
        let mut cleared = hidden.clone();
        cleared["version"] = json!(4);
        cleared["generation"] = json!(1);
        cleared["progress"] = Value::Null;
        mirror(&c, "s", &cleared).unwrap();
        assert!(
            missing_list_ids(&c, "s", "history", "historyAt", 0, &absent)
                .unwrap()
                .is_empty()
        );
        assert_eq!(state(&c, "s", id).unwrap()["generation"], 1);
        queue(&mut c, "s", progress("pending", 3)).unwrap();
        assert!(
            missing_list_ids(&c, "s", "history", "historyAt", 0, &absent)
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn progress_regression_and_omitted_cover_preserved() {
        let mut c = connection();
        let mut s = state(&c, "s", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
        s["progress"] = json!({"pageIndex":8,"pageCount":10,"layout":"paged","direction":"ltr","coverAlone":true,"updatedAt":"now"});
        mirror(&c, "s", &s).unwrap();
        let mut operation = progress("one", 2);
        operation["allowProgressRegression"] = json!(false);
        let response = queue(&mut c, "s", operation).unwrap();
        assert_eq!(response["state"]["progress"]["pageIndex"], 8);
        assert_eq!(response["state"]["progress"]["coverAlone"], true);
    }
    #[test]
    fn actual_migrations_baseline_and_unsent_coalescing() {
        let dir = tempfile::tempdir().unwrap();
        let database = crate::db::Database::open_path(dir.path().join("real.sqlite")).unwrap();
        let mut c = database.connection.lock().unwrap();
        schema(&c).unwrap();
        c.execute("INSERT INTO reading_progress(scope_id,archive_id,page_index,page_count,layout,direction) VALUES('s','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',2,10,'paged','ltr')",[]).unwrap();
        configure_local(
            &mut c,
            "s".into(),
            true,
            Some(json!({"serverId":"server","epoch":"epoch"})),
        )
        .unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM reading_progress", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        queue(&mut c, "s", progress("one", 3)).unwrap();
        queue(&mut c, "s", progress("two", 4)).unwrap();
        assert_eq!(config(&c, "s").unwrap()["pending"], 1);
        assert_eq!(
            state(&c, "s", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap()["version"],
            1
        );
        c.execute("UPDATE lrr_bridge_outbox SET attempted=1", [])
            .unwrap();
        queue(&mut c, "s", progress("three", 5)).unwrap();
        assert_eq!(config(&c, "s").unwrap()["pending"], 2);
        assert!(configure_local(&mut c, "s".into(), false, None).is_err());
        c.execute(
            "UPDATE lrr_bridge_config SET server_id='lost-server',epoch='lost-epoch'",
            [],
        )
        .unwrap();
        c.execute_batch("CREATE TRIGGER fail_restore BEFORE DELETE ON reading_progress BEGIN SELECT RAISE(ABORT,'restore blocked'); END;").unwrap();
        assert!(abandon_pending(&mut c, "s".into()).is_err());
        assert_eq!(config(&c, "s").unwrap()["pending"], 2);
        c.execute_batch("DROP TRIGGER fail_restore;").unwrap();
        let result = abandon_pending(&mut c, "s".into()).unwrap();
        assert_eq!(result["pending"], 0);
        assert_eq!(result["enabled"], false);
        assert!(result["serverId"].is_null());
        assert_eq!(
            c.query_row("SELECT page_index FROM reading_progress", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
    #[test]
    fn nested_regression_is_normalized_and_returned_progress_is_strict() {
        let mut c = connection();
        let mut op = progress("one", 2);
        op["progress"]["allowProgressRegression"] = json!(true);
        op["progress"]["unexpected"] = json!("discard");
        let response = queue(&mut c, "s", op).unwrap();
        assert_eq!(response["state"]["progress"].as_object().unwrap().len(), 6);
        let raw: String = c
            .query_row("SELECT operation FROM lrr_bridge_outbox", [], |r| r.get(0))
            .unwrap();
        let op: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(op["allowProgressRegression"], true);
        assert!(op["progress"].get("allowProgressRegression").is_none());
    }
    #[test]
    fn changing_list_snapshot_version_does_not_remove_members() {
        let c = connection();
        let mut s = state(&c, "s", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
        s["historyAt"] = json!("2026-01-01");
        mirror(&c, "s", &s).unwrap();
        reconcile_list(
            &c,
            "s",
            &json!({"kind":"history","offset":0}),
            &json!({"version":1,"states":[s],"total":2}),
        )
        .unwrap();
        assert!(reconcile_list(
            &c,
            "s",
            &json!({"kind":"history","offset":1}),
            &json!({"version":2,"states":[],"total":1})
        )
        .is_err());
        assert!(
            !state(&c, "s", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap()["historyAt"]
                .is_null()
        );
    }
}

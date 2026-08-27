use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{db::Database, domain::result::CommandResult};

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

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use super::*;

    struct MemoryStore { writes: Mutex<Vec<(String, String)>>, deletes: Mutex<Vec<String>> }
    impl EhCookieStore for MemoryStore {
        fn set_cookie(&self, reference: &str, cookie: &str) -> Result<(), String> { self.writes.lock().unwrap().push((reference.to_string(), cookie.to_string())); Ok(()) }
        fn delete_cookie(&self, reference: &str) -> Result<(), String> { self.deletes.lock().unwrap().push(reference.to_string()); Ok(()) }
    }
    fn db() -> Connection { let c = Connection::open_in_memory().unwrap(); c.execute_batch(include_str!("../../migrations/0001_initial.sql")).unwrap(); c.execute_batch(include_str!("../../migrations/0007_eh_accounts.sql")).unwrap(); c }
    #[test]
    fn account_keeps_cookie_out_of_sqlite_and_response() {
        let mut c = db(); let store = MemoryStore { writes: Mutex::new(vec![]), deletes: Mutex::new(vec![]) };
        let result = save_eh_account_record(&mut c, &store, SaveEhAccountInput { id: "eh-a".into(), label: "EH".into(), host: "e-hentai.org".into(), username_hint: Some("reader".into()), cookie: "ipb=secret".into() });
        let account = match result { CommandResult::Success { value, .. } => value, _ => panic!("save") };
        assert!(!serde_json::to_string(&account).unwrap().contains("secret"));
        let text: String = c.query_row("SELECT id||label||host||cookie_ref FROM eh_accounts", [], |r| r.get(0)).unwrap();
        assert!(!text.contains("secret")); assert_eq!(store.writes.lock().unwrap().len(), 1);
    }
}

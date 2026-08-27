#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_hash_uses_blake3_and_is_deterministic() {
        assert_eq!(exact_hash(b"hello"), "ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f");
    }
}
pub fn exact_hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExactHashResult {
    pub hash: String,
    pub size: u64,
}

#[derive(Debug, serde::Deserialize)]
pub struct DedupFileInput {
    pub path: String,
}

#[tauri::command]
pub fn dedup_check_file(input: DedupFileInput) -> crate::domain::result::CommandResult<ExactHashResult> {
    let metadata = match std::fs::metadata(&input.path) {
        Ok(value) if value.is_file() => value,
        _ => return crate::domain::result::CommandResult::failure("INVALID_RESPONSE", "Dedup path is not a regular file", false),
    };
    match std::fs::read(&input.path) {
        Ok(bytes) => crate::domain::result::CommandResult::success(ExactHashResult { hash: exact_hash(&bytes), size: metadata.len() }),
        Err(error) => crate::domain::result::CommandResult::failure("REMOTE_UNAVAILABLE", error.to_string(), true),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupFeatureInput { pub scope_id: String, pub path: String, pub exact_hash: String, pub dhash: Option<String>, pub algorithm_version: String, pub size: u64 }

#[tauri::command]
pub fn dedup_save_feature(input: DedupFeatureInput, database: tauri::State<'_, crate::db::Database>) -> crate::domain::result::CommandResult<()> {
    if input.scope_id.trim().is_empty() || input.path.trim().is_empty() || input.exact_hash.len() != 64 || !input.exact_hash.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
        return crate::domain::result::CommandResult::failure("INVALID_RESPONSE", "Invalid dedup feature", false);
    }
    let connection = match database.connection.lock() { Ok(value) => value, Err(_) => return crate::domain::result::CommandResult::failure("UNKNOWN", "Database lock failed", true) };
    match connection.execute("INSERT INTO dedup_features (scope_id,path,exact_hash,dhash,algorithm_version,size) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(scope_id,path) DO UPDATE SET exact_hash=excluded.exact_hash,dhash=excluded.dhash,algorithm_version=excluded.algorithm_version,size=excluded.size,updated_at=CURRENT_TIMESTAMP", rusqlite::params![input.scope_id,input.path,input.exact_hash,input.dhash,input.algorithm_version,input.size]) {
        Ok(_) => crate::domain::result::CommandResult::success(()),
        Err(error) => crate::domain::result::CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupFeatureRecord { pub scope_id: String, pub path: String, pub exact_hash: String, pub dhash: Option<String>, pub algorithm_version: String, pub size: u64 }

#[tauri::command]
pub fn dedup_find_exact(scope_id: String, exact_hash: String, database: tauri::State<'_, crate::db::Database>) -> crate::domain::result::CommandResult<Vec<DedupFeatureRecord>> {
    let connection = match database.connection.lock() { Ok(value) => value, Err(_) => return crate::domain::result::CommandResult::failure("UNKNOWN", "Database lock failed", true) };
    let mut statement = match connection.prepare("SELECT scope_id,path,exact_hash,dhash,algorithm_version,size FROM dedup_features WHERE scope_id=?1 AND exact_hash=?2 ORDER BY path") { Ok(value) => value, Err(error) => return crate::domain::result::CommandResult::failure("UNKNOWN", error.to_string(), true) };
    let rows = statement.query_map(rusqlite::params![scope_id, exact_hash], |row| Ok(DedupFeatureRecord { scope_id: row.get(0)?, path: row.get(1)?, exact_hash: row.get(2)?, dhash: row.get(3)?, algorithm_version: row.get(4)?, size: row.get(5)? })).ok();
    crate::domain::result::CommandResult::success(rows.map(|iter| iter.filter_map(Result::ok).collect()).unwrap_or_default())
}

//! Per-record hosted collections. No entire-document replacement or cloud journal.
use super::*;

pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS lrr_bridge_collections(scope_id TEXT NOT NULL,collection TEXT NOT NULL,key TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,collection,key));").map_err(|e|e.to_string())
}
fn collection_name(value: &Value) -> Result<&str, String> {
    match value.as_str() {
        Some(v @ ("search_presets" | "non_duplicates")) => Ok(v),
        _ => Err("Invalid bridge collection".into()),
    }
}
fn validate_key(collection: &str, key: &str) -> bool {
    if collection == "search_presets" {
        !key.is_empty()
            && key.len() <= 96
            && key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    } else {
        let parts = key.split(':').collect::<Vec<_>>();
        parts.len() == 2
            && parts[0] < parts[1]
            && parts.iter().all(|s| {
                s.len() == 40
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
    }
}
fn validate_record(r: &Value) -> Result<(), String> {
    let name = collection_name(&r["collection"])?;
    let key = r["key"].as_str().ok_or("Invalid collection key")?;
    let version = r["version"].as_i64().ok_or("Invalid collection version")?;
    if !validate_key(name, key) || version < 0 || r.get("value").is_none() {
        return Err("Invalid collection record".into());
    }
    if version > 0 && (!r["createdAt"].is_string() || !r["updatedAt"].is_string()) {
        return Err("Invalid collection timestamps".into());
    }
    let v = &r["value"];
    if serde_json::to_vec(v)
        .map_err(|_| "Invalid collection JSON")?
        .len()
        > 4000
    {
        return Err("Invalid collection value size".into());
    }
    if !v.is_null() {
        let fields = if name == "search_presets" {
            vec!["name", "query", "sortBy", "sortOrder", "categoryId"]
        } else {
            vec!["archiveIdA", "archiveIdB"]
        };
        if !v.as_object().is_some_and(|m| {
            m.len() == fields.len() && fields.iter().all(|key| m.contains_key(*key))
        }) {
            return Err("Invalid collection fields".into());
        }
        if name == "search_presets"
            && (v["name"].as_str().is_some_and(|s| s.chars().count() > 256)
                || v["categoryId"]
                    .as_str()
                    .is_some_and(|s| s.chars().count() > 256))
        {
            return Err("Invalid collection text size".into());
        }
        if name == "search_presets" {
            if v["name"].as_str().is_none_or(|s| s.trim().is_empty())
                || !v["query"].is_string()
                || !matches!(v["sortBy"].as_str(), Some("title" | "added"))
                || !matches!(v["sortOrder"].as_str(), Some("asc" | "desc"))
                || !(v["categoryId"].is_null() || v["categoryId"].is_string())
            {
                return Err("Invalid search preset".into());
            }
        } else if format!(
            "{}:{}",
            v["archiveIdA"].as_str().unwrap_or(""),
            v["archiveIdB"].as_str().unwrap_or("")
        ) != key
        {
            return Err("Invalid nonduplicate pair".into());
        }
    }
    Ok(())
}
fn get(c: &Connection, scope: &str, name: &str, key: &str) -> Result<Value, String> {
    let raw:Option<String>=c.query_row("SELECT record FROM lrr_bridge_collections WHERE scope_id=?1 AND collection=?2 AND key=?3",params![scope,name,key],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|r|serde_json::from_str(&r).map_err(|_|"Invalid cached collection record".into())).unwrap_or_else(||Ok(json!({"collection":name,"key":key,"version":0,"value":null,"createdAt":null,"updatedAt":null})))
}
fn mirror(c: &Connection, scope: &str, r: &Value) -> Result<(), String> {
    validate_record(r)?;
    let name = r["collection"].as_str().unwrap();
    let key = r["key"].as_str().unwrap();
    let v = &r["value"];
    c.execute("INSERT INTO lrr_bridge_collections VALUES(?1,?2,?3,?4) ON CONFLICT(scope_id,collection,key) DO UPDATE SET record=excluded.record",params![scope,name,key,r.to_string()]).map_err(|e|e.to_string())?;
    if name == "search_presets" {
        c.execute(
            "DELETE FROM search_presets WHERE scope_id=?1 AND preset_id=?2",
            params![scope, key],
        )
        .map_err(|e| e.to_string())?;
        if !v.is_null() {
            c.execute("INSERT INTO search_presets(scope_id,preset_id,name,query,sort_by,sort_order,category_id,created_at,updated_at,device_id,revision) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'lrr-bridge',?10)",params![scope,key,v["name"].as_str(),v["query"].as_str(),v["sortBy"].as_str(),v["sortOrder"].as_str(),v["categoryId"].as_str(),r["createdAt"].as_str(),r["updatedAt"].as_str(),r["version"].as_i64()]).map_err(|e|e.to_string())?;
        }
    } else {
        let parts = key.split(':').collect::<Vec<_>>();
        let pair = format!("{}|{}", parts[0], parts[1]);
        c.execute(
            "DELETE FROM dedup_non_duplicates WHERE scope_id=?1 AND pair_key=?2",
            params![scope, pair],
        )
        .map_err(|e| e.to_string())?;
        c.execute("INSERT INTO dedup_non_duplicates(scope_id,pair_key,left_archive_id,right_archive_id,tombstoned,updated_at,logical_clock) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![scope,pair,parts[0],parts[1],v.is_null(),r["updatedAt"].as_str().unwrap_or("1970-01-01T00:00:00Z"),r["version"].as_i64()]).map_err(|e|e.to_string())?;
    }
    Ok(())
}
pub(super) fn queue(c: &mut Connection, scope: &str, op: Value) -> Result<Value, String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let result = queue_in(&tx, scope, op)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}
pub(super) fn queue_in(tx: &Connection, scope: &str, mut op: Value) -> Result<Value, String> {
    let name = collection_name(&op["collection"])?.to_owned();
    let key = op["key"]
        .as_str()
        .ok_or("Invalid collection key")?
        .to_owned();
    if !validate_key(&name, &key) || op.get("value").is_none() {
        return Err("Invalid collection write".into());
    }
    if !enabled(&tx, scope) {
        return Err("LANraragi bridge is disabled".into());
    }
    let target = format!("collection:{name}:{key}");
    let conflict:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM lrr_bridge_outbox WHERE scope_id=?1 AND archive_id=?2 AND conflict=1)",params![scope,target],|r|r.get(0)).map_err(|e|e.to_string())?;
    if conflict {
        return Err("Bridge conflict requires explicit resolution".into());
    }
    let old = get(&tx, scope, &name, &key)?;
    let entropy: String = tx
        .query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    op["id"] = json!(format!("c-{entropy}"));
    op["expectedVersion"] = old["version"].clone();
    request_url(
        "http://localhost",
        "collection_apply",
        json!({"operation":op}),
    )?;
    let now: String = tx
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let r = json!({"collection":name,"key":key,"version":old["version"].as_i64().unwrap_or(0)+1,"value":op["value"],"createdAt":old["createdAt"].as_str().unwrap_or(&now),"updatedAt":now});
    validate_record(&r)?;
    tx.execute("INSERT INTO lrr_bridge_outbox(scope_id,operation_id,archive_id,operation) VALUES(?1,?2,?3,?4)",params![scope,op["id"].as_str(),target,op.to_string()]).map_err(|e|e.to_string())?;
    mirror(&tx, scope, &r)?;
    Ok(json!({"queued":true,"record":r}))
}
pub(super) fn cached(c: &Connection, scope: &str, name: &str) -> Result<Value, String> {
    let mut stmt=c.prepare("SELECT record FROM lrr_bridge_collections WHERE scope_id=?1 AND collection=?2 ORDER BY key").map_err(|e|e.to_string())?;
    let records = stmt
        .query_map(params![scope, name], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|r| {
            r.map_err(|e| e.to_string()).and_then(|r| {
                serde_json::from_str::<Value>(&r).map_err(|_| "Invalid cached collection".into())
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({"collection":name,"records":records,"offline":true}))
}
pub(super) async fn list(
    app: &tauri::AppHandle,
    scope: &str,
    input: Value,
) -> Result<Value, String> {
    for attempt in 0..2 {
        match list_once(app, scope, input.clone()).await {
            Err(e) if attempt == 0 && e == "Bridge collection changed during pagination; retry" => {
                continue
            }
            result => return result,
        }
    }
    unreachable!()
}
async fn list_once(app: &tauri::AppHandle, scope: &str, input: Value) -> Result<Value, String> {
    let name = collection_name(&input["collection"])?.to_owned();
    let mut records = Vec::new();
    let mut version = None;
    for offset in (0..100_000).step_by(50) {
        let page = match remote(
            app,
            scope,
            "collection_list",
            json!({"collection":name,"offset":offset,"limit":50}),
            false,
        )
        .await
        {
            Ok(v) => v,
            Err(e) if e == "Bridge network request failed" => {
                let scope = scope.to_owned();
                return db(app, move |c| cached(c, &scope, &name)).await;
            }
            Err(e) => return Err(e),
        };
        let stamp = page["version"]
            .as_i64()
            .ok_or("Invalid collection snapshot version")?;
        if version.is_some_and(|v| v != stamp) {
            return Err("Bridge collection changed during pagination; retry".into());
        }
        version = Some(stamp);
        if page["collection"] != name {
            return Err("Invalid collection response".into());
        }
        let rows = page["records"]
            .as_array()
            .ok_or("Invalid collection records")?;
        for r in rows {
            validate_record(r)?;
            if r["collection"] != name {
                return Err("Invalid collection record scope".into());
            }
        }
        let total = page["total"].as_u64().ok_or("Invalid collection total")? as usize;
        if rows.len() > 50 || rows.len() + offset > total {
            return Err("Invalid collection pagination".into());
        }
        records.extend(rows.iter().cloned());
        if records.len() >= total {
            let scope = scope.to_owned();
            return db(app,move|c|{
                let tx=c.transaction().map_err(|e|e.to_string())?;
                let keys=records.iter().map(|r|r["key"].as_str().unwrap()).collect::<std::collections::HashSet<_>>();
                if keys.len()!=records.len(){return Err("Invalid duplicate collection key".into());}
                // A complete authoritative snapshot may omit cached rows after restore.
                let old=cached(&tx,&scope,&name)?;
                for old in old["records"].as_array().unwrap(){if !keys.contains(old["key"].as_str().unwrap()){
                    let target=format!("collection:{}:{}",name,old["key"].as_str().unwrap());
                    let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM lrr_bridge_outbox WHERE scope_id=?1 AND archive_id=?2)",params![scope,target],|r|r.get(0)).map_err(|e|e.to_string())?;
                    if !pending{let mut cleared=old.clone();cleared["value"]=Value::Null;mirror(&tx,&scope,&cleared)?;}
                }}
                for r in records{
                    let target=format!("collection:{}:{}",name,r["key"].as_str().unwrap());
                    let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM lrr_bridge_outbox WHERE scope_id=?1 AND archive_id=?2)",params![scope,target],|r|r.get(0)).map_err(|e|e.to_string())?;
                    if !pending{mirror(&tx,&scope,&r)?;}
                }
                let mut result=cached(&tx,&scope,&name)?;result["offline"]=json!(false);result["version"]=json!(version);tx.commit().map_err(|e|e.to_string())?;Ok(result)
            }).await;
        }
        if rows.is_empty() {
            return Err("Invalid empty collection page".into());
        }
    }
    Err("Bridge collection snapshot exceeds limit".into())
}
pub(super) fn acknowledge(
    c: &mut Connection,
    scope: &str,
    id: &str,
    op: &Value,
    data: &Value,
) -> Result<(), String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    if data["errorCode"] == "BRIDGE_CONFLICT" {
        tx.execute(
            "UPDATE lrr_bridge_outbox SET conflict=1 WHERE operation_id=?1",
            [id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let r = &data["record"];
        validate_record(r)?;
        if r["collection"] != op["collection"]
            || r["key"] != op["key"]
            || r["version"].as_i64() != op["expectedVersion"].as_i64().map(|v| v + 1)
        {
            return Err("Invalid collection acknowledgement".into());
        }
        tx.execute("DELETE FROM lrr_bridge_outbox WHERE operation_id=?1", [id])
            .map_err(|e| e.to_string())?;
        let target = format!(
            "collection:{}:{}",
            op["collection"].as_str().unwrap(),
            op["key"].as_str().unwrap()
        );
        let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM lrr_bridge_outbox WHERE scope_id=?1 AND archive_id=?2)",params![scope,target],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !pending {
            let current = data.get("currentRecord").unwrap_or(r);
            validate_record(current)?;
            if current["collection"] != r["collection"]
                || current["key"] != r["key"]
                || current["version"].as_i64() < r["version"].as_i64()
            {
                return Err("Invalid current collection acknowledgement".into());
            }
            mirror(&tx, scope, current)?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
pub(super) async fn discard(
    app: &tauri::AppHandle,
    scope: &str,
    target: &str,
) -> Result<(), String> {
    let parts = target.splitn(3, ':').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Err("Invalid collection conflict target".into());
    }
    let r = remote(
        app,
        scope,
        "collection_get",
        json!({"collection":parts[1],"key":parts[2]}),
        false,
    )
    .await?["record"]
        .clone();
    validate_record(&r)?;
    if r["collection"] != parts[1] || r["key"] != parts[2] {
        return Err("Invalid collection conflict response".into());
    }
    let scope = scope.to_owned();
    let target = target.to_owned();
    db(app, move |c| {
        let tx = c.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM lrr_bridge_outbox WHERE scope_id=?1 AND archive_id=?2",
            params![scope, target],
        )
        .map_err(|e| e.to_string())?;
        mirror(&tx, &scope, &r)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn connection() -> Connection {
        let database = crate::db::Database::open_path(":memory:").unwrap();
        let c = database.connection.into_inner().unwrap();
        super::super::schema(&c).unwrap();
        c.execute(
            "INSERT INTO lrr_bridge_config VALUES('s',1,'server','\"epoch\"')",
            [],
        )
        .unwrap();
        c
    }
    fn preset(name: &str) -> Value {
        json!({"collection":"search_presets","key":"preset-one","value":{"name":name,"query":"language:chinese","sortBy":"added","sortOrder":"desc","categoryId":null}})
    }
    #[test]
    fn queues_and_mirrors_presets_with_immutable_versions() {
        let mut c = connection();
        let first = queue(&mut c, "s", preset("first")).unwrap();
        let second = queue(&mut c, "s", preset("second")).unwrap();
        assert_eq!(first["record"]["version"], 1);
        assert_eq!(second["record"]["version"], 2);
        let operations: Vec<String> = c
            .prepare("SELECT operation FROM lrr_bridge_outbox ORDER BY seq")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let old: Value = serde_json::from_str(&operations[0]).unwrap();
        let new: Value = serde_json::from_str(&operations[1]).unwrap();
        assert_eq!(old["expectedVersion"], 0);
        assert_eq!(new["expectedVersion"], 1);
        assert_ne!(old["id"], new["id"]);
        acknowledge(
            &mut c,
            "s",
            old["id"].as_str().unwrap(),
            &old,
            &json!({"record":first["record"]}),
        )
        .unwrap();
        assert_eq!(
            get(&c, "s", "search_presets", "preset-one").unwrap()["value"]["name"],
            "second"
        );
        assert_eq!(
            c.query_row("SELECT name FROM search_presets", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "second"
        );
        assert_eq!(super::super::config(&c, "s").unwrap()["pending"], 1);
    }
    #[test]
    fn original_retry_ack_uses_current_tombstone_and_never_restores_deleted_mark() {
        let mut c = connection();
        let a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let queued=queue(&mut c,"s",json!({"collection":"non_duplicates","key":format!("{a}:{b}"),"value":{"archiveIdA":a,"archiveIdB":b}})).unwrap();
        let raw: String = c
            .query_row("SELECT operation FROM lrr_bridge_outbox", [], |r| r.get(0))
            .unwrap();
        let op: Value = serde_json::from_str(&raw).unwrap();
        let mut current = queued["record"].clone();
        current["value"] = Value::Null;
        current["version"] = json!(2);
        acknowledge(
            &mut c,
            "s",
            op["id"].as_str().unwrap(),
            &op,
            &json!({"record":queued["record"],"currentRecord":current}),
        )
        .unwrap();
        assert_eq!(
            get(&c, "s", "non_duplicates", &format!("{a}:{b}")).unwrap()["version"],
            2
        );
        assert_eq!(
            c.query_row("SELECT tombstoned FROM dedup_non_duplicates", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(super::super::config(&c, "s").unwrap()["pending"], 0);
    }
    #[test]
    fn deletion_and_conflict_never_silently_rewrite_remote_records() {
        let mut c = connection();
        queue(&mut c, "s", preset("first")).unwrap();
        c.execute("UPDATE lrr_bridge_outbox SET conflict=1", [])
            .unwrap();
        assert!(queue(&mut c, "s", preset("second")).is_err());
        assert!(super::super::configure_local(&mut c, "s".into(), false, None).is_err());
        super::super::abandon_pending(&mut c, "s".into()).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM search_presets", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(super::super::config(&c, "s").unwrap()["pending"], 0);
    }
    #[test]
    fn baseline_restores_all_five_categories_after_hosting() {
        let mut c = connection();
        c.execute("UPDATE lrr_bridge_config SET enabled=0", [])
            .unwrap();
        c.execute("INSERT INTO search_presets(scope_id,preset_id,name,device_id) VALUES('s','local','original','device')",[]).unwrap();
        super::super::configure_local(&mut c, "s".into(), true, None).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM search_presets", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        queue(&mut c, "s", preset("server side pending")).unwrap();
        super::super::abandon_pending(&mut c, "s".into()).unwrap();
        assert_eq!(
            c.query_row("SELECT name FROM search_presets", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "original"
        );
    }
    #[test]
    fn nonduplicate_native_transaction_and_invalid_writes() {
        let mut c = connection();
        let a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        {
            let tx = c.transaction().unwrap();
            super::super::queue_nonduplicate(&tx, "s", b, a, true).unwrap();
        }
        assert_eq!(
            super::super::config(&c, "s").unwrap()["pending"],
            0,
            "outer transaction rollback must include outbox"
        );
        super::super::queue_nonduplicate(&c, "s", b, a, true).unwrap();
        assert_eq!(
            c.query_row("SELECT pair_key FROM dedup_non_duplicates", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            format!("{a}|{b}")
        );
        assert!(queue(
            &mut c,
            "s",
            json!({"collection":"non_duplicates","key":"b:a","value":null})
        )
        .is_err());
        assert!(queue(&mut c, "s", preset(&"x".repeat(257))).is_err());
        let mut extra = preset("valid");
        extra["value"]["extra"] = json!(true);
        assert!(queue(&mut c, "s", extra).is_err());
        let mut bad = preset(" ");
        assert!(queue(&mut c, "s", bad.clone()).is_err());
        bad["value"]["name"] = json!("valid");
        bad["value"]["sortOrder"] = json!("wrong");
        assert!(queue(&mut c, "s", bad).is_err());
    }
}

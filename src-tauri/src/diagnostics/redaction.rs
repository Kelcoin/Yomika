use serde_json::Value;

const SENSITIVE_KEYS: [&str; 8] = [
    "api_key",
    "apikey",
    "token",
    "password",
    "authorization",
    "cookie",
    "sync_secret",
    "ipb_pass_hash",
];

pub fn redact_value(value: &mut Value) {
    match value {
        Value::Object(entries) => {
            for (key, item) in entries {
                let normalized = key.to_ascii_lowercase();
                if SENSITIVE_KEYS
                    .iter()
                    .any(|secret| normalized.contains(secret))
                {
                    *item = Value::String("[REDACTED]".into());
                } else {
                    redact_value(item);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_value),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::redact_value;

    #[test]
    fn removes_nested_secrets() {
        let mut value = json!({
            "archive": "A-1",
            "headers": { "Authorization": "Bearer secret" },
            "cookie": "ipb_pass_hash=secret"
        });

        redact_value(&mut value);

        let text = value.to_string();
        assert!(text.contains("A-1"));
        assert!(!text.contains("Bearer secret"));
        assert!(!text.contains("ipb_pass_hash"));
    }
}

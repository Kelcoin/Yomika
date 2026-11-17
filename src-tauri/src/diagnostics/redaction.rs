use serde_json::Value;
use std::sync::LazyLock;
use regex::Regex;

const SENSITIVE_KEYS: &[&str] = &[
    "api_key",
    "apikey",
    "token",
    "password",
    "authorization",
    "cookie",
    "sync_secret",
    "ipb_pass_hash",
    "passphrase", "credential", "secret", "passwd", "ipb_member_id",
];

fn sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
    SENSITIVE_KEYS.iter().any(|part| normalized.contains(&part.replace('_', ""))) || matches!(normalized.as_str(),
        "url" | "uri" | "baseurl" | "serverurl" | "host" | "hostname" | "address" | "path" | "filepath" |
        "filename" | "directory" | "username" | "userid" | "email" | "identity" | "serverid" | "servername" | "scopeid" | "archiveid")
}

pub fn redact_text(text: &str) -> String {
    if let Ok(mut value @ (Value::Object(_) | Value::Array(_))) = serde_json::from_str::<Value>(text) {
        redact_value(&mut value);
        return value.to_string();
    }
    static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\b(?:https?|wss?|ftp|file|content|tauri)://[^\s<>"'`),}]+"#).unwrap());
    static DIAGNOSTIC_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:(?:https?://tauri\.localhost|tauri://localhost)/assets/[\w.-]+\.(?:js|css)(?::\d+){0,2}|https://react\.dev/errors/\d+|https://reactjs\.org/docs/error-decoder\.html\?invariant=\d+)$").unwrap());
    let text = URL.replace_all(text, |captures: &regex::Captures<'_>| {
        let url = &captures[0];
        if DIAGNOSTIC_URL.is_match(url) { url.to_string() } else { "[REDACTED]".to_string() }
    });
    static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| [
        r#"(?:\b[A-Za-z]:[\\/]|\\\\)[^\r\n\t"'<>|,;]+"#,
        r#"/(?:home|Users|data/user|storage|mnt|media|private|tmp|var/folders)/[^\s"'<>),;]+"#,
        r"\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b",
        r"(?i)\[?(?:[\da-f]{0,4}::[\da-f:]+|(?:[\da-f]{0,4}:){3,}[\da-f:]+)(?:%[\w.-]+)?\]?(?::\d+)?",
        r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
        r"(?i)(?:Bearer|Basic)\s+[^\s,;]+",
        r#"(?i)\b(?:api[_-]?key|token|password|passwd|passphrase|sync[_-]?secret|credential|secret|ipb_member_id|ipb_pass_hash|authorization|cookie|username|user[_-]?id|server[_-]?id|scope[_-]?id)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;&#]+)"#,
    ].into_iter().map(|pattern| Regex::new(pattern).expect("static redaction regex")).collect());
    PATTERNS.iter().fold(text.to_string(), |text, pattern| pattern.replace_all(&text, "[REDACTED]").into_owned())
}

pub fn redact_value(value: &mut Value) {
    match value {
        Value::Object(entries) => {
            for (key, item) in entries {
                if sensitive_key(key) {
                    *item = Value::String("[REDACTED]".into());
                } else {
                    redact_value(item);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_value),
        Value::String(text) => *text = redact_text(text),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::redact_value;

    #[test]
    fn removes_private_locations_and_identifiers_in_free_text_and_json() {
        let mut value = json!({
            "serverId": "private-server", "username": "Alice", "filePath": "private-file",
            "message": "https://alice:secret@library.example/api?token=abcd 192.168.12.34 [fd00::1234]:90 C:\\Users\\Alice\\books\\file.zip /home/alice/books/file.zip alice@example.com",
            "code": "COMPUTE_MODEL_UNAVAILABLE"
        });
        redact_value(&mut value);
        let text = value.to_string();
        for secret in ["private-server", "Alice", "private-file", "alice", "library.example", "192.168.12.34", "fd00::1234", "abcd"] {
            assert!(!text.contains(secret), "private value leaked");
        }
        assert!(text.contains("COMPUTE_MODEL_UNAVAILABLE"));
        assert_eq!(super::redact_text("2026-10-16T16:21:08.000Z"), "2026-10-16T16:21:08.000Z");
    }

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

    #[test]
    fn keeps_release_script_positions_and_error_names_without_leaking_credentials() {
        let mut value = json!({
            "name": "RangeError",
            "stack": "at ReaderScreen (http://tauri.localhost/assets/ReaderRoute-Ab12.js:1:420)",
            "message": "React #185 https://react.dev/errors/185",
            "token": "private-token",
        });
        redact_value(&mut value);
        assert_eq!(value["name"], "RangeError");
        assert_eq!(value["stack"], "at ReaderScreen (http://tauri.localhost/assets/ReaderRoute-Ab12.js:1:420)");
        assert_eq!(value["message"], "React #185 https://react.dev/errors/185");
        assert_eq!(value["token"], "[REDACTED]");
        for url in ["http://tauri.localhost/api?token=private", "https://tauri.localhost.evil.test/assets/main.js", "http://alice:secret@tauri.localhost/assets/main.js", "https://react.dev/errors/185?token=private"] {
            assert_eq!(super::redact_text(url), "[REDACTED]");
        }
    }
}

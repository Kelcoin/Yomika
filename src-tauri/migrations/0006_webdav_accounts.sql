PRAGMA foreign_keys = ON;

CREATE TABLE webdav_accounts (
    id TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL,
    base_url TEXT NOT NULL,
    username TEXT NOT NULL,
    credential_ref TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unverified'
        CHECK (status IN ('unverified', 'verified', 'error')),
    last_probe_at TEXT,
    last_error_code TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX webdav_accounts_label_idx
    ON webdav_accounts(label COLLATE NOCASE, id);

INSERT INTO schema_migrations (version) VALUES (6);

PRAGMA foreign_keys = ON;
CREATE TABLE eh_accounts (
    id TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL,
    host TEXT NOT NULL CHECK (host IN ('e-hentai.org', 'exhentai.org')),
    username_hint TEXT,
    cookie_ref TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'verified', 'error')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX eh_accounts_label_idx ON eh_accounts(label COLLATE NOCASE, id);
INSERT INTO schema_migrations (version) VALUES (7);

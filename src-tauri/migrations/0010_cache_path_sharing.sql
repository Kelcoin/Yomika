PRAGMA foreign_keys = ON;

ALTER TABLE cache_entries RENAME TO cache_entries_v9;

CREATE TABLE cache_entries (
    key TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    mime TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    source_scope TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    model_id TEXT
);

INSERT INTO cache_entries (
    key, kind, path, size, mime, created_at, last_accessed_at,
    pinned, source_scope, content_hash, model_id
)
SELECT
    key, kind, path, size, mime, created_at, last_accessed_at,
    pinned, source_scope, content_hash, model_id
FROM cache_entries_v9;

DROP TABLE cache_entries_v9;

CREATE INDEX cache_entries_eviction_idx ON cache_entries(pinned, last_accessed_at);
CREATE INDEX cache_entries_path_idx ON cache_entries(path);

INSERT INTO schema_migrations (version) VALUES (10);

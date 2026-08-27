PRAGMA foreign_keys = ON;

CREATE TABLE watchlist (
    scope_id TEXT NOT NULL,
    archive_id TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    device_id TEXT NOT NULL,
    deleted_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (scope_id, archive_id)
);

CREATE INDEX watchlist_scope_visible_idx
    ON watchlist(scope_id, deleted_at, updated_at DESC);

INSERT INTO schema_migrations (version) VALUES (4);

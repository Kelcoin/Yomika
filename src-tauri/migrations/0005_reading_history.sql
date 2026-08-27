PRAGMA foreign_keys = ON;

CREATE TABLE reading_history (
    scope_id TEXT NOT NULL,
    archive_id TEXT NOT NULL,
    page_index INTEGER NOT NULL CHECK (page_index >= 0),
    visited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    device_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (scope_id, archive_id)
);

CREATE INDEX reading_history_scope_visited_idx
    ON reading_history(scope_id, visited_at DESC);

INSERT INTO schema_migrations (version) VALUES (5);

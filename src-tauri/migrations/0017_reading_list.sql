-- Reading list ("待看"), separate from the watchlist ("收藏夹").
--
-- The two answer different questions: the watchlist is "I like this", the
-- reading list is "I intend to read this next". Sharing one table would have
-- made either one destroy the other, and both need to sync, so this mirrors the
-- watchlist shape (device id + revision + tombstone) to reuse the sync journal.
PRAGMA foreign_keys = ON;

CREATE TABLE reading_list (
    scope_id TEXT NOT NULL,
    archive_id TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    device_id TEXT NOT NULL,
    deleted_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (scope_id, archive_id)
);

CREATE INDEX reading_list_scope_visible_idx
    ON reading_list(scope_id, deleted_at, updated_at DESC);

INSERT INTO schema_migrations (version) VALUES (17);

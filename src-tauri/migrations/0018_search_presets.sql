-- Saved searches ("检索预设").
--
-- Readoshi keeps presets as named filter sets and JHenTai as quick search tabs;
-- both are the same shape: a name plus the query state the library toolbar
-- already has. Stored per scope with the watchlist's sync columns so the journal
-- carries presets like every other user record.
PRAGMA foreign_keys = ON;

CREATE TABLE search_presets (
    scope_id TEXT NOT NULL,
    preset_id TEXT NOT NULL,
    name TEXT NOT NULL,
    query TEXT NOT NULL DEFAULT '',
    sort_by TEXT NOT NULL DEFAULT 'added',
    sort_order TEXT NOT NULL DEFAULT 'desc',
    category_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    device_id TEXT NOT NULL,
    deleted_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (scope_id, preset_id)
);

CREATE INDEX search_presets_scope_visible_idx
    ON search_presets(scope_id, deleted_at, updated_at DESC);

INSERT INTO schema_migrations (version) VALUES (18);

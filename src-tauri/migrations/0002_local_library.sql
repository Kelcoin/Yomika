PRAGMA foreign_keys = ON;

CREATE TABLE servers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_ref TEXT,
    scope_id TEXT NOT NULL UNIQUE,
    last_health_at TEXT,
    last_error_code TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE archives (
    server_id TEXT NOT NULL,
    archive_id TEXT NOT NULL,
    title TEXT NOT NULL,
    title_sort TEXT NOT NULL DEFAULT '',
    summary TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
    category TEXT,
    language TEXT,
    page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
    file_size INTEGER CHECK (file_size >= 0),
    rating REAL,
    cover_page INTEGER CHECK (cover_page >= 0),
    remote_updated_at TEXT,
    local_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata_revision INTEGER NOT NULL DEFAULT 0,
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    PRIMARY KEY (server_id, archive_id),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE TABLE pages (
    server_id TEXT NOT NULL,
    archive_id TEXT NOT NULL,
    page_index INTEGER NOT NULL CHECK (page_index >= 0),
    remote_url TEXT,
    width INTEGER CHECK (width > 0),
    height INTEGER CHECK (height > 0),
    mime TEXT,
    remote_etag TEXT,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, archive_id, page_index),
    FOREIGN KEY (server_id, archive_id) REFERENCES archives(server_id, archive_id) ON DELETE CASCADE
);

CREATE TABLE reading_progress (
    scope_id TEXT NOT NULL,
    archive_id TEXT NOT NULL,
    page_index INTEGER NOT NULL CHECK (page_index >= 0),
    page_count INTEGER NOT NULL CHECK (page_count >= 0),
    layout TEXT NOT NULL CHECK (layout IN ('paged', 'continuous')),
    direction TEXT NOT NULL CHECK (direction IN ('ltr', 'rtl')),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    device_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    hidden_from_history INTEGER NOT NULL DEFAULT 0 CHECK (hidden_from_history IN (0, 1)),
    PRIMARY KEY (scope_id, archive_id)
);

CREATE TABLE cache_entries (
    key TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL CHECK (size >= 0),
    mime TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    source_scope TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    model_id TEXT
);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('download', 'sync', 'inference', 'maintenance')),
    label TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
    progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX archives_server_updated_idx ON archives(server_id, is_deleted, local_updated_at DESC);
CREATE INDEX cache_entries_eviction_idx ON cache_entries(pinned, last_accessed_at);
CREATE INDEX tasks_status_updated_idx ON tasks(status, updated_at DESC);

INSERT INTO schema_migrations (version) VALUES (2);

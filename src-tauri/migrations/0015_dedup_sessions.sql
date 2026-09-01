CREATE TABLE dedup_sessions (
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'cancelled', 'completed')),
    checkpoint INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint >= 0),
    archive_count INTEGER NOT NULL DEFAULT 0 CHECK (archive_count >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE dedup_archive_snapshots (
    session_id TEXT NOT NULL REFERENCES dedup_sessions(id) ON DELETE CASCADE,
    archive_id TEXT NOT NULL,
    path TEXT NOT NULL,
    title TEXT,
    page_count INTEGER,
    size INTEGER,
    feature_version TEXT NOT NULL,
    PRIMARY KEY (session_id, archive_id)
);

CREATE TABLE dedup_pairs (
    session_id TEXT NOT NULL REFERENCES dedup_sessions(id) ON DELETE CASCADE,
    pair_key TEXT NOT NULL,
    left_archive_id TEXT NOT NULL,
    right_archive_id TEXT NOT NULL,
    source TEXT NOT NULL,
    diagnostics TEXT,
    PRIMARY KEY (session_id, pair_key)
);

CREATE TABLE dedup_selection (
    session_id TEXT NOT NULL REFERENCES dedup_sessions(id) ON DELETE CASCADE,
    archive_id TEXT NOT NULL,
    PRIMARY KEY (session_id, archive_id)
);

CREATE TABLE dedup_non_duplicates (
    scope_id TEXT NOT NULL,
    pair_key TEXT NOT NULL,
    left_archive_id TEXT NOT NULL,
    right_archive_id TEXT NOT NULL,
    tombstoned INTEGER NOT NULL DEFAULT 0 CHECK (tombstoned IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scope_id, pair_key)
);

CREATE TABLE dedup_deletion_outcomes (
    session_id TEXT NOT NULL REFERENCES dedup_sessions(id) ON DELETE CASCADE,
    archive_id TEXT NOT NULL,
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, archive_id)
);

CREATE INDEX dedup_sessions_scope_idx ON dedup_sessions(scope_id, updated_at DESC);
CREATE INDEX dedup_pairs_session_idx ON dedup_pairs(session_id);
CREATE INDEX dedup_non_duplicates_scope_idx ON dedup_non_duplicates(scope_id, tombstoned);

INSERT INTO schema_migrations (version) VALUES (15);

PRAGMA foreign_keys = ON;

CREATE TABLE sync_journal (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    object_type TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
    device_id TEXT NOT NULL,
    logical_clock INTEGER NOT NULL CHECK (logical_clock >= 0),
    wall_clock TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    base_hash TEXT,
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'retryable', 'processing', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX sync_journal_scope_status_sequence_idx
    ON sync_journal(scope_id, status, sequence);

INSERT INTO schema_migrations (version) VALUES (3);

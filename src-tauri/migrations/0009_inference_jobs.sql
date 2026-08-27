PRAGMA foreign_keys = ON;
CREATE TABLE inference_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    source_scope TEXT NOT NULL,
    source_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    backend TEXT NOT NULL DEFAULT 'cpu',
    status TEXT NOT NULL CHECK (status IN ('queued','running','paused','completed','failed','cancelled')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE inference_items (
    job_id TEXT NOT NULL REFERENCES inference_jobs(id) ON DELETE CASCADE,
    item_index INTEGER NOT NULL CHECK (item_index >= 0),
    input_hash TEXT NOT NULL,
    completed_tile INTEGER NOT NULL DEFAULT 0 CHECK (completed_tile >= 0),
    status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled')),
    output_path TEXT,
    error TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (job_id, item_index)
);
CREATE INDEX inference_jobs_status_idx ON inference_jobs(status, updated_at);
INSERT INTO schema_migrations (version) VALUES (9);

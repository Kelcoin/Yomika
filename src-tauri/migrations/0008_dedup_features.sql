PRAGMA foreign_keys = ON;
CREATE TABLE dedup_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id TEXT NOT NULL,
    path TEXT NOT NULL,
    exact_hash TEXT NOT NULL,
    dhash TEXT,
    algorithm_version TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(scope_id, path)
);
CREATE INDEX dedup_exact_hash_idx ON dedup_features(scope_id, exact_hash);
CREATE INDEX dedup_dhash_idx ON dedup_features(scope_id, dhash);
INSERT INTO schema_migrations (version) VALUES (8);

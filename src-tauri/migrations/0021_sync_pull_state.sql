-- Which encrypted change segments this device has already merged from the
-- remote manifest, per sync account. The pull phase skips everything listed
-- here, so a segment is downloaded and applied exactly once.
CREATE TABLE sync_applied_segments (
    account_id TEXT NOT NULL,
    segment_hash TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, segment_hash)
);

-- Remote dedup relations merge by the object's logical clock (union of marks,
-- a tombstone only beats an older mark). The table previously had no clock, so
-- arriving relations could not be compared against local ones.
ALTER TABLE dedup_non_duplicates
    ADD COLUMN logical_clock INTEGER NOT NULL DEFAULT 0;

INSERT INTO schema_migrations (version) VALUES (21);

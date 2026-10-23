-- Existing scans remain visible; new working sessions opt in via Save.
ALTER TABLE dedup_sessions ADD COLUMN saved INTEGER NOT NULL DEFAULT 1 CHECK (saved IN (0, 1));
INSERT INTO schema_migrations (version) VALUES (32);

ALTER TABLE cache_entries ADD COLUMN source_archive TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS cache_entries_archive_idx
    ON cache_entries(source_scope, source_archive, kind);

INSERT INTO schema_migrations (version) VALUES (14);

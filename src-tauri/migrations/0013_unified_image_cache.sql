ALTER TABLE cache_entries ADD COLUMN resource_revision TEXT;

CREATE INDEX IF NOT EXISTS cache_entries_image_lookup_idx
    ON cache_entries(source_scope, kind, last_accessed_at);

INSERT INTO schema_migrations (version) VALUES (13);

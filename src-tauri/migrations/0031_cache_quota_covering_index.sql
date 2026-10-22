-- Cache writes check the quota while holding the shared database mutex.
-- GROUP BY path must also read size from the index, rather than visiting
-- every cache row (including large metadata) once per downloaded image.
CREATE INDEX cache_entries_path_size_idx ON cache_entries(path, size);
-- The covering index retains path-prefix lookups; keep only one such index.
DROP INDEX cache_entries_path_idx;

INSERT INTO schema_migrations (version) VALUES (31);

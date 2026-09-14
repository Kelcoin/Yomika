-- One enabled server at a time. The enabled row is where the home shelves,
-- the library and every default-server fallback read from.
ALTER TABLE servers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;

-- After the upgrade exactly one server keeps the flag: the oldest row (the
-- one every default-server fallback already treated as first), the rest
-- start disabled.
UPDATE servers SET enabled = CASE WHEN rowid = (SELECT MIN(rowid) FROM servers) THEN 1 ELSE 0 END;

INSERT INTO schema_migrations (version) VALUES (23);

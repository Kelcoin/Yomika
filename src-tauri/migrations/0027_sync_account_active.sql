-- 两类同步账户各存各的（WebDAV 一份、对象存储一份），但同一时刻只有一套生效：
-- 保存某一套就是启用它，另一套留在库里待命。
-- 回填：老库里最多只有一行，把它标成生效。
ALTER TABLE sync_accounts ADD COLUMN active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1));
UPDATE sync_accounts SET active = 1
WHERE id = (SELECT id FROM sync_accounts ORDER BY updated_at DESC, id LIMIT 1);
INSERT INTO schema_migrations (version) VALUES (27);

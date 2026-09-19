-- 热路径缺的两个索引：
-- 1) 每次日志写入都要按 (scope_id, object_id) 查 MAX(logical_clock)
--    （journal_global_object / local_object_clock / append_dedup_journal），
--    原先只有 (scope_id, status, sequence)，object_id 无索引可用 → 每写全扫。
-- 2) 本地档案镜像 JOIN 按 archive_id 单列查（PK 是 (server_id, archive_id)，
--    单列谓词用不上 PK）→ 每行全扫，而调用方按行循环调用。
CREATE INDEX IF NOT EXISTS sync_journal_scope_object_idx
    ON sync_journal(scope_id, object_id);

CREATE INDEX IF NOT EXISTS archives_archive_id_idx
    ON archives(archive_id);

INSERT INTO schema_migrations (version) VALUES (30);

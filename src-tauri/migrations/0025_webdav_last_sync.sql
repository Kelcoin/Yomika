-- 上次成功同步的时刻：账户行据此显示「上次同步」并在启动/回到前台时判断要不要补一次，
-- 免得每次切窗口都重新推拉一遍整份文档。空值＝这个账户还没同步过。
ALTER TABLE webdav_accounts ADD COLUMN last_sync_at TEXT;
INSERT INTO schema_migrations (version) VALUES (25);

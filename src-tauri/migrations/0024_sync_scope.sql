-- 同步范围：账户上勾了哪几类，同步就只推拉哪几类。
-- 空串＝旧账户的默认集合（进度、历史、待看、搜索预设、非重复标记）。
-- LRR 服务器、E-H 账户与应用设置默认不勾：它们带着地址、账号名这类信息，
-- 要不要让它们上远端由使用者自己决定。
ALTER TABLE webdav_accounts ADD COLUMN sync_scope TEXT NOT NULL DEFAULT '';
INSERT INTO schema_migrations (version) VALUES (24);

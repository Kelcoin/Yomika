-- 同步不再只有 WebDAV：账户表升级为「远端账户」，类型由 kind 决定。
--   kind='webdav'：base_url 是目录地址，username/凭据是账号口令。
--   kind='s3'    ：base_url 是 S3 兼容端点（如 Cloudflare R2），bucket 是存储桶，
--                  username 放 Access Key ID，凭据库放 Secret Access Key。
-- 旧行都是 WebDAV，默认值正好接住。
ALTER TABLE webdav_accounts RENAME TO sync_accounts;
ALTER TABLE sync_accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'webdav';
ALTER TABLE sync_accounts ADD COLUMN bucket TEXT NOT NULL DEFAULT '';
INSERT INTO schema_migrations (version) VALUES (26);

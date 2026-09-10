PRAGMA foreign_keys = ON;

ALTER TABLE eh_accounts ADD COLUMN gp TEXT;
ALTER TABLE eh_accounts ADD COLUMN credits TEXT;
ALTER TABLE eh_accounts ADD COLUMN hath TEXT;
ALTER TABLE eh_accounts ADD COLUMN exhentai_access INTEGER;

INSERT INTO schema_migrations (version) VALUES (20);

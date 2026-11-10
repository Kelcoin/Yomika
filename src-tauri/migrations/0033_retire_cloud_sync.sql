-- Local reset markers prevent server metadata resurrecting intentional progress resets.
CREATE TABLE reading_resets (scope_id TEXT NOT NULL, archive_id TEXT NOT NULL, PRIMARY KEY(scope_id,archive_id));
INSERT OR IGNORE INTO reading_resets SELECT scope_id, json_extract(payload_json,'$.archiveId') FROM sync_journal WHERE object_type='reading_progress' AND (operation='delete' OR json_extract(payload_json,'$.clearProgress')=1) AND json_extract(payload_json,'$.archiveId') IS NOT NULL;
-- Preserve user records; retire cloud queue and account metadata.
DROP TABLE IF EXISTS sync_applied_segments;
DROP TABLE IF EXISTS sync_journal;
DROP TABLE IF EXISTS sync_accounts;
DROP TABLE IF EXISTS webdav_accounts;
DELETE FROM settings WHERE key='preferences.auto_sync';
INSERT INTO schema_migrations (version) VALUES (33);

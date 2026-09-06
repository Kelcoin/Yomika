-- Sortable added-at column.
--
-- "Newest first" used to be derived at query time from the `date_added:` tag
-- inside tags_json, and the refresh path ordered by local_updated_at, which a
-- full resync sets to the same CURRENT_TIMESTAMP for every row. Both collapse
-- into an arbitrary order, so archives added in LANraragi never surfaced.
ALTER TABLE archives ADD COLUMN added_at INTEGER;
ALTER TABLE archives ADD COLUMN first_seen_at INTEGER;

UPDATE archives
SET added_at = (
    SELECT MAX(CAST(substr(value, 12) AS INTEGER))
    FROM json_each(archives.tags_json)
    WHERE value LIKE 'date_added:%'
)
WHERE added_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_archives_added_at
    ON archives (server_id, added_at DESC, archive_id);

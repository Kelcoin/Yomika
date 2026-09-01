CREATE TABLE IF NOT EXISTS archive_categories (
    server_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    archive_id TEXT NOT NULL,
    PRIMARY KEY (server_id, category_id, archive_id),
    FOREIGN KEY (server_id, archive_id) REFERENCES archives(server_id, archive_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS archive_categories_lookup_idx
    ON archive_categories(server_id, category_id, archive_id);

INSERT INTO schema_migrations (version) VALUES (12);

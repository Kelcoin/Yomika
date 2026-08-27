PRAGMA foreign_keys = ON;

ALTER TABLE tasks ADD COLUMN cancelable INTEGER NOT NULL DEFAULT 1 CHECK (cancelable IN (0, 1));
ALTER TABLE tasks ADD COLUMN retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1));

INSERT INTO schema_migrations (version) VALUES (11);

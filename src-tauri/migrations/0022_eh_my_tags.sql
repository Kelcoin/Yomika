-- The E-Hentai account's own tag list ("My Tags", https://e-hentai.org/mytags).
-- One fetch stores the whole set per account: cards and detail pages rank the
-- watched tags first and paint them with the account's preset colours. No sync
-- semantics — the table is a cache of the server-side list, replaced wholesale
-- on every fetch.
CREATE TABLE IF NOT EXISTS eh_my_tags (
  account_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  namespace TEXT NOT NULL,
  tag_key TEXT NOT NULL,
  watched INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, tag_id)
);
CREATE INDEX IF NOT EXISTS eh_my_tags_watched_idx ON eh_my_tags (account_id, watched);
INSERT INTO schema_migrations (version) VALUES (22);

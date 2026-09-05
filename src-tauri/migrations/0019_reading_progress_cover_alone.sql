-- Per-archive pairing start for double-page reading.
--
-- A scan that includes both inside-cover pages pairs off by one all the way
-- through. The reader has a control for it, but the setting lived only in
-- component state, so it evaporated every time the archive was reopened — the
-- fix had to be re-applied on every visit to the same broken scan.
--
-- It belongs beside `layout` and `direction`: all three are per-archive reading
-- preferences, and all three should travel with the progress row through the
-- sync journal. NULL means "not decided", which reads as the default (the cover
-- opens alone) and keeps rows written by older builds valid.
PRAGMA foreign_keys = ON;

ALTER TABLE reading_progress ADD COLUMN cover_alone INTEGER;

INSERT INTO schema_migrations (version) VALUES (19);

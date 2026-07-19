-- Per-team invite codes. Admin batch-generates them and hands one to each team.
-- A code is single-use: consumed when a team creates its submission.
CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  label TEXT,              -- optional note (e.g. which team it was handed to)
  used_by TEXT,            -- submission id that consumed it (NULL = still available)
  created_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_used ON invite_codes(used_by);

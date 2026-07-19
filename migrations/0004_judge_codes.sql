-- Per-judge login codes: each judge gets a unique code bound to a fixed name,
-- so scoring identity is stable (no more same-name overwrite).
CREATE TABLE IF NOT EXISTS judges (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Rekey scores on a stable judge_id (the judge's login code), not the typed name.
-- Safe to drop: no scores exist in production yet.
DROP TABLE IF EXISTS scores;
CREATE TABLE scores (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  judge_id TEXT NOT NULL,          -- stable identity (judge login code, or 'admin')
  judge_name TEXT NOT NULL,        -- display only
  innovation INTEGER NOT NULL,
  technical INTEGER NOT NULL,
  completeness INTEGER NOT NULL,
  presentation INTEGER NOT NULL,
  comment TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(submission_id, judge_id)
);

CREATE INDEX IF NOT EXISTS idx_scores_submission ON scores(submission_id);

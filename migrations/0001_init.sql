-- HackVideo schema: GitHub-repo submissions + screenshots (in KV) + judge scores.
-- Auth is passcode-based with stateless signed cookies, so there is no auth/session table.

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  team_name TEXT NOT NULL,
  contact TEXT,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  description TEXT,
  video_url TEXT NOT NULL,        -- required external link (Bilibili / YouTube / etc.)
  video_key TEXT,                 -- reserved: R2 object key when direct upload is enabled
  shot_count INTEGER NOT NULL DEFAULT 0,
  shots_meta TEXT NOT NULL DEFAULT '[]',  -- JSON array of {contentType} per screenshot, KV key = shot:<id>:<idx>
  share_token TEXT NOT NULL UNIQUE,
  edit_token TEXT NOT NULL,       -- lets the submitter edit later without an account
  locked_sha TEXT,                -- frozen commit SHA for the reviewed version
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready', 'hidden')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(repo_owner, repo_name)
);

CREATE INDEX IF NOT EXISTS idx_submissions_status_created
  ON submissions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  judge_name TEXT NOT NULL,
  innovation INTEGER NOT NULL,      -- 1-10 创新
  technical INTEGER NOT NULL,       -- 1-10 技术
  completeness INTEGER NOT NULL,    -- 1-10 完成度
  presentation INTEGER NOT NULL,    -- 1-10 展示
  comment TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(submission_id, judge_name)
);

CREATE INDEX IF NOT EXISTS idx_scores_submission
  ON scores(submission_id);

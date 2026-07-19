-- Fix: repo uniqueness must be PER TENANT, not global, so the same repo can be
-- submitted in different hackathons. Rebuild submissions with a composite unique key.
-- (Testing phase: a simple rebuild; existing demo rows are carried over.)

CREATE TABLE submissions_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'demo',
  project_name TEXT NOT NULL DEFAULT '',
  team_name TEXT NOT NULL,
  contact TEXT,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  description TEXT,
  video_url TEXT NOT NULL,
  video_key TEXT,
  shot_count INTEGER NOT NULL DEFAULT 0,
  shots_meta TEXT NOT NULL DEFAULT '[]',
  share_token TEXT NOT NULL UNIQUE,
  edit_token TEXT NOT NULL,
  locked_sha TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready', 'hidden')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, repo_owner, repo_name)
);

INSERT INTO submissions_new
  (id, tenant_id, project_name, team_name, contact, repo_owner, repo_name, repo_url, description, video_url, video_key, shot_count, shots_meta, share_token, edit_token, locked_sha, status, created_at, updated_at)
  SELECT id, tenant_id, project_name, team_name, contact, repo_owner, repo_name, repo_url, description, video_url, video_key, shot_count, shots_meta, share_token, edit_token, locked_sha, status, created_at, updated_at
  FROM submissions;

DROP TABLE submissions;
ALTER TABLE submissions_new RENAME TO submissions;

CREATE INDEX IF NOT EXISTS idx_submissions_tenant ON submissions(tenant_id, status, created_at DESC);

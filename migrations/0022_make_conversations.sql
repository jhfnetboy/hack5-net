-- Server-side persistence of the /make (mini「做成应用」) chat, so a returning participant gets
-- their prior conversation + spec-readiness back cross-browser — not just this-browser localStorage
-- (which is also cleared on launch). Keyed by (tenant, email_key, wb_project); email_key mirrors the
-- submissions identity HMAC(AUTH_SECRET, "mini:"+email)[:40] so a conversation lines up with the
-- launched build for the same participant. Persistence is gated on a signed hv_part session server-side
-- — anonymous chats stay localStorage-only.
CREATE TABLE IF NOT EXISTS make_conversations (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  email_key   TEXT NOT NULL,
  wb_client   TEXT,
  wb_project  TEXT NOT NULL,
  msgs        TEXT NOT NULL DEFAULT '[]',   -- JSON [{who:'me'|'ai', text}]
  readiness   TEXT,                          -- JSON {score, loop_ready}
  ready       INTEGER NOT NULL DEFAULT 0,
  last_idea   TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_make_conv_key ON make_conversations(tenant_id, email_key, wb_project);
CREATE INDEX IF NOT EXISTS idx_make_conv_owner ON make_conversations(tenant_id, email_key, updated_at DESC);

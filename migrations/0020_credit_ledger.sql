-- Credits/token billing (mini /make): local ledger for audit + idempotency.
-- hack5 does NOT hold the balance (an external credits system, queried by email, is the authority).
-- This table records every reserve/settle/release so charges are idempotent (by ref/id) and
-- reconcilable, and so per-participant usage can be shown. No behaviour change until CREDITS_ENABLED.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id          TEXT PRIMARY KEY,               -- hack5-generated ref (idempotency key; sent to the external API)
  tenant_id   TEXT NOT NULL,
  email       TEXT NOT NULL,                  -- participant identity = credits account key
  kind        TEXT NOT NULL,                  -- 'chat' | 'build'
  status      TEXT NOT NULL DEFAULT 'reserved', -- 'reserved' | 'settled' | 'released'
  tokens      INTEGER NOT NULL DEFAULT 0,     -- actual tokens (filled on settle)
  credits     INTEGER NOT NULL DEFAULT 0,     -- credits reserved, then adjusted to actual on settle
  hold_id     TEXT,                           -- external reserve/hold id, if the API returns one
  wb_ref      TEXT,                           -- WorkBench job/turn ref this charge corresponds to
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_email ON credit_ledger(email, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant ON credit_ledger(tenant_id, created_at);

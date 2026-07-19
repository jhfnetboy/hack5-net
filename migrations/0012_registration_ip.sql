-- Registration abuse control: record submitter IP so we can rate-limit per (tenant, IP).
ALTER TABLE registrations ADD COLUMN request_ip TEXT;
CREATE INDEX IF NOT EXISTS idx_registrations_ratelimit ON registrations(tenant_id, request_ip, created_at);

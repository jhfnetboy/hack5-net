-- Organizer (host) profile: an account-level org identity reused across all their hackathons.
ALTER TABLE users ADD COLUMN org_name TEXT;
ALTER TABLE users ADD COLUMN org_intro TEXT;
ALTER TABLE users ADD COLUMN org_url TEXT;
ALTER TABLE users ADD COLUMN org_contact TEXT;
ALTER TABLE users ADD COLUMN org_logo TEXT;   -- small square logo as a data: URI

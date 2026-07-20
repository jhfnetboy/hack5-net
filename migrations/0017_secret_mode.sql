-- Secret / enterprise hackathon mode: gated access + no-source-exposure submissions.
ALTER TABLE tenants ADD COLUMN mode TEXT NOT NULL DEFAULT 'open';   -- 'open' | 'secret'
ALTER TABLE tenants ADD COLUMN access_days INTEGER NOT NULL DEFAULT 7; -- access-session validity (organizer set)

-- Judges bind a GitHub account so participants can add them as private-repo collaborators.
ALTER TABLE judges ADD COLUMN github_user TEXT;

-- Secret submissions: online demo + credentials + pasted README + private repo (open mode: NULL).
ALTER TABLE submissions ADD COLUMN demo_url TEXT;
ALTER TABLE submissions ADD COLUMN demo_user TEXT;
ALTER TABLE submissions ADD COLUMN demo_pass TEXT;
ALTER TABLE submissions ADD COLUMN readme_md TEXT;

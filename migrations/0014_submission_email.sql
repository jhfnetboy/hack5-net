-- Reliably reach submitters: collect a required email as its own field.
-- Contact info (email/wechat) is shown to judges/admin only, never to anonymous viewers.
ALTER TABLE submissions ADD COLUMN email TEXT;

-- Add a product/project name (the primary title of a submission).
-- Team name becomes secondary/optional.
ALTER TABLE submissions ADD COLUMN project_name TEXT NOT NULL DEFAULT '';

-- The composer has always offered a size; the API accepted it and then dropped
-- it on the floor. Store it, so the control plane can schedule against it once
-- there is more than one host.
ALTER TABLE sessions ADD COLUMN size TEXT NOT NULL DEFAULT 'Medium';

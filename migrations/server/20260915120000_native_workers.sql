-- A worker runs on the machine itself, always. A host that pointed at a
-- container — one on this machine, or one reached through `docker exec` on a
-- server — has no worker behind it any more. Its workspaces, sessions and
-- events go with it: they are a record of what that worker reported, and the
-- worker is what is being removed.
DELETE FROM hosts
 WHERE compute->>'type' = 'Container'
    OR (compute->>'type' = 'Server' AND compute->>'container' IS NOT NULL);

-- What is left is a machine reached over ssh, and the field that said which
-- container to exec into no longer means anything.
UPDATE hosts
   SET compute = compute - 'container'
 WHERE compute->>'type' = 'Server';

-- A host says *which* key, not *where* it is.
--
-- `identityFile` was a path on the machine running the control plane, which was
-- right while that machine was the operator's own. In a container it is not:
-- the path is read inside the container, `~/.ssh/id_ed25519` names a file that
-- exists on their machine and not in this one, and no path they can type
-- bridges the two. The error was `no key at /root/.ssh/id_ed25519` — naming a
-- file they could see and saying it was not there.
--
-- So the field becomes a `key` object with a `type`, one of which is still a
-- path. Nothing here changes what an existing host does:
--
--   * a host that named a path keeps naming it, as `File` — still correct for a
--     control plane that is not in a container, and the only honest thing to do
--     with a value somebody chose.
--   * a host that named nothing keeps naming nothing, as `Default` — ssh's own
--     choice of the agent and then the usual names, which is what absent has
--     always meant here.
--
-- Nothing is migrated to `Managed`. Firetower's own key is new, no machine has
-- been given it yet, and quietly switching a working host to a key its far end
-- has never seen would break the fleet on upgrade.
UPDATE hosts
SET compute = (compute - 'identityFile') || jsonb_build_object(
        'key', CASE
            WHEN compute->>'identityFile' IS NOT NULL
                 AND compute->>'identityFile' <> ''
                THEN jsonb_build_object(
                    'type', 'File',
                    'path', compute->>'identityFile'
                )
            ELSE jsonb_build_object('type', 'Default')
        END
    )
WHERE compute->>'type' = 'Server';

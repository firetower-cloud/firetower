-- A server is the parts of an ssh destination, not one string.
--
-- `target` held `[user@]host`, which was enough while every connection took
-- ssh's defaults. A port and a key have to be passed as their own flags, and
-- which account work runs as is a separate decision from which machine it runs
-- on, so each is now its own field.
--
-- Existing rows are split rather than dropped. Hosts are the control plane's
-- own — unlike sessions and events, there is no worker log to rebuild them
-- from, so losing one here means adding the machine again by hand.
UPDATE hosts
SET compute = (compute - 'target') || jsonb_build_object(
        -- `root@fire-01` comes apart. `fire-01` on its own is a name from an
        -- ssh config, and its user stays absent so that file still decides.
        'host', CASE
            WHEN position('@' IN compute->>'target') > 0
                THEN split_part(compute->>'target', '@', 2)
            ELSE compute->>'target'
        END,
        'user', CASE
            WHEN position('@' IN compute->>'target') > 0
                THEN split_part(compute->>'target', '@', 1)
            ELSE NULL
        END,
        -- Nothing was ever stored for these, and absent means "whatever ssh
        -- would do" — which is exactly what these hosts have been doing.
        'port', NULL,
        'identityFile', NULL
    )
WHERE compute->>'type' = 'Server';

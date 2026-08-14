-- Removing a host was impossible: every session it ever ran referenced it, so
-- the foreign key refused even when nothing was running.
--
-- Its sessions and events go with it. That is a real loss and the right one —
-- both are a cache of what a worker reported, and the worker is what you just
-- removed. The endpoint still refuses while anything is actually running, so
-- what cascades here is history, not work.
ALTER TABLE sessions DROP CONSTRAINT sessions_host_id_fkey;
ALTER TABLE sessions
    ADD CONSTRAINT sessions_host_id_fkey
    FOREIGN KEY (host_id) REFERENCES hosts (id) ON DELETE CASCADE;

ALTER TABLE events DROP CONSTRAINT events_host_id_fkey;
ALTER TABLE events
    ADD CONSTRAINT events_host_id_fkey
    FOREIGN KEY (host_id) REFERENCES hosts (id) ON DELETE CASCADE;

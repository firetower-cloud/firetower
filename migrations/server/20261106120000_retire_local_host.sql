-- Retire the machine that was the control plane's own container.
--
-- Firetower used to register its own process as a host named `localhost` on
-- every boot, so that a fresh install had somewhere to run. An agent started
-- there ran as a child of this binary: same container, same uid, same
-- environment — the database URL, the vault's root key and the updater's token
-- among it. Nothing can start a worker there any more.
--
-- **Nothing is deleted, and nothing cascades.** The sessions, workspaces,
-- transcripts, events and `secret_access` rows that point at this machine are
-- the record of what ran in that container, which is the reason the feature
-- was removed and is evidence somebody is reading. Deleting the host row would
-- take the sessions and events with it. So the row stays, `Compute::Local`
-- stays decodable, and `host_by_id` still answers for it — a session that ran
-- there opens and renders exactly as it did.
--
-- What changes is that it is no longer in the fleet: `Db::hosts` and
-- `Db::hosts_for` both filter `compute->>'type' <> 'Local'`, so no list offers
-- it, no scheduler reaches it and nothing tries to connect to it. One
-- predicate rather than an exclusion in each of the dozen places that
-- enumerate machines.
--
-- Drained and unreachable here as well, belt and braces: anything that reads
-- the row directly — an older client, a query written later — sees a machine
-- that takes no work and is not answering, which is true.
--
-- `roles.host_id` pointing at it is left exactly as it is. Its column is
-- nullable with `on delete set null`, and null means "the scheduler picks";
-- nulling them here would silently repin somebody's profile, which is a
-- decision for whoever owns it.
update hosts
   set drained = true,
       state = 'Unreachable'
 where compute ->> 'type' = 'Local';

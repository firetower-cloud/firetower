-- A run can stop and wait for somebody to answer.
--
-- The backup step used to end the run when it failed, which left no way to
-- upgrade a deployment whose database could not be dumped. It now warns and
-- waits, and this state is what it waits in.
--
-- No constraint on the column to widen — both state columns are plain text.
-- What has to change is the index the "is anything running" query rides on,
-- and a partial index cannot be altered in place.
drop index if exists update_runs_active;

create index update_runs_active on update_runs (created_at desc)
    where state in ('planned', 'waiting_idle', 'running', 'waiting_decision');

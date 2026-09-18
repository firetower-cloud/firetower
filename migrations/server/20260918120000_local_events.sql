-- Events the control plane raises itself.
--
-- Until now every row here came from a worker, so `host_id` and `seq` were the
-- worker's own numbering and the pair deduplicated a replay after a reconnect.
-- But a status change decided *here* — an agent blocked on a permission, a
-- restart that did not come back, a session handed an account — has no host and
-- no place in any host's sequence, and inventing one risks colliding with the
-- numbering its worker owns.
--
-- So a control-plane event has no host. `unique (host_id, seq)` still holds for
-- everything a worker sends, and leaves these alone: in Postgres NULLs are
-- distinct, so the constraint never matches them.
--
-- The cursor clients resume from was never this column — `event_from_row` reads
-- the `bigserial` id — so nothing a client has stored changes meaning.
alter table events alter column host_id drop not null;
alter table events alter column seq     drop not null;

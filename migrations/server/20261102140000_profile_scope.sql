-- What a profile is allowed to reach: the subagents it may delegate to, and the
-- skills it may load. Both by id, and both empty by default, which means "any
-- the owner can see" — scope is opt-in, and a profile nobody narrows behaves as
-- it always did.
--
-- Stored as the ids ticked, not as a directory rule: ticking a whole directory
-- in the picker is a convenience for selecting many at once, so a subagent added
-- to that directory later does not silently join a bounded profile's reach. A
-- stale id (its subagent or skill deleted) costs nothing — every read intersects
-- these with what is actually visible, so a dangling id simply drops out.
alter table roles
    add column delegate_scope text[] not null default '{}',
    add column skill_scope    text[] not null default '{}';

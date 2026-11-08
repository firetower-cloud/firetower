-- A profile's skills become the union of three additive sources, not an
-- intersection of one.
--
-- `skill_scope` was a filter: a spawn took the owner's defaults and kept only
-- the ids on the list, so a tick could only ever subtract and an empty
-- intersection delivered nothing at all. These two switches turn it into a
-- grant. What a profile loads is now the owner's always-on set (when the first
-- is on), plus their defaults for the repositories the child checks out (when
-- the second is on), plus `skill_scope` added on top of whatever survives.
--
-- **Both default true, and that is the whole migration.** Every existing row
-- has `skill_scope = '{}'` — the column's own default, and what `create_profile`
-- mints — and an empty list with both sources on resolves to exactly the set
-- those profiles are given today. So there is no backfill to write and no row
-- to inspect: the two defaults are the compatibility story. The one behaviour
-- that does change is the one the feature exists for, a tick that the old
-- intersection dropped now arrives.
--
-- Not strictly zero-loss, deliberately: a profile ticking a skill its owner can
-- no longer reach loses it, because the spawn now re-checks visibility before
-- it pins. A shared profile could otherwise put a skill only its author can see
-- onto a colleague's worker, and a skill is executable.
alter table roles
    add column include_always_on     boolean not null default true,
    add column include_repo_defaults boolean not null default true;

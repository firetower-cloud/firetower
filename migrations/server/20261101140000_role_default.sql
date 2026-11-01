-- The one profile a person starts a new workspace as, without choosing.
--
-- `user_id` is the key, not `(user_id, role_id)`, because a person has at most
-- one default: setting another is an upsert that replaces it, so "only one"
-- holds without a second write to clear the old. A profile that is deleted
-- takes its default with it (`on delete cascade`), the same as a session pin.
--
-- Global, not per-repository: a lead profile is about who the agent is, not
-- which codebase it opens, so unlike a skill default there is no repo here.
create table role_defaults (
    user_id text primary key references users(id) on delete cascade,
    role_id text not null references roles(id) on delete cascade,
    at      timestamptz not null default now()
);

create index role_defaults_by_role on role_defaults (role_id);

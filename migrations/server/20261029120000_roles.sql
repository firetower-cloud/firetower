-- A role: a saved kind of agent a lead can start.
--
-- Placed, exactly as a skill is — see `docs/paths-and-ownership.md`. It has a
-- path, it can be filed into a directory and shared, and the one predicate
-- that decides "may see this" decides it here too. Nothing here invents a
-- second way to answer that.
--
-- What a role *is*, beyond where it lives: the short lines a lead reads to
-- choose it (`does`, `use_when`, `not_when`), where it runs, which agent runs
-- it, and the instructions composed into the child it starts. A spawn names a
-- role and the control plane applies the rest, so the lead does not describe
-- the same kind of agent every time.
--
-- `placement` and `agent` each have a "let the lead choose" state — 'lead' and
-- null — so a role can pin them when it must and leave them open otherwise. A
-- pinned value is enforced: the lead's own argument does not override it.
create table roles (
    id            text primary key,
    org_id        text not null references organizations(id) on delete cascade,
    -- `ft_core::ResourcePath` is the only thing that writes one.
    path          ltree not null,
    created_by    text references principals(id) on delete set null,
    -- A few named people on one role, on top of where it lives. Same shape and
    -- same meaning as a skill's.
    extra_perms   jsonb not null default '{}',

    name          text not null,
    -- Unique per installation, so two people's `reviewer` roles do not collide
    -- on the path's own uniqueness. A discriminator is appended at creation.
    slug          text not null,

    -- The three lines a lead reads. `does` is the one-liner; the other two are
    -- the trigger and the anti-trigger. Firetower's skills hold description to
    -- "what and when"; a role is held to the same bar, split into fields so it
    -- cannot be forgotten.
    does          text not null,
    use_when      text not null default '',
    not_when      text not null default '',

    -- Where it runs: 'lead' (let the lead choose), 'here' (the lead's
    -- workspace), or 'new' (its own). 'lead' is the open default.
    placement     text not null default 'lead',
    -- Which agent runs it: null lets the lead choose (defaulting to the lead's
    -- own), or one of 'ClaudeCode' | 'Codex' | 'KimiCode' to pin it.
    agent         text,
    -- Composed into the child's AGENTS.md and prompt. Markdown, the agent's to
    -- read. A read-only or hand-back-a-PR intent lives here, in words, rather
    -- than as a field that looks enforced and is not.
    instructions  text not null default '',

    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create unique index roles_by_path on roles (path);
create index roles_path_tree on roles using gist (path);
create unique index roles_slug on roles (org_id, slug);
create index roles_by_creator on roles (created_by);

comment on table roles is
  'A saved kind of agent a lead can start by name. Placed, like a skill.';

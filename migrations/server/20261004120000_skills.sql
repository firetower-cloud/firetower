-- Skills: folders of instructions an agent loads when it needs them.
--
-- A skill is Placed — it has a path, it can be filed into a directory, and
-- every read of one runs `filed_where` like every other kind. Nothing here
-- invents a second way to share something.
--
-- Three things are worth reading before changing this.
--
-- **Versions are append-only.** A version is a fact about the past: what the
-- bundle was when somebody dropped it. Sessions pin one, so rewriting a row
-- would change what a running conversation is reading.
--
-- **Bytes are content-addressed.** Re-dropping a folder is how a version is
-- made, so without hashes a one-line edit to `canvas-design` would re-store 5.3
-- MB of unchanged fonts. Measured on the real library: 11 MB of files is 8.9 MB
-- of distinct blobs on a single import, before any versioning at all.
--
-- **The two editable fields live on `skills`, not on the version.** `name` and
-- `description` are what the picker reads for three hundred rows, and a join
-- per row to find them would be a join per row for the one list that has to be
-- fast. They are copied down from the current version and kept in step.

-- ── the resource ──────────────────────────────────────────────────────

create table skills (
    id                 text primary key,
    org_id             text not null references organizations(id) on delete cascade,
    -- Placed: u.<person>.<slug> or d.<directory>.<slug>. Never built by hand;
    -- `ft_core::ResourcePath` is the only thing that writes one.
    path               ltree not null,
    created_by         text references principals(id) on delete set null,
    extra_perms        jsonb not null default '{}',
    -- What the agent sees, and what somebody types as a command.
    name               text not null,
    -- The directory written onto a worker. Unique per installation so two
    -- skills of one name in two directories cannot collide on disk.
    slug               text not null,
    description        text not null,
    -- No foreign key: the first version points back at the skill that owns it,
    -- so a reference in the other direction is a cycle an insert cannot satisfy.
    current_version_id text,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);

create unique index skills_by_path on skills (path);
create index skills_path_tree on skills using gist (path);
create index skills_extra_perms on skills using gin (extra_perms);
create unique index skills_slug on skills (org_id, slug);
create index skills_by_creator on skills (created_by);

-- ── versions, append-only ─────────────────────────────────────────────

create table skill_versions (
    id          text primary key,
    skill_id    text not null references skills(id) on delete cascade,
    -- Monotonic per skill, and not semver. Whatever the author calls it lives
    -- in `frontmatter -> 'metadata' ->> 'version'`, which is where the Agent
    -- Skills standard puts it.
    version     integer not null,
    frontmatter jsonb not null,
    body        text not null,
    -- What changed, for somebody choosing between two of them.
    notes       text,
    -- What this costs in the model's context on every turn: the listing entry,
    -- counted once at import rather than per keystroke in a picker.
    tokens      integer not null default 0,
    bytes       bigint not null default 0,
    files       integer not null default 0,
    created_by  text references principals(id) on delete set null,
    created_at  timestamptz not null default now(),
    unique (skill_id, version)
);

create index skill_versions_by_skill on skill_versions (skill_id, version desc);

-- ── bytes, once, under a hash of themselves ───────────────────────────

create table blobs (
    hash       text primary key,
    bytes      bytea not null,
    size       bigint not null,
    created_at timestamptz not null default now()
);

create table skill_files (
    version_id text not null references skill_versions(id) on delete cascade,
    -- Relative, validated before it is written: never absolute, never `..`.
    path       text not null,
    hash       text not null references blobs(hash),
    executable boolean not null default false,
    size       bigint not null,
    primary key (version_id, path)
);

create index skill_files_by_hash on skill_files (hash);

-- ── defaults: ticked when you start work ──────────────────────────────
--
-- Hung off the *repository row*, which is already one per person per remote,
-- so a default is personal without anything being built for it. A null
-- `repo_id` is the same idea with no repository attached: on in every workspace
-- this person starts.

create table skill_defaults (
    user_id  text not null references users(id) on delete cascade,
    repo_id  text references repos(id) on delete cascade,
    skill_id text not null references skills(id) on delete cascade,
    at       timestamptz not null default now()
);

-- `repo_id` is nullable, so a primary key would let a person add the same
-- everywhere-default twice. Coalesced, because null is not distinct from null.
create unique index skill_defaults_one
    on skill_defaults (user_id, skill_id, coalesce(repo_id, ''));
create index skill_defaults_by_repo on skill_defaults (repo_id);

-- ── what a session is actually running ────────────────────────────────
--
-- The version is pinned, not looked up. A new version is taken by whoever
-- starts next; a conversation already running keeps what it had, because
-- changing the instructions underneath a live turn is the thing this avoids.

create table skill_pins (
    session_id text not null references sessions(id) on delete cascade,
    skill_id   text not null references skills(id) on delete cascade,
    version_id text not null references skill_versions(id),
    added_by   text references principals(id) on delete set null,
    at         timestamptz not null default now(),
    primary key (session_id, skill_id)
);

create index skill_pins_by_skill on skill_pins (skill_id);

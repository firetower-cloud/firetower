-- Firetower's control plane, as one schema.
--
-- This replaces twenty incremental migrations. They described how the shape
-- got here — one repository per session, then several; one account, then
-- accounts at all — and none of that history is worth carrying, because
-- nothing has been installed from them that anyone has to keep.
--
-- Written for several people on one Firetower, which is the change the old
-- shape could not express: it carried a `user_id bigint DEFAULT 1` on three
-- tables, referencing nothing, populated by nobody.
--
-- **Who owns what.** An organization owns the things a team shares — its
-- compute and its repositories. A person owns the things that are theirs: the
-- sessions they start, the tokens they authorized, the identity on their
-- commits. A repository row is not access: it is a pointer and some setup, and
-- what actually opens it is the token, which is per person.

create table organizations (
    id          text primary key,
    name        text not null,
    created_at  timestamptz not null default now()
);

-- One row, enforced by the check. Which organization this Firetower belongs
-- to, for the deployments that are one team on one machine.
create table installation (
    singleton   boolean primary key default true check (singleton),
    org_id      text not null references organizations(id) on delete cascade,
    -- When somebody named the organization, which is what finishing the setup
    -- wizard means. Null until then, and the reason the row exists from the
    -- first boot rather than from the end of the wizard: a host coming up
    -- needs to know which organization it belongs to before anybody has
    -- answered any questions.
    named_at    timestamptz,
    created_at  timestamptz not null default now()
);

create table users (
    id                   text primary key,
    org_id               text not null references organizations(id) on delete cascade,
    username             text not null,
    -- For signing in, and for nothing else. What goes on a commit is a
    -- different fact about a different account — see `git_identities`.
    email                text,
    password_hash        text not null,
    role                 text not null default 'admin',
    must_change_password boolean not null default false,
    created_at           timestamptz not null default now(),
    unique (org_id, username)
);

-- Absent is allowed and common; two people sharing one is not.
create unique index users_by_email on users (org_id, email) where email is not null;

create table user_sessions (
    token_hash    text primary key,
    user_id       text not null references users(id) on delete cascade,
    created_at    timestamptz not null default now(),
    last_seen_at  timestamptz not null default now(),
    expires_at    timestamptz not null
);

create index user_sessions_by_user   on user_sessions (user_id);
create index user_sessions_by_expiry on user_sessions (expires_at);

-- ── what a team shares ──────────────────────────────────────────────────

-- Compute belongs to the organization: a team pays for a machine and every
-- one of them runs on it.
--
-- Worth knowing what that means: sessions on one host share a worker
-- container, so an agent can read another session's worktree. Deliberate for
-- now, and the fix is a container per person rather than a column here.
create table hosts (
    id              text primary key,
    org_id          text not null references organizations(id) on delete cascade,
    name            text not null,
    state           text not null,
    cpus            integer,
    memory_mb       bigint,
    worker_version  text,
    last_seen_at    timestamptz,
    last_seq        bigint not null default 0,
    created_at      timestamptz not null default now(),
    compute         jsonb not null,
    drained         boolean not null default false,
    diagnosis       jsonb,
    unique (org_id, name)
);

-- Repositories belong to the organization, and the token that opens one
-- belongs to a person.
--
-- The row is a pointer and some setup — none of it grants anything, and a
-- colleague seeing that `acme/api` is connected still needs their own access
-- to clone it. One row means one setup script and one mirror on disk, rather
-- than a copy per person that drifts from the others.
--
-- `visibility = 'private'` is for a side project nobody else needs to see.
create table repos (
    id              text primary key,
    org_id          text not null references organizations(id) on delete cascade,
    -- Who connected it, so the list can say. Kept if they leave.
    added_by        text references users(id) on delete set null,
    visibility      text not null default 'org' check (visibility in ('org', 'private')),
    slug            text not null,
    remote          text not null,
    default_branch  text,
    setup           text,
    env_file        text,
    created_at      timestamptz not null default now(),
    unique (org_id, remote)
);

create index repos_by_owner on repos (added_by);

-- ── what a person owns ──────────────────────────────────────────────────

create sequence session_number_seq;

-- A session belongs to whoever started it. Nobody else lists it, opens it, or
-- reads its conversation.
create table sessions (
    id              text primary key,
    user_id         text not null references users(id) on delete cascade,
    host_id         text not null references hosts(id) on delete cascade,
    repo            text,
    title           text not null,
    prompt          text not null,
    branch          text,
    base            text,
    agent           text not null,
    size            text not null default 'Medium',
    status          text not null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    steps           jsonb not null default '[]'::jsonb,
    note            text,
    number          bigint not null unique default nextval('session_number_seq'),
    name            text,
    forgotten_at    timestamptz,
    cleaned_at      timestamptz,
    pull_request    text,
    proposed_title  text,
    proposed_body   text
);

create index sessions_by_status on sessions (status, updated_at);
create index sessions_by_owner  on sessions (user_id, updated_at);

create table session_repos (
    session_id    text not null references sessions(id) on delete cascade,
    position      integer not null,
    repo_id       text,
    slug          text not null,
    base          text not null,
    branch        text not null,
    path          text not null default '',
    trouble       text,
    pull_request  text,
    primary key (session_id, position)
);

create table events (
    id          bigserial primary key,
    host_id     text not null references hosts(id) on delete cascade,
    seq         bigint not null,
    session_id  text not null,
    payload     jsonb not null,
    created_at  timestamptz not null default now(),
    unique (host_id, seq)
);

create index events_by_session on events (session_id, id);

create table agent_lines (
    session_id  text not null references sessions(id) on delete cascade,
    line_no     bigint not null,
    line        text not null,
    created_at  timestamptz not null default now(),
    primary key (session_id, line_no)
);

create index agent_lines_session_line on agent_lines (session_id, line_no);

-- ── agents ──────────────────────────────────────────────────────────────

-- How each agent is run, per person: a subscription is somebody's, and so is
-- the choice to let it accept edits without asking.
create table agents (
    user_id     text not null references users(id) on delete cascade,
    kind        text not null,
    mode        text not null,
    enabled     boolean not null default true,
    updated_at  timestamptz not null default now(),
    primary key (user_id, kind)
);

-- What a host reported about an agent installed on it. A fact about the
-- machine, so it belongs to the machine.
create table agent_presence (
    host_id     text not null references hosts(id) on delete cascade,
    kind        text not null,
    installed   boolean not null,
    version     text,
    logged_in   boolean,
    account     text,
    checked_at  timestamptz not null default now(),
    primary key (host_id, kind)
);

-- ── the secret store ────────────────────────────────────────────────────

-- `owner` is the person a secret belongs to, and the empty string is the
-- install itself.
--
-- Empty rather than null because this is half of a primary key, and a null
-- there means "no two rows can agree on it" — which is the opposite of what a
-- shared secret needs.
create table secrets (
    scope        text not null,
    name         text not null,
    owner        text not null default '',
    version      integer not null,
    wrapped_key  bytea not null,
    ciphertext   bytea not null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    primary key (scope, name, owner)
);

-- Every time one was touched, chained. The value is never here.
create table secret_access (
    id        bigserial primary key,
    scope     text not null,
    name      text not null,
    owner     text not null default '',
    action    text not null,
    reason    text not null,
    at        timestamptz not null,
    previous  bytea,
    digest    bytea not null
);

create index secret_access_by_secret on secret_access (scope, name, owner, id);

-- ── git identity ────────────────────────────────────────────────────────

-- What goes on a commit, per person and per git host.
--
-- Not `users.email`, which is a login: your work address signs you in, and
-- your GitHub account is what a reviewer expects against the commits. Somebody
-- with three addresses has one of them on their GitHub, and this is the one
-- that has to be on the branch.
--
-- `source` says where it came from: 'host' was read from that person's token
-- and may be replaced when it changes, 'set' was typed and never is.
create table git_identities (
    user_id     text not null references users(id) on delete cascade,
    provider    text not null,
    name        text not null,
    email       text not null,
    source      text not null check (source in ('host', 'set')),
    updated_at  timestamptz not null default now(),
    primary key (user_id, provider)
);

-- ── install-wide settings ───────────────────────────────────────────────

-- The OAuth client id lives here. It registers the *application*, not a
-- person: everybody authorizes the same one and the device flow hands each of
-- them their own token.
create table settings (
    key         text primary key,
    value       text not null,
    updated_at  timestamptz not null default now()
);

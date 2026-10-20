-- ── Git hosts, one row each ─────────────────────────────────────────────
--
-- Until now there was one git host and it was compiled in: `providers.rs`
-- held a `&'static Provider` with GitHub's four URLs in it, and everything
-- downstream keyed off the string "github". That cannot describe a GitLab
-- somebody runs themselves — its address is not knowable at build time — and
-- it cannot describe two of anything, which is what a person with a personal
-- and a work account has.
--
-- So the compiled-in part shrinks to what is true of the *software* — the API
-- dialect, the URL shapes, what it calls a request to merge a branch — and
-- everything about an *instance* moves here.
--
-- **The token does not move.** It stays in the vault at `git/<id>/<owner>`,
-- one per person per host, which is why `id` below is a text column somebody
-- chose rather than a serial: the built-in row's id is the literal string
-- `github`, so every key already written against it still resolves. Same for
-- `git_identities.provider`, for the `github:` prefix on a task key, and for
-- the `/api/v1/providers/github/…` paths three clients already call.
--
-- Nothing is rewritten by this file. One row is inserted and one setting is
-- copied.
create table git_connections (
    id          text primary key,
    -- Which software, and so which dialect: github, gitlab, gitea. Not a
    -- foreign key — the kinds are code, and a row naming one this build does
    -- not have is a row to report rather than one to refuse at the database.
    kind        text not null,
    -- What everybody here sees in the list. Theirs to choose, because "GitHub"
    -- twice is the one arrangement the list has to be able to draw.
    label       text not null,
    -- Where a person reads it in a browser, no trailing slash.
    base_url    text not null,
    -- Root of the REST API. Stored rather than derived: GitHub.com answers on
    -- api.github.com while GitHub Enterprise answers at /api/v3 on the same
    -- host as the web interface, and that is not a rule, it is two facts.
    api_base    text not null,
    -- The hostname in a clone URL, which is how a remote with no row beside it
    -- is matched to a token.
    git_host    text not null,
    -- How people connect. 'device' is the browser flow; 'token' is each person
    -- pasting one. Gitea has no device flow at all and GitLab only got one in
    -- 17.9, so this is a property of the instance and not of the kind.
    auth        text not null default 'device' check (auth in ('device', 'token')),
    -- The application everybody here authorizes against, for the device flow.
    -- Public by design: a device-flow client id has no paired secret.
    client_id   text,
    -- What the instance said it was, last time one was reached. Only ever
    -- shown — it is what tells somebody their GitLab is too old for the
    -- browser flow, which is otherwise discovered as a rejection.
    version     text,
    -- The compiled-in one. Its address is not somebody's to edit and it is not
    -- theirs to remove; signing out of it is a different thing and still works.
    builtin     boolean not null default false,
    -- What order the list is drawn in. The built-in sorts first and stays
    -- first: a client older than this migration reads the first entry and
    -- nothing else, and that entry has to be the one it was already using.
    position    integer not null default 100,
    created_at  timestamptz not null default now(),
    -- Two hosts may share an address — a personal and a work account on
    -- github.com are two rows — but then they have to be told apart by name,
    -- because the list is the only place anybody ever picks between them.
    unique (kind, git_host, label)
);

-- The host every existing install is already using, under the id every key
-- already written is already using.
--
-- `client_id` is *copied* from the setting rather than moved. A control plane
-- rolled back to before this migration reads `settings` and has to still find
-- it there; what it costs is one row that stops being read, and what it buys
-- is that going back works.
insert into git_connections
    (id, kind, label, base_url, api_base, git_host, auth, client_id, builtin, position)
values
    ('github', 'github', 'GitHub', 'https://github.com', 'https://api.github.com',
     'github.com', 'device',
     (select value from settings where key = 'github.client_id'),
     true, 0);

-- ── Which host a repository came from ───────────────────────────────────
--
-- Null means "work it out from the remote's hostname", which is exactly what
-- happened before this column existed — so every row that predates it keeps
-- resolving the way it always did, and no backfill is needed or wanted. A
-- guess written into a column is a guess that outlives the person who could
-- have corrected it.
--
-- It earns its keep the moment two hosts share a hostname: with two github.com
-- accounts connected, the remote alone cannot say which token opens this
-- repository, and this can.
alter table repos
    add column connection_id text references git_connections(id) on delete set null;

comment on column repos.connection_id is
  'Which git host this was connected from. Null means match it by the remote''s hostname.';

create index repos_by_connection on repos (connection_id);

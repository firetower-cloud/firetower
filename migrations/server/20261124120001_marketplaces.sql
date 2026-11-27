-- Where plugins come from.
--
-- **The catalogue is synced; an install never is.** A row in
-- `marketplace_entries` is a listing — a name, a description, a logo and an
-- address. Refreshing rewrites those and touches nothing anybody installed.
-- That one split is what keeps a compromised or deleted upstream from
-- reaching into a running organisation: the worst it can do is offer a bad
-- row that somebody still has to choose.
create table marketplaces (
    id          text primary key,
    org_id      text not null references organizations (id) on delete cascade,
    -- The repository, as somebody would paste it.
    url         text not null,
    name        text not null,
    git_ref     text not null default 'main',
    -- Which manifest it turned out to carry. Both are read; this records
    -- which one answered, because it is the first thing to look at when a
    -- fetch stops working.
    manifest    text check (manifest in ('claude', 'firetower')),
    -- The commit the catalogue was read at. An install pins to this, so two
    -- people installing the same row on the same day get the same bytes.
    commit      text,
    fetched_at  timestamptz,
    -- What went wrong last time, kept so a stale catalogue can say why it is
    -- stale rather than silently showing yesterday's answer.
    error       text,
    -- Ours, added by this migration. Still removable: a marketplace nobody
    -- can take off is a marketplace nobody consented to.
    builtin     boolean not null default false,
    added_by    text references users (id) on delete set null,
    created_at  timestamptz not null default now(),
    unique (org_id, url)
);

create table marketplace_entries (
    marketplace_id text not null references marketplaces (id) on delete cascade,
    slug           text not null,
    name           text not null,
    description    text not null default '',
    version        text,
    author         text,
    category       text,
    homepage       text,
    -- Where the files are. Either a path inside this repository, or another
    -- repository entirely — Anthropic's own marketplace is mostly the second,
    -- so a reader that only understands the first understands a third of it.
    source         jsonb not null,
    -- Shown on the shelf without reaching anybody's origin.
    logo           bytea,
    logo_type      text,
    n_skills       int not null default 0,
    n_commands     int not null default 0,
    has_connector  boolean not null default false,
    primary key (marketplace_id, slug)
);

create index marketplace_entries_by_name on marketplace_entries (name);

-- What an installed bundle came from, so a row can say "there is a newer one"
-- and an update can be refused.
alter table skill_versions add column from_marketplace text references marketplaces (id) on delete set null;
alter table skill_versions add column from_slug text;
alter table skill_versions add column from_commit text;

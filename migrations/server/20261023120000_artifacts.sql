-- Artifacts: a page an agent published for somebody to look at.
--
-- Three things are worth reading before changing this.
--
-- **It does not hang off the workspace, and that is the whole point.**
-- `reclaim.rs` deletes a workspace within a minute of its last session ending,
-- with no grace period, and the cascade takes the conversation with it. An
-- artifact is a document rather than a conversation: it is owned by a person
-- and outlives the work that produced it. A foreign key to `sessions` here
-- would quietly make the feature impossible.
--
-- **Provenance is copied, not referenced.** `from_session_id` and
-- `from_workspace_name` are text, stamped at publish and never updated. A real
-- foreign key would be emptied by that same sweep, and the library's "which
-- workspace did this come from" column would be blank for nearly every row.
-- This is the Recorded discipline from `paths-and-ownership.md` §2.
--
-- **Versions are append-only and immutable.** A note is anchored to the bytes
-- it was written on — that is what makes it still mean something a week later
-- — so a version is never rewritten. Eviction deletes whole versions; it never
-- edits one.

create table artifacts (
    id                  text primary key,
    org_id              text not null references organizations(id) on delete cascade,
    -- Who it belongs to. Not the session, not the workspace.
    owner_id            text not null references users(id) on delete cascade,
    -- What a person calls it, and the folder the agent wrote it in.
    title               text not null,
    slug                text not null,
    -- No foreign key: the first version points back at the artifact that owns
    -- it, so a reference the other way is a cycle an insert cannot satisfy.
    current_version_id  text,
    -- Provenance. Text on purpose — see above.
    from_session_id     text,
    from_workspace_name text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create unique index artifacts_slug on artifacts (owner_id, slug);
create index artifacts_by_owner on artifacts (owner_id, updated_at desc);
create index artifacts_by_session on artifacts (from_session_id);

create table artifact_versions (
    id          text primary key,
    artifact_id text not null references artifacts(id) on delete cascade,
    -- 1, 2, 3 — what the card shows and what a note names.
    n           integer not null,
    -- Which file is the page. Everything else is an asset it reaches for.
    entry       text not null default 'index.html',
    bytes       bigint not null,
    created_at  timestamptz not null default now(),
    unique (artifact_id, n)
);

create index artifact_versions_by_artifact on artifact_versions (artifact_id, n desc);

create table artifact_files (
    version_id   text not null references artifact_versions(id) on delete cascade,
    -- Relative to the artifact's own root, so `index.html`, `style.css`.
    path         text not null,
    content_type text not null,
    body         bytea not null,
    primary key (version_id, path)
);

-- ── notes reach artifacts too ─────────────────────────────────────────
--
-- `port` becomes nullable because an artifact has none. The row still carries
-- a session for who-may-see-it, and now optionally the artifact version the
-- note was written against — which is the thing that makes it survive the
-- agent changing the page underneath it.
alter table preview_annotations
    alter column port drop not null,
    add column artifact_version_id text references artifact_versions(id) on delete cascade;

-- The check only ever meant anything for a port that is there.
alter table preview_annotations drop constraint if exists preview_annotations_port_check;
alter table preview_annotations
    add constraint preview_annotations_port_check
    check (port is null or (port between 1 and 65535));

-- One or the other, never neither: a note has to be about something.
alter table preview_annotations
    add constraint preview_annotations_target
    check (port is not null or artifact_version_id is not null);

create index preview_annotations_artifact on preview_annotations (artifact_version_id);

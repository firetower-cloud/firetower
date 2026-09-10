-- User feedback is durable: unlike worker projections, drafts cannot be rebuilt.
create table preview_annotations (
    id text primary key,
    session_id text not null references sessions(id) on delete cascade,
    user_id text not null references users(id) on delete cascade,
    port integer not null check (port between 1 and 65535),
    snapshot jsonb not null,
    note text not null,
    revision integer not null default 1,
    delivery text not null default 'draft' check (delivery in ('draft', 'sending', 'sent', 'uncertain')),
    delivery_started_at timestamptz,
    created_at timestamptz not null default now()
);
create index preview_annotations_session on preview_annotations(session_id, user_id, created_at);

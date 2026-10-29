-- A profile's team: the profiles it may hand work to.
--
-- One edge, `manages`, between two roles (a role is a profile — the wire still
-- says role). The manager is the one that delegates; the member is a teammate
-- it may spawn. Read from the other end the edge is "reports to". Many-to-many
-- on purpose: one QA profile can be a teammate of several leads, and that reuse
-- is the point.
--
-- A configuration overlay, not the tree that runs. Delegation is flat at run
-- time — a spawned child cannot spawn — so this is the menu a lead may choose
-- from, written down, not a hierarchy the engine walks. A running child still
-- has exactly one parent.
create table role_members (
    manager_id text not null references roles(id) on delete cascade,
    member_id  text not null references roles(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (manager_id, member_id),
    -- A profile is never on its own team; the one cycle cheap enough to refuse
    -- in the schema. Longer loops are caught when an edge is saved.
    constraint role_members_no_self check (manager_id <> member_id)
);

-- The inverse lookup — "who manages this profile" — for the reports-to line.
create index role_members_by_member on role_members (member_id);

comment on table role_members is
  'A profile''s team: the profiles it may delegate to. One manages edge.';

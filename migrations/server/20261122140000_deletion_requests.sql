-- An agent may ask for a deletion. It may not perform one.
--
-- `delete_team` and `delete_profile` were asked for as MCP tools, with the
-- condition that an agent can never carry one out on its own. This is that
-- condition, written where it cannot be argued away: **there is no tool that
-- deletes.** `request_deletion` writes a row here and stops. The delete
-- happens in `POST /deletion-requests/{id}/approve`, which is reachable only
-- by a signed-in person — an agent's single door to the control plane is
-- `delegate.rs`'s tool list, and approving is not on it.
--
-- It is the same asymmetry `propose_schedule` already has, for the same
-- reason: an agent may write a thing down, and a person turns it on.
--
-- ## Why a table rather than a prompt
--
-- The obvious cheaper design is to let the tool ask through the session's own
-- approval socket and delete if the answer is yes. Three things are wrong
-- with it. The question would be answered in a chat, where the blast radius
-- is a sentence rather than the screen that owns the object. It would expire
-- with the session, so an agent that asked at 2am and was never answered
-- would have to ask again. And the decision would leave no trace, which for
-- an irreversible act is the one thing worth keeping.
--
-- ## What is denormalised, and why
--
-- `target_name` and `consequence` are written at ask time so the list reads
-- without a join per row and still says something sensible if the object is
-- renamed between the ask and the answer. Neither is trusted: `approve`
-- re-reads the object and re-computes what it takes, because the tree may
-- have grown a branch since — and the row is a record of what was asked, not
-- a capability to delete whatever that id now points at.

create table deletion_requests (
    id            text primary key,
    org_id        text not null references organizations(id) on delete cascade,

    -- Which kind of thing. The two the tool offers; a third needs a migration
    -- and a look at what its delete does, which is the point of the check.
    kind          text not null check (kind in ('agentTeam', 'role')),
    -- **No foreign key, deliberately.** A cascade here would silently drop
    -- the record of a request when the thing was deleted some other way, and
    -- that record is the audit trail. A request whose target is gone is
    -- answered by `approve` finding nothing and saying so.
    target_id     text not null,
    target_name   text not null,
    -- What it takes with it, as the person deciding should read it.
    consequence   text not null,
    -- Why the agent says it should go. Its own words, shown as such.
    reason        text,

    -- Who asked. A session's owner, because that is the person whose grants
    -- the request was made under — and the session itself, so the decision
    -- can be read back to the conversation that wanted it.
    asked_by      text not null references principals(id),
    asked_session text references sessions(id) on delete set null,
    asked_at      timestamptz not null default now(),

    state         text not null default 'pending'
                  check (state in ('pending', 'done', 'refused')),
    -- Only ever a user: the column's reference says so, and it is the
    -- shortest statement of the whole feature.
    decided_by    text references users(id),
    decided_at    timestamptz,
    -- What the person said when they refused, carried back to the agent.
    note          text,

    constraint deletion_requests_decided_together check (
        (state = 'pending' and decided_by is null and decided_at is null)
        or (state <> 'pending' and decided_at is not null)
    )
);

-- One open question per thing. An agent that asks twice is told about the
-- request already waiting rather than stacking a second one up.
create unique index deletion_requests_one_pending
    on deletion_requests (kind, target_id)
    where state = 'pending';

-- The list a person reads: their org's, newest first.
create index deletion_requests_by_org on deletion_requests (org_id, asked_at desc);

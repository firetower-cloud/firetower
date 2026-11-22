-- What a connector's authorization server told us, and who we registered as.
--
-- **Per connector, not per person.** A client registration identifies
-- *Firetower* to that server; the person is identified by the token the flow
-- then mints for them. So this is discovered once and reused by everybody,
-- and the credential it produces is in the vault at
-- `connector/<skill id>/<owner>` where only its owner can reach it.
--
-- Discovery is cached here rather than re-walked on every connect: it is three
-- round trips to somebody else's server — `401` for the pointer, then the
-- protected-resource document, then the authorization-server document — and a
-- person pressing Connect should not wait for all of it twice.
create table connector_clients (
    skill_id      text primary key references skills(id) on delete cascade,
    -- RFC 9728 §3: what the resource calls itself. Sent back as the `resource`
    -- parameter on the authorize and token requests, which is what binds the
    -- token to this one server and makes it useless at another.
    resource      text not null,
    authorize_url text not null,
    token_url     text not null,
    -- RFC 7591. Absent for a server that registers no clients dynamically —
    -- GitHub is the one that matters, and it is also the one Firetower already
    -- has an application for, so it never reaches this table.
    register_url  text,
    -- What dynamic registration gave back. The secret is a vault key, never
    -- the secret: `connector-client/<skill id>` with no owner, because this
    -- one is the installation's rather than a person's.
    client_id     text,
    has_secret    boolean not null default false,
    -- What the resource says it wants, space separated. Narrower than asking
    -- for everything: a server that publishes its scopes is telling you which
    -- ones it will honour.
    scopes        text,
    discovered_at timestamptz not null default now()
);

-- An authorization that has left for a browser and not come back.
--
-- **The verifier is the point.** PKCE only protects anything if the verifier
-- never leaves the party that made it, so it is written here and handed to
-- nobody — the browser carries the *challenge*, and the code is worthless to
-- an interceptor without the other half.
--
-- A row rather than a map in memory: the control plane restarts, and somebody
-- mid-authorization should get a refusal they can act on rather than a
-- callback that silently matches nothing.
create table connector_pending (
    state    text primary key,
    skill_id text not null references skills(id) on delete cascade,
    owner    text not null references principals(id) on delete cascade,
    verifier text not null,
    at       timestamptz not null default now()
);

create index connector_pending_by_age on connector_pending (at);

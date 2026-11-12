-- Connectors: remote MCP servers an agent can reach while it is running.
--
-- A connector is an address plus the credential that opens it, presented as one
-- thing somebody turns on. There is no per-product integration to write, which
-- is why this is four small tables and not a subsystem: Slack is
-- `https://mcp.slack.com/mcp`, Canva is `https://mcp.canva.com/mcp`, and a
-- server somebody runs themselves is whatever they typed.
--
-- Three things are worth reading before changing any of this.
--
-- **The credential is not here.** It is in the vault, under scope `connector`,
-- keyed by the connector's slug and by *the person whose grant it is* — so two
-- people each sign in to one connector as themselves, and nobody spends a
-- colleague's. No column in this file holds a token, and no route returns one.
--
-- **A connector is personal in v1.** It has a path, because everything Placed
-- does, but there is no sharing in this build and nothing files one into a
-- directory yet. `owner_id` is who may see and change it. When sharing arrives
-- it is `filed_where` like every other kind and this table does not change.
--
-- **The tool list is a measurement, not configuration.** `connector_tools` is
-- what the server said when it was last asked, hashed per tool, and
-- `connector_drift` is every time an answer stopped matching. Nothing in the
-- product lets somebody edit either: a tool list you can edit is a tool list
-- that disagrees with the server.

-- ── the resource ──────────────────────────────────────────────────────

create table connectors (
    id              text primary key,
    org_id          text not null references organizations(id) on delete cascade,
    -- Placed: `u.<person>.connector.<slug>`. Never built by hand;
    -- `ft_core::ResourcePath` is the only thing that writes one.
    path            ltree not null,
    created_by      text references principals(id) on delete set null,
    -- Whose it is. Separate from `created_by`, which a transfer would leave
    -- behind — and it is this column, never directory membership, that decides
    -- whose credential a session resolves.
    owner_id        text not null references principals(id) on delete cascade,
    extra_perms     jsonb not null default '{}',

    -- What a person calls it.
    name            text not null,
    -- **What the agent calls it**, and so half of every permission rule:
    -- `mcp__<slug>__<tool>`. One label, no separators — checked in Rust before
    -- it is written, and again on the worker, because a slug carrying `__`
    -- would forge a rule about a different server.
    slug            text not null,
    -- The one line that is in the model's context on every turn. It is what
    -- tells an agent when to reach for this rather than something else, which
    -- is why the form asks for it and why it is editable afterwards.
    description     text not null default '',
    url             text not null,
    -- 'http' (Streamable HTTP) or 'sse' (the 2024-11-05 transport). Whichever
    -- answered the probe, written into the agent's configuration as it spells
    -- it — an agent handed the wrong one fails at connect.
    transport       text not null default 'http',

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create unique index connectors_by_path on connectors (path);
create index connectors_path_tree on connectors using gist (path);
-- **Per owner, not per installation.** The slug is what the agent calls the
-- server, so it is worth keeping readable — `slack`, not `slack_1a2b3c4d`. Two
-- people may each have one called `slack`, and they never share a session's
-- configuration: a session resolves its connectors by its own owner.
create unique index connectors_slug on connectors (owner_id, slug);
create index connectors_by_owner on connectors (owner_id);

comment on table connectors is
    'A remote MCP server an agent can reach. The credential is in the vault, '
    'under scope `connector` and the slug, owned by the person who signed in.';

-- ── what the server said, last time anybody asked ─────────────────────
--
-- One row per connector, replaced on each probe. The history that matters is
-- `connector_drift` below; this is the current answer, and a screen reads it
-- rather than probing on every render.

create table connector_probes (
    connector_id     text primary key references connectors(id) on delete cascade,
    at               timestamptz not null default now(),
    -- The version the server chose, beside the one Firetower asked for. Both,
    -- because a mismatch is shown rather than swallowed and a reader needs to
    -- see which side wanted what.
    protocol_version text,
    asked_for        text,
    server_name      text,
    server_version   text,
    -- Declared `capabilities`, verbatim and **uninterpreted**. Which agent can
    -- do what with `sampling`, `resources/` or `prompts/` is a matrix that
    -- would be wrong within two releases of anything, so this is a probe
    -- rather than a document somebody has to keep true.
    capabilities     jsonb not null default '{}',
    -- 'tools' | 'scopes' | 'silent' — which of the three states the detail
    -- view is in. See `connectors::mcp::Shape`.
    shape            text not null default 'silent',
    -- How it is signed in to, as the probe worked out: 'none' (it answered
    -- without a credential), 'oauth' (it refused and published metadata), or
    -- 'token' (it refused and published nothing, so a pasted token is the only
    -- way in). Derived from the answer rather than chosen by anybody.
    sign_in          text not null default 'token',
    -- The real scope list, as the server published it, unauthenticated. Kept
    -- so a library row can say how many without a round trip; the sign-in
    -- screen re-reads it live, because that is the one place being out of
    -- date would matter.
    scopes           jsonb not null default '[]',
    -- Where they came from, for the sentence that says so.
    authority        text,
    -- Client capabilities the server declared a need for that no agent offers.
    -- `sampling` is the live case. Best effort: the specification gives a
    -- server no way to announce this, so the honest claim is "where we can
    -- tell", never "we checked".
    unmet            jsonb not null default '[]',
    -- Why the last probe produced nothing, if that is what happened. A
    -- connector with trouble is still a row: it was reachable once.
    trouble          text
);

-- ── the tool list, hashed per tool ────────────────────────────────────

create table connector_tools (
    connector_id text not null references connectors(id) on delete cascade,
    name         text not null,
    -- sha256 over the tool's **whole** definition — name, description and
    -- schema, canonicalised so key order is not a change. A hash over the name
    -- alone would never notice a server rewriting what a tool claims to do,
    -- which is the attack this exists for.
    digest       text not null,
    description  text not null default '',
    -- From the server's own `annotations.readOnlyHint`, defaulting to true:
    -- nothing said means assume it writes.
    writes       boolean not null default true,
    first_seen   timestamptz not null default now(),
    last_seen    timestamptz not null default now(),
    primary key (connector_id, name)
);

-- Every time an answer stopped matching the one before it. Append-only: this
-- is a record of the past, and the point of it is that somebody can read what
-- changed and when.
create table connector_drift (
    id           bigserial primary key,
    connector_id text not null references connectors(id) on delete cascade,
    at           timestamptz not null default now(),
    tool         text not null,
    -- 'changed' | 'added' | 'gone'
    kind         text not null,
    was          text,
    now_is       text
);

create index connector_drift_by_connector on connector_drift (connector_id, at desc);

-- ── the OAuth client, per connector per installation ──────────────────
--
-- Discovered rather than configured: the `401`'s chain gives the endpoints,
-- and RFC 7591 gives a `client_id` where the authorization server will issue
-- one. Per installation and not per person — the client identifies *Firetower*;
-- the grant it obtains is the person's and lives in the vault.
--
-- A client *secret*, where a server insists on a confidential client, is a
-- credential and goes in the vault under the install's own name. Only the fact
-- that there is one is recorded here.

create table connector_clients (
    connector_id           text primary key references connectors(id) on delete cascade,
    issuer                 text not null,
    client_id              text not null,
    has_secret             boolean not null default false,
    authorization_endpoint text not null,
    token_endpoint         text not null,
    -- RFC 8707's canonical identifier for the resource, out of the
    -- protected-resource document. **Not the URL somebody typed**: Slack's
    -- `/mcp` address names `https://mcp.slack.com` without the path, and
    -- sending the typed one is sending the wrong audience.
    resource               text not null,
    -- What was asked for, space separated, as it was asked for.
    scopes                 text not null default '',
    registered_at          timestamptz not null default now()
);

-- ── a browser leg in progress ─────────────────────────────────────────
--
-- `state` is the primary key because it is what comes back, and it is random
-- per attempt. The PKCE verifier lives here rather than in the vault: it is a
-- single-use nonce for one exchange, worthless without the authorization code,
-- and expires in minutes — a vault row with an access-log entry per attempt
-- would say nothing an audit wants to know.

create table connector_authorizations (
    state        text primary key,
    connector_id text not null references connectors(id) on delete cascade,
    -- Whose attempt. The grant lands under this person and nobody else, which
    -- is what stops a callback arriving for somebody it was not started by.
    user_id      text not null references principals(id) on delete cascade,
    verifier     text not null,
    redirect_uri text not null,
    resource     text not null,
    scopes       text not null default '',
    started_at   timestamptz not null default now(),
    expires_at   timestamptz not null
);

create index connector_authorizations_by_connector
    on connector_authorizations (connector_id, user_id);
create index connector_authorizations_expiry on connector_authorizations (expires_at);

-- ── what a session is actually running ────────────────────────────────
--
-- Pinned per session, like a skill. Unlike a skill it does not take effect
-- until the agent is started again: an agent reads its MCP configuration and
-- its permission rules once, when it launches.

create table connector_pins (
    session_id   text not null references sessions(id) on delete cascade,
    connector_id text not null references connectors(id) on delete cascade,
    added_by     text references principals(id) on delete set null,
    at           timestamptz not null default now(),
    primary key (session_id, connector_id)
);

create index connector_pins_by_connector on connector_pins (connector_id);

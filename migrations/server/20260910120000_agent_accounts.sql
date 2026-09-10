-- Keep legacy vault names: ciphertext is authenticated against its name and owner.
create table agent_accounts (
    id text primary key,
    user_id text not null references users(id) on delete cascade,
    kind text not null,
    name text not null check (length(trim(name)) between 1 and 80),
    mode text not null,
    credential_key text not null,
    is_default boolean not null default false,
    enabled boolean not null default true,
    state text not null default 'connected',
    identity text,
    revision bigint not null default 0,
    fingerprint text,
    created_at timestamptz not null default now(),
    unique(user_id, kind, name),
    unique(user_id, kind, fingerprint)
);
create unique index agent_accounts_default on agent_accounts(user_id, kind) where is_default;
insert into agent_accounts(id, user_id, kind, name, mode, credential_key, is_default, enabled)
select 'legacy:' || user_id || ':' || kind, user_id, kind, 'Default account', mode, kind, true, enabled
from agents where mode != 'NotNeeded';

alter table sessions add column agent_account_id text references agent_accounts(id);
update sessions s set agent_account_id = a.id
from agent_accounts a where a.user_id = s.user_id and a.kind = s.agent;

-- Pin on insertion, including callers which predate named accounts. NULL preserves
-- host-local authentication for sessions that never had a portable credential.
create function pin_agent_account() returns trigger language plpgsql as $$
begin
    if new.agent_account_id is null then
        select id into new.agent_account_id from agent_accounts
        where user_id = new.user_id and kind = new.agent and is_default and enabled and state = 'connected';
    end if;
    return new;
end $$;
create trigger pin_agent_account before insert on sessions for each row execute function pin_agent_account();

create table agent_account_switches (
    id bigserial primary key,
    session_id text not null references sessions(id) on delete cascade,
    from_account_id text references agent_accounts(id),
    to_account_id text not null references agent_accounts(id),
    next_session_id text references sessions(id),
    after_line bigint not null,
    state text not null default 'switching',
    detail text,
    created_at timestamptz not null default now()
);
create unique index one_account_switch_at_a_time on agent_account_switches(session_id) where state = 'switching';
create table agent_account_limits (
    account_id text not null references agent_accounts(id) on delete cascade,
    scope text not null,
    status text not null,
    resets_at bigint,
    used_percent smallint,
    observed_at timestamptz not null default now(),
    primary key(account_id, scope)
);

create table agent_fallbacks (
    session_id text primary key references sessions(id) on delete cascade,
    account_ids jsonb not null default '[]',
    enabled boolean not null default false,
    updated_at timestamptz not null default now()
);

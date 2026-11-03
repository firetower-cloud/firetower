-- The subscription a profile runs its agent on.
--
-- A profile pins its whole shape — placement, machine, engine — and this is the
-- last piece: which account the engine authenticates with. Null is the open
-- default (the owner's default subscription for that engine, resolved at
-- launch), which is what an agent-authored profile gets, since it cannot see
-- account ids. `set null`, not `cascade`: removing a subscription must not take
-- the profiles that named it — they fall back to the owner's default.
alter table roles
    add column agent_account_id text references agent_accounts(id) on delete set null;

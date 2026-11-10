-- What may happen to a child that runs out of allowance, and who may do it.
--
-- A child dying on a usage limit waits for a person today, even when the lead
-- that started it is alive beside it with its own allowance and is told what
-- happened. These two columns are what turn that into something the lead may
-- act on — and they are two rather than one because the grant and the use of
-- the grant belong to different profiles:
--
-- `on_usage_limit` is the **child's** profile saying how much latitude a lead
-- has over it. Three graded rungs, not two: a ladder, where each rung is
-- strictly more than the last. `wait` is what every profile does today.
--
-- `on_child_limit` is the **Manager's** own profile saying whether it uses
-- that latitude on its own or stops and asks the person which subscription to
-- spend. Meaningless unless `can_delegate`, and left alone rather than made
-- conditional: a profile that stops being a Manager and becomes one again
-- should not silently lose the answer somebody gave.
--
-- **Both default to today's behaviour, and that is the whole migration.**
-- `wait` is a child nobody may move, `ask` is a Manager that stops and asks.
-- Composed, an existing pair of profiles behaves exactly as it does now, so
-- there is no backfill and no row to inspect. The check constraints are the
-- same belt-and-braces `roles.rs::check` wears: the validator is what a person
-- gets a sentence from, and this is what keeps a direct write honest.
alter table roles
    add column on_usage_limit text not null default 'wait'
        constraint roles_on_usage_limit check (on_usage_limit in ('wait', 'same', 'engine')),
    add column on_child_limit text not null default 'ask'
        constraint roles_on_child_limit check (on_child_limit in ('ask', 'reroute'));

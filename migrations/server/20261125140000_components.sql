-- Turning off one piece of a bundle.
--
-- **The library stopped listing bundles.** It lists the things inside them —
-- each skill, each server — because a server that publishes its own skills
-- has no folder to belong to, and a model built on folders has nowhere to put
-- it. So the switch somebody presses is on a component, and this is where a
-- component that is switched off is written down.
--
-- Per person, because the switch has always been personal: it decides what
-- *your* plain agent opens with. A colleague's answer is their own.
--
-- Absent means on. Only the exceptions are stored, so a bundle that arrives
-- with eight skills costs eight rows only if somebody turns all eight off.
create table component_off (
    skill_id  text not null references skills (id) on delete cascade,
    person_id text not null references users (id) on delete cascade,
    -- The file that *is* the component: `skills/<name>/SKILL.md` for a skill,
    -- `.mcp.json` for the server a bundle declares.
    path      text not null,
    at        timestamptz not null default now(),
    primary key (skill_id, person_id, path)
);

create index component_off_by_person on component_off (person_id);

-- What a server said its tools were, the last time somebody asked it.
--
-- **Only ever read from an authorized connection.** Measured on Linear, Notion
-- and Figma: `tools/list` is refused without a token, so there is nothing to
-- show before somebody connects and nothing worth guessing. Cached because the
-- answer is stable between releases and a detail screen must not wait on a
-- round trip to somebody else's server.
create table connector_tools (
    skill_id    text primary key references skills (id) on delete cascade,
    tools       jsonb not null,
    counted     int not null default 0,
    fetched_at  timestamptz not null default now()
);

-- What somebody chose for a session, for the agent that is not told.
--
-- Codex takes its model, effort, approval policy and sandbox as parameters on
-- every turn rather than as anything it can be sent between them, so the choice
-- has to be held somewhere and put on the next turn. It was held in the control
-- plane's memory, beside the reader for that session's lines — and that reader
-- is thrown away and rebuilt whenever the agent process ends. An upgrade, a
-- restart, an account switch, a session picked up after its agent had gone: the
-- new conversation opened on the defaults and every turn after it carried them,
-- while the picker showed what had been asked for.
--
-- A choice is a person's, not a process's, so it lives with the session.
create table session_controls (
    session_id  text not null references sessions(id) on delete cascade,
    kind        text not null,
    value       text not null,
    chosen_at   timestamptz not null default now(),
    primary key (session_id, kind)
);

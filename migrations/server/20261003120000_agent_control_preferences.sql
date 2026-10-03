-- What somebody last chose about an agent, so the next session starts there.
--
-- Per person and per agent, not per session: the point is that a new session
-- opens on the settings you were already working with. `session_controls` is
-- the other half and stays — it is what one *session* is running, and it is
-- what a rebuilt reader replays.
--
-- No model in the key. Codex's effort list is a property of its model, so a
-- remembered effort can stop being offered when the model moves; that is
-- handled by checking the value against what the agent now lists rather than
-- by keeping a row per model, which would strand preferences on every rename.
create table agent_control_preferences (
    user_id   text not null references users(id) on delete cascade,
    agent     text not null,
    kind      text not null,
    value     text not null,
    chosen_at timestamptz not null default now(),
    primary key (user_id, agent, kind)
);

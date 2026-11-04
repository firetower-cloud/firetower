-- How a profile runs its agent: the controls, pinned alongside the engine.
--
-- A profile already fixes its agent; these fix the rest of the run — the model,
-- the reasoning effort, the permission mode, the sandbox. Each is nullable and
-- per-engine: a null falls back to that engine's default at launch, exactly as
-- a session with nothing remembered does, so a profile need not over-specify.
-- Stored as four columns rather than one jsonb to match how `Preferred` is read
-- everywhere else — a column per `ControlKind`.
alter table roles
    add column pref_model   text,
    add column pref_effort  text,
    add column pref_mode    text,
    add column pref_sandbox text;

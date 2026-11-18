-- Clear a pinned setting the profile's own engine does not offer.
--
-- `POST /roles` never checked `settings` against the engine beside it, so a
-- profile could be saved with `pref_model = 'opus'` while pinned to Claude
-- Code, whose models are `opus[1m]` and four others. `roles::check` refuses
-- that now (#396). This is the rows that were written before it did.
--
-- **It changes no behaviour, and that is the argument for it.** A value the
-- engine does not offer is already discarded at launch —
-- `controls::Preferred::keeping_only` drops a remembered value the agent no
-- longer lists, without a word — so these columns have never been in force on
-- any run. What they did instead was make the row dishonest: the editor drew a
-- model nothing was using, and `#354`'s export wrote it into a `PROFILE.md`
-- that the import plan then blocked, so Firetower's own export of a profile
-- Firetower accepted would not round-trip. Clearing them makes the stored data
-- say what actually happens, which is "the engine's default".
--
-- **Only where the offer set is knowable here, which is three of the eight
-- pairs.** Two cases are deliberately left alone, and they are the same two
-- the write path and the import plan leave alone:
--
--   * **The engine lists its own.** Codex reports its models and efforts over
--     its protocol (`controls::for_agent` takes them as arguments "because one
--     agent knows its own and the other does not"), so no value here can be
--     judged wrong. `pref_model` and `pref_effort` on a Codex profile stay.
--   * **The engine has no such control.** `pref_sandbox` on a Claude Code
--     profile is a legal value of a column shared across every engine, with no
--     meaning for that one. Nothing about the row is wrong, and clearing it
--     would discard an answer somebody gave in case they later pin an engine
--     that does have a sandbox.
--
-- A profile with `agent is null` is left alone for the same reason the write
-- path accepts anything there: which set applies is not decided until a lead
-- picks an engine.
--
-- **The lists below are a snapshot, deliberately.** They are
-- `controls::claude_models`, `claude_modes`, `claude_efforts`, `codex_modes`
-- and `codex_fences` as of this migration, and they will drift: a model
-- retired next spring stays in this file. That is right for a data migration —
-- it describes the rows it found on the day it ran, and the Rust tables are
-- what keep every later write honest. The alternative is a migration that
-- reads the binary, which nothing here can do.
update roles set pref_model = null
 where agent = 'ClaudeCode'
   and pref_model is not null
   and pref_model not in ('opus[1m]', 'fable[1m]', 'sonnet[1m]', 'haiku', 'opusplan');

update roles set pref_mode = null
 where agent = 'ClaudeCode'
   and pref_mode is not null
   and pref_mode not in ('auto', 'default', 'plan', 'acceptEdits', 'dontAsk');

update roles set pref_effort = null
 where agent = 'ClaudeCode'
   and pref_effort is not null
   and pref_effort not in ('low', 'medium', 'high', 'xhigh', 'max');

update roles set pref_mode = null
 where agent = 'Codex'
   and pref_mode is not null
   and pref_mode not in ('auto', 'on-request', 'untrusted', 'never');

update roles set pref_sandbox = null
 where agent = 'Codex'
   and pref_sandbox is not null
   and pref_sandbox not in ('workspace+network', 'workspace', 'everything');

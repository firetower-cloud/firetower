-- Who last deliberately named a workspace, so the agent can name it once.
--
-- `workspaces.name` is what the rail labels a workspace with, and until now
-- every client seeded it with the first line of the prompt cut to 80
-- characters. That works when somebody opens with a title and fails when they
-- open with a paragraph, which is the ordinary case: a rail of sentence
-- fragments, each beginning mid-thought, several of them sharing an opening
-- clause. The agent knows what the work actually is by the end of its first
-- turn and had no way to say so.
--
-- It does now — `rename_workspace`, which it is told to call once — and these
-- two columns are what make "once" and "never over a person's name" true
-- without the agent having to remember anything. The server reads
-- `name_set_by` before it writes: null means nobody has deliberately named
-- this place and the agent may claim it; anything else means it may not, ever
-- again. Nothing here constrains a *person*: the rename endpoint stamps
-- `'human'` without reading the column first, and is never blocked, however
-- many times they use it.
--
-- **Both nullable, and no backfill.** Null is not a gap here, it is the
-- correct answer for every row that exists today and for every workspace whose
-- name was derived from a prompt rather than chosen: a derived name is not a
-- choice, and treating it as one would block the agent on every workspace.
-- The consequence is deliberate — an agent resuming a workspace from before
-- this migration may name it on its next first turn, which is the behaviour
-- somebody would ask for if it did not happen on its own.
--
-- **Still one writable copy of the name.** `20260829090000_workspace_names`
-- moved `name` off the session and onto the workspace with the reason written
-- out — *one writable copy, two is how the rail and the header come to
-- disagree* — and that reasoning holds for the agent's write as well. These
-- are columns *about* that one name, not a second copy of it; nothing here
-- touches `sessions.title`, which answers a different question.

alter table workspaces add column name_set_at timestamptz;

-- `'agent'` or `'human'`. Text rather than an enum: two values read in one
-- predicate do not need a type of their own, and the check is what stops a
-- third appearing by accident — which, for a column whose whole job is to be
-- compared against those two spellings, is the failure worth closing.
alter table workspaces add column name_set_by text
    check (name_set_by in ('agent', 'human'));

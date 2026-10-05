# Skills

Scoping. What a skill is, where each agent reads one from, what it costs, what
breaks, and the seven decisions that need an answer before anybody writes code.

Everything in §2–§4 was checked against the installed CLIs — Claude Code
2.1.273, Codex 0.156.1, Kimi Code 2.1.1 — and against the real published
libraries. Where something is *not* verified, it says so.

---

## 1. What a skill is

A folder. `SKILL.md` is required and the name is case-sensitive; `scripts/`,
`references/` and `assets/` are optional. No `README.md` inside. The folder
name is kebab-case and matches the `name` in the frontmatter.

Three levels of loading, and the whole design follows from it:

| Level | When it is in context | Cost |
| --- | --- | --- |
| frontmatter | always | every turn, every session |
| `SKILL.md` body | when the agent decides it is relevant | once per invocation |
| `references/`, `scripts/` | when the agent opens one | only if opened |

So the **description** is the expensive field and the one that decides whether a
skill ever fires. Everything else is free until it is needed.

### Frontmatter

Portable across all three agents: `name`, `description`, `license`,
`compatibility`, `metadata`, `allowed-tools`. Everything else belongs to one
agent — Claude Code has a dozen more (`when_to_use`, `arguments`, `model`,
`hooks`, `context: fork`, …), Codex reads `agents/openai.yaml`, Kimi has
`type: flow`.

**Firetower stores the folder verbatim and interprets six fields.** Anything
agent-specific is preserved byte for byte and labelled in the interface as
belonging to one agent. A skill that silently loses its `hooks` on the way to
Codex is worse than one that says it will.

Versions live in `metadata.version` — there is no top-level `version` in the
standard. Firetower's own version is an integer in the database, stamped into
the file on the way out.

### Validation, on import

Errors:

- `SKILL.md` present, exactly that spelling.
- Folder kebab-case, matching `name`. 1–64 chars, `[a-z0-9-]`, no leading or
  trailing hyphen.
- `description` present, under 1024 characters, says **what** and **when**.
- No `<` or `>` anywhere in the frontmatter. It goes into the system prompt;
  angle brackets are an injection route and Anthropic forbids them outright.
- No `claude` or `anthropic` in the name — reserved.

Warnings, never refusals:

- `README.md` inside the folder.
- Body over 5,000 words. Anthropic's own `claude-api` is 603 lines, so this is
  guidance and cannot be a gate.
- Unknown frontmatter — say which agent reads it.
- Name collides with a skill you can already reach, or with one the agent ships
  (`/code-review`, `/doctor`, `imagegen`, `plan`, `skill-creator`).
- The risk scan: `` !`cmd` ``, `allowed-tools`, `hooks`, `scripts/`. See §8.

---

## 2. Where each agent reads one from

One shape for all three: **a directory of skill bundles belonging to one
session.** Two of them already have a per-session home for exactly this reason.

| Agent | Per-session root | How | Verified |
| --- | --- | --- | --- |
| Claude Code 2.1.273 | `<root>/.claude/skills/<name>/` | `--add-dir <root>` | Yes. The `init` frame listed it. Symlinked bundles load. |
| Codex 0.156.1 | `$CODEX_HOME/skills/<name>/` | already per session | Yes. `skills/list` returns `scope: "user"`. |
| Kimi Code 2.1.1 | `$KIMI_CODE_HOME/skills/<name>/` | already per session | No. Read out of the binary; `session/new` needs an account. |

One capability method on `Agent`, beside `home_var`. Never a `kind ===
"ClaudeCode"` in a client.

**Not project scope.** One workspace holds several sessions with different
agents and different selections; project scope is shared by all of them. Kimi
resolves its project root by walking up for `.git`, which in a workspace finds
nothing — or finds the wrong thing. And when `RepoSpec.path` is empty, a
project directory lands inside the git worktree and turns up in the pull
request.

**Not `CLAUDE_CONFIG_DIR`.** It works, but it hides the host's own `~/.claude`
— their settings, their skills, their plugins. Keep it as the fallback.

### Toggling mid-conversation

Verified on Codex: creating or deleting a directory under the skills root while
the app-server runs fires `skills/changed`, and the next `skills/list` reflects
it. The watcher only starts after `thread/start`.

`[[skills.config]] enabled = false` works but is read at startup, so the toggle
is the directory, not the config.

Claude Code documents live change detection, with `/reload-skills` only for a
*new* top-level directory — so **create the per-session root at launch even
when nothing is selected**. Unverified; it is the likeliest thing to break.

---

## 3. The budget — the limit that shapes the product

Descriptions are rendered into the system prompt, and every agent bounds it.
Codex's failure is silent and total: past the budget it truncates descriptions,
and past that it removes **every** skill rather than the last one.

Anthropic's own guidance says to reconsider past **20–50 enabled**. Codex's
default budget is about 8,000 characters, which at realistic sizes is **25–30
skills**.

So: hundreds is a *library* size, never a *selection* size.

- A budget meter per agent in the picker — the three budgets differ.
- The server refuses an oversized selection with the numbers, rather than
  starting a session that silently has nothing.
- `skills.max_context_tokens` raises Codex's. **Generate** that `config.toml`,
  never append — `skills.bundled = true` is not a valid key and one bad line
  makes Codex fail to load config at all and return an empty skill list.

And the invisible cost: changing the selection mid-session changes the prompt
prefix and **invalidates the provider's cache**, so the next turn re-bills the
whole conversation. Apply as a batch, and say *takes effect on your next
message* where somebody reads it.

---

## 4. Size, measured

OpenAI's published skills are small. Anthropic's are not.

| skill | bytes | files | `SKILL.md` |
| --- | --- | --- | --- |
| `canvas-design` | 5.55 MB | 83 | 12 KB |
| `claude-api` | 1.86 MB | 81 | 102 KB / 603 lines |
| `pptx` / `docx` / `xlsx` | ~1.1 MB each | 53–61 | 7–21 KB |
| `skill-creator` | 225 KB | 18 | 33 KB |
| OpenAI's largest (`imagegen`) | 127 KB | 12 | 19 KB |

`canvas-design` is 54 TrueType fonts. `docx`, `pptx` and `xlsx` each ship the
same 650 KB of OOXML schemas — three identical copies.

**Caps:** 100 files, 256 KB body, 2 MB a file, 25 MB a version. Taken from that
sample rather than from a guess; an earlier draft said 50 files and 64 KB and
would have refused five of Anthropic's six largest skills.

**Postgres is fine.** Loaded into PG16, the entire `anthropics/skills` repo —
430 files, 11 MB logical — costs **5.9 MB** with default TOAST compression
(`.xsd` compresses to 15%, markdown 51%, fonts 69%). A `bytea` value tops out
at 1 GB; 2 MB is 0.2% of that.

**But dedup is worth building.** Content-addressed, that same library is 8.9 MB
instead of 11 MB — 20% on one import, before any versioning. And versioning is
where it matters: re-dropping `canvas-design` to change one line would
otherwise re-store 5.3 MB of unchanged fonts.

So: `blobs(hash, bytes)` + `skill_files(version_id, path, hash, executable)`.
Dedup, atomic versions, and `pg_dump` is still the whole backup. Moving to a
filesystem or S3 backend later changes what `blobs` holds, not the schema.

---

## 5. Storage

```sql
-- Placed. Every rule in paths-and-ownership.md §2 applies.
skills (id, org_id, path ltree, created_by, extra_perms jsonb,
        name, slug, current_version_id, archived_at)

-- Recorded. Append-only.
skill_versions (id, skill_id, version int, label, frontmatter jsonb,
                body, notes, created_by, created_at)

-- Content-addressed, shared across versions and skills.
blobs       (hash primary key, bytes bytea, size, refs)
skill_files (version_id, path, hash, executable)

-- Which version a session is holding. §6.
skill_pins  (session_id, skill_id, version_id, added_by, at, removed_at)

-- Defaults. §7.
skill_defaults (repo_id, skill_id, added_by, at)
skill_policies (org_id, repo_slug, skill_id, strength, set_by, at)
```

---

## 6. Versions

**Amend** rewrites what is there, so every session using it reads the new text
on its next turn. Right for a typo. Allowed only while nobody else has pinned
it — or you own the skill and accept a warning that counts the sessions.

**New version** moves `current_version_id`; existing pins do not move.

"Every new user takes the new version" means **whoever starts next**.
`permissions.md` §6 already settled it: you can hand over a place, you cannot
hand over a conversation. `skill_pins` is what makes that true rather than
aspirational.

---

## 7. How a skill gets selected

Three layers, ordered by how little new authority each needs.

**The repository's own skills.** Teams already commit skills to their repo, and
**Firetower currently breaks this**: with checkouts in subdirectories and the
agent's cwd at the workspace root, neither Codex nor Claude Code sees
`<checkout>/.claude/skills`, `.codex/skills` or `.agents/skills`. Verified —
both listed zero. Aggregating them into the session's skills root is a bug fix
that hands you org-level enforcement for free, under a model everybody already
understands: whoever can merge to `main` decides.

**Personal defaults per repository.** `skill_defaults(repo_id, skill_id)`.
Select repo A and repo B and get the union, pre-ticked and removable. The
attribution hangs off the repository, and since `repos` is already one row per
person per remote, your defaults are yours for free.

**An organisation policy**, for what the repository cannot carry — a house
style across twelve repos, or something that should not be public in an
open-source repo. Anthropic ships the equivalent, so this is expected rather
than exotic.

The key move: key it on the **remote**, not on the `repos` row. The row is
personal because the token is; `acme/backend` is what everybody shares. An
admin then never reads or writes anybody's personal row. Two rules keep it
honest:

- A policy may only name a skill the **`everyone` team can already reach**,
  or it becomes a side-channel into a directory somebody holds no grant on.
  Checkable at save: *share this skill with everyone first.*
- Policies are per agent. A Claude-only skill is not defaulted into Codex.

Three strengths — *suggested*, *on by default*, *required*. **Ship only "on by
default".** Required plus Codex's budget cliff is a footgun: three admins
requiring four skills each blows the budget, and Codex's answer is to drop
every description rather than the last four.

Resolution order when over budget: repository → policy → personal, and the
picker **says** what was dropped.

---

## 8. A skill is executable

**Selecting a colleague's skill runs their code on your worker, under your
credentials.**

A Claude Code body can contain `` !`command` ``, which runs before the model
sees the skill. `allowed-tools` pre-approves tools — the guide's own example is
`Bash(python:*) Bash(npm:*) WebFetch` — which bypasses exactly the approval
prompts Firetower routes to a person. `hooks` registers for the session.
`scripts/` is code. A policy (§7) makes all of that automatic for everybody.

Four mitigations, in order of what they buy:

1. **Show what it does.** Badges earned by parsing, on the row: *runs shell
   commands*, *pre-approves tools*, *registers hooks*, *ships scripts*.
2. **Strip by policy.** Refuse `hooks` and `` !`cmd` `` in skills not filed in
   your own space. One installation setting, default on.
3. **Pin the version** so a shared skill cannot change under a running session.
4. **Say who wrote it and when it changed**, on the row.

---

## 9. Scripts, and what is actually ours

**Firetower never runs a skill's script.** The agent does, through its own Bash
tool, under its own sandbox and the approval prompts we already route to a
person. A script is no different from any other command an agent decides to
run.

So the environment is the host's business, the same as it is today. Three
things are ours, and only three:

**The executable bit.** We write the files, so if `scripts/run.sh` lands
without `+x` it fails in a way nobody can debug. A **zip carries the unix
mode**; a dropped folder does not — `dragDropEnabled` is off, so we get HTML5
drag-and-drop rather than OS paths, and a `File` has no POSIX mode. Infer from
a `#!` shebang or a `scripts/` prefix, and show it as a toggle in the file list
so it is visible rather than magic.

**`compatibility`, surfaced before the choice.** It is the standard's field for
"needs python 3.11 and network access", and nothing reads it today. Firetower
knows which machine the session is about to run on, so the check belongs in the
picker — *`imagegen` wants python3 and `fire-01` does not have it* — rather
than four turns into a conversation.

**Honesty about dependencies.** Anthropic's skills import `PIL`, `numpy`,
`lxml`, `openpyxl`, `pypdf`, `pdfplumber`, `pdf2image`, `playwright`. Having
python3 is not having those, and on Debian 12 or Ubuntu 23.04+ a plain
`pip install` is refused outright (PEP 668, `externally-managed-environment`)
unless it is in a virtualenv. A repository that needs them should install them
in its **setup script**, which is the place where "this workspace needs things"
is already expressed and already reviewed.

Worth knowing but not a blocker: the control plane's own container has no
Python, and its Dockerfile notes that `firetower serve` runs that machine's
worker itself. That is the first-run convenience path, not where real work
happens — a VM or a Mac mini has python3.

## 10. How a skill gets into the library

Nobody writes these by hand, and Anthropic's own answer is `skill-creator` — an
agent writes it. So:

**Drop a folder, or a zip.** `desktop/src/ui/drop.ts` refuses folders today, on
purpose; making them work means recursing `webkitGetAsEntry`, which that file
already identifies as the only API that knows. The same code works in a
browser. **Dropping a folder loses the executable bit** — `dragDropEnabled` is
off so we get HTML5 drag-and-drop, not OS paths, and a `File` has no POSIX
mode. A **zip carries the unix mode**, and zip is also the distribution format
the guide tells people to use. For folder drops, infer from a `#!` shebang or a
`scripts/` prefix and show it as a toggle in the file list.

**Expect a folder of folders.** What is on somebody's disk is
`~/.claude/skills/`, not one skill. Detect *N* subdirectories each with a
`SKILL.md` and import them together, with a review list.

**Publish from a workspace.** A session that produced `.claude/skills/foo`
should have *Publish to library* in the Files tab. No upload, no browser API —
the bytes are already on a worker. This is the one acquisition path nobody else
has, and it closes the loop: ask an agent to write a skill, then share it.

**Re-dropping is how a version is made.** That makes versioning a diff between
two drops and removes the need for an editor.

**No editor, but two editable fields**: `name`, because collisions have to be
fixable, and `description`, because it is the only thing in the model's context
and an imported one written for someone else's repo mis-fires. Everything else
read-only.

**Import from a git repo** — `anthropics/skills`, `openai/skills`, your own —
needs a credential and a clone on a worker. Just after v1, but the schema
should not make it hard.

---

### Sharing several at once

Sharing a skill is filing it into a directory. A directory holds one skill of
each name, so `POST /directories/{id}/skills` checks every skill before moving
any, and each name the directory already has needs a decision:

- **Identical:** drop this copy and use the directory's. Sessions and defaults
  that held it move to the directory's.
- **Different:** keep this copy where it is, or make it the directory's next
  version.

The list splits into *Skills you manage* (yours, a directory you administer,
or any directory for an organisation admin) and *Shared with you*. Only the
first can be selected.

## 11. The interface

Hundreds available, a handful selected, selection is per session, it changes
mid-conversation, and it costs money invisibly. That rules out a dropdown and
it rules out a separate page.

Prototypes in [`prototypes/skills/`](prototypes/skills/):

- **B — a fourth tab in the right rail**, beside Diff / Files / Commit. The
  home. It stays open while you read the conversation, which is where the
  selection actually gets reconsidered.
- **A — a palette** on `⌘⇧S`. The way in from anywhere.
- **C — a chip in the composer** carrying the count and the budget. The
  indicator. Before the first message it shows the defaults as a *sentence* —
  *4 skills from acme/backend and acme/web* — because that is the one moment
  they get applied without being read.

One component, three mounts. The library screen is the fourth.

### Say what actually happened

Both of the agents we can ask will tell us what they loaded — Claude Code's
`init.skills`, Codex's `skills/list` and `skills/changed`. Report that, not our
own bookkeeping.

Better: report what **fired**. Anthropic's guide names under- and
over-triggering as the two failure modes, and the fix for both is editing the
description. A list of *selected but never used in 12 sessions* is how somebody
prunes a library that is costing them tokens for nothing.

---

## 12. Getting it to the worker

**At launch**: `CreateWorkspace` and `StartAgent` gain `skills`, the same shape
as `agent_home`, `#[serde(default)]` so an old worker ignores it.

**Mid-conversation**: a new frame, `SetSkills { session_id, skills }`, carrying
the **whole selection** rather than a delta. The worker diffs against disk and
answers with what it ended up with. `PROTOCOL_VERSION` 17 → 18.

**Send hashes first.** A 5.5 MB bundle is 7.4 MB of base64 held whole at every
hop, on every session start. The worker caches bundles by hash on its volume,
the control plane asks which it is missing, and materialising into a session is
a link rather than a transfer. Three sessions using `canvas-design` on one
worker cost one copy.

`write_agent_home` sets 0600 in a 0700 directory and does not set an executable
bit. It also writes credentials, so skills get their own writer rather than a
flag on that one.

---

## 13. Six decisions

1. **Repository-committed skills: on by default, or only visible?**
   *Recommend on — the team committed them deliberately — but counted in the
   meter, with a way to turn one off.*
2. **Ship `required` policies?** *Recommend no, not in v1.*
3. **Does a skill survive its author?** Personal ones go with them, directory
   ones stay. That is two outcomes for one kind, which
   `paths-and-ownership.md` §3 does not currently allow. *Recommend the split,
   written down.*
4. **A personal "always on", on top of repository defaults?** *Recommend yes —
   repository defaults only help somebody who works in one repository.*
5. **Strip `hooks` and `` !`cmd` `` from shared skills by default?**
   *Recommend yes, with a setting.*
6. **Content-addressed blobs, or `bytea` per file?** Everything is in Postgres
   either way; the question is only whether a file's bytes live in the row that
   names it, or once under their hash with the row pointing at it. Re-dropping
   a folder is how a version is made, so without hashes every version re-stores
   every unchanged font. *Recommend hashes — one extra table and a join.*

---

## 14. Acceptance

Fixtures prove the shape, not the agent. Against real accounts:

- A skill selected before the first message is in the agent's own listing.
- A skill activated **mid-conversation** is picked up without a restart, on all
  three. The likeliest failure; Claude Code with a cold root is the risk.
- A skill deactivated mid-conversation leaves the listing.
- Two sessions in one workspace with different selections, neither seeing the
  other's.
- A `scripts/` file arrives executable and runs.
- A selection over budget is refused with the numbers; one just under it does
  not silently lose its descriptions.
- A skill committed in a checkout is loaded.
- A version amended under a running session does not change what it reads.
- A skill shared through a directory is selectable by a colleague and invisible
  to everybody else.
- A skill filed into a directory outlives its author being removed.

# Skills — key decisions

What was decided while scoping the skill library, and what each one turned on.
Not a specification: the reasoning, so that somebody reopening a question later
knows what was already weighed and does not re-derive it differently.

Facts about the agents were checked against the installed CLIs — Claude Code
2.1.273, Codex 0.156.1, Kimi Code 2.1.1 — and against the published libraries,
not against documentation. Where something is unverified it says so.

---

## Ownership and sharing

**A skill is a Placed resource. Nothing new was invented.**
Path, `extra_perms`, `filed_where`, `may_share` — the same shape as a machine or
an agent account. Born at `u/<somebody>/<slug>`, moved into a directory to share
it. Inventing a sharing concept for skills was considered and rejected: the one
in [`paths-and-ownership.md`](../paths-and-ownership.md) already answers every
question this feature asks.

**Skills are each person's responsibility. No organisation policy table.**
A genuine fork, and the reasoning matters more than the conclusion. There are
two kinds of skill:

- **Capability** — *make a PDF*, *review Rust*. These help you do a task.
  Pushed onto somebody who does not need one, a capability skill is pure cost:
  its description is in the system prompt on every turn, for nothing.
- **Convention** — *our commit format*, *our house prose*. These exist so that
  everybody's output matches, and are close to worthless if half the team has
  them off.

Convention is the only kind worth enforcing — and convention skills mostly
belong **in the repository**, where they are reviewed like code and change when
the code changes. So the thing that wants company-level enforcement already has
a home that is not us. A policy table is easy to add later with evidence about
which skills actually needed it, and hard to remove once people depend on it.

**Repository defaults are personal, and that falls out for free.**
`repos` is already `unique (org_id, remote, path)` — one row per person per
remote, each with its own setup script. A default hung off a repository is
therefore already personal, with nothing built for it.

**Discovery without enforcement.**
A skill shared into a directory somebody is in sorts to the top of the picker,
labelled, and **not ticked**. That answers "how would I know this exists"
at zero context cost, which is most of what a policy table would have bought.

**Offboarding splits on where a skill is filed: personal goes, directory stays.**
This is a new pattern. Today each kind picks one outcome applied uniformly —
workspaces cascade *including ones filed in a directory*, machines move to
`d/shared` regardless, secrets go. Skills want the outcome to depend on the
path, and the justification is one sentence: **a workspace is a conversation and
cannot be handed over; a skill is a document, and filing it into a directory
already handed it over.** Because it contradicts the workspace rule, it has to
be said out loud in `delete_user` and in
[`paths-and-ownership.md`](../paths-and-ownership.md) §3 rather than slid in.

---

## Format

**The folder is stored verbatim; five fields are interpreted.**
`name`, `description`, `license`, `compatibility`, `metadata` are portable
across all three agents. Everything agent-specific — Claude Code's dozen extras,
Codex's `agents/openai.yaml`, Kimi's `type: flow` — is kept byte for byte and
labelled in the interface as belonging to one agent. A skill that silently loses
its `hooks` on the way to Codex is worse than one that says it will.

**The version lives in `metadata.version`.**
The Agent Skills standard has no top-level `version`. Firetower's own version is
an integer in the database — that is the thing that moves — and the file is
stamped on the way out so a bundle on a worker can be traced back to a row.

---

## Versions

**Re-dropping the folder is how a version is made.**
This follows from deciding there is no editor: if a version is the diff between
two uploads, nothing needs to be editable in place. Amend-in-place stays as the
narrow case — right for a typo — and is allowed only while nobody else has
pinned the version, because it is the one operation that can change what
somebody else's running agent is reading.

**"Everybody gets the new version" means whoever starts next.**
A running session keeps the version it pinned. Same principle as
[`permissions.md`](../permissions.md) §6: you can hand over a place, you cannot
hand over a conversation. `skill_pins` is what makes that true rather than
aspirational.

---

## Storage

**Everything in Postgres. No object store, no second service.**
Measured rather than assumed: the entire `anthropics/skills` repository is 430
files and 11 MB logical, and costs **5.9 MB** loaded into PG16 with default
TOAST compression — `.xsd` compresses to 15%, markdown to 51%, fonts to 69%. A
`bytea` value tops out at 1 GB and the largest real file is 242 KB. A second
stateful service would cost backup, credentials and upgrades on a product people
install onto their own server with one command.

**Bytes are content-addressed.**
`blobs(hash, bytes)` plus `skill_files(version_id, path, hash, executable)`,
both in Postgres. Because re-dropping a folder is the update mechanism: without
hashes, changing one line of `canvas-design` re-stores 5.3 MB of unchanged
fonts, every version. Measured at 11 MB → 8.9 MB on a *single* import, before
any versioning. It also makes "what changed between v3 and v4" a comparison of
two short lists rather than a diff of megabytes, and it is what lets the worker
cache bundles. If bytes ever need to live on a disk or in a bucket, only what
`blobs` holds changes.

**Caps come from the real sample, not a guess.**
100 files, 256 KB body, 2 MB a file, 25 MB a version. The first draft said 50
files and 64 KB and would have refused five of Anthropic's six largest skills:
`canvas-design` is 5.55 MB over 83 files (54 TrueType fonts), and
`claude-api`'s own `SKILL.md` is 102 KB over 603 lines — so the standard's
"under 500 lines" is guidance and cannot be a gate.

---

## Delivery

**One shape for all three agents: a directory of bundles belonging to one
session.** Verified:

| Agent | Root | How | Verified |
| --- | --- | --- | --- |
| Claude Code 2.1.273 | `<root>/.claude/skills/<name>/` | `--add-dir <root>` | yes — appeared in the `init` frame; symlinked bundles load |
| Codex 0.156.1 | `$CODEX_HOME/skills/<name>/` | already per session | yes — `skills/list` returns `scope: "user"` |
| Kimi Code 2.1.1 | `$KIMI_CODE_HOME/skills/<name>/` | already per session | no — read out of the binary; `session/new` needs an account |

**Project scope was rejected.** One workspace holds several sessions, with
different agents and different selections; a project directory is shared by all
of them. Kimi also resolves its project root by walking up for `.git`, which in
a workspace finds nothing — or the wrong thing. And when `RepoSpec.path` is
empty, a project directory lands inside the git worktree and turns up in the
pull request.

**`CLAUDE_CONFIG_DIR` was rejected** even though it works. It hides the host's
own `~/.claude` — their settings, their skills, their plugins — which is a
bigger change than this feature needs. Kept as the fallback if `--add-dir` ever
stops carrying skills.

**A mid-session change sends the whole selection, never a delta.**
A delta that arrives out of order leaves a worker holding a set nobody chose.

**Hashes are sent first and the worker caches by hash.**
A 5.5 MB bundle is 7.4 MB of base64 held whole at every hop, on every session
start. The worker says which bundles it is missing, and materialising one into a
session is a link rather than a transfer.

**What the agent loaded is read from the agent, not from our own bookkeeping.**
Claude Code's stream-json `init` frame carries a `skills` array; Codex answers
`skills/list` and pushes `skills/changed`. That is the difference between "we
wrote the files" and "the agent has them".

---

## Selection

**Selection is per session, and applied as a batch.**
Descriptions sit in the system prompt, so changing the selection mid-session
changes the prompt prefix and invalidates the provider's cache — the next turn
re-bills the whole conversation as uncached input. Hence an Apply button rather
than per-checkbox application, and a visible *takes effect on your next
message*.

**A budget meter per agent, and the server refuses an over-budget selection.**
This is the constraint the whole interface is designed around. Codex's failure
is a cliff: past the budget it truncates descriptions, and past that it removes
**every** skill description rather than the last one. Anthropic's own guidance
says to reconsider past 20–50 enabled; Codex's default is about 8,000
characters, which is 25–30 skills. **Hundreds is a library size and never a
selection size.** Raising `skills.max_context_tokens` means generating
`$CODEX_HOME/config.toml` rather than appending to it — `skills.bundled = true`
is not a valid key, and one bad line makes Codex fail to load config at all and
return an empty skill list.

**The right rail is the home, the palette is the way in, the composer chip is
the indicator.** One component with three mounts, and the library screen is the
fourth. A dropdown was rejected for having no room for a description, no search
and no budget; a separate page was rejected because the moment you want to
change this is the middle of a conversation.

---

## Getting a skill in

**No editor.** Drop a folder, drop a zip, drop a folder of folders, or publish
one out of a workspace. Only `name` and `description` are editable, because
collisions and a description written for somebody else's repository are the only
two things that reliably need fixing on import. Nobody writes these by hand —
Anthropic's own answer is that an agent writes it, with `skill-creator`.

**Zips are accepted because that is how skills are published**, not because of
the file mode. A dropped folder cannot carry the POSIX executable bit — Tauri's
`dragDropEnabled` is off, so drops arrive as HTML5 `File` objects rather than OS
paths, and a `File` has no mode — and the first draft made a feature of that,
with a per-file control in the import review.

It was wrong, and checking settled it. The standard has no field declaring which
files run; `scripts/` is only a folder name. In `anthropics/skills`, **404 files
are `100644` and 26 are `100755`** — most of their own scripts are not
executable, including ones beside ones that are. Nothing depends on it because
every `SKILL.md` invokes through an interpreter: 23 occurrences of
`python scripts/…`, two of `bash scripts/…`, and none of `./scripts/…`.

So the bit is preserved when a zip carries one, inferred from a `#!` line when a
folder does not, and surfaced nowhere. A control for it was interface for
something nobody uses, and it cost a reader a question about whether files were
being excluded.

**Publishing out of a workspace is cut from v1, and the replacement is better.**
An agent that has just written `.claude/skills/foo` in a workspace is the most
natural source of a skill there is, and the first draft put a *Publish* control
in the Files tab. Getting the bytes off a worker that way needs a new frame —
`ListFiles` and `ReadFile` move one file at a time — so it is a protocol bump, a
directory walk across the tunnel and a second review path, for something that is
not the feature. It also asks somebody to choose between two homes for one skill
at the moment they are least able to: the folder the agent wrote is inside a
checkout, so it is either about to be committed, which makes it the
repository's, or it is scratch that dies with the workspace.

The route to take later is **MCP**, and it is cheaper than the button rather
than more expensive. `ft-worker/src/approver.rs` already starts a `firetower`
MCP server for the session with one tool, `approve`, holding the socket that
carries a question to a browser and the answer back. A second tool publishes a
bundle the agent hands over — no directory walk, no new frame, and the approval
card that already exists is exactly the right gate: *the agent wants to publish
a skill called `rust-review` to your library*. It also composes with how skills
are actually written, since `skill-creator` is Anthropic's own answer to
authoring one.

The caveat to know before planning it: that MCP server reaches Claude Code only,
through `--permission-prompt-tool` and `--mcp-config`. Codex takes approvals
over its app-server and Kimi over ACP, whose `session/new` currently passes
`mcpServers: []`.

## Safety

**Nothing is stripped from a shared skill.**
Reversed during scoping, and the argument that won is the right one: stripping
`hooks` and `` !`cmd` `` is a half-protection. It does not stop `scripts/`, it
does not stop `allowed-tools`, and it does not stop the body simply telling the
agent to run something. A door that looks closed is worse than no door. The
house position is already to **name** risks no permission level fixes rather
than build partial mitigations — see [`permissions.md`](../permissions.md) §8 —
and Firetower already runs a repository's setup script in every session without
asking, on a repository somebody else may have connected. Fidelity to the format
is the product: a skill that works in Claude Code and behaves differently under
Firetower is the worse failure.

**Badges instead, earned by parsing.** *Runs shell commands*, *pre-approves
tools*, *registers hooks*, *ships scripts* — on the row, not three clicks away —
plus one paragraph in `permissions.md` §8 saying that selecting somebody's skill
runs their code on your worker under your credentials.

**Firetower never runs a skill's script.** The agent does, through its own Bash
tool, under its own sandbox and the approval prompts already routed to a person.
Three things are ours and only three: the executable bit, because we write the
files; surfacing `compatibility` before somebody selects — checked against the
host the session is about to run on, which we know; and not pretending the
environment is ready when it is not.

---

## Surface and scope

**The desktop owns the library.** [`which-surface.md`](../which-surface.md)
decides it: *bound to you → desktop*. A skill is the same shape as a repository
or an agent account, and those are desktop, as are sharing a resource and
granting on a directory. Nothing about a skill is organisational in the sense
the administration site owns, which is who exists and how they authenticate.

**All three clients select; mobile never creates.** That matches the existing
line — *mobile reads and starts work, it writes no access of any kind* — and is
forced anyway, since there is no directory drop on a phone.

**Repository-committed skills are a separate piece of work.** Worth recording
that it is currently broken: with checkouts in subdirectories and the agent's
cwd at the workspace root, neither Codex nor Claude Code sees a checkout's own
`.claude/skills`, `.codex/skills` or `.agents/skills`. Both listed zero when
tested. That is a bug in how workspaces are laid out, not part of the library.

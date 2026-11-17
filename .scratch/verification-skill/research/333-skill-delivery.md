# How does a repo-local verification skill reach the QA agent?

Research for [#333](https://github.com/firetower-cloud/firetower/issues/333), which
blocks [#335](https://github.com/firetower-cloud/firetower/issues/335). Map:
[#329](https://github.com/firetower-cloud/firetower/issues/329).

Read-only. Nothing was built, run or measured against a live stack; every claim
below is cited to a file and line, and where something could not be established
by reading it says so under **Not established** at the end of its section.

All line numbers are against `3fdc6de2` (`origin/main` at the time of writing).

---

## The one constraint that shapes every option

**A bundle committed at `<checkout>/.claude/skills/verify-firetower/` is read by
nothing today.** Two facts in the code put it out of reach, and neither is a
configuration:

1. Every checkout lands in a *subdirectory* of the workspace —
   `crates/ft-server/src/api/sessions.rs:989-1001`: "Every checkout gets a
   directory inside the workspace, including when there is only one. Uniform
   because a session can gain a repository later." The path comes from
   `ft_core::session::checkout_dir` and is stored on `Checkout.path`
   (`crates/ft-core/src/session.rs:33-39`); empty means the checkout *is* the
   workspace, and that is only how pre-multi-repo sessions are laid out.
2. The agent's working directory is the **workspace root**, not the checkout —
   `crates/ft-worker/src/agentd.rs:355` (`.current_dir(&launch.workspace)`) for
   Claude Code and Codex, and `crates/ft-worker/src/acp.rs:359,403` (`"cwd":cwd`
   where `cwd` is the canonicalised workspace) for Kimi and Cursor.

So the project-scope directory each agent looks in is `<workspace>/.claude/skills`,
one level above the committed one. `docs/skills.md:739-745` states the same thing
as a measurement rather than an inference — "**Firetower currently breaks this**:
with checkouts in subdirectories and the agent's cwd at the workspace root,
neither Codex nor Claude Code sees `<checkout>/.claude/skills`, `.codex/skills`
or `.agents/skills`. Verified — both listed zero" — and
`docs/skills/key-decisions.md:281-285` repeats it and calls it "a bug in how
workspaces are laid out, not part of the library". It is an open acceptance
criterion, not a shipped behaviour: `docs/skills.md:1061`, "A skill committed in
a checkout is loaded."

The agent can of course still `Read` the file by path. What it cannot do is
*discover* it, which is the whole mechanism this ticket is about.

---

## Options, with costs

"Fires unprompted" means the agent reaches for it off its own description,
without the prompt or the profile instructions naming it.

| # | Option | Fires unprompted? | At-rest cost | Visible in library / meterable | Can a session turn it off? | Versioned & pinned? | Engines it reaches | Build cost |
|---|---|---|---|---|---|---|---|---|
| **A** | Commit the bundle at `firetower/.claude/skills/verify-firetower/` and change nothing else | **No** — nothing reads it (`sessions.rs:989`, `agentd.rs:355`, `acp.rs:359`) | 0 tokens | No | n/a | No | none | none |
| **B** | A, plus the QA profile's `instructions` naming the path, so the agent opens it with `Read` | No — it fires because it was told to | Whatever the instruction weighs, every turn: a profile rides `--append-system-prompt` for a person-started session (`crates/ft-core/src/lib.rs:241-248`) and the first user message for a delegated child (`crates/ft-server/src/delegate.rs:861-870`) | No | Only by editing the profile | No — it is whatever `main` says that minute | all four | ~0 |
| **C** | A, plus pass the checkout to Claude Code as a second `--add-dir` (one `argv.push` beside `crates/ft-worker/src/entry.rs:111-119`) | **Yes** — Claude Code loads `<added>/.claude/skills/<name>/` (`crates/ft-core/src/lib.rs:1359-1363`, verified in its `init` frame per `docs/skills.md:310`) | ~105 tokens for a full description (see §3) | **No** — bypasses `skill_pins` entirely | **No** | No | **Claude Code only** | small, but it is product code and a new shared-project-scope precedent that `docs/skills.md:429-434` argues against |
| **D** | A, plus the aggregation `docs/skills.md:739-745` describes: collect each checkout's committed skills into the session's skills root | **Yes**, on every engine | same ~105 tokens | Partly — would want a row in the picker and the meter (`docs/skills.md:1028-1030` leaves "on by default, or only visible?" open) | Design question, unanswered | No — the repo is the version | all four | **the real cost**: unbuilt, unspecified, named as a separate piece of work in two docs |
| **E** | Put the bundle in the library as a Placed skill (drop a folder on the Skills screen, or `create_skill` over MCP), enable it as a repository default and/or in the QA profile's `skill_scope` | **Yes**, on every engine, through the machinery that already runs | same ~105 tokens, and the picker meters it against the per-agent budget (`desktop/src/skills.ts:490-495`) | **Yes** — a row, `tokens` on it, a version, an author | **Yes** — `PUT /sessions/{id}/skills` (`crates/ft-server/src/api/skills.rs:604`) | **Yes** — `skill_pins` pins the version (`migrations/server/20261004120000_skills.sql:124-131`) | all four | ~0 product code. Cost is **drift**: the library copy is a snapshot, re-import is how a version is made (`docs/skills.md:917`), and a bundle shipping `scripts/` published by an agent is **held for review** until a human approves (`crates/ft-server/src/delegate.rs:2379-2406`, `2588-2594`) |
| **F** | Install it at `~/.claude/skills/verify-firetower/` on the machine the QA agent runs on | **Yes** | same ~105 tokens | **No** — and the product says so out loud | **No** | No | **Claude Code only** (`desktop/src/skills.ts:506-511`) | ~0, and it is per machine, by hand, forever |
| **G** | E **and** A together — library copy for triggering, repo copy as the source of truth | Yes | ~105 tokens once | Yes (for the library copy) | Yes | Yes (library copy) | all four | two copies to keep in step, and a **name collision** the moment D lands: two skills of one name means *neither* is delivered (`crates/ft-server/src/skills.rs:3285-3346`) |

Costs that apply to several rows:

- **Two skills, not one.** #337 put QA proof in a PR comment via `gh --attach`,
  so the QA profile plausibly needs `pr-screenshots` alongside `verify-firetower`.
  Two descriptions, both in the system prompt every turn — see §3 for the pair's
  arithmetic.
- **A child cannot install its own skill.** `create_skill`, `update_skill`,
  `list_skills`, `list_profiles` and `update_profile` are all refused to a
  delegated session: `crates/ft-server/src/delegate.rs:383-393`, "this session is
  itself a child; configuring Firetower is the lead's to do". Confirmed live —
  this session's own `list_skills` and `list_profiles` calls were refused with
  that sentence. So options D, E and F are all something a lead or a person does,
  never something the QA agent does for itself.
- **Nothing is required.** The org-policy layer with *suggested* / *on by
  default* / *required* strengths (`docs/skills.md:752-773`) is **not built**:
  there is no `skill_policies` table in `migrations/server/` (the only skill
  migrations are `20261004120000_skills.sql`, `20261004170000_skill_identity.sql`,
  `20261101120000_skill_hold.sql`, `20261108120000_profile_skill_sources.sql`).
  The strongest thing that exists is a profile's `skill_scope`, which is additive
  and not switchable at spawn — and a person can still drop it mid-session.

---

## 1. How a skill in this checkout is loaded for an agent in a Firetower workspace

### The per-agent directory table

`docs/skills.md:308-313`, with the live implementation beside each row in
`Agent::skills_home` (`crates/ft-core/src/lib.rs:1372-1379`) and
`skills::root` (`crates/ft-worker/src/skills.rs:39-52`):

| Agent | Directory it reads | How it is told | Verified, per the doc |
|---|---|---|---|
| Claude Code 2.1.273 | `<root>/.claude/skills/<name>/` | `--add-dir <root>`, pushed per launch at `crates/ft-worker/src/entry.rs:111-119` | Yes — "The `init` frame listed it. Symlinked bundles load." (`docs/skills.md:310`) |
| Codex 0.156.1 | `$CODEX_HOME/skills/<name>/` | already per session | Yes — `skills/list` returns `scope: "user"` (`:311`) |
| Kimi Code 2.1.1 | `$KIMI_CODE_HOME/skills/<name>/` | already per session | **No** — read out of the binary; `session/new` needs an account (`:312`) |
| Cursor Agent 2026.09.28-64d2043 | `$HOME/.cursor/skills/<name>/` (its home *is* `HOME`) | already per session | **Partly** — read out of the binary, not confirmed against a signed-in session (`:313`) |

Firetower's own copy of that table is the `SkillsHome` enum: `AgentHome("skills")`
for Codex and Kimi, `AgentHome(".cursor/skills")` for Cursor, `AddedDirectory` for
Claude Code, `None` for `Shell` (`crates/ft-core/src/lib.rs:1372-1379`). The
concrete paths the worker writes are
`<workspace>/<agentd>/agent-home-<session>/<under>` and
`<workspace>/<agentd>/skills-<session>/.claude/skills` respectively
(`crates/ft-worker/src/skills.rs:32-52`).

**Which other agents' directories each one reads.** Only Cursor reads anybody
else's. `docs/skills.md:315-319` and `crates/ft-core/src/lib.rs:1366-1371`: Cursor
"scans a fixed table of `<config>/skills` directories — `.cursor`, `.claude`,
`.codex`, `.grok`, `.agents` — under both the project root and the home
directory". That is five names in two places. Claude Code, Codex and Kimi each
read only their own. One further Claude-Code-only route is recorded in
`desktop/src/skills.ts:501-511`: it **also** reads the machine's own
`~/.claude/skills`, and the other three do not.

Cursor caches: `loadCommandsAndSkills` memoises on first use, so the `/`-menu it
advertises over ACP is the set that existed when the session opened
(`docs/skills.md:321-324`).

### What a bundle at `.claude/skills/verify-firetower/` reaches, and what it misses

Everything in the "one constraint" section above. Specifically:

**Reaches:** nothing, as a skill. Not Claude Code (project scope is
`<workspace>/.claude/skills`, and the only `--add-dir` passed is the per-session
skills root — `crates/ft-worker/src/entry.rs:113-118`, the single `--add-dir` in
the whole repo). Not Codex (`$CODEX_HOME/skills`). Not Kimi (same, and
`docs/skills.md:430-431` adds that Kimi "resolves its project root by walking up
for `.git`, which in a workspace finds nothing — or finds the wrong thing";
walking up from the workspace root past a checkout subdirectory is exactly that
case). Not Cursor — its project root is the ACP `cwd`, which is the workspace
root (`crates/ft-worker/src/acp.rs:359`), so the `.claude` entry in its five-name
table lands one level above the committed bundle too.

**Misses:** per-session isolation, the picker, the budget meter, version pinning,
the risk badges, and any record that it was loaded. It also misses the one thing
`docs/skills.md:429-437` deliberately rejects for the opposite reason — project
scope is "shared by all of them" and `CLAUDE_CONFIG_DIR` "hides the host's own
`~/.claude`".

**It does reach a `Read` tool.** The checkout is a subdirectory of the agent's
cwd, so `firetower/.claude/skills/verify-firetower/SKILL.md` is an ordinary
readable file. That is option B: a document the profile points at, not a skill.

Two consolations if the bundle is committed anyway: the layout is exactly what
option D would aggregate, so nothing is wasted; and `docs/skills.md:310` records
that **symlinked bundles load** in Claude Code, which is what makes C and D cheap
rather than a copy.

### Not established

- Whether Claude Code 2.1.273 reads `.claude/skills` relative to its cwd at all
  (as opposed to only under `--add-dir` roots). `docs/skills.md:741-743` asserts
  that it would, were the cwd right — "neither Codex nor Claude Code sees
  `<checkout>/.claude/skills`" is written as a consequence of the cwd, and the
  measurement reported is "both listed zero". I did not re-run it, and the
  distinction matters for option C: if cwd-relative project scope is the
  mechanism, moving the cwd is an alternative to adding a directory.
- Whether Cursor and Kimi behave as the binary-read suggests. Both rows in
  `docs/skills.md:312-313,351` say unverified, and nothing in this repo verifies
  them.

---

## 2. Can a PROFILE point at a repo-local skill, or only at a Placed one?

**Only at a Placed one. The field is a list of database ids, filtered through the
visible library, and there is no path anywhere in it.**

- `Role.skill_scope: Vec<String>` — "Skills this profile loads whatever the two
  switches say, **by id**" (`crates/ft-server/src/roles.rs:116-122`).
- What a profile loads is the union of three additive sources, all of them ids:
  the starter's always-on `skill_defaults` rows, their defaults for the
  repositories the child checks out, and `skill_scope`
  (`crates/ft-server/src/roles.rs:371-395`). Every id is dropped unless
  `reachable.contains(id)` (`:389`), where `reachable` is
  `skills.visible(person, Level::Viewer)` (`:433-439`).
- Saving a profile refuses an unreachable id outright rather than filtering it:
  `check_skills` in `crates/ft-server/src/api/roles.rs:78-105`, "N of the skills
  named aren't ones you can use, so this profile can't load them".
- Delivery re-checks at the moment it pins: `Skills::set_for_session` runs the
  set through `deliverable()` and then an SQL `filed_where(... Viewer)`
  (`crates/ft-server/src/skills.rs:3307-3346`, `3456-3486`).
- The editor is a picker over the library and nothing else:
  `desktop/src/ui/config/SkillSources.tsx:48` (`useSkills` from `~/data`),
  mounted from the profile editor at `desktop/src/ui/config/Roles.tsx:861,1452`.
  There is no free-text path input.

So a profile cannot name a file in a checkout. The only profile-shaped way to
reach a repo-local bundle is the `instructions` field — prose telling the agent
where to look (option B).

### Does `built-in-skills.md`'s argument apply to a repo-local skill?

The argument is at `docs/built-in-skills.md:82-88`: an earlier draft had the
worker write a bundle straight into the session's skills directory, bypassing the
database, and it was rejected because "a skill nobody can see in the library
cannot be read, cannot be turned off for a session that does not want it, and
cannot have its cost accounted for. Invisible is not the same as built-in."

**All three clauses apply to a repo-local skill, and one of them lands harder.**

- *Cannot be read.* Partly mitigated and not removed. A repo-local skill is
  readable in the sense that it is in `main` and went through review — strictly
  better than a bundle `include_str!`'d into a binary. It is not readable *where
  the decision is made*: `docs/built-in-skills.md:134-138` argues the thing that
  identifies a skill is its description, and "the description is also, literally,
  the text that goes into the model's context, so it is the one field a person has
  to be able to read properly". Nobody looking at the Skills screen sees it.
- *Cannot be turned off.* **Fully applies, and this is the sharpest one.** A
  Placed skill is a `skill_pins` row that `choose_skills` can delete
  (`crates/ft-server/src/api/skills.rs:604-663`). A repo-local bundle is whatever
  is on disk; there is no row and no switch. A QA agent that should not be driving
  the app this turn is still carrying the description.
- *Cannot have its cost accounted for.* Fully applies. `tokens` is computed and
  stored per version (`crates/ft-server/src/skills.rs:349-359`), the picker meters
  the total against `BUDGET` (`desktop/src/skills.ts:490-495`), and Codex's
  failure past its budget is to drop **every** description rather than the last
  one (`docs/skills.md:636-642`, `desktop/src/skills.ts:477-481`). A skill outside
  the library is outside that sum, which means the meter is wrong for everything
  else in it.

**Where repo-local is genuinely a different case.** Three ways, and they are real:

1. `docs/built-in-skills.md:271-279` already decided this exact question for the
   neighbouring case and came down on the repository's side: "What is specific to
   one repository — which client owns which page, where its tokens and its
   screenshot tooling are — belongs to that repository: **in its own committed
   skills once the aggregation `docs/skills.md` §7 describes lands, and in the
   library as a repository default until then**. Never in the binary." That is a
   written answer to #335 for the interim: the library, as a repository default.
2. `docs/skills.md:739-745` treats the repository's own skills as the *first* of
   three layers of selection, "ordered by how little new authority each needs",
   and says aggregating them "hands you org-level enforcement for free, under a
   model everybody already understands: whoever can merge to `main` decides".
   A repo-local verification skill is that model's best case: it has to change in
   lockstep with the app it drives, and a library snapshot cannot.
3. Review and provenance. `docs/skills.md:826-854` and
   `docs/skills/key-decisions.md:243-258` are about *somebody else's* executable
   code arriving on your worker. `verify-firetower` ships a `control-firetower`
   CLI that drives the app, and a bundle in `main` has had a pull request; a
   bundle dropped into a library has had whatever the dropper did.

Nothing in the repository resolves that tension, and it is #335's to resolve.
What is established is that the first two clauses of the quoted argument are
*untouched* by repo-local, and the third — turning it off — is the one that gets
worse rather than better.

### Not established

- Whether aggregated repo skills, if D landed, would appear as library rows with
  pins and a meter entry. `docs/skills.md:1028-1030` leaves it as decision 1:
  "Repository-committed skills: on by default, or only visible? *Recommend on …
  but counted in the meter, with a way to turn one off.*" A recommendation, not a
  design.

---

## 3. What the QA profile needs for the skill to fire unprompted, and what it costs at rest

### What makes it fire

Nothing more than being in the resolved set. A skill in the session's set has its
`name`, `description` and path rendered into the system prompt, and the model
decides from the description alone — `docs/skills.md:18-27`:

| Level | When it is in context | Cost |
|---|---|---|
| frontmatter | always | every turn, every session |
| `SKILL.md` body | when the agent decides it is relevant | once per invocation |
| `references/`, `scripts/` | when the agent opens one | only if opened |

"So the **description** is the expensive field and the one that decides whether a
skill ever fires. Everything else is free until it is needed."
`docs/built-in-skills.md:195-197` says the same of the one shipped example: "The
description is the whole triggering mechanism, so it names what it does and the
phrasings that should reach it, including the ones that never say 'artifact'."
`docs/skills.md:998-1001` names the two failure modes — under- and
over-triggering — and says the fix for both is editing the description.

### What controls which library skills are enabled for a given session

This is the mechanism that decides whether a QA agent reaches `verify-firetower`,
and it is `skill_pins` — one row per session per skill, pinning a version
(`migrations/server/20261004120000_skills.sql:118-131`). Rows are written in
exactly one place, `Skills::set_for_session`
(`crates/ft-server/src/skills.rs:3456-3486`), and the callers are:

| When | What decides the set |
|---|---|
| A person starts a workspace | started as a profile → `skills_at_spawn`; else the explicit selection the New page sent; else that person's `skill_defaults` for those repos (`crates/ft-server/src/api/sessions.rs:1172-1185`) |
| A second agent in an existing workspace | `skills_source` (`crates/ft-server/src/api/sessions.rs:1881`, `2071-2095`) |
| A lead delegates | the profile's `skills_at_spawn`; an ad-hoc child with no profile passes nothing and takes the owner's defaults (`crates/ft-server/src/delegate.rs:735-759`) |
| Mid-conversation | `PUT /api/v1/sessions/{id}/skills` → `choose_skills`, carrying the **whole** selection (`crates/ft-server/src/api/skills.rs:604-663`) |

So a Placed skill that nobody has ticked, defaulted or named in a profile is in
the library and in no session. That is the state the map's chartering session was
in with respect to `create-verification-skill`: being in the library grants
nothing; a `skill_defaults` row, a profile's `skill_scope`, or a tick is what
enables it. `skill_defaults` is keyed `(user_id, repo_id, skill_id)` with a
nullable `repo_id` meaning "on in every workspace this person starts"
(`migrations/server/20261004120000_skills.sql:100-116`).

**Can a profile require one?** Almost, and not quite:

- `skill_scope` is not switchable at spawn. `skills_for` always folds it in —
  `(true, role.skill_scope.as_slice())` with the comment "The list is not
  switchable: it is the profile's own decision, and 'always include these' is what
  it says on the screen" (`crates/ft-server/src/roles.rs:381-383`). The two
  inheritance switches can be turned off; this list cannot.
- But it is not *required* in the policy sense. `choose_skills` replaces the whole
  selection, so a person with Writer on the session can untick it mid-conversation
  (`crates/ft-server/src/api/skills.rs:604-663`). And the three-strength policy
  layer is unbuilt — no `skill_policies` table exists — with
  `docs/skills.md:767-770` recommending against shipping *required* at all:
  "Required plus Codex's budget cliff is a footgun."
- Two further ways a tick silently delivers nothing, both worth knowing before
  relying on a profile: a skill with no approved version (`version == 0`) is
  skipped everywhere (`crates/ft-server/src/api/skills.rs:440-459`,
  `desktop/src/ui/config/SkillSources.tsx:70-80`), and two skills of one name mean
  **neither** is sent (`crates/ft-server/src/skills.rs:3285-3346`).

**Does a repo-local skill bypass that switch?** Yes, completely — and that is a
real advantage with a real price. It is not a `skill_pins` row, so nothing can
remove it, nothing pins its version, and it is not in the budget sum. The product
already says this out loud about the one bypass route that works today, the
machine's own `~/.claude/skills` — `desktop/src/ui/config/SkillSources.tsx:646-665`:
"Claude Code also reads `~/.claude/skills` on the machine, whatever is set here.
Nothing on this screen pins, versions, scopes or records what is in there. This
decides what Firetower sends. It is not everything the agent can read." And when
both switches are off with nothing named: "`~/.claude/skills` is the only place
this child's skills will come from. **It is not hermetic — it is unrecorded.**"
(`:669`). Read that sentence as the cost of options C, D and F.

### The numbers

**The stored at-rest cost is computed from one string.**
`crates/ft-server/src/skills.rs:349-359`:

```rust
let entry = format!("{name}: {description} (skills/{name}/SKILL.md)");
```

tokenised with `tiktoken_rs::o200k_base()`, falling back to `entry.len() / 4` if
the tokenizer will not load. "`o200k_base` is a byte-pair encoder and not
Claude's, so this is an estimate — close enough for a budget meter, and wrong for
billing" (`:345-348`).

**The authoritative figures:**

| Figure | Value | Source |
|---|---|---|
| Guidance in the system prompt, at rest | **~250 tokens** | `docs/built-in-skills.md:25-28` |
| The same thing as a skill, at rest | **~30 tokens** (frontmatter) | `docs/built-in-skills.md:25-28` — "roughly **eight times cheaper at rest**" (`:30-31`) |
| Either, when actually used | **~250 tokens** | `docs/built-in-skills.md:25-28` |
| Per-agent budget, in tokens | Claude Code **3,000**; Kimi **2,250**; Codex **2,000**; Cursor **2,000** | `desktop/src/skills.ts:490-495` |
| Smallest budget, used for a profile that pins no agent | **2,000** | `desktop/src/skills.ts:497-499` |
| Codex's own stated budget | **~8,000 characters**, which "at realistic sizes is **25–30 skills**" | `docs/skills.md:640-642`; `desktop/src/skills.ts:477-481` reconciles 2,000 tokens with it "at roughly four characters a token" |
| Anthropic's guidance | reconsider past **20–50 enabled** | `docs/skills.md:640` |
| Description hard cap | **2,048 characters** | `crates/ft-server/src/skills.rs:68`, `docs/skills.md:65-69` |
| **Corpus median description** | **319 characters** | `crates/ft-server/src/skills.rs:65`, `docs/skills.md:68` — "this is headroom, not a target" |

Note the ~30-token row is about `firetower-artifacts`-style *frontmatter* and is
the figure `docs/built-in-skills.md:252` repeats ("anybody who never publishes can
stop paying its thirty tokens"); the mock in `:153-160` shows 170 tokens for the
same skill, and its real description is 702 characters
(`crates/ft-server/skills/firetower-artifacts/SKILL.md:3`), which by
`entry.len()/4` is ~190. The thirty-token figure is the cheap end of the range and
the hundred-and-seventy one is the shipped reality; both appear in the same
document.

**What that means for this effort,** by the shipped formula with the `/4` fallback
(not `o200k_base`, which is not installed here — treat as ±15%):

| Entry | Description chars | ~tokens every turn |
|---|---|---|
| Corpus median description | 319 | **~85** |
| `pr-screenshots`, description as drawn in `docs/prototypes/redesign/desktop-redesign.html:3540-3542` | 139 | **~47** |
| A one-line `verify-firetower` ("Drive the real Firetower stack and capture evidence a reviewer accepts.") | 71 | **~31** |
| A triggering `verify-firetower` — the Firetower stack named, the engines, "show it working rather than argue from a diff", plus the phrasings that should reach it | 369 | **~105** |
| **The pair #337 implies: `verify-firetower` + `pr-screenshots`** | — | **~150, every turn, for the whole life of a QA session** |

Against the smallest budget that applies to a profile pinning no engine (2,000),
~150 tokens is **7.5%**, leaving room for roughly 20 more median-sized skills.
Against Claude Code's 3,000 it is 5%. Neither is near the cliff. The
`docs/prototypes/redesign/desktop-redesign.html:3555` figure of "412 tokens a
turn" for `pr-screenshots` is mock data in a prototype and does not agree with
its own description; the formula is the thing to trust.

Three costs that are not tokens:

- **Changing the selection mid-session invalidates the provider's cache**, so the
  next turn re-bills the whole conversation (`docs/skills.md:653-656`). Apply as a
  batch.
- **A description written to fire has to not fire elsewhere.** `verify-firetower`
  is a Firetower-specific skill, so phrasings like "verify this works" are exactly
  the over-triggering `docs/skills.md:998-1001` warns about if it is ever enabled
  in a workspace that is not Firetower's. Scoping it as a *repository* default
  (`skill_defaults.repo_id`) rather than an always-on one is what bounds that.
- **`verify` is a reserved name** (`crates/ft-server/src/skills.rs:71-94`).
  `verify-firetower` is not — the check is exact-match
  (`is_reserved`, `:409-411`) — but `verify` itself would be a warning.

### Not established

- Whether a `BUDGET` figure is enforced server-side. `docs/skills.md:646-648` wants
  "The server refuses an oversized selection with the numbers"; I found the
  constants and the meter in `desktop/src/skills.ts` and did not find a
  corresponding refusal in `crates/ft-server/src/api/skills.rs`. Not chased
  further — it does not change any option here, since ~150 tokens is far inside
  every budget.
- The `o200k_base` count for a real candidate description. The tokenizer is a Rust
  dependency and `python3 -c "import tiktoken"` fails on this machine; the
  deliverable forbids builds. Every token figure above is the `/4` fallback.

---

## 4. What changes if QA runs on something other than Claude Code

**Four engines are supported.** `Agent::all()` returns exactly
`[ClaudeCode, Codex, KimiCode, CursorAgent]` (`crates/ft-core/src/lib.rs:104-111`).
A fifth variant, `Shell`, exists and is "not offered … starting one has been
refused for as long as the refusal has existed" (`:86-101`); `skills_home()`
returns `None` for it, so it reads no skills at all
(`crates/ft-core/src/lib.rs:1377`, `crates/ft-worker/src/skills.rs:38-39`). A
profile may pin an engine or leave it to the lead (`Role.agent: Option<String>`,
`crates/ft-server/src/roles.rs:78-80`), so a QA profile that pins nothing can run
on any of the four.

What a repo-local `.claude/skills/verify-firetower/` bundle means per engine, as
things stand:

| Engine | What it does with `<checkout>/.claude/skills/` today | If option C (one extra `--add-dir`) ships | If option D (aggregation) ships |
|---|---|---|---|
| **Claude Code** | Nothing — project scope is the workspace root, and the only `--add-dir` is the per-session skills root (`crates/ft-worker/src/entry.rs:113-118`) | **Works.** `<added>/.claude/skills/<name>/` is exactly what it reads, and symlinked bundles load (`docs/skills.md:310`) | Works |
| **Codex** | Nothing. Reads `$CODEX_HOME/skills` only (`crates/ft-core/src/lib.rs:1375`); `docs/skills.md:742` measured zero | **Still nothing** — `--add-dir` is a Claude Code flag | Works |
| **Kimi Code** | Nothing. `$KIMI_CODE_HOME/skills` only, and its project-root discovery walks up for `.git`, which "in a workspace finds nothing — or finds the wrong thing" (`docs/skills.md:430-431`) | Still nothing | Works, *unverified against a live Kimi* (`docs/skills.md:312`) |
| **Cursor Agent** | **Closest to working and still misses.** It scans `.cursor`, `.claude`, `.codex`, `.grok`, `.agents` under the project root *and* the home — but its project root is the ACP `cwd`, the workspace root (`crates/ft-worker/src/acp.rs:359,403`), one level above the checkout | Still nothing | Works, *unverified* (`docs/skills.md:313`); and it memoises the list at session start (`:321-324`) |

Four consequences worth carrying into #335:

1. **Option C buys Claude Code only.** Choosing it is choosing that QA runs on
   Claude Code, or that QA on another engine silently has no verification skill.
   `docs/skills.md:326-327` is explicit that this is the wrong shape: "One
   capability method on `Agent`, beside `home_var`. Never a `kind ===
   "ClaudeCode"` in a client."
2. **Option F is Claude Code only too**, and for a different reason:
   `READS_HOST_DIRECTORY` is true for `ClaudeCode` and false for the other three
   (`desktop/src/skills.ts:506-511`), which the profile editor says in as many
   words (`desktop/src/ui/config/SkillSources.tsx:659-664`).
3. **Option E is the only one that reaches all four today**, because the worker
   writes the same bundle to whatever directory the engine reads
   (`crates/ft-worker/src/skills.rs:39-52`).
4. **Frontmatter does not travel intact.** `docs/skills.md:31-36`: `name`,
   `description`, `license`, `compatibility`, `metadata` and `allowed-tools` are
   portable; `when_to_use`, `arguments`, `model`, `hooks` and `context: fork` are
   Claude Code's alone, and the client warns when one is present
   (`desktop/src/skills.ts:413-415`). A `verify-firetower` that leans on
   `allowed-tools` to pre-approve its Playwright calls is leaning on something
   three of the four engines ignore. There is also a line-break disagreement
   between readers that can turn one frontmatter field into two
   (`docs/skills.md:337-366`) — not an authoring concern unless the description
   carries a lone CR or a U+2028.

### Not established

- Whether Codex, Kimi or Cursor read any checkout-local directory at all once the
  cwd is right. The Cursor table is read out of its binary; the other two are
  measured only in the negative.

---

## 5. Validation an imported bundle must pass — the author's checklist

From `docs/skills.md:58-299`, with the enforcing code beside each rule. Server
entry point is `skills::check` (`crates/ft-server/src/skills.rs:444-610`), mirrored
client-side in `bundle()` in `desktop/src/skills.ts:295-426`. **Every rule is asked of the bytes
in the bundle, not of the `frontmatter`/`body` a client parsed alongside them**
(`docs/skills.md:258-262`, `crates/ft-server/src/skills.rs:549-559`), and
`PATCH /skills/{id}` is held to the same bracket rule as import.

### Refusals — get one of these wrong and the bundle does not import

- [ ] **`SKILL.md` exists, spelled exactly that way.** `crates/ft-server/src/skills.rs:469-473`.
- [ ] **Folder name is kebab-case and matches `name`**: 1–64 chars, `[a-z0-9-]`, no
      leading or trailing hyphen. `check_name`, `crates/ft-server/src/skills.rs:420-434`.
      (`verify-firetower` passes. A mismatch between folder and declared `name` is
      only a *warning* — `desktop/src/skills.ts:405-406`.)
- [ ] **No `claude` or `anthropic` anywhere in the name** — reserved outright.
      `crates/ft-server/src/skills.rs:435-439`.
- [ ] **`description` present, non-empty, ≤ 2,048 characters**, and it says *what*
      and *when*. `crates/ft-server/src/skills.rs:447-456`. Median in the corpus is
      319; the cap is headroom, and §3's budget is the real bound.
- [ ] **No `<` or `>` anywhere in the frontmatter.** `check_no_brackets`,
      `crates/ft-server/src/skills.rs:981-990`; `docs/skills.md:70-74`. It goes into
      the system prompt, so a bracket is an injection route and "Anthropic forbids
      them outright". **Checked on the *decoded* frontmatter**, because a
      double-quoted scalar can spell one as `<` — "a rule that only looks for
      the character is one line away from being bypassed". Practical consequences for
      an author: no `<name>` placeholders, no `-->`, no `->` arrows with a bracket, no
      `description: "a < b"`, in **any** frontmatter field including `metadata`. Use
      the body for anything that needs one — 15 of the 26 skills Anthropic and OpenAI
      ship have brackets in their *bodies*, and that is fine
      (`docs/skills.md:82-84`).
- [ ] **No harness framing anywhere in the bundle.** `check_no_forged_tags`,
      `crates/ft-server/src/skills.rs:1003-1010`, run over *every* UTF-8 file
      (`:600-607`) — not just `SKILL.md`, because "a `references/` file is opened
      into the same context on the same turn". The list, `FORGED_TAGS` at
      `crates/ft-server/src/skills.rs:959-970`: `system-reminder`,
      `function_calls`, `function_results`, `task-notification`, `command-name`,
      `command-message`, `user-prompt-submit-hook`, `invoke` — plus the whole
      `antml:` namespace (`FORGED_NAMESPACES`, `:973`). Opening or closing form,
      case-insensitive. **Two deliberate non-rules:** it is *not* a bracket ban, and
      it is *not* triggered inside a code span or fenced block, which is a tag being
      *discussed* (`docs/skills.md:82-91`, `crates/ft-server/src/skills.rs:998-1002`).
      A line whose backticks do not pair up is read as prose, so a stray backtick is
      not a hiding place. The client additionally **warns** on the code-span case;
      the server does not refuse it (`desktop/src/skills.ts:396-397`).
      **For this effort specifically:** a verification skill documents how an agent
      drives an app and may well want to quote what the harness said. Put every such
      quote in a fenced block or a code span, and never write one bare in prose.
- [ ] **One frontmatter, whoever opens the file** — `check_one_frontmatter`,
      `crates/ft-server/src/skills.rs:859`, asked of the bytes and **failing closed**
      (`docs/skills.md:92-99`, `402-406`). Four clauses: the file opens with a line of
      exactly `---`; the first following line starting with `---` is exactly `---`;
      nothing inside the frame is a line break to one reader and text to another; and
      **every line inside the frame is one Firetower can read**. In practice: no
      trailing space after the opening `---`, no tab, **no BOM**
      (`docs/skills.md:386-394` — all three are fences Claude Code reads a
      frontmatter behind and Firetower refuses), no lone CR inside the frame (CRLF is
      fine, `:364-366`), no U+0085/U+2028/U+2029, keys at the left margin with
      `key: value` (`description : x` with a space before the colon is **refused**,
      `:104-113`), at most **one** level of nesting (three deep is refused whether or
      not it carries anything, `:230-237`), no flow mappings `{...}`, no flow
      sequences `[...]`, no YAML tags/anchors/aliases/directives, no `\u` escapes, and
      no colon-key like `license:a: b` (`:179-195`). Measured cost of all of that:
      **0 of 57** published and library `SKILL.md` hold a line this refuses
      (`:117-122`, `:231-234`).
      A block scalar **is** supported and is the recommended way to write a long
      description — `description: >-` — and both readers handle it
      (`docs/skills.md:272-279`).
- [ ] **The file itself declares `name` and `description`** in its own bytes; a JSON
      field beside them does not count. `declares(...)`,
      `crates/ft-server/src/skills.rs:589-594`; `docs/skills.md:239-245`.
- [ ] **Paths:** ≤ 256 bytes per path, ≤ 96 bytes per name; no leading `/`, no `\`,
      no `..`, no empty or `.` segment; plain **ASCII graphic** only; no leading
      space, no trailing space or dot; **no colon**; and **no `<` or `>` in a path** —
      "a path is written onto the worker and the agent sees it whenever it lists the
      skill's folder". `check_path`, `crates/ft-server/src/skills.rs:1858-1953`;
      `docs/skills.md:246-255`.
- [ ] **No two paths that differ only in case** — one file on macOS and Windows, two
      rows in the bundle, and the later write wins after every check passed on the
      earlier one. `crates/ft-server/src/skills.rs:478-506`.
- [ ] **No path that is a file for one row and a folder for another** — e.g. `scripts`
      as a file and `scripts/run.sh` as another. `crates/ft-server/src/skills.rs:518-541`.
- [ ] **Sizes:** at most **100 files**; body ≤ **256 KB**; any one file ≤ **2 MB**;
      the whole version ≤ **25 MB**. `crates/ft-server/src/skills.rs:37,54,56,59`,
      checked at `:462-467,474-476,509-515,542-547`; `docs/skills.md:675-677`.
- [ ] **`SKILL.md` is UTF-8.** `crates/ft-server/src/skills.rs:560-561`. Non-UTF-8
      files elsewhere are skipped as fonts or images, not refused (`:600-604`).

### Warnings — never refusals, but somebody reads them

`docs/skills.md:281-299`, implemented in `desktop/src/skills.ts:355-415`:

- [ ] No `README.md` inside the folder — "not read by anything" (`:409-410`).
- [ ] Body under 5,000 words / 500 lines; the client warns past 500 lines and
      suggests `references/`, "which costs nothing until it is opened" (`:411-412`).
      The refusal is far above it at 256 KB.
- [ ] Unknown frontmatter keys are named, with the agent that reads them
      (`:361-368`, `:413-415`).
- [ ] Folder name ≠ declared `name` (`:405-406`).
- [ ] Name collides with one an agent ships. `RESERVED` is
      `crates/ft-server/src/skills.rs:71-94` — `code-review`, `review`, `doctor`,
      `debug`, `batch`, `run`, **`verify`**, `loop`, `init`, `security-review`,
      `simplify`, `compact`, `clear`, `config`, `model`, `help`, `imagegen`, `plan`,
      `skill-creator`, `skill-installer`, `plugin-creator`, `review-agent`. Exact
      match (`is_reserved`, `:409-411`), so `verify-firetower` is clear and a skill
      called `verify` would not be.
- [ ] **The risk scan**, which is the one that matters here: `` !`cmd` `` in the
      body, `allowed-tools`, `hooks`, `scripts/`. `risk_of`,
      `crates/ft-server/src/skills.rs:389-405`; `docs/skills.md:299`, `§8`.

### Two consequences of the risk scan for `verify-firetower` specifically

1. **A name collision is a refusal at delivery even though it is a warning at
   import.** `docs/skills.md:290-298`: `set_for_session` sends *neither* of a
   colliding pair, the profile editor names the pair, and `POST /roles` and
   `PUT /sessions/{id}/skills` refuse a set containing one
   (`crates/ft-server/src/skills.rs:3285-3346`,
   `crates/ft-server/src/api/roles.rs:107-136`,
   `crates/ft-server/src/api/skills.rs:635-659`). This is option G's cost in one
   sentence: a library `verify-firetower` plus an aggregated repo
   `verify-firetower` is two of one name, and the agent gets neither.
2. **A bundle an agent publishes with `scripts/` is held for review.**
   `held_because` reads the bundle through `risk_of` and holds anything that runs
   (`crates/ft-server/src/delegate.rs:2379-2406`); the acknowledgement says "it
   runs nowhere until you do" (`:2588-2594`). A held skill has no
   `current_version_id`, reports as version 0, and is **skipped by
   `set_for_session` on every path** — so it cannot be made a default
   (`crates/ft-server/src/api/skills.rs:440-459`) and does not count in a
   profile's resolved set (`desktop/src/ui/config/SkillSources.tsx:70-80`).
   `verify-firetower` ships `control-firetower`, so under option E it is held on
   arrival and a human has to approve it before any QA agent sees it. That is one
   click, and it is a click that has to happen again on every version.

### Not established

- Whether the per-agent budget is refused server-side as `docs/skills.md:646-648`
  asks (see §3's Not established).
- The 5,000-word guidance is in the doc and the implemented warning is 500 lines;
  I did not find a word-count check anywhere. Treat 500 lines as the real
  threshold.

---

## Summary for #335

- The decision is **not** "repo-local or library". It is **"what reads it"**,
  because repo-local-and-nothing-else reads as nothing at all today.
- Three routes fire unprompted without product work: **the library (E)** on all
  four engines, with a pin, a version, a meter entry and an off switch; **the
  machine's `~/.claude/skills` (F)**, Claude Code only and unrecorded; and
  **profile instructions pointing at the committed file (B)**, which is not
  triggering at all, just telling.
- Two routes fire unprompted *with* product work: **one extra `--add-dir` (C)**,
  cheap and Claude-Code-only and against a stated principle; and **the aggregation
  (D)**, which is the documented long-term answer, is unbuilt, and is named as a
  separate piece of work in `docs/skills.md:739-745` and
  `docs/skills/key-decisions.md:281-285`.
- `docs/built-in-skills.md:271-279` has already answered the interim question for
  the neighbouring case: the library, as a repository default, until the
  aggregation lands.
- At rest, the pair #337 implies — `verify-firetower` plus `pr-screenshots` — is
  **~150 tokens every turn**, 7.5% of the smallest per-agent budget (2,000) and 5%
  of Claude Code's (3,000). Not a constraint. The constraint is discovery.

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

Portable across every agent: `name`, `description`, `license`,
`compatibility`, `metadata`, `allowed-tools`. Everything else belongs to one
agent — Claude Code has a dozen more (`when_to_use`, `arguments`, `model`,
`hooks`, `context: fork`, …), Codex reads `agents/openai.yaml`, Kimi has
`type: flow`. Cursor adds none of its own, and reads four other agents'
directories besides its own — see the table below.

A refusal never repeats the bundle verbatim. Everything quoted back — a
fence, a frontmatter line, a path — goes through one sanitiser that keeps 24
characters of printable ASCII and turns the two angle brackets, the backtick
and everything else into a dot. The frontmatter rule deliberately runs
*before* the forged-tag rule, so a refusal about a fence is often the first
thing to touch a file holding a forged tag, and the refusal is read by a
person and by an agent on the MCP routes. The backtick is in the set because
every one of those messages quotes inside a code span, and 24 characters
cannot forge a tag but are plenty to close the span and write markdown of
their own.

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
- `description` present, under 2,048 characters, says **what** and **when**.
  Was 1,024 — a round number no real skill had been measured against, since
  `claude-api`'s 1,068-character description only ever passed as the string
  `"|-"`. The corpus median is 319, so this is headroom, not a target; the
  aggregate guard is the per-agent budget in §3.
- No `<` or `>` anywhere in the frontmatter. It goes into the system prompt;
  angle brackets are an injection route and Anthropic forbids them outright.
  Checked on the *decoded* frontmatter, because a double-quoted scalar can
  spell one as `\u003c` — a rule that only looks for the character is one
  line away from being bypassed.
- No harness framing **anywhere in the bundle**: `<system-reminder>`,
  `<function_calls>`, a tag in the `antml:` namespace, a forged `<invoke>`, and
  the rest of `FORGED_TAGS`. Checked in every UTF-8 file, not only `SKILL.md`
  — a `references/` file is opened into the same context on the same turn, so
  a forged frame there arrives exactly as it would from the body. Anything
  that is not UTF-8 is a font or an image and is skipped.

  Two things this is deliberately **not**. It is not a bracket ban: 15 of the
  26 skills Anthropic and OpenAI ship have `<` or `>` in their bodies, because
  `docx` has to quote `<w:r>` and `skill-creator` has to write `<skill-name>`.
  And it is not triggered by a tag inside a code span or a fenced block, which
  is a tag being *discussed* — `claude-api` names `<system-reminder>` in three
  reference files, one of them to explain that the pattern is forgeable, and
  refusing a skill for documenting the attack it defends against would be the
  wrong trade. A line whose backticks do not pair up is read as prose, so a
  single stray backtick is not a hiding place. The client additionally *warns*
  on the code-span case; the server does not refuse it.
- **One frontmatter, whoever opens the file.** `SKILL.md` opens with a line of
  exactly `---`, the first line after that which starts with `---` is exactly
  `---`, nothing inside that frame is a character one reader ends a line on
  and another calls text, and **every line inside the frame is one Firetower
  can read.** Refused when any of the four cannot be established, rather than
  skipped — see §2, which is where the measurements are. This is the one rule
  that **must** fail closed: it is asked about where the frontmatter ends and
  what is in it, so a parse of it is not evidence about it.

  The fourth clause is the same principle as the first three, one level down,
  and it was a live injection route for one round longer than they were. The
  reader's key is `[A-Za-z0-9_-]+` before a colon at the left margin, and a
  line that did not match was **dropped** — so `description : x`, with one
  space, was a key Firetower never saw and YAML reads fine. The bracket rule
  then had nothing to inspect, the risk scan nothing to find, and a forged
  `<system-reminder>` reached a system prompt through bytes that were
  accepted. Measured against Claude Code 2.1.273, reading the pair it renders
  rather than only whether it parsed: `description : X`, `"description": X`,
  `'description': X`, the explicit-key `? description` form and a whole
  mapping indented two spaces are all read by it; a **tab** before the key is
  the one inert member, and gives the same answer as a description that is
  simply absent. The frame was perfectly canonical in all six.

  So a line in a frontmatter is blank, a comment, `key: value` at the left
  margin, a `- list item`, an indented `key: value` under one, or part of a
  block scalar already open — and anything else is refused. The cost was
  measured the same way the frame rule's was: **0 of 87** published and
  library `SKILL.md` hold a line this reader drops.

  **And a value this reader did not fully read is refused for the same
  reason, with the reader itself being the thing that says so.** A line it
  cannot read is a key the agent has and Firetower does not; a value it did
  not decode is a *character* the agent has and Firetower does not, which is
  the same hole for the bracket rule below. So
  `license: {a: "\u003csystem-reminder\u003e"}` was accepted — the bracket
  rule asked about six characters while libyaml hands the agent a `<`.

  The rule is one sentence and it is deliberately not a list of shapes:
  **reading a value means decoding it, and the decoder reports whether it
  did.** A quoted scalar is decoded, escapes and all. A plain or a block
  scalar means exactly what it spells, because YAML processes no escapes in
  either. Anything else is kept as the characters that spell it, and that is
  not a reading of it — so it is refused, by name, from inside the decoder.
  A flow mapping, a tag, an anchor, an alias and a directive are all refused
  without being named anywhere, because what is *allowed* is stated instead:
  YAML's own rule for what a plain scalar may begin with.

  **And that rule is asked of a position, because it is three productions
  and not one.** A plain scalar may not begin with an indicator wherever it
  sits; inside `[...]` a `,` `[` `]` `{` or `}` ends one wherever it appears;
  and a `: ` ends one and makes the element a **mapping** wherever a mapping
  is legal. That last clause was written as though it were a flow rule, and
  it is not: a `- ` entry spelled `a: "…"` is a block mapping too, so

  ```yaml
  metadata:
    - a: "\u003csystem-reminder\u003e"
  ```

  came back as the one string `a: "\u003csystem-reminder\u003e"` — no
  bracket anywhere for the rule below to find, nothing reported as undecoded,
  and libyaml handing the agent the tag. The negative control is what names
  the cause: `  - a:"\u003cx\u003e"`, with no space, really *is* a plain
  scalar, both readers read the same one string, and it is correctly
  accepted.

  **Measured inert against Claude Code 2.1.273**, re-derived against a
  loopback capture sink reading the `name: description` pair it renders:
  `description: "\u003cCCPOS\u003e"` → `probe-skill: <CCPOS>` is the
  positive control and reproduces, while shape 7 under `metadata` and under
  `description` both render `Do the thing.` with **0 occurrences** of the
  marker anywhere in the request. The control that says *why* is a third
  row: the same entry with a plain `"CC7BARE"` and no escape at all is also
  absent, so Claude Code puts no `metadata` into the prompt and this is not
  an escape failing to decode. So the demonstrated reach is a libyaml-family
  reader — the same evidentiary position as the flow-sequence shape above.

  The position matters in the other direction too, which is why the clause is
  not simply applied everywhere. After a `key:` a second `: ` is not a
  nesting at all — libyaml refuses the document — so refusing it there closes
  no differential and costs three published skills (`firetower-artifacts`,
  `firetower-surfaces`, `pr-screenshots`: issue #275, the ones libyaml
  already refuses). Where a mapping *is* legal it costs **0 of 87**.

  That shape matters more than the list it replaced, and the reason is this
  area's history. The first version of this rule was a separate predicate
  sitting *beside* the decoder, guessing from a value's first and last
  characters what the decoder was about to do — and it was wrong in two
  places at once. A flow sequence was only ever split at the left margin, so
  in a nested or a list position the escapes inside one survived untouched
  with nothing reporting it; and `description: "a\"` ends on a quote that is
  not a close, so a scalar libyaml had not finished reading looked complete,
  and libyaml folded the next line — key and all — into `description`. Both
  were accepted. A rule that approximates the reader instead of being
  produced by it is the shape every round of this bug has had.

  **One level of nesting is all this reader models, and that is now a
  statement it keeps.** It used to fold every nested pair into a single flat
  map whatever its indentation, so a key three levels deep landed beside its
  own parent's siblings and a later sibling of the same name overwrote it —
  *after* it had been decoded. `metadata:` / `  a:` / `    b: "\u003c…"` /
  `  b: plain` left a frontmatter with no `<` in it anywhere for the bracket
  rule to find, while libyaml keeps it at `metadata.a.b` and hands it to the
  agent. The root keys agree, so no comparison of *keys* says a word about
  it; it was found by the property in §2 comparing the characters the two
  readers deliver, which is the only reason anybody knows about it.

  Measured against libyaml — pyyaml's `CSafeLoader`, Ruby's Psych, and
  `serde_yaml` over `unsafe-libyaml` in the tests — with the controls that
  matter: a **plain** scalar and a **single-quoted** scalar process no
  escapes in YAML either, so the escape is six characters to both readers
  there and nothing is refused. Claude Code 2.1.273 renders the literal six
  characters for both, and **decodes `\u003c` in a double-quoted scalar** — so
  the escape class is live against it too, and the exemption is right in three
  readers rather than two. *(Claude Code measured by the security review of
  `d408c3c2`, against a loopback capture sink reading the `name: description`
  pair it renders into the system prompt, with positive and negative controls.
  Not re-derived here; the independent evidence in this section is libyaml, in
  three bindings.)* **87 of 87** published and library `SKILL.md` are
  accepted: 0 hold a flow sequence, a brace, or a `\u` escape anywhere in
  their frontmatter, 0 nest three deep, and 0 hold a block sequence entry
  with a `: ` in it. The one cost is honest and worth
  naming: a frontmatter nested three levels deep is refused whether or not
  that instance carries anything, for the same reason a dropped line is — a
  parse of the frontmatter is not evidence about the frontmatter.

  And the rule that the file has to **declare** a name and a description is
  asked of the bytes for the same reason. It used to read the `frontmatter`
  the client sent, so `name : probe-skill` was accepted with the file's own
  frontmatter holding no `name` at all — the exact outcome the rule exists to
  prevent, reachable through the rule's own blind spot. A bundle whose bytes
  omit the key while the JSON beside them supplies one is the other half of
  that, and only asking the bytes closes both.
- A path inside the bundle is at most 256 bytes and each name in it at most
  96. A longer one is a row in a bundle that is not a file any worker can
  create, which is the same defect as a path that has to be a file for one row
  and a folder for another.
- **No `<` or `>` in a path.** The forged-tag rule above reads file
  *contents*, and a path is read too: it is written onto the worker and the
  agent sees it whenever it lists the skill's folder. So
  `references/<system-reminder>…</system-reminder>.md` was accepted outright.
  Refusing the two characters is one rule rather than a second tag list, and
  no name in the published corpus holds either.
- No `claude` or `anthropic` in the name — reserved.

All of these are asked of the bytes in the bundle, not of the `frontmatter`
and `body` the client sends alongside them. Those are a parse the client did
and could have done generously; the bytes are what is written onto a worker
and read by the agent. `PATCH /skills/{id}` is held to the same bracket rule
as import, since it writes the description the listing renders.

**And asked of a parse of those bytes is not the same as asked of the bytes.**
The first attempt at the frame rule above ran inside `if let Some(region) =
frame(said)` with no `else` — a rule about where the frontmatter ends, gated
on this reader finding where it ends. Three opening fences make `frame`
decline and Claude Code 2.1.273 reads a frontmatter behind all three, so the
rule was skipped exactly when it was needed. A check that can be turned off by
the thing it is checking is not a check.

Reading the file is `read_frontmatter` in `crates/ft-server/src/skills.rs`,
mirrored by `split` in `desktop/src/skills.ts`. Neither is a YAML library, but
both read **block scalars** — `description: >` is how a description long
enough to be useful is written, and Anthropic's own `academy-guide`,
`discernment-nudge` and `claude-api` write it that way. Read as a plain scalar
it comes out as the string `">"`, which loses the description and then trips
the bracket rule above for a character the author never wrote as content. The
block-scalar and escape cases in both test suites were taken from libyaml.

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

One shape for all of them: **a directory of skill bundles belonging to one
session.** Most already have a per-session home for exactly this reason.

| Agent | Per-session root | How | Verified |
| --- | --- | --- | --- |
| Claude Code 2.1.273 | `<root>/.claude/skills/<name>/` | `--add-dir <root>` | Yes. The `init` frame listed it. Symlinked bundles load. |
| Codex 0.156.1 | `$CODEX_HOME/skills/<name>/` | already per session | Yes. `skills/list` returns `scope: "user"`. |
| Kimi Code 2.1.1 | `$KIMI_CODE_HOME/skills/<name>/` | already per session | No. Read out of the binary; `session/new` needs an account. |
| Cursor Agent 2026.09.28-64d2043 | `$HOME/.cursor/skills/<name>/` | already per session — Cursor's home *is* `HOME` | Partly. Read out of the binary: it scans `<config>/skills` for `.cursor`, `.claude`, `.codex`, `.grok` and `.agents` under both the project root and `homedir()`, and its ACP session lists them as commands. Not yet confirmed against a signed-in session. |

**Cursor reads five of these, including other agents' names.** `.claude/skills`
and `.codex/skills` are on its list, so a checkout that has them gets them
whether Firetower put them there or not — and the project root is shared by
every session in a workspace. `.cursor/skills` under the relocated home is the
one place that is this session's alone.

**Cursor caches the list.** `loadCommandsAndSkills` memoises on first use, so
the `/`-menu it advertises over ACP is the set that existed when the session
opened. Whether the *model* re-reads the directory on a later turn is the
thing to check live; the menu is not evidence either way.

One capability method on `Agent`, beside `home_var`. Never a `kind ===
"ClaudeCode"` in a client.

**Where the `claude` binary is, because it was twice reported as absent.** Not
on `PATH`, not under `~/.claude`, not in any `node_modules` — it is at
`~/.firetower/worker/agents/claude-code/<version>/bin/claude`, which is how a
worker session has one at all. Probing it needs no account: skills load before
the auth check, so pointing `ANTHROPIC_BASE_URL` at a loopback sink that
answers every request with a 400 is enough to read the system prompt it built.
Every Claude Code row in this document was measured that way.

### What each agent calls a line break

**Firetower writes the same bundle to every agent, and they do not agree about
where a frontmatter line ends.** YAML 1.1 ends one on five characters; YAML 1.2
narrowed it to LF and CR, and the readers are split across the change. So a
description holding U+2028 is one field to one agent and two to another — and
the second field can be `allowed-tools` or `hooks`, which §8 is about.

| Reader | Ends a line on | Verified |
| --- | --- | --- |
| Firetower `read_frontmatter` | **LF only** | Yes. `split('\n')`, then `trim_end_matches('\r')` on each line — so a CRLF file works because the CR is trimmed off an ending, never because it is one. A **lone CR** is ordinary text here. |
| Claude Code 2.1.273 | LF, CR | Yes. Probed with a payload valid only if split: U+0085, U+2028 and U+2029 all left the frontmatter a single field. |
| libyaml / `unsafe-libyaml` | LF, CR, U+0085, U+2028, U+2029 | Yes. pyyaml's `CSafeLoader` and `serde_yaml` both read an injected `allowed-tools` from one line. |
| Codex 0.156.1 | — | **No.** Its binary links `serde_yaml` and `unsafe-libyaml`, so a libyaml reading is the inference; that those are what it parses a skill's frontmatter *with* was not observed. |
| Kimi Code 2.1.1, Cursor Agent | — | **No.** Not probed at all. |

That is a **four**-character difference, not three, and the fourth is the
dangerous one. The row above once read *"LF, CR"* for Firetower while citing a
split on LF; the disputed set was worked out from that row and came out one
character short. **A lone CR is the one of the four that is a line break to
Claude Code** — U+0085, U+2028 and U+2029 are ordinary text to it, so they
reach only a libyaml-family reader, where they *break* a skill. The CR
*injects*, into the agent this control plane mostly writes for. So the rule
and the rows are no longer written out side by side: `FIRETOWER_BREAKS`,
`CLAUDE_CODE_BREAKS` and `YAML_1_1_BREAKS` are one statement each, this table
transcribes those three, and `DISPUTED_BREAKS` is computed from them.

The rule is **a CR not followed by LF**, never a CR: CRLF is a line ending
every reader here puts in the same place, and a blanket ban would refuse every
CRLF-authored `SKILL.md`.

### Where the frontmatter ends

The characters are only half of it. **The other half is the frame**, and it
was the live route: a rule asked of the region *Firetower's* parser delimits
is gated on the very parse that is in dispute, so anyone who could make that
parser decline got the rule skipped while the agent read the frontmatter
perfectly well.

Probing Claude Code needs no account: skills load before the auth check, so
`claude -p --debug --debug-file <path>` in a directory with a planted bundle
logs `Failed to parse YAML frontmatter` for a frontmatter it rejected and
nothing for one it accepted. That one bit is enough, given a payload valid
only one way round. Reading the parser out of the binary is not — it is one
packed Mach-O and every YAML signature greps to zero.

Measured that way, in both polarities, because a table of fences that all
error proves nothing about whether the fence or the contents caused it:

| Opening fence | A valid frontmatter behind it | Invalid YAML behind it | |
| --- | --- | --- | --- |
| `---LF` | loads, `project: 1` | **parse error** | read — and `frame` accepts |
| `---CRLF` | loads, `project: 1` | **parse error** | read — and `frame` accepts |
| `"--- "LF` | loads, `project: 1` | **parse error** | read, and `frame` **declines** |
| `"---TAB"LF` | loads, `project: 1` | **parse error** | read, and `frame` **declines** |
| `BOM`+`---LF` | loads, `project: 1` | **parse error** | read, and `frame` **declines** |
| `"--"LF` | loads, `project: 1` | loads, `project: 1` | not read — the control |
| no fence at all | loads, `project: 1` | loads, `project: 1` | not read — the control |

An error that tracks the region's *contents* and disappears when those
contents are valid can only arise if the region is being parsed; the last two
rows are what says so, because they are the same invalid payload not being
parsed. So three fences Firetower cannot read are three fences Claude Code
reads a frontmatter behind.

So `skills::check_one_frontmatter` is asked of **the bytes**, and **fails
closed**: the file opens with exactly `---` and a line ending, the first line
after it that starts with `---` is exactly `---`, and nothing in that frame
reads as a line break to one reader and as text to another. A file whose
frame cannot be read is refused, not skipped.

The closing half of that is precaution rather than a hole: Claude Code 2.1.273
closes the frontmatter where `read_frontmatter` does, on `--- ` and `----` and
`---notakey: y` alike. But `read_frontmatter`'s close is the loosest rule of
the three and so gives the *smallest* region, and a rule asked of the smallest
region says nothing about what a reader with a stricter close reads as
frontmatter. Making the two the same line takes that whole dimension out of
the dispute instead of waiting to measure the next reader.

**It costs nothing real.** Of the 25 skills Anthropic and OpenAI publish, 25
open with exactly `---LF` and 25 close with a line of exactly `---`; so do all
12 bundles on the machine this was measured on. None use CRLF, and `---CRLF`
is accepted anyway, because Claude Code and `frame` agree about it.

And the rule is asked again when stored bytes are **published again** —
`approve`, and `merge_into` when it adds a version. Those turn bytes checked
under whatever `check()` existed on the day they arrived into bytes a worker
writes, which is a gap no amount of checking on the way in closes. Only that
one rule, not the whole of `check()`: re-running the path and collision rules
there would refuse a legacy skill for the shape of a filename it has had all
along, at a moment nobody was asking about filenames.

**Not project scope.** One workspace holds several sessions with different
agents and different selections; project scope is shared by all of them. Kimi
resolves its project root by walking up for `.git`, which in a workspace finds
nothing — or finds the wrong thing. And when `RepoSpec.path` is empty, a
project directory lands inside the git worktree and turns up in the pull
request.

**Not `CLAUDE_CONFIG_DIR`.** It works, but it hides the host's own `~/.claude`
— their settings, their skills, their plugins. Keep it as the fallback.

### The property, and why the oracle is libyaml itself

Each rule above closes the variants somebody has thought of. **The property
closes the next one without anybody having to think of it first**, and after
five rounds in this area it is the only thing that ends the sequence rather
than continuing it:

> For every bundle `check()` accepts, the readers agree — about the keys they
> find **and about the characters they deliver**.

Asserted as a gate rather than as a test. Every test that puts a bundle
through `check()` goes through `checked`, so the property is asked about all
of them, and a direct `check()` that accepts is itself a test failure — the
one way the gate could go quiet without anybody noticing.

Three things are compared, and the second two exist because the first was not
enough:

1. **The keys, against a reader looser than Firetower's on every axis** — one
   that skips a byte-order mark, opens on anything starting with `---`, splits
   on all five of YAML 1.1's line breaks, takes a quoted or an explicit `?`
   key, and finds the root mapping wherever it is indented to.
2. **The keys, against libyaml itself**, which is `serde_yaml` as a
   `[dev-dependencies]` entry. The model in (1) is built on *more* — more
   breaks, more spellings — so it assumes the other reader's keys are a
   superset of Firetower's, and libyaml can find a **subset**: a quoted
   scalar that does not close on its line swallows the following line, key and
   all. On that whole family the model returned exactly Firetower's own answer
   and the property was silent.
3. **The characters libyaml ends up handing the agent**, every one of which
   has to be a character Firetower also saw. This is the one that generalises,
   because it is what the bracket rule is actually about: that rule exists so
   a `<` does not reach a system prompt, and it can only do that if the text
   it inspects is the text the agent gets. Any route that decodes a character
   Firetower never saw fails it, named or not.

Containment rather than equality in (3), and the direction is the security
question: a character libyaml delivers that Firetower never saw is one the
agent is handed and no rule inspected. The other way round — Firetower holding
more than libyaml, which is what it does with a `~` or a `1e3` — is only this
reader being blunter than the standard, and no rule is blind to it. Whitespace
is dropped on both sides, so two readers' *folding* of a `description: >` is
not a disagreement.

**A real dependency rather than a model of one.** `ft-server` has no YAML
library and should not: `read_frontmatter` is deliberately small and
deliberately the same shape as the desktop client's, and a parser in the
server would be one that disagrees with the client. None of that is an
argument about test code, and an oracle that *is* libyaml cannot be weaker
than libyaml. The hand-written one was.

**And the property is asked of a corpus generated from YAML's node grammar,
not from a list of value shapes somebody thought of.** That distinction is
not theoretical, and the measurement is this area's whole history: three
successive rounds each ended with a value shape found by hand *after* the
previous fix, and the last of them — a block mapping as a block sequence
entry — was assembled in twenty minutes from parts the generator already
carried separately. `[a: "…"]` was in its list and the `- ` position was in
its list, and the product was never taken. The gate was sound. The corpus was
an enumeration.

So the corpus is the cross product of **node kind × depth × position ×
escape**: fourteen productions — plain, single-quoted, double-quoted, a
double-quoted scalar that does not close where it looks like it does, literal
and folded block scalars, flow and block sequences, flow and block mappings,
a tag, an anchor, an alias and a merge key — composed up to three deep, in
seven positions, with the escape and without, over four keys. **12,544
bundles**, with one grammatical restriction (block content is not legal
inside a flow collection) and one node property restriction (at most one tag
and one anchor on a node). Everything the product produces is spelt, so
adding a production is meant to be impossible: the list of kinds is walked
from an exhaustive match, so a kind added to it does not compile until it has
a place, and the verdict then refuses a corpus that does not produce it.

**The verdict is per family, not an aggregate floor, and that is the half
that was missing.** The old gate asserted that the corpus held more than
fifty disagreements. That pins *the corpus is interesting* and cannot pin
*the corpus is interesting about the thing the rule is for*: measured, taking
the entire escape class out of the generator left **186** disagreements and a
passing test, because the deep positions manufacture one from any value at
all. A lost family does not trip a number taken over all of them. So each
family is asked for its own evidence, in characters:

- it is produced at all, in every position, at more than one depth, and both
  with the escape and without;
- nothing in it is accepted while libyaml hands the agent a character
  Firetower never saw;
- and it owes either a **decode** — libyaml delivering a character that is
  nowhere in the bytes, which is the class itself — or an **exemption**: an
  accepted bundle where libyaml delivers the escape's own spelling and
  neither bracket, which is the control that stops the rule from being
  "refuse anything with a backslash in it".

**Both halves are run rather than described.** One test removes each of the
fourteen families in turn and asserts the verdict fails *and* that what is
left would still pass an aggregate floor — hundreds of disagreements, both
answers, and a hole nobody would have seen. Another replaces the escape with
ordinary letters, which leaves 5,703 disagreements and no decode anywhere,
and asserts the verdict fails for the escape rather than for the shape of the
corpus. A gate nobody has watched fail is a gate nobody has tested.

The measured two-sided result, over 934 payloads from two independent
enumerations: at `d408c3c2`, 293 accepted with **72** where libyaml delivered
a character Firetower never saw and 11 key disagreements; with the rules
above, 172 accepted with **0** and **0**. The same oracle, the same payloads.
And over the **87** unique published and library `SKILL.md` on a worker:
**87 accepted, 0 refused, 0 disagreeing** — with 3 of the 87 refused by
libyaml outright, which is issue #275 and not a security finding, since a
reader that refuses the document finds no keys to disagree about. (The
security review measured 57 and 4 on its own snapshot; more sessions have
materialised bundles on this machine since, and the conclusion is the same
one. 29 of the 87 open a value with a double quote, 0 hold a flow sequence, a
brace, a `\u` escape or three levels of nesting, and 0 hold a block sequence
entry with a `: ` in it.)

**Where the grammar stops, and it is named rather than implied.** Ten of
fifteen clause-removing mutations of the reader are caught by the corpus. The
five that are not, each measured: the flow-indicator clause (libyaml refuses
every document the clause's absence would let through, so there is no reading
to disagree with); `*` in the indicator set (an alias needs an anchor, and
the anchor's `&` is refused by the same clause, so an alias can never reach a
reading here); the text-after-a-close clause (libyaml refuses the document —
the claim about it was always the weaker one); the `''` clause (removing it
is strictly *more* refusing, so no disagreement can appear); and a `-` with
nothing after it (the mutation makes Firetower read and decode what libyaml
keeps as spelling, which is the safe direction). The frame and key classes
have their own grammar and their own two oracles; this one is the value
grammar.

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

   **A badge earned by parsing is only as good as the parse.** The badge is
   the human gate, so a badge that is *wrong* is worse than one that is
   absent — and `allowed-tools : Bash(curl:*)`, one space, was a key neither
   Firetower's reader nor the client's saw and Claude Code honours, so the
   review screen read "no tools, no hooks" about a bundle carrying both. That
   is why §1's fourth clause refuses a line it cannot read instead of
   skipping it, on the server and in the client's own reader: the badge can
   only describe what somebody read.
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

Worth knowing but not a blocker: this is a question about the machine a
workspace runs on, and never about the control plane. Firetower runs no agents
in its own container — it has no git, no tmux, no Node and no Python, by
design — so the only thing that has to be able to read a `.docx` is the VM or
the Mac mini the work is on.

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

# Built-in skills, and the library that shows them

Scoping. What a first-party skill is, how one arrives and survives an upgrade,
and what the library screen should look like once there is more than one kind
of thing in it.

Not a specification: the reasoning, so that reopening a question later does not
mean re-deriving it differently.

---

## 1. Where this came from

The artifact contract — *write it to `.firetower/artifacts/<name>/index.html`* —
is currently appended to the **system prompt of every Claude Code session**.
That was the right fix for the bug it solved (a file the agent never read), and
it is the wrong shape long-term, for a reason `docs/skills/key-decisions.md`
already states:

> a capability skill pushed onto somebody who does not need one is pure cost:
> its description is in the system prompt on every turn, for nothing.

Which is exactly what that guidance now is. The numbers:

| | At rest, every turn | When it is actually used |
|---|---|---|
| In the system prompt (today) | ~250 tokens | ~250 tokens |
| As a skill | **~30 tokens** (frontmatter) | ~250 tokens |

A skill is the mechanism built to avoid this, and it is roughly **eight times
cheaper at rest**. The artifact guidance is the first customer; it is not the
reason to build this.

The reason is that Firetower will ship more of them. There is Firetower-specific
competence that is not taste and not a contract — how previews and annotation
work, what `.firetower/` holds, how per-session Docker teardown behaves — and
today there is no way to ship any of it.

---

## 2. What is there now

The library is **Configuration → Skills** (`desktop/src/ui/config/Skills.tsx`).
It works and is not the problem:

- a flat list of rows, with a search over name, description and author;
- already split two ways — what you can manage, and what is shared with you,
  which is `mayShare` standing in for "is this at my own root";
- tick several, share or delete them together;
- a detail view with the bundle, its versions, and where it is on by default;
- import by dropping a folder, which is the only way one arrives.

What it has no concept of is a skill that **Firetower itself** provides.

---

## 3. What makes a skill built-in

The temptation is a `source` column and a special case through every query. The
cheaper answer is that this is a question the path already answers.

**A built-in is an ordinary Placed skill, filed in a system directory that
Firetower owns.** `d/firetower`, created at setup exactly as `d/shared` already
is (`access.rs:1367`), with the organisation's `everyone` team granted viewer on
it (`everyone_team`, `access.rs:497`).

Everything falls out of that and nothing is invented:

| Wanted | How it already works |
|---|---|
| Visible in the library | it is a row like any other |
| Available to the whole organisation | a grant to `everyone` on one directory |
| Not deletable by a user | `may_share` refuses: nobody has writer on `d/firetower` |
| Grouped under its own heading | the path says `d.firetower.…` |
| Shown as not-yours | `mayShare` is already false for it |

The one thing to add is that the directory is **system-managed**: `delete_directory`
and `set_grant` refuse it by name, the way `FiledKind::Repository` is refused by
name from filing. A directory somebody can revoke their own organisation's
access to is a support ticket waiting to happen.

### Why not place it from the worker instead

An earlier draft had the worker write the bundle straight into the session's
skills directory, bypassing the database entirely. It is less code and it is
wrong for what is being asked here: a skill nobody can see in the library cannot
be read, cannot be turned off for a session that does not want it, and cannot
have its cost accounted for. Invisible is not the same as built-in.

---

## 4. How one arrives, and what an upgrade does

Bundles ship inside the control plane binary with `include_str!`, so there is no
fetch, no network at setup, and no missing-file failure mode.

**On start-up**, for each bundled skill: if `d/firetower/<slug>` does not exist,
create it. If it exists and the bundled bytes differ from the current version,
**add a version**. `skill_versions` is already append-only and content-addressed,
so an unchanged bundle costs one hash comparison and writes nothing.

**A running session is unaffected**, because a session pins a version
(`docs/skills.md`) — which is the existing answer to "what happens if this
changes underneath me", and it is the reason this upgrade path is safe rather
than something to design.

**What an administrator may do**: nothing, for now. No rename, no delete, no
edit. That is a real constraint and §8 asks whether it is the right one.

---

## 5. The library, redesigned

### The grouping

Three sections, and they are the three the path already encodes — the same split
the artifacts library landed on:

1. **From Firetower** — `d.firetower.…`
2. **Yours** — `u.<you>.…`
3. **Shared with you** — any other directory you hold a grant on, labelled with
   the directory it is in

No "Discover" tab. The product this is modelled on has a directory to browse;
Firetower has none, and a tab that only ever shows an empty state teaches people
the feature is broken — the same reason the artifact scopes only appear once
there is something in them.

### The shape of an entry

Here the reference screenshot and this product disagree, and it is worth saying
where before building.

The thing that identifies a skill is **its description**. Not an icon — a skill
has no icon and inventing one per skill is decoration standing in for
information. The description is also, literally, the text that goes into the
model's context, so it is the one field a person has to be able to read
properly. Two lines of it, at full width, is the entry.

And Firetower knows something no other skills interface does: **what a skill
costs**. `tokens` is already on the row. `docs/skills.md` is explicit that the
description is in the system prompt every turn and that there is a per-agent
budget — Codex stops listing skills past about eight thousand characters of
them. A library that shows the running total is telling somebody something true
and useful that nobody else shows them.

So the proposal is: wide two-column entries in Firetower's own density — name,
two lines of description, and a meta line carrying the cost — with a budget
total per section. Closer to the reference than today's bare rows, without
borrowing the icon tile or the marketplace furniture.

```
  FROM FIRETOWER                                        2 skills · 340 tokens

  ┌──────────────────────────────────┐ ┌──────────────────────────────────┐
  │ firetower-artifacts        on    │ │ firetower-previews        off    │
  │ Publish a page for somebody to   │ │ Reach a port a session is        │
  │ look at — a mock-up, a chart…    │ │ serving, and annotate it…        │
  │ 170 tokens · v3                  │ │ 170 tokens · v1                  │
  └──────────────────────────────────┘ └──────────────────────────────────┘

  YOURS                                                 6 skills · 1,210 tokens
  …
```

---

## 6. The skill itself

`firetower-artifacts`. Thin on purpose — the contract, not a recipe. Taste is
`web-artifacts-builder` and whatever house style somebody imports, and those
belong in the library where they can change without shipping a binary.

The description is the whole triggering mechanism, so it names what it does and
the phrasings that should reach it, including the ones that never say
"artifact":

```yaml
name: firetower-artifacts
description: >-
  Publish a page for somebody to look at — a mock-up, a page, a chart, a
  report, a prototype — so it appears in the Firetower conversation, opens
  full screen, and can be annotated. Use this whenever somebody asks to *see*
  something rather than change the repository: "show me", "mock up", "make a
  page", "visualise this", "build a dashboard", "create an artifact". Use it
  even when the word artifact is never said.
```

The body is the contract already proven in `ft_core::ARTIFACT_GUIDANCE`: the
path, one self-contained file, an origin with no network, same name means a new
version, outside git — and the paragraph handing off to a richer skill when one
is installed.

**The system prompt keeps one line**: the path. A skill still has to be chosen,
and the bug this all started from was an agent not reading something it had been
left. One line is cheap insurance against the same failure in a new costume.

---

## 7. Not in this

- **A marketplace.** No Discover, no featured banner, no install counts. Skills
  arrive by being dropped, and until that changes a browse surface is furniture.
- **Icons per skill.** Decoration standing in for the description.
- **An editor.** `config/Skills.tsx` says why, and nothing here changes it.
- **Taste.** Firetower ships the contract. The design system is yours.

---

## 8. Decided

1. **On by default.** A departure from `key-decisions.md`'s *labelled and not
   ticked*, taken deliberately. That rule is about capability skills pushed on
   people who do not need them; this one describes how a Firetower feature
   works, which is closer to convention — and convention is the kind the same
   document says is worth everybody having.

2. **Undeletable from the organisation, always untickable for a session.**
   Nobody can remove it from the library; anybody who never publishes can stop
   paying its thirty tokens.

3. **Not overridable.** A skill of the same name at somebody's own root does
   *not* shadow it. The built-in carries the contract — where a file has to be
   for anybody to see it — and a contract that any skill can replace is not a
   contract.

   This is why the skill itself has to separate its two halves out loud. The
   **delivery** is fixed and the **craft is explicitly overridable**: another
   artifact builder's typography, components, palette and build tooling all win,
   so long as what it produces ends up at the path Firetower watches. The skill
   says so in as many words, because an agent holding two sets of instructions
   needs to know which one yields.

4. **The cost total is out.** Interesting, easy to read as nagging, and not
   what anybody came to this screen for. Revisit with a reason.

---

## 9. Rough size

| | |
|---|---|
| `d/firetower` at setup, granted to `everyone`, refused by `delete_directory` | small; `d/shared` is the template |
| Seed and upgrade bundles from `include_str!` on start-up | small; content-addressing already decides when to add a version |
| The `firetower-artifacts` bundle | mostly written — it is `ARTIFACT_GUIDANCE` |
| Trim the system prompt to one line | one constant |
| Library: three sections, wider entries, cost totals | the real work, and all of it in one file |

Nothing here is new machinery. The whole of it is one system directory, a seed
on boot, and a screen that groups by a path it already has.

---
name: skill-creator
description: Write a new skill, or improve an existing one, and save it to the person's Firetower library. Use this whenever someone asks you to make, create, write, turn something into, or edit a skill — or describes a repetitive workflow and wants it captured — even if they never say the word "skill". Reach for it before writing a SKILL.md by hand.
---

# Skill Creator

A skill for writing skills and saving them into Firetower, so the person never
has to copy a folder into the editor by hand. You write it; the `create_skill`
tool saves it; it appears on their Skills screen.

A skill is a folder of instructions an agent loads only when it needs them. One
file is required — `SKILL.md`, whose frontmatter carries the name and the
description, and whose body is the instructions. Everything else is optional
support beside it: `references/` for docs read on demand, `assets/` for
templates used in the output, `scripts/` for code.

## How to work

Figure out where the person is and move them forward — don't make them answer a
questionnaire before anything happens.

1. **Capture the intent.** Often the conversation already holds it ("turn this
   into a skill"): pull the steps, the tools, the corrections, the input and
   output formats out of what has already happened. Fill the gaps by asking,
   and confirm before you write.
2. **Write the draft.** A page of instructions, and a description written to
   trigger (below). Keep `SKILL.md` short; push long reference material into a
   `references/` file and point at it.
3. **Save it with `create_skill`.** Pass `name`, `description`, `body`, and any
   bundled `files`. The frontmatter is composed for you from the name and
   description, so the body is just the instructions.
4. **Iterate with `update_skill`.** Refinements are new versions; only the
   fields you send change, and the other files carry forward.

Run `list_skills` first, so you sharpen an existing skill rather than make a
near-duplicate of one they already have.

## The description is the whole triggering mechanism

The name and description are the only part always in the model's context — they
are what decides whether the skill ever fires. Spend your effort here.

Write what it does **and** when to reach for it, in one line, and be a little
pushy: models under-trigger skills, skipping them on tasks they could have
helped with. So instead of "Formats release notes.", write "Turns RFC notes
into a changelog entry in the house format. Use this whenever the person
mentions a changelog, release notes, or shipping a version, even if they don't
say 'skill'." Name the triggers; name the output. No angle brackets — the
description is rendered into a system prompt.

## Writing the body

- **Imperative voice.** "Read the diff first", not "the skill reads the diff".
- **Say why, not just what.** A line the model understands the reason for is one
  it applies in a case you didn't foresee — better than a wall of MUST.
- **Pin down the output.** When the shape matters, give the exact template the
  skill fills in, with a short worked example of input and result.
- **Progressive disclosure.** Keep `SKILL.md` to roughly a page. When it grows,
  add a layer: move the detail into `references/`, and tell the model when to
  go read it.
- **One job per skill.** A skill that does three unrelated things triggers for
  none of them well. Split it.

## Scripts, and the review that follows

A skill can carry a `scripts/` file — code that runs on the machine of every
session that uses the skill. Offer one only when a deterministic step is better
as code than as instructions (a parser, a build, a fixed transform), and write
it to do exactly what the skill says and nothing surprising.

When you save a skill that ships a script, Firetower holds it for the person's
review before it can run — they approve it on the Skills screen after reading
what it does. Tell them that is what happened, rather than implying it is
already live. Never write a skill whose real behaviour differs from what its
description claims.

## Filing

A skill is the person's own by default. If they want a teammate to have it, pass
`directory` with the name of a directory they can write to, and it is filed
there — the same sharing every other thing in Firetower uses.

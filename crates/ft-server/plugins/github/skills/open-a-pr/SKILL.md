---
name: open-a-pr
description: Use when work on a branch is finished and wants a pull request opened — writes the title and body, links the issue it closes, and picks reviewers from who touched the code.
---

# Opening a pull request

The title is the release note. Write it as the thing a person reads in a
changelog six months from now, not as a description of the diff.

## The body

Three short sections, and none of them is a list of the files you changed —
the diff already says that.

- **What was wrong.** The behaviour, with the case that shows it.
- **What this does about it**, and why this way rather than the obvious one.
- **How it was checked.** The commands, so somebody else can run them.

## Linking

`Closes #32` for a GitHub issue, on its own line. A tracker's identifier goes
beside it rather than instead of it — each host ignores the other's, so both
can sit in one body.

## Reviewers

Whoever last touched the lines this changes. Ask the connector, do not guess
from the top-level owners file.

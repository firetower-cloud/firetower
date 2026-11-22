---
name: conventional-commits
description: Use when writing a commit message in a repository whose releases are cut from its commits — the subject becomes the release note, so it has to read as one.
---

# The commit message is the release note

Where a release tool reads the history, every subject you write is published.
So write the sentence a person would want to read in a changelog, not a
description of the diff.

```
feat(server): a plugin's connector carries the person's own token
fix(desktop): the shelf no longer collapses to one column at 951
docs(worker): say which directory Claude Code is actually handed
```

`feat` is a minor bump and `fix` a patch. `docs`, `test`, `refactor`, `chore`,
`ci`, `style` and `build` bump nothing, and they are the right answer when the
change is not one anybody would read about.

**A branch whose subjects are prose ships no release at all.** The work is
then invisible until somebody restates it by hand, which is how a changelog
stops matching the product.

Scope is the area somebody would search for, not the directory you edited.

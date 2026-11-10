<!-- Firetower reads commits, not this title. Every commit on your branch has to be
     a Conventional Commit — `.github/workflows/commits.yml` fails the pull request
     otherwise, and that is a reword, never a code change. -->

## What changes

<!-- What it does now that it did not do before, grouped by surface. Two sentences
     per bullet at most. If you cannot do this without a paragraph, the pull request
     is probably two pull requests. -->

## Why

Closes #

<!-- The issue has to be labelled `accepted`. If it is not, stop and ask in Discord
     — a pull request nobody agreed to may be closed without review, and we would
     rather tell you that now than after you have written it.

     A fix under about fifty lines with a screenshot needs no issue at all. -->

## Screenshots — every user path this touches

<!-- REQUIRED for any change under web/, desktop/ or mobile/. Not a sample. Every
     path. A screen you changed, a screen you added, and a screen you only
     *might* have disturbed all go here.

     Drag the images into this box so GitHub hosts them. Do NOT link to a branch
     on your own fork — GitHub does not proxy those, so they are served live from
     your repository and you can change or delete them after a reviewer approved
     what they showed. The check refuses them for that reason, not to be awkward.

     A check fails if the body has no GitHub-hosted image anywhere in it — it
     reads the whole description, not only this section, and it reads the page
     GitHub draws rather than what you typed. A picture inside a comment or a
     code fence does not count, because a reader cannot see it either. -->

| Path | Surface | Before | After |
|---|---|---|---|
| Tasks → pick a board | Desktop | ![](…) | ![](…) |
| Tasks → board view, columns | Desktop | n/a — new | ![](…) |
| Tasks list row | Mobile | ![](…) | ![](…) |

<!-- A flow that only reads as a flow gets a recording instead. Anything that
     changed on more than one surface shows all of them: a desktop screenshot is
     not evidence about the phone. -->

## How it was checked

<!-- What you actually ran, and against what. Be exact — "tested locally" tells a
     reviewer nothing. If something is unverified, say which thing and why; that is
     a far better pull request than one that implies it all works. -->

- [ ] `just gen-check`
- [ ] `just test`
- [ ] Ran it against a real control plane and a real worker
- [ ] Every commit on this branch is a Conventional Commit

## What I did not do

<!-- Deliberate omissions, known gaps, anything you want cut or split out.
     This section is never "nothing" on a pull request of any size. -->

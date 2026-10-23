# Workspaces without a repository

**Status:** built.

A workspace does not need a repository. With none it is a *bare agent*: a
directory on a host with an agent waiting in it, no mirror, no worktree and no
branch. It is still a workspace and still a session — it is listed, shared,
shelled into, torn down and billed like any other.

## Why

Requiring one made Firetower refuse work it is otherwise good at. Connecting a
git host is four steps of OAuth before anything runs, which is the first thing
anybody meets; and plenty of what people point an agent at was never going to
be a pull request — a render, a scrape, a report, a one-off script. The skills
in `docs/skills.md` are mostly of that kind, and every one of them was gated
behind a checkout for no reason anybody could name.

The machinery was already general. An isolated directory, a resource limit,
tmux, somebody's own subscription, approvals, the file browser: none of that is
about git. The repository was the only part that made this a *coding* tool, and
it was mandatory in two forms and nowhere else.

## What is different inside one

| | With a repository | Bare |
|---|---|---|
| Steps on bring-up | fetch, worktree, (setup), launch | workspace, launch |
| `Session::repo`, `::branch`, `::base` | set | `None` |
| `workspace_repos` rows | one per checkout | none |
| Commit, push, pull request | yes | refused, saying why |
| Diff | the branch against its base | empty |
| Rail | filed under its repository | filed under *no repository* |
| Environment | the repository's variables | none — see below |
| How work leaves | `git push` | a download |

`Step::plan` decides the first row of that table, and it is decided when the
session is created so the screen has the shape of the work before the worker
has said anything.

## How work leaves one

This is the part that needed building, because git was the only way anything
ever left a workspace and a bare one has no git.

* **A file**, byte for byte — `GET /api/v1/sessions/{id}/file?path=…`.
* **A path as one zip** — `GET /api/v1/sessions/{id}/archive?path=…`. A
  directory, a file, or the whole workspace when the path is empty.

Both are on the right-click menu of every row in the Files panel, and the whole
workspace is a button under the tree. A directory is only ever offered as a zip
because there is no single stream of bytes to send otherwise; a file is offered
both ways because zipping one is how a 90 MB log becomes a small download.

Two things about the archive worth knowing before changing it:

* **It is staged to a temporary file on the worker before anything is sent.** A
  zip's size is not known until the last entry is deflated, and the control
  plane has to put `content-length` on a response before it has a body. The
  alternative is a chunked download with no progress and no resume.
* **Symlinks are skipped, never followed.** One pointing at `/` would turn a
  directory download into an archive of the machine.

The desktop app fetches none of this in the renderer. `save_download` in
`desktop/src-tauri/src/main.rs` asks where to put it and streams it there,
because a webview has no filesystem and the usual fix — giving the `fs` plugin
a write scope — hands every page in the window the ability to write to the disk
for the sake of one button. A hundred megabytes also has no business crossing
the IPC bridge.

## Ending one is the dangerous case

Everywhere else, ending a workspace has a floor under it: whatever is lost, the
branch stays on the machine. A bare workspace has no floor — git never saw the
directory, so every file in it goes. The confirmation says so, and says it
differently from the repository case, because "nothing uncommitted is in it" is
true of a bare workspace and reads as reassurance when it should read as a
warning.

`session_work` answers an empty list for a bare workspace rather than refusing.
It used to be a `400`, and the caller that mattered caught it as "could not be
read" — so ending a bare workspace warned about uncommitted work on a branch
that did not exist.

## Checking a repository in later

`POST /api/v1/sessions/{id}/repos` works on a bare workspace, and the branch is
derived from the prompt since there is none to reuse. The caption columns on
`workspaces` — `repo`, `branch`, `base` — are backfilled by `add_checkout` in
the same transaction as the checkout row, and they have to be: `run_action`
reads `repo` to decide whether committing is allowed, and the credential for
the remote is looked up from it. Without the backfill the repository was
checked out on disk and every push was refused.

Adding a *second* repository leaves the caption on the first, which is why the
backfill is conditional on `repo IS NULL` rather than on being the first row.

## What is still missing

**Environment variables.** Secrets are loaded from the scope `repo:{id}`
(`repo_env`), so a bare workspace gets none at all. An agent asked to call an
external API has nowhere to keep the key. The `secrets` table is keyed by a
free-text `scope`, so this is a loader and a screen rather than a migration —
but nothing loads a non-repo scope today.

**Hosts still need git.** `readiness::check` asks for it unconditionally. A
machine with an agent, tmux and no git is refused for work that would never
touch a repository. Harmless in practice and left alone deliberately.

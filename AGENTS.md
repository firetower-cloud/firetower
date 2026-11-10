# Working in this repository

[CONTRIBUTING.md](CONTRIBUTING.md) is the full version — the toolchain, the
dev loop, the database, the deployment. This is the short list of things that
are easy to get wrong.

## Your commit message is the release note

`main` is read by release-please: it decides the next version from the commits
and writes `CHANGELOG.md` from their subjects. Pull requests here are merged
with a **merge commit**, so every commit you write lands on `main` and every
one of them is read — and the pull request's title is read by nothing.

So write [Conventional Commits], every commit, no exceptions:

```
feat(desktop): the profile editor's Skills section, three additive sources
fix(server): a child's hand-back that never arrived is held again
docs(mobile): say the ratio's real name, and retire "matched"
```

`feat` is a minor bump and `fix` a patch; `docs`, `test`, `refactor`, `chore`,
`ci`, `style` and `build` bump nothing and are the right answer when the change
is not one a user would read about. A branch whose subjects are prose — however
well written — ships no release at all, and the work is invisible until
somebody restates it by hand. `.github/workflows/commits.yml` fails a pull
request that carries one, so this is checked rather than hoped for.

Three packages version separately — `.`, `desktop` and `mobile` — and a commit
is attributed to one by **the files it touches**, not by its scope. See
`release-please-config.json`, and the Commit messages section of
CONTRIBUTING.md for the rest.

## Before you push

```sh
just gen-check   # the contract and the three clients match their sources
just test
```

`just gen-check` is the one that catches a change nobody ran `just gen` for,
which is most of the red builds on this repository. If you changed a Rust
handler, the committed `api/openapi.json` and each client's
`src/api/generated/` have to be what the generator now produces.

## If you are opening a pull request

`.github/pull_request_template.md` is what it has to fill in. Three of these
four are checked rather than hoped for; the linked issue is a warning:

* **Every commit is a Conventional Commit.** Above, and `commits.yml` fails the
  pull request otherwise.
* **Link the issue, and it should be labelled `accepted`.** `Closes #123` in the
  Why section. An issue is not agreement; `accepted` is. A fix under roughly
  fifty lines with a screenshot needs no issue at all.
* **Screenshot every user path you touched** when the change is under `web/`,
  `desktop/` or `mobile/` — before and after, a row per path, on every surface
  it appears on. Drag the images in so GitHub hosts them; a link to a branch on
  a fork is refused. `contribution.yml` fails the pull request without one.
* **Say what you did not do.** Deliberate omissions and known gaps. On a pull
  request of any size this is never "nothing".

## What not to do

* **Don't edit `CHANGELOG.md`, `version.txt`, `.release-please-manifest.json`
  or the version in any `Cargo.toml`/`package.json`.** release-please owns all
  of them and its pull request will conflict with you.
* **Don't edit anything under `src/api/generated/`** in `web/`, `desktop/` or
  `mobile/` by hand. Change the Rust handler and run `just gen`.
* **Don't push to `main`.** It is unprotected, which is not an invitation.

[Conventional Commits]: https://www.conventionalcommits.org

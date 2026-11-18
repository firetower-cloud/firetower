# What GitHub actually exposes about this repo, and how far back

Research for [#400](https://github.com/firetower-cloud/firetower/issues/400), on the
map [#399](https://github.com/firetower-cloud/firetower/issues/399). A data inventory
a Postgres ingest can be specified from: for pull requests, commits on `main`,
releases and tags, workflow runs and issues — the endpoint, the fields that carry a
timestamp, the retention horizon, the pagination cost of the full backfill, and the
cost of one incremental run.

Everything below is one of two things, and the document says which every time:

- **Documented** — quoted from GitHub's own documentation, with a link.
- **Measured** — a call made against `firetower-cloud/firetower` on **2026-11-18**,
  with the call and its result. Measured numbers are a snapshot; the repository
  moves.

---

## The short answer

| Uncertainty | Answer |
|---|---|
| Do a squash-merged PR's commits survive a deleted branch? | **Yes — and more than that.** 34 commits that are unreachable from *every* ref in the repository still return `200` today. Lead-time-from-first-commit is measurable from history, so the ingest's cadence is a **preference**, not a correctness constraint. |
| How far back does workflow-run metadata go? | **To the first run ever: `2026-08-16T09:54:18Z`.** All 3,196 runs are retrievable, with zero gaps in run numbering. Logs are gone past 90 days (`410 Gone`), metadata is not. **But** GitHub documents that from 2026-10-01 the 90-day retention covers workflow runs themselves — so this is the one dataset with a real backfill urgency. |
| Can a commit on `main` be linked to its PR, and a PR to its release? | **Yes, both, exactly.** `/commits/{sha}/pulls` resolved 213 of 213 PR-borne first-parent commits to exactly one PR each, and never to two. Releases carry the target commit SHA directly, and every versioned release points at a commit on `main`'s first-parent chain. |
| What identifies a release-please PR robustly? | **`head.ref` starting `release-please--branches--`** — 82 of 215 merged PRs, exactly. The label `autorelease: tagged` and the author `github-actions[bot]` each select the *same* 82. **Title matching does not** — only **42** of the 82 are titled `chore: release main`. |
| What auth scope does the ingest need? | **None.** Every endpoint required returned `200` unauthenticated. A token buys rate limit (5,000/hr vs 60/hr) and GraphQL access, not reach. |

Two numbers in the map's Notes do not survive contact with the API. See
[What this invalidates](#what-this-invalidates).

---

## 1. Do a merged PR's commits survive a squash merge and a deleted branch?

**They do, and the margin is wider than the question assumes.** This is the finding
the map was most exposed on, so it was tested against real merged PRs of both merge
kinds rather than reasoned about.

### How the repository actually merges

`gh api repos/firetower-cloud/firetower --jq '{allow_squash_merge, allow_merge_commit, delete_branch_on_merge}'`

```json
{"allow_squash_merge": true, "allow_merge_commit": true, "delete_branch_on_merge": false}
```

Branch deletion is *not* automatic — and yet only **32 branches are live** against 215
merged PRs, so roughly 190 head branches have been deleted by hand or by the agent
workflow. Deletion is the normal case here.

Merge kind was classified by the parent count of each PR's `merge_commit_sha` (a
squash or rebase merge leaves one parent; a merge commit leaves two), joined from the
full `/commits?sha=main` listing:

| | merged PRs |
|---|---|
| merge commit (2 parents) | **210** |
| squash merge (1 parent) | **5** — #203, #205, #206, #208, #224 |

`commits.yml` explains why: *"Pull requests here are merged with a merge commit, so
each commit you write lands on `main`."* For those 210, the branch commits are second
parents of a commit on `main` and are therefore in `main`'s history permanently — a
plain `git clone` has them. The five squash merges are the real test.

### The real test: commits unreachable from every ref

For all 215 merged PRs, `/pulls/{n}/commits` was paginated and every returned SHA
checked against a full clone with all 32 branches fetched:

```
present in clone: 1142
absent from clone (orphaned objects): 34
```

The 34 absent commits belong to exactly the five squash-merged PRs. They are not on
`main`, not on any branch, not on any tag — `git cat-file -e` fails on them, and
`git merge-base --is-ancestor` reports `fatal: Not a valid commit name`. They are
unreachable Git objects.

All 34 were then fetched individually:

```
$ gh api repos/firetower-cloud/firetower/commits/cb75b3edeb3035d3e8ff5abe2f3088f407d0fe22
{"sha":"cb75b3ede…","date":"2026-10-03T08:27:00Z",
 "msg":"style(core): rustfmt the binary-name split_diff test"}

fetched OK: 34   failed: 0
```

The oldest is authored `2026-09-30T13:20:52Z` — **49 days old at the time of
measurement**, on PR #205, squash-merged, branch
`agent/optimise-memory-on-desktop-app-diff-section` deleted (`/branches/{ref}` →
`404 Branch not found`). Its full six-commit list still comes back in order with
original author dates:

```
$ gh api repos/firetower-cloud/firetower/pulls/205/commits
7e33273f9  author=2026-09-30T13:20:52Z  committer=2026-10-03T06:22:25Z  perf(desktop): draw only the diff rows…
380d60b13  author=2026-09-30T13:37:48Z  committer=2026-10-03T06:22:25Z  test(desktop): let the mock report edits…
59fd78a1f  author=2026-09-30T13:45:09Z  committer=2026-10-03T06:22:25Z  test(desktop): report a mock edit…
bbfbf86cf  author=2026-09-30T16:58:13Z  committer=2026-10-03T06:22:25Z  perf(diff): ask for names when names are all…
d18c3c89e  author=2026-10-03T07:13:17Z  committer=2026-10-03T07:13:17Z  fix(mobile): a cut patch says so there too
cb75b3ede  author=2026-10-03T08:27:00Z  committer=2026-10-03T08:27:00Z  style(core): rustfmt the binary-name split_diff test
```

A harder case still: PR #203's head branch `release-please--branches--main` *exists*,
but release-please force-pushes it on every release, so it has been overwritten dozens
of times since October. Its recorded head `01cc790a2` is therefore orphaned the same
way — and `/commits/01cc790a2…` returns `200` with the right date.

`/commits/{sha}/pulls` also works **on an orphan**, resolving `7e33273f9` back to PR
#205. The link survives in both directions.

### What this decides

**The ingest has a preferred cadence, not a correctness-driven one.** Lead time from
the first commit on the branch is measurable from history, for every merged PR in the
repository's life, today. The three tickets blocked on this can plan an hourly or
daily job on their own merits.

**Caveat, stated honestly.** GitHub does not document a retention guarantee for
unreachable Git objects. This is a measured behaviour over a 49-day-old orphan, not a
promise. The documented ceiling that *does* exist is on list length, not lifetime:
[List commits on a pull request](https://docs.github.com/en/rest/pulls/pulls) —
*"Lists a maximum of 250 commits for a pull request. To receive a complete commit list
for pull requests with more than 250 commits, use the List commits endpoint."* The
largest merged PR here has **111** commits (#261), so the cap is not currently
binding, but an ingest should detect `commits.totalCount > 250` rather than silently
truncate.

**Use `commit.author.date`, not `commit.committer.date`.** Measured over the 1,309
non-merge commits reachable from `main`: the two differ on **145 (11.1%)**, by a mean
of 53 minutes, and by more than 24 hours on 14 of them. Rebases and squashes rewrite
the committer date; the author date is when the work was done. PR #205 above shows it
plainly — four commits authored on 2026-09-30, all re-committed at `2026-10-03T06:22:25Z`.

### A bonus the map wanted

With the first-commit dates in hand, the lead-time question the map posed can be
answered now, for the 133 non-release merged PRs:

| clock | p25 | p50 | p75 | p90 | max |
|---|---|---|---|---|---|
| **first commit → merged** | 13 min | **87 min** | 9.4 h | 24.4 h | 22 days |
| PR opened → merged | — | 37 min | — | 17.8 h | — |
| first commit → PR opened | — | **1.2 min** | — | 5.9 h | — |

The map's instinct is right — starting at the first commit more than doubles the
median — but the magnitude is modest, and the reason is interesting: the median branch
is pushed and its PR opened **1.2 minutes later**. The work is not hidden *before* the
PR opens; it is that the whole cycle is short. Two PRs have a first commit *after* the
PR was opened (branch pushed to after opening).

---

## 2. How far back is workflow-run metadata retrievable?

**Measured: to the first run that ever happened.** The distinction between logs and
metadata is real, and currently it is the whole story.

```
$ gh api 'repos/firetower-cloud/firetower/actions/runs?per_page=1' --jq .total_count
3196
```

All 32 pages paginate — page 32 returns the final 96 rows, so there is no 1,000-item
wall on this endpoint. The oldest row:

```json
{"id":31940266810,"name":"release","run_number":1,"path":".github/workflows/release.yml",
 "event":"push","status":"completed","conclusion":"failure",
 "created_at":"2026-08-16T09:54:18Z","run_started_at":"2026-08-16T09:54:18Z",
 "updated_at":"2026-08-16T09:54:35Z"}
```

That is `run_number: 1` of the first workflow the repository ever had, and it lines up
with the commit that introduced it — `8e41eaf` *"ci: publish the worker image and
release from commits"*, authored `2026-08-16 17:50:25 +0800`. **Nothing older exists to
be missing.**

Nothing in between is missing either. Every run of the `release` workflow was
paginated and the run numbers checked for gaps:

```json
{"runs_returned":294,"min_run_number":1,"max_run_number":294,"distinct":294,"missing":[]}
```

294 runs, numbered 1 to 294, none absent — over a window that reaches 94 days back,
past any 90-day boundary.

### Logs, by contrast, are gone exactly as documented

Same run, 94 days old:

```
$ gh api repos/firetower-cloud/firetower/actions/runs/31940266810/logs -i
HTTP/2.0 410 Gone
```

Newest run, hours old:

```
$ gh api repos/firetower-cloud/firetower/actions/runs/44289825225/logs -i
HTTP/2.0 200 OK
```

Yet for that same 94-day-old run, the *job and step* records are intact:

```json
{"total":2,"jobs":[
  {"name":"please","conclusion":"failure","created_at":"2026-08-16T09:54:19Z",
   "started_at":"2026-08-16T09:54:24Z","completed_at":"2026-08-16T09:54:34Z","steps":3},
  {"name":"image","conclusion":"skipped","created_at":"2026-08-16T09:54:34Z",
   "started_at":"2026-08-16T09:54:34Z","completed_at":"2026-08-16T09:54:34Z","steps":0}]}
```

…with per-step `started_at`/`completed_at` present. So: **metadata to day one, logs to
90 days.** CI health is not capped at 90 days today.

### The documented risk, which is the reverse of what the ticket expected

[Configuring the retention period for checks, workflow runs, commit statuses,
artifacts, and logs in your
organization](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization):

> "By default, checks, workflow runs, commit statuses, and the artifacts and log files
> generated by workflows are retained for 90 days before they are automatically
> deleted."

> "For public repositories: you can change this retention period to anywhere between
> 1 day or 90 days."

> "Starting October 1, 2026, these policies will apply to checks, workflow runs, and
> commit statuses in addition to artifacts and logs. Until then, checks, workflow runs,
> and commit statuses are retained for 400+ days regardless of your configured
> retention period."

That date has passed. The documentation says workflow runs for a **public** repository
are now subject to a retention period that **cannot exceed 90 days**. The live call
disagrees — a 94-day-old run is still there, with no gaps — so either the deletion is
not yet being applied retroactively, or it is rolling out gradually. The
organization's configured value could not be read (`/orgs/firetower-cloud/actions/permissions`
→ `403`, needs org admin), but it cannot be the explanation: a public repository's
maximum is 90 days.

**This inverts the ticket's framing.** The ticket guessed PR commits were the
perishable thing and workflow runs the durable one. It is the other way round:

- PR commits are durable and can be ingested whenever.
- **Workflow runs are the dataset with a correctness-driven backfill urgency.** The
  complete history is available right now and is documented as expiring. Back-fill all
  3,196 runs on the first run of the ingest, keep the rows forever, and never treat
  GitHub as the system of record for them again. 32 requests buys the project's entire
  CI history, and that offer may not stand in 90 days.

### What the run rows actually contain, measured over all 3,196

| | count |
|---|---|
| total | 3,196 |
| `status: completed` / `queued` | 3,172 / 24 |
| `conclusion: success` | 1,765 |
| `conclusion: skipped` | 648 |
| `conclusion: failure` | 411 |
| `conclusion: action_required` | 227 |
| `conclusion: cancelled` | 121 |
| `conclusion: null` (still queued) | 24 |
| `event: pull_request` / `push` / `workflow_dispatch` / `dynamic` | 2,647 / 535 / 10 / 4 |
| `run_attempt > 1` | 416 |
| runs on `head_branch == "main"` | 534 — 512 success, 13 failure, 9 cancelled |

Four things in that table matter to whoever defines change failure rate:

1. **`skipped` (648) and `action_required` (227) are not failures.** `action_required`
   is overwhelmingly release-please PRs waiting on approval. A naive
   `conclusion != 'success'` rate would read 44%; the honest `main`-branch failure rate
   is **13 of 525 completed, non-cancelled runs — 2.5%**.
2. **416 runs have `run_attempt > 1`.** The list endpoint returns the *latest* attempt,
   so a run that failed and was re-run to green reads as `success`. Any "time to green"
   or "first-try pass rate" metric needs `/actions/runs/{id}/attempts/{n}`, one request
   per extra attempt.
3. **`run.pull_requests[]` is unreliable.** It is populated on only **827 of the 2,647**
   `pull_request`-event runs (31%). Join runs to PRs on `head_branch` and `head_sha`
   instead.
4. **Run history outlives the workflow file.** `workflow_id 335483376` ("worker image",
   `.github/workflows/worker-image.yml`) has 4 surviving runs but does not appear in
   `/actions/workflows`; fetched by id it reports `"state": "deleted"`. Take the
   workflow name and path from the run row, not from a join to the workflow list, or
   those rows orphan.

**Run duration needs no extra request.** `updated_at − run_started_at` was checked
against `/actions/runs/{id}/timing` on five runs and matched exactly every time
(e.g. `441 s` vs `run_duration_ms: 441000`; the fifth was a skipped run with no timing
value at all). That saves 3,196 requests on the backfill. Median successful run:
**108 s**, p90 **679 s**.

---

## 3. Commit → PR, and PR → release

### Commit on `main` → its PR

`GET /repos/{owner}/{repo}/commits/{sha}/pulls` was called for **every one of the 369
commits on `main`'s first-parent chain**:

| | commits | resolve to a PR | resolve to >1 PR |
|---|---|---|---|
| merge commits (2 parents) | 209 | **208** | 0 |
| non-merge commits | 160 | 5 | 0 |

- The one merge commit that resolves to nothing is `64fa1794` *"Merge branch
  'chat-view'"* — a local merge pushed straight to `main` on 2026-08-23.
- The five non-merge commits that *do* resolve are exactly the five squash merges.
- **No commit ever resolved to more than one PR**, so the relation is safe to model as
  a nullable `pr_number` column on the commit row rather than a join table.

**There is a free alternative for merge commits.** 208 of the 209 merge-commit subjects
match `^Merge pull request #[0-9]+` — the same 208. Parsing the subject costs zero
requests. Use `/commits/{sha}/pulls` only for non-merge commits, or as a verification
pass.

**The gap that matters more than the method.** 155 of `main`'s 369 first-parent commits
(42%) came through no PR at all — direct pushes. They are not spread out:

| month | direct pushes to `main` |
|---|---|
| 2026-08 | 123 |
| 2026-09 | 32 |
| 2026-10 | 0 |
| 2026-11 | 0 |

The last one is **2026-09-25** (`Update CONTRIBUTING.md`). So the merge loop is
complete and trustworthy from **2026-09-25** onwards, and partial for the repository's
first six weeks. Any merge-loop series should either start there or draw the earlier
weeks differently, because "PRs merged per week" in August is measuring a workflow that
did not exist yet. 213 of the 215 merged PRs target `main`; the other two target
sibling agent branches (stacked PRs) and never produce a `main` commit of their own.

### PR → the release that first contained it

Three measured facts make this exact and cheap:

1. **`release.target_commitish` is the commit SHA**, not a branch name, for every
   release release-please cut. 127 of the 129 releases carry a 40-hex SHA. The two
   exceptions are rolling pointers — `worker-latest` and `desktop-latest` — whose
   `target_commitish` is the literal string `"main"`.
2. **Every one of the 81 distinct versioned target commits lies on `main`'s first-parent
   chain.** Checked against `git rev-list --first-parent main`: 81 on, 0 off.
3. **The target commit of a release event is the merge commit of a release-please PR:**

   ```
   firetower-v0.55.0 → a96ecfc0c… → "Merge pull request #312 from firetower-cloud/release-please--branches--main"
   ```

So the whole chain is one join away in Postgres, with no ancestry calls:

> Ingest `main`'s first-parent chain with an ordinal (`position`). The first release
> containing a commit is the release event with the smallest ordinal `>=` that commit's
> ordinal.

`/commits?sha=main` returns each commit's `parents[]`, so the first-parent chain is
reconstructible from the 16 pages already being fetched — follow `parents[0]` from the
tip. Nothing needs a clone. **GraphQL cannot do this**: `history()` has no first-parent
option, so it returns the full DAG with no way to distinguish the trunk.

The alternative — `GET /compare/{base}...{head}` per (commit, tag) pair, reading
`status: "behind" | "ahead"` — is one request per pair and is not worth it.

### Releases arrive in groups; `created_at` is the grouping key

Grouping the 127 versioned releases by `target_commitish` gives **81 release events**:

| packages tagged from one commit | events |
|---|---|
| 1 | 52 |
| 2 | 12 |
| 3 | 17 |

The three-package case the map describes is real but is the minority — 17 of 81.
Within an event, `created_at` is **identical** across all releases (29 of 29
multi-package events have exactly one distinct `created_at`) while `published_at`
differs by 1–2 seconds:

```json
[{"tag_name":"mobile-v0.17.0",   "created_at":"2026-11-15T09:46:51Z","published_at":"2026-11-15T09:47:07Z"},
 {"tag_name":"firetower-v0.55.0","created_at":"2026-11-15T09:46:51Z","published_at":"2026-11-15T09:47:05Z"},
 {"tag_name":"desktop-v0.30.0", "created_at":"2026-11-15T09:46:51Z","published_at":"2026-11-15T09:47:06Z"}]
```

`created_at` is the **target commit's own date** — `a96ecfc0c` is committed at
`2026-11-15T09:46:51Z`, to the second. So:

- Group a release event by `target_commitish` (equivalently by `created_at`).
- Use `min(published_at)` as "when it shipped".
- Never use `created_at` as a publish time. It is a commit timestamp wearing a
  release's clothes, and on a rolling release it is meaningless.

---

## 4. A robust identifier for release-please's release PRs

Four candidate identifiers, measured across all 215 merged PRs:

| identifier | selects | verdict |
|---|---|---|
| `head.ref` starts with `release-please--branches--` | **82** | ✅ **use this** |
| `labels[].name == "autorelease: tagged"` | **82** | ✅ same 82, set-equal |
| `user.login == "github-actions[bot]"` | **82** | ✅ same 82, set-equal |
| `title == "chore: release main"` | **42** | ❌ **misses 40** |
| `title` contains "release" | 87 | ❌ over-selects by 5 |

The first three select the *same* 82 PRs; set equality was checked both ways. Title
matching does not, and the reason is that release-please's title template changed
partway through the repository's life:

| head branch | merged PRs | title |
|---|---|---|
| `release-please--branches--main` | 42 | `chore: release main` |
| `release-please--branches--main--components--firetower` | 40 | `chore(main): release firetower 0.2.0` … `0.32.2` |

The earlier 40 are the single-package era — PRs #1 to #100, against #111 to #312 for
the later 42 — and a
`title = 'chore: release main'` filter leaves all 40 counted as *work*, inflating the
real work-PR count by 30% and halving the release loop.

**Recommendation: match on `head.ref` with the prefix `release-please--branches--`.**

- It is derived from release-please's own branch configuration, not from a message
  template, and it survived the title change that broke title matching.
- It is on the PR row already — no extra request, no join.
- It is stable across PR state. The label is not: the currently-open release PR #327
  carries **`autorelease: pending`**, which release-please flips to
  `autorelease: tagged` only after tagging. That makes the label an excellent
  *lifecycle* signal and a poor *identity* one.
- Author is nearly as good — all 85 `github-actions[bot]` PRs in the repository (open,
  closed and merged) are release-please PRs, and `dependabot[bot]`'s 15 PRs are a
  separate login with 0 merged. But it would collide the day any other Actions
  workflow opens a PR, which is a cheap thing for someone to add.

Belt and braces: `head.ref LIKE 'release-please--branches--%'` as the identity, store
the labels so `autorelease: pending` → `tagged` is available if the release loop ever
needs the in-flight state.

---

## 5. The datasets, endpoint by endpoint

Timestamp-bearing fields are in **bold** where they are the ones a metric should use.

### Pull requests

`GET /repos/firetower-cloud/firetower/pulls?state=all&per_page=100`

- **`created_at`** — opened. **`updated_at`** — the incremental cursor.
  **`merged_at`** — null unless merged; the merge-loop clock. `closed_at` — equals
  `merged_at` on 203 of 215 merged PRs and is 1 second later on the other 12. Use
  `merged_at`.
- Also: `number`, `title`, `state`, `draft`, `merge_commit_sha`, `head.ref`,
  `head.sha`, `base.ref`, `labels[]`, `user.login`, `user.type`.
- **The list endpoint omits** `commits`, `additions`, `deletions`, `changed_files`,
  `merged_by`, `comments`, `review_comments`. Those exist only on
  `GET /pulls/{n}` — one request per PR. (GraphQL returns `additions`/`deletions`/
  `changedFiles` in the list node for free.)
- Measured: 257 PRs — 215 merged, 16 open, 26 closed unmerged — in **3 requests**.
- No retention limit, documented or observed. Every PR back to #1 is present.
- No `since` parameter. Incremental = `sort=updated&direction=desc` and stop at the
  watermark. Measured: page 1 of 100 reaches back to `2026-10-17`, so an hourly or
  daily run needs **1 request**.

### A PR's commits

`GET /repos/{owner}/{repo}/pulls/{n}/commits?per_page=100`

- **`commit.author.date`** — when written; use this. `commit.committer.date` — rewritten
  by rebase; differs 11.1% of the time.
- Returned oldest-first, so `[0]` is the first commit on the branch. Cross-checked
  against GraphQL for all 215 PRs: **215 of 215 agree** on the first-commit date.
- Documented cap: 250 per PR. Measured maximum: 111 (#261). Not binding today.
- Measured: 1,184 commits across the 215 merged PRs (1,176 distinct). **216 requests** —
  one per PR, plus a second page for #261.
- **Survives squash merge, branch deletion and force-push** — see §1.

### Commits on `main`

`GET /repos/firetower-cloud/firetower/commits?sha=main&per_page=100`

- **`commit.author.date`**, `commit.committer.date`, **`parents[]`** (needed for
  first-parent reconstruction), `sha`, `commit.message`.
- **No `stats` and no `files`** on the list rows. Lines-changed per commit is one
  request per commit — 1,546 of them. The map already warns that line counts are a
  gameable metric; this is one more reason to leave them out.
- Measured: **1,546 commits in 16 requests**. That is the *full DAG* reachable from
  `main`, not the trunk — see [What this invalidates](#what-this-invalidates).
- `since=` works: 79 commits since `2026-11-17T00:00:00Z`. Incremental = **1 request**.

### Releases

`GET /repos/firetower-cloud/firetower/releases?per_page=100`

- **`published_at`** — when the release row appeared; use this as "shipped at".
  `created_at` — the **target commit's** date, *not* a publish time. `assets[].created_at`
  / `updated_at` if build artefacts ever matter.
- **`target_commitish`** — a 40-hex SHA on all 127 versioned releases; the string
  `"main"` on the 2 rolling ones.
- `tag_name`, `name`, `draft` (0), `prerelease` (6), `id`.
- Measured: **129 releases in 2 requests** — 127 versioned (`firetower` 74,
  `desktop` 34, `mobile` 19) and 2 rolling (`worker-latest`, `desktop-latest`).
- Filter to `tag_name ~ '^(firetower|desktop|mobile)-v'`. The rolling pointers are not
  releases and will otherwise appear as two mystery deployments in September.
- No retention limit. No `since` parameter — 2 requests is cheap enough to re-read in
  full every run.

### Tags

`GET /repos/firetower-cloud/firetower/tags?per_page=100`

- **No timestamps at all.** The payload is `name`, `commit.sha`, `node_id`,
  `tarball_url`, `zipball_url`. A tag's date has to come from the commit it points at.
- Measured: **130 tags in 2 requests**, against 129 releases — `desktop-v0.6.0` is a
  tag with no release row.
- Worth ingesting for one reason: it gives the *current* SHA of a moving tag.
  `worker-latest` now points at `d846271a`, while its release row still says `"main"`.
- Rolling tags are mutable. Treat the tag table as a snapshot, not as history.

### Workflow runs

`GET /repos/firetower-cloud/firetower/actions/runs?per_page=100`

- **`run_started_at`** — started. **`updated_at`** — for a completed run, finished;
  `updated_at − run_started_at` equals `/timing`'s `run_duration_ms` exactly.
  `created_at` — queued; `created_at → run_started_at` is queue wait.
  `head_commit.timestamp` — the commit's own date.
- `id`, `name`, `path`, `workflow_id`, `run_number`, **`run_attempt`**, `event`,
  `status`, **`conclusion`**, `head_branch`, `head_sha`.
- Measured: **3,196 runs in 32 requests**, oldest `2026-08-16T09:54:18Z`, no gaps.
- `created=>=YYYY-MM-DD` works: 304 runs since 2026-11-17, 850 in 7 days. An hourly
  run is **1 request**; a daily run is **3**. At ~850 runs a week this is the busiest
  dataset by far and the one most worth windowing.
- Only `status == "completed"` rows are final. Re-read a trailing window (24 h) each
  run, and upsert on `(id, run_attempt)`.

### Workflow jobs — optional, and expensive

`GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`

- `created_at`, `started_at`, `completed_at`, plus `steps[].started_at` /
  `completed_at`. Present on a 94-day-old run.
- **One request per run — 3,196 for the backfill**, 64% of an hour's authenticated
  budget, for data the run row already summarises. Skip it unless a metric needs
  per-step timing, and if it does, fetch jobs only for failed runs on `main` (13 rows).

### Issues

`GET /repos/firetower-cloud/firetower/issues?state=all&since=…&per_page=100`

- **`created_at`**, **`updated_at`** (the cursor), **`closed_at`**, plus
  **`state_reason`** — measured: `completed` 73, `not_planned` 4, `duplicate` 1,
  `null` 71.
- **This endpoint returns pull requests too.** Measured: 406 rows = **149 issues + 257
  PRs**. Filter `pull_request == null` or every count doubles.
- Measured: 149 issues in **5 requests** (everything, PRs included). `since=` works:
  89 rows since 2026-11-17 — incremental **1 request**.
- Label health, re-measured today: 79 of 149 unlabelled, `bug` 10, `enhancement` 23 —
  the map's reading holds. 32 titles begin with `fix`.
- **New caution the map does not have:** 34 of the 149 issues (23%) carry a process
  label — `wayfinder:grilling` 16, `wayfinder:research` 12, `wayfinder:map` 3,
  `wayfinder:prototype` 3, `ready-for-agent` 7. The wayfinder process files issues, so
  "issues opened per week" now counts planning artefacts alongside defects and
  requests. Exclude `wayfinder:*` from any issue-volume series.

---

## 6. Rate-limit arithmetic

**Documented.** [Rate limits for the REST
API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api):

> "All of these requests count towards your personal rate limit of 5,000 requests per hour."

> "The primary rate limit for unauthenticated requests is 60 requests per hour."
> "Unauthenticated requests are associated with the originating IP address, not with the
> user or application that made the request."

> "No more than 100 concurrent requests are allowed."
> "No more than 900 points per minute are allowed for REST API endpoints, and no more
> than 2,000 points per minute are allowed for the GraphQL API endpoint."

[Rate limits and node limits for the GraphQL
API](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api):
5,000 **points** per hour per user; *"Individual calls cannot request more than 500,000
total nodes."*

### Full 15-week backfill

All request counts measured, not estimated.

| dataset | REST requests | note |
|---|---|---|
| pull requests, all states | **3** | 257 rows |
| commits for all 215 merged PRs | **216** | 1,184 commits; 215 + one second page |
| commits on `main` | **16** | 1,546 rows, with `parents[]` |
| releases | **2** | 129 rows |
| tags | **2** | 130 rows |
| workflow runs | **32** | 3,196 rows |
| issues (and PRs) | **5** | 406 rows |
| **total** | **276** | **5.5% of one hour's authenticated budget** |

Avoidable extras, listed so nobody re-discovers them the expensive way:

| if you also want | cost | cheaper route |
|---|---|---|
| `/commits/{sha}/pulls` for every trunk commit | +369 | parse `^Merge pull request #N` — free for 208 of 209 |
| jobs and steps for every run | +3,196 | run row already has conclusion and duration |
| `stats`/`files` per commit | +1,546 | don't; the metric is gameable anyway |
| `/timing` per run | +3,196 | `updated_at − run_started_at`, verified exact |

Swapping GraphQL in for pull requests and their commits:

| | REST | GraphQL |
|---|---|---|
| 215 merged PRs + every commit + labels + merge commit | 219 requests | **9 points** (9 pages, `cost: 1` each, measured) |
| rest of the backfill | 57 requests | REST |

**Full backfill: 276 REST requests, or 57 REST + 9 GraphQL points.** Either fits inside
one hour many times over. Serially, wall-clock time is the only real constraint, and
it is minutes, not hours.

### One incremental run

| dataset | hourly | daily |
|---|---|---|
| PRs by `updated_at`, stop at watermark | 1 | 1 |
| commits on `main`, `since=` | 1 | 1 |
| commits for newly-merged PRs (~13/week) | 0–1 | 1–3 |
| releases (full re-read) | 2 | 2 |
| tags (full re-read) | 2 | 2 |
| workflow runs, `created>=` | 1 | 3 |
| issues, `since=` | 1 | 1 |
| **total** | **~9** | **~13** |

**An hourly run costs about 9 requests — 0.2% of the budget. 24 of them cost 216, or
4.3% of one hour's budget spread over a day.** Rate limit does not constrain the
cadence at any sane frequency, and §1 means correctness does not either.

### REST versus GraphQL, per dataset

| dataset | use | why |
|---|---|---|
| **PRs + their commits** | **GraphQL** | 9 points versus 219 requests — 24× cheaper, one round trip per 25 PRs, and `additions`/`deletions`/`changedFiles` come free. Cross-checked against REST on 215 of 215 first-commit dates. |
| **Commits on `main`** | **REST** | `parents[]` is what makes the first-parent chain reconstructible. GraphQL `history()` has no first-parent option and would hand back the same 1,546-node DAG with no trunk. |
| **Releases and tags** | **REST** | 4 requests total. `target_commitish` as a SHA is exactly what the release join needs. Nothing to optimise. |
| **Workflow runs** | **REST — there is no choice** | Introspection: the `Repository` type exposes no workflow-run connection, and the `WorkflowRun` type has **no `conclusion` and no `status`** (its fields are `checkSuite`, `createdAt`, `databaseId`, `deploymentReviews`, `displayTitle`, `event`, `file`, `id`, `pendingDeploymentRequests`, `resourcePath`, `runAttempt`, `runNumber`, `updatedAt`, `url`, `workflow`). Reaching a conclusion means walking commits → check suites, which is more points for less data. |
| **Issues** | **REST** | 5 requests, and `since=` is a real server-side filter. GraphQL would need `pull_request == null` filtering client-side anyway. |

Verdict: **REST for everything except pull requests, GraphQL for pull requests.** That
is the only place the 24× applies, and it is the only place a token is genuinely
earning its keep.

### Two operational notes

**Retry, with backoff.** Measured during this research: 8 of 215 `/pulls/{n}/commits`
calls failed with `net/http: TLS handshake timeout` on the first attempt — **3.7%** —
and all 8 succeeded on retry with the full, correct commit list. These were transient
network failures that an ingest without retries would silently record as "this PR has
no commits". Treat an empty list for a PR whose `commits` count is non-zero as an
error, not as data.

**Do not parallelise hard.** The documented secondary limits are 100 concurrent
requests and 900 points per minute for REST. A backfill of 276 requests has no reason
to go above ~10 concurrent.

---

## 7. What authentication the ingest needs

**For a read-only ingest of this public repository: no credential at all.** Said
plainly because it simplifies a downstream decision.

Measured — every endpoint the ingest needs, called with `curl` and **no `Authorization`
header**:

```
200  repos/firetower-cloud/firetower
200  repos/firetower-cloud/firetower/pulls?state=all
200  repos/firetower-cloud/firetower/pulls/205/commits          ← squash-merged, branch deleted
200  repos/firetower-cloud/firetower/commits?sha=main
200  repos/firetower-cloud/firetower/commits/cb75b3ede…         ← orphaned commit, unreachable from every ref
200  repos/firetower-cloud/firetower/commits/4b023f3d…/pulls
200  repos/firetower-cloud/firetower/releases
200  repos/firetower-cloud/firetower/tags
200  repos/firetower-cloud/firetower/actions/runs
200  repos/firetower-cloud/firetower/actions/runs/31940266810/jobs
200  repos/firetower-cloud/firetower/actions/workflows
200  repos/firetower-cloud/firetower/issues?state=all
```

Twelve for twelve, including all three Actions endpoints and the unreachable commit.
There is **no scope** that unlocks anything the ingest needs, because nothing it needs
is gated. A token with zero scopes would work exactly as well as one with `repo`.

What a token actually buys:

1. **Rate limit: 5,000/hour instead of 60/hour.** The 276-request backfill is ~4.6
   hours of unauthenticated budget; a 9-request hourly run fits with room to spare. So
   unauthenticated is *viable*, even for the backfill, if it is paced.
2. **GraphQL at all.** Unauthenticated GraphQL is `403` (measured). Without a token the
   PR commits cost 219 REST requests instead of 9 points — which turns the backfill
   from 276 requests into 276 requests at 60/hour, still fine, but removes the headroom.
3. **A budget that is actually yours.** This is the real argument. The unauthenticated
   limit is per **originating IP address** (documented, quoted above). A Cloud Run
   service egresses through shared Google NAT, so an unauthenticated ingest shares its
   60/hour with whatever else is behind that address. The budget is not merely small —
   it is not predictable.

**Recommendation for the credential ticket.** Run authenticated, and make it the
smallest possible credential:

- A **fine-grained personal access token with no repository permissions granted** —
  public-repository read access is what an unscoped token already has. Or a classic PAT
  with **no scopes ticked**.
- Equivalently, a GitHub App installation token with no permissions, if the project
  would rather not hold a user-bound token.
- Explicitly **not** `repo`, not `workflow`, not `read:org`. The token on this machine
  carries `repo` and `workflow`; neither was needed for any call in this document.
- If secret management is the expensive part of the credential ticket, **no credential
  is a defensible answer** — 60 requests/hour against 9 per run leaves a 6× margin, and
  the only thing lost is GraphQL and a predictable ceiling. The one caveat: the
  first-run backfill must then be paced across ~5 hours, or run once from a machine
  that does have a token.

Do note the asymmetry for later: the moment this ingest is pointed at anything private
— `backend`, `firetower-terraform` — all of the above stops being true and it needs
`repo`-equivalent read. The "no credential" answer is a property of
`firetower-cloud/firetower` being public, not of the design.

---

## What this invalidates

Four things in the map's Notes do not survive a live call. Flagged here rather than
edited into #399, which this session does not own.

**1. "82 of 215 merged PRs are `chore: release main`" — the count is right, the
identifier is not.** 82 is correct, but only **42** carry that title. The other 40 are
`chore(main): release firetower 0.2.0`…`0.32.2` from the single-package era. Any work
already built on the title filter is counting 40 release PRs as work. Switch to
`head.ref LIKE 'release-please--branches--%'`. — §4

**2. "504 commits on `main`" does not reproduce, and the commit-type counts are
directionally wrong.** Three precise definitions, all measured today:

| definition | count |
|---|---|
| `GET /commits?sha=main` — the full DAG reachable from `main` | **1,546** |
| `git rev-list --first-parent main` — the trunk | **369** |
| non-merge commits in the full DAG | **1,309** |

None is 504, and no filter tried (date windows, unique subjects, PR-borne commits,
excluding other branch tips) produced it. The likely cause is a shallow or partial
clone in the charting session's worktree, but that is a guess.

It matters because the type histogram is not merely differently scaled, it is
differently **ordered**:

| | map's Notes | full DAG (1,309 non-merge) | trunk only (160 non-merge) |
|---|---|---|---|
| `feat` | **143** | 344 | 51 |
| `fix` | **110** | **411** | **65** |
| `chore` | 107 | 176 | 9 |

The map concludes `feat > fix`. **Every reproducible population has `fix > feat`.** A
"what did we ship" chart built on the map's numbers would show the wrong thing about
the project. Whoever defines the work-mix metric must first pick a population — trunk
or DAG — and say so on the page, because the two differ by 4×.

**3. "0 non-conventional, enforced by `commits.yml`" is true only for the last nine
days.** `commits.yml` was created **2026-11-09T13:07** (measured via
`/actions/workflows`). Measured over the full DAG: **115 of 1,309 non-merge commits
(8.8%) carry no conventional type** — `2026-08`: 6, `2026-09`: 9, `2026-10`: 19,
`2026-11`: 81 — and **zero** after `2026-11-09T13:07`. Enforcement works perfectly and
is nine days old. Type-based metrics need an explicit `untyped` bucket for the first 13
of 15 weeks, or they will quietly attribute 8.8% of the repository's history to
nothing. (The check reads every commit on the branch, not the PR title — the map's
reading of it is right.)

**4. "129 releases is roughly 43 release events" — it is 81.** Measured by grouping the
127 versioned releases on `target_commitish`: 52 single-package, 12 two-package, 17
three-package = **81 events**. The three-at-once pattern is real but is 21% of events,
not the rule. If deployment frequency is defined per release *event*, the number is
roughly double what the map assumes. — §3

**One thing the map does not know, and should.** 155 of `main`'s 369 trunk commits
(42%) were pushed directly, with no PR — 123 in August, 32 in September, **none after
2026-09-25**. The merge loop is only well-defined from that date. Charts that start at
`2026-08-13` will show a merge rate climbing out of nothing, and that curve is the
repository adopting pull requests, not the project speeding up. — §3

---

## Appendix: the calls

Reproducible, in the order they appear above. `-R`/owner-repo is
`firetower-cloud/firetower` throughout.

```bash
# §1 merge kind, orphan survival
gh api repos/firetower-cloud/firetower --jq '{delete_branch_on_merge,allow_squash_merge}'
gh api --paginate 'repos/firetower-cloud/firetower/pulls?state=all&per_page=100'
gh api --paginate 'repos/firetower-cloud/firetower/commits?sha=main&per_page=100'   # join merge_commit_sha -> parents|length
gh api repos/firetower-cloud/firetower/branches/agent/optimise-memory-on-desktop-app-diff-section   # 404
gh api 'repos/firetower-cloud/firetower/pulls/205/commits?per_page=100'
gh api repos/firetower-cloud/firetower/commits/cb75b3edeb3035d3e8ff5abe2f3088f407d0fe22
git cat-file -e cb75b3edeb3035d3e8ff5abe2f3088f407d0fe22   # fails: unreachable from every ref

# §2 workflow run horizon
gh api 'repos/firetower-cloud/firetower/actions/runs?per_page=1' --jq .total_count          # 3196
gh api 'repos/firetower-cloud/firetower/actions/runs?per_page=100&page=32'                 # oldest: run_number 1
gh api --paginate 'repos/firetower-cloud/firetower/actions/workflows/335483375/runs?per_page=100'
gh api repos/firetower-cloud/firetower/actions/runs/31940266810/logs -i                    # 410 Gone
gh api repos/firetower-cloud/firetower/actions/runs/44289825225/logs -i                    # 200 OK
gh api repos/firetower-cloud/firetower/actions/runs/31940266810/jobs
gh api repos/firetower-cloud/firetower/actions/runs/31940266810/timing

# §3 linkage
gh api repos/firetower-cloud/firetower/commits/a96ecfc0c7dba81e50f54e58ab775a6d33579a1b/pulls
gh api --paginate 'repos/firetower-cloud/firetower/releases?per_page=100'
gh api --paginate 'repos/firetower-cloud/firetower/tags?per_page=100'

# §4 release-please identity
#   group merged PRs by head.ref prefix / labels[].name / user.login / title

# §6 GraphQL cost
gh api graphql -f query='query($cursor:String){ rateLimit{cost} repository(owner:"firetower-cloud",name:"firetower"){
  pullRequests(first:25,states:MERGED,orderBy:{field:CREATED_AT,direction:ASC},after:$cursor){
    pageInfo{hasNextPage endCursor}
    nodes{number mergedAt headRefName mergeCommit{oid} labels(first:10){nodes{name}}
          commits(first:100){totalCount nodes{commit{oid authoredDate messageHeadline}}}}}}}'
# -> 9 pages, cost 1 each

# §7 no credential
curl -s -o /dev/null -w '%{http_code}' -H 'Accept: application/vnd.github+json' \
  https://api.github.com/repos/firetower-cloud/firetower/actions/runs   # 200
curl -s https://api.github.com/rate_limit | jq .rate                    # limit 60
curl -s -o /dev/null -w '%{http_code}' -X POST -d '{"query":"{viewer{login}}"}' \
  https://api.github.com/graphql                                        # 403
```

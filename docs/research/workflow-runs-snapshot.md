# Workflow run snapshot — captured because it expires

`workflow-runs-snapshot.json` is **3,196 workflow runs** of
`firetower-cloud/firetower`, every run from the first
(`2026-08-16T09:54:18Z`, `run_number: 1`) to `2026-11-18T10:54:53Z`.

## Why this file exists

GitHub documents a **90-day retention for workflow runs** in public
repositories. Every other dataset this effort needs — pull requests, commits,
releases, issues — can be re-read from the API at any time, so keeping a copy
is only ever convenience. **Runs are the exception: this history cannot be
backfilled later.** It was captured on 2026-11-18 while it was still complete.

It is deliberately *not* a decision to build anything on it. Wayfinder map #399
left "whether CI health belongs on the dashboard at all" unresolved, and #403
rejected CI failures as the change failure rate. This is insurance so that the
option stays open rather than expiring while the question is undecided.

## What is in it

One object per run, sorted oldest first, carrying only the fields a metric
could want: `id`, `name`, `head_branch`, `head_sha`, `event`, `status`,
`conclusion`, `workflow_id`, `run_number`, `run_attempt`, `created_at`,
`updated_at`, `run_started_at`. No logs — those expire sooner and are far
larger.

Conclusions across the whole history: 1,765 success, 648 skipped, **411
failure**, 227 action_required, 121 cancelled, 24 null.

## The one thing to know before using it

`head_branch` is the branch, not the trunk. A run's presence here does not mean
it ran on `main`, and the 411 failures are overwhelmingly branch runs — which
is CI doing its job, not a production incident. Any "how often is `main` red"
figure has to filter on `head_branch == "main"` first.

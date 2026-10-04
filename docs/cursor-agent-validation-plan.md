# Remaining Cursor validation plan

Baseline: fce82f3; tracking: salim4n/firetower#1; maintainer PR still to create after authorized preparation.

## Analysis

First native failure reached Launch without TmuxOpened; later fresh starts pass, so its exact cause remains unknown. Timed Docker diagnostics currently drop output futures without terminating children, a concrete process leak under a wedged daemon. macOS memory measurement only uses Linux files. Fork CI selects unavailable Depot runners. Cursor ACP documents Task completion but no nested child tool stream. Invalid credentials are distinct from a valid account without entitlement.

## Scope and decisions

1. Bound diagnostic subprocess lifetime (kill on dropped timeout) and add a real stalled-child regression. Add native macOS memory reporting without weakening Linux cgroup logic, and prove the formerly failing test.
2. Use GitHub hosted runners for fork PR checks only, preserving Depot for upstream same-repository PRs and manual jobs. Inspect required packages and actual final-head job results; do not alter billing or install self-hosted runners.
3. Repeat fresh native Tauri first launches with lifecycle read-back on matching rebuilt backend. Do not claim the original cause fixed from a successful repeat.
4. Probe/document official provider Task capability; faithfully display emitted data, never synthesize child events. Valid expired/unentitled provider proof requires a dedicated account; user input requested.
5. Synchronize with current maintainer main and resolve integration conflicts without discarding work. Review independently against this baseline, then full affected tests and live evidence, update tracking issue/PR and create authorized upstream draft with honest checklist.

## Acceptance

- Timed diagnostic child is gone after timeout, normal command output preserved.
- Worker memory suite passes on native macOS; Linux branch remains intact and runs in CI.
- Fork CI executes required checks on final head; queued/skipped is not PASS.
- Fresh Tauri starts and an actual ACP prompt complete; original failure diagnosis remains separate if unreproducible.
- Real provider entitlement error and recovery are proven only with a genuine suitable test account.
- Parent Task data and any actually emitted child data are visible; absent provider capability remains NOT PROVEN.

Preserve unrelated workers, containers, databases and subscriptions. No destructive cleanup. Issue remains open/PR draft until all gates are proven.

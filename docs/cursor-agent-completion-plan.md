# Cursor Agent completion plan

Baseline: `3a26a2a6744a63dadcb70c10dd08e03a30e728a7`; issue salim4n/firetower#1; PR #4.

## Analysis

Existing Android Maestro and Chromium happy paths pass. Native Tauri first launch failed then recovered. Its cause is not established. Live permission effects, cancellation, restart, provider failures and child activity remain incomplete. CI is queued. Preserve isolated test data and credentials; never publish credentials or manufacture provider events.

## Implementation decisions

1. Diagnose the failed native launch from server lifecycle and worker records; fix its cause and add a targeted regression if reproducible.
2. Extend reproducible live scenarios for approval/denial of harmless disposable-file operations, cancellation, restart/load and reconnect without automatic replay. Verify filesystem effects as well as transcript.
3. Probe actual provider errors and Task events. Render emitted activity faithfully; document unavailable child tools as an open provider capability gap. Keep simulated fixtures distinct from real-provider acceptance.
4. Build matching server, worker, Tauri and Android source, review changes against this baseline, then rerun affected fixtures, typechecks and native/browser scenarios on the final implementation commit. Inspect CI's actual runner/results.

## Acceptance and verification

- New Cursor workspace launches on first attempt in actual Tauri; fresh screenshot/report.
- Approval produces its intended disposable effect; denial prevents it.
- Cancellation leaves no perpetual Working; restart and client reconnect retain context without duplicate prompts/events.
- Actual provider failure is readable in Chromium, native Android and Tauri.
- Emitted Task identity/status/completion is visible. Missing provider child events remain explicitly NOT PROVEN.
- Final-head build identities and runtime artifacts are recorded; checks finish successfully or their exact external blocker is identified.

## Scope and exclusions

Complete the four outstanding review gates of issue #1. No transport migration for Claude/Codex, production deployment, account changes, or upstream review request. Existing issue is reused for tracking. PR remains draft while any required gate is not proven.

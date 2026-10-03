# Cursor Agent remaining acceptance work

## Correction and regression

A real native Tauri permission was left pending across a control-plane/local-worker restart. The UI replayed its approval card, but Fleet had lost its in-memory pending questions. A decision therefore failed before reaching Cursor. Fleet now restores unanswered protocol requests while replaying its stored journal, retaining the original epoch/request ID and removing resolved requests. Replay sends no provider frames. A real agent exit persists a terminal status; historical questions are not restored outside a blocked/in-flight turn. The database regression failed before this change and passed after it; it also verifies that a responded permission is not resurrected.

## Authenticated live observations, macOS arm64

CLI `2026.09.28-64d2043`, isolated PostgreSQL 14, Firetower local worker, disposable repository, actual unsigned Tauri application:

- One new native workspace launched on its first attempt: Workspace/Fetch/Worktree/Launch, TmuxOpened, AgentLaunched, Ready. This successful repeat does not establish the cause or correction of the earlier first-launch failure.
- Shell `printf` approval reached Cursor's offered `allow-once`; filesystem read-back was exactly `SHELL APPROVED`. Edit File ran without a permission request and was not counted as approval evidence.
- Before the fix, refusal following server restart did not reach the provider. Cancellation recovered this blocked turn; the journal contains `session/cancel` and `stopReason: cancelled`.
- After the fix, another permission was opened, the server/local worker restarted, and native Deny reached Cursor. The provider completed and `restart-denied.txt` remained absent.
- A Task using `explore` was rejected by this running CLI, which listed its allowed types. Retrying a read-only Task using `generalPurpose` returned the README line. The parent stream contains Task tool updates and `cursor/task`; it does not expose the child's own tool/progress events. This remains an open provider capability gap.

Playwright's opt-in `FIRETOWER_E2E_PERMISSIONS=1` now checks a real Shell approval with before/after filesystem assertions, a denied Shell with no resulting file, cancellation while waiting for a permission. With `FIRETOWER_E2E_FOLLOWUP=1`, it also checks follow-up memory and reload without duplicate answers. `FIRETOWER_E2E_TASKS=1` exercises a real generalPurpose Task and the concrete invalid-enum rejection of explore, checking the installed CLI version first. All three flags require `FIRETOWER_E2E_RUN=1`. Set `FIRETOWER_E2E_WORKER_ROOT` to the isolated local worker root. These scenarios do not mock API/provider responses.

## Remaining gates

The full issue remains NOT PROVEN. The earlier native first-launch failure has no established cause; expired/unentitled account failure has not been induced on the subscription; native Android provider failures and Task activity still need a matching-build run. Full final-head checks and native evidence must be recorded separately. GitHub backend jobs were read as queued on `depot-ubuntu-22.04`, with `runner_id: 0`; no CI test passed merely by being queued.

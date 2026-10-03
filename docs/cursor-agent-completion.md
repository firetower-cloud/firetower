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

## Final implementation and verification (2026-10-03)

- Established worker socket EOF closes the agent only when a tmux probe confirms the matching session is absent. Unknown probe failures and watcher loss retain recovery semantics. Real Unix socket/tmux regressions cover killed and live processes.
- Conversation terminal reconciliation resolves historical pending permission/user-input cards and fails an active turn, including after reload. Live cursors advance monotonically.
- Native Android approval content retains actual ACP rawInput (or complete toolCall fallback) inside a bounded vertical scroller, with decision buttons outside it.
- Full Playwright run on backend ba5ad43 passed login/install, real turn, approval filesystem effect, refusal absence, cancellation, memory/reconnect, Task/rejection, abrupt process exit before/after reload, and stored authentication failure/recovery UI. Add FIRETOWER_E2E_CLOSE=1 and FIRETOWER_E2E_FAILED_SESSION=<failed-session-id> to the flags above. Credentials were invalidated only in an isolated per-session copy and then restored; this is not proof of an expired or unentitled subscription.
- Native Tauri restarted the failed session with restored credentials and returned `NATIVE RECOVERED` plus the correct earlier README line. Two fresh native workspaces launched first attempt; the original first-launch failure still has no established root cause.
- Android API34 arm64 debug build succeeded. Actual native Task and rejected Task flows passed; approval/refusal/cancellation passed with host filesystem read-back (`MOBILE APPROVED`, denied file absent). The full bounded-card flow exited 0: exact command visible before approval, Allow/No accessible, cancellation clears the question; filesystem assertions passed again.
- Backend final-source tests: server 364 passed; core 117 passed; proto 21 passed; worker 237 passed, 1 ignored, 1 failed (existing Linux-only memory-capacity test reads /proc and /sys unavailable on macOS). ACP fixtures 7 + 12 passed. Desktop tests 385 passed; web/desktop/mobile typechecks passed. Do not interpret this as an entirely green cross-platform suite.
- Both completion review agents found no blocking issues in the final worker/approval changes. A custom tmux remain-on-exit setting remains a documented edge.

## Remaining gates — BLOCKED / NOT PROVEN

Original first-launch failure: successful fresh repeats do not establish its correction. Provider Task parent activity is visible, but Cursor did not emit child tool/progress events. Expired/unentitled subscription acceptance is untested. GitHub fork runners are absent, jobs queued; CI must run on the pushed final head before readiness. PR remains draft and issue remains open.

Evidence is under [cursor-completion](evidence/cursor-completion). Screenshots contain disposable test workspaces, not credential files. Runtime source is ba5ad43 (backend) and 16ad69a (mobile product); later commits adjust native test orchestration and documentation only.

Verified product subtree identities (unchanged by evidence/test-orchestration commits):

- `crates`: `af3d94c14da4e32e3a1556efbcf22f2191248ce3`
- `desktop/src`: `7a043d6f60592c7f585040e5805eb1720d9ddc59`
- `mobile/src`: `332498557da7006c9b882226f5aadc11f757decd`
- `web/src`: `fd2d7988327bded36993b54dc707c4724c138acb`

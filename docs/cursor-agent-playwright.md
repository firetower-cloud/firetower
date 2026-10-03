# Cursor Agent Playwright evidence

On 2026-10-03, the Desktop renderer was driven by Playwright Chromium 1243 against a real Firetower 0.42.0 server, local worker, isolated PostgreSQL 14 database, and Cursor Agent `2026.09.28-64d2043` on macOS arm64. The server and worker were built from `1f585b3c5c15ae7ac27a63cabaf076972fe5ace5`. No API route was mocked. The test account was connected through Firetower and approved on Cursor's real browser sign-in page.

The browser test is [`desktop/e2e/cursor-live.mjs`](../desktop/e2e/cursor-live.mjs). Run it with the Desktop Vite renderer, server, and worker from the same checkout, and an isolated Firetower home/database. Set `FIRETOWER_E2E_PASSWORD` to that server's administrator password. The first run checks installation. With `FIRETOWER_E2E_CONNECT=1`, it starts the provider sign-in and prints a short-lived approval URL; approve it in a browser signed in to the intended Cursor account. With `FIRETOWER_E2E_RUN=1` and `FIRETOWER_E2E_REPOSITORY` pointing to a disposable local Git repository containing a one-line `README.md`, it creates a workspace, sends a read-only prompt, and waits for the line and an idle state. Use a fresh isolated backend for a first-user run. Screenshots are written outside the checkout by default.

## Observed results

| Journey | Result |
| --- | --- |
| Control-plane login, Cursor catalog row, install on initially empty worker | PASS. Server logged installation of the pinned version. |
| Firetower account connection via Cursor subscription login | PASS. Browser sign-in finished; account row showed connected and default. |
| Desktop renderer picker, local workspace, real ACP turn | PASS once. The reply contained `Playwright Cursor ACP smoke test.` and the session returned from Working to idle. The activity showed search and read-file steps. [Screenshot](evidence/cursor-agent-playwright-turn.png). |
| Repeat new workspace and send immediately | FAIL intermittently. One later attempt received `AgentUnavailable` because no session socket was listening when the turn was sent; no reply appeared within 120 seconds. This needs a product fix and a fresh repeat of the test. |

This proves the shared Desktop renderer in Chromium. It does not prove the installed Tauri app or native mobile app. Live approval/denial, cancellation, restart/reconnect, expired account errors, and Cursor child tool progress remain open acceptance checks. The screenshot contains only disposable test names and no credential material.

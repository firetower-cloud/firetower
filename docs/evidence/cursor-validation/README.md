# Cursor live validation, 2026-10-04

Implementation: 65f76585. Unsigned macOS Tauri, Android API34 arm64 debug client, real local worker/PostgreSQL, pinned Cursor CLI 2026.09.28-64d2043, disposable git repository.

The native-stalled capture is the failing baseline. native-fixed and first-launch-events show one fresh launch and the real response after correcting probe stdin. Cursor-stdin-observation uses the actual CLI on an isolated pipe. Probe/readiness red logs are expected failures before their fixes; worker-tests and workspace-clippy are the passing corrected gates.

Playwright and all three native Maestro flows passed. Mobile filesystem assertions are independent of UI text; provider counts confirm Task notifications and cancellation. Screenshots represent real provider responses, not mocked routes. Expired subscription and child progress/tool streaming remain NOT PROVEN; see the completion report.

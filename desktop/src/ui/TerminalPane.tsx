/**
 * A terminal, as far as a fixture goes.
 *
 * The real one is xterm over a WebSocket to the worker's pty. Nothing here
 * tests that, so this draws the surface at the right density and stops — the
 * open question about xterm is render latency under WKWebView, and that needs a
 * real stream to answer, not a prettier mock.
 *
 * What it does take seriously is where it starts. A terminal opens at the
 * **bottom**: the interesting line is the last one and the prompt is under it,
 * and one that opens at the top of a long scrollback makes you scroll to find
 * out what happened — which is the opposite of why it was opened.
 */
import { useLayoutEffect, useRef } from "react";
import type { Workspace } from "@/src/api/workspaces";

const LINES: [string, string][] = [
  ["prompt", "just check"],
  ["dim", "    Checking ft-core v0.32.2"],
  ["dim", "    Checking ft-proto v0.32.2"],
  ["dim", "    Checking ft-worker v0.32.2"],
  ["dim", "    Checking ft-server v0.32.2"],
  ["dim", "    Finished `dev` profile in 11.84s"],
  ["", ""],
  ["prompt", "cargo test -p ft-server auth::"],
  ["dim", "   Compiling ft-server v0.32.2"],
  ["dim", "    Finished `test` profile in 6.42s"],
  ["dim", "     Running unittests src/lib.rs"],
  ["", ""],
  ["dim", "running 14 tests"],
  ["ok", "test auth::policy_reads_the_environment ... ok"],
  ["ok", "test auth::proxy_header_needs_upstream ... ok"],
  ["ok", "test auth::open_only_on_loopback ... ok"],
  ["ok", "test auth::device::single_use ... ok"],
  ["ok", "test auth::device::expires_after_ten_minutes ... ok"],
  ["ok", "test auth::device::rejects_unknown_code ... ok"],
  ["ok", "test auth::device::binds_to_the_user_who_approved ... ok"],
  ["ok", "test accounts::sessions_slide_for_thirty_days ... ok"],
  ["ok", "test accounts::lockout_after_five_attempts ... ok"],
  ["ok", "test accounts::revocation_is_immediate ... ok"],
  ["ok", "test accounts::one_organization_per_installation ... ok"],
  ["ok", "test vault::owner_is_in_the_primary_key ... ok"],
  ["ok", "test vault::credential_for_distinguishes_the_asker ... ok"],
  ["ok", "test api::bootstrap_needs_no_token ... ok"],
  ["", ""],
  ["dim", "test result: ok. 14 passed; 0 failed; 0 ignored; finished in 0.41s"],
  ["", ""],
  ["prompt", "git status --short"],
  ["warn", " M crates/ft-server/src/api/auth.rs"],
  ["warn", "?? migrations/server/20260912160000_device_codes.sql"],
];

export function TerminalPane({ place }: { place: Workspace }) {
  const view = useRef<HTMLDivElement>(null);

  /* Before paint, not after: `useEffect` would show the top of the scrollback
     for a frame and then jump, which reads as the pane flinching open. */
  useLayoutEffect(() => {
    const el = view.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  return (
    <div ref={view} className="scroll-slim h-full overflow-auto bg-ground p-4 font-mono text-code">
      <div className="text-mute">{place.branch}</div>

      {LINES.map(([kind, text], i) => (
        <div
          key={i}
          className={
            kind === "ok"
              ? "text-sage"
              : kind === "warn"
                ? "text-kind-data"
                : kind === "dim"
                  ? "text-dim"
                  : kind === "prompt"
                    ? "text-bone"
                    : ""
          }
        >
          {kind === "prompt" && <span className="mr-1.5 text-mute">$</span>}
          {text || " "}
        </div>
      ))}

      <div className="flex items-center text-bone">
        <span className="mr-1.5 text-mute">$</span>
        <span className="inline-block h-3.5 w-[7px] animate-pulse bg-bone" />
      </div>
    </div>
  );
}

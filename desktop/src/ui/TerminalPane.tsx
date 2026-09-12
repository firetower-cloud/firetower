/**
 * A terminal, as far as a fixture goes.
 *
 * The real one is xterm over a WebSocket to the worker's pty. Nothing here
 * tests that, so this draws the surface at the right density and stops — the
 * open question about xterm is render latency under WKWebView, and that needs a
 * real stream to answer, not a prettier mock.
 */
import type { Workspace } from "@/src/api/workspaces";

const LINES: [string, string][] = [
  ["prompt", "cargo test -p ft-server auth::"],
  ["dim", "   Compiling ft-server v0.32.2"],
  ["dim", "    Finished `test` profile in 6.42s"],
  ["dim", "     Running unittests src/lib.rs"],
  ["", ""],
  ["dim", "running 14 tests"],
  ["ok", "test auth::device::single_use ... ok"],
  ["ok", "test auth::device::expires_after_ten_minutes ... ok"],
  ["ok", "test auth::device::rejects_unknown_code ... ok"],
  ["ok", "test auth::proxy_header_needs_upstream ... ok"],
  ["", ""],
  ["dim", "test result: ok. 14 passed; 0 failed; 0 ignored"],
];

export function TerminalPane({ place }: { place: Workspace }) {
  return (
    <div className="h-full overflow-auto bg-ground p-4 font-mono text-code">
      <div className="text-mute">{place.branch}</div>
      {LINES.map(([kind, text], i) => (
        <div
          key={i}
          className={
            kind === "ok" ? "text-sage" : kind === "dim" ? "text-dim" : kind === "prompt" ? "text-bone" : ""
          }
        >
          {kind === "prompt" && <span className="mr-1.5 text-mute">$</span>}
          {text || " "}
        </div>
      ))}
      <div className="flex items-center text-bone">
        <span className="mr-1.5 text-mute">$</span>
        <span className="inline-block h-3.5 w-[7px] animate-pulse bg-bone" />
      </div>
    </div>
  );
}

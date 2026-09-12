/**
 * A title bar that spans the window.
 *
 * The first arrangement put the traffic lights over the rail: with the title bar
 * hidden, AppKit still draws them at the window's top-left, and a 48px strip is
 * narrower than the 78px they need. Reserving that space inside the strip only
 * moved the overlap one column right.
 *
 * So the chrome is a row of its own, full width — the lights get their gutter,
 * everything below starts at a clean edge, and the whole bar drags the window
 * except the controls in it.
 */
import { Command } from "lucide-react";
import { bridge } from "~/bridge";
import { BACKENDS } from "~/mock/backends";
import type { Scope } from "~/ui/ServerStrip";

export function Titlebar({
  scope,
  waiting,
  onPalette,
}: {
  scope: Scope;
  waiting: number;
  onPalette: () => void;
}) {
  const here = scope === "all" ? null : BACKENDS.find((b) => b.id === scope);

  return (
    <div
      className="drag flex h-(--chrome-title) shrink-0 items-center gap-2 border-b border-line bg-(--color-strip)"
      style={{ paddingLeft: bridge.native ? "var(--chrome-lights)" : "0.75rem" }}
    >
      <span className="text-ui text-dim">
        {here ? (
          <>
            <span className="text-bone">{here.org}</span>
            <span className="mx-1.5 text-mute">/</span>
            <span>{here.user}</span>
          </>
        ) : (
          <span className="text-bone">Everything</span>
        )}
      </span>

      {/* Ember, in the chrome. The same number that goes on the dock. */}
      {waiting > 0 && (
        <span className="ml-1 rounded-full border border-ember-deep bg-ember-tint px-1.5 text-meta font-semibold text-ember-soft">
          {waiting}
        </span>
      )}

      <button
        onClick={onPalette}
        className="no-drag ml-auto mr-2 flex h-6 items-center gap-1 rounded-sm px-2 text-meta text-mute transition-colors hover:bg-raise hover:text-dim"
      >
        <Command className="h-3 w-3" strokeWidth={2} />K
      </button>
    </div>
  );
}

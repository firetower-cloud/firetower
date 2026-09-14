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
import { Command, Minus, Square, X } from "lucide-react";
import { isMac, mod } from "~/platform";
import { bridge } from "~/bridge";
import { drag } from "~/drag";
import { useFleet } from "~/fleet";
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
  const fleet = useFleet();
  const here = scope === "all" ? null : fleet.find((f) => f.backend.id === scope)?.backend;

  return (
    <div
      {...drag}
      className="flex h-(--chrome-title) shrink-0 items-center gap-2 border-b border-line bg-(--color-strip)"
      style={{ paddingLeft: bridge.native && isMac ? "var(--chrome-lights)" : "0.75rem" }}
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

      <span className="flex-1 self-stretch" />

      <button
        onClick={onPalette}
        className="no-drag mr-2 flex h-6 items-center gap-1 rounded-sm px-2 text-meta text-mute transition-colors hover:bg-raise hover:text-dim"
      >
        {isMac ? <Command className="h-3 w-3" strokeWidth={2} /> : <span>{mod}+</span>}K
      </button>

      {/* macOS draws its own lights at the left; everywhere else the window
          has no frame and these are the buttons, at the right, in the order
          and size the platform's own windows use. */}
      {!isMac && bridge.native && (
        <span className="no-drag flex h-full items-stretch">
          <button onClick={bridge.minimize} title="Minimize" className="grid w-11 place-items-center text-dim transition-colors hover:bg-raise hover:text-bone"><Minus className="h-3.5 w-3.5" strokeWidth={1.75} /></button>
          <button onClick={bridge.zoom} title="Maximize" className="grid w-11 place-items-center text-dim transition-colors hover:bg-raise hover:text-bone"><Square className="h-3 w-3" strokeWidth={1.75} /></button>
          <button onClick={bridge.close} title="Close" className="grid w-11 place-items-center text-dim transition-colors hover:bg-brick hover:text-ground"><X className="h-3.5 w-3.5" strokeWidth={1.75} /></button>
        </span>
      )}
    </div>
  );
}

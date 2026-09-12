/**
 * A title bar that spans the window.
 *
 * The first arrangement put the traffic lights over the inbox: with the title
 * bar hidden, AppKit still draws them at the window's top-left, and a 48px strip
 * is narrower than the 78px they need. Reserving that space inside the strip
 * only moved the problem one column right.
 *
 * So the chrome is a row of its own, full width, the way Xcode and VS Code do it
 * on a Mac — the lights get their gutter, everything below starts at a clean
 * edge, and the whole bar is draggable except the controls in it.
 */
import { Command, Minus, Square } from "lucide-react";
import { bridge } from "~/bridge";
import type { Row } from "~/backend";

export function Titlebar({ row, waiting, onPalette }: { row?: Row; waiting: number; onPalette?: () => void }) {
  return (
    <div
      className="drag flex h-(--chrome-title) shrink-0 items-center gap-2 border-b border-line bg-(--color-strip)"
      style={{ paddingLeft: bridge.native ? "var(--chrome-lights)" : "0.75rem" }}
    >
      <span className="text-ui text-dim">
        {row ? (
          <>
            <span className="text-bone">{row.name}</span>
            <span className="mx-1.5 text-mute">·</span>
            <span>{row.backend.org}</span>
          </>
        ) : (
          "Firetower"
        )}
      </span>

      {/* Ember, in the chrome. The count is across every server, which is the
          same number that goes on the dock. */}
      {waiting > 0 && (
        <span className="ml-1 rounded-full border border-ember-deep bg-ember-tint px-1.5 text-meta font-semibold text-ember-soft">
          {waiting}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1 pr-2">
        <button onClick={onPalette} className="no-drag flex h-6 items-center gap-1 rounded-sm px-2 text-meta text-mute transition-colors hover:bg-raise hover:text-dim">
          <Command className="h-3 w-3" strokeWidth={2} />K
        </button>
        {!bridge.native && (
          <>
            <button onClick={() => bridge.minimize()} className="no-drag grid h-6 w-6 place-items-center rounded-sm text-mute hover:bg-raise">
              <Minus className="h-3 w-3" strokeWidth={2} />
            </button>
            <button onClick={() => bridge.zoom()} className="no-drag grid h-6 w-6 place-items-center rounded-sm text-mute hover:bg-raise">
              <Square className="h-2.5 w-2.5" strokeWidth={2} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

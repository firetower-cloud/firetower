/**
 * A title bar that spans the window, and says which Firetower you are in.
 *
 * The first arrangement put the traffic lights over the rail: with the title bar
 * hidden, AppKit still draws them at the window's top-left, and a 48px strip is
 * narrower than the 78px they need. Reserving that space inside the strip only
 * moved the overlap one column right.
 *
 * So the chrome is a row of its own, full width — the lights get their gutter,
 * everything below starts at a clean edge, and the whole bar drags the window
 * except the controls in it.
 *
 * **`org / user`, as text, at rest.** It is the one thing a client for several
 * Firetowers has to answer on every screen, and a monogram alone cannot: the
 * mark is two letters and two letters are an abbreviation, not an address. No
 * hover and no click is needed to read it — pressing it is the *second* way to
 * the switcher, which otherwise lives under the avatar.
 *
 * **And no ember count.** It used to carry the number waiting across every
 * connected Firetower, which is now the dock's and the island's job; a third
 * place saying it is a third place for it to disagree. What is left inside the
 * window is one dot on the rail's avatar meaning *waiting somewhere you are
 * not*.
 */
import { ChevronDown, Minus, PanelLeft, Square, X } from "lucide-react";
import { useState } from "react";
import { Icon } from "~/components/ui";
import { bridge } from "~/bridge";
import { drag } from "~/drag";
import { useFleet } from "~/fleet";
import { isMac, key } from "~/platform";
import { usePathname } from "~/shims/next-navigation";
import { usePanel } from "~/ui/panel";
import { FiretowerSwitcher } from "~/ui/ProfileMenu";
import { Pop } from "~/ui/Pop";

export function Titlebar({ serverId, onSwitch }: { serverId: string | null; onSwitch: (id: string) => void }) {
  const fleet = useFleet();
  const here = fleet.find((f) => f.backend.id === serverId)?.backend;
  const path = usePathname();
  const [pinned, setPinned] = usePanel(path);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <div
      {...drag}
      className="relative z-6 flex h-(--chrome-title) shrink-0 items-center gap-2.5 pr-3"
      style={{ paddingLeft: bridge.native && isMac ? "var(--chrome-lights)" : "0.75rem" }}
    >
      {here ? (
        <button
          onClick={(e) => setAnchor((held) => (held ? null : e.currentTarget))}
          aria-haspopup="menu"
          aria-expanded={!!anchor}
          title="Switch Firetower"
          className="no-drag flex h-7 items-center gap-2 rounded-lg py-0 pr-2.5 pl-1.5 transition-colors hover:bg-raise"
        >
          <span className="server-mark grid h-5 w-5 place-items-center text-micro" data-reach={here.reach}>
            {here.mark}
          </span>
          <span className="text-ui font-medium text-bone">{here.org}</span>
          <span className="text-ui text-line">/</span>
          <span className="text-ui text-mute">{here.user}</span>
          <span className="text-mute">
            <Icon of={ChevronDown} size={12} />
          </span>
        </button>
      ) : (
        <span className="text-ui text-bone">Firetower</span>
      )}

      {anchor && (
        <Pop anchor={anchor} onClose={() => setAnchor(null)} width={296}>
          <FiretowerSwitcher
            backend={here ?? null}
            onSwitch={onSwitch}
            onClose={() => setAnchor(null)}
          />
        </Pop>
      )}

      <span className="flex-1 self-stretch" />

      {/* The way back from a collapsed panel that is not a keystroke. */}
      {here && (
        <button
          onClick={() => setPinned(!pinned)}
          title={`${pinned ? "Hide the panel" : "Show the panel"}  ${key("\\")}`}
          aria-label={pinned ? "Hide the panel" : "Show the panel"}
          className="no-drag grid h-7 w-7 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-text"
        >
          <Icon of={PanelLeft} size={14} />
        </button>
      )}

      {/* macOS draws its own lights at the left; everywhere else the window
          has no frame and these are the buttons, at the right, in the order
          and size the platform's own windows use. */}
      {!isMac && bridge.native && (
        <span className="no-drag -mr-3 flex h-full items-stretch">
          <button onClick={bridge.minimize} title="Minimize" className="grid w-11 place-items-center text-dim transition-colors hover:bg-raise hover:text-bone"><Minus className="h-3.5 w-3.5" strokeWidth={1.75} /></button>
          <button onClick={bridge.zoom} title="Maximize" className="grid w-11 place-items-center text-dim transition-colors hover:bg-raise hover:text-bone"><Square className="h-3 w-3" strokeWidth={1.75} /></button>
          <button onClick={bridge.close} title="Close" className="grid w-11 place-items-center text-dim transition-colors hover:bg-brick hover:text-ground"><X className="h-3.5 w-3.5" strokeWidth={1.75} /></button>
        </span>
      )}
    </div>
  );
}

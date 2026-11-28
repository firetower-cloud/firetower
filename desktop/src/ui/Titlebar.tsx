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
 * **Served in a browser there is no bar at all.** Every reason this row exists
 * is the window's: the lights need their gutter, the frameless platforms need
 * their buttons, the whole strip drags, and the one sentence left on it named a
 * Firetower you could neither switch away from nor have arrived at by mistake.
 * A page in a tab has somebody else's title bar above it already, so this one
 * was 40px of grey across the top of every screen answering nothing. The text
 * went with it for the reason the mark did: with one Firetower, `org / user` is
 * a constant, and a constant is decoration.
 *
 * **The panel toggle was the one thing on it that still did something**, and it
 * is the panel's own now — `RailPanel`'s head carries it in both directions, so
 * a collapsed panel is pinned from the preview that hovering the rail opens.
 * Here it stays as well, because in a window there is a bar to put it on and
 * `STYLE.md` has it beside the account control. See `~/installed-app`.
 *
 * **And no ember count.** It used to carry the number waiting across every
 * connected Firetower, which is now the dock's and the island's job; a third
 * place saying it is a third place for it to disagree. What is left inside the
 * window is one dot on the rail's avatar meaning *waiting somewhere you are
 * not*.
 */
import { ChevronDown, Minus, PanelLeft, Square, X } from "lucide-react";
import { useState } from "react";
import { Icon, IconButton } from "~/components/ui";
import { bridge } from "~/bridge";
import { drag } from "~/drag";
import { useFleet } from "~/fleet";
import { advertisedKey, installedApp } from "~/installed-app";
import { isMac } from "~/platform";
import { usePathname } from "~/shims/next-navigation";
import { usePanel } from "~/ui/panel";
import { FiretowerSwitcher } from "~/ui/ProfileMenu";
import { Pop } from "~/ui/Pop";

/**
 * The bar, where there is a window to put one on.
 *
 * A wrapper rather than an early return inside `Bar`, because the gate has to
 * be answered before the hooks are: a component that returns `null` after
 * calling five of them is still subscribing a browser tab to the fleet, the
 * path and the panel for a row nobody will see. Both of `App.tsx`'s call sites
 * go through here — the bootstrap window as well as the main one — so neither
 * has to know, and a browser gets no row and no space where one was.
 */
export function Titlebar({ serverId, onSwitch }: { serverId: string | null; onSwitch: (id: string) => void }) {
  if (!installedApp()) return null;
  return <Bar serverId={serverId} onSwitch={onSwitch} />;
}

function Bar({ serverId, onSwitch }: { serverId: string | null; onSwitch: (id: string) => void }) {
  const fleet = useFleet();
  const here = fleet.find((f) => f.backend.id === serverId)?.backend;
  const path = usePathname();
  const [pinned, setPinned] = usePanel(path);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const panelLabel = pinned ? "Hide the panel" : "Show the panel";
  const panelKey = advertisedKey("\\");

  return (
    <div
      {...drag}
      className="relative z-6 flex h-(--chrome-title) shrink-0 items-center gap-2.5 pr-3"
      style={{ paddingLeft: isMac ? "var(--chrome-lights)" : "0.75rem" }}
    >
      {!here ? (
        <span className="text-ui text-bone">Firetower</span>
      ) : (
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
      )}

      {/* **Beside the account control, not at the far end.** The drawing puts
          this in a `margin-left:auto` group at the right of the title bar,
          which is a long way from anything and easy to miss — it was there,
          and the person who asked for it did not know it existed. Next to the
          name it is where you look for it.

          It is no longer the only way to *close* the panel besides `⌘\`: the
          panel's own head holds both directions, which is what a browser with
          no bar above it is left with. Two doors to one toggle, and this one
          is the window's. */}
      {here && (
        <IconButton
          of={PanelLeft}
          onClick={() => setPinned(!pinned)}
          label={panelLabel}
          hint={panelKey ? `${panelLabel}  ${panelKey}` : panelLabel}
          className="no-drag -ml-0.5"
        />
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

      {/* macOS draws its own lights at the left; everywhere else the window
          has no frame and these are the buttons, at the right, in the order
          and size the platform's own windows use. */}
      {!isMac && (
        <span className="no-drag -mr-3 flex h-full items-stretch">
          <button onClick={bridge.minimize} title="Minimize" className="grid w-11 place-items-center text-dim transition-colors hover:bg-raise hover:text-bone"><Minus className="h-3.5 w-3.5" strokeWidth={1.75} /></button>
          <button onClick={bridge.zoom} title="Maximize" className="grid w-11 place-items-center text-dim transition-colors hover:bg-raise hover:text-bone"><Square className="h-3 w-3" strokeWidth={1.75} /></button>
          <button onClick={bridge.close} title="Close" className="grid w-11 place-items-center text-dim transition-colors hover:bg-brick hover:text-ground"><X className="h-3.5 w-3.5" strokeWidth={1.75} /></button>
        </span>
      )}
    </div>
  );
}

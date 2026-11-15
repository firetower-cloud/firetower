/**
 * The 62px rail, and the panel it opens.
 *
 * What used to be here was a 256px column doing three jobs at once —
 * navigation, the workspace list and the configuration index — and swapping
 * between them. It is two things now: this, which is **where you can go**, and
 * `RailPanel`, which is **what is in the place you are pointing at**.
 *
 * Seven destinations and nothing under them but the avatar. 42px targets, 20px
 * icons, 4px gaps. Selection is a pill in the sheet's own colour, because the
 * selected destination is the sheet's handle; nothing else fills.
 *
 * **The rule and the two doors below it are gone.** Settings and Updates were
 * drawn here *and* as rows in the profile menu, and a thing in two places is a
 * thing with no home; the menu is the home. `destinations.ts` carries that
 * argument in full. What the rail keeps of Updates is the mark on the avatar,
 * which is `ProfileMenu`'s.
 *
 * ## Hover previews, and so does focus
 *
 * Pointing at a destination swaps the panel's contents without navigating.
 * Pressing it commits. It is a convenience rather than a load-bearing thing —
 * the rail works without it — but **focus does exactly what hover does**, so
 * nothing in here is reachable by pointer only. 180ms in and 240ms out, with
 * the panel itself cancelling both, so a diagonal path from an icon to a row
 * does not flicker.
 */
import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { navigate, usePathname } from "~/shims/next-navigation";
import { useFleet, waitingIn, type Backend } from "~/fleet";
import { isGlobalMod, key } from "~/platform";
import { useStart } from "~/start";
import { SETTINGS_HOME } from "~/ui/config/panes";
import { DESTINATIONS, destinationAt, type DestinationId } from "~/ui/destinations";
import { usePanel } from "~/ui/panel";
import { Palette } from "~/ui/Palette";
import { ProfileMenu } from "~/ui/ProfileMenu";
import { RailPanel } from "~/ui/RailPanel";

export function Rail({ backend, onSwitch, onForgot }: { backend: Backend; onSwitch: (serverId: string) => void; onForgot: () => void }) {
  const path = usePathname();
  const here = destinationAt(path);
  const start = useStart();
  const fleet = useFleet();
  /* One ember dot on the avatar, meaning *waiting somewhere you are not*. It
     is the whole of what the "all servers" scope and the Fleet screen used to
     do inside the window; the dock badge and the island still carry the
     machine-wide count. */
  const elsewhere = fleet.some((f) => f.backend.id !== backend.id && f.backend.reach === "live" && waitingIn(f.sessions) > 0);

  /* Which destination the panel is showing, when it is not the one you are
     in. Null means "the one you are in". */
  const [peek, setPeek] = useState<DestinationId | null>(null);
  const [pinned, setPinned] = usePanel(path);
  /* ⌘K. It lived in `Palette.tsx` with nothing importing it, no key opening
     it and nothing rendering it — so the tooltip-shaped promise of a palette
     has been in the tree for some time without one existing. */
  const [palette, setPalette] = useState(false);

  /* Hysteresis. One timer, because a pointer leaving an icon and arriving at
     the panel fires both edges and whichever lands last has to win. */
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hold = () => clearTimeout(timer.current);
  /**
   * Whether pointing at a destination should preview it.
   *
   * | destination | panel | preview |
   * |---|---|---|
   * | active | open | **no** — it is already on screen |
   * | active | collapsed | **yes** |
   * | not active | either | **yes** |
   *
   * It used to be "anything but the one you are on", which made the active
   * destination the one place a collapsed panel could never be glimpsed —
   * exactly the case somebody with the panel shut is in most of the time.
   */
  const previews = (to: DestinationId) => to !== here || !pinned;

  const startPeek = (to: DestinationId) => {
    hold();
    if (!previews(to)) return;
    timer.current = setTimeout(() => setPeek(to), 180);
  };
  const showPeek = (to: DestinationId) => {
    hold();
    setPeek(previews(to) ? to : null);
  };
  const endPeek = () => {
    hold();
    timer.current = setTimeout(() => setPeek(null), 240);
  };
  useEffect(() => hold, []);

  /* Leaving a destination is leaving its preview. Without this, pressing an
     icon would navigate *and* keep showing the panel of wherever the pointer
     drifted to on the way back. */
  useEffect(() => setPeek(null), [path]);

  /* **Pressing a destination navigates and nothing else.** The panel is
     open or shut because somebody chose it, and that choice persists. What
     a collapsed panel gives up is not the ability to see what is in a
     destination — hovering previews it — only the ability to see it without
     asking. The toggle and `⌘\` are the two things that change the choice. */
  const go = (href: string) => {
    hold();
    setPeek(null);
    navigate(href);
  };

  /* The panel's find glyph opens the same palette the key does. An event
     rather than a prop: the panel is three components down and nothing else
     between here and there has any business knowing about ⌘K. */
  useEffect(() => {
    const open = () => setPalette(true);
    window.addEventListener("firetower:palette", open);
    return () => window.removeEventListener("firetower:palette", open);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPeek(null);
        setPalette(false);
        return;
      }
      /* The *global* modifier only. ⌃ is the inspector's inside a workspace,
         and `e.metaKey || e.ctrlKey` would take it here first. */
      if (!isGlobalMod(e)) return;
      /* A focused terminal owns the keyboard, exactly as the workbench's own
         handler has it. Everything here is a window-level gesture, so none of
         it is the one exception. */
      if ((document.activeElement as HTMLElement | null)?.closest(".xterm")) return;

      const numbered = DESTINATIONS.find((d) => d.key === e.key);
      if (numbered) {
        e.preventDefault();
        go(numbered.href);
        return;
      }
      /* **⌘, survives the door going.** It is the one thing the rail still
         owns about Settings: a window-level gesture belongs to the window
         rather than to the menu that happens to list it. The menu's row
         carries the same hint, so the key is still advertised where Settings
         now lives. */
      if (e.key === ",") {
        e.preventDefault();
        go(SETTINGS_HOME);
        return;
      }
      /* **Inside the terminal ⌘K clears the buffer**, which is shipped
         behaviour and stays — the guard above has already returned by then,
         and `Shell.tsx` stops the key reaching here at all. Everywhere else
         it opens the palette. */
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((o) => !o);
        return;
      }
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        start();
        return;
      }
      /* The workbench owns the backslash inside a workspace — there it is the
         inspector rail that collapses, which is the one the width is being
         argued over. */
      if (e.key === "\\" && !path.startsWith("/sessions")) {
        e.preventDefault();
        setPeek(null);
        setPinned(!pinned);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const showing = peek ?? here ?? "home";
  const floating = !pinned && !!peek;

  return (
    <>
      <nav
        aria-label="Destinations"
        onMouseLeave={endPeek}
        className="relative z-5 flex w-(--rail) shrink-0 flex-col items-center gap-1 pt-0.5 pb-3.5"
      >
        {DESTINATIONS.map((d) => (
          <RailButton
            key={d.id}
            icon={d.icon}
            label={d.label}
            hint={key(d.key)}
            on={d.id === here}
            peeked={peek === d.id && previews(d.id)}
            onPick={() => go(d.href)}
            onPoint={() => startPeek(d.id)}
            onFocus={() => showPeek(d.id)}
          />
        ))}

        <span className="flex-1" />

        <ProfileMenu backend={backend} waitingElsewhere={elsewhere} onSwitch={onSwitch} onForgot={onForgot} />
      </nav>

      <Palette open={palette} onClose={() => setPalette(false)} />

      {(pinned || floating) && (
        <RailPanel
          at={showing}
          floating={floating}
          stale={backend.reach === "unreachable"}
          onCollapse={() => {
            setPeek(null);
            setPinned(false);
          }}
          onEnter={hold}
          onLeave={endPeek}
        />
      )}
    </>
  );
}

/**
 * One destination.
 *
 * The icon is drawn heavier than an icon inside a list — 1.8, and 2 when it is
 * the one you are on — because a rail icon is read before it is clicked and
 * there is no label under it to help. That is why these do not go through
 * `Icon`, which exists to stop exactly this kind of per-site weight: the rule
 * it enforces is right, and this is the one surface that argues with it.
 */
function RailButton({
  icon: Glyph,
  label,
  hint,
  on,
  peeked,
  onPick,
  onPoint,
  onFocus,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  on: boolean;
  peeked: boolean;
  onPick: () => void;
  onPoint: () => void;
  onFocus: () => void;
}) {
  return (
    <button
      onClick={onPick}
      onMouseEnter={onPoint}
      onFocus={onFocus}
      aria-current={on ? "page" : undefined}
      aria-label={label}
      title={hint ? `${label}  ${hint}` : label}
      data-peek={peeked}
      className="rbtn"
    >
      {/* **No dot can appear on a destination**, in any state. The one mark
          the rail ever carried — *a newer build is out* — is on the avatar
          now, beside the menu row that says which version.
          
          That includes a schedule waiting to be approved. A proposal is
          announced where a held skill's is: a *Waiting for you* section in
          the panel that destination owns, and nothing above it. */}
      <Glyph size={20} strokeWidth={on ? 2 : 1.8} aria-hidden />
    </button>
  );
}

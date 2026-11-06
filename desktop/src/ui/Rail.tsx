/**
 * The 62px rail, and the panel it opens.
 *
 * What used to be here was a 256px column doing three jobs at once —
 * navigation, the workspace list and the configuration index — and swapping
 * between them. It is two things now: this, which is **where you can go**, and
 * `RailPanel`, which is **what is in the place you are pointing at**.
 *
 * Six destinations, then a rule, then the two doors that are genuinely
 * settings. 42px targets, 20px icons, 4px gaps. Selection is a pill in the
 * sheet's own colour, because the selected destination is the sheet's handle;
 * nothing else fills.
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
import { useUpdatesRow } from "~/data";
import { useFleet, waitingIn, type Backend } from "~/fleet";
import { isGlobalMod, key } from "~/platform";
import { useStart } from "~/start";
import { DESTINATIONS, DOORS, destinationAt, type DestinationId } from "~/ui/destinations";
import { usePanel } from "~/ui/panel";
import { ProfileMenu } from "~/ui/ProfileMenu";
import { RailPanel } from "~/ui/RailPanel";

export function Rail({ backend, onSwitch, onForgot }: { backend: Backend; onSwitch: (serverId: string) => void; onForgot: () => void }) {
  const path = usePathname();
  const here = destinationAt(path);
  const start = useStart();
  const updates = useUpdatesRow();
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

  /* Hysteresis. One timer, because a pointer leaving an icon and arriving at
     the panel fires both edges and whichever lands last has to win. */
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hold = () => clearTimeout(timer.current);
  const startPeek = (to: DestinationId) => {
    hold();
    if (to === here) return;
    timer.current = setTimeout(() => setPeek(to), 180);
  };
  const showPeek = (to: DestinationId) => {
    hold();
    setPeek(to === here ? null : to);
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

  const go = (to: { id: DestinationId; href: string }) => {
    hold();
    setPeek(null);
    setPinned(true);
    navigate(to.href);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPeek(null);
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
        go(numbered);
        return;
      }
      if (e.key === ",") {
        e.preventDefault();
        go(DOORS[0]);
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
            hint={d.key ? key(d.key) : undefined}
            on={d.id === here}
            peeked={peek === d.id && d.id !== here}
            onPick={() => go(d)}
            onPoint={() => startPeek(d.id)}
            onFocus={() => showPeek(d.id)}
          />
        ))}

        <span className="my-1.5 h-px w-[22px] shrink-0 bg-line" />

        {DOORS.map((d) => (
          <RailButton
            key={d.id}
            icon={d.icon}
            label={d.id === "updates" ? updates.label : d.label}
            hint={d.id === "settings" ? key(",") : undefined}
            on={d.id === here}
            peeked={peek === d.id && d.id !== here}
            news={d.id === "updates" && updates.dot}
            onPick={() => go(d)}
            onPoint={() => startPeek(d.id)}
            onFocus={() => showPeek(d.id)}
          />
        ))}

        <span className="flex-1" />

        <ProfileMenu backend={backend} waitingElsewhere={elsewhere} onSwitch={onSwitch} onForgot={onForgot} />
      </nav>

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
  news,
  onPick,
  onPoint,
  onFocus,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  on: boolean;
  peeked: boolean;
  news?: boolean;
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
      <Glyph size={20} strokeWidth={on ? 2 : 1.8} aria-hidden />
      {news && <span className="news" title="A newer build is out" />}
    </button>
  );
}

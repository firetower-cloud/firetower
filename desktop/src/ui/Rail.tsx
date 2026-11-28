/**
 * The 62px rail, and the panel it opens.
 *
 * What used to be here was a 256px column doing three jobs at once —
 * navigation, the workspace list and the configuration index — and swapping
 * between them. It is two things now: this, which is **where you can go**, and
 * `RailPanel`, which is **what is in the place you are pointing at**.
 *
 * Seven destinations at the top, and Organisation at the foot just above the
 * avatar. 42px targets, 20px icons, 4px gaps. Selection is a pill in the sheet's own colour, because the
 * selected destination is the sheet's handle; nothing else fills.
 *
 * **The rule and the two doors below it are gone.** Settings and Updates were
 * drawn here *and* as rows in the profile menu, and a thing in two places is a
 * thing with no home; the menu is the home. `destinations.ts` carries that
 * argument in full. What the rail keeps of Updates is the mark on the avatar,
 * which is `ProfileMenu`'s.
 *
 * **In a browser the number keys are gone, and so are their keycaps.** Which
 * is measured rather than assumed — `evidence/ticket-06/` has both browsers
 * driven with real keystrokes — and is the user's call rather than this file's:
 * Chrome delivers `⌘1`–`⌘8` and Safari never does, and a rail that promised a
 * shortcut half the browsers swallow would be `STYLE.md`'s fifth rule
 * inverted. The icons are unchanged and are the way in. `~/installed-app`.
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
import { advertisedKey, installedApp } from "~/installed-app";
import { isGlobalMod } from "~/platform";
import { useStart } from "~/start";
import { SETTINGS_HOME } from "~/ui/config/panes";
import { DESTINATIONS, destinationAt, type DestinationId } from "~/ui/destinations";
import { usePanel } from "~/ui/panel";
import { Palette } from "~/ui/Palette";
import { ProfileMenu } from "~/ui/ProfileMenu";
import { RailPanel } from "~/ui/RailPanel";

/**
 * What a keystroke means to the window, or nothing.
 *
 * **Pure and exported, because the gate it carries is otherwise inside a
 * `useEffect`** — which `renderToStaticMarkup` cannot reach, so until this
 * existed the rail's keyboard had no test at all, in either client.
 * `Inspector.tsx`'s `tabsFor` and `shownTab` set the precedent for a
 * component exporting the rule it is drawn from; `installed-only.test.tsx`
 * asserts every key below on both sides of the shell question.
 *
 * It is a transcription of the handler it came from and nothing more. The
 * caller does the `preventDefault`, once, for whatever this claims — which is
 * exactly the branches that used to call it themselves, and for a keystroke
 * this returns `null` for nothing is prevented, as before.
 *
 * **Nothing at all on a served page.** Chrome delivers `⌘1`–`⌘8` and Safari
 * never does, so half of these would work in one browser and none in the
 * other; the user's answer was to keep none of it but `⌘F`, which is not
 * here. Every one of them is still a control — the icons, the panel's two
 * glyphs, the New workspace row, the Settings row in the profile menu. See
 * `~/installed-app` and `evidence/ticket-06/`.
 *
 * `inTerminal` is a function rather than a boolean, deliberately: it walks the
 * focused element's ancestors, and this runs on every keystroke anywhere in
 * the app. The cheap tests go first and that walk happens only for a chord
 * this would otherwise claim — which is the order `Chat.tsx` and
 * `ArtifactTab.tsx` already read it in.
 */
export type RailKey =
  | { at: "go"; href: string }
  | { at: "palette" }
  | { at: "new" }
  | { at: "panel" }
  | null;

export function railKey(
  e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
  where: { installed: boolean; inTerminal: () => boolean; path: string },
): RailKey {
  if (!where.installed) return null;
  /* The *global* modifier only. ⌃ is the inspector's inside a workspace, and
     `e.metaKey || e.ctrlKey` would take it here first. */
  if (!isGlobalMod(e)) return null;
  /* A focused terminal owns the keyboard, exactly as the workbench's own
     handler has it. Everything here is a window-level gesture, so none of it
     is the one exception. */
  if (where.inTerminal()) return null;

  const numbered = DESTINATIONS.find((d) => d.key === e.key);
  if (numbered) return { at: "go", href: numbered.href };
  /* **⌘, survives the door going.** It is the one thing the rail still owns
     about Settings: a window-level gesture belongs to the window rather than
     to the menu that happens to list it. The menu's row carries the same
     hint, so the key is still advertised where Settings now lives. */
  if (e.key === ",") return { at: "go", href: SETTINGS_HOME };
  /* **Inside the terminal ⌘K clears the buffer**, which is shipped behaviour
     and stays — the guard above has already returned by then, and `Shell.tsx`
     stops the key reaching here at all. Everywhere else it opens the palette. */
  const k = e.key.toLowerCase();
  if (k === "k") return { at: "palette" };
  if (k === "n") return { at: "new" };
  /* The workbench owns the backslash inside a workspace — there it is the
     inspector rail that collapses, which is the one the width is being argued
     over. */
  if (e.key === "\\" && !where.path.startsWith("/sessions")) return { at: "panel" };
  return null;
}

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
      /* **Escape is above the rule, deliberately.** It is not a chord and it
         is not the window's to withhold: the palette is still openable from
         the panel's Search glyph on a served page, and a thing you can open
         has to be closable. Everything else is `railKey`'s. */
      const act = railKey(e, {
        installed: installedApp(),
        inTerminal: () => !!(document.activeElement as HTMLElement | null)?.closest(".xterm"),
        path,
      });
      if (!act) return;
      e.preventDefault();
      if (act.at === "go") go(act.href);
      else if (act.at === "palette") setPalette((o) => !o);
      else if (act.at === "new") start();
      else {
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
        className="rail relative z-5 flex w-(--rail) shrink-0 flex-col items-center gap-1 pt-0.5 pb-3.5"
      >
        {DESTINATIONS.map((d) => (
          <RailButton
            key={d.id}
            foot={d.foot}
            icon={d.icon}
            label={d.label}
            hint={advertisedKey(d.key)}
            on={d.id === here}
            peeked={peek === d.id && previews(d.id)}
            onPick={() => go(d.href)}
            onPoint={() => startPeek(d.id)}
            onFocus={() => showPeek(d.id)}
          />
        ))}

        {/* A destination at the foot pushes itself, and the avatar after it,
            to the bottom (`mt-auto` on its button); a spacer here as well
            would take that room first and leave it at the top. */}
        {!DESTINATIONS.some((d) => d.foot) && <span className="flex-1" />}

        <ProfileMenu backend={backend} waitingElsewhere={elsewhere} onSwitch={onSwitch} onForgot={onForgot} />
      </nav>

      <Palette open={palette} onClose={() => setPalette(false)} />

      {(pinned || floating) && (
        <RailPanel
          at={showing}
          floating={floating}
          stale={backend.reach === "unreachable"}
          /* **Both directions, because the panel's head draws both.** It used
             to be given only the collapse — the way back was the title bar's
             toggle, and a browser has no title bar. Pinning from a preview
             clears the peek for the same reason collapsing does: a pinned
             panel is the destination you are *in*, and leaving the peek set
             would snap it over the moment the pointer left. */
          pin={{
            pinned,
            set: (next) => {
              setPeek(null);
              setPinned(next);
            },
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
  foot,
  icon: Glyph,
  label,
  hint,
  on,
  peeked,
  onPick,
  onPoint,
  onFocus,
}: {
  /** At the foot of the rail rather than the top. See `Destination.foot`. */
  foot?: boolean;
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
      className={foot ? "rbtn mt-auto" : "rbtn"}
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

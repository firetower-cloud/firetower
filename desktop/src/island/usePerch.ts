/**
 * Keeping the window the same size and shape as the pill drawn inside it.
 *
 * A normal web page is given a viewport and lays itself out inside it. This one
 * is the other way round: the content decides, and the window is resized to
 * match on every change, because a transparent window larger than its pill is a
 * rectangle of dead space that swallows clicks meant for the desktop.
 *
 * So the loop is: measure the content, work out where a pill that size belongs
 * (`place.ts`), tell the shell (`shell.ts`). Everything worth arguing about is
 * in the middle step, which is pure and tested; this file is the wiring.
 *
 * ## Why the window is sometimes bigger than the pill
 *
 * The pill grows over 320ms and a window resizes in one frame, so the two
 * cannot be the same rectangle while the animation is running — the box would
 * be clipped to its final size before it had got there, which is exactly what
 * a snap looks like.
 *
 * So the window is placed at the *union* of where the pill is and where it is
 * going, immediately, and settles down to the exact size once the animation
 * has finished. Growing, the window is already big and the pill expands into
 * it. Shrinking, the window stays big until the pill has finished pulling in.
 * Either way the extra is transparent and nobody sees it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  dock,
  fingerprint,
  floating,
  grow,
  notched,
  perchOf,
  resolve,
  screenFor,
  snap,
  union,
  type Mode,
  type Perch,
  type Screen,
  type Size,
} from "./place";
import {
  anchor,
  bounds,
  onMoved,
  place,
  screens as readScreens,
  startDragging,
  unit,
  visible,
} from "./shell";

/** Until the pill has been measured once. Never seen: the window starts hidden. */
const GUESS: Size = { width: 160, height: 28 };

/** `--dur-island`, plus a frame or two for the compositor to catch up. */
const SETTLE = 380;

export function usePerch(o: {
  /** The *content*, at its natural size — not the box, which is animated. */
  pill: RefObject<HTMLElement | null>;
  /** Whether the panel is expanded, which changes the size but never the perch. */
  open: boolean;
  /** Whether it should be on screen at all. */
  show: boolean;
  perch: Perch | null;
  onPerch: (p: Perch) => void;
}) {
  const [screens, setScreens] = useState<Screen[]>([]);
  /** The content's natural size in CSS pixels, for the box to be drawn at. */
  const [box, setBox] = useState<Size | null>(null);
  /* Where it *actually* is, which is not always what was remembered: a fresh
     install has no perch and still docks, and a saved dock degrades to
     floating when the notch is gone. The pill is drawn from this, or it wears
     square corners on a display with nothing to be square against. */
  const [perched, setPerched] = useState<Mode>("float");

  /** The collapsed size, kept so an expanded panel can be grown from it. */
  const collapsed = useRef<Size>(GUESS);
  /** The size the window is at right now, which leads the pill on the way up. */
  const held = useRef<Size>(GUESS);
  /** Takes the extra room back out once the animation has finished. */
  const slack = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** AppKit owns the window for the length of a drag; we must not fight it. */
  const dragging = useRef(false);
  const settling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shown = useRef(false);
  /** IPC can answer out of order; only the newest placement may win. */
  const turn = useRef(0);

  const latest = useRef({ o, screens });
  latest.current = { o, screens };

  const apply = useCallback(async () => {
    const { o: now, screens: displays } = latest.current;
    const el = now.pill.current;
    if (!el || dragging.current || displays.length === 0) return;

    // Measured in CSS pixels, placed in whatever the shell measures in.
    const natural = el.getBoundingClientRect();
    const per = unit();
    const size = {
      width: Math.ceil(natural.width * per),
      height: Math.ceil(natural.height * per),
    };
    if (size.width < 2 || size.height < 2) return;
    if (!now.open) collapsed.current = size;

    // The box is drawn at the natural size and animates to it; the window is
    // placed at the union so the animation has room in whichever direction it
    // is going.
    setBox({ width: Math.ceil(natural.width), height: Math.ceil(natural.height) });
    const room = union(size, held.current);
    held.current = room;

    const base = resolve(now.perch, displays, collapsed.current, anchor);
    if (!base) return;
    setPerched(base.mode);

    const at = (of: Size) => grow(base.rect, of, base.screen, anchor === "corner" ? "right" : "centre");

    const mine = ++turn.current;
    await place(at(room));
    if (mine !== turn.current) return;

    if (now.show && !shown.current) {
      shown.current = true;
      await visible(true);
    }

    // Once the pill has stopped moving, take the slack back out of the window
    // so it is again exactly the shape of what is drawn in it.
    clearTimeout(slack.current);
    slack.current = setTimeout(() => {
      if (mine !== turn.current || dragging.current) return;
      held.current = size;
      void place(at(size));
    }, SETTLE);
  }, []);

  /* The displays, and a cheap watch for one arriving or leaving. A monitor is
     unplugged rarely and without warning, so this is polled rather than
     observed: four seconds of an island in the wrong place is a blink, and an
     AppKit notification observer is a lot of unsafe code for that blink. */
  useEffect(() => {
    let alive = true;
    let known = "";
    const look = async () => {
      const found = await readScreens();
      if (!alive) return;
      const now = fingerprint(found);
      if (now === known) return;
      known = now;
      setScreens(found);
    };
    void look();
    const timer = setInterval(look, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  /* The pill changing size is the commonest reason to re-place: a session
     arrives, a name is longer, the panel opens. */
  useEffect(() => {
    const el = o.pill.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => void apply());
    observer.observe(el);
    return () => observer.disconnect();
  }, [o.pill, apply]);

  useEffect(() => {
    void apply();
  }, [apply, o.open, o.perch, screens]);

  /* Hiding is immediate; showing waits for a placement, so the island never
     appears at the last run's coordinates and then jumps. */
  useEffect(() => {
    if (o.show) {
      if (shown.current) return;
      void apply();
      return;
    }
    shown.current = false;
    void visible(false);
  }, [o.show, apply]);

  /* The end of a drag, inferred from the moves stopping — the webview does not
     reliably see the mouseup, which `src/drag.ts` documents at length. */
  useEffect(() => {
    let off = () => {};
    let alive = true;
    void (async () => {
      const stop = await onMoved(() => {
        if (!dragging.current) return;
        clearTimeout(settling.current);
        settling.current = setTimeout(() => void land(), 260);
      });
      if (alive) off = stop;
      else stop();
    })();

    const land = async () => {
      dragging.current = false;
      const where = await bounds();
      const { screens: displays, o: now } = latest.current;
      if (!where || displays.length === 0) return;

      // Snap the *collapsed* pill, not whatever size it happens to be while
      // open: the remembered perch is the pill's, and keeping the centre is
      // what stops it sliding sideways when the panel closes.
      const centre = where.x + where.width / 2;
      const asPill = {
        x: Math.round(centre - collapsed.current.width / 2),
        y: where.y,
        ...collapsed.current,
      };
      const landed = snap(asPill, displays);
      if (landed) now.onPerch(perchOf(landed));
    };

    return () => {
      alive = false;
      clearTimeout(settling.current);
      off();
    };
  }, []);

  useEffect(() => () => clearTimeout(slack.current), []);

  const drag = useCallback(() => {
    dragging.current = true;
    void startDragging();
  }, []);

  /** The menu's "dock to the notch" / "float free", which is a perch, not a flag. */
  const perchAs = useCallback((want: Mode) => {
    const { screens: displays, o: now } = latest.current;
    const here =
      displays.find((s) => s.name === now.perch?.screen) ??
      screenFor({ x: 0, y: 0, ...collapsed.current }, displays) ??
      displays[0];
    if (!here) return;
    const rect = want === "notch" ? dock(here, collapsed.current) : floating(here, collapsed.current);
    now.onPerch({ screen: here.name, mode: want, x: rect.x, y: rect.y });
  }, []);

  const home = screens.find((s) => s.name === o.perch?.screen) ?? screens.find((s) => s.primary);

  return {
    perched,
    /** What to draw the animated box at, in CSS pixels. */
    box,
    /** Which edges the box is pinned to inside the window while it animates. */
    align: anchor === "corner" ? ("right" as const) : ("centre" as const),
    /**
     * The cutout on the display it lives on, or zeroes.
     *
     * Both numbers are load-bearing while docked, for the same reason: **the
     * notch is a hole in the panel, not a dark patch of it.** Nothing drawn
     * there is ever seen.
     *
     * So the height is a floor — a 24px pill flush against a 38px cutout
     * leaves the notch carrying on below its wings, and the two read as a
     * stepped blob rather than one shape. And the width is a gap the content
     * has to be pushed out of, or a collapsed pill centred on the notch puts
     * every word it has behind the camera.
     *
     * Used as CSS lengths, which is safe only because notches are a macOS
     * thing and macOS reports points — the same unit CSS is in. Everywhere
     * else both numbers are zero.
     */
    notch: { width: home?.notchWidth ?? 0, height: home?.notchHeight ?? 0 },
    /** Whether "dock to the notch" is worth offering on the display it is on. */
    dockable: home ? notched(home) : false,
    drag,
    perchAs,
  };
}

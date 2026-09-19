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
 * ## Why the window follows the pill a frame at a time
 *
 * The pill changes size over 320ms and a window resizes in one step, so the
 * two cannot be the same rectangle unless the window is told, repeatedly,
 * what the box currently measures.
 *
 * It used to be told twice: once at the union of where the pill was and where
 * it was going, and once more at the end. Both of those are an eighteen-point
 * change to the window in a single frame, and the webview re-lays out its
 * centred content on the *next* one — so for that frame the pill sits nine
 * points to one side, and then snaps back. Twice per open-and-close, which is
 * exactly the twitch you see.
 *
 * So the window is never far from the box. Each frame of the transition it is
 * set to what the box actually measures, which moves it a point or two at a
 * time; the lag is still there and is now smaller than a pixel. The first
 * placement is the exception — the window is built hidden, and a hidden
 * window has no frames to follow.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  dock,
  fingerprint,
  floating,
  grow,
  dockable as topDockable,
  perchOf,
  resolve,
  screenFor,
  snap,
  type Mode,
  type Perch,
  type Rect,
  type Screen,
  type Size,
} from "./place";
import { isMac } from "~/platform";
import {
  anchor,
  bounds,
  hit,
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

/** If the stylesheet is not there to be asked. Kept equal to `--island-melt`. */
const MELT = 13;

/**
 * How far a docked pill is lifted above the first row of the screen.
 *
 * One point: enough to put the hairline macOS draws around the window above
 * the display's top edge, and little enough that the point given back as
 * padding leaves the row where it was. Paired with `--island-lift`.
 */
const LIFT = 1;

/**
 * How far the docked pill's black bleeds sideways, read from the stylesheet.
 *
 * The number belongs to the shape, so it is defined where the shape is and
 * read here rather than written twice. A pill whose window is 13pt too narrow
 * loses its melting corners silently, which is the kind of drift a second
 * copy of a constant produces.
 */
function melt(): number {
  if (typeof window === "undefined") return MELT;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--island-melt");
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : MELT;
}

/** Rounded up to an even number, so half of it is still a whole pixel. */
const even = (of: Size): Size => ({
  width: of.width + (of.width % 2),
  height: of.height,
});

/**
 * Where the visible pill sits *inside* its window.
 *
 * An offset from the window's own top-left, not a place on the screen. The
 * window is moved by things that never tell the renderer — a drag above all —
 * and an absolute rectangle would be left behind at the spot the drag
 * started. An inset is true wherever the window goes.
 *
 * Centred horizontally, because the root is a centring flex container and
 * whatever the window carries beyond the pill sits half either side; and
 * below the lifted point, which is off the top of the screen where nothing
 * can be pointed at anyway.
 */
function seen(window_: Rect, pill: Size, lift: number): Rect {
  return {
    x: Math.round((window_.width - pill.width) / 2),
    y: lift,
    width: pill.width,
    height: pill.height,
  };
}

export function usePerch(o: {
  /** The *content*, at its natural size — not the box, which is animated. */
  pill: RefObject<HTMLElement | null>;
  /** The box around it, the one whose width and height are animated. */
  frame: RefObject<HTMLElement | null>;
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
  /** The frame callback walking the pointer's target behind the animated box. */
  const follow = useRef<number | undefined>(undefined);
  /** The largest the content has ever been, which is the window's size. */
  const stage = useRef<Size>(GUESS);
  /** Where the window already is, so it is not told again for nothing. */
  const last = useRef<Rect | null>(null);
  /** AppKit owns the window for the length of a drag; we must not fight it. */
  const dragging = useRef(false);
  /** The landing, reachable from `drag` so a drag that never moves still ends. */
  const landing = useRef<() => void>(() => {});
  const settling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shown = useRef(false);
  /** IPC can answer out of order; only the newest placement may win. */
  const turn = useRef(0);
  /** Whether the pill has ever been measured, as opposed to guessed at. */
  const measured = useRef(false);
  /** One placement per frame: the latest rectangle, and who is waiting on it. */
  const queued = useRef<{ rect: Rect; waiting: Array<() => void> } | null>(null);

  /**
   * Place the window at most once a frame.
   *
   * Several things ask for a placement in the same breath — the state arrives,
   * a font finishes loading, the panel is keyed out and the row keyed in — and
   * each one used to move the window the moment it asked. Six `set_position`
   * calls inside a second, at five different x, is a pill that jitters
   * sideways before it settles. They are all answers to the same question, so
   * only the last one is worth sending.
   *
   * A timer rather than `requestAnimationFrame`. The window is built hidden
   * and waits to be placed before it is shown, and a hidden window is not
   * animating — its frame callbacks never run, so the placement it is waiting
   * on never happens and the island stays invisible for the whole session.
   */
  const placeSoon = useCallback(
    (rect: Rect) =>
      new Promise<void>((done) => {
        const held = queued.current;
        if (held) {
          held.rect = rect;
          held.waiting.push(done);
          return;
        }
        queued.current = { rect, waiting: [done] };
        setTimeout(async () => {
          const batch = queued.current;
          queued.current = null;
          if (!batch) return;
          await place(batch.rect);
          for (const wake of batch.waiting) wake();
        }, 0);
      }),
    [],
  );

  const latest = useRef({ o, screens });
  latest.current = { o, screens };

  const apply = useCallback(async () => {
    const { o: now, screens: displays } = latest.current;
    const el = now.pill.current;
    if (!el || dragging.current || displays.length === 0) return;

    // Measured in CSS pixels, placed in whatever the shell measures in.
    const natural = el.getBoundingClientRect();
    const per = unit();
    /* Even, and even at the source. Every rectangle downstream is derived
       from this one — what is remembered, what the dock is centred on, what
       the window is grown to — and each derivation halves a width and rounds.
       An odd width there puts the pill half a point off the middle of the
       screen, and a *differently* odd one puts it half a point the other way,
       which is the shift you see as the box settles. */
    const size = even({
      width: Math.ceil(natural.width * per),
      height: Math.ceil(natural.height * per),
    });
    if (size.width < 2 || size.height < 2) return;
    if (!now.open) collapsed.current = size;

    const base = resolve(now.perch, displays, collapsed.current, anchor);
    if (!base) return;
    setPerched(base.mode);

    /* Docked, the two melting corners are drawn *outside* the pill — a square
       of its own black at `left: -13px` and `right: -13px`, with a quarter
       disc bitten out. The window has to carry them, or they survive exactly
       as long as the window is oversized for the animation and are clipped
       off the moment it settles to the pill's own size. That is the shape
       melting into the bezel for a beat and then going square again.

       Only the window is widened. `collapsed.current` — what is remembered,
       what a drag snaps, what the notch is centred on — stays the pill. */
    const bleed = base.mode === "notch" ? Math.ceil(melt() * per) * 2 : 0;

    /* And one point above the first row of the screen.
       macOS puts a hairline of its own around a window, and on a transparent
       one it traces the alpha — so it follows the pill rather than the frame,
       and no amount of CSS moves it: painting past it only hands it a new
       outer edge to trace. The one place it can go is off the display. Lifted
       by a point, the pill's top edge is above row zero and what meets the
       bezel is its black. The point is given back as padding, so the row
       inside sits exactly where it did.

       macOS only, because the hairline is. Windows does not draw one — the
       island gets a colour step and a top highlight there instead of a
       shadow — so lifting would push a point of that highlight off the screen
       to hide something that was never there. */
    const lift = base.mode === "notch" && isMac ? Math.ceil(LIFT * per) : 0;
    const roomFor = (of: Size): Size => ({
      width: of.width + bleed,
      height: of.height + lift,
    });

    const at = (of: Size) => {
      const rect = grow(base.rect, roomFor(of), base.screen, anchor === "corner" ? "right" : "centre");
      return lift ? { ...rect, y: rect.y - lift } : rect;
    };

    /* The box is drawn at the natural size and animates to it. Docked, it
       carries the lift as well, so the black fills the window right up to the
       edge that is off the screen. */
    setBox({
      width: Math.ceil(natural.width) + (Math.ceil(natural.width) % 2),
      height: Math.ceil(natural.height) + (lift ? LIFT : 0),
    });

    /* The stage the pill is drawn on, which only ever grows.
       Any change to the window's width moves centred content by half of it
       until the layout catches up, and that is the whole of the glitch — so
       the window stops changing. It is placed once at the largest the content
       has ever been and left there; the pill animates inside it, centred by
       the root, and its middle is the window's middle whatever size it is.
       The margin around it is transparent and, while the pointer is not on
       the pill, invisible to the mouse as well (`clickThrough`). */
    const grown = {
      width: Math.max(stage.current.width, size.width),
      height: Math.max(stage.current.height, size.height),
    };
    stage.current = grown;
    const window_ = at(grown);

    const mine = ++turn.current;
    const settled = last.current;
    const moved =
      !settled ||
      settled.x !== window_.x ||
      settled.y !== window_.y ||
      settled.width !== window_.width ||
      settled.height !== window_.height;

    if (moved) {
      last.current = window_;
      await placeSoon(window_);
      if (mine !== turn.current) return;
    }

    if (now.show && !shown.current) {
      shown.current = true;
      await visible(true);
    }

    /* What the pointer may land on, which is the only thing still following
       the animation. The window does not move, so this is pure arithmetic on
       a rectangle the shell already has — no frame change, nothing to lag. */
    void hit(seen(window_, size, lift));

    cancelAnimationFrame(follow.current ?? 0);
    /* A transition's worth of frames and a little over, so that a transition
       that never finishes costs nothing rather than a frame callback for
       ever. */
    let left = 40;
    let settled_ = 0;
    const chase = () => {
      if (mine !== turn.current || dragging.current) return;
      const box = latest.current.o.frame.current;
      if (!box) return;
      const now_ = box.getBoundingClientRect();
      const shape = {
        width: Math.ceil(now_.width * per),
        height: Math.ceil(now_.height * per) - lift,
      };
      void hit(seen(window_, shape, lift));

      /* Both dimensions, and twice.
         Width alone was enough while the pill only ever grew sideways. It is
         not: the row and the panel are the same width, so opening is a change
         in height only, and a width-only test called it arrived on the first
         frame — before the box had moved at all. The chase stopped there and
         left the pointer's target the height of the closed pill, so the panel
         you had just opened counted as outside, closed itself, and opened
         again on the next pass.

         Twice, because the first frame after a size is set still measures the
         old one: once is indistinguishable from never having started. */
      const arrived =
        Math.abs(shape.width - size.width) <= 1 && Math.abs(shape.height - size.height) <= 1;
      settled_ = arrived ? settled_ + 1 : 0;
      if (settled_ < 2 && (left -= 1) > 0) follow.current = requestAnimationFrame(chase);
    };
    follow.current = requestAnimationFrame(chase);
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

    landing.current = () => void land();

    const land = async () => {
      dragging.current = false;
      clearTimeout(settling.current);
      /* The window is no longer where we last put it — AppKit has just spent
         a drag moving it — so the record of that has to go, or the placement
         this landing is about to ask for is skipped as redundant and the pill
         is left exactly where it was dropped. Docking would then snap it in
         the stored perch and nowhere on the screen. */
      last.current = null;
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

  useEffect(
    () => () => {
      clearTimeout(slack.current);
      cancelAnimationFrame(follow.current ?? 0);
    },
    [],
  );

  const drag = useCallback(() => {
    dragging.current = true;
    void startDragging();

    // Same reason as in the landing: from here on the window is AppKit's.
    last.current = null;

    /* And a floor under it. The landing is scheduled off the *moves* a drag
       emits, so a drag that is let go without moving emits none and never
       lands — and this flag, left set, stops every placement there will ever
       be. The window then stays wherever AppKit last put it, which after a
       drag off the side of a display is somewhere you cannot reach it, with
       nothing left running that would pull it back. */
    clearTimeout(settling.current);
    settling.current = setTimeout(() => landing.current(), 700);
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
    /**
     * The menu bar, which is a point or two taller than the cutout.
     *
     * A docked pill the height of the notch alone stops a point short of the
     * bar it is sitting in, and the hairline macOS draws along its underside
     * then falls *inside* the black band rather than at the edge of one —
     * a line ruled across the notch. Filling the bar puts that edge where the
     * eye already expects a boundary.
     */
    bar: home ? Math.max(0, home.workY - home.y) : 0,
    /** Whether "dock to the top" is worth offering on the display it is on. */
    dockable: home ? topDockable(home) : false,
    drag,
    perchAs,
  };
}

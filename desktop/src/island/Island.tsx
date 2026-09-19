/**
 * The pill.
 *
 * Three states and one action. It says whether anything needs you, and it
 * takes you there; it does not answer questions and it does not approve
 * diffs. A permission request is three lines of context in two hundred pixels,
 * and a button next to it is a machine for approving code nobody read — so the
 * island escorts you to the decision and the decision stays in the app.
 *
 * Which leaves it with no text input, no keyboard shortcuts and no reason to
 * ever take focus. That is not a reduced version of the idea; it is what makes
 * it safe to leave on screen all day.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Signal } from "~/components/Signal";
import { AgentMark } from "~/components/AgentMark";
import { Mark } from "~/ui/Mark";
import { elapsed } from "~/api/view";
import { usePerch } from "./usePerch";
import { activate, open as openWorkspace, onState, onWake, pointerInside, sharing } from "./shell";
import { read, write, type Prefs } from "./prefs";
import { empty, headline, modeOf, onScreen, type IslandState, type Row } from "./state";

/** Long enough that crossing the pill on the way somewhere else does not open it. */
const IN = 120;
/** Short enough to feel deliberate, long enough to survive the gap to a row. */
const OUT = 380;

/** Past this the panel is a list to scroll, which is not what a glance is for. */
const MOST_WAITING = 5;
const MOST_WORKING = 3;

/* TEMPORARY — for showing the island on a machine with no server attached.
   Reverted straight after; `git diff` should never show this. */
const DEMO: IslandState = {
  waiting: [
    { key: "a:1", serverId: "a", workspaceId: "w1", mark: "W", name: "auth middleware", repo: "ledger", agent: "ClaudeCode", status: "NeedsYou", minutes: 28, stale: false },
    { key: "a:2", serverId: "a", workspaceId: "w2", mark: "W", name: "rate limiter", repo: "api", agent: "Codex", status: "HandedBack", minutes: 61, stale: false },
  ],
  working: [
    { key: "a:3", serverId: "a", workspaceId: "w3", mark: "W", name: "query optimisation", repo: "web", agent: "ClaudeCode", status: "Working", minutes: 300, stale: false },
  ],
  servers: 1,
  unreachable: 0,
};

export function Island() {
  const [state, setState] = useState<IslandState>(import.meta.env.DEV ? DEMO : empty);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(read);
  const pill = useRef<HTMLDivElement>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const save = useCallback((next: Partial<Prefs>) => {
    setPrefs((held) => {
      const merged = { ...held, ...next };
      write(merged);
      return merged;
    });
  }, []);

  useEffect(() => {
    let off = () => {};
    let alive = true;
    void onState(setState).then((stop) => (alive ? (off = stop) : stop()));
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => void sharing(prefs.unshared), [prefs.unshared]);

  /* "Show the island", from the Windows tray. */
  useEffect(() => {
    let off = () => {};
    let alive = true;
    void onWake(() => save({ quiet: false })).then((stop) => (alive ? (off = stop) : stop()));
    return () => {
      alive = false;
      off();
    };
  }, [save]);

  /* Both windows share an origin, so the app can change these too. `storage`
     only fires in the *other* documents of an origin, which is exactly the
     direction wanted: the island hears the app, and never its own writes. */
  useEffect(() => {
    const reread = () => setPrefs(read());
    window.addEventListener("storage", reread);
    return () => window.removeEventListener("storage", reread);
  }, []);

  const mode = modeOf(state);
  const show = onScreen(prefs.quiet, mode);

  const { perched, notch, bar, box, align, dockable, drag, perchAs } = usePerch({
    pill,
    open: open || menu,
    show,
    perch: prefs.perch,
    onPerch: (perch) => save({ perch }),
  });

  const enter = () => {
    clearTimeout(hover.current);
    hover.current = setTimeout(() => setOpen(true), IN);
  };
  const leave = () => {
    clearTimeout(hover.current);
    hover.current = setTimeout(() => {
      setOpen(false);
      setMenu(false);
    }, OUT);
  };

  /* The pointer, asked of the shell rather than read off the document.
     Same timers, so the feel is unchanged; it simply also works when another
     app is in front, which `:hover` on a non-activating window does not.

     A tenth of a second: below what a 120ms open delay can notice, and the
     question is two comparisons against a rectangle the shell already has. */
  useEffect(() => {
    let alive = true;
    let over = false;
    const ask = async () => {
      // A shell that cannot answer is a shell without the command — an older
      // build, or a platform that does not need it. The document's own
      // `:hover` is still wired, so the pill keeps working; it just wants the
      // window clicked first, which is where this started.
      const inside = await pointerInside().catch(() => false);
      if (!alive || inside === over) return;
      over = inside;
      if (inside) enter();
      else leave();
    };
    const timer = setInterval(() => void ask(), 100);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // `enter` and `leave` only touch a ref and two setters, so the first pair is
    // as good as any later one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = (row: Row) => {
    setOpen(false);
    setMenu(false);
    void openWorkspace(row.serverId, row.workspaceId);
  };

  /* Floating, the card stays open. A pill that grows and shrinks as the
     pointer crosses it is a target that moves while you are aiming at it, and
     off the notch there is no cutout for the collapsed form to hide in — so
     the only thing the collapse bought was the animation. Dormant is the
     exception: with nothing to say it stays a nub rather than sitting there as
     an open, empty card.

     Not before it has been placed, though. `perched` reads "float" until the
     displays have been measured and answered for, and a pill that is about to
     dock would otherwise be built as a full panel for those first frames. */
  const placed = box !== null;
  const expanded = (placed && perched === "float" && mode !== "dormant") || open || menu;

  /* Opening is the one moment the island asks to come forward. A panel is a
     list you point at, and a window that is not key is sent no mouse moves —
     so without this the rows do not light up under the pointer that opened
     them. It hands the keyboard to a window with nothing to type into. */
  useEffect(() => {
    if (expanded) void activate();
  }, [expanded]);

  /* Docked, the black fills the whole menu bar rather than just the cutout,
     so that the one edge macOS insists on drawing lands where the bar ends
     instead of part way down the notch. */
  const band = perched === "notch" ? Math.max(notch.height, bar) : 0;

  return (
    /* The root fills the window, which is bigger than the pill for as long as
       the pill is changing size. Where inside it the pill sits is the edge
       that has to stay still: under the notch that is its centre, in a corner
       it is the corner. */
    <div className="island-root" data-align={align}>
      <div className="island-frame" data-perch={perched}>
        <div
          className="island text-text"
          data-mode={mode}
          data-perch={perched}
          /* Drawn at the size the content wants and animated to it, rather
             than sized by the content — the box has to be able to be a
             different size from what is in it while it is on the way.

             No `minHeight` for the docked case: a floor on the box would
             leave the row sitting against the top of it, five pixels above
             the middle of the cutout, which is most of what "not aligned"
             looked like. The row is given the cutout's height instead, and
             centres its own contents in it. */
          style={box ? { width: box.width, height: box.height } : undefined}
          onMouseEnter={enter}
          onMouseLeave={leave}
          onClick={() => {
            if (!expanded) setOpen(true);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu((was) => !was);
            setOpen(true);
          }}
        >
          {/* Keyed on the state so React remounts it and the entry animation
              runs again: the box stretches, and a beat later what is now
              inside it fades up. */}
          <div ref={pill} className="island-body island-enter" key={expanded ? "open" : "shut"}>
        {expanded ? (
          <Panel
            state={state}
            mode={mode}
            onOpen={go}
            onGrab={drag}
            clear={band}
          >
            {menu && (
              <Menu
                prefs={prefs}
                dockable={dockable}
                docked={perched === "notch"}
                onPick={(what) => {
                  setMenu(false);
                  if (what === "dock") perchAs("notch");
                  if (what === "float") perchAs("float");
                  if (what === "quiet") save({ quiet: !prefs.quiet });
                  if (what === "unshared") save({ unshared: !prefs.unshared });
                }}
              />
            )}
          </Panel>
        ) : (
          <Collapsed
            state={state}
            mode={mode}
            onGrab={drag}
            gap={perched === "notch" ? notch.width : 0}
            tall={band}
          />
        )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Collapsed ─────────────────────────────────────────────────────────────
   One line, and at most one thing that moves. */

export function Collapsed({
  state,
  mode,
  onGrab,
  gap = 0,
  tall = 0,
}: {
  state: IslandState;
  mode: ReturnType<typeof modeOf>;
  onGrab: () => void;
  /**
   * The width of the cutout to leave empty in the middle, when docked.
   *
   * Nothing renders inside a notch — it is a hole. A collapsed pill centred
   * on one would put its dot and its every word behind the camera and look,
   * from the outside, like an island that had stopped working. So docking
   * splits the row around the gap instead of spanning it: what is happening
   * to the left of the cutout, which server and the handle to the right.
   */
  gap?: number;
  /** The cutout's height, which the row fills and centres itself in. */
  tall?: number;
}) {
  const one = mode === "demand" ? state.waiting[0] : state.working[0];
  const alone = (mode === "demand" ? state.waiting : state.working).length === 1;

  const left =
    mode === "dormant" ? (
      <Mark size={13} className="island-quiet text-mute" />
    ) : (
      <>
        <Beat mode={mode} />
        <span className="max-w-[210px] truncate text-meta whitespace-nowrap text-bone">
          {headline(state)}
        </span>
      </>
    );

  /* Docked, the two wings are made the same width, so whatever is on the
     quiet side decides how much empty black sits opposite the text. Padding
     it out with nothing looked like a mistake; the age of the thing being
     talked about is the one number that is always available, always
     changing, and worth a glance on its own. */
  const right = (
    <>
      {one && gap > 0 && (
        <span className="font-mono text-micro whitespace-nowrap text-dim">
          {elapsed(one.minutes)}
        </span>
      )}
      {/* Which server, when the pill is about exactly one thing. Identity is a
          shape, here as everywhere else. */}
      {one && alone && mode !== "dormant" && (
        <span className="server-mark grid h-[15px] w-[15px] shrink-0 place-items-center" data-reach="live">
          {one.mark}
        </span>
      )}
      <Grip onGrab={onGrab} />
    </>
  );

  const row = mode === "dormant" ? "h-[22px]" : "h-[28px]";

  /* Floating, it is one row and reads left to right like any other. The nub
     is tighter than the rest: it is two glyphs and nothing else, and the gap
     the other states need between a dot and a sentence just makes it wide. */
  if (gap === 0) {
    const pad = mode === "dormant" ? "gap-1 pr-0.5 pl-1.5" : "gap-2 pr-0.5 pl-2.5";
    return (
      <div className={`flex ${row} items-center ${pad}`}>
        {left}
        {right}
      </div>
    );
  }

  /* Docked, it is two wings either side of a hole, and they have to be the
     same width or the shape is lopsided about the one thing it is aligned to.
     `.island-wings` makes both tracks as wide as the wider content; the two
     halves then sit against the cutout with the slack pushed to the outside. */
  return (
    <div
      className={tall > 0 ? "island-wings" : `island-wings ${row}`}
      style={{ ["--island-gap" as string]: `${gap}px`, ...(tall > 0 ? { height: tall } : null) }}
    >
      <span className="island-left flex items-center gap-2 pr-2 pl-2.5">{left}</span>
      <span aria-hidden />
      <span className="island-right flex items-center gap-1.5 pr-1 pl-2">{right}</span>
    </div>
  );
}

/**
 * The one moving thing.
 *
 * Not `Signal`: that draws the lead session's own status, and a summary of
 * five sessions is not any one of them. Two sessions handed back and one
 * failed is still, to the person glancing at it, ember.
 */
function Beat({ mode }: { mode: "ambient" | "demand" }) {
  if (mode === "ambient") {
    // `breathe` *is* meant for the dot: 50% to 100% and back, which reads as
    // alive without ever reading as urgent.
    return <span className="breathe block h-[7px] w-[7px] shrink-0 rounded-full bg-slate" />;
  }

  /* `ember-pulse` is a halo, not a dot — it runs from 32% opacity out to 190%
     scale and down to 8%. Putting it straight on the dot, as this did at
     first, leaves the one loud thing in the whole product sitting at a third
     of its opacity and reading as brown. Solid dot, ring behind it: the same
     two elements `Signal` draws for the same state inside the app. */
  return (
    <span className="relative grid h-[7px] w-[7px] shrink-0 place-items-center text-ember">
      <span className="ember-pulse absolute h-[7px] w-[7px] rounded-full bg-current" />
      <span className="island-ember relative h-[7px] w-[7px] rounded-full bg-current" />
    </span>
  );
}

/* ── Expanded ──────────────────────────────────────────────────────────── */

export function Panel({
  state,
  mode,
  onOpen,
  onGrab,
  clear = 0,
  children,
}: {
  state: IslandState;
  mode: ReturnType<typeof modeOf>;
  onOpen: (row: Row) => void;
  onGrab: () => void;
  /** Height of the cutout to keep clear at the top, when docked. */
  clear?: number;
  children?: React.ReactNode;
}) {
  const overflow = state.waiting.length - MOST_WAITING;

  return (
    <div className="w-[364px] pb-1" style={clear ? { paddingTop: clear } : undefined}>
      <div className="flex h-[22px] items-center justify-end pr-0.5 pl-2">
        <Grip onGrab={onGrab} />
      </div>

      {state.waiting.length > 0 && (
        <>
          <Head label="Waiting on you" count={state.waiting.length} />
          {state.waiting.slice(0, MOST_WAITING).map((row) => (
            <RowLine key={row.key} row={row} onOpen={onOpen} />
          ))}
          {overflow > 0 && (
            <p className="px-3 pt-0.5 pb-1 text-meta text-mute">and {overflow} more</p>
          )}
        </>
      )}

      {state.working.length > 0 && (
        <>
          <Head label="In flight" count={state.working.length} />
          {state.working.slice(0, MOST_WORKING).map((row) => (
            <RowLine key={row.key} row={row} onOpen={onOpen} />
          ))}
        </>
      )}

      {mode === "dormant" && (
        <p className="px-3 pt-1 pb-2 text-meta text-mute">
          {state.servers === 0 ? "No servers connected." : "Nothing running."}
        </p>
      )}

      {/* Dimmed, never red: a server behind a VPN that is off has not failed. */}
      {state.unreachable > 0 && (
        <p className="px-3 pb-1 text-meta text-mute">
          {state.unreachable === 1 ? "1 server" : `${state.unreachable} servers`} not answering —
          showing what was last known
        </p>
      )}

      {children}
    </div>
  );
}

function Head({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between border-t border-line-soft px-3 pt-1.5 pb-0.5">
      <span className="eyebrow">{label}</span>
      <span className="font-mono text-micro text-mute">{count}</span>
    </div>
  );
}

function RowLine({ row, onOpen }: { row: Row; onOpen: (row: Row) => void }) {
  return (
    <button
      onClick={() => onOpen(row)}
      className={`flex h-[34px] w-full items-center gap-2.5 px-3 text-left transition-colors duration-150 hover:bg-raise/70 ${
        row.stale ? "stale" : ""
      }`}
    >
      <Signal status={row.status} size={6} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui text-dim">{row.name}</span>
        <span className="block truncate font-mono text-micro text-mute">{row.repo}</span>
      </span>
      <span className="server-mark grid h-[15px] w-[15px] shrink-0 place-items-center" data-reach="live">
        {row.mark}
      </span>
      <AgentMark agent={row.agent} size={12} className="shrink-0 text-mute" />
      <span className="w-[30px] shrink-0 text-right font-mono text-micro text-mute">
        {elapsed(row.minutes)}
      </span>
    </button>
  );
}

/* ── Furniture ─────────────────────────────────────────────────────────── */

/**
 * Two columns of dots, and the whole reason the island can live anywhere.
 *
 * `startDragging` hands the window to AppKit for the length of the drag; where
 * it lands is worked out afterwards, in `place.ts`, because the webview never
 * reliably sees the mouse come back up.
 */
function Grip({ onGrab }: { onGrab: () => void }) {
  return (
    <span
      className="island-grip grid shrink-0 place-items-center px-1.5 py-1"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        onGrab();
      }}
      aria-hidden
    >
      <svg width="6" height="12" viewBox="0 0 6 12" fill="currentColor">
        {[2, 6, 10].map((y) => (
          <g key={y}>
            <circle cx="1" cy={y} r="1" />
            <circle cx="5" cy={y} r="1" />
          </g>
        ))}
      </svg>
    </span>
  );
}

type Choice = "dock" | "float" | "quiet" | "unshared";

function Menu({
  prefs,
  dockable,
  docked,
  onPick,
}: {
  prefs: Prefs;
  dockable: boolean;
  docked: boolean;
  onPick: (what: Choice) => void;
}) {
  return (
    <div className="mt-1 border-t border-line-soft pt-1">
      {dockable &&
        (docked ? (
          <Item onPick={() => onPick("float")}>Float free of the notch</Item>
        ) : (
          <Item onPick={() => onPick("dock")}>Dock into the notch</Item>
        ))}
      <Item onPick={() => onPick("unshared")}>
        {prefs.unshared ? "Show in screen shares" : "Hide from screen shares"}
      </Item>
      {/* The way back. Quiet already lets ember through, so this item is
          reachable the moment something needs you — but somebody who changed
          their mind before that should not have to wait for an agent to stop
          in order to undo it. */}
      <Item onPick={() => onPick("quiet")}>
        {prefs.quiet ? "Keep it on screen" : "Hide until something needs you"}
      </Item>
    </div>
  );
}

function Item({ children, onPick }: { children: React.ReactNode; onPick: () => void }) {
  return (
    <button
      onClick={onPick}
      className="block w-full px-3 py-1.5 text-left text-meta text-text transition-colors duration-150 hover:bg-raise/70"
    >
      {children}
    </button>
  );
}

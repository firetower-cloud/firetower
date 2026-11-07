/**
 * The home: a greeting, a composer, and what is worth a glance under it.
 *
 * Drawn in `docs/prototypes/redesign/home-alternative.html`, which supersedes
 * the Dashboard in `desktop-redesign.html` for this screen. The screen it
 * replaces opened with a status — *"Three agents are waiting on you."* — and
 * docked the composer to the foot of the page. This opens with a greeting and
 * puts the composer in the middle, because starting something is what
 * somebody is here to do far more often than triaging four agents.
 *
 * **The headline is always a greeting, never a status.** The same sentence
 * whether four are waiting or none are. What is waiting is still on the
 * screen; it is a section under the composer rather than the first thing the
 * page says.
 *
 * ## One section, ordered by status
 *
 * It was three — *Waiting for you*, *Handed back*, *Working* — and they were
 * reversed as soon as they were built: with one chip under each, a heading per
 * category costs more than it returns. Three words of chrome to label three
 * words of content.
 *
 * What makes one section work is that **the marks are shapes rather than
 * colours** — ember dot, sage tick, slate typing, brick triangle, all told
 * apart with the colour off. That has only been true since `BeatMark` existed;
 * before it a single row would have been four greys and the headings would
 * have been load-bearing.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronUp } from "lucide-react";
import { Icon } from "~/components/ui";
import { ArtifactShot } from "~/components/ArtifactShot";
import { BeatMark } from "~/components/BeatMark";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import type { Artifact } from "~/api/generated/model";
import { elapsed, minutesSince, needsYou, type Beat } from "~/api/view";
import { flat, group, isChild, placeBeat, type Workspace } from "~/api/workspaces";
import { useSessions } from "~/data";
import { useFleet, waitingIn, type Backend } from "~/fleet";
import { navigate } from "~/shims/next-navigation";
import { useNow } from "~/ui/clock";
import { StartComposer } from "~/ui/StartComposer";
import { cameFrom } from "~/ui/ArtifactsPage";

/** Small numbers read as words. A sentence does not count in digits. */
const WORDS = ["no", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const say = (n: number) => WORDS[n] ?? String(n);

/**
 * The order of *Recent agents*: severity first, then what has finished, then
 * what is still going.
 *
 * It is `placeBeat`'s own precedence with `broken` lifted to the front —
 * **a failed run is the one thing here you cannot act on by waiting.** That
 * precedence spends ember on being stuck and on nothing else, which is right
 * for choosing *one* mark for a row; it is not right for ordering a list
 * somebody scans left to right.
 *
 * `over` is not in it. The home draws live sessions only, so nothing here can
 * roll up to ended — and a beat this does not name sorts last rather than
 * first, which is what `indexOf`'s `-1` would have done.
 */
const AGENT_ORDER: Beat[] = ["broken", "blocked", "done", "working"];
const rank = (beat: Beat) => {
  const at = AGENT_ORDER.indexOf(beat);
  return at < 0 ? AGENT_ORDER.length : at;
};

/**
 * How many rows of chips are drawn before the rest is behind *View all*.
 *
 * **A parameter, because it was asked for as two, then one, then two.** The
 * drawing carries both in its masthead for the same reason. Two is the
 * default: measured at the 748px column, one row holds 2–3 chips and two hold
 * 4–5 — not double, because the second row only exists once the first
 * overflows.
 */
export const ROWS = 2;

/**
 * Worst first, for the home's one section. A comparator rather than a sort in
 * place, so the order is a thing a test can hold.
 *
 * `placeBeat` reads one hop past what is drawn — a child in a workspace of its
 * own is hidden here and belongs to its lead — so it needs the whole list and
 * not the list being ordered.
 */
export const severityFirst = (every: Workspace[]) => (a: Workspace, b: Workspace) =>
  rank(placeBeat(a, every)) - rank(placeBeat(b, every));

/**
 * Three greetings off the machine's own clock.
 *
 * The boundaries are the ordinary ones and the late-night window is the only
 * interesting call: 00:00–04:59 takes *evening* rather than a fourth
 * greeting, because a fourth is a joke and a joke you cannot dismiss gets old
 * by the third night.
 */
export function greeting(at: Date = new Date()): string {
  const h = at.getHours();
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function Home({ backend, onSwitch }: { backend: Backend; onSwitch: (serverId: string) => void }) {
  const { data: sessions } = useSessions();
  const artifacts = useListArtifacts();
  const fleet = useFleet();
  /* The ages come off the clock, and a workspace working quietly produces no
     renders of its own. */
  useNow();

  const { agents, asks, every } = useMemo(() => {
    const live = sessions.filter((s) => s.status !== "Ended");
    const places = flat(group(live));
    /* A child in its own workspace lives under its lead in the Overview tab,
       not as a chip of its own here. */
    const top = places.filter((p) => !isChild(p, places));
    return {
      /* **No agents at all is not a state of this page.** It is first run,
         and first run has no section rather than an empty one. `group()` has
         already put what needs you first and the newest next, and `sort` is
         stable, so that survives inside each beat. */
      agents: [...top].sort(severityFirst(places)),
      asks: top.filter((p) => p.runs.some(needsYou)),
      /* `placeBeat` reads one hop past what is drawn, so it needs them all. */
      every: places,
    };
  }, [sessions]);

  const recent = (artifacts.data ?? []).slice(0, 3) as Artifact[];

  /* One line, only while it is true. */
  const elsewhere = fleet.find(
    (f) => f.backend.id !== backend.id && f.backend.reach === "live" && waitingIn(f.sessions) > 0,
  );

  /* Nothing running and nothing published: first run. It has to look
     deliberate rather than broken, so the column centres and the sections are
     simply absent — no heading over three grey plates, and no sentence
     explaining what an artifact is. The composer is the only thing to do and
     the page says so by having nothing else on it. */
  const bare = agents.length === 0 && recent.length === 0;

  /** Whether the section is showing everything. */
  const [expanded, setExpanded] = useState(false);

  /**
   * **What *View all* does — one function, so it stays one line to change.**
   *
   * It expands in place, which is the drawing's default and what was asked
   * for. The alternative — opening the workspaces panel at the same list —
   * was built and withdrawn: **the panel is usually already pinned open**, so
   * on the common path the press would do nothing at all. A control that is
   * inert depending on state the press does not change is a worse defect than
   * a loud screen, and it is the exact class `assert-connected.mjs` exists to
   * find.
   *
   * The ember cost is real and accepted, and it is **not** the expansion's.
   * Measured on a rendered page at 36 workspaces: two rows put **5 ember on
   * screen against a budget of 3** — four chips and the rail's avatar — and
   * expanding to all 36 chips puts up **5 as well**. Severity first is why:
   * every ember chip is at the front of the row, so two rows already shows
   * all of them and what expanding reveals is sage and slate. The overrun
   * belongs to the two-row default, which was chosen with the number in
   * hand; *View all* costs nothing on top of it.
   */
  const openBand = () => setExpanded((held) => !held);

  return (
    <StartComposer mid bare={bare} above={<h1>{greeting()}, what should we work on?</h1>}>
      {agents.length > 0 && (
        <Recent list={agents} every={every} open={expanded} onAll={openBand} />
      )}

      {recent.length > 0 ? (
        <section className="sect">
          <div className="hd">
            <h2>Recent artifacts</h2>
            <button onClick={() => navigate("/artifacts")} className="all">
              View all
              <Icon of={ChevronRight} size={14} />
            </button>
          </div>
          <div className="three">
            {recent.map((a) => (
              <Poster key={a.id} artifact={a} />
            ))}
          </div>
        </section>
      ) : (
        asks.length > 0 && (
          <section className="sect">
            <p className="none">
              Nothing published yet. Ask an agent to show you something and the page it makes lands
              here.
            </p>
          </section>
        )
      )}

      {elsewhere && (
        <button
          onClick={() => onSwitch(elsewhere.backend.id)}
          title={`Switch to ${elsewhere.backend.org}`}
          className="elsewhere"
        >
          <span>
            {say(waitingIn(elsewhere.sessions))} more waiting in <b>{elsewhere.backend.org}</b> — you
            are not in it
          </span>
          <span className="go">
            Switch
            <Icon of={ChevronRight} size={12} />
          </span>
        </button>
      )}
    </StartComposer>
  );
}

/** One artifact, as a poster. Never a live frame — see `ArtifactShot`. */
function Poster({ artifact }: { artifact: Artifact }) {
  return (
    <button onClick={() => navigate(`/artifacts/${artifact.id}`)} className="art" title={artifact.title}>
      <ArtifactShot artifact={artifact} framed={false} className="shot" />
      <span className="nm">{artifact.title}</span>
      <span className="mt">
        <span className="min-w-0 truncate">{cameFrom(artifact)}</span>
        <span className="ml-auto flex-none tabular-nums text-mute">
          {elapsed(minutesSince(artifact.updatedAt))}
        </span>
      </span>
    </button>
  );
}

/**
 * *Recent agents*: a heading, `ROWS` rows of chips, and *View all* when there
 * is more than that.
 *
 * **Both the clip and the control are decided by measurement.** A chip is as
 * wide as a workspace name, so how many fit on a row is not a number anybody
 * can write down and a guessed `max-height` is wrong the moment a name
 * changes. The rows are found from the chips themselves: group them by
 * `offsetTop`, keep the first `ROWS` of them, clip to the bottom of the last
 * one kept. **The cut is always between rows, never through a chip**, because
 * a wrapped flex row moves a whole item down rather than slicing one.
 *
 * If nothing falls past the limit there is nothing to view and the control is
 * not drawn at all.
 *
 * **And no hairline where the order turns.** The workspaces panel rules its
 * bands because it is a tall list you scan down; this is two to five chips,
 * and at two rows a rule would land somewhere different every time a name
 * changed length. A break that moves is worse than no break — the marks are
 * the ordering, and they are shapes.
 */
function Recent({
  list,
  every,
  open,
  onAll,
}: {
  list: Workspace[];
  every: Workspace[];
  /** Expanded: every chip, no clip, and the control reads *View less*. */
  open: boolean;
  onAll: () => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [spills, setSpills] = useState(false);

  /* After layout, because `offsetTop` before it is a guess. */
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => {
      const chips = [...el.children] as HTMLElement[];
      el.style.maxHeight = "";
      if (chips.length === 0) return setSpills(false);
      const tops = [...new Set(chips.map((c) => c.offsetTop))].sort((a, b) => a - b);
      const over = tops.length > ROWS;
      /* **Whether the control is drawn is measured while expanded too.** It
         is what turns *View less* back off; reading it only while clipped
         would leave the control showing after the last chip went away. */
      setSpills(over);
      if (!over || open) return;
      /* The first chip on the last row kept — every chip on a row shares its
         top and its height, so any of them gives the same bottom edge. */
      const last = chips.find((c) => c.offsetTop === tops[ROWS - 1]);
      if (last) el.style.maxHeight = `${last.offsetTop - chips[0].offsetTop + last.offsetHeight}px`;
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [list, open]);

  return (
    <section className="sect">
      <div className="hd">
        <h2>Recent agents</h2>
        <button hidden={!spills} onClick={onAll} className="all">
          {open ? "View less" : "View all"}
          <Icon of={open ? ChevronUp : ChevronRight} size={14} />
        </button>
      </div>
      {/* No `data-rows` while expanded, which is what takes the clip off. */}
      <div ref={row} className="chips" data-rows={open ? undefined : ROWS}>
        {list.map((place) => {
          const beat = placeBeat(place, every);
          const asking = place.runs.find(needsYou);
          const note = asking?.note?.trim();
          return (
            <button
              key={place.id}
              onClick={() => navigate(`/sessions/${place.id}`)}
              title={note ? `${place.name} — ${note}` : place.name}
              className="sw"
            >
              {/* **The same alphabet the team rail uses.** This was a plain
                  `.dot` wearing the beat as a colour, so a failed workspace
                  was a brick circle here beside ember circles — one shape
                  told from another by hue, which is the one thing the guide
                  forbids. `broken` is the warning triangle, and it leads. */}
              <BeatMark beat={beat} />
              <b>{place.name}</b>
              <span className="age">{elapsed(minutesSince((asking ?? place.runs[0]).createdAt))}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

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
 * ## The ember budget, again
 *
 * Two chips carry a dot. Everything past them collapses into one chip reading
 * "N more" with no dot at all. That is the Dashboard's `IN_FULL = 2` rule said
 * in a different shape, and it is not a layout convenience: the budget is
 * three ember marks on screen, the rail's avatar can take the third, and five
 * dots in a row is the exact failure the redesign's first round was rejected
 * for.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronUp } from "lucide-react";
import { Icon } from "~/components/ui";
import { ArtifactShot } from "~/components/ArtifactShot";
import { BeatMark } from "~/components/BeatMark";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import type { Artifact } from "~/api/generated/model";
import { elapsed, minutesSince, needsYou } from "~/api/view";
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
 * The three sections, in order, above *Recent artifacts*.
 *
 * They key off `BEAT` through `placeBeat`, the same rollup the rail's mark
 * and the panel's dot use — one fact, one function. Each chip carries its own
 * tone, which is what makes three sections legible rather than three
 * identical grey rows.
 */
const BANDS = [
  { beat: "blocked", title: "Waiting for you" },
  { beat: "done", title: "Handed back" },
  { beat: "working", title: "Working" },
] as const;

/** How many waiting chips carry a dot. See the ember budget above. */
export const DOTTED = 2;

/**
 * The split, as a function, so the budget can be tested rather than eyeballed.
 *
 * It was two `slice` calls inline and a test that pointed at the Dashboard's
 * version of the same rule — a screen this one replaced. An eye cannot check
 * a count reliably and a test can, so the rule gets a name.
 */
export function drawnInFull<T>(waiting: T[]): { inFull: T[]; quieter: T[] } {
  return { inFull: waiting.slice(0, DOTTED), quieter: waiting.slice(DOTTED) };
}

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

  const { bands, asks, every } = useMemo(() => {
    const live = sessions.filter((s) => s.status !== "Ended");
    const places = flat(group(live));
    /* A child in its own workspace lives under its lead in the Overview tab,
       not as a chip of its own here.

       **The section still lists all three.** `needsYou` is right that handed
       back and failed both want you — what changes is that each chip wears
       its own tone. The section says *these need you*; the dot says what
       kind of needing. */
    const top = places.filter((p) => !isChild(p, places));
    return {
      /* **An empty section is not drawn at all.** Three headings with
         nothing under two of them is worse than one heading, and a section
         that is sometimes there reads more easily than a section that is
         sometimes empty. So *nothing waiting* is not a state of this page —
         it is the Waiting section not existing while the other two carry
         on, and all three gone is first run. */
      bands: BANDS.map((b) => ({
        ...b,
        list: top.filter((p) => {
          const beat = placeBeat(p, places);
          /* **`broken` has no section of its own.** It sits in *Waiting for
             you* with its brick triangle, which is the status quo; giving it
             a fourth section is a question the user has deferred. */
          return beat === b.beat || (b.beat === "blocked" && beat === "broken");
        }),
      })).filter((b) => b.list.length > 0),
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

  /* Nothing waiting and nothing published: first run. It has to look
     deliberate rather than broken, so the column centres and the sections are
     simply absent — no heading over three grey plates, and no sentence
     explaining what an artifact is. The composer is the only thing to do and
     the page says so by having nothing else on it. */
  const bare = bands.length === 0 && recent.length === 0;

  /** Which section is open, if any. */
  const [expanded, setExpanded] = useState<string | null>(null);

  /**
   * **What *View more* does — one function, by design.**
   *
   * Expanding in place is what was asked for and what the drawing defaults
   * to. The alternative is opening the Workspaces panel at that band, which
   * matters because expanding measured **5 ember at 36 workspaces against a
   * budget of 3**, and the home has no exemption where the panel does.
   *
   * That decision is still with the user, so switching it is this body and
   * not a refactor: replace the two lines with a navigate and a band.
   */
  const openBand = (beat: string) => setExpanded((held) => (held === beat ? null : beat));

  return (
    <StartComposer mid bare={bare} above={<h1>{greeting()}, what should we work on?</h1>}>
      {bands.map((band) => (
        <Band
          key={band.beat}
          band={band}
          every={every}
          open={expanded === band.beat}
          onMore={() => openBand(band.beat)}
        />
      ))}

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
 * One section: a heading, one line of chips, and *View more* when there is
 * more than a line.
 *
 * **The clip is measured, not counted.** A fixed number of chips is wrong the
 * moment a name is long, and a wrapped flex row moves a whole item down
 * rather than slicing one — so clipping to the first chip's height hides
 * chips entirely and never cuts through a name. *View more* appears only
 * when something is actually on a second row, which is read off the layout
 * rather than assumed.
 *
 * The chip caps at 306px and truncates, so one name can never fill the line
 * alone; the column is capped at 748px, which makes how many fit a constant
 * of the design rather than of the window.
 */
function Band({
  band,
  every,
  open,
  onMore,
}: {
  band: { beat: string; title: string; list: Workspace[] };
  every: Workspace[];
  open: boolean;
  onMore: () => void;
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
      const top = chips[0].offsetTop;
      const over = chips.some((c) => c.offsetTop > top + 2);
      setSpills(over);
      if (over && !open) el.style.maxHeight = `${chips[0].offsetHeight}px`;
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [band.list, open]);

  return (
    <section className="sect">
      <div className="hd">
        <h2>{band.title}</h2>
        {/* **One function, so the target is a line to change.** What *View
            more* does is still with the user: expanding in place measured 5
            ember at 36 workspaces against a budget of 3, and the home has no
            exemption — opening the Workspaces panel at this band measures 3.
            It expands, because that is what was asked for; `onMore` is where
            it switches. */}
        <button hidden={!spills} onClick={onMore} className="all">
          {open ? "View less" : "View more"}
          <Icon of={open ? ChevronUp : ChevronRight} size={14} />
        </button>
      </div>
      <div ref={row} className="chips" data-one={!open}>
        {band.list.map((place) => {
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
                  forbids. `broken` is the warning triangle. */}
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

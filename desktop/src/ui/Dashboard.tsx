/**
 * The one screen that answers "do I need to do anything".
 *
 * It was a table: a filter bar, a repository select, four ALL-CAPS column
 * headers, and a row per workspace carrying a branch, three agent marks, an
 * elapsed time and a state pill. Everything was the same weight, so the
 * question the screen exists for — *is an agent waiting on me* — had to be
 * read out of a grid.
 *
 * It is a sentence now, and then the questions themselves. **The agent's own
 * words, at reading size**, from `Session.note`, which is exactly that: "only
 * ever the agent's own words, and only for the statuses that mean your move".
 * Nothing new is fetched to get it — it is already on the row.
 *
 * ## The ember budget
 *
 * An earlier round put six dots on this screen and was rejected for it. The
 * budget is **three on screen at once**, and the arithmetic is deliberate:
 * at most **two** questions are drawn in full with a dot, and the rail's
 * avatar carries at most one more for *waiting somewhere you are not*. In the
 * calm state that leaves exactly one.
 *
 * A third waiting agent does not get a third dot. It joins the list below at
 * the brightest text tier and in medium weight — which is the system's own
 * rule, the same one the rail's panel follows: anything new is shape, weight
 * or position, never a new hue.
 */
import { useMemo } from "react";
import { ChevronRight, Monitor, Terminal } from "lucide-react";
import { AgentMark } from "~/components/AgentMark";
import { Icon } from "~/components/ui";
import { flat, group, isChild, type Workspace } from "~/api/workspaces";
import { elapsed, inFlight, minutesSince, needsYou } from "~/api/view";
import { useNow } from "~/ui/clock";
import { useFleet, waitingIn, type Backend } from "~/fleet";
import { useHosts, useSessions } from "~/data";
import { whereItRuns } from "~/ui/StatusBar";
import { navigate } from "~/shims/next-navigation";
import { StartComposer } from "~/ui/StartComposer";

/** Small numbers read as words. A sentence does not count in digits. */
const WORDS = ["no", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const say = (n: number) => WORDS[n] ?? String(n);

/** How many questions are drawn in full. See the ember budget above. */
const IN_FULL = 2;

/**
 * Which questions get a dot, and which get weight instead.
 *
 * The cap is the ember budget and not a layout convenience: three dots here
 * plus the rail's avatar is four of the one colour that is supposed to be
 * rare. Everything past the cap is still on the screen — it is in the list
 * below in medium weight at the brightest tier, and it is in the rail's panel
 * — it just does not get a second way of shouting.
 */
export function drawnInFull<T>(asks: T[]): { inFull: T[]; quieter: T[] } {
  return { inFull: asks.slice(0, IN_FULL), quieter: asks.slice(IN_FULL) };
}

/**
 * What to call the list under the questions.
 *
 * "Still working" is a lie about a workspace that is waiting on you and did
 * not fit in the budget above, so the word changes when one of those is in
 * there. With nothing waiting at all it is not "others" — it is the list.
 */
export function also(asking: number, quieter: number, working: number): string {
  const n = quieter + working;
  if (asking === 0) return "Working";
  return `${say(n)} other${n === 1 ? " is" : "s are"} still ${quieter > 0 ? "open" : "working"}`;
}

export function Dashboard({ backend, onSwitch }: { backend: Backend; onSwitch: (serverId: string) => void }) {
  const { data: sessions, loading, error } = useSessions();
  const fleet = useFleet();
  /* The ages come off the clock, and a workspace working quietly produces no
     renders of its own. */
  useNow();

  const { asks, working, agentsWaiting, agentsWorking } = useMemo(() => {
    const live = sessions.filter((s) => s.status !== "Ended");
    const places = flat(group(live));
    /* A child in its own workspace lives under its lead in the Overview tab,
       not as a row of its own here. */
    const top = places.filter((p) => !isChild(p, places));
    return {
      asks: top.filter((p) => p.runs.some(needsYou)),
      working: top.filter((p) => !p.runs.some(needsYou)),
      /* The sentence counts **agents**, which is what it says and what the
         dock badge counts — three agents can be waiting in two workspaces,
         and the badge on the dock has always said three. The items below are
         workspaces, because a workspace is what you open. */
      agentsWaiting: live.filter(needsYou).length,
      agentsWorking: live.filter(inFlight).length,
    };
  }, [sessions]);

  /* One line, only while it is true. The whole of what the "all servers"
     scope and the Fleet screen used to do inside the window. */
  const elsewhere = fleet.find(
    (f) => f.backend.id !== backend.id && f.backend.reach === "live" && waitingIn(f.sessions) > 0,
  );

  const nothingYet = !loading && !error && asks.length === 0 && working.length === 0;
  const { inFull, quieter } = drawnInFull(asks);

  return (
    <StartComposer>
      {nothingYet ? (
        <div className="grid min-h-0 flex-1 place-items-center px-8 pb-[170px]">
          <div className="max-w-[430px] text-center">
            <span className="mx-auto grid h-13 w-13 place-items-center rounded-2xl bg-raise text-mute">
              <Icon of={Terminal} size={20} />
            </span>
            <h2 className="mt-5 text-display font-mid text-bone">What should we build?</h2>
            <p className="mt-2 text-read text-dim">
              Describe it, and an agent starts on it in its own copy of the code.
            </p>
          </div>
        </div>
      ) : (
        <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[740px] px-[34px] pt-13 pb-[230px]">
            {loading && <p className="text-read text-mute">Reading what is running…</p>}
            {error && <p className="text-read text-brick">{error}</p>}

            {!loading && !error && (
              <>
                <h1 className="text-hero font-mid text-bone">
                  {agentsWaiting > 0
                    ? `${say(agentsWaiting)} agent${agentsWaiting === 1 ? " is" : "s are"} waiting on you.`
                    : `${say(agentsWorking)} agent${agentsWorking === 1 ? " is" : "s are"} working.`}
                </h1>
                {agentsWaiting === 0 && (
                  <p className="mt-3 max-w-[46ch] text-lede text-dim">Nothing needs you right now.</p>
                )}
              </>
            )}

            {inFull.length > 0 && (
              <div className="mt-7 flex flex-col">
                {inFull.map((place) => (
                  <Ask key={place.id} place={place} />
                ))}
              </div>
            )}

            {elsewhere && (
              <button
                onClick={() => onSwitch(elsewhere.backend.id)}
                title={`Switch to ${elsewhere.backend.org}`}
                className="elsewhere mt-6 text-ui"
              >
                <span>
                  {say(waitingIn(elsewhere.sessions))} more waiting in <b>{elsewhere.backend.org}</b> — you are not in it
                </span>
                <span className="go text-ui">
                  Switch
                  <Icon of={ChevronRight} size={12} />
                </span>
              </button>
            )}

            {(quieter.length > 0 || working.length > 0) && (
              <section className="mt-13">
                <h2 className="text-ui font-normal text-dim">{also(asks.length, quieter.length, working.length)}</h2>
                <div className="mt-1.5">
                  {/* The waiting ones past the budget. Weight and the brightest
                      tier, never a third dot. */}
                  {quieter.map((place) => (
                    <Row key={place.id} place={place} hot />
                  ))}
                  {working.map((place) => (
                    <Row key={place.id} place={place} />
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </StartComposer>
  );
}

/**
 * One agent, and what it asked.
 *
 * Not a card and not a filled block — a name, a question and one dot, on the
 * page itself, where a dot is the loudest thing there is. The question is the
 * agent's own sentence at reading size, which is the whole reason this screen
 * is worth opening rather than the rail.
 */
function Ask({ place }: { place: Workspace }) {
  const asking = place.runs.find(needsYou);
  const question = asking?.note?.trim();
  return (
    <button onClick={() => navigate(`/sessions/${place.id}`)} className="ask">
      <span className="top flex min-w-0 items-center gap-2.5">
        <span className="dot" />
        <span className="min-w-0 truncate text-title font-mid text-bone">{place.name}</span>
        <span className="flex-1" />
        <span className="shrink-0 text-ui tabular-nums text-dim">
          {elapsed(minutesSince((asking ?? place.runs[0]).createdAt))}
        </span>
      </span>
      {question ? (
        <span className="mt-2 block text-lede text-text">{question}</span>
      ) : (
        /* No words with it. The status is still the answer — it is your move —
           and saying so beats an empty space where a sentence should be. */
        <span className="mt-2 block text-lede text-dim">Waiting on you.</span>
      )}
    </button>
  );
}

/**
 * A workspace that is not asking: a name and one timestamp.
 *
 * The branch, the agent and the machine are facts *about* the row rather than
 * things anybody reads, so they arrive on hover — and on focus, or the
 * keyboard would be told less than the mouse.
 */
function Row({ place, hot = false }: { place: Workspace; hot?: boolean }) {
  const hosts = useHosts();
  const lead = place.runs[0];
  const host = hosts.data.find((h) => h.id === lead.hostId);
  const where = whereItRuns(host, hosts.data);
  const live = place.runs.some(inFlight);

  return (
    <button onClick={() => navigate(`/sessions/${place.id}`)} className="wrow">
      <span className="top flex min-w-0 items-center gap-2.5">
        <span className={`min-w-0 truncate text-read ${hot ? "font-mid text-bone" : "text-text"}`}>
          {place.name}
        </span>
        {live && (
          <span className="typing" title="Working now">
            <i />
            <i />
            <i />
          </span>
        )}
        <span className="ml-auto shrink-0 text-ui tabular-nums text-dim">
          {elapsed(minutesSince(lead.createdAt))}
        </span>
      </span>
      <span className="more text-meta text-dim">
        <span>
          <AgentMark agent={lead.agent} size={13} className="shrink-0 text-mute" />
          {place.branch ? (
            <span className="truncate font-mono text-micro tracking-tight">{place.branch}</span>
          ) : (
            <span>no branch yet</span>
          )}
          {where && (
            <>
              <Icon of={Monitor} size={12} className="shrink-0 text-mute" />
              <span className="truncate">{where.name}</span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}

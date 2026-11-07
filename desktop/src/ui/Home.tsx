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
import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { Icon } from "~/components/ui";
import { ArtifactShot } from "~/components/ArtifactShot";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import type { Artifact } from "~/api/generated/model";
import { elapsed, minutesSince, needsYou } from "~/api/view";
import { flat, group, isChild } from "~/api/workspaces";
import { useSessions } from "~/data";
import { useFleet, waitingIn, type Backend } from "~/fleet";
import { navigate } from "~/shims/next-navigation";
import { useNow } from "~/ui/clock";
import { StartComposer } from "~/ui/StartComposer";
import { cameFrom } from "~/ui/ArtifactsPage";

/** Small numbers read as words. A sentence does not count in digits. */
const WORDS = ["no", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const say = (n: number) => WORDS[n] ?? String(n);

/** How many waiting chips carry a dot. See the ember budget above. */
export const DOTTED = 2;

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

  const asks = useMemo(() => {
    const live = sessions.filter((s) => s.status !== "Ended");
    const places = flat(group(live));
    /* A child in its own workspace lives under its lead in the Overview tab,
       not as a chip of its own here. */
    return places.filter((p) => !isChild(p, places)).filter((p) => p.runs.some(needsYou));
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
  const bare = asks.length === 0 && recent.length === 0;
  const over = asks.length - DOTTED;

  return (
    <StartComposer mid bare={bare} above={<h1>{greeting()}, what should we work on?</h1>}>
      {asks.length > 0 && (
        <section className="sect">
          <div className="hd">
            <h2>Agents waiting for you</h2>
          </div>
          <div className="chips">
            {asks.slice(0, DOTTED).map((place) => {
              const asking = place.runs.find(needsYou);
              const note = asking?.note?.trim();
              return (
                <button
                  key={place.id}
                  onClick={() => navigate(`/sessions/${place.id}`)}
                  title={note ? `${place.name} — ${note}` : place.name}
                  className="sw"
                >
                  <span className="dot" />
                  <b>{place.name}</b>
                  <span className="age">
                    {elapsed(minutesSince((asking ?? place.runs[0]).createdAt))}
                  </span>
                </button>
              );
            })}
            {/* No dot. This is a count, not a third thing shouting. */}
            {over > 0 && (
              <button
                onClick={() => navigate(`/sessions/${asks[DOTTED].id}`)}
                data-over="true"
                title={`${over} more waiting`}
                className="sw"
              >
                <b>{say(over)} more</b>
              </button>
            )}
          </div>
        </section>
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

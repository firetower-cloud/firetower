/**
 * What a profile always has, as one list.
 *
 * **A profile is a closed set.** This list is exactly what an agent started
 * from it loads — never unioned with whoever starts it. It replaces three
 * additive sources governed by two switches, and the reason is not tidiness:
 * the other two belonged to the *starter*, so two people beginning the same
 * profile got two different agents. A saved kind of agent that is not the same
 * agent for everybody is not a saved kind of agent.
 *
 * **The connector line is the thing the plugin abstraction otherwise hides.**
 * A skill installs once for everybody; a connector authorizes per person. So
 * "this profile has GitHub" is a task for whoever starts it rather than a
 * finished state, and the count is read for the person looking at the screen.
 */
import { useMemo, useState } from "react";
import { Link2, Plus, X } from "lucide-react";
import { IconButton } from "~/components/ui";
import { useSkills } from "~/data";
import { useConnectorState } from "~/api/generated/connectors/connectors";
import type { Skill } from "~/api/generated/model";

/**
 * What is inside a bundle, as a phrase rather than a meta string.
 *
 * Kept for the screens that still think in bundles — a profile's list is one
 * — while the library itself lists components and has no use for it.
 */
export function contents(p: { hasConnector?: boolean; nSkills?: number; nCommands?: number }): string {
  const bits: string[] = [];
  const say = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (p.hasConnector) bits.push("1 connector");
  if (p.nSkills) bits.push(say(p.nSkills, "skill", "skills"));
  if (p.nCommands) bits.push(say(p.nCommands, "command", "commands"));
  if (!bits.length) return "nothing in it yet";
  if (bits.length === 1) return bits[0];
  return `${bits.slice(0, -1).join(", ")} and ${bits[bits.length - 1]}`;
}



/** A monogram, from the initial of each hyphenated part. */
function mono(name: string): string {
  const parts = name.split(/[-_ ]/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toLowerCase();
}

/**
 * Whether **you** hold a credential for one of this profile's connectors.
 *
 * Read per row and per person. A colleague opening the same profile sees a
 * different answer, which is the whole point of the line this feeds.
 */
function useConnected(of: Skill[]): { held: number; total: number } {
  /* Hooks cannot be called in a loop over a changing list, so this asks about
     at most four — enough for the sentence to be true in every real profile,
     and the list itself says which ones when it is longer. */
  const slots = [0, 1, 2, 3];
  const ids = slots.map((i) => of[i]?.id ?? "");
  const answers = [
    useConnectorState(ids[0]!, { query: { enabled: !!ids[0] } }),
    useConnectorState(ids[1]!, { query: { enabled: !!ids[1] } }),
    useConnectorState(ids[2]!, { query: { enabled: !!ids[2] } }),
    useConnectorState(ids[3]!, { query: { enabled: !!ids[3] } }),
  ];
  const total = of.length;
  const held = answers.filter((a) => a.data?.connected).length;
  return { held, total };
}

export function ProfilePlugins({
  scope,
  onChange,
}: {
  scope: string[];
  onChange: (next: string[]) => void;
}) {
  const { data: library } = useSkills();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");

  const chosen = useMemo(
    () => scope.map((id) => library.find((s) => s.id === id)).filter((s): s is Skill => !!s),
    [scope, library],
  );
  const connectors = chosen.filter((s) => s.hasConnector);
  const { held, total } = useConnected(connectors);

  const offer = useMemo(() => {
    const term = query.trim().toLowerCase();
    return library
      .filter((s) => !scope.includes(s.id))
      .filter((s) => !term || s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term))
      .slice(0, 40);
  }, [library, scope, query]);

  return (
    <section className="mt-7">
      <h3 className="text-ui text-dim">What it always has</h3>
      <p className="mt-1 max-w-[70ch] text-meta text-dim">
        Exactly this, whoever starts it. A person&rsquo;s own always-on bundles are what an
        ad-hoc session opens with; a profile decides for itself.
      </p>

      <div className="mt-2">
        {chosen.map((s) => (
          <div key={s.id} className="r">
            <span className="plg">{mono(s.name)}</span>
            <span className="tx">
              <b>{s.name}</b>
              <s>{s.kind === "plugin" ? contents(s) : s.description}</s>
            </span>
            {s.hasConnector && (
              <span className="chip3">
                <Link2 className="mr-1 inline h-3.5 w-3.5 align-[-2px]" strokeWidth={1.5} />
                connector
              </span>
            )}
            <IconButton
              of={X}
              label={`Take ${s.name} off this profile`}
              className="hov"
              onClick={() => onChange(scope.filter((id) => id !== s.id))}
            />
          </div>
        ))}

        {chosen.length === 0 && (
          <p className="py-3 text-ui text-dim">
            Nothing yet, so an agent started from this profile reads only what the checkout
            commits.
          </p>
        )}

        {adding ? (
          <div className="mt-2 rounded-xl bg-raise p-3">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the library"
              aria-label="Search the library"
              className="w-full bg-transparent text-ui text-bone outline-none placeholder:text-mute"
            />
            <div className="mt-2 max-h-64 overflow-y-auto">
              {offer.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="r"
                  onClick={() => {
                    onChange([...scope, s.id]);
                    setQuery("");
                  }}
                >
                  <span className="plg">{mono(s.name)}</span>
                  <span className="tx">
                    <b>{s.name}</b>
                    <s>{s.kind === "plugin" ? contents(s) : s.description}</s>
                  </span>
                </button>
              ))}
              {offer.length === 0 && (
                <p className="py-2 text-ui text-dim">Nothing left that matches.</p>
              )}
            </div>
            <button type="button" className="btn quiet mt-2" onClick={() => setAdding(false)}>
              Done
            </button>
          </div>
        ) : (
          <button type="button" className="out mt-2" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" strokeWidth={1.5} />
            Add a plugin or a skill
          </button>
        )}
      </div>

      {total > 0 && (
        <p className="mt-3 max-w-[70ch] text-meta text-dim">
          <b className="font-mid text-bone">
            You have connected {held} of this profile&rsquo;s {total}{" "}
            {total === 1 ? "connector" : "connectors"}.
          </b>{" "}
          A connector travels with the profile; the authorization never does. A colleague sees
          their own count here, and starting this before connecting stops with the button rather
          than running without the tools it was built around.
        </p>
      )}
    </section>
  );
}

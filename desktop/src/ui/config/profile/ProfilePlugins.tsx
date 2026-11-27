/**
 * What a profile always has, as one list.
 *
 * **A profile is a closed set.** This list is exactly what an agent started
 * from it loads — never unioned with whoever starts it. It replaces three
 * additive sources governed by two switches, and the reason is not tidiness:
 * the other two belonged to the *starter*, so two people beginning the same
 * profile got two different agents.
 *
 * **One screen, the same two nouns as everywhere else.** This one used to
 * speak four: a *connector* pill beside a *bundle* in the prose under a button
 * offering a *plugin* or a *skill*. There are two things in Firetower and a
 * person has to learn both once — a skill, and an MCP server.
 *
 * **And it is the library's row, not its own.** It drew a two-letter monogram
 * where the library draws the vendor's mark, and `1 connector` where the
 * library draws what the thing does. Both were already on the data.
 */
import { useMemo, useState } from "react";
import { Check, Link2, Plus, Search, X } from "lucide-react";
import { IconButton } from "~/components/ui";
import { useSkills } from "~/data";
import { Mark } from "~/ui/config/Library";
import { useListLibrary } from "~/api/generated/library/library";
import type { Skill } from "~/api/generated/model";

export function ProfilePlugins({
  scope,
  onChange,
}: {
  scope: string[];
  onChange: (next: string[]) => void;
}) {
  const library = useSkills().data;
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");

  /* **Asked once, for every row.** Whether *you* hold a credential is a fact
     the library already answers per person; this used to ask the connector
     endpoint through four fixed hook slots, so a profile's fifth server was
     silently left out of its own count. */
  const mine = useListLibrary({ query: { select: (r) => r ?? [] } }).data ?? [];
  const connected = useMemo(() => {
    const by = new Map<string, boolean>();
    for (const i of mine) {
      if (i.kind === "server") by.set(i.skillId, i.connected === true);
    }
    return by;
  }, [mine]);

  const chosen = useMemo(
    () => scope.map((id) => library.find((s) => s.id === id)).filter((s): s is Skill => !!s),
    [scope, library],
  );
  const servers = chosen.filter((s) => s.hasConnector);
  const held = servers.filter((s) => connected.get(s.id)).length;

  const said = (s: Skill) => s.displayName || s.name;
  const offer = useMemo(() => {
    const term = query.trim().toLowerCase();
    return library
      .filter((s) => !scope.includes(s.id))
      .filter(
        (s) =>
          !term ||
          `${s.displayName ?? ""} ${s.name} ${s.description}`.toLowerCase().includes(term),
      )
      .slice(0, 40);
  }, [library, scope, query]);

  return (
    <section className="mt-7">
      <h3 className="text-ui text-bone">What it always has</h3>
      <p className="mt-1 max-w-[70ch] text-meta text-dim">
        Exactly this, whoever starts it — an ad-hoc session opens with whatever you have,
        a profile decides for itself.
      </p>

      <div className="mt-3">
        {chosen.map((s) => (
          <div key={s.id} className="r">
            <span className="g">
              <Mark logo={s.logo} name={said(s)} />
            </span>
            <span className="tx">
              <b>{said(s)}</b>
              <s>{s.description || "no description of its own"}</s>
            </span>
            {/* **The per-person fact, where the noun used to be.** A pill
                reading "connector" said what the row already showed. Whether
                you have authorized it is the one thing this screen knows that
                the profile itself does not. */}
            {s.hasConnector &&
              (connected.get(s.id) ? (
                <span className="act-said act-done">
                  <Check className="h-3.5 w-3.5" strokeWidth={2} />
                  Connected
                </span>
              ) : (
                <span className="act-said" title="You have not authorized this one yet.">
                  <Link2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  Not connected
                </span>
              ))}
            <IconButton
              of={X}
              label={`Take ${said(s)} off this profile`}
              className="hov"
              onClick={() => onChange(scope.filter((id) => id !== s.id))}
            />
          </div>
        ))}

        {chosen.length === 0 && !adding && (
          <p className="py-3 text-ui text-dim">
            Nothing yet, so an agent started from this profile reads only what the checkout
            commits.
          </p>
        )}

        {/* **The search is a row of this list, not a panel inside it.** It was
            a grey box with its own row style and a bare "Done", which read as
            a different screen that had opened on top of this one. */}
        {adding ? (
          <>
            <label className="srch mt-2 w-full">
              <Search className="h-4 w-4 text-mute" strokeWidth={1.5} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your skills and MCP servers"
                aria-label="Search your skills and MCP servers"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setAdding(false);
                    setQuery("");
                  }
                }}
              />
            </label>
            <div className="mt-1 max-h-72 overflow-y-auto">
              {offer.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="r w-full"
                  onClick={() => {
                    onChange([...scope, s.id]);
                    setQuery("");
                  }}
                >
                  <span className="g">
                    <Mark logo={s.logo} name={said(s)} />
                  </span>
                  <span className="tx">
                    <b>{said(s)}</b>
                    <s>{s.description || "no description of its own"}</s>
                  </span>
                  <Plus className="h-4 w-4 shrink-0 text-mute" strokeWidth={1.75} />
                </button>
              ))}
              {offer.length === 0 && (
                <p className="py-2 text-ui text-dim">
                  {query ? "Nothing left that matches." : "Everything you have is already on it."}
                </p>
              )}
            </div>
            <button
              type="button"
              className="out mt-2"
              onClick={() => {
                setAdding(false);
                setQuery("");
              }}
            >
              Done
            </button>
          </>
        ) : (
          <button type="button" className="out mt-2" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" strokeWidth={1.5} />
            Add
          </button>
        )}
      </div>

      {servers.length > 0 && (
        <p className="mt-4 max-w-[70ch] text-meta text-dim">
          <b className="font-mid text-bone">
            You have connected {held} of this profile&rsquo;s {servers.length}{" "}
            {servers.length === 1 ? "MCP server" : "MCP servers"}.
          </b>{" "}
          A server travels with the profile; your authorization never does. A colleague sees
          their own count here.
        </p>
      )}
    </section>
  );
}

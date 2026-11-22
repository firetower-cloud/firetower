/**
 * The plugin library.
 *
 * A plugin is a folder carrying any of skills, connectors, commands,
 * subagents and hooks. It is **Placed** like every other kind, so nothing
 * here reimplements filing or sharing.
 *
 * **Two shapes, because they answer different questions.** *Yours* is a list:
 * every row carries a state and the one control that is blocking, and both
 * want the width. The marketplace below is a shelf — two to a line, because
 * one plugin across a thousand pixels is a row pretending to be something you
 * can browse. Neither draws a box: a cell fills on hover and its control
 * lifts, which is how this design expresses elevation.
 *
 * **The word "plugin" is not on a row.** A row says what the thing *is* —
 * `GitHub · 1 connector and 1 skill` — because people search for GitHub, not
 * for a plugin. The noun earns its place in the page title and the Add menu
 * and nowhere else.
 *
 * **"Always on" is a default, not a guarantee.** It is the value the picker
 * opens with when a session starts, and anybody may untick a row before they
 * send. It is `skill_defaults` with no repository against it — the same row
 * the skills library has always written, because it is the same question.
 */
import { useMemo, useState } from "react";
import { Check, Link2, Plus, Puzzle, Search, Square, Terminal } from "lucide-react";
import { Blank, Note, Row, Section } from "~/ui/config/bits";
import { useSkills, why } from "~/data";
import { setDefault, getListSkillsQueryKey } from "~/api/generated/skills/skills";
import {
  connect,
  disconnect,
  useConnectorState,
  getConnectorStateQueryKey,
} from "~/api/generated/connectors/connectors";
import { useQueryClient } from "@tanstack/react-query";
import { openExternal } from "~/open";
import type { Skill } from "~/api/generated/model";

/**
 * What is inside a bundle, as a phrase rather than a meta string.
 *
 * `STYLE.md` bans joining facts with middle dots, and it is right to: "1
 * connector · 2 skills" is three objects pretending to be one. A sentence
 * fragment reads at a glance and survives being read aloud.
 */
export function contents(p: Skill): string {
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

function Mark({ of }: { of: Skill }) {
  return <span className="plg">{mono(of.name)}</span>;
}

export function Plugins() {
  const feed = useSkills();
  const cache = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const refresh = () => cache.invalidateQueries({ queryKey: getListSkillsQueryKey() });

  const toggle = async (p: Skill) => {
    setBusy(p.id);
    setTrouble(null);
    try {
      await setDefault(p.id, { on: !p.alwaysOn, repoId: null });
      await refresh();
    } catch (e) {
      setTrouble(why(e));
    } finally {
      setBusy(null);
    }
  };

  const all = useMemo(() => {
    const term = query.trim().toLowerCase();
    return feed.data
      .filter((s) => s.kind === "plugin")
      .filter(
        (s) =>
          !term ||
          s.name.toLowerCase().includes(term) ||
          s.description.toLowerCase().includes(term),
      );
  }, [feed.data, query]);

  const yours = all.filter((p) => p.alwaysOn);
  const shelf = all.filter((p) => !p.alwaysOn);

  return (
    <Section
      title="Plugins"
      note="What an agent can do past the model — the tools it can call, and the instructions for using them well. Everything here reaches whichever engine a session runs on."
      controls={
        <label className="srch">
          <Search className="h-4 w-4 text-mute" strokeWidth={1.5} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins"
            aria-label="Search plugins"
          />
        </label>
      }
      error={feed.error}
      settling={feed.loading}
    >
      {trouble && (
        <Note icon={Puzzle}>{trouble}</Note>
      )}

      {yours.length > 0 && (
        <>
          <h3 className="mt-6 text-ui text-dim">Yours</h3>
          <p className="mt-1 max-w-[74ch] text-meta text-dim">
            What your own sessions open with. A list rather than a shelf — each row is
            carrying a state and one control, and both want the width.
          </p>
          <div className="mt-2">
            {yours.map((p) => (
              <Row
                key={p.id}
                glyph={<Mark of={p} />}
                name={p.name}
                sub={p.description}
              >
                <span className="chip3">{contents(p)}</span>
                {p.hasConnector && <Connected of={p} />}
                <button
                  type="button"
                  className="on"
                  disabled={busy === p.id}
                  onClick={() => toggle(p)}
                >
                  <Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} />
                  Always on
                </button>
              </Row>
            ))}
          </div>
        </>
      )}

      {shelf.length > 0 && (
        <>
          <h3 className="mt-7 text-ui text-dim">From the Firetower marketplace</h3>
          <div className="pgrid">
            {shelf.map((p) => (
              <div key={p.id} className="pcard">
                <span className="top">
                  <Mark of={p} />
                  <span className="nm">
                    <b>{p.name}</b>
                  </span>
                </span>
                <span className="desc">{p.description}</span>
                <span className="foot">
                  <span className="chip3">{contents(p)}</span>
                  <button
                    type="button"
                    className="add"
                    disabled={busy === p.id}
                    onClick={() => toggle(p)}
                  >
                    <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                    Always on
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {all.length === 0 && !feed.loading && (
        <Blank
          icon={Puzzle}
          title={query ? "Nothing matches that" : "No plugins here yet"}
        >
          {query
            ? "Clear the search to see the whole library."
            : "Firetower ships a few. If this is empty the control plane has not seeded them — restart it and look again."}
        </Blank>
      )}
    </Section>
  );
}

/**
 * Whether **you** are connected, which is not a property of the plugin.
 *
 * A connector travels with a plugin through a directory or a profile; the
 * authorization never does. So this is read per person, and a colleague sees a
 * different answer on the same row.
 *
 * Three shapes, and each is the honest one for what the server said:
 *
 * - **`borrow-git`** needs no browser at all. Its token is the one Firetower
 *   already holds for that git host, so the row either says you are connected
 *   or sends you to the screen where that host is.
 * - **`oauth`** opens your browser. Firetower registers itself with the
 *   server, which is why there is no application for anybody to create.
 * - Already connected: a quiet statement, with disconnecting on the same
 *   control rather than hidden behind a menu.
 */
function Connected({ of }: { of: Skill }) {
  const q = useConnectorState(of.id);
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const state = q.data;
  const refresh = () =>
    cache.invalidateQueries({ queryKey: getConnectorStateQueryKey(of.id) });

  if (!state) return null;

  if (state.connected) {
    return (
      <button
        type="button"
        className="on"
        title={`Connected to ${state.server}. Disconnecting takes out your credential and leaves everybody else's.`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await disconnect(of.id);
            await refresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        <Link2 className="h-3.5 w-3.5 text-sage" strokeWidth={1.75} />
        Connected
      </button>
    );
  }

  /* Not connectable from here, and the sentence says where it is instead. A
     connector waiting on a git host nobody has authorized is not broken. */
  if (state.blocked) {
    return (
      <span className="chip3" title={state.blocked}>
        needs a git host
      </span>
    );
  }

  return (
    <button
      type="button"
      className="on"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const opened = await connect(of.id);
          /* The person's own browser, as them. Nothing is stored until it
             comes back to the callback. */
          await openExternal(opened.authorizeUrl);
        } catch (e) {
          /* The server's own sentence, which says more than ours would. */
          window.alert(why(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Link2 className="h-3.5 w-3.5" strokeWidth={1.75} />
      {busy ? "Opening…" : "Connect"}
    </button>
  );
}

/** A badge for a bundle that runs somebody else's code on your worker. */
export function Risky({ says }: { says: string }) {
  return (
    <span className="badge-warn">
      <Terminal className="h-3.5 w-3.5" strokeWidth={1.5} />
      {says}
    </span>
  );
}

/** The off state, in the same box as the on state so the column cannot move. */
export function Off() {
  return (
    <span className="on off">
      <Square className="h-3.5 w-3.5" strokeWidth={1.5} />
      Off
    </span>
  );
}

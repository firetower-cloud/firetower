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
import { useMemo, useRef, useState } from "react";
import { Check, FolderDown, Link2, Loader2, Plus, Puzzle, Search, Square, Terminal } from "lucide-react";
import { Blank, Dropping, Note, Row, Section } from "~/ui/config/bits";
import { useSkills, why } from "~/data";
import { setDefault, getListSkillsQueryKey } from "~/api/generated/skills/skills";
import {
  connect,
  disconnect,
  useConnectorState,
  getConnectorStateQueryKey,
} from "~/api/generated/connectors/connectors";
import { addFromUrl, probeUrl } from "~/api/generated/connectors/connectors";
import { useQueryClient } from "@tanstack/react-query";
import { AddSkill } from "~/ui/AddSkill";
import { readDrop } from "~/skills";
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
  const [adding, setAdding] = useState(false);
  const [pasting, setPasting] = useState(false);
  /* A folder dropped on the list goes straight into the review, so the way in
     the page describes is the way in that works. The entries are only readable
     while the event is being handled, so the read starts here. */
  const seed = useRef<ReturnType<typeof readDrop> | null>(null);
  const [over, setOver] = useState(false);
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

  if (adding)
    return (
      <AddSkill
        seed={seed.current}
        onClose={() => setAdding(false)}
        onDone={() => {
          setAdding(false);
          seed.current = null;
          refresh();
        }}
      />
    );

  /* The whole pane is the drop surface, so the way in that the page describes
     is the way in that works — rather than a target somebody has to find. */
  const surface = {
    onDragOver: (e: React.DragEvent) => {
      if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      seed.current = readDrop(e.dataTransfer);
      setAdding(true);
    },
  };

  return (
    <div {...surface} className="relative">
      {over && (
        <Dropping says="A plugin, a folder of them, or a .zip of either. The source says which is which, and nothing is written until you have looked at what was found." />
      )}
    <Section
      title="Plugins"
      note="What an agent can do past the model — the tools it can call, and the instructions for using them well. Everything here reaches whichever engine a session runs on."
      action={
        <div className="flex items-center gap-2">
          <button type="button" className="out" onClick={() => setPasting((p) => !p)}>
            <Link2 className="h-4 w-4" strokeWidth={1.5} />
            Paste an address
          </button>
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            Add a plugin
          </button>
        </div>
      }
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
      {trouble && <Note icon={Puzzle}>{trouble}</Note>}

      {pasting && (
        <PasteAddress
          onClose={() => setPasting(false)}
          onDone={() => {
            setPasting(false);
            void refresh();
          }}
        />
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
    </div>
  );
}

/**
 * An address, turned into a plugin.
 *
 * **A bare MCP URL is an entry path, not a concept.** Firetower asks the
 * server what it is and how it wants to be authorized, writes the manifest
 * itself, and lands a one-connector plugin in the library. Nobody is ever
 * asked to author a wrapper, and the word does not appear.
 */
function PasteAddress({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [found, setFound] = useState<Awaited<ReturnType<typeof probeUrl>> | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<string | null>(null);

  const look = async () => {
    setBusy(true);
    setBad(null);
    setFound(null);
    try {
      const got = await probeUrl({ url: url.trim() });
      setFound(got);
      setName(got.name);
    } catch (e) {
      setBad(why(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl bg-raise p-4">
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 shrink-0 text-dim" strokeWidth={1.5} />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && url.trim() && void look()}
          placeholder="https://mcp.linear.app/mcp"
          aria-label="The MCP server's address"
          className="min-w-0 flex-1 bg-transparent font-mono text-code text-bone outline-none placeholder:text-mute"
        />
        <button
          type="button"
          className="btn plain"
          disabled={busy || !url.trim()}
          onClick={() => void look()}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} /> : null}
          {busy ? "Asking…" : "Look"}
        </button>
        <button type="button" className="btn quiet" onClick={onClose}>
          Cancel
        </button>
      </div>

      {bad && <p className="mt-3 text-ui text-brick">{bad}</p>}

      {found && (
        <div className="mt-3 border-t border-line-soft pt-3">
          <dl className="grid grid-cols-[9rem_1fr] gap-y-1.5 text-ui">
            <dt className="text-dim">It reaches</dt>
            <dd className="font-mono text-code text-bone">{found.host}</dd>
            <dt className="text-dim">Authorization</dt>
            <dd className="text-text">
              {found.auth === "oauth"
                ? "OAuth, with dynamic registration — no application for anybody to create"
                : "None it told us about, so it works as soon as it is on"}
            </dd>
            {found.scopes && (
              <>
                <dt className="text-dim">It asks for</dt>
                <dd className="text-text">{found.scopes}</dd>
              </>
            )}
            <dt className="text-dim">Name</dt>
            <dd>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="What to call it"
                className="w-full bg-transparent text-ui text-bone outline-none"
              />
            </dd>
          </dl>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !name.trim()}
              onClick={async () => {
                setBusy(true);
                setBad(null);
                try {
                  await addFromUrl({ url: url.trim(), name: name.trim() });
                  onDone();
                } catch (e) {
                  setBad(why(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Add it
            </button>
            <span className="text-meta text-dim">
              It lands in the library as a one-connector plugin. You connect it after.
            </span>
          </div>
        </div>
      )}
    </div>
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

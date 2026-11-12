/**
 * The connector library.
 *
 * A connector is **an address plus the credential that opens it**, presented as
 * one thing you turn on. This screen is `config/Skills.tsx` with a different
 * noun, deliberately: the same `.pcol` page, the same `.sksec` sections, the
 * same `.sk` rows, the same search box. A second vocabulary for a list of
 * things you turn on for a session would be two screens to learn.
 *
 * **Everything about the server is reported, never configured.** What it can
 * do, what it will ask for, which tools write, what version it speaks — those
 * are facts about somebody else's server, and a control beside a fact invites
 * you to change what you have no say over. The two things that *are* yours are
 * the name and the one-line description, because the description is in the
 * model's context on every turn and an imported one mis-fires constantly.
 *
 * **Three states for what a server will tell you before you sign in**, and the
 * detail view draws whichever it is in. Google Drive answers `tools/list` to a
 * stranger, so its tools are listed before connecting. Slack and Canva refuse
 * and still publish what they will ask for, so their permissions are listed
 * instead — the better state of the two, since permissions are what you are
 * actually deciding about. Some publish neither, and the page says so plainly
 * rather than drawing an empty list.
 *
 * **No sharing.** A connector is yours in this build. Lending a definition and
 * lending a credential are different decisions and only the first one is a
 * screen; until that screen exists there is no filing here.
 */
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  Eye,
  ExternalLink,
  Loader2,
  PencilLine,
  Plug,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Blank, Facts, Group, Note, Section, Typed, WhereTo } from "~/ui/config/bits";
import { Icon } from "~/components/ui";
import { useConfirm } from "~/ui/Confirm";
import { useConnectorDetail, useConnectors, useConnectorScopeList, why } from "~/data";
import { elapsed, minutesSince } from "~/api/view";
import { openExternal } from "~/open";
import { useOpened } from "~/ui/opened";
import {
  authorizeConnector,
  createConnector,
  deleteConnector,
  describeConnector,
  getConnectorDetailQueryKey,
  getListConnectorsQueryKey,
  probeConnector,
  setConnectorToken,
  signOutOfConnector,
} from "~/api/generated/connectors/connectors";
import type { Connector, Opening, ToolRow } from "~/api/generated/model";

export function Connectors({ open: asked = null }: { open?: string | null }) {
  const [open, setOpen] = useOpened(asked);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const feed = useConnectors();
  const cache = useQueryClient();
  const refresh = () => cache.invalidateQueries({ queryKey: getListConnectorsQueryKey() });

  const chosen = feed.data.find((c) => c.id === open);
  if (chosen) return <Detail connector={chosen} onBack={() => setOpen(null)} onChanged={refresh} />;

  const q = query.trim().toLowerCase();
  const shown = q
    ? feed.data.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.url.toLowerCase().includes(q),
      )
    : feed.data;

  /* The page's one primary action, written once: the head wears it when there
     is a list, and the blank wears it when there is not. */
  const add = (
    <button onClick={() => setAdding(true)} className="btn primary">
      <Icon of={Plus} size={14} />
      Add a connector
    </button>
  );

  const live = feed.data.filter((c) => c.onIn > 0).length;

  return (
    <Section
      title="Connectors"
      note="What your agents can reach while they are running: Slack, Google Drive, a server of your own. Each one runs at its provider — nothing is installed on your machines."
      action={feed.data.length > 0 ? add : undefined}
      trouble={feed.trouble}
      error={feed.error}
      onRetry={refresh}
      settling={feed.loading}
      controls={
        feed.data.length > 0 ? (
          <>
            <label className="find">
              <Icon of={Search} size={14} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or address"
                spellCheck={false}
                aria-label="Search connectors"
                className="placeholder:text-mute focus:outline-none"
              />
            </label>
            {live > 0 && (
              <span className="right text-ui text-mute">
                on in {live} {live === 1 ? "connector" : "connectors"} right now
              </span>
            )}
          </>
        ) : undefined
      }
    >
      {adding && <AddByUrl onClose={() => setAdding(false)} onDone={refresh} />}

      {feed.data.length === 0 ? (
        /* **The state a person actually meets on a fresh install**, and the one
           place the cost is stated: five ordinary connectors is a real slice of
           every turn before anybody has said anything, and that is better said
           here than discovered later. */
        <Blank icon={Plug} title="Nothing is connected yet" action={add}>
          A connector lets your agents work in something outside Firetower. Add one by its address;
          everything it can do is read from the server rather than written here.
        </Blank>
      ) : q && shown.length === 0 ? (
        <div className="mt-4">
          <Note
            icon={Search}
            control={
              <button onClick={() => setQuery("")} className="btn quiet">
                Clear
              </button>
            }
          >
            No connector matches <Typed>{query.trim()}</Typed>.
          </Note>
        </div>
      ) : (
        <>
          <Group
            title="Yours"
            count={shown.length}
            note="Yours alone. Signing in to one is yours too — nobody uses anybody else's, including an administrator."
          >
            {shown.map((c) => (
              <Rowish key={c.id} connector={c} onOpen={() => setOpen(c.id)} />
            ))}
          </Group>

          <WhereTo>
            <b>Git hosts and Trackers are a different job.</b> Those are how Firetower reads your
            work and pushes your branches. A connector is what an agent can reach while it is
            running — the same products sometimes, doing different work.
          </WhereTo>
        </>
      )}
    </Section>
  );
}

/**
 * One connector, as a row.
 *
 * A plate, the name, what it is, and **what is true now** on the right rather
 * than what was ticked: signed in or not, how many tools, whether anything has
 * drifted. The `Connect` button is on the row because signing in is the one
 * thing a row can be missing, and making somebody open a page to find that out
 * is the thing Skills' own row avoids.
 */
function Rowish({ connector: c, onOpen }: { connector: Connector; onOpen: () => void }) {
  const probed = c.probed;
  const needs = c.signIn !== "None";
  return (
    <div className="relative">
      <button onClick={onOpen} className="sk w-full" title={c.name}>
        <span className="plate">
          <Icon of={Plug} size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="min-w-0 truncate text-ui font-medium text-bone">{c.name}</span>
            <span className="shrink-0 text-meta text-mute">{host(c.url)}</span>
            {c.expired && <span className="tag amber shrink-0">Sign-in expired</span>}
          </span>
          <span className="ds mt-1 text-ui leading-snug text-dim">
            {c.description || "No description. An agent decides whether to reach for this by reading one, so it is worth writing."}
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-meta text-mute">
            {probed?.shape === "tools" && (
              <span>
                {probed.toolCount} {probed.toolCount === 1 ? "tool" : "tools"}
                {probed.writeCount > 0 && `, ${probed.writeCount} of them write`}
              </span>
            )}
            {probed?.shape === "scopes" && <span>{probed.scopes.length} permissions</span>}
            {probed?.shape === "silent" && <span>lists nothing until you sign in</span>}
            {probed && <span>checked {elapsed(minutesSince(probed.at))}</span>}
            {c.onIn > 0 && <span>on in {c.onIn === 1 ? "1 session" : `${c.onIn} sessions`}</span>}
          </span>
          {/* Amber marks, the way a skill's risks are drawn — a line of small
              facts rather than a row of filled badges, because four badges
              read as four errors. */}
          {(probed?.drifted ?? 0) > 0 && (
            <span className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1">
              <span className="risk">
                <i />
                {probed!.drifted} {probed!.drifted === 1 ? "tool has" : "tools have"} changed
                definition
              </span>
            </span>
          )}
          {probed?.unmet.length ? (
            <span className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1">
              <span className="risk">
                <i />
                needs {probed.unmet.join(", ")}, which no agent here offers
              </span>
            </span>
          ) : null}
          {probed?.versionTrouble && (
            <span className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1">
              <span className="risk">
                <i />
                its MCP version is one no agent here speaks
              </span>
            </span>
          )}
          {probed?.trouble && (
            <span className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1">
              <span className="risk">
                <i />
                did not answer the last check
              </span>
            </span>
          )}
        </span>
        <span className="mt-2 flex shrink-0 items-center gap-2.5">
          {needs &&
            (c.connected ? (
              <span className="flex items-center gap-1.5 text-meta text-mute">
                <span className="st" data-s={c.expired ? "warn" : "ok"} />
                {c.expired ? "expired" : "signed in"}
              </span>
            ) : (
              /* Counted at zero and not sent to a session until this is done —
                 criterion 17, said on the row rather than discovered in a
                 transcript. */
              <span className="chip3">not signed in</span>
            ))}
        </span>
      </button>
    </div>
  );
}

/* ── Adding one, by address ─────────────────────────────────────────────── */

/**
 * **Two fields: a name and an address.** No command field — v1 is remote only,
 * so nothing a connector brings runs on a machine, and a field that implied
 * otherwise would be the wrong promise.
 *
 * Nothing is added until the server answers. That is the whole of the failure
 * story: the address is checked here, the control plane asks the server what it
 * is, and a URL that is not an MCP server comes back as a sentence naming what
 * went wrong rather than as a half-made row to clean up.
 */
function AddByUrl({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [asking, setAsking] = useState(false);
  const [bad, setBad] = useState<string | null>(null);

  const submit = async () => {
    setAsking(true);
    setBad(null);
    try {
      await createConnector({ name: name.trim(), url: url.trim(), description: description.trim() });
      onDone();
      onClose();
    } catch (e) {
      setBad(why(e));
    } finally {
      setAsking(false);
    }
  };

  const ready = name.trim().length > 0 && url.trim().length > 0 && !asking;

  return (
    <div className="veil" onMouseDown={onClose}>
      <div className="sheet2" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sh-head">
          <h2>Add a connector</h2>
        </div>
        <p className="sh-note">
          A remote MCP server, at its address. Firetower speaks to it from this machine, so this
          machine has to be able to reach it — a worker being able to is not enough.
        </p>
        <div className="sh-body">
          <div className="sh-lab">Name</div>
          <div className="sh-field">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Google Drive"
              aria-label="Name"
            />
          </div>

          <div className="sh-lab">MCP server URL</div>
          <div className="sh-field">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ready && void submit()}
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
              aria-label="MCP server URL"
              className="font-mono text-meta"
            />
          </div>
          <p className="sh-note">
            The HTTPS address where the server accepts MCP requests. Don’t put a token in it —
            Firetower asks for the credential separately and keeps it in the vault.
          </p>

          <div className="sh-lab">What it is, in a sentence</div>
          <div className="sh-field">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Deploy status, feature flags and the on-call rota."
              aria-label="What it is"
            />
          </div>
          <p className="sh-note">
            This line is in the model’s context on every turn. It is what tells an agent when to
            reach for this rather than something else.
          </p>

          {bad && (
            <div className="sh-bad">
              <b>Nothing was added</b>
              {bad}
            </div>
          )}

          {/* The trust warning, and it has to be stronger than a curated
              catalogue's would be: nobody has checked this address. */}
          <div className="sh-bad" data-tone="amber">
            <b>Nobody has checked this address</b>
            Whoever runs this server can change what it does at any time. An agent using it sends it
            whatever the work needs: file contents, issue text, your messages. Add it only if you
            would give that person the same access yourself.
          </div>
        </div>
        <div className="sh-foot">
          <span className="where">
            Firetower asks the server what it can do before adding it. You are told if the answer
            changes.
          </span>
          <button onClick={onClose} className="btn quiet">
            Cancel
          </button>
          <button disabled={!ready} onClick={() => void submit()} className="btn primary">
            {asking ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                Asking it…
              </>
            ) : (
              "Add connector"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Signing in ─────────────────────────────────────────────────────────── */

/**
 * **The screen nobody ships and everybody wants.**
 *
 * What you are about to grant, in the server's own words, read from the server
 * a moment ago — not from a table in Firetower that somebody has to keep true.
 * Canva publishes sixteen scopes and Slack thirty, unauthenticated, to anybody
 * who asks; so this list cannot be out of date, and the sentence at the bottom
 * says so because that is the part worth believing.
 *
 * Two steps: read it, then the browser. The browser does not open until the
 * second press.
 */
function ScopesThenBrowser({
  connector,
  onClose,
  onDone,
}: {
  connector: Connector;
  onClose: () => void;
  onDone: () => void;
}) {
  const live = useConnectorScopeList(connector.id, true);
  const [leaving, setLeaving] = useState(false);
  const [waiting, setWaiting] = useState<Opening | null>(null);
  const [bad, setBad] = useState<string | null>(null);

  /* Poll until this person's grant lands. The attempt expires on its own and
     the control plane drops the row, so the wait ends whether or not anybody
     cancels — the same shape `config/connect.tsx` uses for a device code. */
  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const tick = async () => {
      for (let asked = 0; asked < 450 && !stop; asked++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const { listConnectors } = await import("~/api/generated/connectors/connectors");
          const all = await listConnectors();
          if (all.find((c) => c.id === connector.id)?.connected) {
            onDone();
            onClose();
            return;
          }
        } catch {
          /* A blip while somebody is in a browser is not a reason to give up
             on a flow they may be halfway through. */
        }
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [waiting, connector.id, onClose, onDone]);

  const go = async () => {
    setLeaving(true);
    setBad(null);
    try {
      const opening = await authorizeConnector(connector.id);
      if (!opening.authorize) {
        setBad(opening.trouble ?? "This server does not offer a browser sign-in.");
        return;
      }
      void openExternal(opening.authorize);
      setWaiting(opening);
    } catch (e) {
      setBad(why(e));
    } finally {
      setLeaving(false);
    }
  };

  if (waiting) {
    return (
      <div className="veil" onMouseDown={onClose}>
        <div className="sheet2" onMouseDown={(e) => e.stopPropagation()}>
          <div className="sh-head">
            <h2>Connect {connector.name}</h2>
          </div>
          <div className="sh-steps">
            <i data-on="true" />
            <i data-on="true" />
          </div>
          <div className="sh-body pb-4">
            <div className="flex flex-col items-center gap-3 px-4 pt-7 pb-2 text-center">
              <Loader2 className="h-5 w-5 animate-spin text-dim" strokeWidth={2} />
              <div className="text-lede font-mid text-bone">Waiting for you to approve it</div>
              <p className="max-w-[40ch] text-ui leading-relaxed text-dim">
                Your browser opened {waiting.at}. Approve it there and this closes by itself.
              </p>
            </div>
            <p className="sh-note text-center">
              Browser did not open?{" "}
              <button
                onClick={() => waiting.authorize && void openExternal(waiting.authorize)}
                className="text-bone underline decoration-line underline-offset-2"
              >
                Copy the link
              </button>
            </p>
          </div>
          <div className="sh-foot">
            <span className="where">The sign-in expires on its own.</span>
            <button onClick={onClose} className="btn quiet">
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  const scopes = live.data?.scopes ?? [];
  const trouble = live.data?.trouble ?? null;

  return (
    <div className="veil" onMouseDown={onClose}>
      <div className="sheet2" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sh-head">
          <h2>Connect {connector.name}</h2>
        </div>
        <div className="sh-steps">
          <i data-on="true" />
          <i />
        </div>
        <p className="sh-note">
          You will approve this in your browser. Read it here first — the provider’s own screen
          names an application, not what it can do. <b>This list came from {live.data?.at ?? "the server"} a
          moment ago</b>, not from a table in Firetower, so it cannot be out of date.
        </p>
        <div className="sh-body">
          {live.loading ? (
            <div className="flex items-center gap-3 px-4 py-6">
              <Loader2 className="h-4 w-4 animate-spin text-dim" strokeWidth={2} />
              <span className="text-ui text-dim">Asking it what it will want…</span>
            </div>
          ) : scopes.length > 0 ? (
            <>
              <div className="sh-lab">{connector.name} will be asked to let Firetower</div>
              {scopes.map((s) => (
                <div key={s} className="sh-row">
                  <span className="grid place-items-center text-slate">
                    <Icon of={Check} size={14} />
                  </span>
                  <span className="tx">
                    <b className="font-normal">{s}</b>
                  </span>
                </div>
              ))}
              <p className="sh-note pt-3">
                Read from {live.data?.at} when this opened. Nobody writes these into Firetower and
                nobody has to keep them true.
              </p>
            </>
          ) : (
            <div className="sh-bad" data-tone="amber">
              <b>It publishes no list of permissions</b>
              {trouble ??
                `${connector.name} will not say what it is going to ask for until you are on its own screen. Read that screen before you approve it.`}
            </div>
          )}
          {bad && (
            <div className="sh-bad">
              <b>That did not start</b>
              {bad}
            </div>
          )}
        </div>
        <div className="sh-foot">
          <span className="where">The sign-in is yours alone. Nobody else uses it.</span>
          <button onClick={onClose} className="btn quiet">
            Cancel
          </button>
          <button disabled={leaving} onClick={() => void go()} className="btn primary">
            <Icon of={ExternalLink} size={14} />
            {leaving ? "Opening…" : "Open browser"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A token somebody pastes, for a server that publishes no OAuth metadata.
 *
 * Inline rather than a sheet in the drawing, but this one is a sheet: it is
 * opened from a detail page rather than from a row, and where the credential is
 * kept is worth four lines that a row has no space for.
 */
function PasteToken({
  connector,
  onClose,
  onDone,
}: {
  connector: Connector;
  onClose: () => void;
  onDone: () => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setBad(null);
    try {
      await setConnectorToken(connector.id, { token: token.trim() });
      onDone();
      onClose();
    } catch (e) {
      setBad(why(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="veil" onMouseDown={onClose}>
      <div className="sheet2" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sh-head">
          <h2>Connect {connector.name}</h2>
        </div>
        <p className="sh-note">
          {host(connector.url)} does not offer a browser sign-in for this. Paste an access token.
        </p>
        <div className="sh-body">
          <div className="sh-lab">Access token</div>
          <div className="sh-field">
            <input
              autoFocus
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && token.trim() && !busy && void submit()}
              placeholder="Paste the token"
              spellCheck={false}
              aria-label="Access token"
              className="font-mono text-meta"
            />
          </div>
          {bad && (
            <div className="sh-bad">
              <b>It would not accept that</b>
              {bad}
            </div>
          )}
          <div className="sh-lab">Where it is kept</div>
          <p className="sh-note">
            Encrypted in this Firetower’s vault under your name, at{" "}
            <span className="font-mono text-meta">connector/{connector.slug}</span>. Every read is a
            line in the vault’s log. <b>No route returns it, including to you.</b>
          </p>
        </div>
        <div className="sh-foot">
          <span className="where">Checked against the server before it is stored.</span>
          <button onClick={onClose} className="btn quiet">
            Cancel
          </button>
          <button disabled={!token.trim() || busy} onClick={() => void submit()} className="btn primary">
            {busy ? "Checking…" : `Connect ${connector.name}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── One connector, opened ──────────────────────────────────────────────── */

/**
 * The detail view, in whichever of the three states the server put it in.
 *
 * `tools` — it listed them to a stranger, so they are here before you sign in.
 * `scopes` — it refused and still published what it will ask for, so those are
 * here instead; it is the better of the two, because permissions are what you
 * are deciding about. `silent` — neither, and the page says you are signing in
 * before you know what it can do, which is the fact that matters.
 */
function Detail({
  connector: c,
  onBack,
  onChanged,
}: {
  connector: Connector;
  onBack: () => void;
  onChanged: () => void;
}) {
  const detail = useConnectorDetail(c.id);
  const cache = useQueryClient();
  const confirm = useConfirm();
  const [signingIn, setSigningIn] = useState<"browser" | "token" | null>(null);
  const [probing, setProbing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: c.name, description: c.description });

  const refresh = () => {
    onChanged();
    void cache.invalidateQueries({ queryKey: getConnectorDetailQueryKey(c.id) });
  };

  const probed = detail.data?.probed ?? c.probed;
  const tools = detail.data?.tools ?? [];
  const drift = detail.data?.drift ?? [];
  const shape = probed?.shape ?? "silent";

  const reprobe = async () => {
    setProbing(true);
    try {
      await probeConnector(c.id);
      refresh();
    } finally {
      setProbing(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Remove ${c.name}?`,
      body: "Your sign-in goes with it. Sessions using it lose it when their agent next starts. The vault keeps the record that it existed.",
      action: "Remove connector",
      tone: "danger",
    });
    if (!ok) return;
    await deleteConnector(c.id);
    onChanged();
    onBack();
  };

  const save = async () => {
    await describeConnector(c.id, { name: draft.name, description: draft.description });
    setEditing(false);
    refresh();
  };

  return (
    <div data-wide className="pcol">
      <button onClick={onBack} className="btn quiet mb-3.5 pl-1.5">
        <Icon of={ChevronLeft} size={14} />
        All connectors
      </button>

      <div className="phead2">
        <div className="min-w-0">
          <h1>{c.name}</h1>
          <p className="sub">
            {c.description ||
              "No description yet. An agent decides whether to reach for this by reading one."}
          </p>
        </div>
        <div className="acts">
          <button onClick={() => void reprobe()} disabled={probing} className="btn plain">
            <Icon of={probing ? Loader2 : RefreshCw} size={14} />
            {probing ? "Asking…" : "Check again"}
          </button>
          <button onClick={() => void remove()} className="btn plain text-brick">
            <Icon of={Trash2} size={14} />
            Remove
          </button>
        </div>
      </div>

      {signingIn === "browser" && (
        <ScopesThenBrowser connector={c} onClose={() => setSigningIn(null)} onDone={refresh} />
      )}
      {signingIn === "token" && (
        <PasteToken connector={c} onClose={() => setSigningIn(null)} onDone={refresh} />
      )}

      {/* **What this person's sign-in is, and nothing about anybody else's.**
          One sign-in each: nobody uses anybody else's, including an
          administrator, and there is no sharing in this build for either half
          of it to be lent through. */}
      <div className="cx-half mt-5">
        <h3>
          <span className="g">
            <Icon of={ArrowUpRight} size={16} />
          </span>
          Your agents can use it
        </h3>
        {c.signIn === "None" ? (
          <p>
            This server answers without a credential, so there is nothing to sign in to. Turn it on
            in a session and its tools are there.
          </p>
        ) : c.connected ? (
          <p>
            Signed in as you. {c.expired ? "That sign-in has expired — connect it again." : ""}{" "}
            Nobody else uses it, and no route returns it.
          </p>
        ) : (
          <p>
            You have not signed in to this one. It shows in a session’s picker, counts for nothing,
            and is not sent to the agent — a server with no credential would fail to authenticate
            and leave a line in the transcript nobody could explain.
          </p>
        )}
        <Facts
          of={[
            ["Address", c.url, true],
            ["An agent calls it", `mcp__${c.slug}`, true],
            ["Transport", probed?.transport === "sse" ? "HTTP+SSE (2024-11-05)" : "Streamable HTTP"],
            [
              "Signed in",
              c.signIn === "None"
                ? "Not needed"
                : c.connected
                  ? c.expired
                    ? "Expired"
                    : c.expiresAt
                      ? `Yes, until ${new Date(c.expiresAt).toLocaleString()}`
                      : "Yes"
                  : "No",
            ],
            ["On in", c.onIn === 0 ? "No sessions" : `${c.onIn} of your sessions`],
          ]}
        />
        <div className="foot">
          {c.signIn !== "None" &&
            (c.connected ? (
              <>
                <button
                  onClick={() =>
                    setSigningIn(c.signIn === "OAuth" ? "browser" : "token")
                  }
                  className="btn plain"
                >
                  {c.expired ? "Connect again" : "Replace the sign-in"}
                </button>
                <button
                  onClick={async () => {
                    await signOutOfConnector(c.id);
                    refresh();
                  }}
                  className="btn quiet"
                >
                  Sign out
                </button>
              </>
            ) : (
              <button
                onClick={() => setSigningIn(c.signIn === "OAuth" ? "browser" : "token")}
                className="btn primary"
              >
                Sign in to {c.name}
              </button>
            ))}
          {c.signIn === "Token" && c.connected && null}
        </div>
      </div>

      {/* Criterion 18d, as a display job: the failure is already loud — the
          agent reports the server as failed at connect — so what is owed here
          is saying which version each side wanted. */}
      {probed?.versionTrouble && (
        <div className="sh-bad mt-5" data-tone="amber">
          <b>Its MCP version is one no agent here speaks</b>
          {probed.versionTrouble}
        </div>
      )}

      {/* Criterion 18e. Where it can be told, it is said plainly — and the
          honest part is that the specification gives a server no way to
          announce this, so silence is not evidence. */}
      {probed?.unmet.length ? (
        <div className="sh-bad mt-5" data-tone="amber">
          <b>It says it needs something no agent here provides</b>
          This server declares <b>{probed.unmet.join(", ")}</b>. None of the agents Firetower runs
          offers that, so it will connect and then fail the first time it needs it. Nothing in
          Firetower can fix that — whoever runs the server has to.
        </div>
      ) : null}

      {probed?.trouble && (
        <div className="sh-bad mt-5">
          <b>It did not answer the last check</b>
          {probed.trouble}
        </div>
      )}

      {/* ── The three shapes ────────────────────────────────────────── */}

      {shape === "tools" && (
        <Group
          title="What it can do"
          count={tools.length}
          note={`Read from the server${probed ? ` ${elapsed(minutesSince(probed.at))}` : ""}, not from anything stored here. ${probed?.writeCount ?? 0} of these write, and a write is asked before it happens.`}
        >
          <div className="cx-tools">
            {tools.map((t) => (
              <ToolChip key={t.name} tool={t} />
            ))}
          </div>
        </Group>
      )}

      {shape === "scopes" && (
        <Group
          title="What you will be granting"
          count={probed?.scopes.length ?? 0}
          note={`${c.name} does not list its tools until you sign in. It does list what it will ask for, and it did so without any account of yours${probed?.authority ? ` — from ${probed.authority}` : ""}. Its tools appear here once you have connected.`}
        >
          <div className="cx-tools">
            {(probed?.scopes ?? []).map((s: string) => (
              <span key={s} className="cx-tool" data-w={writes(s) ? 1 : 0}>
                <span className="g">
                  <Icon of={writes(s) ? PencilLine : Eye} size={12} />
                </span>
                {s}
              </span>
            ))}
          </div>
        </Group>
      )}

      {shape === "silent" && (
        <Group title="What it can do">
          <div className="dt-unknown">
            <b>{c.name} lists what it can do once you sign in</b>
            <p>
              It will not describe itself to anyone who has not signed in, and it publishes no list
              of permissions either. Firetower asks the moment you connect, puts the answer here, and
              tells you if it changes afterwards.
            </p>
            <p className="quiet">
              You are signing in before you know what it can do. Most servers say more than this one.
            </p>
          </div>
        </Group>
      )}

      {/* Criterion 14, where a person can read it. A list of hashes would be
          worthless; what is useful is which tool and when. */}
      {drift.length > 0 && (
        <Group
          title="What has changed"
          count={drift.length}
          note="A hash over each tool’s whole definition — its name, its description and its schema — is kept from the first time the list was read. These are the times an answer stopped matching."
        >
          <div className="lrows">
            {drift.map((d, i) => (
              <div key={`${d.at}-${d.tool}-${i}`} className="r">
                <span className="g">
                  <Icon of={d.kind === "changed" ? TriangleAlert : ShieldAlert} size={16} />
                </span>
                <span className="tx">
                  <b>{d.tool}</b>
                  <s>
                    {d.kind === "changed"
                      ? "its definition changed"
                      : d.kind === "added"
                        ? "appeared"
                        : "is no longer offered"}
                  </s>
                </span>
                <span className="path">{elapsed(minutesSince(d.at))}</span>
              </div>
            ))}
          </div>
        </Group>
      )}

      {/* The facts nobody configures, as facts. */}
      <div className="cx-fsheet">
        <div className="row">
          <dt>Where it runs</dt>
          <dd>
            At {host(c.url)}. Nothing is installed on your machines, and nothing runs on a worker.
          </dd>
        </div>
        <div className="row">
          <dt>It speaks</dt>
          <dd>
            MCP {probed?.protocolVersion ?? "—"}
            {probed?.askedFor && probed.askedFor !== probed.protocolVersion
              ? ` · Firetower asked for ${probed.askedFor}`
              : ""}
            {probed?.serverName ? ` · ${probed.serverName} ${probed.serverVersion ?? ""}` : ""}
          </dd>
        </div>
        <div className="row">
          <dt>What it says it can do</dt>
          <dd className="font-mono text-meta">
            {probed ? Object.keys(probed.capabilities ?? {}).join(", ") || "nothing declared" : "—"}
            <span className="block text-ui text-mute">
              Recorded as the server said it, and not interpreted. Which agent can use which of
              these is a thing to measure, not a table to keep true.
            </span>
          </dd>
        </div>
        <div className="row">
          <dt>Last checked</dt>
          <dd>{probed ? elapsed(minutesSince(probed.at)) : "—"}</dd>
        </div>
        <div className="row">
          <dt>Changing the set a session has</dt>
          <dd>
            Takes effect when that session’s agent next starts. An agent reads its servers and its
            permission rules once, when it launches.
          </dd>
        </div>
      </div>

      {/* The two fields that are yours. Everything above is the server's. */}
      <Group title="What you call it" note="The only two things here that are yours rather than the server’s.">
        {editing ? (
          <div className="mt-2 flex flex-col gap-2">
            <div className="sh-field">
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                aria-label="Name"
              />
            </div>
            <div className="sh-field">
              <input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="What it is, in a sentence"
                aria-label="Description"
              />
            </div>
            <div className="flex gap-2">
              <button onClick={() => setEditing(false)} className="btn quiet">
                Cancel
              </button>
              <button onClick={() => void save()} className="btn primary">
                Save
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-2">
            <button onClick={() => setEditing(true)} className="btn plain">
              <Icon of={PencilLine} size={14} />
              Edit the name and description
            </button>
          </div>
        )}
      </Group>
    </div>
  );
}

/**
 * One tool, as a chip.
 *
 * Which tools **write** is the useful half of the list, so it is the thing the
 * glyph says. A tool the server did not annotate is drawn as writing: the other
 * default would call an unannotated tool safe on no evidence, and every tool
 * gets an approval rule either way.
 */
function ToolChip({ tool }: { tool: ToolRow }) {
  return (
    <span className="cx-tool" data-w={tool.writes ? 1 : 0} title={tool.description}>
      <span className="g">
        <Icon of={tool.writes ? PencilLine : Eye} size={12} />
      </span>
      {tool.name}
      {tool.writes && <span className="n">asks first</span>}
    </span>
  );
}

/**
 * Whether a scope's own name says it writes.
 *
 * **A guess, and the useful half of the list.** A scope carries no annotation
 * the way a tool does, so there is nothing to read — but `design:content:write`
 * and `chat:write` are not ambiguous, and every provider checked spells it the
 * same way. Wrong in the safe direction either way: this decides a glyph, and
 * what an agent is actually allowed to do is decided by the approval rule.
 */
function writes(scope: string): boolean {
  const lowered = scope.toLowerCase();
  return ["write", "create", "update", "delete", "manage", "admin", "post"].some((verb) =>
    lowered.includes(verb),
  );
}

/** `https://mcp.canva.com/mcp` as `mcp.canva.com`, for a line of prose. */
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/* **What the drawing has that this does not: "Not asked for".**
 *
 * The scopes sheet in the artifact lists the permissions Firetower is *not*
 * requesting beside the ones it is, which is the better screen. It needs a
 * curated entry to subtract from — the server publishes what it supports, not
 * what a client chose — and there is no catalogue in this build. Left out
 * rather than faked; it is in the hand-back as a deviation.
 */

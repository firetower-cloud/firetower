/**
 * The git hosts this Firetower can clone from and push to.
 *
 * **A host and a token are two different things, and this screen draws both.**
 * A git host is the installation's — its address, the application everybody
 * authorizes against, whether people connect it in a browser or by pasting a
 * token. A token is one person's: two people on one Firetower each hold their
 * own for the same host, because a commit has to be attributable to a person.
 * So Add, edit and remove are an administrator's, and Connect is anybody's, and
 * the server says which of those this caller may do rather than each client
 * working it out — `maySetApplication`.
 *
 * Two ways to connect, and which a host offers is a fact about that instance
 * rather than about the software. The browser flow is the device authorization
 * grant: ask for a code, open the page, then poll the providers list until the
 * pending authorization clears — a code lasts minutes and the control plane
 * drops it when it expires, so the wait ends on its own. A pasted token is the
 * other, and it is not a lesser one: Gitea has no device flow at any version
 * and GitLab only grew one in 17.9.
 *
 * The identity on commits (`get/set/clear_identity`) is a different fact from
 * the account that signed in, and is set here too.
 *
 * **This pane is the prerequisite, not the job.** Most people reach a host
 * through the Repositories screen, which connects one without coming here at
 * all; this is where hosts are added, renamed and removed. Trackers are their
 * own pane — see `Trackers`.
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Link2, Loader2, MoreHorizontal, Plus, X } from "lucide-react";
import { HostMark, Icon } from "~/components/ui";
import type { AuthMode, KindInfo, ProbedProvider, ProviderStatus } from "~/api/generated/model";
import {
  getListProvidersQueryKey,
  useClearIdentity,
  useCreateProvider,
  useDeleteProvider,
  useDisconnectProvider,
  useGetIdentity,
  useListKinds,
  useProbeProvider,
  useSetIdentity,
  useUpdateProvider,
} from "~/api/generated/providers/providers";
import { getListTrackersQueryKey } from "~/api/generated/trackers/trackers";
import { useProviders } from "~/data";
import { why } from "~/data";
import { openExternal } from "~/open";
import { bold, Rows, Section } from "~/ui/config/bits";
import { useConnect } from "~/ui/config/connect";
import { Pop } from "~/ui/Pop";
import { useConfirm } from "~/ui/Confirm";

export function GitHosts({ live }: { live: boolean }) {
  const providers = useProviders();
  const [adding, setAdding] = useState(false);
  /* Drawn off any row, because the rule is the installation's rather than any
     one host's — and with no host yet there would be no row to read it from. */
  const mayAdd = providers.data.some((p) => p.maySetApplication);

  /**
   * Connected hosts first.
   *
   * The server's order is the install's — built-in first, then whatever was
   * added — and that order is load-bearing on the wire, because a client that
   * predates this table reads the first entry. It is not load-bearing *here*:
   * the question this screen answers is "what am I signed in to", and the rows
   * that answer it were sorted below the ones that do not.
   *
   * Sorted for the drawing only, and stably, so two connected hosts keep the
   * install's order between them.
   */
  const rows = useMemo(
    () => [...providers.data].sort((a, b) => Number(b.connected) - Number(a.connected)),
    [providers.data],
  );

  /**
   * The host somebody just added, which should ask to be connected.
   *
   * Adding one and being returned to a list where it sits unconnected, looking
   * like the two above it that were never touched, is a dead stop in the
   * middle of a job — the reason to add a host is to use it. The row starts
   * its own flow once, and only for the host that was named.
   */
  const [fresh, setFresh] = useState<string | null>(null);

  return (
    <>
      <Section
        title="Git hosts"
        note="Signed in as you, because a commit has to be attributable to a person. Everybody here connects their own."
        action={
          live && mayAdd ? (
            <button onClick={() => setAdding(true)} className="control border border-line bg-raise text-ui text-bone hover:bg-overlay">
              <Icon of={Plus} size={12} />Add a host
            </button>
          ) : null
        }
      >
        <Rows feed={providers} empty="Nothing to connect to on this server.">
          {rows.map((p) => (
            <Provider
              key={p.id}
              p={p}
              live={live}
              connectNow={p.id === fresh}
              onConnected={() => setFresh(null)}
            />
          ))}
        </Rows>
      </Section>
      {adding && <AddHost onClose={() => setAdding(false)} onAdded={setFresh} />}
    </>
  );
}

/* ── One host ──────────────────────────────────────────────────────────── */

/**
 * What one row offers this caller, as a decision rather than as markup.
 *
 * Pulled out so the rule can be tested without a DOM: these tests render to a
 * static string, which cannot open a menu — and asserting on the markup of a
 * button tied the rule to where the button happened to sit. This says what may
 * be done; the row below decides where it goes.
 */
export type RowActions = {
  /** The one button on the row. */
  primary: "identity" | "connect" | "set-up" | "refused";
  /** Behind the ⋯, in order. */
  menu: ("settings" | "sign-out" | "remove")[];
};

export function actionsFor(p: ProviderStatus): RowActions {
  const menu: RowActions["menu"] = [];
  // The installation's settings — address aside — are an administrator's.
  if (p.maySetApplication) menu.push("settings");
  // Yours, so it is offered whenever you have one, whoever you are.
  if (p.connected) menu.push("sign-out");
  // The built-in host is not removable and the server refuses it, so it is
  // not drawn rather than drawn and refused.
  if (p.maySetApplication && !p.builtin) menu.push("remove");

  const primary: RowActions["primary"] = p.connected
    ? "identity"
    : p.configured
      ? "connect"
      : p.maySetApplication
        ? "set-up"
        : "refused";

  return { primary, menu };
}

function Provider({
  p,
  live,
  connectNow = false,
  onConnected,
}: {
  p: ProviderStatus;
  live: boolean;
  /** This host was just added, so offer to connect it without being asked. */
  connectNow?: boolean;
  onConnected?: () => void;
}) {
  const confirm = useConfirm();
  const cache = useQueryClient();
  const disconnect = useDisconnectProvider();
  const remove = useDeleteProvider();
  const connect = useConnect(p);
  const [identity, setIdentity] = useState(false);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const refresh = () => cache.invalidateQueries({ queryKey: getListProvidersQueryKey() });

  /* **Added, so connect it.** Once, and only while it is still unconnected —
     a re-render after the token lands must not start a second authorization.
     `connect.start()` is the same call the Connect button makes, so a host
     with no device flow gets the paste box and one with it gets the code. */
  useEffect(() => {
    if (!connectNow || !live || p.connected || !p.configured) return;
    onConnected?.();
    connect.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectNow, live, p.connected, p.configured]);

  /* **The address, and only the address, in monospace.** What was here before
     was four facts of very different importance flattened into one mono
     sentence — name, hostname, what it calls a change, which application — so
     it read as code, carried no hierarchy, and ran past the width until it
     truncated mid-word. The hostname is the only one of the four that is data;
     the rest are the row's title or a state, and a state belongs in a chip. */
  const under = [p.gitHost, p.version].filter(Boolean).join(" · ");

  /* `maySetApplication` rather than a role read off `auth/me`: the rule is the
     server's, and a copy of it here is a copy to keep in step. A control plane
     older than this app does not send it, which reads as false and costs an
     administrator the control until the server is upgraded — the right way
     round, because the other default draws controls the server refuses. */
  const mayManage = p.maySetApplication;
  const { primary, menu: offered } = actionsFor(p);

  return (
    <div>
      <div className="flex items-center gap-2.5 px-3.5 py-2">
        {/* Tinted here, unlike the dense rows elsewhere. This is the list whose
            whole job is telling hosts apart, and at 13px a grey tanuki and a
            grey teacup are the same smudge. */}
        <HostMark kind={p.kind} size={14} brand />

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-ui text-bone">{p.label}</span>
            {p.connected ? (
              <Chip tone="good">connected</Chip>
            ) : !p.configured ? (
              <Chip tone="warn">needs an application</Chip>
            ) : null}
            {p.sharedApplication && <Chip>shared app</Chip>}
          </span>
          <span className="block truncate font-mono text-micro text-mute">{under}</span>
        </span>

        {/* **One action column.** Before, a row was pencil + Connect and the
            next was pencil + Connect + bin, so the controls shifted sideways as
            the eye went down. At most one button, then one menu — every row
            ends in the same place. */}
        <div className="flex shrink-0 items-center gap-1.5">
          {primary === "identity" ? (
            <button onClick={() => setIdentity(!identity)} className="control border border-line bg-raise text-ui text-text hover:bg-overlay">
              Identity
            </button>
          ) : primary === "connect" ? (
            <button
              disabled={!live || connect.busy}
              onClick={connect.start}
              className="control border border-line bg-raise text-ui text-text hover:bg-overlay disabled:opacity-50"
            >
              <Icon of={Link2} size={12} />Connect
            </button>
          ) : primary === "set-up" ? (
            <button onClick={() => setEditing(true)} className="control border border-line bg-raise text-ui text-text hover:bg-overlay">
              Set it up
            </button>
          ) : (
            /* Saying what has to happen beats a control the server refuses. */
            <span className="text-meta text-mute">An administrator sets this up</span>
          )}

          <div>
            <button
              onClick={(e) => setMenu(menu ? null : e.currentTarget)}
              aria-label={`More for ${p.label}`}
              className="control text-mute hover:bg-raise hover:text-bone"
            >
              <Icon of={MoreHorizontal} size={14} />
            </button>
            {/* Into `document.body`, because `Section` wraps these rows in an
                `overflow-hidden` card and a clipping ancestor clips whatever
                its descendants' z-index say. The sharing sheet learned this
                first; `Pop` is that lesson, imported. */}
            {menu && (
              <Pop anchor={menu} onClose={() => setMenu(null)}>
                <div className="w-56 py-1">
                  {offered.includes("settings") && (
                    <MenuItem onClick={() => { setMenu(null); setEditing(true); }}>
                      Advanced
                    </MenuItem>
                  )}
                  {offered.includes("sign-out") && (
                    <MenuItem
                      tone="danger"
                      disabled={!live || disconnect.isPending}
                      onClick={() => {
                        setMenu(null);
                        void confirm({
                          title: `Sign out of ${p.label}?`,
                          body: "Your token is forgotten. The host stays, and anybody else here keeps theirs. Sessions already running keep the token they were given.",
                          action: "Sign out",
                          tone: "danger",
                        }).then((ok) => ok && disconnect.mutate({ id: p.id }, { onSuccess: refresh }));
                      }}
                    >
                      Sign out
                    </MenuItem>
                  )}
                  {/* Removing the host, not signing out of it. The built-in one
                      is not removable and the server refuses it, so it is not
                      drawn rather than drawn and refused. */}
                  {offered.includes("remove") && (
                    <MenuItem
                      tone="danger"
                      disabled={!live || remove.isPending}
                      onClick={() => {
                        setMenu(null);
                        void confirm({
                          title: `Remove ${p.label}?`,
                          body: "Every token anybody here holds for it is forgotten — they are that host's and open nothing else. Repositories cloned from it are left alone and stop finding a token.",
                          action: "Remove",
                          tone: "danger",
                        }).then((ok) => ok && remove.mutate({ id: p.id }, { onSuccess: refresh }));
                      }}
                    >
                      Remove this host
                    </MenuItem>
                  )}
                </div>
              </Pop>
            )}
          </div>
        </div>
      </div>

      {remove.error && <p className="px-3.5 pb-2 text-meta text-brick">{why(remove.error)}</p>}
      {connect.node}
      {identity && p.connected && <Identity providerId={p.id} />}
      {editing && (
        <Settings
          p={p}
          onSaved={() => { setEditing(false); refresh(); }}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

/** A state, as a chip — not a clause in a monospace sentence. */
function Chip({ children, tone }: { children: React.ReactNode; tone?: "good" | "warn" }) {
  const look =
    tone === "good"
      ? "border-sage-deep bg-sage-tint text-sage"
      : tone === "warn"
        ? "border-line text-kind-data"
        : "border-line text-mute";
  return <span className={`shrink-0 rounded-full border px-1.5 py-px text-micro ${look}`}>{children}</span>;
}

function MenuItem({
  children,
  onClick,
  tone,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "danger";
  disabled?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left text-ui hover:bg-raise/60 disabled:opacity-40 ${
        tone === "danger" ? "text-dim hover:text-brick" : "text-text hover:text-bone"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Add a git host — pick what it is, then say where.
 *
 * **The list is the point, not the question.** An earlier draft opened on a
 * single address field, on the theory that the kind is a fact the probe can
 * read rather than a question worth asking. That was right about the question
 * and wrong about the list: the kinds were the only place the product ever
 * said *what it can talk to*. An empty box asking "where is it" tells somebody
 * who has a Forgejo nothing at all, and they will never type its address to
 * find out.
 *
 * So the kinds are back as the first step, and they are **named as the things
 * people actually have** — GitHub Enterprise Server, GitLab self-managed,
 * Gitea or Forgejo — rather than collapsed into three brands. The hosted and
 * the self-hosted forms are separate rows because they are separate products
 * to whoever is picking, and they need different second steps.
 *
 * It is a vertical list rather than a row of buttons, which is the shape that
 * survives a fourth and a fifth kind.
 *
 * **The probe still does the work.** Step two reaches the instance to confirm
 * what is there, read its version, and say whether the browser flow is
 * available — and it says so plainly when the answer disagrees with the row
 * that was picked, rather than letting somebody find out later.
 *
 * Exported because the Repositories screen opens *this* dialog rather than one
 * of its own. Adding a host is one job with one set of traps in it — the
 * device-flow checkbox, the Confidential box, the probe disagreeing with the
 * row that was picked — and a second copy of it is a second place for those to
 * drift out of step.
 */
export function AddHost({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  /** The id of the host that was created, so the list can offer to connect it. */
  onAdded?: (id: string) => void;
}) {
  const kinds = useListKinds();
  const [picked, setPicked] = useState<Choice | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ground/70 pt-[12vh] backdrop-blur-[3px]" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-[28rem] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--shadow-float)">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          {picked && (
            <button onClick={() => setPicked(null)} className="grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone" aria-label="Back">
              <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
            </button>
          )}
          <h2 className="text-title text-bone">{picked ? `Add ${picked.label}` : "Add a git host"}</h2>
          <button onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone">
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        {picked ? (
          <Where choice={picked} onClose={onClose} onAdded={onAdded} />
        ) : (
          <Which kinds={kinds.data ?? []} loading={kinds.isPending} onPick={setPicked} />
        )}
      </div>
    </div>
  );
}

/** One row of the first step: a thing somebody has, and where it lives. */
type Choice = {
  kind: string;
  label: string;
  /** The address, for a hosted instance. Absent means they have to say. */
  baseUrl: string | null;
  aside: string;
};

/** Every kind, as the hosted and the self-hosted things people actually run. */
function choicesFrom(kinds: KindInfo[]): Choice[] {
  const out: Choice[] = [];
  for (const k of kinds) {
    if (k.hostedBaseUrl) {
      out.push({
        kind: k.id,
        label: k.label,
        baseUrl: k.hostedBaseUrl,
        aside: k.hostedBaseUrl.replace(/^https?:\/\//, ""),
      });
    }
    out.push({
      kind: k.id,
      label: k.selfHostedLabel,
      baseUrl: null,
      aside: "your own server",
    });
  }
  return out;
}

function Which({
  kinds,
  loading,
  onPick,
}: {
  kinds: KindInfo[];
  loading: boolean;
  onPick: (c: Choice) => void;
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 px-5 py-8 text-ui text-mute">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />Asking what this server supports…
      </p>
    );
  }

  return (
    <div className="px-5 py-4">
      <p className="text-meta text-dim">What are you connecting?</p>
      <div className="mt-2.5 flex flex-col gap-1.5">
        {choicesFrom(kinds).map((c) => (
          <button
            key={`${c.kind}:${c.label}`}
            onClick={() => onPick(c)}
            className="flex items-center gap-3 rounded-lg border border-line bg-raise px-3.5 py-2.5 text-left hover:bg-overlay"
          >
            <HostMark kind={c.kind} size={16} brand />
            <span className="text-ui font-medium text-bone">{c.label}</span>
            <span className="ml-auto truncate font-mono text-micro text-mute">{c.aside}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Which way in a host offers first, once we know what it is.
 *
 * **The browser wherever it exists.** It is the way in that has always worked
 * here, and the only one where nobody ends up holding a token: each person
 * approves a short code and the host mints one for them. A pasted token is the
 * fallback, and the cases it is for are real rather than hypothetical — Gitea
 * has no device flow at any version, a GitLab older than 17.9 has none either,
 * and an organization may refuse to approve a third-party application at all.
 *
 * The regression this is pinned against: the two were drawn as a pair of equal
 * buttons with the *token* selected, so a brand-new GitHub — the one case where
 * the browser needs nothing set up — opened on the harder half of a fork in the
 * road nobody had asked to be at.
 */
export function firstWayIn(probed: Pick<ProbedProvider, "authModes">): AuthMode {
  return probed.authModes.includes("device") ? "device" : "token";
}

/**
 * The second step, which differs by what was picked.
 *
 * A hosted instance needs no address — it is one field and a press. Anything
 * self-hosted asks where, then confirms what answered.
 */
function Where({
  choice,
  onClose,
  onAdded,
}: {
  choice: Choice;
  onClose: () => void;
  onAdded?: (id: string) => void;
}) {
  const cache = useQueryClient();
  const kinds = useListKinds();
  const kind = (kinds.data ?? []).find((k) => k.id === (choice.kind as string));
  const probe = useProbeProvider();
  const create = useCreateProvider();

  const [address, setAddress] = useState(choice.baseUrl ?? "");
  const [label, setLabel] = useState(choice.baseUrl ? choice.label : "");
  const [named, setNamed] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [clientId, setClientId] = useState("");
  const [found, setFound] = useState<ProbedProvider | null>(null);

  /* Asked when the field is left alone, not on a button: a Check button beside
     a field that already probes on blur is two ways to do one thing. */
  const look = () => {
    const typed = address.trim();
    if (!typed || typed === found?.baseUrl) return;
    setFound(null);
    probe.mutate(
      { data: { baseUrl: typed } },
      {
        onSuccess: (p) => {
          setFound(p);
          if (!named) setLabel(p.suggestedLabel);
          setBrowser(firstWayIn(p) === "device");
        },
      },
    );
  };

  /* A hosted instance has nothing to type, so it is asked once on open rather
     than waiting for a blur that will never come. */
  useEffect(() => {
    if (choice.baseUrl) look();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canBrowser = found?.authModes.includes("device") ?? false;
  /* Browser sign-in without an application is a host nobody can connect — the
     same half-added state the server's `default_auth` exists to avoid, so the
     button does not offer it either. */
  const ready = !!found && label.trim().length > 0 && (!browser || clientId.trim().length > 0);
  /* What answered is not always what was picked — somebody choosing GitLab and
     pasting a Gitea's address should be told, not silently corrected. */
  const mismatch = found && found.kind !== choice.kind ? found : null;

  const add = () =>
    create.mutate(
      {
        data: {
          kind: found!.kind,
          label: label.trim(),
          baseUrl: found!.baseUrl,
          auth: browser ? "device" : null,
          clientId: browser ? clientId.trim() || null : null,
        },
      },
      {
        onSuccess: async (made) => {
          await Promise.all([
            cache.invalidateQueries({ queryKey: getListProvidersQueryKey() }),
            cache.invalidateQueries({ queryKey: getListTrackersQueryKey() }),
          ]);
          // Named before the dialog goes, so the row it belongs to can pick
          // the job up where this left off rather than leaving somebody on a
          // list with a new host on it and nothing suggesting what is next.
          onAdded?.(made.id);
          onClose();
        },
      },
    );

  return (
    <>
      <div className="space-y-3.5 px-5 py-4">
        {!choice.baseUrl && (
          <label className="block">
            <span className="text-meta text-dim">Where is it</span>
            <input
              autoFocus
              value={address}
              onChange={(e) => { setAddress(e.target.value); setFound(null); }}
              onBlur={look}
              onKeyDown={(e) => e.key === "Enter" && look()}
              placeholder="https://git.acme.internal"
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-line bg-ground px-3 py-1.5 font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none"
            />
          </label>
        )}

        {/* The answer lands here and nothing is reserved for it — a fixed-height
            box held open for a result that is not there reads as a rendering
            fault, which is what the earlier draft did. */}
        {probe.isPending && (
          <span className="flex items-center gap-2 text-meta text-mute">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />Reaching it…
          </span>
        )}
        {probe.isError && <span className="block text-meta text-brick">{why(probe.error)}</span>}
        {found && !probe.isPending && (
          <span className="flex items-center gap-2 text-meta text-sage">
            <HostMark kind={found.kind} size={13} brand />
            reached it — a {found.kindLabel}
            {found.version ? `, version ${found.version}` : ""}
          </span>
        )}
        {mismatch && (
          <p className="text-meta text-kind-data">
            That is a {mismatch.kindLabel}, not a {choice.label}. Adding it as a{" "}
            {mismatch.kindLabel} — which is what it is.
          </p>
        )}

        {found && (
          <>
            <label className="block">
              <span className="text-meta text-dim">Name <span className="text-mute">— how anybody here tells two apart</span></span>
              <input
                value={label}
                onChange={(e) => { setLabel(e.target.value); setNamed(true); }}
                className="mt-1 w-full rounded-lg border border-line bg-ground px-3 py-1.5 text-ui text-bone focus:border-slate-deep focus:outline-none"
              />
            </label>

            <div>
              <span className="text-meta text-dim">How people sign in</span>
              {/* **A host you add is yours, including its application.** The
                  shipped rows — github.com and gitlab.com — use Firetower's,
                  which is what makes a fresh install work with nothing
                  registered. Anything added here does not, for two reasons the
                  copy says out loud: the approval screen would carry our name
                  rather than theirs, and GitHub's 50 authorizations an hour are
                  per application and shared by every installation using it.

                  **Not two equal choices.** An earlier draft put these behind a
                  pair of buttons with the token selected, which read as a fork
                  in the road and defaulted to the harder side of it. The
                  browser is the way in; a token is what you reach for when the
                  browser is not available — Gitea has no device flow at any
                  version, a GitLab older than 17.9 has none either, and an
                  organization may refuse to approve a third-party application
                  at all. So one is shown and the other is a line underneath. */}
              {browser ? (
                <div className="mt-1.5">
                  <p className="text-meta text-dim">
                    Create an OAuth application of your own on{" "}
                    <button
                      onClick={() => void openExternal(`${found.baseUrl}${kind?.appPage ?? ""}`)}
                      className="font-mono text-mute underline decoration-line underline-offset-2 hover:text-bone"
                    >
                      {found.gitHost}
                    </button>
                    :
                  </p>
                  {/* The step that catches people out differs by host and fails
                      identically to a wrong client id on both, so it is written
                      down rather than left to be discovered. */}
                  <ol className="mt-1.5 space-y-1 text-meta text-mute">
                    {(kind?.appSteps ?? []).map((step, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="shrink-0 text-dim">{i + 1}.</span>
                        <span>{bold(step)}</span>
                      </li>
                    ))}
                  </ol>
                  <input
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder={found.kind === "gitlab" ? "Application ID" : "Client ID"}
                    spellCheck={false}
                    className="mt-2 w-full rounded-lg border border-line bg-ground px-3 py-1.5 font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none"
                  />
                  <button
                    onClick={() => setBrowser(false)}
                    className="mt-2 text-meta text-mute underline decoration-line underline-offset-2 hover:text-bone"
                  >
                    Can&rsquo;t register one? Everybody pastes a token instead.
                  </button>
                </div>
              ) : (
                <div className="mt-1.5">
                  <p className="text-meta text-mute">
                    Each person makes an access token on{" "}
                    <span className="font-mono text-dim">{found.gitHost}</span> and pastes it.
                    Nothing to register.
                  </p>
                  {canBrowser ? (
                    <button
                      onClick={() => setBrowser(true)}
                      className="mt-1.5 text-meta text-mute underline decoration-line underline-offset-2 hover:text-bone"
                    >
                      Register an application instead, and nobody handles a token.
                    </button>
                  ) : (
                    found.note && <p className="mt-1.5 text-meta text-mute">{found.note}</p>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {create.error && <p className="text-meta text-brick">{why(create.error)}</p>}
      </div>

      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <button onClick={onClose} className="control text-mute hover:text-bone">Cancel</button>
        <button
          disabled={!ready || create.isPending}
          onClick={add}
          className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute"
        >
          {create.isPending ? "Adding…" : "Add the host"}
        </button>
      </div>
    </>
  );
}

/* ── Editing one ───────────────────────────────────────────────────────── */

/**
 * What may be changed about a host after it exists.
 *
 * **Not the address.** A host whose address moves is a different host: the
 * repositories cloned from the old one still point at it and the tokens issued
 * by it are still for it. Moving one is removing it and adding the new one,
 * which is at least honest about what happens to everything that referred to it.
 *
 * The application is install-wide rather than yours: one row in the server's
 * settings, no owner — so changing it changes it for everybody, and signing out
 * of your own account deliberately leaves it alone. Shown filled in, because
 * the reason to open this is that the id already there is the thing that
 * stopped working.
 */
function Settings({ p, onSaved, onClose }: { p: ProviderStatus; onSaved: () => void; onClose: () => void }) {
  const save = useUpdateProvider();
  const [label, setLabel] = useState(p.label);
  const [auth, setAuth] = useState<AuthMode>(p.auth);
  const [clientId, setClientId] = useState(p.clientId ?? "");

  const changed = label.trim() !== p.label || auth !== p.auth || clientId.trim() !== (p.clientId ?? "");

  return (
    <div className="space-y-3 border-t border-line-soft bg-ground/40 px-3.5 py-3">
      <p className="text-meta text-dim">
        <span className="font-mono text-mute">{p.baseUrl}</span>
        {p.builtin ? " — built in, and not removable. Signing out forgets your token." : " — a host that moves is a different host: remove this one and add the new one."}
      </p>

      <label className="block">
        <span className="text-meta text-dim">Name</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} className="mt-1 w-full rounded-md border border-line bg-ground px-2 py-1 text-ui text-bone focus:outline-none" />
      </label>

      <div>
        <span className="text-meta text-dim">How people connect it</span>
        <div className="mt-1 flex gap-1.5">
          {(["device", "token"] as AuthMode[]).map((mode) => (
            <button
              key={mode}
              disabled={!p.authModes.includes(mode)}
              onClick={() => setAuth(mode)}
              className={`control flex-1 justify-center border ${auth === mode ? "border-slate-deep bg-raise text-bone" : "border-line bg-ground text-mute hover:text-bone"} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {mode === "device" ? "In a browser" : "A token each"}
            </button>
          ))}
        </div>
        {!p.authModes.includes("device") && <p className="mt-1 text-meta text-mute">{p.label} has no device flow, so everybody connects it with a token.</p>}
      </div>

      {auth === "device" && (
        <label className="block">
          <span className="text-meta text-dim">Application <span className="text-mute">— for everybody on this server</span></span>
          {/* Which one is in use, and the two reasons to replace it. Both are
              real and neither is obvious: an approval screen showing an
              outside publisher is a different conversation with a security
              team, and the shared ceiling is a limit nobody can see coming. */}
          {p.sharedApplication ? (
            <p className="mt-1 text-meta text-dim">
              Using <span className="text-bone">Firetower&rsquo;s application</span>, so there is
              nothing to register and this works out of the box. Your own instead if you would
              rather the approval screen carried your name, or your organisation reviews
              third-party applications — and it has an authorisation limit of its own rather than
              one shared with every other Firetower.
            </p>
          ) : (
            <p className="mt-1 text-meta text-dim">
              This installation&rsquo;s own. Clear it to go back to the one Firetower ships.
            </p>
          )}
          <div className="mt-1.5 flex items-center gap-2">
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={p.sharedApplication ? "Your own OAuth client id" : "OAuth client id"} spellCheck={false} className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 font-mono text-ui text-bone focus:outline-none" />
            <button onClick={() => void openExternal(p.appPage)} className="control text-micro text-mute hover:text-bone">register one</button>
          </div>
          {/* The only place an organisation that restricts third-party
              applications can be granted after the fact, and the address of it
              contains the client id. GitHub only — nothing equivalent exists on
              the other two, and a link to a page that is not there is worse
              than no link. */}
          {p.accessPage && (
            <button onClick={() => void openExternal(p.accessPage!)} className="mt-1.5 text-meta text-mute underline decoration-line underline-offset-2 hover:text-bone">
              Review this application&rsquo;s access on {p.gitHost}
            </button>
          )}
        </label>
      )}

      {/* **A way out.** This opens from the ⋯ menu, which is one-way: without
          this the only exit was saving, so somebody who opened it to look was
          stuck with a panel they could not put away. */}
      <div className="flex items-center gap-2">
        <button
          disabled={!changed || save.isPending}
          onClick={() => save.mutate({ id: p.id, data: { label: label.trim(), auth, clientId: clientId.trim() } }, { onSuccess: onSaved })}
          className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute"
        >
          {save.isPending ? "Saving…" : changed ? "Save" : "Saved"}
        </button>
        <button onClick={onClose} className="control text-mute hover:text-bone">
          {changed ? "Cancel" : "Close"}
        </button>
      </div>
      {save.error && <p className="text-meta text-brick">{why(save.error)}</p>}
    </div>
  );
}

/** The name and email on commits — a different fact from who signed in. */
function Identity({ providerId }: { providerId: string }) {
  const identity = useGetIdentity(providerId);
  const save = useSetIdentity();
  const clear = useClearIdentity();
  const held = identity.data as { name?: string; email?: string } | undefined;
  const [name, setName] = useState(held?.name ?? "");
  const [email, setEmail] = useState(held?.email ?? "");

  return (
    <div className="border-t border-line-soft bg-ground/40 px-3.5 py-3">
      <p className="text-meta text-dim">Who commits are attributed to. Empty means whatever the agent&rsquo;s git says.</p>
      <div className="mt-2 flex items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 text-ui text-bone focus:outline-none" />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 font-mono text-ui text-bone focus:outline-none" />
        <button disabled={!name.trim() || !email.trim() || save.isPending} onClick={() => save.mutate({ id: providerId, data: { name: name.trim(), email: email.trim() } }, { onSuccess: () => identity.refetch() })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">Save</button>
        {held?.name && <button onClick={() => clear.mutate({ id: providerId }, { onSuccess: () => { setName(""); setEmail(""); identity.refetch(); } })} className="control text-mute hover:text-brick"><X className="h-3.5 w-3.5" strokeWidth={2} /></button>}
      </div>
    </div>
  );
}

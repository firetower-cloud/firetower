/**
 * Repositories — what Firetower cuts worktrees from, and where you get more.
 *
 * **One screen, two lists.** What is connected, and what the chosen host can
 * see that is not. Importing used to be behind a modal, which meant the only
 * way to look at your repositories was to already be committed to adding one:
 * you could not browse. The list is on the screen now and the modal is gone.
 *
 * **Already-imported projects are left out of the lower list** rather than
 * shown ticked. The alternative puts the same repository on screen twice and
 * fills a 300-row list with rows that do nothing; the count — "12 not
 * imported" — carries the fact that there is more without the rows.
 *
 * **Nothing here sends you to another pane.** The host picker connects a host
 * on its own and the empty state offers the hosts themselves, because the
 * screen somebody lands on first has to be a start rather than a signpost.
 * Adding, renaming and removing a host is still an administrator's job and
 * still lives under Git hosts; this is the half everybody does.
 *
 * **One filter, governing both lists, and "All hosts" is the default.** It
 * used to govern only the lower one: the upper list showed every repository
 * from every host and ignored the picker entirely, so the single control that
 * looked page-wide was the only one that was not. Narrowing to a host now
 * narrows what you have imported *and* what you could import, which is what
 * the control looked like it did all along.
 *
 * Across all hosts the lower list is one request per connected host, run
 * together and cached per host. That is three requests on a three-host
 * install, which is the price of the default being the true answer rather
 * than whichever host happened to sort first.
 */
import { useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Link2,
  Loader2,
  Lock,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { HostMark, Icon } from "~/components/ui";
import type { ProviderStatus, RemoteRepo, Repo } from "~/api/generated/model";
import {
  getListReposQueryKey,
  useCreateRepo,
  useDeleteRepo,
  useListRepoEnv,
  useProbeRepo,
  usePutRepoEnv,
  useRemoveRepoEnv,
  useUpdateRepo,
} from "~/api/generated/repos/repos";
import {
  getListProvidersQueryKey,
  getListProviderReposQueryOptions,
} from "~/api/generated/providers/providers";
import { useHostOf, useProviders, useRepos, why } from "~/data";
import { navigate } from "~/shims/next-navigation";
import { Section } from "~/ui/config/bits";
import { useConnect } from "~/ui/config/connect";
import { AddHost } from "~/ui/config/GitHosts";
import { Pop } from "~/ui/Pop";
import { useConfirm } from "~/ui/Confirm";

/** `paste` is not a host — it is the way in for a remote no host can list. */
const PASTE = "paste";

/**
 * Every connected host at once, and what the screen opens on.
 *
 * A sentinel rather than `null`, because `null` already means "the hosts have
 * not arrived yet" and the two want opposite things on screen.
 */
const ALL = "all";

export function Repos({ live }: { live: boolean }) {
  const repos = useRepos();
  const providers = useProviders();
  const hostOf = useHostOf();

  const connectedHosts = useMemo(
    () => providers.data.filter((p) => p.connected),
    [providers.data],
  );

  /* What both lists are showing. Everything, until somebody narrows it. */
  const [from, setFrom] = useState<string>(ALL);
  const pasting = from === PASTE;
  /* `null` means every host rather than none — `showing` below is the list it
     resolves to, and that is what the two lists are actually built from. */
  const chosen = pasting ? null : (connectedHosts.find((p) => p.id === from) ?? null);
  const showing = useMemo(
    () => (chosen ? [chosen] : connectedHosts),
    [chosen, connectedHosts],
  );

  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const needle = q.trim().toLowerCase();
  /* **The upper list obeys the filter too.** This is the half that used to
     ignore it: `hostOf` resolves which host a repository came from, so
     narrowing to one hides the rest rather than leaving them on screen under
     a control that claims to have excluded them. */
  const mine = useMemo(
    () =>
      repos.data.filter(
        (r) =>
          (!needle || r.slug.toLowerCase().includes(needle)) &&
          (!chosen || hostOf(r.slug)?.id === chosen.id),
      ),
    [repos.data, needle, chosen, hostOf],
  );

  /* **No host to import from** — not "no repositories imported yet". The
     whole screen becomes the way in, so whatever replaces it has to be the
     thing that gets you unstuck.
     
     The bug this is pinned against: this read `repos.data.length === 0`, so
     anybody who connected a host and had not yet imported anything got the
     screen that asks them to connect a host. `Start` draws only hosts that are
     *not* connected, so the host they had just signed into was missing from
     it — and the picker and the Available list, the two things that could have
     imported anything, were both inside the branch this skipped. A first run
     ended on a screen with no way forward and nothing on it that was true.
     
     While the hosts are still arriving, `Start` is the right place to be: it
     has a loading state of its own, and the alternative is a two-list view
     flashing "Nothing connected yet" before we know whether that is so. */
  const bare =
    !pasting &&
    !repos.loading &&
    repos.data.length === 0 &&
    (providers.loading || connectedHosts.length === 0);

  return (
    <Section
      title="Repositories"
      action={
        live ? (
          <button
            onClick={() => setAdding(true)}
            className="control border border-line bg-raise text-ui text-bone hover:bg-overlay"
          >
            <Plus className="h-3.5 w-3.5 text-mute" strokeWidth={2} />
            Add a host
          </button>
        ) : null
      }
      controls={
        live && !bare ? (
          <>
            <HostPicker
              hosts={connectedHosts}
              chosen={chosen}
              pasting={pasting}
              onPick={setFrom}
            />
            <label className="flex items-center gap-1.5 rounded-md border border-line bg-raise px-2 py-1">
              <Search className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search"
                className="w-32 bg-transparent text-ui text-bone placeholder:text-mute focus:outline-none"
              />
            </label>
          </>
        ) : null
      }
    >
      {adding && <AddHost onClose={() => setAdding(false)} />}
      {bare ? (
        <Start hosts={providers.data} loading={providers.loading} onPaste={() => setFrom(PASTE)} />
      ) : (
        <div className="px-3.5 py-3">
          {pasting ? (
            <Paste onDone={() => setFrom(ALL)} onCancel={() => setFrom(ALL)} />
          ) : (
            <>
              <Eyebrow label="Imported" count={`${mine.length}`} />
              <div className="overflow-hidden rounded-lg border border-line">
                {repos.loading && <Quiet>Reading your repositories…</Quiet>}
                {!repos.loading && mine.length === 0 && (
                  <Quiet>
                    {needle
                      ? "Nothing imported matches that."
                      : chosen
                        ? `Nothing imported from ${chosen.label} yet.`
                        : "Nothing imported yet."}
                  </Quiet>
                )}
                {mine.map((r) => (
                  <div key={r.id} className="border-b border-line-soft last:border-b-0">
                    <button
                      onClick={() => setOpen(open === r.id ? null : r.id)}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-raise/60"
                    >
                      <HostMark kind={hostOf(r.slug)?.kind} size={13} className="shrink-0 text-mute" />
                      <span className="min-w-0 flex-1 truncate font-mono text-ui text-text">{r.slug}</span>
                      <span className="font-mono text-micro text-mute">{r.defaultBranch ?? "main"}</span>
                      {r.setup && <span className="text-micro text-mute">setup</span>}
                      <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-mute transition-transform ${open === r.id ? "rotate-180" : ""}`}
                        strokeWidth={2}
                      />
                    </button>
                    {open === r.id && live && <Settings repo={r} onGone={() => setOpen(null)} />}
                  </div>
                ))}
              </div>

              {showing.length > 0 && (
                <Available
                  hosts={showing}
                  named={!chosen && connectedHosts.length > 1}
                  connected={repos.data}
                  needle={needle}
                  live={live}
                />
              )}
            </>
          )}
        </div>
      )}
    </Section>
  );
}

function Eyebrow({ label, count }: { label: string; count?: string }) {
  return (
    <div className="mt-3 mb-1.5 flex items-center gap-2 first:mt-0">
      <span className="text-micro tracking-[0.07em] text-mute uppercase">{label}</span>
      {count && <span className="ml-auto text-meta text-mute">{count}</span>}
    </div>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-3 text-ui text-mute">{children}</p>;
}

/* ── What this host can see that you have not taken ────────────────────── */

/**
 * The lower list.
 *
 * Already-connected projects are dropped rather than drawn ticked — the count
 * says how many are left, which carries "there is more here" without the rows.
 * Matched on the remote rather than the slug: two hosts can both have an
 * `acme/web`, and the remote is the thing that is actually the same repository.
 */
function Available({
  hosts,
  named,
  connected,
  needle,
  live,
}: {
  /** Every host the list is drawn from — one, or all the connected ones. */
  hosts: ProviderStatus[];
  /** Whether to say which host each row is on. Only worth it across several. */
  named: boolean;
  connected: Repo[];
  needle: string;
  live: boolean;
}) {
  const cache = useQueryClient();
  const create = useCreateRepo();
  const [taking, setTaking] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});

  /* **One query per host, declared together.** `useQueries` rather than a
     component per host because the rows have to interleave: sorted by what
     was pushed most recently across the whole set, not host by host. Each
     keeps its own cache entry, so narrowing to one host afterwards is free
     and re-widening does not re-ask. */
  const answers = useQueries({
    queries: hosts.map((h) => getListProviderReposQueryOptions(h.id)),
  });

  const pending = answers.some((a) => a.isPending);
  /* A host that will not answer is named rather than folded into a count:
     "everything is imported" and "GitLab did not reply" look identical on a
     screen that only shows what came back. */
  const broken = answers
    .map((a, i) => (a.error ? { host: hosts[i], why: why(a.error) } : null))
    .filter((x): x is { host: ProviderStatus; why: string } => x !== null);

  const held = useMemo(
    () => new Set(connected.map((r) => r.remote.replace(/\.git$/, ""))),
    [connected],
  );

  /* Flattened with the host each row came from, because the Import call needs
     it: a repository is recorded against the host that offered it rather than
     matched by hostname later, which is the only thing that works when two
     accounts share one hostname. */
  const all = useMemo(() => {
    const rows = answers.flatMap((a, i) =>
      ((a.data ?? []) as RemoteRepo[]).map((r) => ({ repo: r, host: hosts[i] })),
    );
    return rows
      .filter(({ repo }) => !held.has(repo.remote.replace(/\.git$/, "")))
      .sort((a, b) => (b.repo.pushedAt ?? "").localeCompare(a.repo.pushedAt ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers.map((a) => a.dataUpdatedAt).join(), hosts, held]);

  const shown = needle
    ? all.filter(({ repo }) => repo.slug.toLowerCase().includes(needle))
    : all;

  const take = async (r: RemoteRepo, host: ProviderStatus) => {
    const at = `${host.id}:${r.slug}`;
    setTaking(at);
    setFailed((was) => ({ ...was, [at]: "" }));
    try {
      await create.mutateAsync({
        data: {
          slug: r.slug,
          remote: r.remote,
          // Which host it came from, written down rather than matched by
          // hostname later: with two accounts on one hostname the remote
          // cannot say which token opens it.
          provider: host.id,
          defaultBranch: r.defaultBranch,
        },
      });
      await cache.invalidateQueries({ queryKey: getListReposQueryKey() });
    } catch (e) {
      setFailed((was) => ({ ...was, [at]: why(e) }));
    }
    setTaking(null);
  };

  const where = hosts.length === 1 ? ` on ${hosts[0].label}` : "";

  return (
    <>
      <Eyebrow
        label={`Available to import${where}`}
        count={
          pending
            ? undefined
            : named
              ? `${all.length} across ${hosts.length} hosts`
              : `${all.length} not imported`
        }
      />
      <div className="overflow-hidden rounded-lg border border-line">
        {pending && (
          <p className="flex items-center gap-2 px-3 py-3 text-ui text-mute">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            {hosts.length === 1 ? `Asking ${hosts[0].label}…` : "Asking your hosts…"}
          </p>
        )}
        {broken.map(({ host, why: reason }) => (
          <p key={host.id} className="px-3 py-2 text-meta text-brick">
            {host.label}: {reason}
          </p>
        ))}
        {!pending && broken.length === 0 && shown.length === 0 && (
          <Quiet>
            {needle
              ? `Nothing available${where} matches that.`
              : `Everything${where} is imported.`}
          </Quiet>
        )}
        {shown.slice(0, 80).map(({ repo: r, host }) => (
          <div key={`${host.id}:${r.remote}`} className="border-b border-line-soft last:border-b-0">
            <div className="flex items-center gap-2.5 px-3 py-2">
              <HostMark kind={host.kind} size={13} className="shrink-0 text-mute" />
              <span className="min-w-0 flex-1 truncate font-mono text-ui text-text">{r.slug}</span>
              {/* **Which host, across several.** Two hosts can both hold an
                  `acme/web`, and without this the two rows are identical. */}
              {named && (
                <span className="hidden shrink-0 truncate font-mono text-micro text-mute sm:block">
                  {host.gitHost}
                </span>
              )}
              {r.private && <Lock className="h-3 w-3 shrink-0 text-mute" strokeWidth={2} />}
              <span className="font-mono text-micro text-mute">{ago(r.pushedAt)}</span>
              <button
                disabled={!live || taking !== null}
                onClick={() => void take(r, host)}
                className="control shrink-0 border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute"
              >
                {taking === `${host.id}:${r.slug}` ? "Importing…" : "Import"}
              </button>
            </div>
            {failed[`${host.id}:${r.slug}`] && (
              <p className="px-3 pb-2 text-meta text-brick">{failed[`${host.id}:${r.slug}`]}</p>
            )}
          </div>
        ))}
        {shown.length > 80 && (
          <p className="px-3 py-2 text-meta text-mute">
            {shown.length - 80} more — narrow it with the search box.
          </p>
        )}
      </div>
    </>
  );
}

/** `2h`, `3d`, `—`. Short because it sits in a dense row. */
function ago(at?: string | null): string {
  if (!at) return "";
  const then = Date.parse(at);
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  if (mins < 60 * 24 * 365) return `${Math.round(mins / (60 * 24))}d`;
  return `${Math.round(mins / (60 * 24 * 365))}y`;
}

/* ── Which host both lists are showing ────────────────────────────────── */

/**
 * The filter over both lists, or all hosts at once.
 *
 * **"All hosts" is the default and the first row.** The screen's question is
 * "what have I got", and on a three-host install the answer is not whichever
 * host sorted first — which is what this used to open on.
 *
 * **Connected hosts only.** It once listed every host and disabled the rows
 * for the ones nobody had signed into, each with a small Connect beside it.
 * The rows that could not be picked outnumbered the ones that could on a
 * fresh install, clicking the obvious part of such a row did nothing at all,
 * and "a host you cannot choose" is not an answer to *whose repositories am
 * I looking at*. Signing one in belongs on Git hosts, and the empty state
 * already offers it when nothing is connected.
 *
 * Adding a host is a button beside the heading rather than the last row here:
 * it is not something the list can be filtered to.
 */
function HostPicker({
  hosts,
  chosen,
  pasting,
  onPick,
}: {
  hosts: ProviderStatus[];
  chosen: ProviderStatus | null;
  pasting: boolean;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState<HTMLElement | null>(null);

  return (
    <div>
      <button
        onClick={(e) => setOpen(open ? null : e.currentTarget)}
        className="control border border-line bg-raise text-ui text-bone hover:bg-overlay"
      >
        {pasting ? (
          <>Paste a remote</>
        ) : chosen ? (
          <>
            <HostMark kind={chosen.kind} size={13} brand />
            {chosen.label}
          </>
        ) : (
          <>All hosts</>
        )}
        <ChevronDown className="h-3.5 w-3.5 text-mute" strokeWidth={2} />
      </button>

      {/* Into `document.body` — the pane is a scroll container and the card
          below it clips, so an absolutely positioned menu is one row away
          from coming out cut in half. See `Pop`. */}
      {open && (
        <Pop anchor={open} onClose={() => setOpen(null)}>
          <div className="w-[19rem]">
            <button
              onClick={() => { onPick(ALL); setOpen(null); }}
              className="flex w-full items-center gap-2.5 border-b border-line-soft px-3 py-2 text-left hover:bg-raise/60"
            >
              <span className="min-w-0 flex-1 text-ui text-bone">All hosts</span>
              <span className="shrink-0 font-mono text-micro text-mute">{hosts.length}</span>
              {!chosen && !pasting && (
                <Check className="h-3.5 w-3.5 shrink-0 text-sage" strokeWidth={2} />
              )}
            </button>
            {hosts.map((h) => (
              <button
                key={h.id}
                onClick={() => { onPick(h.id); setOpen(null); }}
                className="flex w-full items-center gap-2.5 border-b border-line-soft px-3 py-2 text-left last:border-b-0 hover:bg-raise/60"
              >
                <HostMark kind={h.kind} size={13} brand />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui text-bone">{h.label}</span>
                  <span className="block truncate font-mono text-micro text-mute">{h.gitHost}</span>
                </span>
                {chosen?.id === h.id && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-sage" strokeWidth={2} />
                )}
              </button>
            ))}
          </div>
        </Pop>
      )}
    </div>
  );
}

/* ── Settings for one ──────────────────────────────────────────────────── */

function Settings({ repo, onGone }: { repo: Repo; onGone: () => void }) {
  const confirm = useConfirm();
  const cache = useQueryClient();
  const save = useUpdateRepo();
  const remove = useDeleteRepo();
  const put = usePutRepoEnv();
  const drop = useRemoveRepoEnv();
  const env = useListRepoEnv(repo.id);
  const [setup, setSetup] = useState(repo.setup ?? "");
  const [envFile, setEnvFile] = useState(repo.envFile ?? "");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);

  const refresh = () => cache.invalidateQueries({ queryKey: getListReposQueryKey() });

  return (
    <div className="space-y-3 border-t border-line-soft bg-ground/40 px-3.5 py-3">
      <label className="block">
        <span className="text-meta text-dim">Setup script <span className="text-mute">— runs after checkout, before the agent</span></span>
        <textarea rows={3} value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="pnpm install" className="scroll-slim mt-1 w-full resize-none rounded-lg border border-line bg-ground px-3 py-2 font-mono text-code text-text focus:border-slate-deep focus:outline-none" />
      </label>
      <label className="block">
        <span className="text-meta text-dim">Env file <span className="text-mute">— written into the workspace from the variables below</span></span>
        <input value={envFile} onChange={(e) => setEnvFile(e.target.value)} placeholder=".env" className="mt-1 w-full rounded-lg border border-line bg-ground px-3 py-1.5 font-mono text-ui text-bone focus:border-slate-deep focus:outline-none" />
      </label>
      <div className="flex items-center gap-2">
        <button disabled={save.isPending} onClick={() => save.mutate({ id: repo.id, data: { setup: setup || null, envFile: envFile || null } }, { onSuccess: () => { refresh(); setSaved(true); setTimeout(() => setSaved(false), 1400); } })} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">
          {save.isPending ? "Saving…" : saved ? <><Check className="h-3.5 w-3.5" strokeWidth={2} />Saved</> : "Save"}
        </button>
        <button onClick={() => { void confirm({ title: `Remove ${repo.slug}?`, body: "Workspaces already cut from it are untouched.", action: "Remove", tone: "danger" }).then((ok) => ok && remove.mutate({ id: repo.id }, { onSuccess: () => { refresh(); onGone(); } })); }} className="control ml-auto text-mute hover:text-brick"><Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />Remove</button>
      </div>

      <div>
        <span className="text-meta text-dim">Environment <span className="text-mute">— names are shown, values never come back</span></span>
        <div className="mt-1.5 space-y-1">
          {(env.data ?? []).map((n) => (
            <div key={n} className="flex items-center gap-2 rounded-md bg-ground px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-ui text-text">{n}</span>
              <span className="font-mono text-micro text-mute">••••</span>
              <button onClick={() => drop.mutate({ id: repo.id, name: n }, { onSuccess: () => env.refetch() })} className="grid h-5 w-5 place-items-center rounded text-mute hover:text-brick"><X className="h-3 w-3" strokeWidth={2} /></button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="NAME" className="w-40 rounded-md border border-line bg-ground px-2 py-1 font-mono text-ui text-bone focus:outline-none" />
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" type="password" className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 font-mono text-ui text-bone focus:outline-none" />
            <button disabled={!name || !value || put.isPending} onClick={() => put.mutate({ id: repo.id, data: { variables: [{ name, value }] } }, { onSuccess: () => { setName(""); setValue(""); env.refetch(); } })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">Add</button>
          </div>
        </div>
      </div>
    </div>
  );
}


/* ── Nothing connected yet ─────────────────────────────────────────────── */

/**
 * Three empty states, not one.
 *
 * Which you get depends on what the installation already has, and only the
 * first is a fresh solo install:
 *
 *   * **nothing added** — the kinds, so a first run has somewhere to press;
 *   * **hosts added, none of them yours** — those hosts *by name*, because a
 *     colleague set them up and a generic "GitLab" button would send somebody
 *     to gitlab.com rather than to the GitLab they actually work on;
 *   * **connected but empty** — not here at all; that is a sentence inside the
 *     lower list, because the screen is not empty, one section of it is.
 *
 * The host's own mark, in the host's own colour. It is the thing people scan
 * for, and this is the one screen where a logo is doing that work rather than
 * sitting in a dense row beside a slug.
 */
function Start({
  hosts,
  loading,
  onPaste,
}: {
  hosts: ProviderStatus[];
  loading: boolean;
  onPaste: () => void;
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 px-3.5 py-6 text-ui text-mute">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
        Reading your connections…
      </p>
    );
  }

  const waiting = hosts.filter((h) => !h.connected);

  /* **A host somebody here added, versus the one that ships.** Every install
     has the built-in GitHub whether anybody chose it or not, so "a host
     exists" cannot be the test for "a colleague set this up" — that would
     greet the very first person on a fresh install as though somebody had
     been here before them. */
  const theirs = waiting.some((h) => !h.builtin);

  return (
    <div className="px-6 py-9 text-center">
      <p className="text-title text-bone">
        {theirs ? "Connect a git host" : "Pick a git host to start from"}
      </p>
      <p className="mx-auto mt-1.5 max-w-[46ch] text-ui text-dim">
        {theirs
          ? "Your colleagues set these up. Firetower clones with your own account, so yours is a separate sign-in."
          : "Firetower clones with your own account, so you choose from what it says you can see."}
      </p>

      <div className="mx-auto mt-5 flex w-full max-w-[20rem] flex-col gap-2">
        {waiting.map((h) => (
          <StartHost key={h.id} host={h} />
        ))}
      </div>

      <div className="mt-5 flex flex-col items-center gap-1.5 text-meta text-mute">
        {/* A link, not a sentence naming a place. This said "add it under Git
            hosts" and was plain text — so the one screen a new person lands on
            pointed at somewhere else and left them to find it. */}
        <span>
          Self-hosted or enterprise versions?{" "}
          <button
            onClick={() => navigate("/configuration/git-hosts")}
            className="text-dim underline decoration-line underline-offset-2 hover:text-bone"
          >
            Add custom hosts
          </button>
          .
        </span>
        <button onClick={onPaste} className="underline decoration-line underline-offset-2 hover:text-dim">
          Or paste a URL
        </button>
      </div>
    </div>
  );
}

/** One host, as a button with its own mark in its own colour. */
function StartHost({ host }: { host: ProviderStatus }) {
  const connect = useConnect(host);

  /* The address on the right, because once there are two of a kind it is the
     only thing telling them apart — `github.com` beside `ghe.acme.com`. */
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-raise text-left">
      <button
        onClick={connect.start}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 hover:bg-overlay"
      >
        <HostMark kind={host.kind} size={16} brand />
        <span className="text-ui font-medium text-bone">{host.label}</span>
        <span className="ml-auto truncate font-mono text-micro text-mute">{host.gitHost}</span>
      </button>
      {connect.node}
    </div>
  );
}

/* ── A remote no host can list ─────────────────────────────────────────── */

/**
 * Probed on a pause after typing: the server says what the remote is called
 * and whether it can reach it, before anything is written down.
 */
function Paste({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const cache = useQueryClient();
  const probe = useProbeRepo();
  const create = useCreateRepo();
  const [remote, setRemote] = useState("");
  const [trouble, setTrouble] = useState<string | null>(null);

  const look = (value: string) => {
    setRemote(value);
    setTrouble(null);
  };

  const found = probe.data;

  return (
    <div className="rounded-lg border border-line bg-panel px-3.5 py-3">
      <p className="text-meta text-dim">
        Anything git can clone — a URL, or a path on the machine that will do the cloning.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <input
          autoFocus
          value={remote}
          onChange={(e) => look(e.target.value)}
          onBlur={() => remote.trim() && probe.mutate({ data: { remote: remote.trim() } })}
          onKeyDown={(e) => e.key === "Enter" && remote.trim() && probe.mutate({ data: { remote: remote.trim() } })}
          placeholder="git@github.com:acme/web.git"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2.5 py-1.5 font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none"
        />
        <button onClick={onCancel} className="control text-mute hover:text-bone">
          Cancel
        </button>
        <button
          disabled={!found || create.isPending}
          onClick={() =>
            create.mutate(
              { data: { slug: found?.slug ?? "", remote: remote.trim() } },
              {
                onSuccess: async () => {
                  await cache.invalidateQueries({ queryKey: getListReposQueryKey() });
                  onDone();
                },
                onError: (e) => setTrouble(why(e)),
              },
            )
          }
          className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute"
        >
          {create.isPending ? "Adding…" : "Add it"}
        </button>
      </div>
      <div className="mt-1.5 min-h-5 text-meta">
        {probe.isPending && (
          <span className="flex items-center gap-2 text-mute">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            Reaching it…
          </span>
        )}
        {probe.isError && <span className="text-brick">{why(probe.error)}</span>}
        {found && !probe.isPending && (
          <span className="text-sage">
            <Check className="mr-1 inline h-3.5 w-3.5" strokeWidth={2} />
            {found.slug} · default branch {found.defaultBranch}
            {found.onlyHere ? " · only reachable from the server" : ""}
          </span>
        )}
        {trouble && <span className="text-brick">{trouble}</span>}
      </div>
    </div>
  );
}

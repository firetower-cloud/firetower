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
  FolderGit2,
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
import { Blank, Group, Note, Rows, Section, Typed } from "~/ui/config/bits";
import { useConnect } from "~/ui/config/connect";
import { navigate } from "~/shims/next-navigation";
import { actionsFor, AddHost } from "~/ui/config/GitHosts";
import { Pop } from "~/ui/Pop";
import { useConfirm } from "~/ui/Confirm";
import { useOpened } from "~/ui/opened";

/** `paste` is not a host — it is the way in for a remote no host can list. */
const PASTE = "paste";

/**
 * Every connected host at once, and what the screen opens on.
 *
 * A sentinel rather than `null`, because `null` already means "the hosts have
 * not arrived yet" and the two want opposite things on screen.
 */
const ALL = "all";

export function Repos({ live, open: asked = null }: { live: boolean; open?: string | null }) {
  const repos = useRepos();
  const cache = useQueryClient();
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
  const [open, setOpen] = useOpened(asked);
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
  /* **And nothing is in trouble.** A server that is not answering makes both
     lists empty, which is indistinguishable from a fresh install if you only
     count rows — so a dead Firetower drew "Pick a git host to start from",
     which is advice, confidently given, about a state nobody is in. An
     onboarding screen is for an install with nothing in it, not for an
     install we cannot see. */
  const bare =
    !pasting &&
    !repos.loading &&
    !repos.trouble &&
    !providers.trouble &&
    repos.data.length === 0 &&
    (providers.loading || connectedHosts.length === 0);

  return (
    <Section
      title="Repositories"
      note="What Firetower cuts worktrees from. Every workspace is a branch of one of these, in a copy of its own."
      settling={repos.loading}
      trouble={repos.trouble ?? providers.trouble}
      error={repos.error ?? providers.error}
      onRetry={() => void cache.invalidateQueries({ queryKey: getListReposQueryKey() })}
      /* **Not over the blank.** Adding a host is one of the rows inside the
         blank's own menu while nothing is connected, and the same verb twice
         on a screen with one sentence on it is one too many. It comes back
         the moment there is a list to add to. */
      action={
        live && !bare ? (
          <button
            onClick={() => setAdding(true)}
            className="btn plain"
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
            <label className="find right">
              <Search className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find a repository"
                aria-label="Find a repository"
                className="min-w-0 flex-1 bg-transparent placeholder:text-mute focus:outline-none"
              />
            </label>
          </>
        ) : null
      }
    >
      {adding && <AddHost onClose={() => setAdding(false)} />}
      {bare ? (
        <Start
          hosts={providers.data}
          loading={providers.loading}
          onAddHost={() => setAdding(true)}
        />
      ) : (
        <div>
          {pasting ? (
            <Paste onDone={() => setFrom(ALL)} onCancel={() => setFrom(ALL)} />
          ) : (
            <>
              {/* **Through `Rows`.** This read `repos.data` straight and never
                  looked at `repos.error`, so a server answering 503 drew
                  "Nothing imported yet" — a refusal rendered as an empty
                  list, which is the worst of the five possible lies. */}
              <Rows
                /* **The filtered list, not the raw one.** `empty` is what
                   `Rows` draws when its feed has no rows, and the feed was
                   `repos` — so with seven repositories and a query matching
                   none of them the branch below was unreachable and the
                   section drew its heading, its 0, and nothing else. The
                   trouble and the loading are still the request's. */
                feed={{ data: mine, loading: repos.loading, error: repos.error, trouble: repos.trouble }}
                /* **A `Note`, never a `Blank`.** The screen is not empty; one
                   section of it is, and a centred plate here would say the
                   page had failed. Which note is which cause: a typed query,
                   a host the reader narrowed to, or a connected host nothing
                   has been taken from yet.

                   **And with a query, the heading goes with it.** Three
                   headings each reading 0 with a line under them are three
                   lies about one fact, so the count collapses into the one
                   line that names the cause — `Available` below does the same
                   and draws nothing at all. */
                empty={
                  needle ? (
                    /* **The heading goes with it.** Three headings each
                       reading 0 with a line under them are three lies about
                       one fact, so the count collapses into the one line that
                       names the cause — and `Available` below draws nothing
                       at all for the same reason. */
                    <Note
                      icon={Search}
                      control={
                        <button onClick={() => setQ("")} className="btn quiet">
                          Clear
                        </button>
                      }
                    >
                      No repository matches <Typed>{needle}</Typed>.
                    </Note>
                  ) : (
                    <Group
                      title="Checked out"
                      count={0}
                      empty={
                        <Note icon={FolderGit2}>
                          {chosen
                            ? `Nothing imported from ${chosen.label} yet.`
                            : "Nothing imported yet. Take one from the list below."}
                        </Note>
                      }
                    />
                  )
                }
                onRetry={() => void cache.invalidateQueries({ queryKey: getListReposQueryKey() })}
              >
              <Group title="Checked out" count={mine.length}>
                {mine.map((r) => (
                  <div key={r.id}>
                    <button onClick={() => setOpen(open === r.id ? null : r.id)} className="r">
                      <span className="g">
                        <HostMark kind={hostOf(r.slug)?.kind} size={16} />
                      </span>
                      {/* The slug reads at reading size, not in monospace. It
                          is a name, and the mono voice is for what a machine
                          said — see `STYLE.md`'s rule about a branch at rest. */}
                      <span className="tx">
                        <b>{r.slug}</b>
                        {r.setup ? <s>has a setup command</s> : null}
                      </span>
                      <span className="said">{r.defaultBranch ?? "main"}</span>
                      <span className="g">
                        <ChevronDown
                          className={`h-3.5 w-3.5 transition-transform ${open === r.id ? "rotate-180" : "-rotate-90"}`}
                          strokeWidth={2}
                        />
                      </span>
                    </button>
                    {open === r.id && live && <Settings repo={r} onGone={() => setOpen(null)} />}
                  </div>
                ))}
              </Group>
              </Rows>

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

  /* **A query that matched nothing here draws nothing here.** The upper list
     already carries the one line naming the cause; a second heading reading 0
     under it is the same fact said twice, and the second time with a count. A
     host that would not answer still gets its row, because "GitLab did not
     reply" and "nothing matched" are different answers. */
  if (needle && !pending && broken.length === 0 && shown.length === 0) return null;

  return (
    <>
      <Group
        title={`Not imported yet${where}`}
        count={pending ? undefined : all.length}
        note="Importing one makes it available to start a workspace on. Nothing is cloned until a workspace needs it."
      >
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
          <Note icon={FolderGit2}>Everything{where} is imported.</Note>
        )}
        {shown.slice(0, 80).map(({ repo: r, host }) => (
          <div key={`${host.id}:${r.remote}`}>
            <div className="r">
              <span className="g">
                <HostMark kind={host.kind} size={16} />
              </span>
              <span className="tx">
                <b>{r.slug}</b>
                {/* **Which host, across several.** Two hosts can both hold an
                    `acme/web`, and without this the two rows are identical. */}
                {/* Joined rather than concatenated: with no push date the old
                    form left a trailing separator on the row. */}
                <s>{[named ? host.gitHost : null, r.private ? "private" : null, ago(r.pushedAt) || null].filter(Boolean).join(" · ")}</s>
              </span>
              {r.private && <Lock className="h-3 w-3 shrink-0 text-mute" strokeWidth={2} />}
              <button
                disabled={!live || taking !== null}
                onClick={() => void take(r, host)}
                className="btn plain hov"
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
          <p className="py-2 text-ui text-mute">
            {shown.length - 80} more. Narrow it with the find box.
          </p>
        )}
      </Group>
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
        className="btn plain"
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
            {/* **A remote no host can list**, and this is where it lives now.
                It was a link in small print under the empty state's buttons,
                and the empty state is one button and one sentence — so it
                moved to the control that already owns the state it sets and
                already has a word for being in it. It is not a host to filter
                to, which is why it sits under the rule. */}
            <button
              onClick={() => { onPick(PASTE); setOpen(null); }}
              className="flex w-full items-center gap-2.5 border-t border-line px-3 py-2 text-left hover:bg-raise/60"
            >
              <Link2 className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui text-bone">Paste a remote</span>
                <span className="block truncate text-micro text-mute">Anything git can clone.</span>
              </span>
              {pasting && <Check className="h-3.5 w-3.5 shrink-0 text-sage" strokeWidth={2} />}
            </button>
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
            <button disabled={!name || !value || put.isPending} onClick={() => put.mutate({ id: repo.id, data: { variables: [{ name, value }] } }, { onSuccess: () => { setName(""); setValue(""); env.refetch(); } })} className="btn plain">Add</button>
          </div>
        </div>
      </div>
    </div>
  );
}


/* ── Nothing connected yet ─────────────────────────────────────────────── */

/**
 * The page body with nothing in it, and **one action that is the actual next
 * step for the state the screen is in**.
 *
 * One action in every case, but not always the same one. The three host
 * buttons it replaced were doing a real job — the mark is the thing people
 * scan for, and three buttons are the fastest possible first run — so folding
 * them into one is only worth it if the one is *right*. A generic *Add a host*
 * over an install whose `github.com` is already registered and merely needs
 * signing into is both the wrong verb and a dead end, and that is the most
 * common first run there is: the built-in row arrives with every install.
 *
 * So the ladder, in order, and `actionsFor` is the thing that decides each
 * rung — the same function the Git hosts rows are drawn from, so the two
 * screens cannot disagree about what a host needs next:
 *
 *   1. **a registered host merely waiting to be signed into** — the action
 *      connects *that one*, by name. It does not open "What are you
 *      connecting?", because the answer to that question is already known;
 *   2. **a registered host with no application yet** — the action goes where
 *      that is resolved rather than to a sign-in that cannot succeed. And
 *      where this reader may not resolve it, there is no action at all: a
 *      control the server would refuse is worse than the sentence;
 *   3. **nothing registered** — the action opens `AddHost`, whose first step
 *      is the vertical list of *kinds*: GitHub, GitHub Enterprise Server,
 *      GitLab, GitLab self-managed, Gitea or Forgejo, built from `kindInfo`
 *      so a sixth appears on its own. `GitHosts.tsx` argues that list and it
 *      is the argument this screen rests on — the kinds are the only place
 *      the product says what it can talk to, and somebody who has a Forgejo
 *      learns nothing from a row of three brands. Nothing here re-implements
 *      it; a second copy is a second place for it to fall behind the server.
 *
 * The sentence agrees with whichever action is showing. "Add" above a button
 * that says "connect" is the screen contradicting itself in two lines.
 */
function Start({
  hosts,
  loading,
  onAddHost,
}: {
  hosts: ProviderStatus[];
  loading: boolean;
  onAddHost: () => void;
}) {
  /* **A host somebody here added, before the one that ships.** Every install
     has the built-in GitHub whether anybody chose it or not, so where a
     colleague has registered their own GitLab that is what this install is
     actually for — and it is the one worth naming on the button. It is also
     the test for whether anybody has been here before: "a host exists" is not,
     and using it would greet the very first person as though somebody had. */
  const waiting = [...hosts.filter((h) => !h.connected)].sort(
    (a, b) => Number(!!a.builtin) - Number(!!b.builtin),
  );
  const signIn = waiting.find((h) => actionsFor(h).primary === "connect");
  const unready = waiting.find((h) => !h.configured);
  const theirs = waiting.some((h) => !h.builtin);

  if (loading) {
    return (
      <p className="flex items-center gap-2 px-3.5 py-6 text-ui text-mute">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
        Reading your connections…
      </p>
    );
  }

  /* 1. Registered, configured, and waiting for you. */
  if (signIn) return <SignIn host={signIn} theirs={theirs} />;

  /* 2. Registered, and not something anybody can sign into yet. */
  if (unready) {
    return (
      <Blank
        icon={FolderGit2}
        title="No repository yet"
        action={
          actionsFor(unready).primary === "set-up" ? (
            <button
              onClick={() => navigate("/configuration/git-hosts")}
              className="btn primary"
            >
              Set up {unready.label}
            </button>
          ) : undefined
        }
      >
        {actionsFor(unready).primary === "set-up"
          ? `${unready.label} needs an application of its own before anybody can sign in.`
          : `${unready.label} needs an application. An administrator of this Firetower sets that up.`}
      </Blank>
    );
  }

  /* 3. Nothing registered at all. */
  return (
    <Blank
      icon={FolderGit2}
      title="No repository yet"
      action={
        <button onClick={onAddHost} className="btn primary">
          <Icon of={Plus} size={14} />
          Connect a git host
        </button>
      }
    >
      Connect a git host and import what you want to work on.
    </Blank>
  );
}

/**
 * The blank, where the next step is signing into a host that is already here.
 *
 * Its own component because `useConnect` is a hook per host, and the three
 * rungs above it are a choice made before there is a host to give it.
 */
function SignIn({ host, theirs }: { host: ProviderStatus; theirs: boolean }) {
  const connect = useConnect(host);
  return (
    <>
      <Blank
        icon={FolderGit2}
        title="No repository yet"
        action={
          <button disabled={connect.busy} onClick={connect.start} className="btn primary">
            <Icon of={Link2} size={14} />
            Connect {host.label}
          </button>
        }
      >
        {theirs
          ? "Your colleagues added these hosts. You sign in with your own account."
          : "Sign in with your own account, then import what you want to work on."}
      </Blank>
      {connect.node}
    </>
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
          /* A probe that failed does not mean the server will refuse this.
             `create_repo` saves the URL either way — the row *is* a URL, and
             its name and default branch are read the first time a workspace
             clones it — so a fleet that is empty or down used to hard-block a
             save the server would have accepted. */
          disabled={!remote.trim() || create.isPending}
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
          {create.isPending ? "Adding…" : found || probe.isPending ? "Add it" : "Save it anyway"}
        </button>
      </div>
      <div className="mt-1.5 min-h-5 text-meta">
        {probe.isPending && (
          <span className="flex items-center gap-2 text-mute">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            Reaching it…
          </span>
        )}
        {probe.isError && (
          <span className="text-brick">
            {why(probe.error)} Saving it anyway keeps the URL; its name and default branch are read
            the first time a workspace clones it.
          </span>
        )}
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

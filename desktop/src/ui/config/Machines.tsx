/**
 * Machines: where agents run.
 *
 * Adding one is the web's `AddCompute` flow exactly — show the key the machine
 * has to be given, probe the destination with `probe_host`, and on `reached`
 * create the machine. A probe that does not reach says why, with the
 * diagnosis's own remedy. Nothing here installs: the machine's own row does.
 *
 * Each machine's row answers `host_readiness` — ssh, the worker, the agents —
 * with the remedies the server suggests, and the verbs that fix what it can:
 * connect, install the worker, drain, rename, remove.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, Cpu, HardDrive, History, Key, Loader2, Plus, Server as ServerIcon, Trash2, X } from "lucide-react";
import { Icon } from "~/components/ui";
import type { Compute, Diagnosis, Host, RetiredMachine, Session } from "~/api/generated/model";
import {
  getListHostsQueryKey,
  useConnectHost,
  useRetiredHosts,
  useCreateHost,
  useDeleteHost,
  useDrainHost,
  useHostReadiness,
  useInstallWorker,
  useProbeHost,
  useRenameHost,
  useSshKey,
} from "~/api/generated/hosts/hosts";
import { getListAgentsQueryKey, useInstallAgent } from "~/api/generated/agents/agents";
import type { AgentView } from "~/api/generated/model";
import { parseDestination, reachedTheMachine, stateLabel, waitForOnline } from "~/api/environments";
import { useAgents, useHosts, useRepos, useSessions } from "~/data";
import { getListRolesQueryKey, useListRoles, useUpdateRole } from "~/api/generated/roles/roles";
import { STATUS_LABEL } from "~/api/view";
import { toDraft } from "~/ui/config/Roles";
import { navigate, usePathname } from "~/shims/next-navigation";
import { Group, Rows, Section, WhereTo } from "~/ui/config/bits";
import { WhoCanAccess } from "~/ui/Sharing";
import { useMe } from "~/api/generated/auth/auth";
import { useConfirm } from "~/ui/Confirm";
import { useOpened } from "~/ui/opened";

export function Machines({ live, open: asked = null }: { live: boolean; open?: string | null }) {
  const me = useMe();
  const hosts = useHosts();
  /* `/configuration/machines/add` opens straight into the dialog. The three
     machine pickers send people here when the fleet is empty, and landing on a
     screen that says "add one" with the form still shut is one press of
     nothing. */
  const [adding, setAdding] = useState(usePathname().endsWith("/add"));
  /* And `/configuration/machines/h_1` opens that machine — the rail's rows
     name one, so the address has to be able to. */
  const [open, setOpen] = useOpened(asked);

  /* **Nothing added, and nothing wrong** — which is every fresh install, and
     the one state where the page is its own empty state. Two things come off
     the screen while it holds, and both are the general rule rather than a
     Machines quirk: a page's **header action is not drawn over a `Blank`
     whose action is the same action** — a 33px target in the top right corner
     of a page whose only words are 500px away at the optical centre, where
     the blank's button carries the same verb *and* the sentence explaining it
     — and a **`WhereTo` is never drawn beside a `Blank`**. Both come back
     with the first row, so neither is ever on screen beside its double. */
  const blank = !hosts.loading && !hosts.trouble && !hosts.error && hosts.data.length === 0;

  return (
    /* **Machines**, which is what the rail calls it and what the drawing says.
       The page said "Compute" — a category word for the one screen that is
       about a thing you can point at. */
    <>
    <Section
      title="Machines"
      note="Where agents run. One owner per machine, until sessions are isolated from each other."
      settling={hosts.loading}
      trouble={hosts.trouble}
      error={hosts.error}
      action={live && !blank && <button onClick={() => setAdding(true)} className="btn primary"><Icon of={Plus} size={14} />Add a machine</button>}
    >
      <Rows
        feed={hosts}
        icon={ServerIcon}
        empty="No machine yet"
        note="Agents run on a machine you add over ssh. Firetower does not run them on itself."
        action={live ? <button onClick={() => setAdding(true)} className="btn primary"><Icon of={Plus} size={14} />Add a machine</button> : undefined}
      >
      <Group>
        {hosts.data.map((h) => (
          <div key={h.id}>
            <button onClick={() => setOpen(open === h.id ? null : h.id)} className="r">
              <span className="st" data-s={h.state === "Online" ? "ok" : h.state === "Draining" || reachedTheMachine(h) ? "warn" : "bad"} />
              <span className="g">
                <Icon of={ServerIcon} size={16} />
              </span>
              <span className="tx">
                <b>{h.name}</b>
                <s>
                  {[
                    h.cpus != null ? `${h.cpus} vCPU` : null,
                    h.memoryMb != null ? `${Math.round(h.memoryMb / 1024)} GB` : null,
                    h.workerVersion ? `worker ${h.workerVersion}` : "worker not installed",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </s>
              </span>
              {/* A machine is personal until it is shared, so whoever added it
                  shares it — the same as a workspace. Taking one back out of a
                  directory needs admin *there*, which is why the fleet's shared
                  machines cannot be pulled out from under everybody. The chip
                  works out whether this person is one of those; it used to be
                  decided here, and `startsWith("u/")` read somebody else's own
                  space as this person's. */}
              <WhoCanAccess look="chip" kind="machine" id={h.id} path={h.path} />
              {/* Where it is, in the voice an address is written in. */}
              <span className="path">{describe(h.compute)}</span>
              <span className="said">{stateLabel(h)}</span>
              <span className="g">
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open === h.id ? "rotate-180" : "-rotate-90"}`} strokeWidth={2} />
              </span>
            </button>
            {open === h.id && live && <Detail host={h} onGone={() => setOpen(null)} />}
          </div>
        ))}
      </Group>
      </Rows>
      {adding && <Add onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); setOpen(id); }} />}

      {!blank && (
        <WhereTo>
          A machine that is <b>not answering keeps its workspaces</b> until it comes back.
          Draining stops new work without ending what is running.
        </WhereTo>
      )}
    </Section>
    <Removed />
    </>
  );
}

/** Where it is, which is all a machine's second line ever was. */
function describe(c: Compute): string {
  if (c.type !== "Server") return "";
  return `${c.user ? `${c.user}@` : ""}${c.host}${c.port ? `:${c.port}` : ""}`;
}

/**
 * The machine that is gone: what is left to do about it, and what happened on
 * it.
 *
 * **Two registers, with a rule between them.** Above it, the two things
 * somebody can actually finish — a repository connected by a path that only
 * existed on that machine, a profile pinned to it — and only those are
 * counted. Below it, the record of what ran there: stated, never offered, with
 * no verb but *read*. They were one count in an earlier draft, and putting the
 * sessions in it made them read as the third chore on a list, which invites
 * somebody to go looking for the verb that clears them. There is not one, and
 * there must not appear to be: ending those sessions is what would delete the
 * conversation.
 *
 * Only the chores hold the notice open — it can be dismissed, and goes by
 * itself when they are done. The record is permanent, so it also sits as a
 * line under the card that no dismissal touches.
 *
 * Every count here is worked out in the client. The machine is absent from
 * `listHosts` while `useSessions` still returns its sessions, which is the
 * whole predicate; nothing new is asked of the server, and nothing about those
 * rows is changed to make the screen easier to draw.
 */
function Removed() {
  const machines = useRetiredHosts().data ?? [];
  if (machines.length === 0) return null;
  return (
    <>
      {machines.map((m) => (
        <WasHere key={m.id} machine={m} />
      ))}
    </>
  );
}

/**
 * Which copy of the session list is open, if either.
 *
 * There are two controls for one list — one in the notice, one on the line
 * under the card — because the notice is the explanation and the line is the
 * route, and the line has to survive the notice being dismissed. Holding
 * *where* it is open rather than *whether* means the list is drawn under
 * whichever control was pressed: never twice, and never nowhere.
 *
 * It was a boolean, with the copy under the line gated on there being no
 * chores left. That is the state QA found: chores outstanding and the notice
 * dismissed, so neither copy drew and the line's control toggled nothing.
 */
export type Listing = "notice" | "foot" | null;

export function toggled(open: Listing, pressed: Exclude<Listing, null>): Listing {
  return open === pressed ? null : pressed;
}

function WasHere({ machine }: { machine: RetiredMachine }) {
  const sessions = useSessions();
  const repos = useRepos();
  const profiles = useListRoles();
  const cache = useQueryClient();
  const unpin = useUpdateRole();
  const [detail, setDetail] = useState(false);
  const [listing, setListing] = useState<Listing>(null);
  /* Dismissed on this Mac, per machine. The server is not told: this is
     somebody saying "I have read it", and it is the notice they are hiding
     rather than anything about the machine. */
  const key = `firetower.removed.${machine.id}`;
  const [hidden, setHidden] = useState(() => localStorage.getItem(key) === "1");

  const ran = sessions.data.filter((s) => s.hostId === machine.id);
  /* A path is read on the machine that does the cloning, and that machine is
     gone — so these are connected to nowhere until they are given a remote or
     the machine holding the path is added. Which machine a path was meant for
     is not recorded anywhere, so this is every path repository rather than
     only that machine's. */
  const paths = repos.data.filter((r) => /^[/.~]/.test(r.remote));
  const pinned = (profiles.data ?? []).filter((p) => p.machine === machine.id);
  const chores = paths.length + pinned.length;

  const unpinIt = (id: string) => {
    const profile = (profiles.data ?? []).find((p) => p.id === id);
    if (!profile) return;
    unpin.mutate(
      { id, data: { ...toDraft(profile), machine: null } },
      { onSuccess: () => cache.invalidateQueries({ queryKey: getListRolesQueryKey() }) },
    );
  };

  return (
    <>
      {/* The chores are what keep it on screen. With none left there is
          nothing to do about this machine and the line below is the whole of
          what is still true. */}
      {chores > 0 && !hidden && (
        <div className="mt-2 rounded-xl border border-kind-data/40 bg-ground px-4 py-3.5">
          <p className="text-ui text-bone">Firetower no longer runs agents on itself</p>
          <p className="mt-1 text-meta leading-relaxed text-dim">
            The machine called <span className="font-mono text-mute">{machine.name}</span> was the
            control plane&rsquo;s own process. An agent started there ran inside Firetower&rsquo;s
            container — its filesystem, its environment, its database — so that machine has been
            removed. Agents now run only on machines you add over ssh.
          </p>
          <p className="mt-2 text-meta text-bone">
            {[
              paths.length > 0 && `${paths.length} ${paths.length === 1 ? "repository" : "repositories"}`,
              pinned.length > 0 && `${pinned.length} ${pinned.length === 1 ? "profile" : "profiles"}`,
            ]
              .filter(Boolean)
              .join(" and ")}{" "}
            still {chores === 1 ? "points" : "point"} at it.
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              onClick={() => navigate("/configuration/machines/add")}
              className="control border border-line bg-raise text-ui text-bone hover:bg-overlay"
            >
              <Icon of={Plus} size={12} />Add a machine
            </button>
            <button onClick={() => setDetail(!detail)} className="control text-dim hover:text-bone">
              {detail ? "Hide the detail" : "Show what pointed at it"}
            </button>
            <button
              onClick={() => {
                localStorage.setItem(key, "1");
                setHidden(true);
              }}
              className="control ml-auto text-mute hover:text-bone"
            >
              Hide this
            </button>
          </div>

          {detail && (
            <div className="mt-3 space-y-3 border-t border-line-soft pt-3">
              {paths.length > 0 && (
                <div>
                  {/* Not an ALL-CAPS eyebrow. Nothing in the desk's type scale
                      is uppercased, and these two were hand-rolled rather than
                      `.eyebrow`, so neither grep that retired the class found
                      them. */}
                  <p className="text-meta text-dim">
                    Repositories connected by a path on that machine — {paths.length}
                  </p>
                  <div className="mt-1.5 space-y-1">
                    {paths.map((r) => (
                      <div key={r.id} className="flex items-center gap-2 rounded-md bg-panel px-2.5 py-1.5">
                        <span className="min-w-0 flex-1 truncate text-ui text-bone">{r.slug}</span>
                        <span className="min-w-0 truncate font-mono text-micro text-mute">{r.remote}</span>
                        <button
                          onClick={() => navigate("/configuration/repositories")}
                          className="control shrink-0 text-dim hover:text-bone"
                        >
                          Connect by URL instead
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="mt-1.5 text-micro leading-relaxed text-mute">
                    A path only means something on the machine that does the cloning. Give it a
                    remote, or add the machine the path is on and connect it there.
                  </p>
                </div>
              )}

              {pinned.length > 0 && (
                <div>
                  <p className="text-meta text-dim">
                    Profiles pinned to that machine — {pinned.length}
                  </p>
                  <div className="mt-1.5 space-y-1">
                    {pinned.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 rounded-md bg-panel px-2.5 py-1.5">
                        <span className="min-w-0 flex-1 truncate text-ui text-bone">{p.name}</span>
                        <span className="min-w-0 truncate text-micro text-mute">{p.does}</span>
                        <button
                          disabled={unpin.isPending}
                          onClick={() => unpinIt(p.id)}
                          className="control shrink-0 text-dim hover:text-bone disabled:text-mute"
                        >
                          Unpin
                        </button>
                        <button
                          onClick={() => navigate("/configuration/roles")}
                          className="control shrink-0 text-mute hover:text-bone"
                        >
                          Open the profile
                        </button>
                      </div>
                    ))}
                  </div>
                  {/* **What unpinning actually leaves.** The sentence here used
                      to say "a profile runs wherever the workspace that uses it
                      runs", which describes `placement: here` — and every
                      profile that can appear in this list has a machine, so it
                      was never true of one. Unpinned, the machine is an open
                      question: the lead may answer it, and Firetower answers it
                      otherwise. "Any machine" is the phrase the Profiles list
                      uses for the same state, so the two screens agree. */}
                  <p className="mt-1.5 max-w-[52ch] text-meta leading-relaxed text-dim">
                    Unpinned, a profile takes <b className="font-medium text-bone">any machine</b>:
                    the lead may name one, and Firetower picks if it does not. Pin it again from
                    the profile if it needs a particular one.
                  </p>
                  {unpin.isError && <p className="mt-1 text-micro text-brick">{unpin.error.message}</p>}
                </div>
              )}
            </div>
          )}

          {/* Below the rule, and on `ground` rather than `panel`, with no verb
              on any row: the block reads as a different kind of thing before a
              word of it is read. */}
          {ran.length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-ui text-bone">The work that was running there</p>
              <p className="mt-1 text-meta leading-relaxed text-dim">
                {ran.length === 1 ? "1 session was" : `${ran.length} sessions were`} running on it.
                They are not running now, and there is no machine to open them on — so they cannot
                be picked up again.
              </p>
              <p className="mt-1.5 text-meta leading-relaxed text-dim">
                Nothing ended them and nothing was cleaned up, so they still show a running status.
                Changing it would take the conversation with it, and that conversation is the record
                of what ran in that container.
              </p>
              <p className="mt-1.5 text-meta leading-relaxed text-dim">
                All of it is readable, and stays readable. Their worktrees are still where the worker
                left them — <span className="font-mono text-mute">/var/lib/firetower/worker/worktrees</span>{" "}
                in the Docker deployment — and Firetower has no route to them any more, so anything
                wanted out of one is fetched there by hand.
              </p>
              <button
                onClick={() => setListing(toggled(listing, "notice"))}
                className="control mt-2 text-dim hover:text-bone"
              >
                {listing === "notice" ? "Hide what was running" : "Show what was running"}
              </button>
              {listing === "notice" && <Ran sessions={ran} />}
            </div>
          )}
        </div>
      )}

      {/* The route in, which no dismissal touches. Not a banner: one line in
          the register the note above the card already uses. It renders for as
          long as those sessions exist, which is for good — the count going to
          zero would mean the record had been deleted. */}
      {ran.length > 0 && (
        <p className="mt-2 text-meta text-mute">
          {ran.length === 1 ? "1 session ran" : `${ran.length} sessions ran`} on{" "}
          {machine.name === "localhost" ? "Firetower's own machine" : machine.name} before it was
          removed. They can be read; they cannot be picked up again.{" "}
          <button
            onClick={() => setListing(toggled(listing, "foot"))}
            className="underline decoration-line underline-offset-2 hover:text-dim"
          >
            {listing === "foot" ? "Hide them" : "Show them"}
          </button>
        </p>
      )}
      {/* One comparison, and nothing else. This was gated on `chores === 0` as
          well — a guard against drawing the list twice — which meant that
          dismissing a notice with chores still in it left this control
          toggling a list nothing drew. Whatever else is on screen, the list
          belongs under the control that was pressed. */}
      {listing === "foot" && <Ran sessions={ran} />}
    </>
  );
}

/**
 * The sessions that ran there, as a list that opens them and does nothing
 * else.
 *
 * **No `Signal` dot.** Its colour comes from `BEAT`, and `Working` is a slate
 * dot with the breathe animation on it — a dot literally pulsing to say an
 * agent is mid-task, drawn under a paragraph explaining that nothing is
 * running. So: a dead dot, and the recorded status quoted beside it. A chip
 * that looks like a quotation is read as one, and it is worth showing rather
 * than hiding, because that same string is on the row in the rail.
 */
function Ran({ sessions }: { sessions: Session[] }) {
  return (
    <div className="mt-2 space-y-1">
      {sessions.map((s) => (
        <button
          key={s.id}
          onClick={() => navigate(`/sessions/${s.workspaceId ?? s.id}`)}
          className="flex w-full items-center gap-2 rounded-md bg-panel px-2.5 py-1.5 text-left hover:bg-raise"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-mute" />
          <span className="min-w-0 flex-1 truncate text-ui text-bone">{s.title}</span>
          {s.branch && <span className="min-w-0 truncate font-mono text-micro text-mute">{s.branch}</span>}
          <span className="stale shrink-0 rounded border border-line px-1.5 font-mono text-micro text-dim">
            still says {STATUS_LABEL[s.status]}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ── One machine ───────────────────────────────────────────────────────── */

function Detail({ host, onGone }: { host: Host; onGone: () => void }) {
  const confirm = useConfirm();
  const cache = useQueryClient();
  const readiness = useHostReadiness(host.id, undefined, { query: { staleTime: 10_000 } });
  const connect = useConnectHost();
  const install = useInstallWorker();
  const drain = useDrainHost();
  const rename = useRenameHost();
  const remove = useDeleteHost();
  const [name, setName] = useState(host.name);
  const [settling, setSettling] = useState(false);
  /* The agents, from what the Agents screen already records per host. "Ready"
     is about the machine; which agents can start is its own line, because a
     green panel that then refuses to launch Claude Code is worse than a red
     one. */
  const agents = useAgents();
  const installAgent = useInstallAgent();
  const [fetching, setFetching] = useState<string | null>(null);
  const offered = agents.data.filter((a) => a.enabled && a.supported);
  const onThis = (a: AgentView) => a.hosts.find((h) => h.hostId === host.id);
  const toInstall = offered.filter((a) => !onThis(a)?.installed).length;
  const fetchAgent = async (a: AgentView) => {
    setFetching(a.kind);
    try {
      await installAgent.mutateAsync({ kind: a.kind, data: { hostId: host.id } });
      await cache.invalidateQueries({ queryKey: getListAgentsQueryKey() });
      await readiness.refetch();
    } finally {
      setFetching(null);
    }
  };
  const refresh = () => Promise.all([cache.invalidateQueries({ queryKey: getListHostsQueryKey() }), readiness.refetch()]);
  // The install returns when the binary is there; the machine answers a few
  // seconds later. Wait for that, so the panel turns green on its own.
  const installed = async () => {
    setSettling(true);
    await waitForOnline(host.id);
    setSettling(false);
    await refresh();
  };

  const checks = readiness.data?.checks ?? [];
  const missing = checks.filter((c) => c.required && !c.available);

  return (
    <div className="space-y-3 border-t border-line-soft bg-ground/40 px-3.5 py-3">
      {/* The rows below say it when ssh got in; the box is for when it did not. */}
      {host.diagnosis && host.state !== "Online" && !reachedTheMachine(host) && <Told d={host.diagnosis} />}

      <div>
        <div className="flex items-center gap-2">
          <span className="text-meta text-dim">{readiness.isPending ? "Checking…" : missing.length === 0 && checks.length > 0 ? `Ready${toInstall > 0 ? ` · ${toInstall} agent${toInstall === 1 ? "" : "s"} to install` : ""}` : `${missing.length} thing${missing.length === 1 ? "" : "s"} missing`}</span>
          {readiness.data?.user && <span className="font-mono text-micro text-mute">as {readiness.data.user}</span>}
          <button onClick={() => readiness.refetch()} className="ml-auto text-micro text-mute hover:text-bone">check again</button>
        </div>
        <div className="mt-1.5 space-y-1">
          {checks.map((c) => (
            <div key={c.name} className="rounded-md bg-ground px-2.5 py-1.5">
              <div className="flex items-center gap-2 text-ui">
                {c.available ? <Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} /> : <X className={`h-3.5 w-3.5 ${c.required ? "text-brick" : "text-mute"}`} strokeWidth={2} />}
                <span className={c.available ? "text-text" : c.required ? "text-bone" : "text-dim"}>{c.name}</span>
                <span className="min-w-0 truncate text-meta text-mute">{c.detail}</span>
              </div>
              {!c.available && c.remedy && c.name !== "Worker" && (
                <div className="mt-1 flex items-center gap-2 pl-5">
                  <code className="min-w-0 flex-1 truncate font-mono text-micro text-dim">{c.remedy}</code>
                  {/^\S+( \S+)+$/.test(c.remedy) && <button onClick={() => navigator.clipboard?.writeText(c.remedy!)} className="text-mute hover:text-bone"><Copy className="h-3 w-3" strokeWidth={1.75} /></button>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {host.state === "Online" && offered.length > 0 && (
        <div>
          <p className="legend">Agents</p>
          <div className="mt-1.5 space-y-1">
            {offered.map((a) => {
              const here = onThis(a);
              return (
                <div key={a.kind} className="flex items-center gap-2 rounded-md bg-ground px-2.5 py-1.5 text-ui">
                  {here?.installed ? <Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} /> : <X className="h-3.5 w-3.5 text-brick" strokeWidth={2} />}
                  <span className={here?.installed ? "text-text" : "text-bone"}>{a.label}</span>
                  <span className="min-w-0 truncate text-meta text-mute">{here?.installed ? (here.version ?? "installed") : "not installed"}</span>
                  {!here?.installed && (
                    <button disabled={fetching !== null} onClick={() => fetchAgent(a)} className="control ml-auto border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">{fetching === a.kind ? "Fetching…" : "Install"}</button>
                  )}
                </div>
              );
            })}
          </div>
          {installAgent.isError && <p className="mt-1 text-meta text-brick">{installAgent.error.message}</p>}
        </div>
      )}

      {checks.some((c) => c.name === "Worker" && !c.available && c.remedy) && (
        <details className="text-meta text-mute">
          <summary className="cursor-pointer hover:text-bone">Or do it on the machine yourself</summary>
          <code className="mt-1.5 block break-all rounded-md bg-ground px-2.5 py-1.5 font-mono text-micro text-dim">{checks.find((c) => c.name === "Worker")?.remedy}</code>
        </details>
      )}
      {missing.some((c) => c.name !== "Worker" && /^(sudo |brew |apt|dnf|yum|pacman|apk|zypper)/.test(c.remedy ?? "")) && (
        <p className="text-meta text-mute">Run that on the machine, then check again. Firetower does not run sudo for you.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button disabled={connect.isPending} onClick={() => connect.mutate({ id: host.id }, { onSuccess: refresh })} className="btn plain">{connect.isPending ? "Connecting…" : "Connect"}</button>
        <button disabled={install.isPending || settling} onClick={() => install.mutate({ id: host.id }, { onSuccess: installed })} className="btn plain">{install.isPending ? "Installing…" : settling ? "Reconnecting…" : host.workerVersion ? "Reinstall the worker" : "Install the worker"}</button>
        {install.isError && <span className="text-meta text-brick">{install.error.message}</span>}
        <button disabled={drain.isPending} onClick={() => drain.mutate({ id: host.id, data: { drained: !host.drained } }, { onSuccess: refresh })} className="btn plain">{host.drained ? "Take new work" : "Drain"}</button>
        <button onClick={() => void confirm({ title: `Remove ${host.name}?`, body: "Nothing on the machine is touched.", action: "Remove", tone: "danger" }).then((ok) => ok && remove.mutate({ id: host.id, params: undefined as never }, { onSuccess: () => { refresh(); onGone(); } }))} className="control ml-auto text-mute hover:text-brick"><Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />Remove</button>
      </div>

      <div className="flex items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 text-ui text-bone focus:outline-none" />
        <button disabled={!name.trim() || name === host.name || rename.isPending} onClick={() => rename.mutate({ id: host.id, data: { name: name.trim() } }, { onSuccess: refresh })} className="btn plain">Rename</button>
      </div>
    </div>
  );
}

function Told({ d }: { d: Diagnosis }) {
  return (
    <div className="rounded-lg border border-brick-deep bg-brick-tint px-3 py-2.5">
      <p className="text-ui text-bone">{d.summary}</p>
      {d.detail && <p className="mt-1 font-mono text-micro text-brick">{d.detail}</p>}
      {d.remedy && <p className="mt-1 text-meta text-dim">{d.remedy}</p>}
    </div>
  );
}

/* ── Adding one ────────────────────────────────────────────────────────── */

function Add({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const cache = useQueryClient();
  const create = useCreateHost();
  const probe = useProbeHost();
  const installWorker = useInstallWorker();
  const key = useSshKey();
  /* The machine, once it is saved and ssh got in but found no worker: the
     dialog turns into that next step rather than closing onto a row that
     looks broken. */
  const [made, setMade] = useState<{ host: Host; remedy?: string } | null>(null);
  const [settling, setSettling] = useState(false);
  /* Once the worker answers, one more step: which agents the machine should
     run, so it is launchable when this closes. */
  const [stage, setStage] = useState<"worker" | "agents">("worker");
  const agents = useAgents();
  const installAgent = useInstallAgent();
  const [fetched, setFetched] = useState<Record<string, "fetching" | "done" | string>>({});
  const fetchAgent = async (a: AgentView) => {
    if (!made) return;
    setFetched((f) => ({ ...f, [a.kind]: "fetching" }));
    try {
      await installAgent.mutateAsync({ kind: a.kind, data: { hostId: made.host.id } });
      setFetched((f) => ({ ...f, [a.kind]: "done" }));
    } catch (e) {
      setFetched((f) => ({ ...f, [a.kind]: (e as Error).message }));
    }
    await cache.invalidateQueries({ queryKey: getListAgentsQueryKey() });
  };
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("");
  const [label, setLabel] = useState("");
  const [told, setTold] = useState<Diagnosis | null>(null);
  const [copied, setCopied] = useState(false);

  const typed = parseDestination(address);
  const busy = create.isPending || probe.isPending || installWorker.isPending || settling;

  const body = () => ({
    name: label.trim() || undefined,
    compute: { type: "Server", host: address.trim(), user: user.trim() || undefined, key: { type: "Managed" } } as Compute,
  });

  const save = async (needsWorker: Diagnosis | null) => {
    const host = await create.mutateAsync({ data: body() });
    await cache.invalidateQueries({ queryKey: getListHostsQueryKey() });
    if (needsWorker) setMade({ host, remedy: needsWorker.remedy ?? undefined });
    else onAdded(host.id);
  };

  const add = () => {
    setTold(null);
    probe.mutate({ data: body() }, {
      onSuccess: (r) => {
        if (!r.reached) return setTold(r.diagnosis ?? null);
        save(r.diagnosis?.cause === "WorkerMissing" ? r.diagnosis : null);
      },
    });
  };

  const install = async () => {
    if (!made) return;
    await installWorker.mutateAsync({ id: made.host.id });
    setSettling(true);
    const online = await waitForOnline(made.host.id);
    setSettling(false);
    await cache.invalidateQueries({ queryKey: getListHostsQueryKey() });
    if (online) setStage("agents");
    else onAdded(made.host.id);
  };

  const pub = (key.data as { publicKey?: string } | undefined)?.publicKey;
  const copy = () => {
    navigator.clipboard?.writeText(pub ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim py-[8vh] backdrop-blur-[3px]" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-[36rem] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--shadow-float)">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-title text-bone">Add a machine</h2>
          <button onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"><X className="h-4 w-4" strokeWidth={1.75} /></button>
        </div>

        {made && stage === "agents" ? (
          <div className="space-y-3 px-5 py-4">
            <p className="flex items-center gap-2 text-ui text-bone"><Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} />Connected to {made.host.name}. The worker is installed.</p>
            <p className="text-meta text-mute">Which agents should this machine run? Each is fetched onto the machine as the standalone binary its publisher ships; nothing else is needed for it.</p>
            <div className="flex flex-wrap gap-2">
              {agents.data.filter((a) => a.enabled && a.supported).map((a) => (
                <button key={a.kind} disabled={fetched[a.kind] === "fetching" || fetched[a.kind] === "done"} onClick={() => fetchAgent(a)} className="btn plain">
                  {fetched[a.kind] === "done" ? <Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} /> : <Icon of={Plus} size={12} />}
                  {fetched[a.kind] === "fetching" ? `Fetching ${a.label}…` : fetched[a.kind] === "done" ? a.label : `Install ${a.label}`}
                </button>
              ))}
            </div>
            {Object.entries(fetched).filter(([, v]) => v !== "fetching" && v !== "done").map(([k, v]) => <p key={k} className="text-meta text-brick">{v}</p>)}
          </div>
        ) : made ? (
          <div className="space-y-3 px-5 py-4">
            <p className="flex items-center gap-2 text-ui text-bone"><Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} />Connected to {made.host.name} as {(made.host.compute.type === "Server" && made.host.compute.user) || "the ssh account"}.</p>
            <p className="flex items-center gap-2 text-ui text-bone"><X className="h-3.5 w-3.5 text-brick" strokeWidth={2} />There is no worker on it yet.</p>
            <p className="text-meta text-mute">Firetower puts the worker built for that machine into <code className="font-mono">~/.firetower/worker/bin</code> over the connection it just made. No sudo, nothing outside that account's home. Anything else the machine is missing is shown afterwards, with the command that installs it.</p>
            {made.remedy && (
              <details className="text-meta text-mute">
                <summary className="cursor-pointer hover:text-bone">Or do it on the machine yourself</summary>
                <code className="mt-1.5 block break-all rounded-md bg-ground px-2.5 py-1.5 font-mono text-micro text-dim">{made.remedy}</code>
              </details>
            )}
            {installWorker.isError && <p className="text-meta text-brick">{installWorker.error.message}</p>}
          </div>
        ) : (
        <div className="space-y-4 px-5 py-4">
          <Field label="IP address or hostname"><input autoFocus value={address} onChange={(e) => { setTold(null); setAddress(e.target.value); }} placeholder="192.0.2.10" spellCheck={false} className="w-full rounded-lg border border-line bg-ground px-3 py-2 font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="SSH account"><input value={user} onChange={(e) => setUser(e.target.value)} placeholder={typed.user || "editor"} className="w-full rounded-lg border border-line bg-ground px-3 py-2 font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" /></Field>
            <Field label="Name"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={typed.host || "video-vm"} className="w-full rounded-lg border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" /></Field>
          </div>
          <div className="rounded-lg border border-line bg-ground p-3">
            <div className="flex items-center gap-2 text-ui text-dim"><Key className="h-3.5 w-3.5" strokeWidth={1.75} />Firetower gets in with this key</div>
            {key.isPending ? <p className="mt-1.5 flex items-center gap-2 text-meta text-mute"><Loader2 className="h-3 w-3 animate-spin" />Reading the key…</p> : (
              <div className="mt-2 flex items-start gap-2">
                <code className="scroll-slim min-w-0 flex-1 overflow-x-auto rounded-md bg-panel px-2.5 py-1.5 font-mono text-micro whitespace-nowrap text-dim">{pub ?? JSON.stringify(key.data)}</code>
                <button onClick={copy} className="btn plain">{copied ? <Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />}</button>
              </div>
            )}
            <p className="mt-2 text-meta text-mute">Give it to the machine the way that machine takes keys: <code className="font-mono">~/.ssh/authorized_keys</code> of the account above on a machine you own; the provider's console, instance metadata or OS Login on Google Cloud; the CA where there is one. It is public — safe anywhere.</p>
            <details className="mt-2 text-meta text-mute">
              <summary className="cursor-pointer hover:text-bone">Adding it to authorized_keys by hand, logged in as that account</summary>
              <pre className="mt-1.5 overflow-x-auto rounded-md bg-panel px-2.5 py-1.5 font-mono text-micro text-dim">{authorizedKeys(pub ?? "…")}</pre>
            </details>
          </div>

          {told && <Told d={told} />}
        </div>
        )}

        <div className="flex items-center gap-2 border-t border-line bg-ground/40 px-5 py-3">
          {made && stage === "agents" ? (
            <button onClick={() => onAdded(made.host.id)} disabled={Object.values(fetched).includes("fetching")} className="control ml-auto bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">Done</button>
          ) : made ? (
            <>
              <button onClick={() => onAdded(made.host.id)} disabled={busy} className="control ml-auto text-mute hover:bg-raise hover:text-bone disabled:text-mute">Later</button>
              <button disabled={busy} onClick={install} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">{installWorker.isPending ? "Installing…" : settling ? "Reconnecting…" : "Install the worker"}</button>
            </>
          ) : (
            <>
              <button onClick={onClose} className="control ml-auto text-mute hover:bg-raise hover:text-bone">Cancel</button>
              <button disabled={!typed.host || busy} onClick={add} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">{probe.isPending ? "Reaching it…" : create.isPending ? "Adding…" : "Add it"}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The lines for whoever adds the key on the machine itself, run as the
 * account Firetower will connect as — `~` is that account's home, wherever
 * the machine keeps it (`/home` on Linux, `/Users` on a Mac, somewhere else
 * entirely under LDAP). Guessing the path was wrong on every Mac.
 *
 * `mkdir` and both `chmod`s are not padding: sshd ignores an `authorized_keys`
 * it considers too permissive, without saying so, and a fresh machine often
 * has no `~/.ssh` at all.
 */
function authorizedKeys(key: string) {
  return [
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
    `printf '%s\\n' '${key}' >> ~/.ssh/authorized_keys`,
    "chmod 600 ~/.ssh/authorized_keys",
  ].join("\n");
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-2"><span className="text-ui text-dim">{label}</span>{hint && <span className="text-meta text-mute">{hint}</span>}</span>
      {children}
    </label>
  );
}

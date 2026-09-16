/**
 * Starting work.
 *
 * A workspace is a checkout on a machine with agents in it, so the form has to
 * ask for all three — and the contract is `NewSession`, not what seems like
 * enough. An earlier version of this asked for a name, one repository, a branch
 * and a first message, which is a plausible-looking form that cannot express
 * half of what a workspace is: several repositories cut at different bases,
 * which machine, whose subscription, and
 * how it competes for that machine when other agents are already on it.
 *
 * The UI is this client's own. The fields, their meaning and the payload are
 * the web build's, because there is one control plane and it has one idea of
 * what starting work means.
 *
 * **No prompt is sent, ever** — including from a task. The agent starts and
 * waits; what you want doing is said in the conversation, where it can be
 * answered. A task seeds the composer instead, unsent.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, GitBranch, Plus, Search, Server, X } from "lucide-react";
import { GithubMark, Icon } from "~/components/ui";
import { AgentMark } from "~/components/AgentMark";
import { canRun, resolve, type Where } from "~/components/WhereItRuns";
import { Readout, isReady } from "~/components/HostReadiness";
import { useHostReadiness } from "~/api/generated/hosts/hosts";
import { machineLabel, machines } from "~/api/environments";
import type { Agent, Share } from "~/api/generated/model";
import { useCreateSession } from "~/api/generated/sessions/sessions";
import { useAccounts, useAgents, useHosts, useRepos } from "~/data";
import type { Backend } from "~/fleet";
import { navigate } from "~/shims/next-navigation";
import { leaveDraft } from "~/workspace/draft";
import { isMac } from "~/platform";

export type Seed = {
  title?: string;
  repo?: string;
  issue?: string;
  taskKey?: string;
  taskUrl?: string;
  /** Another agent in an existing workspace rather than a new one. */
  workspaceId?: string;
};

type Checkout = { id: string; slug: string; base?: string };

/** `auth refactor` → `agent/auth-refactor`, the way the web build suggests one. */
const slug = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const SHARES: { share: Share; label: string; verb: string }[] = [
  { share: "yields" as Share, label: "Yields", verb: "Waits for the others." },
  { share: "equal" as Share, label: "Equal share", verb: "Takes its turn." },
  { share: "takesMore" as Share, label: "Takes more", verb: "Goes first." },
];

export function NewWorkspace({
  backend,
  seed,
  onClose,
}: {
  backend: Backend;
  seed?: Seed;
  onClose: () => void;
}) {
  const { data: repos, loading: findingRepos } = useRepos();
  const { data: hosts } = useHosts();
  const { data: agents } = useAgents();
  const { data: accounts } = useAccounts();
  const create = useCreateSession();

  const [name, setName] = useState(seed?.title ?? "");
  const [checkouts, setCheckouts] = useState<Checkout[]>([]);
  const [branch, setBranch] = useState("");
  const [typed, setTyped] = useState(false);
  const [where, setWhere] = useState<Where>({ machine: "", hostId: "", agent: "" });
  const [accountId, setAccountId] = useState("");
  const [share, setShare] = useState<Share>("equal" as Share);
  const [adding, setAdding] = useState(false);

  /* A task names a repository; the id it maps to is only knowable once the
     server has answered. */
  useEffect(() => {
    if (checkouts.length > 0 || repos.length === 0) return;
    const wanted = seed?.repo ? repos.find((r) => r.slug === seed.repo) : undefined;
    if (wanted) setCheckouts([{ id: wanted.id, slug: wanted.slug }]);
  }, [repos, seed?.repo, checkouts.length]);

  const all = useMemo(() => machines(hosts), [hosts]);
  const { host } = useMemo(() => resolve(hosts, where), [hosts, where]);

  const runsHere = (kind: Agent) => {
    const a = agents.find((x) => x.kind === kind);
    return !!a && !!host && canRun(a, host.id);
  };
  const kind = (where.agent || agents.find((a) => host && canRun(a, host.id))?.kind || agents[0]?.kind) as
    | Agent
    | undefined;

  const mine = accounts.filter(
    (a) => a.kind === kind && a.enabled && a.state === "connected",
  );

  const suggested = name ? `agent/${slug(name)}` : "";
  const shown = typed ? branch : suggested;
  // The same readout the panel shows, for this machine and this agent, so a
  // missing agent is an Install button here and not a refusal after Start.
  const readiness = useHostReadiness(host?.id ?? "", { agent: kind }, { query: { enabled: !!host && !!kind, retry: false, staleTime: 5000 } });
  const ready = !!name.trim() && checkouts.length > 0 && !!host && !!kind && isReady(readiness.data) && !create.isPending;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const go = () => {
    if (!ready || !kind) return;
    create.mutate(
      {
        data: {
          name: name.trim(),
          taskKey: seed?.taskKey,
          taskUrl: seed?.taskUrl,
          workspaceId: seed?.workspaceId as never,
          repos: checkouts.map((c) => ({ repoId: c.id, base: c.base })),
          agent: kind,
          accountId: mine.find((a) => a.id === accountId)?.id,
          branch: shown.trim() || undefined,
          hostId: host?.id,
          share,
        },
      },
      {
        onSuccess: (made) => {
          onClose();
          const session = made as { id: string; workspaceId?: string | null };
          // The issue lands in the composer, unsent. Add "let's plan this
          // before touching anything", delete half of it, or send it unchanged.
          if (seed?.taskUrl) leaveDraft(session.id, `${seed.title ?? ""}\n${seed.taskUrl}`.trim());
          navigate(`/sessions/${session.workspaceId ?? session.id}`);
        },
      },
    );
  };

  const unpicked = repos.filter((r) => !checkouts.some((c) => c.id === r.id));
  /* The list of repositories: fixed to the window rather than to the sheet,
     because the sheet clips what leaves it, and a list of ten repositories
     leaves it. Filtered as you type; ↵ takes the first match. */
  const [wanted, setWanted] = useState("");
  const addAt = useRef<HTMLButtonElement>(null);
  const [listAt, setListAt] = useState<{ left: number; top: number } | null>(null);
  const openList = () => {
    const r = addAt.current?.getBoundingClientRect();
    if (r) setListAt({ left: Math.min(r.left, window.innerWidth - 22 * 16 - 12), top: r.bottom + 6 });
    setWanted("");
    setAdding(!adding);
  };
  const needle = wanted.trim().toLowerCase();
  const offered = needle ? unpicked.filter((r) => r.slug.toLowerCase().includes(needle)) : unpicked;
  const take = (r: (typeof repos)[number]) => {
    setCheckouts((held) => [...held, { id: r.id, slug: r.slug }]);
    setAdding(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ground/70 py-[7vh] backdrop-blur-[3px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[38rem] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--shadow-float)"
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-title text-bone">{seed?.workspaceId ? "Another agent" : "New workspace"}</h2>
          {seed?.issue && (
            <span className="rounded-md border border-line bg-raise px-2 py-0.5 font-mono text-micro text-dim">
              {seed.issue}
            </span>
          )}
          <button
            onClick={onClose}
            className="ml-auto grid h-7 w-7 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-bone"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <Field label="Name" hint="What this branch is for">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="auth refactor"
              className="w-full rounded-lg border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none"
            />
          </Field>

          <Field
            label="Repository"
            hint={checkouts.length > 1 ? "One branch, cut in each" : undefined}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {checkouts.map((c) => (
                <Chip
                  key={c.id}
                  checkout={c}
                  onBase={(base) =>
                    setCheckouts((held) => held.map((h) => (h.id === c.id ? { ...h, base } : h)))
                  }
                  onRemove={() => setCheckouts((held) => held.filter((h) => h.id !== c.id))}
                />
              ))}

              <div className="relative">
                <button
                  ref={addAt}
                  onClick={openList}
                  className="control border border-dashed border-line-soft text-mute hover:bg-raise hover:text-bone"
                >
                  {checkouts.length === 0 ? "Choose a repository" : "+ another"}
                </button>

                {adding && listAt && (
                  <>
                    <button className="fixed inset-0 z-[60] cursor-default" onClick={() => setAdding(false)} />
                    <div style={listAt} className="fixed z-[70] w-[22rem] overflow-hidden rounded-lg border border-line bg-overlay shadow-(--shadow-float)">
                      <div className="flex items-center gap-2 border-b border-line px-2.5">
                        <Search className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
                        <input
                          autoFocus
                          value={wanted}
                          onChange={(e) => setWanted(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setAdding(false);
                            if (e.key === "Enter" && offered[0]) take(offered[0]);
                          }}
                          placeholder="Find a repository"
                          className="w-full bg-transparent py-2 text-ui text-bone placeholder:text-mute focus:outline-none"
                        />
                      </div>
                      <div className="scroll-slim max-h-56 overflow-y-auto p-1">
                        {offered.length === 0 && (
                          <p className="px-2.5 py-2 text-meta text-mute">
                            {findingRepos
                              ? "Reading your repositories…"
                              : repos.length === 0
                                ? "Nothing connected yet."
                                : needle
                                  ? "No repository matches."
                                  : "All of them are in."}
                          </p>
                        )}
                        {offered.map((r) => (
                          <button key={r.id} onClick={() => take(r)} className="row w-full">
                            <GithubMark size={12} className="shrink-0 text-mute" />
                            <span className="truncate font-mono text-ui text-text">{r.slug}</span>
                          </button>
                        ))}
                      </div>
                      {/* Connecting one lives in Configuration; this is the door. */}
                      <button
                        onClick={() => {
                          setAdding(false);
                          onClose();
                          navigate("/configuration#repositories");
                        }}
                        className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-ui text-dim transition-colors hover:bg-raise hover:text-bone"
                      >
                        <Plus className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                        Connect another repository…
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </Field>

          {checkouts.length > 0 && (
            <Field label="Branch" hint="Cut from the base above">
              <div className="relative">
                <GitBranch
                  className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-mute"
                  strokeWidth={1.75}
                />
                <input
                  value={shown}
                  onChange={(e) => {
                    setTyped(true);
                    setBranch(e.target.value);
                  }}
                  placeholder="agent/…"
                  spellCheck={false}
                  title={typed ? undefined : "Following the name — edit to fix it"}
                  className={`w-full rounded-lg border border-line bg-ground py-2 pr-3 pl-8 font-mono text-ui focus:border-slate-deep focus:outline-none ${
                    typed ? "text-bone" : "text-dim"
                  }`}
                />
              </div>
            </Field>
          )}

          {/* Machine, mode and agent are one control because what decides
              whether an agent can start is the three of them together. */}
          <Field label="Where it runs">
            <div className="space-y-2 rounded-lg border border-line bg-ground p-2.5">
              <div className="flex items-center gap-2">
                <Icon of={Server} size={14} className="shrink-0 text-mute" />
                <select
                  value={where.machine || (all[0]?.key ?? "")}
                  onChange={(e) => setWhere({ ...where, machine: e.target.value, hostId: "" })}
                  className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1.5 text-ui text-bone focus:outline-none"
                >
                  {all.length === 0 && <option value="">No machine is connected</option>}
                  {all.map((m) => (
                    <option key={m.key} value={m.key}>
                      {machineLabel(m)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {agents.map((a) => {
                  const ok = runsHere(a.kind);
                  return (
                    <button
                      key={a.kind}
                      onClick={() => setWhere({ ...where, agent: a.kind })}
                      className={`control border ${
                        kind === a.kind
                          ? "border-line bg-overlay text-bone"
                          : "border-line bg-panel text-mute hover:bg-raise"
                      }`}
                      title={ok ? undefined : "Not installed or not signed in on this host"}
                    >
                      <AgentMark agent={a.kind} size={12} />
                      {a.label}
                      {!ok && <span className="text-micro text-kind-data">·</span>}
                    </button>
                  );
                })}
              </div>

              {host && kind && (
                <div className="overflow-hidden rounded-md border border-line bg-panel">
                  <Readout key={`${host.id}:${kind}`} host={host} agent={kind} agentLabel={agents.find((a) => a.kind === kind)?.label} />
                </div>
              )}
            </div>
          </Field>

          <Field label="Account" hint="Whose subscription this runs on">
            <div className="relative">
              <select
                value={mine.some((a) => a.id === accountId) ? accountId : ""}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full appearance-none rounded-lg border border-line bg-ground py-2 pr-8 pl-3 text-ui text-bone focus:border-slate-deep focus:outline-none"
              >
                <option value="">Default account</option>
                {mine.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.isDefault ? " · Default" : ""}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute top-1/2 right-3 h-3.5 w-3.5 -translate-y-1/2 text-mute"
                strokeWidth={2}
              />
            </div>
          </Field>

          <Field label="When the machine is busy">
            <div className="track w-full">
              {SHARES.map((c) => (
                <button
                  key={c.share}
                  data-on={share === c.share}
                  onClick={() => setShare(c.share)}
                  className="flex-1"
                  title={c.verb}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </Field>

          {create.isError && (
            <p className="rounded-lg border border-brick-deep bg-brick-tint px-3 py-2 font-mono text-meta text-brick">
              {(create.error as { code?: string })?.code === "NoCapacity"
                ? "No host is available to take this."
                : ((create.error as { message?: string })?.message ?? "Couldn't create it.")}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-line bg-ground/40 px-5 py-3">
          <span className="flex items-center gap-1.5 text-meta text-mute">
            <Icon of={Cpu} size={12} />
            {host ? machineLabel(all.find((m) => m.hosts.some((h) => h.id === host.id)) ?? all[0]) : backend.org}
          </span>
          <button onClick={onClose} className="control ml-auto text-mute hover:bg-raise hover:text-bone">
            Cancel
          </button>
          <button
            disabled={!ready}
            onClick={go}
            className="control border border-line bg-bone font-medium text-ground transition-opacity hover:opacity-90 disabled:bg-raise disabled:text-mute"
          >
            {create.isPending ? "Starting…" : "Start it"}
            <span className="keycap ml-1">{isMac ? "⌘⏎" : "Ctrl+⏎"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** One repository, and the branch it is cut from. */
function Chip({
  checkout,
  onBase,
  onRemove,
}: {
  checkout: Checkout;
  onBase: (base: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <span className="flex items-center gap-1.5 rounded-lg border border-line bg-ground py-1 pr-1 pl-2.5">
      <GithubMark size={12} className="shrink-0 text-mute" />
      <span className="font-mono text-ui text-bone">{checkout.slug}</span>

      {editing ? (
        <input
          autoFocus
          defaultValue={checkout.base ?? ""}
          onBlur={(e) => {
            onBase(e.target.value.trim());
            setEditing(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="main"
          className="w-24 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-micro text-bone focus:outline-none"
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          title="The branch to cut from"
          className="rounded px-1.5 py-0.5 font-mono text-micro text-mute hover:bg-raise hover:text-dim"
        >
          from {checkout.base || "default"}
        </button>
      )}

      <button
        onClick={onRemove}
        className="grid h-5 w-5 place-items-center rounded text-mute transition-colors hover:bg-raise hover:text-bone"
      >
        <X className="h-3 w-3" strokeWidth={2} />
      </button>
    </span>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-2">
        <span className="text-ui text-dim">{label}</span>
        {hint && <span className="text-meta text-mute">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

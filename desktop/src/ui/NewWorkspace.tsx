/**
 * Starting work.
 *
 * A workspace is a checkout on a machine with agents in it, so the form has to
 * ask for all three — and the contract is `NewSession`, not what seems like
 * enough. An earlier version of this asked for a name, one repository, a branch
 * and a first message, which is a plausible-looking form that cannot express
 * half of what a workspace is: several repositories cut at different bases,
 * which machine, **container or straight on the host**, whose subscription, and
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
import { useEffect, useMemo, useState } from "react";
import { Box, Check, ChevronDown, Cpu, GitBranch, Server, Terminal, X } from "lucide-react";
import { GithubMark, Icon } from "@/components/ui";
import { AgentMark } from "@/components/AgentMark";
import {
  canRun,
  defaultMode,
  resolve,
  type Where,
} from "@/components/WhereItRuns";
import { machineLabel, machines, modesOn, isLocal } from "@/src/api/environments";
import type { Agent, Execution, Share } from "@/src/api/generated/model";
import { useCreateSession } from "@/src/api/generated/sessions/sessions";
import { useAccounts, useAgents, useHosts, useRepos } from "~/data";
import type { Backend } from "~/mock/backends";
import { navigate } from "~/shims/next-navigation";
import { leaveDraft } from "@/src/workspace/draft";

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
  const [where, setWhere] = useState<Where>({ machine: "", execution: "container", hostId: "", agent: "" });
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
  const { machine, host } = useMemo(() => resolve(hosts, where), [hosts, where]);
  const modes = modesOn(machine);
  const local = isLocal(machine);
  const execution: Execution = local
    ? ((modes[0] ?? "container") as Execution)
    : where.picked
      ? where.execution
      : defaultMode(machine);

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
  const ready = !!name.trim() && checkouts.length > 0 && !!host && !!kind && !create.isPending;

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
                  onClick={() => setAdding(!adding)}
                  className="control border border-dashed border-line-soft text-mute hover:bg-raise hover:text-bone"
                >
                  {checkouts.length === 0 ? "Choose a repository" : "+ another"}
                </button>

                {adding && (
                  <>
                    <button className="fixed inset-0 z-10 cursor-default" onClick={() => setAdding(false)} />
                    <div className="scroll-slim absolute top-full left-0 z-20 mt-1.5 max-h-56 w-[22rem] overflow-y-auto rounded-lg border border-line bg-overlay p-1 shadow-(--shadow-float)">
                      {unpicked.length === 0 && (
                        <p className="px-2.5 py-2 text-meta text-mute">
                          {findingRepos
                            ? "Reading your repositories…"
                            : repos.length === 0
                              ? "Nothing connected yet."
                              : "All of them are in."}
                        </p>
                      )}
                      {unpicked.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => {
                            setCheckouts((held) => [...held, { id: r.id, slug: r.slug }]);
                            setAdding(false);
                          }}
                          className="row w-full"
                        >
                          <GithubMark size={12} className="shrink-0 text-mute" />
                          <span className="truncate font-mono text-ui text-text">{r.slug}</span>
                        </button>
                      ))}
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

              {/* On the machine hosting Firetower the mode is not a choice:
                  agents run where the control plane runs. */}
              {!local && (
                <div className="track w-full">
                  {(["container", "host"] as Execution[]).map((m) => (
                    <button
                      key={m}
                      data-on={execution === m}
                      onClick={() => setWhere({ ...where, execution: m, picked: true, hostId: "" })}
                      className="flex-1"
                    >
                      <span className="flex items-center justify-center gap-1.5">
                        <Icon of={m === "container" ? Box : Terminal} size={12} />
                        {m === "container" ? "Container" : "On the host"}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <p className="text-micro text-mute">
                {execution === "container"
                  ? "The agent gets the image's tools, not whatever is on that machine."
                  : "The agent runs straight on the machine, with its tools and its state."}
              </p>

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

              {!host && all.length > 0 && (
                <p className="text-micro text-kind-data">
                  That machine has no environment for this mode yet — starting will make one.
                </p>
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
            {host ? `${machine ? machineLabel(machine) : ""} · ${execution}` : backend.org}
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
            <span className="keycap ml-1">⌘⏎</span>
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

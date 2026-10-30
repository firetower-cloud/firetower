/**
 * Starting work, as a page rather than a sheet.
 *
 * The input is the hero: say what you want and start, the way a conversation
 * begins anywhere else. The four decisions a workspace is — who it is, what it
 * touches, what runs it, where — sit beneath it as quiet dropdowns, set only
 * when the default is not what you want.
 *
 * Unlike the old sheet, this one **does** send the prompt: what you type is the
 * first message, delivered once the workspace is set up. Leave it empty and the
 * agent comes up idle, as it always did — you just chat in the composer then.
 *
 * The data hooks, the fields and the `NewSession` payload are shared with the
 * rest of the client; only the shape on screen is this page's own.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  FolderGit2,
  Plus,
  Search,
  Server,
  UserRound,
  X,
} from "lucide-react";
import { Icon } from "~/components/ui";
import { FiretowerMark } from "~/components/ui/Brand";
import { AgentMark } from "~/components/AgentMark";
import { RunPicker } from "~/ui/RunPicker";
import { useAgentControls } from "~/api/generated/agents/agents";
import { useMe } from "~/api/generated/auth/auth";
import { Pop } from "~/ui/Pop";
import { Readout, isReady } from "~/components/HostReadiness";
import { useHostReadiness } from "~/api/generated/hosts/hosts";
import { useListRoles } from "~/api/generated/roles/roles";
import { useCreateSession } from "~/api/generated/sessions/sessions";
import { machineLabel, machines } from "~/api/environments";
import { canRun, resolve, type Where } from "~/components/WhereItRuns";
import { usable } from "~/api/accounts";
import { useAccounts, useAgents, useHosts, useRepos } from "~/data";
import { ConnectAccount } from "~/ui/config/ConnectAccount";
import { navigate } from "~/shims/next-navigation";
import { leaveDraft } from "~/workspace/draft";
import { isMac } from "~/platform";
import { consumeSeed } from "~/start";
import type { Agent, Control, ControlKind } from "~/api/generated/model";

type Checkout = { id: string; slug: string };

const slug = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

/** "Good morning/afternoon/evening", by the clock on this machine. */
function timeOfDay(): string {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

export function NewPage() {
  const seed = useMemo(() => consumeSeed(), []);
  const me = useMe().data?.user;
  const who = me?.slug ? me.slug.charAt(0).toUpperCase() + me.slug.slice(1) : me?.username;

  const { data: repos } = useRepos();
  const { data: hosts } = useHosts();
  const { data: agents } = useAgents();
  const { data: accounts } = useAccounts();
  const profiles = useListRoles().data ?? [];
  const create = useCreateSession();

  const [prompt, setPrompt] = useState("");
  const [checkouts, setCheckouts] = useState<Checkout[]>([]);
  const [where, setWhere] = useState<Where>({ machine: "", hostId: "", agent: "" });
  const [profileId, setProfileId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [open, setOpen] = useState<{ which: string; at: HTMLElement } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  /* A task seeds the repository once the server has mapped its slug to an id. */
  useEffect(() => {
    if (checkouts.length > 0 || repos.length === 0 || !seed?.repo) return;
    const wanted = repos.find((r) => r.slug === seed.repo);
    if (wanted) setCheckouts([{ id: wanted.id, slug: wanted.slug }]);
  }, [repos, seed?.repo, checkouts.length]);

  const all = useMemo(() => machines(hosts), [hosts]);
  const { host } = useMemo(() => resolve(hosts, where), [hosts, where]);
  const machine =
    all.find((m) => m.key === where.machine) ??
    (host ? all.find((m) => m.hosts.some((h) => h.id === host.id)) : undefined) ??
    all[0];

  const profile = profiles.find((p) => p.id === profileId);
  const pinned = (profile?.agent ?? undefined) as Agent | undefined;
  const kind = (pinned ||
    where.agent ||
    agents.find((a) => host && canRun(a, host.id))?.kind ||
    agents[0]?.kind) as Agent | undefined;

  const mine = useMemo(() => accounts.filter((a) => a.kind === kind && usable(a)), [accounts, kind]);
  const account = mine.find((a) => a.id === accountId);
  useEffect(() => {
    if (account || mine.length === 0) return;
    setAccountId((mine.find((a) => a.isDefault) ?? mine[0]).id);
  }, [account, mine]);

  /* Model, effort and permissions — the same picker the conversation uses,
     fed the choices Firetower knows for this agent before one is running. A
     fresh set each time the engine changes, since a model is one agent's. */
  const controlsQ = useAgentControls(kind ?? "", { query: { enabled: !!kind } });
  const controls = (kind ? (controlsQ.data ?? []) : []) as Control[];
  const [chosen, setChosen] = useState<Partial<Record<ControlKind, string>>>({});
  useEffect(() => setChosen({}), [kind]);
  const valueOf = (c: Control) => chosen[c.kind] ?? c.current ?? undefined;

  const readiness = useHostReadiness(
    host?.id ?? "",
    { agent: kind },
    { query: { enabled: !!host && !!kind, retry: false, staleTime: 5000 } },
  );
  const hostReady = !!host && !!kind && isReady(readiness.data);
  const ready = hostReady && !!account && !create.isPending;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const go = () => {
    if (!ready || !kind || !account) return;
    const first = prompt.split("\n")[0].trim();
    const name = (seed?.title || first || checkouts[0]?.slug || "Workspace").slice(0, 80);
    const branch = checkouts.length ? `agent/${slug(first || name) || "work"}` : undefined;
    create.mutate(
      {
        data: {
          name,
          prompt: prompt.trim() || undefined,
          taskKey: seed?.taskKey,
          taskUrl: seed?.taskUrl,
          workspaceId: seed?.workspaceId as never,
          repos: checkouts.map((c) => ({ repoId: c.id })),
          agent: kind,
          profile: profileId ?? undefined,
          accountId: account.id,
          branch,
          hostId: host?.id,
          settings: {
            model: chosen.model,
            effort: chosen.effort,
            mode: chosen.mode,
            sandbox: chosen.sandbox,
          },
        },
      },
      {
        onSuccess: (made) => {
          const s = made as { id: string; workspaceId?: string | null };
          if (seed?.taskUrl) leaveDraft(s.id, `${seed.title ?? ""}\n${seed.taskUrl}`.trim());
          navigate(`/sessions/${s.workspaceId ?? s.id}`);
        },
      },
    );
  };

  const toggleRepo = (r: { id: string; slug: string }) =>
    setCheckouts((cs) =>
      cs.some((c) => c.id === r.id) ? cs.filter((c) => c.id !== r.id) : [...cs, { id: r.id, slug: r.slug }],
    );

  const close = () => setOpen(null);
  const toggle = (which: string, at: HTMLElement) =>
    setOpen((o) => (o?.which === which ? null : { which, at }));

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto">
      <div className="m-auto w-full max-w-[680px] px-7 py-10">
        <h1 className="mb-8 flex items-center justify-center gap-2.5 text-[1.6rem] font-normal leading-snug tracking-[-0.02em] text-bone/90">
          <FiretowerMark size={28} className="text-bone" />
          Good {timeOfDay()}{who ? `, ${who}` : ""}
        </h1>

        {/* composer */}
        <div className="group rounded-2xl border border-line bg-raise/40 px-5 py-4 transition-colors focus-within:border-slate-deep/80 focus-within:bg-raise/60">
          <textarea
            ref={box}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 240) + "px";
            }}
            placeholder="Describe the task, or start empty and say what you want in the conversation."
            rows={2}
            className="scroll-slim w-full resize-none bg-transparent text-read leading-relaxed text-bone placeholder:text-mute/80 focus:outline-none"
          />
          <div className="mt-2.5 flex items-center gap-3">
            {kind && (
              <RunPicker
                agent={kind}
                agentLabel={agents.find((a) => a.kind === kind)?.label}
                agents={agents.filter((a) => a.supported).map((a) => ({ kind: a.kind, label: a.label }))}
                accounts={mine.map((a) => ({ id: a.id, name: a.name, isDefault: a.isDefault }))}
                accountId={account?.id ?? ""}
                agentLocked={!!pinned}
                controls={controls}
                valueOf={valueOf}
                onPickAgent={(k) => setWhere({ ...where, agent: k })}
                onPickAccount={(id) => setAccountId(id)}
                onPickControl={(k, v) => setChosen((p) => ({ ...p, [k]: v }))}
              />
            )}
            <span className="flex-1" />
            <span className="text-micro text-mute">Starts a workspace</span>
            <button
              onClick={go}
              disabled={!ready}
              className="inline-flex h-8 items-center gap-2 rounded-full bg-bone pr-2.5 pl-3.5 text-ui font-medium text-ground transition enabled:hover:bg-white disabled:cursor-default disabled:bg-overlay disabled:text-mute"
            >
              Start
              <span className={`font-mono text-micro ${ready ? "opacity-50" : "opacity-40"}`}>
                {isMac ? "⌘↵" : "Ctrl↵"}
              </span>
            </button>
          </div>
        </div>

        {/* the four decisions */}
        <div className="mt-3 flex flex-wrap gap-0.5">
          {/* Profile */}
          <Pill
            icon={
              pinned ? (
                <AgentMark agent={pinned} size={15} />
              ) : profile ? (
                <UserRound className="h-[15px] w-[15px]" strokeWidth={1.8} />
              ) : (
                <UserRound className="h-[15px] w-[15px]" strokeWidth={1.8} />
              )
            }
            label={profile ? profile.name : "Just an agent"}
            set={!!profile}
            onClick={(e) => toggle("profile", e)}
          />
          {/* Repository */}
          <Pill
            icon={<FolderGit2 className="h-[15px] w-[15px]" strokeWidth={1.8} />}
            label={
              checkouts.length === 0
                ? "Add a repository"
                : checkouts.length === 1
                  ? checkouts[0].slug
                  : `${checkouts.length} repositories`
            }
            set={checkouts.length > 0}
            onClick={(e) => toggle("repo", e)}
          />
          {/* Where it runs */}
          <Pill
            icon={<Server className="h-[15px] w-[15px]" strokeWidth={1.8} />}
            label={machine ? machineLabel(machine) : "Where it runs"}
            set={!!where.machine}
            after={
              host && kind ? (
                <span
                  className={`h-1.5 w-1.5 rounded-full ${hostReady ? "bg-sage" : "bg-kind-data"}`}
                  title={hostReady ? "Ready" : "Needs setup — open to see"}
                />
              ) : undefined
            }
            onClick={(e) => toggle("machine", e)}
          />
        </div>

        {/* Readiness lives in the machine dropdown now; only a blocker that
            needs you — no account to run on — surfaces here. */}
        {host && kind && mine.length === 0 && (
          <div className="mt-2 flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2">
            <span className="min-w-0 flex-1 text-meta text-kind-data">
              No {agents.find((a) => a.kind === kind)?.label ?? kind} account connected.
            </span>
            <button
              onClick={() => setConnecting(true)}
              className="control h-7 border border-line bg-raise text-meta text-bone hover:bg-overlay"
            >
              <Icon of={Plus} size={12} />
              Connect an account
            </button>
          </div>
        )}
        {create.isError && (
          <p className="mt-2 rounded-lg border border-brick-deep bg-brick-tint px-3 py-2 font-mono text-meta text-brick">
            {(create.error as { code?: string })?.code === "NoCapacity"
              ? "No host is available to take this."
              : ((create.error as { message?: string })?.message ?? "Couldn't start it.")}
          </p>
        )}
      </div>

      {/* ---------- the pill menus ---------- */}
      {open?.which === "profile" && (
        <Pop anchor={open.at} onClose={close} width={320}>
          <Menu>
            <Opt
              on={!profile}
              onPick={() => {
                setProfileId(null);
                close();
              }}
              icon={<UserRound className="h-4 w-4" strokeWidth={1.8} />}
              title="Just an agent"
              sub="No profile — a plain workspace"
            />
            {profiles.map((p) => (
              <Opt
                key={p.id}
                on={p.id === profileId}
                onPick={() => {
                  setProfileId(p.id);
                  close();
                }}
                icon={
                  p.agent ? (
                    <AgentMark agent={p.agent as Agent} size={16} />
                  ) : (
                    <UserRound className="h-4 w-4" strokeWidth={1.8} />
                  )
                }
                title={p.name}
                sub={p.does}
                chip={p.canDelegate ? "manager" : undefined}
              />
            ))}
          </Menu>
        </Pop>
      )}

      {open?.which === "repo" && (
        <Pop anchor={open.at} onClose={close} width={340}>
          <Menu>
            {repos.length === 0 && (
              <p className="px-3 py-2 text-meta text-mute">No repositories connected.</p>
            )}
            {repos.map((r) => (
              <Opt
                key={r.id}
                on={checkouts.some((c) => c.id === r.id)}
                onPick={() => toggleRepo(r)}
                keepOpen
                icon={<FolderGit2 className="h-4 w-4" strokeWidth={1.8} />}
                title={r.slug}
                sub={r.defaultBranch ?? undefined}
              />
            ))}
          </Menu>
        </Pop>
      )}

      {open?.which === "machine" && (
        <Pop anchor={open.at} onClose={close} width={340}>
          <Menu>
            {all.length === 0 && (
              <p className="px-3 py-2 text-meta text-mute">No machine connected.</p>
            )}
            {all.map((m) => (
              <Opt
                key={m.key}
                on={m.key === machine?.key}
                onPick={() => {
                  setWhere({ machine: m.key, hostId: "", agent: where.agent });
                  close();
                }}
                icon={<Server className="h-4 w-4" strokeWidth={1.8} />}
                title={machineLabel(m)}
              />
            ))}
            {host && kind && (
              <div className="mt-1 border-t border-line-soft pt-1">
                <Readout
                  key={`${host.id}:${kind}`}
                  host={host}
                  agent={kind}
                  agentLabel={agents.find((a) => a.kind === kind)?.label}
                />
              </div>
            )}
          </Menu>
        </Pop>
      )}

      {connecting && kind && agents.some((a) => a.kind === kind) && (
        <ConnectAccount
          agent={agents.find((a) => a.kind === kind)!}
          onClose={() => setConnecting(false)}
        />
      )}
    </div>
  );
}

/* ---------------- small building blocks ---------------- */

function Pill({
  icon,
  label,
  sub,
  lock,
  set,
  after,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
  lock?: string;
  set?: boolean;
  after?: React.ReactNode;
  onClick: (el: HTMLElement) => void;
}) {
  return (
    <button
      onClick={(e) => onClick(e.currentTarget)}
      className="group inline-flex h-8 items-center gap-2 rounded-lg px-2 text-meta transition-colors hover:bg-raise/60"
    >
      <span className={set ? "text-slate" : "text-mute"}>{icon}</span>
      <span className={set ? "text-bone" : "text-dim group-hover:text-text"}>{label}</span>
      {sub && <span className="text-mute">{sub}</span>}
      {lock && <span className="text-sage/90">· {lock}</span>}
      {after}
      <ChevronDown className="h-3 w-3 text-mute/60 transition-colors group-hover:text-mute" strokeWidth={2} />
    </button>
  );
}

function Menu({ children }: { children: React.ReactNode }) {
  return <div className="max-h-80 overflow-y-auto py-1">{children}</div>;
}

function Head({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pt-2 pb-1 text-micro text-mute">{children}</div>;
}

function Opt({
  on,
  disabled,
  keepOpen,
  onPick,
  icon,
  title,
  sub,
  chip,
}: {
  on: boolean;
  disabled?: boolean;
  keepOpen?: boolean;
  onPick: () => void;
  icon: React.ReactNode;
  title: string;
  sub?: string;
  chip?: string;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={on}
      disabled={disabled}
      onClick={(e) => {
        if (keepOpen) e.stopPropagation();
        onPick();
      }}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${
        disabled ? "opacity-40" : "hover:bg-raise"
      }`}
    >
      <span className={`shrink-0 ${on ? "text-bone" : "text-dim"}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui text-bone">{title}</span>
        {sub && <span className="block truncate text-micro text-mute">{sub}</span>}
      </span>
      {chip && (
        <span className="shrink-0 rounded bg-sage-tint px-1.5 py-0.5 text-micro text-sage">{chip}</span>
      )}
      <Check
        className={`h-4 w-4 shrink-0 ${on ? "text-slate" : "text-transparent"}`}
        strokeWidth={2.5}
      />
    </button>
  );
}

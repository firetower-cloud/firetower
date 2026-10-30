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
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { Icon } from "~/components/ui";
import { AgentMark, AGENT_LABEL } from "~/components/AgentMark";
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
import type { Agent } from "~/api/generated/model";

type Checkout = { id: string; slug: string };

const slug = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

export function NewPage() {
  const seed = useMemo(() => consumeSeed(), []);

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
  const runsHere = (k: Agent) => {
    const a = agents.find((x) => x.kind === k);
    return !!a && !!host && canRun(a, host.id);
  };

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

  const readiness = useHostReadiness(
    host?.id ?? "",
    { agent: kind },
    { query: { enabled: !!host && !!kind, retry: false, staleTime: 5000 } },
  );
  const ready = !!host && !!kind && !!account && isReady(readiness.data) && !create.isPending;

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

  const accountLabel = account ? account.name : mine.length === 0 ? "connect an account" : "";

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto">
      <div className="m-auto w-full max-w-[720px] px-7 py-10">
        <div className="mb-6 flex items-center justify-center gap-3">
          <Sparkles className="h-6 w-6 text-ember" strokeWidth={1.75} />
          <h1 className="text-display font-semibold tracking-tight text-bone">
            What are we building?
          </h1>
        </div>

        {/* composer */}
        <div className="rounded-[18px] border border-line bg-panel px-4 pt-4 pb-3 shadow-(--shadow-float) focus-within:border-slate-deep">
          <textarea
            ref={box}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 240) + "px";
            }}
            placeholder="Describe the task — or just start it empty and say what you want in the conversation."
            rows={2}
            className="scroll-slim w-full resize-none bg-transparent text-read leading-relaxed text-bone placeholder:text-mute focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-2">
            <span className="flex-1" />
            <span className="text-micro text-mute">Starts a workspace</span>
            <button
              onClick={go}
              disabled={!ready}
              className="inline-flex h-8 items-center gap-2 rounded-lg bg-bone px-3 text-ui font-semibold text-ground transition hover:bg-white disabled:bg-raise disabled:text-mute"
            >
              Start it
              <span className="font-mono text-micro opacity-60">{isMac ? "⌘↵" : "Ctrl↵"}</span>
            </button>
          </div>
        </div>

        {/* the four decisions */}
        <div className="mt-3.5 flex flex-wrap gap-2 px-0.5">
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
          {/* Agent · Account */}
          <Pill
            icon={kind ? <AgentMark agent={kind} size={15} /> : <Sparkles className="h-[15px] w-[15px]" />}
            label={kind ? AGENT_LABEL[kind] : "Agent"}
            sub={accountLabel ? `· ${accountLabel}` : undefined}
            lock={pinned ? "from profile" : undefined}
            set={!!where.agent || !!pinned}
            onClick={(e) => toggle("agent", e)}
          />
          {/* Where it runs */}
          <Pill
            icon={<Server className="h-[15px] w-[15px]" strokeWidth={1.8} />}
            label={machine ? machineLabel(machine) : "Where it runs"}
            set={!!where.machine}
            onClick={(e) => toggle("machine", e)}
          />
        </div>

        {/* readiness / connect, shown only when there is something to say */}
        {host && kind && mine.length > 0 && (
          <div className="mt-2 overflow-hidden rounded-lg border border-line bg-panel">
            <Readout
              key={`${host.id}:${kind}`}
              host={host}
              agent={kind}
              agentLabel={agents.find((a) => a.kind === kind)?.label}
            />
          </div>
        )}
        {host && kind && mine.length === 0 && (
          <div className="mt-2 flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2">
            <span className="min-w-0 flex-1 text-meta text-kind-data">
              No {AGENT_LABEL[kind]} account connected.
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

      {open?.which === "agent" && (
        <Pop anchor={open.at} onClose={close} width={300}>
          <Menu>
            <Head>{pinned ? "Set by the profile" : "Agent"}</Head>
            {agents
              .filter((a) => a.supported)
              .map((a) => (
                <Opt
                  key={a.kind}
                  on={kind === a.kind}
                  disabled={!!pinned && a.kind !== pinned}
                  onPick={() => {
                    setWhere({ ...where, agent: a.kind });
                    close();
                  }}
                  icon={<AgentMark agent={a.kind} size={16} />}
                  title={a.label}
                  sub={runsHere(a.kind) ? undefined : "not installed here, or no account"}
                />
              ))}
            {mine.length > 1 && (
              <>
                <Head>Account</Head>
                {mine.map((a) => (
                  <Opt
                    key={a.id}
                    on={a.id === account?.id}
                    onPick={() => {
                      setAccountId(a.id);
                      close();
                    }}
                    icon={<span className="inline-block h-2 w-2 rounded-full bg-slate" />}
                    title={a.name}
                    sub={a.isDefault ? "default" : undefined}
                  />
                ))}
              </>
            )}
          </Menu>
        </Pop>
      )}

      {open?.which === "machine" && (
        <Pop anchor={open.at} onClose={close} width={300}>
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
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
  lock?: string;
  set?: boolean;
  onClick: (el: HTMLElement) => void;
}) {
  return (
    <button
      onClick={(e) => onClick(e.currentTarget)}
      className={`inline-flex h-[34px] items-center gap-2 rounded-[10px] border px-3 text-ui transition-colors ${
        set
          ? "border-slate-deep bg-slate-tint text-bone"
          : "border-line bg-panel text-text hover:border-dim hover:bg-raise"
      }`}
    >
      <span className={set ? "text-slate" : "text-dim"}>{icon}</span>
      <span className="text-bone">{label}</span>
      {sub && <span className="text-mute">{sub}</span>}
      {lock && <span className="text-micro text-sage">· {lock}</span>}
      <ChevronDown className="h-3.5 w-3.5 text-mute" strokeWidth={1.9} />
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

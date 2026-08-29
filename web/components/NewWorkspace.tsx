"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListRepos, useRepoBranches } from "@/src/api/generated/repos/repos";
import { useListAgents } from "@/src/api/generated/agents/agents";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import {
  useCreateSession,
  getListSessionsQueryKey,
} from "@/src/api/generated/sessions/sessions";
import type { Agent, AgentView, Host, Repo } from "@/src/api/generated/model";
import { AgentMark, AGENT_LABEL } from "@/components/AgentMark";
import { slugify } from "@/src/api/slug";
import { leaveDraft } from "@/src/workspace/draft";
import { ConnectRepo } from "@/components/ConnectRepo";
import { getListReposQueryKey } from "@/src/api/generated/repos/repos";

/**
 * Making a workspace.
 *
 * A workspace is a place — a branch, checked out, with an agent waiting in it.
 * So this asks for a name and derives the branch from it, and the agent is one
 * field rather than the point of the screen.
 *
 * **There is no task field.** What you want doing is a conversation, and it
 * belongs in the conversation: you land in the workspace with the files in
 * front of you and say it there. Asking for it up front made this a box for
 * launching an agent that happened to leave a branch behind.
 *
 * Always open, never a thing you click to expand. It is already a dialog;
 * something inside a dialog that has to be opened is a second door.
 */
export function NewWorkspace({
  startWith,
  fromTask,
  onCreated,
}: {
  /** A repository slug to begin with, from the `+` beside a group in the rail. */
  startWith?: string;
  /**
   * The task this worktree is for, when it came from one.
   *
   * Fills in the name and the branch, and is written to the workspace so the
   * rail can say `#5138` and shipping can offer to close it. The prompt is the
   * title, the body and the link — the whole "streamlined" claim is that
   * nobody types the problem out a second time.
   */
  fromTask?: { key: string; title: string; url: string; body?: string };
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState(fromTask?.title ?? "");
  const [branch, setBranch] = useState("");
  /** Once the branch has been typed in it is yours, and stops following. */
  const [branchTyped, setBranchTyped] = useState(false);
  const [checkouts, setCheckouts] = useState<{ id: string; slug: string; base?: string }[]>([]);
  const [agent, setAgent] = useState<Agent | "">("");
  const [hostId, setHostId] = useState("");
  const [adding, setAdding] = useState(false);

  const first = useRef<HTMLInputElement>(null);
  const cache = useQueryClient();

  const { data: repos = [] } = useListRepos();
  const [connecting, setConnecting] = useState(false);
  const { data: agents = [] } = useListAgents();
  const { data: allHosts = [] } = useListHosts();

  useEffect(() => first.current?.focus(), []);

  // Seeded once the list arrives rather than as initial state: the repositories
  // are fetched, so at first render there is nothing to match a slug against.
  const [seeded, setSeeded] = useState<string | undefined>(undefined);
  if (startWith && startWith !== seeded && repos.length > 0) {
    setSeeded(startWith);
    const match = repos.find((r) => r.slug === startWith);
    if (match) setCheckouts([{ id: match.id, slug: match.slug }]);
  }

  // Where first, then what: the machine decides which agents are available, so
  // asking the other way round means the machine you picked can vanish from its
  // own list. A host that is not answering stays — "we cannot see your compute
  // this second" is a different thing from "you have none".
  const hosts = allHosts.filter((h) => !h.drained);
  const host = hosts.find((h) => h.id === hostId) ?? hosts.find((h) => h.state === "Online") ?? hosts[0];

  const runsHere = (a: AgentView) => (host ? canRun(a, host.id) : false);
  const choices = [...agents].sort((a, b) => Number(runsHere(b)) - Number(runsHere(a)));
  const chosenKind = (agent || choices.find(runsHere)?.kind || choices[0]?.kind) as Agent | undefined;
  const chosen = choices.find((c) => c.kind === chosenKind);

  const slug = slugify(name);
  const shownBranch = branchTyped ? branch : slug ? `agent/${slug}` : "";

  const create = useCreateSession({
    mutation: {
      onSuccess: (session) => {
        // The task, waiting in the composer of a screen that does not exist
        // yet. Left rather than sent: an agent should not be editing files
        // before anybody has read the issue here.
        if (fromTask) {
          leaveDraft(
            session.id,
            [fromTask.title, fromTask.body, fromTask.url].filter(Boolean).join("\n\n"),
          );
        }
        cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
        onCreated(session.id);
      },
    },
  });

  const ready = !!name.trim() && !!chosen && runsHere(chosen) && usable(host) && !create.isPending;

  const go = () => {
    if (!ready || !chosenKind) return;
    create.mutate({
      data: {
        name: name.trim(),
        // No prompt, ever — including when this came from a task. The agent
        // starts and waits; what you want doing is said in the conversation,
        // where it can be answered. A task fills the composer instead, unsent,
        // so "here is the issue, let's plan it together" is something you can
        // still type in front of it.
        taskKey: fromTask?.key,
        taskUrl: fromTask?.url,
        repos: checkouts.map((c) => ({ repoId: c.id, base: c.base })),
        agent: chosenKind,
        branch: checkouts.length ? shownBranch.trim() || undefined : undefined,
        hostId: host?.id,
      },
    });
  };

  const unpicked = repos.filter((r) => !checkouts.some((c) => c.id === r.id));

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go();
      }}
      className="flex flex-col gap-4"
    >
      <Row label="Name" hint="What this branch is for">
        <input
          ref={first}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="auth refactor"
          className="w-full rounded-[8px] border border-line bg-ground px-3 py-2 text-[14px] text-bone placeholder:text-mute focus:border-ember focus:outline-none"
        />
      </Row>

      <Row label="Repository" hint={checkouts.length > 1 ? "One branch, cut in each" : undefined}>
        <div className="flex flex-wrap items-center gap-1.5">
          {checkouts.map((c) => (
            <RepoChip
              key={c.id}
              repoId={c.id}
              slug={c.slug}
              base={c.base}
              onBase={(base) =>
                setCheckouts((held) => held.map((h) => (h.id === c.id ? { ...h, base } : h)))
              }
              onRemove={() => setCheckouts((held) => held.filter((h) => h.id !== c.id))}
            />
          ))}

          <Add
            open={adding}
            onOpen={() => setAdding(!adding)}
            onClose={() => setAdding(false)}
            repos={unpicked}
            empty={repos.length === 0 ? "Nothing connected yet." : "All of them are in."}
            label={checkouts.length === 0 ? "Choose a repository" : "+ another"}
            onPick={(r) => {
              setCheckouts((held) => [...held, { id: r.id, slug: r.slug }]);
              setAdding(false);
            }}
            onConnect={() => setConnecting(true)}
          />
        </div>
      </Row>

      {checkouts.length > 0 && (
        <Row label="Branch" hint="Cut from the base above">
          <input
            value={shownBranch}
            onChange={(e) => {
              setBranch(e.target.value);
              setBranchTyped(true);
            }}
            placeholder="agent/…"
            spellCheck={false}
            title={branchTyped ? undefined : "Following the name — edit to fix it"}
            className={`w-full rounded-[8px] border border-line bg-ground px-3 py-2 font-mono text-[12.5px] placeholder:text-mute focus:border-ember focus:outline-none ${
              branchTyped ? "text-bone" : "text-dim"
            }`}
          />
        </Row>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Row label="Agent">
          <Select
            value={chosen ? agentLabel(chosen, runsHere(chosen)) : "no agent"}
            options={choices.length ? choices.map((c) => agentLabel(c, runsHere(c))) : ["no agent"]}
            onChange={(v) => setAgent(choices.find((c) => agentLabel(c, runsHere(c)) === v)?.kind ?? "")}
            glyph={chosenKind ? <AgentMark agent={chosenKind} size={13} /> : undefined}
          />
        </Row>
        <Row label="Runs on">
          <Select
            value={host ? picked(host) : "nowhere to run"}
            options={hosts.length ? hosts.map(picked) : ["nowhere to run"]}
            onChange={(v) => setHostId(hosts.find((h) => picked(h) === v)?.id ?? "")}
          />
        </Row>
      </div>

      {create.isError && (
        <p className="rounded-[7px] border border-brick/40 bg-ground px-3 py-2 font-mono text-[11.5px] text-brick">
          {(create.error as { code?: string }).code === "NoCapacity"
            ? "No host is available to take this."
            : ((create.error as { message?: string }).message ?? "Couldn't create it.")}
        </p>
      )}

      {/* Which task this is for, when it came from one. Said out loud because
          the fields above are filled in and it should be obvious what filled
          them — and because the first prompt is about to be derived from it. */}
      {fromTask && (
        <a
          href={fromTask.url}
          target="_blank"
          rel="noreferrer"
          className="mb-3 flex items-center gap-2 rounded-[8px] border border-line px-3 py-2 transition-colors hover:border-ember/40"
        >
          <span className="shrink-0 font-mono text-[11px] text-ember">{fromTask.key}</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-mute">{fromTask.title}</span>
          <span aria-hidden className="shrink-0 text-[10px] text-mute">
            ↗
          </span>
        </a>
      )}

      <div className="flex items-center gap-3 border-t border-line pt-3">
        <p className="min-w-0 flex-1 text-[11.5px] leading-[1.5] text-mute">
          {why({
            hosts: hosts.length,
            chosen,
            host,
            repos: checkouts.length,
          })}
        </p>
        <button
          onClick={go}
          disabled={!ready}
          className="flex shrink-0 items-center gap-2 rounded-[8px] bg-ember px-4 py-2 text-[13px] font-semibold text-[#1a0c04] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-line disabled:text-mute"
        >
          {create.isPending ? "Creating…" : "Create workspace"}
          {!create.isPending && (
            <span aria-hidden className="font-mono text-[12px] opacity-60">
              ⌘↵
            </span>
          )}
        </button>
      </div>

      {/* The repository somebody wants is sometimes one Firetower has never
          heard of — and on the first day the account it would come from is not
          connected either, which this dialog handles too. Doing it here rather
          than in Configuration keeps the name and the branch already typed. */}
      {connecting && (
        <ConnectRepo
          onClose={() => {
            setConnecting(false);
            // Whatever was just connected has to be in the list the picker
            // reads, or the dialog says "nothing connected yet" about a
            // repository connected ten seconds ago.
            cache.invalidateQueries({ queryKey: getListReposQueryKey() });
          }}
        />
      )}
    </div>
  );
}

/** A labelled field. The label is above, because these are not chips. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline gap-2">
        <span className="text-[11.5px] font-medium text-dim">{label}</span>
        {hint && <span className="text-[11px] text-mute">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

/** A native select wearing the same clothes as the inputs beside it. */
function Select({
  value,
  options,
  onChange,
  glyph,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  glyph?: React.ReactNode;
}) {
  return (
    <span className="relative flex items-center gap-2 rounded-[8px] border border-line bg-ground px-3 py-2 transition-colors hover:border-[#3a3631]">
      {glyph && <span className="shrink-0 text-mute">{glyph}</span>}
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-bone">{value}</span>
      <span aria-hidden className="shrink-0 text-[9px] text-mute">
        ▾
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </span>
  );
}

/**
 * Adding a repository.
 *
 * Expands in place rather than dropping over the dialog. A floating list inside
 * a short modal hangs off the bottom of the panel and onto the backdrop behind
 * it, where a click that looks like it lands on a repository dismisses the
 * whole thing instead — which is exactly what it did.
 */
function Add({
  open,
  onOpen,
  onClose,
  repos,
  empty,
  label,
  onPick,
  onConnect,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  repos: Repo[];
  empty: string;
  label: string;
  onPick: (repo: Repo) => void;
  /** Connect one that is not there — or the account it would come from. */
  onConnect: () => void;
}) {
  const [search, setSearch] = useState("");
  const shown = repos.filter((r) => r.slug.toLowerCase().includes(search.trim().toLowerCase()));

  if (!open) {
    return (
      <button
        onClick={() => {
          onOpen();
          setSearch("");
        }}
        className="rounded-[7px] border border-dashed border-line px-2.5 py-1.5 text-[12px] text-mute transition-colors hover:border-ember/40 hover:text-ember"
      >
        {label}
      </button>
    );
  }

  return (
    <div className="w-full rounded-[8px] border border-line bg-ground p-1">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            // Enter takes the only one left, which is what typing three
            // characters and reaching for the keyboard means.
            if (e.key === "Enter" && shown.length === 1) onPick(shown[0]);
          }}
          placeholder="Search repositories"
          className="min-w-0 flex-1 rounded-[6px] bg-transparent px-2.5 py-1.5 text-[12.5px] text-bone placeholder:text-mute focus:outline-none"
        />
        <button
          onClick={onClose}
          aria-label="Stop adding"
          className="shrink-0 px-2 text-[13px] text-mute transition-colors hover:text-text"
        >
          ×
        </button>
      </div>

      <div className="max-h-[168px] overflow-y-auto">
        {shown.length === 0 && (
          <p className="px-2.5 py-2 text-[12px] text-mute">{empty}</p>
        )}
        {shown.map((r) => (
          <button
            key={r.id}
            onClick={() => onPick(r)}
            className="block w-full rounded-[6px] px-2.5 py-1.5 text-left font-mono text-[12px] text-text transition-colors hover:bg-raise"
          >
            {r.slug}
          </button>
        ))}
      </div>

      {/* The repository somebody wants is sometimes one Firetower has never
          heard of, and on the first day there are none at all — the account it
          would come from is not connected either. Sending them to Configuration
          to do it means losing the name and the branch they have already typed,
          so it happens here and hands back the same picker with the new one
          in it. */}
      <button
        onClick={onConnect}
        className="mt-0.5 block w-full rounded-[6px] border-t border-line px-2.5 py-1.5 text-left text-[12px] text-mute transition-colors hover:text-ember"
      >
        + Connect a repository…
      </button>
    </div>
  );
}

/** One repository, with the branch it will be cut from. */
function RepoChip({
  repoId,
  slug,
  base,
  onBase,
  onRemove,
}: {
  repoId: string;
  slug: string;
  base?: string;
  onBase: (base: string) => void;
  onRemove: () => void;
}) {
  const { data: info } = useRepoBranches(repoId);
  const branches = info?.branches ?? [];

  // What we know, never a guess. A repository connected while nothing could
  // read it has no trunk yet, and sending `main` on its behalf is how you
  // branch from the wrong place in one that calls it something else.
  const showing = base ?? info?.defaultBranch ?? "its default branch";

  return (
    <span className="flex items-center rounded-[7px] border border-line bg-panel text-[12px] text-dim">
      <span className="max-w-[200px] truncate py-1.5 pr-2 pl-2.5 font-mono text-[11.5px] text-bone">
        {slug}
      </span>
      <label className="group relative flex items-center gap-1 border-l border-line py-1.5 pr-5 pl-2">
        <span className="text-mute">⑂</span>
        <span className="max-w-[110px] truncate font-mono text-[11.5px]">{showing}</span>
        <span aria-hidden className="pointer-events-none absolute right-1.5 text-[9px] text-mute">
          ▾
        </span>
        <select
          value={showing}
          onChange={(e) => onBase(e.target.value)}
          aria-label={`Branch to start ${slug} from`}
          className="absolute inset-0 cursor-pointer opacity-0"
        >
          {(branches.length ? branches : [showing]).map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </label>
      <button
        onClick={onRemove}
        aria-label={`Remove ${slug}`}
        className="border-l border-line px-2 py-1.5 text-mute transition-colors hover:text-brick"
      >
        ×
      </button>
    </span>
  );
}

/**
 * Whether this agent could run on this particular host.
 *
 * Authentication is per host, not global: a subscription lives in the agent's
 * own config on the machine it was signed in on, so one host being logged in
 * says nothing about another. Only a token we hold travels.
 */
function canRun(agent: AgentView, hostId: string) {
  const here = agent.hosts.find((h) => h.hostId === hostId);
  if (!here?.installed) return false;
  if (!agent.needsCredential) return true;
  return here.loggedIn === true || agent.credentialSet;
}

/**
 * Marked rather than hidden: disappearing from a list looks like the thing does
 * not exist, and leaves nowhere to learn what is missing.
 */
function agentLabel(agent: AgentView, runsHere: boolean) {
  return runsHere ? agent.label : `${agent.label} · unavailable here`;
}

/**
 * Whether a machine can take work.
 *
 * Reconnecting counts, but only for one that has worked before: a host with
 * nothing installed reconnects forever, so without `workerVersion` it would sit
 * in the list looking launchable and fail every time.
 */
function usable(host?: Host) {
  return !!host && (host.state === "Online" || (host.reconnecting && !!host.workerVersion));
}

/** "this machine" rather than `localhost` — a hostname doesn't say it. */
function where(host?: Host) {
  if (!host) return "nowhere to run";
  return host.compute.type === "Local" ? "this machine" : host.name;
}

function picked(host?: Host) {
  if (!host) return "nowhere to run";
  if (host.state === "Online") return where(host);
  return `${where(host)} — ${host.reconnecting ? "reconnecting" : "unreachable"}`;
}

/**
 * The line under the button: what will happen, or what is in the way.
 *
 * Takes the agent rather than a precomputed verdict about it. It used to take
 * both, and the caller had to invent an agent to ask about when there was
 * none — which it did with a cast, and which crashed the dialog the moment
 * anything read a field off it.
 */
function why({
  hosts,
  chosen,
  host,
  repos,
}: {
  hosts: number;
  chosen?: AgentView;
  host?: Host;
  repos: number;
}) {
  if (hosts === 0) return "You have no compute. Add a machine first.";
  if (!chosen) return "No agent to run. Install one on a host.";
  if (!host || !canRun(chosen, host.id)) {
    const installed = chosen.hosts.find((h) => h.hostId === host?.id)?.installed;
    return `${where(host)} can't run ${chosen.label} — ${
      installed
        ? "it has no credentials there. Give it a token on the Agents screen; this machine being signed in doesn't cover other hosts."
        : "it isn't installed there."
    }`;
  }
  if (repos === 0) {
    return "A workspace with nothing checked out — the agent starts where you put it and clones nothing.";
  }
  return "Cuts the branch, starts the agent, and opens it. Say what you want doing there.";
}

export { AGENT_LABEL };

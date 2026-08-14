"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useListRepos, useRepoBranches } from "@/src/api/generated/repos/repos";
import { useListAgents } from "@/src/api/generated/agents/agents";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import type { Agent, AgentView, Host } from "@/src/api/generated/model";
import {
  useCreateSession,
  getListSessionsQueryKey,
} from "@/src/api/generated/sessions/sessions";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Whether this agent could run on this particular host.
 *
 * Authentication is per host, not global: a subscription lives in the agent's
 * own config on the machine it was signed in on, so one host being logged in
 * says nothing about another. Only a token we hold travels.
 *
 * Getting this wrong offered a container that had no credentials at all,
 * because a laptop elsewhere happened to be signed in.
 */
function canRun(agent: AgentView, hostId: string) {
  const here = agent.hosts.find((h) => h.hostId === hostId);
  if (!here?.installed) return false;
  if (!agent.needsCredential) return true;

  // Either this host is signed in itself, or we have a token to give it.
  return here.loggedIn === true || agent.credentialSet;
}

/**
 * What the chip shows for an agent, given the machine that's chosen.
 *
 * Marked rather than hidden: disappearing from a dropdown looks like the thing
 * doesn't exist, and leaves nowhere to learn what is missing.
 */
function agentLabel(agent: AgentView, runsHere: boolean) {
  if (runsHere) return agent.label;
  return `${agent.label} · unavailable here`;
}

export function Composer() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [repoId, setRepoId] = useState<string>("");
  const [agent, setAgent] = useState<Agent | "">("");
  const [base, setBase] = useState<string>("");
  const [branch, setBranch] = useState<string>("");
  const [hostId, setHostId] = useState<string>("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: repos = [] } = useListRepos();

  // "No repository" is a real choice, not an empty state: an agent with a
  // workspace and nothing checked out.
  const NONE = "No repository";
  const repo = repoId === NONE ? undefined : (repos.find((r) => r.id === repoId) ?? repos[0]);

  const { data: agents = [] } = useListAgents();
  const { data: allHosts = [] } = useListHosts();

  // Where first, then what. The machine decides which agents are available —
  // an agent is software installed on a particular host, so asking the other
  // way round means the machine you picked can vanish from its own list.
  const hosts = allHosts.filter((h) => h.state === "Online" && !h.drained);
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0];

  /** Whether this agent could run on the host that's currently chosen. */
  const runsHere = (a: AgentView) => (host ? canRun(a, host.id) : false);

  // Every agent, in the order they'd be useful, each labelled with what the
  // chosen machine can actually do with it.
  const choices = [...agents].sort(
    (a, b) => Number(runsHere(b)) - Number(runsHere(a)),
  );
  const chosenAgent = (agent ||
    choices.find(runsHere)?.kind ||
    choices[0]?.kind) as Agent | undefined;
  const chosen = choices.find((c) => c.kind === chosenAgent);

  // Only ask once the composer is open — it reaches the remote.
  const { data: branchInfo } = useRepoBranches(repo?.id ?? "", {
    query: { enabled: open && !!repo },
  });
  const branches = branchInfo?.branches ?? [];
  const chosenBase = base || branchInfo?.defaultBranch || repo?.defaultBranch || "main";

  const create = useCreateSession({
    mutation: {
      onSuccess: (session) => {
        queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
        router.push(`/sessions/${session.id}`);
      },
    },
  });

  useEffect(() => {
    if (open) ta.current?.focus();
  }, [open]);

  /* Launching opens the session — you land on the workspace being built. */
  const launch = () => {
    if (!text.trim() || !chosenAgent || create.isPending) return;
    create.mutate({
      data: {
        repoId: repo?.id,
        prompt: text.trim(),
        agent: chosenAgent,
        // Everything about a checkout goes together, or none of it does.
        base: repo ? chosenBase : undefined,
        branch: repo ? branch.trim() || undefined : undefined,
        hostId: host?.id,
      },
    });
  };

  return (
    <div
      className={`panel overflow-hidden transition-colors ${
        open ? "border-line bg-raise" : "hover:border-[#33302c]"
      }`}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <textarea
          ref={ta}
          rows={open ? 3 : 1}
          value={text}
          placeholder="What should we work on?"
          onFocus={() => setOpen(true)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) launch();
            if (e.key === "Escape") setOpen(false);
          }}
          className="flex-1 resize-none bg-transparent text-[14px] leading-6 text-bone placeholder:text-mute focus:outline-none"
        />
        {!open && (
          <span className="mt-0.5 font-mono text-[11px] text-mute">{repo?.slug ?? NONE}</span>
        )}
      </div>

      {open && (
        <div className="border-t border-line px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip
              glyph="repo"
              value={repo?.slug ?? NONE}
              onChange={(slug) =>
                setRepoId(slug === NONE ? NONE : (repos.find((r) => r.slug === slug)?.id ?? ""))
              }
              options={[...repos.map((r) => r.slug), NONE]}
            />
            {repo && (
            <Chip
              glyph="branch"
              value={chosenBase}
              onChange={setBase}
              options={branches.length ? branches : [chosenBase]}
            />
            )}
            {repo && (
            <label className="flex items-center gap-1.5 rounded-[5px] border border-line bg-panel py-1 pr-2 pl-2 text-[12px] text-dim transition-colors focus-within:border-ember/40 hover:border-[#3a3631]">
              <span className="text-mute">⎇</span>
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder={suggestion(text)}
                spellCheck={false}
                className="w-[190px] bg-transparent font-mono text-[11.5px] text-bone placeholder:text-mute focus:outline-none"
              />
            </label>
            )}

            {/* Every machine that's up. Nothing here is filtered by which
                agent you picked — that would hide the thing you just added. */}
            <Chip
              glyph="host"
              value={where(host)}
              onChange={(name) => setHostId(hosts.find((h) => where(h) === name)?.id ?? "")}
              options={hosts.length ? hosts.map((h) => where(h)) : ["nowhere to run"]}
            />

            <Chip
              glyph="agent"
              value={chosen ? agentLabel(chosen, runsHere(chosen)) : "no agent"}
              onChange={(name) =>
                setAgent(
                  choices.find((c) => agentLabel(c, runsHere(c)) === name)?.kind ?? "",
                )
              }
              options={choices.map((c) => agentLabel(c, runsHere(c)))}
            />

            <div className="ml-auto flex items-center gap-3">
              <span className="font-mono text-[10px] text-mute">⌘⏎</span>
              <button
                onClick={launch}
                disabled={
                  !text.trim() ||
                  !host ||
                  !chosen ||
                  !runsHere(chosen) ||
                  create.isPending
                }
                className="rounded-[5px] bg-ember px-3.5 py-1.5 text-[12.5px] font-semibold text-[#1a0c04] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-line disabled:text-mute"
              >
                {create.isPending ? "Opening…" : "Launch"}
              </button>
            </div>
          </div>

          {create.isError && (
            <p className="mt-2.5 border-t border-line pt-2.5 font-mono text-[11.5px] text-brick">
              {(create.error as { code?: string; message?: string }).code === "NoCapacity"
                ? "No host is available to take this."
                : (create.error as { message?: string }).message ?? "Couldn't launch."}
            </p>
          )}

          <p className="mt-2.5 border-t border-line pt-2.5 text-[11.5px] text-mute">
            {hosts.length === 0
              ? "No machine is online. Add compute first."
              : !chosen
                ? "No agent to run. Install one on a host."
                : !runsHere(chosen)
                  ? `${where(host)} can't run ${chosen.label} — ${
                      chosen.hosts.find((h) => h.hostId === host?.id)?.installed
                        ? "it has no credentials there. Give it a token on the Agents screen; this machine being signed in doesn't cover other hosts."
                        : "it isn't installed there."
                    }`
                  : repo
                    ? "Opens the session so you can watch it start. The workspace stays until you end the session."
                    : "A workspace with nothing checked out — the agent starts where you put it and clones nothing."}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * What the branch would be called if you leave it alone.
 *
 * Shown as a placeholder rather than filled in, so the field stays yours to
 * type in and the fallback is visible without being in the way.
 */
function suggestion(prompt: string) {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-");
  return slug ? `agent/${slug}` : "branch name";
}

/** What to show for the chosen agent, before the list has loaded. */

/**
 * What to call a host in the picker.
 *
 * "this machine" rather than `localhost`, because where a session runs is a
 * meaningfully different answer and a hostname doesn't say it.
 */
function where(host?: Host) {
  if (!host) return "nowhere to run";
  return host.compute.type === "Local" ? "this machine" : host.name;
}



const GLYPHS: Record<string, React.ReactNode> = {
  repo: "▣",
  branch: "⑂",
  agent: "◈",
  host: "⌂",
};

function Chip({
  glyph,
  value,
  options,
  onChange,
}: {
  glyph: string;
  value: string;
  options: string[];
  onChange?: (v: string) => void;
}) {
  return (
    <label className="group relative flex items-center gap-1.5 rounded-[5px] border border-line bg-panel py-1 pr-6 pl-2 text-[12px] text-dim transition-colors hover:border-[#3a3631] hover:text-text">
      <span className="text-mute">{GLYPHS[glyph]}</span>
      <span className="max-w-[150px] truncate">{value}</span>
      <span className="pointer-events-none absolute right-2 text-[9px] text-mute">▾</span>
      <select
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}

"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useListRepos, useRepoBranches } from "@/src/api/generated/repos/repos";
import { useListAgents } from "@/src/api/generated/agents/agents";
import type { Agent, AgentView } from "@/src/api/generated/model";
import {
  useCreateSession,
  getListSessionsQueryKey,
} from "@/src/api/generated/sessions/sessions";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Whether this agent could actually run a session right now.
 *
 * Installed somewhere, and either needing no credential or having one — either
 * a token we hold or a host already signed in. Offering an agent that cannot
 * start is offering a failure.
 */
function usable(agent: AgentView) {
  const installed = agent.hosts.some((h) => h.installed);
  const authenticated =
    !agent.needsCredential ||
    agent.credentialSet ||
    agent.hosts.some((h) => h.loggedIn);
  return installed && authenticated;
}

export function Composer() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [repoId, setRepoId] = useState<string>("");
  const [agent, setAgent] = useState<Agent | "">("");
  const [base, setBase] = useState<string>("");
  const [branch, setBranch] = useState<string>("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: repos = [] } = useListRepos();
  const repo = repos.find((r) => r.id === repoId) ?? repos[0];

  const { data: agents = [] } = useListAgents();
  const choices = agents.filter(usable);
  // Fall back to whatever is usable rather than to a hard-coded name, so the
  // chip can never offer something that would fail to start.
  const chosenAgent = (agent || choices[0]?.kind) as Agent | undefined;

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
    if (!text.trim() || !repo || !chosenAgent || create.isPending) return;
    create.mutate({
      data: {
        repoId: repo.id,
        prompt: text.trim(),
        agent: chosenAgent,
        base: chosenBase,
        branch: branch.trim() || undefined,
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
          <span className="mt-0.5 font-mono text-[11px] text-mute">{repo?.slug ?? "no repository"}</span>
        )}
      </div>

      {open && (
        <div className="border-t border-line px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip
              glyph="repo"
              value={repo?.slug ?? "none"}
              onChange={(slug) => setRepoId(repos.find((r) => r.slug === slug)?.id ?? "")}
              options={repos.map((r) => r.slug)}
            />
            <Chip
              glyph="branch"
              value={chosenBase}
              onChange={setBase}
              options={branches.length ? branches : [chosenBase]}
            />
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

            <Chip
              glyph="agent"
              value={label(chosenAgent, choices)}
              onChange={(name) =>
                setAgent(choices.find((c) => c.label === name)?.kind ?? "")
              }
              options={choices.map((c) => c.label)}
            />

            <div className="ml-auto flex items-center gap-3">
              <span className="font-mono text-[10px] text-mute">⌘⏎</span>
              <button
                onClick={launch}
                disabled={!text.trim() || !repo || !chosenAgent || create.isPending}
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
            {choices.length === 0
              ? "No agent is ready. Connect one on the Agents screen first."
              : "Opens the session so you can watch it start. Firetower names the branch from your prompt; the workspace stays until you end the session."}
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
function label(kind: Agent | undefined, choices: AgentView[]) {
  return choices.find((c) => c.kind === kind)?.label ?? "no agent ready";
}

const GLYPHS: Record<string, React.ReactNode> = {
  repo: "▣",
  branch: "⑂",
  agent: "◈",
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

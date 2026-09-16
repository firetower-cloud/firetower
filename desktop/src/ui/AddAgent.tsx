/**
 * Another agent in this workspace.
 *
 * Not another workspace: the same checkout, the same branch, a second
 * conversation beside the first — a reviewer next to the author, or a
 * different model on the same problem. Git sees one working tree, so the
 * diff and the commit stay one.
 *
 * The rule for which agents can start here is the web's (`unavailable`):
 * the workspace is one directory on one machine, so the agent has to be
 * installed and signed in *there*. Unavailable ones stay listed and say why.
 * With an opening message the new agent starts on it straight away — that is
 * how notes are handed to a second agent.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, X } from "lucide-react";
import { AgentMark } from "~/components/AgentMark";
import { unavailable } from "~/components/workspace/StartAgent";
import { getListSessionsQueryKey, useCreateSession } from "~/api/generated/sessions/sessions";
import type { Agent, Session } from "~/api/generated/model";
import { usable } from "~/api/accounts";
import { useAccounts, useAgents, useHosts, why } from "~/data";
import { navigate } from "~/shims/next-navigation";

export function AddAgent({
  session,
  workspaceId,
  prompt,
  onClose,
  onStarted,
}: {
  /** One session already in the workspace — for the host it is on. */
  session: Session;
  workspaceId: string;
  /** What the new agent starts on, when it is being handed something. */
  prompt?: string;
  onClose: () => void;
  onStarted?: (id: string) => void;
}) {
  const agents = useAgents();
  const hosts = useHosts();
  const accounts = useAccounts();
  const cache = useQueryClient();
  const create = useCreateSession();
  const host = hosts.data.find((h) => h.id === session.hostId);
  const [picked, setPicked] = useState<Agent | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () => agents.data.filter((a) => a.enabled).map((a) => ({ agent: a, why: unavailable(a, host?.id, host?.name) })),
    [agents.data, host],
  );
  /* Accounts for the chosen kind. One is a fact, not a choice. */
  const forKind = useMemo(() => accounts.data.filter((a) => a.kind === picked && usable(a)), [accounts.data, picked]);
  const chosen = forKind.find((a) => a.id === account) ?? forKind.find((a) => a.isDefault) ?? forKind[0];

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const start = (agent: Agent) => {
    setTrouble(null);
    create.mutate(
      { data: { workspaceId, agent, accountId: chosen?.id ?? null, prompt: prompt ?? null } },
      {
        onSuccess: (made) => {
          cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
          onStarted?.(made.id);
          onClose();
          navigate(`/sessions/${made.id}`);
        },
        onError: (e) => setTrouble(why(e) ?? "It did not start."),
      },
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div ref={card} onMouseDown={(e) => e.stopPropagation()} className="fixed top-24 left-1/2 z-50 w-[26rem] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-overlay shadow-(--shadow-float)">
        <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
          <Bot className="h-4 w-4 text-slate" strokeWidth={1.75} />
          <span className="text-ui text-bone">Add an agent to this workspace</span>
          <button onClick={onClose} className="ml-auto grid h-6 w-6 place-items-center rounded text-mute hover:bg-raise hover:text-bone"><X className="h-3.5 w-3.5" strokeWidth={2} /></button>
        </div>
        <p className="px-4 pb-3 text-meta text-mute">
          Same checkout, same branch{host ? `, on ${host.name}` : ""}. {prompt ? "It starts on your notes." : "One diff, one commit, whoever wrote what."}
        </p>

        {agents.loading && <p className="px-4 py-3 text-meta text-mute">Reading the agents…</p>}
        {agents.error && <p className="px-4 py-3 text-meta text-brick">{agents.error}</p>}
        <ul className="border-t border-line-soft py-1">
          {rows.map(({ agent, why: reason }) => {
            const on = picked === agent.kind;
            return (
              <li key={agent.kind}>
                <button
                  disabled={!!reason || create.isPending}
                  onClick={() => {
                    setPicked(agent.kind);
                    setAccount(null);
                    const mine = accounts.data.filter((a) => a.kind === agent.kind && usable(a));
                    if (mine.length <= 1) start(agent.kind);
                  }}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${reason ? "opacity-50" : "hover:bg-raise/70"} ${on ? "bg-raise/50" : ""}`}
                >
                  <AgentMark agent={agent.kind} size={14} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-ui text-bone">{agent.label}</span>
                    <span className="block truncate text-micro text-mute">{reason ?? (agent.hosts.find((h) => h.hostId === host?.id)?.account ?? "ready here")}</span>
                  </span>
                  {create.isPending && on && <span className="text-micro text-mute">starting…</span>}
                </button>
                {on && forKind.length > 1 && (
                  <div className="flex items-center gap-2 px-4 pb-2.5 pl-11">
                    <select value={chosen?.id ?? ""} onChange={(e) => setAccount(e.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 text-ui text-bone focus:outline-none">
                      {forKind.map((a) => <option key={a.id} value={a.id}>{a.name}{a.identity ? ` · ${a.identity}` : ""}</option>)}
                    </select>
                    <button disabled={create.isPending} onClick={() => start(agent.kind)} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">Start</button>
                  </div>
                )}
              </li>
            );
          })}
          {!agents.loading && rows.length === 0 && <li className="px-4 py-3 text-meta text-mute">No agent is set up on this server. Configuration → Agents.</li>}
        </ul>
        {trouble && <p className="border-t border-line-soft px-4 py-2.5 text-meta text-brick">{trouble}</p>}
      </div>
    </>
  );
}

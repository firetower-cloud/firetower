"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAgents,
  useCheckAgents,
  useForgetAgent,
  getListAgentsQueryKey,
} from "@/src/api/generated/agents/agents";
import { AgentMode, type AgentView } from "@/src/api/generated/model";
import { ConnectAgent } from "@/components/ConnectAgent";
import { KeyGlyph } from "@/components/Signal";

export default function Agents() {
  const [configuring, setConfiguring] = useState<AgentView | null>(null);

  const queryClient = useQueryClient();
  const { data: agents = [], isLoading } = useListAgents();
  const check = useCheckAgents();

  const refresh = () =>
    check.mutate(undefined, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() }),
    });

  const configured = agents.filter((a) => a.needsCredential && a.mode).length;
  const waiting = agents.filter((a) => a.needsCredential && !a.mode).length;

  return (
    <div className="max-w-[900px] px-8 pt-8 pb-24">
      <header className="mb-7">
        <div className="eyebrow">Agents</div>
        <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-bone">
          {isLoading
            ? "Looking…"
            : waiting === 0
              ? `${configured} configured.`
              : `${waiting} still ${waiting === 1 ? "needs" : "need"} a credential.`}
        </h1>
        <p className="mt-1.5 max-w-[56ch] text-[14px] text-dim">
          Firetower runs the real CLI on your hosts. You authenticate once here, and the
          credential is handed to a workspace when one starts — never written to a
          worker&apos;s disk.
        </p>
      </header>

      <div className="flex flex-col gap-2.5">
        {agents.map((a) => (
          <AgentRow key={a.kind} agent={a} onConfigure={() => setConfiguring(a)} />
        ))}
      </div>

      <button
        onClick={refresh}
        disabled={check.isPending}
        className="mt-4 w-full rounded-[6px] border border-dashed border-line py-3 text-[13px] text-mute transition-colors hover:border-ember/40 hover:text-ember disabled:hover:border-line disabled:hover:text-mute"
      >
        {check.isPending ? "Checking your hosts…" : "Check hosts again"}
      </button>

      {configuring && (
        <ConnectAgent agent={configuring} onClose={() => setConfiguring(null)} />
      )}
    </div>
  );
}

function AgentRow({
  agent,
  onConfigure,
}: {
  agent: AgentView;
  onConfigure: () => void;
}) {
  const queryClient = useQueryClient();
  const forget = useForgetAgent();

  const anywhere = agent.hosts.filter((h) => h.installed);

  return (
    <div className="panel px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="text-[13.5px] text-bone">{agent.label}</span>
        <Mode agent={agent} />
        {agent.needsCredential && (
          <button onClick={onConfigure} className="ml-auto text-[11.5px] text-mute transition-colors hover:text-ember">
            {agent.mode ? "Change" : "Connect"}
          </button>
        )}
        {agent.mode && agent.needsCredential && (
          <button
            onClick={() =>
              forget.mutate(
                { kind: agent.kind },
                {
                  onSuccess: () =>
                    queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() }),
                },
              )
            }
            className="text-[11.5px] text-mute transition-colors hover:text-ember"
          >
            Forget
          </button>
        )}
      </div>

      <div className="mt-3 border-t border-line pt-3">
        <div className="eyebrow mb-2">
          On your hosts
          {anywhere.length > 0 && (
            <span className="ml-2 normal-case tracking-normal text-mute">
              {anywhere.length} of {agent.hosts.length}
            </span>
          )}
        </div>

        {agent.hosts.length === 0 && (
          <p className="text-[12px] text-mute">No hosts yet.</p>
        )}

        {agent.hosts.map((h) => (
          <div key={h.hostId} className="flex items-center gap-2.5 py-[3px]">
            <span
              className={`h-1.5 w-1.5 rounded-full ${h.installed ? "bg-sage" : "border border-mute"}`}
            />
            <span className="font-mono text-[11.5px] text-dim">{h.hostName}</span>
            {h.installed ? (
              <>
                <span className="shrink-0 font-mono text-[11px] text-mute">{h.version}</span>
                {h.loggedIn === false && (
                  <span className="shrink-0 text-[11px] text-ember">signed out</span>
                )}
                {h.account && (
                  <span className="min-w-0 truncate text-[11px] text-slate">{h.account}</span>
                )}
              </>
            ) : (
              <span className="text-[11.5px] text-mute">
                {h.checkedAt ? "not installed" : "not checked yet"}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** What the row says about how this agent authenticates. */
function Mode({ agent }: { agent: AgentView }) {
  if (!agent.needsCredential) {
    return <Tag>nothing to authenticate</Tag>;
  }
  if (!agent.mode) {
    return <Tag warn>not configured</Tag>;
  }
  if (agent.mode === AgentMode.ApiKey) {
    return (
      <Tag>
        <span className="mr-1 inline-flex align-[-1px] text-slate">
          <KeyGlyph size={10} />
        </span>
        {agent.credentialSet ? "API key" : "API key missing"}
      </Tag>
    );
  }
  return <Tag>subscription</Tag>;
}

function Tag({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <span
      className={`rounded-[4px] border px-1.5 py-0.5 font-mono text-[10.5px] ${
        warn ? "border-ember/30 text-ember" : "border-line text-slate"
      }`}
    >
      {children}
    </span>
  );
}

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
import { Install } from "@/components/InstallAgent";
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

  // Only the ones Firetower can actually run. Counting an agent it has no
  // driver for as "still needs a credential" sends somebody to configure a
  // thing that would not start afterwards.
  const runnable = agents.filter((a) => a.supported);
  const configured = runnable.filter((a) => a.needsCredential && a.mode).length;
  const waiting = runnable.filter((a) => a.needsCredential && !a.mode).length;

  return (
    <div className="max-w-[900px] px-8 pt-8 pb-24">
      <header className="mb-7">
        <div className="eyebrow">Agents</div>
        <h1 className="mt-2 text-display font-semibold text-bone">
          {isLoading
            ? "Looking…"
            : waiting === 0
              ? `${configured} configured.`
              : `${waiting} still ${waiting === 1 ? "needs" : "need"} a credential.`}
        </h1>
        <p className="mt-1.5 text-ui text-dim">
          Authenticate once here. The credential is handed to a workspace as it starts,
          never written to a worker&apos;s disk.
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
        className="mt-4 w-full rounded-sm border border-dashed border-line py-3 text-ui text-mute transition-colors hover:border-line hover:text-bone disabled:hover:border-line disabled:hover:text-mute"
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
        <span className="text-ui text-bone">{agent.label}</span>
        <Mode agent={agent} />
        {/* Connecting is not gated on there being a driver. Signing in is the
            half that needs a person and a browser, and it is worth having done
            before a session can use it — the row still says there is no driver
            yet, so nobody is being told the agent will run. */}
        {(agent.supported || agent.signsInWithACode) && agent.needsCredential && (
          <button onClick={onConfigure} className="ml-auto text-meta text-mute transition-colors hover:text-bone">
            {agent.mode ? "Change" : "Connect"}
          </button>
        )}
        {(agent.supported || agent.signsInWithACode) && agent.mode && agent.needsCredential && (
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
            className="text-meta text-mute transition-colors hover:text-bone"
          >
            Forget
          </button>
        )}
      </div>

      {!agent.supported && (
        <p className="mt-2 max-w-[62ch] text-meta leading-[1.5] text-mute">
          Firetower has no driver for {agent.label} yet, so it cannot start a session on
          one. It is listed because it may be installed on your hosts — that is worth
          seeing, and it is what a driver would use.
          {agent.signsInWithACode && " Signing in already works, and is kept for when it does."}
        </p>
      )}

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
          <p className="text-meta text-mute">No hosts yet.</p>
        )}

        {agent.hosts.map((h) => (
          <div key={h.hostId} className="flex items-center gap-2.5 py-[3px]">
            <span
              className={`h-1.5 w-1.5 rounded-full ${h.installed ? "bg-sage" : "border border-mute"}`}
            />
            <span className="font-mono text-meta text-dim">{h.hostName}</span>
            {h.installed ? (
              <>
                <span className="shrink-0 font-mono text-meta text-mute">{h.version}</span>
                {h.loggedIn === false && (
                  <span className="shrink-0 text-meta text-brick">signed out</span>
                )}
                {h.account && (
                  <span className="min-w-0 truncate text-meta text-slate">{h.account}</span>
                )}
              </>
            ) : (
              <>
                <span className="text-meta text-mute">
                  {h.checkedAt ? "not installed" : "not checked yet"}
                </span>
                <span className="ml-auto flex items-center gap-2.5">
                  <Install agent={agent} host={h} />
                </span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** What the row says about how this agent authenticates. */
function Mode({ agent }: { agent: AgentView }) {
  // Before anything about credentials, because none of it applies: an agent
  // Firetower cannot drive will not start whatever you authenticate it with.
  //
  // Unless it is already signed in, which is a real thing to have done and
  // survives the driver arriving. Saying only "not supported yet" would throw
  // away the one piece of state the person actually created.
  if (!agent.supported) {
    return agent.credentialSet ? (
      <>
        <Tag>signed in</Tag>
        <Tag warn>no driver yet</Tag>
      </>
    ) : (
      <Tag warn>not supported yet</Tag>
    );
  }
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
      className={`rounded-sm border px-1.5 py-0.5 font-mono text-micro ${
        warn ? "border-brick-deep text-brick" : "border-line text-slate"
      }`}
    >
      {children}
    </span>
  );
}

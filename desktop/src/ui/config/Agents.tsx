/**
 * Agents and the accounts they run on.
 *
 * An agent is a thing installed on a host; an account is whose subscription
 * it uses. Connecting one is `ConnectAccount`; this is the list — what each
 * account is called, whether it is connected, what is left of its allowance,
 * and which one new work runs on.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Download, Plus, RefreshCw, Trash2 } from "lucide-react";
import { AgentMark } from "~/components/AgentMark";
import { Icon } from "~/components/ui";
import type { Account, AgentView } from "~/api/generated/model";
import { getListAgentsQueryKey, useCheckAgents, useConfigureAgent, useForgetAgent, useInstallAgent } from "~/api/generated/agents/agents";
import { getListAccountsQueryKey, useUpdateAccount } from "~/api/generated/accounts/accounts";
import { quota } from "~/api/accounts";
import { useAccounts, useAgents, useHosts } from "~/data";
import { Rows, Section } from "~/ui/config/bits";
import { ConnectAccount } from "~/ui/config/ConnectAccount";
import { useConfirm } from "~/ui/Confirm";

export function Agents({ live }: { live: boolean }) {
  const cache = useQueryClient();
  const agents = useAgents();
  const accounts = useAccounts();
  const check = useCheckAgents();
  const [open, setOpen] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<{ agent: AgentView; account?: Account } | null>(null);

  return (
    <>
      <Section
        title="Agents"
        note="What is installed where, and whether it is signed in."
        action={live && <button disabled={check.isPending} onClick={() => check.mutate(undefined as never, { onSuccess: () => cache.invalidateQueries({ queryKey: getListAgentsQueryKey() }) })} className="control border border-line bg-raise text-ui text-dim hover:bg-overlay disabled:text-mute"><Icon of={RefreshCw} size={12} />{check.isPending ? "Checking…" : "Check all"}</button>}
      >
        <Rows feed={agents} empty="No agent is configured.">
          {agents.data.map((a) => (
            <div key={a.kind}>
              <button onClick={() => setOpen(open === a.kind ? null : a.kind)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-raise/60">
                <AgentMark agent={a.kind} size={14} className="shrink-0 text-dim" />
                <span className="min-w-0 flex-1">
                  <span className="block text-ui text-bone">{a.label}</span>
                  <span className="block text-micro text-mute">{a.hosts.filter((h) => h.installed).length} of {a.hosts.length} host{a.hosts.length === 1 ? "" : "s"} · {accounts.data.filter((x) => x.kind === a.kind).length} account{accounts.data.filter((x) => x.kind === a.kind).length === 1 ? "" : "s"}</span>
                </span>
                {a.credentialSet ? <span className="flex items-center gap-1.5 text-meta text-sage"><Icon of={Check} size={12} />signed in</span> : a.needsCredential ? <span className="text-meta text-kind-data">needs an account</span> : <span className="text-meta text-mute">no credential needed</span>}
                <ChevronDown className={`h-3.5 w-3.5 text-mute transition-transform ${open === a.kind ? "rotate-180" : ""}`} strokeWidth={2} />
              </button>
              {open === a.kind && live && <AgentDetail agent={a} accounts={accounts.data.filter((x) => x.kind === a.kind)} onConnect={(account) => setConnecting({ agent: a, account })} />}
            </div>
          ))}
        </Rows>
      </Section>
      {connecting && <ConnectAccount agent={connecting.agent} account={connecting.account} onClose={() => setConnecting(null)} />}
    </>
  );
}

function AgentDetail({ agent, accounts, onConnect }: { agent: AgentView; accounts: Account[]; onConnect: (account?: Account) => void }) {
  const confirm = useConfirm();
  const cache = useQueryClient();
  const hosts = useHosts();
  const install = useInstallAgent();
  const configure = useConfigureAgent();
  const forget = useForgetAgent();
  const change = useUpdateAccount();
  const refresh = () => Promise.all([cache.invalidateQueries({ queryKey: getListAgentsQueryKey() }), cache.invalidateQueries({ queryKey: getListAccountsQueryKey() })]);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  return (
    <div className="space-y-3 border-t border-line-soft bg-ground/40 px-3.5 py-3">
      <div>
        <span className="text-meta text-dim">On each machine</span>
        <div className="mt-1.5 space-y-1">
          {hosts.data.map((h) => {
            const on = agent.hosts.find((x) => x.hostId === h.id);
            return (
              <div key={h.id} className="flex items-center gap-2 rounded-md bg-ground px-2.5 py-1.5 text-ui">
                <span className="min-w-0 flex-1 truncate text-text">{h.name}</span>
                <span className="font-mono text-micro text-mute">{on?.installed ? (on.version ?? "installed") : "not installed"}{on?.loggedIn ? " · signed in" : ""}</span>
                <button disabled={install.isPending || !agent.supported} onClick={() => install.mutate({ kind: agent.kind, data: { hostId: h.id } }, { onSuccess: refresh })} className="control h-6 border border-line bg-raise text-micro text-bone hover:bg-overlay disabled:text-mute"><Icon of={Download} size={12} />{on?.installed ? "Reinstall" : "Install"}</button>
              </div>
            );
          })}
          {hosts.data.length === 0 && <p className="text-meta text-mute">Add a machine first.</p>}
        </div>
      </div>

      {agent.needsCredential && (
        <div>
          <div className="flex items-center gap-2">
            <span className="text-meta text-dim">Accounts</span>
            <button onClick={() => onConnect()} className="control ml-auto h-6 border border-line bg-raise text-micro text-bone hover:bg-overlay"><Icon of={Plus} size={12} />Connect an account</button>
          </div>
          <div className="mt-1.5 space-y-1">
            {accounts.map((a) => {
              const connected = a.state === "connected" && a.credentialSet;
              return (
                <div key={a.id} className="flex items-center gap-2 rounded-md bg-ground px-2.5 py-1.5 text-ui">
                  {renaming?.id === a.id ? (
                    <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: a.id, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") change.mutate({ id: a.id, data: { name: renaming.name } }, { onSuccess: () => { refresh(); setRenaming(null); } }); if (e.key === "Escape") setRenaming(null); }} className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5 text-ui text-bone focus:outline-none" />
                  ) : (
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-text">
                        {a.name}
                        {a.isDefault && <span className="ml-1.5 text-micro text-mute">· default</span>}
                        {!a.enabled && <span className="ml-1.5 text-micro text-mute">· disabled</span>}
                      </span>
                      <span className={`block truncate text-micro ${connected ? "text-mute" : "text-kind-data"}`}>
                        {connected ? [a.identity, quota(a)].filter(Boolean).join(" · ") : a.state === "connected" ? "no credential held" : a.state}
                      </span>
                    </span>
                  )}
                  {renaming?.id !== a.id && <button onClick={() => setRenaming({ id: a.id, name: a.name })} className="text-micro text-mute hover:text-bone">rename</button>}
                  <button onClick={() => onConnect(a)} className="text-micro text-mute hover:text-bone">{connected ? "reconnect" : "finish connecting"}</button>
                  {!a.isDefault && a.enabled && connected && <button onClick={() => change.mutate({ id: a.id, data: { isDefault: true } }, { onSuccess: refresh })} className="text-micro text-mute hover:text-bone">make default</button>}
                  {!a.isDefault && <button onClick={() => change.mutate({ id: a.id, data: { enabled: !a.enabled } }, { onSuccess: refresh })} className="text-micro text-mute hover:text-bone">{a.enabled ? "disable" : "enable"}</button>}
                </div>
              );
            })}
            {accounts.length === 0 && <p className="text-meta text-mute">None yet. A workspace needs one to run on.</p>}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-meta text-dim">
          <input type="checkbox" checked={agent.enabled} onChange={(e) => configure.mutate({ kind: agent.kind, data: { enabled: e.target.checked, mode: (agent.mode ?? "Subscription") as never } }, { onSuccess: refresh })} />
          Offered when starting work
        </label>
        <button onClick={() => void confirm({ title: `Forget ${agent.label}'s configuration on this server?`, action: "Forget", tone: "danger" }).then((ok) => ok && forget.mutate({ kind: agent.kind }, { onSuccess: refresh }))} className="control ml-auto text-mute hover:text-brick"><Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />Forget</button>
      </div>
    </div>
  );
}

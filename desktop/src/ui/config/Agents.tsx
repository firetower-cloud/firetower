/**
 * Agents and the accounts they run on.
 *
 * An agent is a thing installed on a host; an account is whose subscription
 * it uses. The web's `ConnectAgent` sequence, kept exactly: create the account
 * (`create_account`), then for an agent that signs in with a code ask
 * `sign_agent_in` with that account, show the code, and poll the accounts list
 * until the account's revision moves past the one we made and its state is
 * `connected`. Then, optionally, make it the default.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Download, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { Icon } from "@/components/ui";
import type { Account, AgentView } from "@/src/api/generated/model";
import { getListAgentsQueryKey, useCheckAgents, useConfigureAgent, useForgetAgent, useInstallAgent, useSignAgentIn } from "@/src/api/generated/agents/agents";
import { getListAccountsQueryKey, useCreateAccount, useListAccounts, useUpdateAccount } from "@/src/api/generated/accounts/accounts";
import { useAccounts, useAgents, useHosts } from "~/data";
import { why } from "~/data";
import { DeviceCode, Rows, Section } from "~/ui/config/bits";
import { useConfirm } from "~/ui/Confirm";

export function Agents({ live }: { live: boolean }) {
  const cache = useQueryClient();
  const agents = useAgents();
  const accounts = useAccounts();
  const check = useCheckAgents();
  const [open, setOpen] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<AgentView | null>(null);

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
              {open === a.kind && live && <AgentDetail agent={a} accounts={accounts.data.filter((x) => x.kind === a.kind)} onConnect={() => setConnecting(a)} />}
            </div>
          ))}
        </Rows>
      </Section>
      {connecting && <ConnectAccount agent={connecting} onClose={() => setConnecting(null)} />}
    </>
  );
}

function AgentDetail({ agent, accounts, onConnect }: { agent: AgentView; accounts: Account[]; onConnect: () => void }) {
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
            <button onClick={onConnect} className="control ml-auto h-6 border border-line bg-raise text-micro text-bone hover:bg-overlay"><Icon of={Plus} size={12} />Connect an account</button>
          </div>
          <div className="mt-1.5 space-y-1">
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center gap-2 rounded-md bg-ground px-2.5 py-1.5 text-ui">
                {renaming?.id === a.id ? (
                  <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: a.id, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") change.mutate({ id: a.id, data: { name: renaming.name } }, { onSuccess: () => { refresh(); setRenaming(null); } }); if (e.key === "Escape") setRenaming(null); }} className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5 text-ui text-bone focus:outline-none" />
                ) : (
                  <button onDoubleClick={() => setRenaming({ id: a.id, name: a.name })} className="min-w-0 flex-1 truncate text-left text-text">{a.name}{a.isDefault && <span className="ml-1.5 text-micro text-mute">· default</span>}</button>
                )}
                <span className={`font-mono text-micro ${a.state === "connected" ? "text-sage" : "text-mute"}`}>{a.mode === "ApiKey" ? "api key" : a.identity ?? a.state}</span>
                {!a.isDefault && a.enabled && a.state === "connected" && <button onClick={() => change.mutate({ id: a.id, data: { isDefault: true } }, { onSuccess: refresh })} className="text-micro text-mute hover:text-bone">make default</button>}
                <button onClick={() => change.mutate({ id: a.id, data: { enabled: !a.enabled } }, { onSuccess: refresh })} className="text-micro text-mute hover:text-bone">{a.enabled ? "disable" : "enable"}</button>
              </div>
            ))}
            {accounts.length === 0 && <p className="text-meta text-mute">None yet. A session needs one to run on.</p>}
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

/* ── Connecting an account ─────────────────────────────────────────────── */

function ConnectAccount({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const cache = useQueryClient();
  const create = useCreateAccount();
  const update = useUpdateAccount();
  const login = useSignAgentIn();
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [useKey, setUseKey] = useState(!agent.signsInWithACode);
  const [created, setCreated] = useState<Account | null>(null);
  const [makeDefault, setMakeDefault] = useState(true);
  const [trouble, setTrouble] = useState<string | null>(null);
  const device = agent.signsInWithACode && !useKey;

  /* Poll while a code is out: the account's revision moves past the one we
     made once the provider confirms it. */
  const accounts = useListAccounts({ query: { enabled: !!created && device && !!login.data, refetchInterval: 2000 } });
  const confirmed = accounts.data?.find((a) => a.id === created?.id && a.state === "connected" && a.revision > (created?.revision ?? 0));
  const ready = created && (!device || confirmed);

  const save = async () => {
    setTrouble(null);
    try {
      const made = await create.mutateAsync({ data: { kind: agent.kind, name: name.trim(), mode: (useKey ? "ApiKey" : "Subscription") as never, secret: useKey ? secret : null } });
      setCreated(made);
      await cache.invalidateQueries({ queryKey: getListAccountsQueryKey() });
      if (device) await login.mutateAsync({ kind: agent.kind, data: { accountId: made.id } });
    } catch (e) {
      setTrouble(why(e));
    }
  };

  const finish = async () => {
    if (!created) return;
    await update.mutateAsync({ id: created.id, data: { name: name.trim(), ...(makeDefault ? { isDefault: true } : {}) } });
    await Promise.all([cache.invalidateQueries({ queryKey: getListAccountsQueryKey() }), cache.invalidateQueries({ queryKey: getListAgentsQueryKey() })]);
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ground/70 pt-[10vh] backdrop-blur-[3px]" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-[32rem] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--shadow-float)">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <AgentMark agent={agent.kind} size={16} className="text-dim" />
          <h2 className="text-title text-bone">{ready ? "Account connected" : `Connect a ${agent.label} account`}</h2>
          <button onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"><X className="h-4 w-4" strokeWidth={1.75} /></button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="text-ui text-dim">Account name <span className="text-meta text-mute">— what you'll recognise when switching</span></span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={!!created && !ready} placeholder="Personal Claude, Work, Client Acme…" maxLength={80} className="mt-1.5 w-full rounded-lg border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none disabled:text-dim" />
          </label>

          {!created && (
            <>
              {agent.signsInWithACode && (
                <div className="track w-full">
                  <button data-on={!useKey} onClick={() => setUseKey(false)} className="flex-1">Sign in with a code</button>
                  <button data-on={useKey} onClick={() => setUseKey(true)} className="flex-1">Use an API key</button>
                </div>
              )}
              {useKey && <input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" placeholder="API key" className="w-full rounded-lg border border-line bg-ground px-3 py-2 font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" />}
              {device && !agent.hosts.some((h) => h.installed) && <p className="text-meta text-kind-data">Signing in with a code needs {agent.label} installed on a machine first.</p>}
            </>
          )}

          {created && device && !confirmed && login.data && <DeviceCode code={login.data.userCode} url={login.data.verificationUri} note="Check that you sign in with the intended account." />}

          {ready && (
            <>
              <p className="text-ui text-dim">{agent.label} · {created?.identity ?? confirmed?.identity ?? "Credential connected."}</p>
              <label className="flex items-center gap-2 text-ui text-dim"><input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />Use by default for new work</label>
            </>
          )}

          {trouble && <p className="text-meta text-brick">{trouble}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-ground/40 px-5 py-3">
          <button onClick={onClose} className="control ml-auto text-mute hover:bg-raise hover:text-bone">Cancel</button>
          {ready ? (
            <button disabled={!name.trim() || update.isPending} onClick={finish} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">{update.isPending ? "Saving…" : "Done"}</button>
          ) : (
            <button disabled={!!created || !name.trim() || create.isPending || (useKey && !secret.trim()) || (device && !agent.hosts.some((h) => h.installed))} onClick={save} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">{create.isPending ? "Connecting…" : device ? "Continue to sign in" : "Connect"}</button>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { accountsKey, sessionAccountKey, switchAccount, useAccounts, useSessionAccount, exhausted } from "@/src/api/accounts";
import { useListAgents } from "@/src/api/generated/agents/agents";
import { useGetSession } from "@/src/api/generated/sessions/sessions";
import { useTabs } from "@/src/workspace/tabs";
import { Modal, Foot, Go, Quiet } from "./Modal";
import { AccountFallback } from "./AccountFallback";
import { ConnectAgent } from "./ConnectAgent";
import type { AgentView } from "@/src/api/generated/model";

export function AccountSwitcher({ sessionId, working }: { sessionId: string; working: boolean }) {
  const current = useSessionAccount(sessionId);
  const accounts = useAccounts();
  const agents = useListAgents();
  const session = useGetSession(sessionId);
  const { open } = useTabs();
  const [choosing, setChoosing] = useState(false);
  const [permissionChange, setPermissionChange] = useState(false);
  const [selected, setSelected] = useState("");
  const [connecting, setConnecting] = useState<AgentView | null>(null);
  const cache = useQueryClient();
  const switcher = useMutation({ mutationFn: (id: string) => switchAccount(sessionId, id, permissionChange), onSuccess: async (result) => {
    setChoosing(false);
    await cache.invalidateQueries({ queryKey: sessionAccountKey(sessionId) });
    await cache.invalidateQueries({ queryKey: accountsKey });
    await cache.invalidateQueries({ queryKey: ["/api/v1/sessions"] });
    if (result.sessionId !== sessionId) open({ id: `run:${result.sessionId}`, kind: "run", sessionId: result.sessionId });
  }});
  const blocked = current.data?.limits.find((limit) => exhausted(limit));
  const account = current.data?.account;
  const candidates = accounts.data?.filter((a) => a.id !== account?.id && a.enabled && a.state === "connected" && a.credentialSet) ?? [];
  candidates.sort((a, b) => Number(b.kind === session.data?.agent) - Number(a.kind === session.data?.agent));
  const recommended = candidates.find((a) => a.kind === session.data?.agent && a.mode === "Subscription" && !a.limits.some((l) => exhausted(l)));
  const target = candidates.find((a) => a.id === selected);
  const changesAgent = target && target.kind !== session.data?.agent;
  const pending = switcher.isPending || current.data?.switches.some((s) => s.state === "switching");
  const ownAgent = agents.data?.find((a) => a.kind === session.data?.agent);
  const lastSwitch = current.data?.switches.at(-1);
  return <div className="mb-2 rounded-lg border border-line bg-panel px-4 py-3">
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-meta text-dim">{ownAgent?.label ?? session.data?.agent} · {account?.name ?? "Host account"}</span>
      <button className="ml-auto text-meta text-bone disabled:text-mute" disabled={pending || !session.data || !!session.data.forgottenAt} onClick={() => setChoosing(true)}>{pending ? "Switching account…" : "Switch account"}</button>
    </div>
    {blocked && <div className="mt-2 text-ui text-dim" role="status">
      <p>{account?.name ?? "This account"} reached its usage limit. Your workspace is preserved.</p>
      {blocked.resetsAt && <p className="mt-1 text-meta text-mute">Reset reported for {new Date(blocked.resetsAt * 1000).toLocaleString()}.</p>}
      <div className="mt-2 flex flex-wrap gap-4">{recommended && <button className="text-bone disabled:text-mute" disabled={pending || working} onClick={() => switcher.mutate(recommended.id)}>Continue with {recommended.name}</button>}<button className="text-bone" disabled={pending} onClick={() => setChoosing(true)}>{recommended ? "Other options" : "Choose another account"}</button><span className="text-meta text-mute">Or wait for the limit to reset.</span></div>
    </div>}
    <AccountFallback sessionId={sessionId} />
    {lastSwitch && <p className={`mt-2 text-meta ${lastSwitch.state === "failed" ? "text-brick" : "text-mute"}`}>{lastSwitch.detail ?? "Account switch in progress…"}{lastSwitch.nextSessionId && <button className="ml-2 underline" onClick={() => open({ id: `run:${lastSwitch.nextSessionId}`, kind: "run", sessionId: lastSwitch.nextSessionId! })}>Open continuation</button>}</p>}
    {switcher.error && <p role="alert" className="mt-2 text-meta text-brick">{switcher.error.message}</p>}
    {choosing && <Modal title="Continue this task" onClose={() => setChoosing(false)} wide>
      <p className="text-ui text-dim">Your files, changes and branch stay in this workspace.</p>
      <div className="mt-4 flex flex-col gap-2">
        {candidates.map((a) => {
          const installed = agents.data?.find((agent) => agent.kind === a.kind)?.hosts.some((h) => h.hostId === session.data?.hostId && h.installed);
          return <label key={a.id} className="flex items-center gap-3 rounded border border-line px-3 py-3 text-ui text-bone">
            <input type="radio" name="continue-account" checked={selected === a.id} disabled={!installed || pending} onChange={() => { setSelected(a.id); setPermissionChange(false); }} />
            <span>{agents.data?.find((agent) => agent.kind === a.kind)?.label} · {a.name}<span className="mt-1 block text-meta text-mute">{installed ? a.mode === "ApiKey" ? "Metered API usage" : a.limits.some((l) => exhausted(l)) ? "Limit reached · try after reset" : a.limits.length ? a.limits.map((l) => l.usedPercent != null ? `${l.scope}: ${l.usedPercent}% used (last reported)` : `${l.scope}: ${l.status} (last reported)`).join(" · ") : "Connected · quota unknown" : "Not installed on this host"}</span></span>
          </label>;
        })}
        {candidates.length === 0 && <p className="text-meta text-mute">Connect another account to continue.</p>}
      </div>
      {changesAgent && <p className="mt-4 text-ui text-dim">This starts another agent with a handoff of the request and recorded progress. Its conversation opens in a new tab here; the original history remains available.</p>}
      {changesAgent && <label className="mt-3 flex gap-2 text-meta text-dim"><input type="checkbox" checked={permissionChange} onChange={(e) => setPermissionChange(e.target.checked)} />Use the destination agent’s default permissions: {target?.kind === "Codex" ? "workspace sandbox with network access and approvals on request" : "Claude Code auto permission mode; some tool calls may be approved automatically"}. Existing approvals are not transferred.</label>}
      {working && <p className="mt-3 text-meta text-mute">Stop the current turn before switching. Pending approvals must be answered first.</p>}
      <div className="mt-4 flex gap-4">{agents.data?.filter((a) => a.supported && a.needsCredential).map((a) => <button key={a.kind} className="text-meta text-dim" onClick={() => { setChoosing(false); setConnecting(a); }}>+ Connect {a.label} account</button>)}</div>
      <Foot><Go disabled={!selected || pending || working || (!!changesAgent && !permissionChange)} onClick={() => switcher.mutate(selected)}>{pending ? "Switching…" : changesAgent ? "Hand off and continue" : "Switch and continue"}</Go><Quiet onClick={() => setChoosing(false)}>Cancel</Quiet></Foot>
    </Modal>}
    {connecting && <ConnectAgent agent={connecting} onClose={() => setConnecting(null)} onConnected={(a) => { if (!working && a.kind === session.data?.agent) switcher.mutate(a.id); else { setSelected(a.id); setChoosing(true); } }} />}
  </div>;
}

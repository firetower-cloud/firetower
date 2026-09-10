"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { accountsKey, updateAccount, useAccounts, type Account } from "@/src/api/accounts";
import { getListAgentsQueryKey } from "@/src/api/generated/agents/agents";
import type { AgentView } from "@/src/api/generated/model";
import { ConnectAgent } from "./ConnectAgent";

export function AgentAccounts({ agent }: { agent: AgentView }) {
  const accounts = useAccounts();
  const [editing, setEditing] = useState<Account | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const cache = useQueryClient();
  const change = useMutation({ mutationFn: ({ id, data }: { id: string; data: Parameters<typeof updateAccount>[1] }) => updateAccount(id, data), onSuccess: async () => {
    setRenaming(null);
    await cache.invalidateQueries({ queryKey: accountsKey });
    await cache.invalidateQueries({ queryKey: getListAgentsQueryKey() });
  }});
  return <div className="mt-3 flex flex-col gap-3">
    {accounts.data?.filter((a) => a.kind === agent.kind).map((a) => <div key={a.id} className="rounded border border-line px-3 py-2">
      {renaming === a.id ? <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); change.mutate({ id: a.id, data: { name } }); }}>
        <input aria-label="Account name" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 rounded border border-line bg-ground px-2 text-ui text-bone" />
        <button disabled={!name.trim() || change.isPending} className="text-meta text-bone">Save</button><button type="button" onClick={() => setRenaming(null)} className="text-meta text-mute">Cancel</button>
      </form> : <>
        <div className="flex flex-wrap items-center gap-2 text-ui text-bone"><span>{a.name}</span>{a.isDefault && <span className="text-meta text-sage">Default</span>}<span className="ml-auto text-meta text-mute">{a.enabled ? a.state === "connected" && !a.credentialSet ? "Host-local sign-in" : a.state : "Disabled for new selections"}</span></div>
        {a.identity && <div className="mt-1 text-meta text-dim">{a.identity}</div>}
        <div className="mt-2 flex flex-wrap gap-4 text-meta text-mute">
          <button onClick={() => { setRenaming(a.id); setName(a.name); }}>Rename</button>
          <button onClick={() => setEditing(a)}>{a.state === "connected" ? "Reconnect" : "Finish connecting"}</button>
          {!a.isDefault && a.enabled && a.state === "connected" && <button disabled={change.isPending} onClick={() => change.mutate({ id: a.id, data: { isDefault: true } })}>Make default</button>}
          {!a.isDefault && <button disabled={change.isPending} onClick={() => change.mutate({ id: a.id, data: { enabled: !a.enabled } })}>{a.enabled ? "Disable" : "Enable"}</button>}
        </div>
      </>}
    </div>)}
    {(change.error || accounts.error) && <p role="alert" className="text-meta text-brick">{(change.error ?? accounts.error)?.message}</p>}
    {editing && <ConnectAgent agent={agent} account={editing} onClose={() => setEditing(null)} />}
  </div>;
}

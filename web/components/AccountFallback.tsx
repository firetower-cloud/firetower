"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFallback, saveFallback, useAccounts, type Fallback } from "@/src/api/accounts";
import { Modal, Foot, Go, Quiet } from "./Modal";

export function AccountFallback({ sessionId }: { sessionId: string }) {
  const value = useFallback(sessionId);
  const accounts = useAccounts();
  const [draft, setDraft] = useState<Fallback | null>(null);
  const cache = useQueryClient();
  const save = useMutation({ mutationFn: (next: Fallback) => saveFallback(sessionId, next), onSuccess: async () => { await cache.invalidateQueries({ queryKey: ["account-fallback", sessionId] }); setDraft(null); } });
  return <>
    <button className="mt-2 text-meta text-mute" onClick={() => setDraft(value.data ?? { enabled: false, accountIds: [] })}>On usage limit: {value.data?.enabled ? "switch automatically" : "ask me"} · Edit</button>
    {draft && <Modal title="When this account reaches its limit" onClose={() => setDraft(null)} wide>
      <label className="flex gap-2 text-ui text-bone"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />Switch automatically using these accounts</label>
      <p className="mt-3 text-meta text-dim">Select accounts in the order you want to try them. This authorizes using their allowance, handing the task to another provider using its default tool permissions if selected (Claude Code auto mode; Codex workspace sandbox with network access and approvals on request), and metered charges for any API key you include.</p>
      <div className="mt-4 flex flex-col gap-3">{accounts.data?.filter((a) => a.enabled && a.state === "connected" && a.credentialSet).map((a) => {
        const position = draft.accountIds.indexOf(a.id);
        return <label className="flex gap-2 text-ui text-bone" key={a.id}><input type="checkbox" checked={position >= 0} onChange={(e) => setDraft({ ...draft, accountIds: e.target.checked ? [...draft.accountIds, a.id] : draft.accountIds.filter((id) => id !== a.id) })} />{position >= 0 ? `${position + 1}. ` : ""}{a.kind} · {a.name}{a.mode === "ApiKey" ? " · Metered API" : ""}</label>;
      })}</div>
      <p className="mt-4 text-meta text-mute">Temporary throttling and sign-in errors do not trigger a switch. Each selected account is tried at most once per saved order. A switch failure pauses automation.</p>
      {save.error && <p className="mt-3 text-meta text-brick" role="alert">{save.error.message}</p>}
      <Foot><Go disabled={save.isPending || (draft.enabled && !draft.accountIds.length)} onClick={() => save.mutate(draft)}>Save</Go><Quiet onClick={() => setDraft(null)}>Cancel</Quiet></Foot>
    </Modal>}
  </>;
}

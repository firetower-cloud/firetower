/**
 * What happens when the account a session runs on reaches its limit.
 *
 * Off by default: switching spends somebody else's allowance, and possibly
 * hands the work to a different agent with its own permissions. Turning it
 * on is choosing the accounts to try, in order; the server does the rest,
 * browser open or not, and tries each one at most once per saved order.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { fallbackKey, saveFallback, usable, useAccounts, useFallback, type Fallback } from "~/api/accounts";
import { useAgents, why } from "~/data";

export function FallbackLine({ sessionId }: { sessionId: string }) {
  const value = useFallback(sessionId);
  const [editing, setEditing] = useState(false);
  return (
    <>
      <button onClick={() => setEditing(true)} className="text-meta text-mute hover:text-bone">
        On usage limit: {value.data?.enabled ? "switch automatically" : "ask me"} · Edit
      </button>
      {editing && <FallbackEditor sessionId={sessionId} initial={value.data ?? { enabled: false, accountIds: [] }} onClose={() => setEditing(false)} />}
    </>
  );
}

function FallbackEditor({ sessionId, initial, onClose }: { sessionId: string; initial: Fallback; onClose: () => void }) {
  const cache = useQueryClient();
  const accounts = useAccounts();
  const agents = useAgents();
  const [draft, setDraft] = useState<Fallback>(initial);
  const save = useMutation({
    mutationFn: (next: Fallback) => saveFallback(sessionId, next),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: fallbackKey(sessionId) });
      onClose();
    },
  });
  const label = (kind: string) => agents.data.find((a) => a.kind === kind)?.label ?? kind;
  const candidates = (accounts.data ?? []).filter(usable);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (id: string, on: boolean) =>
    setDraft({ ...draft, accountIds: on ? [...draft.accountIds, id] : draft.accountIds.filter((x) => x !== id) });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ground/70 pt-[10vh] backdrop-blur-[3px]" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-[32rem] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--shadow-float)">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-title text-bone">When this account reaches its limit</h2>
          <button onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"><X className="h-4 w-4" strokeWidth={1.75} /></button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <label className="flex items-center gap-2 text-ui text-bone">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            Switch automatically using these accounts
          </label>
          <p className="text-meta text-dim">
            Tick accounts in the order to try them. This authorises spending their allowance, and handing the work to another agent with its default tool permissions when one is ticked: Claude Code in auto mode, Codex in its workspace sandbox with approvals on request.
          </p>
          <div className="space-y-1.5">
            {candidates.map((a) => {
              const position = draft.accountIds.indexOf(a.id);
              return (
                <label key={a.id} className="flex items-center gap-2.5 rounded-md bg-ground px-2.5 py-1.5 text-ui text-bone">
                  <input type="checkbox" checked={position >= 0} onChange={(e) => toggle(a.id, e.target.checked)} />
                  <span className="w-5 font-mono text-meta text-mute">{position >= 0 ? `${position + 1}.` : ""}</span>
                  <span className="min-w-0 flex-1 truncate">{label(a.kind)} · {a.name}</span>
                  {a.mode === "ApiKey" && <span className="text-micro text-mute">metered</span>}
                </label>
              );
            })}
            {candidates.length === 0 && <p className="text-meta text-mute">No other connected account. Connect one in Configuration.</p>}
          </div>
          <p className="text-meta text-mute">Temporary throttling and sign-in errors do not trigger a switch. Each ticked account is tried at most once per saved order. A failed switch pauses this.</p>
          {save.error && <p className="text-meta text-brick">{why(save.error)}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-ground/40 px-5 py-3">
          <button onClick={onClose} className="control ml-auto text-mute hover:bg-raise hover:text-bone">Cancel</button>
          <button disabled={save.isPending || (draft.enabled && draft.accountIds.length === 0)} onClick={() => save.mutate(draft)} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The picker that appears when the account a session runs on has run out.
 *
 * `src/api/accounts.ts` is the contract — which limit is exhausted, what the
 * candidates are, and `switchAccount` with the permission-change
 * acknowledgement when the hand-off is to a different agent. Drawn above the
 * composer, where the web draws it, because it is the thing to deal with
 * before saying anything else.
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { accountsKey, exhausted, sessionAccountKey, switchAccount, useAccounts, useSessionAccount } from "~/api/accounts";
import type { Session } from "~/api/generated/model";
import { getGetSessionQueryKey, getListSessionsQueryKey } from "~/api/generated/sessions/sessions";

import { why } from "~/data";

export function AccountSwitcher({ session, working }: { session: Session; working: boolean }) {
  const cache = useQueryClient();
  const current = useSessionAccount(session.id);
  const accounts = useAccounts();
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState("");
  const [permissionChange, setPermissionChange] = useState(false);

  const blocked = current.data?.limits.find((l) => exhausted(l));
  const candidates = useMemo(
    () => (accounts.data ?? []).filter((a) => a.enabled && a.state === "connected" && a.id !== current.data?.account?.id),
    [accounts.data, current.data],
  );
  const recommended = candidates.find((a) => a.kind === session.agent && a.mode === "Subscription" && !a.limits.some((l) => exhausted(l)));
  const chosen = candidates.find((a) => a.id === selected);
  const changesAgent = !!chosen && chosen.kind !== session.agent;

  const switcher = useMutation({
    mutationFn: (accountId: string) => switchAccount(session.id, accountId, changesAgent && permissionChange),
    onSuccess: async () => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: sessionAccountKey(session.id) }),
        cache.invalidateQueries({ queryKey: accountsKey }),
        cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) }),
        cache.invalidateQueries({ queryKey: getListSessionsQueryKey() }),
      ]);
      setChoosing(false);
    },
  });

  if (!blocked && !choosing) return null;
  const pending = switcher.isPending;

  return (
    <div className="mt-8 rounded-xl border border-kind-data/40 bg-panel px-4 py-3.5">
      {blocked && (
        <p className="flex items-start gap-2.5 text-ui text-text">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-kind-data" strokeWidth={1.75} />
          <span>
            <span className="text-bone">{current.data?.account?.name ?? "This account"}</span> has hit its {blocked.scope} limit
            {blocked.resetsAt ? ` — it resets ${new Date(blocked.resetsAt * 1000).toLocaleTimeString()}` : ""}.
          </span>
        </p>
      )}

      {!choosing ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-3 text-ui">
          {recommended && (
            <button disabled={pending || working} onClick={() => switcher.mutate(recommended.id)} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">
              Continue with {recommended.name}
            </button>
          )}
          <button disabled={pending} onClick={() => setChoosing(true)} className="control border border-line text-dim hover:text-bone">
            {recommended ? "Other options" : "Choose another account"}
          </button>
          <span className="text-meta text-mute">Or wait for the limit to reset.</span>
        </div>
      ) : (
        <div className="mt-3">
          <div className="grid gap-1.5">
            {candidates.map((a) => {
              const out = a.limits.some((l) => exhausted(l));
              return (
                <button key={a.id} onClick={() => setSelected(a.id)} className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left ${selected === a.id ? "border-line bg-overlay" : "border-line-soft bg-ground hover:bg-raise"}`}>
                  <span className="min-w-0">
                    <span className="block text-ui text-bone">{a.kind} · {a.name}</span>
                    <span className="block text-meta text-mute">
                      {a.mode === "ApiKey" ? "Metered API usage" : out ? "Limit reached · try after reset" : a.limits.length ? a.limits.map((l) => (l.usedPercent != null ? `${l.scope}: ${l.usedPercent}% used` : `${l.scope}: ${l.status}`)).join(" · ") : "Connected · quota unknown"}
                    </span>
                  </span>
                </button>
              );
            })}
            {candidates.length === 0 && <p className="text-meta text-mute">No other connected account. Connect one in Configuration.</p>}
          </div>
          {changesAgent && (
            <label className="mt-3 flex items-start gap-2 text-meta text-dim">
              <input type="checkbox" checked={permissionChange} onChange={(e) => setPermissionChange(e.target.checked)} className="mt-0.5" />
              This hands the work to a different agent, which starts with its own permission mode.
            </label>
          )}
          <div className="mt-3 flex gap-2">
            <button disabled={!selected || pending || working || (changesAgent && !permissionChange)} onClick={() => switcher.mutate(selected)} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">
              {pending ? "Switching…" : changesAgent ? "Hand off and continue" : "Switch and continue"}
            </button>
            <button onClick={() => setChoosing(false)} className="control text-mute hover:text-dim">Cancel</button>
          </div>
          {switcher.error && <p className="mt-2 text-meta text-brick">{why(switcher.error)}</p>}
        </div>
      )}
    </div>
  );
}

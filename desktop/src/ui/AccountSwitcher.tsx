/**
 * Whose subscription this conversation is running on, and what to do when it
 * runs out.
 *
 * One line above the composer, always there: the account, **Switch account**,
 * and the usage-limit rule (`FallbackLine`). When a limit is exhausted the
 * line grows into the web's recovery card — continue with the recommended
 * account, or choose. `src/api/accounts.ts` is the contract: which limit is
 * exhausted, what the candidates are, and `switchAccount` with the
 * permission-change acknowledgement when the hand-off is to another agent.
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, X } from "lucide-react";
import { AgentMark } from "~/components/AgentMark";
import { accountsKey, exhausted, quota, sessionAccountKey, switchAccount, usable, useAccounts, useSessionAccount } from "~/api/accounts";
import type { Account, Agent, AgentView, Session } from "~/api/generated/model";
import { getGetSessionQueryKey, getListSessionsQueryKey } from "~/api/generated/sessions/sessions";
import { useAgents, why } from "~/data";
import { navigate } from "~/shims/next-navigation";
import { FallbackLine } from "~/ui/AccountFallback";
import { ConnectAccount } from "~/ui/config/ConnectAccount";

export function AccountSwitcher({ session, working }: { session: Session; working: boolean }) {
  const cache = useQueryClient();
  const current = useSessionAccount(session.id);
  const accounts = useAccounts();
  const agents = useAgents();
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState("");
  const [permissionChange, setPermissionChange] = useState(false);
  const [connecting, setConnecting] = useState<AgentView | null>(null);

  const own = agents.data.find((a) => a.kind === session.agent);
  const label = (kind: string) => agents.data.find((a) => a.kind === kind)?.label ?? kind;
  const account = current.data?.account;
  const blocked = current.data?.limits.find((l) => exhausted(l));
  const candidates = useMemo(() => {
    const list = (accounts.data ?? []).filter((a) => usable(a) && a.id !== account?.id);
    list.sort((a, b) => Number(b.kind === session.agent) - Number(a.kind === session.agent));
    return list;
  }, [accounts.data, account?.id, session.agent]);
  const recommended = candidates.find((a) => a.kind === session.agent && a.mode === "Subscription" && !a.limits.some((l) => exhausted(l)));
  const chosen = candidates.find((a) => a.id === selected);
  const changesAgent = !!chosen && chosen.kind !== session.agent;
  const installedHere = (a: Account) => !!agents.data.find((x) => x.kind === a.kind)?.hosts.some((h) => h.hostId === session.hostId && h.installed);
  const inFlight = current.data?.switches.some((s) => s.state === "switching") ?? false;
  const last = current.data?.switches.at(-1);

  const switcher = useMutation({
    mutationFn: (accountId: string) => switchAccount(session.id, accountId, changesAgent && permissionChange),
    onSuccess: async (result) => {
      setChoosing(false);
      setSelected("");
      await Promise.all([
        cache.invalidateQueries({ queryKey: sessionAccountKey(session.id) }),
        cache.invalidateQueries({ queryKey: accountsKey }),
        cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) }),
        cache.invalidateQueries({ queryKey: getListSessionsQueryKey() }),
      ]);
      if (result.sessionId !== session.id) navigate(`/sessions/${result.sessionId}`);
    },
  });
  const pending = switcher.isPending || inFlight;

  // Nothing to say about an agent that spends nothing.
  if (own && !own.needsCredential) return null;

  return (
    <div className={`mt-8 rounded-xl border px-4 py-3 ${blocked ? "border-kind-data/40 bg-panel" : "border-line-soft bg-panel/60"}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-meta">
        <span className="flex items-center gap-1.5 text-dim">
          <AgentMark agent={session.agent} size={12} />
          {own?.label ?? session.agent} · <span className="text-text">{account?.name ?? "no account"}</span>
        </span>
        <span className="ml-auto flex items-center gap-4">
          <FallbackLine sessionId={session.id} />
          <button disabled={pending || !!session.forgottenAt} onClick={() => setChoosing(true)} className="text-mute hover:text-bone disabled:text-mute">
            {pending ? "Switching account…" : "Switch account"}
          </button>
        </span>
      </div>

      {blocked && (
        <div className="mt-3">
          <p className="flex items-start gap-2.5 text-ui text-text">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-kind-data" strokeWidth={1.75} />
            <span>
              <span className="text-bone">{account?.name ?? "This account"}</span> has hit its {blocked.scope} limit
              {blocked.resetsAt ? ` — it resets ${new Date(blocked.resetsAt * 1000).toLocaleString()}` : ""}. The workspace is kept.
            </span>
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-3 text-ui">
            {recommended && (
              <button disabled={pending || working} onClick={() => { setSelected(recommended.id); switcher.mutate(recommended.id); }} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">
                Continue with {recommended.name}
              </button>
            )}
            <button disabled={pending} onClick={() => setChoosing(true)} className="control border border-line text-dim hover:text-bone">
              {recommended ? "Other options" : "Choose another account"}
            </button>
            <span className="text-meta text-mute">Or wait for the limit to reset.</span>
          </div>
        </div>
      )}

      {last && (
        <p className={`mt-2 text-meta ${last.state === "failed" ? "text-brick" : "text-mute"}`}>
          {last.detail ?? (last.state === "switching" ? "Account switch in progress…" : `Continued on ${accounts.data?.find((a) => a.id === last.toAccountId)?.name ?? "another account"}.`)}
          {last.nextSessionId && (
            <button onClick={() => navigate(`/sessions/${last.nextSessionId}`)} className="ml-2 text-bone underline decoration-line underline-offset-2">Open continuation</button>
          )}
        </p>
      )}
      {switcher.error && <p className="mt-2 text-meta text-brick">{why(switcher.error)}</p>}

      {choosing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-ground/70 pt-[10vh] backdrop-blur-[3px]" onMouseDown={() => setChoosing(false)}>
          <div onMouseDown={(e) => e.stopPropagation()} className="w-[32rem] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--shadow-float)">
            <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
              <h2 className="text-title text-bone">Continue this task</h2>
              <button onClick={() => setChoosing(false)} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"><X className="h-4 w-4" strokeWidth={1.75} /></button>
            </div>

            <div className="space-y-3 px-5 py-4">
              <p className="text-ui text-dim">Your files, changes and branch stay in this workspace.</p>
              <div className="grid gap-1.5">
                {candidates.map((a) => {
                  const here = installedHere(a);
                  return (
                    <button key={a.id} disabled={!here || pending} onClick={() => { setSelected(a.id); setPermissionChange(false); }} className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left disabled:opacity-50 ${selected === a.id ? "border-line bg-overlay" : "border-line-soft bg-ground hover:bg-raise"}`}>
                      <AgentMark agent={a.kind as Agent} size={12} className="mt-1 shrink-0 text-dim" />
                      <span className="min-w-0">
                        <span className="block text-ui text-bone">{label(a.kind)} · {a.name}</span>
                        <span className="block text-meta text-mute">{here ? quota(a) : "Not installed on this machine"}</span>
                      </span>
                    </button>
                  );
                })}
                {candidates.length === 0 && <p className="text-meta text-mute">No other connected account.</p>}
              </div>
              {changesAgent && (
                <>
                  <p className="text-ui text-dim">This starts another agent with a hand-off of the request and the progress so far. Its conversation opens in a new tab; this one stays.</p>
                  <label className="flex items-start gap-2 text-meta text-dim">
                    <input type="checkbox" checked={permissionChange} onChange={(e) => setPermissionChange(e.target.checked)} className="mt-0.5" />
                    Use the destination agent's default permissions: {chosen?.kind === "Codex" ? "workspace sandbox with network access and approvals on request" : "Claude Code auto permission mode; some tool calls may be approved automatically"}. Existing approvals are not carried over.
                  </label>
                </>
              )}
              {working && <p className="text-meta text-mute">Stop the current turn before switching. Pending approvals must be answered first.</p>}
              <div className="flex flex-wrap gap-4">
                {agents.data.filter((a) => a.supported && a.needsCredential).map((a) => (
                  <button key={a.kind} onClick={() => { setChoosing(false); setConnecting(a); }} className="text-meta text-dim hover:text-bone">+ Connect {a.label} account</button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 border-t border-line bg-ground/40 px-5 py-3">
              <button onClick={() => setChoosing(false)} className="control ml-auto text-mute hover:bg-raise hover:text-bone">Cancel</button>
              <button disabled={!chosen || pending || working || (changesAgent && !permissionChange)} onClick={() => switcher.mutate(selected)} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">
                {pending ? "Switching…" : changesAgent ? "Hand off and continue" : "Switch and continue"}
              </button>
            </div>
          </div>
        </div>
      )}

      {connecting && (
        <ConnectAccount
          agent={connecting}
          onClose={() => setConnecting(null)}
          onConnected={(made) => {
            if (!working && made.kind === session.agent) {
              setSelected(made.id);
              switcher.mutate(made.id);
            } else {
              setSelected(made.id);
              setChoosing(true);
            }
          }}
        />
      )}
    </div>
  );
}

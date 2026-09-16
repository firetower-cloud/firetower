/**
 * Whose subscription this conversation is running on, and what to do when it
 * runs out.
 *
 * Three pieces with one state between them, so the composer can place each
 * where it belongs: `AccountLine` is the compact line in the composer's hint
 * row (account · usage-limit rule · Switch); `AccountNotice` sits above the
 * input and only appears when a limit is exhausted or a switch has something
 * to say; `AccountSwitcher` wraps both, holds the state and draws the modals.
 * `src/api/accounts.ts` is the contract: which limit is exhausted, what the
 * candidates are, and `switchAccount` with the permission-change
 * acknowledgement when the hand-off is to another agent.
 */
import { createContext, useContext, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, X } from "lucide-react";
import { AgentMark } from "~/components/AgentMark";
import { accountsKey, exhausted, quota, sessionAccountKey, switchAccount, usable, useAccounts, useSessionAccount } from "~/api/accounts";
import type { Account, Agent, AgentView, Limit, Session, Switch } from "~/api/generated/model";
import { getGetSessionQueryKey, getListSessionsQueryKey } from "~/api/generated/sessions/sessions";
import { useAgents, why } from "~/data";
import { navigate } from "~/shims/next-navigation";
import { FallbackLine } from "~/ui/AccountFallback";
import { ConnectAccount } from "~/ui/config/ConnectAccount";

type Shared = {
  session: Session;
  working: boolean;
  label: string;
  account?: Account | null;
  loaded: boolean;
  blocked?: Limit;
  recommended?: Account;
  last?: Switch;
  pending: boolean;
  error: unknown;
  accounts: Account[];
  open: () => void;
  continueWith: (id: string) => void;
};

const Ctx = createContext<Shared | null>(null);

export function AccountSwitcher({ session, working, children }: { session: Session; working: boolean; children: React.ReactNode }) {
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
  /* Not a candidate until it is known which one is current: a list drawn
     before the answer arrives would offer the account already in use. */
  const candidates = useMemo(() => {
    if (!current.data) return [];
    const list = (accounts.data ?? []).filter((a) => usable(a) && a.id !== account?.id);
    list.sort((a, b) => Number(b.kind === session.agent) - Number(a.kind === session.agent));
    return list;
  }, [accounts.data, account?.id, session.agent, current.data]);
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

  const shared: Shared | null =
    own && !own.needsCredential
      ? null
      : {
          session,
          working,
          label: own?.label ?? session.agent,
          account,
          loaded: !!current.data,
          blocked,
          recommended,
          last,
          pending,
          error: switcher.error,
          accounts: accounts.data ?? [],
          open: () => setChoosing(true),
          continueWith: (id) => {
            setSelected(id);
            switcher.mutate(id);
          },
        };

  return (
    <Ctx.Provider value={shared}>
      {children}

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
                  const handoff = a.kind !== session.agent;
                  return (
                    <button key={a.id} disabled={!here || pending} onClick={() => { setSelected(a.id); setPermissionChange(false); }} className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left disabled:opacity-50 ${selected === a.id ? "border-line bg-overlay" : "border-line-soft bg-ground hover:bg-raise"}`}>
                      <AgentMark agent={a.kind as Agent} size={12} className="mt-1 shrink-0 text-dim" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-ui text-bone">{label(a.kind)} · {a.name}</span>
                        <span className="block text-meta text-mute">{here ? quota(a) : "Not installed on this machine"}</span>
                      </span>
                      {handoff && here && <span className="shrink-0 text-micro text-mute">hands off</span>}
                    </button>
                  );
                })}
                {current.data && candidates.length === 0 && <p className="text-meta text-mute">No other connected account.</p>}
                {!current.data && <p className="text-meta text-mute">Reading which account this runs on…</p>}
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
            setSelected(made.id);
            if (!working && made.kind === session.agent) switcher.mutate(made.id);
            else setChoosing(true);
          }}
        />
      )}
    </Ctx.Provider>
  );
}

/** The line in the composer's hint row: account, the usage-limit rule, Switch. */
export function AccountLine() {
  const s = useContext(Ctx);
  if (!s) return null;
  return (
    <span className="ml-auto flex min-w-0 items-center gap-3">
      <span className="flex min-w-0 items-center gap-1.5">
        <AgentMark agent={s.session.agent} size={11} className="shrink-0 text-mute" />
        <span className="truncate text-dim">{s.account?.name ?? (s.loaded ? "no account" : "…")}</span>
      </span>
      <span className="text-line-soft">·</span>
      <FallbackLine sessionId={s.session.id} agent={s.session.agent} currentId={s.account?.id} />
      <span className="text-line-soft">·</span>
      <button disabled={s.pending || !!s.session.forgottenAt} onClick={s.open} className="text-mute hover:text-bone disabled:text-mute">
        {s.pending ? "Switching…" : "Switch"}
      </button>
    </span>
  );
}

/** Above the input, only when there is something to deal with. */
export function AccountNotice() {
  const s = useContext(Ctx);
  if (!s) return null;
  const { blocked, last, recommended, account } = s;
  const said = s.error ? why(s.error) : null;
  if (!blocked && !last && !said) return null;
  return (
    <div className={`mb-2 rounded-xl border px-4 py-3 ${blocked ? "border-kind-data/40 bg-panel" : "border-line-soft bg-panel/60"}`}>
      {blocked && (
        <>
          <p className="flex items-start gap-2.5 text-ui text-text">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-kind-data" strokeWidth={1.75} />
            <span>
              <span className="text-bone">{account?.name ?? "This account"}</span> has hit its {blocked.scope} limit
              {blocked.resetsAt ? ` — it resets ${new Date(blocked.resetsAt * 1000).toLocaleString()}` : ""}. The workspace is kept.
            </span>
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-3 text-ui">
            {recommended && (
              <button disabled={s.pending || s.working} onClick={() => s.continueWith(recommended.id)} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">
                Continue with {recommended.name}
              </button>
            )}
            <button disabled={s.pending} onClick={s.open} className="control border border-line text-dim hover:text-bone">
              {recommended ? "Other options" : "Choose another account"}
            </button>
            <span className="text-meta text-mute">Or wait for the limit to reset.</span>
          </div>
        </>
      )}
      {last && (
        <p className={`text-meta ${blocked ? "mt-2" : ""} ${last.state === "failed" ? "text-brick" : "text-mute"}`}>
          {last.detail ?? (last.state === "switching" ? "Account switch in progress…" : `Continued on ${s.accounts.find((a) => a.id === last.toAccountId)?.name ?? "another account"}.`)}
          {last.nextSessionId && (
            <button onClick={() => navigate(`/sessions/${last.nextSessionId}`)} className="ml-2 text-bone underline decoration-line underline-offset-2">Open continuation</button>
          )}
        </p>
      )}
      {said && <p className="mt-1 text-meta text-brick">{said}</p>}
    </div>
  );
}

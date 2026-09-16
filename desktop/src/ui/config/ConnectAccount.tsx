/**
 * Connecting a subscription.
 *
 * One modal, two ways in, decided by the agent. Claude Code prints a token on
 * your own machine (`claude setup-token`) and the token is what is pasted
 * here; Codex signs a machine in with a code you approve in a browser, and the
 * credential comes back to the server from there. Either way the sequence is
 * the web's: make the named account first (`create_account`), then attach the
 * credential to it, then optionally make it the default.
 *
 * Opened with an existing `account` it reconnects that one instead — the same
 * steps, against the row that is already there.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { AgentMark } from "~/components/AgentMark";
import { CopyButton } from "~/components/ui";
import type { Account, AgentView } from "~/api/generated/model";
import { getListAgentsQueryKey, useSignAgentIn } from "~/api/generated/agents/agents";
import { getListAccountsQueryKey, useCreateAccount, useListAccounts, useUpdateAccount } from "~/api/generated/accounts/accounts";
import { why } from "~/data";
import { DeviceCode } from "~/ui/config/bits";

export function ConnectAccount({
  agent,
  account,
  onClose,
  onConnected,
}: {
  agent: AgentView;
  /** Reconnect this one rather than make a new one. */
  account?: Account;
  onClose: () => void;
  /** After Done, with the account as it now is. */
  onConnected?: (account: Account) => void;
}) {
  const cache = useQueryClient();
  const create = useCreateAccount();
  const update = useUpdateAccount();
  const login = useSignAgentIn();
  const [name, setName] = useState(account?.name ?? "");
  const [secret, setSecret] = useState("");
  const [made, setMade] = useState<Account | null>(null);
  const [makeDefault, setMakeDefault] = useState(!account || account.isDefault);
  const [trouble, setTrouble] = useState<string | null>(null);
  const device = agent.signsInWithACode;
  const reconnecting = !!account;

  /* Poll while a code is out: the row's revision moves past the one we
     started from once the provider confirms it, and its state says so when
     it does not. */
  const polling = !!made && device && !!login.data;
  const accounts = useListAccounts({ query: { enabled: polling, refetchInterval: 2000 } });
  const seen = accounts.data?.find((a) => a.id === made?.id);
  const confirmed = polling && seen && seen.state === "connected" && seen.revision > (made?.revision ?? 0) ? seen : undefined;
  const failed = polling && !confirmed && seen?.state === "sign-in failed";
  const ready = !!made && (!device || !!confirmed);

  const refresh = () => Promise.all([cache.invalidateQueries({ queryKey: getListAccountsQueryKey() }), cache.invalidateQueries({ queryKey: getListAgentsQueryKey() })]);

  const save = async () => {
    setTrouble(null);
    try {
      let row: Account;
      if (account) {
        row = await update.mutateAsync({ id: account.id, data: { name: name.trim(), ...(device ? {} : { secret }) } });
      } else {
        row = await create.mutateAsync({ data: { kind: agent.kind, name: name.trim(), mode: "Subscription" as never, secret: device ? null : secret } });
      }
      setMade(row);
      await refresh();
      if (device) await login.mutateAsync({ kind: agent.kind, data: { accountId: row.id } });
    } catch (e) {
      setTrouble(why(e));
    }
  };

  const again = async () => {
    if (!made) return;
    setTrouble(null);
    login.reset();
    try {
      await login.mutateAsync({ kind: agent.kind, data: { accountId: made.id } });
    } catch (e) {
      setTrouble(why(e));
    }
  };

  const finish = async () => {
    if (!made) return;
    try {
      const row = await update.mutateAsync({ id: made.id, data: { name: name.trim(), ...(makeDefault ? { isDefault: true } : {}) } });
      await refresh();
      onConnected?.(row);
      onClose();
    } catch (e) {
      setTrouble(why(e));
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = ready ? "Account connected" : `${reconnecting ? "Reconnect" : "Connect"} a ${agent.label} account`;
  const hostHasIt = agent.hosts.some((h) => h.installed);
  const canSave = !made && !!name.trim() && !create.isPending && !update.isPending && (device ? hostHasIt : !!secret.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ground/70 pt-[10vh] backdrop-blur-[3px]" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-[32rem] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--shadow-float)">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <AgentMark agent={agent.kind} size={16} className="text-dim" />
          <h2 className="text-title text-bone">{title}</h2>
          <button onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"><X className="h-4 w-4" strokeWidth={1.75} /></button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="text-ui text-dim">Account name <span className="text-meta text-mute">— what you'll recognise when switching</span></span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={!!made && !ready} placeholder="Personal Claude, Work, Client Acme…" maxLength={80} className="mt-1.5 w-full rounded-lg border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none disabled:text-dim" />
          </label>

          {!made && !device && agent.tokenCommand && (
            <div className="space-y-2.5">
              <p className="text-ui text-dim">Sign in with the intended account on your own machine, then run:</p>
              <div className="flex items-center gap-2 rounded-lg border border-line bg-ground px-3 py-2 font-mono text-ui text-bone">
                <span className="text-mute">$</span>
                <span className="flex-1">{agent.tokenCommand}</span>
                <CopyButton text={agent.tokenCommand} />
              </div>
              <p className="text-meta text-mute">It opens a browser and prints a token. Paste it here; every machine uses it.</p>
              <input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" placeholder="Subscription token" className="w-full rounded-lg border border-line bg-ground px-3 py-2 font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" />
            </div>
          )}

          {!made && device && (
            <p className="text-ui text-dim">
              {hostHasIt
                ? "Continue to sign in, then approve the connection with the account you want to use."
                : `Signing in with a code needs ${agent.label} installed on a machine first.`}
            </p>
          )}

          {made && device && !confirmed && login.data && !failed && (
            <DeviceCode code={login.data.userCode} url={login.data.verificationUri} note="Check that you sign in with the intended account. You can close this window; the pending connection stays in the account list." />
          )}

          {made && device && !confirmed && (failed || (!login.data && !login.isPending)) && (
            <p className="text-ui text-brick">{failed ? "Sign-in could not be saved. This identity may already be connected; check the account list or try again." : "The sign-in did not start."}</p>
          )}

          {ready && (
            <>
              <p className="text-ui text-dim">{agent.label} · {confirmed?.identity ?? made?.identity ?? "Credential connected."}</p>
              <label className="flex items-center gap-2 text-ui text-dim"><input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />Use by default for new work</label>
            </>
          )}

          {trouble && <p className="text-meta text-brick">{trouble}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-ground/40 px-5 py-3">
          <button onClick={onClose} className="control ml-auto text-mute hover:bg-raise hover:text-bone">{made && !ready ? "Close" : "Cancel"}</button>
          {ready ? (
            <button disabled={!name.trim() || update.isPending} onClick={finish} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">{update.isPending ? "Saving…" : "Done"}</button>
          ) : made && device ? (
            <button disabled={login.isPending || (!!login.data && !failed)} onClick={again} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">{login.isPending ? "Asking for a code…" : "Try again"}</button>
          ) : (
            <button disabled={!canSave} onClick={save} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">
              {create.isPending || update.isPending ? "Connecting…" : device ? "Continue to sign in" : "Connect account"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

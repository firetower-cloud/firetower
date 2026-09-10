"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal, Command, Foot, Go, Quiet, CodeToType } from "./Modal";
import { useSignAgentIn, getListAgentsQueryKey } from "@/src/api/generated/agents/agents";
import { AgentMode, type AgentView } from "@/src/api/generated/model";
import { accountsKey, createAccount, updateAccount, useAccounts, type Account } from "@/src/api/accounts";

const input = "mt-2 w-full rounded-sm border border-line bg-ground px-3 py-2 text-ui text-bone outline-none focus:border-dim/40";

export function ConnectAgent({ agent, account, onClose, onConnected }: {
  agent: AgentView; account?: Account; onClose: () => void; onConnected?: (account: Account) => void;
}) {
  const [name, setName] = useState(account?.name ?? "");
  const [secret, setSecret] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [created, setCreated] = useState<Account | null>(null);
  const [saved, setReady] = useState<Account | null>(null);
  const cache = useQueryClient();
  const login = useSignAgentIn();
  const accounts = useAccounts(!!created && !saved);
  const authenticated = accounts.data?.find((a) => a.id === created?.id && a.state === "connected" && a.revision > created.revision);
  const ready = saved ?? (login.data ? authenticated : null);
  const device = agent.signsInWithACode && account?.mode !== "ApiKey";
  const save = useMutation({ mutationFn: async () => {
    let connection = created ?? account;
    if (connection) {
      connection = await updateAccount(connection.id, { name, ...(device ? {} : { secret }) });
    } else {
      connection = await createAccount({ kind: agent.kind, name, mode: account?.mode === "ApiKey" ? AgentMode.ApiKey : AgentMode.Subscription, ...(device ? {} : { secret }) });
    }
    setCreated(connection);
    await cache.invalidateQueries({ queryKey: accountsKey });
    if (device) {
      await login.mutateAsync({ kind: agent.kind, data: { accountId: connection.id } });
    } else {
      setReady(connection);
    }
  }});
  const finish = useMutation({ mutationFn: async () => {
    if (!ready) return;
    const connection = await updateAccount(ready.id, { name, ...(makeDefault ? { isDefault: true } : {}) });
    await cache.invalidateQueries({ queryKey: accountsKey });
    await cache.invalidateQueries({ queryKey: getListAgentsQueryKey() });
    onConnected?.(connection);
    onClose();
  }});
  const error = save.error ?? finish.error;
  const current = accounts.data?.find((a) => a.id === created?.id);
  return <Modal title={ready ? "Account connected" : `${account ? "Reconnect" : "Connect"} ${agent.label} account`} onClose={onClose} wide>
    <label className="eyebrow" htmlFor="account-name">Account name</label>
    <input id="account-name" autoFocus className={input} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Personal Claude, Work, Client Acme…" disabled={!!login.data && !ready} />
    <p className="mt-2 text-meta text-mute">Choose a name you’ll recognize when switching accounts.</p>
    {ready ? <>
      <p className="mt-4 text-ui text-dim">{agent.label} · {ready.identity ?? "Credential connected. The provider did not return an account identity."}</p>
      <label className="mt-4 flex gap-2 text-ui text-dim"><input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />Use by default for new tasks</label>
      <Foot><Go onClick={() => finish.mutate()} disabled={!name.trim() || finish.isPending}>{finish.isPending ? "Saving…" : onConnected ? "Save and continue task" : "Done"}</Go></Foot>
    </> : login.data ? <>
      <p className="mt-4 text-ui text-dim">Open <a className="underline" href={login.data.verificationUri} target="_blank" rel="noopener noreferrer">the sign-in page</a> and enter this code. Check that you sign in with the intended account.</p>
      <CodeToType code={login.data.userCode} />
      <p className="mt-3 text-meta text-mute">{current?.state === "sign-in failed" ? "Sign-in could not be saved. This identity may already be connected; check your accounts or try again." : "Waiting for you to approve… You can close this window; the pending connection stays in your account list."}</p>
      <Foot><Quiet onClick={() => { login.reset();  }}>Try again</Quiet><Quiet onClick={onClose}>Close</Quiet></Foot>
    </> : <>
      {!device && <>
        {agent.tokenCommand && <div className="mt-4"><p className="mb-2 text-ui text-dim">Sign in with the intended account on your machine, then run:</p><Command text={agent.tokenCommand} /></div>}
        <label className="eyebrow mt-4 block" htmlFor="account-secret">{account?.mode === "ApiKey" ? "API key" : "Subscription token"}</label>
        <input id="account-secret" className={input} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} />
      </>}
      {device && <p className="mt-4 text-ui text-dim">Continue to device sign-in, then approve the connection with the account you want to use.</p>}
      <Foot><Go onClick={() => save.mutate()} disabled={!name.trim() || save.isPending || (!device && !secret.trim()) || (device && !agent.hosts.some((h) => h.installed))}>{save.isPending ? "Connecting…" : device ? "Continue to sign in" : "Connect account"}</Go><Quiet onClick={onClose}>Cancel</Quiet></Foot>
      {device && !agent.hosts.some((h) => h.installed) && <p className="text-meta text-mute">Install {agent.label} on a host first.</p>}
    </>}
    {error && <p role="alert" className="mt-3 text-meta text-brick">{error instanceof Error ? error.message : "Could not connect this account."}</p>}
  </Modal>;
}

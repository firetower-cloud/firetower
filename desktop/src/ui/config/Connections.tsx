/**
 * What Firetower may reach on your behalf, and where tasks come from.
 *
 * GitHub is authorised the way the web's `GitHubAccess` does it: ask for a
 * device code, open the page, then poll the providers list until the pending
 * authorisation clears — a code lasts about a quarter of an hour and the
 * control plane drops it when it expires, so the wait ends on its own. The
 * identity on commits (`get/set/clear_identity`) is a different fact from the
 * account that signed in, and is set here too.
 *
 * Trackers take an API key (`set_tracker_key`) and answer with the account it
 * belongs to; scopes say what the tasks list can be narrowed to.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Link2, Unlink, X } from "lucide-react";
import { GithubMark, Icon } from "@/components/ui";
import type { ProviderStatus, TrackerStatus } from "@/src/api/generated/model";
import {
  getListProvidersQueryKey,
  listProviders,
  useAuthorizeProvider,
  useClearIdentity,
  useDisconnectProvider,
  useGetIdentity,
  useSetClientId,
  useSetIdentity,
} from "@/src/api/generated/providers/providers";
import { getListTrackersQueryKey, useDisconnectTracker, useListTrackerScopes, useSetTrackerKey } from "@/src/api/generated/trackers/trackers";
import { useProviders, useTrackers } from "~/data";
import { why } from "~/data";
import { openExternal } from "~/open";
import { DeviceCode, Rows, Section, sleep } from "~/ui/config/bits";

export function Connections({ live }: { live: boolean }) {
  const providers = useProviders();
  const trackers = useTrackers();
  return (
    <>
      <Section title="Connections" note="What Firetower may reach on your behalf. Authorised as you, and revocable.">
        <Rows feed={providers} empty="Nothing to connect to on this server.">
          {providers.data.map((p) => <Provider key={p.id} p={p} live={live} />)}
        </Rows>
      </Section>
      <Section title="Trackers" note="Where the tasks list reads from.">
        <Rows feed={trackers} empty="No tracker is available on this server.">
          {trackers.data.map((t) => <Tracker key={t.id} t={t} live={live} />)}
        </Rows>
      </Section>
    </>
  );
}

/* ── One provider ──────────────────────────────────────────────────────── */

function Provider({ p, live }: { p: ProviderStatus; live: boolean }) {
  const cache = useQueryClient();
  const authorize = useAuthorizeProvider();
  const disconnect = useDisconnectProvider();
  const setClient = useSetClientId();
  const [waiting, setWaiting] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [clientId, setClientId] = useState("");
  const [open, setOpen] = useState(false);
  const refresh = () => cache.invalidateQueries({ queryKey: getListProvidersQueryKey() });

  const start = () =>
    authorize.mutate(
      { id: p.id },
      {
        onSuccess: async (auth) => {
          void openExternal(auth.verificationUri);
          setWaiting(auth);
          for (let asked = 0; asked < 600; asked++) {
            await sleep(2000);
            const still = await listProviders().then((all) => all.find((x) => x.id === p.id)?.pending != null).catch(() => true);
            if (!still) break;
          }
          setWaiting(null);
          await refresh();
        },
      },
    );

  return (
    <div>
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <GithubMark size={13} className="shrink-0 text-mute" />
        <span className="min-w-0 flex-1">
          <span className="block text-ui text-bone">{p.label}</span>
          <span className="block font-mono text-micro text-mute">{p.configured ? p.id : "no client id set on this server"}</span>
        </span>
        {p.connected ? (
          <>
            <span className="flex items-center gap-1.5 text-meta text-sage"><Icon of={Check} size={12} />connected</span>
            <button onClick={() => setOpen(!open)} className="control text-mute hover:bg-raise hover:text-bone">identity</button>
            <button disabled={!live || disconnect.isPending} onClick={() => { if (window.confirm(`Disconnect ${p.label}? Sessions already running keep the token they were given.`)) disconnect.mutate({ id: p.id }, { onSuccess: refresh }); }} className="control text-mute hover:text-brick disabled:opacity-50"><Icon of={Unlink} size={12} /></button>
          </>
        ) : p.configured ? (
          <button disabled={!live || authorize.isPending} onClick={start} className="control border border-line bg-raise text-ui text-text hover:bg-overlay disabled:opacity-50"><Icon of={Link2} size={12} />Connect</button>
        ) : (
          <div className="flex items-center gap-1.5">
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="OAuth client id" className="w-44 rounded-md border border-line bg-ground px-2 py-1 font-mono text-micro text-bone focus:outline-none" />
            <button disabled={!clientId.trim() || !live} onClick={() => setClient.mutate({ id: p.id, data: { clientId: clientId.trim() } }, { onSuccess: refresh })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">Set</button>
          </div>
        )}
      </div>
      {waiting && <div className="px-3.5 pb-3"><DeviceCode code={waiting.userCode} url={waiting.verificationUri} note="Grant every organisation you want Firetower to clone from. Ones you skip stay hidden." /></div>}
      {open && p.connected && <Identity providerId={p.id} />}
    </div>
  );
}

/** The name and email on commits — a different fact from who signed in. */
function Identity({ providerId }: { providerId: string }) {
  const identity = useGetIdentity(providerId);
  const save = useSetIdentity();
  const clear = useClearIdentity();
  const held = identity.data as { name?: string; email?: string } | undefined;
  const [name, setName] = useState(held?.name ?? "");
  const [email, setEmail] = useState(held?.email ?? "");

  return (
    <div className="border-t border-line-soft bg-ground/40 px-3.5 py-3">
      <p className="text-meta text-dim">Who commits are attributed to. Empty means whatever the agent's git says.</p>
      <div className="mt-2 flex items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 text-ui text-bone focus:outline-none" />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 font-mono text-ui text-bone focus:outline-none" />
        <button disabled={!name.trim() || !email.trim() || save.isPending} onClick={() => save.mutate({ id: providerId, data: { name: name.trim(), email: email.trim() } }, { onSuccess: () => identity.refetch() })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">Save</button>
        {held?.name && <button onClick={() => clear.mutate({ id: providerId }, { onSuccess: () => { setName(""); setEmail(""); identity.refetch(); } })} className="control text-mute hover:text-brick"><X className="h-3.5 w-3.5" strokeWidth={2} /></button>}
      </div>
    </div>
  );
}

/* ── One tracker ───────────────────────────────────────────────────────── */

function Tracker({ t, live }: { t: TrackerStatus; live: boolean }) {
  const cache = useQueryClient();
  const set = useSetTrackerKey();
  const disconnect = useDisconnectTracker();
  const scopes = useListTrackerScopes(t.id, { query: { enabled: t.connected } });
  const [key, setKey] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const refresh = () => cache.invalidateQueries({ queryKey: getListTrackersQueryKey() });
  const named = (scopes.data ?? []) as { name?: string; id?: string }[];

  return (
    <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block text-ui text-bone">{t.label}</span>
        <span className="block text-micro text-mute">
          {t.kinds.join(", ")}
          {t.connected && named.length > 0 && ` · ${named.length} ${t.scopeKind}`}
          {account && ` · as ${account}`}
        </span>
      </span>
      {t.connected ? (
        <>
          <span className="flex items-center gap-1.5 text-meta text-sage"><Icon of={Check} size={12} />connected</span>
          {t.auth === "apiKey" && <button disabled={!live} onClick={() => disconnect.mutate({ id: t.id }, { onSuccess: refresh })} className="control text-mute hover:text-brick"><Icon of={Unlink} size={12} /></button>}
        </>
      ) : t.auth === "gitProvider" ? (
        <span className="text-meta text-mute">connects with GitHub above</span>
      ) : (
        <div className="flex items-center gap-1.5">
          <input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder="API key" className="w-44 rounded-md border border-line bg-ground px-2 py-1 font-mono text-micro text-bone focus:outline-none" />
          {t.keyUrl && <a href={t.keyUrl} target="_blank" rel="noreferrer" className="text-micro text-mute underline">get one</a>}
          <button disabled={!key.trim() || !live || set.isPending} onClick={() => set.mutate({ id: t.id, data: { key: key.trim() } }, { onSuccess: (c) => { setAccount(c.account); setKey(""); refresh(); } })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">{set.isPending ? "Checking…" : "Connect"}</button>
          {set.error && <span className="text-meta text-brick">{why(set.error)}</span>}
        </div>
      )}
    </div>
  );
}

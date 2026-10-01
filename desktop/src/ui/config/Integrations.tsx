/**
 * What Firetower may reach on your behalf, and where tasks come from.
 *
 * GitHub is authorised the way the web's `GitHubAccess` does it: ask for a
 * device code, open the page, then poll the providers list until the pending
 * authorisation clears — a code lasts about a quarter of an hour and the
 * control plane drops it when it expires, so the wait ends on its own. The
 * identity on commits (`get/set/clear_identity`) is a different fact from the
 * account that signed in, and is set here too. So is the client id: it registers
 * the application rather than a person, and stays when somebody signs out — so
 * it is changed here, not re-entered, and what the host refused is on screen
 * rather than in a log nobody is reading.
 *
 * Trackers take an API key (`set_tracker_key`) and answer with the account it
 * belongs to; scopes say what the tasks list can be narrowed to.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Link2, Unlink, X } from "lucide-react";
import { GithubMark, Icon } from "~/components/ui";
import type { ProviderStatus, TrackerStatus } from "~/api/generated/model";
import {
  getListProvidersQueryKey,
  listProviders,
  useAuthorizeProvider,
  useClearIdentity,
  useDisconnectProvider,
  useGetIdentity,
  useSetClientId,
  useSetIdentity,
} from "~/api/generated/providers/providers";
import { getListTrackersQueryKey, useDisconnectTracker, useListTrackerScopes, useSetTrackerKey } from "~/api/generated/trackers/trackers";
import { useProviders, useTrackers } from "~/data";
import { why } from "~/data";
import { openExternal } from "~/open";
import { DeviceCode, Rows, Section, sleep } from "~/ui/config/bits";
import { WhoCanAccess } from "~/ui/Sharing";
import { useConfirm } from "~/ui/Confirm";

export function Integrations({ live }: { live: boolean }) {
  const providers = useProviders();
  const trackers = useTrackers();
  return (
    <>
      <Section title="Git hosts" note="Signed in as you, because a commit has to be attributable to a person. Everybody here connects their own.">
        <Rows feed={providers} empty="Nothing to connect to on this server.">
          {providers.data.map((p) => <Provider key={p.id} p={p} live={live} />)}
        </Rows>
      </Section>
      <Section title="Task trackers" note="Where the tasks list reads from. An API key can belong to a directory, so one key answers for a team.">
        <Rows feed={trackers} empty="No tracker is available on this server.">
          {trackers.data.map((t) => <Tracker key={t.id} t={t} live={live} />)}
        </Rows>
      </Section>
    </>
  );
}

/* ── One provider ──────────────────────────────────────────────────────── */

function Provider({ p, live }: { p: ProviderStatus; live: boolean }) {
  const confirm = useConfirm();
  const cache = useQueryClient();
  const authorize = useAuthorizeProvider();
  const disconnect = useDisconnectProvider();
  const setClient = useSetClientId();
  const [waiting, setWaiting] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [clientId, setClientId] = useState("");
  const [open, setOpen] = useState(false);
  const [app, setApp] = useState(false);
  const refresh = () => cache.invalidateQueries({ queryKey: getListProvidersQueryKey() });

  /* Offered wherever one is already registered, which is the case the row used
     to have no answer for: `configured` means a client id is stored, never that
     it still works, so an application that was deleted or had the device flow
     turned off left a Connect button that could not succeed and no field to
     correct. */
  /* Only to somebody the server will take it from. The application is
     install-wide and has no owner, so whoever sets it decides what everybody
     here authorizes next — and a member who was shown the field filled it in
     and was refused at the moment they pressed Save.

     `maySetApplication` rather than a role read off `auth/me`: the rule is the
     server's, and a copy of it here is a copy to keep in step.

     A control plane older than this app does not send the field, so this reads
     as false and an administrator loses the control until the server is
     upgraded. That is the right way round: the web still has it, and the other
     default would put the bug back for everybody. */
  const application = p.maySetApplication ? (
    <button onClick={() => setApp(!app)} className="control text-mute hover:bg-raise hover:text-bone">application</button>
  ) : null;

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
            {application}
            <button disabled={!live || disconnect.isPending} onClick={() => void confirm({ title: `Disconnect ${p.label}?`, body: "Sessions already running keep the token they were given.", action: "Disconnect", tone: "danger" }).then((ok) => ok && disconnect.mutate({ id: p.id }, { onSuccess: refresh }))} className="control text-mute hover:text-brick disabled:opacity-50"><Icon of={Unlink} size={12} /></button>
          </>
        ) : p.configured ? (
          <>
            {application}
            <button disabled={!live || authorize.isPending} onClick={start} className="control border border-line bg-raise text-ui text-text hover:bg-overlay disabled:opacity-50"><Icon of={Link2} size={12} />Connect</button>
          </>
        ) : p.maySetApplication ? (
          <div className="flex items-center gap-1.5">
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="OAuth client id" className="w-44 rounded-md border border-line bg-ground px-2 py-1 font-mono text-micro text-bone focus:outline-none" />
            <button disabled={!clientId.trim() || !live} onClick={() => setClient.mutate({ id: p.id, data: { clientId: clientId.trim() } }, { onSuccess: refresh })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">Set</button>
          </div>
        ) : (
          /* Nothing to do here, and saying what has to happen beats a field
             that refuses. Connecting an account of your own needs an
             application registered for the whole installation first, and that
             is not this person's to register. */
          <span className="text-meta text-mute">An administrator has to set this up</span>
        )}
      </div>
      {/* What the host refused, in its own words. Without this the button is
          silent about every way it can fail — a rejected client id, a host we
          could not reach — and the screen looks identical to nothing having
          been clicked. */}
      {authorize.error && <p className="px-3.5 pb-3 text-meta text-brick">{why(authorize.error)}</p>}
      {waiting && <div className="px-3.5 pb-3"><DeviceCode code={waiting.userCode} url={waiting.verificationUri} note="Grant every organisation you want Firetower to clone from. Ones you skip stay hidden." /></div>}
      {open && p.connected && <Identity providerId={p.id} />}
      {app && <Application p={p} onSaved={() => { setApp(false); refresh(); }} />}
    </div>
  );
}

/**
 * Which OAuth application everybody here authorizes against.
 *
 * Install-wide rather than yours: one row in the server's settings, no owner —
 * so changing it changes it for everybody, and disconnecting your own account
 * deliberately leaves it alone. Shown filled in, because the reason to open
 * this is that the id already there is the thing that stopped working.
 */
function Application({ p, onSaved }: { p: ProviderStatus; onSaved: () => void }) {
  const save = useSetClientId();
  const [value, setValue] = useState(p.clientId ?? "");

  return (
    <div className="border-t border-line-soft bg-ground/40 px-3.5 py-3">
      <p className="text-meta text-dim">The application {p.label} authorizes against, for everybody on this server. Public by design — a device-flow client id has no paired secret.</p>
      <div className="mt-2 flex items-center gap-2">
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="OAuth client id" spellCheck={false} className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 font-mono text-ui text-bone focus:outline-none" />
        <button disabled={!value.trim() || value.trim() === p.clientId || save.isPending} onClick={() => save.mutate({ id: p.id, data: { clientId: value.trim() } }, { onSuccess: onSaved })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">{save.isPending ? "Saving…" : "Save"}</button>
      </div>
      {save.error && <p className="mt-2 text-meta text-brick">{why(save.error)}</p>}
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
          {/* An API key is frequently the organisation's — one Linear workspace
              key a team shares, rather than five people pasting the same
              string. A git host's is not: its token pushes commits, and a
              commit has to be attributable to a person, so the server hands
              back no handle for one and nothing is drawn here. */}
          {t.secret && <WhoCanAccess look="chip" kind="secret" id={t.secret} path={t.path} />}
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

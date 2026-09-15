/**
 * Machines: where agents run.
 *
 * Adding one is the web's `AddCompute` flow exactly — show the key the machine
 * has to be given, probe the destination with `probe_host`, and on `reached`
 * create the machine. A probe that does not reach says why, with the
 * diagnosis's own remedy. Nothing here installs: the machine's own row does.
 *
 * Each machine's row answers `host_readiness` — ssh, the worker, the agents —
 * with the remedies the server suggests, and the verbs that fix what it can:
 * connect, install the worker, drain, rename, remove.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, Cpu, HardDrive, Key, Loader2, Plus, Trash2, X } from "lucide-react";
import { Icon } from "~/components/ui";
import type { Compute, Diagnosis, Host } from "~/api/generated/model";
import {
  getListHostsQueryKey,
  useConnectHost,
  useCreateHost,
  useDeleteHost,
  useDrainHost,
  useHostReadiness,
  useInstallWorker,
  useProbeHost,
  useRenameHost,
  useSshKey,
} from "~/api/generated/hosts/hosts";
import { parseDestination, reachedTheMachine, stateLabel, waitForOnline } from "~/api/environments";
import { useHosts } from "~/data";
import { Rows, Section } from "~/ui/config/bits";
import { useConfirm } from "~/ui/Confirm";

export function Machines({ live }: { live: boolean }) {
  const hosts = useHosts();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Section
      title="Compute"
      note="One owner per host until sessions are isolated from each other."
      action={live && <button onClick={() => setAdding(true)} className="control border border-line bg-raise text-ui text-bone hover:bg-overlay"><Icon of={Plus} size={12} />Add a machine</button>}
    >
      <Rows feed={hosts} empty="No machine is connected yet.">
        {hosts.data.map((h) => (
          <div key={h.id}>
            <button onClick={() => setOpen(open === h.id ? null : h.id)} className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-raise/60">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${h.state === "Online" ? "bg-sage" : h.state === "Draining" || reachedTheMachine(h) ? "bg-kind-data" : "bg-brick"}`} />
              <span className="min-w-0 flex-1">
                <span className="block text-ui text-bone">{h.name}</span>
                <span className="block font-mono text-micro text-mute">{describe(h.compute)} · worker {h.workerVersion ?? "not installed"}</span>
              </span>
              {h.cpus != null && <span className="flex items-center gap-1.5 text-meta text-mute"><Icon of={Cpu} size={12} />{h.cpus}</span>}
              {h.memoryMb != null && <span className="flex items-center gap-1.5 text-meta text-mute"><Icon of={HardDrive} size={12} />{Math.round(h.memoryMb / 1024)} GB</span>}
              <span className="w-[76px] text-right text-meta text-mute">{stateLabel(h)}</span>
              <ChevronDown className={`h-3.5 w-3.5 text-mute transition-transform ${open === h.id ? "rotate-180" : ""}`} strokeWidth={2} />
            </button>
            {open === h.id && live && <Detail host={h} onGone={() => setOpen(null)} />}
          </div>
        ))}
      </Rows>
      {adding && <Add onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); setOpen(id); }} />}
    </Section>
  );
}

function describe(c: Compute): string {
  if (c.type === "Local") return "this server";
  return `${c.user ? `${c.user}@` : ""}${c.host}${c.port ? `:${c.port}` : ""}`;
}

/* ── One machine ───────────────────────────────────────────────────────── */

function Detail({ host, onGone }: { host: Host; onGone: () => void }) {
  const confirm = useConfirm();
  const cache = useQueryClient();
  const readiness = useHostReadiness(host.id, undefined, { query: { staleTime: 10_000 } });
  const connect = useConnectHost();
  const install = useInstallWorker();
  const drain = useDrainHost();
  const rename = useRenameHost();
  const remove = useDeleteHost();
  const [name, setName] = useState(host.name);
  const [settling, setSettling] = useState(false);
  const refresh = () => Promise.all([cache.invalidateQueries({ queryKey: getListHostsQueryKey() }), readiness.refetch()]);
  // The install returns when the binary is there; the machine answers a few
  // seconds later. Wait for that, so the panel turns green on its own.
  const installed = async () => {
    setSettling(true);
    await waitForOnline(host.id);
    setSettling(false);
    await refresh();
  };

  const checks = readiness.data?.checks ?? [];
  const missing = checks.filter((c) => c.required && !c.available);

  return (
    <div className="space-y-3 border-t border-line-soft bg-ground/40 px-3.5 py-3">
      {/* The rows below say it when ssh got in; the box is for when it did not. */}
      {host.diagnosis && host.state !== "Online" && !reachedTheMachine(host) && <Told d={host.diagnosis} />}

      <div>
        <div className="flex items-center gap-2">
          <span className="text-meta text-dim">{readiness.isPending ? "Checking…" : missing.length === 0 && checks.length > 0 ? "Ready" : `${missing.length} thing${missing.length === 1 ? "" : "s"} missing`}</span>
          {readiness.data?.user && <span className="font-mono text-micro text-mute">as {readiness.data.user}</span>}
          <button onClick={() => readiness.refetch()} className="ml-auto text-micro text-mute hover:text-bone">check again</button>
        </div>
        <div className="mt-1.5 space-y-1">
          {checks.map((c) => (
            <div key={c.name} className="rounded-md bg-ground px-2.5 py-1.5">
              <div className="flex items-center gap-2 text-ui">
                {c.available ? <Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} /> : <X className={`h-3.5 w-3.5 ${c.required ? "text-brick" : "text-mute"}`} strokeWidth={2} />}
                <span className={c.available ? "text-text" : c.required ? "text-bone" : "text-dim"}>{c.name}</span>
                <span className="min-w-0 truncate text-meta text-mute">{c.detail}</span>
              </div>
              {!c.available && c.remedy && c.name !== "Worker" && (
                <div className="mt-1 flex items-center gap-2 pl-5">
                  <code className="min-w-0 flex-1 truncate font-mono text-micro text-dim">{c.remedy}</code>
                  {/^\S+( \S+)+$/.test(c.remedy) && <button onClick={() => navigator.clipboard?.writeText(c.remedy!)} className="text-mute hover:text-bone"><Copy className="h-3 w-3" strokeWidth={1.75} /></button>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {checks.some((c) => c.name === "Worker" && !c.available && c.remedy) && (
        <details className="text-meta text-mute">
          <summary className="cursor-pointer hover:text-bone">Or do it on the machine yourself</summary>
          <code className="mt-1.5 block break-all rounded-md bg-ground px-2.5 py-1.5 font-mono text-micro text-dim">{checks.find((c) => c.name === "Worker")?.remedy}</code>
        </details>
      )}
      {missing.some((c) => c.name !== "Worker" && /^(sudo |brew |apt|dnf|yum|pacman|apk|zypper)/.test(c.remedy ?? "")) && (
        <p className="text-meta text-mute">Run that on the machine, then check again. Firetower does not run sudo for you.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button disabled={connect.isPending} onClick={() => connect.mutate({ id: host.id }, { onSuccess: refresh })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">{connect.isPending ? "Connecting…" : "Connect"}</button>
        <button disabled={install.isPending || settling} onClick={() => install.mutate({ id: host.id }, { onSuccess: installed })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">{install.isPending ? "Installing…" : settling ? "Reconnecting…" : host.workerVersion ? "Reinstall the worker" : "Install the worker"}</button>
        {install.isError && <span className="text-meta text-brick">{install.error.message}</span>}
        <button disabled={drain.isPending} onClick={() => drain.mutate({ id: host.id, data: { drained: !host.drained } }, { onSuccess: refresh })} className="control border border-line bg-raise text-dim hover:bg-overlay disabled:text-mute">{host.drained ? "Take new work" : "Drain"}</button>
        <button onClick={() => void confirm({ title: `Remove ${host.name}?`, body: "Nothing on the machine is touched.", action: "Remove", tone: "danger" }).then((ok) => ok && remove.mutate({ id: host.id, params: undefined as never }, { onSuccess: () => { refresh(); onGone(); } }))} className="control ml-auto text-mute hover:text-brick"><Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />Remove</button>
      </div>

      <div className="flex items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 text-ui text-bone focus:outline-none" />
        <button disabled={!name.trim() || name === host.name || rename.isPending} onClick={() => rename.mutate({ id: host.id, data: { name: name.trim() } }, { onSuccess: refresh })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">Rename</button>
      </div>
    </div>
  );
}

function Told({ d }: { d: Diagnosis }) {
  return (
    <div className="rounded-lg border border-brick-deep bg-brick-tint px-3 py-2.5">
      <p className="text-ui text-bone">{d.summary}</p>
      {d.detail && <p className="mt-1 font-mono text-micro text-brick">{d.detail}</p>}
      {d.remedy && <p className="mt-1 text-meta text-dim">{d.remedy}</p>}
    </div>
  );
}

/* ── Adding one ────────────────────────────────────────────────────────── */

function Add({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const cache = useQueryClient();
  const create = useCreateHost();
  const probe = useProbeHost();
  const installWorker = useInstallWorker();
  const key = useSshKey();
  /* The machine, once it is saved and ssh got in but found no worker: the
     dialog turns into that next step rather than closing onto a row that
     looks broken. */
  const [made, setMade] = useState<{ host: Host; remedy?: string } | null>(null);
  const [settling, setSettling] = useState(false);
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("");
  const [label, setLabel] = useState("");
  const [told, setTold] = useState<Diagnosis | null>(null);
  const [copied, setCopied] = useState(false);

  const typed = parseDestination(address);
  const busy = create.isPending || probe.isPending || installWorker.isPending || settling;

  const body = () => ({
    name: label.trim() || undefined,
    compute: { type: "Server", host: address.trim(), user: user.trim() || undefined, key: { type: "Managed" } } as Compute,
  });

  const save = async (needsWorker: Diagnosis | null) => {
    const host = await create.mutateAsync({ data: body() });
    await cache.invalidateQueries({ queryKey: getListHostsQueryKey() });
    if (needsWorker) setMade({ host, remedy: needsWorker.remedy ?? undefined });
    else onAdded(host.id);
  };

  const add = () => {
    setTold(null);
    probe.mutate({ data: body() }, {
      onSuccess: (r) => {
        if (!r.reached) return setTold(r.diagnosis ?? null);
        save(r.diagnosis?.cause === "WorkerMissing" ? r.diagnosis : null);
      },
    });
  };

  const install = async () => {
    if (!made) return;
    await installWorker.mutateAsync({ id: made.host.id });
    setSettling(true);
    await waitForOnline(made.host.id);
    setSettling(false);
    await cache.invalidateQueries({ queryKey: getListHostsQueryKey() });
    onAdded(made.host.id);
  };

  const pub = (key.data as { publicKey?: string } | undefined)?.publicKey;
  const copy = () => {
    navigator.clipboard?.writeText(pub ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ground/70 py-[8vh] backdrop-blur-[3px]" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-[36rem] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--shadow-float)">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-title text-bone">Add a machine</h2>
          <button onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"><X className="h-4 w-4" strokeWidth={1.75} /></button>
        </div>

        {made ? (
          <div className="space-y-3 px-5 py-4">
            <p className="flex items-center gap-2 text-ui text-bone"><Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} />Connected to {made.host.name} as {(made.host.compute.type === "Server" && made.host.compute.user) || "the ssh account"}.</p>
            <p className="flex items-center gap-2 text-ui text-bone"><X className="h-3.5 w-3.5 text-brick" strokeWidth={2} />There is no worker on it yet.</p>
            <p className="text-meta text-mute">Firetower puts the worker built for that machine into <code className="font-mono">~/.firetower/worker/bin</code> over the connection it just made. No sudo, nothing outside that account's home. Anything else the machine is missing is shown afterwards, with the command that installs it.</p>
            {made.remedy && (
              <details className="text-meta text-mute">
                <summary className="cursor-pointer hover:text-bone">Or do it on the machine yourself</summary>
                <code className="mt-1.5 block break-all rounded-md bg-ground px-2.5 py-1.5 font-mono text-micro text-dim">{made.remedy}</code>
              </details>
            )}
            {installWorker.isError && <p className="text-meta text-brick">{installWorker.error.message}</p>}
          </div>
        ) : (
        <div className="space-y-4 px-5 py-4">
          <Field label="IP address or hostname"><input autoFocus value={address} onChange={(e) => { setTold(null); setAddress(e.target.value); }} placeholder="192.0.2.10" spellCheck={false} className="w-full rounded-lg border border-line bg-ground px-3 py-2 font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="SSH account"><input value={user} onChange={(e) => setUser(e.target.value)} placeholder={typed.user || "editor"} className="w-full rounded-lg border border-line bg-ground px-3 py-2 font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" /></Field>
            <Field label="Name"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={typed.host || "video-vm"} className="w-full rounded-lg border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" /></Field>
          </div>
          <div className="rounded-lg border border-line bg-ground p-3">
            <div className="flex items-center gap-2 text-ui text-dim"><Key className="h-3.5 w-3.5" strokeWidth={1.75} />Firetower gets in with this key</div>
            {key.isPending ? <p className="mt-1.5 flex items-center gap-2 text-meta text-mute"><Loader2 className="h-3 w-3 animate-spin" />Reading the key…</p> : (
              <div className="mt-2 flex items-start gap-2">
                <code className="scroll-slim min-w-0 flex-1 overflow-x-auto rounded-md bg-panel px-2.5 py-1.5 font-mono text-micro whitespace-nowrap text-dim">{pub ?? JSON.stringify(key.data)}</code>
                <button onClick={copy} className="control border border-line bg-raise text-bone hover:bg-overlay">{copied ? <Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />}</button>
              </div>
            )}
            <p className="mt-2 text-meta text-mute">Give it to the machine the way that machine takes keys: <code className="font-mono">~/.ssh/authorized_keys</code> of the account above on a machine you own; the provider's console, instance metadata or OS Login on Google Cloud; the CA where there is one. It is public — safe anywhere.</p>
            <details className="mt-2 text-meta text-mute">
              <summary className="cursor-pointer hover:text-bone">Adding it to authorized_keys by hand, logged in as that account</summary>
              <pre className="mt-1.5 overflow-x-auto rounded-md bg-panel px-2.5 py-1.5 font-mono text-micro text-dim">{authorizedKeys(pub ?? "…")}</pre>
            </details>
          </div>

          {told && <Told d={told} />}
        </div>
        )}

        <div className="flex items-center gap-2 border-t border-line bg-ground/40 px-5 py-3">
          {made ? (
            <>
              <button onClick={() => onAdded(made.host.id)} disabled={busy} className="control ml-auto text-mute hover:bg-raise hover:text-bone disabled:text-mute">Later</button>
              <button disabled={busy} onClick={install} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">{installWorker.isPending ? "Installing…" : settling ? "Reconnecting…" : "Install the worker"}</button>
            </>
          ) : (
            <>
              <button onClick={onClose} className="control ml-auto text-mute hover:bg-raise hover:text-bone">Cancel</button>
              <button disabled={!typed.host || busy} onClick={add} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">{probe.isPending ? "Reaching it…" : create.isPending ? "Adding…" : "Add it"}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The lines for whoever adds the key on the machine itself, run as the
 * account Firetower will connect as — `~` is that account's home, wherever
 * the machine keeps it (`/home` on Linux, `/Users` on a Mac, somewhere else
 * entirely under LDAP). Guessing the path was wrong on every Mac.
 *
 * `mkdir` and both `chmod`s are not padding: sshd ignores an `authorized_keys`
 * it considers too permissive, without saying so, and a fresh machine often
 * has no `~/.ssh` at all.
 */
function authorizedKeys(key: string) {
  return [
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
    `printf '%s\\n' '${key}' >> ~/.ssh/authorized_keys`,
    "chmod 600 ~/.ssh/authorized_keys",
  ].join("\n");
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-2"><span className="text-ui text-dim">{label}</span>{hint && <span className="text-meta text-mute">{hint}</span>}</span>
      {children}
    </label>
  );
}

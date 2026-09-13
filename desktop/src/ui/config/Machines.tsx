/**
 * Machines: where agents run.
 *
 * Adding one is the web's `AddCompute` flow exactly — probe the destination
 * with `probe_host`, and on `reached` create both environments in one go: the
 * machine itself, and the container on it, because picking Container in the
 * new-workspace form should not have to invent one. A probe that does not
 * reach says why, with the diagnosis's own remedy.
 *
 * Each machine's row answers `host_readiness` — docker, the worker, the agents
 * — with the remedies the server suggests, and the verbs that fix what it can:
 * connect, install the worker, drain, rename, remove.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, Cpu, HardDrive, Key, Loader2, Plus, Trash2, X } from "lucide-react";
import { Icon } from "@/components/ui";
import type { Compute, Diagnosis, Host } from "@/src/api/generated/model";
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
} from "@/src/api/generated/hosts/hosts";
import { parseDestination } from "@/src/api/environments";
import { useHosts } from "~/data";
import { Rows, Section } from "~/ui/config/bits";

const DEFAULT_CONTAINER = "firetower-worker";

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
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${h.state === "Online" ? "bg-sage" : h.state === "Draining" ? "bg-kind-data" : "bg-brick"}`} />
              <span className="min-w-0 flex-1">
                <span className="block text-ui text-bone">{h.name}</span>
                <span className="block font-mono text-micro text-mute">{describe(h.compute)} · worker {h.workerVersion ?? "not installed"}</span>
              </span>
              {h.cpus != null && <span className="flex items-center gap-1.5 text-meta text-mute"><Icon of={Cpu} size={12} />{h.cpus}</span>}
              {h.memoryMb != null && <span className="flex items-center gap-1.5 text-meta text-mute"><Icon of={HardDrive} size={12} />{Math.round(h.memoryMb / 1024)} GB</span>}
              <span className="w-[68px] text-right text-meta text-mute">{h.drained ? "draining" : h.state}</span>
              <ChevronDown className={`h-3.5 w-3.5 text-mute transition-transform ${open === h.id ? "rotate-180" : ""}`} strokeWidth={2} />
            </button>
            {open === h.id && live && <Detail host={h} onGone={() => setOpen(null)} />}
          </div>
        ))}
      </Rows>
      {adding && <Add onClose={() => setAdding(false)} />}
    </Section>
  );
}

function describe(c: Compute): string {
  if (c.type === "Local") return "this server";
  if (c.type === "Container") return `container ${c.name}`;
  return `${c.user ? `${c.user}@` : ""}${c.host}${c.port ? `:${c.port}` : ""}${c.container ? ` · in ${c.container}` : ""}`;
}

/* ── One machine ───────────────────────────────────────────────────────── */

function Detail({ host, onGone }: { host: Host; onGone: () => void }) {
  const cache = useQueryClient();
  const readiness = useHostReadiness(host.id, undefined, { query: { staleTime: 10_000 } });
  const connect = useConnectHost();
  const install = useInstallWorker();
  const drain = useDrainHost();
  const rename = useRenameHost();
  const remove = useDeleteHost();
  const [name, setName] = useState(host.name);
  const refresh = () => Promise.all([cache.invalidateQueries({ queryKey: getListHostsQueryKey() }), readiness.refetch()]);

  const checks = readiness.data?.checks ?? [];
  const missing = checks.filter((c) => c.required && !c.available);

  return (
    <div className="space-y-3 border-t border-line-soft bg-ground/40 px-3.5 py-3">
      {host.diagnosis && <Told d={host.diagnosis} />}

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
              {!c.available && c.remedy && (
                <div className="mt-1 flex items-center gap-2 pl-5">
                  <code className="min-w-0 flex-1 truncate font-mono text-micro text-dim">{c.remedy}</code>
                  {/^\S+( \S+)+$/.test(c.remedy) && <button onClick={() => navigator.clipboard?.writeText(c.remedy!)} className="text-mute hover:text-bone"><Copy className="h-3 w-3" strokeWidth={1.75} /></button>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button disabled={connect.isPending} onClick={() => connect.mutate({ id: host.id }, { onSuccess: refresh })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">{connect.isPending ? "Connecting…" : "Connect"}</button>
        <button disabled={install.isPending} onClick={() => install.mutate({ id: host.id }, { onSuccess: refresh })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">{install.isPending ? "Installing…" : host.workerVersion ? "Reinstall the worker" : "Install the worker"}</button>
        <button disabled={drain.isPending} onClick={() => drain.mutate({ id: host.id, data: { drained: !host.drained } }, { onSuccess: refresh })} className="control border border-line bg-raise text-dim hover:bg-overlay disabled:text-mute">{host.drained ? "Take new work" : "Drain"}</button>
        <button onClick={() => { if (window.confirm(`Remove ${host.name}? Nothing on the machine is touched.`)) remove.mutate({ id: host.id, params: undefined as never }, { onSuccess: () => { refresh(); onGone(); } }); }} className="control ml-auto text-mute hover:text-brick"><Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />Remove</button>
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

function Add({ onClose }: { onClose: () => void }) {
  const cache = useQueryClient();
  const create = useCreateHost();
  const probe = useProbeHost();
  const key = useSshKey();
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("");
  const [container, setContainer] = useState(DEFAULT_CONTAINER);
  const [label, setLabel] = useState("");
  const [ownKey, setOwnKey] = useState(false);
  const [keyPath, setKeyPath] = useState("");
  const [told, setTold] = useState<Diagnosis | null>(null);
  const [copied, setCopied] = useState(false);

  const typed = parseDestination(address);
  const busy = create.isPending || probe.isPending;

  const body = () => ({
    name: label.trim() || undefined,
    compute: { type: "Server", host: address.trim(), user: user.trim() || undefined, key: ownKey && keyPath.trim() ? { type: "File", path: keyPath.trim() } : { type: "Managed" } } as Compute,
  });

  /* Both environments, in one go — the machine, then the container on it. A
     machine that is added and a second environment that is not is still a
     machine that is added. */
  const save = async () => {
    await create.mutateAsync({ data: body() });
    const named = container.trim();
    if (named) {
      const base = label.trim() || typed.host;
      await create.mutateAsync({ data: { name: `${base} · container`, compute: { ...body().compute, container: named } as Compute } }).catch(() => {});
    }
    await cache.invalidateQueries({ queryKey: getListHostsQueryKey() });
    onClose();
  };

  const add = () => {
    setTold(null);
    probe.mutate({ data: body() }, { onSuccess: (r) => (r.reached ? save() : setTold(r.diagnosis ?? null)) });
  };

  const pub = (key.data as { publicKey?: string } | undefined)?.publicKey;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ground/70 py-[8vh] backdrop-blur-[3px]" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-[36rem] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--shadow-float)">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-title text-bone">Add a machine</h2>
          <button onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"><X className="h-4 w-4" strokeWidth={1.75} /></button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <Field label="IP address or hostname"><input autoFocus value={address} onChange={(e) => { setTold(null); setAddress(e.target.value); }} placeholder="192.0.2.10" spellCheck={false} className="w-full rounded-lg border border-line bg-ground px-3 py-2 font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="SSH account"><input value={user} onChange={(e) => setUser(e.target.value)} placeholder={typed.user || "editor"} className="w-full rounded-lg border border-line bg-ground px-3 py-2 font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" /></Field>
            <Field label="Name"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={typed.host || "video-vm"} className="w-full rounded-lg border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" /></Field>
          </div>
          <Field label="Container name" hint="The environment agents run in, made when first picked"><input value={container} onChange={(e) => setContainer(e.target.value)} placeholder={DEFAULT_CONTAINER} className="w-full rounded-lg border border-line bg-ground px-3 py-2 font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" /></Field>

          <div className="rounded-lg border border-line bg-ground p-3">
            <div className="flex items-center gap-2 text-ui text-dim"><Key className="h-3.5 w-3.5" strokeWidth={1.75} />How Firetower gets in</div>
            <div className="track mt-2">
              <button data-on={!ownKey} onClick={() => setOwnKey(false)}>Firetower's key</button>
              <button data-on={ownKey} onClick={() => setOwnKey(true)}>A key on the server</button>
            </div>
            {!ownKey ? (
              <div className="mt-2">
                <p className="text-meta text-mute">Add this public key to the machine's <code className="font-mono">~/.ssh/authorized_keys</code>.</p>
                {key.isPending ? <p className="mt-1.5 flex items-center gap-2 text-meta text-mute"><Loader2 className="h-3 w-3 animate-spin" />Reading the key…</p> : (
                  <div className="mt-1.5 flex items-start gap-2">
                    <code className="scroll-slim min-w-0 flex-1 overflow-x-auto rounded-md bg-panel px-2.5 py-1.5 font-mono text-micro whitespace-nowrap text-dim">{pub ?? JSON.stringify(key.data)}</code>
                    <button onClick={() => { navigator.clipboard?.writeText(pub ?? ""); setCopied(true); setTimeout(() => setCopied(false), 1400); }} className="control border border-line bg-raise text-bone hover:bg-overlay">{copied ? <Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />}</button>
                  </div>
                )}
              </div>
            ) : (
              <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" className="mt-2 w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-ui text-bone placeholder:text-mute focus:outline-none" />
            )}
          </div>

          {told && <Told d={told} />}
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-ground/40 px-5 py-3">
          <button onClick={onClose} className="control ml-auto text-mute hover:bg-raise hover:text-bone">Cancel</button>
          <button disabled={!typed.host || busy} onClick={add} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">{probe.isPending ? "Reaching it…" : create.isPending ? "Adding…" : "Add it"}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-2"><span className="text-ui text-dim">{label}</span>{hint && <span className="text-meta text-mute">{hint}</span>}</span>
      {children}
    </label>
  );
}

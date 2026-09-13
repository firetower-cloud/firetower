/**
 * Repositories: a pointer and some setup. What opens one is the token, which is
 * per person — so adding one is either picking from what GitHub says you can
 * see, or pasting a remote and letting the server probe it.
 *
 * The flows are the web's `ConnectRepo` and `RepoSettings`: probe on a pause
 * after typing, create with the probed slug, settings as `RepoChanges`, env as
 * `NewEnv` with values that are never read back.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2, Plus, Trash2, X } from "lucide-react";
import { GithubMark, Icon } from "@/components/ui";
import type { Repo } from "@/src/api/generated/model";
import {
  getListReposQueryKey,
  useCreateRepo,
  useDeleteRepo,
  useListRepoEnv,
  useProbeRepo,
  usePutRepoEnv,
  useRemoveRepoEnv,
  useUpdateRepo,
} from "@/src/api/generated/repos/repos";
import { useListProviderRepos } from "@/src/api/generated/providers/providers";
import { useProviders, useRepos } from "~/data";
import { why } from "~/data";
import { Rows, Section } from "~/ui/config/bits";
import { useConfirm } from "~/ui/Confirm";

export function Repos({ live }: { live: boolean }) {
  const repos = useRepos();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Section
      title="Repositories"
      note="A pointer and some setup. What opens one is the token, which is per person."
      action={live && <button onClick={() => setAdding(true)} className="control border border-line bg-raise text-ui text-bone hover:bg-overlay"><Icon of={Plus} size={12} />Add</button>}
    >
      <Rows feed={repos} empty="No repository is connected yet.">
        {repos.data.map((r) => (
          <div key={r.id}>
            <button onClick={() => setOpen(open === r.id ? null : r.id)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-raise/60">
              <GithubMark size={13} className="shrink-0 text-mute" />
              <span className="min-w-0 flex-1 truncate font-mono text-ui text-dim">{r.slug}</span>
              <span className="font-mono text-micro text-mute">{r.defaultBranch ?? "main"}</span>
              <ChevronDown className={`h-3.5 w-3.5 text-mute transition-transform ${open === r.id ? "rotate-180" : ""}`} strokeWidth={2} />
            </button>
            {open === r.id && live && <Settings repo={r} onGone={() => setOpen(null)} />}
          </div>
        ))}
      </Rows>
      {adding && <Add onClose={() => setAdding(false)} />}
    </Section>
  );
}

/* ── Settings for one ──────────────────────────────────────────────────── */

function Settings({ repo, onGone }: { repo: Repo; onGone: () => void }) {
  const confirm = useConfirm();
  const cache = useQueryClient();
  const save = useUpdateRepo();
  const remove = useDeleteRepo();
  const put = usePutRepoEnv();
  const drop = useRemoveRepoEnv();
  const env = useListRepoEnv(repo.id);
  const [setup, setSetup] = useState(repo.setup ?? "");
  const [envFile, setEnvFile] = useState(repo.envFile ?? "");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);

  const refresh = () => cache.invalidateQueries({ queryKey: getListReposQueryKey() });

  return (
    <div className="space-y-3 border-t border-line-soft bg-ground/40 px-3.5 py-3">
      <label className="block">
        <span className="text-meta text-dim">Setup script <span className="text-mute">— runs after checkout, before the agent</span></span>
        <textarea rows={3} value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="pnpm install" className="scroll-slim mt-1 w-full resize-none rounded-lg border border-line bg-ground px-3 py-2 font-mono text-code text-text focus:border-slate-deep focus:outline-none" />
      </label>
      <label className="block">
        <span className="text-meta text-dim">Env file <span className="text-mute">— written into the workspace from the variables below</span></span>
        <input value={envFile} onChange={(e) => setEnvFile(e.target.value)} placeholder=".env" className="mt-1 w-full rounded-lg border border-line bg-ground px-3 py-1.5 font-mono text-ui text-bone focus:border-slate-deep focus:outline-none" />
      </label>
      <div className="flex items-center gap-2">
        <button disabled={save.isPending} onClick={() => save.mutate({ id: repo.id, data: { setup: setup || null, envFile: envFile || null } }, { onSuccess: () => { refresh(); setSaved(true); setTimeout(() => setSaved(false), 1400); } })} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">
          {save.isPending ? "Saving…" : saved ? <><Check className="h-3.5 w-3.5" strokeWidth={2} />Saved</> : "Save"}
        </button>
        <button onClick={() => { void confirm({ title: `Remove ${repo.slug}?`, body: "Workspaces already cut from it are untouched.", action: "Remove", tone: "danger" }).then((ok) => ok && remove.mutate({ id: repo.id }, { onSuccess: () => { refresh(); onGone(); } })); }} className="control ml-auto text-mute hover:text-brick"><Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />Remove</button>
      </div>

      <div>
        <span className="text-meta text-dim">Environment <span className="text-mute">— names are shown, values never come back</span></span>
        <div className="mt-1.5 space-y-1">
          {(env.data ?? []).map((n) => (
            <div key={n} className="flex items-center gap-2 rounded-md bg-ground px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-ui text-text">{n}</span>
              <span className="font-mono text-micro text-mute">••••</span>
              <button onClick={() => drop.mutate({ id: repo.id, name: n }, { onSuccess: () => env.refetch() })} className="grid h-5 w-5 place-items-center rounded text-mute hover:text-brick"><X className="h-3 w-3" strokeWidth={2} /></button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="NAME" className="w-40 rounded-md border border-line bg-ground px-2 py-1 font-mono text-ui text-bone focus:outline-none" />
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" type="password" className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 font-mono text-ui text-bone focus:outline-none" />
            <button disabled={!name || !value || put.isPending} onClick={() => put.mutate({ id: repo.id, data: { variables: [{ name, value }] } }, { onSuccess: () => { setName(""); setValue(""); env.refetch(); } })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">Add</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Adding one ────────────────────────────────────────────────────────── */

function Add({ onClose }: { onClose: () => void }) {
  const cache = useQueryClient();
  const providers = useProviders();
  const github = providers.data.find((p) => p.connected);
  const [way, setWay] = useState<"pick" | "paste">(github ? "pick" : "paste");

  const done = async () => {
    await cache.invalidateQueries({ queryKey: getListReposQueryKey() });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ground/70 pt-[10vh] backdrop-blur-[3px]" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-[34rem] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--shadow-float)">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-title text-bone">Add a repository</h2>
          <div className="track ml-auto">
            <button data-on={way === "pick"} onClick={() => setWay("pick")} disabled={!github}>From GitHub</button>
            <button data-on={way === "paste"} onClick={() => setWay("paste")}>Paste a remote</button>
          </div>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"><X className="h-4 w-4" strokeWidth={1.75} /></button>
        </div>
        {way === "pick" && github ? <Pick providerId={github.id} onDone={done} /> : <Paste onDone={done} />}
      </div>
    </div>
  );
}

function Pick({ providerId, onDone }: { providerId: string; onDone: () => void }) {
  const { data, isPending, error } = useListProviderRepos(providerId);
  const create = useCreateRepo();
  const [q, setQ] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const all = (data ?? []) as { slug: string; remote: string }[];
  const shown = all.filter((r) => r.slug.toLowerCase().includes(q.toLowerCase())).slice(0, 60);

  const add = async () => {
    setBusy(true);
    for (const r of all.filter((r) => chosen.has(r.slug))) {
      await create.mutateAsync({ data: { slug: r.slug, remote: r.remote } }).catch(() => {});
    }
    setBusy(false);
    onDone();
  };

  return (
    <div className="px-5 py-4">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter your repositories" className="w-full rounded-lg border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" />
      <div className="scroll-slim mt-2 max-h-72 divide-y divide-line-soft overflow-y-auto rounded-lg border border-line">
        {isPending && <p className="flex items-center gap-2 px-3 py-3 text-ui text-mute"><Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />Asking GitHub…</p>}
        {error && <p className="px-3 py-3 text-ui text-brick">{why(error)}</p>}
        {shown.map((r) => {
          const on = chosen.has(r.slug);
          return (
            <button key={r.slug} onClick={() => setChosen((h) => { const n = new Set(h); on ? n.delete(r.slug) : n.add(r.slug); return n; })} className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-raise/60">
              <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${on ? "border-sage-deep bg-sage-tint text-sage" : "border-line text-transparent"}`}><Check className="h-3 w-3" strokeWidth={3} /></span>
              <span className="truncate font-mono text-ui text-text">{r.slug}</span>
            </button>
          );
        })}
        {!isPending && !error && shown.length === 0 && <p className="px-3 py-3 text-ui text-mute">Nothing matches. Organisations you did not grant stay hidden.</p>}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button disabled={chosen.size === 0 || busy} onClick={add} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">{busy ? "Adding…" : `Add ${chosen.size || ""}`}</button>
      </div>
    </div>
  );
}

function Paste({ onDone }: { onDone: () => void }) {
  const probe = useProbeRepo();
  const create = useCreateRepo();
  const [remote, setRemote] = useState("");
  const [trouble, setTrouble] = useState<string | null>(null);

  /* Probed on a pause after typing, the way the web does it: the server says
     what the remote is called and whether it can reach it. */
  useEffect(() => {
    const value = remote.trim();
    if (!value) return;
    const t = setTimeout(() => probe.mutate({ data: { remote: value } }), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote]);

  const found = probe.data;
  const add = () =>
    create.mutate({ data: { slug: found?.slug ?? "", remote: remote.trim() } }, { onSuccess: onDone, onError: (e) => setTrouble(why(e)) });

  return (
    <div className="px-5 py-4">
      <input autoFocus value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="git@github.com:acme/web.git" spellCheck={false} className="w-full rounded-lg border border-line bg-ground px-3 py-2 font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" />
      <div className="mt-2 min-h-6 text-meta">
        {probe.isPending && <span className="flex items-center gap-2 text-mute"><Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />Reaching it…</span>}
        {probe.isError && <span className="text-brick">{why(probe.error)}</span>}
        {found && <span className="text-sage"><Check className="mr-1 inline h-3.5 w-3.5" strokeWidth={2} />{found.slug} · default branch {found.defaultBranch}{found.onlyHere ? " · only reachable from the server" : ""}</span>}
      </div>
      {trouble && <p className="text-meta text-brick">{trouble}</p>}
      <div className="mt-3 flex justify-end">
        <button disabled={!found || create.isPending} onClick={add} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">{create.isPending ? "Adding…" : "Add it"}</button>
      </div>
    </div>
  );
}

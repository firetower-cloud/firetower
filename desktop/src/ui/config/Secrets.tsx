/**
 * The vault, as much of it as a person may see.
 *
 * Names and scopes are listed; a value is only ever shown by asking
 * (`reveal_secret`), which is logged on the server — the access trail is the
 * point of having a vault rather than a file. Replace and remove are the two
 * writes.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { Icon } from "@/components/ui";
import { getListSecretsQueryKey, useListSecrets, useRemoveSecret, useReplaceSecret, useRevealSecret } from "@/src/api/generated/secrets/secrets";
import { Section } from "~/ui/config/bits";

import { why } from "~/data";

export function Secrets() {
  const cache = useQueryClient();
  const { data, isPending, error } = useListSecrets();
  const replace = useReplaceSecret();
  const remove = useRemoveSecret();
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState("global");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const refresh = () => cache.invalidateQueries({ queryKey: getListSecretsQueryKey() });

  const held = (data as { held?: { scope: string; name: string; mine: boolean }[]; intact?: boolean } | undefined)?.held ?? [];

  return (
    <Section
      title="Secrets"
      note="Held encrypted, revealed only by asking, and every read is logged."
      action={<button onClick={() => setAdding(!adding)} className="control border border-line bg-raise text-ui text-bone hover:bg-overlay"><Icon of={Plus} size={12} />Add</button>}
    >
      {isPending && <p className="px-3.5 py-4 text-ui text-mute">Reading the vault…</p>}
      {error ? <p className="px-3.5 py-4 text-ui text-brick">{why(error)}</p> : null}
      {!isPending && !error && held.length === 0 && !adding && <p className="px-3.5 py-4 text-ui text-mute">Nothing held yet.</p>}

      {adding && (
        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="scope" className="w-28 rounded-md border border-line bg-ground px-2 py-1 font-mono text-ui text-bone focus:outline-none" />
          <input value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="NAME" className="w-40 rounded-md border border-line bg-ground px-2 py-1 font-mono text-ui text-bone focus:outline-none" />
          <input value={value} onChange={(e) => setValue(e.target.value)} type="password" placeholder="value" className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 font-mono text-ui text-bone focus:outline-none" />
          <button disabled={!scope || !name || !value || replace.isPending} onClick={() => replace.mutate({ scope, name, data: { value } }, { onSuccess: () => { setName(""); setValue(""); setAdding(false); refresh(); } })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">Keep</button>
        </div>
      )}

      {held.map((s) => (
        <Row key={`${s.scope}/${s.name}`} scope={s.scope} name={s.name} mine={s.mine} onGone={refresh} />
      ))}
    </Section>
  );
}

function Row({ scope, name, mine, onGone }: { scope: string; name: string; mine: boolean; onGone: () => void }) {
  const reveal = useRevealSecret();
  const remove = useRemoveSecret();
  const replace = useReplaceSecret();
  const [shown, setShown] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2.5 px-3.5 py-2.5">
      <span className="w-24 shrink-0 truncate font-mono text-micro text-mute">{scope}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-ui text-text">{name}{!mine && <span className="ml-1.5 text-micro text-mute">· someone else's</span>}</span>
      {editing !== null ? (
        <>
          <input autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} type="password" onKeyDown={(e) => { if (e.key === "Enter" && editing) replace.mutate({ scope, name, data: { value: editing } }, { onSuccess: () => setEditing(null) }); if (e.key === "Escape") setEditing(null); }} placeholder="new value" className="w-48 rounded-md border border-line bg-ground px-2 py-1 font-mono text-micro text-bone focus:outline-none" />
          <button onClick={() => setEditing(null)} className="text-micro text-mute hover:text-bone">cancel</button>
        </>
      ) : (
        <>
          <code className="font-mono text-micro text-mute">{shown ?? "••••••••"}</code>
          <button onClick={() => (shown ? setShown(null) : reveal.mutate({ scope, name }, { onSuccess: (r) => setShown(r.value) }))} title={shown ? "Hide" : "Reveal — this is logged"} className="grid h-6 w-6 place-items-center rounded text-mute hover:bg-raise hover:text-bone">{shown ? <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} /> : <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />}</button>
          <button onClick={() => setEditing("")} className="text-micro text-mute hover:text-bone">replace</button>
          <button onClick={() => { if (window.confirm(`Remove ${scope}/${name}?`)) remove.mutate({ scope, name }, { onSuccess: onGone }); }} className="grid h-6 w-6 place-items-center rounded text-mute hover:text-brick"><Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} /></button>
        </>
      )}
    </div>
  );
}

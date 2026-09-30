/**
 * The vault, as much of it as a person may see.
 *
 * Names and scopes are listed; a value is only ever shown by asking
 * (`reveal_secret`), which is logged on the server — the access trail is the
 * point of having a vault rather than a file. Keep and remove are the two
 * A list, not a form. Every secret the product uses is made where it is used —
 * a git token by connecting an account, an agent's credential by connecting a
 * subscription, a repository's variables on the repository, the voice key on
 * the composer. Nothing reads a scope somebody invented here, so a control that
 * made one was a trap: you stored the thing, reasonably expected an agent to be
 * given it, and it never was. What is left is seeing what is held, replacing a
 * value, and taking one away.
 *
 * Every write says out loud when it is refused. A silent mutation here is how
 * "clicking Keep does nothing" got reported as the button being dead, when the
 * request was going out and coming back with a reason nothing was showing.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Trash2 } from "lucide-react";
import { Icon } from "~/components/ui";
import { getListSecretsQueryKey, useListSecrets, useRemoveSecret, useReplaceSecret, useRevealSecret } from "~/api/generated/secrets/secrets";
import type { HeldSecret } from "~/api/generated/model";
import { Section } from "~/ui/config/bits";
import { WhoCanAccess } from "~/ui/Sharing";

import { why } from "~/data";
import { useConfirm } from "~/ui/Confirm";

export function Secrets() {
  const cache = useQueryClient();
  const { data, isPending, error } = useListSecrets();
  const refresh = () => cache.invalidateQueries({ queryKey: getListSecretsQueryKey() });

  // The generated type, not a hand-written copy of it: this was spelled out
  // here and so did not learn about `id` when the server grew one.
  const held = (data as { held?: HeldSecret[] } | undefined)?.held ?? [];

  return (
    <Section
      title="Secrets"
      note="Held encrypted, revealed only by asking, and every read is logged. Each one is made where it is used."
    >
      {isPending && <p className="px-3.5 py-4 text-ui text-mute">Reading the vault…</p>}
      {error ? <p className="px-3.5 py-4 text-ui text-brick">{why(error)}</p> : null}
      {!isPending && !error && held.length === 0 && <p className="px-3.5 py-4 text-ui text-mute">Nothing held yet.</p>}

      {held.map((s) => (
        <Row key={s.id} id={s.id} scope={s.scope} name={s.name} mine={s.mine} path={s.path} onGone={refresh} />
      ))}
    </Section>
  );
}

/* `id` is `scope/name/owner`, which is the whole key. Scope and name alone are
   not unique — two people each authorizing GitHub as themselves is the point —
   so they are what the row *says* and `id` is what addresses it, here and as
   the React key. */
function Row({ id, scope, name, mine, path, onGone }: { id: string; scope: string; name: string; mine: boolean; path?: string | null; onGone: () => void }) {
  const confirm = useConfirm();
  const reveal = useRevealSecret();
  const remove = useRemoveSecret();
  const replace = useReplaceSecret();
  const [shown, setShown] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2.5 px-3.5 py-2.5">
      <span className="w-24 shrink-0 truncate font-mono text-micro text-mute">{scope}</span>
      {/* What it says when it is not simply yours. A secret filed into a
          directory has that directory as its owner — that is what handing it
          over means — so `mine` goes false the moment it is shared, and
          "someone else's" would be a lie about your own credential. The chip
          beside it already says where it is; the only thing left to name is the
          installation's own, which belongs to the deployment and to nobody. */}
      <span className="min-w-0 flex-1 truncate font-mono text-ui text-text">{name}{!mine && !path && <span className="ml-1.5 text-micro text-mute">· this installation's</span>}</span>
      {/* Filing a secret re-seals it: the owner is in the associated data of
          both crypto layers, so it is opened under the old identity and sealed
          under the new. That is why moving one is a real transfer and not a
          second reader being added.

          Never an `agent` one, and never a repository's `env:` variable. Those
          are *attached* — they belong to an account or a repository and move when
          it moves — so they arrive here with no path and the chip draws
          nothing. Sharing the account is what sharing one of those means. */}
      <WhoCanAccess look="chip" kind="secret" id={id} path={path} />
      {editing !== null ? (
        <>
          <input autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} type="password" onKeyDown={(e) => { if (e.key === "Enter" && editing) replace.mutate({ scope, name, data: { value: editing } }, { onSuccess: () => setEditing(null) }); if (e.key === "Escape") setEditing(null); }} placeholder="new value" className="w-48 rounded-md border border-line bg-ground px-2 py-1 font-mono text-micro text-bone focus:outline-none" />
          <button onClick={() => { setEditing(null); replace.reset(); }} className="text-micro text-mute hover:text-bone">cancel</button>
          {replace.isError && <span className="text-micro text-brick">{why(replace.error)}</span>}
        </>
      ) : (
        <>
          <code className="font-mono text-micro text-mute">{shown ?? "••••••••"}</code>
          <button onClick={() => (shown ? setShown(null) : reveal.mutate({ scope, name }, { onSuccess: (r) => setShown(r.value) }))} title={shown ? "Hide" : "Reveal — this is logged"} className="grid h-6 w-6 place-items-center rounded text-mute hover:bg-raise hover:text-bone">{shown ? <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} /> : <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />}</button>
          <button onClick={() => setEditing("")} className="text-micro text-mute hover:text-bone">replace</button>
          <button onClick={() => void confirm({ title: `Remove ${scope}/${name}?`, body: "Sessions that were given it keep what they have.", action: "Remove", tone: "danger" }).then((ok) => ok && remove.mutate({ scope, name }, { onSuccess: onGone }))} className="grid h-6 w-6 place-items-center rounded text-mute hover:text-brick"><Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} /></button>
        </>
      )}
    </div>
  );
}

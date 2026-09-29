/** The three states a list off a server can be in, drawn the same way everywhere. */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { fileItems, unfileItems } from "~/api/generated/access/access";
import type { FiledKind } from "~/api/generated/model";
import { useDirectories, why } from "~/data";
import { destinations, mayMove, where } from "~/filing";
import { useMe } from "~/api/generated/auth/auth";
import { ContextMenu, useMenu } from "~/ui/ContextMenu";

export function Rows<T>({ feed, empty, children }: { feed: { data: T[]; loading: boolean; error: string | null }; empty: string; children: React.ReactNode }) {
  if (feed.loading) {
    return (
      <div className="flex items-center gap-2 px-3.5 py-4 text-ui text-mute">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
        Reading it off the server…
      </div>
    );
  }
  if (feed.error) return <p className="px-3.5 py-4 text-ui text-brick">{feed.error}</p>;
  if (feed.data.length === 0) return <p className="px-3.5 py-4 text-ui text-mute">{empty}</p>;
  return <>{children}</>;
}

export function Section({ title, note, action, children }: { title: string; note?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <h2 className="text-title text-bone">{title}</h2>
          {note && <p className="mt-0.5 text-meta text-mute">{note}</p>}
        </div>
        {action && <div className="ml-auto shrink-0">{action}</div>}
      </div>
      <div className="mt-2.5 divide-y divide-line-soft overflow-hidden rounded-xl border border-line bg-panel">{children}</div>
    </section>
  );
}

/** A device code, shown large enough to type across the room. */
export function DeviceCode({ code, url, note }: { code: string; url: string; note?: string }) {
  return (
    <div className="rounded-xl border border-line bg-ground px-4 py-4 text-center">
      <p className="text-meta text-dim">Enter this code at <a href={url} target="_blank" rel="noreferrer" className="text-bone underline decoration-line underline-offset-2">{url.replace(/^https?:\/\//, "")}</a></p>
      <div className="mx-auto mt-3 inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-4 py-2 font-mono text-display tracking-[0.2em] text-bone">
        {code}
        <button onClick={() => navigator.clipboard?.writeText(code)} className="text-micro tracking-normal text-mute hover:text-bone">copy</button>
      </div>
      <p className="mt-3 flex items-center justify-center gap-2 text-meta text-mute"><Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />Waiting for you to approve it…</p>
      {note && <p className="mt-2 text-micro text-mute">{note}</p>}
    </div>
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Where something is filed, and — if they may — the way to move it.
 *
 * One control for all three of the things on this screen — a machine, a
 * subscription, a secret — because it is one question.
 *
 * **Who may answer it is not the caller's to decide.** It was, and the three
 * callers disagreed: two of them read a `u/` prefix as "mine" when it only
 * means "somebody's", so a colleague's machine came with a working-looking
 * menu. `mayMove` is the one answer, and it is the same one `may_share` gives
 * on the server.
 *
 * **One choice, not a set of ticks.** A thing lives at one path, so moving it
 * into a directory takes it out of wherever it was — and hands it over. The menu
 * says so on the line that does it, because a transfer somebody did not know
 * they were making is the failure this has to prevent.
 *
 * Shows the path, not just the directory's name. `d/backend` is what the
 * Organization screen lists and what a log line says; a chip reading only
 * "Backend" leaves somebody to guess they are the same thing.
 */
export function FiledIn({
  kind,
  id,
  path,
}: {
  kind: FiledKind;
  id: string;
  /** Where it is now — `u/kevin/…` or `d/backend/…`. Absent for an *attached*
   *  thing, which has no path of its own and moves with what it belongs to. */
  path?: string | null;
}) {
  const cache = useQueryClient();
  const { data: directories } = useDirectories();
  const me = useMe();
  const menu = useMenu<null>();
  const [trouble, setTrouble] = useState<string | null>(null);

  // Nothing to say: an attached thing — an agent account's own credential, the
  // install's own secrets — is filed nowhere and cannot be.
  if (!path) return null;

  const mine = me.data?.user;
  const shown = where(path, mine);
  const here = directories.find((d) => d.slug === path.split("/")[1]);

  // Said, not offered. Somebody with a look at a directory should be able to
  // read where a thing is; what they must not get is a control that the server
  // is going to refuse.
  if (!mayMove(path, mine, directories)) {
    return <span className="shrink-0 font-mono text-micro text-mute">{shown}</span>;
  }

  const move = async (to: { id: string } | null) => {
    try {
      const items = { items: [{ kind, id }] };
      if (to) await fileItems(to.id, items);
      // Addressed to the directory it is coming out of: the server checks the
      // two agree, so a stale menu refuses rather than moving something from
      // wherever it has since gone.
      else if (here) await unfileItems(here.id, items);
      setTrouble(null);
      await cache.invalidateQueries();
    } catch (e) {
      setTrouble(why(e));
    }
  };

  return (
    <>
      {menu.open && (
        <ContextMenu
          at={menu.open.at}
          onClose={menu.close}
          items={[
            {
              label: `${path.startsWith("u/") ? "✓ " : "   "}Yours — nobody else`,
              onPick: () => void move(null),
            },
            ...destinations(directories).map((d) => ({
              label: `${here?.id === d.id ? "✓ " : "   "}${d.name} — hands it over`,
              onPick: () => void move(d),
            })),
          ]}
        />
      )}
      <button
        onClick={(e) => menu.show(e, null)}
        title="Where this is filed — and so who can reach it"
        className="shrink-0 rounded px-1.5 py-0.5 font-mono text-micro text-mute transition-colors hover:bg-raise hover:text-bone"
      >
        {shown} ▾
      </button>
      {trouble && <span className="shrink-0 text-micro text-brick">{trouble}</span>}
    </>
  );
}

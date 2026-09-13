/** The three states a list off a server can be in, drawn the same way everywhere. */
import { Loader2 } from "lucide-react";

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

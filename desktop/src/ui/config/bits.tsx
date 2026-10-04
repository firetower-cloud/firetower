/** The three states a list off a server can be in, drawn the same way everywhere. */
import { ExternalLink, Loader2 } from "lucide-react";

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
    <section className="mt-7 first:mt-0">
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
      <p className="text-meta text-dim">{code ? "Enter this code at" : "Open this sign-in link:"} <a href={url} target="_blank" rel="noreferrer" className="text-bone underline decoration-line underline-offset-2">{code ? url.replace(/^https?:\/\//, "") : "Continue with Cursor"}</a></p>
      {code && <div className="mx-auto mt-3 inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-4 py-2 font-mono text-display tracking-[0.2em] text-bone">
        {code}
        <button onClick={() => navigator.clipboard?.writeText(code)} className="text-micro tracking-normal text-mute hover:text-bone">copy</button>
      </div>}
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

/**
 * The way out to the administration site, for the things this app does not do.
 *
 * **The base address and nothing after it.** Linking at a page would make the
 * desktop depend on the web's route structure, and that is a contract nobody
 * agreed to keep — the admin site is free to move its own screens around.
 *
 * `backend.url` is already a resolved origin: `probe.ts` tries the schemes,
 * keeps whichever answered, and only that is stored. So there is no guessing to
 * do here. It is still parsed before it is offered, because a URL written by an
 * older build, or edited by hand in `localStorage`, should not produce a button
 * that goes nowhere.
 *
 * Only to an administrator. Sending a member to a screen that will refuse them
 * is the same mistake as drawing a control the server will not honour.
 */
export function ManageOnTheWeb({ url, may }: { url: string; may: boolean }) {
  if (!may) return null;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  return (
    <a
      href={origin}
      target="_blank"
      rel="noreferrer"
      className="control border border-line bg-raise text-ui text-dim hover:bg-overlay hover:text-bone"
    >
      Manage on the web
      <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
    </a>
  );
}

/**
 * The shape eleven configuration screens are, written once.
 *
 * Each of them had re-implemented it: a title, one sentence, one action, then
 * rows — and each had reached a slightly different answer, so People's heading
 * was a different size from Machines' and Directories' primary action was an
 * outline where Skills' was a pill. `components.html` measures this shape as
 * the single biggest duplication in the client, and the classes below are the
 * artifact's own, so the drawing and the build can be read side by side.
 *
 * **Rows live on the sheet, not in a card.** A border around a list is a
 * second frame inside the sheet's own, and what makes a list read as a list is
 * the repeat — every border added is one more thing competing with it.
 */
import { ExternalLink, Info, Loader2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Icon } from "~/components/ui";

/** The three states a list off a server can be in, drawn the same way everywhere. */
export function Rows<T>({
  feed,
  empty,
  children,
}: {
  feed: { data: T[]; loading: boolean; error: string | null };
  empty: string;
  children: React.ReactNode;
}) {
  if (feed.loading) {
    return (
      <p className="flex items-center gap-2 py-4 text-ui text-mute">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
        Reading it off the server…
      </p>
    );
  }
  if (feed.error) return <p className="py-4 text-ui text-brick">{feed.error}</p>;
  if (feed.data.length === 0) return <p className="py-4 text-ui text-mute">{empty}</p>;
  return <>{children}</>;
}

/**
 * The page: a title, one sentence, one action, then content.
 *
 * `action` is the screen's **one** primary action and belongs top right.
 * `controls` are what operates on the list — a filter, a find — and sit under
 * the title, where they plainly govern what is directly beneath them.
 */
export function Section({
  title,
  note,
  action,
  controls,
  children,
}: {
  title: string;
  note?: string;
  action?: React.ReactNode;
  controls?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="pg">
      <div className="pg-head">
        <div>
          <h1>{title}</h1>
          {note && <p className="sub">{note}</p>}
        </div>
        {action && <div className="acts">{action}</div>}
      </div>
      {controls && <div className="filterline">{controls}</div>}
      {children}
    </div>
  );
}

/**
 * A run of rows under a heading, with its count and its note.
 *
 * The count is beside the heading rather than in a badge: it is part of the
 * sentence the heading makes, not a state to be flagged.
 */
export function Group({
  title,
  count,
  note,
  children,
}: {
  title?: string;
  count?: number;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="lsec">
      {title && (
        <h2>
          {title}
          {count !== undefined && <span className="n">{count}</span>}
        </h2>
      )}
      {note && <p className="note">{note}</p>}
      <div className="lrows">{children}</div>
    </section>
  );
}

/**
 * One row, the same shape on every pane.
 *
 * `glyph` · name and sub-line · whatever the row says about itself · the
 * actions, which arrive on hover **and on focus**, or the keyboard is told
 * less than the mouse.
 */
export function Row({
  glyph,
  name,
  sub,
  onClick,
  children,
  className = "",
}: {
  glyph?: React.ReactNode;
  name: React.ReactNode;
  sub?: React.ReactNode;
  onClick?: () => void;
  /** What the row says about itself, and its actions. */
  children?: React.ReactNode;
  className?: string;
}) {
  const inside = (
    <>
      {glyph && <span className="g">{glyph}</span>}
      <span className="tx">
        <b>{name}</b>
        {sub && <s>{sub}</s>}
      </span>
      {children}
    </>
  );
  if (!onClick) return <div className={`r ${className}`}>{inside}</div>;
  return (
    <button type="button" onClick={onClick} className={`r ${className}`}>
      {inside}
    </button>
  );
}

/** Nothing here yet, or nothing matched: a glyph, one line, one way forward. */
export function Blank({
  icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="blank">
      <div className="in">
        <span className="glyph">
          <Icon of={icon} size={20} />
        </span>
        <h2>{title}</h2>
        {children && <p>{children}</p>}
        {action && <div className="acts">{action}</div>}
      </div>
    </div>
  );
}

/**
 * A line saying what this screen does not do, and where it is done instead.
 *
 * People, Teams, Account and Repositories each end with one. It is how the
 * read-only surfaces stay generous instead of looking withheld — a reader who
 * came to invite somebody is told where to go, rather than shown a control
 * that is greyed out.
 */
export function WhereTo({ children }: { children: React.ReactNode }) {
  return (
    <div className="whereto">
      <span className="g">
        <Icon of={Info} size={16} />
      </span>
      <p>{children}</p>
    </div>
  );
}

/** The facts pane: what is read rather than changed. */
export function Facts({ of }: { of: [string, React.ReactNode, boolean?][] }) {
  return (
    <dl className="fsheet">
      {of.map(([term, value, mono]) => (
        <div key={term} className="row">
          <dt>{term}</dt>
          <dd className={mono ? "mono" : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
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
      className="out"
    >
      Manage on the web
      <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
    </a>
  );
}

/**
 * `**like this**` → bold.
 *
 * The steps come from the server, where the line that catches people out is
 * marked — GitHub's device-flow checkbox, GitLab's Confidential one, Gitea's
 * `user` scope. A step that reads as prose when the whole point is *do not
 * miss this* has lost the thing it was written for.
 *
 * Here rather than beside either screen that draws them: the host list draws
 * the steps for registering an application and the connect panel draws the
 * ones for making a token, and the connect panel is imported *by* the host
 * list — so keeping this next to either one would be a cycle.
 */
export function bold(text: string): React.ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-medium text-dim">
        {part}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

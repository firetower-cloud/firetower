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
import { CircleSlash2, ExternalLink, Info, Loader2, Lock, RefreshCw, Shapes, TriangleAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Icon } from "~/components/ui";
import type { Trouble as TroubleKind } from "~/data";
import { SettingsIndex } from "~/ui/config/SettingsIndex";

/**
 * The five states a list off a server can be in — criterion 49.
 *
 * **A fresh install hits every one of them at once**, so none is an edge case,
 * and they are not one state with five messages. *Refused* is the server
 * answering with a problem and is worth a retry; *denied* is the server
 * answering correctly, and a retry will say the same thing; *dark* is nothing
 * answering at all, where the last thing we knew is still the most useful
 * thing on the screen. They were one line of brick text — and on Repositories
 * they were nothing at all: a 503 drew "Nothing imported yet", which is the
 * worst of the five possible lies.
 */
const BLANK = {
  error: [TriangleAlert, "That did not load"] as const,
  denied: [Lock, "You cannot see this"] as const,
  dark: [CircleSlash2, "Can’t reach this Firetower"] as const,
};

export function Rows<T>({
  feed,
  empty,
  note,
  action,
  onRetry,
  children,
}: {
  feed: { data: T[]; loading: boolean; error: string | null; trouble?: TroubleKind | null };
  /**
   * The heading when there is simply nothing yet — **or a whole block**.
   *
   * Main's reasoning, kept: a grey line inside a bordered card reads as a
   * list that failed to load, which is right for a list that happens to be
   * empty and wrong for a screen whose empty state is the first thing to do.
   * Machines is that screen now that nothing is registered for you, so it
   * passes its own panel; everything else passes a string and gets `Blank`.
   */
  empty: React.ReactNode;
  /** The sentence under it, saying how one comes to exist. */
  note?: string;
  /** The way to make the first one, when the reader may. */
  action?: React.ReactNode;
  onRetry?: () => void;
  children: React.ReactNode;
}) {
  if (feed.loading) return <Settling />;

  /* **The rows stay.** A list that empties itself when the VPN drops reads as
     work being lost, so a server that is not answering keeps what was last
     known — visibly stale, and said so above it. */
  if (feed.trouble === "dark") {
    return (
      <>
        <WhereTo>
          <b>Can’t reach this Firetower.</b> Showing what was last known. Rows from a server that is
          not answering stay visible — a list that empties itself reads as work being lost.
        </WhereTo>
        {feed.data.length > 0 && <div className="stale2">{children}</div>}
      </>
    );
  }

  if (feed.error) {
    const [icon, title] = BLANK[feed.trouble === "denied" ? "denied" : "error"];
    return (
      <Blank
        icon={icon}
        title={title}
        action={
          feed.trouble === "denied" ? undefined : onRetry ? (
            <button onClick={onRetry} className="btn plain">
              <Icon of={RefreshCw} size={14} />
              Try again
            </button>
          ) : undefined
        }
      >
        {feed.trouble === "denied"
          ? "Ask an administrator of this Firetower. Nothing is hidden from you by this window — the server decides, and it said no."
          : `${feed.error} Nothing has been lost — this list is on the server, not in this window.`}
      </Blank>
    );
  }

  if (feed.data.length === 0) {
    if (typeof empty !== "string") return <>{empty}</>;
    return (
      <Blank icon={Shapes} title={empty} action={action}>
        {note}
      </Blank>
    );
  }
  return <>{children}</>;
}

/**
 * Rows the shape of the rows that are coming.
 *
 * A spinner says only that something is happening; this says *what* — five
 * rows at the height of a row, with a disc where the glyph goes and two bars
 * where the name and its sub-line go. The page stops moving when the answer
 * arrives rather than reflowing from a one-line "Reading it off the server…".
 */
function Settling() {
  return (
    <div className="lrows mt-5">
      {[70, 45, 60, 38, 55].map((w, i) => (
        <div key={i} className="r">
          <span className="settling h-6 w-6 !rounded-full" />
          <span className="tx">
            <span className="settling block h-2.5" style={{ width: `${w}%` }} />
            <span className="settling mt-1.5 block h-2" style={{ width: `${Math.round(w * 0.4)}%` }} />
          </span>
          <span className="settling h-2 w-[54px]" />
        </div>
      ))}
    </div>
  );
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
  trouble: bad,
  error,
  onRetry,
  settling,
  children,
}: {
  title: string;
  note?: string;
  action?: React.ReactNode;
  controls?: React.ReactNode;
  /**
   * The pane's own bad answer, when it has one.
   *
   * **It replaces the body.** A refusal wedged between a filter line and two
   * section headings reads as one list of several having a problem; what has
   * actually happened is that this screen cannot be drawn. The drawing does
   * the same thing — its `pg()` swaps the whole body out — and the controls
   * go with it, because narrowing a list nobody can read is not a thing to
   * offer.
   */
  trouble?: TroubleKind | null;
  error?: string | null;
  onRetry?: () => void;
  /** Nothing has arrived yet. The body is five rows the shape of the rows. */
  settling?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="pg">
      {/* **Above the head, and outside everything `trouble` swaps.** Settings
          has no rail icon to leave a pane by, so the one way between its five
          panes is in here — and a pane that cannot be read is the pane you
          most need to leave. It draws nothing outside Settings. */}
      <SettingsIndex />
      <div className="pg-head">
        <div>
          <h1>{title}</h1>
          {note && <p className="sub">{note}</p>}
        </div>
        {action && <div className="acts">{action}</div>}
      </div>
      {settling ? (
        <Settling />
      ) : bad ? (
        <Trouble kind={bad} error={error} onRetry={onRetry} />
      ) : (
        <>
          {controls && <div className="filterline">{controls}</div>}
          {children}
        </>
      )}
    </div>
  );
}

/** One of the three bad answers, drawn as the thing on the screen. */
export function Trouble({
  kind,
  error,
  onRetry,
}: {
  kind: Exclude<TroubleKind, never>;
  error?: string | null;
  onRetry?: () => void;
}) {
  if (kind === "dark") {
    return (
      <WhereTo>
        <b>Can’t reach this Firetower.</b> Showing what was last known. Rows from a server that is
        not answering stay visible — a list that empties itself reads as work being lost.
      </WhereTo>
    );
  }
  if (kind === "denied") {
    return (
      <Blank icon={Lock} title="You cannot see this">
        Ask an administrator of this Firetower. Nothing is hidden from you by this window — the
        server decides, and it said no.
      </Blank>
    );
  }
  return (
    <Blank
      icon={TriangleAlert}
      title="That did not load"
      action={
        onRetry ? (
          <button onClick={onRetry} className="btn plain">
            <Icon of={RefreshCw} size={14} />
            Try again
          </button>
        ) : undefined
      }
    >
      {error ? `${error} ` : ""}Nothing has been lost — this list is on the server, not in this
      window.
    </Blank>
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
export function WhereTo({
  children,
  icon,
  className,
}: {
  children: React.ReactNode;
  /* The drawing varies the glyph by what it is pointing at — people for the
     administration site, a key for the control plane. Info is the default
     because most of these are just "it lives over there". */
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `whereto ${className}` : "whereto"}>
      <span className="g">{icon ?? <Icon of={Info} size={16} />}</span>
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

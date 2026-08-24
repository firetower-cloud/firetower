"use client";

import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import Link from "next/link";
import { useGetSession, useRenameSession } from "@/src/api/generated/sessions/sessions";
import { useListEvents } from "@/src/api/generated/events/events";
import { useSessionWork } from "@/src/api/generated/sessions/sessions";
import type { CheckoutWork, Session } from "@/src/api/generated/model";
import { stepLines } from "@/components/Steps";
import { Signal } from "@/components/Signal";
import { Terminal } from "@/components/Terminal";
import { Chat } from "@/components/Chat";
import { Review } from "@/components/Review";
import { shipping, ready, done } from "@/src/api/ship";
import type { Ship } from "@/src/api/ship";
import { SessionMenu } from "@/components/SessionActions";
import { Diff } from "@/components/Diff";
import { AddRepo } from "@/components/AddRepo";
import { Files } from "@/components/Files";
import { elapsed, minutesSince, unfinished, STATUS_LABEL } from "@/src/api/view";
import { ApiError } from "@/src/api/http";

/**
 * A session, read from the API rather than a build-time list.
 *
 * Client-side on purpose: session ids don't exist when the interface is built,
 * so nothing here can be pre-rendered per session.
 */
type Tab = "Chat" | "Shell" | "Files" | "Changes";

/**
 * The id, taken from the address bar rather than from the router.
 *
 * The interface ships as a static export embedded in the control plane, and an
 * export has to know every path when it is built. Session ids do not exist
 * then, so this route is written once under the placeholder segment `_` and the
 * control plane serves that one shell for every session — see `web.rs`. Reading
 * the router's parameter would therefore answer with the placeholder rather
 * than the session actually being looked at, on the deployment that matters
 * most. The address bar is always right.
 */
/**
 * The one control for getting the work out.
 *
 * Disabled with a reason rather than hidden — "nothing changed yet" is
 * information, and a button that vanishes teaches somebody to go looking for
 * where it went.
 */
function Ship({
  session,
  work,
  onReview,
}: {
  session: Session;
  work?: CheckoutWork[];
  onReview: () => void;
}) {
  const ship = shipping(session, work);

  // The work is out and there is nothing left to press. This used to be the
  // primary button, reading "2 pull requests open" and opening the diff — a
  // control that named a state and did something else, and with two requests
  // open it could not even link to them.
  if (done(ship)) return <Opened ship={ship} onReview={onReview} />;

  const can = ready(ship);
  return (
    <button
      onClick={onReview}
      disabled={!can}
      title={ship.blocked ?? ship.label}
      className={`shrink-0 rounded-[9px] px-3 py-1.5 text-ui font-medium transition-colors ${
        can
          ? "bg-ember text-ground"
          : "border border-line text-mute"
      }`}
    >
      {ship.label}
    </button>
  );
}

/**
 * What a finished session offers: the request, and a way back to the diff.
 *
 * One repository links straight out. Several cannot — there is no single place
 * to go — so the chip lists them, which is the case that previously had a
 * button with nowhere to send you.
 */
function Opened({ ship, onReview }: { ship: Ship; onReview: () => void }) {
  const [listing, setListing] = useState(false);
  const one = ship.links.length === 1 ? ship.links[0] : undefined;

  const chip =
    "flex items-center gap-1.5 rounded-[9px] border border-sage/35 bg-sage/[0.07] px-2.5 py-1.5 text-ui font-medium text-sage transition-colors hover:bg-sage/[0.12]";

  return (
    <div className="relative flex shrink-0 items-center gap-2">
      {/* Getting back to the sheet is what the old button actually did, so it
          stays reachable — just not dressed as the main action. Not "Review
          changes": everything is committed and pushed by now, so the one thing
          it cannot promise is changes to look at. */}
      <button
        onClick={onReview}
        className="rounded-[9px] border border-line px-2.5 py-1.5 text-ui text-dim transition-colors hover:text-bone"
      >
        Details
      </button>

      {one ? (
        <a className={chip} href={one.url} target="_blank" rel="noreferrer">
          ✓ {ship.label} ↗
        </a>
      ) : (
        <button className={chip} onClick={() => setListing(!listing)}>
          ✓ {ship.label}
        </button>
      )}

      {listing && !one && (
        <div className="absolute top-full right-0 z-20 mt-1.5 min-w-[220px] rounded-[9px] border border-line bg-panel py-1 shadow-lg">
          {ship.links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              onClick={() => setListing(false)}
              className="flex items-center justify-between gap-3 px-3 py-2 font-mono text-[12px] text-dim transition-colors hover:bg-raise hover:text-bone"
            >
              {l.slug} <span className="text-mute">↗</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function useSessionId(): string {
  const pathname = usePathname();
  const last = pathname.split("/").filter(Boolean).pop() ?? "";
  return decodeURIComponent(last);
}

export default function SessionView() {
  const id = useSessionId();
  const [tab, setTab] = useState<Tab>("Chat");
  const [reviewing, setReviewing] = useState(false);
  /** Open while somebody is choosing another repository to check in. */
  const [adding, setAdding] = useState(false);
  /** The name being edited, when it is. Absent means it is not. */
  const [naming, setNaming] = useState<string | null>(null);
  /**
   * Set by Escape, read by the blur that follows it.
   *
   * Leaving a field keeps what is in it, so cancelling has to say so before it
   * lets go — otherwise the blur that Escape causes saves the thing Escape was
   * pressed to discard.
   */
  const dropping = useRef(false);

  // The stream is how this stays live, and it is fast. It is not, however,
  // something to bet the page on: a stream that silently stops leaves a session
  // frozen mid-build with no way to tell, which is exactly what it looked like.
  // So while a session is still going, ask as well. Once it is over, stop —
  // there is nothing left to learn.
  const {
    data: session,
    isLoading,
    error,
    refetch,
  } = useGetSession(id, {
    query: {
      refetchInterval: (query) =>
        query.state.data && unfinished(query.state.data) ? 2_000 : false,
    },
  });
  const rename = useRenameSession();

  const busy = !!session && unfinished(session);
  // What is in the workspace that is not safely elsewhere. Asked while the
  // session is running because it changes under you, and once afterwards.
  const { data: work } = useSessionWork(id, {
    query: { enabled: !!session?.repo, refetchInterval: busy ? 10_000 : false },
  });
  const { data: events = [] } = useListEvents(
    { since: 0, sessionId: id },
    { query: { refetchInterval: busy ? 1_500 : false } },
  );

  if (isLoading) {
    return <Frame><p className="text-[14px] text-mute">Looking…</p></Frame>;
  }

  if (error || !session) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <Frame>
        <h1 className="text-[21px] font-semibold text-bone">
          {missing ? "No such session." : "Couldn't load that session."}
        </h1>
        <p className="mt-2 max-w-[52ch] text-[15px] text-dim">
          {missing
            ? "It may have ended and been cleaned up — ending a session removes its workspace."
            : error instanceof ApiError
              ? error.message
              : "The control plane didn't answer."}
        </p>
        <Link href="/" className="mt-4 inline-block text-[14px] text-ember hover:underline">
          ← All sessions
        </Link>
      </Frame>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One thin bar. What a session is, and what you can do to it — nothing
          else. The old header spent four lines restating things that are
          either obvious from the conversation or one hover away, and pushed the
          thing somebody came to read below the fold. */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-3 lg:px-5">
        <Link
          href="/"
          aria-label="All sessions"
          className="shrink-0 rounded-[8px] px-2 py-1.5 text-[15px] text-mute transition-colors hover:bg-raise hover:text-text"
        >
          ←
        </Link>

        <Signal status={session.status} size={7} />

        {/* The name is edited where it sits. A prompt box is a modal for one
            short string: it covers the thing being renamed, and it cannot be
            corrected once dismissed. */}
        {naming === null ? (
          <button
            onClick={() => setNaming(session.name)}
            title="Rename"
            className="min-w-0 shrink truncate rounded-[8px] px-1 text-[15.5px] font-semibold tracking-[-0.01em] text-bone transition-colors hover:text-ember"
          >
            {session.name}
          </button>
        ) : (
          <input
            autoFocus
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                dropping.current = true;
                e.currentTarget.blur();
              }
            }}
            // Clicking away keeps it, which is what happens to a field you have
            // finished with. Escape is the way to change your mind.
            onBlur={() => {
              const next = naming.trim();
              const dropped = dropping.current;
              dropping.current = false;
              setNaming(null);
              if (dropped || !next || next === session.name) return;
              rename.mutate(
                { id: session.id, data: { name: next } },
                { onSuccess: () => refetch() },
              );
            }}
            style={{ width: `${Math.min(Math.max(naming.length, 10) + 2, 40)}ch` }}
            className="min-w-0 shrink rounded-[8px] border border-ember-deep bg-raise px-1.5 py-0.5 text-[15.5px] font-semibold tracking-[-0.01em] text-bone focus:border-ember focus:outline-none"
          />
        )}

        <span className="ml-auto hidden shrink-0 font-mono text-meta text-mute sm:inline">
          {elapsed(minutesSince(session.createdAt))}
        </span>
        <span className="shrink-0 rounded-[7px] border border-line px-2 py-1 font-mono text-[11px] text-slate">
          {STATUS_LABEL[session.status] ?? session.status}
        </span>

        {/* One control, saying the next honest thing. A session is always at
            exactly one point on the way out, so offering every verb and letting
            somebody work out which applies is work the screen can do. */}
        {session.repo && <Ship session={session} work={work} onReview={() => setReviewing(true)} />}

        <SessionMenu session={session} work={work} />
      </header>

      {reviewing && (
        <Review session={session} work={work} onClose={() => setReviewing(false)} />
      )}

      {adding && (
        <AddRepo session={session} onClose={() => setAdding(false)} onAdded={() => refetch()} />
      )}

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-4 py-4 lg:px-6 lg:py-5">
        <div className="mb-4 flex gap-1">
          {(["Chat", "Shell", "Files", "Changes"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-[8px] px-3 py-1.5 text-ui transition-colors ${
                tab === t ? "bg-raise text-bone" : "text-mute hover:text-text"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Chat and Changes stay mounted: switching tabs should not drop the
            conversation stream and repaint the whole session. */}
        <div className="min-h-0 flex-1">
          <div className={`h-full ${tab === "Chat" ? "" : "hidden"}`}>
            <Chat
              sessionId={session.id}
              live={busy}
              branch={session.branch}
              repo={session.repo}
              checkouts={session.checkouts}
              onAddRepo={busy ? () => setAdding(true) : undefined}
              steps={stepLines(session, events)}
            />
          </div>
          {/* Mounted only while you are looking at it: a shell lives for the
              length of a visit, and opening this tab is what starts one. */}
          {tab === "Shell" && (
            <div className="h-full">
              <Terminal sessionId={session.id} live={busy} showing />
            </div>
          )}
          {tab === "Files" && (
            <div className="h-full">
              <Files sessionId={session.id} />
            </div>
          )}
          <div className={`h-full ${tab === "Changes" ? "" : "hidden"}`}>
            <Diff sessionId={session.id} />
          </div>
        </div>
      </section>

    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="max-w-[900px] px-8 pt-8">{children}</div>;
}

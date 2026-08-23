"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { useGetSession, useRenameSession } from "@/src/api/generated/sessions/sessions";
import { useListEvents } from "@/src/api/generated/events/events";
import { useSessionWork } from "@/src/api/generated/sessions/sessions";
import type { Session, WorkSummary } from "@/src/api/generated/model";
import { stepLines } from "@/components/Steps";
import { Signal } from "@/components/Signal";
import { Terminal } from "@/components/Terminal";
import { Chat } from "@/components/Chat";
import { Review } from "@/components/Review";
import { shipping, ready } from "@/src/api/ship";
import { SessionMenu } from "@/components/SessionActions";
import { Diff } from "@/components/Diff";
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
  work?: WorkSummary;
  onReview: () => void;
}) {
  const ship = shipping(session, work);
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

function useSessionId(): string {
  const pathname = usePathname();
  const last = pathname.split("/").filter(Boolean).pop() ?? "";
  return decodeURIComponent(last);
}

export default function SessionView() {
  const id = useSessionId();
  const [tab, setTab] = useState<Tab>("Chat");
  const [reviewing, setReviewing] = useState(false);

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

        <button
          onClick={() => {
            const next = window.prompt(`Call ${session.name} what?`, session.name);
            if (!next || next.trim() === session.name) return;
            rename.mutate(
              { id: session.id, data: { name: next.trim() } },
              { onSuccess: () => refetch() },
            );
          }}
          title="Rename"
          className="min-w-0 shrink truncate rounded-[8px] px-1 text-[15.5px] font-semibold tracking-[-0.01em] text-bone transition-colors hover:text-ember"
        >
          {session.name}
        </button>

        {session.repo && (
          <span className="hidden shrink-0 rounded-[7px] border border-line px-2 py-1 font-mono text-meta text-dim sm:inline">
            {session.repo}
          </span>
        )}
        {session.branch && (
          <span className="hidden min-w-0 shrink truncate font-mono text-meta text-mute md:inline">
            ⑂ {session.branch}
          </span>
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

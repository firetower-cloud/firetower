"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSession,
  useRenameSession,
  useSessionWork,
  getListSessionsQueryKey,
} from "@/src/api/generated/sessions/sessions";
import { useListEvents } from "@/src/api/generated/events/events";
import { Chat } from "@/components/Chat";
import { Terminal } from "@/components/Terminal";
import { Review } from "@/components/Review";
import { AddRepo } from "@/components/AddRepo";
import { SessionMenu } from "@/components/SessionActions";
import { stepLines } from "@/components/Steps";
import { Signal } from "@/components/Signal";
import { shipping, ready, done } from "@/src/api/ship";
import { answerable, elapsed, minutesSince, unfinished, STATUS_LABEL } from "@/src/api/view";
import { ApiError } from "@/src/api/http";
import { useTabs, type SessionFace } from "@/src/workspace/tabs";

/**
 * One session, as a tab.
 *
 * The same conversation the session page used to hold, with the page's header
 * traded for a thin bar: the name, what it is doing, and the one control that
 * gets the work out. Everything the old header restated — the repository, the
 * branch, the host — is either in the rail beside it or in the panel to the
 * right, and repeating it cost the fold.
 *
 * `Agent` and `Shell` are two faces of one tab rather than two tabs. They are
 * the same workspace looked at two ways, and a tab strip that listed both for
 * every session would be twice as long for no new information.
 */
export function SessionTab({
  sessionId,
  face,
  showing,
}: {
  sessionId: string;
  face: SessionFace;
  /**
   * Whether this tab is the one on screen.
   *
   * Tabs stay mounted behind each other so switching does not drop a
   * conversation stream and repaint everything — so being mounted is not the
   * same question as being visible, and the terminal needs the second one to
   * decide where keystrokes should go.
   */
  showing: boolean;
}) {
  const { face: setFace } = useTabs();
  const [reviewing, setReviewing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  /** Set by Escape, read by the blur that follows it. */
  const dropping = useRef(false);

  const {
    data: session,
    isLoading,
    error,
    refetch,
  } = useGetSession(sessionId, {
    query: {
      refetchInterval: (query) => (query.state.data && unfinished(query.state.data) ? 2_000 : false),
    },
  });
  const rename = useRenameSession();
  const cache = useQueryClient();

  const busy = !!session && unfinished(session);
  const live = !!session && answerable(session);

  const { data: work } = useSessionWork(sessionId, {
    query: { enabled: !!session?.repo, refetchInterval: busy ? 10_000 : false },
  });
  const { data: events = [] } = useListEvents(
    { since: 0, sessionId },
    { query: { refetchInterval: busy ? 1_500 : false } },
  );

  if (isLoading) {
    return <Middle>Looking…</Middle>;
  }

  if (error || !session) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <Middle>
        {missing
          ? "That session has ended — ending one removes its workspace."
          : error instanceof ApiError
            ? error.message
            : "The control plane didn't answer."}
      </Middle>
    );
  }

  const ship = session.repo ? shipping(session, work) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="@container flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-3">
        <Signal status={session.status} size={7} />

        {naming === null ? (
          <button
            onClick={() => setNaming(session.name)}
            title="Rename"
            className="min-w-[7ch] shrink truncate rounded-[6px] px-1 text-[14px] font-semibold tracking-[-0.01em] text-bone transition-colors hover:text-ember"
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
            onBlur={() => {
              const next = naming.trim();
              const dropped = dropping.current;
              dropping.current = false;
              setNaming(null);
              if (dropped || !next || next === session.name) return;
              rename.mutate(
                { id: session.id, data: { name: next } },
                {
                  onSuccess: () => {
                    refetch();
                    cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
                  },
                },
              );
            }}
            style={{ width: `${Math.min(Math.max(naming.length, 10) + 2, 36)}ch` }}
            className="min-w-0 shrink rounded-[6px] border border-ember-deep bg-raise px-1.5 py-0.5 text-[14px] font-semibold text-bone focus:border-ember focus:outline-none"
          />
        )}

        {/* Two faces of one workspace. */}
        <div className="ml-1 flex shrink-0 items-center gap-px rounded-[7px] border border-line p-px">
          {(["agent", "shell"] as SessionFace[]).map((f) => (
            <button
              key={f}
              onClick={() => setFace(`session:${sessionId}`, f)}
              className={`rounded-[5px] px-2 py-[3px] text-[11px] capitalize transition-colors ${
                face === f ? "bg-raise text-bone" : "text-mute hover:text-text"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* An explicit spacer rather than `ml-auto` on the first optional
            thing: those are hidden on a narrow pane, and a hidden element
            takes its margin out of the layout with it — which let the whole
            right-hand group drift back to the middle. */}
        <span className="ml-auto" />
        <span className="hidden shrink-0 font-mono text-[11px] text-mute @[26rem]:inline">
          {elapsed(minutesSince(session.createdAt))}
        </span>
        <span className="hidden shrink-0 rounded-[6px] border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-slate @[34rem]:inline">
          {STATUS_LABEL[session.status] ?? session.status}
        </span>

        {ship && (
          <button
            onClick={() => setReviewing(true)}
            disabled={!ready(ship) && !done(ship)}
            title={ship.blocked ?? ship.label}
            className={`shrink-0 rounded-[7px] px-2.5 py-1 text-[12px] font-medium transition-colors ${
              done(ship)
                ? "border border-sage/35 bg-sage/[0.07] text-sage"
                : ready(ship)
                  ? "bg-ember text-ground"
                  : "border border-line text-mute"
            }`}
          >
            {done(ship) ? `✓ ${ship.label}` : ship.label}
          </button>
        )}

        <SessionMenu session={session} work={work} />
      </header>

      {reviewing && <Review session={session} work={work} onClose={() => setReviewing(false)} />}
      {adding && (
        <AddRepo session={session} onClose={() => setAdding(false)} onAdded={() => refetch()} />
      )}

      {/* Both stay mounted: the conversation holds a stream, and the terminal
          holds a socket. Toggling the face should not tear either down. */}
      <div className="min-h-0 flex-1">
        <div className={`h-full ${face === "agent" ? "" : "hidden"}`}>
          <Chat
            sessionId={session.id}
            live={live}
            branch={session.branch}
            repo={session.repo}
            checkouts={session.checkouts}
            onAddRepo={busy ? () => setAdding(true) : undefined}
            steps={stepLines(session, events)}
          />
        </div>
        {/* Started by looking at it: a shell lives for the length of a visit. */}
        {face === "shell" && (
          <div className="h-full p-2">
            <Terminal sessionId={session.id} live={busy} showing={showing} />
          </div>
        )}
      </div>
    </div>
  );
}

function Middle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-8">
      <p className="max-w-[46ch] text-center text-[13.5px] text-mute">{children}</p>
    </div>
  );
}

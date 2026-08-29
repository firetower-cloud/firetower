"use client";

import { useState } from "react";
import { useGetSession } from "@/src/api/generated/sessions/sessions";
import { useListEvents } from "@/src/api/generated/events/events";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import { useSessionControls } from "@/src/api/generated/conversation/conversation";
import { Chat } from "@/components/Chat";
import { AddRepo } from "@/components/AddRepo";
import { stepLines } from "@/components/Steps";
import { AgentMark, AGENT_LABEL } from "@/components/AgentMark";
import { answerable, unfinished } from "@/src/api/view";
import { ApiError } from "@/src/api/http";
import type { Session } from "@/src/api/generated/model";

/**
 * The conversation, and nothing above it.
 *
 * There used to be a bar between the tab strip and the run: a status light, the
 * name, an Agent/Shell toggle, the elapsed time, a status chip, a Ship button
 * and a menu. Every one of those said something that is already on screen — the
 * rail names the session and shows its state, the plate below names the agent
 * and the model, and the panel on the right holds the way out and a live line
 * saying what it is doing. It was a row of chrome restating the room, and it
 * cost the top of the fold.
 *
 * So it is gone. Rename and End moved to the session's row in the rail, where
 * the thing they act on is; the shell became a tab of its own.
 */
export function SessionTab({ sessionId }: { sessionId: string }) {
  const [adding, setAdding] = useState(false);

  const {
    data: session,
    isLoading,
    error,
    refetch,
  } = useGetSession(sessionId);

  const busy = !!session && unfinished(session);
  const live = !!session && answerable(session);

  const { data: events = [] } = useListEvents({ since: 0, sessionId });

  if (isLoading) return <Middle>Looking…</Middle>;

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

  return (
    <div className="h-full min-h-0">
      {adding && (
        <AddRepo session={session} onClose={() => setAdding(false)} onAdded={() => refetch()} />
      )}

      <Chat
        sessionId={session.id}
        live={live}
        branch={session.branch}
        repo={session.repo}
        checkouts={session.checkouts}
        onAddRepo={busy ? () => setAdding(true) : undefined}
        steps={stepLines(session, events)}
        head={<Plate session={session} />}
      />
    </div>
  );
}

/**
 * What is running, above the run.
 *
 * The four questions somebody arrives with — which agent, which model, which
 * branch, which machine — on three lines, inside the scroller so they go away
 * once you are reading. With the header gone this is the only place that says
 * them, which is what it was always meant to be.
 */
function Plate({ session }: { session: Session }) {
  const { data: hosts = [] } = useListHosts();
  const { data: controls = [] } = useSessionControls(session.id, {
    query: { staleTime: 30_000 },
  });

  const host = hosts.find((h) => h.id === session.hostId)?.name;
  // Only what the agent has said is actually in force. A control also carries a
  // `fallback`, but that is the picker's *label* — "Model" — for the case where
  // nothing is known yet, and printing it here read as though the session were
  // running a model called Model.
  const running = controls.find((c) => c.kind === "model")?.current ?? undefined;

  const checkouts = session.checkouts ?? [];

  return (
    <div className="mb-4 flex items-start gap-3 border-b border-line-soft pb-4">
      <span className="mt-0.5 shrink-0 text-mute">
        <AgentMark agent={session.agent} size={18} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[13.5px] font-medium text-bone">{AGENT_LABEL[session.agent]}</span>
          {running && <span className="font-mono text-[11.5px] text-slate">· {running}</span>}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] text-mute">
          {checkouts.length === 0 && <span>no repository</span>}
          {checkouts.map((c) => (
            <span key={c.slug} className="flex items-center gap-1.5">
              <span className="text-dim">{c.slug}</span>
              {c.branch && (
                <>
                  <span className="text-mute/60">on</span>
                  <span className="text-dim">{c.branch}</span>
                </>
              )}
            </span>
          ))}
          {host && (
            <span className="flex items-center gap-1.5">
              <span className="text-mute/60">·</span>
              {host}
            </span>
          )}
        </div>
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

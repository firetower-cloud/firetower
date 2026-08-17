"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { useGetSession } from "@/src/api/generated/sessions/sessions";
import { useListEvents } from "@/src/api/generated/events/events";
import { Steps, STEP_EVENTS } from "@/components/Steps";
import { Signal } from "@/components/Signal";
import { Terminal } from "@/components/Terminal";
import { SessionActions } from "@/components/SessionActions";
import { Diff } from "@/components/Diff";
import { elapsed, minutesSince, unfinished, STATUS_LABEL } from "@/src/api/view";
import { ApiError } from "@/src/api/http";

/**
 * A session, read from the API rather than a build-time list.
 *
 * Client-side on purpose: session ids don't exist when the interface is built,
 * so nothing here can be pre-rendered per session.
 */
type Tab = "Terminal" | "Changes";

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
function useSessionId(): string {
  const pathname = usePathname();
  const last = pathname.split("/").filter(Boolean).pop() ?? "";
  return decodeURIComponent(last);
}

export default function SessionView() {
  const id = useSessionId();
  const [tab, setTab] = useState<Tab>("Terminal");

  // The stream is how this stays live, and it is fast. It is not, however,
  // something to bet the page on: a stream that silently stops leaves a session
  // frozen mid-build with no way to tell, which is exactly what it looked like.
  // So while a session is still going, ask as well. Once it is over, stop —
  // there is nothing left to learn.
  const { data: session, isLoading, error } = useGetSession(id, {
    query: {
      refetchInterval: (query) =>
        query.state.data && unfinished(query.state.data) ? 2_000 : false,
    },
  });

  const busy = !!session && unfinished(session);
  const { data: events = [] } = useListEvents(
    { since: 0, sessionId: id },
    { query: { refetchInterval: busy ? 1_500 : false } },
  );

  if (isLoading) {
    return <Frame><p className="text-[13px] text-mute">Looking…</p></Frame>;
  }

  if (error || !session) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <Frame>
        <h1 className="text-[20px] font-semibold text-bone">
          {missing ? "No such session." : "Couldn't load that session."}
        </h1>
        <p className="mt-2 max-w-[52ch] text-[13.5px] text-dim">
          {missing
            ? "It may have ended and been cleaned up — ending a session removes its workspace."
            : error instanceof ApiError
              ? error.message
              : "The control plane didn't answer."}
        </p>
        <Link href="/" className="mt-4 inline-block text-[13px] text-ember hover:underline">
          ← All sessions
        </Link>
      </Frame>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b border-line px-8 pt-6 pb-4">
        <Link href="/" className="text-[12px] text-mute transition-colors hover:text-text">
          ← All sessions
        </Link>

        <div className="mt-2 flex items-center gap-3">
          <Signal status={session.status} size={8} />
          <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-bone">
            {session.title}
          </h1>
          <span className="rounded-[4px] border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-slate">
            {STATUS_LABEL[session.status] ?? session.status}
          </span>
          <span className="ml-auto font-mono text-[11px] text-mute">
            {elapsed(minutesSince(session.createdAt))}
          </span>
        </div>

        <div className="mt-2 flex items-center gap-4 font-mono text-[11.5px] text-mute">
          <span>{session.repo}</span>
          <span>⑂ {session.branch}</span>
          <span>{session.agent}</span>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_320px]">
        <section className="flex min-w-0 flex-col overflow-hidden border-r border-line p-6">
          <div className="mb-3 flex gap-1">
            {(["Terminal", "Changes"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-[5px] px-2.5 py-1 text-[12px] transition-colors ${
                  tab === t ? "bg-raise text-bone" : "text-mute hover:text-text"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Both stay mounted: switching tabs shouldn't drop the terminal
              connection and lose everything on screen. */}
          <div className="min-h-0 flex-1">
            <div className={`h-full ${tab === "Terminal" ? "" : "hidden"}`}>
              <Terminal sessionId={session.id} live={busy} />
            </div>
            <div className={`h-full ${tab === "Changes" ? "" : "hidden"}`}>
              <Diff sessionId={session.id} />
            </div>
          </div>
        </section>

        <aside className="min-h-0 overflow-y-auto p-5">
          <SessionActions session={session} />

          <div className="eyebrow mt-5 mb-3">Bringing it up</div>
          <Steps session={session} events={events} />

          <div className="eyebrow mt-5 mb-3">Activity</div>
          <ol className="flex flex-col gap-2.5">
            {/* What the checklist above already says, without saying it twice. */}
            {events
              .filter((e) => !STEP_EVENTS.has((e.kind as { type?: string }).type ?? ""))
              .map((e) => (
              <li key={e.seq} className="flex gap-2.5">
                <span className="mt-[6px] h-[3px] w-[3px] shrink-0 rounded-full bg-mute" />
                <span className="min-w-0">
                  <span className="block text-[12.5px] text-dim">{label(e.kind)}</span>
                  <span className="block truncate font-mono text-[11px] text-mute">
                    {detail(e.kind)}
                  </span>
                </span>
              </li>
            ))}
            {events.length === 0 && (
              <li className="text-[12px] text-mute">Waiting for the host to answer.</li>
            )}
          </ol>
        </aside>
      </div>
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="max-w-[900px] px-8 pt-8">{children}</div>;
}

/* The wire tags each event with its variant name; these turn that into prose. */
const LABELS: Record<string, string> = {
  SessionCreated: "Session created",
  HostSelected: "Picked a host",
  RepoFetched: "Fetched the repository",
  WorktreeAdded: "Added a worktree",
  WorkspaceStarted: "Started the workspace",
  SetupFinished: "Ran the setup script",
  TmuxOpened: "Opened tmux",
  AgentLaunched: "Launched the agent",
  StatusChanged: "Status",
  Failed: "Failed",
};

type EventKind = Record<string, unknown> & { type?: string };

function label(kind: EventKind) {
  return LABELS[kind.type ?? ""] ?? (kind.type ?? "Event");
}

/** Whichever field this variant carries — they never carry two. */
function detail(kind: EventKind) {
  for (const key of ["detail", "branch", "name", "status", "message", "prompt"]) {
    const value = kind[key];
    if (typeof value === "string") return value;
  }
  return "";
}

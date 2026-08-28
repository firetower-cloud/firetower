"use client";

import { useEffect, useState } from "react";
import { useListSessions } from "@/src/api/generated/sessions/sessions";
import { apiBase } from "@/src/api/http";
import { Composer } from "@/components/Composer";
import { Modal } from "@/components/Modal";
import { Rail } from "./Rail";
import { TabBar } from "./TabBar";
import { Inspector } from "./Inspector";
import { SessionTab } from "./SessionTab";
import { FileTab } from "./FileTab";
import { DiffTab } from "./DiffTab";
import {
  Tabs,
  paneTabs,
  useFocusedSession,
  useOpen,
  useTabs,
  type PaneIndex,
  type Tab,
} from "@/src/workspace/tabs";
import { useWorkbenchKeys } from "@/src/workspace/keys";

/**
 * The whole interface: sessions on the left, what you are reading in the
 * middle, the workspace on the right.
 *
 * It replaces a design that was one session per page. That shape came from
 * thinking of a session as a document you visit; what it is actually like to
 * use Firetower is watching several at once and dipping into whichever one
 * stopped — which is a workbench, not a series of pages.
 */
export function Workspace({ initialSession }: { initialSession?: string }) {
  return (
    <Tabs>
      <Bench initialSession={initialSession} />
    </Tabs>
  );
}

function Bench({ initialSession }: { initialSession?: string }) {
  const { state } = useTabs();
  const open = useOpen();
  const focused = useFocusedSession();
  /** The repository the composer should start on, when it was opened from one. */
  const [starting, setStarting] = useState<{ repo?: string } | null>(null);
  // The same query the rail runs, so this costs nothing — but it is the only
  // place that can say the whole thing is unreachable rather than empty.
  const { isError } = useListSessions();

  useWorkbenchKeys();

  // A link straight to a session — a notification, a bookmark, another tab —
  // opens it here rather than anywhere else. Once. Closing it afterwards has
  // to stick, so this does not re-run on every render of the same address.
  useEffect(() => {
    if (initialSession) open.session(initialSession);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSession]);

  // Keep the address bar honest about what is on top, so a reload comes back to
  // the same session and the link is worth copying. `replaceState` rather than
  // the router: this is not navigation, and every tab click should not add a
  // history entry to press Back through.
  useEffect(() => {
    const top = state.tabs.find((t) => t.id === state.active[state.focused]);
    const path = top ? `/sessions/${top.sessionId}` : "/";
    if (window.location.pathname !== path) window.history.replaceState(null, "", path);
  }, [state]);

  if (isError) return <Unreachable />;

  return (
    <div className="flex h-dvh overflow-hidden">
      <Rail onNew={(repo) => setStarting({ repo })} />

      <main className="flex min-w-0 flex-1">
        <Pane index={0} />
        {state.split && (
          <>
            <div className="w-px shrink-0 bg-line" />
            <Pane index={1} />
          </>
        )}
      </main>

      <Inspector sessionId={focused} />

      {starting && (
        <Modal onClose={() => setStarting(null)} title="New session" wide>
          <div className="p-4">
            <Composer
              startWith={starting.repo}
              onStarted={(id) => {
                setStarting(null);
                open.session(id);
              }}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}

function Pane({ index }: { index: PaneIndex }) {
  const { state, focusPane } = useTabs();
  const tabs = paneTabs(state, index);
  const active = state.active[index];

  return (
    <section
      onMouseDownCapture={() => focusPane(index)}
      className="flex min-w-0 flex-1 flex-col overflow-hidden"
    >
      <TabBar pane={index} />

      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <Blank />
        ) : (
          // Every tab in the pane stays mounted, hidden behind the one on top.
          // A conversation holds an event stream and a terminal holds a socket;
          // unmounting to switch tabs would drop both and repaint on the way
          // back, which is the difference between tabs and navigation.
          tabs.map((tab) => (
            <div
              key={tab.id}
              className={`absolute inset-0 ${tab.id === active ? "" : "hidden"}`}
            >
              <Content tab={tab} showing={tab.id === active} />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function Content({ tab, showing }: { tab: Tab; showing: boolean }) {
  switch (tab.kind) {
    case "session":
      return <SessionTab sessionId={tab.sessionId} face={tab.face} showing={showing} />;
    case "file":
      return <FileTab sessionId={tab.sessionId} path={tab.path} />;
    case "diff":
      return <DiffTab sessionId={tab.sessionId} path={tab.path} />;
  }
}

/**
 * Nothing answered.
 *
 * Kept as a whole screen rather than an empty rail: "no sessions" and "no
 * control plane" look identical otherwise, and the second one has an answer
 * somebody can act on.
 */
function Unreachable() {
  return (
    <div className="flex h-dvh items-center justify-center px-8">
      <div className="max-w-[52ch]">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-bone">
          Can&apos;t reach the control plane.
        </h1>
        <p className="mt-2 text-[14px] text-dim">
          Nothing useful came back from{" "}
          <code className="font-mono text-[12.5px] text-slate">{apiBase()}</code>.
        </p>
        <ul className="mt-3 list-disc pl-5 text-[13.5px] leading-[1.7] text-mute">
          <li>
            If that address is this page&apos;s own, the interface is asking itself. Start both
            halves with <code className="font-mono text-[12px] text-slate">just dev</code>.
          </li>
          <li>
            If it&apos;s the control plane&apos;s address, check it is running:{" "}
            <code className="font-mono text-[12px] text-slate">cargo run</code>.
          </li>
        </ul>
      </div>
    </div>
  );
}

function Blank() {
  return (
    <div className="flex h-full items-center justify-center px-8">
      <p className="max-w-[40ch] text-center text-[13px] text-mute">
        Pick a session on the left, or start one.
      </p>
    </div>
  );
}

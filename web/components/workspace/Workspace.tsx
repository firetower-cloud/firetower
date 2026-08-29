"use client";

import { useRouter } from "next/navigation";

import { useEffect, useRef, useState } from "react";
import { useListSessions } from "@/src/api/generated/sessions/sessions";
import { apiBase } from "@/src/api/http";
import { NewWorkspace } from "@/components/NewWorkspace";
import { Modal } from "@/components/Modal";
import { Terminal } from "@/components/Terminal";
import { Rail } from "./Rail";
import { TabBar } from "./TabBar";
import { Inspector } from "./Inspector";
import { SessionTab } from "./SessionTab";
import { FileTab } from "./FileTab";
import { DiffTab } from "./DiffTab";
import {
  Tabs,
  paneTabs,
  useCurrentSession,
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
 *
 * A session is a worktree, so it owns its tabs. Picking one in the rail changes
 * which workspace you are in rather than adding to a pile.
 */
export function Workspace({ initialSession }: { initialSession?: string }) {
  return (
    <Tabs>
      <Bench initialSession={initialSession} />
    </Tabs>
  );
}

function Bench({ initialSession }: { initialSession?: string }) {
  const router = useRouter();
  const { enter } = useTabs();
  const current = useCurrentSession();
  /** The repository the composer should start on, when it was opened from one. */
  const [starting, setStarting] = useState<{ repo?: string } | null>(null);
  // The same query the rail runs, so this costs nothing — but it is the only
  // place that can say the whole thing is unreachable rather than empty.
  const { isError } = useListSessions();

  useWorkbenchKeys();

  // A link straight to a session — a notification, a bookmark, another tab —
  // goes there rather than anywhere else. Once. Leaving afterwards has to
  // stick, so this does not re-run on every render of the same address.
  useEffect(() => {
    if (initialSession) enter(initialSession);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSession]);

  // Keep the address bar honest about which session you are in, so a reload
  // comes back to it and the link is worth copying. `replaceState` rather than
  // the router: this is not navigation, and moving between sessions should not
  // add a history entry to press Back through.
  //
  // Leaving the last one is different. `/` is a page of its own now — the
  // overview — so being in no workspace has somewhere to be, and rewriting the
  // address to it without navigating would leave a workspace screen with no
  // workspace in it, which is the emptiness the overview exists to replace.
  // Only once a workspace has actually been entered. On the first render of
  // this screen `current` is still null — entering happens in the effect above,
  // and this one runs in the same pass — so redirecting on "no workspace" alone
  // sent every click from the overview straight back to it.
  const entered = useRef(false);

  useEffect(() => {
    if (current) {
      entered.current = true;
      const path = `/sessions/${current}`;
      if (window.location.pathname !== path) window.history.replaceState(null, "", path);
      return;
    }
    if (entered.current) router.replace("/");
  }, [current, router]);

  if (isError) return <Unreachable />;

  return (
    <div className="flex h-dvh overflow-hidden">
      <Rail onNew={(repo) => setStarting({ repo })} />

      <main className="flex min-w-0 flex-1">
        <Pane index={0} />
        <SecondPane />
      </main>

      <Inspector sessionId={current} />

      {starting && (
        <Modal onClose={() => setStarting(null)} title="New workspace" wide>
          <NewWorkspace
            startWith={starting.repo}
            onCreated={(id) => {
              setStarting(null);
              enter(id);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/** The other half of a split, when there is one. */
function SecondPane() {
  const { set } = useTabs();
  if (!set?.split) return null;
  return (
    <>
      <div className="w-px shrink-0 bg-line" />
      <Pane index={1} />
    </>
  );
}

function Pane({ index }: { index: PaneIndex }) {
  const { set, focusPane } = useTabs();
  const current = useCurrentSession();
  const tabs = paneTabs(set, index);
  const active = set?.active[index] ?? null;

  if (!current) {
    return (
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Blank />
      </section>
    );
  }

  return (
    <section
      onMouseDownCapture={() => focusPane(index)}
      className="flex min-w-0 flex-1 flex-col overflow-hidden"
    >
      <TabBar pane={index} />

      <div className="relative min-h-0 flex-1">
        {/* Every tab stays mounted, hidden behind the one on top. A
            conversation holds an event stream and a terminal holds a socket;
            unmounting to switch tabs would drop both and repaint on the way
            back, which is the difference between tabs and navigation.

            Keyed by session as well as tab, so moving to another session tears
            these down rather than pointing them at the wrong workspace. */}
        {tabs.map((tab) => (
          <div
            key={`${current}:${tab.id}`}
            className={`absolute inset-0 ${tab.id === active ? "" : "hidden"}`}
          >
            <Content sessionId={current} tab={tab} showing={tab.id === active} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Content({
  sessionId,
  tab,
  showing,
}: {
  sessionId: string;
  tab: Tab;
  showing: boolean;
}) {
  switch (tab.kind) {
    case "agent":
      return <SessionTab sessionId={sessionId} />;
    // Another agent in this workspace: its own conversation, its own session.
    case "run":
      return <SessionTab sessionId={tab.sessionId} />;
    case "terminal":
      // No wrapper and no padding: the terminal is the pane.
      return <Terminal sessionId={sessionId} live showing={showing} />;
    case "file":
      return <FileTab sessionId={sessionId} path={tab.path} />;
    case "diff":
      return <DiffTab sessionId={sessionId} path={tab.path} />;
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

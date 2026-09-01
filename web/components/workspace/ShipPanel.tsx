"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSession,
  useSessionWork,
  useSessionDiff,
  usePushSession,
  getSessionWorkQueryKey,
  getGetSessionQueryKey,
} from "@/src/api/generated/sessions/sessions";
import { useGetTask } from "@/src/api/generated/tasks/tasks";
import { shipping, sequence, done, awaiting } from "@/src/api/ship";
import { ApiError } from "@/src/api/http";
import { useOpen } from "@/src/workspace/tabs";
import { PathRow, Counts, Fold } from "./PathRow";
import { ShipSheet } from "./ShipSheet";

/**
 * Everything between "it finished" and "it is on the git host".
 *
 * This was a modal. The modal held the message, the file list, the decision and
 * a diff pane — all of it correct, and all of it drawn *over the conversation
 * that produced the change*, which is the one thing you want beside you while
 * reviewing.
 *
 * In the panel it keeps the file list and gives up the diff pane: clicking a
 * file opens a diff **tab**, at full width, in the middle. A modal could never
 * do that, and it is the reason this is worth being a panel rather than a
 * restyled sheet.
 *
 * ## Why the words moved back out
 *
 * The title and the body did go back to a modal — [`ShipSheet`] — and the
 * distinction is what each half is for. Reviewing is continuous: you read a
 * file, look at the conversation, untick a lockfile, read another. Describing
 * is one decision, made once, and it wants the title, the body, the issues and
 * the sequence visible at the same time, which 320px of rail cannot do.
 *
 * So the panel is the review surface and the sheet is the decision. Nothing is
 * in both: the sheet has no file list, and this has no text boxes.
 *
 * There is no staging. An editor has Stage All because a person stages; here
 * the agent did the work and `shipping()` already reduces the whole state to
 * one next step. A staging area would be a concept added to look like an IDE.
 */
export function ShipPanel({ sessionId }: { sessionId: string }) {
  const cache = useQueryClient();
  const openTab = useOpen();

  const { data: session } = useGetSession(sessionId);
  // While a request is open this is also what asks the git host whether it has
  // been merged, so it keeps its own pace: 10s while somebody is waiting on a
  // review, and nothing once every request is settled — merged does not go
  // back to open, and this unmounts with the page.
  const { data: work } = useSessionWork(sessionId, {
    query: {
      enabled: !!session?.repo,
      refetchInterval: (query) => {
        const latest = query.state.data;
        if (!session || !latest) return 10_000;
        // Matched to the server's own throttle: asking faster than it will
        // answer only spends requests on the reply it already gave.
        return awaiting(shipping(session, latest)) ? 5_000 : 30_000;
      },
    },
  });
  const { data: files = [], isLoading } = useSessionDiff(sessionId, undefined, {
    query: { refetchInterval: 8_000 },
  });

  const push = usePushSession();

  /** Files left out. Everything is in by default — that is what finishing means. */
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [trouble, setTrouble] = useState<string | null>(null);
  const [listing, setListing] = useState(true);
  const [deciding, setDeciding] = useState(false);

  const keeping = files.filter((f) => !dropped.has(f.path));
  const totals = useMemo(
    () => ({
      added: keeping.reduce((n, f) => n + f.added, 0),
      removed: keeping.reduce((n, f) => n + f.removed, 0),
    }),
    [keeping],
  );

  if (!session) {
    return <Note>Looking…</Note>;
  }

  const ship = shipping(session, work);

  const refresh = () => {
    cache.invalidateQueries({ queryKey: getSessionWorkQueryKey(sessionId) });
    cache.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
  };

  /**
   * Whether pressing will end with a pull request being created.
   *
   * `open-behind` pushes onto a branch whose request is already open, which
   * amends it — so there is no title, no body and nothing to decide. That one
   * stays a single press here rather than opening a sheet that would ask for
   * words nobody can use.
   */
  const opening =
    ship.stage === "uncommitted" || ship.stage === "unpushed" || ship.stage === "pushed";

  const amend = async () => {
    setTrouble(null);
    try {
      await push.mutateAsync({ id: sessionId });
      refresh();
    } catch (e) {
      setTrouble(e instanceof ApiError ? e.message : "That didn't work.");
      refresh();
    }
  };

  if (!session.repo && (session.checkouts?.length ?? 0) === 0) {
    return <Note>This session has no repository, so there is nothing to ship.</Note>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="shrink-0 space-y-2 p-2.5">
        <p className="min-w-0 truncate font-mono text-micro text-mute">⑂ {session.branch}</p>

        {/* The issue this workspace was cut for. It has been a column on the
            session since sessions could be started from a task, and nothing
            ever showed it — so the one screen that is about to reference it
            was also the one place you could not see what it was. */}
        <TaskLine session={session} merged={ship.stage === "merged"} />

        {trouble && (
          <p className="rounded-sm border border-brick/40 bg-ground px-2.5 py-2 text-meta leading-[1.5] text-brick">
            {trouble}
          </p>
        )}

        {done(ship) ? (
          <div className="flex flex-col gap-1.5">
            {/* What became of it, once it has become anything. The panel used
                to draw "View pull request" for ever, whatever happened to the
                change — so a workspace whose work went in a week ago looked
                exactly like one still waiting for a reviewer. */}
            {(ship.stage === "merged" || ship.stage === "closed") && (
              <div
                className={`rounded-md border px-2.5 py-2 ${
                  ship.stage === "merged"
                    ? "border-sage-deep bg-sage-tint"
                    : "border-line bg-raise"
                }`}
              >
                <p
                  className={`text-meta font-medium ${
                    ship.stage === "merged" ? "text-sage" : "text-dim"
                  }`}
                >
                  {ship.stage === "merged" ? "✓ Merged" : "· Closed"}
                </p>
                <p className="mt-0.5 text-meta leading-[1.5] text-mute">
                  {ship.stage === "merged"
                    ? "The work is on the base branch. Nothing here is waiting."
                    : "It was closed without merging. The branch and the work are still here."}
                </p>
              </div>
            )}

            {ship.links.map((l) => (
              <a
                key={l.url}
                href={l.url}
                target="_blank"
                rel="noreferrer"
                className={`flex items-center justify-center gap-1.5 rounded-md border py-2 text-meta font-medium transition-opacity hover:opacity-80 ${
                  ship.stage === "open"
                    ? "border-sage-deep bg-sage-tint text-sage"
                    : "border-line text-dim"
                }`}
              >
                {ship.links.length === 1 ? "View pull request" : l.slug} ↗
              </a>
            ))}
          </div>
        ) : (
          <>
            <button
              onClick={() => (opening ? setDeciding(true) : amend())}
              disabled={
                push.isPending ||
                !!ship.blocked ||
                (keeping.length === 0 && ship.stage === "uncommitted")
              }
              title={ship.blocked ?? ship.label}
              className="w-full rounded-md bg-bone py-2 text-meta font-medium text-ground transition-colors hover:bg-white disabled:bg-line disabled:text-mute"
            >
              {push.isPending ? "Working…" : ship.label}
            </button>
            {sequence(ship.stage) && (
              <p className="text-meta leading-[1.5] text-mute">{sequence(ship.stage)}</p>
            )}
          </>
        )}
      </div>

      <div className="min-h-0 border-t border-line px-1 pt-1 pb-2">
        <Fold
          label={done(ship) ? "Went in" : "Going in"}
          count={keeping.length}
          open={listing}
          onToggle={() => setListing(!listing)}
        >
          {isLoading && <Line>Reading the workspace…</Line>}
          {!isLoading && files.length === 0 && <Line>Nothing has changed.</Line>}

          {files.map((f) => {
            const going = !dropped.has(f.path);
            return (
              <PathRow
                key={f.path}
                path={f.path}
                onClick={() => openTab.diff(f.path)}
                title={`${f.path} — open the diff`}
                lead={
                  <button
                    onClick={() =>
                      setDropped((held) => {
                        const next = new Set(held);
                        if (next.has(f.path)) next.delete(f.path);
                        else next.add(f.path);
                        return next;
                      })
                    }
                    title={going ? "Leave this one out" : "Put this one back"}
                    aria-label={going ? `Leave out ${f.path}` : `Include ${f.path}`}
                    className={`shrink-0 text-meta transition-colors ${
                      going ? "text-sage" : "text-mute hover:text-dim"
                    }`}
                  >
                    {going ? "☑" : "☐"}
                  </button>
                }
                trail={going ? <Counts added={f.added} removed={f.removed} /> : undefined}
              />
            );
          })}

          {files.length > 0 && (
            <p className="px-1.5 pt-1.5 font-mono text-micro text-mute">
              <span className="text-sage">+{totals.added}</span>{" "}
              <span className="text-brick">−{totals.removed}</span>
              {dropped.size > 0 && ` · ${dropped.size} left out`}
            </p>
          )}
        </Fold>
      </div>

      {deciding && (
        <ShipSheet
          session={session}
          ship={ship}
          paths={keeping.map((f) => f.path)}
          added={totals.added}
          removed={totals.removed}
          dropped={dropped.size}
          onClose={() => setDeciding(false)}
          onReviewFiles={() => {
            setDeciding(false);
            setListing(true);
          }}
        />
      )}
    </div>
  );
}

/**
 * `#32`, and what it is called.
 *
 * The number and the link are ours — two columns written when the workspace
 * was cut, which survive the tracker being unreachable. The title is the
 * tracker's, so it is asked for and then done without: a rate limit or a
 * revoked token leaves the number, which is still the thing this branch is
 * about and still somewhere to click through to.
 */
function TaskLine({
  session,
  merged,
}: {
  session: { taskKey?: string | null; taskUrl?: string | null };
  merged: boolean;
}) {
  const url = session.taskUrl ?? undefined;
  const { data: task } = useGetTask(
    { url: url ?? "" },
    { query: { enabled: !!url, staleTime: 5 * 60_000, retry: false } },
  );

  if (!session.taskKey && !url) return null;
  const key = task?.key ?? session.taskKey ?? "the issue";

  return (
    <p className="flex min-w-0 items-baseline gap-1.5 text-meta">
      <span className="shrink-0 font-mono text-micro text-dim">⌗ {key}</span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate text-mute transition-colors hover:text-bone"
          title={task?.title ?? url}
        >
          {task?.title ?? (merged ? "closes when this merges" : "the issue this came from")}
        </a>
      ) : (
        <span className="min-w-0 flex-1 truncate text-mute">the issue this came from</span>
      )}
    </p>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-3">
      <p className="text-meta leading-[1.55] text-mute">{children}</p>
    </div>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return <p className="px-1.5 py-1 text-meta text-mute">{children}</p>;
}

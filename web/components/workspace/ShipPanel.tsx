"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSession,
  useSessionWork,
  useSessionDiff,
  useCommitSession,
  usePushSession,
  useOpenPullRequest,
  useDescribeSession,
  getSessionWorkQueryKey,
  getGetSessionQueryKey,
} from "@/src/api/generated/sessions/sessions";
import { shipping, sequence, done, awaiting } from "@/src/api/ship";
import { ApiError } from "@/src/api/http";
import { useOpen } from "@/src/workspace/tabs";
import { PathRow, Counts, Fold } from "./PathRow";
import { CloseWorkspace } from "./CloseWorkspace";

/**
 * Everything between "it finished" and "it is on the git host".
 *
 * This was a modal. The modal held the message, the file list, the decision and
 * a diff pane — all of it correct, and all of it drawn *over the conversation
 * that produced the change*, which is the one thing you want beside you while
 * reviewing.
 *
 * In the panel it keeps the first three and gives up the fourth: clicking a
 * file opens a diff **tab**, at full width, in the middle. A modal could never
 * do that, and it is the reason this is worth moving rather than restyling.
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

  const commit = useCommitSession();
  const push = usePushSession();
  const open = useOpenPullRequest();
  const describe = useDescribeSession();

  const [title, setTitle] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [draft, setDraft] = useState(false);
  /** Files left out. Everything is in by default — that is what finishing means. */
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [trouble, setTrouble] = useState<string | null>(null);
  const [listing, setListing] = useState(true);

  // The agent writes a title and body when it finishes. Held as `null` until
  // somebody types, so a description arriving after the panel opened is not
  // shadowed by an empty string somebody never chose.
  const shownTitle = title ?? session?.proposedTitle ?? "";
  const shownBody = body ?? session?.proposedBody ?? "";

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
  const busy = commit.isPending || push.isPending || open.isPending;

  const refresh = () => {
    cache.invalidateQueries({ queryKey: getSessionWorkQueryKey(sessionId) });
    cache.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
  };

  const failed = (e: unknown) =>
    setTrouble(e instanceof ApiError ? e.message : "That didn't work.");

  /**
   * Whether pressing will end with a pull request being created.
   *
   * `open-behind` pushes onto a branch whose request is already open, which
   * amends it — so the draft choice does not apply and nothing new is opened.
   */
  const opening =
    ship.stage === "uncommitted" || ship.stage === "unpushed" || ship.stage === "pushed";

  /** One press, however many steps it takes from here. */
  const go = async () => {
    setTrouble(null);
    try {
      if (ship.stage === "uncommitted") {
        if (!shownTitle.trim()) {
          setTrouble("A commit needs a message. The title is used as one.");
          return;
        }
        await commit.mutateAsync({
          id: sessionId,
          data: { message: shownTitle.trim(), paths: keeping.map((f) => f.path) },
        });
      }
      if (
        ship.stage === "uncommitted" ||
        ship.stage === "unpushed" ||
        ship.stage === "open-behind"
      ) {
        await push.mutateAsync({ id: sessionId });
      }
      if (opening) {
        const made = await open.mutateAsync({
          id: sessionId,
          data: { title: shownTitle.trim(), body: shownBody.trim(), draft },
        });
        window.open(made.url, "_blank", "noreferrer");
      }
      refresh();
    } catch (e) {
      failed(e);
      refresh();
    }
  };

  if (!session.repo && (session.checkouts?.length ?? 0) === 0) {
    return <Note>This session has no repository, so there is nothing to ship.</Note>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="shrink-0 space-y-2 p-2.5">
        <input
          value={shownTitle}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title — the commit message and the pull request"
          className="w-full rounded-md border border-line bg-ground px-2.5 py-2 text-meta text-text placeholder:text-mute focus:border-dim focus:outline-none"
        />

        <div className="relative">
          <textarea
            value={shownBody}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="What changed and why, for whoever reviews it"
            className="w-full resize-none rounded-md border border-line bg-ground py-2 pr-8 pl-2.5 text-meta leading-[1.5] text-text placeholder:text-mute focus:border-dim focus:outline-none"
          />
          <button
            onClick={() =>
              describe.mutate(
                { id: sessionId },
                {
                  onSuccess: (p) => {
                    setTitle(p.title);
                    setBody(p.body);
                  },
                  onError: failed,
                },
              )
            }
            disabled={describe.isPending}
            title="Ask the agent to describe the change"
            className="absolute top-1.5 right-1.5 rounded-sm px-1 py-0.5 text-meta text-mute transition-colors hover:text-bone disabled:opacity-40"
          >
            {describe.isPending ? "…" : "✦"}
          </button>
        </div>

        {sequence(ship.stage) && (
          <p className="text-meta leading-[1.5] text-mute">{sequence(ship.stage)}</p>
        )}

        {/* Read and acted on, not a toast: a refused push is something to fix,
            and a message that disappears is neither. */}
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

            {/* The next thing to do, once there is nothing left to review. */}
            {ship.stage === "merged" && <CloseWorkspace session={session} prominent />}

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
          <button
            onClick={go}
            disabled={busy || (keeping.length === 0 && ship.stage === "uncommitted")}
            title={ship.blocked ?? ship.label}
            className="w-full rounded-md bg-bone py-2 text-meta font-medium text-ground transition-colors hover:bg-white disabled:bg-line disabled:text-mute"
          >
            {busy ? "Working…" : ship.label}
          </button>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 truncate font-mono text-micro text-mute">
            ⑂ {session.branch}
          </span>
          {opening && (
            <label className="flex cursor-pointer items-center gap-1.5 text-meta text-dim">
              <input
                type="checkbox"
                checked={draft}
                onChange={(e) => setDraft(e.target.checked)}
                className="accent-bone"
              />
              Draft
            </label>
          )}
        </div>
      </div>

      <div className="min-h-0 border-t border-line px-1 pt-1 pb-2">
        <Fold
          label="Going in"
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

      {/* Always, whatever the stage. Most workspaces never get a pull request,
          so the way to finish with one cannot live in the half of the panel
          that only appears when there is one. */}
      <div className="flex shrink-0 items-center justify-end border-t border-line px-2 py-1.5">
        <CloseWorkspace session={session} />
      </div>
    </div>
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

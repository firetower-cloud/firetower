"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  useStopSession,
  usePushSession,
  useOpenPullRequest,
  useDestroySession,
  useSessionWork,
  getSessionWorkQueryKey,
  getListSessionsQueryKey,
  getGetSessionQueryKey,
} from "@/src/api/generated/sessions/sessions";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import type { Session } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";

/**
 * What you can do with what the agent produced.
 *
 * Ordered by what a session actually goes through: stop it, keep the work,
 * send it somewhere, then throw the workspace away. Ending is last and apart,
 * because it is the only one that destroys anything.
 */
export function SessionActions({ session }: { session: Session }) {
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const router = useRouter();
  const queryClient = useQueryClient();

  const ended = session.status === "Ended";
  const running = session.status === "Working" || session.status === "Starting";

  /**
   * Whether the machine this runs on is answering.
   *
   * Everything below except removing it goes through that machine, and a
   * session on a host that has gone can otherwise never be got rid of: ending
   * one asks its worker to tear the workspace down, and there is no worker.
   */
  const { data: hosts } = useListHosts();
  const host = hosts?.find((h) => h.id === session.hostId);
  const unreachable = host?.state === "Unreachable";

  const { data: work } = useSessionWork(session.id, {
    // Cheap, and it changes whenever the agent does something. Skipped without
    // a repository: there is no checkout to summarise.
    query: {
      refetchInterval: ended ? false : 5000,
      enabled: !ended && session.repo != null,
    },
  });

  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [titling, setTitling] = useState(false);
  const [title, setTitle] = useState("");

  const stop = useStopSession();
  const push = usePushSession();
  const pullRequest = useOpenPullRequest();
  const destroy = useDestroySession();

  const busy =
    stop.isPending || push.isPending || pullRequest.isPending || destroy.isPending;

  const after = async (detail: string) => {
    setNote(detail);
    setFailed(null);
    await queryClient.invalidateQueries({ queryKey: getSessionWorkQueryKey(session.id) });
    await queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) });
  };

  const submitPr = () =>
    pullRequest.mutate(
      { id: session.id, data: { title: title.trim() } },
      {
        onSuccess: (r) => {
          setPrUrl(r.url);
          setFailed(null);
          setTitling(false);
        },
        onError: problem,
      },
    );

  const problem = (e: unknown) => {
    setNote(null);
    setFailed(e instanceof ApiError ? e.message : "That didn't work.");
  };

  if (ended) {
    return (
      <Panel>
        <p className="text-[12.5px] leading-[1.5] text-mute">
          {session.forgottenAt
            ? // It did not end — it was taken off the inbox. Saying the
              // workspace was removed would be untrue, and this is the one
              // screen that knows better.
              `Removed here while ${host?.name ?? "its host"} wasn't answering. Whatever it left behind is still on that machine, and Firetower tears it down if that machine comes back.`
            : "This session has ended and its workspace was removed."}
        </p>
      </Panel>
    );
  }


  // A bare agent has no checkout, so committing, pushing and opening a pull
  // request are not things that could happen here. Absent beats
  // present-and-failing.
  const checkout = session.repo != null;

  return (
    <Panel>
      {unreachable && (
        <p className="mb-3 rounded-[5px] border border-ember/30 bg-ember/[0.05] px-2.5 py-1.5 text-[11.5px] leading-[1.5] text-bone">
          {host?.name ?? "This session's host"} isn&apos;t answering. Nothing here
          reaches the agent until it does — you can still remove the session from
          Firetower.
        </p>
      )}

      {checkout ? (
        <Work work={work} />
      ) : (
        <p className="text-[12.5px] leading-[1.5] text-mute">
          No repository — nothing is checked out, so there is nothing to push.
        </p>
      )}

      {/* Committing is the agent's job. It knows what it changed and why, and
          a message written from a branch name reads like one. */}
      <div className="mt-3 flex flex-col gap-1.5">
        {running && (
          <Action
            label="Stop the agent"
            hint={checkout ? "Keeps the workspace and the branch" : "Keeps the workspace"}
            onClick={() =>
              stop.mutate({ id: session.id }, { onSuccess: (d) => after(d.detail), onError: problem })
            }
            disabled={busy}
          />
        )}

        {checkout && (
        <Action
          label={work && work.ahead > 0 ? `Push ${work.ahead}` : "Push"}
          hint={
            work
              ? work.ahead > 0
                ? `${work.ahead} ${work.ahead === 1 ? "commit" : "commits"} waiting`
                : "Up to date"
              : undefined
          }
          onClick={() =>
            push.mutate({ id: session.id }, { onSuccess: (d) => after(d.detail), onError: problem })
          }
          disabled={busy || (work ? work.ahead === 0 : false)}
        />
        )}

        {!checkout ? null : !titling ? (
          <Action
            label="Open pull request"
            hint={work && !work.pushed ? "Push the branch first" : (session.branch ?? undefined)}
            onClick={() => {
              setTitle(fromBranch(session.branch ?? ""));
              setTitling(true);
            }}
            disabled={busy || (work ? !work.pushed : true)}
          />
        ) : (
          <div className="rounded-[5px] border border-ember/40 px-2.5 py-2">
            <label className="eyebrow">Pull request title</label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && title.trim() && submitPr()}
              placeholder="What this changes"
              className="mt-1.5 w-full bg-transparent text-[12.5px] text-bone placeholder:text-mute focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-mute">
              Your prompt becomes the description.
            </p>
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={submitPr}
                disabled={!title.trim() || pullRequest.isPending}
                className="rounded-[4px] bg-ember px-2.5 py-1 text-[11.5px] font-semibold text-[#1a0c04] transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pullRequest.isPending ? "Opening…" : "Open it"}
              </button>
              <button
                onClick={() => setTitling(false)}
                className="text-[11.5px] text-mute transition-colors hover:text-text"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {prUrl && (
        <a
          href={prUrl}
          target="_blank"
          rel="noopener"
          className="mt-3 block truncate rounded-[5px] border border-sage/25 bg-sage/[0.04] px-2.5 py-1.5 font-mono text-[11px] text-sage hover:underline"
        >
          {prUrl.replace(/^https?:\/\//, "")}
        </a>
      )}

      {note && (
        <p className="mt-3 rounded-[5px] border border-sage/25 bg-sage/[0.04] px-2.5 py-1.5 text-[11.5px] text-slate">
          {note}
        </p>
      )}
      {failed && (
        <p className="mt-3 rounded-[5px] border border-ember/30 bg-ember/[0.05] px-2.5 py-1.5 text-[11.5px] text-bone">
          {failed}
        </p>
      )}

      <div className="mt-4 border-t border-line pt-3">
        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            disabled={busy}
            className="text-[12px] text-mute transition-colors hover:text-ember"
          >
            {unreachable ? "Force remove" : "End session"}
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            {unreachable ? (
              // Said plainly, because it is not what ending normally means.
              // Nothing is being torn down here — the agent is still running on
              // a machine we cannot reach, and this only stops it filling the
              // inbox.
              <p className="text-[11.5px] leading-[1.5] text-dim">
                {host?.name ?? "That machine"} isn&apos;t answering, so the workspace
                can&apos;t be removed. The agent keeps running there, holding its
                worktree and its terminal. If that machine comes back, Firetower
                tears them down then. We also can&apos;t tell you what is unpushed,
                because we can&apos;t reach it to look.
              </p>
            ) : (
              <p className="text-[11.5px] leading-[1.5] text-dim">
                {checkout && atRisk(work)
                  ? "This removes the workspace. What hasn't been pushed is gone."
                  : "This removes the workspace. Everything is pushed."}
              </p>
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={() =>
                  destroy.mutate(
                    { id: session.id, params: unreachable ? { force: true } : undefined },
                    {
                      onSuccess: async () => {
                        await queryClient.invalidateQueries({
                          queryKey: getListSessionsQueryKey(),
                        });
                        router.push("/");
                      },
                      onError: problem,
                    },
                  )
                }
                disabled={busy}
                className="rounded-[4px] bg-ember px-2.5 py-1 text-[11.5px] font-semibold text-[#1a0c04] transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {destroy.isPending
                  ? unreachable
                    ? "Removing…"
                    : "Ending…"
                  : unreachable
                    ? "Remove it here"
                    : "End it"}
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="text-[11.5px] text-mute transition-colors hover:text-text"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * A first draft of a title, from the branch you named.
 *
 * Better than the prompt: you chose the branch deliberately, whereas a title
 * sliced off the front of a sentence reads like one.
 */
function fromBranch(branch: string) {
  const last = branch.split("/").pop() ?? branch;
  const words = last.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Whether ending this would lose something. */
function atRisk(work?: { uncommitted: number; ahead: number }) {
  return !work || work.uncommitted > 0 || work.ahead > 0;
}

function Work({ work }: { work?: { uncommitted: number; ahead: number; pushed: boolean } }) {
  if (!work) {
    return <p className="text-[11.5px] text-mute">Looking at the workspace…</p>;
  }

  const clean = work.uncommitted === 0 && work.ahead === 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 rounded-full ${clean ? "bg-sage" : "bg-ember"}`}
        />
        <span className="text-[12.5px] text-dim">
          {clean ? "Everything is pushed" : "Not everything is saved"}
        </span>
      </div>
      <div className="pl-3.5 font-mono text-[11px] text-mute">
        {work.uncommitted} uncommitted · {work.ahead} unpushed
        {!work.pushed && " · branch not on the remote"}
      </div>
    </div>
  );
}

function Action({
  label,
  hint,
  onClick,
  disabled,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group flex flex-col items-start rounded-[5px] border border-line px-2.5 py-1.5 text-left transition-colors hover:border-ember/40 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-line"
    >
      <span className="text-[12.5px] text-bone">{label}</span>
      {hint && <span className="text-[11px] text-mute">{hint}</span>}
    </button>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-line pt-4">
      <div className="eyebrow mb-2.5">The work</div>
      {children}
    </div>
  );
}

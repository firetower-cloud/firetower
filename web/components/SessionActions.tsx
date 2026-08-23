"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  useStopSession,
  useDestroySession,
  getListSessionsQueryKey,
  getGetSessionQueryKey,
  getSessionWorkQueryKey,
} from "@/src/api/generated/sessions/sessions";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import type { Session, WorkSummary } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";

/**
 * The two things you can do to a session itself.
 *
 * Stopping it and ending it, and nothing else. Getting the work out is the
 * button next to this one — that is a sequence with a next step, and it earns
 * the space. These two are rare and destructive-ish, so they live behind a
 * menu where neither can be hit on the way to something else.
 */
export function SessionMenu({ session, work }: { session: Session; work?: WorkSummary }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const router = useRouter();
  const cache = useQueryClient();

  const ended = session.status === "Ended";
  const running = session.status === "Working" || session.status === "Starting";

  /**
   * Whether the machine this runs on is answering.
   *
   * Ending a session asks its worker to tear the workspace down, so a session
   * on a host that has gone can otherwise never be got rid of.
   */
  const { data: hosts } = useListHosts();
  const host = hosts?.find((h) => h.id === session.hostId);
  const unreachable = host?.state === "Unreachable";

  const stop = useStopSession();
  const destroy = useDestroySession();
  const busy = stop.isPending || destroy.isPending;

  /** Closing puts it back how it opens: no half-confirmed End waiting. */
  const close = useCallback(() => {
    setOpen(false);
    setConfirming(false);
    setFailed(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open, close]);

  const problem = (e: unknown) =>
    setFailed(e instanceof ApiError ? e.message : "That didn't work.");

  return (
    <div ref={box} className="relative shrink-0">
      <button
        onClick={() => (open ? close() : setOpen(true))}
        aria-label="More"
        className="rounded-[8px] px-2 py-1.5 text-[16px] leading-none text-mute transition-colors hover:bg-raise hover:text-text"
      >
        ⋯
      </button>

      {open && (
        <div className="absolute top-full right-0 z-30 mt-2 w-[292px] rounded-[14px] border border-line bg-panel p-1.5 shadow-[0_12px_36px_-14px_rgba(0,0,0,0.85)]">
          {ended ? (
            <p className="px-2 py-1.5 text-[13px] leading-[1.5] text-mute">
              {session.forgottenAt
                ? // It did not end — it was taken off the inbox. Saying the
                  // workspace was removed would be untrue, and this is the one
                  // screen that knows better.
                  `Removed here while ${host?.name ?? "its host"} wasn't answering. Whatever it left behind is still on that machine, and Firetower tears it down if that machine comes back.`
                : "This session has ended and its workspace was removed."}
            </p>
          ) : (
            <>
              {unreachable && (
                <p className="mb-1 rounded-[6px] bg-ember/[0.06] px-2 py-1.5 text-[12.5px] leading-[1.5] text-bone">
                  {host?.name ?? "This session's host"} isn&apos;t answering. Nothing
                  here reaches the agent until it does — you can still remove the
                  session from Firetower.
                </p>
              )}

              {running && (
                <Item
                  label="Stop the agent"
                  hint={session.repo ? "Keeps the workspace and the branch" : "Keeps the workspace"}
                  disabled={busy}
                  onClick={() =>
                    stop.mutate(
                      { id: session.id },
                      {
                        onSuccess: () => {
                          close();
                          cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) });
                          cache.invalidateQueries({ queryKey: getSessionWorkQueryKey(session.id) });
                        },
                        onError: problem,
                      },
                    )
                  }
                />
              )}

              {!confirming ? (
                <Item
                  label={unreachable ? "Force remove" : "End session"}
                  hint="Removes the workspace"
                  grave
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                />
              ) : (
                <div className="px-2 py-1.5">
                  {unreachable ? (
                    // Said plainly, because it is not what ending normally
                    // means. Nothing is torn down here — the agent is still
                    // running on a machine we cannot reach, and this only stops
                    // it filling the inbox.
                    <p className="text-[12.5px] leading-[1.5] text-dim">
                      {host?.name ?? "That machine"} isn&apos;t answering, so the
                      workspace can&apos;t be removed. The agent keeps running
                      there, holding its worktree and its terminal. If that
                      machine comes back, Firetower tears them down then. We also
                      can&apos;t tell you what is unpushed, because we can&apos;t
                      reach it to look.
                    </p>
                  ) : (
                    <p className="text-[12.5px] leading-[1.5] text-dim">
                      {session.repo && atRisk(work)
                        ? "This removes the workspace. What hasn't been pushed is gone."
                        : "This removes the workspace. Everything is pushed."}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      onClick={() =>
                        destroy.mutate(
                          { id: session.id, params: unreachable ? { force: true } : undefined },
                          {
                            onSuccess: async () => {
                              await cache.invalidateQueries({
                                queryKey: getListSessionsQueryKey(),
                              });
                              router.push("/");
                            },
                            onError: problem,
                          },
                        )
                      }
                      disabled={busy}
                      className="rounded-[5px] bg-ember px-2.5 py-1 text-[12.5px] font-semibold text-ground transition-opacity hover:opacity-90 disabled:opacity-60"
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
                      className="text-[12.5px] text-mute transition-colors hover:text-text"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {failed && (
            <p className="mt-1 rounded-[6px] bg-ember/[0.06] px-2 py-1.5 text-[12.5px] text-bone">
              {failed}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Whether ending this would lose something. */
function atRisk(work?: WorkSummary) {
  return !work || work.uncommitted > 0 || work.ahead > 0;
}

function Item({
  label,
  hint,
  onClick,
  disabled,
  grave,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  grave?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-raise disabled:opacity-45 disabled:hover:bg-transparent"
    >
      <span className={`block text-[13.5px] ${grave ? "text-dim" : "text-text"}`}>{label}</span>
      {hint && <span className="block text-[12px] text-mute">{hint}</span>}
    </button>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useDestroySession,
  useListSessions,
  useSessionWork,
  getListSessionsQueryKey,
} from "@/src/api/generated/sessions/sessions";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import type { Session } from "@/src/api/generated/model";
import { Modal, Foot, Go, Quiet } from "@/components/Modal";
import { Icon } from "@/components/ui";
import { ApiError } from "@/src/api/http";

/**
 * The way out of a workspace, wherever it got to.
 *
 * Ending one was only ever reachable by closing an agent's tab, which ends
 * that agent — a thing you had to already know. Then it was a word at the
 * bottom of the Ship view, which is better and still filed the only control
 * that ends a workspace under the one thing most workspaces never do. It lives
 * on the panel's status line now, under every view; see `Doing`.
 *
 * It says what it is about to destroy first. This removes a worktree from a
 * machine, and uncommitted work in it does not come back.
 */
export function CloseWorkspace({
  session,
  prominent,
}: {
  session: Session;
  /** Drawn as the thing to do next, for a workspace whose work has gone in. */
  prominent?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const router = useRouter();
  const cache = useQueryClient();
  const destroy = useDestroySession();

  const { data: sessions = [] } = useListSessions();
  const { data: checkouts = [] } = useSessionWork(session.id, {
    query: { enabled: asking && !!session.repo },
  });
  const { data: hosts = [] } = useListHosts();

  // Ending the workspace's own session ends the workspace, so the other agents
  // in it go too — worth saying before it happens rather than after.
  const founding = session.workspaceId === session.id;
  const others = founding
    ? sessions.filter(
        (s) => s.workspaceId === session.workspaceId && s.id !== session.id && s.status !== "Ended",
      ).length
    : 0;

  // A host that has gone cannot be asked to tear anything down, and the API
  // refuses rather than pretending. Removing it here is the documented way out.
  const unreachable = hosts.find((h) => h.id === session.hostId)?.state === "Unreachable";

  // Across every repository in the workspace, because closing takes all of
  // them and a warning about one of three is a warning that misleads.
  const uncommitted = checkouts.reduce((n, c) => n + c.uncommitted, 0);
  const unpushed = checkouts.reduce((n, c) => n + (c.pushed ? 0 : c.ahead), 0);
  const pushed = checkouts.length > 0 && checkouts.every((c) => c.pushed);
  const losing = uncommitted > 0 || unpushed > 0;

  const go = () =>
    destroy.mutate(
      { id: session.id, params: unreachable ? { force: true } : undefined },
      {
        onSuccess: async () => {
          await cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
          router.push("/");
        },
        onError: (e) => setFailed(e instanceof ApiError ? e.message : "That didn't work."),
      },
    );

  return (
    <>
      <button
        onClick={() => {
          setFailed(null);
          setAsking(true);
        }}
        className={
          prominent
            ? "w-full rounded-md bg-bone py-2 text-meta font-medium text-ground transition-colors hover:bg-white"
            : // Outlined rather than filled: this is a way out, not a next
              // step, and the filled control in this panel is the one that
              // ships. It turns brick under the pointer instead of resting
              // that way — the only destructive control on screen should say
              // so before it is pressed, without sitting there as a warning.
              "flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-meta text-dim transition-colors hover:border-brick-deep hover:bg-brick-tint hover:text-brick"
        }
      >
        {!prominent && <Icon of={LogOut} size={12} />}
        Close workspace
      </button>

      {asking && (
        <Modal title="Close this workspace?" onClose={() => setAsking(false)}>
          <p className="text-ui leading-[1.6] text-dim">
            {founding
              ? others > 0
                ? `The agent and ${others} other${others === 1 ? "" : "s"} in this workspace stop.`
                : "The agent stops."
              : "This agent stops. The others in this workspace carry on."}{" "}
            The worktree is removed from{" "}
            {hosts.find((h) => h.id === session.hostId)?.name ?? "its host"}.
          </p>

          {losing ? (
            <p className="mt-3 rounded-sm border border-brick/40 bg-ground px-3 py-2 text-meta leading-[1.55] text-brick">
              {[
                uncommitted > 0 && `${uncommitted} uncommitted file${uncommitted === 1 ? "" : "s"}`,
                unpushed > 0 && `${unpushed} unpushed commit${unpushed === 1 ? "" : "s"}`,
              ]
                .filter(Boolean)
                .join(" and ")}{" "}
              — closing loses that.
            </p>
          ) : (
            <p className="mt-3 text-meta leading-[1.55] text-mute">
              {pushed
                ? `${session.branch} is pushed, so the commits are safe on the remote.`
                : "Nothing here is waiting to be saved."}
            </p>
          )}

          {unreachable && (
            <p className="mt-3 text-meta leading-[1.55] text-mute">
              Its host is not answering, so this removes it here. The machine tears the
              workspace down when it comes back.
            </p>
          )}

          {failed && <p className="mt-3 text-meta text-brick">{failed}</p>}

          <Foot>
            <Go onClick={go} disabled={destroy.isPending}>
              {destroy.isPending ? "Closing…" : "Close it"}
            </Go>
            <Quiet onClick={() => setAsking(false)}>Cancel</Quiet>
          </Foot>
        </Modal>
      )}
    </>
  );
}

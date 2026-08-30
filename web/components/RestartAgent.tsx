"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  useRelaunchSession,
  getGetSessionQueryKey,
} from "@/src/api/generated/sessions/sessions";
import type { Session } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";

/**
 * A session whose agent is not running, and the way back.
 *
 * The process is not the session. The worktree, the branch, the commits and
 * everything said so far are on the volume; the agent is a child process with
 * a socket in `/tmp`, and recreating the container to upgrade Firetower ends
 * every one of them at once. Without this the only sign was a message that
 * never got an answer, and the only way on was to abandon the workspace and
 * start again somewhere else.
 *
 * Saying what is *still there* is the point of the sentence. "The agent
 * stopped" reads as "your work is gone" unless it is answered in the same
 * breath.
 */
export function RestartAgent({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  const relaunch = useRelaunchSession();

  const go = () =>
    relaunch.mutate(
      { id: session.id },
      {
        onSuccess: () =>
          queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) }),
      },
    );

  return (
    <div className="mb-2 rounded-lg border border-ember-deep bg-panel px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className="eyebrow text-ember">Stopped</span>
      </div>

      <p className="mt-1 max-w-[62ch] text-ui leading-[1.55] text-text">
        The agent is not running. Its workspace, its branch and everything said
        so far are still here — starting it again picks the conversation up
        where it stopped.
      </p>

      {/* What the control plane was told, when it is not the ordinary case.
          The ordinary one is already said above in better words. */}
      {session.note && !session.note.startsWith("The agent is not running") && (
        <p className="mt-2 font-mono text-meta text-mute">{session.note}</p>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={go}
          disabled={relaunch.isPending}
          className="min-h-[32px] rounded-md bg-bone px-3.5 text-ui font-medium text-ground transition-colors hover:bg-white disabled:bg-line disabled:text-mute"
        >
          {relaunch.isPending ? "Starting…" : "Restart the agent"}
        </button>
        <span className="text-meta text-mute">
          Or just say something — it starts on its own.
        </span>
      </div>

      {relaunch.isError && (
        <p className="mt-2 text-meta text-brick">
          {relaunch.error instanceof ApiError
            ? relaunch.error.message
            : "it didn't start"}
        </p>
      )}
    </div>
  );
}

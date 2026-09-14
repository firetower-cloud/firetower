/**
 * Ending a workspace, from wherever it is asked.
 *
 * The same operation as the web's *Close workspace*: every agent in it stops,
 * the workspace goes, the branch stays on the machine. What would be lost is
 * read first — uncommitted files and unpushed commits per checkout, off
 * `session_work` — and put in the question, the way the web puts it.
 */
import { useQueryClient } from "@tanstack/react-query";
import { destroySession, getListSessionsQueryKey, sessionWork } from "~/api/generated/sessions/sessions";
import type { Workspace } from "~/api/workspaces";
import { useConfirm } from "~/ui/Confirm";
import { why } from "~/data";

export function useEndWorkspace() {
  const confirm = useConfirm();
  const cache = useQueryClient();

  return async (place: Workspace): Promise<{ ended: boolean; trouble?: string }> => {
    const work = await sessionWork(place.id).catch(() => null);
    const uncommitted = (work ?? []).reduce((n, c) => n + (c.uncommitted ?? 0), 0);
    const unpushed = (work ?? []).reduce((n, c) => n + ((c.ahead ?? 0) > 0 && c.pushed === false ? c.ahead ?? 0 : 0), 0);
    const agents = place.runs.filter((r) => r.status !== "Ended").length;
    const losing = [
      uncommitted > 0 && `${uncommitted} uncommitted file${uncommitted === 1 ? "" : "s"}`,
      unpushed > 0 && `${unpushed} unpushed commit${unpushed === 1 ? "" : "s"}`,
    ].filter(Boolean);

    const ok = await confirm({
      title: `End "${place.name}"?`,
      body:
        `${agents === 1 ? "The agent stops" : `${agents} agents stop`}. ` +
        (losing.length ? `${losing.join(" and ")} on ${place.branch ?? "its branch"} would be lost. ` : work === null ? "What is uncommitted there could not be read and would be lost. " : "Nothing uncommitted is in it. ") +
        "The branch stays on the machine.",
      action: "End workspace",
      tone: "danger",
    });
    if (!ok) return { ended: false };
    try {
      await destroySession(place.id, undefined);
      await cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
      return { ended: true };
    } catch (e) {
      return { ended: false, trouble: why(e) };
    }
  };
}

/** One agent out of several. The others keep working. */
export function useEndAgent() {
  const confirm = useConfirm();
  const cache = useQueryClient();
  return async (id: string, label: string, others: number): Promise<boolean> => {
    const ok = await confirm({
      title: `End ${label}?`,
      body: others > 0 ? `This conversation stops. The other agent${others === 1 ? "" : "s"} in the workspace keep${others === 1 ? "s" : ""} working.` : "This conversation stops.",
      action: "End this agent",
      tone: "danger",
    });
    if (!ok) return false;
    await destroySession(id, undefined);
    await cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
    return true;
  };
}

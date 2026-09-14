/**
 * The facts along the bottom edge of a workspace, the way an editor keeps
 * them: where the work is (the branch and what is not saved on it), where it
 * runs (the machine, how, with what), and what this run is drawing right now.
 *
 * Chrome, not content — one short line in mono. Ember is not used here; a
 * machine is context. A machine that has gone quiet says so in place.
 */
import { useRef, useState } from "react";
import { Box, GitBranch, Monitor } from "lucide-react";
import { useSessionWork } from "~/api/generated/sessions/sessions";
import type { Host, Session } from "~/api/generated/model";
import { executionOf, isLocal, machines } from "~/api/environments";
import { useHosts, useSessions } from "~/data";
import { navigate } from "~/shims/next-navigation";

const SHARE: Record<string, string> = { yields: "yields", equal: "equal share", takesMore: "takes more" };

/** Where a session runs, as words. The Mac is a client; "Firetower's machine" is the one underneath the control plane. */
export function whereItRuns(host: Host | undefined, hosts: Host[]) {
  if (!host) return null;
  const machine = machines(hosts).find((m) => m.hosts.some((h) => h.id === host.id));
  const execution = executionOf(host);
  return {
    name: isLocal(machine) ? "Firetower's machine" : (machine?.label ?? host.name),
    execution,
    how: execution === "container" ? "in a container" : execution === "host" ? "on the machine" : "",
    Mark: execution === "container" ? Box : Monitor,
    quiet: host.state === "Unreachable" || !!host.reconnecting,
    draining: host.state === "Draining" || !!host.drained,
  };
}

const gb = (mb?: number | null) => (mb ? `${Math.round(mb / 1024)} GB` : null);

export function StatusBar({ session, branch, onCommit }: { session: Session; branch?: string; onCommit: () => void }) {
  const hosts = useHosts();
  const host = hosts.data.find((h) => h.id === session.hostId);
  const where = whereItRuns(host, hosts.data);
  const work = useSessionWork(session.id, { query: { refetchInterval: 15_000, retry: false } });
  const uncommitted = (work.data ?? []).reduce((n, c) => n + (c.uncommitted ?? 0), 0);
  const unpushed = (work.data ?? []).reduce((n, c) => n + (c.pushed === false ? c.ahead ?? 0 : 0), 0);
  const ended = session.status === "Ended";
  const [card, setCard] = useState(false);
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);

  return (
    <div className="relative flex h-6 shrink-0 items-center gap-4 border-t border-line bg-panel px-3 font-mono text-micro text-mute select-none">
      {/* The branch, and what is not saved on it. */}
      <button onClick={onCommit} title="Open the Commit tab" className="flex min-w-0 items-center gap-1.5 hover:text-bone">
        <GitBranch className="h-3 w-3 shrink-0" strokeWidth={1.75} />
        <span className="truncate">{branch ?? "—"}</span>
        {!ended && uncommitted > 0 && <span className="shrink-0 text-dim">· {uncommitted} uncommitted</span>}
        {!ended && unpushed > 0 && <span className="shrink-0 text-dim">· {unpushed} unpushed</span>}
      </button>

      {/* The machine. */}
      {where && (
        <button
          onClick={() => navigate("/configuration")}
          onMouseEnter={() => (hover.current = setTimeout(() => setCard(true), 450))}
          onMouseLeave={() => {
            clearTimeout(hover.current);
            setCard(false);
          }}
          title="Open Compute in Configuration"
          className={`flex min-w-0 items-center gap-1.5 hover:text-bone ${where.quiet ? "stale" : ""}`}
        >
          <where.Mark className="h-3 w-3 shrink-0" strokeWidth={1.75} />
          <span className="truncate">
            {where.quiet
              ? `${where.name} is not answering — reconnecting`
              : where.draining
                ? `${where.name} · draining — nothing new starts here`
                : [where.name, where.how, host?.cpus ? `${host.cpus} cores` : null, gb(host?.memoryMb), session.share ? SHARE[session.share] : null].filter(Boolean).join(" · ")}
          </span>
        </button>
      )}

      {/* What this run is drawing now. */}
      {!ended && session.usage && (
        <span className="ml-auto shrink-0" title="What this workspace is using on its machine">
          {Math.round(session.usage.cpu * 10) / 10} cores · {Math.round(session.usage.memoryMb)} MB
        </span>
      )}

      {card && host && <HostCard host={host} where={where!} />}
    </div>
  );
}

/** The facts that do not fit a line. Anchored above the bar, or at a point on screen when told one. */
export function HostCard({ host, where, at }: { host: Host; where: NonNullable<ReturnType<typeof whereItRuns>>; at?: { x: number; y: number } }) {
  const sessions = useSessions();
  const on = sessions.data.filter((s) => s.hostId === host.id && s.status !== "Ended").length;
  const docker = host.docker?.status === "Running" ? `Docker ${host.docker.detail ?? ""}`.trim() : host.docker?.status === "Absent" ? "no Docker" : host.docker?.status === "Stopped" ? "Docker stopped" : null;
  return (
    <div
      style={at ? { left: Math.min(at.x, window.innerWidth - 22 * 16 - 12), top: at.y + 8 } : undefined}
      className={`${at ? "fixed" : "absolute bottom-7 left-3"} z-40 w-[22rem] rounded-xl border border-line bg-overlay px-4 py-3 font-sans text-left shadow-(--shadow-float)`}
    >
      <div className="flex items-center gap-2">
        <where.Mark className="h-3.5 w-3.5 text-slate" strokeWidth={1.75} />
        <span className="text-ui text-bone">{where.name}</span>
        <span className={`ml-auto text-micro ${host.state === "Online" ? "text-sage" : host.state === "Draining" ? "text-dim" : "text-brick"}`}>{host.state === "Unreachable" ? "Not answering" : host.state}</span>
      </div>
      <p className="mt-1.5 text-meta text-dim">
        {where.how ? where.how[0].toUpperCase() + where.how.slice(1) : "Execution unknown"}
        {docker ? ` · ${docker}` : ""}
      </p>
      <p className="text-meta text-dim">
        {[host.cpus ? `${host.cpus} cores` : null, gb(host.memoryMb), `${on} session${on === 1 ? "" : "s"} on it`].filter(Boolean).join(" · ")}
      </p>
      <p className="text-meta text-mute">{host.workerVersion ? `worker ${host.workerVersion}` : "worker version unknown"}</p>
    </div>
  );
}

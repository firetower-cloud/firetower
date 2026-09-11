"use client";

import type { Agent, Host, Readiness } from "@/src/api/generated/model";
import { useHostReadiness, useConnectHost } from "@/src/api/generated/hosts/hosts";
import { useQueryClient } from "@tanstack/react-query";
import { connectionLabel, executionOf } from "@/src/api/environments";

export function isReady(report?: Readiness): boolean {
  return (
    !!report &&
    report.checks.length > 0 &&
    report.checks.every((check) => !check.required || check.available)
  );
}

export function NativeSetupInstructions() {
  return (
    <div className="space-y-2 text-meta leading-[1.5] text-mute">
      <p>
        On this machine, install Git, tmux, a POSIX shell and your selected agent. Use its package
        manager for system packages (for example,{" "}
        <code>sudo apt install git tmux ca-certificates</code> on Debian/Ubuntu). Docker is
        optional.
      </p>
      <p>
        Install a native <code>firetower-worker</code> binary matching your control plane. To build
        it from the matching Firetower source checkout with Rust installed:
      </p>
      <pre className="overflow-x-auto rounded-sm bg-ground p-3 font-mono text-meta text-bone">{`cargo build --release -p ft-cli --no-default-features --bin firetower-worker
sudo install -m 755 target/release/firetower-worker /usr/local/bin/firetower-worker`}</pre>
      <p>
        Install the agent using its own installation instructions, or, with Node.js/npm installed,
        run <code>firetower-worker agents add claude-code</code> or{" "}
        <code>firetower-worker agents add codex</code> as the connection account.
      </p>
      <p>
        Ensure the tools are available in a non-interactive SSH connection, and the account can
        write to <code>~/.firetower/worker</code>. Firetower checks these requirements; you install
        or configure them yourself.
      </p>
    </div>
  );
}

export function HostReadiness({ host, agent }: { host: Host; agent?: Agent }) {
  const cache = useQueryClient();
  const report = useHostReadiness(
    host.id,
    { agent },
    {
      query: {
        retry: false,
        staleTime: 5000,
        refetchInterval: (query) => (isReady(query.state.data) ? false : 5000),
      },
    },
  );
  const connect = useConnectHost();
  const checkAgain = async () => {
    if (host.state !== "Online") {
      await connect.mutateAsync({ id: host.id });
    }
    await report.refetch();
    await cache.invalidateQueries({ queryKey: ["/api/v1/hosts"] });
    await cache.invalidateQueries({ queryKey: ["/api/v1/agents"] });
  };
  return (
    <section aria-label="Environment readiness" className="rounded-md border border-line p-3">
      <p className="text-meta text-dim">Connection: {connectionLabel(host)}</p>
      {report.data?.user && (
        <p className="mt-1 text-meta text-mute">
          Runs as {report.data.user}. Uses this account&apos;s permissions{" "}
          {executionOf(host) === "host" ? "on the host" : "in the container"}.
        </p>
      )}
      {report.isFetching && (
        <p role="status" className="mt-2 text-meta text-mute">
          Checking requirements…
        </p>
      )}
      {report.error && (
        <p role="alert" className="mt-2 text-meta text-brick">
          Couldn&apos;t check requirements: {report.error.message}
        </p>
      )}
      <ul className="my-2 space-y-1 text-meta">
        {report.data?.checks.map((check) => (
          <li key={check.name}>
            <div className="flex justify-between gap-3">
              <span className="text-dim">
                {check.name}
                {!check.required && " (optional)"}
              </span>
              <span className={check.available ? "text-sage" : "text-mute"}>
                {check.available ? "Ready" : "Missing or unavailable"}
              </span>
            </div>
            {!check.available && (
              <p className="text-mute">
                {check.detail} {check.remedy}
              </p>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-start justify-between gap-3">
        <details className="min-w-0 flex-1">
          <summary className="cursor-pointer text-meta text-slate">Setup instructions</summary>
          <div className="mt-2">
            {executionOf(host) === "host" ? (
              <NativeSetupInstructions />
            ) : (
              <p className="text-meta text-mute">
                Set up and start the Firetower worker container on this machine yourself. Install
                missing tools inside that container, then check again. The selected agent must be
                installed in that environment.
              </p>
            )}
          </div>
        </details>
        <button
          type="button"
          disabled={report.isFetching || connect.isPending}
          onClick={() => void checkAgain().catch(() => {})}
          className="text-meta text-slate disabled:opacity-50"
        >
          Check again
        </button>
      </div>
      {connect.error && (
        <p role="alert" className="text-meta text-brick">
          {connect.error.message}
        </p>
      )}
    </section>
  );
}

"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListRepos,
  useDeleteRepo,
  getListReposQueryKey,
} from "@/src/api/generated/repos/repos";
import { useListSessions } from "@/src/api/generated/sessions/sessions";
import { ConnectRepo } from "@/components/ConnectRepo";
import { RepoSettings } from "@/components/RepoSettings";
import { ApiError } from "@/src/api/http";

export default function Repos() {
  const [connecting, setConnecting] = useState(false);
  /** The repository being configured, if any. */
  const [settling, setSettling] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const { data: repos = [], isLoading } = useListRepos();
  const { data: sessions = [] } = useListSessions();
  const disconnect = useDeleteRepo();

  const forget = (id: string) => {
    setRefused(null);
    disconnect.mutate(
      { id },
      {
        // The server refuses while sessions are still running on it and says
        // which ones, so show that rather than a generic failure.
        onError: (e) => setRefused(e instanceof ApiError ? e.message : "Couldn't disconnect it."),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: getListReposQueryKey() }),
      },
    );
  };

  return (
    <div className="max-w-[900px] px-8 pt-8 pb-24">
      <header className="mb-7">
        <div className="eyebrow">Repositories</div>
        <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-bone">
          {isLoading ? "Looking…" : `${repos.length} connected.`}
        </h1>
        <p className="mt-1.5 max-w-[54ch] text-[14px] text-dim">
          Each host keeps a mirror, so a new session gets a worktree in under a second
          instead of a fresh clone.
        </p>
      </header>

      <div className="flex flex-col gap-2.5">
        {repos.map((r) => {
          const count = sessions.filter((s) => s.repo === r.slug).length;
          return (
            <div key={r.id} className="panel px-4 py-3.5">
              <div className="flex items-center gap-3">
                <span className="font-mono text-[13.5px] text-bone">{r.slug}</span>
                <span className="rounded-[4px] border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-slate">
                  {r.defaultBranch ? `⑂ ${r.defaultBranch}` : "not read yet"}
                </span>
                <span className="ml-auto font-mono text-[11px] text-mute">
                  {count} {count === 1 ? "session" : "sessions"}
                </span>
                <button
                  onClick={() => setSettling(r.id)}
                  className="text-[11.5px] text-mute transition-colors hover:text-ember"
                >
                  Settings
                </button>
                <button
                  onClick={() => forget(r.id)}
                  className="text-[11.5px] text-mute transition-colors hover:text-ember"
                >
                  Disconnect
                </button>
              </div>
              <div className="mt-3 grid grid-cols-[110px_1fr] items-center gap-3 border-t border-line pt-3">
                <span className="eyebrow">Remote</span>
                <code className="truncate font-mono text-[11.5px] text-dim">{r.remote}</code>
                <span className="eyebrow">Setup</span>
                <code className="font-mono text-[11.5px] text-dim">
                  {r.setup ?? <span className="text-mute">nothing to run</span>}
                </code>
                <span className="eyebrow">Environment</span>
                <span className="font-mono text-[11.5px] text-dim">
                  {r.env && r.env.length > 0 ? (
                    <>
                      {r.env.length} {r.env.length === 1 ? "variable" : "variables"}
                      {r.envFile && <span className="text-mute"> · written to {r.envFile}</span>}
                    </>
                  ) : (
                    <span className="text-mute">none</span>
                  )}
                </span>
              </div>
            </div>
          );
        })}

        {refused && (
          <p className="rounded-[6px] border border-ember/30 bg-ember/[0.05] px-3.5 py-2.5 text-[12.5px] text-bone">
            {refused}
          </p>
        )}

        {!isLoading && repos.length === 0 && (
          <p className="panel px-4 py-6 text-center text-[13px] text-mute">
            No repositories yet. Connect one and Firetower mirrors it on first use.
          </p>
        )}
      </div>

      <button
        onClick={() => setConnecting(true)}
        className="mt-4 w-full rounded-[6px] border border-dashed border-line py-3 text-[13px] text-mute transition-colors hover:border-ember/40 hover:text-ember"
      >
        + Connect a repository
      </button>

      {connecting && <ConnectRepo onClose={() => setConnecting(false)} />}

      {settling && repos.find((r) => r.id === settling) && (
        <RepoSettings
          repo={repos.find((r) => r.id === settling)!}
          onClose={() => setSettling(null)}
        />
      )}
    </div>
  );
}

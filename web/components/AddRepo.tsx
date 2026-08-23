"use client";

import { useEffect, useState } from "react";
import { useListRepos } from "@/src/api/generated/repos/repos";
import { useAddRepo } from "@/src/api/generated/sessions/sessions";
import type { Session } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";

/**
 * Check another repository into a session that is already running.
 *
 * The same work as bringing one up: fetch, cut the worktree on this session's
 * branch, and tell the agent where it landed. It takes as long as a clone, so
 * the sheet says what is happening rather than closing on the press.
 */
export function AddRepo({
  session,
  onClose,
  onAdded,
}: {
  session: Session;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { data: repos = [] } = useListRepos();
  const add = useAddRepo();
  const [search, setSearch] = useState("");
  const [trouble, setTrouble] = useState<string | null>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !add.isPending && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [add.isPending, onClose]);

  const held = new Set((session.checkouts ?? []).map((c) => c.slug));
  const offered = repos.filter(
    (r) => !held.has(r.slug) && r.slug.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && !add.isPending && onClose()}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ground/70 p-4 backdrop-blur-[2px]"
    >
      <div className="flex max-h-[70vh] w-full max-w-[480px] flex-col overflow-hidden rounded-[14px] border border-line bg-panel">
        <header className="shrink-0 border-b border-line px-4 py-3">
          <p className="text-[14px] font-semibold text-bone">Check in another repository</p>
          <p className="mt-1 text-meta text-mute">
            It is cut on <span className="font-mono">{session.branch}</span>, beside what is
            already here, and the agent is told where it landed.
          </p>
        </header>

        <div className="shrink-0 px-3 pt-3">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repositories"
            disabled={add.isPending}
            className="w-full rounded-[8px] border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-ember focus:outline-none disabled:opacity-50"
          />
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {offered.length === 0 && (
            <li className="px-2.5 py-3 text-[13px] text-mute">
              {repos.length === 0
                ? "Nothing is connected yet."
                : "Everything connected is already in this session."}
            </li>
          )}
          {offered.map((r) => (
            <li key={r.id}>
              <button
                disabled={add.isPending}
                onClick={() =>
                  add.mutate(
                    { id: session.id, data: { repoId: r.id } },
                    {
                      onSuccess: () => {
                        onAdded();
                        onClose();
                      },
                      onError: (e) =>
                        setTrouble(
                          e instanceof ApiError ? e.message : "That didn't work.",
                        ),
                    },
                  )
                }
                className="w-full rounded-[8px] px-2.5 py-2 text-left font-mono text-[13px] text-text transition-colors hover:bg-raise disabled:opacity-40"
              >
                {r.slug}
              </button>
            </li>
          ))}
        </ul>

        {add.isPending && (
          <p className="shrink-0 border-t border-line px-4 py-2.5 text-meta text-dim">
            Fetching and cutting the worktree. This takes as long as a clone.
          </p>
        )}
        {trouble && (
          <p className="shrink-0 border-t border-line px-4 py-2.5 text-meta text-brick">
            {trouble}
          </p>
        )}
      </div>
    </div>
  );
}

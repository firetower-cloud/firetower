"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetIdentity,
  useSetIdentity,
  useClearIdentity,
  getGetIdentityQueryKey,
} from "@/src/api/generated/providers/providers";
import { ApiError } from "@/src/api/http";

/**
 * What your commits are authored as.
 *
 * On this page because it belongs to the git host rather than to your account:
 * signing in to Firetower and being credited for a commit are two different
 * facts about two different things, and somebody with a work address whose
 * GitHub is under another one needs them to stay apart.
 *
 * Firetower can answer this without being asked — it reads the account your
 * token belongs to — so this exists for when that answer is the wrong one.
 * What is typed here is never replaced by what the host says, because the
 * reason to type it is that the host's answer was not the address you wanted
 * on your branches.
 */
export function GitIdentity({ provider, label }: { provider: string; label: string }) {
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [failed, setFailed] = useState<string | null>(null);

  // 404 while the host is unauthorized and there is nothing to derive one
  // from, which is a state to describe rather than an error to report.
  const { data: identity, isLoading } = useGetIdentity(provider, {
    query: { retry: false },
  });

  const save = useSetIdentity();
  const clear = useClearIdentity();

  const refresh = () =>
    cache.invalidateQueries({ queryKey: getGetIdentityQueryKey(provider) });

  const failure = (e: unknown) =>
    setFailed(e instanceof ApiError ? e.message : "That didn't work.");

  const open = () => {
    setFailed(null);
    setName(identity?.name ?? "");
    setEmail(identity?.email ?? "");
    setEditing(true);
  };

  if (isLoading) return null;

  return (
    <div className="panel mt-2.5 px-4 py-3.5">
      <div className="flex items-baseline gap-3">
        <span className="eyebrow">Commits are authored as</span>
        {identity && (
          <span className="font-mono text-[11px] text-mute">
            {identity.source === "set" ? "yours" : `from ${label}`}
          </span>
        )}
        {!editing && (
          <button
            onClick={open}
            className="ml-auto text-[11.5px] text-mute transition-colors hover:text-ember"
          >
            {identity ? "Change" : "Set one"}
          </button>
        )}
      </div>

      {!editing && (
        <p className="mt-1.5 font-mono text-[12.5px] text-dim">
          {identity ? (
            <>
              {identity.name} &lt;{identity.email}&gt;
            </>
          ) : (
            // Not an error: a session still commits, under a name that says
            // nobody in particular, and the branch still pushes.
            <span className="text-mute">
              Nothing yet — authorize {label}, or set a name and address here.
              Until then commits are authored as Firetower.
            </span>
          )}
        </p>
      )}

      {editing && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              className="min-h-[36px] flex-1 rounded-[7px] border border-line bg-ground px-2.5 text-[13px] text-bone placeholder:text-mute focus:border-ember focus:outline-none"
            />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="min-h-[36px] flex-1 rounded-[7px] border border-line bg-ground px-2.5 font-mono text-[12.5px] text-bone placeholder:text-mute focus:border-ember focus:outline-none"
            />
          </div>

          {/* The thing that bites people, said before it does. */}
          <p className="text-[11.5px] leading-[1.5] text-mute">
            Use an address {label} knows about. With <em>Keep my email address
            private</em> switched on, a push authored with your real one is
            refused — the <code className="font-mono">users.noreply</code>{" "}
            address always works.
          </p>

          {failed && <p className="text-[12px] text-brick">{failed}</p>}

          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                setFailed(null);
                save.mutate(
                  { id: provider, data: { name: name.trim(), email: email.trim() } },
                  {
                    onSuccess: () => {
                      setEditing(false);
                      refresh();
                    },
                    onError: failure,
                  },
                );
              }}
              disabled={!name.trim() || !email.trim() || save.isPending}
              className="rounded-[6px] bg-ember px-3 py-1.5 text-[12.5px] font-medium text-ground disabled:opacity-40"
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-[12px] text-mute transition-colors hover:text-text"
            >
              Cancel
            </button>

            {identity?.source === "set" && (
              <button
                onClick={() => {
                  setFailed(null);
                  clear.mutate(
                    { id: provider },
                    {
                      onSuccess: () => {
                        setEditing(false);
                        refresh();
                      },
                      onError: failure,
                    },
                  );
                }}
                disabled={clear.isPending}
                className="ml-auto text-[12px] text-mute transition-colors hover:text-brick"
              >
                Use {label}&apos;s answer instead
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

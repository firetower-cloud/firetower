/**
 * What is checked out in this workspace, and checking another one in.
 *
 * A workspace is a directory with one worktree per repository, and until now
 * the only place that was ever said was the form that created it. After that
 * the client drew one branch on the status bar and the second and third
 * repository were invisible — so a session that came up with two of three had
 * nothing on screen saying which one was missing, and adding one meant
 * starting the workspace again.
 *
 * Both halves are one panel because they are one question. The list says what
 * is on disk; the picker adds to it. `POST /sessions/{id}/repos` is the same
 * code path as bring-up — it fetches, cuts the worktree on this workspace's
 * branch and tells the agent where it landed — so it takes as long as a clone
 * and the panel says so rather than closing on the press.
 *
 * Checkouts are the *workspace's*, not the agent's: the server writes them to
 * `workspace_repos` against whichever session asked. So this is addressed to a
 * session and true of the place, and every session's view of it is refreshed
 * afterwards.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, GitBranch, Loader2, Plus, Search } from "lucide-react";
import { GithubMark } from "~/components/ui";
import type { Checkout, CheckoutWork, Session } from "~/api/generated/model";
import {
  addRepo,
  getGetSessionQueryKey,
  getListSessionsQueryKey,
  getSessionWorkQueryKey,
  useSessionWork,
} from "~/api/generated/sessions/sessions";
import { beginCheckout, howItIsDoing, markCheckout } from "~/api/checkouts";
import { useRepos, why } from "~/data";
import { openExternal } from "~/open";

export function Repositories({
  session,
  branch,
  onClose,
}: {
  /** The session asked. Its checkouts are the workspace's. */
  session: Session;
  branch?: string;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const repos = useRepos();
  const ended = session.status === "Ended";
  const checkouts = useMemo(() => session.checkouts ?? [], [session.checkouts]);
  const { data: work } = useSessionWork(session.id, {
    query: { enabled: !ended, refetchInterval: 30_000, retry: false },
  });

  const [picking, setPicking] = useState(checkouts.length === 0);
  const [wanted, setWanted] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  /* A base other than the repository's own default, for the few times that is
     wanted. Only ever written by the control on a chosen row, so an empty map
     is the ordinary case and means "each repository's default". */
  const [bases, setBases] = useState<Record<string, string>>({});
  /* What the run of clones is doing, per repository. Kept by slug so a row can
     draw its own spinner rather than the whole panel going grey. */
  const [doing, setDoing] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const busy = doing !== null;
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (busy) return;
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [busy, onClose]);

  const held = useMemo(() => new Set(checkouts.map((c) => c.slug)), [checkouts]);
  const needle = wanted.trim().toLowerCase();
  const offered = useMemo(
    () => repos.data.filter((r) => !held.has(r.slug) && (!needle || r.slug.toLowerCase().includes(needle))),
    [repos.data, held, needle],
  );

  const toggle = (id: string) =>
    setChosen((on) => (on.includes(id) ? on.filter((x) => x !== id) : [...on, id]));

  /**
   * Check the chosen repositories in, one after another.
   *
   * Sequential on purpose: each one is a fetch and a worktree on somebody's
   * machine, and three at once is three clones competing for the same disk.
   * One that fails does not stop the rest — a repository the host could not
   * reach is that repository's problem — and what failed is named at the end.
   */
  const go = async () => {
    const queue = repos.data.filter((r) => chosen.includes(r.id));
    const trouble: Record<string, string> = {};
    setFailed({});
    /* Said in the transcript as well as here. The popover is a place you are
       passing through; the conversation is where this workspace's history is
       kept, and checking a repository in belongs in it. */
    const run = beginCheckout(session.id, queue.map((r) => r.slug));
    for (const repo of queue) {
      setDoing(repo.slug);
      markCheckout(session.id, run, repo.slug, "fetching");
      try {
        const done = await addRepo(session.id, { repoId: repo.id, base: bases[repo.id]?.trim() || undefined });
        markCheckout(session.id, run, repo.slug, "done", done.detail);
        setChosen((on) => on.filter((x) => x !== repo.id));
      } catch (e) {
        trouble[repo.slug] = why(e);
        setFailed({ ...trouble });
        markCheckout(session.id, run, repo.slug, "failed", why(e));
      }
    }
    setDoing(null);
    await Promise.all([
      cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) }),
      cache.invalidateQueries({ queryKey: getListSessionsQueryKey() }),
      cache.invalidateQueries({ queryKey: getSessionWorkQueryKey(session.id) }),
    ]);
    /* Stay here while something is still wrong. Going back to the list would
       draw a workspace with one repository missing and no reason given — the
       press would read as having done nothing. */
    if (Object.keys(trouble).length === 0) {
      setPicking(false);
      setWanted("");
    }
  };

  const chosenCount = chosen.length;

  return (
    <div
      ref={box}
      /* This hangs off the toolbar, and the toolbar is a drag region: without
         this, pressing the panel's heading — anywhere that is not a control —
         picks the window up and moves it. `src/drag.ts` lets controls through
         by looking for one under the pointer, which a paragraph is not. */
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute top-full left-0 z-40 mt-1.5 w-[24rem] overflow-hidden rounded-xl border border-line bg-overlay shadow-(--shadow-float)"
    >
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
        {picking && checkouts.length > 0 && (
          <button
            onClick={() => setPicking(false)}
            disabled={busy}
            className="grid h-5 w-5 place-items-center rounded text-mute hover:bg-raise hover:text-bone disabled:opacity-40"
            title="Back to what is checked out"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        )}
        <span className="text-ui text-bone">{picking ? "Add repositories" : "Repositories"}</span>
        {!picking && (
          <span className="ml-auto font-mono text-micro text-mute">
            {checkouts.length} checked out
          </span>
        )}
      </div>

      {picking ? (
        <>
          <p className="px-3.5 pb-2.5 text-meta text-mute">
            Fetched beside what is here and cut on{" "}
            <span className="font-mono text-dim">{branch ?? "this branch"}</span>, from each
            repository&rsquo;s own default — press a branch to cut from another. The agent is
            told where they landed.
          </p>

          <div className="flex items-center gap-2 border-y border-line-soft px-3.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
            <input
              autoFocus
              value={wanted}
              onChange={(e) => setWanted(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && offered[0] && !busy) toggle(offered[0].id);
              }}
              disabled={busy}
              placeholder="Find a repository"
              className="w-full bg-transparent py-2 text-ui text-bone placeholder:text-mute focus:outline-none disabled:opacity-50"
            />
          </div>

          <ul className="scroll-slim max-h-64 overflow-y-auto py-1">
            {offered.length === 0 && (
              <li className="px-3.5 py-3 text-meta text-mute">
                {repos.loading
                  ? "Reading your repositories…"
                  : repos.data.length === 0
                    ? "Nothing is connected yet. Configuration → Repositories."
                    : needle
                      ? "No repository matches."
                      : "Everything connected is already in this workspace."}
              </li>
            )}
            {offered.map((r) => {
              const on = chosen.includes(r.id);
              const running = doing === r.slug;
              return (
                <li key={r.id} className="transition-colors hover:bg-raise/70">
                  {/* The row is two controls, not one: picking the repository
                      and saying what to cut it from are different decisions,
                      and the second only exists once the first is made. */}
                  <div className="flex items-center gap-2.5 px-3.5 py-1.5">
                    <button
                      disabled={busy}
                      onClick={() => toggle(r.id)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:opacity-60"
                    >
                      <span
                        className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
                          on ? "border-sage-deep bg-sage-tint text-sage" : "border-line text-transparent"
                        }`}
                      >
                        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 fill-none stroke-current stroke-2">
                          <path d="M1.5 5.2 4 7.5 8.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                      <GithubMark size={12} className="text-mute" />
                      <span className="min-w-0 flex-1 truncate font-mono text-ui text-text">{r.slug}</span>
                    </button>
                    {running ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-dim" strokeWidth={2} />
                    ) : failed[r.slug] ? (
                      <span className="shrink-0 text-micro text-brick">failed</span>
                    ) : on ? (
                      <Base
                        value={bases[r.id] ?? ""}
                        fallback={r.defaultBranch ?? "default"}
                        disabled={busy}
                        onChange={(base) => setBases((held) => ({ ...held, [r.id]: base }))}
                      />
                    ) : (
                      <span className="shrink-0 font-mono text-micro text-mute">
                        {r.defaultBranch ?? "default"}
                      </span>
                    )}
                  </div>
                  {failed[r.slug] && (
                    <p className="px-3.5 pb-1.5 pl-14 text-micro text-brick">{failed[r.slug]}</p>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
            <span className="min-w-0 flex-1 truncate text-meta text-mute">
              {busy ? `Fetching ${doing}…` : "As long as a clone."}
            </span>
            <button
              disabled={chosenCount === 0 || busy || ended}
              onClick={() => void go()}
              title={ended ? "This workspace has ended." : undefined}
              className="control shrink-0 bg-bone font-medium text-ground transition-opacity hover:opacity-90 disabled:bg-raise disabled:text-mute"
            >
              {busy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                  Checking in…
                </>
              ) : chosenCount === 0 ? (
                "Check in"
              ) : (
                `Check in ${chosenCount}`
              )}
            </button>
          </div>
        </>
      ) : (
        <>
          <ul className="scroll-slim max-h-72 overflow-y-auto border-t border-line-soft py-1">
            {checkouts.map((c) => (
              <Row
                key={c.path || c.slug}
                checkout={c}
                work={(work ?? []).find((w) => (c.path ? w.path === c.path : w.slug === c.slug))}
                ended={ended}
              />
            ))}
            {checkouts.length === 0 && (
              <li className="px-3.5 py-3 text-meta text-mute">
                A bare agent — nothing is checked out here yet.
              </li>
            )}
          </ul>

          <button
            onClick={() => {
              setPicking(true);
              setChosen([]);
            }}
            disabled={ended}
            title={ended ? "This workspace has ended." : undefined}
            className="flex w-full items-center gap-2 border-t border-line px-3.5 py-2.5 text-left text-ui text-dim transition-colors hover:bg-raise hover:text-bone disabled:text-mute disabled:hover:bg-transparent"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            Add a repository to this workspace
          </button>
        </>
      )}
    </div>
  );
}

/**
 * What to cut this one from, for the few times it is not the default.
 *
 * A branch per repository is a real thing to want — the API has taken one
 * since bring-up — and it is also not why anybody opens this. So it is the
 * branch name a chosen row was already showing, made pressable: nothing new
 * appears, nothing moves, and a row nobody presses reads exactly as it did.
 */
function Base({
  value,
  fallback,
  disabled,
  onChange,
}: {
  value: string;
  fallback: string;
  disabled: boolean;
  onChange: (base: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={value}
        onBlur={(e) => {
          onChange(e.target.value.trim());
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
          // The panel closes on Escape and the list acts on Enter; neither is
          // what either key means while a branch is being typed.
          e.stopPropagation();
        }}
        placeholder={fallback}
        spellCheck={false}
        className="w-28 shrink-0 rounded border border-line bg-ground px-1.5 py-0.5 text-right font-mono text-micro text-bone placeholder:text-mute focus:outline-none"
      />
    );
  }

  return (
    <button
      disabled={disabled}
      onClick={() => setEditing(true)}
      title="The branch to cut from"
      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-micro transition-colors hover:bg-overlay hover:text-dim disabled:opacity-60 ${
        value ? "text-slate" : "text-mute"
      }`}
    >
      {value || fallback}
    </button>
  );
}

/** One checked-out repository: where it is, what branch, and how it is doing. */
function Row({ checkout, work, ended }: { checkout: Checkout; work?: CheckoutWork; ended: boolean }) {
  /* Its own trouble beats the workspace's: a repository the host could not
     reach is not a workspace that failed, and saying which one is missing is
     the whole reason the list exists. */
  const trouble = checkout.trouble ?? work?.trouble ?? null;
  const said = howItIsDoing(work, ended);
  const link = checkout.pullRequest ?? work?.pullRequest ?? null;

  return (
    <li>
      <div className="flex items-start gap-2.5 px-3.5 py-1.5">
        <GithubMark size={12} className={`mt-1 ${trouble ? "text-brick" : "text-mute"}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 truncate font-mono text-ui text-bone">{checkout.slug}</span>
            <span className="shrink-0 font-mono text-micro text-mute">
              ./{checkout.path || "."}
            </span>
          </span>
          {trouble ? (
            <span className="block text-micro text-brick">{trouble}</span>
          ) : (
            <span className="flex items-center gap-1.5 text-micro text-mute">
              <GitBranch className="h-3 w-3 shrink-0" strokeWidth={1.75} />
              <span className="min-w-0 truncate font-mono">{checkout.branch}</span>
              <span className="shrink-0">·</span>
              <span className={`shrink-0 ${said.tone}`}>{said.text}</span>
            </span>
          )}
        </span>
        {link && (
          <button
            onClick={() => void openExternal(link)}
            title="Open the pull request"
            className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-micro text-mute transition-colors hover:bg-raise hover:text-bone"
          >
            PR ↗
          </button>
        )}
      </div>
    </li>
  );
}

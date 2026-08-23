"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useSessionDiff,
  useCommitSession,
  usePushSession,
  useOpenPullRequest,
  useDescribeSession,
  getSessionWorkQueryKey,
  getGetSessionQueryKey,
} from "@/src/api/generated/sessions/sessions";
import type { CheckoutWork, FileDiff, Session } from "@/src/api/generated/model";
import { shipping } from "@/src/api/ship";
import { ApiError } from "@/src/api/http";

/**
 * Everything between "it finished" and "it is on GitHub", on one surface.
 *
 * The work used to be spread across a tab, a menu and a prompt box: read the
 * diff over there, come back, find the actions, press push, press open, then
 * type a title because the API insists on one. Six moves, two of them
 * navigation, and nothing on screen ever said which one was next.
 *
 * Here the diff, the description and the decision are in one place, and the
 * button says exactly what pressing it will do.
 */
export function Review({
  session,
  work,
  onClose,
}: {
  session: Session;
  work?: CheckoutWork[];
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const { data: files = [], isLoading } = useSessionDiff(session.id, undefined, {
    query: { refetchInterval: 15_000 },
  });

  const commit = useCommitSession();
  const push = usePushSession();
  const open = useOpenPullRequest();
  const describe = useDescribeSession();

  const [title, setTitle] = useState(session.proposedTitle ?? "");
  const [body, setBody] = useState(session.proposedBody ?? "");
  const [draft, setDraft] = useState(false);
  const [looking, setLooking] = useState<string | null>(null);
  /** Files left out. Everything is in by default — that is what finishing means. */
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [trouble, setTrouble] = useState<string | null>(null);

  const ship = shipping(session, work);
  const busy = commit.isPending || push.isPending || open.isPending;

  // Escape closes, because this is a sheet over the session rather than a page.
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, onClose]);

  const keeping = files.filter((f) => !dropped.has(f.path));
  const totals = useMemo(
    () => ({
      added: keeping.reduce((n, f) => n + f.added, 0),
      removed: keeping.reduce((n, f) => n + f.removed, 0),
    }),
    [keeping],
  );

  const showing = files.find((f) => f.path === looking) ?? files[0];

  const refresh = () => {
    cache.invalidateQueries({ queryKey: getSessionWorkQueryKey(session.id) });
    cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) });
  };

  const failed = (e: unknown) =>
    setTrouble(e instanceof ApiError ? e.message : "That didn't work.");

  /** One press, however many steps it takes from here. */
  const go = async () => {
    setTrouble(null);
    try {
      if (ship.stage === "open" && ship.url && !work?.some((c) => c.ahead > 0)) {
        window.open(ship.url, "_blank", "noreferrer");
        return;
      }
      if (ship.stage === "uncommitted") {
        if (!title.trim()) {
          setTrouble("A commit needs a message. The title is used as one.");
          return;
        }
        await commit.mutateAsync({
          id: session.id,
          data: { message: title.trim(), paths: keeping.map((f) => f.path) },
        });
      }
      if (ship.stage === "uncommitted" || ship.stage === "unpushed" || ship.stage === "open") {
        await push.mutateAsync({ id: session.id });
      }
      if (ship.stage !== "open") {
        const made = await open.mutateAsync({
          id: session.id,
          data: { title: title.trim(), body: body.trim(), draft },
        });
        window.open(made.url, "_blank", "noreferrer");
      }
      refresh();
      onClose();
    } catch (e) {
      failed(e);
      refresh();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Review changes"
      className="fixed inset-0 z-50 flex items-stretch bg-ground/80 backdrop-blur-[2px] sm:items-center sm:justify-center sm:p-6"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="flex h-full w-full flex-col overflow-hidden border border-line bg-panel sm:h-[min(88vh,900px)] sm:max-w-[1100px] sm:rounded-[12px]">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
          <span className="text-[13.5px] font-semibold text-bone">Review</span>
          <span className="font-mono text-[11.5px] text-mute">
            {keeping.length} {keeping.length === 1 ? "file" : "files"}
            {" · "}
            <span className="text-sage">+{totals.added}</span>
            {" "}
            <span className="text-brick">−{totals.removed}</span>
            {dropped.size > 0 && <span className="text-mute"> · {dropped.size} left out</span>}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded-[6px] px-2 py-1 text-[13px] text-mute transition-colors hover:bg-raise hover:text-text"
          >
            ✕
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr] overflow-hidden md:grid-cols-[260px_1fr] md:grid-rows-1">
          {/* Which files, and which of them are going. */}
          <div className="min-h-0 overflow-y-auto border-b border-line md:border-r md:border-b-0">
            {isLoading && <p className="p-4 text-[12.5px] text-mute">Reading the workspace…</p>}
            {!isLoading && files.length === 0 && (
              <p className="p-4 text-[12.5px] text-mute">Nothing has changed.</p>
            )}
            {/* Grouped by repository, because a session holds any number of
                them and `src/index.ts` in two of them is two different files.
                One repository draws no heading — there is nothing to tell
                apart. */}
            {byRepo(files, work).map((group) => (
              <div key={group.slug || "."}>
                {group.slug && (
                  <div className="flex items-baseline gap-2 px-3 pt-3 pb-1">
                    <span className="eyebrow">{group.slug}</span>
                    <span className="font-mono text-[11px] text-mute">
                      <span className="text-sage">+{group.added}</span>{" "}
                      <span className="text-brick">−{group.removed}</span>
                    </span>
                  </div>
                )}
                <ul className="py-1">
                  {group.files.map((file) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      // The heading says which repository, so the row says the
                      // path inside it.
                      label={group.path ? file.path.slice(group.path.length + 1) : file.path}
                      chosen={!dropped.has(file.path)}
                      looking={showing?.path === file.path}
                      onLook={() => setLooking(file.path)}
                      onToggle={() =>
                        setDropped((held) => {
                          const next = new Set(held);
                          if (next.has(file.path)) next.delete(file.path);
                          else next.add(file.path);
                          return next;
                        })
                      }
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="min-h-0 overflow-auto">
            {showing ? (
              <Patch file={showing} />
            ) : (
              <p className="p-4 text-[12.5px] text-mute">Pick a file to see what changed.</p>
            )}
          </div>
        </div>

        <footer className="shrink-0 border-t border-line p-3">
          <div className="flex items-center gap-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title — used for the commit and the pull request"
              className="min-h-[38px] flex-1 rounded-[7px] border border-line bg-ground px-2.5 text-[13px] text-text placeholder:text-mute focus:border-ember focus:outline-none"
            />
            <button
              onClick={() =>
                describe.mutate(
                  { id: session.id },
                  {
                    onSuccess: (p) => {
                      setTitle(p.title);
                      setBody(p.body);
                    },
                    onError: failed,
                  },
                )
              }
              disabled={describe.isPending}
              title="Ask the agent to describe the change"
              className="min-h-[38px] shrink-0 rounded-[7px] border border-line px-2.5 text-[12px] text-dim transition-colors hover:text-bone disabled:opacity-40"
            >
              {describe.isPending ? "Asking…" : "Rewrite"}
            </button>
          </div>

          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="What changed and why, for whoever reviews it"
            className="mt-2 w-full resize-none rounded-[7px] border border-line bg-ground px-2.5 py-2 text-[12.5px] leading-[1.5] text-text placeholder:text-mute focus:border-ember focus:outline-none"
          />

          {(session.proposedTitle || session.proposedBody) && (
            <p className="mt-1 text-[11px] text-mute">
              Written by the agent when it finished. Edit freely.
            </p>
          )}

          {/* Reported here rather than as a toast: a refused push is something
              to read and act on, and a message that disappears is neither. */}
          {trouble && (
            <p className="mt-2 rounded-[6px] border border-brick/40 bg-ground px-2.5 py-2 text-[12px] text-brick">
              {trouble}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="font-mono text-[11.5px] text-mute">
              ⑂ {session.branch}
              {(work?.length ?? 0) > 1 && ` · ${work?.length} repositories`}
            </span>
            {ship.stage !== "open" && (
              <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-dim">
                <input
                  type="checkbox"
                  checked={draft}
                  onChange={(e) => setDraft(e.target.checked)}
                  className="accent-ember"
                />
                Draft
              </label>
            )}
            <button
              onClick={go}
              disabled={busy || (keeping.length === 0 && ship.stage === "uncommitted")}
              className="ml-auto min-h-[40px] rounded-[7px] bg-ember px-4 text-[13px] font-medium text-ground transition-opacity disabled:opacity-40"
            >
              {busy ? "Working…" : ship.label}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/**
 * The files, under the repository each came from.
 *
 * The server prefixes every path with its checkout's directory when a session
 * holds more than one, so grouping is a matter of reading that prefix back off.
 * A session with one repository has no prefix and gets one unlabelled group,
 * which is the same list it always had.
 */
function byRepo(files: FileDiff[], work?: CheckoutWork[]) {
  const held = (work ?? []).filter((c) => c.path);
  if (held.length < 2) {
    return [
      {
        slug: "",
        path: "",
        files,
        added: files.reduce((n, f) => n + f.added, 0),
        removed: files.reduce((n, f) => n + f.removed, 0),
      },
    ];
  }

  return held
    .map((c) => {
      const mine = files.filter((f) => f.path.startsWith(`${c.path}/`));
      return {
        slug: c.slug,
        path: c.path,
        files: mine,
        added: mine.reduce((n, f) => n + f.added, 0),
        removed: mine.reduce((n, f) => n + f.removed, 0),
      };
    })
    .filter((group) => group.files.length > 0);
}

/** One file, and whether it is going. */
function FileRow({
  file,
  label,
  chosen,
  looking,
  onLook,
  onToggle,
}: {
  file: FileDiff;
  /** What to call it here, which is its path inside its own repository. */
  label: string;
  chosen: boolean;
  looking: boolean;
  onLook: () => void;
  onToggle: () => void;
}) {
  const name = label.split("/").pop() ?? label;
  const where = label.slice(0, label.length - name.length);

  return (
    <li className={`flex items-center gap-2 px-2.5 py-1 ${looking ? "bg-raise" : ""}`}>
      <input
        type="checkbox"
        checked={chosen}
        onChange={onToggle}
        aria-label={`Include ${file.path}`}
        className="shrink-0 accent-ember"
      />
      <button onClick={onLook} className="min-w-0 flex-1 text-left">
        <span
          className={`block truncate font-mono text-[12px] ${
            chosen ? "text-text" : "text-mute line-through"
          }`}
          title={file.path}
        >
          <span className="text-mute">{where}</span>
          {name}
        </span>
      </button>
      <span className="shrink-0 font-mono text-[10.5px]">
        <span className="text-sage">+{file.added}</span>{" "}
        <span className="text-brick">−{file.removed}</span>
      </span>
    </li>
  );
}

/**
 * One file's hunks, coloured.
 *
 * Rendered from the patch git printed rather than re-derived: it is already
 * correct, and a second implementation of "what changed" is a second thing to
 * be subtly wrong.
 */
function Patch({ file }: { file: FileDiff }) {
  return (
    <div>
      <div className="sticky top-0 border-b border-line bg-panel px-3 py-2 font-mono text-[11.5px] text-dim">
        {file.path}
      </div>
      <pre className="px-3 py-2 font-mono text-[11.5px] leading-[1.5]">
        {file.patch.split("\n").map((line, i) => (
          <div
            key={i}
            className={
              line.startsWith("+") && !line.startsWith("+++")
                ? "text-sage"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "text-brick"
                  : line.startsWith("@@")
                    ? "text-slate"
                    : "text-mute"
            }
          >
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

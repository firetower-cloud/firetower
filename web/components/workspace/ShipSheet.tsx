"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import {
  useCommitSession,
  usePushSession,
  useOpenPullRequest,
  useDescribeSession,
  getSessionWorkQueryKey,
  getGetSessionQueryKey,
} from "@/src/api/generated/sessions/sessions";
import type { Session } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";
import { Modal } from "@/components/Modal";
import { Icon, Segmented } from "@/components/ui";
import { Markdown } from "@/components/Markdown";
import { sequence, type Ship } from "@/src/api/ship";
import {
  fromTask,
  suggestionsFrom,
  trailerFor,
  withTrailer,
  type Reference,
} from "@/src/api/issues";
import { IssueChips } from "./IssueChips";

/**
 * Everything between "the work is done" and "it is a pull request somebody can
 * read", asked for once and confirmed once.
 *
 * ## Why this is a modal, when the review panel deliberately is not
 *
 * The panel gave up being a modal so that clicking a file could open a
 * full-width diff *tab* beside the conversation — a modal can never do that,
 * and reviewing a change is the thing you do most. This does not take that
 * back: it owns the words and never the files. The file list stays in the
 * panel, and `Review the files →` dismisses this to get back to it.
 *
 * What a modal is right for is the other half: writing a title, a body and the
 * issues it answers is one decision, made once, and confirmed. Spread down a
 * 320px rail it was four controls nobody could see at the same time as the
 * thing they describe.
 *
 * ## Why it always asks
 *
 * A description is proposed when a session hands back, and that description is
 * of the diff *as it was then*. A session that carried on working has moved
 * past it. So this asks on open, every time, rather than showing something
 * that was true twenty minutes ago — and `Write it myself` is there for
 * anybody who would rather not wait.
 */
export function ShipSheet({
  session,
  ship,
  paths,
  added,
  removed,
  dropped,
  onClose,
  onReviewFiles,
}: {
  session: Session;
  ship: Ship;
  /** What is going in, decided in the panel. */
  paths: string[];
  added: number;
  removed: number;
  dropped: number;
  onClose: () => void;
  onReviewFiles: () => void;
}) {
  const cache = useQueryClient();

  const describe = useDescribeSession();
  const commit = useCommitSession();
  const push = usePushSession();
  const open = useOpenPullRequest();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [showing, setShowing] = useState<"write" | "preview">("write");
  const [draft, setDraft] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  // The issue this workspace was cut for, known before anything is asked. It
  // comes from two columns on the session rather than from the tracker, so it
  // is on screen while the description is still being written — and stays
  // there if the tracker never answers.
  //
  // Initial state rather than an effect: it is derived from the session, which
  // is already here at first render, and an effect would paint one frame with
  // nothing linked.
  const [refs, setRefs] = useState<Reference[]>(() => {
    const bound = fromTask(
      session.taskKey,
      session.taskUrl,
      session.repo ?? undefined,
    );
    return bound ? [bound] : [];
  });
  const [suggested, setSuggested] = useState<Reference[]>([]);
  /** Which steps have happened, once the sequence is under way. */
  const [went, setWent] = useState<Step[] | null>(null);

  const first = useRef<HTMLInputElement>(null);
  const asked = useRef(false);
  /**
   * Whether somebody gave up waiting and started writing.
   *
   * `reset()` on the mutation clears its state but does not call the request
   * back — it is already on its way to a host that will answer in its own
   * time. Without this, pressing "Write it myself", typing a title, and having
   * the run land ten seconds later replaces what was just written.
   */
  const abandoned = useRef(false);

  /** The repository a bare `#32` belongs to. */
  const within = session.repo ?? undefined;
  const slugs = useMemo(
    () => (session.checkouts ?? []).map((c) => c.slug),
    [session.checkouts],
  );

  const failed = (e: unknown) =>
    setTrouble(e instanceof ApiError ? e.message : "That didn't work.");

  /** Ask the host to describe the change. Called on open, and by Regenerate. */
  const ask = () => {
    setTrouble(null);
    // Regenerate is somebody asking again on purpose, so the answer is wanted.
    abandoned.current = false;
    describe.mutate(
      { id: session.id },
      {
        onSuccess: (p) => {
          if (abandoned.current) return;
          setTitle(p.title);
          setBody(p.body);
          setSuggested((held) =>
            suggestionsFrom(p.issues, refs, within).filter(
              (s) =>
                !held.some((h) => h.number === s.number && h.repo === s.repo),
            ),
          );
          window.setTimeout(() => first.current?.focus(), 0);
        },
        // Not fatal, and not a dead end: the boxes are editable and the
        // sequence still works. A machine that cannot describe a change can
        // still push one.
        onError: (e) => {
          if (abandoned.current) return;
          failed(e);
          window.setTimeout(() => first.current?.focus(), 0);
        },
      },
    );
  };

  // Once, on open. `asked` rather than an empty dependency list because React
  // in development mounts twice, and asking twice spends two runs on a host to
  // answer one question.
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    ask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const writing = describe.isPending;
  const busy = commit.isPending || push.isPending || open.isPending;
  const opening =
    ship.stage === "uncommitted" ||
    ship.stage === "unpushed" ||
    ship.stage === "pushed";

  const refresh = () => {
    cache.invalidateQueries({ queryKey: getSessionWorkQueryKey(session.id) });
    cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) });
  };

  /** One press, however many steps it takes from here. */
  const go = async () => {
    if (!title.trim()) {
      setTrouble("A commit needs a message. The title is used as one.");
      return;
    }
    setTrouble(null);

    const steps: Step[] = [];
    // Keyed on the step, not on what it currently says — the label changes
    // from "Committing" to "Committed" as it finishes, and matching on that
    // appends a second row instead of settling the first.
    const mark = (
      id: Step["id"],
      what: string,
      state: Step["state"],
      detail?: string,
    ) => {
      const at = steps.findIndex((s) => s.id === id);
      if (at >= 0) steps[at] = { id, what, state, detail };
      else steps.push({ id, what, state, detail });
      setWent([...steps]);
    };

    const branch = session.branch ?? "the branch";

    try {
      if (ship.stage === "uncommitted") {
        mark("commit", `Committing ${paths.length} files`, "doing");
        await commit.mutateAsync({
          id: session.id,
          data: { message: title.trim(), paths },
        });
        mark("commit", `Committed ${paths.length} files`, "done");
      }
      if (
        ship.stage === "uncommitted" ||
        ship.stage === "unpushed" ||
        ship.stage === "open-behind"
      ) {
        mark("push", `Pushing ${branch}`, "doing");
        await push.mutateAsync({ id: session.id });
        mark("push", `Pushed ${branch}`, "done");
      }
      if (opening) {
        mark("open", "Opening the pull request", "doing");
        const made = await open.mutateAsync({
          id: session.id,
          data: {
            title: title.trim(),
            // The trailer is added here, at the last moment, so what is in the
            // box stays the prose somebody wrote. What gets appended is on
            // screen above the button.
            body: withTrailer(body, refs, within),
            draft,
          },
        });
        mark("open", "Opened the pull request", "done");
        window.open(made.url, "_blank", "noreferrer");
      }
      refresh();
      onClose();
    } catch (e) {
      const last = steps.findIndex((s) => s.state === "doing");
      if (last >= 0) {
        steps[last] = {
          ...steps[last],
          state: "failed",
          detail: e instanceof ApiError ? e.message : "That didn't work.",
        };
        setWent([...steps]);
      }
      failed(e);
      refresh();
    }
  };

  const kind = title.trim().match(/^(\w+)(\([^)]*\))?!?:/)?.[1];
  const trailer = trailerFor(refs, within);

  return (
    <Modal title="Commit & open pull request" onClose={onClose} wide>
      <div
        onKeyDown={(e) => {
          // From anywhere in the sheet, including the body — a description is
          // typed in a textarea, and having to reach for the mouse to send it
          // is the reason people stop writing them.
          if (
            e.key === "Enter" &&
            (e.metaKey || e.ctrlKey) &&
            !busy &&
            !writing &&
            !went
          ) {
            e.preventDefault();
            void go();
          }
        }}
      >
        <p className="-mt-1 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-mute">
          <span className="truncate">
            {slugs.length > 1
              ? `${slugs.length} repositories`
              : (session.repo ?? "no repository")}
          </span>
          <span className="truncate font-mono text-micro">
            ⑂ {session.branch}
            {session.base ? ` → ${session.base}` : ""}
          </span>
        </p>

        {went ? (
          <Going steps={went} onBack={() => setWent(null)} />
        ) : (
          <div className="space-y-3">
            {/* ── the title ─────────────────────────────────────────── */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="eyebrow" htmlFor="ship-title">
                  Title
                </label>
                <button
                  onClick={ask}
                  disabled={writing}
                  title="Ask the host to describe the change again"
                  className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-meta text-mute transition-colors hover:text-bone disabled:opacity-40"
                >
                  <Icon of={Sparkles} size={12} />
                  {writing ? "Asking…" : "Regenerate"}
                </button>
              </div>

              {writing ? (
                <Skeleton lines={1} />
              ) : (
                <input
                  id="ship-title"
                  ref={first}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="feat(scope): what this change does"
                  className="w-full rounded-md border border-line bg-ground px-2.5 py-2 text-meta text-text placeholder:text-mute focus:border-dim focus:outline-none"
                />
              )}
              <p className="mt-1 text-micro text-mute">
                {kind && <span className="font-mono text-dim">{kind}</span>}
                {kind && " · "}
                <span className={title.trim().length > 72 ? "text-brick" : ""}>
                  {title.trim().length}/72
                </span>{" "}
                · this is also the commit message
              </p>
            </div>

            {/* ── the body ──────────────────────────────────────────── */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="eyebrow">Body</span>
                <Segmented
                  options={[
                    ["write", "Write"],
                    ["preview", "Preview"],
                  ]}
                  value={showing}
                  onChange={setShowing}
                />
              </div>

              {writing ? (
                <Skeleton lines={4} />
              ) : showing === "write" ? (
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={7}
                  placeholder="What changed and why, for whoever reviews it"
                  className="w-full resize-none rounded-md border border-line bg-ground px-2.5 py-2 text-meta leading-[1.5] text-text placeholder:text-mute focus:border-dim focus:outline-none"
                />
              ) : (
                <div className="min-h-[132px] rounded-md border border-line bg-ground px-2.5 py-2">
                  {body.trim() ? (
                    <Markdown>{body}</Markdown>
                  ) : (
                    <p className="text-meta text-mute">Nothing written yet.</p>
                  )}
                </div>
              )}
            </div>

            {/* ── the issues ────────────────────────────────────────── */}
            <div>
              <span className="eyebrow mb-1 block">Issues</span>
              <IssueChips
                refs={refs}
                onChange={(next) => {
                  setRefs(next);
                  setSuggested((held) =>
                    held.filter(
                      (s) =>
                        !next.some(
                          (n) => n.number === s.number && n.repo === s.repo,
                        ),
                    ),
                  );
                }}
                within={within}
                suggestions={suggested}
              />
            </div>

            {/* Exactly what will be appended, because it is appended at send
              time rather than typed into the box. A trailer nobody can see
              before it is written is a surprise in a pull request. */}
            {trailer && (
              <div>
                <p className="text-meta text-mute">
                  {slugs.length > 1
                    ? "Appended to each body:"
                    : "Appended to the body when it opens:"}
                </p>
                <div className="mt-1 border-l-2 border-line pl-2 font-mono text-micro text-dim">
                  {slugs.length > 1
                    ? slugs.map((slug) => (
                        <p key={slug} className="truncate">
                          <span className="text-mute">{slug}</span>{" "}
                          {trailerFor(refs, slug).split("\n").join(" · ")}
                        </p>
                      ))
                    : trailer
                        .split("\n")
                        .map((line) => <p key={line}>{line}</p>)}
                </div>
                {slugs.length > 1 && (
                  <p className="mt-1 text-micro text-mute">
                    A closing keyword only closes inside its own repository.
                  </p>
                )}
              </div>
            )}

            {/* ── what is going in ──────────────────────────────────── */}
            <div className="flex items-center justify-between border-t border-line pt-2.5">
              <p className="min-w-0 truncate font-mono text-micro text-mute">
                {paths.length} files <span className="text-sage">+{added}</span>{" "}
                <span className="text-brick">−{removed}</span>
                {dropped > 0 && ` · ${dropped} left out`}
              </p>
              <button
                onClick={onReviewFiles}
                className="shrink-0 text-meta text-dim transition-colors hover:text-bone"
              >
                Review the files →
              </button>
            </div>
          </div>
        )}

        {trouble && !went && (
          <p className="mt-3 rounded-sm border border-brick/40 bg-ground px-2.5 py-2 text-meta leading-[1.5] text-brick">
            {trouble}
          </p>
        )}

        {/* ── the decision ────────────────────────────────────────── */}
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3">
          {opening && !went && (
            <label className="flex cursor-pointer items-center gap-1.5 text-meta text-dim">
              <input
                type="checkbox"
                checked={draft}
                onChange={(e) => setDraft(e.target.checked)}
                className="accent-bone"
              />
              Open as a draft
            </label>
          )}
          {!went && sequence(ship.stage) && (
            <p className="min-w-0 flex-1 text-meta text-mute">
              {sequence(ship.stage)}
            </p>
          )}

          <div className="ml-auto flex items-center gap-2">
            {writing && (
              <button
                onClick={() => {
                  abandoned.current = true;
                  describe.reset();
                  window.setTimeout(() => first.current?.focus(), 0);
                }}
                className="text-meta text-mute transition-colors hover:text-bone"
              >
                Write it myself
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-md px-2.5 py-1.5 text-meta text-mute transition-colors hover:text-bone"
            >
              {went?.some((s) => s.state === "failed") ? "Close" : "Cancel"}
            </button>
            <button
              onClick={go}
              disabled={
                busy ||
                writing ||
                (paths.length === 0 && ship.stage === "uncommitted")
              }
              title={`${ship.blocked ?? ship.label} (⌘↵)`}
              className="rounded-md bg-bone px-3 py-1.5 text-meta font-medium text-ground transition-colors hover:bg-white disabled:bg-line disabled:text-mute"
            >
              {busy ? "Working…" : went ? "Try again" : ship.label}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** One thing the sequence did, or is doing, or would not do. */
type Step = {
  id: "commit" | "push" | "open";
  what: string;
  state: "doing" | "done" | "failed";
  detail?: string;
};

/**
 * The sequence, while it runs.
 *
 * Three requests, and which one failed is the only thing worth knowing — a
 * single "that didn't work" left somebody unable to tell a rejected push from
 * a refused pull request, which are fixed in completely different places.
 */
function Going({ steps, onBack }: { steps: Step[]; onBack: () => void }) {
  const stuck = steps.find((s) => s.state === "failed");
  // Nothing landed, so the words are still worth changing — a commit refused
  // for its message is fixed by editing the message, and closing the sheet to
  // get back to it would throw away everything typed.
  const nothingDone = !steps.some((s) => s.state === "done");

  return (
    <div className="py-2">
      {steps.map((step) => (
        <div key={step.id} className="flex items-start gap-2.5 py-1">
          <span
            className={`mt-[1px] shrink-0 font-mono text-meta ${
              step.state === "done"
                ? "text-sage"
                : step.state === "failed"
                  ? "text-brick"
                  : "text-mute"
            }`}
          >
            {step.state === "done" ? "✓" : step.state === "failed" ? "✕" : "·"}
          </span>
          <div className="min-w-0">
            <p className="text-meta text-text">
              {step.what}
              {step.state === "doing" && "…"}
            </p>
            {step.detail && (
              <p className="mt-0.5 font-mono text-micro leading-[1.5] text-brick">
                {step.detail}
              </p>
            )}
          </div>
        </div>
      ))}

      {stuck && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="min-w-0 flex-1 text-meta leading-[1.5] text-mute">
            {steps.some((s) => s.id === "commit" && s.state === "done")
              ? "The commit is safe on the branch. Nothing was lost."
              : "Nothing has changed. What you wrote is still here."}
          </p>
          {nothingDone && (
            <button
              onClick={onBack}
              className="shrink-0 text-meta text-dim transition-colors hover:text-bone"
            >
              ← Edit the description
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Where the words will be, while the host is still reading the diff. */
function Skeleton({ lines }: { lines: number }) {
  return (
    <div className="space-y-1.5 rounded-md border border-line bg-ground px-2.5 py-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-[9px] animate-pulse rounded-sm bg-line"
          style={{ width: `${[92, 78, 85, 60][i % 4]}%` }}
        />
      ))}
    </div>
  );
}

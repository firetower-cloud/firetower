"use client";

import { useState } from "react";
import { Modal, Foot, Quiet } from "./Modal";
import { useListRepos } from "@/src/api/generated/repos/repos";
import type { CheckoutWork, Session } from "@/src/api/generated/model";

/**
 * The agent's branch, as a worktree on the machine you are sitting at.
 *
 * Not a preview URL. A dev server on a worker is reachable only by tunnelling
 * something, and what somebody actually wants after an agent hands back is to
 * run the thing with their own editor, their own debugger and their own test
 * runner — which is a checkout, not a port.
 *
 * A worktree rather than a checkout on purpose: it is a second directory on the
 * agent's branch sharing one `.git`, so whatever is open and half-finished on
 * the branch you were already on is untouched. It is also what Firetower does
 * on the worker, so it is a model somebody using this already has.
 *
 * Commands rather than doing it: the control plane may be on a VPS, and
 * "locally" is then a machine it has no way to touch. Text works everywhere.
 */
export function GetLocally({
  session,
  work,
  onClose,
}: {
  session: Session;
  work?: CheckoutWork[];
  onClose: () => void;
}) {
  const { data: repos = [] } = useListRepos();

  // The checkouts, each with the remote to clone from. A session made before a
  // session could hold more than one has its branch on the session itself.
  const held = (session.checkouts ?? []).map((c) => ({
    slug: c.slug,
    branch: c.branch,
    remote: repos.find((r) => r.slug === c.slug)?.remote ?? null,
    // Where its work has got to, which decides whether there is anything to
    // fetch. Absent while the summary is still loading.
    state: work?.find((w) => w.slug === c.slug),
  }));

  return (
    <Modal title="Get it locally" onClose={onClose} wide>
      <p className="max-w-[56ch] text-ui leading-[1.6] text-dim">
        A worktree on the agent&apos;s branch, beside your own clone. Your
        current branch and anything uncommitted in it are untouched.
      </p>

      {held.length === 0 && (
        <p className="mt-4 text-ui text-mute">
          This session has no repository, so there is nothing to fetch.
        </p>
      )}

      <div className="mt-4 flex flex-col gap-4">
        {held.map((c) => (
          <Recipe key={c.slug} name={session.name} {...c} />
        ))}
      </div>

      <Foot>
        <Quiet onClick={onClose}>Close</Quiet>
      </Foot>
    </Modal>
  );
}

/**
 * One repository's commands.
 *
 * Stated as three separate things, because they are three different questions:
 * whether you have the repository at all, how to get this branch, and how to
 * put it back afterwards. A single blob hides the middle one, which is the only
 * part that changes per session.
 */
function Recipe({
  name,
  slug,
  branch,
  remote,
  state,
}: {
  name: string;
  slug: string;
  branch: string;
  remote: string | null;
  state?: CheckoutWork;
}) {
  // The directory name of the clone, which is what git would have made.
  const repo = slug.split("/").pop() ?? slug;
  const tree = `${repo}-${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;

  // Nothing is fetchable until the branch is on the remote. The commits live on
  // the worker until then, and reaching those directly is a different and much
  // larger feature.
  const blocked = reason(remote, state);

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-meta text-bone">{slug}</span>
        <span className="font-mono text-meta text-mute">⑂ {branch}</span>
      </div>

      {blocked ? (
        <p className="mt-1.5 rounded-md border border-line bg-raise px-3 py-2 text-meta leading-[1.5] text-bone">
          {blocked}
        </p>
      ) : (
        <>
          <Block
            label="Once, if you don't have it"
            lines={[`git clone ${remote} ${repo}`]}
          />
          <Block
            label={`Then, for ${name}`}
            lines={[
              `cd ${repo}`,
              `git fetch origin ${branch}`,
              `git worktree add ../${tree} ${branch}`,
              `cd ../${tree}`,
            ]}
          />
          <Block label="When you're done with it" lines={[`git worktree remove ../${tree}`]} />
        </>
      )}
    </div>
  );
}

/**
 * Why this repository cannot be fetched, if it cannot.
 *
 * Each of these is a different thing to go and do, so each says which — a
 * single "not ready" would send somebody looking.
 */
function reason(remote: string | null, state?: CheckoutWork): string | null {
  if (!remote) {
    return "This repository was added as a path rather than a remote, so there is nothing to clone from.";
  }
  if (!state) return null; // still loading; the commands are right anyway
  if (state.trouble) return state.trouble;
  if (state.uncommitted > 0) {
    return `${state.uncommitted} ${state.uncommitted === 1 ? "file is" : "files are"} uncommitted on the worker. Commit and push first — what is only on that machine cannot be fetched from here.`;
  }
  if (state.ahead > 0) {
    return `${state.ahead} ${state.ahead === 1 ? "commit is" : "commits are"} not pushed yet. Push first — until then they exist only on the worker.`;
  }
  if (!state.pushed) {
    return "This branch has not been pushed, so there is nothing on the remote to fetch.";
  }
  return null;
}

/** A copyable run of lines, with what they are for above them. */
function Block({ label, lines }: { label: string; lines: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = lines.join("\n");

  return (
    <div className="mt-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-meta text-mute">{label}</span>
        <button
          onClick={() => {
            navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
          className="ml-auto text-meta text-mute transition-colors hover:text-bone"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="mt-1 overflow-x-auto rounded-sm border border-line bg-ground px-3 py-2 font-mono text-meta leading-[1.6] text-text">
        {text}
      </pre>
    </div>
  );
}

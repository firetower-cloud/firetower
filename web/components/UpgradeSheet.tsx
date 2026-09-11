"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, Foot, Go, Quiet, Choice } from "./Modal";
import {
  getGetUpdatesQueryKey,
  getListRunsQueryKey,
  useCreateRun,
  usePlanUpdate,
} from "@/src/api/generated/updates/updates";
import type { FilePlan, UpdateStatus, UpgradePlan } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";
import { CopyButton } from "@/components/ui";
import {
  type Chosen,
  countEnded,
  diffLines,
  needsChoice,
  sessionsWord,
  willWrite,
  wouldEnd,
} from "@/src/api/updates";

/**
 * The one decision, asked once: what is about to happen, in order, and what
 * it costs.
 *
 * A file the release changed and somebody here edited is the case this sheet
 * exists for. Both diffs are shown — what they changed, what the release
 * changed — and replacing is a choice they make, not a default. Nothing is
 * merged.
 */
export function UpgradeSheet({
  status,
  chosen,
  whenIdle,
  onClose,
  onStarted,
}: {
  status: UpdateStatus;
  chosen: Chosen;
  whenIdle: boolean;
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const version = status.latest?.version ?? "";
  const queryClient = useQueryClient();
  const planUpdate = usePlanUpdate();
  const createRun = useCreateRun();

  const [plan, setPlan] = useState<UpgradePlan | null>(null);
  const [planProblem, setPlanProblem] = useState<string | null>(null);
  const [replace, setReplace] = useState<Record<string, boolean>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Only the control plane touches files, so only then is there a plan to
  // fetch. Asked when the sheet opens rather than when the page loads: it
  // reaches GitHub and the updater, and nobody opens this idly.
  const wantsPlan = chosen.controlPlane;
  useEffect(() => {
    if (!wantsPlan) return;
    planUpdate.mutate(
      { data: { version } },
      {
        onSuccess: setPlan,
        onError: (e) =>
          setPlanProblem(e instanceof ApiError ? e.message : "Couldn't read the deployment files."),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsPlan, version]);

  const ended = wouldEnd(status, chosen);
  const endedCount = countEnded(ended);
  const mustAcknowledge = !whenIdle && endedCount > 0;

  const files = plan?.files ?? [];
  const asking = files.filter(needsChoice);
  const undecided = asking.some((f) => replace[f.name] === undefined);
  const written = files.filter((f) => willWrite(f, replace[f.name] ?? false));
  const skippingControlPlane = asking.some((f) => replace[f.name] === false);

  const ready =
    !!version &&
    (!wantsPlan || (!!plan && !undecided)) &&
    (!mustAcknowledge || acknowledged) &&
    (plan?.envMissing.length ?? 0) === 0;

  const start = () => {
    const controlPlane = chosen.controlPlane && !skippingControlPlane;
    createRun.mutate(
      {
        data: {
          version,
          controlPlane,
          hostIds: chosen.hostIds,
          whenIdle,
          endSessions: acknowledged,
          files: asking.map((f) => ({ name: f.name, replace: replace[f.name] ?? false })),
        },
      },
      {
        onSuccess: (run) => {
          queryClient.invalidateQueries({ queryKey: getGetUpdatesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListRunsQueryKey() });
          onStarted(run.id);
        },
        onError: (e) => setProblem(e instanceof ApiError ? e.message : "That didn't work."),
      },
    );
  };

  const steps: string[] = [];
  if (chosen.controlPlane && !skippingControlPlane) {
    steps.push("back up the database to backups/ beside firetower.yml");
    if (plan?.updaterUpgrade) steps.push("recreate the updater");
    steps.push("recreate the control plane — the interface goes away for about half a minute");
  }
  for (const id of chosen.hostIds) {
    const host = status.hosts.find((h) => h.hostId === id);
    if (host) steps.push(`recreate the worker on ${host.name}`);
  }

  return (
    <Modal title={`Upgrade to ${version}`} onClose={onClose} wide>
      <p className="text-ui text-dim">
        {whenIdle
          ? "Each target is drained now and recreated once nothing is running on it. In order:"
          : "This will, in order:"}
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-ui text-text">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>

      {wantsPlan && !plan && !planProblem && (
        <p className="mt-4 text-meta text-mute">Reading the deployment files…</p>
      )}
      {planProblem && (
        <p className="mt-4 rounded-md border border-brick-deep bg-brick-tint px-3 py-2 text-meta text-brick">
          {planProblem}
        </p>
      )}

      {plan && plan.envMissing.length > 0 && (
        <div className="mt-4 rounded-md border border-ember-deep bg-ember-tint px-3.5 py-3">
          <p className="text-ui text-ember">
            .env needs {plan.envMissing.length === 1 ? "a new line" : "new lines"} before the control
            plane can restart:
          </p>
          {plan.envMissing.map((key) => (
            <div key={key} className="mt-1.5 flex items-center gap-2">
              <code className="rounded-sm border border-line bg-ground px-2 py-1 font-mono text-meta text-bone">
                {key}=
              </code>
              <CopyButton text={`${key}=`} />
            </div>
          ))}
          <p className="mt-2 text-meta text-dim">
            Add them on the machine, beside firetower.yml, then open this again.
          </p>
        </div>
      )}

      {files.filter((f) => f.verdict !== "Unchanged").map((file) => (
        <FileBlock
          key={file.name}
          file={file}
          replace={replace[file.name]}
          onChoose={(r) => setReplace({ ...replace, [file.name]: r })}
        />
      ))}

      {mustAcknowledge && (
        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-md border border-line px-3.5 py-3">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-1"
          />
          <span className="min-w-0">
            <span className="block text-ui text-text">
              End {sessionsWord(endedCount)} now
              {ended.map((e) => ` · ${e.sessions.length} on ${e.where}`).join("")}.
            </span>
            <span className="mt-0.5 block text-meta text-dim">
              {ended.flatMap((e) => e.sessions).join(", ")}. Their worktrees and branches stay;
              the agents&apos; conversations are lost.
            </span>
          </span>
        </label>
      )}

      {chosen.controlPlane && !skippingControlPlane && (
        <p className="mt-4 text-meta text-dim">
          If the control plane doesn&apos;t come back healthy within three minutes, the previous
          image is put back automatically
          {written.length > 0 && ", along with the files it rewrote"}.
        </p>
      )}

      {problem && (
        <p className="mt-4 rounded-md border border-brick-deep bg-brick-tint px-3 py-2 text-meta text-brick">
          {problem}
        </p>
      )}

      <Foot>
        <Go onClick={start} disabled={!ready || createRun.isPending}>
          {whenIdle ? "Upgrade when idle" : "Upgrade now"}
        </Go>
        <Quiet onClick={onClose}>Cancel</Quiet>
      </Foot>
    </Modal>
  );
}

function FileBlock({
  file,
  replace,
  onChoose,
}: {
  file: FilePlan;
  replace: boolean | undefined;
  onChoose: (replace: boolean) => void;
}) {
  const [showing, setShowing] = useState<"release" | "yours" | null>(
    file.verdict === "Edited" ? "yours" : null,
  );

  const said = {
    Update: "changed in this release; yours is the previous release's copy and will be replaced, kept as .backup",
    New: "new in this release; it will be written",
    Edited: "changed in this release, and yours has edits of its own",
    Unshipped: "no longer shipped; yours is left alone",
    Unchanged: "",
  }[file.verdict];

  return (
    <div className="mt-4 rounded-md border border-line">
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
        <span className="font-mono text-ui text-bone">{file.name}</span>
        <span className="text-meta text-dim">{said}</span>
        <span className="ml-auto flex gap-1">
          {file.yourEdits && (
            <Toggle on={showing === "yours"} onClick={() => setShowing(showing === "yours" ? null : "yours")}>
              your edits
            </Toggle>
          )}
          {file.releaseChange && (
            <Toggle on={showing === "release"} onClick={() => setShowing(showing === "release" ? null : "release")}>
              what the release changes
            </Toggle>
          )}
        </span>
      </div>
      {showing && <Diff text={showing === "yours" ? file.yourEdits ?? "" : file.releaseChange ?? ""} />}
      {file.verdict === "Edited" && (
        <div className="space-y-2 border-t border-line px-3.5 py-3">
          <Choice
            on={replace === true}
            title={`Replace it with ${"the release's file"}, keep mine as ${file.name}.backup`}
            body="I'll reapply my edits afterwards."
            onClick={() => onChoose(true)}
          />
          <Choice
            on={replace === false}
            title="Skip the control plane this time"
            body="Upgrade the workers only; the control plane stays as it is."
            onClick={() => onChoose(false)}
          />
        </div>
      )}
    </div>
  );
}

function Toggle({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-sm border px-2 py-0.5 text-meta transition-colors ${
        on ? "border-line bg-raise text-bone" : "border-line-soft text-dim hover:text-bone"
      }`}
    >
      {children}
    </button>
  );
}

/** A unified diff, coloured by line. */
export function Diff({ text }: { text: string }) {
  const lines = diffLines(text);
  if (lines.length === 0) {
    return <p className="border-t border-line px-3.5 py-2 text-meta text-mute">No difference.</p>;
  }
  return (
    <pre className="max-h-[320px] overflow-auto border-t border-line bg-ground px-3.5 py-2 font-mono text-meta leading-relaxed">
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            l.kind === "add"
              ? "text-sage"
              : l.kind === "del"
                ? "text-brick"
                : l.kind === "hunk" || l.kind === "meta"
                  ? "text-mute"
                  : "text-dim"
          }
        >
          {l.text || " "}
        </div>
      ))}
    </pre>
  );
}

"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetUpdatesQueryKey,
  getListRunsQueryKey,
  useCancelRun,
  useContinueRun,
  useGetRun,
} from "@/src/api/generated/updates/updates";
import type { UpdateRun, UpdateStep } from "@/src/api/generated/model";
import { Badge, Button } from "@/components/ui";
import { ApiError } from "@/src/api/http";
import {
  duration,
  isActive,
  needsAnAnswer,
  RUN_LABEL,
  runTone,
  stepGlyph,
} from "@/src/api/updates";

/**
 * One upgrade, as it happens and afterwards.
 *
 * Polled rather than streamed, on purpose: the step that recreates the control
 * plane takes the server away for half a minute, and a poll that fails and
 * tries again is the whole reconnection story. While it is failing the page
 * says so, rather than showing a stale step as still running.
 */
export function RunView({ id, onDone }: { id: string; onDone?: () => void }) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const { data: run, isError, error } = useGetRun(id, {
    query: {
      refetchInterval: (query) => (query.state.data && !isActive(query.state.data) ? false : 2_000),
      // Keep trying through the restart: a failed fetch is expected mid-run.
      retry: true,
      retryDelay: 2_000,
    },
  });

  const cancel = useCancelRun();
  const carryOn = useContinueRun();
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetUpdatesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListRunsQueryKey() });
  };

  if (!run) {
    return (
      <div className="panel px-4 py-3.5 text-ui text-dim">
        {isError ? "Reading the run… the control plane may be restarting." : "Reading the run…"}
        {isError && error instanceof ApiError && error.code === "NotFound" && (
          <span className="ml-2 text-mute">This run is not on record.</span>
        )}
      </div>
    );
  }

  const active = isActive(run);
  const waiting = needsAnAnswer(run);
  const canCancel = run.state === "planned" || run.state === "waitingIdle" || waiting;
  // The step that stopped it, so the panel below can say what went wrong in
  // its own words rather than repeating a summary.
  const warned = run.steps.find((s) => s.state === "warned");

  return (
    <div className="panel">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <span className="font-mono text-ui text-bone">
          {run.fromVersion} → {run.toVersion}
        </span>
        <Badge tone={runTone(run.state)}>{RUN_LABEL[run.state]}</Badge>
        {isError && active && (
          <span className="text-meta text-dim">the control plane is restarting…</span>
        )}
        <span className="ml-auto font-mono text-meta text-mute">
          {run.startedAt ? duration(run.startedAt, run.finishedAt) : ""}
        </span>
        {canCancel && (
          <Button
            variant="quiet"
            size="sm"
            disabled={cancel.isPending}
            onClick={() =>
              cancel.mutate(
                { id: run.id },
                {
                  onSuccess: () => {
                    setProblem(null);
                    refresh();
                  },
                  onError: (e) =>
                    setProblem(e instanceof ApiError ? e.message : "That didn't work."),
                },
              )
            }
          >
            Cancel
          </Button>
        )}
        {!active && onDone && (
          <Button variant="quiet" size="sm" onClick={onDone}>
            Close
          </Button>
        )}
      </div>

      {/* A run that stopped to ask. Nothing happens until somebody answers —
          an upgrade with no backup is a decision, not a default. */}
      {waiting && (
        <div className="border-b border-brick-deep bg-brick-tint px-4 py-3">
          <p className="text-ui text-bone">The backup didn&apos;t work.</p>
          {warned?.detail && (
            <pre className="mt-2 max-h-40 overflow-auto rounded-sm bg-black/25 px-3 py-2 font-mono text-meta leading-[1.6] whitespace-pre-wrap text-mute">
              {warned.detail}
            </pre>
          )}
          <p className="mt-2 text-meta leading-[1.5] text-mute">
            Nothing has been upgraded yet. Carrying on means upgrading with no backup of the
            database to go back to.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={carryOn.isPending}
              onClick={() =>
                carryOn.mutate(
                  { id: run.id },
                  {
                    onSuccess: () => {
                      setProblem(null);
                      refresh();
                    },
                    onError: (e) =>
                      setProblem(e instanceof ApiError ? e.message : "That didn't work."),
                  },
                )
              }
            >
              Upgrade without a backup
            </Button>
          </div>
        </div>
      )}

      {problem && <p className="px-4 pt-3 text-meta text-brick">{problem}</p>}
      {run.error && !active && <p className="px-4 pt-3 text-meta text-brick">{run.error}</p>}
      {run.state === "waitingIdle" && (
        <p className="px-4 pt-3 text-meta text-dim">
          The targets are drained and nothing new will land on them. The upgrade starts when
          every session on them has ended.
        </p>
      )}

      <div className="divide-y divide-line-soft">
        {run.steps.map((step) => (
          <StepRow
            key={step.position}
            step={step}
            open={open === step.position}
            onToggle={() => setOpen(open === step.position ? null : step.position)}
          />
        ))}
      </div>
    </div>
  );
}

function StepRow({
  step,
  open,
  onToggle,
}: {
  step: UpdateStep;
  open: boolean;
  onToggle: () => void;
}) {
  const tone =
    step.state === "done"
      ? "text-sage"
      : step.state === "failed"
        ? "text-brick"
        : step.state === "running"
          ? "text-slate"
          : "text-mute";
  const hasLog = step.log.trim().length > 0;

  return (
    <div className="px-4 py-2.5">
      <button
        type="button"
        onClick={hasLog ? onToggle : undefined}
        className={`flex w-full items-start gap-3 text-left ${hasLog ? "cursor-pointer" : "cursor-default"}`}
      >
        <span className={`w-3 shrink-0 font-mono text-ui ${tone}`}>{stepGlyph(step.state)}</span>
        <span className="min-w-0 flex-1">
          <span className={`block text-ui ${step.state === "pending" || step.state === "skipped" ? "text-mute" : "text-text"}`}>
            {step.title}
          </span>
          {step.detail && (
            <span className={`mt-0.5 block text-meta ${step.state === "failed" ? "text-brick" : "text-dim"}`}>
              {step.detail}
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-meta text-mute">
          {step.startedAt ? duration(step.startedAt, step.finishedAt) : ""}
          {hasLog && <span className="ml-2">{open ? "▾" : "▸"}</span>}
        </span>
      </button>
      {open && hasLog && (
        <pre className="mt-2 max-h-[360px] overflow-auto rounded-md border border-line bg-ground px-3 py-2 font-mono text-meta leading-relaxed whitespace-pre-wrap text-dim">
          {step.log}
        </pre>
      )}
    </div>
  );
}

/** A past run, folded to one line until opened. */
export function RunHistoryRow({ run }: { run: UpdateRun }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raise"
      >
        <span className="font-mono text-ui text-text">
          {run.fromVersion} → {run.toVersion}
        </span>
        <Badge tone={runTone(run.state)}>{RUN_LABEL[run.state]}</Badge>
        <span className="ml-auto font-mono text-meta text-mute">
          {new Date(run.createdAt).toLocaleString()}
          {run.startedAt && !isActive(run) && ` · ${duration(run.startedAt, run.finishedAt)}`}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3">
          <RunView id={run.id} />
        </div>
      )}
    </div>
  );
}

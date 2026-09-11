"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CircleFadingArrowUp, RefreshCw } from "lucide-react";
import {
  getGetUpdatesQueryKey,
  useCheckUpdates,
  useGetUpdates,
  useListRuns,
} from "@/src/api/generated/updates/updates";
import type { HostTarget, UpdateStatus } from "@/src/api/generated/model";
import { Badge, Button, Empty, Icon, PageHead } from "@/components/ui";
import { Markdown } from "@/components/Markdown";
import { ApiError } from "@/src/api/http";
import { UpgradeSheet } from "@/components/UpgradeSheet";
import { RunHistoryRow, RunView } from "@/components/UpdateRun";
import {
  type Chosen,
  everythingUpgradable,
  hostNote,
  isActive,
  nothingChosen,
  sessionsWord,
} from "@/src/api/updates";
import { elapsed, minutesSince } from "@/src/api/view";

/**
 * Where everything stands against the newest release, and the way to move it.
 *
 * Nothing here is automatic. A check every few hours says what is out; a
 * person ticks what to move and presses one of two buttons — now, or when the
 * machines are idle. Both ask first.
 */
export function UpdatesScreen() {
  const queryClient = useQueryClient();
  const { data: status, isLoading, isError, error } = useGetUpdates({
    query: { refetchInterval: 60_000 },
  });
  const { data: runs = [] } = useListRuns({ query: { refetchInterval: 30_000 } });
  const check = useCheckUpdates();

  const [sheet, setSheet] = useState<{ whenIdle: boolean } | null>(null);
  const [watching, setWatching] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // What starts ticked is everything that can move; a person unticks. What
  // they picked is kept against the shape it was picked for, so a different
  // release or a host arriving starts the ticks over — and a refetch that
  // changes nothing keeps them.
  const shape = status ? pickShape(status) : "";
  const [picked, setPicked] = useState<{ shape: string; chosen: Chosen } | null>(null);
  const chosen: Chosen | null = status
    ? picked && picked.shape === shape
      ? picked.chosen
      : everythingUpgradable(status)
    : null;
  const setChosen = (next: Chosen) => setPicked({ shape, chosen: next });

  // A run in progress owns the top of the page, whoever started it.
  const active = status?.activeRun ?? watching;

  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetUpdatesQueryKey() });

  if (isError) {
    const forbidden = error instanceof ApiError && error.code === "Forbidden";
    return (
      <div className="max-w-[900px] px-8 pt-8 pb-24">
        <PageHead eyebrow="Updates" title={forbidden ? "Administrators only." : "Couldn't ask."}>
          {forbidden
            ? "Upgrading recreates every machine at once, so it is an administrator's to do."
            : "Couldn't reach the control plane. Is Firetower running?"}
        </PageHead>
      </div>
    );
  }

  const title = isLoading || !status
    ? "Looking…"
    : status.updateAvailable
      ? `${status.latest?.version ?? "A release"} is available.`
      : "Up to date.";

  return (
    <div className="max-w-[900px] px-8 pt-8 pb-24">
      <PageHead
        eyebrow="Updates"
        title={title}
        aside={
          <Button
            icon={RefreshCw}
            disabled={check.isPending}
            onClick={() =>
              check.mutate(undefined, {
                onSuccess: (fresh) => {
                  queryClient.setQueryData(getGetUpdatesQueryKey(), fresh);
                  setProblem(null);
                },
                onError: (e) => setProblem(e instanceof ApiError ? e.message : "That didn't work."),
              })
            }
          >
            {check.isPending ? "Checking…" : "Check now"}
          </Button>
        }
      >
        {status && (
          <>
            Firetower {status.current}
            {status.checkedAt && ` · checked ${elapsed(minutesSince(status.checkedAt))} ago`}
            {status.latest?.publishedAt &&
              status.updateAvailable &&
              ` · ${status.latest.version} released ${elapsed(minutesSince(status.latest.publishedAt))} ago`}
          </>
        )}
      </PageHead>

      {problem && (
        <p className="mb-4 rounded-md border border-brick-deep bg-brick-tint px-3.5 py-2.5 text-meta text-brick">
          {problem}
        </p>
      )}
      {status?.checkError && (
        <p className="mb-4 rounded-md border border-line px-3.5 py-2.5 text-meta text-dim">
          The last check failed: {status.checkError}
          {status.latest && " — showing what the one before it found."}
        </p>
      )}

      {active && (
        <div className="mb-6">
          <RunView
            id={active}
            onDone={() => {
              setWatching(null);
              refresh();
            }}
          />
        </div>
      )}

      {status && status.latest && status.updateAvailable && !active && chosen && (
        <>
          {status.latest.notes && (
            <div className="panel mb-5 px-5 py-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="eyebrow">What&apos;s in it</span>
                {status.latest.notesUrl && (
                  <a
                    href={status.latest.notesUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto flex items-center gap-1 text-meta text-dim hover:text-bone"
                  >
                    Release notes <Icon of={ArrowUpRight} size={12} />
                  </a>
                )}
              </div>
              <div className="max-h-[320px] overflow-y-auto">
                <Markdown>{status.latest.notes}</Markdown>
              </div>
            </div>
          )}

          <Targets status={status} chosen={chosen} onChange={setChosen} />

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              disabled={nothingChosen(chosen)}
              onClick={() => setSheet({ whenIdle: false })}
            >
              Upgrade now…
            </Button>
            <Button disabled={nothingChosen(chosen)} onClick={() => setSheet({ whenIdle: true })}>
              Upgrade when idle
            </Button>
            <span className="text-meta text-mute">
              Both ask first. Nothing moves until you say so.
            </span>
          </div>
        </>
      )}

      {status && !status.updateAvailable && !active && (
        <Empty icon={CircleFadingArrowUp}>
          Everything is on {status.current}. The next check is in a few hours; the button above
          asks now.
        </Empty>
      )}

      {status && !active && <CliRow status={status} />}

      {runs.length > 0 && (
        <div className="mt-8">
          <div className="eyebrow mb-2">History</div>
          <div className="panel divide-y divide-line-soft">
            {runs
              .filter((r) => !isActive(r) || r.id !== active)
              .map((run) => (
                <RunHistoryRow key={run.id} run={run} />
              ))}
          </div>
        </div>
      )}

      {sheet && status && chosen && (
        <UpgradeSheet
          status={status}
          chosen={chosen}
          whenIdle={sheet.whenIdle}
          onClose={() => setSheet(null)}
          onStarted={(id) => {
            setSheet(null);
            setWatching(id);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** What the ticks were made for: the release, and which targets could move. */
function pickShape(status: UpdateStatus): string {
  return [
    status.latest?.version ?? "",
    status.controlPlane.upgradable ? "cp" : "",
    ...status.hosts.filter((h) => h.upgradable).map((h) => h.hostId),
  ].join("|");
}

/** Every target, with a box in front of the ones that can move. */
function Targets({
  status,
  chosen,
  onChange,
}: {
  status: UpdateStatus;
  chosen: Chosen;
  onChange: (chosen: Chosen) => void;
}) {
  const to = status.latest?.version ?? "";
  const cp = status.controlPlane;

  const toggleHost = (host: HostTarget, on: boolean) =>
    onChange({
      ...chosen,
      hostIds: on
        ? [...chosen.hostIds, host.hostId]
        : chosen.hostIds.filter((id) => id !== host.hostId),
    });

  return (
    <div className="panel divide-y divide-line-soft">
      <TargetRow
        checked={chosen.controlPlane}
        canCheck={cp.upgradable}
        onCheck={(on) => onChange({ ...chosen, controlPlane: on })}
        name="Control plane"
        kind="this machine"
        from={cp.version}
        to={to}
        behind={cp.version !== to}
        note={
          cp.reason ??
          (cp.sessions.length > 0 ? `ends ${sessionsWord(cp.sessions.length)} on this machine` : "idle")
        }
        warn={!!cp.reason}
      />
      {status.hosts.map((host) => (
        <TargetRow
          key={host.hostId}
          checked={chosen.hostIds.includes(host.hostId)}
          canCheck={host.upgradable}
          onCheck={(on) => toggleHost(host, on)}
          name={host.name}
          kind={host.kind === "container" ? "worker container" : "worker, installed by hand"}
          from={host.version ?? "—"}
          to={host.upgradable ? to : "—"}
          behind={host.version !== to}
          note={hostNote(host)}
          warn={!host.upgradable && host.version !== to}
          offline={!host.online}
        />
      ))}
    </div>
  );
}

function TargetRow({
  checked,
  canCheck,
  onCheck,
  name,
  kind,
  from,
  to,
  behind,
  note,
  warn,
  offline,
}: {
  checked: boolean;
  canCheck: boolean;
  onCheck: (on: boolean) => void;
  name: string;
  kind: string;
  from: string;
  to: string;
  behind: boolean;
  note: string;
  warn?: boolean;
  offline?: boolean;
}) {
  return (
    <label className={`flex items-start gap-3 px-4 py-3 ${canCheck ? "cursor-pointer" : ""}`}>
      <input
        type="checkbox"
        checked={checked && canCheck}
        disabled={!canCheck}
        onChange={(e) => onCheck(e.target.checked)}
        className="mt-1"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-ui text-bone">{name}</span>
          <span className="text-meta text-mute">{kind}</span>
          {offline && <Badge tone="brick">offline</Badge>}
          {!behind && <Badge tone="sage">current</Badge>}
        </span>
        <span className={`mt-0.5 block text-meta ${warn ? "text-ember" : "text-dim"}`}>{note}</span>
      </span>
      <span className="shrink-0 font-mono text-meta text-dim">
        {from}
        {behind && canCheck && <span className="text-mute"> → </span>}
        {behind && canCheck && <span className="text-bone">{to}</span>}
      </span>
    </label>
  );
}

/** The one thing this screen cannot move: the CLI on your own machine. */
function CliRow({ status }: { status: UpdateStatus }) {
  const minimum = status.latest?.cliMinimum;
  if (!minimum) return null;
  return (
    <p className="mt-4 text-meta text-dim">
      Your <span className="font-mono">@firetower/cli</span> should be at least{" "}
      <span className="font-mono text-text">{minimum}</span> for {status.latest?.version}. That
      lives on your own machine, so it is yours to run:{" "}
      <span className="font-mono text-text">npm i -g @firetower/cli</span>
    </p>
  );
}

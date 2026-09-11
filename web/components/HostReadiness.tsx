"use client";

import { useState } from "react";
import type { Agent, Host, Readiness, Requirement } from "@/src/api/generated/model";
import {
  useHostReadiness,
  useConnectHost,
  useInstallWorker,
} from "@/src/api/generated/hosts/hosts";
import { useInstallAgent } from "@/src/api/generated/agents/agents";
import { useQueryClient } from "@tanstack/react-query";
import { Copyable } from "@/components/ui";
import { connectionLabel, environmentLabel, executionOf } from "@/src/api/environments";

export function isReady(report?: Readiness): boolean {
  return (
    !!report &&
    report.checks.length > 0 &&
    report.checks.every((check) => !check.required || check.available)
  );
}

/**
 * The check that stands in for all the others when there is no worker yet.
 *
 * Readiness is measured *by* the worker, so a machine without one cannot report
 * which tools it has — the server answers with this single row instead. It is
 * the one failure Firetower can fix from here, which is why it is named rather
 * than matched on a substring.
 */
const CONNECTION = "Worker connection";

/** A machine Firetower can put a worker on: reached over ssh, running it directly. */
function takesAWorker(host: Host): boolean {
  return host.compute.type === "Server" && !host.compute.container;
}

/**
 * What the environment says about itself.
 *
 * ## Why ready is one line
 *
 * This used to be a card of eight rows, every one of them saying `Ready`, open
 * on a form people fill in twenty times a day. In a container all eight are
 * ready by construction — the image put them there — so the card spent a third
 * of the dialog proving something nobody doubted, and the one case where the
 * answer is genuinely unknown looked exactly the same as the case where it
 * isn't.
 *
 * So: **problems are shown, readiness is not.** Ready collapses to a sentence
 * with the count beside it; the list is still there, behind the count, for
 * whoever wants to see what was actually checked. Everything that is missing is
 * itemised in full, with what can be done about it.
 *
 * The rule does not change between a container and a host, which is the other
 * half of what was wrong: one mode showed a card and the other showed a button.
 */
export function Readout({
  host,
  agent,
  agentLabel,
}: {
  host: Host;
  agent?: Agent;
  /** What the agent's own check is called, so it can be matched to a button. */
  agentLabel?: string;
}) {
  const cache = useQueryClient();
  const [showing, setShowing] = useState(false);

  const report = useHostReadiness(
    host.id,
    { agent },
    {
      query: {
        retry: false,
        staleTime: 5000,
        refetchInterval: (query) => (isReady(query.state.data) ? false : 5000),
      },
    },
  );
  const connect = useConnectHost();
  const installWorker = useInstallWorker();
  const installAgent = useInstallAgent();
  const working = connect.isPending || installWorker.isPending || installAgent.isPending;

  const refresh = async () => {
    await report.refetch();
    await cache.invalidateQueries({ queryKey: ["/api/v1/hosts"] });
    await cache.invalidateQueries({ queryKey: ["/api/v1/agents"] });
  };
  const checkAgain = async () => {
    if (host.state !== "Online") await connect.mutateAsync({ id: host.id });
    await refresh();
  };

  const checks = report.data?.checks ?? [];
  const missing = checks.filter((c) => c.required && !c.available);
  const passed = checks.filter((c) => c.available);
  const ready = isReady(report.data);
  const problem = (installWorker.error ?? installAgent.error ?? connect.error)?.message;

  // Said as one sentence rather than a table of two: where it runs, and who it
  // runs as. Both are things people get wrong about a host they set up weeks
  // ago, and neither is worth a row of its own.
  const where =
    host.compute.type === "Local"
      ? executionOf(host) === "host"
        ? "on this machine"
        : "in the Firetower container"
      : executionOf(host) === "host"
        ? `on ${connectionLabel(host)}`
        : `in ${environmentLabel(host)}`;

  if (report.isFetching && !report.data) {
    return (
      <Verdict tone="checking">
        <span role="status">
          Checking {connectionLabel(host)} for what {agentLabel ?? "an agent"} needs…
        </span>
      </Verdict>
    );
  }

  if (report.error) {
    return (
      <Verdict tone="bad">
        <span role="alert">Couldn&apos;t check {connectionLabel(host)}: {report.error.message}</span>
      </Verdict>
    );
  }

  if (ready) {
    return (
      <>
        <Verdict
          tone="good"
          aside={
            <button
              type="button"
              onClick={() => setShowing(!showing)}
              className="shrink-0 text-meta text-slate hover:text-bone"
            >
              {checks.length} checks {showing ? "▾" : "▸"}
            </button>
          }
        >
          Ready — runs as {report.data?.user ?? "the connection account"} {where}.
        </Verdict>
        {showing && (
          <div className="border-t border-line px-3 py-2.5">
            <Checks checks={checks} />
            <Again onClick={checkAgain} busy={working || report.isFetching} />
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <Verdict tone="bad">
        <span role="alert">
          {missing.length === 1 && missing[0].name === CONNECTION && takesAWorker(host)
            ? `There is no worker on ${connectionLabel(host)} yet.`
            : `${count(missing.length)} missing on ${connectionLabel(host)}.`}
        </span>
      </Verdict>
      <div className="border-t border-brick-deep bg-brick-tint px-3 py-2.5">
        <p className="eyebrow mb-1.5 text-brick">Missing</p>
        <ul className="space-y-1.5">
          {missing.map((check) => (
            <li key={check.name} className="flex items-start gap-2.5 text-meta">
              <span aria-hidden className="font-mono text-brick">
                ✕
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-bone">{check.name}</span>
                <span className="ml-2 text-mute">{detail(check)}</span>
              </span>
              {check.name === CONNECTION && takesAWorker(host) && (
                <Do
                  busy={installWorker.isPending}
                  label="Install the worker"
                  onClick={async () => {
                    await installWorker.mutateAsync({ id: host.id });
                    await refresh();
                  }}
                />
              )}
              {agent && check.name === agentLabel && (
                <Do
                  busy={installAgent.isPending}
                  label="Install"
                  onClick={async () => {
                    await installAgent.mutateAsync({
                      kind: agent,
                      data: { hostId: host.id },
                    });
                    await refresh();
                  }}
                />
              )}
            </li>
          ))}
        </ul>

        {/* What passed, in one line. They are here so it is clear the check ran
            and what it covered — not so anybody reads them. */}
        {passed.length > 0 && (
          <p className="mt-2.5 border-t border-white/5 pt-2 text-meta text-mute">
            <span aria-hidden className="mr-1.5 font-mono text-sage">
              ✓
            </span>
            {passed.map((c) => c.name).join(", ")} — all fine.
          </p>
        )}

        {missing.some((c) => c.name === CONNECTION) && takesAWorker(host) && (
          <p className="mt-2.5 text-meta leading-[1.5] text-mute">
            Firetower copies its own binary, at the version this control plane runs, into{" "}
            <code className="font-mono">~/.firetower/worker/bin</code> over the connection it
            already has. No sudo, and nothing outside that account&apos;s home.
          </p>
        )}

        {/* One remedy per thing that is genuinely the machine's, and never for
            something there is a button for above. */}
        {missing
          .filter((c) => command(c) && !actionable(c, host, agent, agentLabel))
          .map((check) => (
            <Remedy key={check.name} check={check} />
          ))}

        {problem && (
          <p role="alert" className="mt-2.5 text-meta text-brick">
            {problem}
          </p>
        )}
        <Again onClick={checkAgain} busy={working || report.isFetching} />
      </div>
    </>
  );
}

/** Whether a button above already answers this one. */
function actionable(check: Requirement, host: Host, agent?: Agent, agentLabel?: string) {
  if (check.name === CONNECTION) return takesAWorker(host);
  return !!agent && check.name === agentLabel;
}

/**
 * A remedy that is a command, and worth copying. One that is a sentence is not.
 */
function command(check: Requirement): string | undefined {
  const remedy = (check.remedy ?? "").trim();
  return /^(sudo |apt |brew |dnf |yum |curl |docker |firetower)/.test(remedy) ? remedy : undefined;
}

/**
 * What is wrong with this one, said once.
 *
 * The remedy is part of the sentence only when it *is* a sentence — when it is
 * a command it is shown below, to be copied, and repeating it here printed the
 * same `sudo apt install tmux` twice on the same row.
 */
function detail(check: Requirement) {
  return [check.detail, command(check) ? undefined : check.remedy]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function count(n: number) {
  return n === 1 ? "One thing is" : `${n} things are`;
}

function Remedy({ check }: { check: Requirement }) {
  const fix = command(check);
  if (!fix) return null;
  return (
    <Copyable text={fix} label={`Copy the fix for ${check.name}`} className="mt-2.5">
      <pre className="overflow-x-auto rounded-sm bg-black/25 px-3 py-2 font-mono text-meta text-bone">
        {fix}
      </pre>
    </Copyable>
  );
}

function Do({ label, onClick, busy }: { label: string; onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="shrink-0 rounded-sm border border-line bg-overlay px-2.5 py-1 text-micro text-bone transition-colors hover:border-dim disabled:opacity-50"
    >
      {busy ? "Working…" : label}
    </button>
  );
}

function Again({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="mt-2.5 text-meta text-slate hover:text-bone disabled:opacity-50"
    >
      {busy ? "Checking…" : "Check again"}
    </button>
  );
}

function Checks({ checks }: { checks: Requirement[] }) {
  return (
    <ul className="space-y-1 text-meta">
      {checks.map((check) => (
        <li key={check.name} className="flex items-baseline gap-2.5">
          <span aria-hidden className={`font-mono ${check.available ? "text-sage" : "text-mute"}`}>
            {check.available ? "✓" : "✕"}
          </span>
          <span className="w-40 shrink-0 truncate text-dim">{check.name}</span>
          <span className="min-w-0 flex-1 truncate text-mute">{check.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function Verdict({
  tone,
  children,
  aside,
}: {
  tone: "good" | "bad" | "checking";
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  const mark = tone === "good" ? "✓" : tone === "bad" ? "✕" : "◔";
  return (
    <p
      className={`flex items-center gap-2.5 px-3 py-2.5 text-meta leading-[1.5] ${
        tone === "bad" ? "bg-brick-tint text-brick" : "text-dim"
      }`}
    >
      <span
        aria-hidden
        className={`font-mono ${
          tone === "good" ? "text-sage" : tone === "bad" ? "text-brick" : "text-slate"
        }`}
      >
        {mark}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
      {aside}
    </p>
  );
}

/**
 * The same readout, in a box of its own.
 *
 * For the screens that are about one environment rather than about starting
 * something in it — Compute, and setting one up from there.
 */
export function HostReadiness({ host, agent }: { host: Host; agent?: Agent }) {
  return (
    <section
      aria-label="Environment readiness"
      className="overflow-hidden rounded-md border border-line"
    >
      <p className="border-b border-line px-3 py-2 text-meta text-dim">
        Connection: {connectionLabel(host)}
      </p>
      <Readout host={host} agent={agent} />
    </section>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import {
  useListSessions,
  useEndAllSessions,
  getListSessionsQueryKey,
} from "@/src/api/generated/sessions/sessions";
import { useQueryClient } from "@tanstack/react-query";
import { Horizon } from "@/components/Horizon";
import { Composer } from "@/components/Composer";
import { NeedsCard } from "@/components/NeedsCard";
import { Signal } from "@/components/Signal";
import { elapsed, inFlight, needsYou, outcomeOf, toView } from "@/src/api/view";
import { apiBase } from "@/src/api/http";

export default function Dashboard() {
  const { data: raw = [], isLoading, isError } = useListSessions();
  const { data: hosts = [] } = useListHosts();

  const sessions = raw.map((s) => toView(s, hosts));
  const blocked = sessions.filter(needsYou);
  const busy = sessions.filter(inFlight);
  const ended = sessions.filter((s) => s.status === "Ended");
  const longest = busy.reduce((a, s) => Math.max(a, s.minutes), 0);

  if (isError) {
    return (
      <div className="max-w-[900px] px-8 pt-8">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-bone">
          Can&apos;t reach the control plane.
        </h1>
        <p className="mt-2 max-w-[54ch] text-[14px] text-dim">
          Nothing useful came back from{" "}
          <code className="font-mono text-[12.5px] text-slate">{apiBase()}</code>.
        </p>
        <ul className="mt-3 max-w-[54ch] list-disc pl-5 text-[13.5px] leading-[1.7] text-mute">
          <li>
            If that address is this page&apos;s own — the interface is asking itself.
            Start both halves with{" "}
            <code className="font-mono text-[12px] text-slate">just dev</code>.
          </li>
          <li>
            If it&apos;s the control plane&apos;s address, check it&apos;s running:{" "}
            <code className="font-mono text-[12px] text-slate">cargo run</code>.
          </li>
        </ul>
      </div>
    );
  }

  const nothingYet = !isLoading && sessions.length === 0;

  return (
    <div className="min-h-full">
      <header className="px-8 pt-8 pb-4">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="eyebrow">{today()}</div>
            <h1 className="mt-2 max-w-[38ch] text-[30px] leading-[1.15] font-semibold tracking-[-0.02em] text-bone">
          {isLoading
            ? "Looking…"
            : nothingYet
              ? "Nothing on the horizon."
              : blocked.length > 0
                ? `${blocked.length} ${blocked.length === 1 ? "session is" : "sessions are"} waiting on you.`
                : `${busy.length} working, nothing waiting on you.`}
            </h1>
            <p className="mt-2 text-[14px] text-dim">
              {nothingYet
                ? "Describe a task and it'll run on your own hardware — you can close the laptop as soon as it starts."
                : `${busy.length} working. ${longest > 0 ? `The longest has been at it for ${longest} minutes.` : ""}`}
            </p>
          </div>

        </div>
      </header>

      {busy.length + blocked.length > 0 && (
        <div className="max-w-[900px] px-8">
          <Horizon sessions={sessions} />
        </div>
      )}

      <div className="max-w-[900px] px-8 pt-8 pb-24">
        <Composer />

        {blocked.length > 0 && (
          <Section label="Needs you" count={blocked.length} className="mt-10">
            <div className="flex flex-col gap-2.5">
              {blocked.map((s) => (
                <NeedsCard key={s.id} session={s} />
              ))}
            </div>
          </Section>
        )}

        {busy.length > 0 && (
          <Section label="Working" count={busy.length} className="mt-9">
            <div className="panel divide-y divide-line-soft">
              {busy.map((s) => (
                <Link
                  key={s.id}
                  href={`/sessions/${s.id}`}
                  className="flex items-center gap-3 px-3 py-2.5 transition-colors first:rounded-t-[5px] last:rounded-b-[5px] hover:bg-raise"
                >
                  <Signal status={s.status} size={7} />
                  <span className="shrink-0 text-[13.5px] text-bone">{s.name}</span>
                  <span className="font-mono text-[11.5px] text-mute">{s.repo}</span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-text">{s.title}</span>
                  <span className="hidden font-mono text-[11px] text-mute md:block">{s.host}</span>
                  <span className="w-9 text-right font-mono text-[11px] text-dim">
                    {elapsed(s.minutes)}
                  </span>
                </Link>
              ))}
            </div>

            {/* Directly under what it acts on, rather than in the header where
                it read as a page-level action and was easy to miss. */}
            <EndAll live={busy.length + blocked.length} />
          </Section>
        )}

        {ended.length > 0 && (
          <Section label="Recent" className="mt-9">
            <div className="flex flex-col">
              {/* A handful, not a history. The rest has its own page. */}
              {ended.slice(0, 5).map((s) => (
                <Link
                  key={s.id}
                  href={`/sessions/${s.id}`}
                  className="flex items-center gap-3 rounded-[5px] px-3 py-2 transition-colors hover:bg-panel"
                >
                  <span className="text-mute/50">⎿</span>
                  <span className="shrink-0 text-[13px] text-dim">{s.name}</span>
                  <span className="font-mono text-[11.5px] text-mute/70">{s.repo}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-dim">{s.title}</span>
                  <span className="font-mono text-[11px] text-mute">{outcomeOf(s)}</span>
                </Link>
              ))}
            </div>

            <Link
              href="/sessions"
              className="mt-2 inline-block px-3 text-[12px] text-mute transition-colors hover:text-ember"
            >
              View all sessions →
            </Link>
          </Section>
        )}
      </div>
    </div>
  );
}

/**
 * Stop everything at once.
 *
 * Behind a confirm that says how many and what goes with them, because this is
 * the same destruction as ending one session multiplied by however many are
 * running — and it is one click from a page you look at all day.
 */
function EndAll({ live }: { live: number }) {
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const endAll = useEndAllSessions();

  if (result) {
    return <p className="mt-2.5 px-3 text-[12.5px] text-slate">{result}</p>;
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="mt-2.5 w-full rounded-[6px] border border-dashed border-line py-2 text-[12.5px] text-mute transition-colors hover:border-ember/40 hover:text-ember"
      >
        End all {live} {live === 1 ? "session" : "sessions"}
      </button>
    );
  }

  return (
    <div className="mt-2.5 flex items-center gap-3 rounded-[6px] border border-ember/40 bg-ember/[0.04] px-3 py-2">
      <span className="flex-1 text-[12.5px] leading-[1.45] text-dim">
        End {live} {live === 1 ? "session" : "sessions"}? Their workspaces go, and
        anything unpushed with them.
      </span>
      <button
        onClick={() =>
          endAll.mutate(undefined, {
            onSuccess: async (r) => {
              await queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
              setResult(
                r.unreachable > 0
                  ? `Ended ${r.ended}. ${r.unreachable} left alone — their host wasn't answering.`
                  : `Ended ${r.ended}.`,
              );
            },
          })
        }
        disabled={endAll.isPending}
        className="rounded-[4px] bg-ember px-2.5 py-1 text-[11.5px] font-semibold text-[#1a0c04] transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {endAll.isPending ? "Ending…" : "End them"}
      </button>
      <button
        onClick={() => setConfirming(false)}
        className="text-[11.5px] text-mute transition-colors hover:text-text"
      >
        Cancel
      </button>
    </div>
  );
}

function today() {
  return new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function Section({
  label,
  count,
  className = "",
  children,
}: {
  label: string;
  count?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={className}>
      <div className="mb-2.5 flex items-center gap-3">
        <span className="eyebrow">{label}</span>
        <span className="h-px flex-1 bg-line" />
        {count !== undefined && <span className="font-mono text-[11px] text-mute">{count}</span>}
      </div>
      {children}
    </section>
  );
}

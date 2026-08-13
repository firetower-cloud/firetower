"use client";

import Link from "next/link";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import { useListSessions } from "@/src/api/generated/sessions/sessions";
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
    <div className="min-h-screen">
      <header className="px-8 pt-8 pb-4">
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
                  <span className="font-mono text-[11.5px] text-mute">{s.repo}</span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-text">{s.title}</span>
                  <span className="hidden font-mono text-[11px] text-mute md:block">{s.host}</span>
                  <span className="w-9 text-right font-mono text-[11px] text-dim">
                    {elapsed(s.minutes)}
                  </span>
                </Link>
              ))}
            </div>
          </Section>
        )}

        {ended.length > 0 && (
          <Section label="Recent" className="mt-9">
            <div className="flex flex-col">
              {ended.map((s) => (
                <Link
                  key={s.id}
                  href={`/sessions/${s.id}`}
                  className="flex items-center gap-3 rounded-[5px] px-3 py-2 transition-colors hover:bg-panel"
                >
                  <span className="text-mute/50">⎿</span>
                  <span className="font-mono text-[11.5px] text-mute/70">{s.repo}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-dim">{s.title}</span>
                  <span className="font-mono text-[11px] text-mute">{outcomeOf(s)}</span>
                </Link>
              ))}
            </div>
          </Section>
        )}
      </div>
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

"use client";

import { useEffect, useRef, useState } from "react";
import type { ModelUsage, Usage } from "@/src/api/generated/model";
import type { Limits } from "@/src/api/conversation";

/**
 * How full the model's context is, and everything behind that number.
 *
 * The ring is the whole answer most of the time — nobody knows what 121,107 of
 * 1,000,000 feels like, and a ring filling up is legible at 20 pixels. What the
 * ring cannot say is *why*, and that is the popup: a session that costs more
 * than it looks like it should is nearly always cache writes, and a session
 * that is suddenly cheap is nearly always cache reads.
 *
 * Everything drawn here is reported by the agent on the turn's own `result`.
 * Nothing is inferred from a model name and nothing is accumulated across
 * turns — the agent restates its window every time, and adding up deltas
 * drifts.
 */
export function Context({ usage, limits }: { usage: Usage; limits?: Limits }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  const full = fullness(usage);
  if (full === undefined) return null;

  const percent = Math.round(full * 100);
  const tight = full > 0.85;

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label={`Context ${percent}% full`}
        title="Context and cost"
        className="relative grid h-10 w-10 place-items-center rounded-full transition-colors hover:bg-raise"
      >
        <Ring full={full} tight={tight} />
        <span className={`absolute font-mono text-micro ${tight ? "text-brick" : "text-mute"}`}>
          {percent}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 bottom-full z-30 mb-2 w-[300px]">
          <Panel usage={usage} limits={limits} />
        </div>
      )}
    </div>
  );
}

/**
 * Everything behind the ring.
 *
 * Its own component, and exported, so it can be drawn on its own — a panel that
 * can only be seen by clicking something is a panel nobody looks at twice.
 */
export function Panel({ usage, limits }: { usage: Usage; limits?: Limits }) {
  const full = fullness(usage);
  if (full === undefined) return null;
  const tight = full > 0.85;

  return (
    <div className="rounded-lg border border-line bg-panel p-3.5 shadow-[0_12px_36px_-14px_rgba(0,0,0,0.85)]">
      <Window usage={usage} full={full} tight={tight} />
      <Composition usage={usage} />
      <Cost usage={usage} />
      <Turn usage={usage} />
      <Allowance limits={limits} />
    </div>
  );
}

/**
 * How much room is left, and in whose window.
 *
 * Named, because a turn is often more than one model and the window being
 * filled belongs to whichever did the work — not to whatever the picker says.
 */
function Window({ usage, full, tight }: { usage: Usage; full: number; tight: boolean }) {
  const busiest = worked(usage);
  return (
    <>
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">Context window</span>
        <span className={`font-mono text-meta ${tight ? "text-brick" : "text-dim"}`}>
          {Math.round(full * 100)}%
        </span>
      </div>
      <Bar of={full} tight={tight} />
      <p className="mt-1.5 font-mono text-meta text-mute">
        {count(usage.contextUsed)} of {count(usage.contextWindow)}
        {busiest && ` · ${pretty(busiest.model)}`}
      </p>
    </>
  );
}

/**
 * What that number is made of.
 *
 * The interesting row is the first: once caching is working, almost everything
 * the model reads was already paid for, which is why the billed input can read
 * as eight tokens on a turn that had a hundred thousand in front of it.
 */
function Composition({ usage }: { usage: Usage }) {
  const rows: [string, number | null | undefined][] = [
    ["Read from cache", usage.cacheReadTokens],
    ["Newly cached", usage.cacheWriteTokens],
    ["New", usage.inputTokens],
    ["Written", usage.outputTokens],
  ];
  const some = rows.filter(([, n]) => n !== null && n !== undefined);
  if (some.length === 0) return null;

  return (
    <Section label="What went in">
      {some.map(([what, n]) => (
        <Row key={what} left={what} right={count(n)} />
      ))}
      {!!usage.thinkingTokens && (
        <p className="mt-1 text-meta text-mute">
          {count(usage.thinkingTokens)} of what it wrote was thinking.
        </p>
      )}
    </Section>
  );
}

/**
 * What the session has cost, per model.
 *
 * Per model rather than as one figure because a turn quietly involves a small
 * model naming and summarising things alongside the one doing the work, and it
 * is on the bill. One model, one line — the breakdown only earns its space
 * when there is something to break down.
 */
function Cost({ usage }: { usage: Usage }) {
  const models = usage.models ?? [];
  const paid = models.filter((m) => m.costUsd);
  if (usage.costUsd === null || usage.costUsd === undefined) return null;

  return (
    <Section label="Cost">
      {paid.length > 1 &&
        paid.map((m) => <Row key={m.model} left={pretty(m.model)} right={money(m.costUsd)} />)}
      <Row left="This session" right={money(usage.costUsd)} strong />
    </Section>
  );
}

/** How the last turn went, in the two numbers anybody asks about. */
function Turn({ usage }: { usage: Usage }) {
  const { durationMs, firstTokenMs, denied } = usage;
  if (!durationMs && !firstTokenMs && !denied?.length) return null;

  return (
    <Section label="Last turn">
      {durationMs !== null && durationMs !== undefined && (
        <Row left="Took" right={seconds(durationMs)} />
      )}
      {firstTokenMs !== null && firstTokenMs !== undefined && (
        <Row left="First word after" right={seconds(firstTokenMs)} />
      )}
      {!!denied?.length && (
        <Row left={denied.length === 1 ? "Refused" : `Refused ${denied.length}`} right={denied.join(", ")} />
      )}
    </Section>
  );
}

/**
 * What the account's limits allow.
 *
 * A window, whether we are inside it, and when it starts again — which is all
 * the agent reports. There is no proportion in the stream, so there is no bar
 * here: a bar without a numerator is a drawing.
 */
function Allowance({ limits }: { limits?: Limits }) {
  if (!limits) return null;
  const blocked = limits.status !== "allowed";
  // A reset time that has already gone by says nothing: the window turned over
  // and the agent has not mentioned the next one. The status is what is still
  // true.
  const resets = limits.resetsAt ? away(limits.resetsAt) : undefined;
  return (
    <Section label="Plan limit">
      <Row left={window_(limits.window)} right={resets ?? limits.status} />
      {blocked && (
        <p className="mt-1 text-meta text-brick">
          This window is {limits.status}. The agent will wait rather than run.
        </p>
      )}
    </Section>
  );
}

/* ── The parts every section is built from ──────────────────── */

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3.5 border-t border-line-soft pt-3">
      <div className="eyebrow mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function Row({ left, right, strong }: { left: string; right: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[1.5px]">
      <span className={`shrink-0 text-meta ${strong ? "text-dim" : "text-mute"}`}>{left}</span>
      <span
        className={`min-w-0 truncate text-right font-mono text-meta ${
          strong ? "text-bone" : "text-dim"
        }`}
      >
        {right}
      </span>
    </div>
  );
}

function Bar({ of, tight }: { of: number; tight: boolean }) {
  return (
    <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-raise">
      <div
        className={`h-full rounded-full ${tight ? "bg-brick" : "bg-slate"}`}
        style={{ width: `${Math.max(of * 100, 1.5)}%` }}
      />
    </div>
  );
}

function Ring({ full, tight }: { full: number; tight: boolean }) {
  const R = 8;
  const circumference = 2 * Math.PI * R;
  return (
    <svg viewBox="0 0 20 20" className="h-[21px] w-[21px] -rotate-90">
      <circle cx="10" cy="10" r={R} fill="none" strokeWidth="2" className="stroke-line" />
      <circle
        cx="10"
        cy="10"
        r={R}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - full)}
        className={tight ? "stroke-brick" : "stroke-mute"}
      />
    </svg>
  );
}

/* ── Reading the numbers ────────────────────────────────────── */

/** 0 to 1, when the agent has said enough to work it out. */
export function fullness(usage: Usage): number | undefined {
  const { contextUsed, contextWindow } = usage;
  if (!contextUsed || !contextWindow) return undefined;
  return Math.min(1, Math.max(0, contextUsed / contextWindow));
}

/** Whichever model had the most in front of it — the one whose window is filling. */
function worked(usage: Usage): ModelUsage | undefined {
  const size = (m: ModelUsage) =>
    m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens;
  return (usage.models ?? []).reduce<ModelUsage | undefined>(
    (most, m) => (!most || size(m) > size(most) ? m : most),
    undefined,
  );
}

/**
 * A model identifier, as somebody would say it.
 *
 * `claude-haiku-4-5-20251001` is a build number wearing a name. Dated segments
 * go, the family is capitalised, and what is left of the version reads as one.
 */
function pretty(model: string): string {
  const bits = model
    .replace(/^claude-/, "")
    .replace(/\[.*\]$/, "")
    .split("-")
    .filter((bit) => bit && !/^\d{8}$/.test(bit));
  const [family, ...version] = bits;
  if (!family) return model;
  const name = family[0].toUpperCase() + family.slice(1);
  return version.length ? `${name} ${version.join(".")}` : name;
}

function count(n?: number | null): string {
  return n === null || n === undefined ? "—" : n.toLocaleString();
}

/**
 * Dollars, to as many places as the figure deserves.
 *
 * A background call that cost a tenth of a cent rounds to $0.00, which reads as
 * free rather than as small.
 */
function money(n?: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  if (n >= 0.0001) return `$${n.toFixed(4)}`;
  return "<$0.0001";
}

function seconds(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const mins = Math.floor(ms / 60_000);
  return `${mins} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** `five_hour` as a phrase. */
function window_(name: string): string {
  return name.replace(/_/g, "-").replace(/^\w/, (c) => c.toUpperCase());
}

/** How long until a unix timestamp, or nothing when it has already gone by. */
function away(at: number): string | undefined {
  const left = at * 1000 - Date.now();
  if (left <= 0) return undefined;
  const mins = Math.round(left / 60_000);
  if (mins < 60) return `resets in ${mins} min`;
  return `resets in ${Math.floor(mins / 60)} hr ${mins % 60} min`;
}

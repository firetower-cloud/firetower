"use client";

import Link from "next/link";
import { useState } from "react";
import { elapsed, inFlight, needsYou, STATUS_LABEL, type SessionView } from "@/src/api/view";
import { TONE } from "./Signal";

/* ── The signature: a lookout's view of the horizon ─────────────────────
   Every agent that's still in flight gets a stem. Height is how long it
   has been running; left is oldest. Ember means it stopped without you.
   One glance tells you where the smoke is.                              */

/* Scaled against the longest-running agent so the band is always used. */
const stemHeight = (m: number, max: number) =>
  22 + (72 * Math.log(1 + m)) / Math.log(1 + max);

export function Horizon({ sessions }: { sessions: SessionView[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const live = sessions
    .filter((t) => needsYou(t) || inFlight(t))
    .sort((a, b) => b.minutes - a.minutes);
  const max = Math.max(1, ...live.map((t) => t.minutes));

  if (live.length === 0) return null;

  return (
    <div className="relative select-none">
      <div className="relative h-[116px] overflow-hidden">
        {/* distant ridgelines — atmosphere, deliberately near-invisible */}
        <svg
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[46px] w-full"
          viewBox="0 0 1000 46"
          preserveAspectRatio="none"
          aria-hidden
        >
          <path d="M0 34 L120 20 L215 30 L340 12 L455 27 L580 16 L700 31 L830 18 L940 29 L1000 22 V46 H0 Z" fill="#1b1611" />
          <path d="M0 40 L95 32 L190 39 L300 28 L420 38 L540 30 L660 40 L790 31 L900 39 L1000 34 V46 H0 Z" fill="#131110" />
        </svg>

        <div className="absolute inset-x-0 bottom-0 flex h-full items-end">
          {live.map((t, i) => (
            <Stem
              key={t.id}
              session={t}
              index={i}
              total={live.length}
              max={max}
              hover={hover === t.id}
              onHover={setHover}
            />
          ))}
        </div>
      </div>

      <div className="border-t border-line" />

      <div className="flex items-center justify-between pt-2">
        <span className="eyebrow">Longest running</span>
        <span className="eyebrow flex items-center gap-4">
          <Key tone="text-ember" label="Needs you" />
          <Key tone="text-slate" label="Working" />
        </span>
        <span className="eyebrow">Just launched</span>
      </div>
    </div>
  );
}

function Key({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${tone}`} />
      {label}
    </span>
  );
}

function Stem({
  session,
  index,
  total,
  max,
  hover,
  onHover,
}: {
  session: SessionView;
  index: number;
  total: number;
  max: number;
  hover: boolean;
  onHover: (id: string | null) => void;
}) {
  const h = stemHeight(session.minutes, max);
  const waiting = session.status === "NeedsYou";
  const tone = TONE[session.status];
  const show = waiting || hover;

  return (
    <Link
      href={`/sessions/${session.id}`}
      onMouseEnter={() => onHover(session.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(session.id)}
      onBlur={() => onHover(null)}
      className="group relative flex h-full flex-col items-center justify-end pb-[17px]"
      style={{ width: `${100 / total}%` }}
    >
      {waiting && (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-[10px] left-1/2 h-[86px] w-[150px] -translate-x-1/2"
          style={{
            background:
              "radial-gradient(closest-side, rgba(255,107,44,0.15), rgba(255,107,44,0.03) 60%, transparent)",
          }}
        />
      )}
      <div
        className="stem-rise flex w-full flex-col items-center justify-end"
        style={{ height: `${h}%`, animationDelay: `${index * 70}ms` }}
      >
        <div
          className={`max-w-full truncate px-1 pb-1.5 font-narrow text-[10px] font-semibold tracking-[0.1em] uppercase transition-opacity duration-200 ${tone} ${
            show ? "opacity-100" : "opacity-0"
          }`}
        >
          {/* The last part identifies it; a bare agent has none. */}
          {session.repo?.split("/").pop() ?? "no repo"}
        </div>

        <span className={`relative flex items-center justify-center ${tone}`}>
          {waiting && <span className="ember-pulse absolute h-2 w-2 rounded-full bg-current" />}
          <span
            className={`relative h-[7px] w-[7px] rounded-full bg-current transition-transform duration-200 ${
              hover ? "scale-150" : ""
            }`}
          />
        </span>

        <span
          className={`w-px flex-1 ${tone}`}
          style={{
            background: waiting
              ? "linear-gradient(to bottom, currentColor, transparent)"
              : "linear-gradient(to bottom, currentColor, transparent 88%)",
            opacity: hover ? 0.9 : waiting ? 0.7 : 0.3,
          }}
        />
      </div>

      <div
        className={`absolute bottom-[2px] font-mono text-[10px] transition-colors ${
          hover || waiting ? "text-dim" : "text-mute/60"
        }`}
      >
        {elapsed(session.minutes)}
      </div>

      <span className="sr-only">
        {session.repo ?? "no repository"} — {session.name} — {STATUS_LABEL[session.status]}
      </span>
    </Link>
  );
}

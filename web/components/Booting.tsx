"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Signal, KeyGlyph } from "./Signal";
import { Bullet } from "./Terminal";

/* Launching opens the session. What you land on is a workspace being built —
   the one moment where showing the machinery is the point, because it's how
   you learn to trust closing the laptop. */

const BOOT: [string, string, number][] = [
  ["Picked a host", "fire-02 — 9 of 16 GB free, 2 sessions running", 700],
  ["Fetched the repository", "from the mirror on fire-02 · 0.9s", 900],
  ["Added a worktree", "cut from main", 600],
  ["Started the workspace", "docker · 2 CPU / 4 GB", 1100],
  ["Ran the setup script", "pnpm install --frozen-lockfile · 4.2s", 1500],
  ["Opened tmux", "firetower:s-118", 500],
  ["Launched Claude Code", "2.1.44 · Max plan", 700],
];

/** agent/<slug> — Firetower names the branch from the prompt. */
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter((w) => !["the", "a", "an", "for", "to", "in", "and", "of"].includes(w))
    .slice(0, 3)
    .join("-") || "session";

export function Booting() {
  const params = useSearchParams();
  const prompt = params.get("p") ?? "Fix retry handling for Stripe webhook processing.";
  const repo = params.get("repo") ?? "acme/backend";

  const [step, setStep] = useState(0);
  const done = step >= BOOT.length;
  const slug = slugify(prompt);
  const branch = `agent/${slug}`;
  /* Sessions get a short name, same derivation as the branch. The prompt
     itself stays in the transcript where it belongs. */
  const title = slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

  useEffect(() => {
    if (done) return;
    const t = setTimeout(() => setStep((s) => s + 1), BOOT[step][2]);
    return () => clearTimeout(t);
  }, [step, done]);

  return (
    <div className="flex h-screen min-h-0 flex-col">
      <header className="shrink-0 border-b border-line bg-panel">
        <div className="flex items-center gap-3 px-5 pt-3.5 pb-2.5">
          <Link
            href="/"
            className="rounded-[4px] px-1.5 py-0.5 text-[13px] text-mute transition-colors hover:bg-raise hover:text-text"
          >
            ←
          </Link>
          <span className="font-mono text-[12px] text-mute">{repo}</span>
          <h1 className="min-w-0 truncate text-[15px] font-semibold text-bone">{title}</h1>

          <span
            className={`ml-2 flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-ground py-0.5 pr-2.5 pl-1.5 font-narrow text-[10px] font-semibold tracking-[0.12em] uppercase ${
              done ? "text-slate" : "text-slate"
            }`}
          >
            <Signal status={done ? "Working" : "Starting"} size={5} />
            {done ? "Working" : "Starting up"}
          </span>
        </div>

        <div className="flex items-center gap-4 px-5 pb-2.5 font-mono text-[11.5px] text-mute">
          <span>
            <span className="text-slate">⑂ {branch}</span> → main
          </span>
          <span>⌂ fire-02</span>
          <span>◈ Claude Code</span>
          <span className="flex items-center gap-1">
            <KeyGlyph size={10} /> Max plan
          </span>
        </div>

        <nav className="flex items-center gap-px px-3">
          {["Terminal", "Diff", "Files", "Activity"].map((t, i) => (
            <span
              key={t}
              className={`relative px-3 py-2 text-[12.5px] ${i === 0 ? "text-bone" : "text-mute/60"}`}
            >
              {t}
              {i === 0 && <span className="absolute inset-x-2 -bottom-px h-[2px] bg-ember" />}
            </span>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#0a0908] px-5 py-5">
        <div className="max-w-[680px]">
          <div className="eyebrow mb-3">Building the workspace</div>

          <div className="flex flex-col">
            {BOOT.map(([what, detail], i) => {
              const state = i < step ? "done" : i === step ? "now" : "todo";
              return (
                <div
                  key={what}
                  className={`flex items-baseline gap-3 py-[7px] font-mono text-[12.5px] transition-opacity duration-300 ${
                    state === "todo" ? "opacity-35" : "opacity-100"
                  }`}
                >
                  <span className="w-3 shrink-0">
                    {state === "done" ? (
                      <span className="text-sage">✓</span>
                    ) : state === "now" ? (
                      <span className="breathe inline-block h-1.5 w-1.5 rounded-full bg-ember" />
                    ) : (
                      <span className="inline-block h-1.5 w-1.5 rounded-full border border-mute" />
                    )}
                  </span>
                  <span className={`w-[190px] shrink-0 ${state === "todo" ? "text-mute" : "text-text"}`}>
                    {what}
                  </span>
                  <span className="text-mute">{state === "todo" ? "" : detail}</span>
                </div>
              );
            })}
          </div>

          {!done && (
            <p className="mt-6 border-l border-line pl-3 text-[12.5px] leading-[1.6] text-mute">
              You don&apos;t have to wait for this. Close the tab — Firetower will buzz you
              when the session needs something or hands the work back.
            </p>
          )}

          {done && (
            <div className="mt-7 border-t border-line pt-5">
              <div className="font-mono text-[12.5px] leading-[1.75]">
                <div className="my-3 rounded-[5px] border border-line bg-raise px-3 py-2">
                  <div className="eyebrow mb-1">You</div>
                  <div className="text-[12.5px] text-text">{prompt}</div>
                </div>

                <div className="my-1.5">
                  <div className="text-dim">
                    <Bullet /> <span className="text-bone">Grep</span>
                    <span className="text-mute">(</span>
                    <span className="text-slate">processWebhook</span>
                    <span className="text-mute">)</span>
                  </div>
                  <div className="pl-4 text-mute">⎿ 6 matches in 4 files</div>
                </div>

                <div className="mt-3 flex items-center gap-2 text-bone">
                  <span className="text-ember">›</span>
                  <span className="caret inline-block h-[15px] w-[7px] bg-bone align-middle" />
                </div>
              </div>

              <div className="mt-7 flex items-center gap-3">
                <Link
                  href="/"
                  className="rounded-[5px] border border-line bg-raise px-3 py-1.5 text-[12.5px] font-medium text-text transition-colors hover:border-[#3a3631] hover:text-bone"
                >
                  ← Back to sessions
                </Link>
                <span className="text-[12px] text-mute">
                  It&apos;s working. You can close this.
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-line bg-[#12100e] px-3 py-1 font-mono text-[10.5px] text-mute">
        <span className="rounded-[3px] bg-sage/15 px-1.5 py-0.5 text-sage">firetower</span>
        <span className={done ? "text-dim" : "text-mute/50"}>0:claude{done ? "*" : ""}</span>
        <span className={done ? "" : "text-mute/50"}>1:shell</span>
        <span className="ml-auto">
          fire-02 · {branch}
        </span>
      </div>
    </div>
  );
}

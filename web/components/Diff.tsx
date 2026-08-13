"use client";

import { useState } from "react";
import { DIFF_HUNKS, type FileChange } from "@/lib/data";

export function Diff({ files }: { files: FileChange[] }) {
  const [active, setActive] = useState(0);

  return (
    <div className="flex h-full min-h-0">
      <div className="w-[236px] shrink-0 overflow-y-auto border-r border-line bg-panel py-2">
        {files.map((f, i) => (
          <button
            key={f.path}
            onClick={() => setActive(i)}
            className={`flex w-full items-center gap-2 px-3 py-[5px] text-left transition-colors ${
              active === i ? "bg-raise" : "hover:bg-raise/50"
            }`}
          >
            <span
              className={`font-mono text-[10px] ${
                f.mode === "A" ? "text-sage" : f.mode === "D" ? "text-brick" : "text-mute"
              }`}
            >
              {f.mode}
            </span>
            <span
              className={`flex-1 truncate font-mono text-[11.5px] ${
                active === i ? "text-bone" : "text-dim"
              }`}
              dir="rtl"
            >
              {f.path}
            </span>
            <span className="font-mono text-[10px] text-sage">+{f.add}</span>
            {f.del > 0 && <span className="font-mono text-[10px] text-brick">−{f.del}</span>}
          </button>
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto bg-[#0a0908]">
        {DIFF_HUNKS.map((h, i) => (
          <Hunk key={i} header={h.header} lines={h.lines} />
        ))}
        <div className="px-5 py-6 text-center text-[11.5px] text-mute">
          Showing 2 of 8 changed files
        </div>
      </div>
    </div>
  );
}

function Hunk({
  header,
  lines,
}: {
  header: string;
  lines: { t: string; n: (number | null)[]; s: string }[];
}) {
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState(false);

  return (
    <div className="group/hunk border-b border-line">
      <div className="flex items-center justify-between bg-panel px-4 py-1.5">
        <span className="truncate font-mono text-[11px] text-slate">{header}</span>
        <button
          onClick={() => setAsking((v) => !v)}
          className="shrink-0 rounded-[4px] border border-line px-2 py-0.5 font-narrow text-[10px] font-semibold tracking-[0.1em] text-mute uppercase opacity-0 transition-opacity group-hover/hunk:opacity-100 hover:border-ember hover:text-ember focus-visible:opacity-100"
        >
          Ask about this
        </button>
      </div>

      <div className="font-mono text-[12px] leading-[1.65]">
        {lines.map((l, i) => (
          <div
            key={i}
            className={`flex ${
              l.t === "+"
                ? "bg-sage/[0.07]"
                : l.t === "-"
                  ? "bg-brick/[0.07]"
                  : ""
            }`}
          >
            <span className="w-11 shrink-0 pr-2 text-right text-[10.5px] text-mute/60 select-none">
              {l.n[0] ?? ""}
            </span>
            <span className="w-11 shrink-0 pr-2 text-right text-[10.5px] text-mute/60 select-none">
              {l.n[1] ?? ""}
            </span>
            <span
              className={`w-4 shrink-0 select-none ${
                l.t === "+" ? "text-sage" : l.t === "-" ? "text-brick" : "text-mute/40"
              }`}
            >
              {l.t.trim() || " "}
            </span>
            <span
              className={`whitespace-pre ${
                l.t === "+" ? "text-[#bcd2b5]" : l.t === "-" ? "text-[#e0a79f]" : "text-dim"
              }`}
            >
              {l.s}
            </span>
          </div>
        ))}
      </div>

      {asking && (
        <div className="border-t border-line bg-panel px-4 py-3">
          {sent ? (
            <div className="flex items-center gap-2 font-mono text-[11.5px] text-ember">
              <span className="breathe h-1.5 w-1.5 rounded-full bg-current" />
              Sent into the live session with the file and line range attached.
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                placeholder="Why full jitter here rather than equal jitter?"
                onKeyDown={(e) => e.key === "Enter" && setSent(true)}
                className="flex-1 rounded-[5px] border border-line bg-ground px-2.5 py-1.5 text-[12.5px] text-bone placeholder:text-mute focus:border-ember focus:outline-none"
              />
              <button
                onClick={() => setSent(true)}
                className="rounded-[5px] bg-ember px-3 py-1.5 text-[12px] font-semibold text-[#1a0c04]"
              >
                Send
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { elapsed, outcomeOf, type SessionView } from "@/src/api/view";
import { Signal } from "./Signal";

const BAR: Record<string, string> = {
  NeedsYou: "bg-ember",
  HandedBack: "bg-sage",
  Failed: "bg-brick",
};

export function NeedsCard({ session }: { session: SessionView }) {
  const waiting = session.status === "NeedsYou";

  return (
    <div
      className={`panel relative overflow-hidden ${
        waiting ? "bg-ember/[0.035] border-ember/25" : ""
      }`}
    >
      <span className={`absolute inset-y-0 left-0 w-[2px] ${BAR[session.status]}`} />

      <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
        <div className="pt-0.5">
          <Signal status={session.status} />
        </div>

        <div className="min-w-0 flex-1">
          {/* What to call it, then what it was asked to do. Five sessions on
              one repository used to differ only in a title cut from the first
              four words of the prompt, which for "ask me a question about…"
              meant five cards reading almost the same thing. */}
          <Link href={`/sessions/${session.id}`} className="group flex items-baseline gap-2">
            <span className="text-[14px] font-semibold text-bone group-hover:underline">
              {session.name}
            </span>
            <span className="min-w-0 truncate text-[13px] text-dim">{session.title}</span>
          </Link>

          <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-mute">
            <span>{session.repo}</span>
            <span>·</span>
            <span>{session.agent}</span>
            <span>·</span>
            <span>{session.host}</span>
            <span>·</span>
            <span>{elapsed(session.minutes)}{waiting ? " waiting" : " ago"}</span>
          </div>

          {/* What it actually wants, in its own words — the permission it is
              asking for, the last thing it said, the error that stopped it.
              Without this the card is a red dot you have to open a terminal to
              understand, and opening the terminal is most of the cost of being
              interrupted. */}
          {session.note && (
            <p className="mt-2.5 line-clamp-3 text-[13px] leading-[1.5] text-text">
              {session.note}
            </p>
          )}

          {session.status === "HandedBack" && (
            <p className="mt-3 flex items-center gap-3 text-[13px] text-text">
              <span>{outcomeOf(session)}</span>
              <span className="font-mono text-[11.5px] text-mute">{session.branch}</span>
            </p>
          )}

          {session.status === "Failed" && (
            <p className="mt-3 font-mono text-[12px] text-brick/90">{outcomeOf(session)}</p>
          )}

          {/* One way out of every state: the terminal.
              There used to be a reply box here. It was never wired to anything
              — the button set a local flag and rendered "Sent. ClaudeCode
              picked it up.", which was untrue — and it could not have worked
              anyway. What blocks an agent is usually a permission prompt
              wanting `1`, `2` or `3` against options this card cannot see,
              because a notification message is a sentence rather than a menu.
              Answering happens where the question is. */}
          <div className="mt-3.5 flex items-center gap-2">
            <Link
              href={`/sessions/${session.id}`}
              className={
                waiting
                  ? "rounded-[5px] bg-ember px-3 py-1.5 text-[12.5px] font-semibold text-[#1a0c04] transition-opacity hover:opacity-90"
                  : "rounded-[5px] border border-line bg-raise px-3 py-1.5 text-[12.5px] font-medium text-text transition-colors hover:border-[#3a3631] hover:text-bone"
              }
            >
              {waiting
                ? "Open agent"
                : session.status === "HandedBack"
                  ? "Review changes"
                  : "Open terminal"}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

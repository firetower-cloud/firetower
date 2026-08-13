"use client";

import Link from "next/link";
import { useState } from "react";
import { elapsed, outcomeOf, type SessionView } from "@/src/api/view";
import { Signal } from "./Signal";

const BAR: Record<string, string> = {
  NeedsYou: "bg-ember",
  HandedBack: "bg-sage",
  Failed: "bg-brick",
};

export function NeedsCard({ session }: { session: SessionView }) {
  const [reply, setReply] = useState("");
  const [sent, setSent] = useState(false);
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
          <Link href={`/sessions/${session.id}`} className="group flex items-baseline gap-2">
            <span className="font-mono text-[11.5px] text-mute">{session.repo}</span>
            <span className="text-[14px] font-semibold text-bone group-hover:underline">
              {session.title}
            </span>
          </Link>

          <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-mute">
            <span>{session.agent}</span>
            <span>·</span>
            <span>{session.host}</span>
            <span>·</span>
            <span>{elapsed(session.minutes)}{waiting ? " waiting" : " ago"}</span>
          </div>

          
          {session.status === "HandedBack" && (
            <p className="mt-3 flex items-center gap-3 text-[13px] text-text">
              <span>{outcomeOf(session)}</span>
              <span className="font-mono text-[11.5px] text-mute">{session.branch}</span>
            </p>
          )}

          {session.status === "Failed" && (
            <p className="mt-3 font-mono text-[12px] text-brick/90">{outcomeOf(session)}</p>
          )}

          <div className="mt-3.5 flex items-center gap-2">
            {waiting ? (
              sent ? (
                <span className="flex items-center gap-2 font-mono text-[11.5px] text-ember">
                  <span className="breathe h-1.5 w-1.5 rounded-full bg-current" />
                  Sent. {session.agent} picked it up.
                </span>
              ) : (
                <>
                  <input
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && reply.trim() && setSent(true)}
                    placeholder="Reuse Nav.tsx for both."
                    className="flex-1 rounded-[5px] border border-line bg-ground px-2.5 py-1.5 text-[13px] text-bone placeholder:text-mute focus:border-ember focus:outline-none"
                  />
                  <button
                    onClick={() => reply.trim() && setSent(true)}
                    className="shrink-0 rounded-[5px] bg-ember px-3 py-1.5 text-[12.5px] font-semibold text-[#1a0c04] transition-opacity hover:opacity-90"
                  >
                    Reply
                  </button>
                </>
              )
            ) : (
              <Link
                href={`/sessions/${session.id}`}
                className="rounded-[5px] border border-line bg-raise px-3 py-1.5 text-[12.5px] font-medium text-text transition-colors hover:border-[#3a3631] hover:text-bone"
              >
                {session.status === "HandedBack" ? "Review changes" : "Open terminal"}
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

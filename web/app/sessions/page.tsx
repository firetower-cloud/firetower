"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { listSessions } from "@/src/api/generated/sessions/sessions";
import type { Session } from "@/src/api/generated/model";
import { Signal } from "@/components/Signal";
import { elapsed, minutesSince, outcomeOf, STATUS_LABEL, toView } from "@/src/api/view";
import { ApiError } from "@/src/api/http";

/** Enough to fill a screen and ask for more before you reach the bottom. */
const PAGE = 30;

/**
 * Every session there has ever been.
 *
 * Paged rather than fetched whole: this grows without limit, and the dashboard
 * already covers the handful you care about right now.
 */
export default function AllSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const sentinel = useRef<HTMLDivElement>(null);
  // Read inside the observer, which would otherwise capture a stale array.
  const cursor = useRef<string | undefined>(undefined);

  const more = useCallback(async () => {
    if (loading || done) return;
    setLoading(true);

    try {
      const page = await listSessions({ limit: PAGE, before: cursor.current });
      setSessions((seen) => [...seen, ...page]);
      cursor.current = page.at(-1)?.id;
      // A short page means the end; asking again would return nothing.
      if (page.length < PAGE) setDone(true);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load more sessions.");
      // Stop climbing: an observer that retries on every scroll would hammer it.
      setDone(true);
    } finally {
      setLoading(false);
    }
  }, [loading, done]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => entries[0].isIntersecting && more(),
      // Fetch before it comes into view, so scrolling doesn't stall.
      { rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [more]);

  return (
    <div className="max-w-[900px] px-8 pt-8 pb-24">
      <header className="mb-7">
        <Link href="/" className="text-[12px] text-mute transition-colors hover:text-text">
          ← Dashboard
        </Link>
        <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-bone">
          All sessions
        </h1>
        <p className="mt-1.5 text-[14px] text-dim">
          {sessions.length > 0
            ? `${sessions.length}${done ? "" : "+"} so far, newest first.`
            : "Everything Firetower has run."}
        </p>
      </header>

      <div className="flex flex-col">
        {sessions.map((raw) => {
          const s = toView(raw);
          const ended = s.status === "Ended";

          return (
            <Link
              key={s.id}
              href={`/sessions/${s.id}`}
              className="flex items-center gap-3 rounded-[5px] px-3 py-2 transition-colors hover:bg-panel"
            >
              <Signal status={s.status} size={6} />
              <span className={`shrink-0 text-[13.5px] ${ended ? "text-dim" : "text-bone"}`}>
                {s.name}
              </span>
              <span className="font-mono text-[11.5px] text-mute">{many(s)}</span>
              <span
                className={`min-w-0 flex-1 truncate text-[13.5px] ${ended ? "text-dim" : "text-text"}`}
              >
                {s.title}
              </span>
              <span className="hidden font-mono text-[11px] text-mute md:block">
                {ended ? outcomeOf(s) : (STATUS_LABEL[s.status] ?? s.status)}
              </span>
              <span className="w-10 text-right font-mono text-[11px] text-mute">
                {elapsed(minutesSince(s.createdAt))}
              </span>
            </Link>
          );
        })}
      </div>

      {error && (
        <p className="mt-4 rounded-[6px] border border-ember/30 bg-ember/[0.05] px-3.5 py-2.5 text-[12.5px] text-bone">
          {error}
        </p>
      )}

      {!done && (
        <div ref={sentinel} className="py-6 text-center text-[12px] text-mute">
          {loading ? "Loading…" : " "}
        </div>
      )}

      {done && sessions.length === 0 && !error && (
        <p className="panel px-4 py-6 text-center text-[13px] text-mute">
          No sessions yet.
        </p>
      )}
    </div>
  );
}

/**
 * What a row says a session is on.
 *
 * The first repository, and how many others — a row has space for one name,
 * and "+1" is the part that says this session is not what it looks like.
 */
function many(session: { repo?: string | null; checkouts?: { slug: string }[] }): string {
  const held = session.checkouts ?? [];
  if (held.length > 1) return `${held[0].slug} +${held.length - 1}`;
  return held[0]?.slug ?? session.repo ?? "";
}

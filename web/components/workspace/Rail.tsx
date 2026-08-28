"use client";

import Link from "next/link";
import { useState } from "react";
import { useListSessions } from "@/src/api/generated/sessions/sessions";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import { useMe, useLogout } from "@/src/api/generated/auth/auth";
import { forgetToken } from "@/src/api/http";
import type { Session } from "@/src/api/generated/model";
import { Mark, Signal } from "@/components/Signal";
import { elapsed, minutesSince, needsYou, unfinished } from "@/src/api/view";
import { useOpen, useTabs, addressOf } from "@/src/workspace/tabs";

/**
 * Sessions, not files.
 *
 * The left of an editor lists a directory because an editor is about one
 * repository. This is a control plane for a fleet, and the question it exists
 * to answer is *where is my attention needed* — so what is waiting on you is
 * pinned at the top and sorts first inside its group, and everything else is
 * grouped by the repository it is working on.
 */
export function Rail({ onNew }: { onNew: () => void }) {
  const { data: sessions = [] } = useListSessions(undefined, {
    query: {
      // Faster while something is still going, slow rather than never once
      // nothing is: a session started from a phone should still turn up.
      refetchInterval: (query) => ((query.state.data ?? []).some(unfinished) ? 2_000 : 15_000),
    },
  });

  const live = sessions.filter((s) => unfinished(s) || needsYou(s));
  const waiting = live.filter(needsYou);

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col overflow-hidden border-r border-line bg-panel">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <span className="text-bone">
          <Mark size={20} />
        </span>
        <span className="font-narrow text-[12px] font-semibold tracking-[0.22em] text-bone uppercase">
          Firetower
        </span>
      </div>

      {waiting.length > 0 && (
        <div className="px-2 pb-2">
          <div className="flex items-center gap-2 rounded-[8px] border border-ember-deep bg-ember/[0.06] px-2.5 py-1.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember" />
            <span className="font-narrow text-[10px] font-semibold tracking-[0.14em] text-ember uppercase">
              Waiting on you
            </span>
            <span className="ml-auto font-mono text-[11px] text-ember">{waiting.length}</span>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <Grouped sessions={live} />
        {live.length === 0 && (
          <p className="px-2.5 py-2 text-[13px] text-mute">Nothing running.</p>
        )}
      </div>

      <button
        onClick={onNew}
        className="mx-2 mb-2 shrink-0 rounded-[8px] border border-dashed border-line py-2 text-ui text-mute transition-colors hover:border-ember/40 hover:text-ember"
      >
        + New session
      </button>

      <Hosts />

      {/* One line, and it has to stay one line: these are the pages that are
          still pages, and a rail that reflows them into two rows steals a row
          from the sessions above it every time the window narrows. */}
      <nav className="flex shrink-0 items-center justify-between gap-1 border-t border-line px-3 py-2">
        {[
          ["/repos", "Repos"],
          ["/agents", "Agents"],
          ["/secrets", "Secrets"],
          ["/compute", "Compute"],
        ].map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className="rounded-[5px] px-1.5 py-1 text-[11px] whitespace-nowrap text-mute transition-colors hover:bg-raise/60 hover:text-ember"
          >
            {label}
          </Link>
        ))}
      </nav>

      <WhoAmI />
    </aside>
  );
}

/**
 * Sessions under the repository they are working on.
 *
 * Grouped rather than flat because a fleet's session list is mostly noise to
 * somebody thinking about one repository, and the group header is the fastest
 * way to skip past four of them. Within a group, what is waiting on you first.
 */
function Grouped({ sessions }: { sessions: Session[] }) {
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = s.checkouts?.[0]?.slug ?? s.repo ?? "No repository";
    const held = groups.get(key);
    if (held) held.push(s);
    else groups.set(key, [s]);
  }

  return (
    <>
      {[...groups].map(([repo, held]) => (
        <section key={repo} className="mb-3">
          <div className="flex items-baseline gap-2 px-2.5 py-1">
            <span className="min-w-0 truncate font-mono text-[11px] text-mute" title={repo}>
              {repo.split("/").slice(-1)[0]}
            </span>
            <span className="h-px flex-1 bg-line-soft" />
          </div>
          {held
            .slice()
            .sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)))
            .map((s) => (
              <Row key={s.id} session={s} />
            ))}
        </section>
      ))}
    </>
  );
}

function Row({ session }: { session: Session }) {
  const open = useOpen();
  const { state } = useTabs();
  const on = state.active.includes(addressOf.session(session.id));
  const asks = needsYou(session);

  return (
    <button
      onClick={() => open.session(session.id)}
      title={session.title ?? session.name}
      className={`flex w-full items-center gap-2 rounded-[8px] py-[7px] pr-2 pl-2 text-left transition-colors ${
        on ? "bg-raise" : "hover:bg-raise/60"
      }`}
    >
      <Signal status={session.status} size={6} />
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-[13px] ${
            asks ? "text-bone" : on ? "text-bone" : "text-dim"
          }`}
        >
          {session.name}
        </span>
        <span className="block truncate font-mono text-[10.5px] text-mute">
          {(session.agent ?? "").toLowerCase()} · {elapsed(minutesSince(session.createdAt))}
        </span>
      </span>
      {asks && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember" />}
    </button>
  );
}

function Hosts() {
  const { data: hosts = [] } = useListHosts();
  const [showing, setShowing] = useState(false);

  if (hosts.length === 0) return null;
  const up = hosts.filter((h) => h.state === "Online").length;

  return (
    <div className="shrink-0 border-t border-line px-4 py-2">
      <button
        onClick={() => setShowing(!showing)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="eyebrow">Hosts</span>
        <span className="ml-auto font-mono text-[10px] text-mute">
          {up}/{hosts.length}
        </span>
        <span className="text-[9px] text-mute">{showing ? "▾" : "▸"}</span>
      </button>
      {showing && (
        <div className="mt-1.5 max-h-[22vh] overflow-y-auto">
          {hosts.map((h) => (
            <div key={h.name} className="flex items-center gap-2 py-[3px]">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  h.state === "Online" ? "bg-sage" : "border border-mute"
                }`}
              />
              <span className="min-w-0 truncate font-mono text-meta text-dim">{h.name}</span>
              <span className="ml-auto font-mono text-[10px] text-mute">{h.cpus ?? "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WhoAmI() {
  const { data } = useMe();
  const out = useLogout();

  if (!data) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-dim">{data.user.username}</div>
      </div>
      <button
        onClick={() =>
          out.mutate(undefined, {
            // Whether or not the server managed to delete the row, this browser
            // is done with the token.
            onSettled: () => {
              forgetToken();
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              window.location.assign("/login");
            },
          })
        }
        className="text-[11.5px] text-mute transition-colors hover:text-text"
      >
        Sign out
      </button>
    </div>
  );
}

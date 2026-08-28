"use client";

import Link from "next/link";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useListSessions } from "@/src/api/generated/sessions/sessions";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import { useMe, useLogout } from "@/src/api/generated/auth/auth";
import { forgetToken } from "@/src/api/http";
import type { Session } from "@/src/api/generated/model";
import { Mark, Signal } from "@/components/Signal";
import { AgentMark, AGENT_SHORT } from "@/components/AgentMark";
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
export function Rail({ onNew }: { onNew: (repo?: string) => void }) {
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
    <aside className="flex h-full w-[268px] shrink-0 flex-col overflow-hidden border-r border-line bg-panel">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-2.5">
        <span className="text-bone">
          <Mark size={20} />
        </span>
        <span className="font-narrow text-[12px] font-semibold tracking-[0.22em] text-bone uppercase">
          Firetower
        </span>
      </div>

      {waiting.length > 0 && (
        <div className="px-2.5 pb-2.5">
          <div className="flex items-center gap-2 rounded-[9px] border border-ember-deep bg-ember/[0.06] px-2.5 py-1.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember" />
            <span className="font-narrow text-[10px] font-semibold tracking-[0.14em] text-ember uppercase">
              Waiting on you
            </span>
            <span className="ml-auto font-mono text-[11px] text-ember">{waiting.length}</span>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2.5">
        <Grouped sessions={live} onNew={onNew} />
        {live.length === 0 && (
          <div className="px-1 py-3">
            <p className="text-[13px] text-dim">Nothing running.</p>
            <p className="mt-1 text-[12px] leading-[1.55] text-mute">
              Describe some work and it runs on your own hardware — you can close the laptop as
              soon as it starts.
            </p>
          </div>
        )}
      </div>

      <button
        onClick={() => onNew()}
        className="mx-2.5 mb-2.5 shrink-0 rounded-[9px] border border-dashed border-line py-2 text-ui text-mute transition-colors hover:border-ember/40 hover:text-ember"
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
 *
 * Collapsible, and remembered: nine sessions on one repository used to push
 * every other repository off the bottom of the rail.
 */
function Grouped({
  sessions,
  onNew,
}: {
  sessions: Session[];
  onNew: (repo?: string) => void;
}) {
  const { shut, toggle } = useShutGroups();

  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = s.checkouts?.[0]?.slug ?? s.repo ?? "No repository";
    const held = groups.get(key);
    if (held) held.push(s);
    else groups.set(key, [s]);
  }

  return (
    <>
      {[...groups].map(([repo, held]) => {
        const closed = shut.includes(repo);
        const asking = held.filter(needsYou).length;

        return (
          <section key={repo} className="mb-2.5">
            <div className="group/head flex items-center gap-1.5 rounded-[6px] py-1 pr-1 pl-0.5">
              <button
                onClick={() => toggle(repo)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <span
                  className="shrink-0 text-[9px] text-mute transition-transform"
                  style={{ transform: closed ? undefined : "rotate(90deg)" }}
                >
                  ▸
                </span>
                <span
                  className="min-w-0 truncate font-mono text-[11px] text-dim"
                  title={repo}
                >
                  {repo.split("/").slice(-1)[0]}
                </span>
              </button>

              {/* The count says what collapsing would hide, and turns ember
                  when some of it is waiting — so a shut group still shows
                  that it needs somebody. */}
              <span
                className={`shrink-0 font-mono text-[10px] ${asking > 0 ? "text-ember" : "text-mute"}`}
              >
                {held.length}
              </span>
              <button
                onClick={() => onNew(repo)}
                title={`New session on ${repo}`}
                className="shrink-0 px-0.5 text-[12px] leading-none text-mute opacity-0 transition-opacity group-hover/head:opacity-100 hover:text-ember"
              >
                +
              </button>
            </div>

            {!closed &&
              held
                .slice()
                .sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)))
                .map((s) => <Row key={s.id} session={s} />)}
          </section>
        );
      })}
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
      // A card when it is the one you are looking at — a border and a raised
      // ground, not a background tint. A tint says "hovered"; a card says
      // "this is the thing on screen", which is what the row actually means.
      className={`mb-px flex w-full items-center gap-2 rounded-[9px] border px-2 py-[7px] text-left transition-colors ${
        on
          ? "border-line bg-raise"
          : "border-transparent hover:border-line-soft hover:bg-raise/50"
      }`}
    >
      <Signal status={session.status} size={6} />

      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] ${on || asks ? "text-bone" : "text-dim"}`}>
          {session.name}
        </span>
        <span className="mt-px flex items-center gap-1.5 text-mute">
          <AgentMark agent={session.agent} size={11} className="shrink-0 opacity-80" />
          <span className="truncate font-mono text-[10.5px]">
            {AGENT_SHORT[session.agent]} · {elapsed(minutesSince(session.createdAt))}
          </span>
        </span>
      </span>

      {asks && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember" />}
    </button>
  );
}

/**
 * Which repository groups are shut.
 *
 * In the browser, like the tab layout: it is a fact about how somebody is
 * working right now, not about the fleet. Storage can throw, and an unreadable
 * store simply means everything is open.
 */
const SHUT = "firetower.rail.shut";
const watching = new Set<() => void>();
let held: { raw: string | null; groups: string[] } = { raw: null, groups: [] };
const NONE: string[] = [];

function useShutGroups() {
  const shut = useSyncExternalStore(
    (onChange) => {
      watching.add(onChange);
      window.addEventListener("storage", onChange);
      return () => {
        watching.delete(onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    () => {
      let raw: string | null = null;
      try {
        raw = window.localStorage.getItem(SHUT);
      } catch {
        return NONE;
      }
      // Compared by the raw string so a re-parse does not look like a change.
      if (held.raw === raw) return held.groups;
      let groups: string[] = NONE;
      try {
        if (raw) groups = JSON.parse(raw) as string[];
      } catch {
        groups = NONE;
      }
      held = { raw, groups };
      return groups;
    },
    () => NONE,
  );

  const toggle = useCallback(
    (repo: string) => {
      const next = shut.includes(repo) ? shut.filter((r) => r !== repo) : [...shut, repo];
      try {
        if (next.length === 0) window.localStorage.removeItem(SHUT);
        else window.localStorage.setItem(SHUT, JSON.stringify(next));
      } catch {
        // It still works for this visit, which is the part that matters.
      }
      for (const tell of watching) tell();
    },
    [shut],
  );

  return { shut, toggle };
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

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMe, useLogout } from "@/src/api/generated/auth/auth";
import { forgetToken } from "@/src/api/http";
import { useState } from "react";
import { Mark, Signal } from "./Signal";
import { Modal } from "./Modal";
import { NewWorkspace } from "./NewWorkspace";
import { AgentMark } from "./AgentMark";
import { useListSessions } from "@/src/api/generated/sessions/sessions";
import { doing, group, shortRepo, type Workspace } from "@/src/api/workspaces";
import { elapsed, minutesSince, needsYou, unfinished } from "@/src/api/view";

/**
 * The top of the rail: what you came here to do.
 *
 * Repositories, agents, secrets and hosts used to sit here as four more rows of
 * the same weight, which made the rail read as a settings menu with some
 * sessions underneath. They are not the same kind of thing — you touch a
 * repository to start work, and you touch the other three once and then never
 * again until something breaks. The three live behind Configuration now.
 */
const NAV = [
  {
    href: "/",
    label: "Dashboard",
    icon: (
      <>
        <path d="M2 3.5h10M2 7h10M2 10.5h6" strokeWidth="1.3" strokeLinecap="round" />
      </>
    ),
  },
  {
    href: "/tasks",
    label: "Tasks",
    icon: (
      <>
        <path d="M2 3.6h1.8M2 7h1.8M2 10.4h1.8" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M5.8 3.6H12M5.8 7H12M5.8 10.4h4" strokeWidth="1.3" strokeLinecap="round" />
      </>
    ),
  },
];


export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();

  /* Onboarding and signing in run full-bleed — no fleet to navigate yet. */
  if (path.startsWith("/setup") || path.startsWith("/login")) return <>{children}</>;

  /* One rail, everywhere. The workbench used to bring its own — a second list
     of the same workspaces, with a back button to get out of it — which meant
     the fleet was drawn twice and looked different depending on which screen
     you were on. Now it is a page like the others, and leaving a workspace is
     clicking another one. */
  const workbench = path.startsWith("/sessions/");

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Fixed to the window, whatever is in it. The list of running sessions
          grows without bound, and a rail that grows with it pushes the page
          past the viewport and scrolls everything — including the session
          somebody is reading. */}
      <aside className="hidden h-full w-[224px] shrink-0 flex-col overflow-hidden border-r border-line bg-panel md:flex">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-5">
          <span className="text-bone">
            <Mark size={22} />
          </span>
          <span className="font-narrow text-[13px] font-semibold tracking-[0.22em] text-bone uppercase">
            Firetower
          </span>
        </div>

        <nav className="flex flex-col gap-px px-2">
          {NAV.map((n) => {
            const on = n.href === "/" ? path === "/" || path.startsWith("/sessions") : path === n.href;
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`group flex items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-ui transition-colors ${
                  on ? "bg-raise text-bone" : "text-dim hover:bg-raise/60 hover:text-text"
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" className="opacity-70">
                  {n.icon}
                </svg>
                {n.label}
              </Link>
            );
          })}
        </nav>

        <Worktrees />

        {/* Configuration, Documentation, then who you are. The three things
            you reach for after the work rather than during it, in the order you
            reach for them. Hosts used to be here; they are what Compute is
            about, and a list of them was fleet trivia on every screen. */}
        <Link
          href="/configuration"
          className={`flex shrink-0 items-center gap-2.5 border-t border-line px-4 py-2.5 text-ui transition-colors ${
            path.startsWith("/configuration")
              ? "bg-raise text-bone"
              : "text-mute hover:bg-raise/60 hover:text-text"
          }`}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            aria-hidden
            className="opacity-70"
          >
            <circle cx="7" cy="7" r="2.1" strokeWidth="1.3" />
            <path
              d="M7 1.6v1.5M7 10.9v1.5M12.4 7h-1.5M3.1 7H1.6M10.8 3.2l-1 1M4.2 9.8l-1 1M10.8 10.8l-1-1M4.2 4.2l-1-1"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
          Configuration
        </Link>

        {/* Between the fleet and the account, where somebody looks after they
            have run out of things to try on the screen itself. Off to the
            website rather than into the app: it is versioned with the release,
            not with what is running here. */}
        <a
          href="https://www.usefiretower.com/docs"
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-2.5 border-t border-line px-4 py-2.5 text-ui text-mute transition-colors hover:bg-raise/60 hover:text-text"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            aria-hidden
            className="opacity-70"
          >
            <path
              d="M2.4 2.6h3.2c.8 0 1.4.6 1.4 1.4v7c0-.6-.5-1.1-1.1-1.1H2.4zM11.6 2.6H8.4c-.8 0-1.4.6-1.4 1.4v7c0-.6.5-1.1 1.1-1.1h3.5z"
              strokeWidth="1.1"
              strokeLinejoin="round"
            />
          </svg>
          Documentation
          <span aria-hidden className="ml-auto text-[10px] opacity-60">
            ↗
          </span>
        </a>

        <WhoAmI />
      </aside>

      {/* The workbench owns its own scrolling — tabs, a transcript that follows
          itself, a terminal. Every other page is a document and scrolls here. */}
      <main
        className={`min-w-0 flex-1 ${workbench ? "flex overflow-hidden" : "overflow-y-auto"}`}
      >
        {children}
      </main>
    </div>
  );
}

/**
 * Who is signed in, and the way out.
 *
 * At the bottom of the rail rather than in a menu: there is one account today,
 * and the question it answers — "whose credentials would a session use?" — is
 * worth a permanent line rather than a click.
 */
function WhoAmI() {
  const { data } = useMe();

  const out = useLogout();
  const signOut = () =>
    out.mutate(undefined, {
      // Whether or not the server managed to delete the row, this browser is
      // done with the token. Keeping it after someone asked to leave would be
      // the wrong way to fail.
      onSettled: () => {
        forgetToken();
        // A full load on purpose: this runs when a session has just ended, and the
        // router would keep every cached query belonging to whoever was signed in.
        // Clearing that is the point.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/login");
      },
    });

  if (!data) return null;

  return (
    <div className="shrink-0 border-t border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-dim">{data.user.username}</div>
          {data.organization && (
            <div className="truncate text-[11px] text-mute">{data.organization.name}</div>
          )}
        </div>
        <button
          onClick={signOut}
          className="text-[11.5px] text-mute transition-colors hover:text-text"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

/**
 * Every repository, and the worktrees cut from each.
 *
 * The tree is the entry point rather than a settings page: picking where work
 * happens is the first thing somebody does, and it is the same list whether
 * they are on the dashboard or reading a conversation — which is why the rail
 * is shared now and the workbench no longer brings one of its own.
 */
function Worktrees() {
  const path = usePathname();
  const router = useRouter();
  const [starting, setStarting] = useState<{ repo?: string } | null>(null);
  // The rail is on screen the whole time. Faster while something is still
  // going, and slow rather than never once nothing is — a workspace started
  // from another tab, or from a phone, should still turn up.
  const { data: sessions = [] } = useListSessions(undefined, {
    query: {
      refetchInterval: (query) => ((query.state.data ?? []).some(unfinished) ? 2_000 : 15_000),
    },
  });

  const live = sessions.filter((s) => s.status !== "Ended");
  const repos = group(live);

  return (
    <div className="mt-6 flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pb-1">
        <span className="eyebrow">Worktrees</span>
        {/* Making one, not connecting a repository. Connecting is a once-a-year
            thing and lives in Configuration; cutting a worktree is the reason
            somebody opened Firetower, so it is the `+` nearest the list of
            them. */}
        <button
          onClick={() => setStarting({})}
          title="New worktree"
          className="ml-auto text-[15px] leading-none text-mute transition-colors hover:text-ember"
        >
          +
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {repos.groups.length === 0 && (
          <p className="px-2 py-1 text-[13px] text-mute">Nothing running.</p>
        )}

        {repos.groups.map(([repo, places]) => (
          <div key={repo} className="mb-2">
            <div className="flex items-center gap-1.5 px-2 py-1">
              <span className="min-w-0 truncate font-mono text-[11px] text-dim">
                {shortRepo(repo)}
              </span>
              <span className="font-mono text-[10px] text-mute">{places.length}</span>
            </div>
            {places.map((place) => (
              <Worktree key={place.id} place={place} on={path === `/sessions/${place.id}`} />
            ))}
          </div>
        ))}
      </div>

      {starting && (
        <Modal onClose={() => setStarting(null)} title="New worktree" wide>
          <NewWorkspace
            startWith={starting.repo}
            onCreated={(id) => {
              setStarting(null);
              router.push(`/sessions/${id}`);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/** One worktree: its branch, and what is happening in it. */
function Worktree({ place, on }: { place: Workspace; on: boolean }) {
  const state = doing(place);

  return (
    <Link
      href={`/sessions/${place.id}`}
      className={`block rounded-[8px] py-1.5 pr-2 pl-2 transition-colors ${
        on ? "bg-raise" : "hover:bg-raise/60"
      }`}
    >
      <div className="flex items-center gap-2">
        <Signal status={place.runs[0].status} size={6} />
        <span className={`min-w-0 flex-1 truncate text-[13px] ${on ? "text-bone" : "text-dim"}`}>
          {place.name}
        </span>
        {place.runs.some(needsYou) && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember" />
        )}
        <span className="shrink-0 font-mono text-[10px] text-mute">
          {elapsed(minutesSince(place.runs[0].createdAt))}
        </span>
      </div>

      <div className="mt-0.5 flex items-center gap-1.5 pl-[14px]">
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mute">
          {place.branch ?? "—"}
        </span>
        {/* Which agents are in it, rather than how many: two of one and one of
            another is a different place from three of one, and a count says
            neither. */}
        {state === "working" &&
          place.runs.slice(0, 3).map((run) => (
            <AgentMark key={run.id} agent={run.agent} size={10} className="shrink-0 text-mute" />
          ))}
      </div>
    </Link>
  );
}

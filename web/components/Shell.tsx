"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMe, useLogout } from "@/src/api/generated/auth/auth";
import { forgetToken } from "@/src/api/http";
import { useState } from "react";
import { BookOpen, CircleDashed, LayoutList, ListTodo, Plus, Settings2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Mark, Signal } from "./Signal";
import { NewWorkspaceModal } from "./NewWorkspace";
import { AgentMark } from "./AgentMark";
import { Button, GithubMark, Icon } from "./ui";
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
const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Dashboard", icon: LayoutList },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
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
      <aside className="hidden h-full w-[236px] shrink-0 flex-col overflow-hidden border-r border-line bg-panel md:flex">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-5">
          <span className="text-bone">
            <Mark size={20} />
          </span>
          <span className="font-narrow text-ui font-semibold tracking-[0.22em] text-bone uppercase">
            Firetower
          </span>
        </div>

        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map((n) => {
            const on = n.href === "/" ? path === "/" || path.startsWith("/sessions") : path === n.href;
            return <NavLink key={n.href} {...n} on={on} />;
          })}
        </nav>

        <Workspaces />

        {/* Configuration, Documentation, then who you are. The three things
            you reach for after the work rather than during it, in the order you
            reach for them. Hosts used to be here; they are what Compute is
            about, and a list of them was fleet trivia on every screen. */}
        <div className="shrink-0 border-t border-line px-2 py-2">
          <NavLink
            href="/configuration"
            label="Configuration"
            icon={Settings2}
            on={path.startsWith("/configuration")}
          />

          {/* Off to the website rather than into the app: it is versioned with
              the release, not with what is running here. */}
          <a
            href="https://www.usefiretower.com/docs"
            target="_blank"
            rel="noreferrer"
            className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-ui text-mute transition-colors duration-150 hover:bg-raise hover:text-text"
          >
            <Icon of={BookOpen} size={14} />
            Documentation
          </a>
        </div>

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
 * One destination.
 *
 * Where it is on is a lift and a brighter label, plus a short ember stub in the
 * left margin — the only place in the rail that colour appears, so the eye
 * finds "you are here" before it reads anything.
 */
function NavLink({
  href,
  label,
  icon,
  on,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  on: boolean;
}) {
  return (
    <Link
      href={href}
      className={`relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-ui transition-colors duration-150 ${
        on ? "bg-raise text-bone" : "text-dim hover:bg-raise/60 hover:text-text"
      }`}
    >
      {on && (
        <span className="absolute top-1.5 bottom-1.5 -left-2 w-[2px] rounded-full bg-bone" />
      )}
      <Icon of={icon} size={14} />
      {label}
    </Link>
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
          <div className="truncate text-ui text-text">{data.user.username}</div>
          {data.organization && (
            <div className="truncate text-meta text-mute">{data.organization.name}</div>
          )}
        </div>
        <Button variant="quiet" size="sm" onClick={signOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

/**
 * Every repository, and the workspaces cut from each.
 *
 * The tree is the entry point rather than a settings page: picking where work
 * happens is the first thing somebody does, and it is the same list whether
 * they are on the dashboard or reading a conversation — which is why the rail
 * is shared now and the workbench no longer brings one of its own.
 */
function Workspaces() {
  const path = usePathname();
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
      <div className="flex items-center gap-2 px-4 pb-1.5">
        <span className="eyebrow">Workspaces</span>
        {/* Making one, not connecting a repository. Connecting is a once-a-year
            thing and lives in Configuration; opening a workspace is the reason
            somebody opened Firetower, so it is the `+` nearest the list of
            them. */}
        <Button
          variant="quiet"
          size="sm"
          icon={Plus}
          title="New workspace"
          onClick={() => setStarting({})}
          className="-mr-1.5 ml-auto px-1"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {repos.groups.length === 0 && (
          <p className="px-2.5 py-1 text-ui text-mute">Nothing running.</p>
        )}

        {repos.groups.map(([repo, places]) => (
          <div key={repo} className="mb-3">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5">
              {/* The bucket for workspaces with nothing checked out is not a
                  repository, so it does not get a repository's mark. */}
              {repo === "no repository" ? (
                <Icon of={CircleDashed} size={12} className="text-mute" />
              ) : (
                <GithubMark size={13} className="text-dim" />
              )}
              <span className="min-w-0 truncate text-ui font-medium text-bone">
                {shortRepo(repo)}
              </span>
              <span className="font-mono text-micro text-mute">{places.length}</span>
            </div>
            {places.map((place) => (
              <WorkspaceRow key={place.id} place={place} on={path === `/sessions/${place.id}`} />
            ))}
          </div>
        ))}
      </div>

      {starting && (
        <NewWorkspaceModal startWith={starting.repo} onClose={() => setStarting(null)} />
      )}
    </div>
  );
}

/** One workspace: its branch, and what is happening in it. */
function WorkspaceRow({ place, on }: { place: Workspace; on: boolean }) {
  const state = doing(place);

  return (
    <Link
      href={`/sessions/${place.id}`}
      className={`block rounded-md px-2 py-1.5 transition-colors duration-150 ${
        on ? "bg-raise" : "hover:bg-raise/60"
      }`}
    >
      <div className="flex items-center gap-2">
        <Signal status={place.runs[0].status} size={6} />
        <span className={`min-w-0 flex-1 truncate text-ui ${on ? "text-bone" : "text-dim"}`}>
          {place.name}
        </span>
        {place.runs.some(needsYou) && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember" />
        )}
        <span className="shrink-0 font-mono text-micro text-mute">
          {elapsed(minutesSince(place.runs[0].createdAt))}
        </span>
      </div>

      <div className="mt-0.5 flex items-center gap-1.5 pl-[14px]">
        <span className="min-w-0 flex-1 truncate font-mono text-micro text-mute">
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

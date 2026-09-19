/**
 * The rail, at desktop density.
 *
 * Same pattern as the web build's — nav, then every repository with the
 * workspaces cut from it, then the things you touch once — and the same
 * vocabulary, because `group()`, `doing()` and `Signal` are shared rather than
 * reimplemented. What differs is what a window allows: 34px rows instead of a
 * 44px touch floor, no drawer, and the org at the top instead of the product
 * name, since which server you are on is the question a multi-server client has
 * to answer on every screen.
 */
import { BookOpen, CircleDashed, CircleFadingArrowUp, LayoutList, ListTodo, Plus, Settings2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AgentMark } from "~/components/AgentMark";
import { Blocks } from "~/island/Blocks";
import { GithubMark, Icon } from "~/components/ui";
import { doing, group, shortRepo, type Workspace } from "~/api/workspaces";
import { beatOf, elapsed, minutesSince } from "~/api/view";
import type { Backend } from "~/fleet";
import { useSessions, useUpdatesDot } from "~/data";
import { navigate, usePathname } from "~/shims/next-navigation";
import { useStart } from "~/start";
import { useNow } from "~/ui/clock";
import { useQueryClient } from "@tanstack/react-query";
import { getListSessionsQueryKey, renameSession } from "~/api/generated/sessions/sessions";
import { ContextMenu, useMenu } from "~/ui/ContextMenu";
import { usePrompt } from "~/ui/Confirm";
import { useEndWorkspace } from "~/ui/end";
import { HostCard, whereItRuns } from "~/ui/StatusBar";
import { useHosts } from "~/data";
import { Monitor, Server } from "lucide-react";
import { useRef, useState } from "react";
import { key } from "~/platform";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Dashboard", icon: LayoutList },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
];

export function Rail({ backend }: { backend: Backend }) {
  const path = usePathname();
  const start = useStart();
  const { data: sessions, loading, error } = useSessions();
  const updates = useUpdatesDot();
  // The ages below are read off the clock, so the rail has to be told the clock
  // moved — nothing else re-renders a workspace that is quietly working.
  useNow();

  const running = sessions.filter((s) => s.status !== "Ended");
  const repos = group(running);
  const dark = backend.reach === "unreachable";

  return (
    <aside className="flex w-[16rem] shrink-0 flex-col overflow-hidden border-r border-line bg-(--color-panel-vibrant)">
      <nav className="flex shrink-0 flex-col gap-0.5 px-2 pt-2">
        {NAV.map((n) => (
          <NavLink
            key={n.href}
            {...n}
            on={n.href === "/" ? path === "/" || path.startsWith("/sessions") : path.startsWith(n.href)}
          />
        ))}
      </nav>

      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 px-4 pb-1">
          <span className="eyebrow">Workspaces</span>
          <button
            onClick={() => start()}
            title={`New workspace  ${key("N")}`}
            className="-mr-1 ml-auto grid h-7 w-7 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-bone"
          >
            <Icon of={Plus} size={12} />
          </button>
        </div>

        <div className={`scroll-slim min-h-0 flex-1 overflow-y-auto px-2 pb-3 ${dark ? "stale" : ""}`}>
          {loading && <p className="px-2.5 py-1 text-ui text-mute">Loading…</p>}
          {error && <p className="px-2.5 py-1 text-meta text-brick">{error}</p>}
          {!loading && !error && repos.groups.length === 0 && (
            <p className="px-2.5 py-1 text-ui text-mute">Nothing running.</p>
          )}

          {repos.groups.map(([repo, places]) => (
            <div key={repo} className="mb-2.5">
              <div className="flex items-center gap-1.5 px-2.5 py-1">
                {repo === "no repository" ? (
                  <Icon of={CircleDashed} size={12} className="text-mute" />
                ) : (
                  <GithubMark size={12} className="text-dim" />
                )}
                <span className="min-w-0 flex-1 truncate text-ui font-medium text-bone">
                  {shortRepo(repo)}
                </span>
                <RepoTally places={places} />
              </div>
              {places.map((place) => (
                <Row key={place.id} place={place} on={path === `/sessions/${place.id}`} />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="shrink-0 border-t border-line px-2 py-1.5">
        <NavLink href="/configuration" label="Configuration" icon={Settings2} on={path.startsWith("/configuration")} />
        <NavLink href="/updates" label="Updates" icon={CircleFadingArrowUp} on={path.startsWith("/updates")} dot={updates} />
        {import.meta.env.DEV && <NavLink href="/style" label="Style guide" icon={BookOpen} on={path.startsWith("/style")} />}
      </div>

      {/* Who you are *here*. Two servers means two accounts, so this is not
          furniture — it answers whose credentials a session would use. */}
      <button onClick={() => navigate("/account")} className={`shrink-0 border-t border-line px-4 py-2.5 text-left transition-colors hover:bg-raise/60 ${path.startsWith("/account") ? "bg-raise" : ""}`}>
        <div className="truncate text-ui text-text">{backend.user}</div>
        <div className="truncate text-meta text-mute">{backend.org}</div>
      </button>
    </aside>
  );
}

function NavLink({ href, label, icon, on, dot }: { href: string; label: string; icon: LucideIcon; on: boolean; dot?: boolean }) {
  return (
    <button
      onClick={() => navigate(href)}
      className={`flex h-8 items-center gap-2.5 rounded-md px-2.5 text-ui transition-colors duration-150 ${
        on ? "bg-overlay text-bone shadow-(--shadow-raise)" : "text-dim hover:bg-raise/60 hover:text-text"
      }`}
    >
      <Icon of={icon} size={14} />
      {label}
      {dot && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-slate" />}
    </button>
  );
}

/**
 * What is inside a repository, in the island's counters.
 *
 * A bare count said how many workspaces there were, which is the least
 * interesting thing about them — three is three whether they are all finished
 * or all stuck. The same glyphs and the same order as the pill, at eight
 * pixels, so a group that is scrolled past still says what is in it.
 */
function RepoTally({ places }: { places: Workspace[] }) {
  const tally = { working: 0, blocked: 0, done: 0, broken: 0 };
  for (const place of places) {
    const beat = beatOf(place.runs[0]);
    if (beat === "over") continue;
    tally[beat] += 1;
  }

  const order: (keyof typeof tally)[] = ["working", "blocked", "done", "broken"];

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {order
        .filter((beat) => tally[beat] > 0)
        .map((beat) => (
          <span key={beat} className="flex items-center gap-1">
            <Blocks beat={beat} size={8} />
            <span className="font-mono text-micro tabular-nums text-mute">{tally[beat]}</span>
          </span>
        ))}
    </span>
  );
}

/** One workspace: its branch, and what is happening in it. */
function Row({ place, on }: { place: Workspace; on: boolean }) {
  const state = doing(place);
  const menu = useMenu<null>();
  const prompt = usePrompt();
  const endWorkspace = useEndWorkspace();
  const cache = useQueryClient();
  const rename = async () => {
    const name = await prompt({ title: "Rename this workspace", initial: place.name, placeholder: "A name", action: "Rename" });
    if (!name || name === place.name) return;
    await renameSession(place.id, { name });
    await cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
  };

  return (
    <>
    {menu.open && (
      <ContextMenu
        at={menu.open.at}
        onClose={menu.close}
        items={[
          { label: "Open", onPick: () => navigate(`/sessions/${place.id}`) },
          { label: "Rename…", onPick: () => void rename() },
          "-",
          { label: "End workspace", tone: "danger", onPick: () => void endWorkspace(place).then(({ ended }) => ended && on && navigate("/")) },
        ]}
      />
    )}
    <button
      onClick={() => navigate(`/sessions/${place.id}`)}
      onContextMenu={(e) => menu.show(e, null)}
      className={`block w-full rounded-md px-2.5 py-1.5 text-left transition-colors duration-150 select-none ${
        on ? "bg-overlay shadow-(--shadow-raise)" : "hover:bg-raise/60"
      }`}
    >
      <div className="flex items-center gap-2">
        {/* The island's mark, at nine pixels instead of eleven. One alphabet
            for both places, so a workspace reads the same in the menu bar as
            it does here.

            There used to be a second dot after the name — `runs.some(needsYou)`
            in ember — saying again what this already says, and contradicting
            it for the two statuses where `needsYou` and the colour disagree:
            a finished workspace drew sage and then ember, a failed one brick
            and then ember. The mark is the only thing that speaks now. */}
        <Blocks beat={beatOf(place.runs[0])} size={9} />
        <span className={`min-w-0 flex-1 truncate text-ui ${on ? "text-bone" : "text-dim"}`}>{place.name}</span>
        <span className="shrink-0 font-mono text-micro text-mute">
          {elapsed(minutesSince(place.runs[0].createdAt))}
        </span>
      </div>
      <div className="flex items-center gap-1.5 pl-[12px]">
        <span className="min-w-0 flex-1 truncate font-mono text-micro text-mute">{place.branch ?? "—"}</span>
        {state === "working" &&
          place.runs.slice(0, 3).map((run) => (
            <AgentMark key={run.id} agent={run.agent} size={10} className="shrink-0 text-mute" />
          ))}
        <Where place={place} />
      </div>
    </button>
    </>
  );
}

/**
 * Where the workspace runs, as one icon at the end of the row: a screen for
 * Firetower's own machine, a server for any other computer. Hovering it
 * opens the machine's card — the name and the facts live there, not in a
 * row that is already full.
 */
function Where({ place }: { place: Workspace }) {
  const hosts = useHosts();
  const host = hosts.data.find((h) => h.id === place.runs[0].hostId);
  const where = whereItRuns(host, hosts.data);
  const [card, setCard] = useState<{ x: number; y: number } | null>(null);
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  if (!host || !where) return null;
  const local = where.name === "Firetower's machine";
  const Icon = local ? Monitor : Server;
  return (
    <span
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        hover.current = setTimeout(() => setCard({ x: r.left, y: r.bottom }), 350);
      }}
      onMouseLeave={() => {
        clearTimeout(hover.current);
        setCard(null);
      }}
      className={`relative ml-0.5 shrink-0 ${where.quiet ? "stale" : ""}`}
      aria-label={`Runs on ${where.name}`}
    >
      <Icon className={`h-3 w-3 ${where.quiet ? "text-brick" : "text-mute"}`} strokeWidth={1.75} />
      {card && <HostCard host={host} where={where} at={card} />}
    </span>
  );
}

/**
 * The 252px panel beside the rail: one destination's working surface.
 *
 * Half of what `Rail.tsx` used to be. The old rail was one column doing three
 * jobs — navigation, the workspace list, and the configuration index — and
 * swapped wholesale between them. This is the second job, per destination: a
 * few sub-destinations, then the live things you actually have.
 *
 * **It previews.** Pointing at a rail icon, or giving it focus, swaps what is
 * in here without navigating; pressing it commits. So the panel is often
 * showing somewhere you are *not*, which is the point — looking into a
 * destination without leaving the one you are in.
 *
 * **A row is a name and one timestamp.** No branch, no repository, no machine,
 * no state. All of those used to be here and made every row a paragraph; what
 * matters enough to be in a row has to earn the space against the name, and
 * otherwise belongs in the thing the row opens.
 */
import { useMemo } from "react";
import {
  Blocks,
  FolderGit2,
  GaugeCircle,
  GitBranch,
  Inbox,
  Key,
  Monitor,
  PanelLeftClose,
  Pencil,
  Puzzle,
  Search,
  Server,
  Settings,
  Shapes,
  Ticket,
  Building2,
  CircleAlert,
  FileClock,
  Folder,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { Icon } from "~/components/ui";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import { useMe } from "~/api/generated/auth/auth";
import { elapsed, minutesSince, needsYou } from "~/api/view";
import { flat, group, isChild, rowLabel, type Workspace } from "~/api/workspaces";
import { useHosts, useRepos, useSessions, useSkills } from "~/data";
import { isPersonal } from "~/filing";
import { key } from "~/platform";
import { navigate, usePathname } from "~/shims/next-navigation";
import { useStart } from "~/start";
import { useNow } from "~/ui/clock";
import { EVERY, type DestinationId } from "~/ui/destinations";

export function RailPanel({
  at,
  floating,
  onCollapse,
  onEnter,
  onLeave,
}: {
  at: DestinationId;
  /** Over the sheet rather than beside it: the panel is collapsed and this is
   *  a preview, so it floats rather than pushing the page sideways. */
  floating: boolean;
  onCollapse: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  return (
    <aside
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocusCapture={onEnter}
      className={
        floating
          ? "panel-float absolute top-0 bottom-3 left-(--rail) z-20 flex w-(--panel) flex-col overflow-hidden"
          : "flex w-(--panel) shrink-0 flex-col overflow-hidden"
      }
    >
      <Contents at={at} onCollapse={onCollapse} />
    </aside>
  );
}

function Contents({ at, onCollapse }: { at: DestinationId; onCollapse: () => void }) {
  const path = usePathname();
  if (at === "home") return <Workspaces onCollapse={onCollapse} />;
  return (
    <>
      <Head name={EVERY.find((d) => d.id === at)?.label ?? ""} onCollapse={onCollapse} />
      <Scroll>
        {at === "tasks" && (
          <>
            <Row label="Everything" icon={Inbox} on={path.startsWith("/tasks")} to="/tasks" />
            <Label>Where work comes from</Label>
            <Row label="Trackers" icon={Ticket} on={path.startsWith("/configuration/trackers")} to="/configuration/trackers" />
          </>
        )}
        {at === "artifacts" && <Artifacts />}
        {at === "customize" && <Customize />}
        {at === "repos" && <Repositories />}
        {at === "machines" && <Machines />}
        {at === "settings" && (
          <>
            <Label>Who can reach what</Label>
            <Row label="People" icon={UsersRound} on={pane(path) === "people"} to="/configuration/people" />
            <Row label="Teams" icon={Users} on={pane(path) === "teams"} to="/configuration/teams" />
            <Row label="Directories" icon={Folder} on={pane(path) === "directories"} to="/configuration/directories" />
            <Label>Secrets</Label>
            <Row label="Vault" icon={Key} on={pane(path) === "vault"} to="/configuration/vault" />
            <Label>This deployment</Label>
            <Row label="This Firetower" icon={Building2} on={pane(path) === "server"} to="/configuration/server" />
          </>
        )}
        {at === "updates" && (
          <>
            <Row label="What is running" icon={GaugeCircle} on to="/updates" />
            <Row label="Past runs" icon={FileClock} on={false} to="/updates" />
          </>
        )}
      </Scroll>
    </>
  );
}

/** Which configuration pane a path is on, for the rows that mark themselves. */
const pane = (path: string) => path.split("/").filter(Boolean)[1] ?? "";

/* ── The Dashboard's panel: what is running ──────────────────────────────── */

/**
 * The list the old rail was mostly made of, at one level instead of three.
 *
 * It used to be grouped by repository inside two sections, with a tally per
 * group and a branch, a machine and three agent marks on every row. The split
 * that survives is the one that answers a question somebody actually asks —
 * is this mine or did somebody share it — and even that is only drawn when
 * there is something in it.
 */
function Workspaces({ onCollapse }: { onCollapse: () => void }) {
  const path = usePathname();
  const start = useStart();
  const { data: sessions, loading, error } = useSessions();
  const me = useMe();
  /* The ages are read off the clock, so this has to be told the clock moved —
     nothing else re-renders a workspace that is quietly working. */
  useNow();

  const { mine, theirs } = useMemo(() => {
    const running = sessions.filter((s) => s.status !== "Ended");
    const own = flat(group(running.filter((s) => isPersonal(s.path, me.data?.user))));
    const shared = flat(group(running.filter((s) => !isPersonal(s.path, me.data?.user))));
    /* A child spawned in its own workspace lives under its lead in the
       Overview tab, not as a row of its own here. */
    const everyPlace = [...own, ...shared];
    const topOnly = (places: Workspace[]) => places.filter((p) => !isChild(p, everyPlace));
    return { mine: topOnly(own), theirs: topOnly(shared) };
  }, [sessions, me.data?.user]);

  return (
    <>
      <Head name="Workspaces" onCollapse={onCollapse}>
        <Glyph of={Search} label="Find anything" hint={key("P")} onPick={() => navigate("/")} />
      </Head>
      <Scroll>
        <button onClick={() => start()} className="prow">
          <span className="grid w-[17px] shrink-0 place-items-center text-mute">
            <Icon of={Pencil} size={14} />
          </span>
          <span className="min-w-0 flex-1 truncate text-bone">New workspace</span>
          <span className="shrink-0 text-micro text-mute">{key("N")}</span>
        </button>

        {loading && <p className="px-2.5 py-1 text-ui text-mute">Loading…</p>}
        {error && <p className="px-2.5 py-1 text-meta text-brick">{error}</p>}

        {mine.length > 0 ? (
          <>
            <Label>Recent</Label>
            {mine.map((place) => (
              <Place key={place.id} place={place} places={mine} on={path === `/sessions/${place.id}`} />
            ))}
          </>
        ) : (
          !loading && <p className="px-2.5 py-3 text-ui text-mute">Nothing running yet.</p>
        )}

        {theirs.length > 0 && (
          <>
            <Label>Shared with you</Label>
            {theirs.map((place) => (
              <Place key={place.id} place={place} places={theirs} on={path === `/sessions/${place.id}`} />
            ))}
          </>
        )}
      </Scroll>
    </>
  );
}

/**
 * One workspace: its name, and how long it has been going.
 *
 * A place that is waiting on you is said with **weight and the brightest text
 * tier**, never with a second ember dot. The Dashboard beside this already has
 * the dot, and the rule the whole design turns on is that ember is rare — six
 * of a thing that means "the one loud thing" is none of them.
 */
function Place({ place, places, on }: { place: Workspace; places: Workspace[]; on: boolean }) {
  const hot = place.runs.some(needsYou);
  return (
    <button
      onClick={() => navigate(`/sessions/${place.id}`)}
      aria-current={on}
      title={hot ? `${place.name} — waiting on you` : place.name}
      className="prow"
    >
      <span className={`min-w-0 flex-1 truncate ${hot ? "font-medium text-bone" : ""}`}>
        {rowLabel(place, places)}
      </span>
      <span className={`shrink-0 tabular-nums ${hot ? "text-text" : "text-dim"} text-meta`}>
        {elapsed(minutesSince(place.runs[0].createdAt))}
      </span>
    </button>
  );
}

/* ── The other destinations ──────────────────────────────────────────────── */

function Customize() {
  const path = usePathname();
  const skills = useSkills();
  return (
    <>
      <Row label="Skills" icon={Puzzle} on={pane(path) === "skills"} to="/configuration/skills" />
      <Row label="Agent profiles" icon={UsersRound} on={pane(path) === "roles"} to="/configuration/roles" />
      <Row label="Agents" icon={Blocks} on={pane(path) === "agents"} to="/configuration/agents" />
      {skills.data.length > 0 && (
        <>
          <Label>Your skills</Label>
          {skills.data.slice(0, 8).map((s) => (
            <button key={s.id} onClick={() => navigate("/configuration/skills")} className="prow">
              <span className="min-w-0 flex-1 truncate font-mono text-meta">{s.name}</span>
            </button>
          ))}
        </>
      )}
    </>
  );
}

function Repositories() {
  const path = usePathname();
  const repos = useRepos();
  return (
    <>
      <Row label="All repositories" icon={FolderGit2} on={pane(path) === "repositories"} to="/configuration/repositories" />
      <Row label="Git hosts" icon={GitBranch} on={pane(path) === "git-hosts"} to="/configuration/git-hosts" />
      {repos.data.length > 0 && (
        <>
          <Label>Checked out</Label>
          {repos.data.slice(0, 10).map((r) => (
            <button key={r.id} onClick={() => navigate("/configuration/repositories")} className="prow">
              <span className="min-w-0 flex-1 truncate">{r.slug}</span>
            </button>
          ))}
        </>
      )}
    </>
  );
}

function Machines() {
  const path = usePathname();
  const hosts = useHosts();
  return (
    <>
      <Row label="All machines" icon={Server} on={pane(path) === "machines"} to="/configuration/machines" />
      {hosts.data.length > 0 && (
        <>
          <Label>Yours</Label>
          {hosts.data.map((h) => (
            <button key={h.id} onClick={() => navigate("/configuration/machines")} className="prow">
              <span className="grid w-[17px] shrink-0 place-items-center text-mute">
                <Icon of={h.machine === "local" ? Monitor : Server} size={14} />
              </span>
              <span className="min-w-0 flex-1 truncate">{h.name}</span>
              {!h.workerVersion && (
                <span className="shrink-0 text-mute" title="Needs setup">
                  <Icon of={CircleAlert} size={12} />
                </span>
              )}
            </button>
          ))}
        </>
      )}
    </>
  );
}

/**
 * Recent artifacts, by name.
 *
 * No poster here, deliberately. A poster is 84 × 52 and earns its place in a
 * list row that is 64px tall; this row is 34px of chrome, and a thumbnail at
 * that size says less than the name does. The grid is where you browse.
 */
function Artifacts() {
  const { data } = useListArtifacts();
  useNow();
  const recent = (data ?? []).slice(0, 8);
  return (
    <>
      <Row label="All artifacts" icon={Shapes} on to="/artifacts" />
      {recent.length > 0 && (
        <>
          <Label>Recent</Label>
          {recent.map((a) => (
            <button key={a.id} onClick={() => navigate("/artifacts")} className="prow">
              <span className="min-w-0 flex-1 truncate">{a.title}</span>
              <span className="shrink-0 text-meta tabular-nums text-dim">
                {elapsed(minutesSince(a.updatedAt))}
              </span>
            </button>
          ))}
        </>
      )}
    </>
  );
}

/* ── The pieces every panel is made of ───────────────────────────────────── */

function Head({ name, onCollapse, children }: { name: string; onCollapse: () => void; children?: React.ReactNode }) {
  return (
    <div className="flex h-[38px] shrink-0 items-center gap-0.5 pr-2 pl-3.5">
      <span className="min-w-0 flex-1 truncate text-ui font-semibold text-bone">{name}</span>
      {children}
      <Glyph of={PanelLeftClose} label="Hide this panel" hint={key("\\")} onPick={onCollapse} />
    </div>
  );
}

function Glyph({ of, label, hint, onPick }: { of: LucideIcon; label: string; hint?: string; onPick: () => void }) {
  return (
    <button
      onClick={onPick}
      title={hint ? `${label}  ${hint}` : label}
      aria-label={label}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-text"
    >
      <Icon of={of} size={14} />
    </button>
  );
}

function Scroll({ children }: { children: React.ReactNode }) {
  return <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-2 pb-4">{children}</div>;
}

/** A section label is a sentence, not an instrument-panel legend. */
function Label({ children }: { children: React.ReactNode }) {
  return <p className="px-2 pt-4 pb-1 text-meta text-dim first:pt-1">{children}</p>;
}

function Row({ label, icon, on, to }: { label: string; icon: LucideIcon; on: boolean; to: string }) {
  return (
    <button onClick={() => navigate(to)} aria-current={on} className="prow">
      <span className={`grid w-[17px] shrink-0 place-items-center ${on ? "text-bone" : "text-dim"}`}>
        <Icon of={icon} size={14} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

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
import { Fragment, useMemo, useState } from "react";
import {
  Blocks,
  CircleSlash2,
  Clock,
  FileClock,
  FolderGit2,
  GitBranch,
  Inbox,
  Monitor,
  PanelLeftClose,
  Pencil,
  Plus,
  Puzzle,
  Server,
  Search,
  Shapes,
  Ticket,
  CircleAlert,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { Icon } from "~/components/ui";
import { BeatMark } from "~/components/BeatMark";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import { useAllRuns, useListSchedules } from "~/api/generated/schedules/schedules";
import type { Schedule } from "~/api/generated/model";
import { useMe } from "~/api/generated/auth/auth";
import { elapsed, minutesSince, needsYou } from "~/api/view";
import { childrenElsewhere, doing, flat, group, isChild, placeBeat, rowLabel, type Repositories, type Workspace } from "~/api/workspaces";
import { useHosts, useRepos, useSessions, useSkills } from "~/data";
import { isPersonal } from "~/filing";
import { key } from "~/platform";
import { navigate, usePathname } from "~/shims/next-navigation";
import { useStart } from "~/start";
import { useNow } from "~/ui/clock";
import { DESTINATIONS, type DestinationId } from "~/ui/destinations";
import { ContextMenu, useMenu } from "~/ui/ContextMenu";
import { usePrompt } from "~/ui/Confirm";
import { useEndWorkspace } from "~/ui/end";
import { useQueryClient } from "@tanstack/react-query";
import { getListSessionsQueryKey, renameSession } from "~/api/generated/sessions/sessions";

export function RailPanel({
  at,
  floating,
  stale,
  onCollapse,
  onEnter,
  onLeave,
}: {
  at: DestinationId;
  /** Over the sheet rather than beside it: the panel is collapsed and this is
   *  a preview, so it floats rather than pushing the page sideways. */
  floating: boolean;
  /** This Firetower is not answering. The rows stay with what was last known
   *  on them, dimmed — a list that empties itself reads as work being lost. */
  stale: boolean;
  onCollapse: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  return (
    <aside
      /* Named, because "the aside" is ambiguous — Configuration panes have
         their own, and a check looking for *this* one was finding those. */
      data-rail-panel=""
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocusCapture={onEnter}
      className={
        floating
          ? "panel-float absolute top-0 bottom-3 left-(--rail) z-20 flex w-(--panel) flex-col overflow-hidden"
          : "flex w-(--panel) shrink-0 flex-col overflow-hidden"
      }
    >
      <div className={`flex min-h-0 flex-1 flex-col ${stale ? "stale" : ""}`}>
        <Contents at={at} stale={stale} onCollapse={onCollapse} />
      </div>
    </aside>
  );
}

function Contents({ at, stale, onCollapse }: { at: DestinationId; stale: boolean; onCollapse: () => void }) {
  const path = usePathname();
  if (at === "home") return <Workspaces stale={stale} onCollapse={onCollapse} />;
  return (
    <>
      <Head name={DESTINATIONS.find((d) => d.id === at)?.label ?? ""} onCollapse={onCollapse} />
      <Scroll>
        {at === "tasks" && (
          <>
            <Row label="Everything" icon={Inbox} on={path === "/tasks"} to="/tasks" />
            {/* The one narrowing worth a place in the rail. It is the same
                filter the page carries, reachable from the index rather than
                only from the row of pills on the screen you are already on. */}
            <Row label="Assigned to you" icon={UserRound} on={path.startsWith("/tasks/mine")} to="/tasks/mine" />
            <Label>Where work comes from</Label>
            <Row label="Trackers" icon={Ticket} on={path.startsWith("/configuration/trackers")} to="/configuration/trackers" />
          </>
        )}
        {at === "artifacts" && <Artifacts />}
        {at === "schedules" && <Schedules path={path} />}
        {at === "customize" && <Customize />}
        {at === "repos" && <Repositories />}
        {at === "machines" && <Machines />}
        {/* **Settings' five panes and Updates' two rows used to be here.** They
            were the panels of the two doors below the rail's rule, and both
            doors have gone — the profile menu is the only Settings and the only
            Updates now. Settings' index moved into the page it indexes
            (`config/panes.ts`'s `SETTINGS`, drawn by `SettingsIndex`), because
            a panel beside a rail with no icon to open it is unreachable.
            Updates' two rows were a *What is running* that was always current
            and a *Past runs* that went to the same address, so there was never
            an index there to relocate. */}
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
/**
 * How a workspace is grouped in the panel. One answer, kept, because it is a
 * preference and asking again every launch is the same complaint that got the
 * rail's collapsed state persisted.
 *
 * State here rather than a module with watchers, because the segment below is
 * the only thing that sets it. It was briefly a module, for a *View all* on
 * the home that would have put the panel in Status — and that control was
 * withdrawn, because opening a panel that is usually already open is a button
 * that does nothing. The abstraction went with it.
 */
const BY_KEY = "firetower.workspaces-by";
type By = "status" | "repo";
const heldBy = (): By => {
  try {
    return window.localStorage.getItem(BY_KEY) === "repo" ? "repo" : "status";
  } catch {
    return "status";
  }
};

/**
 * What a workspace is doing, as a band.
 *
 * **Three, not the drawing's four.** The drawing bands on a `BEAT` rollup —
 * *Needs you*, *Working*, *Done*, *Broken* — and says in its own Spec that
 * the rollup does not exist yet. It does not: `doing()` is what there is, and
 * its `waiting` spans `NeedsYou`, `HandedBack` *and* `Failed`, because
 * `NEEDS_YOU` is all three. So a finished workspace and a failed one both
 * report *waiting*, not *idle*.
 *
 * That is why these are named for what `doing()` can honestly say. All three
 * of those statuses really are waiting on you — one stopped to ask, one gave
 * it back, one died and will not go on — so **"Waiting on you"** is true of
 * the band. Splitting it into the drawing's three needs `beatOfPlace()`, and
 * that is a product decision rather than a wiring one.
 */
const BANDS: { of: ReturnType<typeof doing>; says: string }[] = [
  { of: "waiting", says: "Waiting on you" },
  { of: "working", says: "Working" },
  { of: "idle", says: "Idle" },
];
const BAND_ORDER = { waiting: 0, working: 1, idle: 2 } as const;
/* Worst first, within whatever grouping is on. The band is still `doing()`'s,
   so the bands stay contiguous; inside one, the beat decides — which is what
   makes the dots run ember, brick, sage rather than interleaving.

   **`placeBeat` is main's, and it is better than the `beatOfPlace` written
   here.** Both roll a place's runs up to one `Beat`; main's also walks one
   hop into the workspaces those runs started, because a child with a
   workspace of its own is hidden from this panel and belongs under its lead.
   Its precedence is blocked › working › broken › done rather than broken
   first — ember is spent on being stuck and on nothing else. Taken whole on
   the merge; the duplicate is gone. */
const BEAT_ORDER = { blocked: 0, working: 1, broken: 2, done: 3, over: 4 } as const;
const worstFirst = (every: Workspace[]) => (a: Workspace, b: Workspace) =>
  BAND_ORDER[doing(a)] - BAND_ORDER[doing(b)] ||
  BEAT_ORDER[placeBeat(a, every)] - BEAT_ORDER[placeBeat(b, every)];

/* **Every row carries a dot, in both modes.** The design had none in Status
   mode — on the argument that the band heading already says *Needs you* —
   and a capped one in Repository mode. The user has seen it rendered both
   ways and overruled both: a panel where one row of three has a mark reads
   as *missing*, not as restraint.

   Each dot takes its own row's tone from `BEAT_TONE`, so the mark says which
   of the three kinds of waiting a row is: ember blocked, slate working, sage
   done, brick broken. Under a band reading *Waiting on you* that is more
   than the heading says, not a repeat of it.

   This breaches the three-ember budget on a busy screen — four waiting rows
   are four ember dots — and that is accepted, by the person the budget was
   for. `design-rules.mjs` exempts this panel and keeps counting everywhere
   else. */

function Workspaces({ stale, onCollapse }: { stale: boolean; onCollapse: () => void }) {
  const path = usePathname();
  const start = useStart();
  const { data: sessions, loading, error } = useSessions();
  const me = useMe();
  const [by, setBy] = useState<By>(heldBy);
  /* The ages are read off the clock, so this has to be told the clock moved —
     nothing else re-renders a workspace that is quietly working. */
  useNow();

  const pick = (next: By) => {
    setBy(next);
    try {
      window.localStorage.setItem(BY_KEY, next);
    } catch {
      /* it applies now; it just does not survive a restart */
    }
  };

  const { mine, theirs, every } = useMemo(() => {
    const running = sessions.filter((s) => s.status !== "Ended");
    const ownBy = group(running.filter((s) => isPersonal(s.path, me.data?.user)));
    const sharedBy = group(running.filter((s) => !isPersonal(s.path, me.data?.user)));
    /* A child spawned in its own workspace lives under its lead in the
       Overview tab, not as a row of its own here. */
    const everyPlace = [...flat(ownBy), ...flat(sharedBy)];
    const topOnly = (p: Workspace) => !isChild(p, everyPlace);
    /* **Both shapes, from one grouping.** Status mode wants them flat;
       Repository mode wants the repository `group()` already knows, which
       `Workspace` itself does not carry. */
    const both = (by: Repositories) => ({
      flat: flat(by).filter(topOnly),
      byRepo: by.groups
        .map(([repo, places]) => [repo, places.filter(topOnly)] as [string, Workspace[]])
        .filter(([, places]) => places.length > 0),
    });
    return { mine: both(ownBy), theirs: both(sharedBy), every: everyPlace };
  }, [sessions, me.data?.user]);

  const nothing = mine.flat.length === 0 && theirs.flat.length === 0;

  return (
    <>
      <Head name="Workspaces" onCollapse={onCollapse} />
      {/* **Its own row.** The header already carries a name, a search and a
          collapse at 252px, and `Repository` is the longest realistic label —
          a fourth thing on that line is what overlapped the title. This
          switch is on the Workspaces panel and nowhere else: it is the one
          panel whose set is big and heterogeneous enough for a second
          grouping to pay for itself. */}
      {!nothing && (
        <div className="pswitch">
          <span className="seg2" role="group" aria-label="Group workspaces by">
            {([["status", "Status"], ["repo", "Repository"]] as const).map(([id, says]) => (
              <button key={id} onClick={() => pick(id)} aria-pressed={by === id}>
                {says}
              </button>
            ))}
          </span>
        </div>
      )}
      <Scroll>
        <button onClick={() => start()} className="prow">
          <span className="grid w-[17px] shrink-0 place-items-center text-mute">
            <Icon of={Pencil} size={14} />
          </span>
          <span className="min-w-0 flex-1 truncate text-bone">New workspace</span>
          <span className="shrink-0 text-micro text-mute">{key("N")}</span>
        </button>

        {loading && <p className="px-2.5 py-1 text-ui text-mute">Loading…</p>}
        {/* **Never brick.** Brick means something failed, and a Firetower
            behind a VPN that is off has not failed — it is not there, which
            the memo expects to be the common case. The rows above and below
            stay with what was last known on them. */}
        {stale ? (
          <p className="px-2.5 py-1 text-meta text-mute">Can’t reach it — showing what was last known.</p>
        ) : (
          error && <p className="px-2.5 py-1 text-meta text-brick">{error}</p>
        )}

        {nothing && !loading && !error && (
          <p className="pnone">Nothing running yet. Start something on the home and it appears here.</p>
        )}

        {mine.flat.length > 0 && <Listing places={mine} every={every} by={by} path={path} />}

        {theirs.flat.length > 0 && (
          <>
            <Label>Shared with you</Label>
            <Listing places={theirs} every={every} by={by} path={path} />
          </>
        )}
      </Scroll>
    </>
  );
}

/**
 * The rows, banded.
 *
 * **Flat and ordered, not grouped into sections.** One hairline and a word
 * where the band turns. A grouped list reorders under the pointer — the row
 * you reached for jumps to another section the moment its state changes.
 */
function Listing({
  places,
  every,
  by,
  path,
}: {
  places: { flat: Workspace[]; byRepo: [string, Workspace[]][] };
  /** Every place there is — `placeBeat` reads one hop past what is drawn. */
  every: Workspace[];
  by: By;
  path: string;
}) {
  if (by === "repo") {
    return (
      <>
        {places.byRepo.map(([repo, held]) => (
          <Fragment key={repo}>
            <div className="prepo">
              <Icon of={FolderGit2} size={14} />
              <span>{repo}</span>
              <span className="n">{held.length}</span>
            </div>
            {[...held]
              .sort(worstFirst(every))
              .map((place) => (
                <Place key={place.id} place={place} places={held} every={every} on={path === `/sessions/${place.id}`} />
              ))}
          </Fragment>
        ))}
      </>
    );
  }

  const sorted = [...places.flat].sort(worstFirst(every));
  let last: string | null = null;
  return (
    <>
      {sorted.map((place) => {
        const band = doing(place);
        const turn = band !== last;
        last = band;
        const n = sorted.filter((p) => doing(p) === band).length;
        return (
          <Fragment key={place.id}>
            {turn && (
              <div className="pband">
                <span>{BANDS.find((b) => b.of === band)?.says}</span>
                <i />
                <span className="n">{n}</span>
              </div>
            )}
            <Place place={place} places={sorted} every={every} on={path === `/sessions/${place.id}`} />
          </Fragment>
        );
      })}
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
function Place({ place, places, every, on }: { place: Workspace; places: Workspace[]; every: Workspace[]; on: boolean }) {
  const hot = place.runs.some(needsYou);
  const beat = placeBeat(place, every);
  const menu = useMenu<null>();
  const prompt = usePrompt();
  const endWorkspace = useEndWorkspace();
  const cache = useQueryClient();

  /* **`mayWrite`, not `maySpeak`.** `Chat.tsx` separates them: `mayWrite` is
     *the place* — may I work in this workspace at all — and `maySpeak` is
     *this conversation*, true only for whoever started it, because the agent
     runs on their subscription and pushes with their token. Renaming and
     ending are facts about the place.

     `!== false` rather than `=== true`: a control plane older than this app
     sends neither, and reading absence as "you may only watch" takes every
     control from the person whose work it is.

     Asked of the runs rather than of `runs[0]`, which is whichever one
     `group()` sorted first and not the place — the mistake main spent two
     commits undoing. */
  const mayAct = place.runs.some((r) => r.mayWrite !== false);

  const rename = async () => {
    const name = await prompt({ title: "Rename this workspace", initial: place.name, placeholder: "A name", action: "Rename" });
    if (!name || name === place.name) return;
    await renameSession(place.id, { name });
    await cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
  };

  return (
    <>
    {/* **A row you may not act on gets no menu**, rather than a menu with
        dead entries in it. The only item that would survive the gate is
        *Open*, which left-clicking already does. */}
    {menu.open && (
      <ContextMenu
        at={menu.open.at}
        onClose={menu.close}
        items={[
          { label: "Open", onPick: () => navigate(`/sessions/${place.id}`) },
          { label: "Rename…", onPick: () => void rename() },
          "-",
          /* No second question. `ui/end.ts` already confirms, and builds its
             body out of `sessionWork` — the uncommitted files, the unpushed
             commits, how many agents stop. Asking again here would be the
             same question in worse words. */
          {
            label: "End workspace",
            tone: "danger" as const,
            onPick: () =>
              void endWorkspace(place, childrenElsewhere(place, every)).then(
                ({ ended }) => ended && on && navigate("/"),
              ),
          },
        ]}
      />
    )}
    <button
      onClick={() => navigate(`/sessions/${place.id}`)}
      onContextMenu={mayAct ? (e) => menu.show(e, null) : undefined}
      aria-current={on}
      title={hot ? `${place.name} — waiting on you` : place.name}
      className="prow"
    >
      {/* **One alphabet, and not for tidiness.** This drew its own `.wdot`:
          one circle in four tones, which is hue alone. Simulated, three of
          the four states collapse — a protanope in light reads *needs you*
          against *done* at 1.07:1 and against *broken* at 1.14:1; a
          deuteranope in dark reads *working* against *done* at 1.00:1, which
          is the same mark. The pair that collapses hardest is an agent
          waiting on you against one that has finished.

          The shaped set survives 1.00:1 because the shapes differ. It costs
          7px of label width — see `.prow .mk` — and that is the whole bill. */}
      <span className="mk">
        <BeatMark beat={beat} />
      </span>
      <span className={`min-w-0 flex-1 truncate ${hot ? "font-medium text-bone" : ""}`}>
        {rowLabel(place, places)}
      </span>
      <span className={`shrink-0 tabular-nums ${hot ? "text-text" : "text-dim"} text-meta`}>
        {elapsed(minutesSince(place.runs[0].createdAt))}
      </span>
    </button>
    </>
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
          {/* **Not monospace, and no monogram tile.** A skill's name is read
              as a word, never character by character — which is the test the
              handoff now gives for the mono voice. The six tiles that used to
              sit here decoded to nothing (`it` for incident-timeline); a 17px
              spacer keeps the column aligned with the rows above. */}
          {skills.data.slice(0, 8).map((s) => (
            <button key={s.id} onClick={() => navigate(`/configuration/skills/${s.id}`)} className="prow">
              <span className="w-[17px] shrink-0" />
              <span className="lbl">{s.name}</span>
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
            <button key={r.id} onClick={() => navigate(`/configuration/repositories/${r.id}`)} className="prow">
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
            <button key={h.id} onClick={() => navigate(`/configuration/machines/${h.id}`)} className="prow">
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
            <button key={a.id} onClick={() => navigate(`/artifacts/${a.id}`)} className="prow">
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

/**
 * Schedules.
 *
 * Three rows, then three sections. **No segmented control**: the two scopes
 * are rows here rather than a switch, because a switch would say the page
 * stays put and it does not — *All runs* is its own page.
 *
 * *Waiting for you* is where a proposal is announced, and it is the only
 * place one is. There is no dot on the rail glyph and there will not be: the
 * rail says where you can go, and what wants you is said in the panel beside
 * it, which previews from any destination.
 */
function Schedules({ path }: { path: string }) {
  const { data } = useListSchedules();
  useNow();
  const everything = data ?? [];
  const waiting = everything.filter(
    (s) => (s.made.byAgent && !s.approvedAt) || (!s.active && !!s.pausedReason),
  );
  const mine = everything.filter((s) => !waiting.includes(s));
  const runs = useAllRuns({ limit: 5 });
  const onRuns = path.startsWith("/schedules/runs");

  return (
    <>
      <Row label="All schedules" icon={Clock} on={path === "/schedules"} to="/schedules" />
      <Row label="All runs" icon={FileClock} on={onRuns} to="/schedules/runs" />
      {/* The way to make one, from the index rather than only from the page.
          It lands on the library with the sheet open — the sheet is over that
          screen, so arriving anywhere else would be arriving behind it. */}
      <button onClick={() => navigate("/schedules?new=1")} className="prow strong">
        <span className="grid w-[17px] shrink-0 place-items-center text-dim">
          <Icon of={Plus} size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate">New schedule</span>
      </button>
      {everything.length === 0 && (
        <p className="px-2 pt-3 text-meta text-dim">
          Nothing on a clock yet. Start one from an example.
        </p>
      )}
      {waiting.length > 0 && (
        <>
          <Label>Waiting for you</Label>
          {waiting.map((s) => (
            <ScheduleRow key={s.id} schedule={s} on={path.endsWith(s.id)} />
          ))}
        </>
      )}
      {mine.length > 0 && (
        <>
          <Label>Your schedules</Label>
          {mine.map((s) => (
            <ScheduleRow key={s.id} schedule={s} on={path.endsWith(s.id)} />
          ))}
        </>
      )}
      {(runs.data ?? []).length > 0 && (
        <>
          <Label>Recent runs</Label>
          {(runs.data ?? []).map((r) => (
            <button key={r.id} onClick={() => navigate("/schedules/runs")} className="prow">
              <span className="min-w-0 flex-1 truncate">{r.scheduleName}</span>
              <span className="shrink-0 text-meta tabular-nums text-dim">
                {elapsed(minutesSince(r.fireAt))}
              </span>
            </button>
          ))}
        </>
      )}
    </>
  );
}

/**
 * One schedule, in the panel.
 *
 * **The mark here is the schedule's own state**, not its last run's: there is
 * no column beside it to say what the mark refers to. On the list there is a
 * *Last run* column, so the mark there is the outcome.
 */
function ScheduleRow({ schedule, on }: { schedule: Schedule; on: boolean }) {
  return (
    <button
      onClick={() => navigate(`/schedules/${schedule.id}`)}
      aria-current={on}
      className="prow"
      title={schedule.name}
    >
      <span className="grid w-[17px] shrink-0 place-items-center">
        {schedule.made.byAgent && !schedule.approvedAt ? (
          <span className="dot" title="waiting for you to turn it on" />
        ) : !schedule.active ? (
          <Icon of={CircleSlash2} size={14} className="text-dim" aria-label="off" />
        ) : (
          <Icon of={Clock} size={14} className="text-dim" aria-label="on" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{schedule.name}</span>
      <span className="shrink-0 text-meta tabular-nums text-dim">
        {schedule.active ? whenNext(schedule) : "off"}
      </span>
    </button>
  );
}

/** The next run, short enough for a 252px panel. */
function whenNext(schedule: Schedule): string {
  const at = schedule.triggers[0]?.nextFireAt;
  if (!at) return "—";
  const mins = Math.round((Date.parse(at) - Date.now()) / 60_000);
  if (!Number.isFinite(mins)) return "—";
  if (mins <= 0) return "due";
  return `in ${elapsed(mins)}`;
}

/* ── The pieces every panel is made of ───────────────────────────────────── */

function Head({ name, onCollapse }: { name: string; onCollapse: () => void }) {
  return (
    <div className="flex h-[38px] shrink-0 items-center gap-0.5 pr-2 pl-3.5">
      <span className="min-w-0 flex-1 truncate text-ui font-mid text-bone">{name}</span>
      {/* **Find anything, from the panel.** The drawing puts it here beside
          the collapse, in every destination's panel — the palette was
          reachable only by the key, which is the one way an affordance can be
          present and invisible at the same time. */}
      <Glyph
        of={Search}
        label="Find anything"
        hint={key("K")}
        onPick={() => window.dispatchEvent(new CustomEvent("firetower:palette"))}
      />
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

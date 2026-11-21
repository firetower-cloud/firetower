/**
 * The profile drawer: one editor, for a profile and for a position.
 *
 * It opens from a row in **Agent profiles** and from a card on a team's map,
 * in the window's own right rail — `right-rail.ts` holds that geometry, and
 * `Workbench` has been opening the same rail beside the conversation since the
 * redesign. Nothing here is a new kind of panel.
 *
 * ## The tabs are questions
 *
 * **Custom · What it is · Skills · How it runs · In teams.** Opened from a
 * card, *Custom* comes first, because the thing somebody pressed a card to
 * change is what that seat says — and the other three are not about that team
 * at all.
 *
 * ## The rule the whole screen is shaped around
 *
 * **A position never replaces a profile field. It only adds.** So there is no
 * resolution order to define and no override semantics to explain, which is
 * why the tab is *Custom* and not *Overrides*, and why the Custom tab draws
 * the profile's own instructions **above** the box somebody types in, in one
 * frame, with the join between them labelled. A field that looked like it
 * could overrule the profile would be two answers to "what is this agent
 * told".
 *
 * ## One band, under the tabs
 *
 * Three of the five tabs change the profile, which every team shares. The
 * consequence a person cannot otherwise see is that **the other team is not on
 * screen**, so it is stated once, in one place, rather than as a warning
 * repeated inside each panel. It is one of the few explanatory notes this
 * design keeps.
 *
 * ## What it replaced
 *
 * `Roles.tsx` had a full-page form for the same nineteen fields. Two editors
 * writing one object is the trap the approved design removed, so the form is
 * gone and every field it held is in a tab here — the inventory is in the pull
 * request, and `profile-drawer.test.tsx` holds the half of it a test can keep
 * honest.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CornerDownRight,
  CornerUpLeft,
  Eye,
  EyeOff,
  Maximize2,
  Network,
  PanelRightClose,
  Plus,
  Puzzle,
  Search,
  Server,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  deleteRole,
  getListRolesQueryKey,
  getRolePositionsQueryKey,
  updateRole,
  useListRoles,
  useRolePositions,
} from "~/api/generated/roles/roles";
import { useAgentControls } from "~/api/generated/agents/agents";
import { useMe } from "~/api/generated/auth/auth";
import type {
  Agent,
  Control,
  ControlKind,
  NewRole,
  ProfilePlaces,
  ProfilePosition,
  Role,
} from "~/api/generated/model";
import { AgentMark, AGENT_LABEL } from "~/components/AgentMark";
import { Badge, Button, Icon, IconButton } from "~/components/ui";
import { Pop } from "~/ui/Pop";
import { WhoCanAccess } from "~/ui/Sharing";
import { useAccounts, useAgents, useHosts, useSkills, why } from "~/data";
import { quota, usable } from "~/api/accounts";
import { machineLabel, machines, stateLabel } from "~/api/environments";
import { canRun } from "~/components/WhereItRuns";
import { useConfirm } from "~/ui/Confirm";
import { where } from "~/filing";
import { Note, WhereTo } from "~/ui/config/bits";
import { LeaveSheet, Sheet } from "~/ui/config/TeamSheet";
import { SkillSources, useSkillSources } from "~/ui/config/SkillSources";
import {
  ANY_ENGINE,
  CONTROL_ICON,
  ON_LIMIT,
  OPEN,
  PLACEMENTS,
  filedIn,
  nameTakenBy,
  nameTakenSays,
  pinnedAccountFits,
  toDraft,
  whatAChildGets,
  type Settled,
} from "~/ui/config/profile-draft";
import { bandAt, RAIL_DEFAULT, RAIL_MIN, railWidth, type Band } from "~/ui/right-rail";
import { useLeaveGuard } from "~/shims/next-navigation";

/* ── What opens in it ────────────────────────────────────────────────────── */

/**
 * The seat a map card opened, and the handles for editing it.
 *
 * #492's `OpenedSeat` says *which* seat; this adds what the drawer does with
 * it. **A position's instructions live in the map's draft, not here** — the
 * map holds one tree and Save is the only commit, so typing in the Custom tab
 * joins the map's pending count and Discard puts it back. A write of its own
 * would be a second commit on a screen whose whole design note is that there
 * is one.
 */
export type SeatHandle = {
  team: string;
  teamName: string;
  /** Null for a seat the map has drawn and not saved. */
  position: string | null;
  /** The map's own key for the card. */
  key: string;
  /** This seat's instructions, as the draft holds them. */
  instructions: string;
  /** Whether it is the lead, which cannot report to anything. */
  leads: boolean;
  /** The map's key of the seat above it. */
  under: string | null;
  /** And what that one is called, for the heading. */
  underName: string | null;
  /** Where else it could report: every seat it may be moved under. */
  elsewhere: { key: string; name: string }[];
  /** Whether this person may change the team. */
  mayWrite: boolean;
  onInstructions: (text: string) => void;
  onReparent: (parentKey: string) => void;
};

export type TabId = "custom" | "is" | "skills" | "runs" | "where";

export const PROFILE_TABS: [TabId, string][] = [
  ["is", "What it is"],
  ["skills", "Skills"],
  ["runs", "How it runs"],
  ["where", "In teams"],
];

/**
 * **Custom first**, because a card was pressed to change what that seat says.
 *
 * The name of this tab lives here and nowhere else. It was *Only here*, then
 * *Customize*, which collided with the rail destination of that name. *Custom*
 * says **added to** rather than **instead of**, which is the whole of what a
 * position does to a profile.
 */
export const SEAT_TABS: [TabId, string][] = [["custom", "Custom"], ...PROFILE_TABS];

/**
 * Which tabs change the profile, which every team shares.
 *
 * **Derived from the tab list rather than written beside it**, because the two
 * drifted: this was `{ is, skills, runs }` with *In teams* left out, so from a
 * card that tab's band read *This applies in Product only. It does not change
 * the profile* while the foot of the same pane read *Will save 1 change to
 * the profile, in both teams that use it*. The band is the one explanatory
 * note this design keeps, and it was reassuring somebody before they changed
 * something everywhere.
 *
 * *In teams* does edit the profile: during the compatibility window it holds
 * the reach a profile carries on its own. Every tab but *Custom* does, which
 * is what this now says in one place instead of two.
 */
export const SHARED: Record<string, true> = Object.fromEntries(
  PROFILE_TABS.map(([id]) => [id, true]),
);

/* ── The rail it opens in ────────────────────────────────────────────────── */

/**
 * A pane with a rail beside it.
 *
 * The pane is laid out as the left column and scrolls on its own, so the rail
 * is full height and keeps its own scroll — which is what makes it the
 * window's rail rather than a box drawn inside a page.
 *
 * **Three bands, measured on the pane.** `right-rail.ts` has the numbers and
 * the reason; what is here is what each one does. Floating puts the rail over
 * the pane with the ground behind it dismissing, because at that width docking
 * would leave the screen narrower than the rail. Pushing gives it the pane,
 * which is reached by dragging a desktop window narrow.
 *
 * The column exists whether or not anything is open, so opening the rail never
 * changes which element is scrolling and never throws away a scroll position.
 */
export function WithRail({
  children,
  rail,
  onDismiss,
}: {
  children: ReactNode;
  rail: ((band: Band, width: number) => ReactNode) | null;
  onDismiss: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  const [held, setHeld] = useState(() => {
    try {
      const was = Number(localStorage.getItem("firetower.drawer.width"));
      return was >= RAIL_MIN ? was : RAIL_DEFAULT;
    } catch {
      return RAIL_DEFAULT;
    }
  });

  /* The pane, not the window. A `ResizeObserver` rather than a resize
     listener: the rail index collapses with ⌘\ and the pane changes width
     without the window changing at all. */
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const watch = new ResizeObserver(([entry]) => setRoom(entry.contentRect.width));
    watch.observe(el);
    setRoom(el.clientWidth);
    return () => watch.disconnect();
  }, []);

  const band = bandAt(room || DOCK_GUESS);
  const width = band === "push" ? room : railWidth(held, room || DOCK_GUESS);

  /* Dragging its edge, the way `Workbench` drags the inspector's: pointer
     capture on the handle, so the drag survives the pointer outrunning it. */
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const from = { x: e.clientX, width };
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => setHeld(railWidth(from.width + (from.x - ev.clientX), room));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setHeld((w) => {
        try {
          localStorage.setItem("firetower.drawer.width", String(w));
        } catch {
          // A browser told to keep nothing. The width lasts the session.
        }
        return w;
      });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  const panel = rail?.(band, width);

  return (
    <div ref={box} className="pdock">
      <div className="pdockmain scroll-slim">{children}</div>
      {panel && band === "dock" && (
        <>
          <div onPointerDown={startResize} title="Drag to resize" className="pdockgrip">
            <span />
          </div>
          <aside style={{ width }} className="pdockrail">
            {panel}
          </aside>
        </>
      )}
      {panel && band !== "dock" && (
        /* Over the pane. The ground behind it dismisses, which is what
           anything floating in this window does. */
        <div className="pdockover" onMouseDown={onDismiss}>
          <aside
            onMouseDown={(e) => e.stopPropagation()}
            style={{ width: band === "push" ? "100%" : width }}
            className="pdockrail"
          >
            {panel}
          </aside>
        </div>
      )}
    </div>
  );
}

/** Before the first measurement. The desk's pane, which docks. */
const DOCK_GUESS = 982;

/* ── The drawer ──────────────────────────────────────────────────────────── */

export function ProfileDrawer({
  profile,
  seat,
  withheld,
  want,
  onClose,
  onGoToSeat,
}: {
  /** The profile being edited, by id. */
  profile: string;
  /** The seat it was opened from, or null from a library row. */
  seat?: SeatHandle | null;
  /**
   * Where the screen behind would like the drawer to go next: another
   * profile, or nothing at all.
   *
   * **Asked for rather than done**, because the drawer may be holding an
   * unsaved draft and swapping what it is editing behind its back is the
   * same silent loss as navigating away. It answers through `onClose`, once
   * the question has been settled.
   *
   * `to` is opaque here and is handed straight back: the library means a
   * profile by it and the map means one of its own card keys, and the drawer
   * does not need to know which. The screen behind asks only when it is a
   * genuine change.
   */
  want?: { to: string | null };
  /**
   * The team read this seat without a profile name, so nothing of the profile
   * may be drawn here. **Told rather than worked out**, because working it out
   * means reading the profile list — which is the leak.
   */
  withheld?: boolean;
  /** Let go, and show `to` instead — or nothing, when there is no `to`. */
  onClose: (to?: string | null) => void;
  /** Where an *In teams* row goes. Absent where there is nowhere to go. */
  onGoToSeat?: (team: string, position: string) => void;
}) {
  /* **Before anything reads the profile.** A withheld seat is a seat whose
     profile this person may not see, and a drawer that fetched it to find out
     what to hide has already found out. */
  if (withheld && seat) {
    return <Redacted profile={profile} seat={seat} onClose={() => onClose(null)} />;
  }
  return (
    <Editing
      profile={profile}
      seat={seat}
      want={want}
      onClose={onClose}
      onGoToSeat={onGoToSeat}
    />
  );
}

/**
 * A seat whose profile this reader cannot see.
 *
 * **The id is disclosed on purpose**, and it is the only thing of the profile
 * that is: #490's own note records it as intended rather than as a leak, and
 * the reason is the one the map's dashed card is drawn for — a gap would
 * misrepresent the team. So the seat keeps its place, says the id it
 * references, and shows what *the team* says about it, which this person may
 * read because the team is theirs to read.
 *
 * No tabs: four of the five are about a profile, and there is no profile here
 * to put in them.
 */
function Redacted({
  profile,
  seat,
  onClose,
}: {
  profile: string;
  seat: SeatHandle;
  onClose: () => void;
}) {
  return (
    <Panel label="Position" onClose={onClose} crumb={`${seat.teamName} · a position`}>
      <div className="dhead">
        <div className="top">
          <span className="g">
            <Icon of={EyeOff} size={16} />
          </span>
          <h2 className="font-mono">{profile}</h2>
        </div>
        <div className="dchips">
          <span className="dchip on">
            <Icon of={Network} size={12} />
            in {seat.teamName}
            {seat.leads ? ", leading it" : null}
          </span>
        </div>
      </div>
      <div className="dshared only" role="note">
        <Icon of={EyeOff} size={12} />
        <span>
          This profile is filed somewhere you cannot reach, so its name and what it does are not
          shown. Its seat in <b>{seat.teamName}</b> is.
        </span>
      </div>
      <div className="dbody scroll-slim">
        <div className="fld">
          <span>What {seat.teamName} says here</span>
          <span className="hint">
            The seat's own instructions. {seat.mayWrite ? "Yours to change." : null}
          </span>
          <div className="instrbox">
            <textarea
              rows={5}
              value={seat.instructions}
              readOnly={!seat.mayWrite}
              onChange={(e) => seat.onInstructions(e.target.value)}
              placeholder={seat.mayWrite ? "Owns the web client." : "Nothing"}
              aria-label={`Extra instructions in ${seat.teamName}`}
            />
          </div>
        </div>
      </div>
      <div className="dfoot">
        <span className="msg quiet">
          Take it out from the card on the map, if this team should not hand work to it.
        </span>
      </div>
    </Panel>
  );
}

/** Everything the drawer is when there is a profile to draw. */
function Editing({
  profile,
  seat,
  want,
  onClose,
  onGoToSeat,
}: {
  profile: string;
  seat?: SeatHandle | null;
  want?: { to: string | null };
  onClose: (to?: string | null) => void;
  onGoToSeat?: (team: string, position: string) => void;
}) {
  const cache = useQueryClient();
  const confirm = useConfirm();
  const roles = useListRoles();
  const role = roles.data?.find((r) => r.id === profile);
  const places = useRolePositions(profile, { query: { enabled: !!role } });

  const [tab, setTab] = useState<TabId>(seat ? "custom" : "is");
  const [draft, setDraft] = useState<Settled | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<"profile" | "seat" | null>(null);
  const [pinning, setPinning] = useState(false);
  /** What to do once the question about unsaved changes has been answered. */
  const [leaving, setLeaving] = useState<{ resume: () => void } | null>(null);

  /* Seeded from the stored profile, and re-seeded when a different one opens
     or the stored one changes under an untouched drawer. A draft in progress
     is left alone: a refetch that overwrote what somebody is typing is the
     thing `Save is the only commit` exists to make impossible. */
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!role) return;
    const at = `${role.id}/${role.updatedAt}`;
    if (seeded.current === at) return;
    seeded.current = at;
    setDraft(toDraft(role));
    setProblem(null);
  }, [role]);

  /* Opening a different seat is a different question, so the tabs go back to
     the one that question is on. */
  useEffect(() => {
    setTab(seat ? "custom" : "is");
  }, [seat?.key, profile]);

  const tabs = seat ? SEAT_TABS : PROFILE_TABS;
  const may = role?.mayWrite !== false;
  const changed = useMemo(
    () => (role && draft ? diffOf(role, draft) : []),
    [role, draft],
  );

  /* **Is this name free where this profile is filed?** (#489)
     A profile's name is one profile within its directory, and the server is
     what enforces that — `roles_name_in_directory`, and the sentences
     `crate::roles` reads off it. This asks the same question so that Save is
     not a button that looks live and comes back refused, which is the half
     #498 built into the editor this drawer replaced. An existing profile is
     judged where it is *filed*, which `role.path` always says, so unlike the
     create form there is no destination here to be unsure about. */
  const taken = role && draft ? nameTakenBy(draft.name, filedIn(role.path), role.id, roles.data ?? []) : null;

  const set = <K extends keyof Settled>(k: K, v: Settled[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));

  /** Answers whether it wrote, so *Save and go* only goes when it did. */
  const save = async (): Promise<boolean> => {
    if (!role || !draft || saving) return false;
    /* The one refusal this knows before the server does (#489). *Save and go*
       reaches here with the button it would have pressed held, so it answers
       with the sentence rather than silently declining to write — a press that
       does nothing is worse than the dead end it was guarding. */
    if (taken) {
      setProblem(
        `“${taken}” is already filed where this profile is, and two profiles filed together cannot share a name, so the name on What it is has to change first.`,
      );
      return false;
    }
    setSaving(true);
    setProblem(null);
    try {
      await updateRole(role.id, { ...draft, agent: draft.agent || null } as NewRole);
      await cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
      seeded.current = null;
      return true;
    } catch (e) {
      setProblem(why(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (role) setDraft(toDraft(role));
    setProblem(null);
  };

  /**
   * **Shutting the drawer with a draft in it asks**, and so does going
   * somewhere else.
   *
   * Save is the only commit here as it is on the map, and the same promise
   * breaks the same way: a surface that drops unsaved work on the way out
   * does it in silence. The question is `LeaveSheet`, which is the map's own
   * — one idea, one wording.
   *
   * Two exits, one answer. `navigate` consults the guard; the close control,
   * `Escape` and the ground behind a floating drawer all come through
   * `ifSaved`. On the map both this guard and the map's are registered, and
   * each asks for its own draft in turn.
   */
  const ifSaved = (go: () => void) => {
    if (changed.length === 0 || saving) {
      go();
      return;
    }
    setLeaving({ resume: go });
  };
  useLeaveGuard((resume) => {
    if (changed.length === 0 || saving) return false;
    setLeaving({ resume });
    return true;
  });
  const andGo = () => {
    const go = leaving?.resume;
    setLeaving(null);
    go?.();
  };

  /* The third exit: the screen behind wants this drawer to hold something
     else. Another row in the library, or nothing because the ground behind a
     floating drawer was pressed. Same question, same answer. */
  useEffect(() => {
    if (!want) return;
    ifSaved(() => onClose(want.to));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want]);

  /**
   * Delete the profile, naming every team and the count first.
   *
   * The confirmation is the same shape the map card's destructive control
   * has: **it states what goes with it before it is pressed.** Deleting a
   * profile removes each position that references it and everything under
   * those, and the teams that lose them are not on screen — so they are named,
   * with the number of positions each loses, and a team whose lead this is
   * says that instead, because it is left with nothing rather than pruned.
   */
  const remove = async () => {
    if (!role) return;
    const used: ProfilePlaces = places.data ?? EMPTY_PLACES;
    const takes = used.places.length + Math.max(0, used.withheld ?? 0);
    const ok = await confirm({
      title: `Delete ${role.name}?`,
      body: <Blast name={role.name} used={used} />,
      action: takes ? "Delete and take the positions out" : "Delete profile",
      tone: "danger",
    });
    if (!ok) return;
    setSaving(true);
    try {
      await deleteRole(role.id);
      await cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
      onClose(null);
    } catch (e) {
      setProblem(why(e));
      setSaving(false);
    }
  };

  if (!role) {
    return (
      <Panel label="Profile" onClose={() => onClose(null)}>
        <p className="px-4 py-6 text-ui text-dim">
          {roles.isLoading ? "Reading the profile…" : "This profile is no longer here."}
        </p>
      </Panel>
    );
  }

  /* **A profile somebody may read and not change opens as a reading.** No
     fields, nothing greyed out, and no Save the server would refuse. The
     boundary is read as a boundary. */
  if (!may) {
    return (
      <Panel label="Profile" onClose={() => onClose(null)} crumb={crumbOf(seat, places.data?.places)}>
        <Head role={role} seat={seat} />
        <Reading role={role} places={places.data?.places ?? []} seat={seat} />
      </Panel>
    );
  }

  const band =
    seat && SHARED[tab] ? (
      <Everywhere name={role.name} teams={teamsIn(places.data?.places)} />
    ) : seat ? (
      <OnlyHere team={seat.teamName} />
    ) : SHARED[tab] && teamsIn(places.data?.places) > 0 ? (
      <Everywhere name={role.name} teams={teamsIn(places.data?.places)} />
    ) : null;

  return (
    <Panel
      label={seat ? "Position" : "Profile"}
      onClose={() => ifSaved(() => onClose(null))}
      crumb={crumbOf(seat, places.data?.places)}
      more={
        <IconButton
          of={Trash2}
          onClick={() => void remove()}
          label={`Delete ${role.name}`}
          hint="Delete this profile"
          className="hover:text-brick"
        />
      }
    >
      <Head role={role} seat={seat} />

      <div className="itabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className="itab"
          >
            {label}
            {tab === id && <span className="ul" />}
          </button>
        ))}
      </div>

      {band}

      <div className="dbody scroll-slim">
        {tab === "custom" && seat && (
          <Custom
            role={role}
            seat={seat}
            onExpand={() => setExpanded("seat")}
          />
        )}
        {tab === "is" && draft && (
          <WhatItIs
            role={role}
            draft={draft}
            set={set}
            taken={taken}
            roles={roles.data ?? []}
            onExpand={() => setExpanded("profile")}
          />
        )}
        {tab === "skills" && draft && (
          <Skills
            draft={draft}
            shared={role.path.startsWith("d/")}
            onChange={(patch) =>
              /* `NewRole` reads the two skill switches as
                 `boolean | null | undefined`, where absent means *leave it
                 alone*; a draft has to have decided, which is what `Settled`
                 says. The patch comes from a component that draws a switch
                 per field, so neither can be absent in practice — the
                 coalesce is what makes that a type rather than a hope. */
              setDraft((d) =>
                d
                  ? {
                      ...d,
                      ...patch,
                      includeAlwaysOn: patch.includeAlwaysOn ?? d.includeAlwaysOn,
                      includeRepoDefaults: patch.includeRepoDefaults ?? d.includeRepoDefaults,
                    }
                  : d,
              )
            }
            onPin={() => setPinning(true)}
          />
        )}
        {tab === "runs" && draft && <HowItRuns draft={draft} set={set} setDraft={setDraft} />}
        {tab === "where" && (
          <InTeams
            role={role}
            places={places.data?.places ?? []}
            loading={places.isLoading}
            here={seat?.key ?? null}
            onGoToSeat={onGoToSeat}
          />
        )}
      </div>

      {problem && <p className="px-4 pb-2 text-meta text-brick">{problem} Nothing was saved.</p>}

      {/* **The action row, at the desk's one control height.** Not a status
          strip: `--control` is 30px and a strip is 22, so a control in one
          overhangs it. #492's map puts Save and Discard in an action row for
          the same reason, and this is the same row. */}
      <div className="dfoot">
        {/* Nothing at rest: the chip at the other end of this row already
            reads *No changes*, and a sentence saying the same thing is the
            second drawing of one fact. */}
        {changed.length > 0 && (
          <span className="msg">{willSave(changed.length, teamsIn(places.data?.places))}</span>
        )}
        {changed.length > 0 ? (
          <>
            <Button variant="quiet" size="sm" onClick={discard} disabled={saving}>
              Discard
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void save()}
              disabled={saving || !!taken}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </>
        ) : (
          <span className="dchip">
            <Icon of={Check} size={12} />
            No changes
          </span>
        )}
      </div>

      {/* The bigger editor, over the screen. **One affordance, two fields** —
          the profile's instructions and a seat's extra instructions are the
          same kind of writing at drawer width, and a second way to expand
          would be a second thing to learn. */}
      {expanded === "profile" && draft && (
        <Sheet
          title={`Instructions for ${role.name}`}
          onClose={() => setExpanded(null)}
          foot={
            <>
              <span className="msg">
                {draft.instructions?.length ?? 0} characters. Saved with the profile.
              </span>
              <Button variant="default" onClick={() => setExpanded(null)}>
                Done
              </Button>
            </>
          }
        >
          <p className="max-w-[60ch] text-body leading-relaxed text-text">
            Markdown. Added to its prompt wherever it runs.
          </p>
          <div className="bigedit">
            <textarea
              autoFocus
              rows={16}
              value={draft.instructions ?? ""}
              onChange={(e) => set("instructions", e.target.value)}
              placeholder="What it should always do, wherever it is used."
            />
          </div>
        </Sheet>
      )}

      {expanded === "seat" && seat && (
        <Sheet
          title="Extra instructions for this position"
          onClose={() => setExpanded(null)}
          foot={
            <>
              <span className="msg">
                {seat.instructions.length} characters. Saved when you save the team.
              </span>
              <Button variant="default" onClick={() => setExpanded(null)}>
                Done
              </Button>
            </>
          }
        >
          <p className="max-w-[60ch] text-body leading-relaxed text-text">
            Markdown. Added to what {role.name} already says, in <b>{seat.teamName}</b> only.
          </p>
          <div className="bigedit">
            <textarea
              autoFocus
              rows={16}
              value={seat.instructions}
              onChange={(e) => seat.onInstructions(e.target.value)}
              placeholder="Owns the web client."
            />
          </div>
        </Sheet>
      )}

      {pinning && draft && (
        <PinSkill
          name={role.name}
          pinned={draft.skillScope ?? []}
          teams={places.data?.places ?? []}
          onChange={(skillScope) => set("skillScope", skillScope)}
          onClose={() => setPinning(false)}
        />
      )}

      {leaving && (
        <LeaveSheet
          what={role.name}
          says={`${notSaved(changed.length, teamsIn(places.data?.places))} The drawer is showing them until you decide.`}
          saving={saving}
          problem={problem}
          onStay={() => setLeaving(null)}
          onDiscard={() => {
            discard();
            andGo();
          }}
          onSave={() => void save().then((wrote) => wrote && andGo())}
        />
      )}
    </Panel>
  );
}

/* ── The shell ───────────────────────────────────────────────────────────── */

/** The rail's own chrome: what you opened, and the way out of it. */
function Panel({
  label,
  crumb,
  more,
  onClose,
  children,
}: {
  label: string;
  crumb?: string;
  more?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section aria-label={label} className="pdrawer">
      <div className="dnav">
        <IconButton of={PanelRightClose} onClick={onClose} label="Close" />
        {crumb && <span className="crumb">{crumb}</span>}
        {more && <span className="right">{more}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * What you opened, said at the top.
 *
 * **A profile and a position have the same name and different
 * consequences**, so the heading has to say which. A position wears the team
 * it is in and what it sits under; a profile wears where it is filed.
 *
 * **And where it is filed is also who else has it**, which is why that chip
 * is the sharing control rather than a label beside one. *What it is* carried
 * a *Who can use it* row whose whole content was a sentence explaining that
 * the path above it was the answer — a sentence that existed because of where
 * the control was. The chip was already on screen and already inert; the row
 * is gone and the chip opens the sheet.
 */
function Head({ role, seat }: { role: Role; seat?: SeatHandle | null }) {
  return (
    <div className="dhead">
      <div className="top">
        <span className="g">
          {role.agent ? (
            <AgentMark agent={role.agent as Agent} size={16} />
          ) : (
            <Icon of={CircleDashed} size={16} />
          )}
        </span>
        <h2>{role.name}</h2>
      </div>
      <div className="dchips">
        {seat ? (
          /* **Which seat, not just which team.** Two positions of one
             profile in one team have the same name, and where each sits is
             the thing that tells them apart. */
          <span className="dchip on">
            <Icon of={Network} size={12} />
            in {seat.teamName}
            {seat.leads
              ? ", leading it"
              : seat.underName
                ? `, under ${seat.underName}`
                : null}
          </span>
        ) : (
          <WhoCanAccess
            kind="role"
            id={role.id}
            path={role.path}
            look="chip"
            label={role.path}
            className="dchip mono act"
          />
        )}
        {seat && !seat.position && (
          <span className="dchip">
            <Icon of={Plus} size={12} />
            not saved yet
          </span>
        )}
      </div>
    </div>
  );
}

/** `Product · a position`, or the teams a profile sits in. */
function crumbOf(seat: SeatHandle | null | undefined, places: ProfilePosition[] | undefined) {
  if (seat) return `${seat.teamName} · a position`;
  const names = [...new Set((places ?? []).map((p) => p.teamName))];
  return names.length ? names.join(" · ") : "in no team";
}

/** How many teams hold a position for this profile. */
function teamsIn(places: ProfilePosition[] | undefined): number {
  return new Set((places ?? []).map((p) => p.team)).size;
}

/* ── The band ────────────────────────────────────────────────────────────── */

/**
 * **The one note this design keeps.**
 *
 * The other team is not on screen, and that is the consequence a person will
 * not otherwise see. Said once, under the tabs, rather than inside each panel
 * that happens to edit the profile.
 */
function Everywhere({ name, teams }: { name: string; teams: number }) {
  return (
    <div className="dshared" role="note">
      <Icon of={Users} size={12} />
      <span>
        Editing this changes <b>{name}</b> in{" "}
        {teams <= 1
          ? "the one team that uses it"
          : teams === 2
            ? "both teams that use it"
            : `all ${teams} teams that use it`}
        .
      </span>
    </div>
  );
}

function OnlyHere({ team }: { team: string }) {
  return (
    <div className="dshared only" role="note">
      <Icon of={Network} size={12} />
      <span>
        This applies in <b>{team}</b> only. It does not change the profile.
      </span>
    </div>
  );
}

/* ── Custom ──────────────────────────────────────────────────────────────── */

/**
 * What this seat adds, and what it adds to.
 *
 * **One frame, two parts, and the join is labelled.** The profile's own
 * instructions are above, as text; the box below is this seat's. Drawn apart
 * they would be two fields of the same shape, and *the drawer must never show
 * a profile field and a position field in one group without saying which is
 * which* — which is the must-not this frame answers rather than a caption
 * does.
 */
function Custom({
  role,
  seat,
  onExpand,
}: {
  role: Role;
  seat: SeatHandle;
  onExpand: () => void;
}) {
  const said = role.instructions.trim();
  return (
    <>
      <div className="fld">
        <span>Extra instructions</span>
        <span className="hint">
          It never replaces the profile’s instructions. Yours are added after.
        </span>
        <div className="joinbox">
          <div className="jh">{role.name} always says</div>
          {said ? (
            <div className="jsaid">{clip(said, 340)}</div>
          ) : (
            <div className="jsaid none">Nothing. Its instructions are empty.</div>
          )}
          <div className="jh and">and here, as well</div>
          <textarea
            rows={5}
            value={seat.instructions}
            readOnly={!seat.mayWrite}
            onChange={(e) => seat.onInstructions(e.target.value)}
            placeholder={seat.mayWrite ? "Owns the web client." : "Nothing"}
            aria-label={`Extra instructions in ${seat.teamName}`}
          />
          <div className="bar">
            <span className="msg">
              {seat.instructions.length
                ? `${seat.instructions.length} characters`
                : "Markdown"}
            </span>
            <Button variant="quiet" size="sm" icon={Maximize2} onClick={onExpand}>
              Open editor
            </Button>
          </div>
        </div>
      </div>

      {/* **Re-parenting lives here.** The map has no control for it: the
          prototype draws none, and #492 would have had to invent one. The
          draft it edits is the map's, so moving a seat joins the map's pending
          count and Discard puts it back. */}
      {seat.mayWrite && !seat.leads && seat.elsewhere.length > 1 && (
        <Group
          label="Reports to"
          hint="It takes everything under it with it."
        >
          <div className="pickrow">
            {seat.elsewhere.map((o) => (
              <button
                key={o.key}
                type="button"
                aria-pressed={seat.under === o.key}
                onClick={() => seat.onReparent(o.key)}
                className="pk"
              >
                {o.name}
                {seat.under === o.key && (
                  <span className="tick">
                    <Icon of={Check} size={14} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </Group>
      )}
    </>
  );
}

/* ── What it is ──────────────────────────────────────────────────────────── */

/**
 * The identity half: what it is called, what it does, what it is told — and
 * the two statements about the kind of work that nobody else can make.
 *
 * **Two rows left this tab and did not come back.** *Who can use it* was a
 * sentence saying the path chip above it was the answer; the chip is now the
 * control. *Default* was a fact about this person rather than a field of this
 * profile, and it carried "only one profile can be the default" — a rule
 * nobody has to be told on a list where the star is visible and moves. A
 * sentence that exists because of where a control is, is a sign the control
 * is in the wrong place.
 */
function WhatItIs({
  role,
  draft,
  set,
  taken,
  roles,
  onExpand,
}: {
  role: Role;
  draft: Settled;
  set: <K extends keyof Settled>(k: K, v: Settled[K]) => void;
  /** Whichever profile already holds this name in the same directory (#489). */
  taken: string | null;
  /** Every profile this person can see, for naming the ones old reach names. */
  roles: Role[];
  onExpand: () => void;
}) {
  const me = useMe();

  return (
    <>
      <Field label="Name" hint="Leads delegate by this name.">
        <input
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="reviewer"
          className="w-full rounded-md border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-dim focus:outline-none"
        />
        {/* Said here rather than at the foot, because the field at fault is
            the one above it — and before Save rather than after, which is
            what makes it worth saying at all: the server refuses this either
            way. Carried over from the editor this tab replaced (#498). */}
        {taken && (
          <p className="text-meta text-brick">
            {nameTakenSays(taken, where(filedIn(role.path), me.data?.user))}
          </p>
        )}
      </Field>

      {/* The craft advice is in the placeholder, where it is read while the
          box is empty and gone the moment there is something to read
          instead. */}
      <Field label="Description" hint="A lead reads this to decide whether to hand it the work.">
        <textarea
          value={draft.does}
          onChange={(e) => set("does", e.target.value)}
          rows={3}
          placeholder="Reviews a finished branch and reports problems as file:line. Not for a one-line fix."
          className="w-full resize-y rounded-md border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-dim focus:outline-none"
        />
      </Field>

      {/* **Open editor sits beside the label**, not under the box. At the
          rail's floor the box is for checking what is there rather than for
          writing it, so the way to the room with the width in it is the
          control next to the heading — and the bar under the box, which held
          a character count and the word Markdown the hint already says, is
          gone with it.

          **And a `Group`, not a `Field`**, now that there are two controls:
          a `label` adopts the first one under it and forwards to it every
          click that lands on the label and misses, which is what #df57c93
          found in the sharing chip one field below this one. The box carries
          its own name instead. */}
      <Group
        label="Instructions"
        hint="Added to its prompt every time it runs. Markdown."
        beside={
          <Button variant="quiet" size="sm" icon={Maximize2} onClick={onExpand}>
            Open editor
          </Button>
        }
      >
        <div className="instrbox">
          <textarea
            rows={6}
            value={draft.instructions ?? ""}
            onChange={(e) => set("instructions", e.target.value)}
            placeholder="What it should always do, wherever it is used."
            aria-label={`Instructions for ${role.name}`}
          />
        </div>
      </Group>

      <OldReach draft={draft} set={set} roles={roles} />
    </>
  );
}

/**
 * The reach a profile carries from before teams, and the way to put it down.
 *
 * **Only on a profile that actually carries some.** Every other profile shows
 * nothing, so nothing here teaches a model that is being removed — which is
 * the whole reason it is a disclosure and not a field.
 *
 * It closes a real gap rather than restating one. The per-profile delegation
 * controls came out of the drawer when teams took the question over, and the
 * fields stayed live for a session that holds no position — so a profile with
 * reach set could not be turned off from this window at all. *Remove* is the
 * control that was missing. It joins the draft like every other change and
 * Save writes it, because Save is the only commit in this drawer.
 *
 * Goes entirely with #497, which removes the fields.
 */
export function OldReach({
  draft,
  set,
  roles,
}: {
  draft: Settled;
  set: <K extends keyof Settled>(k: K, v: Settled[K]) => void;
  roles: Role[];
}) {
  const [showing, setShowing] = useState(false);
  const scope = draft.delegateScope ?? [];
  if (!draft.canDelegate && scope.length === 0) return null;

  /* An empty scope is not "nothing": `delegate_scope` empty means *any
     profile the owner can see*, which is the widest reach of the two and the
     one worth naming as such. Naming three is what `Show them` is for; there
     is nothing to show when the list is the whole library. */
  const named = scope
    .map((id) => roles.find((r) => r.id === id)?.name)
    .filter((n): n is string => !!n);

  return (
    <div className="dnote" role="note">
      <b>
        {scope.length
          ? `Still hands work to ${count(scope.length, "profile")}`
          : "Still hands work to any profile you can see"}
      </b>
      <p>We introduced the Teams feature which deprecated the old profile delegation feature.</p>
      {showing && (
        <div className="dchips wrap">
          {named.length ? (
            named.map((n) => (
              <span key={n} className="dchip mono">
                {n}
              </span>
            ))
          ) : (
            <span className="none">None of them is a profile you can see.</span>
          )}
        </div>
      )}
      <div className="acts">
        <Button
          size="sm"
          onClick={() => {
            set("canDelegate", false);
            set("delegateScope", []);
          }}
        >
          Remove
        </Button>
        {scope.length > 0 && (
          <Button variant="quiet" size="sm" onClick={() => setShowing((v) => !v)}>
            {showing ? "Hide them" : "Show them"}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ── Skills ──────────────────────────────────────────────────────────────── */

/**
 * What it loads, and what it pins.
 *
 * **Pin a skill sits above the list.** A control under a list moves every
 * time the list grows, and this one has to be in the same place on a profile
 * that pins two and one that pins twenty.
 */
function Skills({
  draft,
  shared,
  onChange,
  onPin,
}: {
  draft: Settled;
  shared: boolean;
  onChange: (patch: Partial<NewRole>) => void;
  onPin: () => void;
}) {
  const resolved = useSkillSources(draft, shared);
  const skills = useSkills();
  const named = useMemo(
    () => new Map(skills.data.map((s) => [s.id, s.name])),
    [skills.data],
  );
  const pinned = draft.skillScope ?? [];

  return (
    <>
      <div className="fld">
        <span>Pinned skills</span>
        <button type="button" onClick={onPin} className="btn plain addsk">
          <Icon of={Plus} size={14} />
          Pin a skill
        </button>
        <div className="dchips wrap">
          {pinned.length === 0 ? (
            <span className="none">Nothing pinned</span>
          ) : (
            pinned.map((id) => (
              <span key={id} className="dchip mono">
                <Icon of={Puzzle} size={12} />
                {named.get(id) ?? id}
                <button
                  type="button"
                  className="x"
                  aria-label={`Unpin ${named.get(id) ?? id}`}
                  onClick={() => onChange({ skillScope: pinned.filter((s) => s !== id) })}
                >
                  <Icon of={X} size={12} />
                </button>
              </span>
            ))
          )}
        </div>
      </div>

      {/* The budget, the two sources and what they resolve to — the pane's own
          component, mounted unchanged. It already says one thing in one
          wording, and a second wording here would be two. */}
      <SkillSources r={resolved} onChange={onChange} />
    </>
  );
}

/** Pin a skill. The sheet names every team before anything changes. */
function PinSkill({
  name,
  pinned,
  teams,
  onChange,
  onClose,
}: {
  name: string;
  pinned: string[];
  teams: ProfilePosition[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
}) {
  const skills = useSkills();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const rows = skills.data.filter(
    (s) =>
      !needle ||
      s.name.toLowerCase().includes(needle) ||
      (s.description ?? "").toLowerCase().includes(needle),
  );
  const named = [...new Set(teams.map((t) => t.teamName))];

  return (
    <Sheet
      title={`Skills for ${name}`}
      onClose={onClose}
      foot={
        <>
          <span className="msg">
            {pinned.length
              ? `${pinned.length} pinned. Saved when you save the profile.`
              : "Nothing pinned. It can load any skill you can see."}
          </span>
          <Button variant="default" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <p className="max-w-[60ch] text-body leading-relaxed text-text">
        A skill is a set of instructions this profile can load when the work needs it. Pinning
        narrows it to the ones you choose.
      </p>
      {named.length > 1 && (
        <Note icon={Users}>
          Skills belong to the profile, not to one team. {name} holds a position in{" "}
          {named.join(", ")}. Pinning here pins it in all of them.
        </Note>
      )}
      <label className="find mt-3">
        <Icon of={Search} size={14} />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search skills"
          aria-label="Search skills"
          spellCheck={false}
          className="placeholder:text-mute focus:outline-none"
        />
      </label>
      <div className="scopebox mt-2">
        {rows.map((s) => {
          const on = pinned.includes(s.id);
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange(on ? pinned.filter((x) => x !== s.id) : [...pinned, s.id])
              }
              className="sr"
            >
              <span className="tick2" data-on={on}>
                {on && <Icon of={Check} size={12} />}
              </span>
              <span className="nm mono">{s.name}</span>
              <span className="ds">{s.description}</span>
            </button>
          );
        })}
        {rows.length === 0 && <p className="px-3 py-3 text-meta text-mute">No skill matches.</p>}
      </div>
    </Sheet>
  );
}

/* ── How it runs ─────────────────────────────────────────────────────────── */

/**
 * What a run of this profile starts with, for anybody who runs it.
 *
 * **Moved from `Roles.tsx`'s form, field for field, with its comments.** Every
 * argument in here was already won: the three open pills and the one phrase
 * they share, the machine that comes off with *Same workspace*, the
 * subscription that leaves with the engine and says what it dropped, and the
 * sentence that reads all three back as what a spawn gets. None of it was
 * rewritten to fit a narrower column.
 */
function HowItRuns({
  draft,
  set,
  setDraft,
}: {
  draft: Settled;
  set: <K extends keyof Settled>(k: K, v: Settled[K]) => void;
  setDraft: React.Dispatch<React.SetStateAction<Settled | null>>;
}) {
  const agents = useAgents();
  const { data: hosts } = useHosts();
  const { data: accounts, loading: accountsLoading } = useAccounts();

  const agentOptions: Opt[] = agents.data
    .filter((a) => a.supported)
    .map((a) => ({
      value: a.kind as string | null,
      icon: <AgentMark agent={a.kind} size={16} />,
      label: a.label,
    }));
  // A profile may already pin an engine that is no longer on offer; keep it
  // nameable rather than dropping the pin.
  if (draft.agent && !agentOptions.some((o) => o.value === draft.agent)) {
    const held = draft.agent as Agent;
    agentOptions.push({
      value: held,
      icon: <AgentMark agent={held} size={16} />,
      label: AGENT_LABEL[held] ?? held,
    });
  }

  const machineRows = machines(hosts)
    .map((m) => ({ m, host: m.hosts[0] }))
    .filter((x) => !!x.host)
    .map((x) => ({
      id: x.host!.id,
      label: machineLabel(x.m),
      says: [
        x.host!.cpus ? `${x.host!.cpus} cores` : null,
        x.host!.memoryMb ? `${Math.round(x.host!.memoryMb / 1024)} GB` : null,
        stateLabel(x.host!),
      ]
        .filter(Boolean)
        .join(" · "),
    }));
  const pinnedEngine = agents.data.find((a) => a.kind === draft.agent);
  const runsThere = (host: string) => (pinnedEngine ? canRun(pinnedEngine, host) : null);

  const accountOptions: Opt[] = [
    {
      value: null,
      icon: <Icon of={CircleDashed} size={16} />,
      label: `Your default for ${draft.agent ? (AGENT_LABEL[draft.agent as Agent] ?? draft.agent) : "it"}`,
      note: "resolved when it launches",
    },
    ...accounts
      .filter((a) => a.kind === draft.agent && usable(a))
      .map((a) => ({
        value: a.id as string | null,
        icon: <Icon of={Server} size={16} />,
        label: a.name,
        note: a.ownerName ? `${a.ownerName}'s subscription` : quota(a),
      })),
  ];
  const connected = accountOptions.length > 1;

  const controlsQ = useAgentControls(draft.agent ?? "", { query: { enabled: !!draft.agent } });
  const controls = (draft.agent ? (controlsQ.data ?? []) : []) as Control[];

  const setSetting = (kind: ControlKind, v: string | null) =>
    setDraft((d) => {
      if (!d) return d;
      const next = { ...(d.settings ?? {}) };
      if (v == null) delete next[kind];
      else next[kind] = v;
      return { ...d, settings: next };
    });

  /* *Same workspace* is the one placement where a machine can never apply — a
     child there runs wherever its lead does — so the pin comes off with the
     press. Not an effect: a press is one change, and an effect that rewrites a
     field after a render is what made the last pill here unpressable. */
  const setPlacement = (to: string) =>
    setDraft((d) => (d ? { ...d, placement: to, machine: to === "here" ? null : d.machine } : d));

  // A subscription belongs to one engine, so when the engine changes (or the
  // list loads) drop a pick that no longer fits. It falls back to the owner's
  // default rather than to whichever account happens to be first.
  useEffect(() => {
    if (draft.account && !pinnedAccountFits(draft.account, draft.agent, accounts, !accountsLoading))
      set("account", null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.agent, accounts, accountsLoading]);

  /* Run controls are per-engine, so a pin for one means nothing to another.
     What came off is said rather than left to be noticed: clearing is
     invisible, and silently discarding a value is the bug this form was
     changed for. */
  const lastAgent = useRef(draft.agent);
  const [dropped, setDropped] = useState<{ account: boolean; settings: number } | null>(null);
  useEffect(() => {
    if (lastAgent.current !== undefined && lastAgent.current !== draft.agent) {
      if (draft.agent === null) {
        setDropped({
          account: !!draft.account,
          settings: Object.values(draft.settings ?? {}).filter((v) => v != null).length,
        });
      } else {
        setDropped(null);
      }
      set("settings", {});
    }
    lastAgent.current = draft.agent;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.agent]);

  return (
    <>
      {/* **One sentence under the group, about the option actually chosen.**
          Each pill used to carry its own counterfactual — *leave it open and
          the lead decides* — on all three, whether or not it was open. The
          thing a reader cannot see is different in the two states: left open,
          who picks; pinned, that it is a default rather than a pin. */}
      <Group
        label="Where children work"
        hint={
          (draft.placement ?? "lead") === "lead"
            ? "The lead chooses the workspace when it delegates."
            : "A team or a lead can override this."
        }
      >
        <div className="pickrow">
          {PLACEMENTS.map((p) => (
            <button
              key={p.value}
              type="button"
              aria-pressed={(draft.placement ?? "lead") === p.value}
              onClick={() => setPlacement(p.value)}
              className="pk"
            >
              <span className="ic">
                <Icon of={p.icon} size={16} />
              </span>
              {p.label}
              {(draft.placement ?? "lead") === p.value && (
                <span className="tick">
                  <Icon of={Check} size={14} />
                </span>
              )}
            </button>
          ))}
        </div>
      </Group>

      {/* Shown whenever the child *could* get a workspace of its own, and
          hidden only on *Same workspace* — the one case where a machine can
          never apply. */}
      {draft.placement !== "here" && (
        <Group
          label="Machine"
          /* Nothing on *Its own workspace*: the list is the drawing, and the
             open row at the top of it says what happens when nothing is
             pinned. The other branch keeps its sentence, because *this field
             may never be reached* is not visible from the field. */
          hint={
            draft.placement === "new"
              ? undefined
              : "Only reached if the lead gives it a workspace of its own."
          }
        >
          {machineRows.length > 0 ? (
            <>
              <div className="pickrows">
                <button
                  type="button"
                  aria-pressed={(draft.machine ?? null) === null}
                  onClick={() => set("machine", null)}
                  className="pr2"
                >
                  <span className="g">
                    <Icon of={CircleDashed} size={16} />
                  </span>
                  <span className="tx">
                    <b>{OPEN}</b>
                  </span>
                  {(draft.machine ?? null) === null && (
                    <span className="g tick">
                      <Icon of={Check} size={14} />
                    </span>
                  )}
                </button>
                {machineRows.map((m) => {
                  const ok = runsThere(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={draft.machine === m.id}
                      data-off={ok === false ? "true" : undefined}
                      onClick={() => set("machine", m.id)}
                      className="pr2"
                    >
                      <span className="g">
                        <Icon of={Server} size={16} />
                      </span>
                      <span className="tx">
                        <b>{m.label}</b>
                        <s>{m.says}</s>
                      </span>
                      {/* Marked rather than hidden, as every other picker
                          marks it: gone from a list looks like gone. */}
                      {ok === false && (
                        <span className="why">
                          {AGENT_LABEL[draft.agent as Agent] ?? draft.agent} is not installed there
                        </span>
                      )}
                      {draft.machine === m.id && (
                        <span className="g tick">
                          <Icon of={Check} size={14} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {draft.agent === null && (
                <div className="inform">
                  <p>
                    Whether a machine can run an engine depends on which engine, and this profile
                    leaves that open. The lead is told at launch, not here.
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="inform">
              <p>
                <b>No machines yet.</b> Agents run on a machine you add over SSH.
              </p>
            </div>
          )}
        </Group>
      )}

      {/* **A requirement, drawn as a choice somebody made.**
          *Any* in a value column is indistinguishable from a field nobody
          filled in, and on a pill row the open answer was the heaviest thing
          on the tab for a profile that had not decided anything. In a menu
          *Any engine* is an option beside Claude Code and Codex: the same
          fact, visibly chosen. The field was never the problem. */}
      <Group label="Engine" hint="Set this only if the instructions depend on one.">
        <Select
          ariaLabel="Engine"
          value={draft.agent ?? null}
          options={[
            {
              value: null,
              icon: <Icon of={CircleDashed} size={16} />,
              label: ANY_ENGINE,
            },
            ...agentOptions,
          ]}
          onChange={(v) => set("agent", v)}
        />
      </Group>

      {/* Not *How it runs*, which is the tab this group is on: a heading that
          repeats its own tab is a heading saying nothing. These are the
          engine's own dials, and that is what names them. */}
      {controls.length > 0 && (
        <Group label="Model and settings">
          <div className="flex flex-col gap-3">
            {controls.map((c) => {
              const Mark = CONTROL_ICON[c.kind];
              const options: Opt[] = [
                {
                  value: null,
                  icon: <Icon of={Mark} size={16} />,
                  label: "Engine default",
                  note: "Whatever the agent starts on.",
                },
                ...c.choices.map((ch) => ({
                  value: ch.value,
                  icon: <Icon of={Mark} size={16} />,
                  label: ch.label,
                  note: ch.note ?? undefined,
                })),
              ];
              return (
                <div key={c.kind} className="flex flex-col gap-1.5">
                  <span className="text-micro font-medium text-mute">{c.fallback}</span>
                  <Select
                    ariaLabel={c.fallback}
                    value={draft.settings?.[c.kind] ?? null}
                    options={options}
                    onChange={(v) => setSetting(c.kind, v)}
                  />
                </div>
              );
            })}
          </div>
        </Group>
      )}

      {/* A subscription belongs to one engine, so with the engine open there
          is nothing this field could hold. */}
      {draft.agent !== null && (
        <Group label="Subscription">
          {connected ? (
            <div className="pickrow">
              {accountOptions.map((o) => (
                <button
                  key={o.value ?? "__default"}
                  type="button"
                  aria-pressed={(draft.account ?? null) === o.value}
                  onClick={() => set("account", o.value)}
                  className="pk"
                >
                  <span className="ic">{o.icon}</span>
                  {o.label}
                  {o.note && <span className="sub">{o.note}</span>}
                  {(draft.account ?? null) === o.value && (
                    <span className="tick">
                      <Icon of={Check} size={14} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="inform">
              <p>
                No subscription for{" "}
                {AGENT_LABEL[draft.agent as Agent] ?? draft.agent} is connected, so this runs on
                whichever one its owner has when it launches.
              </p>
            </div>
          )}
        </Group>
      )}

      {dropped && (
        <div className="inform">
          <p>
            A pinned subscription and a model belong to one engine, so leaving the engine open
            cleared{" "}
            {[
              dropped.account ? "the subscription" : null,
              dropped.settings ? `${dropped.settings} run setting${dropped.settings === 1 ? "" : "s"}` : null,
            ]
              .filter(Boolean)
              .join(" and ")}
            .
          </p>
        </div>
      )}

      <Group
        label="If it reaches usage limit"
        hint="The lead must be allowed this too."
      >
        <div className="ladder">
          {ON_LIMIT.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={(draft.onUsageLimit ?? "wait") === o.value}
              onClick={() => set("onUsageLimit", o.value)}
              className="pk"
            >
              <span className="ic">
                <Icon of={o.icon} size={16} />
              </span>
              <span className="tx">
                {o.label}
                {o.note && <span className="sub">{o.note}</span>}
              </span>
              {(draft.onUsageLimit ?? "wait") === o.value && (
                <span className="tick">
                  <Icon of={Check} size={14} />
                </span>
              )}
            </button>
          ))}
        </div>
        {draft.onUsageLimit === "same" && (
          <WhereTo className="aside">
            Nothing about what the child may <i>do</i> changes: same engine, same permissions. Only
            whose allowance pays for the rest of it.
          </WhereTo>
        )}
        {draft.onUsageLimit === "engine" && (
          <WhereTo className="aside">
            Choosing this <b>is</b> the acknowledgement that a different engine brings its own
            default permissions. Given here, once, instead of at the moment somebody is waiting.
          </WhereTo>
        )}
      </Group>

      {/* One sentence reading the three fields back as what a spawn gets. The
          bug behind all of this is a lead reporting a build that never
          happened; a form that says what a spawn will be is the cheapest
          guard there is. */}
      <WhereTo>{whatAChildGets(draft, machineRows)}</WhereTo>
    </>
  );
}

/* ── In teams ────────────────────────────────────────────────────────────── */

/**
 * Where it sits, team by team, and what is under it in each.
 *
 * The answer to *is this the same Designer* — yes, and here is each position.
 * Each row is a destination: pressing it opens that team's map with that card
 * selected.
 *
 * **Teams own delegation.** A profile's own `canDelegate`, `delegateScope` and
 * `onChildLimit` are still live for a session occupying no position, and #497
 * is what removes them — but they have no control here any more. A toggle that
 * says a profile hands work off, sitting next to the teams that actually decide
 * it, is read as the thing that decides it. The fields are still written on
 * every save, so a profile that already carries reach keeps carrying it; what
 * is gone is the way to set one from this window.
 */
export function InTeams({
  role,
  places,
  loading,
  here,
  onGoToSeat,
}: {
  role: Role;
  places: ProfilePosition[];
  loading: boolean;
  here: string | null;
  onGoToSeat?: (team: string, position: string) => void;
}) {
  return (
    <>
      <p className="dlede">
        {loading
          ? "Reading where it sits…"
          : places.length === 0
            ? "No team holds a position for this profile yet."
            : `One profile, ${count(places.length, "position")}. Each team decides what sits under it.`}
      </p>

      {places.length === 0 && !loading ? (
        <Note icon={Network}>
          Open a team and press <b>+</b> on a card to give this profile a position there.
        </Note>
      ) : (
        <div className="places">
          {places.map((p) => (
            <button
              key={p.position}
              type="button"
              data-here={p.position === here || undefined}
              onClick={() => onGoToSeat?.(p.team, p.position)}
              disabled={!onGoToSeat}
              className="place"
            >
              <span className="ph">
                <b>{p.teamName}</b>
                {p.leads && <Badge>leads it</Badge>}
                {p.position === here && <Badge tone="sage">this position</Badge>}
                {onGoToSeat && (
                  <span className="g">
                    <Icon of={ChevronRight} size={14} />
                  </span>
                )}
              </span>
              <span className="ptree">
                {p.reportsTo && (
                  <span className="pr up">
                    <Icon of={CornerUpLeft} size={12} />
                    {p.reportsTo}
                  </span>
                )}
                <span className="pr self">
                  {role.name}
                  {p.instructions.trim() && <em>{clip(p.instructions.trim(), 46)}</em>}
                </span>
                {p.under.length > 0 ? (
                  p.under.map((k) => (
                    <span key={k} className="pr kid">
                      <Icon of={CornerDownRight} size={12} />
                      {k}
                    </span>
                  ))
                ) : (
                  <span className="pr none">Nothing under it here</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/* ── A reading ───────────────────────────────────────────────────────────── */

/**
 * A profile somebody may read and not change.
 *
 * **The facts, as text. No fields, no Save, nothing greyed out.** A form with
 * a Save the server would refuse does not look withheld until after you have
 * written something. The line at the foot reads the boundary as a boundary
 * rather than as a refusal, which is the move People and Teams make too.
 *
 * Where it sits is here as well, because a reader who cannot change a profile
 * can still need to know which teams depend on it.
 */
function Reading({
  role,
  places,
  seat,
}: {
  role: Role;
  places: ProfilePosition[];
  seat?: SeatHandle | null;
}) {
  const place =
    role.placement === "new"
      ? "a workspace of its own"
      : role.placement === "here"
        ? "the lead's workspace"
        : "wherever the lead decides";
  const agent = role.agent as Agent | null;

  return (
    <>
      <div className="dbody scroll-slim">
        <p className="dlede">{role.does}</p>
        <div className="dread">
          <Reads label="Runs in">{place}</Reads>
          <Reads label="Engine">
            {agent ? (
              <span className="inline-flex items-center gap-1.5">
                <AgentMark agent={agent} size={12} className="text-dim" />
                {AGENT_LABEL[agent]}
              </span>
            ) : (
              "whichever the lead is running"
            )}
          </Reads>
          <Reads label="Skills it loads">{loadsWhat(role)}</Reads>
          <Reads label="In teams">
            {places.length === 0
              ? "no team holds a position for it"
              : [...new Set(places.map((p) => p.teamName))].join(", ")}
          </Reads>
          {role.instructions.trim() && (
            <Reads label="Instructions">
              <span className="block whitespace-pre-wrap text-text">
                {role.instructions.trim()}
              </span>
            </Reads>
          )}
          {seat && (
            <Reads label={`In ${seat.teamName}, as well`}>
              {seat.instructions.trim() ? (
                <span className="block whitespace-pre-wrap text-text">
                  {seat.instructions.trim()}
                </span>
              ) : (
                "nothing extra"
              )}
            </Reads>
          )}
        </div>
      </div>
      <p className="dfoot">
        <span className="msg quiet">
          <Icon of={Eye} size={12} />
          <span>
            Changed by whoever owns <span className="font-mono">{role.path}</span>.
          </span>
        </span>
      </p>
    </>
  );
}

/** One fact and its name, the shape the panes read facts in. */
function Reads({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-[8rem] shrink-0 text-ui text-dim">{label}</span>
      <span className="min-w-0 flex-1 text-ui text-bone">{children}</span>
    </div>
  );
}

/**
 * What a profile loads, for somebody who cannot open it.
 *
 * The sources rather than a number, because the number is per viewer:
 * `skill_defaults` is keyed on `user_id`, so a profile shared through a
 * directory resolves against whoever starts it. Carried across from the
 * reading it replaces, unchanged.
 */
function loadsWhat(role: Role): string {
  const parts: string[] = [];
  if (role.includeAlwaysOn) parts.push("your always-on set");
  if (role.includeRepoDefaults) parts.push("this repository's defaults");
  const named = role.skillScope.length;
  if (named > 0) parts.push(`${named} named`);
  if (parts.length === 0) return "nothing — both sources are off and nothing is named";
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/* ── Deleting ────────────────────────────────────────────────────────────── */

/**
 * A profile that sits nowhere.
 *
 * One spelling, so a read that has not arrived and a read that failed look
 * the same to `Blast` as a profile genuinely in no team — and none of the
 * three can be an array that quietly has no `withheld` on it.
 */
export const EMPTY_PLACES: ProfilePlaces = { places: [], withheld: 0 };

/**
 * What a delete takes with it, before it is pressed.
 *
 * **The same pattern the map card's destructive control establishes**: state
 * the blast radius, with the count, where the press is. The teams are not on
 * screen, so each one is named and says how many positions it loses — and a
 * team this profile leads says that instead, because deleting the lead takes
 * the whole tree and leaves the team with nothing.
 *
 * **And it may not assert a fact about teams it did not read.** Deleting a
 * profile cascades onto every team in the organisation; the list here is
 * filtered to what this person can see, as every read is. *No team holds a
 * position for it* was therefore a claim about rows nobody had looked at, and
 * false in the one direction that matters — the ordinary case is sharing a
 * profile into a directory and somebody building a team of their own around
 * it. So the server sends the count of what it withheld beside the list, and
 * the shape is said without the names: the same rule a withheld member name
 * on the map follows.
 *
 * Exported for `profile-drawer.test.tsx`, which renders it on its own: whether
 * a confirmation names every team is the one thing here worth a test that
 * needs no server.
 */
/**
 * **What a delete takes, in teams this person cannot see**, as a sentence.
 *
 * Its own function for the reason `pausedBySave` is: the singular is the half
 * that goes silently wrong, and *1 positions in teams you cannot see* is the
 * whole of what this exists to stop.
 *
 * `alsoNamed` is whether anything was named above it, which decides whether
 * this is a share of a total already stated or the whole of it.
 */
export function withheldLine(withheld: number, alsoNamed: boolean): string | null {
  if (withheld <= 0) return null;
  const which = alsoNamed
    ? withheld === 1
      ? "One of them is"
      : `${withheld} of them are`
    : withheld === 1
      ? "It is"
      : "They are";
  const where = withheld === 1 ? "a team you cannot see" : "teams you cannot see";
  const them = withheld === 1 ? "it" : "them";
  return `${which} in ${where}. There is nothing here that can name ${them}.`;
}

export function Blast({ name, used }: { name: string; used: ProfilePlaces }) {
  const withheld = Math.max(0, used.withheld ?? 0);
  const seen = used.places ?? [];

  if (seen.length === 0 && withheld === 0) {
    return (
      <p>
        You can no longer start a workspace as {name}. No team holds a position for it. Agents
        already running are untouched.
      </p>
    );
  }

  const byTeam = new Map<string, { name: string; takes: number; leads: boolean }>();
  for (const p of seen) {
    const at = byTeam.get(p.team) ?? { name: p.teamName, takes: 0, leads: false };
    byTeam.set(p.team, {
      name: p.teamName,
      takes: at.takes + p.takes,
      leads: at.leads || p.leads,
    });
  }
  const teams = [...byTeam.values()].sort((a, b) => a.name.localeCompare(b.name));
  /* **One total, stated once, and every number under it is a share of it.**
     Both halves were already inclusive — `ProfilePosition.takes` is a seat
     and its subtree, and `ProfilePlaces.withheld` is the same walk over the
     teams that were filtered out — and both were followed by *and everything
     under them*, which reads as more to come. A reader braced for more than
     the number said. So the subtree is named where the total is, as what the
     total already counts, and the rows beneath add up to it. */
  const named = teams.reduce((n, t) => n + t.takes, 0);
  const total = named + withheld;

  return (
    <>
      <p>
        This removes {count(total, "position")} in all — the seats {name} holds, and everything
        reporting under them.
      </p>
      {teams.length > 0 && (
        <ul className="takes">
          {teams.map((t) => (
            <li key={t.name}>
              <b>{t.name}</b>
              <span>
                {t.leads
                  ? `loses its lead and all ${count(t.takes, "position")}`
                  : `loses ${count(t.takes, "position")}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {withheld > 0 && <p>{withheldLine(withheld, teams.length > 0)}</p>}
      <p>Agents already running are untouched. They keep the profile they started with.</p>
    </>
  );
}

/* ── Small readings ─────────────────────────────────────────────────────── */

/**
 * Which fields of the stored profile the draft no longer agrees with.
 *
 * Derived rather than logged, which is #492's rule for the map's pending
 * count and is right here for the same reason: typing a character and deleting
 * it again leaves nothing to save, and an edit log says two changes.
 */
export function diffOf(role: Role, draft: Settled): string[] {
  const stored = toDraft(role);
  return (Object.keys(stored) as (keyof Settled)[]).filter((k) => {
    const a = stored[k];
    const b = draft[k];
    if (Array.isArray(a) || Array.isArray(b)) {
      return JSON.stringify([...((a as string[]) ?? [])].sort()) !==
        JSON.stringify([...((b as string[]) ?? [])].sort());
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      return JSON.stringify(a) !== JSON.stringify(b);
    }
    return (a ?? null) !== (b ?? null);
  });
}

/**
 * How far a change reaches, as a clause.
 *
 * One team is not worth a clause — the drawer is the only thing on screen and
 * nothing is hidden from view. Two or more is the whole reason the band above
 * exists, and this is the same fact at the moment of pressing.
 */
function reaching(teams: number): string {
  if (teams <= 1) return "";
  return `, in ${teams === 2 ? "both teams" : `all ${teams} teams`} that use it`;
}

/**
 * What a save will do, said before it is pressed.
 *
 * **The count and how far it goes, and nothing else.** *Will save … to the
 * profile* spent four words on what the button beside it says and what the
 * pane somebody is looking at is.
 */
export function willSave(fields: number, teams: number): string {
  if (teams <= 1) return `${count(fields, "change")}.`;
  return `${count(fields, "change")}, in ${
    teams === 2 ? "both teams" : `all ${teams} teams`
  } using this profile.`;
}

/**
 * What leaving would cost, for the question `LeaveSheet` asks.
 *
 * The map's `describeChanges` counts the cards that would go, because that is
 * what leaving a tree costs; a profile's cost is the fields, and how far they
 * would have reached. Same voice, different unit.
 */
export function notSaved(fields: number, teams: number): string {
  if (fields === 0) return "Nothing is saved yet.";
  return `Not saved yet: ${count(fields, "change")} to the profile${reaching(teams)}.`;
}

/** `1 position` / `4 positions`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Whole words, then an ellipsis. Nothing is cut mid-word. */
function clip(text: string, at: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= at) return one;
  return `${one.slice(0, one.lastIndexOf(" ", at)).trim()}…`;
}

/* ── The form primitives, as the pane draws them ────────────────────────── */

/** A labelled input, with its hint **above** the control. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="fld">
      <span>{label}</span>
      {hint && <span className="hint">{hint}</span>}
      {children}
    </label>
  );
}

/**
 * Field, for a group of buttons rather than one input.
 *
 * A `label` around a set of buttons hands every click to the first one, which
 * is wrong for a picker where each tile is its own control.
 *
 * `beside` is the one control that belongs to the group rather than to what
 * is in it — *Open editor* next to *Instructions*. It sits on the heading's
 * own line, which is the only line in a field that is the same height
 * whatever the field holds.
 */
function Group({
  label,
  hint,
  beside,
  children,
}: {
  label: string;
  hint?: string;
  beside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="fld">
      {beside ? (
        <span className="flex items-center gap-2">
          <span className="flex-1">{label}</span>
          {beside}
        </span>
      ) : (
        <span>{label}</span>
      )}
      {hint && <span className="hint">{hint}</span>}
      {children}
    </div>
  );
}

/** One option in a {@link Select}: what it is worth, and how it reads. */
type Opt = { value: string | null; icon: ReactNode; label: string; note?: string };

/** A dropdown that shows a mark, not just a word. Moved from the old form. */
function Select({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string | null;
  options: Opt[];
  onChange: (v: string | null) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  if (!current) {
    return (
      <div className="flex w-full items-center rounded-md border border-line bg-ground px-3 py-2 text-ui text-mute">
        —
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        onClick={(e) => setOpen(open ? null : e.currentTarget)}
        className="flex w-full items-center gap-2.5 rounded-md border border-line bg-ground px-3 py-2 text-left transition-colors hover:border-dim focus:border-dim focus:outline-none"
      >
        <span className="shrink-0 text-dim">{current.icon}</span>
        <span className="min-w-0 flex-1 truncate text-ui text-bone">{current.label}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-mute transition-transform ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      {open && (
        <Pop anchor={open} onClose={() => setOpen(null)} width={open.offsetWidth}>
          <div role="listbox" className="max-h-72 min-h-0 overflow-y-auto py-1">
            {options.map((o) => {
              const on = o.value === value;
              return (
                <button
                  key={o.value ?? "__open"}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(null);
                  }}
                  className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-raise"
                >
                  <span className={`mt-px shrink-0 ${on ? "text-bone" : "text-dim"}`}>
                    {o.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-ui text-bone">{o.label}</span>
                    {o.note && <span className="block text-micro text-mute">{o.note}</span>}
                  </span>
                  <Check
                    className={`mt-px h-4 w-4 shrink-0 ${on ? "text-slate" : "text-transparent"}`}
                    strokeWidth={2.5}
                  />
                </button>
              );
            })}
          </div>
        </Pop>
      )}
    </>
  );
}

/* Re-exported rather than re-derived. A screen that writes a team has made
   this drawer's reading of *where a profile sits* stale, and there is one key
   for that reading. */
export { getRolePositionsQueryKey };

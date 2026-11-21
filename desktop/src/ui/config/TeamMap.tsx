/**
 * One team's organigramme, and the draft it is edited as.
 *
 * **The map writes a draft and Save is the only commit.** Adding, removing
 * and re-parenting change a tree held in this component; the pending group in
 * the action row says how many changes are waiting, and Discard is an
 * assignment back to what the server answered — which is how a removed
 * subtree comes back whole, because the tree it was in was never touched.
 *
 * The arrangement is **Hybrid**, and `team-map.ts` holds the geometry, the
 * diff and the reason for both. Nothing in here measures anything.
 *
 * ## What else is legible here, and why it is here
 *
 * Three facts belong to other tickets and have nowhere else to appear:
 *
 * - **A save pauses the schedules that pin this team** (#493). Said beside
 *   Save, before the commit, in #493's own words — `schedules/Pinned.tsx` is
 *   theirs and is mounted here unchanged, because one fact wants one wording.
 * - **A seat can arrive without anybody placing it** (#491), during the
 *   compatibility window. The mitigation for a team that grows on its own is
 *   that those seats are visible, so they are marked and there is a way to
 *   step through them.
 * - **A seat whose profile the reader cannot see is still drawn** (#490),
 *   without its name. The shape of the tree belongs to the team; the name
 *   belongs to the profile.
 *
 * `team-elsewhere.ts` reads the first two off responses this screen already
 * fetches, so none of them costs a request.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Plus, SquarePen, Trash2, UserRoundPlus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAgentTeamQueryKey,
  getListAgentTeamsQueryKey,
  updateAgentTeam,
  useAgentTeamLimits,
  useGetAgentTeam,
} from "~/api/generated/agent-teams/agent-teams";
import { createRole, getListRolesQueryKey, useListRoles } from "~/api/generated/roles/roles";
import type { Position, Role } from "~/api/generated/model";
import { trouble, useSkills, why } from "~/data";
import { useLeaveGuard } from "~/shims/next-navigation";
import { Button, Icon } from "~/components/ui";
import { Note, Trouble, WhereTo } from "~/ui/config/bits";
import {
  EngineMark,
  LeaveSheet,
  NewProfileSheet,
  ProfilePicker,
  Sheet,
  blankProfile,
} from "~/ui/config/TeamSheet";
import { SchedulesPinned } from "~/ui/schedules/Pinned";
import { arrivedOnItsOwn, schedulesPinning } from "~/ui/config/team-elsewhere";
import {
  CARD_W,
  addChild,
  changes,
  chipRows,
  couldReportTo,
  countUnder,
  depthOf,
  find,
  flatten,
  fromPositions,
  layout,
  lineage,
  moveSeat,
  parentKeyOf,
  removeSeat,
  say,
  seatTag,
  toNewPosition,
  type Card,
  type Change,
  type Seat,
} from "~/ui/config/team-map";
import {
  ProfileDrawer,
  WithRail,
  getRolePositionsQueryKey,
  type SeatHandle,
} from "~/ui/config/ProfileDrawer";

/**
 * What a card hands to whatever opens beside it.
 *
 * #494's drawer opens from here, and what it needs is the seat rather than
 * the profile: which team, which position, and which profile that position
 * references. `position` is null for a seat the map has drawn and not saved —
 * there is no row to read instructions off yet, which the drawer has to know
 * rather than guess from a missing id.
 */
export type OpenedSeat = {
  team: string;
  position: string | null;
  /** The map's own key, so the caller can say which card to keep selected. */
  key: string;
  profile: string;
};

export function TeamMap({
  id,
  at,
  onClose,
  onOpenSeat,
  onGoToSeat,
}: {
  id: string;
  /**
   * A position in this team to open, named by the address.
   *
   * A link from the drawer's *In teams* tab carries it, so landing here from
   * the library opens the card rather than the tree it is in. A seat's key is
   * its id once it is saved, which is what makes this a selection rather than
   * a search.
   */
  at?: string | null;
  onClose: () => void;
  /** Where a card opens. Absent until #494 docks something beside the map. */
  onOpenSeat?: (seat: OpenedSeat) => void;
  /** Where a row of the drawer's *In teams* tab goes. */
  onGoToSeat?: (team: string, position: string) => void;
}) {
  const cache = useQueryClient();
  const feed = useGetAgentTeam(id);
  const roles = useListRoles();
  const skills = useSkills();
  const limits = useAgentTeamLimits();
  const team = feed.data;

  /* ── The draft, and what it is being compared against ─────────────────
     Both seeded from the same answer. `seen` is what the draft was seeded
     from, so a refetch that brings something new re-seeds and a refetch that
     brings the same thing leaves a draft in progress alone. */
  const [original, setOriginal] = useState<Seat | null>(null);
  const [draft, setDraft] = useState<Seat | null>(null);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!team) return;
    const at = `${team.updatedAt}/${team.positions.length}`;
    if (seen.current === at) return;
    seen.current = at;
    const tree = fromPositions(team.positions);
    setOriginal(tree);
    setDraft(tree);
  }, [team]);

  /**
   * The seat the address named, opened once the tree it is in has arrived.
   *
   * Once per address rather than on every draft: re-running it would reopen
   * the card after somebody closed the drawer, and would fight a selection
   * they made themselves.
   */
  const landed = useRef<string | null>(null);
  useEffect(() => {
    if (!at || !draft || landed.current === at) return;
    if (!find(draft, at)) return;
    landed.current = at;
    setSelected(at);
    setDrawer(at);
  }, [at, draft]);

  /** Off by default: a map opens showing the team. */
  const [showSkills, setShowSkills] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [making, setMaking] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** Which auto-added seat the review is on, or -1 before it has started. */
  const [reviewing, setReviewing] = useState(-1);
  /** Where somebody was going when the draft stopped them. */
  const [leaving, setLeaving] = useState<{ resume: () => void } | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  /**
   * The seat the drawer is holding, by this window's own key.
   *
   * **The drawer is mounted here rather than above**, because a position's
   * fields are the draft's: its instructions and who it reports to are edited
   * in the drawer and committed by this screen's Save. A drawer above the map
   * would need the tree lifted out of it, and the tree is what makes Save the
   * only commit. `onOpenSeat` is still called, so a caller that wants to
   * follow along — an address carrying the open card, later — still can.
   */
  const [drawer, setDrawer] = useState<string | null>(null);
  /** The drawer asked to let go, when it may be holding an unsaved profile. */
  const [drawerWant, setDrawerWant] = useState<{ to: string | null } | null>(null);
  /** How much of the pane the drawer is taking, or 0 when it is not docked. */
  const [beside, setBeside] = useState(0);

  /* ── What the cards read from ─────────────────────────────────────── */

  const byProfile = useMemo(
    () => new Map(roles.data?.map((r) => [r.id, r]) ?? []),
    [roles.data],
  );
  /** The seat rows, by id, for what a `Seat` deliberately does not carry. */
  const bySeat = useMemo(
    () => new Map((team?.positions ?? []).map((p) => [p.id, p])),
    [team],
  );
  /** A profile's pinned skills, by name, sorted. Empty when nothing is pinned. */
  const pinned = useMemo(() => {
    const names = new Map(skills.data.map((s) => [s.id, s.name]));
    const out = new Map<string, string[]>();
    for (const r of roles.data ?? []) {
      out.set(
        r.id,
        r.skillScope.map((s) => names.get(s)).filter((n): n is string => !!n).sort(),
      );
    }
    return out;
  }, [roles.data, skills.data]);

  const laid = useMemo(
    () => layout(draft, showSkills ? pinned : undefined),
    [draft, showSkills, pinned],
  );
  const pending = useMemo(() => changes(original, draft), [original, draft]);
  const automatic = useMemo(
    () => laid.cards.filter((c) => c.seat.id && arrivedOnItsOwn(bySeat.get(c.seat.id))),
    [laid, bySeat],
  );

  /**
   * **Leaving with a draft asks.**
   *
   * Save being the only commit is the whole promise of this screen, and a
   * surface that drops unsaved work on the way out breaks it quietly — which
   * is the one failure a commit boundary must not have. Every way out of here
   * goes through `navigate`: the back link, a rail row, a palette command.
   */
  useLeaveGuard((resume) => {
    if (pending.length === 0 || saving) return false;
    setLeaving({ resume });
    return true;
  });

  /**
   * The name on a card, or nothing when the profile is out of reach.
   *
   * **The server decides, and this does not look for a second opinion.** A
   * saved seat answers with `profileName` or deliberately without it, and
   * falling back to the profile list for a name the team read withheld would
   * undo the withholding wherever the two lists disagree. A seat the map has
   * just drawn has no row to ask, and its profile came out of a list this
   * person can see, so that one reads from the library.
   */
  const nameOf = (seat: Seat) =>
    (seat.id ? bySeat.get(seat.id)?.profileName : byProfile.get(seat.profile)?.name) ?? null;

  /* ── Editing ──────────────────────────────────────────────────────── */

  const put = (parentKey: string, profile: string) => {
    setDraft((d) => (d ? addChild(d, parentKey, profile) : d));
    setAdding(null);
    setMaking(null);
  };

  const take = (key: string) => {
    setDraft((d) => (d ? removeSeat(d, key) : d));
    if (selected === key) setSelected(null);
    if (drawer === key) setDrawer(null);
  };

  /* The two edits the drawer makes to this draft. Both are drafts like
     everything else: they join the pending count and Discard puts them back. */
  const brief = (key: string, text: string) =>
    setDraft((d) => (d ? say(d, key, text) : d));
  const reparent = (key: string, parentKey: string) =>
    setDraft((d) => (d ? moveSeat(d, key, parentKey) : d));

  /**
   * Put the tree back.
   *
   * **It does not close the drawer**, which it used to: the tree and the
   * profile the drawer is editing are different objects with different
   * commit boundaries, and closing one to discard the other threw away an
   * unsaved profile without a word. A seat that only existed in the draft
   * goes with it, and the rail unmounts on its own because there is no longer
   * a seat for it to hold.
   */
  const discard = () => {
    setDraft(original);
    setProblem(null);
    setSelected(null);
  };

  const save = async (): Promise<boolean> => {
    if (!team || !draft || saving) return false;
    setSaving(true);
    setProblem(null);
    try {
      await updateAgentTeam(id, { name: team.name, lead: toNewPosition(draft) });
      await Promise.all([
        cache.invalidateQueries({ queryKey: getGetAgentTeamQueryKey(id) }),
        cache.invalidateQueries({ queryKey: getListAgentTeamsQueryKey() }),
        /* The drawer's *In teams* tab reads where each profile sits, and a
           save has just changed that for every profile in this tree. */
        ...flatten(draft).map((s) =>
          cache.invalidateQueries({ queryKey: getRolePositionsQueryKey(s.profile) }),
        ),
      ]);
      /* The refetch re-seeds both, because its ids are the ones a second save
         has to carry back. Until it lands, what is on screen is what was
         sent, so nothing flickers. */
      seen.current = null;
      return true;
    } catch (e) {
      setProblem(why(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** Go after all, without being asked again. */
  const andGo = () => {
    const go = leaving?.resume;
    setLeaving(null);
    go?.();
  };

  /** Make a profile and put it straight under the card that asked for one. */
  const makeProfile = async (name: string, does: string) => {
    const made = await createRole(blankProfile(name, does));
    await cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
    if (making) put(making, made.id);
  };

  /** Step to the next seat nobody placed, and bring it into view. */
  const reviewNext = () => {
    if (!automatic.length) return;
    const at = (reviewing + 1) % automatic.length;
    setReviewing(at);
    open(automatic[at]);
  };

  /**
   * Open a card, and keep it on screen.
   *
   * The scroll is why this is one function rather than two call sites: a card
   * near the right edge falls behind whatever docks beside the map, and an
   * open card nobody can see is the same as no card open.
   */
  const open = (card: Card) => {
    setSelected(card.seat.key);
    /* A drawer already holding a seat may be holding an unsaved profile with
       it, so it is asked rather than swapped. */
    if (drawer && drawer !== card.seat.key) setDrawerWant({ to: card.seat.key });
    else setDrawer(card.seat.key);
    onOpenSeat?.({
      team: id,
      position: card.seat.id,
      key: card.seat.key,
      profile: card.seat.profile,
    });
  };

  /** Open a seat by key, which for a saved one is its position id. */
  const openKey = (key: string) => {
    const card = laid.cards.find((c) => c.seat.key === key);
    if (card) open(card);
  };

  /**
   * Keep the open card on screen, **after** the drawer has taken its width.
   *
   * This was written in the press handler, where it could only read the
   * canvas as it was *before* the drawer narrowed it: a card near the right
   * edge was scrolled clear of nothing and then hidden. It belongs in a
   * layout effect keyed on the card and on the width beside it, which is also
   * what makes dragging the drawer wider keep the card visible.
   */
  useLayoutEffect(() => {
    const box = surface.current;
    const card = laid.cards.find((c) => c.seat.key === selected);
    if (!box || !card) return;
    const right = card.x + CARD_W + 24;
    if (right > box.scrollLeft + box.clientWidth) box.scrollLeft = right - box.clientWidth;
    if (card.x < box.scrollLeft) box.scrollLeft = Math.max(0, card.x - 24);
    const below = card.y + card.h + 24;
    if (below > box.scrollTop + box.clientHeight) box.scrollTop = below - box.clientHeight;
    if (card.y < box.scrollTop) box.scrollTop = Math.max(0, card.y - 24);
  }, [selected, laid, beside]);

  /* ── Drawing ──────────────────────────────────────────────────────── */

  if (feed.isLoading || !team) {
    /* Through `trouble`, so a team somebody may not see says that rather than
       offering a Try again that will say the same thing. The same three
       answers every list on this pane gives. */
    const bad = feed.error ? (trouble(feed.error) ?? "error") : null;
    return (
      <section data-wide className="pcol">
        <Back onClose={onClose} />
        {bad ? (
          <Trouble
            kind={bad}
            error={why(feed.error)}
            onRetry={bad === "error" ? () => void feed.refetch() : undefined}
          />
        ) : (
          <p className="mt-6 text-ui text-dim">Reading the team…</p>
        )}
      </section>
    );
  }

  const seats = flatten(draft);
  const paused = schedulesPinning(team);
  const atMost = limits.data;
  const may = team.mayWrite;

  /**
   * What the drawer edits, derived from the draft.
   *
   * Derived rather than held, for the reason everything else on this screen
   * is: the tree is the one piece of state, and a copy of a seat's
   * instructions beside it would be a second answer to what this seat says.
   */
  const held = drawer ? find(draft, drawer) : null;
  const handle: SeatHandle | null =
    held && drawer
      ? {
          team: id,
          teamName: team.name,
          position: held.id,
          key: drawer,
          instructions: held.instructions,
          leads: draft?.key === drawer,
          under: parentKeyOf(draft, drawer),
          underName: (() => {
            const key = parentKeyOf(draft, drawer);
            const above = key ? find(draft, key) : null;
            return above ? (nameOf(above) ?? above.profile) : null;
          })(),
          /* Not itself and not anything below it — the model refuses both,
             and offering a press that does nothing is worse than not
             offering it. **Where it already reports is in the list and
             pressed**, so the control reads as a picker with a current
             answer rather than a row of equal choices.

             Two seats of one profile are told apart the way the map tells
             them apart: by what each one says. Without that the picker is
             two buttons reading *Reviewer* and no way to choose between
             them. */
          elsewhere: distinguish(
            couldReportTo(draft, drawer).map((s) => ({
              key: s.key,
              name: nameOf(s) ?? s.profile,
              says: s.instructions.trim().replace(/\s+/g, " "),
            })),
          ),
          mayWrite: may,
          onInstructions: (text) => brief(drawer, text),
          onReparent: (parentKey) => reparent(drawer, parentKey),
        }
      : null;

  return (
    <WithRail
      onDismiss={() => setDrawerWant({ to: null })}
      rail={
        held && handle
          ? (band, width) => (
              <Beside width={band === "dock" ? width : 0} onWidth={setBeside}>
                <ProfileDrawer
                  key={drawer}
                  profile={held.profile}
                  seat={handle}
                  want={drawerWant ?? undefined}
                  /* **The name the team read, not the one the library holds.**
                     A seat whose profile this reader cannot see keeps its
                     place and loses its name, and the drawer reads a profile
                     *by id* — so without this it would fetch back exactly
                     what the team declined to give. #492 fixed this once on
                     the card; a tab with a profile object to hand is how it
                     gets back in. */
                  withheld={!nameOf(held)}
                  /* A seat in **this** team is a selection rather than a
                     navigation: the map is already on screen and the card is
                     already drawn, so it opens rather than reloading the pane
                     it is in. */
                  onGoToSeat={(team, position) =>
                    team === id ? openKey(position) : onGoToSeat?.(team, position)
                  }
                  onClose={(to) => {
                    setDrawerWant(null);
                    setDrawer(to ?? null);
                  }}
                />
              </Beside>
            )
          : null
      }
    >
    <section data-wide className="pcol">
      <Back onClose={onClose} />
      <div className="pg-head mt-3">
        <div>
          <h1>{team.name}</h1>
          <p className="sub">
            {leadLine(draft, nameOf)}
            {may && " Press + on a card to put a profile under it."}
          </p>
        </div>
      </div>

      {!may && (
        <WhereTo>
          You can read this team, not change it. It is filed at{" "}
          <span className="font-mono">{team.path}</span>, and whoever holds that decides.
        </WhereTo>
      )}

      {/* Seats nobody placed. Quiet, and with a way to look at each one —
          keeping or removing it is the selection and the trash that are
          already on the card. */}
      {automatic.length > 0 && (
        <div className="mt-4">
          <Note
            icon={UserRoundPlus}
            control={
              <button onClick={reviewNext} className="btn quiet">
                {reviewing < 0 ? "Show them" : "Show the next"}
              </button>
            }
          >
            {automatic.length === 1
              ? "One position was added automatically, when this team handed work to a profile with no seat here. "
              : `${automatic.length} positions were added automatically, when this team handed work to profiles with no seat here. `}
            Check each one, then keep it or take it out.
            {reviewing >= 0 && ` Showing ${reviewing + 1} of ${automatic.length}.`}
          </Note>
        </div>
      )}

      {/* ── The action row ───────────────────────────────────────────
          One row at `--row-tight`, every control at the desk's single
          control height. There is no status strip in this window, and if
          there were it would be 22px of chrome holding counts and a
          sentence: a 30px control does not fit in it. */}
      <div className="mapbar">
        <button
          type="button"
          role="switch"
          aria-checked={showSkills}
          onClick={() => setShowSkills((v) => !v)}
          className="swrow"
        >
          <span className="lane">
            <span className="knob" />
          </span>
          <span>Show each agent’s skills</span>
        </button>
        {/* Facts, as separate spans with honest spacing rather than a meta
            string joined with middle dots. `STYLE.md` names that habit. */}
        <span className="mm">{count(seats.length, "position")}</span>
        <span className="mm">{depthOf(draft)} deep</span>
        <span className="mm">
          {laid.width} × {laid.height}
        </span>
        {laid.repeats > 0 && (
          <span className="mm">{count(laid.repeats, "profile")} in more than one position</span>
        )}
        {/* `min-w-0` rather than `flex-none`: the drawer docks beside this
            pane and takes 370px with it, and a group that refuses to shrink
            clipped the schedules notice at the drawer's edge instead of
            wrapping its sentence. */}
        <span className="ml-auto flex min-w-0 items-center gap-3">
          {/* **Whenever the map is open, not once something has been
              edited.** The whole point is that it is read before anybody
              decides to change anything — `schedules/Pinned.tsx` says so,
              and owns the sentence.

              **For somebody who could save, and nobody else.** It is a
              consequence-of-saving notice, so beside a Save a reader cannot
              press it says nothing useful — and the number is counted across
              every owner, which is right for whoever is about to stop them
              and is other people's unattended work to anybody else.
              `AgentTeam.schedules` is zero for a reader now, so this is the
              belt to that braces and the two agree. */}
          <SchedulesPinned count={paused} mayWrite={may} />
          {pending.length > 0 && (
            <span className="pend" role="status">
              <span className="n">
                <Icon of={SquarePen} size={12} />
                {pending.length} unsaved
              </span>
              <Button variant="quiet" size="sm" onClick={discard} disabled={saving}>
                Discard
              </Button>
              <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : "Save team"}
              </Button>
            </span>
          )}
        </span>
      </div>

      {problem && (
        <p className="mt-2 text-meta text-brick">{problem} Nothing was written.</p>
      )}

      <div ref={surface} className="mapsurface">
        {seats.length === 0 ? (
          <p className="px-6 py-10 text-ui text-dim">
            This team has no positions. The profile that led it was deleted, which took the
            tree with it.
          </p>
        ) : (
          <div
            className="mapplane"
            style={{ width: `${laid.width}px`, height: `${laid.height}px` }}
          >
            {laid.rules.map((r, i) => (
              <span
                key={i}
                className={r.w === 1 ? "vr" : "hr"}
                style={{ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` }}
              />
            ))}
            {laid.cards.map((card) => (
              <MapCard
                key={card.seat.key}
                card={card}
                seat={card.seat.id ? bySeat.get(card.seat.id) : undefined}
                role={byProfile.get(card.seat.profile)}
                name={nameOf(card.seat)}
                skills={showSkills ? (pinned.get(card.seat.profile) ?? []) : []}
                selected={selected === card.seat.key}
                mayWrite={may}
                onOpen={() => open(card)}
                onAdd={() => setAdding(card.seat.key)}
                onRemove={() => take(card.seat.key)}
              />
            ))}
          </div>
        )}
      </div>

      <WhereTo>
        Save writes this team and nothing else. A profile’s own name, description, instructions
        and skills are the same in every team, and are changed from <b>Agent profiles</b>.
      </WhereTo>

      {adding && draft && (
        <AddUnder
          parent={find(draft, adding)}
          draft={draft}
          profiles={roles.data ?? []}
          nameOf={nameOf}
          positions={seats.length}
          limits={atMost}
          onPick={(profile) => put(adding, profile)}
          onMake={() => {
            setMaking(adding);
            setAdding(null);
          }}
          onClose={() => setAdding(null)}
        />
      )}

      {making && draft && (
        <NewProfileSheet
          under={under(draft, making, nameOf)}
          onClose={() => setMaking(null)}
          onCreate={makeProfile}
        />
      )}

      {/* **The question, in one place.** `LeaveSheet` is this sheet, moved
          into `TeamSheet.tsx` so the profile drawer asks it in the same
          words rather than in its own. */}
      {leaving && (
        <LeaveSheet
          what={team.name}
          says={`${describeChanges(pending)} The map is showing them until you decide.`}
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
    </section>
    </WithRail>
  );
}

/**
 * What is waiting, in the words of what was done rather than a bare number.
 *
 * *2 changes* says nothing about whether leaving would cost a subtree, and
 * that is the thing somebody is deciding.
 */
export function describeChanges(pending: Change[]): string {
  const added = pending.filter((c) => c.kind === "add").length;
  const removed = pending.filter((c) => c.kind === "remove");
  const moved = pending.filter((c) => c.kind === "move").length;
  const gone = removed.reduce((n, c) => n + 1 + c.under, 0);
  const parts: string[] = [];
  if (added) parts.push(added === 1 ? "one position added" : `${added} positions added`);
  if (removed.length) parts.push(gone === 1 ? "one taken out" : `${gone} taken out`);
  if (moved) parts.push(moved === 1 ? "one moved" : `${moved} moved`);
  const reworded = pending.filter((c) => c.kind === "said").length;
  if (reworded) parts.push(reworded === 1 ? "one reworded" : `${reworded} reworded`);
  if (!parts.length) return "Nothing is saved yet.";
  const said =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Not saved yet: ${said}.`;
}

/**
 * The drawer, with the width it took reported back to the map.
 *
 * The rail is drawn from a render function, which cannot hold an effect, and
 * the map needs the number: an open card has to be scrolled clear of whatever
 * is beside it, and *whatever is beside it* is this. One component, one
 * effect, and the layout effect above gets something to key on.
 */
function Beside({
  width,
  onWidth,
  children,
}: {
  width: number;
  onWidth: (w: number) => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    onWidth(width);
    return () => onWidth(0);
  }, [width, onWidth]);
  return <>{children}</>;
}

/* ── The card ────────────────────────────────────────────────────────────── */

/**
 * One position.
 *
 * The card is the thing that opens; the two controls on it are buttons of
 * their own, which is why it is a `div` with a role rather than a button with
 * buttons inside it.
 *
 * Exported for `team-card.test.tsx`, which renders it on its own: what the
 * destructive control says before it is pressed, and whether a keyboard can
 * get to it at all, are the two things on this screen worth a test that does
 * not need a server.
 *
 * **Both controls appear on hover and on focus.** The card carries the only
 * route to either, and a control a mouse can reach and a keyboard cannot is
 * one half of this screen being unusable.
 */
export function MapCard({
  card,
  seat,
  role,
  name,
  skills,
  selected,
  mayWrite,
  onOpen,
  onAdd,
  onRemove,
}: {
  card: Card;
  seat: Position | undefined;
  role: Role | undefined;
  name: string | null;
  skills: string[];
  selected: boolean;
  mayWrite: boolean;
  onOpen: () => void;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const under = countUnder(card.seat);
  const kids = card.seat.children.length;
  const brief = card.seat.instructions.trim().replace(/\s+/g, " ");
  const withheld = !name;
  /* Nothing of the profile is drawn when its name was withheld — not its
     engine, not what it does. Those belong to the profile too, and reading
     them out of the library would hand back half of what the team read
     deliberately kept. */
  const of = withheld ? undefined : role;
  const auto = arrivedOnItsOwn(seat);
  const rows = skills.length ? chipRows(skills) : [];
  const label = name ?? card.seat.profile;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      data-lead={card.depth === 0}
      data-on={selected}
      data-auto={auto}
      data-pending={!card.seat.id}
      data-withheld={withheld}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      title={describe(label, of, brief, skills, withheld, auto)}
      style={{
        left: `${card.x}px`,
        top: `${card.y}px`,
        width: `${card.w}px`,
        height: `${card.h}px`,
      }}
      className="oc"
    >
      <span className="seat">
        <span className="g">
          <EngineMark role={of} size={12} />
        </span>
        <span className="nm">{label}</span>
        {auto && (
          <span className="auto" aria-hidden>
            <Icon of={UserRoundPlus} size={12} />
          </span>
        )}
        {kids > 0 && (
          <span className="cnt" title={`${count(kids, "profile")} directly under it here`}>
            {kids}
          </span>
        )}
      </span>

      {/* The line that tells two positions of one profile apart. Not a name
          somebody typed — the thing that actually makes them different. */}
      {brief && <span className="brf">{brief}</span>}

      {rows.length > 0 && (
        <span className="pins">
          {rows.map((row, i) => (
            <span key={i} className="pinrow">
              {row.map((chip) => (
                <span key={chip} className={chip.startsWith("+") ? "pin more" : "pin"}>
                  {chip}
                </span>
              ))}
            </span>
          ))}
        </span>
      )}

      {mayWrite && (
        <button
          type="button"
          className="plus"
          aria-label={`Put a profile under ${label}`}
          title={`Put a profile under ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
        >
          <Icon of={Plus} size={12} />
        </button>
      )}

      {/* The lead has none: removing it would remove the team, which is done
          from the list. */}
      {mayWrite && card.depth > 0 && (
        <button
          type="button"
          className="bin"
          aria-label={removal(label, under)}
          title={removal(label, under)}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Icon of={Trash2} size={12} />
        </button>
      )}
    </div>
  );
}

/** What the destructive control says **before** it is pressed. */
export function removal(name: string, under: number): string {
  if (under === 0) return `Take ${name} out of this team`;
  if (under === 1) return `Take ${name} and the one under it out of this team`;
  return `Take ${name} and the ${under} under it out of this team`;
}

/** The whole of a card, for a pointer that rests on it. */
function describe(
  name: string,
  role: Role | undefined,
  brief: string,
  skills: string[],
  withheld: boolean,
  auto: boolean,
): string {
  const lines = [
    withheld
      ? `${name}. You cannot see this profile. Its seat is in the team; its name and description are filed somewhere you cannot reach.`
      : `${name}. ${role?.does ?? ""}`,
  ];
  if (brief) lines.push(`In this team: ${brief}`);
  if (skills.length) lines.push(`Skills: ${skills.join(", ")}`);
  if (auto) lines.push("Added automatically, when work was handed to it. Keep it, or take it out.");
  return lines.join("\n\n").trim();
}

/* ── Putting a profile under a card ──────────────────────────────────────── */

function AddUnder({
  parent,
  draft,
  profiles,
  nameOf,
  positions,
  limits,
  onPick,
  onMake,
  onClose,
}: {
  parent: Seat | null;
  draft: Seat;
  profiles: Role[];
  nameOf: (seat: Seat) => string | null;
  positions: number;
  limits: { maxDepth: number; maxPositions: number } | undefined;
  onPick: (profile: string) => void;
  onMake: () => void;
  onClose: () => void;
}) {
  if (!parent) return null;
  const parentName = nameOf(parent) ?? parent.profile;

  /* Refused here rather than after a round trip, which is what the limits
     endpoint exists for. Both are stated as the number, because "too deep"
     without it is not something anybody can act on. */
  const here = levelOf(draft, parent.key);
  const refusal = !limits
    ? null
    : positions >= limits.maxPositions
      ? `This team holds ${limits.maxPositions} positions, which is the most one can hold. Take one out to add another.`
      : here >= limits.maxDepth
        ? `A team goes ${limits.maxDepth} levels deep, counting the lead, and ${parentName} is on the last one. Put this profile under something higher up.`
        : null;

  /* The two rules a tree on screen already decides — said on the row rather
     than hidden from it, and both of them blocking. `seatTag` is the whole
     of it, and says why neither is left pickable. */
  const already = parent.children.map((c) => c.profile);
  const above = lineage(draft, parent.key);

  return (
    <Sheet
      title={`Add a profile under ${parentName}`}
      onClose={onClose}
      foot={
        <>
          <span className="msg" />
          <Button variant="default" onClick={onClose}>
            {refusal ? "Close" : "Cancel"}
          </Button>
        </>
      }
    >
      {refusal ? (
        <p className="max-w-[60ch] py-2 text-body leading-relaxed text-text">{refusal}</p>
      ) : (
        <ProfilePicker
          profiles={profiles}
          onPick={onPick}
          onMake={onMake}
          makeLabel="Create a profile for this seat"
          tag={(p) => seatTag(p.id, already, above)}
        />
      )}
    </Sheet>
  );
}

/* ── Small readings ──────────────────────────────────────────────────────── */

/** Which level a seat is on, counting the lead as one. */
function levelOf(root: Seat, key: string): number {
  const walk = (s: Seat, at: number): number | null => {
    if (s.key === key) return at;
    for (const k of s.children) {
      const found = walk(k, at + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(root, 1) ?? 1;
}

/** What a new profile would sit under, by name. */
function under(
  draft: Seat,
  key: string,
  nameOf: (seat: Seat) => string | null,
): string | undefined {
  const seat = find(draft, key);
  return (seat && nameOf(seat)) ?? undefined;
}

function leadLine(draft: Seat | null, nameOf: (seat: Seat) => string | null): string {
  if (!draft) return "This team holds no positions.";
  const name = nameOf(draft);
  return name ? `Led by ${name}.` : "Led by a profile you cannot see.";
}

/**
 * Seats of the same profile, told apart by what each of them says.
 *
 * A name is only a name here: the Product team has two Load tester seats and
 * a picker offering *Load tester* twice is a picker nobody can answer. The
 * map draws the seat's own instruction as its second line for exactly this
 * reason, so the picker borrows the same fact — and a seat that carries
 * nothing says so, because the two really are alike and pretending otherwise
 * would be inventing a difference.
 *
 * Only where there is a clash: a name that appears once is left alone.
 */
export function distinguish(
  seats: { key: string; name: string; says: string }[],
): { key: string; name: string }[] {
  const seen = new Map<string, number>();
  for (const s of seats) seen.set(s.name, (seen.get(s.name) ?? 0) + 1);
  return seats.map((s) => ({
    key: s.key,
    name:
      (seen.get(s.name) ?? 0) > 1
        ? `${s.name} — ${s.says || "nothing extra said"}`
        : s.name,
  }));
}

/** `1 position` / `4 positions`. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function Back({ onClose }: { onClose: () => void }) {
  return (
    <button
      onClick={onClose}
      className="flex items-center gap-1 text-meta text-mute hover:text-bone"
    >
      <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
      All agent teams
    </button>
  );
}

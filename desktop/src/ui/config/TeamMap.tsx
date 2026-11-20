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
 *   Save, before the commit.
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
import { useEffect, useMemo, useRef, useState } from "react";
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
import { useSkills, why } from "~/data";
import { Button, Icon } from "~/components/ui";
import { Note, Trouble, WhereTo } from "~/ui/config/bits";
import {
  EngineMark,
  NewProfileSheet,
  ProfilePicker,
  Sheet,
  blankProfile,
} from "~/ui/config/TeamSheet";
import { SchedulesPaused } from "~/ui/config/SchedulesPaused";
import { arrivedOnItsOwn, schedulesPinning } from "~/ui/config/team-elsewhere";
import {
  CARD_W,
  addChild,
  changes,
  chipRows,
  countUnder,
  depthOf,
  find,
  flatten,
  fromPositions,
  layout,
  removeSeat,
  toNewPosition,
  type Card,
  type Seat,
} from "~/ui/config/team-map";

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
  onClose,
  onOpenSeat,
}: {
  id: string;
  onClose: () => void;
  /** Where a card opens. Absent until #494 docks something beside the map. */
  onOpenSeat?: (seat: OpenedSeat) => void;
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

  /** Off by default: a map opens showing the team. */
  const [showSkills, setShowSkills] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [making, setMaking] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** Which auto-added seat the review is on, or -1 before it has started. */
  const [reviewing, setReviewing] = useState(-1);
  const surface = useRef<HTMLDivElement>(null);

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
  };

  const discard = () => {
    setDraft(original);
    setProblem(null);
    setSelected(null);
  };

  const save = async () => {
    if (!team || !draft || saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await updateAgentTeam(id, { name: team.name, lead: toNewPosition(draft) });
      await Promise.all([
        cache.invalidateQueries({ queryKey: getGetAgentTeamQueryKey(id) }),
        cache.invalidateQueries({ queryKey: getListAgentTeamsQueryKey() }),
      ]);
      /* The refetch re-seeds both, because its ids are the ones a second save
         has to carry back. Until it lands, what is on screen is what was
         sent, so nothing flickers. */
      seen.current = null;
    } catch (e) {
      setProblem(why(e));
    } finally {
      setSaving(false);
    }
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
    onOpenSeat?.({
      team: id,
      position: card.seat.id,
      key: card.seat.key,
      profile: card.seat.profile,
    });
    const box = surface.current;
    if (!box) return;
    const right = card.x + CARD_W + 24;
    if (right > box.scrollLeft + box.clientWidth) box.scrollLeft = right - box.clientWidth;
    if (card.x < box.scrollLeft) box.scrollLeft = Math.max(0, card.x - 24);
    const below = card.y + card.h + 24;
    if (below > box.scrollTop + box.clientHeight) box.scrollTop = below - box.clientHeight;
    if (card.y < box.scrollTop) box.scrollTop = Math.max(0, card.y - 24);
  };

  /* ── Drawing ──────────────────────────────────────────────────────── */

  if (feed.isLoading || !team) {
    return (
      <section data-wide className="pcol">
        <Back onClose={onClose} />
        {feed.error ? (
          <Trouble kind="error" error={why(feed.error)} onRetry={() => void feed.refetch()} />
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

  return (
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
          You can read this team and not change it. Whoever it is filed under decides;{" "}
          <span className="font-mono">{team.path}</span> is where it lives.
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
              ? "One position was added automatically, by a hand-off to a profile with no seat here. "
              : `${automatic.length} positions were added automatically, by hand-offs to profiles with no seat here. `}
            Keep each one, or take it out.
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
        {pending.length > 0 && (
          <span className="pend" role="status">
            <span className="n">
              <Icon of={SquarePen} size={12} />
              {pending.length} unsaved
            </span>
            <SchedulesPaused count={paused} />
            <Button variant="quiet" size="sm" onClick={discard} disabled={saving}>
              Discard
            </Button>
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save team"}
            </Button>
          </span>
        )}
      </div>

      {problem && (
        <p className="mt-2 text-meta text-brick">{problem} Nothing was written.</p>
      )}

      <div ref={surface} className="mapsurface">
        {seats.length === 0 ? (
          <p className="px-6 py-10 text-ui text-dim">
            This team holds no positions. Its lead’s profile was deleted, and naming a lead is
            what repairs it.
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
    </section>
  );
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
  const lines = [withheld ? `${name}. You cannot see this profile.` : `${name}. ${role?.does ?? ""}`];
  if (brief) lines.push(`In this team: ${brief}`);
  if (skills.length) lines.push(`Skills: ${skills.join(", ")}`);
  if (auto) lines.push("Added automatically by a hand-off. Keep it, or take it out.");
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
        ? `A team goes ${limits.maxDepth} levels deep, counting the lead, and ${parentName} is on the last one. A hand-off goes down one level each time, so this is also how long a chain of agents can get.`
        : null;

  /* One profile at most once among one position's children: a lead hands
     work off by name, and two seats of one profile would be a name that does
     not say which is meant. Said on the row rather than hidden from it. */
  const already = new Set(parent.children.map((c) => c.profile));
  const above = new Set(lineage(draft, parent.key));

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
          tag={(p) =>
            already.has(p.id)
              ? { says: "already reports here", blocked: true }
              : above.has(p.id)
                ? { says: "also above this card" }
                : null
          }
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

/** Every profile from this seat up to the lead. */
function lineage(root: Seat, key: string): string[] {
  const walk = (s: Seat, trail: string[]): string[] | null => {
    const here = [...trail, s.profile];
    if (s.key === key) return here;
    for (const k of s.children) {
      const found = walk(k, here);
      if (found) return found;
    }
    return null;
  };
  return walk(root, []) ?? [];
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

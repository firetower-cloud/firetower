/**
 * A profile as a draft: what it holds, the words it uses for "not decided",
 * and the sentence that reads three fields back as one.
 *
 * All of it moved out of `Roles.tsx` unchanged when the full-page editor
 * became the drawer. It is here because the pane, the drawer and three tests
 * all read it, and the pane and the drawer import each other's screens — one
 * neutral module is what stops that being a cycle. **Nothing in this file was
 * rewritten in the move**; the arguments in the comments are the ones that
 * were already won.
 */
import type { ReactNode } from "react";
import {
  Box,
  Clock,
  Cpu,
  CircleDashed,
  Gauge,
  GitBranch,
  GitBranchPlus,
  KeyRound,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { AGENT_LABEL } from "~/components/AgentMark";
import { usable, type Account } from "~/api/accounts";
import type { Agent, ControlKind, NewRole, Role } from "~/api/generated/model";

/**
 * One phrase for one idea, in all three fields that have it.
 *
 * Placement, Machine and Engine each say the same thing when they say nothing,
 * so they say it in the same words and wear the same mark — a dashed ring
 * (`CircleDashed`), because colour is spent and ember means an agent is waiting
 * on you. Three wordings for one state would unmake the idea that it is one.
 */
export const OPEN = "Let the lead choose";

/**
 * What happens when nobody chooses, said on the open pill rather than in the
 * field's hint.
 *
 * Both halves, likelier branch first. In a hint it would read as a default the
 * profile sets, which is the one thing a profile must not have: a field here is
 * a commitment or a question, never a default something else may outrank.
 */
export const OPEN_FALLBACK = {
  placement: "here, unless the lead says otherwise",
  machine: "Firetower picks, unless the lead names one",
  agent: "the lead's own, unless it names another",
};

/**
 * Where a child runs. **Three, and the open one first.**
 *
 * A third was added here once before and taken back out, and the reason is
 * worth keeping: it was reasoned from `Role.placement`, documented as
 * `lead | here | new`, which is the **response** model. `roles.rs` enforced
 * `PLACEMENT: [&str; 2] = ["here", "new"]` on the way in, and the effect below
 * coerced any unknown placement back to `here` on every render — so pressing
 * *Let the lead choose* snapped the selection straight back to *Same
 * workspace*. A pill that cannot stay pressed is a button that does not work,
 * which is exactly how it was reported. **A value in a response model is not an
 * option in a request model.**
 *
 * What makes it work this time is that the server takes it: `PLACEMENT` now
 * carries all three, `check()` accepts an absent engine and an absent machine,
 * and the coercing effect is gone from this file. The order is the drawing's
 * (`desktop-redesign.html:4447`) and the order every field here repeats: the
 * open answer first, wearing the open mark, and the commitments after it.
 */
export const PLACEMENTS: { value: string; icon: LucideIcon; label: string; note: string }[] = [
  { value: "lead", icon: CircleDashed, label: OPEN, note: OPEN_FALLBACK.placement },
  { value: "here", icon: GitBranch, label: "Same workspace", note: "shares the lead's branch" },
  { value: "new", icon: GitBranchPlus, label: "Its own workspace", note: "a fresh branch" },
];

/**
 * What a lead may do about a child of this profile that has run out, in order
 * of how much latitude each grants.
 *
 * **Three rungs and no dashed ring.** The two-state rule governs one axis —
 * who decides a value, the profile or the lead — and on that axis a middle is
 * a lie. This field is not on it: none of the three means "not decided", so
 * none of them is *Let the lead choose*. A profile that says to wait has
 * decided, firmly. *How it runs* two fields above already grades three ways
 * for the same reason, and the strings are the owner's own.
 */
export const ON_LIMIT: { value: string; icon: LucideIcon; label: string; note?: string }[] = [
  { value: "wait", icon: Clock, label: "Wait for human action" },
  {
    value: "same",
    icon: KeyRound,
    label: "Let the lead pick another subscription",
    note: "If the agent runs on Claude Code, it won't pick a subscription on Codex",
  },
  {
    value: "engine",
    icon: RefreshCw,
    label: "Let the lead pick another subscription and engine",
    note: "For example, allow to switch from Codex to Claude Code",
  },
];

/** And the Manager's own half: whether it spends that latitude or asks first. */
export const ON_CHILD_LIMIT: { value: string; icon: LucideIcon; label: string; note: string }[] = [
  { value: "reroute", icon: RefreshCw, label: "Re-route it", note: "picks one and carries on" },
  {
    value: "ask",
    icon: MessageSquare,
    label: "Ask me first",
    note: "stops and puts the choice to you",
  },
];

/** A mark for each run control, so its picker reads like the others. */
export const CONTROL_ICON: Record<ControlKind, LucideIcon> = {
  model: Cpu,
  effort: Gauge,
  mode: ShieldCheck,
  sandbox: Box,
};

/**
 * An empty profile, for a new one. An Operator until made a Manager, and
 * **open on all three** — the drawing's own default
 * (`desktop-redesign.html:4414`), and the honest one: a new profile has not
 * decided where it runs, and two effects used to decide for it by force-picking
 * the first engine and the first machine on the list.
 */
export const BLANK: Settled = {
  name: "",
  does: "",
  placement: "lead",
  agent: null,
  machine: null,
  account: null,
  settings: {},
  instructions: "",
  /* Today's behaviour, both of them — a new profile grants no latitude over
     its children and a new Manager asks before it spends anybody's allowance.
     Sent rather than left off, for the reason the two switches below are: an
     absent field means "leave it as it is", which on a profile that does not
     exist is the same answer, but the form draws these and a draft that
     omitted them would draw one thing and save another. */
  onUsageLimit: "wait",
  onChildLimit: "ask",
  canDelegate: false,
  delegateScope: [],
  skillScope: [],
  // Both on, which is what the column defaults to and what makes a new
  // profile load the owner's usual set rather than nothing. Sent explicitly
  // rather than left off: absent tells the server to leave them as they are,
  // which on a profile that does not exist yet is the same answer — but the
  // two switches are what this screen draws, and a draft that omitted them
  // would draw them off while saving them on.
  includeAlwaysOn: true,
  includeRepoDefaults: true,
  directory: null,
};

/**
 * A draft with both inheritance switches stated as a plain boolean.
 *
 * `boolean | null | undefined` on `NewRole`, because the API takes all three
 * and reads the absent two as *leave whatever is stored alone* — a sound
 * answer for a client that has never heard of these fields, and the wrong one
 * for this editor, which draws a switch per field and has nothing to draw for
 * "no opinion". It drew them **off**, for profiles that load four.
 *
 * So a draft has to have decided. Spelt as an intersection rather than
 * `Required<Pick<…>>`, which would leave `null` in: both of these are
 * questions with two answers by the time they reach a screen. `Settled` is
 * assignable to `NewRole` wherever one is wanted, so this narrows what a draft
 * promises without widening what anything reading one has to handle.
 */
export type Settled = NewRole & { includeAlwaysOn: boolean; includeRepoDefaults: boolean };

/**
 * A profile as the form that edits it.
 *
 * Exported because Compute's notice about a removed machine unpins a profile
 * that pointed at it, and `update_role` takes the whole object: sending a
 * partial one would quietly blank every field it left out.
 *
 * **That hazard fired.** The two inheritance switches were added to `Role` and
 * to `NewRole` and not to here, so every existing profile opened with both off
 * — "It loads no skills from Firetower", over a button offering to save it that
 * way — and `Machines.tsx` sent the same gap with nobody at the keyboard. The
 * fields were optional on `NewRole`, so nothing failed. `role-draft.test.ts`
 * is what makes the next one fail instead of ship: it walks a `Role` whose
 * every field is enumerated by the type checker and insists each one is either
 * carried here or named as deliberately dropped.
 */
export function toDraft(r: Role): Settled {
  return {
    name: r.name,
    does: r.does,
    placement: r.placement,
    agent: r.agent ?? null,
    machine: r.machine ?? null,
    account: r.account ?? null,
    settings: r.settings ?? {},
    instructions: r.instructions,
    onUsageLimit: r.onUsageLimit,
    onChildLimit: r.onChildLimit,
    canDelegate: r.canDelegate,
    delegateScope: r.delegateScope ?? [],
    skillScope: r.skillScope ?? [],
    includeAlwaysOn: r.includeAlwaysOn,
    includeRepoDefaults: r.includeRepoDefaults,
    directory: null,
  };
}

/**
 * Fields of a `Role` that `toDraft` deliberately does not carry, and why.
 *
 * The server owns every one of them: four are identity or timestamps, two are
 * the answers to "may I" that the request is checked against rather than told,
 * `isDefault` is set by its own endpoint so that setting one profile's can
 * unset another's, and `key` is written only by an import adopting the folder
 * name a bundle came from — an editor that could change it would be an editor
 * that can make one file describe a different profile. Exported for
 * `role-draft.test.ts`, which treats anything absent from a draft and absent
 * from here as a field somebody forgot.
 */
export const SERVER_OWNED = [
  "id",
  "path",
  "key",
  "createdAt",
  "updatedAt",
  "mayWrite",
  "mayShare",
  "isDefault",
] as const satisfies readonly (keyof Role)[];

/**
 * The three fields read back as one sentence: what a child actually gets.
 *
 * Open on all three is its own sentence rather than three clauses of "whatever
 * the lead asks for", which is the same fact said three times.
 *
 * **The short branch still carries the grant.** It once returned before
 * `recovery` was consulted, so a profile that had just been given a rung of
 * *If it reaches usage limit* read back as though it had not — on the shape
 * every new profile opens in, which makes it the common case rather than an
 * edge. The three open fields and the grant are different facts: one is what
 * the lead decides, the other is what the lead may later do, and leaving all
 * three open says nothing about the second.
 */
export function whatAChildGets(
  draft: NewRole,
  machines: { id: string; label: string }[],
): ReactNode {
  const open = draft.placement === "lead" && !draft.machine && !draft.agent;
  if (open)
    return (
      <>
        A child gets whatever the lead asks for: <b>its workspace, its machine, its engine</b>
        {recovery(draft)}.
      </>
    );
  const place =
    draft.placement === "here"
      ? "the lead's own workspace"
      : draft.placement === "new"
        ? "a workspace of its own"
        : "whichever workspace the lead asks for";
  const machine =
    draft.placement === "here"
      ? ""
      : machines.length === 0
        ? ", on the first machine you add"
        : draft.machine
          ? `, on ${machines.find((m) => m.id === draft.machine)?.label ?? "a pinned machine"}`
          : ", on a machine the lead names or Firetower picks";
  const engine = draft.agent
    ? `, running ${AGENT_LABEL[draft.agent as Agent] ?? draft.agent}`
    : ", running the engine the lead names";
  return (
    <>
      A child gets <b>{place + machine + engine}</b>
      {recovery(draft)}.
    </>
  );
}

/**
 * And what happens if that child runs out of allowance, as a clause of the
 * same sentence.
 *
 * A clause rather than a sentence of its own, and appended rather than
 * replacing what is already read back: the three things a child *gets* and
 * the one thing that may later be *done about it* are one fact about one
 * spawn, and the form's own reason for saying any of it is that a lead
 * reporting work that never happened is this whole area's bug.
 *
 * `wait` adds nothing. It is what every profile does and what the sentence
 * has always implied by saying nothing, so spending a clause on it would make
 * the common shape read as the exceptional one.
 */
function recovery(draft: NewRole): string {
  const engine = draft.agent ? (AGENT_LABEL[draft.agent as Agent] ?? draft.agent) : null;
  switch (draft.onUsageLimit) {
    case "same":
      return engine
        ? `, and if it runs out its lead may move it to another ${engine} subscription`
        : ", and if it runs out its lead may move it to another subscription for that engine";
    case "engine":
      return ", and if it runs out its lead may move it to another subscription, on another engine if it has to";
    default:
      return "";
  }
}

/**
 * Whether a pinned subscription still fits the engine a draft now names — and
 * so whether the form may drop it.
 *
 * **`answered` is the whole of it.** `useAccounts()` reads `[]` while its query
 * is in flight, so reconciling against the list before it lands finds every pin
 * absent: a profile opened from a cold cache lost a deliberate pick to *Your
 * default*, with nothing said, and Save wrote the loss back. An unanswered list
 * is not an answer and keeps the pin. An *answered* empty one is a real answer
 * — no usable subscription for this engine — and a stale pin still comes off,
 * which is why this reads the query's own state rather than inferring it from
 * the array's length.
 */
export function pinnedAccountFits(
  account: string,
  agent: NewRole["agent"],
  accounts: Account[],
  answered: boolean,
): boolean {
  if (!answered) return true;
  return accounts.some((a) => a.id === account && a.kind === agent && usable(a));

}

/* ── A profile's name, against the directory it is filed in (#489) ─────────

   The three below arrived with the full-page editor and are here for the same
   reason everything else in this file is: the pane, the drawer and their tests
   all read them, and the pane and the drawer import each other's screens.
   Nothing in them was rewritten in the move. `roles-name.test.ts` is their
   test. */

/**
 * The directory something is filed in, off its path: the first two labels.
 *
 * `u/kevin`, `d/platform` — the permission root, which is what "filed in"
 * means (`docs/paths-and-ownership.md` §1) and the scope a profile's name has
 * to be free in (`roles_name_in_directory`).
 */
export function filedIn(path: string): string {
  return path.split("/").slice(0, 2).join("/");
}

/**
 * Whichever profile already has this name where this one would be filed, by
 * the name it carries.
 *
 * **The server is what enforces this** — `roles_name_in_directory`, and the
 * sentences `crate::roles` reads off it — and this is here so that Save is not
 * a button that looks live and comes back refused. The same division
 * `filing.ts` keeps for `mayMove`: one question, asked on both sides, and the
 * two have to agree.
 *
 * `directory` is [`filedIn`] of where it would land, and `null` when that is
 * not known yet — `useMe()` has not answered, so the person's own root cannot
 * be spelled. No opinion rather than a guess: an unanswered query is not an
 * answer (`pinnedAccountFits` says the same about an account list), and the
 * server still refuses what this cannot see.
 *
 * It can only ever name a profile this person already has in front of them,
 * which is the whole reason the rule is scoped to a directory: a check across
 * the installation would have to answer out of rows they cannot see, and "that
 * name is taken" would then be a way to find out what exists in somebody
 * else's space.
 */
export function nameTakenBy(
  name: string,
  directory: string | null,
  self: string | undefined,
  all: Role[],
): string | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted || !directory) return null;
  return (
    all.find(
      (r) =>
        r.id !== self && filedIn(r.path) === directory && r.name.trim().toLowerCase() === wanted,
    )?.name ?? null
  );
}

/**
 * What a taken name says, in the chip language the rest of the app uses.
 *
 * `where` is `yours` or `d/platform` (`filing.ts`), and the two read as
 * different sentences: *you already have one* is the personal case, and the
 * directory is worth naming in the other because somebody else may be the one
 * who filed it there.
 */
export function nameTakenSays(held: string, chip: string): string {
  const clash = "Two profiles filed together can’t share a name.";
  return chip === "yours"
    ? `You already have a profile called “${held}”. ${clash}`
    : `“${held}” is already filed in ${chip}. ${clash}`;
}

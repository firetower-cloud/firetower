/**
 * Who may read what about the organisation, and who may change it.
 *
 * **Every role-dependent decision the Organisation panes take is in here**, as
 * functions over plain data, because this is where the defect would otherwise
 * hide. A rule written at the point a control is drawn is a rule nobody can
 * test and nobody can find again; `filing.ts` learned that from four screens
 * that each worked out `mayMove` for themselves and each got a different
 * answer. Teams reads these rather than keeping its own — `teamActionsFor` and
 * `grantsHeldBy` are at the foot of this file — and the deployment panes are
 * expected to do the same.
 *
 * ## The two ways to list people are not interchangeable
 *
 * | | who may call it | what comes back |
 * |---|---|---|
 * | the `access` tag's colleague list | any signed-in user | a name and an id, and nothing else |
 * | the `organization` tag's user list | **administrators only — a member gets 403** | role, email, and whether they are switched off |
 *
 * The server says why itself, on `Colleague`: *"Deliberately not `User`, which
 * carries a role and whether they are switched off — an administrator's facts
 * about somebody. This is a name and an id, which is all that granting needs,
 * and it is what makes sharing possible for a member."*
 *
 * So **the pane picks its read by role**: an administrator reads the user list
 * and gets the full row, a member reads the colleague list and gets the row
 * that already ships. Building the pane on the administrators-only list and
 * hiding the write controls for everybody else is the defect this exists to
 * avoid — it turns ⌘8 into a 403 for most of the organisation, and the
 * specification is explicit that an empty or forbidden destination *"is a
 * defect, not an access rule"*.
 *
 * Two alternatives were considered and declined. **Relaxing the server** to
 * hand a member a reduced user shape would expose colleagues' emails, roles and
 * switched-off state to everybody: a data-boundary change rather than a
 * refactor, and one that would make the specification's own "no API work is
 * required" false. **Making People administrator-only** is forbidden outright
 * — People is *"visible to every member, read-only for a member"*. Reading two
 * endpoints by role is the only arrangement that keeps both true, which is why
 * this ticket needed no API change at all.
 *
 * `git-hosts.test.tsx` met the same class of defect once already and its
 * conclusion is the one to prefer where it is available: *"`maySetApplication`
 * comes from the server rather than a role read here, so if the rule ever
 * widens nothing in this file has to be found and changed."* There is no such
 * capability flag on the user list — the server states the rule by refusing —
 * so the role is read here, in one place, and the rule is written down beside
 * it.
 */

/** Just enough of the signed-in person. `undefined` while `me` is in flight. */
export type Signed = { id: string; role: string } | null | undefined;

/**
 * Just enough of an account for the rules below.
 *
 * Only ever the administrator's `User`: a `Colleague` has no role and no
 * switched-off state, so a member cannot answer any of these questions and is
 * not asked to.
 */
export type Account = { id: string; role: string; disabled?: boolean };

/** Whether the server will take an organisation-shaped change from them. */
export function mayAdminister(me: Signed): boolean {
  return me?.role === "admin";
}

/**
 * The pane's own control: the way to add somebody.
 *
 * Named separately from `mayAdminister` even though it answers the same thing
 * today, because it is the *pane-level* question and the row-level one is
 * `actionsFor`. A pane that reads the role inline gets two of these subtly out
 * of step — the git hosts pane drew its *Add a host* for everybody while the
 * row correctly refused, which is the same screen telling somebody two
 * different things about the same permission.
 */
export function mayInvite(me: Signed): boolean {
  return mayAdminister(me);
}

/**
 * Which people-read applies, and whether it may be asked for yet.
 *
 * **Both false until the server has said who you are.** A pane that reads a
 * role out of a request still in flight defaults to one of the two answers, and
 * whichever it defaults to is wrong half the time — a member firing the
 * administrators-only list and taking a 403 on the way past is precisely the
 * thing the acceptance criterion *"a member's session makes no request that a
 * member is not permitted to make"* forbids. So neither read is enabled until
 * there is a role to read.
 *
 * Returned as the two flags the query hooks take, rather than as a word the
 * caller then has to translate, because the translation is where the mistake
 * would go.
 */
export function readsFor(me: Signed): { users: boolean; colleagues: boolean } {
  if (!me?.role) return { users: false, colleagues: false };
  const admin = mayAdminister(me);
  return { users: admin, colleagues: !admin };
}

/**
 * How many people can still administer this organisation.
 *
 * **Switched off does not count**, which is the server's own arithmetic
 * (`active_admins`): an administrator who cannot sign in cannot add anybody, so
 * leaving one of those behind locks the room exactly as thoroughly as leaving
 * nobody.
 */
export function administrators(users: Account[]): Account[] {
  return users.filter((u) => u.role === "admin" && !u.disabled);
}

/**
 * Whether a change would leave the organisation with nobody to administer it,
 * and the sentence saying so.
 *
 * **The server owns this rule** — `set_role` and `set_disabled` both refuse
 * with *"<name> is the only administrator"*, inside a transaction that has the
 * row locked, which is the only place the answer can be correct when two
 * administrators are changing things at once. This is the same question asked
 * before a control is drawn, and the two have to agree; the server is what
 * enforces it.
 *
 * It is asked here so that the refusal arrives **as a sentence on the row,
 * before the request is made**, rather than as a round trip that comes back
 * saying no. The control itself is not withheld: changing somebody's role is a
 * thing an administrator may do, and it is this one *choice* that is refused —
 * the same shape as picking a level in Directories, where the menu is always
 * there and one pick can fail.
 *
 * What this cannot do is be certain. The list it reads is a cached answer, so
 * the server refusing anyway — two administrators demoting each other in the
 * same second — is a normal outcome, and the pane shows that sentence in the
 * same place. Belt and braces, and the braces are the server's.
 *
 * **The sentence is in the second person, because it is only ever about you.**
 * This returns non-null only when the single active administrator is the person
 * it is being asked about — and to be offered any of these controls at all you
 * must be an administrator who can sign in, so you are in that count yourself.
 * One active administrator who is somebody else is therefore arithmetically
 * impossible here. It read *"They are the only administrator"* and drew that on
 * the row that also says **you**, which is the one row it can ever appear on.
 *
 * The server says it by name — *"kevin is the only administrator"* — and that
 * is right there, because the server is answering about somebody rather than to
 * them. Where the two sentences differ is whose voice they are in, not what
 * they say, and a stale list is exactly when the server's is the one that shows.
 *
 * `null` means nothing is in the way. A string is the reason, written the way
 * it is read out loud.
 */
export function locksTheRoom(
  users: Account[],
  id: string,
  change: { role?: string; disabled?: boolean },
): string | null {
  const left = administrators(users);
  // Promoting somebody, or switching an administrator back on, can only ever
  // add to the count.
  if (change.role === "admin" || change.disabled === false) return null;
  const losing = change.role !== undefined || change.disabled === true;
  if (!losing) return null;
  if (!left.some((u) => u.id === id)) return null;
  if (left.length > 1) return null;
  return "You are the only administrator, so there would be nobody left to add people or change a role.";
}

/** What a row offers, and what the role beside the name is. */
export type RowActions = {
  /**
   * `menu` — the role is the control, as a `.lvl` menu, the shape Directories
   * already uses for its levels. `null` — the reader was never told it, so
   * there is nothing to draw; a member's colleague list carries no role at
   * all, and an empty space is the honest answer to a fact the server withheld.
   */
  role: "menu" | null;
  /** In the order the row's own menu draws them. */
  menu: ("reset" | "switch-off" | "switch-on" | "remove")[];
};

/**
 * What one row offers, to whom.
 *
 * **Nothing is greyed.** A greyed control is how an interface says you are
 * being withheld from; a control somebody does not have is simply not drawn.
 * So a member's row has no menu and no role, and that is not a thinner version
 * of the administrator's row — it is the whole of what the server will tell a
 * member about a colleague.
 *
 * **Your own row carries the role and nothing else.** The other three are
 * refused on yourself by the server outright, whoever you are and however many
 * administrators there are — *"you cannot switch yourself off"*, *"you cannot
 * remove yourself"*, *"you cannot offboard yourself"* — so they are not drawn.
 * That is not the last-administrator rule and it is not a judgement made here;
 * it is three unconditional refusals, and a control whose every outcome is a
 * refusal is the broken button `filing.ts` opens by describing.
 *
 * Resetting your own password is the one of the four the server does *not*
 * refuse, and it is still not offered: it would end your own sessions and hand
 * you a temporary password to replace, which is what the account screen's
 * *Replace your password* already does properly.
 *
 * **The role on your own row is a menu, though.** Demoting yourself is the
 * handover gesture and the server allows it whenever somebody else
 * administers; when nobody else does, it refuses with *"<name> is the only
 * administrator"* — which is the one way this pane can ask the server to lock
 * the room, and therefore the one place that sentence has to be shown. See
 * `locksTheRoom`, which says it a round trip earlier.
 */
export function actionsFor({
  me,
  person,
}: {
  me: Signed;
  person: Account;
}): RowActions {
  if (!mayAdminister(me)) return { role: null, menu: [] };
  if (person.id === me?.id) return { role: "menu", menu: [] };
  return {
    role: "menu",
    /* Removing is the offboarding confirmation and it destroys what is theirs,
       so it is last and the pane draws a separator above it. */
    menu: ["reset", person.disabled ? "switch-on" : "switch-off", "remove"],
  };
}

/**
 * What each thing a row offers actually asks the server for.
 *
 * **One place, so the question and the request cannot drift apart.** It is the
 * same object `locksTheRoom` is asked about and the same object `change_user`
 * is sent, which is what makes "could this be refused" and "what am I asking
 * for" literally the same value rather than two expressions of it written a
 * hundred lines apart. The administration site builds these inline at four call
 * sites — two of them in a bulk bar — and a role string assembled beside the
 * button is how a screen ends up asking for something its own confirmation did
 * not describe.
 */
export function changeFor(intent: "switch-off" | "switch-on" | Role): {
  role?: string;
  disabled?: boolean;
} {
  switch (intent) {
    case "switch-off":
      return { disabled: true };
    case "switch-on":
      return { disabled: false };
    default:
      return { role: intent };
  }
}

/**
 * What agreeing to somebody going amounts to.
 *
 * **The list of what is destroyed is read back and sent.** The server compares
 * it with what is actually theirs and refuses if they differ, so agreeing to a
 * list means agreeing to *that* list — somebody is still working right up until
 * the moment they are switched off, and a workspace that appeared between the
 * screen drawing and the button being pressed must not be swept up silently.
 *
 * `then` is always `remove` here. Switching somebody off is the row's own menu
 * entry and does not come through this: it takes nothing away, needs no list
 * agreed to, and offering it twice would make the lighter of the two look like
 * part of the heavier.
 */
export function offboardingFor<Kind extends string>(
  owns: { kind: Kind; id: string }[],
  successors: Record<string, { kind: "person" | "team"; id: string }>,
): {
  destroy: { kind: Kind; id: string }[];
  successors: { directory: string; subjectKind: "person" | "team"; subjectId: string }[];
  then: string;
} {
  return {
    destroy: owns.map((o) => ({ kind: o.kind, id: o.id })),
    successors: Object.entries(successors).map(([directory, who]) => ({
      directory,
      subjectKind: who.kind,
      subjectId: who.id,
    })),
    then: "remove",
  };
}

/** The two the server will take. Anything else is somebody else's word. */
export type Role = "member" | "admin";

/** `admin` on the wire; what it is called where somebody reads it. */
export const ROLES: { value: Role; label: string; says: string }[] = [
  {
    value: "member",
    label: "Member",
    says: "Uses Firetower, shares their own work, and cannot change the organisation.",
  },
  {
    value: "admin",
    label: "Administrator",
    says: "Also adds people, defines teams, and can reach a directory nobody administers.",
  },
];

/** What a role is called on screen. `—` for a role nothing recognises. */
export function saidRole(role: string | null | undefined): string {
  return ROLES.find((r) => r.value === role)?.label ?? "—";
}

/**
 * The tags a row wears, in order, and **only when there is something to say**.
 *
 * At rest most rows say nothing: somebody with an address who has signed in and
 * is switched on is the ordinary case and a row reading *Active* spends a tag
 * on it. The administration site drew all four states, which made the column
 * read as a status column where three of the four values meant "fine".
 *
 * **None of them is ember.** The site drew *no email · add one* as an ember
 * link; ember means one thing in this client — something is waiting on you —
 * and a missing address is a fact about an old account, not an agent holding a
 * question. No new hue is introduced either: these are the same quiet pill
 * every other fact on a row wears.
 */
export function tagsFor(person: {
  email?: string | null;
  mustChangePassword?: boolean;
  disabled?: boolean;
}): string[] {
  const tags: string[] = [];
  /* Absent on accounts made before an address was asked for, and never filled
     in with a guess — a placeholder cannot be told apart from a real address
     that bounces. */
  if (!person.email) tags.push("No email yet");
  /* True while the password in use was chosen by somebody else, which is
     exactly "has not got here yet". It clears the first time they replace it. */
  if (person.mustChangePassword) tags.push("Has not signed in");
  if (person.disabled) tags.push("Switched off");
  return tags;
}

/* ── Teams ────────────────────────────────────────────────────────────────
   The straightforward case, and genuinely a different one from People.

   **The team list is readable by anybody**, and so is one team's membership —
   the server says so itself, because granting to a team means choosing one
   from a list and a member who could not read it could not share with one. So
   there is no two-endpoint split here and no read to pick: same data, same
   rows, for everybody, and *only the write controls gate*.

   What gates them is `mayAdminister`, the same function People's row uses, so
   if the rule ever widens there is one place to widen it. Every one of the
   five mutations is `org_admin` on the server. */

/** What one team's row offers, and whether its expander writes. */
export type TeamActions = {
  /**
   * `read` draws the membership as it always has; `write` adds a way in and a
   * way out per row. Not a separate "may edit members" flag, because the
   * expander is one object and a half-writable one would be the greyed control
   * this client does not draw.
   */
  members: "read" | "write";
  /** In the order the row's own menu draws them. */
  menu: ("rename" | "delete")[];
};

/**
 * What a team's row offers, to whom.
 *
 * **The team that is everybody offers nothing, to anybody.** All three of the
 * things a row can do to it are refused by the server outright and by name:
 * *"the team that is everybody cannot be renamed"*, *"the team that is
 * everybody cannot be removed"*, and *"everybody is already in that team"*.
 * Those are not a permission a reader lacks — they are facts about what the
 * team *is*, so nothing is drawn rather than drawn and refused.
 *
 * It already had no expander, for its own reason, written down in `Teams.tsx`:
 * the membership that has to be true is "however many people exist right now",
 * and a team you could open and count would imply somebody could be left out of
 * it. This adds nothing to that and takes nothing from it.
 *
 * A member gets `read` and an empty menu — not a greyed anything. They see
 * every team and everyone in it, because that is what the server tells them.
 */
export function teamActionsFor({
  me,
  team,
}: {
  me: Signed;
  team: { everyone: boolean };
}): TeamActions {
  if (!mayAdminister(me) || team.everyone) return { members: "read", menu: [] };
  return { members: "write", menu: ["rename", "delete"] };
}

/**
 * One directory a team can reach, as the confirmation names it.
 *
 * **No level.** A grant carries one, and the level is deliberately not part of
 * the answer: the decision in front of somebody is *remove this team or not*,
 * and which directories go is what changes it. Saying *Editor on d/platform*
 * would also need the level vocabulary, which `Directories.tsx` owns and this
 * ticket does not touch — a second copy of *writer means Editor* is how two
 * screens come to disagree about a word.
 */
export type HeldGrant = { name: string; slug: string };

/**
 * Which directories a team holds a grant on — **the consequence of deleting
 * it, worked out before it is agreed to**.
 *
 * `delete_team` revokes every grant the team held, by cascade, and that is the
 * whole reason a team is worth having: taking a group's access away is one
 * delete rather than a hunt through every directory somebody thought to share.
 * It is also what makes the delete worth stating first — access handed to
 * several people disappears at once, and nothing about the row says how much.
 *
 * **There is no team-shaped read for this.** The server answers grants per
 * directory, so the caller asks for the directory list and the grants on each
 * — once, when somebody asks to delete, not on render. This is the part that
 * turns those answers into the sentence, which is why it is a rule here rather
 * than a `filter` beside a dialog.
 *
 * **It is not the whole of what goes, and the copy must not claim it is.** A
 * team can also be named in a per-resource exception from the sharing sheet,
 * and `delete_team` forgets those too; they are keyed by path and cannot be
 * enumerated from the team. So the directories are named and the rest is
 * described rather than counted.
 */
export function grantsHeldBy(
  teamId: string,
  over: {
    directory: { name: string; slug: string };
    grants: { subjectKind: string; subjectId: string }[];
  }[],
): HeldGrant[] {
  return over
    .filter(({ grants }) => grants.some((g) => g.subjectKind === "team" && g.subjectId === teamId))
    .map(({ directory }) => ({ name: directory.name, slug: directory.slug }));
}

/** `4 people`, `1 person`, and the one that is neither. */
export function howMany(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

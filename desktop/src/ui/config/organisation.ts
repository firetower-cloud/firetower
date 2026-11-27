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

/**
 * What the People pane is doing, given the role read and whichever list it
 * chose from it.
 *
 * **A role that could not be read is the case this exists for.** Both reads are
 * off until `me` resolves, so a failed `me` leaves no feed at all — and the
 * pane read its error off that absent feed and found none, so it settled
 * forever: a spinner behind ⌘8 that could not resolve and offered no way out,
 * on the destination the whole surface exists to make reachable. `me`'s own
 * error is the one to show, because `me` is the request that failed.
 *
 * **`me`'s error matters only while there is no feed, and the first fix for
 * the above missed that.** It read `feed?.error ?? me.error`, unconditionally
 * — so once a populated list was cached and healthy, a *background refetch* of
 * `/auth/me` failing replaced it with an error screen. A list on screen is a
 * list somebody can use, and the role it was chosen by has already been read;
 * blanking it because a later check of something else blipped is the same
 * family of defect as the one that fix was for, one case narrower. So the
 * feed, once it exists, is the only thing that can put this pane in error.
 *
 * `settling` is asked the same way and comes out right already: a refetch with
 * data in hand is not `pending` in this client's query layer, so a `me` that
 * is re-checked behind a drawn list does not put a spinner over it. The guard
 * that matters is `!feed`, which is about there being nothing to show yet.
 *
 * ## It settled forever a third time, and the case is not the fix
 *
 * The first two fixes each named a *way* the role fails to arrive — the read
 * errors; the read errors behind a healthy list — and the third way had no
 * name: **`/auth/me` answering 200 with nothing usable in it.** A body with no
 * `role`, a shape one version out, a proxy that returned the wrong JSON.
 * `readsFor` then enables neither read, so there is no feed; `me.error` is
 * null, because nothing failed; and the old expression had `(!feed &&
 * !me.error)` holding `settling` true with nothing left that could ever
 * change it. ⌘8 drew the unresolvable spinner again.
 *
 * So this is written as the three states it has rather than as a list of the
 * ways it can go wrong: **there is a feed, or the role has not arrived yet, or
 * the role did not arrive.** No fourth branch exists, which is what makes a
 * fourth way of failing arrive at the right screen without anybody having
 * anticipated it — and *did it arrive* is asked of `roleRead` rather than
 * inferred here, so the pane that routes on the same question cannot drift
 * from the pane that draws on it.
 */
export function feedState(
  role: ReturnType<typeof roleRead>,
  feed: { pending: boolean; error: unknown } | null,
): { settling: boolean; error: unknown } {
  /* Once a list exists the role has already been read, so the list is the
     only thing that can put this pane in either state — a background refetch
     of `/auth/me` blipping must not blank a list somebody is using. */
  if (feed) return { settling: feed.pending, error: feed.error ?? null };
  if (role.reading) return { settling: true, error: null };
  /* Resolved, and still nothing to feed the pane: the role is what did not
     arrive, and `roleRead` guarantees there is something to say about it. */
  return { settling: false, error: role.error };
}

/**
 * The server answered, and said nothing this client can use.
 *
 * Shaped like the errors the API layer throws, because `data.ts`' `trouble`
 * and `why` are what a pane will read it with. **`status` is 200 because that
 * is what happened** — the request was fine and the answer was not, which
 * `trouble` lands on *refused* rather than on *dark*: the right drawing,
 * since there is a server there and a retry is worth offering.
 */
export const ROLE_UNREADABLE = {
  status: 200,
  message: "This Firetower did not say who you are.",
} as const;

/**
 * Whether the role has arrived, and what to say when it has not.
 *
 * **One question, asked by everything that depends on the answer.** Two
 * screens route on it — People picks which list to read, and `Configuration`
 * picks which pane `/configuration/server` draws — and each of them had its
 * own two-state version: *pending or not*, with everything that was not
 * pending treated as an answer. Both were wrong in the same place, and in
 * opposite directions: People settled forever on a role it never got, and
 * `Configuration` read a role still in flight as *not an administrator* and
 * mounted People over the address somebody had typed.
 *
 * **Pending is not refusal, and a 200 is not an answer.** The three states
 * are *still reading*, *read*, and *could not be read* — and the third is the
 * one neither screen had, so neither could tell a member apart from a
 * `/auth/me` that failed.
 *
 * `error` is never null while there is no role, which is what lets a caller
 * trust it without a fallback of its own.
 */
export function roleRead(me: { pending: boolean; error: unknown; user: Signed }): {
  reading: boolean;
  error: unknown;
} {
  if (me.pending) return { reading: true, error: null };
  if (me.user?.role) return { reading: false, error: null };
  return { reading: false, error: me.error ?? ROLE_UNREADABLE };
}

/**
 * What the telemetry row may assert about a switch it has not read.
 *
 * **Three states, because `enabled ?? true` was doing two jobs.** It meant
 * both *not loaded yet* and *loaded, and it is on*, so a preview read that
 * failed drew **Telemetry on** and a brick *Turn telemetry off* — against a
 * server holding `{"enabled": false}`. The opposite of the truth, with no
 * trouble line and no retry, and the guess fell in the loud direction: a
 * destructive control offered for a state the server denies.
 *
 * A switch that cannot read its own position says so. `on` and `off` are
 * answers; `unread` is the absence of one, and the pane draws `Section`'s own
 * trouble for it rather than a third rendering of the same idea.
 *
 * The optimistic default survives only where it is harmless and right:
 * `preview` answers `enabled` for every installation, and a *successful* read
 * missing the field is a server older than the field, where collection was on.
 */
export function telemetryState(
  q: { pending: boolean; error: unknown; data?: { enabled?: boolean } | undefined },
): "on" | "off" | "unread" {
  if (q.pending || q.error || !q.data) return "unread";
  return q.data.enabled === false ? "off" : "on";
}

/**
 * What a team's delete confirmation can honestly say about the consequence.
 *
 * **A read that failed is not an answer of "none".** A grant list that could
 * not be fetched arrives as `undefined`, exactly like a directory that holds
 * no grants, so the dialog said *nobody loses access* over an irreversible
 * delete and the people who did lose it found out afterwards.
 *
 * `unread` rather than refusing outright, **and the reason first written here
 * was wrong**: it said an administrator who is only a Viewer somewhere would be
 * refused every time, so a team they wanted gone would be undeletable. That
 * cannot happen. `may_administer` short-circuits for an administrator of the
 * organisation — the directory exists or it is a 404 — and this dialog is only
 * ever drawn for one. The claim came from a review's hypothesis and was not
 * checked against the handler.
 *
 * The real reason is narrower and still holds: a read can fail for reasons
 * that are nobody's permissions — a timeout, a 5xx, a directory removed
 * between the list and the grants on it. **This dialog's job is to state the
 * consequence, not to gate on it**, so a read that failed should not turn into
 * a functional refusal of an unrelated delete. Saying what is not known is
 * what *the consequence stated before confirming* has to mean when it cannot
 * be read.
 */
export function consequenceState(loading: boolean, failed: boolean): "reading" | "unread" | "known" {
  if (loading) return "reading";
  if (failed) return "unread";
  return "known";
}

/* ── The deployment, and who operates it ──────────────────────────────────

   The Organisation destination's fourth pane is the deployment itself: what
   this installation is called, whether it reports telemetry, what is running,
   and how it lets people in. Unlike People it has no member-readable half —
   there is no reduced shape of *how signing in is configured* that is safe and
   useful — so the pane is not listed for a member at all.

   **Not listed is not the same as not reachable.** The destination is never
   conditional and never changes which pane it opens on: everybody lands on
   People, which is everybody's. That is ticket 02's rule and this must not
   bend it — see `opensOn`. */

/**
 * Whether this installation is operated by the people using it.
 *
 * **Self-hosted, always, today — and that is a placeholder with a reason
 * rather than an oversight.**
 *
 * There is no representation of hosted-versus-self-hosted anywhere in the
 * product: no `deployment_mode`, no `is_hosted`, no tenancy flag in `crates/`,
 * and `/bootstrap` carries only `authModes`, `eventsPath`, `organization`,
 * `serverId` and `version`. The approved specification contradicts itself on
 * this — §3 F3 wants these panes absent in a hosted installation, §9 puts the
 * hosted offering explicitly out of scope — and **how a deployment declares
 * itself hosted is a product decision nobody has taken**, so taking it here by
 * adding a flag to the bootstrap payload would be inventing the scope §9
 * excluded.
 *
 * So the *rule* is written and tested for both modes, and the *signal* is this
 * one function. The day there is something real to read — a bootstrap field, a
 * build-time constant, an address — it is read here and nowhere else, and the
 * hosted branch of `panesFor` starts being exercised by a deployment rather
 * than only by its tests. Switching it on is a one-function change rather than
 * an archaeology exercise.
 */
export type DeploymentMode = "self-hosted" | "hosted";

export function deploymentMode(): DeploymentMode {
  return "self-hosted";
}

/** One pane of the Organisation destination, as its panel lists it. */
export type OrganisationPane = { at: string; label: string };

/**
 * The four panes that are everybody's, in the order the panel draws them.
 *
 * People first because it is where the destination opens and the only one of
 * the three about *who* somebody has a daily reason to be on; Directories last
 * of those three because it is set up once.
 *
 * **Usage is here rather than behind a role, and that is the server's
 * answer rather than a generosity.** `/consumption` has no role check at all:
 * it narrows every read by `filed_within`, the same predicate as workspaces
 * and secrets, with no administrator bypass — so a member opening it sees
 * their own work and an administrator sees whatever they were granted, from
 * one pane with one shape. Adding a gate the handler does not have would be a
 * defect rather than caution, and it would make the surface a member lands on
 * smaller for no reason anybody could point at.
 */
const EVERYBODYS: OrganisationPane[] = [
  { at: "people", label: "People" },
  { at: "teams", label: "Teams" },
  { at: "directories", label: "Directories" },
  { at: "usage", label: "Usage" },
];

/** The deployment pane, which only an operator of the deployment is shown. */
const DEPLOYMENT: OrganisationPane = { at: "server", label: "This Firetower" };

/**
 * Whether the deployment pane is this person's, on this deployment.
 *
 * Two conditions, and they fail for different reasons. **A member** is not
 * refused a reduced version — there is no reduced version: the organisation's
 * name is an administrator's to change and the sign-in configuration is the
 * operator's to read, and `rename_organization` and `set_telemetry_settings`
 * are both `admin` on the server. **A hosted tenant** is not the operator at
 * all: the proxy is the operator's, the deployment is the operator's, and
 * telemetry about the installation is a question for whoever runs it.
 */
export function mayOperateDeployment(mode: DeploymentMode, me: Signed): boolean {
  return mode === "self-hosted" && mayAdminister(me);
}

/**
 * Which panes this destination lists, for this person, on this deployment.
 *
 * **Absent, never disabled and never greyed.** A disabled pane invites a
 * support question; an absent one does not, and the specification records this
 * as the first point where the hosted and self-hosted products present visibly
 * different interfaces rather than the same interface configured differently.
 *
 * **It is never empty**, in any of the four combinations, and that is the
 * property worth protecting rather than the contents: the three panes above
 * are everybody's, and hiding a fourth must not make the destination itself
 * conditional. A member pressing ⌘8 lands on a populated read-only surface,
 * which is ticket 02's rule and the regression this function exists to not
 * cause.
 */
export function panesFor(mode: DeploymentMode, me: Signed): OrganisationPane[] {
  return mayOperateDeployment(mode, me) ? [...EVERYBODYS, DEPLOYMENT] : [...EVERYBODYS];
}

/**
 * The pane the destination opens on — **the same one for everybody, always**.
 *
 * Deliberately not "the first pane you may see", which would be the same
 * answer today and would quietly become a different one the first time the
 * list was reordered. `⌘8`, the rail icon and the palette all navigate to a
 * fixed address in `destinations.ts`; this is that address's pane name, in the
 * rule, so a test can assert the two agree and that it is listed for everybody.
 */
export function opensOn(): string {
  return "people";
}

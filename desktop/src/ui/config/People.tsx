/**
 * Who can sign in, and what each of them is.
 *
 * **This was a read-only mirror of a screen on the administration site**, and
 * the paragraph at its foot used to say so: *"to invite somebody, change a
 * role, or disable an account, use the administration site"*. That stopped
 * being true when this became the only place people exist, so the paragraph and
 * the *Manage on the web* link beside it are both gone — they existed only
 * because this screen could not do the thing being asked of it.
 *
 * ## The pane picks its read by role, and that is the whole of the design
 *
 * There are two ways to list people and **they are not interchangeable**: the
 * colleague list is any signed-in user's and carries a name and an id, and the
 * organisation's user list is administrators-only and carries role, email and
 * switched-off state. `config/organisation.ts` holds that rule, with the
 * reasoning and the two rejected alternatives written out — read it before
 * changing anything here.
 *
 * What it means on this screen: **a member pressing ⌘8 finds a populated,
 * useful, read-only surface**, because they are reading the list they are
 * allowed to read. Building this pane on the administrators-only list and
 * hiding the buttons for everybody else would turn ⌘8 into a 403 for most of
 * the organisation — an empty or forbidden destination is a defect, not an
 * access rule.
 *
 * A member's row is thinner — a face, a name, a handle, and *you* against
 * themselves — **because the server will not tell a member those facts**, not
 * because controls were hidden. It is also exactly the row that shipped here
 * before this change, which is what makes it a proven surface rather than a new
 * one.
 *
 * ## The row, not a table
 *
 * The administration site builds this on a table, a checkbox and a menu, and
 * none of the three is ported. The row carries it: the role is a `.lvl` menu —
 * the shape Directories already uses for its levels — the state is a tag drawn
 * only when there is something to say, and the rest is behind the row's own
 * menu on hover. **The checkbox column does not survive, and bulk demotion and
 * bulk switch-off go with it.** That is a recorded product decision rather than
 * an oversight: this client multi-selects nothing anywhere, and adding
 * selection here would make the screen where somebody changes who can sign in
 * the first one that does.
 *
 * ## Refusals are the server's, and are shown as sentences
 *
 * The rules that would lock the room — the last administrator cannot be
 * demoted, switched off or removed — live on the server, inside a transaction
 * with the row locked, which is the only place the answer is right when two
 * administrators are changing things at once. `locksTheRoom` asks the same
 * question here, a round trip earlier, so the reason lands on the row before
 * the request is made; when the server refuses anyway, its sentence lands in
 * the same place.
 */
import { useState } from "react";
import {
  KeyRound,
  Check,
  ChevronDown,
  Power,
  Search,
  Trash2,
  UserPlus,
  UserRound,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Avatar, Badge, Icon } from "~/components/ui";
import { getListColleaguesQueryKey, useListColleagues } from "~/api/generated/access/access";
import { useMe } from "~/api/generated/auth/auth";
import {
  getListUsersQueryKey,
  useChangeUser,
  useListUsers,
  useResetUserPassword,
} from "~/api/generated/organization/organization";
import type { Colleague, User } from "~/api/generated/model";
import { trouble, why } from "~/data";
import { Pop } from "~/ui/Pop";
import { RowMenu, type RowMenuItem } from "~/ui/RowMenu";
import { useConfirm } from "~/ui/Confirm";
import { Group, Note, Rows, Section, Typed, WhereTo } from "~/ui/config/bits";
import { AddPerson, HandOver, type Handed } from "~/ui/config/AddPerson";
import { Offboard } from "~/ui/config/Offboard";
import {
  actionsFor,
  changeFor,
  feedState,
  locksTheRoom,
  mayInvite,
  readsFor,
  ROLES,
  saidRole,
  tagsFor,
  type Role,
  type Signed,
} from "~/ui/config/organisation";

export function People() {
  const cache = useQueryClient();
  const me = useMe();
  const mine: Signed = me.data?.user;
  /* **Both reads are enabled by role, and neither before the role arrives.**
     This is the one line that decides whether a member's session issues a
     request a member is not permitted to make. See `readsFor`. */
  const reads = readsFor(mine);
  const users = useListUsers({ query: { enabled: reads.users } });
  const colleagues = useListColleagues({ query: { enabled: reads.colleagues } });

  const [find, setFind] = useState("");
  const [handed, setHanded] = useState<Handed | null>(null);
  const [adding, setAdding] = useState(false);
  /* One at a time. Removing somebody is a decision about everything that is
     theirs, and a decision per row cannot be made for four people at once. */
  const [leaving, setLeaving] = useState<User | null>(null);

  /* **Both lists, because adding or removing somebody changes both.** The
     colleague list is what the sharing sheet and the directory picker read
     from, so an administrator who invites somebody and then shares a workspace
     with them in the same session would otherwise be offered a list that does
     not have them in it yet. */
  const refresh = () =>
    Promise.all([
      cache.invalidateQueries({ queryKey: getListUsersQueryKey() }),
      cache.invalidateQueries({ queryKey: getListColleaguesQueryKey() }),
    ]);

  /* Whichever read applies. The administrator's rows carry the facts only an
     administrator is told; a member's carry a name and an id, which is the
     whole of what the server will say to them. */
  const everyone: (User | Colleague)[] = reads.users ? (users.data ?? []) : (colleagues.data ?? []);
  const q = find.trim().toLowerCase();
  const shown = everyone.filter((p) => p.username.toLowerCase().includes(q));

  /* The read that is actually feeding the page, so the five list states — and
     in particular *dark*, where the rows stay — are answered by the request
     that was made rather than by the one that was not. While `me` is still in
     flight neither has started, and the page is settling. */
  const feed = reads.users ? users : reads.colleagues ? colleagues : null;
  /* **`me` failing is the one way both reads stay off with nothing in
     flight**, and it used to settle forever: `feed` is null, so `!feed` held
     `settling` true, while `error` read off a feed that was never created and
     stayed null. ⌘8 drew a spinner that could not resolve and offered no way
     out — on the destination this whole surface exists to make reachable.

     So a role that could not be read is an error like any other, and it is
     `me`'s own that is shown, because that is the request that failed. */
  const { settling, error } = feedState(
    { pending: me.isPending, error: me.error },
    feed ? { pending: feed.isPending, error: feed.error } : null,
  );

  /* Nothing there, and nothing wrong. In practice unreachable — both reads
     include the person asking, so the list always has at least you in it,
     which is also what makes a single-person installation read as useful
     rather than empty. Kept for a server that answers with something stranger
     than it should; narrowed-to-nothing is a different state and gets a
     `Note`. */
  const blank = !settling && !error && everyone.length === 0;

  return (
    <Section
      title="People"
      note={
        mayInvite(mine)
          ? "Who can sign in, and what each of them is. The server holds the rules that would lock the room — the last administrator cannot be demoted, switched off or removed — and refuses in a sentence."
          : "Everybody with an account on this Firetower."
      }
      settling={settling}
      trouble={trouble(error)}
      error={error ? why(error) : null}
      /* Retry whichever request actually failed — neither list exists to
         refetch when it was the role that could not be read. */
      onRetry={() => void (reads.users ? users.refetch() : reads.colleagues ? colleagues.refetch() : me.refetch())}
      /* The screen's one primary action, top right. Not drawn at all for
         somebody the server will not take an account from — a greyed *Add a
         person* is how an interface says you are being withheld from. */
      action={
        mayInvite(mine) ? (
          <button onClick={() => setAdding(true)} className="btn primary">
            <Icon of={UserPlus} size={14} />
            Add a person
          </button>
        ) : undefined
      }
      /* Under the title, where it plainly governs what is beneath it. **Not
         over the blank**: there is nothing to narrow. */
      controls={
        !blank && !settling ? (
          <label className="find">
            <Icon of={Search} size={14} className="shrink-0 text-mute" />
            <input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="Find somebody"
              aria-label="Find somebody"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent placeholder:text-mute focus:outline-none"
            />
          </label>
        ) : undefined
      }
    >
      <Group>
        <Rows
          feed={{
            data: shown,
            loading: settling,
            error: error ? why(error) : null,
            trouble: trouble(error),
          }}
          icon={UserRound}
          empty={
            find ? (
              <Note
                icon={Search}
                control={
                  <button onClick={() => setFind("")} className="btn quiet">
                    Clear
                  </button>
                }
              >
                Nobody here is called <Typed>{find.trim()}</Typed>.
              </Note>
            ) : (
              "Nobody here yet"
            )
          }
        >
          {shown.map((p) => (
            <One
              key={p.id}
              person={p}
              me={mine}
              users={reads.users ? (users.data ?? []) : []}
              onChanged={refresh}
              onHanded={setHanded}
              onLeaving={setLeaving}
            />
          ))}
        </Rows>
      </Group>

      {/* What used to be the paragraph naming somewhere else to go. An account
          is this installation's and nothing federates it, which is the one
          thing somebody adding their first colleague does not already know —
          and it is a fact about what an account *is* rather than directions to
          another address.

          **Never beside a blank**, and never to somebody who cannot add one. */}
      {!blank && !settling && mayInvite(mine) && (
        <WhereTo>
          Accounts made here <b>exist on this Firetower only</b>. Somebody added here cannot sign in
          to another one with the same name, and removing them here removes them nowhere else.
        </WhereTo>
      )}

      {adding && (
        <AddPerson
          onClose={() => setAdding(false)}
          onAdded={(made) => {
            setAdding(false);
            setHanded(made);
            void refresh();
          }}
        />
      )}

      {/* Shown once and never again: the server keeps a hash, so a screen that
          loses this produces an account nobody can get into. */}
      {handed && <HandOver handed={handed} onClose={() => setHanded(null)} />}

      {leaving && <Offboard person={leaving} onClose={() => setLeaving(null)} />}
    </Section>
  );
}

/**
 * One person.
 *
 * The same row shape whichever read answered. What differs is how much of it
 * there is to draw, and that is decided by `actionsFor` rather than here —
 * which is what stops the question "may I" being answered twice, differently,
 * on one screen.
 */
function One({
  person,
  me,
  users,
  onChanged,
  onHanded,
  onLeaving,
}: {
  person: User | Colleague;
  me: Signed;
  /** Everybody, for the last-administrator rule. Empty for a member, who is
   *  never told enough to ask the question and is never offered the controls
   *  that raise it. */
  users: User[];
  onChanged: () => void;
  onHanded: (handed: Handed) => void;
  onLeaving: (person: User) => void;
}) {
  const confirm = useConfirm();
  const change = useChangeUser();
  const reset = useResetUserPassword();
  const [said, setSaid] = useState<string | null>(null);

  /* The administrator's shape, or nothing. `role` is the field the colleague
     list deliberately does not carry, so it is also the honest test for which
     of the two reads answered. */
  const full = "role" in person ? (person as User) : null;
  const actions = full ? actionsFor({ me, person: full }) : { role: null, menu: [] };
  const you = person.id === me?.id;

  const act = (p: Promise<unknown>) => {
    setSaid(null);
    p.then(() => onChanged()).catch((e) => setSaid(why(e)));
  };

  /**
   * Ask, then do it — and say why instead, when the answer is already known.
   *
   * The intent is turned into the request body **once**, by `changeFor`, and
   * the same object is what `locksTheRoom` is asked about. So "could this be
   * refused" and "what am I asking for" are literally one value rather than
   * two expressions of it written a hundred lines apart.
   */
  const ask = async (
    intent: "switch-off" | "switch-on" | Role,
    q: { title: string; body: React.ReactNode; action: string; tone?: "danger" },
  ) => {
    const data = changeFor(intent);
    const refused = locksTheRoom(users, person.id, data);
    if (refused) return setSaid(refused);
    if (!(await confirm(q))) return;
    act(change.mutateAsync({ id: person.id, data }));
  };

  const items: RowMenuItem[] = [];
  for (const what of actions.menu) {
    if (!full) break;
    if (what === "reset") {
      items.push({
        label: "Reset password",
        icon: KeyRound,
        onPick: () =>
          void confirm({
            title: `Reset ${full.username}'s password?`,
            action: "Reset password",
            tone: "danger",
            body: (
              <>
                A new temporary password is made and shown to you <i>once</i>. The one they have now
                stops working, every session of theirs ends, and they choose their own the next time
                they sign in.
              </>
            ),
          }).then(
            (ok) =>
              ok &&
              act(
                reset
                  .mutateAsync({ id: full.id })
                  .then((r) => onHanded({ username: full.username, password: r.password, fresh: false })),
              ),
          ),
      });
    } else if (what === "switch-off") {
      items.push({
        label: "Switch off",
        icon: Power,
        note: "Keeps what they made",
        onPick: () =>
          void ask("switch-off", {
            title: `Switch off ${full.username}?`,
            action: "Switch off",
            tone: "danger",
            body: (
              <>
                They will not be able to sign in, and every session of theirs ends now — in every
                client at once. Everything they made stays exactly where it is, and you can switch
                them back on at any time.
              </>
            ),
          }),
      });
    } else if (what === "switch-on") {
      items.push({
        label: "Switch on",
        icon: Power,
        onPick: () =>
          void ask("switch-on", {
            title: `Switch ${full.username} back on?`,
            action: "Switch on",
            body: <>They will be able to sign in again, with the password they already had.</>,
          }),
      });
    } else {
      /* Behind a rule, because it is the one that destroys something. And it
         is not a question with a yes — it is a decision about everything that
         is theirs, so it opens the offboarding confirmation from this row
         rather than a dialog from here. */
      items.push("-");
      items.push({
        label: "Remove…",
        icon: Trash2,
        tone: "danger",
        onPick: () => onLeaving(full),
      });
    }
  }

  const tags = full ? tagsFor(full) : [];

  return (
    <div className="r">
      <Avatar name={person.username} />
      <span className="tx">
        <b>{person.username}</b>
        {/* The refusal takes the sub-line, which is where the reader is already
            looking. Directories says a row's trouble the same way. */}
        {said ? <s className="!text-brick">{said}</s> : full?.email ? <s>{full.email}</s> : null}
      </span>

      {/* **A member's row, unchanged from what already ships here.** The
          colleague list carries a name and an id and nothing else, so the
          handle is the whole of the rest of it — and `u/<name>` is what the
          sharing sheet and a log line say. An administrator's row spends this
          position on the email instead, which is a fact only they are told. */}
      {!full && <span className="path">u/{person.username}</span>}

      {you && <span className="said">you</span>}

      {/* Only when there is something to say. At rest most rows say nothing:
          somebody with an address, who has signed in, who is switched on is the
          ordinary case, and a row reading *Active* spends a tag on it. */}
      {tags.map((t) => (
        <Badge key={t}>{t}</Badge>
      ))}

      {full && actions.role === "menu" && (
        <RoleMenu
          role={full.role}
          onPick={(role) =>
            void ask(role, {
              title:
                role === "admin"
                  ? `Make ${you ? "yourself" : full.username} an administrator?`
                  : `Make ${you ? "yourself" : full.username} a member?`,
              action: role === "admin" ? "Make an administrator" : "Make a member",
              body:
                role === "admin" ? (
                  <>
                    They will be able to add and remove people, change anybody&rsquo;s role, manage
                    teams and directories, and upgrade this Firetower.
                  </>
                ) : you ? (
                  <>
                    You keep everything you own and every directory you administer. What goes is the
                    organisation&rsquo;s own — people, teams, directories and upgrading this
                    Firetower — and <b>another administrator has to hand it back</b>.
                  </>
                ) : (
                  <>
                    They keep everything they own and every directory they administer. What goes is
                    the organisation&rsquo;s own: people, teams, directories, and upgrading this
                    Firetower.
                  </>
                ),
            })
          }
        />
      )}

      {full && <RowMenu label={`What to do with ${full.username}`} items={items} />}
    </div>
  );
}

/**
 * Administrator or member, as a menu on the row that holds it.
 *
 * `.lvl` and the same two-step as Directories' levels: the pill says what they
 * are, and the rest opens on demand. **A badge with the verb beside it was the
 * other option and is what the administration site draws** — a tag reading
 * *Administrator* and a separate *Make a member* in the overflow — which puts
 * the fact and the control two places apart and makes the fact look like a
 * state being flagged.
 */
function RoleMenu({ role, onPick }: { role: string; onPick: (role: Role) => void }) {
  const [open, setOpen] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        onClick={(e) => setOpen(open ? null : e.currentTarget)}
        className="lvl"
      >
        {saidRole(role)}
        <Icon of={ChevronDown} size={12} />
      </button>
      {open && (
        <Pop anchor={open} onClose={() => setOpen(null)} width={286}>
          <div role="menu" className="py-1">
            {ROLES.map((r) => (
              <button
                key={r.value}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(null);
                  if (r.value !== role) onPick(r.value);
                }}
                /* **Top-aligned, because these rows are three lines tall.**
                   `.mi` centres its children, which is right for the one-line
                   menus everywhere else and puts the tick halfway down a
                   paragraph here — beside the second line of a sentence rather
                   than beside the word it marks. */
                className="mi items-start"
              >
                <span className="ic mt-0.5">
                  {r.value === role ? <Icon of={Check} size={14} /> : null}
                </span>
                <span className="tx">
                  <b>{r.label}</b>
                  {/* The reason to choose it, which is the part somebody
                      changing a colleague's role is actually weighing. */}
                  <s className="whitespace-normal">{r.says}</s>
                </span>
              </button>
            ))}
          </div>
        </Pop>
      )}
    </>
  );
}

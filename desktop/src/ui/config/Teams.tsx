/**
 * The teams a grant can be held by, and who is in each.
 *
 * **A team is people-shaped.** It outlives every resource it was ever granted
 * on, so saying who is in one is a statement about the organisation rather than
 * about any piece of work — which is why it sits in the Organisation
 * destination beside People, and not beside the thing being shared.
 *
 * Granting a team access to a directory is the opposite: that is
 * resource-shaped, it belongs beside the thing being shared, and it is
 * Directories' and the sharing sheet's.
 *
 * ## Only the write controls gate, and they gate at the control
 *
 * **Different from People, and simpler.** The team list and one team's
 * membership are readable by anybody — the server says so itself, because
 * granting to a team means choosing one from a list, and a member who could not
 * read it could not share with one. So there is no read to pick by role here:
 * same data, same rows, for everybody, and what differs is only whether a row
 * offers a way to change it. `config/organisation.ts`'s `teamActionsFor` is
 * that decision, beside People's, so there is one place the rule lives.
 *
 * Nothing is greyed. A control a member does not have is not drawn.
 *
 * ## `Everyone` offers nothing, and that is not a permission
 *
 * It has no membership rows, because the membership that has to be true is
 * "however many people exist right now" — a team you could open and count
 * would imply somebody could be left out of it. Making the other rows writable
 * does not change that, and the three things a row can do are all refused for
 * it by name on the server: it cannot be renamed, it cannot be removed, and
 * everybody is already in it. So the row stays a row.
 *
 * ## Removing one says what goes first
 *
 * A team holds grants, and `delete_team` revokes every one of them by cascade
 * — which is the whole reason a team is worth having and the reason removing
 * one is worth stating. `DeleteTeam` below reads what it can reach at the
 * moment somebody asks, not on render.
 */
import { useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2, UsersRound, X } from "lucide-react";
import { Avatar, Icon, IconButton } from "~/components/ui";
import {
  getListTeamMembersQueryKey,
  getListTeamsQueryKey,
  getListGrantsQueryOptions,
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useListTeamMembers,
  useListTeams,
  useRemoveTeamMember,
  useRenameTeam,
} from "~/api/generated/access/access";
import { useMe } from "~/api/generated/auth/auth";
import type { Grant, Team } from "~/api/generated/model";
import { trouble, useDirectories, why } from "~/data";
import { PickPeople } from "~/ui/PickPeople";
import { RowMenu, type RowMenuItem } from "~/ui/RowMenu";
import { usePrompt } from "~/ui/Confirm";
import { Group, Rows, Section, WhereTo } from "~/ui/config/bits";
import {
  consequenceState,
  grantsHeldBy,
  howMany,
  mayAdminister,
  teamActionsFor,
  type Signed,
} from "~/ui/config/organisation";

export function Teams() {
  const cache = useQueryClient();
  const me = useMe();
  const mine: Signed = me.data?.user;
  const may = mayAdminister(mine);
  const q = useListTeams();
  const create = useCreateTeam();

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  /* One at a time. Removing a team takes access away from everybody in it, so
     it is a decision per team and not a thing to do to four at once. */
  const [leaving, setLeaving] = useState<Team | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const teams = (q.data ?? []) as Team[];
  const blank = !q.isPending && !q.error && teams.length === 0;
  const refresh = () => cache.invalidateQueries({ queryKey: getListTeamsQueryKey() });

  const make = async () => {
    const wanted = name.trim();
    if (!wanted) return;
    setSaid(null);
    try {
      await create.mutateAsync({ data: { name: wanted } });
      setName("");
      setAdding(false);
      await refresh();
    } catch (e) {
      /* The server's own sentence — *there is already a team called Backend* —
         because which of the two reasons it was is the whole of its value. */
      setSaid(why(e));
    }
  };

  /* The pane's one primary action, written once: the head wears it when there
     is a list and the blank wears it when there is not. Directories does the
     same with the same words, which is deliberate — they are two panes of one
     destination and *make one of these* should not be two shapes. */
  const newTeam = may ? (
    <button
      onClick={() => {
        setAdding((v) => !v);
        setSaid(null);
      }}
      className="btn primary"
    >
      <Icon of={Plus} size={14} />
      New team
    </button>
  ) : undefined;

  return (
    <Section
      title="Teams"
      note="A team holds a grant, so access handed to five people is one row rather than five."
      settling={q.isPending}
      trouble={trouble(q.error)}
      error={q.error ? why(q.error) : null}
      onRetry={() => void q.refetch()}
      /* **Not over the blank**, whose own button is the same action with the
         sentence that explains it. */
      action={blank ? undefined : newTeam}
    >
      {adding && (
        <div className="inline-form flex-col items-stretch gap-2">
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setAdding(false);
                if (e.key === "Enter" && name.trim()) void make();
              }}
              placeholder="What to call it"
              className="w-56 rounded-md border border-line bg-ground px-2 py-1 text-ui text-bone focus:outline-none"
            />
            <button
              disabled={!name.trim() || create.isPending}
              onClick={() => void make()}
              className="btn plain ml-auto"
            >
              {create.isPending ? "Making…" : "Make it"}
            </button>
          </div>
          <p className="text-meta text-mute">
            Empty to begin with. Add people to it, then hand it access to a directory.
            {said && <span className="text-brick"> {said}</span>}
          </p>
        </div>
      )}

      <Group>
        <Rows
          feed={{ data: teams, loading: q.isPending, error: q.error ? why(q.error) : null }}
          icon={UsersRound}
          empty="No teams yet"
          note="A team is a name and the people in it. Hand one a grant and access to five people is one row rather than five."
          action={newTeam}
        >
          {teams.map((t) => (
            <One
              key={t.id}
              team={t}
              me={mine}
              /* Every team's id, so the picker offers none of them: it lists
                 people *and* teams because a grant takes either, and a team
                 cannot be a member of a team. Excluding them there beats
                 widening the shared picker for one caller, and beats offering
                 a row that would be quietly ignored. */
              teams={teams}
              onChanged={refresh}
              onLeaving={setLeaving}
            />
          ))}
        </Rows>
      </Group>

      {/* The distinction, which is the thing a reader of this list actually
          needs. Never beside a blank: it is about operating teams this reader
          does not have yet. */}
      {!blank && (
        <WhereTo>
          A team <b>outlives every resource it was ever granted on</b>, so who is in one is a
          statement about the organisation. Granting a team access to a directory is the opposite —
          it belongs beside the thing being shared — and the two are kept apart on purpose.
        </WhereTo>
      )}

      {leaving && (
        <DeleteTeam
          team={leaving}
          onClose={() => setLeaving(null)}
          onDone={() => {
            setLeaving(null);
            void refresh();
          }}
        />
      )}
    </Section>
  );
}

function One({
  team,
  me,
  teams,
  onChanged,
  onLeaving,
}: {
  team: Team;
  me: Signed;
  /** All of them, so none is offered as somebody to add. */
  teams: Team[];
  onChanged: () => void;
  onLeaving: (team: Team) => void;
}) {
  const cache = useQueryClient();
  const prompt = usePrompt();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const rename = useRenameTeam();

  const actions = teamActionsFor({ me, team });

  const refresh = () =>
    Promise.all([
      cache.invalidateQueries({ queryKey: getListTeamMembersQueryKey(team.id) }),
      Promise.resolve(onChanged()),
    ]);
  const act = (p: Promise<unknown>) => {
    setSaid(null);
    p.then(() => void refresh()).catch((e) => setSaid(why(e)));
  };

  const items: RowMenuItem[] = actions.menu.map((what) =>
    what === "rename"
      ? {
          label: "Rename",
          icon: Pencil,
          onPick: () =>
            void prompt({
              title: `Rename ${team.name}`,
              /* The grants are held by the team rather than by its name, so
                 renaming takes nothing away — which is the opposite of a
                 directory, whose slug deliberately does not follow its name.
                 Said here because somebody about to rename a team that five
                 people reach things through wants to know that. */
              body: "Every grant it holds stays with it, and everybody in it stays in it.",
              action: "Rename",
              placeholder: "What to call it",
              initial: team.name,
            }).then(
              (next) =>
                next &&
                next !== team.name &&
                act(rename.mutateAsync({ id: team.id, data: { name: next } })),
            ),
        }
      : {
          label: "Remove…",
          icon: Trash2,
          tone: "danger" as const,
          /* Not a question with a yes: what goes with a team is a list this
             row does not have, so it opens a confirmation that reads it. */
          onPick: () => onLeaving(team),
        },
  );

  /* The everybody team has no list to open — it is everybody, by definition.
     It was a `disabled` button, and this screen is not allowed one: a greyed
     control is how an interface says you are being withheld from, and nothing
     is being withheld here. A row that does not open is simply a row. */
  const inside = (
    <>
      <span className="g">
        <Icon of={UsersRound} size={16} />
      </span>
      <span className="tx">
        <b>{team.name}</b>
        {said ? (
          <s className="!text-brick">{said}</s>
        ) : (
          <s>{team.everyone ? "everybody here, always" : howMany(team.members)}</s>
        )}
      </span>
      {!team.everyone && (
        <span className="g">
          <Icon of={open ? ChevronDown : ChevronRight} size={14} />
        </span>
      )}
    </>
  );

  return (
    <>
      {/* **The row is a `div` and the expander is a button inside it**, which
          is the one arrangement that lets a row both open and carry a menu.
          It used to be a `<button className="r">` outright, and a row menu
          nested inside that would be a button inside a button — markup no two
          browsers agree about, and a defect already on record elsewhere in
          this client. People's rows are `div`s for the same reason.

          The expander keeps the whole row as its target rather than shrinking
          to the chevron: it is `flex-1` at `.r`'s own 14px gap, so what is on
          screen is unchanged to the pixel and only the markup underneath it
          moved. `aria-expanded` arrived with the restructure — it is a
          disclosure and now says so. */}
      <div className="r">
        {team.everyone ? (
          inside
        ) : (
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label={`Who is in ${team.name}`}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-3.5 text-left"
          >
            {inside}
          </button>
        )}
        {items.length > 0 && <RowMenu label={`What to do with ${team.name}`} items={items} />}
      </div>

      {open && !team.everyone && (
        <Members team={team} teams={teams} write={actions.members === "write"} onChanged={refresh} />
      )}
    </>
  );
}

/**
 * Who is in one team, and — if they may — the ways in and out.
 *
 * **Its own component because it mounts when the row opens**, which is what
 * "read when somebody opens it, and not before" means here: there is no
 * `enabled` flag to get wrong, because the hook does not exist until there is
 * a reason for it. It is exported for the same reason the git hosts pane
 * exports its rule — a static render cannot press an expander, and the
 * membership is half of what this pane is for.
 */
export function Members({
  team,
  teams,
  write,
  onChanged,
}: {
  team: Team;
  /** All of them, so none is offered as somebody to add. */
  teams: Team[];
  write: boolean;
  onChanged: () => void | Promise<unknown>;
}) {
  const [adding, setAdding] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const { data: members = [] } = useListTeamMembers(team.id);
  const add = useAddTeamMember();
  const drop = useRemoveTeamMember();

  const act = (p: Promise<unknown>) => {
    setSaid(null);
    p.then(() => void onChanged()).catch((e) => setSaid(why(e)));
  };

  return (
    <>
      {members.map((m) => (
        <div key={m.id} className="r sub">
          <Avatar name={m.username} size={21} />
          <span className="tx">
            <b>{m.username}</b>
          </span>
          <span className="path">u/{m.username}</span>
          {write && (
            <IconButton
              of={X}
              onClick={() => act(drop.mutateAsync({ id: team.id, person: m.id }))}
              label={`Take ${m.username} out of ${team.name}`}
              className="hov hover:text-brick"
            />
          )}
        </div>
      ))}

      {members.length === 0 && <p className="py-1.5 pl-12 text-ui text-mute">Nobody is in it yet.</p>}

      {said && <p className="py-1.5 pl-12 text-ui text-brick">{said}</p>}

      {write &&
        (adding ? (
          /* The picker that already exists, which offers people and teams in
             one list because a grant takes either. A team cannot be a member
             of a team, so every team's id goes into `already` — offering a row
             the server would refuse is the control this client does not draw,
             and it beats widening a shared primitive for one caller. */
          <PickPeople
            already={[...teams.map((t) => t.id), ...members.map((m) => m.id)]}
            empty="Everybody here is in it already."
            placeholder="Find somebody"
            onClose={() => setAdding(false)}
            onPick={(who) => {
              act(add.mutateAsync({ id: team.id, person: who.id }));
              setAdding(false);
            }}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2 py-1.5 pl-12">
            <button
              onClick={() => setAdding(true)}
              className="flex items-center gap-2.5 text-ui text-dim hover:text-bone"
            >
              <span className="g">
                <Icon of={Plus} size={14} />
              </span>
              Add people
            </button>
          </div>
        ))}
    </>
  );
}

/**
 * Removing a team, with what goes said first.
 *
 * **The consequence is read at the moment it is asked for.** There is no
 * team-shaped read for "what does this team reach" — the server answers grants
 * per directory — so this asks for the directory list and the grants on each,
 * once, here. On the pane that would have been a request per directory on every
 * render, for an answer almost nobody needs; `Teams.tsx`'s own membership
 * expander already takes the same line.
 *
 * **It does not claim to be the whole of what goes.** A team can also be named
 * in a per-resource exception from the sharing sheet, and `delete_team` forgets
 * those too — they are keyed by path and cannot be listed from the team. So the
 * directories are named and the rest is described.
 *
 * `.dlg` rather than a sheet: it is a question with a yes, which is what that
 * card is, and the only reason it is not `useConfirm` is that the body has to
 * be read off the server before it can be written.
 */
function DeleteTeam({
  team,
  onClose,
  onDone,
}: {
  team: Team;
  onClose: () => void;
  onDone: () => void;
}) {
  const bin = useDeleteTeam();
  const directories = useDirectories();
  /* **One query per directory, declared together** — `Repos.tsx` set this
     precedent for the same reason: a component per directory would have to
     exist only to hold a hook, and each of these keeps its own cache entry, so
     the Directories pane does not re-ask for what this already fetched. */
  const answers = useQueries({
    queries: directories.data.map((d) => getListGrantsQueryOptions(d.id)),
  });
  const [said, setSaid] = useState<string | null>(null);

  const reading = directories.loading || answers.some((a) => a.isPending);
  /* **A read that failed is not an answer of "none".** `answers[i].data` is
     undefined whether a directory holds no grants or could not be asked, and
     `grantsHeldBy` cannot tell those apart — so a failure on one directory
     used to render *nobody loses access* over an irreversible delete, and the
     people who did lose it found out afterwards.

     Not fatal, deliberately — and **the reason first written here was wrong**,
     so it is worth replacing rather than deleting. It said an administrator
     who is only a Viewer somewhere would be refused every time, leaving a team
     they wanted gone undeletable. That cannot happen: `may_administer`
     (`crates/ft-server/src/api/access.rs:93`) short-circuits for an
     administrator of the organisation — the directory exists, or it is a 404 —
     and this dialog is drawn for nobody else. **There is no 403 path to this
     state at all.**

     The real reason is narrower and still holds: a read can fail for causes
     that are nobody's permissions — a timeout, a 5xx, a directory removed
     between the list and the grants on it. **This dialog's job is to state the
     consequence, not to gate on it**, so a read that failed must not become a
     functional refusal of an unrelated delete. It says what it does not know
     and lets an administrator decide knowing it, which is what *the
     consequence stated before confirming* has to mean when the consequence
     cannot be read. `consequenceState` carries the same correction. */
  const consequence = consequenceState(
    reading,
    !!directories.error || answers.some((a) => a.isError),
  );
  const held = grantsHeldBy(
    team.id,
    directories.data.map((d, i) => ({
      directory: d,
      grants: ((answers[i]?.data ?? []) as Grant[]).map((g) => ({
        subjectKind: g.subjectKind,
        subjectId: g.subjectId,
      })),
    })),
  );

  const go = () => {
    setSaid(null);
    bin
      .mutateAsync({ id: team.id })
      .then(() => onDone())
      .catch((e) => setSaid(why(e)));
  };

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-start justify-center bg-scrim pt-[18vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal className="dlg">
        <div>
          <h2>Remove {team.name}?</h2>
          <div className="say">
            {consequence === "reading" ? (
              <p>Reading what it can reach…</p>
            ) : consequence === "unread" ? (
              <p>
                <b>What this team reaches could not be read.</b> Removing it may withdraw access
                this cannot list. {howMany(team.members)} stop being in it either way.
              </p>
            ) : held.length === 0 ? (
              <p>
                It holds no grants, so <b>nobody loses access</b>. {howMany(team.members)} stop being
                in it, and the name becomes free for somebody to use again.
              </p>
            ) : (
              <>
                <p>
                  <b>
                    {howMany(team.members)} lose what this team let them reach.
                  </b>{" "}
                  Its grants go with it, and so does anything shared with the team directly. Nothing
                  filed in those directories is deleted.
                </p>
                {/* The directories by name, because *which* is what changes the
                    decision — a team on one directory nobody uses and a team on
                    the one everything is filed in are the same row otherwise. */}
                <ul>
                  {held.map((g) => (
                    <li key={g.slug}>
                      {g.name} <span className="font-mono text-mute">d/{g.slug}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {said && <p className="!text-brick">{said}</p>}
          </div>
        </div>
        <div className="dlgfoot">
          <button onClick={onClose} className="btn quiet">
            Cancel
          </button>
          <button
            disabled={reading || bin.isPending}
            onClick={go}
            className="btn harm disabled:opacity-50"
          >
            {bin.isPending ? "Removing…" : "Remove it"}
          </button>
        </div>
      </div>
    </div>
  );
}

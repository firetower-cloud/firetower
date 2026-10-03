"use client";

/**
 * Groups to hand access to.
 *
 * A team exists so that access given to five people is one row rather than five
 * that drift apart the moment somebody joins. What a team is *for* — reaching a
 * directory — is on the Access page; this one is only about who is in it, which
 * is a fact about the organisation and so an administrator's.
 *
 * `Everyone` is here and cannot be touched. It has no membership rows at all:
 * whoever is in the organisation now is who it means, which is what stops
 * somebody being added to the company and not to it.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Search, Trash2, Users, UsersRound } from "lucide-react";
import {
  getListTeamMembersQueryKey,
  getListTeamsQueryKey,
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useListColleagues,
  useListTeamMembers,
  useListTeams,
  useRemoveTeamMember,
  useRenameTeam,
} from "@/src/api/generated/access/access";
import type { Team } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";
import { eachOf, useSelection } from "@/src/selection";
import {
  Avatar,
  Badge,
  Body,
  Bulk,
  Button,
  Cell,
  Checkbox,
  Empty,
  Head,
  HeadCell,
  Input,
  Panel,
  RowMenu,
  Table,
  TableRow,
} from "@/components/ui";
import { Modal } from "@/components/Modal";
import { Toolbar, Trouble } from "./Shared";

const why = (e: unknown) => (e instanceof ApiError ? e.message : "That didn't work.");

export function Teams() {
  const cache = useQueryClient();
  const { data: teams = [], isPending } = useListTeams();
  const remove = useDeleteTeam();
  const refresh = () => cache.invalidateQueries({ queryKey: getListTeamsQueryKey() });

  const [find, setFind] = useState("");
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Team | null>(null);
  const [editing, setEditing] = useState<Team | null>(null);
  const [removing, setRemoving] = useState<Team[] | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);

  const shown = useMemo(
    () => teams.filter((t) => t.name.toLowerCase().includes(find.trim().toLowerCase())),
    [teams, find],
  );
  // Nothing can be done to `Everyone`, so it gets no box.
  const actionable = useMemo(() => shown.filter((t) => !t.everyone), [shown]);
  const pick = useSelection(actionable.map((t) => t.id));
  const chosen = useMemo(() => teams.filter((t) => pick.has(t.id)), [teams, pick]);

  const run = async (over: Team[], act: (t: Team) => Promise<unknown>) => {
    setTrouble(await eachOf(over, act));
    pick.clear();
    void refresh();
  };

  return (
    <>
      <Panel>
        {pick.count > 0 ? (
          <Bulk count={pick.count} onClear={pick.clear} what={pick.count === 1 ? "team selected" : "teams selected"}>
            <Button size="sm" variant="danger" icon={Trash2} onClick={() => setRemoving(chosen)}>
              Remove
            </Button>
          </Bulk>
        ) : (
          <Toolbar
            find={find}
            onFind={setFind}
            placeholder="Find a team"
            count={`${teams.length} ${teams.length === 1 ? "team" : "teams"}`}
            action={
              <Button icon={UsersRound} onClick={() => setAdding(true)}>
                Add a team
              </Button>
            }
          />
        )}

        {isPending ? (
          <p className="px-4 py-6 text-ui text-mute">Reading…</p>
        ) : shown.length === 0 ? (
          <div className="p-4">
            <Empty icon={Search}>No team here is called “{find}”.</Empty>
          </div>
        ) : (
          <Table>
            <Head>
              <HeadCell tight>
                <Checkbox
                  label="Every team"
                  checked={pick.every}
                  indeterminate={pick.some}
                  onChange={pick.all}
                  disabled={actionable.length === 0}
                />
              </HeadCell>
              <HeadCell>Team</HeadCell>
              <HeadCell>Members</HeadCell>
              <HeadCell tight />
            </Head>
            <Body>
              {shown.map((t) => (
                <TableRow key={t.id} selected={pick.has(t.id)}>
                  <Cell tight>
                    {!t.everyone && (
                      <Checkbox
                        label={t.name}
                        checked={pick.has(t.id)}
                        onChange={(on) => pick.toggle(t.id, on)}
                      />
                    )}
                  </Cell>
                  <Cell>
                    <span className="flex items-center gap-2">
                      <span className="truncate text-bone">{t.name}</span>
                      {t.everyone && <Badge tone="slate">Everybody</Badge>}
                    </span>
                  </Cell>
                  <Cell>
                    <span className="text-dim">
                      {t.members} {t.members === 1 ? "person" : "people"}
                    </span>
                    {t.everyone && (
                      <span className="ml-2 text-meta text-mute">kept up to date by itself</span>
                    )}
                  </Cell>
                  <Cell tight>
                    {!t.everyone && (
                      <RowMenu
                        label={`What to do with ${t.name}`}
                        items={[
                          { label: "Members", icon: Users, onClick: () => setEditing(t) },
                          { label: "Rename", icon: Pencil, onClick: () => setRenaming(t) },
                          { separator: true },
                          {
                            label: "Remove",
                            icon: Trash2,
                            danger: true,
                            note: "Takes its access with it",
                            onClick: () => setRemoving([t]),
                          },
                        ]}
                      />
                    )}
                  </Cell>
                </TableRow>
              ))}
            </Body>
          </Table>
        )}
        <Trouble>{trouble}</Trouble>
      </Panel>

      {adding && (
        <Name
          title="Add a team"
          body="Empty to begin with. Put people in it, then give it access to a directory."
          placeholder="Backend"
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}

      {renaming && (
        <Name
          title={`Rename ${renaming.name}`}
          team={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            void refresh();
          }}
        />
      )}

      {editing && (
        <Members
          team={editing}
          onClose={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}

      {removing && (
        <Modal
          title={removing.length === 1 ? `Remove ${removing[0].name}?` : `Remove ${removing.length} teams?`}
          onClose={() => setRemoving(null)}
        >
          <p className="text-ui text-dim">
            Everything these could reach, they stop being able to reach — the grants go with them.
            Nobody’s account is touched, and nothing filed anywhere is deleted.
          </p>
          <ul className="mt-4 flex flex-wrap gap-1.5">
            {removing.map((t) => (
              <li key={t.id}>
                <Badge>{t.name}</Badge>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="quiet" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                const over = removing;
                setRemoving(null);
                void run(over, (t) => remove.mutateAsync({ id: t.id }));
              }}
            >
              Remove
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Add and rename are the same form; which one it is comes from `team`. */
function Name({
  title,
  body,
  placeholder,
  team,
  onClose,
  onDone,
}: {
  title: string;
  body?: string;
  placeholder?: string;
  team?: Team;
  onClose: () => void;
  onDone: () => void;
}) {
  const create = useCreateTeam();
  const rename = useRenameTeam();
  const [name, setName] = useState(team?.name ?? "");
  const busy = create.isPending || rename.isPending;
  const error = create.error ?? rename.error;

  const go = () => {
    if (!name.trim() || busy) return;
    const data = { name: name.trim() };
    const done = { onSuccess: onDone };
    if (team) rename.mutate({ id: team.id, data }, done);
    else create.mutate({ data }, done);
  };

  return (
    <Modal title={title} onClose={onClose}>
      {body && <p className="text-ui text-dim">{body}</p>}
      <Input
        value={name}
        onChange={setName}
        placeholder={placeholder}
        autoFocus
        className={`w-full ${body ? "mt-4" : ""}`}
        onKeyDown={(e) => e.key === "Enter" && go()}
      />
      {error ? <Trouble>{why(error)}</Trouble> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!name.trim() || name.trim() === team?.name || busy}
          onClick={go}
        >
          {team ? "Save" : "Add"}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Who is in a team, as one list of everybody with a verb each.
 *
 * Not checkboxes. Everywhere else in this screen a ticked box means "about to
 * act on this", and here it would mean "already in the team" — the same mark
 * for two different ideas, one row apart. A button that says what it will do
 * cannot be read the wrong way.
 */
function Members({ team, onClose }: { team: Team; onClose: () => void }) {
  const cache = useQueryClient();
  const { data: colleagues = [] } = useListColleagues();
  const { data: members = [] } = useListTeamMembers(team.id);
  const add = useAddTeamMember();
  const drop = useRemoveTeamMember();
  const [find, setFind] = useState("");
  const [trouble, setTrouble] = useState<string | null>(null);
  const refresh = () => cache.invalidateQueries({ queryKey: getListTeamMembersQueryKey(team.id) });

  const shown = colleagues.filter((c) =>
    c.username.toLowerCase().includes(find.trim().toLowerCase()),
  );

  return (
    <Modal title={`Who is in ${team.name}`} onClose={onClose}>
      <p className="text-ui text-dim">
        {members.length} of {colleagues.length} — everything this team has been given access to,
        these people can reach.
      </p>

      <Input
        value={find}
        onChange={setFind}
        placeholder="Find somebody"
        className="mt-4 w-full"
      />

      <ul className="mt-3 max-h-[19rem] divide-y divide-line-soft overflow-y-auto">
        {shown.map((c) => {
          const inside = members.some((m) => m.id === c.id);
          return (
            <li key={c.id} className="flex items-center gap-2.5 py-2">
              <Avatar name={c.username} />
              <span className="min-w-0 flex-1 truncate text-ui text-bone">{c.username}</span>
              <Button
                size="sm"
                variant={inside ? "quiet" : "default"}
                disabled={add.isPending || drop.isPending}
                onClick={() => {
                  setTrouble(null);
                  const p = inside
                    ? drop.mutateAsync({ id: team.id, person: c.id })
                    : add.mutateAsync({ id: team.id, person: c.id });
                  p.then(() => refresh()).catch((e) => setTrouble(why(e)));
                }}
              >
                {inside ? "Take out" : "Put in"}
              </Button>
            </li>
          );
        })}
        {shown.length === 0 && <li className="py-3 text-ui text-mute">Nobody by that name.</li>}
      </ul>

      {trouble && <p className="mt-3 text-meta text-brick">{trouble}</p>}

      <div className="mt-5 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}

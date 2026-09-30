/**
 * The teams a grant can be held by, and who is in each.
 *
 * **`Everyone` is not a list of people.** It has no membership rows, because
 * the membership that has to be true is "however many people exist right now" —
 * so it is drawn without an expander and without controls. A team you could add
 * somebody to would imply somebody could be left out of it.
 *
 * A member reads this; an administrator changes it. Who is in a team is what a
 * grant resolves through, so it is the organisation's decision.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus, UsersRound, X } from "lucide-react";
import { Icon } from "~/components/ui";
import {
  getListTeamMembersQueryKey,
  getListTeamsQueryKey,
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useListTeamMembers,
  useListTeams,
  useRemoveTeamMember,
} from "~/api/generated/access/access";
import { useMe } from "~/api/generated/auth/auth";
import type { Team } from "~/api/generated/model";
import { Face, PickPeople } from "~/ui/PickPeople";
import { Rows, Section } from "~/ui/config/bits";
import { useConfirm } from "~/ui/Confirm";
import { why } from "~/data";

export function Teams() {
  const cache = useQueryClient();
  const me = useMe();
  const admin = me.data?.user.role === "admin";
  const q = useListTeams();
  const make = useCreateTeam();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const refresh = () => cache.invalidateQueries({ queryKey: getListTeamsQueryKey() });

  return (
    <Section
      title="Teams"
      note="A team holds a grant, so access handed to five people is one row rather than five."
      action={
        admin && (
          <button
            onClick={() => {
              setAdding((v) => !v);
              make.reset();
            }}
            className="control border border-line bg-raise text-ui text-bone hover:bg-overlay"
          >
            <Icon of={Plus} size={12} />
            New team
          </button>
        )
      }
    >
      {adding && (
        <div className="px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What to call it"
              className="w-56 rounded-md border border-line bg-ground px-2 py-1 text-ui text-bone focus:outline-none"
            />
            <button
              disabled={!name.trim() || make.isPending}
              onClick={() =>
                make.mutate(
                  { data: { name: name.trim() } },
                  {
                    onSuccess: () => {
                      setName("");
                      setAdding(false);
                      void refresh();
                    },
                  },
                )
              }
              className="control ml-auto border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute"
            >
              {make.isPending ? "Making…" : "Make it"}
            </button>
          </div>
          {make.isError && <p className="mt-1.5 text-meta text-brick">{why(make.error)}</p>}
        </div>
      )}

      <Rows
        feed={{ data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null }}
        empty="No teams yet."
      >
        {(q.data ?? []).map((t) => (
          <One key={t.id} team={t as Team} admin={admin} onChange={refresh} />
        ))}
      </Rows>
    </Section>
  );
}

function One({ team, admin, onChange }: { team: Team; admin: boolean; onChange: () => void }) {
  const cache = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  // Read when somebody opens it, and not before — every team's members on
  // arrival is the shape of request this screen was reorganised to stop making.
  const { data: members = [] } = useListTeamMembers(team.id, {
    query: { enabled: open && !team.everyone },
  });
  const put = useAddTeamMember();
  const drop = useRemoveTeamMember();
  const bin = useDeleteTeam();
  const refresh = () =>
    Promise.all([
      cache.invalidateQueries({ queryKey: getListTeamMembersQueryKey(team.id) }),
      Promise.resolve(onChange()),
    ]);

  const act = (p: Promise<unknown>) => {
    setTrouble(null);
    p.then(() => void refresh()).catch((e) => setTrouble(why(e)));
  };

  return (
    <>
      <div className="flex items-center gap-2.5 pr-3.5 pl-3.5 hover:bg-raise">
        <button
          disabled={team.everyone}
          onClick={() => setOpen((v) => !v)}
          aria-label={`Who is in ${team.name}`}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 text-left disabled:cursor-default"
        >
          <span className="grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full border border-line bg-overlay text-dim">
            <Icon of={UsersRound} size={12} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui text-bone">{team.name}</span>
            {trouble && <span className="block text-micro text-brick">{trouble}</span>}
          </span>
          <span className="shrink-0 text-micro text-mute">
            {team.everyone
              ? "everybody here, always"
              : `${team.members} ${team.members === 1 ? "person" : "people"}`}
          </span>
          {!team.everyone && <Icon of={open ? ChevronDown : ChevronRight} size={12} />}
        </button>
        {admin && !team.everyone && (
          <button
            onClick={() =>
              void confirm({
                title: `Remove ${team.name}?`,
                body: "Every grant this team holds goes with it. Nobody loses their account, and anything they reach another way they keep.",
                action: "Remove the team",
                tone: "danger",
              }).then((ok) => ok && act(bin.mutateAsync({ id: team.id })))
            }
            className="shrink-0 py-2.5 pl-2 text-meta text-mute hover:text-brick"
          >
            Remove
          </button>
        )}
      </div>

      {open && !team.everyone && (
        <>
          {members.map((m) => (
            <div key={m.id} className="flex items-center gap-2.5 py-1.5 pr-3.5 pl-9">
              <Face who={{ name: m.username, kind: "person" }} />
              <span className="min-w-0 flex-1 truncate text-ui text-text">{m.username}</span>
              {admin && (
                <button
                  onClick={() => act(drop.mutateAsync({ id: team.id, person: m.id }))}
                  aria-label={`Take ${m.username} out of ${team.name}`}
                  className="shrink-0 text-mute hover:text-brick"
                >
                  <Icon of={X} size={12} />
                </button>
              )}
            </div>
          ))}
          {admin &&
            (adding ? (
              <PickPeople
                already={members.map((m) => m.id)}
                empty="Everybody here is in it already."
                onClose={() => setAdding(false)}
                onPick={(w) => {
                  act(put.mutateAsync({ id: team.id, person: w.id }));
                  setAdding(false);
                }}
              />
            ) : (
              <button
                onClick={() => setAdding(true)}
                className="flex w-full items-center gap-2.5 py-1.5 pr-3.5 pl-9 text-left text-ui text-mute hover:text-dim"
              >
                <span className="grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full border border-line bg-overlay">
                  <Icon of={Plus} size={12} />
                </span>
                Add somebody…
              </button>
            ))}
        </>
      )}
    </>
  );
}

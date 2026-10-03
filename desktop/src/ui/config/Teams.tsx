/**
 * The teams a grant can be held by, and who is in each. Read, and only read.
 *
 * **A team is people-shaped.** It outlives every resource it was ever granted
 * on, and saying who is in one is a statement about the organisation rather
 * than about any piece of work — so it is made and changed on the
 * administration site, beside the accounts it names.
 *
 * Granting a team access to a directory is the opposite: that is resource-
 * shaped, it belongs beside the thing being shared, and it stays here.
 *
 * `Everyone` has no membership rows, because the membership that has to be true
 * is "however many people exist right now" — so it is drawn without an
 * expander. A team you could open and count would imply somebody could be left
 * out of it.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, UsersRound } from "lucide-react";
import { Icon } from "~/components/ui";
import { useListTeamMembers, useListTeams } from "~/api/generated/access/access";
import { useMe } from "~/api/generated/auth/auth";
import type { Team } from "~/api/generated/model";
import type { Backend } from "~/fleet";
import { Face } from "~/ui/PickPeople";
import { ManageOnTheWeb, Rows, Section } from "~/ui/config/bits";
import { why } from "~/data";

export function Teams({ backend }: { backend: Backend }) {
  const q = useListTeams();
  const me = useMe();

  return (
    <Section
      title="Teams"
      note="A team holds a grant, so access handed to five people is one row rather than five. Who is in one is decided on the administration site."
      action={<ManageOnTheWeb url={backend.url} may={me.data?.user.role === "admin"} />}
    >
      <Rows
        feed={{ data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null }}
        empty="No teams yet."
      >
        {(q.data ?? []).map((t) => (
          <One key={t.id} team={t as Team} />
        ))}
      </Rows>
    </Section>
  );
}

function One({ team }: { team: Team }) {
  const [open, setOpen] = useState(false);
  // Read when somebody opens it, and not before.
  const { data: members = [] } = useListTeamMembers(team.id, {
    query: { enabled: open && !team.everyone },
  });

  return (
    <>
      <button
        disabled={team.everyone}
        onClick={() => setOpen((v) => !v)}
        aria-label={`Who is in ${team.name}`}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-raise disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full border border-line bg-overlay text-dim">
          <Icon of={UsersRound} size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate text-ui text-bone">{team.name}</span>
        <span className="shrink-0 text-micro text-mute">
          {team.everyone
            ? "everybody here, always"
            : `${team.members} ${team.members === 1 ? "person" : "people"}`}
        </span>
        {!team.everyone && <Icon of={open ? ChevronDown : ChevronRight} size={12} />}
      </button>

      {open &&
        !team.everyone &&
        members.map((m) => (
          <div key={m.id} className="flex items-center gap-2.5 py-1.5 pr-3.5 pl-9">
            <Face who={{ name: m.username, kind: "person" }} />
            <span className="min-w-0 flex-1 truncate text-ui text-text">{m.username}</span>
          </div>
        ))}
    </>
  );
}

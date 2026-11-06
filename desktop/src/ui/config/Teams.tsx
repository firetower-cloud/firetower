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
import { Avatar, Icon } from "~/components/ui";
import { useListTeamMembers, useListTeams } from "~/api/generated/access/access";
import { useMe } from "~/api/generated/auth/auth";
import type { Team } from "~/api/generated/model";
import type { Backend } from "~/fleet";
import { Group, ManageOnTheWeb, Rows, Section, WhereTo } from "~/ui/config/bits";
import { why } from "~/data";

export function Teams({ backend }: { backend: Backend }) {
  const q = useListTeams();
  const me = useMe();

  return (
    <Section
      title="Teams"
      note="A team holds a grant, so access handed to five people is one row rather than five."
      action={<ManageOnTheWeb url={backend.url} may={me.data?.user.role === "admin"} />}
    >
      <Group>
        <Rows
          feed={{ data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null }}
          empty="No teams yet."
        >
          {(q.data ?? []).map((t) => (
            <One key={t.id} team={t as Team} />
          ))}
        </Rows>
      </Group>

      <WhereTo>
        Who is in a team is decided on the administration site, beside the accounts it names — a
        team <b>outlives every resource it was ever granted on</b>. Granting one access to a
        directory is the opposite, and stays here.
      </WhereTo>
    </Section>
  );
}

function One({ team }: { team: Team }) {
  const [open, setOpen] = useState(false);
  // Read when somebody opens it, and not before.
  const { data: members = [] } = useListTeamMembers(team.id, {
    query: { enabled: open && !team.everyone },
  });

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
        <s>
          {team.everyone
            ? "everybody here, always"
            : `${team.members} ${team.members === 1 ? "person" : "people"}`}
        </s>
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
      {team.everyone ? (
        <div className="r">{inside}</div>
      ) : (
        <button onClick={() => setOpen((v) => !v)} aria-label={`Who is in ${team.name}`} className="r">
          {inside}
        </button>
      )}

      {open &&
        !team.everyone &&
        members.map((m) => (
          <div key={m.id} className="r sub">
            <Avatar name={m.username} size={21} />
            <span className="tx">
              <b>{m.username}</b>
            </span>
            <span className="path">u/{m.username}</span>
          </div>
        ))}
    </>
  );
}

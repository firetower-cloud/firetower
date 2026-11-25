/**
 * The teams a grant can be held by, and who is in each. Read, for now.
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
 * **The *Manage on the web* link and the paragraph naming the administration
 * site have both gone**, with the control itself — they existed only because
 * this screen could not do the thing being asked of it, and sending somebody to
 * a second application is no longer an answer to anything. Making this pane
 * write is its own change and is not this one: what is left here is the read it
 * always was, in its new home, saying nothing untrue about where a team comes
 * from.
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
import type { Team } from "~/api/generated/model";
import { Group, Rows, Section, WhereTo } from "~/ui/config/bits";
import { trouble, why } from "~/data";

export function Teams() {
  const q = useListTeams();
  const blank = !q.isPending && !q.error && (q.data ?? []).length === 0;

  return (
    <Section
      title="Teams"
      note="A team holds a grant, so access handed to five people is one row rather than five."
      settling={q.isPending}
      trouble={trouble(q.error)}
      error={q.error ? why(q.error) : null}
    >
      <Group>
        <Rows
          feed={{ data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null }}
          icon={UsersRound}
          empty="No teams yet"
        >
          {(q.data ?? []).map((t) => (
            <One key={t.id} team={t as Team} />
          ))}
        </Rows>
      </Group>

      {/* The distinction, which is the thing a reader of this list actually
          needs and the one part of the old paragraph that was never about
          going somewhere else. Never beside a blank: it is about operating
          teams this reader does not have yet. */}
      {!blank && (
        <WhereTo>
          A team <b>outlives every resource it was ever granted on</b>, so who is in one is a
          statement about the organisation. Granting a team access to a directory is the opposite —
          it belongs beside the thing being shared — and the two are kept apart on purpose.
        </WhereTo>
      )}
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

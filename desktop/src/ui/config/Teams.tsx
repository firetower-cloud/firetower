/**
 * The teams a grant can be held by.
 *
 * `Everyone` has no membership rows — the membership that has to be true is
 * "however many people exist right now" — so it says the whole organisation
 * rather than a number that would go stale the next time somebody joins.
 */
import { UsersRound } from "lucide-react";
import { Icon } from "~/components/ui";
import { useListTeams } from "~/api/generated/access/access";
import { Rows, Section } from "~/ui/config/bits";
import { why } from "~/data";

export function Teams() {
  const q = useListTeams();

  return (
    <Section
      title="Teams"
      note="A team holds a grant, so access handed to five people is one row rather than five. An administrator decides who is in one."
    >
      <Rows
        feed={{ data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null }}
        empty="No teams yet."
      >
        {(q.data ?? []).map((t) => (
          <div key={t.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
            <span className="grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full border border-line bg-overlay text-dim">
              <Icon of={UsersRound} size={12} />
            </span>
            <span className="min-w-0 flex-1 truncate text-ui text-bone">{t.name}</span>
            <span className="shrink-0 text-meta text-mute">
              {t.everyone
                ? "everybody here"
                : `${t.members} ${t.members === 1 ? "person" : "people"}`}
            </span>
          </div>
        ))}
      </Rows>
    </Section>
  );
}

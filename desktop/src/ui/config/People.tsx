/**
 * Everybody with an account on this Firetower.
 *
 * A read, and only a read. Adding and removing people is an administrator's and
 * lives on the web — what the desktop needs is the answer to "who is `ana`",
 * which every sharing decision on this machine depends on and which nothing
 * here could tell you before.
 */
import { useListColleagues } from "~/api/generated/access/access";
import { useMe } from "~/api/generated/auth/auth";
import { Face } from "~/ui/PickPeople";
import { Rows, Section } from "~/ui/config/bits";
import { why } from "~/data";

export function People() {
  const q = useListColleagues();
  const me = useMe();
  const mine = me.data?.user;

  return (
    <Section
      title="People"
      note="Everybody with an account on this Firetower. An account exists on this server only."
    >
      <Rows
        feed={{ data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null }}
        empty="Nobody else yet."
      >
        {(q.data ?? []).map((p) => (
          <div key={p.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
            <Face who={{ name: p.username, kind: "person" }} />
            <span className="min-w-0 flex-1 truncate text-ui text-bone">{p.username}</span>
            <span className="shrink-0 font-mono text-micro text-mute">u/{p.username}</span>
            {p.id === mine?.id && <span className="shrink-0 text-meta text-dim">you</span>}
          </div>
        ))}
      </Rows>
    </Section>
  );
}

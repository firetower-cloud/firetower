/**
 * Everybody with an account on this Firetower. Read, and only read.
 *
 * **Who exists is the organisation's, not this seat's.** The desktop is this
 * Firetower seen from where one person sits — their machines, their
 * credentials, the things they can reach. A person is not anybody's seat: an
 * account is provisioned, carries a role, and outlives every resource it was
 * ever granted on. That belongs to the administration site, which is reachable
 * from any browser, including from a machine with no client installed.
 *
 * It is still *shown* here, because the sharing sheet raises "who is ana?"
 * constantly and the answer should not be a browser away. Reading is part of
 * the seat; changing is not.
 */
import { useListColleagues } from "~/api/generated/access/access";
import { useMe } from "~/api/generated/auth/auth";
import type { Backend } from "~/fleet";
import { Face } from "~/ui/PickPeople";
import { ManageOnTheWeb, Rows, Section } from "~/ui/config/bits";
import { why } from "~/data";

export function People({ backend }: { backend: Backend }) {
  const q = useListColleagues();
  const me = useMe();

  return (
    <Section
      title="People"
      note="Everybody with an account on this Firetower. Accounts, roles and who may sign in are decided on the administration site."
      action={<ManageOnTheWeb url={backend.url} may={me.data?.user.role === "admin"} />}
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
            {p.id === me.data?.user.id && <span className="shrink-0 text-meta text-dim">you</span>}
          </div>
        ))}
      </Rows>
    </Section>
  );
}

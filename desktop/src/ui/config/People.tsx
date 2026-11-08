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
import { useState } from "react";
import { Search, UserRound } from "lucide-react";
import { useListColleagues } from "~/api/generated/access/access";
import { useMe } from "~/api/generated/auth/auth";
import type { Backend } from "~/fleet";
import { Avatar } from "~/components/ui";
import { Group, ManageOnTheWeb, Note, Rows, Section, Typed, WhereTo } from "~/ui/config/bits";
import { trouble, why } from "~/data";

export function People({ backend }: { backend: Backend }) {
  const q = useListColleagues();
  const me = useMe();
  const [find, setFind] = useState("");
  const shown = (q.data ?? []).filter((p) => p.username.toLowerCase().includes(find.trim().toLowerCase()));
  /* Nothing there, and nothing wrong. Narrowed to nothing is not this state —
     there *are* people — and it gets a `Note` instead. */
  const blank = !q.isPending && !q.error && (q.data ?? []).length === 0;

  return (
    <Section
      title="People"
      note="Everybody with an account on this Firetower."
      settling={q.isPending}
      trouble={trouble(q.error)}
      error={q.error ? why(q.error) : null}
      action={
        <>
          {/* **Not over the blank.** There is nothing to narrow, and the one
              way out stays: the blank's own sentence names where an account
              is made. */}
          {!blank && <Find value={find} onChange={setFind} />}
          <ManageOnTheWeb url={backend.url} may={me.data?.user?.role === "admin"} />
        </>
      }
    >
      <Group>
        <Rows
          feed={{ data: shown, loading: q.isPending, error: q.error ? why(q.error) : null }}
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
              "Nobody else yet"
            )
          }
          note="Accounts are made on the administration site."
        >
          {shown.map((p) => (
            <div key={p.id} className="r">
              <Avatar name={p.username} />
              <span className="tx">
                <b>{p.username}</b>
              </span>
              <span className="path">u/{p.username}</span>
              {p.id === me.data?.user?.id && <span className="said">you</span>}
            </div>
          ))}
        </Rows>
      </Group>

      {/* The line that keeps a reader's screen from reading as withheld. The
          roles and the invite control are not drawn and not greyed; this says
          where they are.

          **Never beside a blank**, though: a paragraph about changing roles
          and disabling accounts is about operating a list this reader does not
          have, and the blank's own sentence already names the place. */}
      {!blank && (
        <WhereTo>
          This is the list the sharing sheet reads from. To <b>invite somebody, change a role, or
          disable an account</b>, use the administration site — those outlive every piece of work,
          so they are the organisation&rsquo;s rather than this seat&rsquo;s.
        </WhereTo>
      )}
    </Section>
  );
}

/** Find somebody. Beside the way out to the web, where the drawing puts it. */
function Find({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="find">
      <Search className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Find somebody"
        aria-label="Find somebody"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent placeholder:text-mute focus:outline-none"
      />
    </label>
  );
}

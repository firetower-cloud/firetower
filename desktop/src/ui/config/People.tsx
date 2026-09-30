/**
 * Everybody with an account on this Firetower, and what an administrator may do
 * about them.
 *
 * **Switching somebody off is the ordinary answer, and removing them is not.**
 * A disabled person cannot sign in and keeps everything they made, so the work
 * survives them leaving; deleting takes their workspaces with it. The screen
 * says that where the choice is made rather than in a help page, and the two
 * are not drawn as equals.
 *
 * A member sees the list and nothing else. Who else is on the server is not a
 * secret — the sharing sheet names them all day — but adding, disabling and
 * removing are the organisation's.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Icon } from "~/components/ui";
import {
  getListUsersQueryKey,
  useChangeUser,
  useCreateUser,
  useDeleteUser,
  useListUsers,
  useResetUserPassword,
} from "~/api/generated/organization/organization";
import { useListColleagues } from "~/api/generated/access/access";
import { useMe } from "~/api/generated/auth/auth";
import type { User } from "~/api/generated/model";
import { Face } from "~/ui/PickPeople";
import { Rows, Section } from "~/ui/config/bits";
import { useConfirm } from "~/ui/Confirm";
import { why } from "~/data";

export function People() {
  const me = useMe();
  const admin = me.data?.user.role === "admin";
  return admin ? <Everybody mine={me.data?.user.id} /> : <JustNames />;
}

/** What a member sees: who is here, and no controls the server would refuse. */
function JustNames() {
  const q = useListColleagues();
  return (
    <Section title="People" note="Everybody with an account on this Firetower.">
      <Rows
        feed={{ data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null }}
        empty="Nobody else yet."
      >
        {(q.data ?? []).map((p) => (
          <div key={p.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
            <Face who={{ name: p.username, kind: "person" }} />
            <span className="min-w-0 flex-1 truncate text-ui text-bone">{p.username}</span>
            <span className="shrink-0 font-mono text-micro text-mute">u/{p.username}</span>
          </div>
        ))}
      </Rows>
    </Section>
  );
}

function Everybody({ mine }: { mine?: string }) {
  const cache = useQueryClient();
  const q = useListUsers();
  const add = useCreateUser();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("member");
  /* Shown once and never again: the server generates it and does not keep a
     readable copy, so a password dismissed before it is read is one that has to
     be reset. It stays on screen until somebody closes it. */
  const [fresh, setFresh] = useState<{ username: string; password: string } | null>(null);
  const refresh = () => cache.invalidateQueries({ queryKey: getListUsersQueryKey() });

  return (
    <Section
      title="People"
      note="Everybody with an account on this Firetower. An account exists on this server only."
      action={
        <button
          onClick={() => {
            setAdding((v) => !v);
            add.reset();
          }}
          className="control border border-line bg-raise text-ui text-bone hover:bg-overlay"
        >
          <Icon of={Plus} size={12} />
          Add someone
        </button>
      }
    >
      {adding && (
        <div className="px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="username"
              className="w-48 rounded-md border border-line bg-ground px-2 py-1 text-ui text-bone focus:outline-none"
            />
            <div className="track">
              <button data-on={role === "member"} onClick={() => setRole("member")}>
                Member
              </button>
              <button data-on={role === "admin"} onClick={() => setRole("admin")}>
                Administrator
              </button>
            </div>
            <button
              disabled={!name.trim() || add.isPending}
              onClick={() =>
                add.mutate(
                  { data: { username: name.trim(), role } },
                  {
                    onSuccess: (r) => {
                      setFresh({ username: r.user.username, password: r.password });
                      setName("");
                      setAdding(false);
                      void refresh();
                    },
                  },
                )
              }
              className="control ml-auto border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute"
            >
              {add.isPending ? "Adding…" : "Add"}
            </button>
          </div>
          {add.isError && <p className="mt-1.5 text-meta text-brick">{why(add.error)}</p>}
        </div>
      )}

      {fresh && (
        <div className="flex items-center gap-2.5 bg-slate-tint px-3.5 py-2.5 shadow-[inset_2px_0_0_var(--color-slate)]">
          <span className="min-w-0 flex-1 text-ui text-bone">
            {fresh.username} can sign in with{" "}
            <span className="font-mono text-text">{fresh.password}</span>
            <span className="block text-micro text-mute">
              Shown once. They are asked to change it when they first sign in.
            </span>
          </span>
          <button onClick={() => setFresh(null)} className="shrink-0 text-meta text-mute hover:text-bone">
            Done
          </button>
        </div>
      )}

      <Rows
        feed={{ data: q.data ?? [], loading: q.isPending, error: q.error ? why(q.error) : null }}
        empty="Nobody yet."
      >
        {(q.data ?? []).map((p) => (
          <Line key={p.id} person={p as User} you={p.id === mine} onChange={refresh} />
        ))}
      </Rows>
    </Section>
  );
}

function Line({ person, you, onChange }: { person: User; you: boolean; onChange: () => void }) {
  const confirm = useConfirm();
  const change = useChangeUser();
  const reset = useResetUserPassword();
  const remove = useDeleteUser();
  const [trouble, setTrouble] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const busy = change.isPending || reset.isPending || remove.isPending;

  const act = <T,>(p: Promise<T>, then?: (r: T) => void) => {
    setTrouble(null);
    p.then((r) => {
      then?.(r);
      onChange();
    }).catch((e) => setTrouble(why(e)));
  };

  return (
    <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5">
      <Face who={{ name: person.username, kind: "person" }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui text-bone">
          {person.username} <span className="font-mono text-micro text-mute">u/{person.slug}</span>
        </span>
        <span className="block text-micro text-mute">
          {person.disabled ? "switched off · cannot sign in" : person.role === "admin" ? "administrator" : "member"}
          {you && " · you"}
          {shown && <span className="text-text"> · new password {shown}</span>}
          {trouble && <span className="text-brick"> · {trouble}</span>}
        </span>
      </span>

      {/* Nothing offered against yourself. An administrator who takes their own
          role away, or switches themselves off, has locked the one account that
          could put it back. */}
      {you ? (
        <span className="shrink-0 text-meta text-dim">Administrator</span>
      ) : (
        <>
          <div className="track shrink-0">
            <button
              data-on={person.role === "member"}
              disabled={busy}
              onClick={() => act(change.mutateAsync({ id: person.id, data: { role: "member" } }))}
            >
              Member
            </button>
            <button
              data-on={person.role === "admin"}
              disabled={busy}
              onClick={() => act(change.mutateAsync({ id: person.id, data: { role: "admin" } }))}
            >
              Admin
            </button>
          </div>
          <button
            disabled={busy}
            onClick={() =>
              act(change.mutateAsync({ id: person.id, data: { disabled: !person.disabled } }))
            }
            className="control shrink-0 border border-line bg-raise text-meta text-text hover:bg-overlay"
          >
            {person.disabled ? "Switch on" : "Switch off"}
          </button>
          <button
            disabled={busy}
            onClick={() =>
              act(reset.mutateAsync({ id: person.id }), (r) => setShown(r.password))
            }
            className="control shrink-0 text-meta text-mute hover:text-bone"
          >
            Reset password
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void confirm({
                title: `Remove ${person.username} for good?`,
                body: (
                  <>
                    Everything they made goes with them — workspaces, secrets, the lot.{" "}
                    <b className="text-bone">Switching them off</b> stops them signing in and keeps
                    all of it, which is almost always what is wanted.
                  </>
                ),
                action: "Remove them",
                tone: "danger",
              }).then((ok) => ok && act(remove.mutateAsync({ id: person.id })))
            }
            className="control shrink-0 text-meta text-mute hover:text-brick"
          >
            Remove
          </button>
        </>
      )}
    </div>
  );
}

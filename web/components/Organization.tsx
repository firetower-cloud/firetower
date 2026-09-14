"use client";

/**
 * The organisation, and who is in it — the administrator's page.
 *
 * Its name, and the users: add one (a password made by the server and shown
 * once), make them an administrator or a member, switch them off or back on,
 * hand them a new temporary password, or remove them. The server refuses the
 * things that would lock the room — the last administrator cannot be
 * demoted, switched off or removed — and this page shows the sentence it
 * gives.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMe, getMeQueryKey } from "@/src/api/generated/auth/auth";
import {
  getListUsersQueryKey,
  useChangeUser,
  useCreateUser,
  useDeleteUser,
  useListUsers,
  useRenameOrganization,
  useResetUserPassword,
} from "@/src/api/generated/organization/organization";
import type { User } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";
import { Button } from "@/components/ui/Button";
import { Card, CardHead } from "@/components/ui/Card";
import { Input } from "@/components/ui/Field";
import { Copyable } from "@/components/ui/Copy";
import { Modal } from "@/components/Modal";

const why = (e: unknown) => (e instanceof ApiError ? e.message : "That didn't work.");

export function Organization() {
  const { data: me } = useMe();
  if (me && me.user.role !== "admin") {
    return (
      <div className="mx-auto max-w-[640px] px-6 py-8">
        <h1 className="text-display text-bone">Organisation</h1>
        <p className="mt-2 text-ui text-dim">Only an administrator can change the organisation or its users.</p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-[720px] px-6 py-8">
      <h1 className="text-display text-bone">Organisation</h1>
      <Name current={me?.organization?.name ?? ""} />
      <Users me={me?.user} />
    </div>
  );
}

function Name({ current }: { current: string }) {
  const cache = useQueryClient();
  const rename = useRenameOrganization();
  const [name, setName] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const value = name ?? current;
  return (
    <Card className="mt-7">
      <CardHead note="What the app shows for this server.">Name</CardHead>
      <div className="flex items-center gap-2 px-4 pb-4">
        <Input value={value} onChange={(v) => setName(v)} placeholder="The organisation" className="max-w-[24rem]" />
        <Button
          disabled={!value.trim() || value.trim() === current || rename.isPending}
          onClick={() =>
            rename.mutate(
              { data: { name: value.trim() } },
              {
                onSuccess: () => {
                  setName(null);
                  setSaved(true);
                  setTimeout(() => setSaved(false), 1500);
                  void cache.invalidateQueries({ queryKey: getMeQueryKey() });
                },
              },
            )
          }
        >
          {rename.isPending ? "Saving…" : saved ? "Saved" : "Save"}
        </Button>
        {rename.error ? <span className="text-meta text-brick">{why(rename.error)}</span> : null}
      </div>
    </Card>
  );
}

function Users({ me }: { me?: User }) {
  const cache = useQueryClient();
  const { data: users = [], isPending, error } = useListUsers();
  const create = useCreateUser();
  const change = useChangeUser();
  const reset = useResetUserPassword();
  const remove = useDeleteUser();
  const refresh = () => cache.invalidateQueries({ queryKey: getListUsersQueryKey() });
  const [adding, setAdding] = useState(false);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  /** A password made by the server, shown once. */
  const [handed, setHanded] = useState<{ username: string; password: string; fresh: boolean } | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [removing, setRemoving] = useState<User | null>(null);

  const act = (p: Promise<unknown>) => {
    setTrouble(null);
    p.then(() => refresh()).catch((e) => setTrouble(why(e)));
  };

  return (
    <Card className="mt-4">
      <CardHead
        note="Who can sign in to this Firetower, from the app or here."
        aside={
          <Button size="sm" onClick={() => setAdding(true)}>
            Add a user
          </Button>
        }
      >
        Users
      </CardHead>
      {isPending && <p className="px-4 pb-4 text-ui text-mute">Reading…</p>}
      {error ? <p className="px-4 pb-4 text-ui text-brick">{why(error)}</p> : null}
      <ul className="divide-y divide-line-soft">
        {users.map((u) => {
          const self = u.id === me?.id;
          return (
            <li key={u.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 ${u.disabled ? "opacity-60" : ""}`}>
              <span className="min-w-0 flex-1">
                <span className="text-ui text-bone">{u.username}</span>
                <span className="ml-2 text-meta text-mute">
                  {u.role === "admin" ? "administrator" : "member"}
                  {self ? " · you" : ""}
                  {u.disabled ? " · switched off" : u.mustChangePassword ? " · has not signed in yet" : ""}
                </span>
              </span>
              {!self && (
                <span className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={change.isPending}
                    onClick={() => act(change.mutateAsync({ id: u.id, data: { role: u.role === "admin" ? "member" : "admin" } }))}
                  >
                    {u.role === "admin" ? "Make member" : "Make administrator"}
                  </Button>
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={reset.isPending}
                    onClick={() =>
                      act(reset.mutateAsync({ id: u.id }).then((r) => setHanded({ username: u.username, password: r.password, fresh: false })))
                    }
                  >
                    Reset password
                  </Button>
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={change.isPending}
                    onClick={() => act(change.mutateAsync({ id: u.id, data: { disabled: !u.disabled } }))}
                  >
                    {u.disabled ? "Switch on" : "Switch off"}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setRemoving(u)}>
                    Remove
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {trouble && <p className="px-4 pb-4 text-meta text-brick">{trouble}</p>}

      {adding && (
        <Modal title="Add a user" onClose={() => setAdding(false)}>
          <p className="text-ui text-dim">
            The server makes them a password and shows it to you once. They replace it the first time they sign in.
          </p>
          <div className="mt-4 flex flex-col gap-3">
            <Input
              value={username}
              onChange={(v) => setUsername(v)}
              placeholder="username"
              mono
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && username.trim() && submit()}
            />
            <div className="flex items-center gap-2 text-ui">
              <label className="flex items-center gap-2 text-text">
                <input type="radio" checked={role === "member"} onChange={() => setRole("member")} /> Member
              </label>
              <label className="flex items-center gap-2 text-text">
                <input type="radio" checked={role === "admin"} onChange={() => setRole("admin")} /> Administrator
              </label>
            </div>
          </div>
          {create.error ? <p className="mt-3 text-meta text-brick">{why(create.error)}</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="quiet" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button disabled={!username.trim() || create.isPending} onClick={submit}>
              {create.isPending ? "Adding…" : "Add"}
            </Button>
          </div>
        </Modal>
      )}

      {handed && (
        <Modal title={handed.fresh ? `${handed.username} is in.` : `A new password for ${handed.username}.`} onClose={() => setHanded(null)}>
          <p className="text-ui text-dim">
            Pass this on to them. It is shown once — the server keeps only its hash — and they will be asked to replace it when they sign in.
          </p>
          <div className="mt-4">
            <Copyable text={handed.password}>{handed.password}</Copyable>
          </div>
          <div className="mt-5 flex justify-end">
            <Button onClick={() => setHanded(null)}>Done</Button>
          </div>
        </Modal>
      )}

      {removing && (
        <Modal title={`Remove ${removing.username}?`} onClose={() => setRemoving(null)}>
          <p className="text-ui text-dim">
            Their workspaces and everything in them go too. If they might be back, switch them off instead — that keeps what they made.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="quiet" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                const u = removing;
                setRemoving(null);
                act(remove.mutateAsync({ id: u.id }));
              }}
            >
              Remove
            </Button>
          </div>
        </Modal>
      )}
    </Card>
  );

  function submit() {
    create.mutate(
      { data: { username: username.trim(), role } },
      {
        onSuccess: (made) => {
          setAdding(false);
          setUsername("");
          setRole("member");
          setHanded({ username: made.user.username, password: made.password, fresh: true });
          void refresh();
        },
      },
    );
  }
}

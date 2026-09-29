"use client";

/**
 * Who can sign in, and what each of them is.
 *
 * The server holds the rules that would lock the room — the last administrator
 * cannot be demoted, switched off or removed — and refuses in a sentence. This
 * screen shows that sentence rather than trying to predict it: there is one
 * place that knows, and a second guess here would be wrong the first time two
 * people changed something at once.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  KeyRound,
  Power,
  Search,
  Shield,
  ShieldOff,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useMe } from "@/src/api/generated/auth/auth";
import {
  getListUsersQueryKey,
  useChangeUser,
  useCreateUser,
  useDeleteUser,
  useListUsers,
  useResetUserPassword,
} from "@/src/api/generated/organization/organization";
import type { User } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";
import { eachOf, useSelection } from "@/src/selection";
import {
  Avatar,
  Badge,
  Body,
  Bulk,
  Button,
  Cell,
  Checkbox,
  Copyable,
  Empty,
  Head,
  HeadCell,
  Input,
  Panel,
  RowMenu,
  Table,
  TableRow,
  type Item,
} from "@/components/ui";
import { Modal } from "@/components/Modal";
import { Trouble, Toolbar } from "./Shared";

const why = (e: unknown) => (e instanceof ApiError ? e.message : "That didn't work.");

export function People() {
  const cache = useQueryClient();
  const { data: me } = useMe();
  const { data: users = [], isPending } = useListUsers();
  const change = useChangeUser();
  const reset = useResetUserPassword();
  const remove = useDeleteUser();
  const refresh = () => cache.invalidateQueries({ queryKey: getListUsersQueryKey() });

  const [find, setFind] = useState("");
  const [adding, setAdding] = useState(false);
  const [handed, setHanded] = useState<{ username: string; password: string; fresh: boolean } | null>(null);
  const [removing, setRemoving] = useState<User[] | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);

  const shown = useMemo(
    () => users.filter((u) => u.username.toLowerCase().includes(find.trim().toLowerCase())),
    [users, find],
  );

  // Never your own row. Everything a grouped action can do here is something
  // you cannot do to yourself — demote, switch off, remove — so a box that
  // could be ticked and then refused is a box that should not be there.
  const actionable = useMemo(
    () => shown.filter((u) => u.id !== me?.user.id),
    [shown, me],
  );
  const pick = useSelection(actionable.map((u) => u.id));
  const chosen = useMemo(
    () => users.filter((u) => pick.has(u.id)),
    [users, pick],
  );

  const run = async (over: User[], act: (u: User) => Promise<unknown>) => {
    setTrouble(await eachOf(over, act));
    pick.clear();
    void refresh();
  };

  const setRole = (over: User[], role: "admin" | "member") =>
    run(over, (u) => change.mutateAsync({ id: u.id, data: { role } }));
  const setDisabled = (over: User[], disabled: boolean) =>
    run(over, (u) => change.mutateAsync({ id: u.id, data: { disabled } }));

  return (
    <>
      <Panel>
        {pick.count > 0 ? (
          <Bulk count={pick.count} onClear={pick.clear}>
            <Button size="sm" variant="quiet" icon={Shield} onClick={() => setRole(chosen, "admin")}>
              Make administrator
            </Button>
            <Button size="sm" variant="quiet" icon={ShieldOff} onClick={() => setRole(chosen, "member")}>
              Make member
            </Button>
            <Button size="sm" variant="quiet" icon={Power} onClick={() => setDisabled(chosen, !chosen.every((u) => u.disabled))}>
              {chosen.every((u) => u.disabled) ? "Switch on" : "Switch off"}
            </Button>
            <Button size="sm" variant="danger" icon={Trash2} onClick={() => setRemoving(chosen)}>
              Remove
            </Button>
          </Bulk>
        ) : (
          <Toolbar
            find={find}
            onFind={setFind}
            placeholder="Find somebody"
            count={`${users.length} ${users.length === 1 ? "person" : "people"}`}
            action={
              <Button icon={UserPlus} onClick={() => setAdding(true)}>
                Add a person
              </Button>
            }
          />
        )}

        {isPending ? (
          <p className="px-4 py-6 text-ui text-mute">Reading…</p>
        ) : shown.length === 0 ? (
          <div className="p-4">
            <Empty icon={Search}>Nobody here is called “{find}”.</Empty>
          </div>
        ) : (
          <Table>
            <Head>
              <HeadCell tight>
                <Checkbox
                  label="Everybody"
                  checked={pick.every}
                  indeterminate={pick.some}
                  onChange={pick.all}
                  disabled={actionable.length === 0}
                />
              </HeadCell>
              <HeadCell>Person</HeadCell>
              <HeadCell>Role</HeadCell>
              <HeadCell>State</HeadCell>
              <HeadCell tight />
            </Head>
            <Body>
              {shown.map((u) => {
                const self = u.id === me?.user.id;
                return (
                  <TableRow key={u.id} selected={pick.has(u.id)} muted={u.disabled}>
                    <Cell tight>
                      {!self && (
                        <Checkbox
                          label={u.username}
                          checked={pick.has(u.id)}
                          onChange={(on) => pick.toggle(u.id, on)}
                        />
                      )}
                    </Cell>
                    <Cell>
                      <span className="flex items-center gap-2.5">
                        <Avatar name={u.username} />
                        <span className="truncate text-bone">{u.username}</span>
                        {self && <span className="text-meta text-mute">you</span>}
                      </span>
                    </Cell>
                    <Cell>
                      {u.role === "admin" ? (
                        <Badge tone="slate">Administrator</Badge>
                      ) : (
                        <span className="text-dim">Member</span>
                      )}
                    </Cell>
                    <Cell>
                      {u.disabled ? (
                        <Badge tone="brick">Switched off</Badge>
                      ) : u.mustChangePassword ? (
                        <span className="text-meta text-mute">Has not signed in yet</span>
                      ) : (
                        <span className="text-meta text-mute">Active</span>
                      )}
                    </Cell>
                    <Cell tight>
                      {!self && (
                        <RowMenu
                          label={`What to do with ${u.username}`}
                          items={[
                            {
                              label: u.role === "admin" ? "Make a member" : "Make an administrator",
                              icon: u.role === "admin" ? ShieldOff : Shield,
                              onClick: () => setRole([u], u.role === "admin" ? "member" : "admin"),
                            },
                            {
                              label: "Reset password",
                              icon: KeyRound,
                              onClick: () =>
                                reset
                                  .mutateAsync({ id: u.id })
                                  .then((r) =>
                                    setHanded({ username: u.username, password: r.password, fresh: false }),
                                  )
                                  .catch((e) => setTrouble(why(e))),
                            },
                            {
                              label: u.disabled ? "Switch on" : "Switch off",
                              icon: Power,
                              note: u.disabled ? undefined : "Keeps what they made",
                              onClick: () => setDisabled([u], !u.disabled),
                            },
                            { separator: true },
                            {
                              label: "Remove",
                              icon: Trash2,
                              danger: true,
                              onClick: () => setRemoving([u]),
                            },
                          ] satisfies Item[]}
                        />
                      )}
                    </Cell>
                  </TableRow>
                );
              })}
            </Body>
          </Table>
        )}
        <Trouble>{trouble}</Trouble>
      </Panel>

      {adding && (
        <Add
          onClose={() => setAdding(false)}
          onDone={(username, password) => {
            setAdding(false);
            setHanded({ username, password, fresh: true });
            void refresh();
          }}
        />
      )}

      {handed && (
        <Modal
          title={handed.fresh ? `${handed.username} is in` : `A new password for ${handed.username}`}
          onClose={() => setHanded(null)}
        >
          <p className="text-ui text-dim">
            Pass this on. It is shown once — the server keeps only its hash — and they are asked to
            replace it when they sign in.
          </p>
          <div className="mt-4">
            <Copyable text={handed.password}>{handed.password}</Copyable>
          </div>
          <div className="mt-5 flex justify-end">
            <Button variant="primary" onClick={() => setHanded(null)}>
              Done
            </Button>
          </div>
        </Modal>
      )}

      {removing && (
        <Modal
          title={
            removing.length === 1 ? `Remove ${removing[0].username}?` : `Remove ${removing.length} people?`
          }
          onClose={() => setRemoving(null)}
        >
          {/* Said plainly, because a directory makes it look otherwise: a
              workspace filed in `d/backend` belongs to that directory, and
              somebody reading the Access screen would reasonably expect it to
              stay. It does not. A session is an agent run under a person — its
              conversation, the subscription it spent, the git identity on its
              commits — and none of that outlives the account. Their machines do
              stay: compute is real and the organisation is still on it. */}
          <p className="text-ui text-dim">
            Their workspaces go too, including ones they filed in a directory, and so do their
            credentials. Machines they added stay, in <span className="font-mono">Shared</span>. If
            they might be back, switch them off instead — that keeps what they made.
          </p>
          <ul className="mt-4 flex flex-wrap gap-1.5">
            {removing.map((u) => (
              <li key={u.id}>
                <Badge>{u.username}</Badge>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="quiet" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                const over = removing;
                setRemoving(null);
                void run(over, (u) => remove.mutateAsync({ id: u.id }));
              }}
            >
              Remove
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Add({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (username: string, password: string) => void;
}) {
  const create = useCreateUser();
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");

  const go = () =>
    create.mutate(
      { data: { username: username.trim(), role } },
      { onSuccess: (made) => onDone(made.user.username, made.password) },
    );

  return (
    <Modal title="Add a person" onClose={onClose}>
      <p className="text-ui text-dim">
        The server makes them a password and shows it to you once. They replace it the first time
        they sign in.
      </p>

      <div className="mt-4 space-y-4">
        <label className="block">
          <span className="eyebrow">Username</span>
          <Input
            value={username}
            onChange={setUsername}
            placeholder="ana"
            mono
            autoFocus
            className="mt-1.5 w-full"
            onKeyDown={(e) => e.key === "Enter" && username.trim() && go()}
          />
        </label>

        <div>
          <span className="eyebrow">Role</span>
          <div className="mt-1.5 space-y-1.5">
            <Pick
              on={role === "member"}
              onClick={() => setRole("member")}
              title="Member"
              body="Uses Firetower, shares their own work, and cannot change the organisation."
            />
            <Pick
              on={role === "admin"}
              onClick={() => setRole("admin")}
              title="Administrator"
              body="Also adds people, defines teams, and can reach a directory nobody administers."
            />
          </div>
        </div>
      </div>

      {create.error ? <Trouble>{why(create.error)}</Trouble> : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!username.trim() || create.isPending} onClick={go}>
          {create.isPending ? "Adding…" : "Add"}
        </Button>
      </div>
    </Modal>
  );
}

/** One of two, with the reason to choose it written underneath. */
function Pick({
  on,
  onClick,
  title,
  body,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-md border px-3.5 py-2.5 text-left transition-colors duration-150 ${
        on ? "border-line bg-raise" : "border-line-soft hover:border-line hover:bg-raise/50"
      }`}
    >
      <span
        className={`mt-1 grid h-[13px] w-[13px] shrink-0 place-items-center rounded-full border ${
          on ? "border-bone" : "border-line"
        }`}
      >
        {on && <span className="h-[5px] w-[5px] rounded-full bg-bone" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-ui ${on ? "text-bone" : "text-text"}`}>{title}</span>
        <span className="mt-0.5 block text-meta text-dim">{body}</span>
      </span>
    </button>
  );
}

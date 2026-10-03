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
  Check,
  Clipboard,
  Eye,
  EyeOff,
  KeyRound,
  Power,
  Search,
  Shield,
  ShieldOff,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useMe } from "@/src/api/generated/auth/auth";
import { useSetupState } from "@/src/api/generated/setup/setup";
import {
  getListUsersQueryKey,
  useChangeUser,
  useCreateUser,
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
  Empty,
  Head,
  HeadCell,
  IconButton,
  Input,
  Panel,
  RowMenu,
  Table,
  TableRow,
  type Item,
} from "@/components/ui";
import { write } from "@/components/ui/Copy";
import { Modal } from "@/components/Modal";
import { Offboard } from "@/components/org/Offboard";
import { Confirm, type Ask } from "@/components/Confirm";
import { Trouble, Toolbar } from "./Shared";

const why = (e: unknown) => (e instanceof ApiError ? e.message : "That didn't work.");

export function People() {
  const cache = useQueryClient();
  const { data: me } = useMe();
  const { data: users = [], isPending } = useListUsers();
  const change = useChangeUser();
  const reset = useResetUserPassword();
  const refresh = () => cache.invalidateQueries({ queryKey: getListUsersQueryKey() });

  const [find, setFind] = useState("");
  const [adding, setAdding] = useState(false);
  const [handed, setHanded] = useState<{ username: string; password: string; fresh: boolean } | null>(null);
  /* One at a time. Removing somebody now means deciding about everything
     that is theirs, and a decision per row cannot be made for four people at
     once — see `Offboard`. */
  const [leaving, setLeaving] = useState<User | null>(null);
  const [addressing, setAddressing] = useState<User | null>(null);
  const { data: setup } = useSetupState();
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

  const [asking, setAsking] = useState<Ask | null>(null);

  const run = async (over: User[], act: (u: User) => Promise<unknown>) => {
    setTrouble(await eachOf(over, act));
    pick.clear();
    void refresh();
  };

  const setRole = (over: User[], role: "admin" | "member") =>
    run(over, (u) => change.mutateAsync({ id: u.id, data: { role } }));
  const setDisabled = (over: User[], disabled: boolean) =>
    run(over, (u) => change.mutateAsync({ id: u.id, data: { disabled } }));

  /* Nothing here happens on the way past. Each of these ends sessions, moves
     what somebody can reach, or stops a password working, and the body of the
     question is where the part you would not have guessed is said. */
  const who = (over: User[]) =>
    over.length === 1 ? over[0].username : `${over.length} people`;

  const askRole = (over: User[], role: "admin" | "member") =>
    setAsking({
      title: role === "admin" ? `Make ${who(over)} an administrator?` : `Make ${who(over)} a member?`,
      action: role === "admin" ? "Make an administrator" : "Make a member",
      body:
        role === "admin" ? (
          <>
            <strong className="text-bone">{who(over)}</strong> will be able to add and remove
            people, change anybody&apos;s role, manage teams and directories, and upgrade this
            Firetower.
          </>
        ) : (
          <>
            <strong className="text-bone">{who(over)}</strong> keeps everything they own and every
            directory they administer. What goes is the organisation&apos;s own: people, teams,
            directories, and upgrading this Firetower.
          </>
        ),
      run: () => setRole(over, role),
    });

  const askDisabled = (over: User[], disabled: boolean) =>
    setAsking({
      title: disabled ? `Switch off ${who(over)}?` : `Switch ${who(over)} back on?`,
      action: disabled ? "Switch off" : "Switch on",
      tone: disabled ? "danger" : undefined,
      body: disabled ? (
        <>
          <strong className="text-bone">{who(over)}</strong> will not be able to sign in, and every
          session of theirs ends now — on the web, the desktop and the phone. Everything they made
          stays exactly where it is, and you can switch them back on at any time.
        </>
      ) : (
        <>
          <strong className="text-bone">{who(over)}</strong> will be able to sign in again, with the
          password they already had.
        </>
      ),
      run: () => setDisabled(over, disabled),
    });

  const askReset = (u: User) =>
    setAsking({
      title: `Reset ${u.username}'s password?`,
      action: "Reset password",
      tone: "danger",
      body: (
        <>
          A new temporary password is made and shown to you <em>once</em>. The one{" "}
          <strong className="text-bone">{u.username}</strong> has now stops working, every session
          of theirs ends, and they will have to choose their own the next time they sign in here.
        </>
      ),
      run: () =>
        reset
          .mutateAsync({ id: u.id })
          .then((r) => setHanded({ username: u.username, password: r.password, fresh: false }))
          .catch((e) => setTrouble(why(e))),
    });

  return (
    <>
      <Panel>
        {pick.count > 0 ? (
          <Bulk count={pick.count} onClear={pick.clear}>
            <Button size="sm" variant="quiet" icon={Shield} onClick={() => askRole(chosen, "admin")}>
              Make administrator
            </Button>
            <Button size="sm" variant="quiet" icon={ShieldOff} onClick={() => askRole(chosen, "member")}>
              Make member
            </Button>
            <Button size="sm" variant="quiet" icon={Power} onClick={() => askDisabled(chosen, !chosen.every((u) => u.disabled))}>
              {chosen.every((u) => u.disabled) ? "Switch on" : "Switch off"}
            </Button>
            {/* No bulk remove. Removing somebody is now a decision about every
                single thing that is theirs, and four people at once is the
                shape of the problem this replaced: a selection, one button,
                and whatever it swept discovered afterwards. Switching off
                stays, because it takes nothing away. */}
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
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-bone">{u.username}</span>
                            {self && <span className="text-meta text-mute">you</span>}
                          </span>
                          {/* Absent on accounts made before one was asked for.
                              Said rather than filled in: a placeholder cannot
                              be told apart from a real address that bounces. */}
                          {u.email ? (
                            <span className="block truncate text-meta text-mute">{u.email}</span>
                          ) : (
                            <button
                              onClick={() => setAddressing(u)}
                              className="block text-meta text-ember hover:underline"
                            >
                              no email · add one
                            </button>
                          )}
                        </span>
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
                              onClick: () => askRole([u], u.role === "admin" ? "member" : "admin"),
                            },
                            {
                              label: "Reset password",
                              icon: KeyRound,
                              onClick: () => askReset(u),
                            },
                            {
                              label: u.disabled ? "Switch on" : "Switch off",
                              icon: Power,
                              note: u.disabled ? undefined : "Keeps what they made",
                              onClick: () => askDisabled([u], !u.disabled),
                            },
                            { separator: true },
                            {
                              label: "Remove",
                              icon: Trash2,
                              danger: true,
                              onClick: () => setLeaving(u),
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
        /* The server's own answer, not this tab's address. The interface and
           the control plane are two addresses — two ports in development, two
           names behind a proxy — so a sign-in link read off `window.location`
           is right only on the installation it happens to be served from. */
        <HandOver who={handed} where={setup?.publicUrl ?? ""} onClose={() => setHanded(null)} />
      )}

      {addressing && (
        <GiveAnAddress person={addressing} onClose={() => setAddressing(null)} onDone={refresh} />
      )}

      {leaving && <Offboard person={leaving} onClose={() => setLeaving(null)} />}

      {/* Last, so it sits over anything else open. Removing somebody has its
          own screen — `Offboard` is a confirmation with a decision in it — so
          it is not routed through this. */}
      <Confirm ask={asking} onClose={() => setAsking(null)} />
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
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const ready = username.trim() !== "" && email.trim() !== "";

  const go = () => {
    if (!ready) return;
    create.mutate(
      { data: { username: username.trim(), email: email.trim(), role } },
      { onSuccess: (made) => onDone(made.user.username, made.password) },
    );
  };

  return (
    <Modal title="Add a person" onClose={onClose}>
      <p className="text-ui text-dim">
        The server makes them a password and shows it to you once. They replace it the first time
        they sign in.
      </p>

      <div className="mt-4 space-y-4">
        <label className="block">
          <span className="eyebrow">
            Username <span className="text-ember">required</span>
          </span>
          <Input
            value={username}
            onChange={setUsername}
            placeholder="ana"
            mono
            autoFocus
            className="mt-1.5 w-full"
            onKeyDown={(e) => e.key === "Enter" && go()}
          />
          <p className="mt-1.5 text-meta text-mute">
            What they sign in with. It cannot be changed later.
          </p>
        </label>

        {/* Required from now on, and absent on the accounts that predate it.
            Nothing is invented for those: a placeholder cannot be told apart
            from a real address that bounces, which is the question that
            matters the first time anything is sent. */}
        <label className="block">
          <span className="eyebrow">
            Email <span className="text-ember">required</span>
          </span>
          <Input
            value={email}
            onChange={setEmail}
            placeholder="ana@westlabs.com"
            className="mt-1.5 w-full"
            onKeyDown={(e) => e.key === "Enter" && go()}
          />
          <p className="mt-1.5 text-meta text-mute">
            Where we will write to them. One address, one account.
          </p>
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
        <Button variant="primary" disabled={!ready || create.isPending} onClick={go}>
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

/**
 * The password, and something to send with it.
 *
 * **Shown once, because the server keeps only a hash.** A screen that treats
 * that casually produces an account nobody can get into, so the password is a
 * field rather than a sentence: masked, revealable, and copyable without being
 * selected by hand.
 *
 * The message underneath is the thing somebody actually needs: a note they can
 * paste to a colleague. The password is hidden in it and whole on the
 * clipboard, so reading the screen over somebody's shoulder gets you nothing
 * while the paste still works.
 *
 * It sends them to the Firetower itself rather than to a download. Signing in
 * is where the apps are offered, so that is one link instead of two and the
 * order is the one that works.
 */
function HandOver({
  who,
  where,
  onClose,
}: {
  who: { username: string; password: string; fresh: boolean };
  where: string;
  onClose: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  /* Flashes on the button that was pressed, and goes away again, so pressing it
     twice looks like two things rather than one. */
  const [took, setTook] = useState<"password" | "note" | null>(null);
  const hidden = "•".repeat(16);
  const note = (password: string) =>
    `Hi ${who.username}, you have an account on Firetower.\n\n` +
    `Sign in at ${where}\n` +
    `Username: ${who.username}\n` +
    `Password: ${password}  (you will be asked to change it)\n\n` +
    `Once you are signed in there, you can download the Mac or Windows app from the same page.`;

  /* Through `write`, which the rest of the product already uses: it falls back
     to a selection when `navigator.clipboard` is missing or refuses, and says
     so when neither works. The first version here called the clipboard directly
     with no catch, so a refusal did nothing and reported nothing — which is
     indistinguishable from a dead button. */
  const put = (what: "password" | "note", text: string, confirm: string) => {
    void write(text).then((ok) => {
      setSaid(ok ? confirm : "That didn't copy. Select it and copy by hand.");
      if (!ok) return;
      setTook(what);
      window.setTimeout(() => setTook((now) => (now === what ? null : now)), 1600);
    });
  };

  return (
    <Modal
      title={who.fresh ? `${who.username} is in` : `A new password for ${who.username}`}
      onClose={onClose}
    >
      <p className="text-ui text-dim">
        This password is shown once. The server keeps no readable copy.
      </p>

      <div className="mt-4">
        <span className="eyebrow">Temporary password</span>
        <div className="mt-1.5 flex items-stretch gap-2">
          <div className="flex min-w-0 flex-1 items-center overflow-hidden rounded-lg border border-line bg-ground px-3 py-2 font-mono text-ui text-bone">
            <span className="truncate select-all">{shown ? who.password : hidden}</span>
          </div>
          {/* The two controls act on the same thing, so they sit together and
              apart from it. */}
          <div className="flex shrink-0 items-stretch gap-0.5">
            <IconButton
              of={shown ? EyeOff : Eye}
              label={shown ? "Hide it" : "Show it"}
              onClick={() => setShown((v) => !v)}
            />
            {/* The button answers, not only the line underneath it. A tick two
                lines away from the thing you pressed is read by nobody. */}
            <IconButton
              of={took === "password" ? Check : Clipboard}
              label={took === "password" ? "Copied" : "Copy the password"}
              className={took === "password" ? "text-sage" : ""}
              onClick={() => put("password", who.password, "Password copied.")}
            />
          </div>
        </div>
        <p className="mt-1.5 text-meta text-mute">
          {said ?? "They are asked to change it the first time they sign in."}
        </p>
      </div>

      <div className="mt-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow">Send them this</span>
          <Button
            size="sm"
            variant="quiet"
            className="ml-auto"
            onClick={() =>
              put("note", note(who.password), "Copied, with the password in it.")
            }
          >
            {took === "note" ? "Copied" : "Copy instructions with password"}
          </Button>
        </div>
        <pre className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border border-line bg-ground px-3 py-2.5 text-meta leading-relaxed whitespace-pre-wrap text-text">
          {note(hidden)}
        </pre>
        <p className="mt-1.5 text-meta text-mute">
          The password is hidden here and copied in full.
        </p>
      </div>

      <div className="mt-5 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}

/** An address for somebody who predates them being asked for. */
function GiveAnAddress({
  person,
  onClose,
  onDone,
}: {
  person: User;
  onClose: () => void;
  onDone: () => void;
}) {
  const change = useChangeUser();
  const [email, setEmail] = useState("");

  const go = () => {
    if (!email.trim()) return;
    change.mutate(
      { id: person.id, data: { email: email.trim() } },
      {
        onSuccess: () => {
          onDone();
          onClose();
        },
      },
    );
  };

  return (
    <Modal title={`An email for ${person.username}`} onClose={onClose}>
      <p className="text-ui text-dim">
        This account was made before one was asked for. Nothing was invented for it.
      </p>
      <Input
        value={email}
        onChange={setEmail}
        placeholder={`${person.username}@westlabs.com`}
        autoFocus
        className="mt-4 w-full"
        onKeyDown={(e) => e.key === "Enter" && go()}
      />
      {change.error ? <Trouble>{why(change.error)}</Trouble> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!email.trim() || change.isPending} onClick={go}>
          {change.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </Modal>
  );
}

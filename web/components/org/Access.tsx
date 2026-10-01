"use client";

/**
 * Directories, and who can see into them.
 *
 * **Two panes, not a dialog.** Deciding who can reach a body of work means
 * reading a list of people while looking at what is filed there and what you
 * may do yourself. A modal can hold one of those three at a time, and the
 * moment a level has to be changed on four rows it becomes a dialog with a
 * table in it, floating over the table it came from.
 *
 * Everybody gets this page, unlike the two beside it. Sharing your own work is
 * the reason the feature exists, and making it an administrator's errand is how
 * it comes not to happen.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  KeyRound,
  Pencil,
  Search,
  Server,
  Sparkles,
  Trash2,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { useMe } from "@/src/api/generated/auth/auth";
import {
  getListDirectoriesQueryKey,
  getListGrantsQueryKey,
  getListItemsQueryKey,
  useCreateDirectory,
  useDeleteDirectory,
  useFileItems,
  useUnfileItems,
  useListColleagues,
  useListDirectories,
  useListGrants,
  useListItems,
  useListTeams,
  useRenameDirectory,
  useRevokeGrant,
  useSetGrant,
} from "@/src/api/generated/access/access";
import type { Directory, Filed, FiledKind, Grant, Level, SubjectKind } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";
import { destinations, mayMove } from "@/src/filing";
import { eachOf, useSelection } from "@/src/selection";
import {
  Avatar,
  Badge,
  Body,
  Bulk,
  Button,
  Cell,
  Checkbox,
  Choose,
  Empty,
  Head,
  HeadCell,
  Icon,
  Input,
  MenuButton,
  Panel,
  RowMenu,
  Table,
  TableRow,
} from "@/components/ui";
import { Modal } from "@/components/Modal";
import { Toolbar, Trouble } from "./Shared";

const why = (e: unknown) => (e instanceof ApiError ? e.message : "That didn't work.");

/**
 * The three levels, in one word each.
 *
 * They were sentences — "Can work in it", with a line underneath saying what
 * that bought. Three roles are a thing people already know the shape of, and a
 * table of sentences reads as though the system has invented something.
 *
 * `Editor` for the middle one, not `Writer`: `writer` is what the wire and the
 * database call it, and it is the only place that word belongs.
 */
const LEVELS: { value: Level; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "writer", label: "Editor" },
  { value: "admin", label: "Admin" },
];

/** What each kind of thing is, in one word and one glyph. */
const KINDS: Record<FiledKind, { one: string; many: string; icon: typeof FolderOpen }> = {
  workspace: { one: "Workspace", many: "Workspaces", icon: Boxes },
  machine: { one: "Machine", many: "Machines", icon: Server },
  agentAccount: { one: "Agent account", many: "Agent accounts", icon: Sparkles },
  secret: { one: "Secret", many: "Secrets", icon: KeyRound },
  // Never in a directory — a repository is opened by the token of whoever
  // connected it, so there is nowhere to file one. Named here because this map
  // covers every kind the server can name, and what somebody owns is drawn
  // from the same list as what a directory holds.
  repository: { one: "Repository", many: "Repositories", icon: FolderGit2 },
};

const said = (level?: Level | null) =>
  level ? (LEVELS.find((l) => l.value === level)?.label ?? level) : "No access";

/** What is filed here, in words — the thing a grant actually applies to. */
function holds(d: Directory) {
  const parts: string[] = [];
  const say = (n: number, one: string, many = `${one}s`) =>
    n > 0 && parts.push(`${n} ${n === 1 ? one : many}`);
  say(d.workspaces, "workspace");
  say(d.hosts, "machine");
  say(d.agentAccounts, "agent account");
  say(d.secrets, "secret");
  return parts.length ? parts.join(" · ") : "Empty";
}

export function Access() {
  const cache = useQueryClient();
  const { data: directories = [], isPending } = useListDirectories();
  const create = useCreateDirectory();
  const refresh = () => cache.invalidateQueries({ queryKey: getListDirectoriesQueryKey() });

  const [find, setFind] = useState("");
  const [at, setAt] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const shown = useMemo(
    () => directories.filter((d) => d.name.toLowerCase().includes(find.trim().toLowerCase())),
    [directories, find],
  );

  // Derived rather than kept in step with an effect: a directory that has just
  // been removed stops being the answer the first time this is read, instead of
  // one render later with a blank pane in between.
  const here = shown.find((d) => d.id === at) ?? shown[0];

  return (
    <div className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start">
      <Panel>
        <Toolbar
          find={find}
          onFind={setFind}
          placeholder="Find a directory"
          action={
            <Button size="sm" icon={FolderPlus} onClick={() => setAdding(true)}>
              New
            </Button>
          }
        />
        {isPending ? (
          <p className="px-4 py-6 text-ui text-mute">Reading…</p>
        ) : shown.length === 0 ? (
          <div className="p-4">
            <Empty icon={Search}>Nothing here is called “{find}”.</Empty>
          </div>
        ) : (
          <ul className="max-h-[32rem] divide-y divide-line-soft overflow-y-auto">
            {shown.map((d) => {
              const on = d.id === here?.id;
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => setAt(d.id)}
                    className={`relative flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors duration-150 ${
                      on ? "bg-raise" : "hover:bg-raise/50"
                    }`}
                  >
                    {on && (
                      <span className="absolute top-2 bottom-2 left-0 w-[2px] rounded-full bg-bone" />
                    )}
                    <span className={on ? "text-bone" : "text-mute"}>
                      <Icon of={FolderOpen} size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-ui ${on ? "text-bone" : "text-text"}`}>
                        {d.name}
                      </span>
                      {/* The slug, because it is what appears in every path
                          under this directory and it never changes when the
                          name does. Somebody reading `d/backend/…` on a
                          workspace has to be able to find `backend` here. */}
                      <span className="block truncate text-meta text-mute">
                        d/{d.slug} · {holds(d)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {here ? (
        <Detail
          key={here.id}
          directory={here}
          directories={directories}
          onChanged={refresh}
          onGone={() => setAt(null)}
        />
      ) : (
        <Panel className="p-4">
          <Empty icon={FolderOpen}>Nothing to show.</Empty>
        </Panel>
      )}

      {adding && (
        <Modal title="A new directory" onClose={() => setAdding(false)}>
          <NewDirectory
            onClose={() => setAdding(false)}
            onDone={(id) => {
              setAdding(false);
              setAt(id);
              void refresh();
            }}
            create={create}
          />
        </Modal>
      )}
    </div>
  );
}

function NewDirectory({
  onClose,
  onDone,
  create,
}: {
  onClose: () => void;
  onDone: (id: string) => void;
  create: ReturnType<typeof useCreateDirectory>;
}) {
  const [name, setName] = useState("");
  const go = () =>
    create.mutate({ data: { name: name.trim() } }, { onSuccess: (made) => onDone(made.id) });

  return (
    <>
      <p className="text-ui text-dim">
        You administer it. Nothing is in it yet — move a workspace here, or choose it when you start
        one.
      </p>
      <Input
        value={name}
        onChange={setName}
        placeholder="Ledger work"
        autoFocus
        className="mt-4 w-full"
        onKeyDown={(e) => e.key === "Enter" && name.trim() && go()}
      />
      {create.error ? <Trouble>{why(create.error)}</Trouble> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!name.trim() || create.isPending} onClick={go}>
          Make it
        </Button>
      </div>
    </>
  );
}

/** One directory: what is in it, and who can reach it. */
function Detail({
  directory,
  directories,
  onChanged,
  onGone,
}: {
  directory: Directory;
  /** Everywhere else something in here could go. */
  directories: Directory[];
  onChanged: () => void;
  onGone: () => void;
}) {
  const cache = useQueryClient();
  const { data: me } = useMe();
  const [showing, setShowing] = useState<"who" | "what">("who");
  const { data: grants = [], isPending } = useListGrants(directory.id);
  const set = useSetGrant();
  const revoke = useRevokeGrant();
  const remove = useDeleteDirectory();

  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [giving, setGiving] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);

  // Administering the directory, or administering the organisation. The second
  // is what the server allows so that a directory whose last administrator has
  // left is fixable by somebody; hiding the controls here meant the one person
  // who could unstick it was shown a read-only screen.
  const mine = directory.level === "admin" || me?.user.role === "admin";
  const filedCount =
    directory.workspaces + directory.hosts + directory.agentAccounts + directory.secrets;
  const key = (g: Grant) => `${g.subjectKind}:${g.subjectId}`;
  const pick = useSelection(grants.map(key));
  const chosen = useMemo(() => grants.filter((g) => pick.has(key(g))), [grants, pick]);

  const refresh = () => {
    void cache.invalidateQueries({ queryKey: getListGrantsQueryKey(directory.id) });
    onChanged();
  };

  const run = async (over: Grant[], act: (g: Grant) => Promise<unknown>) => {
    setTrouble(await eachOf(over, act));
    pick.clear();
    refresh();
  };

  const change = (over: Grant[], level: Level) =>
    run(over, (g) =>
      set.mutateAsync({
        id: directory.id,
        data: { subjectKind: g.subjectKind, subjectId: g.subjectId, level },
      }),
    );

  const take = (over: Grant[]) =>
    run(over, (g) =>
      revoke.mutateAsync({ id: directory.id, kind: g.subjectKind, subject: g.subjectId }),
    );

  return (
    <>
      <Panel>
        <div className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-ui font-medium text-bone">{directory.name}</h2>
              <Badge tone="slate">d/{directory.slug}</Badge>
              <Badge>{said(directory.level)}</Badge>
            </div>
            <p className="mt-0.5 text-meta text-mute">
              {holds(directory)} — a grant here applies to all of it, and to
              anything filed deeper under the same root.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {mine && (
              <Button size="sm" icon={UserPlus} onClick={() => setGiving(true)}>
                Give access
              </Button>
            )}
            {mine && (
              <RowMenu
                label={`What to do with ${directory.name}`}
                items={[
                  { label: "Rename", icon: Pencil, onClick: () => setRenaming(true) },
                  { separator: true },
                  {
                    label: "Remove directory",
                    icon: Trash2,
                    danger: true,
                    disabled: filedCount > 0,
                    note:
                      filedCount > 0
                        ? "Move what is in it somewhere else first"
                        : undefined,
                    onClick: () => setRemoving(true),
                  },
                ]}
              />
            )}
          </div>
        </div>

        {/* Two halves of one question. Who can reach this, and what "this" is
            — a grant is meaningless without the second, and a list of contents
            is trivia without the first. */}
        <div className="flex items-center gap-1 border-b border-line px-2">
          {(
            [
              ["who", `Who can see it${grants.length ? ` · ${grants.length}` : ""}`],
              ["what", `What is in it${filedCount ? ` · ${filedCount}` : ""}`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setShowing(key)}
              className={`-mb-px border-b px-2.5 py-2 text-ui transition-colors duration-150 ${
                showing === key
                  ? "border-bone text-bone"
                  : "border-transparent text-dim hover:text-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {showing === "what" ? (
          <Contents
            directory={directory}
            directories={directories}
            onMoved={() => {
              void cache.invalidateQueries({ queryKey: getListItemsQueryKey(directory.id) });
              onChanged();
            }}
          />
        ) : (
          <>
        {pick.count > 0 && mine && (
          <Bulk count={pick.count} onClear={pick.clear}>
            <Choose
              label="Change access for everything selected"
              value={chosen[0]?.level ?? "viewer"}
              options={LEVELS}
              onChange={(level) => change(chosen, level)}
            />
            <Button size="sm" variant="danger" icon={Trash2} onClick={() => take(chosen)}>
              Take access away
            </Button>
          </Bulk>
        )}

        {isPending ? (
          <p className="px-4 py-6 text-ui text-mute">Reading…</p>
        ) : grants.length === 0 ? (
          <div className="p-4">
            <Empty
              icon={UserPlus}
              action={
                mine ? (
                  <Button variant="primary" onClick={() => setGiving(true)}>
                    Give access
                  </Button>
                ) : undefined
              }
            >
              Nobody can reach this — not even you.
            </Empty>
          </div>
        ) : (
          <Table>
            <Head>
              <HeadCell tight>
                {mine && (
                  <Checkbox
                    label="Everybody with access"
                    checked={pick.every}
                    indeterminate={pick.some}
                    onChange={pick.all}
                  />
                )}
              </HeadCell>
              <HeadCell>Who</HeadCell>
              <HeadCell>Access</HeadCell>
              <HeadCell tight />
            </Head>
            <Body>
              {grants.map((g) => (
                <TableRow key={key(g)} selected={pick.has(key(g))}>
                  <Cell tight>
                    {mine && (
                      <Checkbox
                        label={g.subjectName}
                        checked={pick.has(key(g))}
                        onChange={(on) => pick.toggle(key(g), on)}
                      />
                    )}
                  </Cell>
                  <Cell>
                    <span className="flex items-center gap-2.5">
                      {g.subjectKind === "team" ? (
                        <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-overlay text-dim">
                          <Icon of={UsersRound} size={12} />
                        </span>
                      ) : (
                        <Avatar name={g.subjectName} />
                      )}
                      <span className="truncate text-bone">{g.subjectName}</span>
                      {g.subjectKind === "team" && <span className="text-meta text-mute">team</span>}
                    </span>
                  </Cell>
                  <Cell>
                    {mine ? (
                      <Choose
                        label={`What ${g.subjectName} may do`}
                        value={g.level}
                        options={LEVELS}
                        onChange={(level) => change([g], level)}
                      />
                    ) : (
                      <span className="text-dim">{said(g.level)}</span>
                    )}
                  </Cell>
                  <Cell tight>
                    {mine && (
                      <RowMenu
                        label={`What to do with ${g.subjectName}`}
                        items={[
                          {
                            label: "Take access away",
                            icon: Trash2,
                            danger: true,
                            onClick: () => take([g]),
                          },
                        ]}
                      />
                    )}
                  </Cell>
                </TableRow>
              ))}
            </Body>
          </Table>
        )}
          </>
        )}
        <Trouble>{trouble}</Trouble>
      </Panel>

      {giving && (
        <Give
          directory={directory}
          already={grants}
          onClose={() => setGiving(false)}
          onDone={() => {
            setGiving(false);
            refresh();
          }}
        />
      )}

      {renaming && (
        <Rename directory={directory} onClose={() => setRenaming(false)} onDone={() => {
          setRenaming(false);
          refresh();
        }} />
      )}

      {removing && (
        <Modal title={`Remove ${directory.name}?`} onClose={() => setRemoving(false)}>
          <p className="text-ui text-dim">
            {directory.workspaces + directory.hosts + directory.agentAccounts + directory.secrets === 0
              ? "Nothing is filed here, so nothing else changes. Everybody who could reach it loses that."
              : `This still holds ${holds(directory).toLowerCase()}. Move them somewhere else first — the server refuses while anything is in it.`}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="quiet" onClick={() => setRemoving(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(
                  { id: directory.id },
                  {
                    onSuccess: () => {
                      setRemoving(false);
                      onGone();
                      onChanged();
                    },
                    onError: (e) => {
                      setRemoving(false);
                      setTrouble(why(e));
                    },
                  },
                )
              }
            >
              Remove
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Rename({
  directory,
  onClose,
  onDone,
}: {
  directory: Directory;
  onClose: () => void;
  onDone: () => void;
}) {
  const rename = useRenameDirectory();
  const [name, setName] = useState(directory.name);
  const go = () =>
    rename.mutate({ id: directory.id, data: { name: name.trim() } }, { onSuccess: onDone });

  return (
    <Modal title={`Rename ${directory.name}`} onClose={onClose}>
      <Input
        value={name}
        onChange={setName}
        autoFocus
        className="w-full"
        onKeyDown={(e) => e.key === "Enter" && name.trim() && go()}
      />
      {rename.error ? <Trouble>{why(rename.error)}</Trouble> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!name.trim() || name.trim() === directory.name || rename.isPending}
          onClick={go}
        >
          Save
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Give several people or teams the same access at once.
 *
 * One at a time was the old shape, and it made the common case — a team and two
 * people, on a directory somebody has just made — four trips through the same
 * dialog. Ticking is the same gesture as the table behind it, which is the
 * point of using it here too.
 */
function Give({
  directory,
  already,
  onClose,
  onDone,
}: {
  directory: Directory;
  already: Grant[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { data: colleagues = [] } = useListColleagues();
  const { data: teams = [] } = useListTeams();
  const set = useSetGrant();

  const [find, setFind] = useState("");
  const [level, setLevel] = useState<Level>("viewer");
  const [trouble, setTrouble] = useState<string | null>(null);

  // Only what is not already granted: a second row for the same subject cannot
  // exist, and offering it invites a refusal nobody can act on.
  const candidates = useMemo(() => {
    const taken = new Set(already.map((g) => `${g.subjectKind}:${g.subjectId}`));
    const wanted = find.trim().toLowerCase();
    return [
      ...teams.map((t) => ({
        id: `team:${t.id}`,
        kind: "team" as SubjectKind,
        subject: t.id,
        name: t.name,
        note: t.everyone ? "everybody" : `${t.members} ${t.members === 1 ? "person" : "people"}`,
      })),
      ...colleagues.map((c) => ({
        id: `person:${c.id}`,
        kind: "person" as SubjectKind,
        subject: c.id,
        name: c.username,
        note: undefined,
      })),
    ]
      .filter((c) => !taken.has(c.id))
      .filter((c) => c.name.toLowerCase().includes(wanted));
  }, [teams, colleagues, already, find]);

  const pick = useSelection(candidates.map((c) => c.id));
  const chosen = candidates.filter((c) => pick.has(c.id));

  const go = async () => {
    // The result, not the state it was just written to. `setTrouble` does not
    // change `trouble` until the next render, so reading it on the line below
    // reads the value from *this* one — which is whatever it was before the
    // attempt, and therefore closes the sheet on a refusal and keeps it open
    // after a success that follows one.
    const failed = await eachOf(chosen, (c) =>
      set.mutateAsync({
        id: directory.id,
        data: { subjectKind: c.kind, subjectId: c.subject, level },
      }),
    );
    setTrouble(failed);
    if (!failed) onDone();
  };

  return (
    <Modal title={`Give access to ${directory.name}`} onClose={onClose} wide>
      <Input value={find} onChange={setFind} placeholder="Find a person or a team" autoFocus className="w-full" />

      <ul className="mt-3 max-h-[17rem] divide-y divide-line-soft overflow-y-auto">
        {candidates.map((c) => (
          <li key={c.id}>
            {/* A div, not a button. The whole row toggles, and the checkbox in
                it is itself a button — nesting one inside the other is invalid
                HTML, and the browser does not simply tolerate it: React warns,
                hydration breaks, and a click on the row lands on neither
                control. The box stays the focusable thing, so the keyboard
                path is unchanged. */}
            <div
              onClick={() => pick.toggle(c.id, !pick.has(c.id))}
              className={`flex w-full cursor-pointer items-center gap-2.5 rounded-md px-1 py-2 text-left transition-colors duration-150 ${
                pick.has(c.id) ? "bg-raise" : "hover:bg-raise/50"
              }`}
            >
              <Checkbox
                label={c.name}
                checked={pick.has(c.id)}
                onChange={(on) => pick.toggle(c.id, on)}
              />
              {c.kind === "team" ? (
                <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-overlay text-dim">
                  <Icon of={UsersRound} size={12} />
                </span>
              ) : (
                <Avatar name={c.name} />
              )}
              <span className="min-w-0 flex-1 truncate text-ui text-bone">{c.name}</span>
              {c.note && <span className="shrink-0 text-meta text-mute">{c.note}</span>}
            </div>
          </li>
        ))}
        {candidates.length === 0 && (
          <li className="py-3 text-ui text-mute">Everybody here already has access.</li>
        )}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <span className="eyebrow">As</span>
        <Choose label="What they may do" value={level} options={LEVELS} onChange={setLevel} />
      </div>

      {trouble ? <Trouble>{trouble}</Trouble> : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={pick.count === 0 || set.isPending} onClick={go}>
          {pick.count > 1 ? `Give access to ${pick.count}` : "Give access"}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * What is filed here, and the one action that matters: putting it somewhere
 * else.
 *
 * This is the other half of the loop. Things are filed where their maker's
 * things go — a workspace in the creator's own directory, a subscription
 * beside it, a secret with the person it was sealed for — and until there was
 * a way to move them afterwards, "share this" meant "decide before you start".
 *
 * Ticking several and moving them together is the common case rather than a
 * flourish: a directory is made *after* the work it is supposed to hold.
 */
function Contents({
  directory,
  directories,
  onMoved,
}: {
  directory: Directory;
  directories: Directory[];
  onMoved: () => void;
}) {
  const { data: me } = useMe();
  const { data: items = [], isPending } = useListItems(directory.id);
  const file = useFileItems();
  const unfile = useUnfileItems();
  const [trouble, setTrouble] = useState<string | null>(null);

  /**
   * Whether things here are yours to move, and the same question `may_share`
   * asks again on the server.
   *
   * One answer for all four kinds, because everything filed here is *held by
   * this directory* — that is what filing it did — so what it takes to move one
   * out is admin here, whatever kind it is. A writer can put things in and
   * cannot take somebody else's out.
   *
   * Asked before drawing, so the control is absent rather than offered and
   * refused: a menu that always fails is worse than no menu.
   *
   * Through `mayMove` rather than reading `directory.level` here, so that this
   * screen and the desktop's answer the question with the same code.
   */
  const movable = () =>
    mayMove(`d/${directory.slug}/x`, me?.user, directories);

  const key = (i: Filed) => `${i.kind}:${i.id}`;
  // Only over what can actually be acted on, so the header box does not tick
  // rows whose only outcome is a refusal.
  const pick = useSelection(movable() ? items.map(key) : []);
  const chosen = useMemo(() => items.filter((i) => pick.has(key(i))), [items, pick]);

  // Somewhere you can follow it to, and not where it already is. Writer, not
  // admin, and deliberately a different question from `movable` — putting work
  // into a directory you can work in is ordinary; taking it out is not. The
  // server checks both ends again; this only keeps the menu honest.
  const elsewhere = destinations(directories).filter((d) => d.id !== directory.id);

  const act = async (run: Promise<unknown>) => {
    try {
      await run;
      setTrouble(null);
      pick.clear();
      onMoved();
    } catch (e) {
      setTrouble(why(e));
    }
  };

  const items_ = (what: Filed[]) => ({ items: what.map((i) => ({ kind: i.kind, id: i.id })) });

  /**
   * Moving, not copying. A thing lives at one path, so filing it elsewhere takes
   * it out of here and hands it to the directory it goes to — the labels say
   * "Move", not "Also file in", because the earlier wording described a shape
   * this no longer has.
   *
   * "Take back into my own space" is the way out: there is always somewhere for
   * a thing to be, and whoever does it owns it afterwards.
   */
  const moveMenu = (what: Filed[]) => [
    ...elsewhere.map((d) => ({
      label: `Move to ${d.name}`,
      onClick: () => void act(file.mutateAsync({ id: d.id, data: items_(what) })),
    })),
    ...(elsewhere.length ? [{ separator: true as const }] : []),
    {
      label: "Take into my own space",
      danger: true,
      onClick: () => void act(unfile.mutateAsync({ id: directory.id, data: items_(what) })),
    },
  ];

  return (
    <>
      {pick.count > 0 && (
        <Bulk count={pick.count} onClear={pick.clear}>
          <MenuButton size="sm" label="Move…" items={moveMenu(chosen)} />
        </Bulk>
      )}

      {isPending ? (
        <p className="px-4 py-6 text-ui text-mute">Reading…</p>
      ) : items.length === 0 ? (
        <div className="p-4">
          <Empty icon={Boxes}>
            Nothing is filed here yet. Move something in from another directory, or choose this one
            when you start a workspace.
          </Empty>
        </div>
      ) : (
        <Table>
          <Head>
            <HeadCell tight>
              <Checkbox
                label="Everything here"
                checked={pick.every}
                indeterminate={pick.some}
                onChange={pick.all}
                // Nothing here is yours to move, so there is nothing to tick.
                disabled={!movable()}
              />
            </HeadCell>
            <HeadCell>What</HeadCell>
            <HeadCell>Made by</HeadCell>
            <HeadCell tight />
          </Head>
          <Body>
            {items.map((i) => (
              <TableRow key={key(i)} selected={pick.has(key(i))}>
                <Cell tight>
                  {movable() && (
                    <Checkbox
                      label={i.name}
                      checked={pick.has(key(i))}
                      onChange={(on) => pick.toggle(key(i), on)}
                    />
                  )}
                </Cell>
                <Cell>
                  <span className="flex items-center gap-2.5">
                    <span className="text-mute">
                      <Icon of={KINDS[i.kind].icon} size={14} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-bone">{i.name}</span>
                      <span className="block truncate font-mono text-meta text-mute">
                        {i.path}
                      </span>
                      <span className="block truncate text-meta text-mute">
                        {KINDS[i.kind].one}
                        {i.detail ? ` · ${i.detail}` : ""}
                      </span>
                    </span>
                  </span>
                </Cell>
                <Cell>
                  {i.ownerName ? (
                    <span className="flex items-center gap-2">
                      <Avatar name={i.ownerName} />
                      <span className="text-dim">{i.ownerName}</span>
                    </span>
                  ) : (
                    <span className="text-meta text-mute">unknown</span>
                  )}
                </Cell>
                <Cell tight>
                  {movable() && (
                    <MenuButton size="sm" label="Move…" items={moveMenu([i])} />
                  )}
                </Cell>
              </TableRow>
            ))}
          </Body>
        </Table>
      )}
      <Trouble>{trouble}</Trouble>
    </>
  );
}

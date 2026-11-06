/**
 * Where things are filed, who each one lets in, and at what.
 *
 * **The whole organisation's, for an administrator.** `list_directories`
 * already answers with every directory when an administrator asks and only the
 * reachable ones otherwise — which is what makes this safe to put here. A
 * directory whose last administrator has left is visible to the one person who
 * can fix it, and that was the objection to having this screen anywhere but the
 * web. It was wrong: the read was always shaped for it.
 *
 * **A grant is not an exception.** What is set here applies to everything filed
 * in the directory, for as long as it is filed there. Letting one person into
 * one workspace is the sharing sheet's job, and the two are kept apart on
 * purpose — they were one flat list once and read as equivalents, which they
 * are not.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, FolderOpen, Plus, X } from "lucide-react";
import { Icon } from "~/components/ui";
import {
  createDirectory,
  getListDirectoriesQueryKey,
  getListGrantsQueryKey,
  useDeleteDirectory,
  useListGrants,
  useRenameDirectory,
  useRevokeGrant,
  useSetGrant,
} from "~/api/generated/access/access";
import { useMe } from "~/api/generated/auth/auth";
import type { Directory, Level } from "~/api/generated/model";
import { useDirectories, why } from "~/data";
import { pathSlug } from "~/filing";
import { Face, PickPeople } from "~/ui/PickPeople";
import { Pop } from "~/ui/Pop";
import { Group, Rows, Section, WhereTo } from "~/ui/config/bits";
import { useConfirm } from "~/ui/Confirm";

/** What a level is called on screen. `writer` is the wire's word for Editor. */
const LEVELS: { value: Level; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "writer", label: "Editor" },
  { value: "admin", label: "Admin" },
];
const said = (l: string | null | undefined) =>
  LEVELS.find((x) => x.value === l)?.label ?? "—";

export function Directories() {
  const cache = useQueryClient();
  const confirm = useConfirm();
  const me = useMe();
  const { data, loading, error } = useDirectories();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const refresh = () => cache.invalidateQueries({ queryKey: getListDirectoriesQueryKey() });

  const make = async () => {
    setBusy(true);
    setTrouble(null);
    try {
      // Whoever makes one administers it. The server grants that, so there is
      // no window where a directory exists with nobody able to decide about it.
      await createDirectory({ name: name.trim(), grants: [] });
      setName("");
      setAdding(false);
      await refresh();
    } catch (e) {
      setTrouble(why(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Directories"
      note="Anything filed in one belongs to it, and everybody it lets in can reach that. Moving something in hands it over."
      action={
        <button
          onClick={() => {
            setAdding((v) => !v);
            setTrouble(null);
          }}
          className="btn primary"
        >
          <Icon of={Plus} size={14} />
          New directory
        </button>
      }
    >
      {adding && (
        <div className="inline-form flex-col items-stretch gap-2">
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && name.trim() && void make()}
              placeholder="What to call it"
              className="w-56 rounded-md border border-line bg-ground px-2 py-1 text-ui text-bone focus:outline-none"
            />
            <span className="font-mono text-micro text-mute">
              {name.trim() ? `d/${pathSlug(name)}` : ""}
            </span>
            <button
              disabled={!name.trim() || busy}
              onClick={() => void make()}
              className="btn plain ml-auto"
            >
              {busy ? "Making…" : "Make it"}
            </button>
          </div>
          <p className="text-meta text-mute">
            You administer it, so you decide who else gets in.
            {trouble && <span className="text-brick"> {trouble}</span>}
          </p>
        </div>
      )}

      <Group>
      <Rows feed={{ data, loading, error }} empty="No directories yet.">
        {data.map((d) => (
          <One
            key={d.id}
            directory={d as Directory}
            mayEdit={(d as Directory).level === "admin" || me.data?.user.role === "admin"}
            onChange={refresh}
            confirm={confirm}
          />
        ))}
      </Rows>
      </Group>

      <WhereTo>
        <b>A grant is not an exception.</b> Letting one person into one workspace is the sharing
        sheet&rsquo;s job, and the two are kept apart on purpose — they were one flat list once and
        read as equivalents, which they are not. An exception can never be <i>Admin</i>.
      </WhereTo>
    </Section>
  );
}

function One({
  directory,
  mayEdit,
  onChange,
  confirm,
}: {
  directory: Directory;
  mayEdit: boolean;
  onChange: () => void;
  confirm: ReturnType<typeof useConfirm>;
}) {
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  // Read when somebody opens it, and not before.
  const { data: grants = [] } = useListGrants(directory.id, { query: { enabled: open } });
  const set = useSetGrant();
  const revoke = useRevokeGrant();
  const rename = useRenameDirectory();
  const bin = useDeleteDirectory();

  const holds = directory.workspaces + directory.hosts + directory.agentAccounts + directory.secrets;
  const refresh = () =>
    Promise.all([
      cache.invalidateQueries({ queryKey: getListGrantsQueryKey(directory.id) }),
      Promise.resolve(onChange()),
    ]);
  const act = (p: Promise<unknown>) => {
    setTrouble(null);
    p.then(() => void refresh()).catch((e) => setTrouble(why(e)));
  };

  return (
    <>
      <button onClick={() => setOpen((v) => !v)} aria-label={`Who is in ${directory.name}`} className="r">
        <span className="g">
          <Icon of={open ? ChevronDown : ChevronRight} size={14} />
        </span>
        <span className="g -ml-2">
          <Icon of={FolderOpen} size={16} />
        </span>
        <span className="tx">
          <b>{directory.name}</b>
          {trouble && <s className="!text-brick">{trouble}</s>}
        </span>
        <span className="path">d/{directory.slug}</span>
        <span className="said">
          {holds === 0 ? "empty" : `${holds} ${holds === 1 ? "thing" : "things"}`}
        </span>
        {directory.level && <span className="said">{said(directory.level)}</span>}
      </button>

      {renaming !== null && (
        <div className="inline-form ml-12">
          <input
            autoFocus
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRenaming(null);
              if (e.key === "Enter" && renaming.trim()) {
                act(rename.mutateAsync({ id: directory.id, data: { name: renaming.trim() } }));
                setRenaming(null);
              }
            }}
            className="min-w-0 flex-1 bg-transparent focus:outline-none"
          />
          {/* The slug does not follow the name. Renaming rewrites nothing, so a
              path stays what it was and everything filed under it stays found. */}
          <span className="font-mono text-micro text-mute">
            stays d/{directory.slug}
          </span>
          <button onClick={() => setRenaming(null)} className="text-micro text-mute hover:text-bone">
            cancel
          </button>
        </div>
      )}

      {open && (
        <>
          {grants.map((g) => (
            <div key={g.subjectId} className="r sub">
              <Face
                who={{ name: g.subjectName, kind: g.subjectKind === "team" ? "team" : "person" }}
              />
              <span className="tx">
                <b>{g.subjectName}</b>
                <s>{g.subjectKind === "team" ? `t/${g.subjectName}` : `u/${g.subjectName}`}</s>
              </span>
              {mayEdit ? (
                <>
                  {/* A menu, not three buttons. Three pills per row is the
                      whole choice drawn permanently on every row of a list
                      that is mostly read — the drawing names the level and
                      opens the rest on demand. */}
                  <LevelMenu
                    level={g.level}
                    onPick={(level) =>
                      act(
                        set.mutateAsync({
                          id: directory.id,
                          data: { subjectKind: g.subjectKind, subjectId: g.subjectId, level },
                        }),
                      )
                    }
                  />
                  <button
                    onClick={() =>
                      act(
                        revoke.mutateAsync({
                          id: directory.id,
                          kind: g.subjectKind,
                          subject: g.subjectId,
                        }),
                      )
                    }
                    aria-label={`Take ${g.subjectName} out of ${directory.name}`}
                    className="gbtn hov h-7 w-7 hover:text-brick"
                  >
                    <Icon of={X} size={14} />
                  </button>
                </>
              ) : (
                <span className="lvl">{said(g.level)}</span>
              )}
            </div>
          ))}

          {grants.length === 0 && (
            <p className="py-1.5 pl-12 text-ui text-mute">Nobody has been let in yet.</p>
          )}

          {mayEdit &&
            (adding ? (
              <PickPeople
                already={grants.map((g) => g.subjectId)}
                empty="Everybody is in it already."
                onClose={() => setAdding(false)}
                onPick={(w) => {
                  act(
                    set.mutateAsync({
                      id: directory.id,
                      data: {
                        subjectKind: w.kind === "team" ? "team" : "person",
                        subjectId: w.id,
                        level: "writer",
                      },
                    }),
                  );
                  setAdding(false);
                }}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2 py-1.5 pl-12">
                <button
                  onClick={() => setAdding(true)}
                  className="flex items-center gap-2.5 text-ui text-dim hover:text-bone"
                >
                  <span className="g">
                    <Icon of={Plus} size={14} />
                  </span>
                  Add people or a team
                </button>
                <button
                  onClick={() => setRenaming(directory.name)}
                  className="ml-auto text-meta text-mute hover:text-bone"
                >
                  Rename
                </button>
                <button
                  onClick={() =>
                    void confirm({
                      title: `Remove ${directory.name}?`,
                      body:
                        holds > 0 ? (
                          <>
                            It still holds {holds} {holds === 1 ? "thing" : "things"}. Take those out
                            first — a directory is removed only once it is empty, so nothing is ever
                            deleted along with it.
                          </>
                        ) : (
                          <>
                            It is empty. Every grant on it goes too, and the name becomes free for
                            somebody to use again.
                          </>
                        ),
                      action: "Remove it",
                      tone: "danger",
                    }).then((ok) => ok && act(bin.mutateAsync({ id: directory.id })))
                  }
                  className="text-meta text-mute hover:text-brick"
                >
                  Remove
                </button>
              </div>
            ))}
        </>
      )}
    </>
  );
}

/**
 * Viewer / Editor / Admin, as a menu on the row that holds it.
 *
 * `writer` stays on the wire and `Editor` is what it is called here: the word
 * people use for somebody who may change a thing without administering it.
 */
function LevelMenu({ level, onPick }: { level: Level; onPick: (level: Level) => void }) {
  const [open, setOpen] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        onClick={(e) => setOpen(open ? null : e.currentTarget)}
        className="lvl"
      >
        {said(level)}
        <Icon of={ChevronDown} size={12} />
      </button>
      {open && (
        <Pop anchor={open} onClose={() => setOpen(null)} width={180}>
          <div role="menu" className="py-1">
            {LEVELS.map((l) => (
              <button
                key={l.value}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(null);
                  onPick(l.value);
                }}
                className="mi"
              >
                <span className="ic">{l.value === level ? <Icon of={Check} size={14} /> : null}</span>
                <span className="tx">
                  <b>{l.label}</b>
                </span>
              </button>
            ))}
          </div>
        </Pop>
      )}
    </>
  );
}

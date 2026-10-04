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
import { ChevronDown, ChevronRight, FolderOpen, Plus, X } from "lucide-react";
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
import { Rows, Section } from "~/ui/config/bits";
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
          className="control border border-line bg-raise text-ui text-bone hover:bg-overlay"
        >
          <Icon of={Plus} size={12} />
          New directory
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
              className="control ml-auto border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute"
            >
              {busy ? "Making…" : "Make it"}
            </button>
          </div>
          <p className="mt-1.5 text-micro text-mute">
            You administer it, so you decide who else gets in.
            {trouble && <span className="text-brick"> {trouble}</span>}
          </p>
        </div>
      )}

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
      <div className="flex items-center gap-2.5 pr-3.5 pl-3.5 hover:bg-raise">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label={`Who is in ${directory.name}`}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 text-left"
        >
          <span className="grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full border border-line bg-overlay text-dim">
            <Icon of={FolderOpen} size={12} />
          </span>
          <span className="min-w-0 flex-1">
            {renaming === null ? (
              <span className="block truncate text-ui text-bone">
                {directory.name}{" "}
                <span className="font-mono text-micro text-mute">d/{directory.slug}</span>
              </span>
            ) : (
              <span className="block text-ui text-bone">{directory.name}</span>
            )}
            {trouble && <span className="block text-micro text-brick">{trouble}</span>}
          </span>
          <span className="shrink-0 text-micro text-mute">
            {holds === 0 ? "empty" : `${holds} ${holds === 1 ? "thing" : "things"}`}
          </span>
          {directory.level && (
            <span className="shrink-0 text-meta text-dim">{said(directory.level)}</span>
          )}
          <Icon of={open ? ChevronDown : ChevronRight} size={12} />
        </button>
      </div>

      {renaming !== null && (
        <div className="flex items-center gap-2 py-1.5 pr-3.5 pl-9">
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
            className="w-56 rounded-md border border-line bg-ground px-2 py-1 text-ui text-bone focus:outline-none"
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
            <div key={g.subjectId} className="flex items-center gap-2.5 py-1.5 pr-3.5 pl-9">
              <Face
                who={{ name: g.subjectName, kind: g.subjectKind === "team" ? "team" : "person" }}
              />
              <span className="min-w-0 flex-1 truncate text-ui text-text">{g.subjectName}</span>
              {mayEdit ? (
                <>
                  <div className="track shrink-0">
                    {LEVELS.map((l) => (
                      <button
                        key={l.value}
                        data-on={g.level === l.value}
                        onClick={() =>
                          act(
                            set.mutateAsync({
                              id: directory.id,
                              data: {
                                subjectKind: g.subjectKind,
                                subjectId: g.subjectId,
                                level: l.value,
                              },
                            }),
                          )
                        }
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
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
                    className="shrink-0 text-mute hover:text-brick"
                  >
                    <Icon of={X} size={12} />
                  </button>
                </>
              ) : (
                <span className="shrink-0 text-meta text-dim">{said(g.level)}</span>
              )}
            </div>
          ))}

          {grants.length === 0 && (
            <p className="py-1.5 pr-3.5 pl-9 text-micro text-mute">Nobody has been let in yet.</p>
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
              <div className="flex flex-wrap items-center gap-2 py-1.5 pr-3.5 pl-9">
                <button
                  onClick={() => setAdding(true)}
                  className="flex items-center gap-2.5 text-ui text-mute hover:text-dim"
                >
                  <span className="grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full border border-line bg-overlay">
                    <Icon of={Plus} size={12} />
                  </span>
                  Add people or teams…
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

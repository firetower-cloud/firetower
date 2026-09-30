"use client";

/**
 * Who can access one workspace.
 *
 * **Two sections, and they are two different acts.** Letting somebody in is
 * additive, reversible and touches nothing else — it writes one entry in
 * `extra_perms` on this row. Moving it hands it to a directory, and whoever
 * administers that directory decides about it afterwards. Those used to share
 * one control, which is how "share with Lisa" became "give your workspace
 * away".
 *
 * **Every row says why it is there.** An exception belongs to this workspace and
 * can be changed here; a grant belongs to the directory and is changed on the
 * Organisation screen, so it is shown with where it came from and no controls.
 * That provenance is what teaches the model without a paragraph explaining it.
 *
 * **Nothing commits until Save.** The list was immediate once, and a click that
 * silently gave four people access to six other things is the reason it is not.
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, UserRound, X } from "lucide-react";
import { Icon } from "~/components/ui";
import {
  createDirectory,
  dropException,
  fileItems,
  getAccessOfQueryKey,
  getListDirectoriesQueryKey,
  setException,
  unfileItems,
  useAccessOf,
} from "~/api/generated/access/access";
import { getListSessionsQueryKey } from "~/api/generated/sessions/sessions";
import type { Level, Reaches } from "~/api/generated/model";
import { useDirectories, why } from "~/data";
import { destinations, pathSlug, rootOf } from "~/filing";
import { PickPeople, Face, type Pickable } from "~/ui/PickPeople";

/** What a level is called on screen. `writer` is the wire's word for Editor. */
const LEVELS: { value: Level; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "writer", label: "Editor" },
];
const said = (l: Level) => LEVELS.find((x) => x.value === l)?.label ?? "Admin";

/** Somewhere it could go. `null` is the person's own space, which has no row. */
type Place = { kind: "mine" } | { kind: "directory"; id: string } | { kind: "new" };

export function Sharing({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const item = useMemo(() => ({ kind: "workspace" as const, id: workspaceId }), [workspaceId]);
  const { data, isPending } = useAccessOf({ kind: "workspace", id: workspaceId });
  const { data: directories } = useDirectories();

  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);

  /* What has been decided but not yet sent. Exceptions are a map so that adding
     somebody and then changing their level is one pending entry, not two. */
  const [pending, setPending] = useState<Record<string, Level | null>>({});
  const [named, setNamed] = useState<Record<string, Pickable>>({});
  const [place, setPlace] = useState<Place | null>(null);
  const [newName, setNewName] = useState("");
  const [newWith, setNewWith] = useState<{ who: Pickable; level: Level }[]>([]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !adding && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, adding]);

  const where = data ? rootOf(data.path) : ["u", ""];
  const here = data?.directory ?? null;

  /* The list, with pending edits folded in so the screen shows what Save will
     do rather than what the server currently says. */
  const who: (Reaches & { pendingLevel?: Level | null })[] = useMemo(() => {
    const rows = (data?.who ?? []).map((r) =>
      r.route === "exception" && r.subjectId in pending
        ? { ...r, pendingLevel: pending[r.subjectId] }
        : r,
    );
    const fresh = Object.entries(pending)
      .filter(([id, lv]) => lv && !rows.some((r) => r.subjectId === id))
      .map(([id, lv]) => ({
        subjectKind: (named[id]?.kind === "team" ? "team" : "person") as Reaches["subjectKind"],
        subjectId: id,
        name: named[id]?.name ?? id,
        level: lv as Level,
        route: "exception" as const,
        pendingLevel: lv,
      }));
    return [...rows, ...fresh];
  }, [data, pending, named]);

  const moving = place !== null && !samePlace(place, data?.directory?.id ?? null, where[0]);
  const changes = Object.keys(pending).length + (moving ? 1 : 0);
  const target = place?.kind === "directory" ? directories.find((d) => d.id === place.id) : undefined;
  const losingAdmin = target != null && target.level !== "admin";

  const save = async () => {
    setBusy(true);
    setTrouble(null);
    try {
      for (const [subjectId, level] of Object.entries(pending)) {
        if (level) await setException({ item, subjectId, level });
        else await dropException({ item, subjectId });
      }
      if (moving && place) {
        if (place.kind === "mine" && here) await unfileItems(here.id, { items: [item] });
        if (place.kind === "directory") await fileItems(place.id, { items: [item] });
        if (place.kind === "new") {
          await createDirectory({
            name: newName.trim(),
            grants: newWith.map((g) => ({
              subjectKind: g.who.kind === "team" ? "team" : "person",
              subjectId: g.who.id,
              level: g.level,
            })),
            move: item,
          });
        }
      }
      await Promise.all([
        cache.invalidateQueries({ queryKey: getAccessOfQueryKey({ kind: "workspace", id: workspaceId }) }),
        cache.invalidateQueries({ queryKey: getListDirectoriesQueryKey() }),
        cache.invalidateQueries({ queryKey: getListSessionsQueryKey() }),
      ]);
      onClose();
    } catch (e) {
      setTrouble(why(e));
    } finally {
      setBusy(false);
    }
  };

  const mayShare = data?.mayShare ?? false;

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-start justify-center bg-ground/40 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        className="flex max-h-[76vh] w-[27rem] flex-col overflow-hidden rounded-xl border border-line bg-overlay shadow-(--shadow-float)"
      >
        <div className="flex items-start gap-2 border-b border-line px-3.5 py-2.5">
          <span className="min-w-0 flex-1">
            <span className="block text-ui text-bone">Who can access it</span>
            <span className="block truncate font-mono text-micro text-mute">{data?.path ?? ""}</span>
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"
          >
            <Icon of={X} size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isPending && <p className="px-3.5 py-3 text-ui text-mute">Reading…</p>}

          {data && (
            <>
              <Label>Who can access it</Label>
              {who.map((r) => (
                <Line
                  key={`${r.route}:${r.subjectId}`}
                  row={r}
                  from={r.route === "directory" ? here?.name : undefined}
                  mayEdit={mayShare && r.route === "exception"}
                  onLevel={(lv) => setPending((p) => ({ ...p, [r.subjectId]: lv }))}
                />
              ))}

              {mayShare &&
                (adding ? (
                  <PickPeople
                    already={who.map((r) => r.subjectId)}
                    onClose={() => setAdding(false)}
                    onPick={(w) => {
                      setNamed((n) => ({ ...n, [w.id]: w }));
                      setPending((p) => ({ ...p, [w.id]: "writer" }));
                      setAdding(false);
                    }}
                  />
                ) : (
                  <Add onClick={() => setAdding(true)}>Add people or teams…</Add>
                ))}

              <div className="mx-3.5 my-1 h-px bg-line" />
              <Label>Where it lives</Label>

              {place === null ? (
                <div className="flex items-center gap-2.5 px-3.5 py-2">
                  <Icon of={here ? FolderOpen : UserRound} size={14} />
                  <span className="min-w-0 flex-1 truncate text-ui text-bone">
                    {here ? here.name : "Only you"}{" "}
                    <span className="font-mono text-micro text-mute">
                      {here ? `d/${here.slug}` : `u/${where[1]}`}
                    </span>
                  </span>
                  {mayShare && (
                    <button
                      onClick={() => setPlace(here ? { kind: "directory", id: here.id } : { kind: "mine" })}
                      aria-label="Change where it lives"
                      className="shrink-0 text-meta text-slate hover:text-bone"
                    >
                      Change
                    </button>
                  )}
                </div>
              ) : (
                <Places
                  chosen={place}
                  onChoose={(p) => {
                    setPlace(p);
                    if (p.kind === "new" && !newName) setNewName(here ? "" : "");
                  }}
                  directories={destinations(directories)}
                  hereId={here?.id ?? null}
                  newName={newName}
                  onName={setNewName}
                  newWith={newWith}
                  onWith={setNewWith}
                  alreadyIn={who.map((r) => r.subjectId)}
                />
              )}

              {losingAdmin && (
                <p className="mx-3.5 my-2 rounded-lg border border-brick-deep bg-brick-tint px-3 py-2.5 text-micro leading-relaxed text-brick">
                  <b className="font-medium">You are not an admin of {target?.name}.</b> Moving this
                  there hands it over — you keep it only as an editor, and will not be able to move
                  it back or decide who else sees it.
                </p>
              )}

              {!mayShare && (
                <p className="px-3.5 py-2.5 text-micro leading-relaxed text-mute">
                  You can open this and read it.{" "}
                  {here ? `Somebody who administers ${here.name} decides who else can.` : "Only its owner can change this."}
                </p>
              )}
            </>
          )}
        </div>

        {trouble && (
          <p className="border-t border-line px-3.5 py-2.5 text-micro text-brick">{trouble}</p>
        )}

        {mayShare && (
          <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
            <span className="flex-1 text-micro text-mute">
              {changes === 0 ? "no change yet" : `${changes} change${changes === 1 ? "" : "s"}`}
            </span>
            <button onClick={onClose} className="control text-dim hover:text-bone">
              Cancel
            </button>
            <button
              disabled={changes === 0 || busy || (place?.kind === "new" && !newName.trim())}
              onClick={() => void save()}
              className="control bg-bone font-medium text-ground disabled:bg-raise disabled:text-mute"
            >
              {busy ? "Saving…" : moving ? (place?.kind === "new" ? "Create & move" : "Transfer ownership") : "Save"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3.5 pt-2.5 pb-1 text-micro tracking-[0.08em] text-mute uppercase">
      {children}
    </div>
  );
}

function Add({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-ui text-mute transition-colors hover:bg-raise hover:text-dim"
    >
      <span className="grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full border border-line bg-overlay">
        +
      </span>
      {children}
    </button>
  );
}

/** One person or team, and why they can reach this. */
function Line({
  row,
  from,
  mayEdit,
  onLevel,
}: {
  row: Reaches & { pendingLevel?: Level | null };
  from?: string;
  mayEdit: boolean;
  onLevel: (level: Level | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const level = row.pendingLevel === undefined ? row.level : row.pendingLevel;
  if (level === null) return null; // pending removal — gone from the list at once

  return (
    <div className={`relative flex items-center gap-2.5 px-3.5 py-2 ${row.pendingLevel !== undefined ? "bg-sage-tint" : "hover:bg-raise"}`}>
      <Face who={{ name: row.name, kind: row.subjectKind === "team" ? "team" : "person" }} />
      <span className="min-w-0 flex-1 truncate text-ui text-bone">
        {row.name}
        {row.route === "owner" && (
          <span className="ml-1.5 text-micro text-mute">{" "}owns it</span>
        )}
      </span>
      {from && (
        <span className="shrink-0 text-micro text-mute">from {from}</span>
      )}
      {mayEdit ? (
        <>
          <button
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 rounded-md border border-line bg-raise px-2 py-0.5 text-meta text-text hover:bg-overlay"
          >
            {said(level)} ⌄
          </button>
          {open && (
            <div className="absolute top-full right-3.5 z-10 w-44 overflow-hidden rounded-lg border border-line bg-panel shadow-(--shadow-float)">
              {LEVELS.map((l) => (
                <button
                  key={l.value}
                  onClick={() => { onLevel(l.value); setOpen(false); }}
                  className="block w-full px-3 py-1.5 text-left text-ui text-text hover:bg-raise"
                >
                  {level === l.value ? "✓ " : "   "}
                  {l.label}
                </button>
              ))}
              <div className="h-px bg-line" />
              <button
                onClick={() => { onLevel(null); setOpen(false); }}
                className="block w-full px-3 py-1.5 text-left text-ui text-brick hover:bg-raise"
              >
                Remove access
              </button>
            </div>
          )}
        </>
      ) : (
        <span className="shrink-0 text-meta text-dim">{row.route === "owner" ? "Owner" : said(row.level)}</span>
      )}
    </div>
  );
}

/** The places it could go. One answer, so radios. */
function Places({
  chosen,
  onChoose,
  directories,
  hereId,
  newName,
  onName,
  newWith,
  onWith,
  alreadyIn,
}: {
  chosen: Place;
  onChoose: (p: Place) => void;
  directories: { id: string; name: string; slug: string; workspaces: number; hosts: number; agentAccounts: number; secrets: number }[];
  hereId: string | null;
  newName: string;
  onName: (s: string) => void;
  newWith: { who: Pickable; level: Level }[];
  onWith: (w: { who: Pickable; level: Level }[]) => void;
  alreadyIn: string[];
}) {
  const [adding, setAdding] = useState(false);
  const holds = (d: { workspaces: number; hosts: number; agentAccounts: number; secrets: number }) => {
    const n = d.workspaces + d.hosts + d.agentAccounts + d.secrets;
    return n === 0 ? "empty" : `${n} thing${n === 1 ? "" : "s"}`;
  };

  return (
    <>
      <Option
        on={chosen.kind === "mine"}
        onPick={() => onChoose({ kind: "mine" })}
        title="Only you"
        note="Nobody else."
      />
      {directories.map((d) => (
        <Option
          key={d.id}
          on={chosen.kind === "directory" && chosen.id === d.id}
          onPick={() => onChoose({ kind: "directory", id: d.id })}
          title={d.name}
          note={`${holds(d)}${d.id === hereId ? " · where it is now" : ""}`}
        />
      ))}
      <div className="mx-3.5 my-1 h-px bg-line" />
      <Option
        on={chosen.kind === "new"}
        onPick={() => onChoose({ kind: "new" })}
        title="A new directory…"
        note="For people who are not together anywhere yet"
      />

      {chosen.kind === "new" && (
        <>
          <div className="px-3.5 pt-1">
            <input
              autoFocus
              value={newName}
              onChange={(e) => onName(e.target.value)}
              placeholder="What to call it"
              className="w-full rounded-md border border-slate-deep bg-ground px-2.5 py-1.5 text-ui text-bone placeholder:text-mute focus:outline-none"
            />
            <p className="mt-1.5 text-micro leading-relaxed text-mute">
              {newName.trim() ? (
                <>
                  It will be <span className="font-mono text-dim">d/{pathSlug(newName)}</span> — the part
                  that appears in paths, and does not change if you rename it later.
                </>
              ) : (
                "Name it, and choose who is in it."
              )}
            </p>
          </div>

          <Label>Who is in it</Label>
          <div className="flex items-center gap-2.5 px-3.5 py-2">
            <Face who={{ name: "you", kind: "person" }} />
            <span className="min-w-0 flex-1 text-ui text-bone">You</span>
            <span className="shrink-0 text-meta text-dim">Admin</span>
          </div>
          {newWith.map((g, i) => (
            <div key={g.who.id} className="flex items-center gap-2.5 bg-sage-tint px-3.5 py-2">
              <Face who={g.who} />
              <span className="min-w-0 flex-1 truncate text-ui text-bone">{g.who.name}</span>
              <button
                onClick={() =>
                  onWith(newWith.map((x, j) => (i === j ? { ...x, level: x.level === "writer" ? "viewer" : "writer" } : x)))
                }
                className="shrink-0 rounded-md border border-line bg-raise px-2 py-0.5 text-meta text-text"
              >
                {said(g.level)} ⌄
              </button>
              <button
                onClick={() => onWith(newWith.filter((_, j) => j !== i))}
                aria-label={`Take ${g.who.name} out`}
                className="shrink-0 text-mute hover:text-brick"
              >
                ✕
              </button>
            </div>
          ))}
          {adding ? (
            <PickPeople
              already={[...alreadyIn, ...newWith.map((g) => g.who.id)]}
              onClose={() => setAdding(false)}
              onPick={(w) => {
                onWith([...newWith, { who: w, level: "writer" }]);
                setAdding(false);
              }}
            />
          ) : (
            <Add onClick={() => setAdding(true)}>Add people or teams…</Add>
          )}
        </>
      )}
    </>
  );
}

function Option({
  on,
  onPick,
  title,
  note,
}: {
  on: boolean;
  onPick: () => void;
  title: string;
  note: string;
}) {
  return (
    <button
      onClick={onPick}
      className={`flex w-full items-start gap-2.5 px-3.5 py-2 text-left transition-colors ${
        on ? "bg-raise" : "hover:bg-raise/60"
      }`}
    >
      <span
        className={`mt-0.5 grid h-[15px] w-[15px] shrink-0 place-items-center rounded-full border ${
          on ? "border-bone" : "border-line"
        }`}
      >
        {on && <span className="h-[7px] w-[7px] rounded-full bg-bone" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui text-bone">{title}</span>
        <span className="block truncate text-micro text-mute">{note}</span>
      </span>
    </button>
  );
}

/** Whether a pending choice is where it already is. */
function samePlace(p: Place, hereId: string | null, root: string) {
  if (p.kind === "mine") return root === "u";
  if (p.kind === "directory") return p.id === hereId;
  return false;
}

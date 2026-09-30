"use client";

/**
 * Who can access one workspace.
 *
 * **Two kinds of access, kept apart on the screen.** Whoever the directory lets
 * in is one row — the directory itself — with its people folded underneath it,
 * because that access belongs to the directory and is the same for everything
 * filed there. Whoever was let into *this workspace* is a separate list. Shown
 * as one flat list they read as equivalent, and they are not: one is changed
 * here, the other on the Organisation screen.
 *
 * **Three steps, not one growing panel.** Choosing where it lives is a different
 * question from who is let in, so it replaces the sheet rather than unrolling
 * beneath it. Making a directory is a third. Each step has its own footer and
 * its own way back.
 *
 * **Nothing commits until Save.** Not when a person is picked, not when a
 * directory is chosen, and not when a new one is filled in — a new directory is
 * a *pending* answer like any other, and the sheet returns to the main step
 * showing it. The first version acted on click, so a mis-click gave somebody
 * access with no way to reconsider.
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FolderOpen,
  Plus,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
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
import { useConfirm } from "~/ui/Confirm";

/** What a level is called on screen. `writer` is the wire's word for Editor. */
const LEVELS: { value: Level; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "writer", label: "Editor" },
];
const said = (l: Level) => LEVELS.find((x) => x.value === l)?.label ?? "Admin";

/**
 * A row that will change when Save is pressed.
 *
 * Slate, not green. Green reads as *done* — and none of this has happened yet;
 * that is the whole point of the footer. Slate is also the only other
 * interactive accent in the sheet (the Change link), so a pending row and the
 * control that made it pending are visibly the same idea.
 *
 * An inset shadow rather than a border, so a row does not shift two pixels
 * sideways the moment it is edited.
 */
const PENDING = "bg-slate-tint shadow-[inset_2px_0_0_var(--color-slate)]";

/** A directory as the pickers need it. */
type Somewhere = {
  id: string;
  name: string;
  slug: string;
  level?: string | null;
  workspaces: number;
  hosts: number;
  agentAccounts: number;
  secrets: number;
};

/** Somewhere it could go. There is no row for a personal root, hence `mine`. */
type Place = { kind: "mine" } | { kind: "directory"; id: string } | { kind: "new" };

export function Sharing({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const cache = useQueryClient();
  const confirm = useConfirm();
  const item = useMemo(() => ({ kind: "workspace" as const, id: workspaceId }), [workspaceId]);
  const { data, isPending } = useAccessOf({ kind: "workspace", id: workspaceId });
  const { data: directories } = useDirectories();

  const [step, setStep] = useState<"main" | "places" | "new">("main");
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);

  /* Decided, not yet sent. Exceptions are a map so that adding somebody and then
     changing their level is one pending entry rather than two. */
  const [pending, setPending] = useState<Record<string, Level | null>>({});
  const [named, setNamed] = useState<Record<string, Pickable>>({});
  const [place, setPlace] = useState<Place | null>(null);
  const [newName, setNewName] = useState("");
  const [newWith, setNewWith] = useState<{ who: Pickable; level: Level }[]>([]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (step === "new") setStep("places");
      else if (step === "places") setStep("main");
      else onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, step]);

  const root = data ? rootOf(data.path)[0] : "u";
  const mySlug = data ? rootOf(data.path)[1] : "";
  const here = data?.directory ?? null;

  const owner = (data?.who ?? []).find((r) => r.route === "owner");
  const fromDirectory = (data?.who ?? []).filter((r) => r.route === "directory");

  /* Exceptions, with pending edits folded in so the screen shows what Save will
     do rather than what the server currently says. */
  const exceptions: (Reaches & { pendingLevel?: Level | null })[] = useMemo(() => {
    type Row = Reaches & { pendingLevel?: Level | null };
    const rows: Row[] = (data?.who ?? [])
      .filter((r) => r.route === "exception")
      .map((r): Row => (r.subjectId in pending ? { ...r, pendingLevel: pending[r.subjectId] } : r));
    const fresh = Object.entries(pending)
      .filter(([id, lv]) => lv && !rows.some((r) => r.subjectId === id))
      .map(([id, lv]): Row => ({
        subjectKind: (named[id]?.kind === "team" ? "team" : "person") as Reaches["subjectKind"],
        subjectId: id,
        name: named[id]?.name ?? id,
        level: lv as Level,
        route: "exception" as const,
        pendingLevel: lv as Level,
      }));
    return [...rows, ...fresh].filter(
      (r) => (r.pendingLevel === undefined ? r.level : r.pendingLevel) !== null,
    );
  }, [data, pending, named]);

  const moving = place !== null && !samePlace(place, here?.id ?? null, root);
  const changes = Object.keys(pending).length + (moving ? 1 : 0);
  const mayShare = data?.mayShare ?? false;
  const taken = [
    ...(data?.who ?? []).map((r) => r.subjectId),
    ...Object.keys(pending).filter((k) => pending[k]),
  ];

  const save = async () => {
    // Asked here rather than warned about earlier, because a warning attached to
    // a list is read once and then skipped forever. This is the one irreversible
    // thing in the sheet, and it is the last thing before it happens.
    if (moving && place && !(await confirm(handingOver(place)))) return;

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
        cache.invalidateQueries({
          queryKey: getAccessOfQueryKey({ kind: "workspace", id: workspaceId }),
        }),
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

  /**
   * What to ask before a move, in the words of the move being made.
   *
   * Three of them, because they are three different things: handing it to a
   * directory, taking it back, and creating one you will administer.
   *
   * Each says where it is **now** before saying where it will be. "It stops
   * being yours" was wrong the moment a workspace was already in a directory —
   * it was not yours, it was that directory's — and a warning that is wrong
   * about the present is not believed about the future.
   *
   * "Only through" is load-bearing in all three: somebody with individual
   * access keeps it, because an exception is on the row and the row is what
   * moves.
   */
  const handingOver = (p: Place) => {
    const now = here ? (
      <>
        it belongs to <b className="text-bone">{here.name}</b>
      </>
    ) : (
      <>it is yours alone</>
    );

    if (p.kind === "mine") {
      return {
        title: `Take this out of ${here?.name ?? "the directory"}?`,
        body: (
          <>
            It becomes yours alone. Anyone who had it only through{" "}
            <b className="text-bone">{here?.name}</b> — {counted(fromDirectory)} — will not.
            Nothing else in {here?.name} changes.
          </>
        ),
        action: "Take it back",
        tone: "danger" as const,
      };
    }

    if (p.kind === "new") {
      return {
        title: `Create ${newName.trim()} and move this into it?`,
        body: (
          <>
            Right now {now}. Afterwards it belongs to{" "}
            <b className="text-bone">{newName.trim()}</b>, which you administer — so you keep it
            and decide who else sees it.
          </>
        ),
        action: "Create and move",
        tone: "plain" as const,
      };
    }

    const to = directories.find((d) => d.id === p.id);
    const mine = to?.level === "admin";
    return {
      title: `Move this to ${to?.name}?`,
      body: (
        <>
          Right now {now}. Afterwards it belongs to <b className="text-bone">{to?.name}</b> —
          everyone with access there can reach it, and anyone who had it only through{" "}
          {here ? here.name : "you"} will not.
          {mine ? (
            <> You administer {to?.name}, so you can still move it back.</>
          ) : (
            <>
              {" "}
              <b className="text-bone">You do not administer {to?.name}</b>, so you will not be able
              to move it back or decide who else sees it.
            </>
          )}
        </>
      ),
      action: "Move it",
      tone: "danger" as const,
    };
  };

  /** What "where it lives" says — the pending answer if there is one. */
  const destination = () => {
    if (place?.kind === "new")
      return {
        name: newName.trim() || "A new directory",
        note: `new · ${newWith.length + 1} in it`,
      };
    if (place?.kind === "mine") return { name: "Only you", note: "nobody else" };
    if (place?.kind === "directory") {
      const d = directories.find((x) => x.id === place.id);
      return { name: d?.name ?? "somewhere", note: d ? `d/${d.slug}` : "" };
    }
    return here
      ? { name: here.name, note: `d/${here.slug}` }
      : { name: "Only you", note: `u/${mySlug}` };
  };

  const title =
    step === "places" ? "Where it lives" : step === "new" ? "A new directory" : "Who can access it";
  const subtitle = step === "new" ? "This workspace will go in it" : (data?.path ?? "");

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
            <span className="block text-ui text-bone">{title}</span>
            <span
              className={`block truncate text-micro text-mute ${step === "new" ? "" : "font-mono"}`}
            >
              {subtitle}
            </span>
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

          {data && step === "main" && (
            <Main
              here={here}
              owner={owner}
              fromDirectory={fromDirectory}
              exceptions={exceptions}
              mayShare={mayShare}
              taken={taken}
              onLevel={(id, lv) => setPending((p) => ({ ...p, [id]: lv }))}
              onAdd={(w) => {
                setNamed((n) => ({ ...n, [w.id]: w }));
                setPending((p) => ({ ...p, [w.id]: "writer" }));
              }}
              destination={destination()}
              pendingMove={moving}
              onChange={() => setStep("places")}
            />
          )}

          {data && step === "places" && (
            <Places
              chosen={place ?? (here ? { kind: "directory", id: here.id } : { kind: "mine" })}
              hereId={here?.id ?? null}
              directories={destinations(directories) as Somewhere[]}
              onPick={(p) => {
                setPlace(p);
                setStep(p.kind === "new" ? "new" : "main");
              }}
            />
          )}

          {data && step === "new" && (
            <NewDirectory
              name={newName}
              onName={setNewName}
              people={newWith}
              onPeople={setNewWith}
              taken={taken}
            />
          )}

          {step === "main" && !mayShare && (
            <p className="px-3.5 py-2.5 text-micro leading-relaxed text-mute">
              You can open this and read it.{" "}
              {here
                ? `Somebody who administers ${here.name} decides who else can.`
                : "Only its owner can change this."}
            </p>
          )}
        </div>

        {trouble && (
          <p className="border-t border-line px-3.5 py-2.5 text-micro text-brick">{trouble}</p>
        )}

        {step === "main" && mayShare && (
          <Footer
            left={changes === 0 ? "no change yet" : `${changes} change${changes === 1 ? "" : "s"}`}
          >
            <button onClick={onClose} className="control text-dim hover:text-bone">
              Cancel
            </button>
            <button
              disabled={changes === 0 || busy}
              onClick={() => void save()}
              className="control bg-bone font-medium text-ground disabled:bg-raise disabled:text-mute"
            >
              {/* The same word the confirmation will use. Two different labels
                  for one act reads as two acts. */}
              {busy ? "Saving…" : moving && place ? handingOver(place).action : "Save"}
            </button>
          </Footer>
        )}

        {step === "places" && (
          <Footer left="nothing is saved until you do">
            <button onClick={() => setStep("main")} className="control text-dim hover:text-bone">
              Back
            </button>
          </Footer>
        )}

        {step === "new" && (
          <Footer left={newName.trim() ? `d/${pathSlug(newName)}` : "name it to continue"}>
            <button onClick={() => setStep("places")} className="control text-dim hover:text-bone">
              Back
            </button>
            <button
              disabled={!newName.trim()}
              onClick={() => setStep("main")}
              className="control bg-bone font-medium text-ground disabled:bg-raise disabled:text-mute"
            >
              Use this
            </button>
          </Footer>
        )}
      </div>
    </div>
  );
}

function Footer({ left, children }: { left: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
      <span className="flex-1 truncate text-micro text-mute">{left}</span>
      {children}
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

/**
 * The one thing a section offers, on a row of its own at the end of it.
 *
 * Both sections end this way — *move somewhere else* and *add people or teams* —
 * so the sheet has a rhythm: what is true, then the one thing you can do about
 * it. Moving used to sit on the directory row itself, which already carried a
 * folder, a name, a slug, a count and a chevron, and whose own job was to
 * expand.
 */
function Act({
  onClick,
  icon,
  children,
}: {
  onClick: () => void;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={typeof children === "string" ? children : undefined}
      className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-ui text-mute transition-colors hover:bg-raise hover:text-dim"
    >
      <span className="grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full border border-line bg-overlay">
        <Icon of={icon} size={12} />
      </span>
      {children}
    </button>
  );
}

/* ── step one: who ────────────────────────────────────────────────────── */

function Main({
  here,
  owner,
  fromDirectory,
  exceptions,
  mayShare,
  taken,
  onLevel,
  onAdd,
  destination,
  pendingMove,
  onChange,
}: {
  here: { id: string; name: string; slug: string } | null;
  owner?: Reaches;
  fromDirectory: Reaches[];
  exceptions: (Reaches & { pendingLevel?: Level | null })[];
  mayShare: boolean;
  taken: string[];
  onLevel: (id: string, level: Level | null) => void;
  onAdd: (who: Pickable) => void;
  destination: { name: string; note: string };
  pendingMove: boolean;
  onChange: () => void;
}) {
  // Folded by default. A directory with twenty people in it would otherwise bury
  // the two lines that are actually about *this* workspace.
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <Label>{here ? "Directory access" : "Owner"}</Label>

      {/* One row, not two. The place and the access it confers were separate
          sections, which meant the directory's name and slug appeared twice on
          a screen small enough to see both at once.

          This row does one thing — expand to show who is in the directory —
          and moving is a row of its own below. It had been squeezed onto the
          right of this one, behind the count and the chevron, where it read as
          part of the folder's own label. */}
      {here ? (
        <>
          <div className="flex items-center gap-2.5 pr-3.5 pl-3.5 hover:bg-raise">
            <button
              onClick={() => setOpen((v) => !v)}
              aria-label={`People in ${here.name}`}
              className="flex min-w-0 flex-1 items-center gap-2.5 py-2 text-left"
            >
              <span className="grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full border border-line bg-overlay text-dim">
                <Icon of={FolderOpen} size={12} />
              </span>
              <span className="min-w-0 flex-1 truncate text-ui text-bone">
                {here.name} <span className="font-mono text-micro text-mute">d/{here.slug}</span>
              </span>
              <span className="shrink-0 text-micro text-mute">{counted(fromDirectory)}</span>
              <Icon of={open ? ChevronDown : ChevronRight} size={12} />
            </button>
          </div>
          {open &&
            fromDirectory.map((r) => (
              <div key={r.subjectId} className="flex items-center gap-2.5 py-1.5 pr-3.5 pl-9">
                <Face who={{ name: r.name, kind: r.subjectKind === "team" ? "team" : "person" }} />
                <span className="min-w-0 flex-1 truncate text-ui text-text">{r.name}</span>
                <span className="shrink-0 text-meta text-dim">{said(r.level)}</span>
              </div>
            ))}
        </>
      ) : (
        owner && (
          <div className="flex items-center gap-2.5 px-3.5 py-2">
            <Face who={{ name: owner.name, kind: "person" }} />
            <span className="min-w-0 flex-1 truncate text-ui text-bone">
              {owner.name} <span className="text-micro text-mute">owns it</span>
            </span>
          </div>
        )
      )}

      {/* A pending move is shown *beside* where it lives now, never instead of
          it. Replacing the row hid the directory and everybody in it behind one
          line — so the screen stopped answering "who can access this" at exactly
          the moment somebody was deciding whether to change it. */}
      {pendingMove && (
        <div className={`flex items-center gap-2.5 px-3.5 py-2 ${PENDING}`}>
          <span className="grid h-[21px] w-[21px] shrink-0 place-items-center text-dim">
            <Icon of={destination.name === "Only you" ? UserRound : FolderOpen} size={12} />
          </span>
          <span className="min-w-0 flex-1 truncate text-ui text-bone">
            Moving to {destination.name}{" "}
            <span className="font-mono text-micro text-mute">{destination.note}</span>
            <span className="block text-micro text-mute">when you save</span>
          </span>
        </div>
      )}

      {mayShare && (
        <Act onClick={onChange} icon={CornerDownRight}>
          {here ? "Move somewhere else…" : "Move into a directory…"}
        </Act>
      )}

      <div className="mx-3.5 my-1 h-px bg-line" />
      <Label>Individual access</Label>

      {exceptions.map((r) => (
        <Line
          key={r.subjectId}
          row={r}
          mayEdit={mayShare}
          onLevel={(lv) => onLevel(r.subjectId, lv)}
        />
      ))}

      {mayShare &&
        (adding ? (
          <PickPeople
            already={taken}
            onClose={() => setAdding(false)}
            onPick={(w) => {
              onAdd(w);
              setAdding(false);
            }}
          />
        ) : (
          <Act onClick={() => setAdding(true)} icon={Plus}>
            Add people or teams…
          </Act>
        ))}

    </>
  );
}

/** One exception, and the one control that changes or removes it. */
function Line({
  row,
  mayEdit,
  onLevel,
}: {
  row: Reaches & { pendingLevel?: Level | null };
  mayEdit: boolean;
  onLevel: (level: Level | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const level = row.pendingLevel === undefined ? row.level : row.pendingLevel;
  if (level === null) return null;

  return (
    <div
      className={`relative flex items-center gap-2.5 px-3.5 py-2 ${
        row.pendingLevel !== undefined ? PENDING : "hover:bg-raise"
      }`}
    >
      <Face who={{ name: row.name, kind: row.subjectKind === "team" ? "team" : "person" }} />
      <span className="min-w-0 flex-1 truncate text-ui text-bone">{row.name}</span>
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
                  onClick={() => {
                    onLevel(l.value);
                    setOpen(false);
                  }}
                  className="block w-full px-3 py-1.5 text-left text-ui text-text hover:bg-raise"
                >
                  {level === l.value ? "✓ " : "   "}
                  {l.label}
                </button>
              ))}
              <div className="h-px bg-line" />
              <button
                onClick={() => {
                  onLevel(null);
                  setOpen(false);
                }}
                className="block w-full px-3 py-1.5 text-left text-ui text-brick hover:bg-raise"
              >
                Remove access
              </button>
            </div>
          )}
        </>
      ) : (
        <span className="shrink-0 text-meta text-dim">{said(level)}</span>
      )}
    </div>
  );
}

/* ── step two: where ──────────────────────────────────────────────────── */

function Places({
  chosen,
  hereId,
  directories,
  onPick,
}: {
  chosen: Place;
  hereId: string | null;
  directories: Somewhere[];
  onPick: (p: Place) => void;
}) {
  const holds = (d: Somewhere) => {
    const n = d.workspaces + d.hosts + d.agentAccounts + d.secrets;
    return n === 0 ? "empty" : `${n} thing${n === 1 ? "" : "s"}`;
  };

  return (
    <>
      <Option
        on={chosen.kind === "mine"}
        onPick={() => onPick({ kind: "mine" })}
        title="Only you"
        note="Nobody else."
      />
      {directories.map((d) => (
        <Option
          key={d.id}
          on={chosen.kind === "directory" && chosen.id === d.id}
          onPick={() => onPick({ kind: "directory", id: d.id })}
          title={d.name}
          note={`${holds(d)}${d.id === hereId ? " · where it is now" : ""}`}
        />
      ))}
      <div className="mx-3.5 my-1 h-px bg-line" />
      <Option
        on={chosen.kind === "new"}
        onPick={() => onPick({ kind: "new" })}
        title="A new directory…"
        note="For people who are not together anywhere yet"
      />
    </>
  );
}

/* ── step three: a new one ────────────────────────────────────────────── */

function NewDirectory({
  name,
  onName,
  people,
  onPeople,
  taken,
}: {
  name: string;
  onName: (s: string) => void;
  people: { who: Pickable; level: Level }[];
  onPeople: (p: { who: Pickable; level: Level }[]) => void;
  taken: string[];
}) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <div className="px-3.5 pt-3">
        <input
          autoFocus
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="What to call it"
          className="w-full rounded-md border border-slate-deep bg-ground px-2.5 py-1.5 text-ui text-bone placeholder:text-mute focus:outline-none"
        />
        <p className="mt-1.5 text-micro leading-relaxed text-mute">
          {name.trim() ? (
            <>
              It will be <span className="font-mono text-dim">d/{pathSlug(name)}</span> — the part
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
      {people.map((g, i) => (
        <div key={g.who.id} className={`flex items-center gap-2.5 px-3.5 py-2 ${PENDING}`}>
          <Face who={g.who} />
          <span className="min-w-0 flex-1 truncate text-ui text-bone">{g.who.name}</span>
          <button
            onClick={() =>
              onPeople(
                people.map((x, j) =>
                  i === j ? { ...x, level: x.level === "writer" ? "viewer" : "writer" } : x,
                ),
              )
            }
            className="shrink-0 rounded-md border border-line bg-raise px-2 py-0.5 text-meta text-text"
          >
            {said(g.level)} ⌄
          </button>
          <button
            onClick={() => onPeople(people.filter((_, j) => j !== i))}
            aria-label={`Take ${g.who.name} out`}
            className="shrink-0 text-mute hover:text-brick"
          >
            ✕
          </button>
        </div>
      ))}
      {adding ? (
        <PickPeople
          already={[...taken, ...people.map((g) => g.who.id)]}
          onClose={() => setAdding(false)}
          onPick={(w) => {
            onPeople([...people, { who: w, level: "writer" }]);
            setAdding(false);
          }}
        />
      ) : (
        <Act onClick={() => setAdding(true)} icon={Plus}>
          Add people or teams…
        </Act>
      )}
      <p className="px-3.5 py-2.5 text-micro leading-relaxed text-mute">
        You administer it, so you keep this workspace and decide who else sees it.
      </p>
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

/**
 * How many are in a directory, said honestly.
 *
 * "3 people" was wrong: a grant is held by a person *or* a team, and a
 * directory usually holds both. "3 principals" is the schema's word for the two
 * together and has no business on a screen — so this says which, and only
 * mentions a kind that is actually there.
 */
function counted(rows: Reaches[]): string {
  const people = rows.filter((r) => r.subjectKind === "person").length;
  const teams = rows.filter((r) => r.subjectKind === "team").length;
  const said = [
    people && `${people} ${people === 1 ? "person" : "people"}`,
    teams && `${teams} ${teams === 1 ? "team" : "teams"}`,
  ].filter(Boolean);
  return said.length ? said.join(" · ") : "nobody";
}

/** Whether a pending choice is where it already is. */
function samePlace(p: Place, hereId: string | null, root: string) {
  if (p.kind === "mine") return root === "u";
  if (p.kind === "directory") return p.id === hereId;
  return false;
}

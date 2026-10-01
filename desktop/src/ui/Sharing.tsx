"use client";

/**
 * Who can access one thing — a workspace, a machine, a subscription, a secret.
 *
 * **One sheet for all four, because it is one question.** The server has always
 * answered it generically: `filed_where` takes an alias, `FiledRef` takes a
 * kind, and every read of every kind runs the same predicate. Only this
 * component was wired to workspaces. What actually differs between the kinds is
 * four nouns and which list to refresh afterwards, which is `KINDS` below —
 * everything else would have been four copies drifting apart.
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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  UserPlus,
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
  setException,
  unfileItems,
  useAccessOf,
  useListGrants,
} from "~/api/generated/access/access";
import { useMe } from "~/api/generated/auth/auth";
import type { FiledKind, Level, Reaches } from "~/api/generated/model";
import { useDirectories, why } from "~/data";
import { destinations, pathSlug, rootOf, where } from "~/filing";
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

/**
 * The whole of what a kind changes: a noun.
 *
 * The sheet says "this machine will go in it", and saying "this item" would be
 * the sort of writing that makes a product feel like a database browser.
 */
const KINDS: Record<FiledKind, string> = {
  workspace: "workspace",
  machine: "machine",
  agentAccount: "subscription",
  secret: "secret",
  // Here for completeness and never drawn: this sheet is how something is
  // filed into a directory, and a repository cannot be. The server refuses it
  // by name, and nothing opens the sheet for one.
  repository: "repository",
};

/**
 * The way in: the control that opens the sheet, for anything.
 *
 * **Two looks, one sheet.** Where it appears is genuinely different — a toolbar
 * control next to the terminal and the bin, or a chip at the end of a table row
 * — and what it opens is not. Before this, three screens had a menu of their
 * own that could move a thing between directories and had no way to say "and
 * let Ana in", while the fourth had the whole sheet. The capability was on the
 * server for all four the entire time; only the screens disagreed.
 *
 * **It opens for everybody, including whoever may change nothing.** Who can
 * reach a thing is worth reading whether or not you may alter it, and the sheet
 * says in its own words what you may do. Hiding it from a reader teaches them
 * the screen is broken; showing them a control the server refuses teaches them
 * the same. Saying what is true and offering nothing to change is neither.
 */
export function WhoCanAccess({
  kind,
  id,
  path,
  look,
}: {
  kind: FiledKind;
  id: string;
  /** Where it is now. */
  path?: string | null;
  look: "toolbar" | "chip";
}) {
  const [open, setOpen] = useState(false);
  const me = useMe();

  // Nothing to open: an *attached* thing — an agent account's own credential,
  // the install's own secrets — is filed nowhere and has no access of its own.
  // Only the chip can be absent; the toolbar's control holds its place in a row
  // of icons, and one that comes and goes moves its neighbours under the
  // pointer.
  if (look === "chip" && !path) return null;

  const sheet = open && <Sharing kind={kind} id={id} onClose={() => setOpen(false)} />;

  if (look === "chip") {
    return (
      <>
        <button
          onClick={() => setOpen(true)}
          title="Who can access it"
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-micro text-mute transition-colors hover:bg-raise hover:text-bone"
        >
          <Icon of={UserPlus} size={12} />
          {where(path, me.data?.user)}
        </button>
        {sheet}
      </>
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        title={`Who can access it — ${path ?? "yours"}`}
        className={`control gap-1.5 ${open ? "bg-overlay text-bone" : "text-mute hover:bg-raise hover:text-bone"}`}
      >
        <UserPlus className="h-4 w-4 shrink-0" strokeWidth={1.75} />
        {/* The root on the button when it is shared, because "who can see my
            work" is not a question anybody should have to open a dialog to
            answer. Nothing in your own space, which is the quiet default, and
            capped because a directory can be called anything. */}
        {path?.startsWith("d/") && (
          <span className="max-w-[150px] truncate font-mono text-micro">
            {path.split("/").slice(0, 2).join("/")}
          </span>
        )}
      </button>
      {sheet}
    </>
  );
}

export function Sharing({
  kind,
  id,
  onClose,
}: {
  kind: FiledKind;
  id: string;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const confirm = useConfirm();
  const item = useMemo(() => ({ kind, id }), [kind, id]);
  const one = KINDS[kind];
  const { data, isPending, error } = useAccessOf({ kind, id });
  const { data: directories } = useDirectories();
  const me = useMe();

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
      /* Everything, and not a list of keys.
       *
       * Where a thing is filed is on more screens than the one it was filed
       * from — its own list, the directories, the toolbar chip, the tracker
       * row — and naming them meant a chip kept showing the old directory
       * until something else happened to refetch. That list also has to be
       * added to every time a path appears somewhere new, and it was already
       * one short: a filed API key is drawn from the trackers list, which was
       * in none of the three.
       *
       * Filing something is rare and deliberate. Refetching what is on screen
       * costs a great deal less than a screen that quietly disagrees with the
       * server about who can read something. */
      await cache.invalidateQueries();
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

  /* Who is in the directory it is going to. A destination is somewhere they may
     at least work, so they may always read its grants — and the pending row
     has to say who is in it, not just its name. */
  const goingTo = moving && place?.kind === "directory" ? place.id : null;
  const { data: waiting } = useListGrants(goingTo ?? "", {
    query: { enabled: goingTo !== null },
  });

  /**
   * Where it would end up, shaped exactly like where it is now.
   *
   * The pending move used to be an extra line under the directory row saying
   * "Moving to X — when you save". Two rows for one question read as two
   * places it lives. This describes the destination in the same terms — a
   * name, a slug, who is in it — so the row can simply be swapped.
   */
  const destination = (): Landing | null => {
    if (!moving || !place) return null;
    if (place.kind === "mine")
      return {
        name: "Only you",
        note: `u/${me.data?.user.slug ?? ""}`,
        count: "just you",
        personal: true,
        who: null,
      };
    if (place.kind === "new") {
      const inside = [
        { subjectId: "you", subjectKind: "person", name: "You", level: "admin" as Level },
        ...newWith.map((g) => ({
          subjectId: g.who.id,
          subjectKind: g.who.kind,
          name: g.who.name,
          level: g.level,
        })),
      ];
      return {
        name: newName.trim() || "A new directory",
        note: `d/${pathSlug(newName)}`,
        count: counted(inside),
        personal: false,
        who: inside,
      };
    }
    const d = directories.find((x) => x.id === place.id);
    const inside = (waiting ?? []).map((g) => ({
      subjectId: g.subjectId,
      subjectKind: g.subjectKind,
      name: g.subjectName,
      level: g.level,
    }));
    return {
      name: d?.name ?? "somewhere",
      note: d ? `d/${d.slug}` : "",
      count: counted(inside),
      personal: false,
      who: inside,
    };
  };

  const title =
    step === "places" ? "Where it lives" : step === "new" ? "A new directory" : "Who can access it";
  const subtitle = step === "new" ? `This ${one} will go in it` : (data?.path ?? "");

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

          {/* Said, and not mistaken for an answer. A failed read left `mayShare`
              at its `false` default, so the sheet explained a permission the
              person already had — "only its owner can change this" to the
              owner. A screen that cannot load something has to say so. */}
          {!isPending && !data && (
            <p className="px-3.5 py-3 text-ui text-brick">{why(error)}</p>
          )}

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
              onUndoMove={() => setPlace(null)}
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
              one={one}
              meId={me.data?.user.id}
            />
          )}

          {data && step === "main" && !mayShare && (
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
  onUndoMove,
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
  destination: Landing | null;
  onUndoMove: () => void;
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<{ id: string; at: HTMLElement } | null>(null);

  return (
    <>
      <Label>{(destination ? destination.personal : !here) ? "Owner" : "Directory access"}</Label>

      {/* Where it would go *replaces* where it is, rather than sitting under
          it. Two rows for one question read as two places it lives at once —
          and the destination is described in the same terms, so the swap is
          the only difference apart from the tint and the way back. */}
      {destination ? (
        <Where
          key={destination.note}
          name={destination.name}
          note={destination.note}
          count={destination.count}
          who={destination.who}
          personal={destination.personal}
          pending
          onUndo={onUndoMove}
        />
      ) : here ? (
        <Where
          name={here.name}
          note={`d/${here.slug}`}
          count={counted(fromDirectory)}
          who={fromDirectory}
          personal={false}
          pending={false}
        />
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
          open={menu?.id === r.subjectId ? menu.at : null}
          onOpen={(at) => setMenu(at ? { id: r.subjectId, at } : null)}
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
/** Somebody a directory lets in — a grant, or a staged one on a new directory. */
type Member = { subjectId: string; subjectKind: string; name: string; level: Level };

/** Where something lives, or would. */
type Landing = {
  name: string;
  /** `d/slug` or `u/slug`, under the name. */
  note: string;
  count: string;
  personal: boolean;
  /** Null when there is nobody to list, which is what a personal space is. */
  who: Member[] | null;
};

/**
 * Where it lives — one component, so that where it *would* live cannot drift.
 *
 * The pending row is this row with a tint and a way back. Written twice, the
 * two would differ within a week, and the whole point is that swapping them is
 * the only change on the screen.
 *
 * Folded by default: a directory with twenty people in it would otherwise bury
 * the lines that are actually about this workspace.
 */
function Where({
  name,
  note,
  count,
  who,
  personal,
  pending,
  onUndo,
}: {
  name: string;
  note: string;
  count: string;
  who: Member[] | null;
  personal: boolean;
  pending: boolean;
  onUndo?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const many = (who?.length ?? 0) > 0;

  return (
    <>
      <div
        className={`flex items-center gap-2.5 pr-3.5 pl-3.5 ${pending ? PENDING : "hover:bg-raise"}`}
      >
        {/* Two buttons and not one, because the way back belongs *between* the
            slug and the count — and a button cannot contain a button. The
            second carries no label of its own: it only keeps the count and the
            chevron clickable, which is where anybody expands a row from. */}
        <button
          disabled={!many}
          onClick={() => setOpen((v) => !v)}
          aria-label={`People in ${name}`}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-2 text-left disabled:cursor-default"
        >
          <span className="grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full border border-line bg-overlay text-dim">
            <Icon of={personal ? UserRound : FolderOpen} size={12} />
          </span>
          <span className="min-w-0 flex-1 truncate text-ui text-bone">
            {name} <span className="font-mono text-micro text-mute">{note}</span>
          </span>
        </button>
        {onUndo && (
          <button
            onClick={onUndo}
            aria-label="Leave it where it is"
            className="shrink-0 px-1 py-2 text-meta text-mute hover:text-bone"
          >
            Cancel
          </button>
        )}
        <button
          disabled={!many}
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => setOpen((v) => !v)}
          className="flex shrink-0 items-center gap-2.5 py-2 disabled:cursor-default"
        >
          <span className="text-micro text-mute">{count}</span>
          {many && <Icon of={open ? ChevronDown : ChevronRight} size={12} />}
        </button>
      </div>
      {open &&
        who?.map((m) => (
          <div
            key={m.subjectId}
            className={`flex items-center gap-2.5 py-1.5 pr-3.5 pl-9 ${pending ? PENDING : ""}`}
          >
            <Face who={{ name: m.name, kind: m.subjectKind === "team" ? "team" : "person" }} />
            <span className="min-w-0 flex-1 truncate text-ui text-text">{m.name}</span>
            <span className="shrink-0 text-meta text-dim">{said(m.level)}</span>
          </div>
        ))}
    </>
  );
}

/**
 * A menu that gets out of the sheet.
 *
 * The rows live in an `overflow-y-auto` column inside an `overflow-hidden`
 * card, and a clipping ancestor clips whatever its descendants' `z-index` say
 * — the last row's level menu came out cut in half, and no stacking would have
 * saved it. So it is not a descendant: it goes into `document.body` at
 * coordinates read off the button, and flips above when the room below has run
 * out.
 *
 * The price of coordinates is that they stop being true. Anything that could
 * move the button underneath it — a scroll, a resize — closes it rather than
 * leaving a menu pointing at nothing.
 */
function Pop({
  anchor,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  // Measured rather than guessed, so the flip keeps working when the menu is
  // four rows instead of three.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const to = anchor.getBoundingClientRect();
    setAt({
      top:
        window.innerHeight - to.bottom - 8 < el.offsetHeight
          ? to.top - el.offsetHeight - 4
          : to.bottom + 4,
      left: Math.max(8, to.right - el.offsetWidth),
    });
  }, [anchor]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      // Not the button, which toggles itself: closing here first would let its
      // own click reopen what it meant to shut.
      if (!box.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    // Captured at the document, which runs before the sheet's own Escape on the
    // window — otherwise dismissing this menu threw the whole sheet away.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={box}
      role="menu"
      style={{ position: "fixed", top: at?.top ?? -9999, left: at?.left ?? -9999 }}
      className={`z-[70] w-44 overflow-hidden rounded-lg border border-line bg-panel shadow-(--shadow-float) ${
        at ? "" : "invisible"
      }`}
    >
      {children}
    </div>,
    document.body,
  );
}

function Line({
  row,
  mayEdit,
  onLevel,
  open,
  onOpen,
}: {
  row: Reaches & { pendingLevel?: Level | null };
  mayEdit: boolean;
  onLevel: (level: Level | null) => void;
  /* Whose menu is open is one answer for the whole list, held above. Each row
     holding its own meant two could be open at once, drawn over each other. */
  open: HTMLElement | null;
  onOpen: (at: HTMLElement | null) => void;
}) {
  const level = row.pendingLevel === undefined ? row.level : row.pendingLevel;
  if (level === null) return null;

  return (
    <div
      className={`flex items-center gap-2.5 px-3.5 py-2 ${
        row.pendingLevel !== undefined ? PENDING : "hover:bg-raise"
      }`}
    >
      <Face who={{ name: row.name, kind: row.subjectKind === "team" ? "team" : "person" }} />
      <span className="min-w-0 flex-1 truncate text-ui text-bone">{row.name}</span>
      {mayEdit ? (
        <>
          <button
            onClick={(e) => onOpen(open ? null : e.currentTarget)}
            className="shrink-0 rounded-md border border-line bg-raise px-2 py-0.5 text-meta text-text hover:bg-overlay"
          >
            {said(level)} ⌄
          </button>
          {open && (
            <Pop anchor={open} onClose={() => onOpen(null)}>
              {LEVELS.map((l) => (
                <button
                  key={l.value}
                  onClick={() => {
                    onLevel(l.value);
                    onOpen(null);
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
                  onOpen(null);
                }}
                className="block w-full px-3 py-1.5 text-left text-ui text-brick hover:bg-raise"
              >
                Remove access
              </button>
            </Pop>
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
  one,
  meId,
}: {
  name: string;
  onName: (s: string) => void;
  people: { who: Pickable; level: Level }[];
  onPeople: (p: { who: Pickable; level: Level }[]) => void;
  /** What this is, in a word: "workspace", "machine", "secret". */
  one: string;
  meId: string | undefined;
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
          /* Only who is already *in this new directory* — not who can reach
             the workspace we came from. A directory that does not exist yet
             has nobody in it, and excluding the workspace's people made the
             picker claim "everybody already has access" to something empty. */
          already={[...people.map((g) => g.who.id), ...(meId ? [meId] : [])]}
          empty="Everybody is in it already."
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
        You administer it, so you keep this {one} and decide who else sees it.
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
function counted(rows: { subjectKind: string }[]): string {
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

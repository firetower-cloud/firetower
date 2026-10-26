/**
 * Every artifact you can reach.
 *
 * This screen is the reason an artifact is owned by a person rather than by a
 * workspace. `reclaim.rs` deletes a workspace within a minute of its last
 * session ending and the cascade takes the conversation with it — so a list
 * spanning conversations can only exist if these rows deliberately sit outside
 * that cascade. They do: `artifacts` has foreign keys to `users` and
 * `organizations` and to nothing else.
 *
 * **A grid, and this is a considered exception to one of the house rules.**
 * `STYLE.md` names "a rounded card around everything" as a habit that makes an
 * interface look generated, and the reason it gives is that one radius on
 * every object *flattens the hierarchy it was supposed to express*. There is
 * no hierarchy to flatten here: one kind of object, and what identifies each
 * one is a picture. Browsing is the whole job of this screen, and you cannot
 * browse what you cannot see.
 *
 * What is *not* copied from the products this resembles: the border goes
 * around the thumbnail, not around the tile and its label together. A border
 * around the bytes and nothing around the sentence is the same choice
 * `WorkspaceImage` already makes for a picture in the transcript.
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, LayoutGrid, MoreHorizontal, Rows3, Search, Shapes } from "lucide-react";
import {
  useListArtifacts,
  deleteArtifact,
  getListArtifactsQueryKey,
} from "~/api/generated/artifacts/artifacts";
import { useQueryClient } from "@tanstack/react-query";
import { ContextMenu, useMenu, type MenuItem } from "~/ui/ContextMenu";
import { useConfirm } from "~/ui/Confirm";
import { bridge as shell } from "~/bridge";
import { apiBase, token } from "~/client/http";
import type { Artifact } from "~/api/generated/model";
import { elapsed, minutesSince } from "~/api/view";
import { ArtifactTab } from "~/ui/ArtifactTab";
import { why } from "~/data";
import { ArtifactShot } from "~/components/ArtifactShot";

type Scope = "all" | "mine" | "shared";
type Sort = "recent" | "name";
type Look = "grid" | "list";

const LOOK_KEY = "firetower.artifacts.look";

export function ArtifactsPage() {
  /* No interval of its own — `Posters` polls for every screen. Two screens
     each naming a cadence is how the list came to be fetched on two timers. */
  const { data, isPending, error } = useListArtifacts();
  const everything = useMemo(() => data ?? [], [data]);

  const [scope, setScope] = useState<Scope>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [look, setLook] = useState<Look>(() => {
    try {
      return window.localStorage.getItem(LOOK_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(LOOK_KEY, look);
    } catch {
      /* A window told to keep nothing still works for this visit. */
    }
  }, [look]);

  /* `mine` comes from the server, decided on the path, so this cannot
     disagree with what `filed_where` let through in the first place. */
  const showing = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return everything
      .filter((a) => (scope === "all" ? true : scope === "mine" ? a.mine : !a.mine))
      .filter(
        (a) =>
          !needle ||
          a.title.toLowerCase().includes(needle) ||
          (a.fromWorkspaceName ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) =>
        sort === "name"
          ? a.title.localeCompare(b.title)
          : b.updatedAt.localeCompare(a.updatedAt),
      );
  }, [everything, scope, query, sort]);

  const shared = everything.filter((a) => !a.mine).length;
  const reading = everything.find((a) => a.id === open) ?? null;

  /* The three things you do to an artifact without opening it. Built here
     rather than per tile so the grid and the list offer the same menu. */
  const menu = useMenu<Artifact>();
  const confirm = useConfirm();
  const cache = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const itemsFor = (a: Artifact): MenuItem[] => [
    {
      label: "Copy link",
      onPick: () => {
        void navigator.clipboard.writeText(a.url);
        setNotice("Link copied.");
      },
    },
    {
      label: "Download as .zip",
      onPick: () => {
        void shell
          .save(
            `${apiBase()}/api/v1/artifacts/${a.id}/download`,
            `${a.slug || "artifact"}-v${a.version}.zip`,
            token(),
          )
          .catch((e) => setNotice(why(e) ?? "Could not save that."));
      },
    },
    "-",
    {
      label: "Delete",
      tone: "danger",
      // `may_share` is the writer check, and the server decides again
      // whatever this draws.
      disabled: !a.mayShare,
      onPick: () => {
        void (async () => {
          const sure = await confirm({
            title: `Delete “${a.title}”?`,
            body: "The page and every version of it go. There is no undo, and nothing to restore from once the workspace that made it is gone.",
            action: "Delete",
            tone: "danger",
          });
          if (!sure) return;
          try {
            await deleteArtifact(a.id);
            if (open === a.id) setOpen(null);
            await cache.invalidateQueries({ queryKey: getListArtifactsQueryKey() });
          } catch (e) {
            setNotice(why(e) ?? "Could not delete it.");
          }
        })();
      },
    },
  ];

  if (isPending) return <Empty title="Looking…">Reading what you have published.</Empty>;
  if (error)
    return <Empty title="That did not load.">{why(error) ?? "Could not read your artifacts."}</Empty>;
  if (everything.length === 0)
    return (
      <Empty title="No artifacts yet">
        Ask your agent to create an artifact and it will appear in this section.
      </Empty>
    );

  /* Reading one takes the screen. The browse grid is for finding; once found,
     the artifact wants every pixel — which was the original complaint about
     looking at one of these in a 700px frame. */
  if (reading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
          <button
            onClick={() => {
              setOpen(null);
              setExpanded(false);
            }}
            className="control plain text-dim hover:bg-raise hover:text-bone"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
            All artifacts
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <ArtifactTab
            key={reading.id}
            artifact={reading}
            sessionId={reading.fromSessionId ?? null}
            expanded={expanded}
            onExpanded={setExpanded}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <Shapes className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
        <span className="shrink-0 text-ui text-bone">Artifacts</span>
        <span className="shrink-0 font-mono text-micro text-mute">{everything.length}</span>

        {/* Offered only once there is a second list to go to. A "Shared" tab
            that is always empty teaches people the feature does not work. */}
        {shared > 0 && (
          <div className="track ml-3 shrink-0">
            {(
              [
                ["all", "All"],
                ["mine", "Yours"],
                ["shared", "Shared"],
              ] as [Scope, string][]
            ).map(([id, label]) => (
              <button key={id} data-on={scope === id} onClick={() => setScope(id)}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* The app's own field idiom — `.search` lives in the prototype
            stylesheet, not in this one, and would have rendered as nothing. */}
        <div className="ml-auto flex w-[16rem] shrink-0 items-center gap-1.5 rounded-md border border-line bg-ground px-2 py-1 focus-within:border-mute">
          <Search className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find an artifact"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-ui text-bone placeholder:text-mute focus:outline-none"
          />
        </div>

        <div className="track shrink-0">
          <button data-on={sort === "recent"} onClick={() => setSort("recent")}>
            Recent
          </button>
          <button data-on={sort === "name"} onClick={() => setSort("name")}>
            Name
          </button>
        </div>

        <div className="track shrink-0">
          <button data-on={look === "grid"} onClick={() => setLook("grid")} title="Grid">
            <LayoutGrid className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <button data-on={look === "list"} onClick={() => setLook("list")} title="List">
            <Rows3 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
        {showing.length === 0 ? (
          <Empty
            title={
              query.trim()
                ? "Nothing matches"
                : scope === "shared"
                  ? "Nothing shared yet"
                  : "Nothing of your own"
            }
          >
            {query.trim()
              ? `No artifact is called “${query.trim()}”.`
              : scope === "shared"
                ? "Move one into a directory with the share control and everybody there can reach it."
                : "Everything here is filed in a directory rather than at your own root."}
          </Empty>
        ) : look === "grid" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4 p-4">
            {showing.map((a) => (
              <Tile key={a.id} artifact={a} onOpen={() => setOpen(a.id)} onMenu={menu.show} />
            ))}
          </div>
        ) : (
          <div className="p-1.5">
            {showing.map((a) => (
              <Line key={a.id} artifact={a} onOpen={() => setOpen(a.id)} onMenu={menu.show} />
            ))}
          </div>
        )}
      </div>

      {menu.open && (
        <ContextMenu at={menu.open.at} items={itemsFor(menu.open.on)} onClose={menu.close} />
      )}
      {notice && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full border border-line bg-overlay px-3.5 py-1.5 text-meta text-dim shadow-(--shadow-float)">
          {notice}
        </div>
      )}
    </div>
  );
}

function Tile({
  artifact,
  onOpen,
  onMenu,
}: {
  artifact: Artifact;
  onOpen: () => void;
  onMenu: (e: React.MouseEvent, a: Artifact) => void;
}) {
  return (
    <div className="group/tile relative">
      {/* One card around the picture and its name.
          The house habit is a border round the bytes and nothing round the
          sentence — which is right in a transcript, where a card would
          compete with the conversation. A library is the other case: the
          tile *is* the object, there is one kind of them, and the card is
          what says where one ends and the next begins. */}
      <button
        onClick={onOpen}
        onContextMenu={(e) => onMenu(e, artifact)}
        className="block w-full overflow-hidden rounded-lg border border-line bg-panel text-left transition-colors hover:border-mute"
      >
        <ArtifactShot artifact={artifact} framed={false} />
        <span className="flex items-center gap-2.5 border-t border-line-soft px-3 py-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line bg-raise">
            <Shapes className="h-4 w-4 text-mute" strokeWidth={1.75} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui text-bone">{artifact.title}</span>
            <span className="mt-0.5 flex items-center gap-1.5 text-micro text-mute">
              <span className="font-mono">v{artifact.version}</span>
              <span>·</span>
              <span className="truncate">
                {artifact.mine
                  ? (artifact.fromWorkspaceName ?? "no workspace")
                  : (artifact.path?.split("/")[1] ?? "shared")}
              </span>
              <span className="ml-auto shrink-0">{elapsed(minutesSince(artifact.updatedAt))}</span>
            </span>
          </span>
        </span>
      </button>
      {/* On the thumbnail, above the shield, and only once the pointer is
          here — a control on every tile all the time is six controls
          competing with the thing they are about. */}
      <button
        onClick={(e) => onMenu(e, artifact)}
        title="More"
        className="absolute top-1.5 right-1.5 z-20 grid h-6 w-6 place-items-center rounded-md border border-line bg-overlay text-dim opacity-0 transition-opacity group-hover/tile:opacity-100 hover:text-bone focus-visible:opacity-100"
      >
        <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
}

function Line({
  artifact,
  onOpen,
  onMenu,
}: {
  artifact: Artifact;
  onOpen: () => void;
  onMenu: (e: React.MouseEvent, a: Artifact) => void;
}) {
  return (
    <button
      onClick={onOpen}
      onContextMenu={(e) => onMenu(e, artifact)}
      className="group/line flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-raise/60"
    >
      <span className="block w-[84px] shrink-0">
        <ArtifactShot artifact={artifact} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui text-text">{artifact.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-micro text-mute">
          <span className="font-mono">v{artifact.version}</span>
          <span>·</span>
          <span className="truncate">
            {artifact.mine ? (artifact.fromWorkspaceName ?? "no workspace") : (artifact.path?.split("/")[1] ?? "shared")}
          </span>
        </span>
      </span>
      <span className="shrink-0 text-micro text-mute">{elapsed(minutesSince(artifact.updatedAt))}</span>
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onMenu(e, artifact);
        }}
        title="More"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-mute opacity-0 transition-opacity group-hover/line:opacity-100 hover:bg-raise hover:text-bone"
      >
        <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.75} />
      </span>
    </button>
  );
}

/**
 * The first thing anybody sees here, and for a while the only thing.
 *
 * A sentence of grey text floating in the middle of a dark window reads as a
 * screen that failed to load. It gets the glyph the rail uses for this
 * section, a line that says what the screen is, and a line that says how to
 * make something appear — which is the only question somebody has while
 * looking at it.
 */
function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center px-6 py-24">
      <div className="flex flex-col items-center text-center">
        {/* The same shape as the rail entry, at the size the mark uses when
            it is the subject rather than a row's label. */}
        <span className="grid h-14 w-14 place-items-center rounded-xl border border-line bg-raise shadow-(--shadow-raise)">
          <Shapes className="h-6 w-6 text-dim" strokeWidth={1.5} />
        </span>
        <p className="mt-5 text-title font-medium text-bone">{title}</p>
        <p className="mt-2 max-w-[42ch] text-ui leading-relaxed text-mute">{children}</p>
      </div>
    </div>
  );
}

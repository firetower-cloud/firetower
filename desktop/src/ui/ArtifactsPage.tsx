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
import { ArrowLeft, LayoutGrid, MoreHorizontal, Rows3, Search, Shapes, Sparkles } from "lucide-react";
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
import { useStart } from "~/start";
import { ArtifactShot } from "~/components/ArtifactShot";

type Scope = "all" | "mine" | "shared";
type Sort = "recent" | "name";
type Look = "grid" | "list";

const LOOK_KEY = "firetower.artifacts.look";

export function ArtifactsPage() {
  const start = useStart();
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

  /* Loading and error wear the pane rather than replacing it. A screen that
     swaps its whole self for one grey sentence reads as having navigated
     somewhere, and the heading is the one thing that is true either way. */
  if (isPending) return <Pane>{<p className="mt-8 text-read text-mute">Reading what you have published…</p>}</Pane>;
  if (error) return <Pane>{<p className="mt-8 text-read text-brick">{why(error) ?? "Could not read your artifacts."}</p>}</Pane>;
  if (everything.length === 0)
    return (
      <Pane>
        <Nothing title="Nothing published yet" onAsk={() => start({ prompt: "Make me an artifact that " })}>
          Ask an agent for a chart, a mock-up or a report and it appears here.
        </Nothing>
      </Pane>
    );

  /* Reading one takes the screen. The browse grid is for finding; once found,
     the artifact wants every pixel — which was the original complaint about
     looking at one of these in a 700px frame. */
  if (reading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line-soft px-3">
          <button
            onClick={() => {
              setOpen(null);
              setExpanded(false);
            }}
            className="btn quiet"
          >
            <ArrowLeft className="h-[15px] w-[15px]" strokeWidth={1.75} />
            All artifacts
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <ArtifactTab
            key={reading.id}
            artifact={reading}
            /* Deliberately not `fromSessionId`: the library is full of
               artifacts whose workspace has been reclaimed, and that column
               goes on naming one. `null` means "ask". */
            sendTo={null}
            expanded={expanded}
            onExpanded={setExpanded}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="scroll-slim relative min-h-0 flex-1 overflow-y-auto">
      <div className="pcol">
        <div className="phead2">
          <div className="min-w-0">
            <h1>Artifacts</h1>
            <p className="sub">
              A page an agent published for you to look at. It outlives the workspace that made it.
            </p>
          </div>
          <div className="acts">
            <label className="find">
              <Search className="h-[15px] w-[15px] shrink-0" strokeWidth={1.75} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find an artifact"
                spellCheck={false}
                aria-label="Find an artifact"
                className="placeholder:text-mute focus:outline-none"
              />
            </label>
            {/* The one filled button on the screen. Everything else here is a
                filter or a view, and a second filled button would make the
                reader decide which was the real one. */}
            <button onClick={() => start({ prompt: "Make me an artifact that " })} className="btn primary">
              <Sparkles className="h-[15px] w-[15px]" strokeWidth={1.75} />
              Ask for one
            </button>
          </div>
        </div>

        <div className="filters">
          {(
            [
              ["all", "All"],
              ["mine", "Yours"],
              ["shared", "Shared with you"],
            ] as [Scope, string][]
          ).map(([id, label]) => (
            <button key={id} className="fp" aria-pressed={scope === id} onClick={() => setScope(id)}>
              {label}
            </button>
          ))}
          <span className="right">
            {/* Sorting has no home in the drawing and is a real thing people
                do with three hundred of these, so it keeps the filter shape
                rather than inventing a control. */}
            <button className="fp" aria-pressed={sort === "recent"} onClick={() => setSort("recent")}>
              Recent
            </button>
            <button className="fp" aria-pressed={sort === "name"} onClick={() => setSort("name")}>
              Name
            </button>
            <span className="ml-2 flex items-center gap-1">
              <button
                onClick={() => setLook("grid")}
                title="Grid"
                aria-label="Grid"
                className={`grid h-7 w-7 place-items-center rounded-md ${look === "grid" ? "text-bone" : "text-mute hover:text-text"}`}
              >
                <LayoutGrid className="h-4 w-4" strokeWidth={1.75} />
              </button>
              <button
                onClick={() => setLook("list")}
                title="List"
                aria-label="List"
                className={`grid h-7 w-7 place-items-center rounded-md ${look === "list" ? "text-bone" : "text-mute hover:text-text"}`}
              >
                <Rows3 className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </span>
          </span>
        </div>

        {showing.length === 0 ? (
          <Nothing
            title={query.trim() ? "Nothing matches" : scope === "shared" ? "Nothing shared yet" : "Nothing of your own"}
            onAsk={() => start({ prompt: "Make me an artifact that " })}
          >
            {query.trim()
              ? `No artifact is called “${query.trim()}”.`
              : scope === "shared"
                ? "Move one into a directory with the share control and everybody there can reach it."
                : "Everything here is filed in a directory rather than at your own root."}
          </Nothing>
        ) : look === "grid" ? (
          <div className="gal">
            {showing.map((a) => (
              <Tile key={a.id} artifact={a} onOpen={() => setOpen(a.id)} onMenu={menu.show} />
            ))}
          </div>
        ) : (
          <>
            <div className="colhead">
              <span className="w-[84px] flex-none" />
              <span className="flex-1">Artifact</span>
              <span className="w-[200px] flex-none">From</span>
              <span className="w-[52px] flex-none text-right">Updated</span>
              <span className="w-6 flex-none" />
            </div>
            <div className="alist">
              {showing.map((a) => (
                <Line key={a.id} artifact={a} onOpen={() => setOpen(a.id)} onMenu={menu.show} />
              ))}
            </div>
          </>
        )}
      </div>

      {menu.open && (
        <ContextMenu at={menu.open.at} items={itemsFor(menu.open.on)} onClose={menu.close} />
      )}
      {notice && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full bg-panel px-3.5 py-1.5 text-meta text-dim shadow-(--shadow-float)">
          {notice}
        </div>
      )}
    </div>
  );
}

/** The pane and its heading, which is true whatever the list is doing. */
function Pane({ children }: { children: React.ReactNode }) {
  return (
    <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
      <div className="pcol">
        <div className="phead2">
          <div className="min-w-0">
            <h1>Artifacts</h1>
            <p className="sub">
              A page an agent published for you to look at. It outlives the workspace that made it.
            </p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Where the artifact came from: the workspace, or the directory it is in. */
const cameFrom = (a: Artifact) =>
  a.mine ? (a.fromWorkspaceName ?? "no workspace") : (a.path?.split("/")[1] ?? "shared");

/**
 * One artifact in the library.
 *
 * **The poster is the card, and the name sits on the paper underneath it.**
 * It used to be a bordered card with the picture inside it and a 32px glyph
 * beside the title — a border round the bytes *and* round the sentence, which
 * is the habit `STYLE.md` names as what makes an interface look generated.
 * There is one kind of object on this screen and what identifies each one is
 * a picture; the picture can be the whole of it.
 */
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
      <button onClick={onOpen} onContextMenu={(e) => onMenu(e, artifact)} className="art" title={artifact.title}>
        <ArtifactShot artifact={artifact} framed={false} className="shot" />
        <span className="nm">{artifact.title}</span>
        <span className="mt">
          <span className="min-w-0 truncate">{cameFrom(artifact)}</span>
          <span className="ml-auto flex-none tabular-nums text-mute">
            {elapsed(minutesSince(artifact.updatedAt))}
          </span>
        </span>
      </button>
      {/* On the poster, and only once the pointer is here — a control on every
          tile all the time is six controls competing with what they are
          about. */}
      <button
        onClick={(e) => onMenu(e, artifact)}
        title="More"
        aria-label={`More for ${artifact.title}`}
        className="absolute top-1.5 right-1.5 z-20 grid h-6 w-6 place-items-center rounded-md bg-panel text-dim opacity-0 shadow-(--shadow-raise) transition-opacity group-hover/tile:opacity-100 hover:text-bone focus-visible:opacity-100"
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
    <button onClick={onOpen} onContextMenu={(e) => onMenu(e, artifact)} className="ar">
      <span className="block w-[84px] flex-none">
        <ArtifactShot artifact={artifact} className="shot rounded-lg" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-read text-bone">{artifact.title}</span>
        <span className="mt-0.5 block text-meta text-dim">
          Version {artifact.version}
          {!artifact.hasPoster && " · no picture yet"}
        </span>
      </span>
      <span className="w-[200px] flex-none truncate text-ui text-dim">{cameFrom(artifact)}</span>
      <span className="w-[52px] flex-none text-right text-ui tabular-nums text-dim">
        {elapsed(minutesSince(artifact.updatedAt))}
      </span>
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onMenu(e, artifact);
        }}
        title="More"
        className="ghost grid h-6 w-6 flex-none place-items-center rounded-md text-mute hover:bg-overlay hover:text-bone"
      >
        <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.75} />
      </span>
    </button>
  );
}

/**
 * The first thing anybody sees here, and for a while the only thing.
 *
 * A sentence of grey text floating in the middle of a window reads as a screen
 * that failed to load. It gets the section's own glyph, a line saying what the
 * screen is, a line saying how to make something appear — and the same primary
 * action the full screen has, because that is the only thing to do here.
 */
function Nothing({ title, children, onAsk }: { title: string; children: React.ReactNode; onAsk: () => void }) {
  return (
    <div className="grid place-items-center px-0 pt-[110px] pb-20 text-center">
      <div className="max-w-[40ch]">
        <span className="mx-auto grid h-[54px] w-[54px] place-items-center rounded-2xl bg-raise text-mute">
          <Shapes className="h-6 w-6" strokeWidth={1.5} />
        </span>
        <h2 className="mt-5 text-display font-mid text-bone">{title}</h2>
        <p className="mt-2 text-read leading-relaxed text-dim">{children}</p>
        <button onClick={onAsk} className="btn primary mt-5">
          <Sparkles className="h-[15px] w-[15px]" strokeWidth={1.75} />
          Ask for one
        </button>
      </div>
    </div>
  );
}

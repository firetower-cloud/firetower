/**
 * A Trello board, drawn as its columns.
 *
 * **Asked, not sorted.** Each column is its own request, the list's question
 * with `status` set to the column's list id (the key `/trackers/{id}/columns`
 * gives), and pages on its own. The
 * tempting version reads one page of cards and deals them into columns here, and it is
 * wrong twice: a page is thirty cards, so a quiet column comes out empty
 * however full it is, and a column's cards would be whichever thirty the
 * board happened to put first. The order of the columns is the tracker's own,
 * from `/columns`, for the same reason: a board with nothing in Review still
 * has a Review column.
 *
 * Every filter the list has (Open or Closed, Assigned to me, the query box)
 * applies to every column, because they are the same parameters. A column
 * adds one and changes none.
 *
 * Starting from a card is starting from a row: the page hands its own Start
 * down rather than this file deciding again what a task becomes.
 */
import { useState } from "react";
import { Play } from "lucide-react";
import { Avatar, Badge, Icon, Segmented } from "~/components/ui";
import { useTasks, useTrackerColumns } from "~/data";
import type { ListTasksParams, Task, TaskColumn, TrackerStatus } from "~/api/generated/model";

/** How the page lays its tasks out. The board is offered, never assumed. */
export type Layout = "list" | "board";

/**
 * What a person calls a task: the tail of its key.
 *
 * The org prefix is noise at every row and on every card, and `start` is
 * handed this same string as the issue, so both places have to agree on it.
 */
export function shortKey(key: string): string {
  return key.replace(/^[a-z]+:/, "").replace(/^.*\//, "");
}

/**
 * List or Board, or nothing at all.
 *
 * **Shown only when the board has answered with columns.** A git host has
 * none and says so with a 404, "All boards" is several boards with no one
 * set of columns, and a board with no lists has nothing to lay out. In all
 * three the page stays a list, and a toggle that could only offer the list
 * would be a control with one position.
 *
 * Recessed rather than pills: the filters beside it narrow different axes of
 * one list, and these two are the same tasks drawn two ways.
 */
export function ListOrBoard({
  source,
  team,
  value,
  onPick,
}: {
  source: TrackerStatus;
  team: string | undefined;
  value: Layout;
  onPick: (v: Layout) => void;
}) {
  const columns = useTrackerColumns(source.id, team, source.connected);
  if (columns.data.length === 0) return null;
  return (
    <Segmented
      value={value}
      onChange={onPick}
      label="How the tasks are laid out"
      options={[
        ["list", "List"],
        ["board", "Board"],
      ]}
    />
  );
}

/**
 * The columns side by side, in a scroller of their own.
 *
 * Horizontal, because a board is wider than a window more often than not, and
 * wrapping columns onto a second row would break the left to right order that
 * is the whole point of drawing them.
 */
export function TasksBoard({
  source,
  ask,
  round,
  onStart,
}: {
  source: TrackerStatus;
  /** The list's question, without its paging: each column pages on its own. */
  ask: ListTasksParams;
  /** Counts Refresh. A column keeps the pages it loaded, so a fresh first page
   *  would show a card twice unless the column starts again. */
  round: number;
  onStart: (t: Task) => void;
}) {
  const columns = useTrackerColumns(source.id, ask.team, source.connected);
  /* A different question is a different first page in every column, so the
     columns are keyed by it and start again rather than keep cards that no
     longer answer it. */
  const question = JSON.stringify(ask);
  return (
    <div className="scroll-slim mt-4 flex items-start gap-3 overflow-x-auto pb-3">
      {columns.data.map((c) => (
        <Column key={`${c.key}|${question}|${round}`} column={c} ask={ask} onStart={onStart} />
      ))}
    </div>
  );
}

/**
 * What one column asks for: the board's question, narrowed to the column and
 * moved to the page the trail has reached.
 */
export function columnQuestion(ask: ListTasksParams, status: string, trail: string[]): ListTasksParams {
  const at = trail.at(-1);
  return {
    ...ask,
    status,
    ...(at ? { cursor: at } : {}),
    ...(trail.length > 0 ? { page: trail.length + 1 } : {}),
  };
}

/**
 * Load more: what is shown becomes what is kept, and the trail gains a step,
 * so the next request is the next page and the first page stays on screen.
 */
export function afterLoadMore(
  cards: Task[],
  trail: string[],
  next: string | null,
): { kept: Task[]; trail: string[] } {
  return { kept: cards, trail: [...trail, next ?? ""] };
}

/**
 * One column: its name, how many cards are loaded, and the cards.
 *
 * **One request at a time.** The column asks for its latest page and keeps
 * the ones before it, so Load more adds to what is there rather than
 * replacing it, which is what a column you are scrolling down needs.
 */
function Column({
  column,
  ask,
  onStart,
}: {
  column: TaskColumn;
  ask: ListTasksParams;
  onStart: (t: Task) => void;
}) {
  /* The cursors spent getting here, as the list keeps them: the length is the
     depth, so a tracker that pages by number and one that pages by cursor
     read the same state. */
  const [trail, setTrail] = useState<string[]>([]);
  const [kept, setKept] = useState<Task[]>([]);
  const feed = useTasks(columnQuestion(ask, column.key, trail));
  const cards = [...kept, ...feed.data];

  return (
    <section
      aria-label={column.label}
      className="flex w-[var(--panel)] shrink-0 flex-col rounded-xl border border-line-soft p-1.5"
    >
      <header className="flex h-[var(--row-tight)] items-center justify-between gap-2 px-2">
        <span className="truncate text-ui text-bone">{column.label}</span>
        <span className="font-mono text-micro text-mute">{cards.length}</span>
      </header>

      <div className="flex flex-col gap-1.5">
        {cards.map((t) => (
          <Card key={t.id} task={t} onStart={onStart} />
        ))}
      </div>

      {feed.loading && <p className="px-2 py-3 text-meta text-mute">Reading {column.label}…</p>}
      {feed.error && <p className="px-2 py-3 text-meta text-brick">{feed.error}</p>}
      {!feed.loading && !feed.error && cards.length === 0 && (
        <p className="px-2 py-3 text-meta text-mute">Nothing here.</p>
      )}

      {feed.more && (
        <button
          onClick={() => {
            const more = afterLoadMore(cards, trail, feed.next);
            setKept(more.kept);
            setTrail(more.trail);
          }}
          className="btn quiet mt-1.5 justify-center"
        >
          Load more
        </button>
      )}
    </section>
  );
}

/**
 * A card: its key, its title, its labels and who has it, and Start.
 *
 * Labels neutral, as on the row: the tracker's own colours are somebody
 * else's palette on a screen allowed one accent. People as discs, because a
 * column is too narrow for names and the disc carries the name on hover.
 */
function Card({ task: t, onStart }: { task: Task; onStart: (t: Task) => void }) {
  return (
    <article className="rounded-lg bg-raise px-2.5 py-2">
      <span className="font-mono text-micro text-mute">{shortKey(t.key)}</span>
      <p className="mt-0.5 text-ui text-bone">{t.title}</p>
      {(t.labels.length > 0 || t.assignees.length > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {t.labels.slice(0, 3).map((l, i) => (
            <Badge key={`${i}|${l.name}`}>{l.name}</Badge>
          ))}
          <span className="ml-auto flex gap-0.5">
            {t.assignees.map((a) => (
              <Avatar key={a.login} name={a.login} size={20} />
            ))}
          </span>
        </div>
      )}
      <button onClick={() => onStart(t)} className="btn quiet mt-1 -ml-1.5">
        <Icon of={Play} size={12} />
        Start
      </button>
    </article>
  );
}

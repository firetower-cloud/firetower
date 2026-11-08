/**
 * The board, asked the way the server answers it.
 *
 * Every column is its own request (`status` set to the column's key, the list's id), so a
 * card only appears in a column if the board asked for that column under the
 * exact parameters the cache was seeded with. A card in the wrong column, or a
 * board that sorted one page into columns itself, cannot pass these.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterLoadMore, columnQuestion, ListOrBoard, TasksBoard } from "./TasksBoard";
import { TasksPage } from "./TasksPage";
import { StartProvider } from "~/start";
import { getListTasksQueryKey } from "~/api/generated/tasks/tasks";
import { getListTrackerColumnsQueryKey, getListTrackersQueryKey } from "~/api/generated/trackers/trackers";
import type { Backend } from "~/fleet";
import type { ListTasksParams, Page, Task, TaskColumn, TrackerStatus } from "~/api/generated/model";

const trello: TrackerStatus = {
  id: "trello",
  label: "Trello",
  host: "trello.com",
  kind: "trello",
  changeNoun: "pull request",
  connected: true,
  auth: "apiKey",
  scopeKind: "boards",
  kinds: ["ticket"],
  keyUrl: null,
};

const github: TrackerStatus = {
  id: "github",
  label: "GitHub",
  host: "github.com",
  kind: "github",
  changeNoun: "pull request",
  connected: true,
  auth: "gitProvider",
  scopeKind: "repos",
  kinds: ["issue", "pullRequest"],
  keyUrl: null,
};

const BOARD = "5f1b2c3d4e5f6a7b8c9d0e1f";

const COLUMNS: TaskColumn[] = [
  { key: "l1", label: "To do" },
  { key: "l2", label: "Doing" },
  { key: "l3", label: "Done" },
];

/** What the page hands the board: the list's question, with a board picked and no paging. */
const ask: ListTasksParams = { source: "trello", kind: "ticket", state: "open", team: BOARD };

const card = (key: string, title: string, status: string): Task => ({
  id: `trello:${key}`,
  source: "trello",
  key,
  title,
  url: `https://trello.com/c/${key}`,
  kind: "ticket",
  state: "open",
  status,
  labels: [{ name: "launch", colour: null }],
  assignees: [{ login: "ana lovelace", avatar: null }],
  updatedAt: new Date().toISOString(),
  repo: null,
});

const page = (tasks: Task[], rest: Partial<Page> = {}): Page => ({
  tasks,
  total: null,
  more: false,
  next: null,
  ...rest,
});

function seeded(columns: TaskColumn[] | null, cards: Record<string, Page> = {}) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  if (columns) cache.setQueryData(getListTrackerColumnsQueryKey("trello", { team: BOARD }), columns);
  for (const c of COLUMNS) {
    cache.setQueryData(getListTasksQueryKey({ ...ask, status: c.key }), cards[c.label] ?? page([]));
  }
  return cache;
}

function board(cache: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <TasksBoard source={trello} ask={ask} round={0} onStart={() => {}} />
    </QueryClientProvider>,
  );
}

/** The markup of one column, by its name. */
function column(html: string, label: string): string {
  const at = html.indexOf(`aria-label="${label}"`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</section>", at));
}

describe("the board", () => {
  it("lays a board out in its own column order", () => {
    const html = board(seeded(COLUMNS));
    const at = COLUMNS.map((c) => html.indexOf(`aria-label="${c.label}"`));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("puts each card in the column it was asked for", () => {
    const html = board(seeded(COLUMNS, { Doing: page([card("hJ5kL2mN", "Import the old support macros", "Doing")]) }));
    expect(column(html, "Doing")).toContain("Import the old support macros");
    expect(column(html, "To do")).not.toContain("Import the old support macros");
    expect(column(html, "Done")).not.toContain("Import the old support macros");
    // A card says what it is, who has it, and how to start on it.
    const doing = column(html, "Doing");
    expect(doing).toContain("hJ5kL2mN");
    expect(doing).toContain("launch");
    expect(doing).toContain("AL");
    expect(doing).toContain("Start");
  });

  it("lets a long column load more", () => {
    const full = Array.from({ length: 30 }, (_, i) => card(`c${i}`, `Card ${i}`, "To do"));
    const html = board(seeded(COLUMNS, { "To do": page(full, { more: true }) }));
    expect(column(html, "To do")).toContain("Load more");
    expect(column(html, "Doing")).not.toContain("Load more");
    // The header counts what is loaded, not what the board holds.
    expect(column(html, "To do")).toContain(">30<");
  });
});

describe("the list or board toggle", () => {
  function toggle(cache: QueryClient, source: TrackerStatus, team: string | undefined) {
    return renderToStaticMarkup(
      <QueryClientProvider client={cache}>
        <ListOrBoard source={source} team={team} value="list" onPick={() => {}} />
      </QueryClientProvider>,
    );
  }

  function page_(trackers: TrackerStatus[], cache: QueryClient) {
    cache.setQueryData(getListTrackersQueryKey(), trackers);
    return renderToStaticMarkup(
      <QueryClientProvider client={cache}>
        <StartProvider>
          <TasksPage backend={{} as Backend} />
        </StartProvider>
      </QueryClientProvider>,
    );
  }

  it("offers the board only when the tracker has columns", () => {
    // A git host has no columns, so its page never offers a board.
    expect(page_([github], seeded(COLUMNS))).not.toContain(">Board</button>");
    // Trello with a board picked, and the board answering its columns.
    expect(toggle(seeded(COLUMNS), trello, BOARD)).toContain(">Board</button>");
    // A board with no columns has nothing to lay out.
    expect(toggle(seeded([]), trello, BOARD)).not.toContain(">Board</button>");
    // "All boards" is many boards, which have no one set of columns.
    expect(toggle(seeded(COLUMNS), trello, undefined)).not.toContain(">Board</button>");
    expect(page_([trello], seeded(COLUMNS))).not.toContain(">Board</button>");
  });
});

describe("the page, with a board remembered", () => {
  function remembered(cache: QueryClient) {
    cache.setQueryData(getListTrackersQueryKey(), [trello]);
    return renderToStaticMarkup(
      <QueryClientProvider client={cache}>
        <StartProvider>
          <TasksPage
            backend={{} as Backend}
            remembered={{ scopes: { trello: BOARD }, layouts: { trello: "board" } }}
          />
        </StartProvider>
      </QueryClientProvider>,
    );
  }

  it("draws the columns, not rows and a pager, once the columns answer", () => {
    const cache = seeded(COLUMNS, { Doing: page([card("hJ5kL2mN", "Import the old support macros", "Doing")]) });
    // The list's own question is answered too, so a page that drew it would show it twice.
    cache.setQueryData(getListTasksQueryKey(ask), page([card("zZ9yY8xX", "Only in the list", "Doing")]));
    const html = remembered(cache);
    expect(column(html, "Doing")).toContain("Import the old support macros");
    expect(column(html, "To do")).toContain("Nothing here.");
    expect(html).not.toContain("Only in the list");
    expect(html).not.toContain(">Next<");
  });

  it("holds the body while the columns are on their way, rather than drawing the list", () => {
    const cache = seeded(null);
    cache.setQueryData(getListTasksQueryKey(ask), page([card("zZ9yY8xX", "Only in the list", "Doing")]));
    const html = remembered(cache);
    expect(html).not.toContain("Only in the list");
    expect(html).not.toContain("Nothing open right now");
    expect(html).toContain("Reading Trello");
  });
});

describe("a column loading more", () => {
  it("asks the next page of its own list", () => {
    expect(columnQuestion(ask, "l1", [])).toEqual({ ...ask, status: "l1" });
    expect(columnQuestion(ask, "l1", [""])).toEqual({ ...ask, status: "l1", page: 2 });
    expect(columnQuestion(ask, "l1", ["", "c2"])).toEqual({ ...ask, status: "l1", page: 3, cursor: "c2" });
  });

  it("keeps the first page on screen while the second is fetched", () => {
    const first = [card("a", "A", "To do"), card("b", "B", "To do")];
    const after = afterLoadMore(first, [], null);
    expect(after.kept).toEqual(first);
    expect(after.trail).toEqual([""]);
  });
});

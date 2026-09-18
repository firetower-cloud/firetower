/**
 * The Tasks page, asked the one question it used to get wrong.
 *
 * `/tasks` answers for one tracker per request and defaults to GitHub when
 * `source` is left off, so a page that never sends it can never show a Linear
 * ticket however well connected Linear is. These render against a seeded cache
 * keyed by the exact parameters: a row only appears if the page asked the
 * question this key was stored under, which is what makes "did it send
 * `source`" something a test can see.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TasksPage } from "./TasksPage";
import { StartProvider } from "~/start";
import { getListTasksQueryKey } from "~/api/generated/tasks/tasks";
import { getListTrackersQueryKey } from "~/api/generated/trackers/trackers";
import type { Backend } from "~/fleet";
import type { ListTasksParams, Page, Task, TrackerStatus } from "~/api/generated/model";

const github = (connected: boolean): TrackerStatus => ({
  id: "github",
  label: "GitHub",
  connected,
  auth: "gitProvider",
  scopeKind: "repos",
  kinds: ["issue", "pullRequest"],
  keyUrl: null,
});

const linear = (connected: boolean): TrackerStatus => ({
  id: "linear",
  label: "Linear",
  connected,
  auth: "apiKey",
  scopeKind: "teams",
  kinds: ["ticket"],
  keyUrl: "https://linear.app/settings/api",
});

/** A ticket as `tasks::linear` builds one: no repo, and `ticket` for a kind. */
const ticket = (key: string, title: string): Task => ({
  id: `linear:${key}`,
  source: "linear",
  key,
  title,
  url: `https://linear.app/acme/issue/${key}/x`,
  kind: "ticket",
  state: "open",
  labels: [],
  assignees: [],
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

/** What the page asks when it opens on a connected tracker. */
const opening = (source: string, kind: string): ListTasksParams => ({
  source,
  kind: kind as ListTasksParams["kind"],
  state: "open",
  ...(source === "linear" ? { team: undefined } : { repo: undefined }),
});

function draw(trackers: TrackerStatus[], seed?: [ListTasksParams, Page]) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  cache.setQueryData(getListTrackersQueryKey(), trackers);
  if (seed) cache.setQueryData(getListTasksQueryKey(seed[0]), seed[1]);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <StartProvider render={() => null}>
        <TasksPage backend={{} as Backend} />
      </StartProvider>
    </QueryClientProvider>,
  );
}

describe("which tracker the page asks", () => {
  /** The regression: Linear connected, and the page asked GitHub anyway. */
  it("asks the connected tracker rather than defaulting to GitHub", () => {
    const html = draw(
      [github(false), linear(true)],
      [opening("linear", "ticket"), page([ticket("ENG-123", "Promo codes expire a day early")])],
    );
    expect(html).toContain("Promo codes expire a day early");
    expect(html).toContain("ENG-123");
    // The readout under the controls is the proof it went out as Linear's.
    expect(html).toContain("source:linear");
  });

  /**
   * The counterpart to the test above, and what stops it passing for the wrong
   * reason: tickets stored under GitHub's key stay invisible, so a row on
   * screen means the page really did ask as Linear.
   */
  it("does not show what was answered for another tracker", () => {
    const html = draw(
      [github(false), linear(true)],
      [opening("github", "issue"), page([ticket("ENG-123", "Promo codes expire a day early")])],
    );
    expect(html).not.toContain("Promo codes expire a day early");
  });

  /**
   * A ticket is neither an issue nor a pull request. The page used to keep
   * only rows whose kind matched an Issues/PRs toggle, which dropped every
   * Linear row even once one arrived.
   */
  it("shows tickets, which are not issues", () => {
    const html = draw(
      [linear(true)],
      [opening("linear", "ticket"), page([ticket("ENG-7", "Rotate the signing key")])],
    );
    expect(html).toContain("Rotate the signing key");
  });

  /** GitHub stays the default when it is the connected one. */
  it("still opens on GitHub when that is what is connected", () => {
    const html = draw([github(true), linear(false)], [opening("github", "issue"), page([])]);
    expect(html).toContain("source:github");
    expect(html).toContain("kind:issue");
  });
});

describe("a tracker with no credential", () => {
  it("offers to connect it instead of reporting an error", () => {
    const html = draw([github(false), linear(false)]);
    expect(html).toContain("isn&#x27;t connected yet");
    expect(html).toContain("Connect GitHub");
    // Nothing was read, so nothing claims to be reading.
    expect(html).not.toContain("Reading ");
    // And nothing offers to narrow a list that was never fetched.
    expect(html).not.toContain("Assigned to me");
    expect(html).not.toContain("Closed");
  });

  it("points at where a key is made, when that is how it connects", () => {
    const html = draw([linear(false)]);
    expect(html).toContain("https://linear.app/settings/api");
    expect(html).toContain("Connect Linear");
  });

  /** Both marks stay on screen: picking the unconnected one is how you get to
      the prompt that connects it. */
  it("still offers a tracker it cannot read", () => {
    const html = draw([github(true), linear(false)]);
    expect(html).toContain('aria-label="Linear"');
    expect(html).toContain("Linear — not connected");
  });
});

describe("the kind toggle", () => {
  it("offers only what the tracker returns", () => {
    const html = draw([linear(true)], [opening("linear", "ticket"), page([])]);
    // Linear has no pull requests, and one kind is not a choice.
    expect(html).not.toContain("PRs");
    expect(html).not.toContain("Issues");
  });

  it("offers both of GitHub's", () => {
    const html = draw([github(true)], [opening("github", "issue"), page([])]);
    expect(html).toContain("Issues");
    expect(html).toContain("PRs");
  });
});

describe("paging", () => {
  /** Linear carries no total, so the heading counts the page. */
  it("counts the page when the source will not say how many there are", () => {
    const html = draw(
      [linear(true)],
      [opening("linear", "ticket"), page([ticket("ENG-1", "One"), ticket("ENG-2", "Two")])],
    );
    expect(html).toContain("2 to pick from.");
  });

  it("uses the total when there is one", () => {
    const html = draw(
      [github(true)],
      [opening("github", "issue"), page([], { total: 214 })],
    );
    expect(html).toContain("214 to pick from.");
  });

  it("offers Next only when there is another page", () => {
    const one = draw([linear(true)], [opening("linear", "ticket"), page([ticket("ENG-1", "One")])]);
    expect(one).not.toContain("Page 1");

    const many = draw(
      [linear(true)],
      [opening("linear", "ticket"), page([ticket("ENG-1", "One")], { more: true, next: "cur" })],
    );
    expect(many).toContain("Page 1");
    expect(many).toContain("Next");
  });
});

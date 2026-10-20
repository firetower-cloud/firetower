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
import { paneFor, pickable, SourceRows, TasksPage } from "./TasksPage";
import { paneAt, FIRST } from "~/ui/config/panes";
import { StartProvider } from "~/start";
import { getListTasksQueryKey } from "~/api/generated/tasks/tasks";
import { getListTrackersQueryKey } from "~/api/generated/trackers/trackers";
import type { Backend } from "~/fleet";
import type { ListTasksParams, Page, Task, TrackerStatus } from "~/api/generated/model";

const github = (connected: boolean): TrackerStatus => ({
  id: "github",
  label: "GitHub",
  host: "github.com",
  kind: "github",
  changeNoun: "pull request",
  connected,
  auth: "gitProvider",
  scopeKind: "repos",
  kinds: ["issue", "pullRequest"],
  keyUrl: null,
});

const linear = (connected: boolean): TrackerStatus => ({
  id: "linear",
  label: "Linear",
  host: "linear.app",
  kind: "linear",
  changeNoun: "pull request",
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

describe("a tracker that stops answering for you", () => {
  /**
   * The report: a Linear key shared through a directory was filed back out,
   * and the person it had been reaching for still saw every ticket — under a
   * panel telling them Linear was not connected.
   *
   * Nothing was persisted and the server refused them outright. The page
   * disables the query when the tracker stops reporting itself connected, and
   * a disabled query hands back its last good answer just as a failing one
   * does — so it never errored, and the cache answered as if nothing had
   * changed.
   */
  it("shows nothing once the tracker is no longer connected for them", () => {
    const tickets = [ticket("WES-1", "Get familiar with Linear")];
    const reachable = draw([linear(true)], [opening("linear", "ticket"), page(tickets)]);
    expect(reachable).toContain("Get familiar with Linear");

    // The same cache, the same person, one grant taken away.
    const revoked = draw([linear(false)], [opening("linear", "ticket"), page(tickets)]);
    expect(revoked).not.toContain("Get familiar with Linear");
    expect(revoked).not.toContain("WES-1");
    expect(revoked).toContain("isn&#x27;t connected yet");
  });
});

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

  /**
   * **The picker offers only what can answer.**
   *
   * This used to be the opposite, and the old reasoning was sound while there
   * were two trackers: listing the unconnected one greyed was how somebody
   * reached the prompt that connects it. It stopped being sound once every
   * git host became a tracker — a fresh install offers six, four of them
   * saying "not connected", so the control that picks what you are reading is
   * mostly things you cannot read. Connecting was never done from this menu
   * anyway; it is Git hosts or Trackers, which is where `paneFor` sends you.
   */
  it("offers only the trackers that can answer", () => {
    const offered = pickable([github(true), linear(false)]);
    expect(offered.map((t) => t.id)).toEqual(["github"]);
    expect(pickable([github(false), linear(false)])).toEqual([]);
  });

  /**
   * With nothing connected the menu is empty, so the panel under the list is
   * the only way through — it must still name the tracker and offer it.
   */
  it("still offers a way in when nothing is connected at all", () => {
    const html = draw([github(false), linear(false)]);
    expect(html).toContain("isn&#x27;t connected yet");
    expect(html).toContain("Connect GitHub");
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

/**
 * A tracker derived from a git host takes that host's id, so a second GitHub is
 * `gh_01j…` rather than `github` — and the mark is chosen by `kind`, not by id.
 * Keyed on the id, the toggle drew the first letter of the label instead of a
 * logo for every host but the built-in one.
 */
describe("a tracker whose id is not its kind", () => {
  const selfHosted: TrackerStatus = {
    id: "gitlab_01jzz",
    label: "GitLab (internal)",
    host: "git.acme.internal",
    kind: "gitlab",
    changeNoun: "merge request",
    connected: true,
    auth: "gitProvider",
    scopeKind: "repos",
    kinds: ["issue", "pullRequest"],
    keyUrl: "https://git.acme.internal/-/user_settings/personal_access_tokens",
  };

  it("is drawn with its kind's mark rather than a letter", () => {
    const html = renderToStaticMarkup(
      <SourceRows trackers={[github(true), selfHosted]} value="github" onPick={() => {}} />,
    );
    // The fallback is `label[0]`, which for this label would be a bare "G".
    expect(html).not.toContain(">G<");
    expect(html).toContain("GitLab (internal)");
  });

  /**
   * And the address beside it, which is the reason the strip of marks had to
   * go: two GitLabs render the same mark and may be named anything, so the
   * host is the only thing on the row that tells them apart.
   */
  it("says where each one reads from", () => {
    const second: TrackerStatus = { ...selfHosted, id: "gitlab_02", label: "GitLab (ops)", host: "git.ops.internal" };
    const html = renderToStaticMarkup(
      <SourceRows trackers={[selfHosted, second]} value="gitlab_01jzz" onPick={() => {}} />,
    );
    expect(html).toContain("git.acme.internal");
    expect(html).toContain("git.ops.internal");
  });
});

/**
 * Where "Connect <tracker>" actually goes.
 *
 * The report: pressing it landed on Repositories. It navigated to
 * `/configuration` with no pane, and `paneAt` falls back to the *first* one —
 * which became Repositories when Integrations was split in two. So the button
 * that exists to connect GitHub opened a list of repositories that does not
 * mention GitHub.
 *
 * Asserted through `paneAt` rather than against a string, so this fails if the
 * panes are ever renamed or reordered again rather than passing against a path
 * that no longer resolves.
 */
describe("the way to connect a tracker that is not connected", () => {
  it("opens the pane that can actually connect it", () => {
    // A git host shares the token that pushes commits: Git hosts.
    expect(paneAt(paneFor({ auth: "gitProvider" }))).toBe("git-hosts");
    // An API key is its own credential: Trackers.
    expect(paneAt(paneFor({ auth: "apiKey" }))).toBe("trackers");
  });

  it("does not fall back to whichever pane happens to be first", () => {
    for (const auth of ["gitProvider", "apiKey"] as const) {
      const pane = paneAt(paneFor({ auth }));
      expect(pane).not.toBe(FIRST);
      // And it is a pane that exists, not a path that silently falls back.
      expect(paneFor({ auth })).toContain(pane);
    }
  });
});

/**
 * `keyUrl` is set for every tracker — Linear's API key page, and a git host's
 * personal-access-token page — so a button hung off it alone said "Make a key"
 * beside GitHub. That is Linear's word for Linear's flow, and the wrong
 * instruction besides: a git host is connected in a browser from Git hosts,
 * and a pasted token is the fallback offered *there*, with its scopes spelled
 * out. Two buttons, the second contradicting the first.
 */
describe("the prompt for a tracker that is not connected", () => {
  it("does not tell a git host to make a key", () => {
    const html = draw([github(false)]);
    expect(html).toContain("Connect GitHub");
    expect(html).not.toContain("Make a key");
  });

  it("still does for one that genuinely reads with a key", () => {
    const html = draw([linear(false)]);
    expect(html).toContain("Make a key");
    expect(html).toContain("https://linear.app/settings/api");
  });
});

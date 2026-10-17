/**
 * The Repositories screen: the two lists, and the three ways it can be empty.
 *
 * What this exists to stop coming back: the screen a new person lands on
 * first used to be a dead end. With no host connected, the only control was
 * Add, and Add's host selector was empty — so it fell through to a paste box
 * with nothing saying that picking from a list was possible at all. The one
 * good path was invisible and the worst one was the default.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Repos } from "./Repos";
import { getListReposQueryKey } from "~/api/generated/repos/repos";
import {
  getListKindsQueryKey,
  getListProvidersQueryKey,
  getListProviderReposQueryKey,
} from "~/api/generated/providers/providers";
import type { ProviderStatus, RemoteRepo, Repo } from "~/api/generated/model";

const host = (p: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id: "github",
  label: "GitHub",
  connected: true,
  configured: true,
  pending: null,
  clientId: "Ov23li",
  maySetApplication: true,
  kind: "github",
  baseUrl: "https://github.com",
  gitHost: "github.com",
  auth: "device",
  authModes: ["device", "token"],
  changeNoun: "pull request",
  version: null,
  builtin: true,
  tokenPage: "https://github.com/settings/tokens/new",
  appPage: "https://github.com/settings/applications/new",
  accessPage: null,
  sharedApplication: true,
  ...p,
});

const gitlab = (p: Partial<ProviderStatus> = {}): ProviderStatus =>
  host({
    id: "gitlab_01j",
    label: "GitLab (internal)",
    kind: "gitlab",
    baseUrl: "https://git.acme.internal",
    gitHost: "git.acme.internal",
    auth: "token",
    changeNoun: "merge request",
    builtin: false,
    sharedApplication: false,
    ...p,
  });

const repo = (slug: string, remote: string): Repo =>
  ({ id: `r_${slug}`, slug, remote, path: "u/kevin", defaultBranch: "main", env: [] }) as Repo;

const offered = (slug: string, remote: string): RemoteRepo => ({
  slug,
  remote,
  defaultBranch: "main",
  private: false,
  pushedAt: null,
});

/** What the server ships. gitlab.com and github.com need nothing registered. */
const KINDS = [
  { id: "github", label: "GitHub", changeNoun: "pull request", authModes: ["device", "token"], hostedBaseUrl: "https://github.com", selfHosted: false },
  { id: "gitlab", label: "GitLab", changeNoun: "merge request", authModes: ["device", "token"], hostedBaseUrl: "https://gitlab.com", selfHosted: false },
  { id: "gitea", label: "Gitea", changeNoun: "pull request", authModes: ["token"], hostedBaseUrl: null, selfHosted: true },
];

function draw({
  hosts,
  repos,
  available,
}: {
  hosts: ProviderStatus[];
  repos: Repo[];
  available?: Record<string, RemoteRepo[]>;
}) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  cache.setQueryData(getListProvidersQueryKey(), hosts);
  cache.setQueryData(getListKindsQueryKey(), KINDS);
  cache.setQueryData(getListReposQueryKey(), repos);
  for (const [id, list] of Object.entries(available ?? {})) {
    cache.setQueryData(getListProviderReposQueryKey(id), list);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <Repos live />
    </QueryClientProvider>,
  );
}

describe("the empty state", () => {
  /**
   * A fresh install has both hosted rows — github.com and gitlab.com — because
   * a migration seeds them and Firetower ships an application for each. So
   * "a host exists" cannot be the test for "somebody set this up before me",
   * and the copy must not greet the first person as though it had.
   */
  it("greets a fresh install without inventing colleagues", () => {
    const html = draw({
      hosts: [host({ connected: false }), gitlab({ id: "gitlab", label: "GitLab", builtin: true, gitHost: "gitlab.com", connected: false })],
      repos: [],
    });
    expect(html).toContain("Pick a git host to start from");
    expect(html).not.toContain("Your colleagues set these up");
    expect(html).toContain("GitHub");
    expect(html).toContain("GitLab");
  });

  /**
   * The case the first draft got wrong, and the common one on any install
   * with more than one person: a colleague added the hosts, and this person
   * needs *those* — a generic "GitLab" would send them to gitlab.com.
   */
  it("names the hosts somebody already added rather than their kinds", () => {
    const html = draw({
      hosts: [host({ connected: false }), gitlab({ connected: false })],
      repos: [],
    });
    expect(html).toContain("Connect a git host");
    expect(html).toContain("Your colleagues set these up");
    expect(html).toContain("GitLab (internal)");
  });

  /**
   * **A connected host with nothing imported yet is not an empty install.**
   *
   * The regression, and the first thing a new person does: connect a host,
   * open Repositories, and get the screen that asks you to connect a host.
   * `bare` was keyed on "no repositories imported", so the two controls that
   * could import one — the host picker and the Available list — were both
   * inside the branch it skipped, and `Start` draws only hosts that are *not*
   * connected, so the host just signed into was not even on screen. A dead end
   * reached by doing the right thing.
   */
  it("offers what a connected host can see before anything is imported", () => {
    const html = draw({
      hosts: [host({ connected: false }), gitlab({ connected: true })],
      repos: [],
      available: { gitlab_01j: [offered("platform/infra/deploy", "https://git.acme.internal/platform/infra/deploy.git")] },
    });

    // Not the "connect something" screen.
    expect(html).not.toContain("Pick a git host to start from");
    expect(html).not.toContain("Connect a git host");

    // The import list, for the host that is actually connected.
    expect(html).toContain("Available on GitLab (internal)");
    expect(html).toContain("platform/infra/deploy");
    // And the empty upper list says so plainly rather than vanishing.
    expect(html).toContain("Nothing connected yet");
  });

  /**
   * The counterpart: with nothing connected anywhere there is genuinely
   * nothing to import from, and the way in is the right thing to show.
   */
  it("still shows the way in when no host is connected", () => {
    const html = draw({
      hosts: [host({ connected: false }), gitlab({ connected: false })],
      repos: [],
    });
    expect(html).toContain("Connect a git host");
    expect(html).not.toContain("Available on");
  });

  /** The dead end. Pasting stays available; it is no longer the only thing. */
  it("is never only a paste box", () => {
    const html = draw({ hosts: [host({ connected: false })], repos: [] });
    expect(html).toContain("paste a URL");
    // The paste box itself is not drawn until somebody asks for it.
    expect(html).not.toContain("git@github.com:acme/web.git");
  });
});

describe("the two lists", () => {
  /**
   * Option A: a project already imported is left out of the lower list rather
   * than drawn ticked. Showing it puts the same repository on screen twice and
   * fills a long list with rows that do nothing.
   */
  it("leaves out what is already imported, and counts what is left", () => {
    const html = draw({
      hosts: [host()],
      repos: [repo("acme/web", "https://github.com/acme/web.git")],
      available: {
        github: [
          offered("acme/web", "https://github.com/acme/web.git"),
          offered("acme/api", "https://github.com/acme/api.git"),
        ],
      },
    });

    expect(html).toContain("Connected");
    expect(html).toContain("Available on GitHub");
    expect(html).toContain("acme/api");
    expect(html).toContain("1 not imported");
    // `acme/web` is drawn once — in Connected — not twice.
    expect(html.match(/acme\/web/g)?.length).toBe(1);
  });

  /**
   * Matched on the remote, not the slug. Two hosts can each have an
   * `acme/web`, and they are different repositories — dropping the second
   * because the first has the same name would hide it for good.
   */
  it("tells two hosts' same-named projects apart", () => {
    const html = draw({
      hosts: [gitlab()],
      repos: [repo("acme/web", "https://github.com/acme/web.git")],
      available: {
        gitlab_01j: [offered("acme/web", "https://git.acme.internal/acme/web.git")],
      },
    });
    // The GitLab one is still on offer despite sharing a slug with a connected
    // GitHub repository.
    expect(html).toContain("1 not imported");
  });

  /** Not a big empty card — the screen is not empty, one section of it is. */
  it("says so quietly when a host has nothing left", () => {
    const html = draw({
      hosts: [host()],
      repos: [repo("acme/web", "https://github.com/acme/web.git")],
      available: { github: [offered("acme/web", "https://github.com/acme/web.git")] },
    });
    expect(html).toContain("Everything GitHub can see is imported");
    expect(html).not.toContain("Pick a git host to start from");
  });

  /** The whole point of the rework: no modal between you and the list. */
  it("shows what is importable without anybody pressing Add", () => {
    const html = draw({
      hosts: [host()],
      repos: [repo("acme/web", "https://github.com/acme/web.git")],
      available: { github: [offered("acme/api", "https://github.com/acme/api.git")] },
    });
    expect(html).toContain("acme/api");
    expect(html).toContain("Import");
  });
});

/**
 * The controls over the two lists: what they say, and what they offer.
 *
 * The report was "this dropdown does not work". It listed every host and
 * disabled the rows for the ones nobody had signed into — so on an install
 * whose built-in GitHub and GitLab are untouched, most of the menu was inert
 * and clicking the obvious part of a row did nothing at all.
 */
describe("the controls", () => {
  it("offers the hosts that are connected, and names the chosen one", () => {
    const html = draw({
      hosts: [host({ connected: false }), gitlab({ connected: true })],
      repos: [repo("acme/web", "https://git.acme.internal/acme/web.git")],
      available: { gitlab_01j: [] },
    });
    // The picker names what the lower list is showing.
    expect(html).toContain("GitLab (internal)");
    // And never "No host connected" while one is.
    expect(html).not.toContain("No host connected");
  });

  /**
   * The screen is a list of repositories; a paragraph explaining what a
   * repository is for sat above it on every visit forever.
   */
  it("does not explain itself at length above the list", () => {
    const html = draw({
      hosts: [gitlab({ connected: true })],
      repos: [repo("acme/web", "https://git.acme.internal/acme/web.git")],
      available: { gitlab_01j: [] },
    });
    expect(html).not.toContain("What Firetower cuts worktrees from");
    expect(html).not.toContain("a colleague&#x27;s looks different");
    // The heading stays.
    expect(html).toContain("Repositories");
  });

  /** Importing one repository by address is still reachable. */
  it("keeps a way to paste a remote", () => {
    const html = draw({
      hosts: [gitlab({ connected: true })],
      repos: [repo("acme/web", "https://git.acme.internal/acme/web.git")],
      available: { gitlab_01j: [] },
    });
    expect(html).toContain("Paste a remote");
  });
});

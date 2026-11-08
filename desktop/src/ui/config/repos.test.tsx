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
import { choicesFrom } from "./GitHosts";
import { getListReposQueryKey } from "~/api/generated/repos/repos";
import {
  getListKindsQueryKey,
  getListProvidersQueryKey,
  getListProviderReposQueryKey,
} from "~/api/generated/providers/providers";
import type { KindInfo, ProviderStatus, RemoteRepo, Repo } from "~/api/generated/model";

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

/**
 * What the server ships. gitlab.com and github.com need nothing registered.
 *
 * `selfHostedLabel` is the field the kind picker is built from, so it is the
 * one this fixture most has to carry: it is what tells somebody with an
 * Enterprise install or a Forgejo that the product can talk to it.
 */
const KINDS: KindInfo[] = [
  { id: "github", label: "GitHub", selfHostedLabel: "GitHub Enterprise Server", changeNoun: "pull request", authModes: ["device", "token"], hostedBaseUrl: "https://github.com", selfHosted: false, appPage: "/settings/applications/new", appSteps: [], tokenSteps: [] },
  { id: "gitlab", label: "GitLab", selfHostedLabel: "GitLab self-managed", changeNoun: "merge request", authModes: ["device", "token"], hostedBaseUrl: "https://gitlab.com", selfHosted: false, appPage: "/-/profile/applications", appSteps: [], tokenSteps: [] },
  { id: "gitea", label: "Gitea", selfHostedLabel: "Gitea or Forgejo", changeNoun: "pull request", authModes: ["token"], hostedBaseUrl: null, selfHosted: true, appPage: "/user/settings/applications", appSteps: [], tokenSteps: [] },
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
    const hosts = [
      host({ connected: false }),
      gitlab({ id: "gitlab", label: "GitLab", builtin: true, gitHost: "gitlab.com", connected: false }),
    ];
    const html = draw({ hosts, repos: [] });
    expect(html).toContain("No repository yet");
    expect(html).toContain("Connect a git host and import what you want to work on.");
    expect(html).not.toContain("Your colleagues added these hosts");
    // One call to action, and nothing else competing with it.
    expect(html).toContain("Connect a git host");
    expect(html).not.toContain("Add a host");
  });

  /**
   * The case the first draft got wrong, and the common one on any install
   * with more than one person: a colleague added the hosts, and this person
   * needs *those* — a generic "GitLab" would send them to gitlab.com.
   */
  it("says when a colleague has been here first", () => {
    const hosts = [host({ connected: false }), gitlab({ connected: false })];
    const html = draw({ hosts, repos: [] });
    expect(html).toContain("Connect a git host");
    expect(html).toContain("Your colleagues added these hosts. You sign in with your own account.");
  });

  /**
   * **The one press buys the whole set, not a narrower one.**
   *
   * Three brand buttons were doing a real job and folding them into one
   * action costs a press — but only if what the press opens is *more* than
   * they were. It opens `AddHost`'s first step, which enumerates every kind
   * this server supports from `kindInfo`: the hosted and the self-hosted form
   * of each, separately, because they are separate products to whoever is
   * picking and they need different second steps. An empty box asking "where
   * is it" tells somebody who has a Forgejo nothing at all.
   *
   * Asserted against `choicesFrom` rather than the markup, because the dialog
   * is shut until the button is pressed — and against the *shape* rather than
   * a list of names, so a sixth kind is a passing test rather than a failing
   * one.
   */
  it("reaches every kind the server supports, hosted and self-hosted", () => {
    const rows = choicesFrom(KINDS);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    // Every kind contributes a self-hosted row; only some are also hosted.
    expect(rows.filter((c) => c.baseUrl === null).length).toBe(KINDS.length);
    expect(rows.some((c) => c.label === "Gitea or Forgejo")).toBe(true);
    expect(rows.some((c) => c.label === "GitHub Enterprise Server")).toBe(true);
    // Nothing is written down here: the labels are the server's own.
    expect(rows.map((c) => c.label)).toEqual(
      KINDS.flatMap((k) => (k.hostedBaseUrl ? [k.label, k.selfHostedLabel] : [k.selfHostedLabel])),
    );
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
    expect(html).not.toContain("No repository yet");
    expect(html).not.toContain("Connect a git host");

    // The import list, for the host that is actually connected.
    expect(html).toContain("Not imported yet on GitLab (internal)");
    expect(html).toContain("platform/infra/deploy");
    /* And the empty upper list says so in one line rather than vanishing, or
       taking the whole page: the screen is not empty, one section of it is.
       It keeps the heading the drawing gives it and its count. */
    expect(html).toContain("Checked out");
    expect(html).toContain("Nothing imported yet. Take one from the list below.");
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
    /* **And nothing else.** One action, zero links, zero banners: the two
       routes that were small print under the buttons are rows in the menu. */
    expect(html).not.toContain("Add custom hosts");
    expect(html).not.toContain("Self-hosted or enterprise");
  });

  /** The dead end. The blank is a way in, never a box to type a URL into. */
  it("is never only a paste box", () => {
    const html = draw({ hosts: [host({ connected: false })], repos: [] });
    expect(html).toContain("Connect a git host");
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

    expect(html).toContain("Checked out");
    expect(html).toContain("Not imported yet on GitHub");
    expect(html).toContain("acme/api");
    // The count sits beside the heading rather than in a sentence of its own.
    expect(html).toContain('Not imported yet on GitHub<span class="n">1</span>');
    // `acme/web` is drawn once — in Checked out — not twice.
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
    expect(html).toContain('Not imported yet on GitLab (internal)<span class="n">1</span>');
  });

  /** Not a big empty card — the screen is not empty, one section of it is. */
  it("says so quietly when a host has nothing left", () => {
    const html = draw({
      hosts: [host()],
      repos: [repo("acme/web", "https://github.com/acme/web.git")],
      available: { github: [offered("acme/web", "https://github.com/acme/web.git")] },
    });
    expect(html).toContain("Everything on GitHub is imported");
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
  /**
   * **Reversed by the drawing, deliberately.** This asserted the opposite —
   * that the populated screen carries no lede — which was a reasonable call
   * before there was a drawing to check it against. `desktop-redesign.html`
   * puts one sentence under every page heading, populated or not: it is what
   * makes eleven configuration panes read as one product rather than eleven
   * lists. What it still must not do is explain itself *at length*, which is
   * what this now says.
   */
  it("says what the screen is in one sentence, and no more", () => {
    const html = draw({
      hosts: [gitlab({ connected: true })],
      repos: [repo("acme/web", "https://git.acme.internal/acme/web.git")],
      available: { gitlab_01j: [] },
    });
    expect(html).toContain("What Firetower cuts worktrees from");
    // One sentence under the heading, not the old two-paragraph preamble.
    expect(html).not.toContain("a colleague&#x27;s looks different");
    const sub = /<p class="sub">([^<]*)<\/p>/.exec(html)?.[1] ?? "";
    expect(sub.length).toBeLessThan(130);
    // The heading stays.
    expect(html).toContain("Repositories");
  });

  /**
   * Pasting a remote is not a control on the populated screen. It is a
   * different job from the two the lists are for — importing one address by
   * hand rather than picking from what a host can see — and it was the odd
   * one out in a row of filters.
   *
   * It stays on the empty state, which is where somebody with no host and a
   * URL in hand actually is.
   */
  it("does not offer pasting a remote beside the filters", () => {
    const populated = draw({
      hosts: [gitlab({ connected: true })],
      repos: [repo("acme/web", "https://git.acme.internal/acme/web.git")],
      available: { gitlab_01j: [] },
    });
    expect(populated).not.toContain("Paste a remote");

    /* And it is not on the blank either. The blank is one button and one
       sentence; pasting a remote moved into the host picker, which is the
       control that already owns that state and already has a word for being
       in it. */
    const empty = draw({ hosts: [gitlab({ connected: false })], repos: [] });
    expect(empty).toContain("Connect a git host");
    expect(empty).not.toContain("Paste a remote");
  });
});

/**
 * All hosts at once, which is what the screen opens on.
 *
 * The diagnosis this came from: the picker governed only the lower list. The
 * upper one showed every repository from every host and ignored it entirely,
 * so the single control that looked page-wide was the only one that was not.
 */
describe("across every host", () => {
  const two = () => [
    host({ id: "github", label: "GitHub", connected: true }),
    gitlab({ connected: true }),
  ];

  it("offers what every connected host can see, not just the first", () => {
    const html = draw({
      hosts: two(),
      repos: [],
      available: {
        github: [offered("acme/api", "https://github.com/acme/api.git")],
        gitlab_01j: [offered("platform/infra/deploy", "https://git.acme.internal/platform/infra/deploy.git")],
      },
    });

    expect(html).toContain("All hosts");
    expect(html).toContain("acme/api");
    expect(html).toContain("platform/infra/deploy");
    // Counted across the set rather than per host.
    expect(html).toContain('Not imported yet<span class="n">2</span>');
  });

  /**
   * Two hosts can both hold an `acme/web`. Without the host beside the row the
   * two are identical, and Import on either is a coin toss.
   */
  it("says which host a row is on when there is more than one", () => {
    const html = draw({
      hosts: two(),
      repos: [],
      available: {
        github: [offered("acme/web", "https://github.com/acme/web.git")],
        gitlab_01j: [offered("acme/web", "https://git.acme.internal/acme/web.git")],
      },
    });
    expect(html).toContain("github.com");
    expect(html).toContain("git.acme.internal");
    expect(html.match(/acme\/web/g)?.length).toBe(2);
  });

  /**
   * The upper list, which is the half that used to ignore the picker.
   *
   * Only the default is provable here — a static render cannot open the menu
   * and pick a host, so the narrowing itself is not covered. What this pins
   * is that "All hosts" means all of them in *both* lists rather than only
   * the lower one.
   */
  it("shows imported repositories from every host at once", () => {
    const html = draw({
      hosts: two(),
      repos: [
        repo("acme/web", "https://github.com/acme/web.git"),
        repo("platform/infra/deploy", "https://git.acme.internal/platform/infra/deploy.git"),
      ],
      available: { github: [], gitlab_01j: [] },
    });
    expect(html).toContain("acme/web");
    expect(html).toContain("platform/infra/deploy");
    expect(html).toContain("Checked out");
  });
});

/**
 * The git hosts pane: what each row offers, to whom.
 *
 * Two rules are pinned here, and both have been got wrong in this file's
 * history.
 *
 * **`configured` says a client id is stored, never that it still works** — so
 * an application that was deleted, or that had the device flow switched off,
 * leaves a Connect button that cannot succeed. The regression: the way to
 * correct one was drawn only while `configured` was false, so after the first
 * registration there was no way to change it from this app at all, and signing
 * out does not clear it (it registers the application, not a person).
 *
 * **The application is the installation's, so the server takes it from an
 * administrator and nobody else.** It was drawn for everybody: a member opened
 * the field, typed a client id, and found out at Save — the same mistake as a
 * button the server will not honour. `maySetApplication` comes from the server
 * rather than a role read here, so if the rule ever widens nothing in this file
 * has to be found and changed.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { actionsFor, firstWayIn, GitHosts } from "./GitHosts";
import { getListProvidersQueryKey } from "~/api/generated/providers/providers";
import { getListTrackersQueryKey } from "~/api/generated/trackers/trackers";
import type { ProviderStatus } from "~/api/generated/model";

const github = (p: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id: "github",
  label: "GitHub",
  connected: false,
  configured: true,
  pending: null,
  clientId: "Ov23liREGISTERED",
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
  accessPage: "https://github.com/settings/connections/applications/Ov23liREGISTERED",
  sharedApplication: false,
  ...p,
});

/** A self-hosted GitLab connected by pasted token, which is the common shape. */
const gitlab = (p: Partial<ProviderStatus> = {}): ProviderStatus =>
  github({
    id: "gitlab_01j",
    label: "GitLab (internal)",
    kind: "gitlab",
    baseUrl: "https://git.acme.internal",
    gitHost: "git.acme.internal",
    auth: "token",
    authModes: ["device", "token"],
    changeNoun: "merge request",
    version: "17.4.1",
    builtin: false,
    clientId: null,
    configured: true,
    tokenPage: "https://git.acme.internal/-/user_settings/personal_access_tokens",
    appPage: "https://git.acme.internal/-/user_settings/applications",
    accessPage: null,
    ...p,
  });

function draw(providers: ProviderStatus[]) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  cache.setQueryData(getListProvidersQueryKey(), providers);
  cache.setQueryData(getListTrackersQueryKey(), []);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <GitHosts live />
    </QueryClientProvider>,
  );
}

/**
 * What a row offers, as a rule rather than as markup.
 *
 * These used to assert on the pencil icon's tooltip and on an inline client-id
 * field — which tied the rule to where a control happened to sit, and broke the
 * moment the row was reorganised. The controls moved into a ⋯ menu, which a
 * static render cannot open. `actionsFor` is the decision itself, so this tests
 * what may be done rather than where it is drawn.
 */
describe("what a row offers", () => {
  /** Exactly where somebody who signed out to replace a token ends up. */
  it("offers the install-wide settings after signing out, and while connected", () => {
    expect(actionsFor(github({ connected: false })).menu).toContain("settings");
    expect(actionsFor(github({ connected: true })).menu).toContain("settings");
  });

  /**
   * `configured` says a client id is stored, never that it still works — so an
   * application that was deleted, or that had the device flow switched off,
   * must still be correctable. The regression: the way to do that was drawn
   * only while `configured` was false, so after the first registration there
   * was no way to change it from this app at all.
   */
  it("keeps the application correctable once one is registered", () => {
    expect(actionsFor(github({ configured: true, connected: true })).menu).toContain("settings");
  });

  /** With none registered, the row's one button is the way to set one up. */
  it("points at setting one up when nothing is registered", () => {
    expect(actionsFor(github({ configured: false, clientId: null })).primary).toBe("set-up");
  });

  it("offers Connect once there is something to connect with", () => {
    expect(actionsFor(github({ configured: true, connected: false })).primary).toBe("connect");
    expect(actionsFor(github({ connected: true })).primary).toBe("identity");
  });
});

/**
 * The application is one row with no owner, for the whole installation, so the
 * server takes it from an administrator and nobody else. This was drawn for
 * everybody: a member opened the field, typed a client id, and found out at
 * Save — the same mistake as a button the server will not honour.
 *
 * `maySetApplication` comes from the server rather than a role read here, so if
 * the rule ever widens nothing in this file has to be found and changed.
 */
describe("somebody the server will not take an application from", () => {
  const member = { maySetApplication: false } as const;

  it("is offered none of the install-wide settings", () => {
    const { menu } = actionsFor(github({ ...member, connected: true }));
    expect(menu).not.toContain("settings");
    expect(menu).not.toContain("remove");
  });

  /** Their own token is still theirs to manage. */
  it("may still sign out, and connect", () => {
    expect(actionsFor(github({ ...member, connected: true })).menu).toContain("sign-out");
    expect(actionsFor(github({ ...member, configured: true, connected: false })).primary).toBe("connect");
  });

  /** And is told what has to happen rather than shown a field that refuses. */
  it("is told an administrator has to set an unconfigured host up", () => {
    expect(actionsFor(github({ ...member, configured: false, clientId: null })).primary).toBe("refused");
    expect(draw([github({ ...member, configured: false, clientId: null })])).toContain(
      "An administrator sets this up",
    );
  });

  it("is not offered the way to add a host", () => {
    expect(draw([github({ maySetApplication: false })])).not.toContain("Add a host");
    expect(draw([github({ maySetApplication: true })])).toContain("Add a host");
  });
});

/**
 * Signing out and removing are different things with different blast radiuses,
 * and the built-in host can only be the first — the server refuses the second
 * for it, so it must not be offered.
 */
describe("removing a host", () => {
  it("is not offered for the built-in one", () => {
    expect(actionsFor(github({ builtin: true, connected: true })).menu).not.toContain("remove");
  });

  it("is offered for one somebody added", () => {
    expect(actionsFor(gitlab({ builtin: false, connected: true })).menu).toContain("remove");
  });
});

/**
 * With more than one host, the label is chosen by whoever added them — so the
 * address is the only thing on the row that reliably tells two apart. A list
 * that drew two rows reading "GitHub" and nothing else would be a list nobody
 * could pick from.
 */
describe("telling two hosts apart", () => {
  it("says which address each one is", () => {
    const html = draw([github(), github({ id: "gh_work", label: "GitHub (work)", builtin: false })]);
    expect(html).toContain("GitHub (work)");
    expect(html.match(/github\.com/g)?.length).toBeGreaterThan(1);
  });

  it("names a self-hosted one by its own hostname", () => {
    const html = draw([github(), gitlab()]);
    expect(html).toContain("git.acme.internal");
    expect(html).toContain("github.com");
  });

  /**
   * The row carries the address and the version and stops there. What a host
   * calls a change is real and is said where it is acted on — the ship sheet
   * and the trackers list — but as a fourth clause here it pushed the line
   * past the width and truncated it mid-word.
   */
  it("does not flatten every fact into the one line", () => {
    const html = draw([gitlab()]);
    expect(html).not.toContain("merge requests");
    expect(html).not.toContain("no client id set on this server");
  });

  /** The version is what tells somebody their instance is too old for the
      browser flow, which is otherwise discovered as a rejected client id. */
  it("shows what the instance said it was", () => {
    expect(draw([gitlab()])).toContain("17.4.1");
  });
});

/**
 * A host with no device flow has nothing to register, so it is never waiting on
 * an administrator — and offering it a browser flow would draw a button whose
 * only outcome is a refusal nobody can act on.
 */
describe("a host connected by pasting a token", () => {
  it("offers Connect with no application registered", () => {
    const html = draw([gitlab({ clientId: null })]);
    expect(html).toContain("Connect");
    expect(html).not.toContain("An administrator has to set this up");
  });
});

/**
 * Which way in the Add-a-host dialog opens on, once the probe has said what
 * answered.
 *
 * The regression: the browser flow and a pasted token were drawn as a pair of
 * equal buttons with the *token* selected, so adding a GitHub Enterprise — the
 * case where the browser is both available and the one that has always worked
 * — opened on the fallback. The question "which of these two do I want" was
 * never the user's to answer; it is decided by what the host can do.
 */
describe("which way in a new host opens on", () => {
  it("opens on the browser wherever the host has one", () => {
    expect(firstWayIn({ authModes: ["device", "token"] })).toBe("device");
    // Order in the list is not the answer — what it contains is.
    expect(firstWayIn({ authModes: ["token", "device"] })).toBe("device");
  });

  /**
   * Gitea at any version, and a GitLab older than 17.9. Offering a browser
   * flow here draws a button whose only outcome is a refusal that reads
   * exactly like a wrong client id.
   */
  it("opens on a token when the host has no device flow", () => {
    expect(firstWayIn({ authModes: ["token"] })).toBe("token");
  });
});

/**
 * What the list answers is "what am I signed in to", and the rows that answer
 * it were sorted below the ones that do not — the server's order is the
 * install's, built-in first, which is load-bearing on the wire but not here.
 */
describe("the order of the list", () => {
  it("puts connected hosts first", () => {
    const html = draw([
      github({ id: "github", label: "GitHub", connected: false }),
      gitlab({ id: "gl_lab", label: "GitLab (lab)", connected: true }),
    ]);
    expect(html.indexOf("GitLab (lab)")).toBeLessThan(html.indexOf("GitHub"));
  });

  /** Two connected hosts keep the install's order between them. */
  it("is stable among the connected ones", () => {
    const html = draw([
      github({ id: "github", label: "GitHub", connected: true }),
      gitlab({ id: "gl_lab", label: "GitLab (lab)", connected: true }),
    ]);
    expect(html.indexOf("GitHub")).toBeLessThan(html.indexOf("GitLab (lab)"));
  });

  /** And among the unconnected ones. */
  it("is stable among the rest", () => {
    const html = draw([
      github({ id: "github", label: "GitHub", connected: false }),
      gitlab({ id: "gl_lab", label: "GitLab (lab)", connected: false }),
    ]);
    expect(html.indexOf("GitHub")).toBeLessThan(html.indexOf("GitLab (lab)"));
  });
});

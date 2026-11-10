/**
 * The trackers pane, and the order it draws them in.
 *
 * **Every git host is a tracker**, so this list is as long as the git hosts
 * list and grows with it. The rows that answer the question the screen asks —
 * what can the tasks list read from — were sorted below the rows that cannot,
 * because the server's order is the install's: built-in first, then whatever
 * was added. That order is load-bearing on the wire and not on a screen.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Trackers } from "./Trackers";
import { getListTrackersQueryKey } from "~/api/generated/trackers/trackers";
import type { TrackerStatus } from "~/api/generated/model";

const tracker = (p: Partial<TrackerStatus> = {}): TrackerStatus => ({
  id: "github",
  label: "GitHub",
  host: "github.com",
  kind: "github",
  changeNoun: "pull request",
  connected: false,
  auth: "gitProvider",
  scopeKind: "repos",
  kinds: ["issue", "pullRequest"],
  keyUrl: null,
  ...p,
});

function draw(trackers: TrackerStatus[]) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  cache.setQueryData(getListTrackersQueryKey(), trackers);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <Trackers live />
    </QueryClientProvider>,
  );
}

describe("the order of the list", () => {
  it("puts connected trackers first", () => {
    const html = draw([
      tracker({ id: "github", label: "GitHub", connected: false }),
      tracker({ id: "gl_lab", label: "GitLab (lab)", kind: "gitlab", connected: true }),
    ]);
    expect(html.indexOf("GitLab (lab)")).toBeLessThan(html.indexOf("GitHub"));
  });

  /** Trackers in the same state keep the install's order between them. */
  it("is stable among the connected ones", () => {
    const html = draw([
      tracker({ id: "github", label: "GitHub", connected: true }),
      tracker({ id: "gl_lab", label: "GitLab (lab)", kind: "gitlab", connected: true }),
    ]);
    expect(html.indexOf("GitHub")).toBeLessThan(html.indexOf("GitLab (lab)"));
  });

  it("is stable among the rest", () => {
    const html = draw([
      tracker({ id: "github", label: "GitHub", connected: false }),
      tracker({ id: "linear", label: "Linear", kind: "linear", auth: "apiKey", connected: false }),
    ]);
    expect(html.indexOf("GitHub")).toBeLessThan(html.indexOf("Linear"));
  });

  /** An unconnected tracker stays on the list — it is how it gets connected. */
  it("still draws the ones that are not connected", () => {
    const html = draw([
      tracker({ id: "gl_lab", label: "GitLab (lab)", kind: "gitlab", connected: true }),
      tracker({ id: "linear", label: "Linear", kind: "linear", auth: "apiKey", connected: false }),
    ]);
    expect(html).toContain("Linear");
    expect(html).toContain("GitLab (lab)");
  });
});

describe("the marks", () => {
  it("draws trello's own mark", () => {
    const html = draw([tracker({ id: "trello", label: "Trello", kind: "trello", auth: "apiKey", scopeKind: "boards", kinds: ["ticket"] })]);
    expect(html).toContain('data-mark="trello"');
  });
});

describe("connecting trello", () => {
  const trello = tracker({
    id: "trello",
    label: "Trello",
    kind: "trello",
    auth: "apiKey",
    scopeKind: "boards",
    kinds: ["ticket"],
    keyUrl: "https://trello.com/1/authorize?key=k",
  });

  it("asks for a token, says where to get one and what to do with it", () => {
    const html = draw([trello]);
    expect(html).toContain('placeholder="Token"');
    expect(html).toContain('aria-label="Token for Trello"');
    expect(html).toContain("Get a token from Trello");
    expect(html).toContain("copy the token Trello shows and paste it here");
    expect(html).not.toContain('placeholder="API key"');
  });

  it("keeps the plain wording for a tracker that takes a key", () => {
    const html = draw([tracker({ id: "linear", label: "Linear", kind: "linear", auth: "apiKey", scopeKind: "teams", keyUrl: "https://linear.app/x" })]);
    expect(html).toContain('placeholder="API key"');
    expect(html).not.toContain("Get a token from Trello");
  });
});

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

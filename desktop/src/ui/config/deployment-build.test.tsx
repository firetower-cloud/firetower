/**
 * What *is running* has to be answerable from this section.
 *
 * **The version alone could not answer it.** `version` is the last release's
 * number, so every image built from `main` between two releases reports the
 * same one — the `edge` tag is rebuilt on every push and still calls itself
 * whatever the previous release was called. A deployment that pulled a new
 * image and one that silently did not therefore drew the identical row, which
 * is the one case somebody opens this section to rule out.
 *
 * `build` is a fingerprint of the interface compiled into the binary, so it
 * moves whenever the interface does. It is optional on the wire — a server
 * older than the field, and a binary built without the bundles, both send
 * nothing — and a dash standing in for it would be the same false certainty
 * in a different shape, so the row is simply absent.
 *
 * `renderToStaticMarkup` with a seeded cache — no jsdom, no network.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getBootstrapQueryKey } from "~/api/generated/meta/meta";
import { Deployment } from "./Deployment";

function draw(boot: Record<string, unknown>): string {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  cache.setQueryData(getBootstrapQueryKey(), boot);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <Deployment />
    </QueryClientProvider>,
  );
}

const base = { version: "0.59.1", eventsPath: "/api/v1/events", authModes: ["password"] };

describe("what the deployment section says is running", () => {
  it("always says which release it is", () => {
    expect(draw(base)).toContain("0.59.1");
  });

  /** The assertion that fails if the row is dropped back to the version alone. */
  it("says which build, when the server sends one", () => {
    const html = draw({ ...base, build: "3f2a9c01bd47" });
    expect(html).toContain("Build");
    expect(html).toContain("3f2a9c01bd47");
  });

  /**
   * Two deployments one push apart are the same release and must still be
   * told apart here. This is the defect the field exists for, stated as the
   * screen: identical versions, different builds, visibly different rows.
   */
  it("distinguishes two images that share a version", () => {
    expect(draw({ ...base, build: "3f2a9c01bd47" })).not.toEqual(
      draw({ ...base, build: "aa11bb22cc33" }),
    );
  });

  /**
   * **No build is no row**, rather than a dash. A server too old to send the
   * field and a binary built without the bundles both arrive here, and
   * drawing a placeholder would restore exactly the uninformative certainty
   * the row was added to remove.
   */
  it("draws no build row when the server sends none", () => {
    expect(draw(base)).not.toContain("Build");
  });
});

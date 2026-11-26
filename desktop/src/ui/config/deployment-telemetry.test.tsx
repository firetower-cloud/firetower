/**
 * The telemetry pane draws the state the rule gives it, and says who sends it.
 *
 * **`telemetryState` had a test and this pane had none**, which is not the
 * same thing: reverting the call site to `q.data?.enabled ?? true` left the
 * whole suite green at 1570 while the pane went back to claiming *on* over a
 * read that had failed, and offering a brick control for a state the server
 * denies. A rule nothing is asserted to consult is a rule that governs
 * nothing — the same shape as `bodyFor` being re-derived inline by the window,
 * and as the security headers' guard never calling `serve`.
 *
 * So each of the three states is rendered. The one that catches the revert is
 * the unread one: the old expression had no way to say it.
 *
 * `renderToStaticMarkup` with a seeded cache — no jsdom, no network.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getPreviewQueryKey } from "~/api/generated/telemetry/telemetry";
import { Telemetry } from "./Deployment";

/** What `/telemetry/preview` answers, with the field under test varied. */
const preview = (enabled?: boolean) => ({
  enabled,
  endpoint: "https://telemetry.usefiretower.com/v1/digest",
  waiting: 2,
  example: { day: "2026-11-25" },
});

function draw(data?: ReturnType<typeof preview>): string {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  // Nothing seeded is the read that has not landed, which is one of the three
  // states and the one a defaulted boolean cannot express.
  if (data) cache.setQueryData(getPreviewQueryKey(), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <Telemetry />
    </QueryClientProvider>,
  );
}

describe("the telemetry pane", () => {
  it("says on, and offers the way off, when the server says on", () => {
    const html = draw(preview(true));
    expect(html).toContain("Turn telemetry off");
    expect(html).toContain("Waiting");
    expect(html).toContain("2 days");
    expect(html).not.toContain("Turn telemetry on");
  });

  it("says off, and offers the way on, when the server says off", () => {
    const html = draw(preview(false));
    expect(html).toContain("Turn telemetry on");
    expect(html).toContain("Nothing is being collected or sent.");
    expect(html).not.toContain("Turn telemetry off");
  });

  /* A successful read with no `enabled` is a server older than the field, and
     collection was on there. The optimistic default survives exactly here. */
  it("reads a server too old to answer as on", () => {
    expect(draw(preview(undefined))).toContain("Turn telemetry off");
  });

  /**
   * **The assertion the revert fails.**
   *
   * `q.data?.enabled ?? true` has no third answer, so a read that had not
   * landed drew *Telemetry on* with a brick *Turn telemetry off* beside it. A
   * switch that cannot read its own position says so instead, and offers the
   * read again rather than a control that would act on a guess.
   */
  it("asserts nothing about a switch it has not read", () => {
    const html = draw();
    expect(html).toContain("Reading whether it is on");
    expect(html).not.toContain("Turn telemetry off");
    expect(html).not.toContain("Turn telemetry on");
  });

  /**
   * And the pane asks the rule, which is a different claim from the rule
   * being right.
   *
   * **A read that *failed* cannot be produced here**, and that is a limit of
   * the harness rather than a choice: a static render performs no fetch, so
   * there is nothing to fail — a cache entry forced into `error` is still
   * reported as pending by a fresh observer. The failed read is the state QA
   * caught the old expression lying about, so it is asserted where it can be:
   * `organisation.test.ts` holds `telemetryState` answering `unread` for it,
   * and this holds that the pane is the thing asking.
   *
   * Source-level, and said so. Swapping the boolean back on its own is
   * behaviourally identical while the early return stands, so there is no
   * render that could tell them apart — what there is to protect is that the
   * rule is consulted at all, and that no second expression quietly answers
   * the same question beside it.
   */
  it("asks the rule rather than keeping a second opinion", () => {
    /* Comments stripped first. Both files that explain this defect quote the
       expression that caused it, and a check that counted those would be
       measuring the explanation rather than the code — which is how the
       `setStage` counter in `connect-stages.test.ts` first read two. */
    const pane = readFileSync(new URL("./Deployment.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(pane).toContain("telemetryState({ pending: q.isPending, error: q.error, data: q.data })");
    expect(pane).toContain('if (state === "unread")');
    // The expression that was the defect, in any of its spellings.
    expect(pane).not.toMatch(/enabled\s*\?\?\s*true/);
  });
});

/**
 * Who actually posts the digest.
 *
 * It said *the desktop app*, and QA watched a browser tab POST to the gateway
 * while this row denied it. `startCourier` runs in the renderer, so whichever
 * client is open is the courier — there is nothing native on that path. The
 * half that was always true, and is the half somebody on this screen is
 * really asking about, is that the control plane never connects out.
 */
describe("what the pane says about who sends it", () => {
  const html = draw(preview(true));

  it("does not name one client in a product with two", () => {
    expect(html).not.toContain("The desktop app, next time somebody opens it");
  });

  it("names both, and keeps the part about the server", () => {
    expect(html).toContain("this page in a browser");
    expect(html).toContain("machine");
    expect(html).toContain("This server never connects out.");
  });
});

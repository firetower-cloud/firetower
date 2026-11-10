/**
 * Every configuration pane draws something, at every address that reaches it.
 *
 * This exists because of a bug report that could not be reproduced: the
 * Agent profiles pane came back **completely empty** after a save — the
 * sheet's own rounded corner and shadow still there, and not one pixel
 * inside it. Measuring the report's screenshot ruled the error boundary out
 * (its panel has neither corner nor shadow), which leaves two possibilities,
 * and this file closes one of them for good: that a pane can render nothing.
 *
 * It cannot, today, in any state — and that is worth holding, because every
 * pane here is one early return away from being able to. Three already have
 * `return null` in them (`Machines`' removed-machine notice, `Repos`' empty
 * filter, `Skills`' instructions), and each is a *child* of a pane rather
 * than a pane. The day one of those is lifted a level, this says so.
 *
 * A bare `QueryClient` on purpose: nothing seeded is the hardest state, and
 * the one a cold open actually passes through. A pane that draws its heading
 * before its rows is a pane that cannot go blank while a list is in flight.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Configuration } from "~/ui/Configuration";
import { PANES } from "~/ui/config/panes";
import type { Backend } from "~/fleet";

const backend = { id: "o_1", url: "http://firetower.test", org: "Acme", user: "kevin" } as Backend;

/**
 * The address, as the hash router reads it.
 *
 * `usePathname` takes the window's hash and nothing else, and these tests run
 * without a DOM — so the one fact a pane is chosen by is supplied here rather
 * than by a browser. `history` is present because importing the shim patches
 * it; it is never called under `renderToStaticMarkup`, which runs no effects.
 */
function at(path: string) {
  vi.stubGlobal("window", {
    location: { hash: `#${path}` },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
  });
}

afterEach(() => vi.unstubAllGlobals());

/** What the pane itself drew, with `Configuration`'s own scroller taken off. */
function drew(path: string): string {
  at(path);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const whole = renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <Configuration backend={backend} onForgot={() => {}} />
    </QueryClientProvider>,
  );
  return whole.replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "");
}

describe("a configuration pane is never empty", () => {
  for (const group of PANES)
    for (const item of group.items)
      it(`${item.label} draws something`, () => {
        expect(drew(`/configuration/${item.at}`)).not.toBe("");
      });

  /* The addresses that name no pane. `paneAt` falls back rather than drawing
     nothing, and this is what says so — an unknown segment is somebody's old
     link, not a blank screen. */
  for (const path of ["/configuration", "/configuration/", "/configuration/nonsense"])
    it(`${path} falls back to a pane that draws`, () => {
      expect(drew(path)).toContain("<h1>Repositories</h1>");
    });

  /* A pane's own segment may be followed by an id — `/configuration/roles/r_1`
     is a profile named in an address. The pane is still the pane. */
  it("draws the pane when the address also names a row", () => {
    expect(drew("/configuration/roles/r_1")).toContain("<h1>Agent profiles</h1>");
  });

  /**
   * The heading is the floor. Whatever a list is doing — loading, refused,
   * empty, or holding a profile somebody has just saved — `Section` draws the
   * title first, so "Agent profiles" is on screen before anything that could
   * go wrong underneath it has had the chance.
   */
  it("draws the Agent profiles heading with nothing loaded", () => {
    expect(drew("/configuration/roles")).toContain("<h1>Agent profiles</h1>");
  });
});

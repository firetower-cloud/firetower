/**
 * The library on a machine that cannot photograph a page.
 *
 * `capture.rs` compiles to `SUPPORTED = false` anywhere but macOS and Windows,
 * so every tile on Linux draws the same grey plate and a library of them reads
 * as *loading* and then as broken. The list is the view that never needed a
 * picture, and the whole of the design is that the library **opens** in it,
 * first launch, with one sentence saying why.
 *
 * It did not. The screen asked `useExpectPoster()` once, in a `useState`
 * initialiser, and that hook only went false after `GIVE_UP_AFTER` captures
 * had failed *in a row* — which could never happen, because the effect that
 * counts them is keyed on the polled artifact list and React Query hands back
 * the same array reference when a poll changes nothing. A failure changes
 * nothing. So exactly one failure was ever recorded, the count never reached
 * two, and the library drew a grid of grey plates for as long as the window
 * was open.
 *
 * What is asserted here is the half that matters: the shell is asked outright,
 * and the screen renders from that answer. The other half of the fix — that
 * the screen reads it *live* rather than freezing it in a `useState`
 * initialiser, which is what makes a cold launch straight into the library
 * right too — needs a second render to observe, and these tests render once
 * to a string. That one is QA's, on the installed build.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, replaceEqualDeep } from "@tanstack/react-query";
import { getListArtifactsQueryKey } from "~/api/generated/artifacts/artifacts";
import type { Artifact } from "~/api/generated/model";

/* The shell, stood in for. A live object, so a test can make it answer either
   way — which is the thing the renderer could not find out for itself. */
const shell = vi.hoisted(() => ({
  bridge: {
    native: true,
    canShoot: vi.fn(),
    shoot: vi.fn(),
    loadArtifact: null,
    setTitle: () => {},
  },
}));
vi.mock("~/bridge", () => shell);

/** Seven of them, none with a picture, which is the Linux case exactly. */
const artifacts: Artifact[] = Array.from({ length: 7 }, (_, i) => ({
  id: `a_${i}`,
  versionId: `v_${i}`,
  version: 1,
  slug: `report-${i}`,
  path: `u/kevin/report-${i}` as Artifact["path"],
  title: `Report ${i}`,
  url: `http://localhost:4401/a/a_${i}`,
  posterUrl: `http://localhost:4401/a/a_${i}/poster`,
  hasPoster: false,
  mayShare: true,
  mine: true,
  fromWorkspaceName: "acme",
  fromSessionId: null,
  updatedAt: "2026-11-11T09:00:00.000Z",
  bytes: 1024,
}));

/** The library, rendered against a cache that already has the list in it. */
async function library() {
  const { ArtifactsPage } = await import("~/ui/ArtifactsPage");
  const { StartProvider } = await import("~/start");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(getListArtifactsQueryKey(), artifacts);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <StartProvider>
        <ArtifactsPage />
      </StartProvider>
    </QueryClientProvider>,
  );
}

const disk = new Map<string, string>();

beforeEach(() => {
  vi.resetModules();
  disk.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => disk.get(k) ?? null,
      setItem: (k: string, v: string) => void disk.set(k, v),
      removeItem: (k: string) => void disk.delete(k),
    },
    /* Enough of a window for the navigation shim, which takes over
       `history` the moment it is imported. */
    location: { hash: "#/artifacts", search: "" },
    history: { pushState: () => {}, replaceState: () => {}, back: () => {}, forward: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  shell.bridge.canShoot.mockReset().mockResolvedValue(true);
  shell.bridge.shoot.mockReset().mockResolvedValue(null);
});

describe("asking the shell whether anything can be photographed", () => {
  it("stops expecting a picture the moment it says it cannot", async () => {
    shell.bridge.canShoot.mockResolvedValue(false);
    const P = await import("./posters");

    // Before the answer: nobody has asked, which is not the same as no.
    expect(P.expectPoster()).toBe(true);
    await P.askTheShell();
    expect(P.expectPoster()).toBe(false);
  });

  it("keeps expecting one where it says it can", async () => {
    const P = await import("./posters");
    await P.askTheShell();
    expect(P.expectPoster()).toBe(true);
  });

  it("reads a shell too old to answer as yes", async () => {
    shell.bridge.canShoot.mockRejectedValue(new Error("no such command"));
    const P = await import("./posters");
    await expect(P.askTheShell()).resolves.toBeUndefined();
    expect(P.expectPoster()).toBe(true);
  });
});

describe("what the library opens as", () => {
  it("is the list, and says why, where no picture can be taken", async () => {
    shell.bridge.canShoot.mockResolvedValue(false);
    const P = await import("./posters");
    await P.askTheShell();

    const html = await library();
    // The list's own column header, which the grid does not draw.
    expect(html).toContain("colhead");
    expect(html).not.toContain('class="gal"');
    expect(html).toContain("This machine can’t photograph a page, so these have no pictures.");
  });

  it("is the grid, and silent, where one can", async () => {
    const P = await import("./posters");
    await P.askTheShell();

    const html = await library();
    expect(html).toContain('class="gal"');
    expect(html).not.toContain("so these have no pictures");
  });

  it("is whatever was chosen, either way", async () => {
    shell.bridge.canShoot.mockResolvedValue(false);
    const P = await import("./posters");
    await P.askTheShell();

    // Somebody asked for the grid on this machine. That is still what they get
    // — the sentence is about the pictures, not about the view.
    disk.set("firetower.artifacts.look", "grid");
    const html = await library();
    expect(html).toContain('class="gal"');
    expect(html).toContain("so these have no pictures");
  });
});

describe("why counting failures could not work", () => {
  it("is that a poll which changes nothing is the same array", () => {
    // The premise under the bug, asserted rather than asserted about: the
    // effect that counts failures is keyed on this array, and a failed capture
    // changes nothing about it.
    const polled = artifacts.map((a) => ({ ...a }));
    expect(polled).not.toBe(artifacts);
    expect(replaceEqualDeep(artifacts, polled)).toBe(artifacts);

    // A poster landing is what used to be the only way back into the effect.
    const landed = artifacts.map((a, i) => (i === 0 ? { ...a, hasPoster: true } : { ...a }));
    expect(replaceEqualDeep(artifacts, landed)).not.toBe(artifacts);
  });
});

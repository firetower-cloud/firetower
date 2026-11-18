/**
 * The changelog span: every version being jumped, and what could not be read.
 *
 * Tested on documents rather than on the network, which is the same rule the
 * control plane's own release picking follows — the thing worth asserting is
 * what a page of releases turns into, and a test that needed GitHub would run
 * sixty times an hour at best.
 */
import { describe, expect, it, vi } from "vitest";
import { PAGES, bullets, counts, firstSubject, isNewer, on, order, span } from "./releases";

/** One release, as the feed shapes it. */
const release = (tag: string, over: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: "2026-11-15T09:00:00Z",
  html_url: `https://github.com/firetower-cloud/firetower/releases/tag/${tag}`,
  body: "### Features\n\n* **server:** a thing ([abc1234](https://x/abc1234))\n",
  ...over,
});

/** A feed of fixed pages. Page 1 is `pages[0]`; anything past the end is empty. */
function feed(pages: unknown[][]) {
  const asked: string[] = [];
  const fetcher = vi.fn(async (url: string) => {
    asked.push(url);
    const page = Number(new URL(url).searchParams.get("page")) || 1;
    return { ok: true, status: 200, json: async () => pages[page - 1] ?? [] } as Response;
  });
  return { fetcher: fetcher as unknown as typeof fetch, asked };
}

/** Thirty of this package's releases, descending from `top`. */
const run = (prefix: string, top: number, many: number) =>
  Array.from({ length: many }, (_, i) => release(`${prefix}${0}.${top - i}.0`));

describe("the versions in a jump", () => {
  it("is every version above what is running, up to and including the target", async () => {
    const { fetcher } = feed([
      [
        release("firetower-v0.55.0"),
        release("firetower-v0.54.1"),
        release("firetower-v0.54.0"),
        release("firetower-v0.53.0"),
      ],
    ]);
    const found = await span("controlPlane", "0.53.0", "0.54.1", fetcher);
    expect(found.versions.map((v) => v.version)).toEqual(["0.54.1", "0.54.0"]);
    expect(found.shortfallBelow).toBeNull();
  });

  it("is still a span when only one version is being jumped", async () => {
    const { fetcher } = feed([[release("firetower-v0.54.1"), release("firetower-v0.54.0")]]);
    const found = await span("controlPlane", "0.54.0", "0.54.1", fetcher);
    expect(found.versions.map((v) => v.version)).toEqual(["0.54.1"]);
  });

  it("reads only this package's releases", async () => {
    const { fetcher } = feed([
      [
        release("desktop-v0.30.0"),
        release("firetower-v0.55.0"),
        release("mobile-v0.9.0"),
        release("firetower-v0.54.0"),
      ],
    ]);
    const cp = await span("controlPlane", "0.54.0", "0.55.0", fetcher);
    expect(cp.versions.map((v) => v.version)).toEqual(["0.55.0"]);
    const app = await span("desktop", "0.29.0", "0.30.0", fetcher);
    expect(app.versions.map((v) => v.version)).toEqual(["0.30.0"]);
  });

  it("ignores a draft", async () => {
    const { fetcher } = feed([
      [
        release("firetower-v0.56.0", { draft: true }),
        release("firetower-v0.55.0"),
        release("firetower-v0.54.0"),
      ],
    ]);
    const found = await span("controlPlane", "0.54.0", "0.56.0", fetcher);
    expect(found.versions.map((v) => v.version)).toEqual(["0.55.0"]);
  });

  it("stops asking once it has seen what is running", async () => {
    const { fetcher, asked } = feed([
      [release("firetower-v0.55.0"), release("firetower-v0.54.0")],
      [release("firetower-v0.53.0")],
    ]);
    await span("controlPlane", "0.54.0", "0.55.0", fetcher);
    expect(asked).toHaveLength(1);
  });
});

describe("paging, and the cap", () => {
  it("reads a second page when the first does not reach back far enough", async () => {
    const { fetcher, asked } = feed([run("firetower-v", 60, 30), run("firetower-v", 30, 30)]);
    /* Page one runs 0.60.0 → 0.31.0, so what is running is not on it. */
    const found = await span("controlPlane", "0.20.0", "0.60.0", fetcher);
    expect(asked).toHaveLength(2);
    expect(found.versions.map((v) => v.version)).toContain("0.41.0");
    expect(found.versions.map((v) => v.version)).toContain("0.21.0");
    expect(found.shortfallBelow).toBeNull();
  });

  /**
   * **The one bad failure mode this cap exists for**: an installation that has
   * not upgraded in a year issuing dozens of requests and meeting a rate limit
   * *during an upgrade*, which is when it is least wanted.
   */
  it("reads no deeper than the cap", async () => {
    const { fetcher, asked } = feed([
      run("firetower-v", 300, 30),
      run("firetower-v", 270, 30),
      run("firetower-v", 240, 30),
      run("firetower-v", 210, 30),
    ]);
    await span("controlPlane", "0.1.0", "0.300.0", fetcher);
    expect(asked).toHaveLength(PAGES);
  });

  /**
   * **Never silently short.** A list that looks complete and is not is worse
   * than showing one version, so a read that stopped at the cap names the
   * boundary it stopped at and links the full comparison.
   */
  it("names what it could not reach, and links the comparison", async () => {
    const { fetcher } = feed([
      run("firetower-v", 300, 30),
      run("firetower-v", 270, 30),
      run("firetower-v", 240, 30),
      run("firetower-v", 210, 30),
    ]);
    const found = await span("controlPlane", "0.1.0", "0.300.0", fetcher);
    expect(found.shortfallBelow).toBe(found.versions[found.versions.length - 1].version);
    expect(found.compareHref).toContain("firetower-v0.1.0...firetower-v0.300.0");
  });

  it("says nothing is missing when the feed simply ran out", async () => {
    const { fetcher } = feed([[release("firetower-v0.2.0"), release("firetower-v0.1.0")]]);
    const found = await span("controlPlane", "0.1.0", "0.2.0", fetcher);
    expect(found.shortfallBelow).toBeNull();
  });
});

describe("a feed that will not answer", () => {
  it("says so, and keeps what it had already read", async () => {
    let page = 0;
    const fetcher = (async () => {
      page += 1;
      if (page === 1) {
        return { ok: true, status: 200, json: async () => run("firetower-v", 300, 30) } as Response;
      }
      return { ok: false, status: 403, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const found = await span("controlPlane", "0.1.0", "0.300.0", fetcher);
    expect(found.trouble).toContain("403");
    expect(found.versions.length).toBeGreaterThan(0);
    expect(found.compareHref).toContain("compare");
  });

  it("says so when it could not be reached at all", async () => {
    const fetcher = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const found = await span("controlPlane", "0.53.0", "0.55.0", fetcher);
    expect(found.trouble).toContain("offline");
    expect(found.versions).toEqual([]);
  });

  /* A rate limit must never read as "nothing changed in this jump". */
  it("does not pass a refusal off as a complete span", async () => {
    const fetcher = (async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    const found = await span("controlPlane", "0.53.0", "0.55.0", fetcher);
    expect(found.versions).toEqual([]);
    expect(found.trouble).toBeTruthy();
  });
});

describe("reading a release's section", () => {
  it("takes the first subject, without its commit link", () => {
    expect(
      firstSubject("### Features\n\n* **server:** run an agent on a clock ([abc1234](https://x/abc1234))\n"),
    ).toBe("server: run an agent on a clock");
  });

  it("drops a trailing issue number too", () => {
    expect(firstSubject("* implement skills system end-to-end (#208)")).toBe(
      "implement skills system end-to-end",
    );
  });

  it("keeps a link's words rather than its address", () => {
    expect(firstSubject("* see [the guide](https://example.test/guide)")).toBe("see the guide");
  });

  it("has nothing to say about a release that published nothing", () => {
    expect(firstSubject(null)).toBeNull();
    expect(firstSubject("### Features\n\nNo notable changes.")).toBeNull();
  });

  it("counts features and fixes off the headings release-please writes", () => {
    const notes = "### Features\n\n* a\n* b\n\n### Bug Fixes\n\n* c\n";
    expect(counts(notes)).toBe("2 features, 1 fix");
  });

  it("counts bullets under no heading as changes rather than as zero", () => {
    expect(counts("* a\n* b\n")).toBe("2 changes");
  });

  it("lists the bullets a reader would read", () => {
    expect(bullets("### Features\n\n* **web:** a\n* b\n")).toEqual(["web: a", "b"]);
  });
});

describe("ordering versions", () => {
  it("sorts by part, not by string", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
    expect(isNewer("1.0.0", "0.300.0")).toBe(true);
  });

  it("is not newer than itself", () => {
    expect(isNewer("0.54.1", "0.54.1")).toBe(false);
    expect(order("0.54.1")).toBe(order("0.54.1"));
  });

  it("ignores a pre-release suffix rather than choking on one", () => {
    expect(order("0.55.0-rc.1")).toBe(order("0.55.0"));
  });
});

describe("saying when", () => {
  it("is a day and a month", () => {
    expect(on("2026-11-15T09:00:00Z")).toMatch(/\d+\s*\w+/);
  });

  it("says nothing when the feed gave nothing", () => {
    expect(on(null)).toBe("");
    expect(on("not a date")).toBe("");
  });
});

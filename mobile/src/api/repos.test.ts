import { describe, expect, it } from "vitest";
import { importable, matching, repoName, repoOwner, worthFiltering } from "./repos";
import type { RemoteRepo, Repo } from "~/api/generated/model";

const seen = (slug: string, pushedAt: string | null = null): RemoteRepo => ({
  slug,
  remote: `https://github.com/${slug}.git`,
  defaultBranch: "main",
  private: false,
  pushedAt,
});

const have = (slug: string, remote = `https://github.com/${slug}.git`): Repo => ({
  id: `r_${slug}`,
  slug,
  remote,
});

describe("what is left to connect", () => {
  it("drops what this Firetower already has", () => {
    const left = importable([seen("acme/web"), seen("acme/api")], [have("acme/web")]);
    expect(left.map((r) => r.slug)).toEqual(["acme/api"]);
  });

  it("matches a connected repository however its case was written", () => {
    const left = importable([seen("Acme/Web")], [have("acme/web")]);
    expect(left).toEqual([]);
  });

  /* The desktop connects one by pasting a remote, and whoever pasted it chose
     between ssh and https. The slug is the half both spellings agree on. */
  it("matches one that was connected over ssh", () => {
    const left = importable([seen("acme/web")], [have("acme/web", "git@github.com:acme/web.git")]);
    expect(left).toEqual([]);
  });

  it("puts the most recently pushed first", () => {
    const left = importable(
      [
        seen("acme/old", "2026-01-01T00:00:00Z"),
        seen("acme/new", "2026-09-01T00:00:00Z"),
        seen("acme/mid", "2026-06-01T00:00:00Z"),
      ],
      [],
    );
    expect(left.map((r) => r.slug)).toEqual(["acme/new", "acme/mid", "acme/old"]);
  });

  it("leaves one nobody has pushed to at the end, by name", () => {
    const left = importable([seen("acme/b"), seen("acme/a"), seen("acme/live", "2026-09-01T00:00:00Z")], []);
    expect(left.map((r) => r.slug)).toEqual(["acme/live", "acme/a", "acme/b"]);
  });

  it("treats a date it cannot read as no date at all", () => {
    const left = importable([seen("acme/broken", "not a date"), seen("acme/live", "2026-09-01T00:00:00Z")], []);
    expect(left.map((r) => r.slug)).toEqual(["acme/live", "acme/broken"]);
  });

  it("does not reorder what it was given", () => {
    const list = [seen("acme/a", "2026-01-01T00:00:00Z"), seen("acme/b", "2026-09-01T00:00:00Z")];
    importable(list, []);
    expect(list.map((r) => r.slug)).toEqual(["acme/a", "acme/b"]);
  });
});

describe("narrowing by what was typed", () => {
  it("narrows on the slug", () => {
    expect(matching([seen("acme/web"), seen("acme/api")], "ap").map((r) => r.slug)).toEqual([
      "acme/api",
    ]);
  });

  it("ignores the case and the spaces around a query", () => {
    expect(matching([seen("acme/Web")], "  WEB ").map((r) => r.slug)).toEqual(["acme/Web"]);
  });

  it("is everything when nothing was typed", () => {
    const list = [seen("acme/web"), seen("acme/api")];
    expect(matching(list, "")).toEqual(list);
    expect(matching(list, "   ")).toEqual(list);
  });

  /* `github` is in every remote on the screen and in none of the names, so a
     query that read both would look broken rather than generous. */
  it("does not match the remote", () => {
    expect(matching([seen("acme/web")], "github")).toEqual([]);
  });
});

describe("the filter box", () => {
  it("is not worth a row for a handful", () => {
    expect(worthFiltering(8)).toBe(false);
    expect(worthFiltering(9)).toBe(true);
  });
});

describe("saying a slug in two parts", () => {
  it("splits the owner from the name", () => {
    expect(repoOwner("acme/web")).toBe("acme");
    expect(repoName("acme/web")).toBe("web");
  });

  it("keeps a name with no owner whole", () => {
    expect(repoOwner("web")).toBeNull();
    expect(repoName("web")).toBe("web");
  });

  /* GitHub has no three-part slug, but a self-hosted host does, and the name
     is the last segment either way. */
  it("takes the last segment as the name", () => {
    expect(repoOwner("group/sub/web")).toBe("group/sub");
    expect(repoName("group/sub/web")).toBe("web");
  });
});

/**
 * Which strings in a turn are paths.
 *
 * Two failure modes matter and they pull against each other. Miss a real path
 * and it is not clickable — the whole point of the file. Claim a URL or a
 * version number and the click does a `find_files` for nothing, or worse,
 * opens some unrelated file that happens to share a name. So the negatives
 * below are as load-bearing as the positives.
 */
import { describe, expect, it } from "vitest";
import { findPaths } from "./paths";

const found = (text: string) => findPaths(text).map((f) => f.path);

describe("findPaths", () => {
  it("finds a relative path with a directory in it", () => {
    expect(found("see src/ui/Chat.tsx for the rest")).toEqual(["src/ui/Chat.tsx"]);
  });

  it("carries the line number when one is written", () => {
    const [hit] = findPaths("crates/ft-worker/src/lib.rs:2879 refuses it");
    expect(hit.path).toBe("crates/ft-worker/src/lib.rs");
    expect(hit.line).toBe(2879);
  });

  /* The case this was changed for: an agent that captures a screenshot says
     where it put it, and where it put it is an absolute path. */
  it("finds an absolute path", () => {
    expect(found("wrote /tmp/annotation/10-card-grown-near-bottom.png")).toEqual([
      "/tmp/annotation/10-card-grown-near-bottom.png",
    ]);
  });

  it("keeps the leading slash, because it is what makes it absolute", () => {
    expect(found("/etc/hosts.json")[0].startsWith("/")).toBe(true);
  });

  it("finds a bare image name, which used to need a directory to be seen", () => {
    expect(found("compare against baseline.png")).toEqual(["baseline.png"]);
  });

  it("still finds a bare source name", () => {
    expect(found("look at Chat.tsx")).toEqual(["Chat.tsx"]);
  });

  /* A URL is the thing most likely to be mistaken for a path now that a
     leading slash is allowed, so it gets its own case for each shape. */
  it("does not claim a URL", () => {
    expect(found("https://example.com/assets/logo.png")).toEqual([]);
    expect(found("http://localhost:3000/static/app.js")).toEqual([]);
    expect(found("see www.example.com/docs/readme.md")).toEqual([]);
  });

  it("does not claim a version number", () => {
    expect(found("upgraded to 1.2.3")).toEqual([]);
  });

  it("finds each path in a line that names several", () => {
    expect(found("moved src/a.ts to /tmp/b.ts")).toEqual(["src/a.ts", "/tmp/b.ts"]);
  });

  it("reports offsets that bracket the text it matched", () => {
    const text = "open src/ui/Tabs.tsx now";
    const [hit] = findPaths(text);
    expect(text.slice(hit.start, hit.end)).toBe("src/ui/Tabs.tsx");
  });
});

/**
 * The tab says which product this is.
 *
 * **Served in a browser, the shell is the whole of the answer.** Inside the
 * desktop app the window carries the mark and the dock carries the icon, so
 * nothing here was ever missing; in a tab there is neither, and the control
 * plane shipped the browser's grey globe at `/` and *the Next.js default* —
 * a black disc with a white triangle — at `/login`, `/setup` and `/account`,
 * which are the first screens anybody signing in has ever seen.
 *
 * Both halves are asserted, because they fail separately: a shell that
 * declares an icon it does not ship is a 404 on every page load, and an icon
 * shipped with nothing declaring it is bytes in the bundle that no browser
 * asks for.
 */
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const iconPath = new URL("../public/favicon.svg", import.meta.url);

describe("the application's shell", () => {
  it("declares the mark as its icon", () => {
    expect(shell).toContain('rel="icon"');
    expect(shell).toContain('href="/favicon.svg"');
    expect(shell).toContain('type="image/svg+xml"');
  });

  /* The browsers that will not take an SVG icon ask for this name instead.
     It is deliberately not in this bundle: `/favicon.ico` resolves out of the
     administration bundle, and a copy here would be the same name in both —
     which `the_bundles_claim_no_name_in_common` in crates/ft-server/src/web.rs
     refuses, and rightly, since two files answering one name means whichever
     is looked up first wins silently. */
  it("names a fallback for browsers that refuse an SVG", () => {
    expect(shell).toContain('href="/favicon.ico"');
    expect(existsSync(new URL("../public/favicon.ico", import.meta.url))).toBe(false);
  });
});

describe("the icon it declares", () => {
  const svg = existsSync(iconPath) ? readFileSync(iconPath, "utf8") : "";

  it("is actually shipped", () => {
    expect(existsSync(iconPath)).toBe(true);
  });

  it("is an svg", () => {
    expect(svg).toContain("<svg");
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("viewBox");
  });

  /**
   * **The assertion a dark tab bar fails.**
   *
   * A favicon is drawn against the browser's own chrome, not against the
   * page, so it cannot read the application's theme and `styles.css` cannot
   * reach it. Without the query inside the file the mark is `#1d1d1e` on a
   * dark tab strip, which is a blank tab.
   */
  it("is legible on a dark tab bar as well as a light one", () => {
    expect(svg).toContain("prefers-color-scheme: dark");
    expect(svg).toMatch(/stroke:\s*#eaeaeb/);
  });

  /** The light is lit — the one place ember is a fill. See ui/Mark.tsx. */
  it("is the mark, with the light lit", () => {
    expect(svg).toMatch(/#ff[56][eb]/i);
    expect(svg).toContain("<circle");
  });

  /* Small enough to be worth inlining nothing: a favicon is fetched on every
     cold load of every page, and this one is geometry rather than pixels. */
  it("is a drawing, not a bitmap in a wrapper", () => {
    expect(svg).not.toContain("base64");
    expect(svg.length).toBeLessThan(4000);
  });
});

/**
 * The three colour literals in `app.config.ts`, held against the palette.
 *
 * A dynamic Expo config is evaluated by Expo's own loader outside Metro, so it
 * cannot `import` from `~/design` — the hex has to be written there. That is
 * exactly the condition under which a value drifts, so it is asserted here
 * instead: the file is read as text and the literals are compared to the
 * generated branches.
 *
 * This is the one place in `mobile/` where a colour is legitimately written by
 * hand, and this test is the price of it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dark, light } from "~/design/tokens.generated";

const config = readFileSync(resolve(__dirname, "../../app.config.ts"), "utf8");

/** `backgroundColor: "#ffffff",` → `#ffffff`, for the nth occurrence. */
const literals = (key: string) =>
  [...config.matchAll(new RegExp(`${key}:\\s*"(#[0-9a-fA-F]{6})"`, "g"))].map((m) => m[1].toLowerCase());

describe("app.config.ts", () => {
  it("launches on light's page, not dark's", () => {
    // The top-level one is light's, because Expo has no dark counterpart for
    // it and `_layout.tsx` sets the real value from the theme at runtime.
    expect(literals("backgroundColor")[0]).toBe(light.ground);
  });

  it("gives the splash a dark branch that is the dark page", () => {
    const all = literals("backgroundColor");
    expect(all).toContain(dark.ground);
    expect(all).toContain(light.ground);
  });

  it("follows the system rather than pinning a theme", () => {
    expect(config).toMatch(/userInterfaceStyle:\s*"automatic"/);
    expect(config).not.toMatch(/userInterfaceStyle:\s*"dark"/);
  });

  it("leaves orientation unlocked, or the dock band is unreachable", () => {
    // No window is ever 840 wide in portrait, so `"portrait"` means the whole
    // `dock` branch cannot be entered on any device.
    expect(config).not.toMatch(/orientation:\s*"portrait"/);
    expect(config).toMatch(/orientation:\s*"default"/);
  });

  it("claims the larger display, or none of the three poses happens", () => {
    expect(config).toMatch(/supportsTablet:\s*true/);
  });

  it("no longer says the token set has no light values", () => {
    // The comment's stated reason is what the redesign spends. A stale comment
    // next to changed code is worse than no comment.
    expect(config).not.toMatch(/Dark, always/);
  });
});

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Select } from "./Field";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

/**
 * The select draws its own arrow.
 *
 * The browser's arrow sat flush against the right border, at whatever inset
 * each engine felt like, while the text sat at `px-2.5`. Turning it off and
 * drawing a chevron at the text's inset is the only way both ends of the
 * control line up.
 */
describe("the select's arrow", () => {
  const out = html(<Select value="a" onChange={() => {}} options={[["a", "All boards"]]} className="h-7 max-w-[220px]" />);

  it("turns the native one off", () => {
    expect(out).toMatch(/<select[^>]*class="[^"]*\bappearance-none\b/);
  });

  it("draws a chevron that a click passes through", () => {
    expect(out).toContain("lucide-chevron-down");
    expect(out).toMatch(/<svg[^>]*class="[^"]*\bpointer-events-none\b/);
  });

  it("sits at the text's inset, in the muted colour", () => {
    const svg = /<svg[^>]*class="([^"]*)"/.exec(out)?.[1] ?? "";
    expect(svg).toMatch(/\bright-2\.5\b/);
    expect(svg).toMatch(/\btext-mute\b/);
    expect(out).toMatch(/<select[^>]*class="[^"]*\bpx-2\.5\b/);
  });

  it("keeps the caller's width on the select", () => {
    expect(out).toMatch(/<select[^>]*class="[^"]*max-w-\[220px\]/);
  });
});

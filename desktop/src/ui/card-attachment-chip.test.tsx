import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Chips } from "./attach";

/**
 * A card's attachment that did not arrive says so on its own chip, which
 * stays removable, and is never mistaken for one still on its way.
 */
describe("a chip whose attachment did not arrive", () => {
  const out = renderToStaticMarkup(
    <Chips
      chips={[{ id: 1, name: "spec.pdf", kind: "file", size: "2 MB", failed: "spec.pdf could not be brought from the card." }]}
      onDrop={() => {}}
    />,
  );

  it("names why, and says it was not brought", () => {
    expect(out).toContain('title="spec.pdf could not be brought from the card."');
    expect(out).toContain("Not brought");
    expect(out).not.toContain("2 MB");
  });

  it("can still be taken away", () => {
    expect(out).toContain('aria-label="Remove spec.pdf"');
  });
});

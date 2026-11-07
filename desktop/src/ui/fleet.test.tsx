/**
 * The Everything screen, drawn where `App` draws it: outside any
 * `BackendProvider`, so with no QueryClient above it. Anything here that reaches
 * for react-query throws "No QueryClient set" and takes the screen down.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Fleet } from "./Fleet";

describe("Fleet", () => {
  it("renders without a QueryClientProvider", () => {
    expect(() => renderToStaticMarkup(<Fleet />)).not.toThrow();
  });
});

/**
 * The last line of defence, and the one way it could be got round.
 *
 * `Boundary` exists because a window with no browser chrome has nowhere to
 * show an uncaught error but a blank rectangle — so the one thing it must
 * never do is decide that nothing went wrong. It did, for every falsy throw:
 * the thrown value *was* the state and `if (!error)` read `undefined`, `null`
 * and `""` as "no error", so `render()` handed the children back to React,
 * React re-rendered the subtree it had just deleted, found it throwing again,
 * and gave the whole root up. The window went white and said nothing — which
 * is the failure this component is for, arriving through the component meant
 * to prevent it.
 *
 * `throw` takes any expression, so this is not a hypothetical shape: a
 * rejected value, a library that throws a string, a `throw undefined` from
 * minified third-party code all arrive here as `unknown`.
 *
 * Rendered off the instance rather than through a DOM: the decision and the
 * panel are both pure, and the repository's component tests are
 * `renderToStaticMarkup` without a browser.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Boundary, said } from "./Boundary";

/** The screen a boundary draws once it has been handed `thrown`. */
function stoppedScreen(thrown: unknown): string {
  const boundary = new Boundary({ children: "the screen" });
  boundary.state = { ...boundary.state, ...Boundary.getDerivedStateFromError(thrown) };
  const drawn = boundary.render();
  return typeof drawn === "string" ? drawn : renderToStaticMarkup(<>{drawn}</>);
}

describe("the boundary catches whatever was thrown", () => {
  /* The four that were read as "nothing went wrong". `undefined` is the one
     that actually took the window down, and the other three are the same
     mistake waiting. */
  for (const [what, thrown] of [
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["zero", 0],
  ] as const) {
    it(`stops the screen when a component throws ${what}`, () => {
      const screen = stoppedScreen(thrown);
      expect(screen).toContain("This screen stopped");
      expect(screen).not.toContain("the screen");
    });
  }

  it("still stops the screen for an ordinary Error", () => {
    const screen = stoppedScreen(new Error("the profile editor threw"));
    expect(screen).toContain("This screen stopped");
    expect(screen).toContain("the profile editor threw");
  });

  /* Until something throws, the boundary is not in the way. */
  it("draws the screen it wraps while nothing has thrown", () => {
    const boundary = new Boundary({ children: "the screen" });
    expect(boundary.render()).toBe("the screen");
  });
});

/**
 * The panel under the heading is the part somebody pastes into a report, so
 * it has to carry something for every shape of throw — an empty box is the
 * same dead end as a blank window, one size smaller.
 */
describe("what a thrown thing says for itself", () => {
  it("prefers the message of an Error", () => {
    expect(said(new Error("boom"))).toBe("boom");
  });

  it("falls back to the name when an Error carries no message", () => {
    expect(said(new TypeError())).toBe("TypeError");
  });

  it("names the kind when the thrown thing is not an Error", () => {
    expect(said(undefined)).toBe("undefined was thrown.");
    expect(said(null)).toBe("null was thrown.");
    expect(said("")).toBe("An empty string was thrown.");
  });

  it("carries a thrown string through as itself", () => {
    expect(said("the worker refused")).toBe("the worker refused");
  });

  /* A thrown object is somebody else's, and reading it must not be the thing
     that throws — that would replace the screen saying what broke with
     nothing at all. */
  it("survives a thrown object that cannot be read", () => {
    const hostile = {
      toString() {
        throw new Error("not today");
      },
    };
    expect(said(hostile)).toBe("A object was thrown, and it could not be read.");
  });

  it("reads an ordinary object", () => {
    expect(said({ code: "NoServer" })).toBe("[object Object]");
  });
});

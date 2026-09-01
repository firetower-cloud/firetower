import { describe, expect, it } from "vitest";
import {
  fromTask,
  idOf,
  label,
  parseReference,
  suggestionsFrom,
  trailerFor,
  withTrailer,
  type Reference,
} from "./issues";

const ref = (over: Partial<Reference> = {}): Reference => ({
  number: 32,
  repo: "acme/web",
  keyword: "Closes",
  ...over,
});

describe("reading what somebody typed", () => {
  it("takes a link from the address bar", () => {
    expect(parseReference("https://github.com/acme/web/issues/32")).toEqual({
      number: 32,
      repo: "acme/web",
      keyword: "Refs",
      url: "https://github.com/acme/web/issues/32",
    });
  });

  it("takes a pull request link, which is an issue at the same number", () => {
    expect(parseReference("https://github.com/acme/web/pull/32")?.number).toBe(32);
  });

  it("drops the comment anchor and the query a link is copied with", () => {
    expect(parseReference("https://github.com/acme/web/issues/32#issuecomment-1")?.url).toBe(
      "https://github.com/acme/web/issues/32",
    );
  });

  it("does not care which host it is", () => {
    // Self-hosted git servers exist and are not worth naming here.
    expect(parseReference("https://git.acme.internal/acme/web/issues/7")?.repo).toBe("acme/web");
  });

  it("takes #32, and takes it as belonging to what is being shipped", () => {
    expect(parseReference("#32", "acme/web")).toEqual({
      number: 32,
      repo: "acme/web",
      keyword: "Refs",
    });
  });

  it("takes acme/api#41 as being somewhere else", () => {
    expect(parseReference("acme/api#41", "acme/web")?.repo).toBe("acme/api");
  });

  /**
   * The one that matters. A bare number is far more often a version, a count
   * or a line number, and everything this returns is a click away from
   * closing somebody's issue.
   */
  it("refuses a bare number, and anything that is not a reference", () => {
    expect(parseReference("32")).toBeNull();
    expect(parseReference("none")).toBeNull();
    expect(parseReference("")).toBeNull();
    expect(parseReference("#")).toBeNull();
    expect(parseReference("https://github.com/acme/web")).toBeNull();
  });
});

describe("what gets written at the end of the body", () => {
  it("writes the keyword and the short form in the issue's own repository", () => {
    expect(trailerFor([ref()], "acme/web")).toBe("Closes #32");
  });

  /**
   * The whole reason `trailerFor` takes a repository.
   *
   * A closing keyword only closes an issue inside its own repository. Writing
   * `Closes acme/web#32` in a request opening against `acme/docs` promises
   * something that will not happen, so it is written as a reference instead —
   * which is what GitHub will actually do with it.
   */
  it("downgrades to a reference when the issue is somewhere else", () => {
    expect(trailerFor([ref()], "acme/docs")).toBe("Refs acme/web#32");
  });

  it("keeps a plain reference plain", () => {
    expect(trailerFor([ref({ keyword: "Refs" })], "acme/web")).toBe("Refs #32");
  });

  it("writes one line each, in the order they were added", () => {
    expect(trailerFor([ref(), ref({ number: 18, keyword: "Refs" })], "acme/web")).toBe(
      "Closes #32\nRefs #18",
    );
  });

  it("adds nothing at all when nothing is linked", () => {
    expect(trailerFor([], "acme/web")).toBe("");
    expect(withTrailer("The body.", [], "acme/web")).toBe("The body.");
  });

  it("puts the references under the prose, with a blank line between", () => {
    expect(withTrailer("The body.\n", [ref()], "acme/web")).toBe("The body.\n\nCloses #32");
  });

  it("is still the trailer when somebody wrote no body", () => {
    expect(withTrailer("   ", [ref()], "acme/web")).toBe("Closes #32");
  });
});

describe("the issue a workspace was cut for", () => {
  it("comes from the URL, and defaults to closing", () => {
    const found = fromTask("#32", "https://github.com/acme/web/issues/32", "acme/web");
    expect(found).toMatchObject({ number: 32, repo: "acme/web", keyword: "Closes" });
  });

  /** Bound before URLs were kept. The number is still worth having. */
  it("falls back to the key when there is no URL", () => {
    expect(fromTask("#32", null, "acme/web")).toMatchObject({ number: 32, keyword: "Closes" });
  });

  it("is nothing for a session that was not started from one", () => {
    expect(fromTask(null, null, "acme/web")).toBeNull();
  });
});

describe("what the describing run noticed", () => {
  it("offers what it saw, as references rather than as closes", () => {
    const found = suggestionsFrom(["#18", "acme/api#41"], [], "acme/web");
    expect(found.map((f) => idOf(f))).toEqual(["acme/web#18", "acme/api#41"]);
    expect(found.every((f) => f.keyword === "Refs")).toBe(true);
  });

  it("does not offer what is already linked", () => {
    expect(suggestionsFrom(["#32"], [ref()], "acme/web")).toEqual([]);
  });

  it("drops anything that is not a reference, and says nothing when asked nothing", () => {
    expect(suggestionsFrom(["none", "32", ""], [], "acme/web")).toEqual([]);
    expect(suggestionsFrom(undefined, [], "acme/web")).toEqual([]);
  });

  it("offers the same issue once, however often it was mentioned", () => {
    expect(suggestionsFrom(["#18", "#18"], [], "acme/web")).toHaveLength(1);
  });
});

describe("how an issue is named on screen", () => {
  it("is short at home and qualified away from it", () => {
    expect(label(ref(), "acme/web")).toBe("#32");
    expect(label(ref(), "acme/docs")).toBe("acme/web#32");
    expect(label(ref({ repo: undefined }))).toBe("#32");
  });
});

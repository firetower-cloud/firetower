import { describe, expect, it } from "vitest";
import {
  fromTask,
  idOf,
  label,
  needsIntegration,
  parseReference,
  suggestionsFrom,
  trailerFor,
  withTrailer,
  type Reference,
} from "./issues";

const ref = (over: Partial<Reference> = {}): Reference => ({
  source: "github",
  key: "32",
  repo: "acme/web",
  keyword: "Closes",
  ...over,
});

const ticket = (over: Partial<Reference> = {}): Reference => ({
  source: "linear",
  key: "ENG-123",
  keyword: "Closes",
  ...over,
});

describe("reading what somebody typed", () => {
  it("takes a link from the address bar", () => {
    expect(parseReference("https://github.com/acme/web/issues/32")).toEqual({
      source: "github",
      key: "32",
      repo: "acme/web",
      keyword: "Refs",
      url: "https://github.com/acme/web/issues/32",
    });
  });

  it("takes a pull request link, which is an issue at the same number", () => {
    expect(parseReference("https://github.com/acme/web/pull/32")?.key).toBe("32");
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
      source: "github",
      key: "32",
      repo: "acme/web",
      keyword: "Refs",
    });
  });

  it("takes acme/api#41 as being somewhere else", () => {
    expect(parseReference("acme/api#41", "acme/web")?.repo).toBe("acme/api");
  });

  it("takes a Linear link, and does not confuse it for a repository", () => {
    expect(parseReference("https://linear.app/acme/issue/ENG-123/promo-codes")).toEqual({
      source: "linear",
      key: "ENG-123",
      keyword: "Refs",
      url: "https://linear.app/acme/issue/ENG-123/promo-codes",
    });
  });

  it("takes a bare ENG-123, upper-cased however it was written", () => {
    expect(parseReference("eng-123")).toMatchObject({ source: "linear", key: "ENG-123" });
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
    // Linear-shaped but not an identifier.
    expect(parseReference("-12")).toBeNull();
    expect(parseReference("ENG-")).toBeNull();
    expect(parseReference("https://linear.app/acme/team/ENG/all")).toBeNull();
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
    expect(trailerFor([ref(), ref({ key: "18", keyword: "Refs" })], "acme/web")).toBe(
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

  it("writes a Linear identifier with a word Linear knows", () => {
    expect(trailerFor([ticket()], "acme/web")).toBe("Closes ENG-123");
  });

  /**
   * `Refs` is not one of Linear's words, and a line it does not read is a
   * link that silently never appears on the issue.
   */
  it("writes Part of rather than Refs for a ticket", () => {
    expect(trailerFor([ticket({ keyword: "Refs" })], "acme/web")).toBe("Part of ENG-123");
  });

  /**
   * A ticket is the same identifier wherever the request opens, so unlike a
   * GitHub issue there is nothing to downgrade when the repository differs.
   */
  it("does not qualify a ticket by repository", () => {
    expect(trailerFor([ticket()], "acme/docs")).toBe("Closes ENG-123");
  });

  /**
   * Both hosts read the same body and each ignores the other's line: `#32` is
   * not an identifier and `ENG-123` is not a number.
   */
  it("writes one line for each tracker without either acting on the other", () => {
    expect(trailerFor([ref(), ticket()], "acme/web")).toBe("Closes #32\nCloses ENG-123");
  });
});

describe("the issue a workspace was cut for", () => {
  it("comes from the URL, and defaults to closing", () => {
    const found = fromTask("#32", "https://github.com/acme/web/issues/32", "acme/web");
    expect(found).toMatchObject({ source: "github", key: "32", repo: "acme/web", keyword: "Closes" });
  });

  /** Bound before URLs were kept. The number is still worth having. */
  it("falls back to the key when there is no URL", () => {
    expect(fromTask("#32", null, "acme/web")).toMatchObject({ key: "32", keyword: "Closes" });
  });

  it("is nothing for a session that was not started from one", () => {
    expect(fromTask(null, null, "acme/web")).toBeNull();
  });

  /**
   * The regression this exists to stop. A workspace cut from a ticket used to
   * read as nothing at all here, so the ship sheet opened with no link and
   * said nothing about it.
   */
  it("reads a workspace cut from a ticket", () => {
    const found = fromTask("ENG-123", "https://linear.app/acme/issue/ENG-123/promo", undefined);
    expect(found).toMatchObject({ source: "linear", key: "ENG-123", keyword: "Closes" });
    expect(found?.url).toBe("https://linear.app/acme/issue/ENG-123/promo");
  });

  it("reads one bound by identifier alone", () => {
    expect(fromTask("ENG-123", null)).toMatchObject({ source: "linear", key: "ENG-123" });
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

  it("does not offer a ticket that is already linked", () => {
    expect(suggestionsFrom(["ENG-123"], [ticket()], "acme/web")).toEqual([]);
  });

  it("drops anything that is not a reference, and says nothing when asked nothing", () => {
    expect(suggestionsFrom(["none", "32", ""], [], "acme/web")).toEqual([]);
    expect(suggestionsFrom(undefined, [], "acme/web")).toEqual([]);
  });

  it("offers the same issue once, however often it was mentioned", () => {
    expect(suggestionsFrom(["#18", "#18"], [], "acme/web")).toHaveLength(1);
  });

  /** An issue and a ticket at the same number are not the same thing. */
  it("does not confuse a number with an identifier", () => {
    const found = suggestionsFrom(["#123", "ENG-123"], [], "acme/web");
    expect(found.map(idOf)).toEqual(["acme/web#123", "linear:ENG-123"]);
  });
});

describe("how an issue is named on screen", () => {
  it("is short at home and qualified away from it", () => {
    expect(label(ref(), "acme/web")).toBe("#32");
    expect(label(ref(), "acme/docs")).toBe("acme/web#32");
    expect(label(ref({ repo: undefined }))).toBe("#32");
  });

  it("names a ticket the same way everywhere", () => {
    expect(label(ticket(), "acme/web")).toBe("ENG-123");
    expect(label(ticket(), "acme/docs")).toBe("ENG-123");
  });
});

describe("what only works if the tracker's own integration is on", () => {
  it("is nothing for GitHub, which needs no help", () => {
    expect(needsIntegration([ref()])).toBe(false);
    expect(needsIntegration([])).toBe(false);
  });

  it("is the ticket, whose trailer does nothing unless Linear is connected", () => {
    expect(needsIntegration([ref(), ticket()])).toBe(true);
  });
});

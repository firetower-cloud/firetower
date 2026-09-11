import { describe, expect, it } from "vitest";
import {
  START,
  back,
  cursorAt,
  describeQuery,
  everything,
  forward,
  queryHint,
  type Asking,
} from "./tasks";

const ask = (over: Partial<Asking> = {}): Asking => ({
  kind: "issue",
  state: "open",
  mine: false,
  q: "",
  ...over,
});

describe("saying what the chips asked for", () => {
  it("writes GitHub's dialect for GitHub", () => {
    expect(describeQuery("github", ask({ scope: "acme/web", mine: true }))).toBe(
      "repo:acme/web is:issue is:open assignee:@me",
    );
  });

  it("writes Linear's dialect for Linear", () => {
    expect(describeQuery("linear", ask({ scope: "ENG", mine: true }))).toBe(
      "team:ENG state:open assignee:me",
    );
  });

  it("says which everything it means when nothing is picked", () => {
    expect(describeQuery("github", ask())).toContain("your repositories");
    expect(describeQuery("linear", ask())).toContain("your teams");
  });

  /**
   * The same rule the server follows. Sending a chip and a typed qualifier
   * for the same thing means one of them is quietly ignored, and this line is
   * where somebody would otherwise never find that out.
   */
  it("drops a chip that what somebody typed already names", () => {
    const said = describeQuery("github", ask({ scope: "acme/web", mine: true, q: "repo:acme/api" }));
    expect(said).not.toContain("repo:acme/web");
    expect(said).toContain("repo:acme/api");
  });

  it("drops a Linear chip the same way", () => {
    const said = describeQuery("linear", ask({ scope: "ENG", q: "team:DES state:completed" }));
    expect(said).not.toContain("team:ENG");
    expect(said).not.toContain("state:open");
    expect(said).toContain("team:DES");
  });

  it("puts what was typed at the end, as it was typed", () => {
    expect(describeQuery("github", ask({ scope: "acme/web", q: "label:bug" }))).toBe(
      "repo:acme/web is:issue is:open label:bug",
    );
  });

  it("asks for pull requests when the toggle says so", () => {
    expect(describeQuery("github", ask({ kind: "pullRequest" }))).toContain("is:pr");
  });

  it("suggests what each tracker actually understands", () => {
    expect(queryHint("linear")).toContain("state:");
    expect(queryHint("github")).toContain("sort:");
  });

  it("names the scope after what the tracker has", () => {
    expect(everything("teams")).toBe("All your teams");
    expect(everything("repos")).toBe("All your repositories");
  });
});

describe("walking a list that pages by cursor", () => {
  it("starts at the beginning, which has no cursor", () => {
    expect(cursorAt(START)).toBeUndefined();
  });

  it("remembers where each page started, so Previous can go back", () => {
    const second = forward(START, "c1");
    const third = forward(second, "c2");

    expect(cursorAt(third)).toBe("c2");
    expect(cursorAt(back(third))).toBe("c1");
    expect(cursorAt(back(back(third)))).toBeUndefined();
  });

  it("does not walk back past the first page", () => {
    expect(back(back(START)).at).toBe(0);
  });

  /**
   * Going back and then forward again down a different branch would otherwise
   * leave the old cursors behind it, and the page count would stop matching
   * the list.
   */
  it("forgets what was after it when it goes back and forward again", () => {
    const third = forward(forward(START, "c1"), "c2");
    const other = forward(back(third), "c9");

    expect(other.cursors).toEqual([undefined, "c1", "c9"]);
    expect(other.at).toBe(2);
  });
});

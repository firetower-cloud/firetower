import { describe, expect, test } from "vitest";
import { trailerFor } from "~/api/issues";
import { seededRefs } from "./Ship";

/**
 * What the Ship sheet starts with in its References, for a session cut from a
 * task. A Trello card's key is its bare shortLink, which `parseReference`
 * rightly refuses on its own, so the card's URL has to be the way back to it.
 */
describe("the references a shipped session starts with", () => {
  test("a Trello card is found through its URL and written as a trailer", () => {
    const refs = seededRefs(
      { taskKey: "aB3dE9fG", taskUrl: "https://trello.com/c/aB3dE9fG/42-fix-export" },
      undefined,
    );
    expect(refs).toHaveLength(1);
    expect(trailerFor(refs)).toBe("Trello: https://trello.com/c/aB3dE9fG");
  });

  test("an issue key still reads as itself", () => {
    expect(seededRefs({ taskKey: "#32", taskUrl: "https://github.com/acme/web/issues/32" }, "acme/web")[0]).toMatchObject({
      key: "32",
      repo: "acme/web",
    });
  });

  test("a session with no task starts with none", () => {
    expect(seededRefs({ taskKey: null, taskUrl: null }, undefined)).toEqual([]);
  });
});

import { describe, expect, test } from "vitest";
import { asError } from "./bridge";
import { why } from "./data";

/**
 * The regression: a download that failed said "That didn't work."
 *
 * The worker refuses anything over the size limit with a sentence naming the
 * file, its size and what to do instead. Tauri hands a `Result::Err(String)`
 * back as a bare string, `why()` reads `.message`, and a string has none — so
 * the useful half of the failure never reached the screen.
 */
describe("a rejection from the shell", () => {
  const refusal =
    "random_stuff/huge.bin is 119 MB. Anything over 100 MB has to come off the " +
    "machine another way — `scp`, `docker cp`, or a command in the shell tab";

  test("keeps what the server actually said", () => {
    expect(asError(refusal).message).toBe(refusal);
    // The whole point: this is what the row ends up drawing.
    expect(why(asError(refusal))).toBe(refusal);
  });

  test("and a bare string would otherwise read as the house fallback", () => {
    // Documents the bug rather than the fix: `why` on the raw rejection.
    expect(why(refusal)).toBe("That didn't work.");
  });

  test("leaves a real Error alone", () => {
    const already = new Error("the host stopped answering");
    expect(asError(already)).toBe(already);
  });
});

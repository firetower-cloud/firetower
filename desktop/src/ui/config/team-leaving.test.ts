/**
 * Leaving a team with a draft on it.
 *
 * **Save being the only commit is the whole promise of this screen**, and a
 * surface that drops unsaved work on the way out breaks it quietly. That was
 * shipped: navigating away discarded the draft and said nothing, which the
 * prototype's own D5 flagged as the transition it was least sure of and which
 * QA confirmed on the build.
 *
 * Two halves are worth pinning. The router has to consult a guard and obey
 * what it answers, and the sentence the question puts on screen has to say
 * what leaving would cost — a bare *2 changes* does not tell somebody whether
 * a subtree is about to go.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { leaveGuard } from "~/shims/next-navigation";
import { describeChanges } from "./TeamMap";
import type { Change } from "./team-map";

afterEach(() => leaveGuard.clear());

describe("the router's leave guard", () => {
  test("nothing is registered by default, so navigation is not gated", () => {
    expect(leaveGuard.armed()).toBe(false);
    expect(leaveGuard.ask(() => {})).toBe(false);
  });

  /* The screen answers per call: a map with nothing pending lets the address
     change without a word, which is every navigation on this pane but one. */
  test("a guard that answers false lets the navigation through", () => {
    const resume = vi.fn();
    expect(leaveGuard.ask(resume)).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });
});

/**
 * **Two screens, two drafts, two questions.**
 *
 * A team's map holds a draft of the tree and the profile drawer docked beside
 * it holds a draft of a profile. They are two commit boundaries, so each asks
 * its own and the sheets come up in turn. The failure this pins is a real one
 * that shipped: with the map asked first, pressing Discard on a sentence
 * counting only the map's changes closed the drawer and took the profile edit
 * with it — a prompt that appeared, said what was being lost, and was wrong
 * about it. Worse than the silent loss the guard exists to prevent.
 */
describe("more than one screen holding unsaved work", () => {
  /** A guard that always takes it, and remembers how to let go. */
  const holding = () => {
    const it = { asked: 0, resume: null as null | (() => void) };
    const guard = (resume: () => void) => {
      it.asked++;
      it.resume = resume;
      return true;
    };
    return { it, guard };
  };

  /**
   * **The most recently mounted asks first.** The drawer opens beside the map
   * rather than the other way round, so it is what somebody was last working
   * in — and it is the one the map's own Discard would otherwise close.
   */
  test("the one that mounted last is asked first", () => {
    const first = holding();
    const last = holding();
    register(first.guard, last.guard);

    expect(leaveGuard.ask(() => {})).toBe(true);
    expect(last.it.asked).toBe(1);
    expect(first.it.asked).toBe(0);
  });

  test("answering the first asks the second, and only then does it go", () => {
    const first = holding();
    const last = holding();
    register(first.guard, last.guard);
    const went = vi.fn();

    expect(leaveGuard.ask(went)).toBe(true);
    expect(went).not.toHaveBeenCalled();

    // The drawer's sheet is answered: the map's comes up, and nothing has
    // navigated yet.
    last.it.resume!();
    expect(first.it.asked).toBe(1);
    expect(went).not.toHaveBeenCalled();

    // And the map's.
    first.it.resume!();
    expect(went).toHaveBeenCalledOnce();
  });

  /**
   * **An answered guard is skipped for that navigation, not dropped.**
   *
   * It used to be deleted, so staying at the second sheet left the first
   * screen unguarded for the rest of its life — it would never ask again.
   */
  test("cancelling at the second sheet leaves both still armed", () => {
    const first = holding();
    const last = holding();
    register(first.guard, last.guard);

    leaveGuard.ask(() => {});
    last.it.resume!(); // answered the drawer's
    // …and stayed at the map's, which is simply not calling its resume.
    expect(leaveGuard.armed()).toBe(true);

    const went = vi.fn();
    expect(leaveGuard.ask(went)).toBe(true);
    expect(last.it.asked).toBe(2);
    expect(went).not.toHaveBeenCalled();
  });

  test("one that has nothing to say is passed over rather than asked twice", () => {
    const quiet = { asked: 0 };
    const last = holding();
    register(() => {
      quiet.asked++;
      return false;
    }, last.guard);

    const went = vi.fn();
    leaveGuard.ask(went);
    last.it.resume!();
    expect(quiet.asked).toBe(1);
    expect(went).toHaveBeenCalledOnce();
  });
});

/**
 * Register guards in mount order, the way two mounted components would.
 *
 * `useLeaveGuard` is a hook and these tests have no renderer, so they go in
 * through the same door the hook uses.
 */
function register(...asks: ((resume: () => void) => boolean)[]) {
  for (const ask of asks) leaveGuard.add(ask);
}

describe("what the question says is at stake", () => {
  const add = (n: number): Change[] =>
    Array.from({ length: n }, (_, i) => ({ kind: "add", key: `new-${i}`, profile: "r_1" }));
  const remove = (under: number): Change =>
    ({ kind: "remove", id: "p_1", profile: "r_1", under });

  test("one of each reads as English", () => {
    expect(describeChanges(add(1))).toBe("Not saved yet: one position added.");
    expect(describeChanges([remove(0)])).toBe("Not saved yet: one taken out.");
    expect(describeChanges(add(3))).toBe("Not saved yet: 3 positions added.");
  });

  /**
   * **A removal counts what goes, not what was pressed.**
   *
   * The pending count beside Save is one per gesture, which is right there —
   * it says how many decisions are waiting. Here the question is what leaving
   * would cost, and taking out a position with three under it costs four
   * cards. The two numbers are different on purpose.
   */
  test("a removed subtree says how many cards go, not how many presses", () => {
    expect(describeChanges([remove(3)])).toBe("Not saved yet: 4 taken out.");
  });

  test("several kinds are joined rather than listed as a number", () => {
    expect(describeChanges([...add(2), remove(1)])).toBe(
      "Not saved yet: 2 positions added and 2 taken out.",
    );
    expect(
      describeChanges([...add(1), remove(0), { kind: "move", id: "p_2", profile: "r_2" }]),
    ).toBe("Not saved yet: one position added, one taken out and one moved.");
  });

  /* It is never drawn at nothing — the guard answers false first — but a
     sentence that reads as a bug if it ever escaped is worth one line. */
  test("nothing pending has nothing to say", () => {
    expect(describeChanges([])).toBe("Nothing is saved yet.");
  });
});

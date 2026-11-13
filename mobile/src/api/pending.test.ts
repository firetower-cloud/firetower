/**
 * A read belongs to the session it was made for.
 *
 * `useAnswering` asks this question again over the top, and that is deliberate
 * — see `pair` there. This is the same question asked of the hook alone, so
 * that the slot's own guard cannot be deleted while the suite stays green: a
 * second lock is only a second lock while both of them are tested.
 *
 * The ordering is the point, and `test/hooks.ts` says why it has to be
 * modelled rather than mocked: `render()` commits a frame, `flush()` runs the
 * effects that follow it, and the hook has to be right in between.
 */
import { describe, expect, it, vi } from "vitest";
import * as hooks from "~/test/hooks";
import { usePending, type Pending } from "~/api/pending";

vi.mock("react", async () => (await import("~/test/hooks")).react);

const reads: string[] = [];

vi.mock("~/api/generated/sessions/sessions", () => ({
  getConversation: async (id: string) => {
    reads.push(id);
    return {
      events: [
        { type: "RequestOpened", lineNo: 2, req: id === "s_a" ? "7" : "9", kind: "Command", detail: id, args: {} },
      ],
    };
  },
}));

describe("what a pending read is about", () => {
  it("is carried with it, and is the session it was asked for", async () => {
    let held: string | null = "s_a";
    hooks.mount(() => usePending(held, true));

    await vi.waitFor(() => expect(hooks.last<Pending>().asked?.req).toBe("7"));
    expect(hooks.last<Pending>().of).toBe("s_a");

    /* The slot keeps its state; the session in it has changed. This is the
       commit before the effect runs, which is the only frame the defect ever
       existed in. */
    held = "s_b";
    const frame = hooks.render<Pending>();
    expect(frame.of).toBe("s_b");
    expect(frame.asked).toBeNull();
    expect(frame.reading).toBe(true);

    hooks.flush();
    await vi.waitFor(() => expect(hooks.last<Pending>().asked?.req).toBe("9"));
    expect(hooks.last<Pending>().of).toBe("s_b");
  });

  it("asks nothing, and holds nothing, while nothing is held", () => {
    reads.length = 0;
    hooks.unmount();
    const nothing = hooks.mount(() => usePending(null, false));
    expect(nothing).toEqual({ of: null, asked: null, reading: false, failed: false });
    expect(reads).toEqual([]);
  });

  it("forgets what it read once the peek is dismissed", async () => {
    let held: string | null = "s_a";
    hooks.unmount();
    hooks.mount(() => usePending(held, true));
    await vi.waitFor(() => expect(hooks.last<Pending>().asked?.req).toBe("7"));

    held = null;
    expect(hooks.render<Pending>().asked).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { apply, nothing } from "./conversation";
import type { ConversationEvent } from "./generated/model";

const event = (lineNo: number, type: string, extra: Record<string, unknown> = {}) =>
  ({ lineNo, type, ...extra }) as ConversationEvent;

describe("a sent image", () => {
  it("stays visible while the server replaces its optimistic message", () => {
    const image = { mediaType: "image/png", data: "iVBORw0KGgo=" };
    const typed = {
      ...nothing,
      items: [
        { id: "typed-1", kind: "UserMessage", text: "Look at this", output: "", images: [image] },
      ],
    } as typeof nothing;

    const started = apply(
      typed,
      event(1, "ItemStarted", { item: "message-1", kind: "UserMessage" }),
    );
    expect(started.items).toEqual([
      expect.objectContaining({ id: "message-1", images: [image] }),
    ]);

    const updated = apply(
      started,
      event(2, "ItemUpdated", { item: "message-1", data: { images: [image] } }),
    );
    expect(updated.items[0].images).toEqual([image]);
  });
});

describe("a turn somebody stopped", () => {
  it("is not reported as an agent that stopped without saying why", () => {
    const working = apply(nothing, event(1, "TurnStarted", { turn: "turn-1" }));
    const asked = { ...working, stopping: true };

    // What an interrupted turn actually comes back as: a failure, with nothing
    // said about it. Indistinguishable from a crash except for having been
    // asked for.
    const ended = apply(asked, event(2, "TurnCompleted", { turn: "turn-1", status: "Failed" }));
    expect(ended.working).toBe(false);
    expect(ended.stopped).toBeUndefined();
    expect(ended.stopping).toBe(false);
  });

  it("still explains a failure nobody asked for", () => {
    const working = apply(nothing, event(1, "TurnStarted", { turn: "turn-1" }));
    const ended = apply(working, event(2, "TurnCompleted", { turn: "turn-1", status: "Failed" }));
    expect(ended.stopped).toBe("The agent stopped without saying why.");
  });

  it("forgets the asking when the next turn starts", () => {
    const asked = { ...nothing, stopping: true };
    expect(apply(asked, event(1, "TurnStarted", { turn: "turn-2" })).stopping).toBe(false);
  });
});

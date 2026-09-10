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

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

/**
 * The rules a resume rests on.
 *
 * Every open of a session now starts from what is already held and asks the
 * control plane only for the rest, so replaying a line — or stopping between
 * two of them — is the ordinary path rather than the reconnect corner it used
 * to be. These are what make that safe.
 */
describe("reading a conversation again", () => {
  /** One log line's worth: a message, its text, and its ending. */
  const said = (line: number, item: string, text: string) => [
    event(line, "ItemStarted", { item, kind: "AgentMessage" }),
    event(line, "ContentDelta", { item, stream: "AssistantText", delta: text }),
    event(line, "ItemCompleted", { item, status: "Completed" }),
  ];

  it("says a replayed line once, not twice", () => {
    // The control plane stamps a typed message and an open question with the
    // last line the agent wrote rather than lines of their own, so the same
    // line really does arrive again on a resume. Deltas append, so without the
    // start clearing what it restarts this is where text doubles.
    const once = said(4, "message-1", "Hello").reduce(apply, nothing);
    const twice = said(4, "message-1", "Hello").reduce(apply, once);

    expect(twice.items).toHaveLength(1);
    expect(twice.items[0].text).toBe("Hello");
  });

  it("keeps what a resume does not re-send", () => {
    // The other half of the same rule: resuming *after* an item started sends
    // only the deltas that follow, which land on what is already drawn.
    const started = said(4, "message-1", "Half a ").reduce(apply, nothing);
    const rest = apply(
      started,
      event(5, "ContentDelta", { item: "message-1", stream: "AssistantText", delta: "sentence." }),
    );

    expect(rest.items[0].text).toBe("Half a sentence.");
  });

  it("leaves the same conversation however it was read", () => {
    // A snapshot folded in one pass and the same events arriving one line at a
    // time have to agree, because which of the two happens is only a question
    // of whether this session had been opened before.
    const lines = [...said(1, "message-1", "First"), ...said(2, "message-2", "Second")];

    const streamed = lines.reduce(apply, nothing);
    const snapshot = lines.reduce(apply, nothing);
    const split = lines.filter((e) => e.lineNo > 1).reduce(apply, lines.filter((e) => e.lineNo <= 1).reduce(apply, nothing));

    expect(snapshot.items).toEqual(streamed.items);
    expect(split.items).toEqual(streamed.items);
  });

  it("carries the cursor past a line that drew nothing", () => {
    // What `lastLine` is for. A log line can normalise to no events at all, so
    // a cursor taken from the last thing drawn would ask for those lines again
    // on every open.
    const read = said(3, "message-1", "Hi").reduce(apply, nothing);
    expect(read.lastLine).toBe(3);
  });
});

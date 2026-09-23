import { describe, expect, it } from "vitest";
import { apply, foldAll, nothing, prepend } from "./conversation";
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

describe("folding a run of events", () => {
  /* `SessionConfigured` reads `event.commands.length`, so one without them
     throws — which is the point. Any event the control plane grows a shape
     for before this client learns it does the same. */
  const unfoldable = { lineNo: 2, type: "SessionConfigured" } as unknown as ConversationEvent;

  it("keeps going past an event it cannot fold", () => {
    const out = foldAll(nothing, [
      event(1, "ItemStarted", { item: "a", kind: "AgentMessage" }),
      unfoldable,
      event(3, "ItemStarted", { item: "b", kind: "AgentMessage" }),
    ]);

    // The one in the middle costs one item, not the rest of the conversation.
    expect(out.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(out.skipped).toBe(1);
  });

  it("moves the cursor past what it could not fold", () => {
    // Or the stream is asked for the same unreadable line for ever.
    expect(foldAll(nothing, [unfoldable]).lastLine).toBe(2);
  });

  it("counts nothing when everything folds", () => {
    const out = foldAll(nothing, [event(1, "TurnStarted")]);
    expect(out.skipped).toBeUndefined();
    expect(out.working).toBe(true);
  });
});

/**
 * Reading backwards.
 *
 * A transcript now opens on its last few exchanges and grows at the top as
 * somebody scrolls. The property that matters is that a conversation read in
 * pages is the same conversation read whole — anything else is a transcript
 * that quietly disagrees with itself depending on how it was opened.
 */
describe("a page of history", () => {
  /** One exchange, as the control plane's own cut produces it. */
  const exchange = (nth: number) => [
    event(nth * 10, "TurnStarted", { turn: `turn-${nth}` }),
    event(nth * 10, "ItemStarted", { item: `msg-${nth}`, kind: "UserMessage" }),
    event(nth * 10, "ContentDelta", { item: `msg-${nth}`, stream: "UserText", delta: `ask ${nth}` }),
    event(nth * 10, "ItemCompleted", { item: `msg-${nth}`, status: "Completed" }),
    event(nth * 10 + 1, "ItemStarted", { item: `said-${nth}`, kind: "AssistantMessage" }),
    event(nth * 10 + 2, "ContentDelta", {
      item: `said-${nth}`,
      stream: "AssistantText",
      delta: `answer ${nth}`,
    }),
    event(nth * 10 + 3, "TurnCompleted", { turn: `turn-${nth}`, status: "Completed" }),
  ];

  const configured = event(1, "SessionConfigured", {
    model: "opus",
    mode: "acceptEdits",
    tools: [],
    commands: [],
  });

  it("reads the same as the conversation read whole", () => {
    const whole = foldAll(nothing, [configured, ...exchange(1), ...exchange(2), ...exchange(3)]);

    // What the two requests actually return: the tail, then the page before
    // it — each carrying the configuration, as the control plane does.
    const tail = foldAll(nothing, [configured, ...exchange(3)]);
    const paged = prepend({ ...tail, firstLine: 30, hasMore: true }, {
      events: [configured, ...exchange(1), ...exchange(2)],
      firstLine: 10,
      hasMore: false,
    });

    expect(paged.items.map((i) => i.id)).toEqual(whole.items.map((i) => i.id));
    expect(paged.items.map((i) => i.text)).toEqual(whole.items.map((i) => i.text));
  });

  it("puts the older exchanges in front, not behind", () => {
    const tail = foldAll(nothing, exchange(3));
    const paged = prepend({ ...tail, firstLine: 30, hasMore: true }, {
      events: exchange(2),
      firstLine: 20,
      hasMore: true,
    });

    expect(paged.items.map((i) => i.id)).toEqual(["msg-2", "said-2", "msg-3", "said-3"]);
  });

  /* The configuration is carried onto every page, so the item that opens the
     page is one the tail already drew. React keys on these ids. */
  it("draws nothing twice when a page overlaps what is already here", () => {
    const tail = foldAll(nothing, exchange(3));
    const paged = prepend({ ...tail, firstLine: 30, hasMore: true }, {
      events: [...exchange(2), ...exchange(3)],
      firstLine: 20,
      hasMore: true,
    });

    const ids = paged.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The resume cursor belongs to the end of the conversation. Moved backwards
   * by a page of history, the socket would replay everything since — and
   * `ContentDelta` appends, so the agent would say the last hour again.
   */
  it("leaves the resume cursor alone", () => {
    const tail = { ...foldAll(nothing, exchange(9)), firstLine: 90, hasMore: true };
    const paged = prepend(tail, { events: exchange(1), firstLine: 10, hasMore: false });

    expect(paged.lastLine).toBe(tail.lastLine);
    expect(paged.firstLine).toBe(10);
    expect(paged.hasMore).toBe(false);
  });

  /**
   * An old page describes the session as it was. Folding it onto the held
   * state would restate all of it as now — and a turn that ended last week
   * would set the composer working.
   */
  it("does not let an old turn make the agent look busy", () => {
    const working = foldAll(nothing, [
      ...exchange(5),
      event(60, "TurnStarted", { turn: "turn-6" }),
    ]);
    expect(working.working).toBe(true);

    // A page whose last turn completed. Folded onto the present it would
    // clear `working`; folded on its own it cannot.
    const paged = prepend({ ...working, firstLine: 50, hasMore: true }, {
      events: exchange(1),
      firstLine: 10,
      hasMore: false,
    });

    expect(paged.working).toBe(true);
  });

  /**
   * A control plane that does not know about paging answers the same request
   * with the whole conversation and says nothing about `hasMore`. Treating
   * that silence as "there is more" would spin for ever at the top.
   */
  it("stops asking when the control plane does not page", () => {
    const tail = { ...foldAll(nothing, exchange(1)), firstLine: 10, hasMore: true };
    const paged = prepend(tail, { events: [] });

    expect(paged.hasMore).toBe(false);
    expect(paged.loadingOlder).toBe(false);
  });
});

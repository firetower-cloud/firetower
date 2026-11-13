/**
 * A slot is not a session.
 *
 * `useAnswering` asks for two pending requests **by position**, because hooks
 * cannot be called in a loop whose length changes. The blocked set does not
 * hold still underneath them: an agent unblocks while a row is held, the next
 * one slides up a place, and for one commit — the one before the slot's effect
 * runs — the slot still holds the previous session's request.
 *
 * `[A, B] → [B, C]` is that frame. B arrives in slot 0 while slot 0 is still
 * holding A's `req`, so the peek drew **B's name over A's request** and a press
 * submitted `{ id: B, req: A's }`. Nobody was answering as somebody else; what
 * made it worth fixing is that a request id is only unique inside a session —
 * Codex numbers them from one — so the stale id can name a real and different
 * permission in the session it lands on. QA's fixture had slot 1 holding a
 * second, unshown `req 7` that would have deleted a production deployment.
 *
 * Two things are asserted here and they are not the same thing:
 *
 * 1. **No frame** ever draws a session against another session's `req`.
 * 2. **No press** ever submits one, including a press that lands in that frame.
 *
 * The second does not follow from the first. The old code re-derived the
 * request at press time by searching the slots, so what it submitted was a
 * fresh answer to the same question rather than the answer the reader was
 * looking at.
 *
 * QA could not reach this on a device — the only thing that moves the blocked
 * set with the peek open is a live fleet refresh, and the rig has no worker to
 * cause one. So it is proved here instead, in the ordering it actually lives
 * in: `render()` commits a frame, `flush()` runs the effects React would run
 * after it, and the gap between them is where the defect was.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "~/api/generated/model";
import { ANSWERS, useAnswering } from "~/api/answering";
import { group, type Workspace } from "~/api/workspaces";
import * as hooks from "~/test/hooks";

/* The hooks come from `test/hooks.ts` rather than from React, which this
   project has no renderer for. `await import` because a `vi.mock` factory is
   hoisted above the imports it would otherwise close over. */
vi.mock("react", async () => (await import("~/test/hooks")).react);

/** What each session is really blocked on. A read may say nothing else. */
const TRUTH: Record<string, string> = {
  s_a: "7",
  s_b: "9",
  /* The one that makes a mispairing cost something: `7` is a real request in
     C as well, and a different one. */
  s_c: "7",
};

const answers: { id: string; req: string }[] = [];

vi.mock("~/api/generated/sessions/sessions", () => ({
  getConversation: async (id: string) => ({
    events: [
      {
        type: "RequestOpened",
        lineNo: 2,
        req: TRUTH[id],
        kind: "Command",
        detail: `what ${id} asked`,
        args: {},
      },
    ],
  }),
  useAnswerRequest: () => ({
    mutate: ({ id, data }: { id: string; data: { req: string } }) =>
      answers.push({ id, req: data.req }),
  }),
}));

const run = (over: Partial<Session> & { id: string }): Session =>
  ({
    name: "Rate limiter",
    status: "NeedsYou",
    agent: "Codex",
    repo: "acme/web",
    workspaceId: "w_api",
    createdAt: "2026-11-11T10:00:00Z",
    updatedAt: "2026-11-11T10:00:00Z",
    ...over,
  }) as Session;

/** One parent with three children of its own, each blocked or not. */
function fleet(blocked: string[]): { place: Workspace; places: Workspace[] } {
  const beat = (id: string) => (blocked.includes(id) ? "NeedsYou" : "Working");
  const { groups } = group([
    run({ id: "s_api", name: "api-gateway", status: "Working", createdAt: "2026-11-11T09:00:00Z" }),
    /* Newest first inside the blocked set, so which slot each lands in is the
       fixture's and not a tie-break's: A, then B, then C. */
    run({ id: "s_a", name: "rate-limiter", status: beat("s_a"), workspaceId: "w_a", parentId: "s_api", createdAt: "2026-11-11T12:00:00Z" }),
    run({ id: "s_b", name: "auth-shim", status: beat("s_b"), workspaceId: "w_b", parentId: "s_api", createdAt: "2026-11-11T11:00:00Z" }),
    run({ id: "s_c", name: "tracing", status: beat("s_c"), workspaceId: "w_c", parentId: "s_api", createdAt: "2026-11-11T10:00:00Z" }),
  ]);
  const places = groups.flatMap(([, inRepo]) => inRepo);
  return { place: places.find((p) => p.id === "w_api")!, places };
}

/** Every pair this frame is offering, as `session:req`. */
const pairs = (asks: { run: Session; asked?: { req: string } | null }[]) =>
  asks.map((ask) => `${ask.run.id}:${ask.asked?.req ?? "—"}`);

/** Nothing on screen or on the wire may name another session's request. */
function nothingMispaired(asks: { run: Session; asked?: { req: string } | null }[]) {
  for (const ask of asks) {
    if (ask.asked) expect(ask.asked.req).toBe(TRUTH[ask.run.id]);
  }
  for (const answer of answers) {
    expect(answer.req).toBe(TRUTH[answer.id]);
  }
}

type Answering = ReturnType<typeof useAnswering>;

describe("a question stays with the agent that asked it", () => {
  let held: { place: Workspace; places: Workspace[] };

  beforeEach(() => {
    answers.length = 0;
    held = fleet(["s_a", "s_b"]);
    hooks.mount(() => useAnswering(held.place, held.places));
  });

  it("offers two, because that is the cap", () => {
    expect(ANSWERS).toBe(2);
    expect(hooks.last<Answering>().asks).toHaveLength(2);
  });

  it("pairs each agent with its own request once the reads land", async () => {
    await vi.waitFor(() => expect(pairs(hooks.last<Answering>().asks)).toEqual(["s_a:7", "s_b:9"]));
    nothingMispaired(hooks.last<Answering>().asks);
  });

  it("draws no pair at all in the commit the set moves in", async () => {
    await vi.waitFor(() => expect(pairs(hooks.last<Answering>().asks)).toEqual(["s_a:7", "s_b:9"]));

    /* A unblocks while the peek is open, so B slides into slot 0 and C
       arrives in slot 1. One commit, no effects — the frame a thumb lands
       in. */
    held = fleet(["s_b", "s_c"]);
    const frame = hooks.render<Answering>();

    expect(pairs(frame.asks)).toEqual(["s_b:—", "s_c:—"]);
    nothingMispaired(frame.asks);
  });

  it("submits nothing when the button is pressed in that commit", async () => {
    await vi.waitFor(() => expect(pairs(hooks.last<Answering>().asks)).toEqual(["s_a:7", "s_b:9"]));

    held = fleet(["s_b", "s_c"]);
    const frame = hooks.render<Answering>();
    /* Both answers, on both slots. `Asking` draws no buttons without an
       `asked`, so this is a press that cannot happen through the UI — and it
       is asserted anyway, because the UI is not what decides what the wire
       carries. */
    for (const ask of frame.asks) {
      frame.onAnswer(ask, true);
      frame.onAnswer(ask, false);
    }

    expect(answers).toEqual([]);
  });

  it("pairs them again, correctly, once the new reads land", async () => {
    await vi.waitFor(() => expect(pairs(hooks.last<Answering>().asks)).toEqual(["s_a:7", "s_b:9"]));

    held = fleet(["s_b", "s_c"]);
    hooks.render();
    hooks.flush();

    await vi.waitFor(() => expect(pairs(hooks.last<Answering>().asks)).toEqual(["s_b:9", "s_c:7"]));
    hooks.last<Answering>().asks.forEach((ask) => hooks.last<Answering>().onAnswer(ask, true));
    expect(answers).toEqual([
      { id: "s_b", req: "9" },
      { id: "s_c", req: "7" },
    ]);
    nothingMispaired(hooks.last<Answering>().asks);
  });

  it("answers the pair the button was drawn with, not the pair the slot holds now", async () => {
    await vi.waitFor(() => expect(pairs(hooks.last<Answering>().asks)).toEqual(["s_a:7", "s_b:9"]));
    /* The reader's thumb is already on A's *Allow* when the set moves under
       it. The press has to mean what it meant when it was drawn — and it is
       the newest frame's handler that runs it, because React hands a fresh
       `onPress` to the button on every commit. */
    const askedOfA = hooks.last<Answering>().asks[0];

    held = fleet(["s_b", "s_c"]);
    hooks.render();
    hooks.flush();
    await vi.waitFor(() => expect(pairs(hooks.last<Answering>().asks)).toEqual(["s_b:9", "s_c:7"]));
    hooks.last<Answering>().onAnswer(askedOfA, true);

    expect(answers).toEqual([{ id: "s_a", req: "7" }]);
  });

  it("counts everyone waiting, past the two it offers buttons for", () => {
    held = fleet(["s_a", "s_b", "s_c"]);
    const frame = hooks.render<Answering>();
    expect(frame.waiting).toBe(3);
    expect(frame.asks).toHaveLength(2);
  });

  it("holds nothing when nothing is held", () => {
    hooks.unmount();
    const nothing = hooks.mount(() => useAnswering(null, []));
    expect(nothing.asks).toEqual([]);
    expect(nothing.waiting).toBe(0);
  });
});

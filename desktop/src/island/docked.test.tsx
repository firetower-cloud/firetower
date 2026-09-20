/**
 * The one thing about docking that cannot be got wrong.
 *
 * A notch is a hole in the panel, not a dark patch of it: nothing drawn in
 * that rectangle is ever seen by anybody. The first version of this centred
 * the collapsed pill on the cutout, which put the ember dot and every word it
 * had behind the camera — on the machine this was written on, which has no
 * notch, it looked perfect.
 *
 * That is exactly the class of bug that reaches a laptop and nowhere else, so
 * the gap is asserted rather than eyeballed.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session, SessionStatus } from "~/api/generated/model";
import type { Backend, Fleet } from "~/fleet";
import { Collapsed, Panel } from "./Island";
import { islandState, modeOf } from "./state";

const backend: Backend = {
  id: "a",
  org: "Westlabs",
  user: "kevin",
  mark: "W",
  url: "https://westlabs.example",
  reach: "live",
};

const session = (status: SessionStatus, over: Partial<Session> = {}): Session =>
  ({
    id: "s_1",
    name: "auth middleware",
    agent: "ClaudeCode",
    repo: "westlabs/ledger",
    workspaceId: "w_1",
    createdAt: new Date(Date.now() - 28 * 60_000).toISOString(),
    status,
    ...over,
  }) as unknown as Session;

const fleet = (sessions: Session[]): Fleet[] => [{ backend, sessions, error: null }];

const waiting = islandState(
  fleet([session("NeedsYou"), session("NeedsYou", { id: "s_2", workspaceId: "w_2", name: "rate limiter" })]),
);

describe("the fleet, counted", () => {
  const mixed = {
    ...waiting,
    working: [...waiting.waiting].slice(0, 1),
    tally: { working: 1, blocked: 2, done: 4, broken: 0, over: 0 },
  };

  it("reads in time order: in flight, then wanting you, then done", () => {
    const html = renderToStaticMarkup(
      <Collapsed state={mixed} mode={modeOf(mixed)} onGrab={() => {}} />,
    );
    const order = [...html.matchAll(/data-beat="(working|blocked|done)"/g)].map((m) => m[1]);
    // The glyphs repeat inside the row, so the first of each is the tally's.
    expect([...new Set(order)]).toEqual(["working", "blocked", "done"]);
  });

  it("keeps an empty state's place rather than resizing the row", () => {
    /* Dropping the slot changes the row's width, and the box animates to a
       new width while its contents are already at it — which is how a glyph
       ends up with its left column cut off for a third of a second. */
    const only = {
      ...waiting,
      working: [],
      tally: { working: 0, blocked: 2, done: 0, broken: 0, over: 0 },
    };
    const html = renderToStaticMarkup(
      <Collapsed state={only} mode={modeOf(only)} onGrab={() => {}} />,
    );
    expect(html).toContain('data-beat="blocked"');
    expect(html).toContain('data-beat="working"');
    expect(html).toContain('data-empty="true"');
    // And the one with something in it is not the one being hidden.
    expect(html).not.toMatch(/data-beat="blocked" data-empty/);
  });
});

describe("a pill docked into the notch", () => {
  it("leaves the cutout empty rather than drawing into it", () => {
    const html = renderToStaticMarkup(
      <Collapsed state={waiting} mode="demand" onGrab={() => {}} gap={200} />,
    );
    expect(html).toContain("--island-gap:200px");
  });

  /* The shape is symmetric about the notch or it is not aligned to it.
     The first cut hung the dot and the label off the left of the cutout and
     left the grab handle alone on the right, so one wing was a block and the
     other a sliver. Nothing was out of place and the whole thing still read
     as crooked, which was the bug. Both wings exist and the grid gives them
     equal tracks; what is asserted here is that there are two of them. */
  it("puts a wing on each side of it", () => {
    const html = renderToStaticMarkup(
      <Collapsed state={waiting} mode="demand" onGrab={() => {}} gap={200} />,
    );
    expect(html).toContain("island-left");
    expect(html).toContain("island-right");
    expect(html).toContain("island-wings");
  });

  it("reserves nothing at all when it is floating", () => {
    const html = renderToStaticMarkup(<Collapsed state={waiting} mode="demand" onGrab={() => {}} />);
    expect(html).not.toContain("--island-gap");
    expect(html).not.toContain("island-wings");
  });

  /* The nub is the state somebody is most likely to leave docked for days,
     and it is the smallest — so it is the one most easily swallowed whole. */
  it("splits the dormant nub around the cutout too", () => {
    const html = renderToStaticMarkup(
      <Collapsed state={islandState([])} mode="dormant" onGrab={() => {}} gap={200} />,
    );
    expect(html).toContain("--island-gap:200px");
    expect(html).toContain("island-left");
    expect(html).toContain("island-right");
  });

  /* The panel is wider than any notch, so it cannot be swallowed — but its
     first rows would still run under one. The cutout's height becomes a band
     of its own, parted around the camera, and the rows start below it. */
  it("gives the cutout's height to a band, and parts it around the camera", () => {
    // The strip the notch leaves is not padding any more: its wings are
    // ordinary screen and they carry the counts.
    const html = renderToStaticMarkup(
      <Panel
        state={waiting}
        mode={modeOf(waiting)}
        onOpen={() => {}}
        onGrab={() => {}}
        clear={38}
        gap={200}
      />,
    );
    expect(html).toContain("height:38px");
    expect(html).toContain("--island-gap:200px");
    expect(html).toContain("island-wings");
  });

  it("keeps the counts in the band, where the pill left them", () => {
    const html = renderToStaticMarkup(
      <Panel
        state={waiting}
        mode={modeOf(waiting)}
        onOpen={() => {}}
        onGrab={() => {}}
        clear={38}
        gap={200}
      />,
    );
    expect(html).toContain('data-beat="blocked"');
  });

  it("has no band to part when it is floating", () => {
    const html = renderToStaticMarkup(
      <Panel state={waiting} mode={modeOf(waiting)} onOpen={() => {}} onGrab={() => {}} />,
    );
    expect(html).not.toContain("island-wings");
    expect(html).toContain('data-beat="blocked"');
  });
});

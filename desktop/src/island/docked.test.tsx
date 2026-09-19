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
     first rows would still run under one. It starts below the cutout instead. */
  it("starts the expanded panel below the cutout", () => {
    const html = renderToStaticMarkup(
      <Panel state={waiting} mode={modeOf(waiting)} onOpen={() => {}} onGrab={() => {}} clear={38} />,
    );
    expect(html).toContain("padding-top:38px");
  });

  it("does not pad the panel when it is floating", () => {
    const html = renderToStaticMarkup(
      <Panel state={waiting} mode={modeOf(waiting)} onOpen={() => {}} onGrab={() => {}} />,
    );
    expect(html).not.toContain("padding-top");
  });
});

/**
 * Pressing *Turn it on* when the server says no.
 *
 * **This is the test that was missing, and the bug it would have caught was
 * shipped.** The server refuses an approval for a schedule whose agent team's
 * lead has changed — deliberately, so the dead end is found at the press
 * rather than at 9am — and both screens awaited the mutation bare. The
 * refusal went to an unhandled promise rejection: the press did nothing, the
 * page was byte-identical before and after, and the sentence was in the
 * devtools console. A server test passes right through that, because it
 * asserts the server.
 *
 * So what is asserted here is the two halves of *the sentence reaches the
 * person*: `flipSchedule` **answers** with it, and `Refused` **draws** it.
 * There is no renderer under this runner — `react-dom/server` and pure
 * functions — so a click cannot be fired and a `catch` inside a component
 * cannot be observed. Splitting the decision out of the event is what makes
 * it checkable at all, which is the same reason `matching`, `roomFor` and
 * `pauseSays` live outside the components that use them.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/** The three mutations, so a test can say what the server answered. */
const api = vi.hoisted(() => ({
  approve: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
}));
vi.mock("~/api/generated/schedules/schedules", () => ({
  approveSchedule: api.approve,
  pauseSchedule: api.pause,
  resumeSchedule: api.resume,
}));

import { flipSchedule, Refused, type Flippable } from "./turn";

/** The sentence the server sends for a team whose lead has changed. */
const LEAD_CHANGED =
  "The “Platform” agent team is not the one this was approved on, so turning it on would start something nobody has read. Open it and set what it runs as.";

const schedule = (over: Partial<Flippable> = {}): Flippable => ({
  id: "sch_01",
  active: false,
  approvedAt: null,
  revision: 3,
  ...over,
});

beforeEach(() => {
  api.approve.mockReset().mockResolvedValue({});
  api.pause.mockReset().mockResolvedValue({});
  api.resume.mockReset().mockResolvedValue({});
});

describe("which call a press makes", () => {
  it("pauses one that is on", async () => {
    expect(await flipSchedule(schedule({ active: true }))).toBeNull();
    expect(api.pause).toHaveBeenCalledWith("sch_01");
    expect(api.approve).not.toHaveBeenCalled();
  });

  it("resumes one that is approved and off", async () => {
    expect(await flipSchedule(schedule({ approvedAt: "2026-11-01T09:00:00Z" }))).toBeNull();
    expect(api.resume).toHaveBeenCalledWith("sch_01");
  });

  it("approves one whose approval is gone, at the revision it drew", async () => {
    // Which is what editing a schedule's agent team leaves behind: the
    // approval cleared and the revision moved, so a stale page is told to
    // read it again rather than approving what it never saw.
    expect(await flipSchedule(schedule())).toBeNull();
    expect(api.approve).toHaveBeenCalledWith("sch_01", { revision: 3 });
  });
});

describe("when the server refuses the press", () => {
  it("answers with the server's own sentence rather than throwing it away", async () => {
    api.approve.mockRejectedValue({ message: LEAD_CHANGED });
    expect(await flipSchedule(schedule())).toBe(LEAD_CHANGED);
  });

  it("answers for a refused pause and a refused resume too", async () => {
    // All three, not just the approval: a handler that catches one of its
    // three calls is one somebody will widen wrongly later.
    api.pause.mockRejectedValue({ message: "That schedule is gone." });
    expect(await flipSchedule(schedule({ active: true }))).toBe("That schedule is gone.");
    api.resume.mockRejectedValue({ message: "That schedule is gone." });
    expect(await flipSchedule(schedule({ approvedAt: "2026-11-01T09:00:00Z" }))).toBe(
      "That schedule is gone.",
    );
  });

  it("says something rather than nothing when the failure carries no sentence", async () => {
    // A network error has no `message` worth reading. An empty box would be
    // the silence this whole file exists to remove.
    api.approve.mockRejectedValue(new Error(""));
    const says = await flipSchedule(schedule());
    expect(says).toBeTruthy();
  });
});

describe("what the person sees", () => {
  it("draws the sentence, so the refusal is on the screen and not in a console", async () => {
    api.approve.mockRejectedValue({ message: LEAD_CHANGED });
    const says = await flipSchedule(schedule());
    const html = renderToStaticMarkup(<Refused says={says} />);
    expect(html).toContain("Open it and set what it runs as.");
    expect(html).toContain("agent team is not the one this was approved on");
    // Brick: an action was refused, as against amber for a schedule that
    // stopped itself. And announced, because a notice that appears without
    // focus moving is one a screen reader otherwise never reaches.
    expect(html).toContain('data-tone="brick"');
    expect(html).toContain('role="alert"');
  });

  it("draws nothing when nothing was refused", () => {
    // So a successful press leaves no empty box behind it.
    expect(renderToStaticMarkup(<Refused says={null} />)).toBe("");
  });
});

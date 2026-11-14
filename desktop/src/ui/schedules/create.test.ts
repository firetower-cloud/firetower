import { beforeEach, describe, expect, test, vi } from "vitest";

const calls: string[] = [];
const createSchedule = vi.fn();
const approveSchedule = vi.fn();

vi.mock("~/api/generated/schedules/schedules", () => ({
  createSchedule: (...a: unknown[]) => {
    calls.push("create");
    return createSchedule(...a);
  },
  approveSchedule: (...a: unknown[]) => {
    calls.push("approve");
    return approveSchedule(...a);
  },
}));

const { createAndTurnOn } = await import("./create");

const req = { name: "Dependency audit" } as never;
const off = { id: "sch_1", name: "Dependency audit", active: false, revision: 1 } as never;
const on = { id: "sch_1", name: "Dependency audit", active: true, revision: 1 } as never;

beforeEach(() => {
  calls.length = 0;
  createSchedule.mockReset().mockResolvedValue(off);
  approveSchedule.mockReset().mockResolvedValue(on);
});

/**
 * **Ruling 18, and the shape of it.**
 *
 * A schedule a person creates through the sheet lands on, because pressing
 * Create *is* the approval. What makes that safe is that it is the **route**
 * rather than the caller: creating writes an inactive schedule whoever asks,
 * and there is one explicit act that turns one on.
 */
describe("creating one from the sheet", () => {
  test("writes it, then turns it on, in that order", async () => {
    const made = await createAndTurnOn(req);

    expect(calls).toEqual(["create", "approve"]);
    /* **And it names the revision it just wrote.** Approving by id alone
       authorizes whatever the row says at that instant, which for a sheet
       that has described a particular thing is not the same promise. */
    expect(approveSchedule).toHaveBeenCalledWith("sch_1", { revision: 1 });
    expect(made.on).toBe(true);
    expect(made.schedule.active).toBe(true);
  });

  /* **Not a flag on the create call.** Activation is a second, explicit act
     against a path of its own; anything that only creates gets an inactive
     schedule, which is what keeps an agent's proposal inactive and what
     keeps the API inert when called by hand. */
  test("turning it on is a separate act, not an argument to creating it", async () => {
    await createAndTurnOn(req);

    const [body] = createSchedule.mock.calls[0] as [Record<string, unknown>];
    for (const asked of ["activate", "active", "approve", "approved", "on"]) {
      expect(body).not.toHaveProperty(asked);
    }
  });

  /* A refusal while writing it down — a cadence under the floor, a
     repository that is not theirs — is the caller's to report, and nothing
     has been turned on. */
  test("a refusal on the way in never reaches the activating call", async () => {
    createSchedule.mockRejectedValue(new Error("Runs cannot be closer together than 15 minutes."));

    await expect(createAndTurnOn(req)).rejects.toThrow(/15 minutes/);
    expect(calls).toEqual(["create"]);
    expect(approveSchedule).not.toHaveBeenCalled();
  });

  /** **Two statements are not atomic, and it fails toward off.** What exists
   *  then is a schedule one switch away, and the caller is told rather than
   *  left waiting for a run that is never coming. */
  test("a schedule that could not be turned on says so and still exists", async () => {
    approveSchedule.mockRejectedValue(new Error("that did not answer"));

    const made = await createAndTurnOn(req);

    expect(made.on).toBe(false);
    expect(made.schedule.id).toBe("sch_1");
    expect(made.on === false && made.why).toMatch(/did not answer/);
  });
});

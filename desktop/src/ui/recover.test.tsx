/**
 * What a conversation shows when the machine under it restarted.
 *
 * Two questions, and the first is the one that cost five hours: *is there a
 * way out of this screen at all*. A session whose agent is gone used to offer
 * nothing — the spinner simply never resolved — and a lead that had handed
 * back before its machine went offered nothing either, because `Chat` only
 * ever drew a way back for `Failed`.
 *
 * The second is the copy. The card stands in the composer's place, so every
 * word in it is in the most valuable space on the screen: one short line of
 * body, and buttons that are verbs.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { recoveryFor, Recover, Seam } from "./Chat";
import { getListHostsQueryKey } from "~/api/generated/hosts/hosts";
import type { Host, Session, SessionStatus } from "~/api/generated/model";

const run = (id: string, status: SessionStatus, over: Partial<Session> = {}): Session =>
  ({
    id,
    status,
    hostId: "h_1",
    agent: "ClaudeCode",
    createdAt: "2026-11-07T09:00:00Z",
    ...over,
  }) as Session;

const child = (id: string, status: SessionStatus) => run(id, status, { parentId: "s_lead" });

describe("whether a conversation offers a way back", () => {
  it("offers one to the session whose machine restarted", () => {
    const found = recoveryFor(run("s_1", "Stranded"), []);
    expect(found).toEqual({ itself: true, team: [], notYours: 0 });
  });

  it("counts the team that stopped with it", () => {
    const team = [child("s_a", "Stranded"), child("s_b", "Stranded"), child("s_c", "HandedBack")];
    expect(recoveryFor(run("s_lead", "Stranded"), team)?.team).toHaveLength(2);
  });

  /* A workspace can be shared while the agents in it are not, and a child runs
     on the subscription its own owner pinned to it. The server refuses those;
     counting them here is what stops the button promising to spend somebody
     else's credit before anybody presses it. */
  it("does not count a stopped child that is somebody else's to start", () => {
    const team = [
      child("s_a", "Stranded"),
      { ...child("s_b", "Stranded"), mayWrite: false } as Session,
    ];
    const found = recoveryFor(run("s_lead", "Stranded"), team);
    expect(found?.team).toHaveLength(1);
    expect(found?.notYours).toBe(1);
  });

  it("treats a control plane that says nothing about it as yours", () => {
    const team = [{ ...child("s_a", "Stranded"), mayWrite: undefined } as unknown as Session];
    expect(recoveryFor(run("s_lead", "Stranded"), team)?.team).toHaveLength(1);
  });

  /* The case that showed nothing at all. A lead resting while its team worked
     keeps an honest `HandedBack` when the machine goes — its own turn really
     did end — so nothing about its status says the family is broken, and it is
     waiting for a report that is never coming. */
  it("offers one to a lead that handed back and whose team is gone", () => {
    const found = recoveryFor(run("s_lead", "HandedBack"), [child("s_a", "Stranded")]);
    expect(found).toEqual({ itself: false, team: [child("s_a", "Stranded")], notYours: 0 });
  });

  it("offers nothing where nothing stopped", () => {
    expect(recoveryFor(run("s_1", "Working"), [])).toBeNull();
    expect(recoveryFor(run("s_1", "HandedBack"), [child("s_a", "HandedBack")])).toBeNull();
    expect(recoveryFor(run("s_1", "Failed"), [])).toBeNull();
    // A lead still working finds out the ordinary way: by being told what
    // became of the agents it started.
    expect(recoveryFor(run("s_1", "Working"), [child("s_a", "Stranded")])).toBeNull();
  });
});

/** Rendered against a seeded fleet, so the card can name the machine. */
function drawn(node: React.ReactElement) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(getListHostsQueryKey(), [
    // `useHosts` reads `compute.type`, so a half-made host is a crash rather
    // than a missing name.
    { id: "h_1", name: "mac-mini", compute: { type: "Server", host: "mac-mini" } } as Host,
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>{node}</QueryClientProvider>,
  );
}

/** Tags out, entities back, whitespace collapsed: what somebody reads. */
const words = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&rsquo;/g, "’")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("what the card says", () => {
  it("names the machine, promises exactly what comes back, and asks", () => {
    const said = words(drawn(<Recover session={run("s_1", "Stranded")} team={[]} itself />));
    expect(said).toContain("Stopped when mac-mini restarted");
    expect(said).toContain(
      "Comes back having read this conversation. Won’t finish the cut-off turn.",
    );
    // A verb, and the whole label.
    expect(said).toContain("Bring it back");
    // What it must never imply: the work is not picked up where it stopped.
    expect(said).not.toMatch(/resume|pick(s)? (it )?up|where it left off/i);
  });

  it("keeps the body to one line, and every button to a verb and an object", () => {
    const said = words(drawn(<Recover session={run("s_1", "Stranded")} team={[]} itself />));
    const body = said.slice(said.indexOf("Comes back"));
    expect(body.split(".").filter((s) => s.trim()).length).toBeLessThanOrEqual(3);
    expect(said).not.toContain("Everything above");
    expect(said.length).toBeLessThan(200);
  });

  it("offers the family first and the one agent beside it", () => {
    const team = [child("s_a", "Stranded"), child("s_b", "Stranded")];
    const said = words(drawn(<Recover session={run("s_lead", "Stranded")} team={team} itself />));
    expect(said).toContain("Bring back all 3");
    expect(said).toContain("This agent only");
    expect(said).toContain("2 of its team stopped too.");
  });

  it("says what a resting lead is actually waiting for", () => {
    const team = [child("s_a", "Stranded")];
    const said = words(
      drawn(<Recover session={run("s_lead", "HandedBack")} team={team} itself={false} />),
    );
    expect(said).toContain("Its team stopped when mac-mini restarted");
    expect(said).toContain("This agent is waiting for a report that isn’t coming.");
    // Two: the lead and the one child. Nothing about "this agent only" here —
    // the agent you are reading is not one of the stopped ones.
    expect(said).toContain("Bring back all 2");
    expect(said).not.toContain("This agent only");
  });

  it("says how many of the family are not yours, and only then", () => {
    const team = [child("s_a", "Stranded")];
    const mine = words(drawn(<Recover session={run("s_lead", "Stranded")} team={team} itself />));
    expect(mine).toContain("1 of its team stopped too.");
    expect(mine).not.toContain("yours to start");

    const shared = words(
      drawn(
        <Recover session={run("s_lead", "Stranded")} team={team} notYours={2} itself />,
      ),
    );
    expect(shared).toContain("3 of its team stopped too. 2 aren’t yours to start.");
    // And the button offers only what pressing it will actually do.
    expect(shared).toContain("Bring back all 2");
  });

  /* The card is in the composer's place on a screen that may have nothing
     above it at all — a workspace whose machine went before the agent said a
     word. Promising that it comes back having read a conversation that does
     not exist is the species of untruth this whole screen replaced. */
  it("promises only what is true of a conversation that never started", () => {
    const empty = words(
      drawn(<Recover session={run("s_1", "Stranded")} team={[]} itself spoke={false} />),
    );
    expect(empty).toContain("Comes back to this workspace.");
    expect(empty).not.toContain("having read this conversation");
    expect(empty).toContain("Bring it back");
  });

  it("marks where the transcript was cut off, in one line", () => {
    const said = words(renderToStaticMarkup(<Seam />));
    expect(said).toBe("cut off when the machine restarted");
  });
});

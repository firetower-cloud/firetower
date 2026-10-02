import { describe, expect, it } from "vitest";
import { destinations, isPersonal, mayMove, pathSlug, where } from "~/filing";

const me = { slug: "kevin", role: "member" };
const admin = { slug: "root", role: "admin" };

const dirs = [
  { slug: "design", level: "viewer" },
  { slug: "backend", level: "writer" },
  { slug: "ledger_work", level: "admin" },
  { slug: "nobodys", level: null },
];

describe("who may move something", () => {
  it("lets somebody move what is in their own space", () => {
    expect(mayMove("u/kevin/ledger_rounding", me, dirs)).toBe(true);
  });

  it("does not let them move what is in somebody else's", () => {
    expect(mayMove("u/ana/invoice_pdf", me, dirs)).toBe(false);
  });

  /**
   * The bug this file was written for. A `u/` prefix is not "mine" — it is
   * "somebody's" — and three screens read it as the former.
   */
  it("is not fooled by a personal path that belongs to somebody else", () => {
    expect(mayMove("u/ana/fire_01", me, [])).toBe(false);
  });

  it("wants admin on the directory, not writer", () => {
    expect(mayMove("d/ledger_work/rounding", me, dirs)).toBe(true);
    expect(mayMove("d/backend/rounding", me, dirs)).toBe(false);
    expect(mayMove("d/design/rounding", me, dirs)).toBe(false);
  });

  /**
   * The report: a viewer on a directory was offered "move this into your own
   * space", and the server refused it.
   */
  it("offers nothing to a viewer", () => {
    expect(mayMove("d/design/mockups", me, dirs)).toBe(false);
  });

  it("does not care what a directory they cannot see is called", () => {
    expect(mayMove("d/somewhere_else/thing", me, dirs)).toBe(false);
    expect(mayMove("d/nobodys/thing", me, dirs)).toBe(false);
  });

  it("lets an administrator of the organisation unstick any directory", () => {
    expect(mayMove("d/design/mockups", admin, [])).toBe(true);
  });

  /**
   * The hard rule: somebody's own root is theirs. An administrator can destroy
   * what is there when removing the account — it is going either way — but can
   * never hand it to a third party, which is the one outcome its owner never
   * agreed to.
   */
  it("does not let even an administrator move somebody's own things", () => {
    expect(mayMove("u/ana/invoice_pdf", admin, [])).toBe(false);
    expect(mayMove("u/ana/git/github", admin, [])).toBe(false);
  });

  it("still lets them move their own", () => {
    expect(mayMove("u/root/thing", admin, [])).toBe(true);
  });

  /** Attached: an agent account's credential, a repository's variables, the
   *  installation's own secrets. They move when their parent moves. */
  it("offers nothing for something with no path", () => {
    expect(mayMove(null, admin, dirs)).toBe(false);
    expect(mayMove(undefined, admin, dirs)).toBe(false);
    expect(mayMove("", admin, dirs)).toBe(false);
  });

  it("offers nothing when nobody is signed in", () => {
    expect(mayMove("u/kevin/thing", null, dirs)).toBe(false);
  });

  it("refuses a root it does not recognise", () => {
    expect(mayMove("t/backend/thing", me, dirs)).toBe(false);
  });
});

describe("where something may go", () => {
  it("is everywhere they can work, which is not the same question", () => {
    expect(destinations(dirs).map((d) => d.slug)).toEqual(["backend", "ledger_work"]);
  });
});

describe("what a chip says", () => {
  it("says yours for their own space and names anybody else's", () => {
    expect(where("u/kevin/thing", me)).toBe("yours");
    expect(where("u/ana/thing", me)).toBe("u/ana");
    expect(where("d/backend/thing", me)).toBe("d/backend");
    expect(where(null, me)).toBe("");
  });
});

describe("the label a name becomes", () => {
  /** These are the cases `ft_core::slug` is written for; if it changes, this
   *  fails, which is the point. */
  it("agrees with the server", () => {
    expect(pathSlug("Ledger work")).toBe("ledger_work");
    expect(pathSlug("Ledger  Work!")).toBe("ledger_work");
    expect(pathSlug("ledger-work")).toBe("ledger_work");
    expect(pathSlug("Q4 launch")).toBe("q4_launch");
    expect(pathSlug("kevin@westlabs.com")).toBe("kevin_westlabs_com");
    expect(pathSlug("  trimmed  ")).toBe("trimmed");
  });

  it("never gives back nothing", () => {
    expect(pathSlug("")).toBe("untitled");
    expect(pathSlug("!!!")).toBe("untitled");
  });
});

/**
 * What the rail splits on.
 *
 * Personal is your own space and nothing else. A directory you administer is
 * still a directory: being responsible for what is filed in `d/backend` does
 * not make a colleague's workspace there yours, and a heading that said so
 * would file their work under *Personal*.
 */
describe("isPersonal", () => {
  const me = { slug: "kevin", role: "admin" };

  it("is your own space", () => {
    expect(isPersonal("u/kevin/ledger_rounding", me)).toBe(true);
  });

  it("is not somebody else's, even for an administrator", () => {
    expect(isPersonal("u/ana/invoice_pdf", me)).toBe(false);
  });

  it("is not a directory, however much of it you run", () => {
    expect(isPersonal("d/shared/fire_01", me)).toBe(false);
    expect(isPersonal("d/kevin/anything", me)).toBe(false);
  });

  it("is false for nothing to go on", () => {
    expect(isPersonal(null, me)).toBe(false);
    expect(isPersonal("u/kevin/x", null)).toBe(false);
  });
});

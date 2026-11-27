/**
 * The People pane: what each role actually finds on it.
 *
 * **The defect this is written against is the one ⌘8 exists to avoid.** There
 * are two ways to list people and they are not interchangeable: the colleague
 * list is any signed-in user's and carries a name and an id, and the
 * organisation's user list is administrators-only and answers a member with a
 * 403. Build the pane on the second one and hide the buttons for everybody
 * else, and the eighth rail destination becomes a forbidden page for most of
 * the organisation — which the specification calls out as *"a defect, not an
 * access rule"*. `git-hosts.test.tsx` records the same mistake one size
 * smaller: a field drawn for everybody that the server would only take from an
 * administrator, discovered at Save.
 *
 * So these render the pane twice from two seeded caches — once as an
 * administrator and once as a member — and assert on what came out. The
 * **rules** themselves, including which request each role issues, are
 * `organisation.test.ts`'s; a static render runs no effects and so issues no
 * request at all, which makes "did it fetch" the one thing this file cannot
 * honestly answer.
 *
 * What it can answer, and does: **each role sees a populated list**, and only
 * an administrator sees a control.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { People } from "./People";
import { getMeQueryKey } from "~/api/generated/auth/auth";
import { getListUsersQueryKey } from "~/api/generated/organization/organization";
import { getListColleaguesQueryKey } from "~/api/generated/access/access";
import type { Colleague, Me, User } from "~/api/generated/model";

const KEVIN: User = {
  id: "u_kevin",
  username: "kevin",
  slug: "kevin",
  email: "kevin@northwind.example",
  role: "admin",
  orgId: "org_1",
  mustChangePassword: false,
  disabled: false,
};

const person = (p: Partial<User>): User => ({ ...KEVIN, role: "member", ...p });

/** The organisation as an administrator is told it, including both edge rows. */
const EVERYBODY: User[] = [
  KEVIN,
  person({ id: "u_ana", username: "ana.ruiz", slug: "ana_ruiz", email: "ana@northwind.example", role: "admin" }),
  person({ id: "u_tom", username: "tom.blake", slug: "tom_blake", email: "tom@northwind.example" }),
  /* An account made before an address was asked for, who has also never got
     here — two tags on one row. */
  person({ id: "u_sam", username: "sam.oduya", slug: "sam_oduya", email: null, mustChangePassword: true }),
  person({ id: "u_dan", username: "d.chen", slug: "d_chen", email: "dan@northwind.example", disabled: true }),
];

/** The same organisation as a member is told it: a name and an id. */
const COLLEAGUES: Colleague[] = EVERYBODY.map((u) => ({ id: u.id, username: u.username }));

const me = (user: User): Me => ({ user, organization: { id: "org_1", name: "Northwind" } });

/**
 * Render the pane for one signed-in person.
 *
 * **Both lists are seeded every time**, which is the point: whichever read the
 * pane makes, the other one's answer is sitting right there in the cache. A
 * member's pane drawing an administrator's facts would therefore show up here
 * rather than being hidden by the absence of the data.
 */
function draw(signedIn: User) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  cache.setQueryData(getMeQueryKey(), me(signedIn));
  cache.setQueryData(getListUsersQueryKey(), EVERYBODY);
  cache.setQueryData(getListColleaguesQueryKey(), COLLEAGUES);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <People />
    </QueryClientProvider>,
  );
}

const MEMBER = person({ id: "u_tom", username: "tom.blake", slug: "tom_blake", email: "tom@northwind.example" });

describe("what an administrator finds", () => {
  it("lists everybody, by name", () => {
    const html = draw(KEVIN);
    for (const u of EVERYBODY) expect(html).toContain(u.username);
  });

  /** The facts only an administrator is told, on the row. */
  it("says each address, which is the sub-line an administrator's row carries", () => {
    const html = draw(KEVIN);
    expect(html).toContain("ana@northwind.example");
    expect(html).toContain("dan@northwind.example");
  });

  it("marks your own row", () => {
    expect(draw(KEVIN)).toContain(">you<");
  });

  /** Role as a control rather than a badge — `.lvl`, the shape Directories
   *  already uses for its levels. */
  it("draws the role as the control it is", () => {
    const html = draw(KEVIN);
    expect(html).toContain("Administrator");
    expect(html).toContain("Member");
    expect(html).toContain('class="lvl"');
  });

  it("offers the way to add somebody", () => {
    expect(draw(KEVIN)).toContain("Add a person");
  });

  /**
   * The row's own menu, which a static render cannot open — so what is
   * asserted is that the row *has* one, named for the person it is about.
   * What is in it is `organisation.test.ts`'s `actionsFor`.
   */
  it("gives every row but your own a menu of its own", () => {
    const html = draw(KEVIN);
    expect(html).toContain("What to do with ana.ruiz");
    expect(html).toContain("What to do with d.chen");
    expect(html).not.toContain("What to do with kevin");
  });

  /**
   * **A tag only when there is something to say.** Most rows say nothing: an
   * account with an address, that has signed in and is switched on is the
   * ordinary case, and a row reading *Active* spends a tag on it — which is
   * what made the administration site's State column a column about nothing.
   */
  it("says the three states that are worth saying, and no fourth", () => {
    const html = draw(KEVIN);
    expect(html).toContain("No email yet");
    expect(html).toContain("Has not signed in");
    expect(html).toContain("Switched off");
    expect(html).not.toContain("Active");
  });

  /** And nothing in a tag is ember, which means one thing and is not this. */
  it("draws no ember anywhere", () => {
    expect(draw(KEVIN)).not.toMatch(/\bember\b/);
  });
});

/**
 * **The trap, from the member's side.**
 *
 * A member pressing ⌘8 must find a populated, useful, read-only surface. The
 * row is thinner — a face, a name, a handle, and *you* against themselves —
 * because the server will not tell a member a colleague's role, address or
 * switched-off state, and that is exactly the row that already shipped here.
 */
describe("what a member finds", () => {
  it("finds a populated list rather than an error or an empty state", () => {
    const html = draw(MEMBER);
    for (const c of COLLEAGUES) expect(html).toContain(c.username);
    expect(html).not.toContain("You cannot see this");
    expect(html).not.toContain("That did not load");
    expect(html).not.toContain("Nobody here yet");
  });

  it("marks their own row", () => {
    expect(draw(MEMBER)).toContain(">you<");
  });

  /** The handle, which is the rest of what the colleague list carries, and
   *  what the sharing sheet and a log line say. */
  it("says each handle", () => {
    expect(draw(MEMBER)).toContain("u/ana.ruiz");
  });

  it("is offered no way to add somebody", () => {
    expect(draw(MEMBER)).not.toContain("Add a person");
  });

  it("is offered no role control and no row menu", () => {
    const html = draw(MEMBER);
    expect(html).not.toContain('class="lvl"');
    expect(html).not.toContain("What to do with");
  });

  /**
   * **Nothing is greyed.** A greyed control is how an interface says you are
   * being withheld from; a control a member does not have is simply not drawn.
   */
  it("greys nothing, because it draws nothing it cannot use", () => {
    expect(draw(MEMBER)).not.toContain("disabled=");
  });

  /**
   * **And none of the administrator's facts leak.** Both lists are in the
   * cache, so a pane that read the wrong one would say so right here — this is
   * the assertion that catches People being built on the administrators-only
   * list with the buttons hidden.
   */
  it("shows none of the facts the server would not tell a member", () => {
    const html = draw(MEMBER);
    expect(html).not.toContain("@northwind.example");
    expect(html).not.toContain("Administrator");
    expect(html).not.toContain("Switched off");
    expect(html).not.toContain("No email yet");
  });

  /** The paragraph that used to say where to go instead, and the link beside
   *  it, are both gone — from here and from the whole client. */
  it("does not send anybody to the administration site", () => {
    const html = draw(MEMBER);
    expect(html).not.toContain("Manage on the web");
    expect(html).not.toContain("administration site");
  });
});

/**
 * A single-person installation.
 *
 * Both reads include the person asking, so the list always has at least you in
 * it and the blank is unreachable in practice. That is what makes a one-person
 * Firetower read as useful rather than as empty — and it is worth pinning,
 * because the obvious implementation of *everybody else* would have made this
 * screen the one that greets a new self-hoster with "Nobody here yet".
 */
describe("a Firetower with one person on it", () => {
  function alone(signedIn: User, colleaguesOnly = false) {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnMount: false } },
    });
    cache.setQueryData(getMeQueryKey(), me(signedIn));
    cache.setQueryData(getListUsersQueryKey(), colleaguesOnly ? [] : [signedIn]);
    cache.setQueryData(getListColleaguesQueryKey(), [
      { id: signedIn.id, username: signedIn.username },
    ]);
    return renderToStaticMarkup(
      <QueryClientProvider client={cache}>
        <People />
      </QueryClientProvider>,
    );
  }

  it("reads as a list with you in it, not as an empty one", () => {
    const html = alone(KEVIN);
    expect(html).toContain("kevin");
    expect(html).toContain(">you<");
    expect(html).not.toContain("Nobody here yet");
  });

  it("still offers the way to add the second person", () => {
    expect(alone(KEVIN)).toContain("Add a person");
  });
});

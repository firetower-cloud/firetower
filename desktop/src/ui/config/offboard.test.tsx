/**
 * What the offboarding confirmation says before anything happens.
 *
 * It is reached from the person's row and its whole job is that nobody finds
 * out afterwards — so what it *says* is the thing worth pinning, and in
 * particular that it says it in words rather than in arithmetic. The payload it
 * sends is `offboardingFor`, tested directly in `organisation.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Offboard } from "./Offboard";
import { getUserReachQueryKey } from "~/api/generated/organization/organization";
import type { Reach, User } from "~/api/generated/model";

const LISA: User = {
  id: "u_lisa",
  username: "lisa",
  slug: "lisa",
  email: "lisa@acme.co",
  role: "member",
  orgId: "o_1",
  mustChangePassword: false,
  disabled: false,
};

const NOTHING: Reach = {
  owns: [],
  administers: [],
  created: [],
  directories: [],
  teams: [],
  exceptions: [],
};

function draw(reach: Reach) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  cache.setQueryData(getUserReachQueryKey(LISA.id), reach);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <Offboard person={LISA} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe("somebody who holds nothing", () => {
  /**
   * **Zero is a sentence, not a count.** It read *"0 things are destroyed"*
   * above *"Nothing of theirs"*, so the heading was an arithmetic result over
   * two lines that already said the thing in words — and this sheet's own
   * sub-head had the zero right all along, which is what made the disagreement
   * visible.
   */
  it("says nothing is destroyed, rather than counting to zero", () => {
    const html = draw(NOTHING);
    expect(html).toContain("Nothing of theirs is destroyed");
    expect(html).not.toContain("0 things are destroyed");
  });

  /** And the sections with nothing in them are not drawn as empty headings. */
  it("draws no handover and no revocation when there is neither", () => {
    const html = draw(NOTHING);
    expect(html).not.toContain("Only they administer");
    expect(html).not.toContain("Revoked");
  });
});

describe("somebody who holds something", () => {
  const theirs: Reach = {
    ...NOTHING,
    owns: [
      {
        kind: "workspace",
        id: "w_1",
        name: "Ledger exports",
        path: "u/lisa/ledger_exports",
        detail: "acme/api",
        ownerName: "lisa",
      },
    ],
    administers: [{ directoryId: "d_1", name: "Platform", slug: "platform", alone: true }],
  };

  it("counts one thing as one thing", () => {
    expect(draw(theirs)).toContain("1 thing is destroyed");
  });

  /** The path, because it is the reason: this is destroyed rather than handed
   *  on because of where it is filed. */
  it("says where it is filed, which is why it cannot be handed on", () => {
    expect(draw(theirs)).toContain("u/lisa/ledger_exports");
  });

  /** The one decision that is genuinely the organisation's. */
  it("asks who takes over a directory nobody else administers", () => {
    const html = draw(theirs);
    expect(html).toContain("Only they administer");
    expect(html).toContain("Make someone an administrator");
  });

  it("does not ask when somebody else administers it too", () => {
    const html = draw({
      ...theirs,
      administers: [{ directoryId: "d_1", name: "Platform", slug: "platform", alone: false }],
    });
    expect(html).not.toContain("Only they administer");
  });
});

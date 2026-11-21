/**
 * The Profiles screen offers the import, in both of its states.
 *
 * **The defect this exists to stop coming back is the one that held the whole
 * feature up**: the review screen was built, tested and photographed, and
 * nothing in the product mounted it. Everything else about profiles as code
 * shipped — the format, the exporter, the plan endpoint, the review — and a
 * person still could not import anything, because no screen said a folder
 * worked here.
 *
 * So this asserts that the page offers it, in both of its states: empty,
 * which is a different block of markup and the one somebody meets first, and
 * with a library, where the way in is now a **control** rather than a
 * sentence under the list. That sentence narrated two things the page's own
 * controls already said, and it went with them — but it also carried the one
 * thing a drop target cannot say for itself, so the gesture moved onto the
 * import item in the primary action, which is what is pinned here instead.
 *
 * **What this cannot see.** That item lives in a popover that opens on a
 * press, so it is not in the markup at all and is read off the source — and
 * the drag handlers firing, the review replacing the pane and an accept
 * reaching the server all need a browser. Those are the end-to-end evidence
 * on the pull request. What is here is the half that fails on a laptop in a
 * second.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Roles } from "./Roles";
import { getListRolesQueryKey, getRoleImportLimitsQueryKey } from "~/api/generated/roles/roles";
import type { PlanLimits, Role } from "~/api/generated/model";

const LIMITS: PlanLimits = { files: 200, fileBytes: 262144, totalBytes: 8388608, depth: 8 };

const profile = (name: string): Role => ({
  id: `role_${name.toLowerCase()}`,
  path: `u/kevin/${name.toLowerCase()}`,
  name,
  key: null,
  does: "does the thing",
  placement: "lead",
  agent: null,
  machine: null,
  account: null,
  settings: {},
  instructions: "",
  onUsageLimit: "wait",
  onChildLimit: "ask",
  canDelegate: false,
  delegateScope: [],
  includeAlwaysOn: true,
  includeRepoDefaults: true,
  skillScope: [],
  mayWrite: true,
  mayShare: true,
  isDefault: false,
  createdAt: "2026-11-18T00:00:00Z",
  updatedAt: "2026-11-18T00:00:00Z",
});

function draw(roles: Role[]): string {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(getListRolesQueryKey(), roles);
  cache.setQueryData(getRoleImportLimitsQueryKey(), LIMITS);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <Roles />
    </QueryClientProvider>,
  );
}

/** The markup with its tags taken out, which is what somebody reads. */
const readable = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const SOURCE = readFileSync(fileURLToPath(new URL("./Roles.tsx", import.meta.url)), "utf8");

describe("the Profiles screen offers a folder of profiles", () => {
  /**
   * A control, in the menu somebody opens to make a profile — and the drop
   * gesture named on it, because the pane is the drop target and a drop
   * target shows nothing until something is already over it.
   */
  it("offers it as an item in the page's one primary action", () => {
    expect(SOURCE).toContain('label: "Import a folder"');
    expect(SOURCE).toContain("Or drop a folder on this page.");
  });

  it("says so on the empty state, which is where somebody starts", () => {
    const said = readable(draw([]));
    expect(said).toContain("No profiles yet");
    expect(said).toContain("drop in a folder of profiles you already have");
  });

  /* And the sentence it replaced does not come back. Two of its three
     clauses narrated what the controls already say, which is the thing this
     feature keeps having to be told. */
  it("does not narrate it under the list", () => {
    const said = readable(draw([profile("Designer")]));
    expect(said).not.toContain("A profile is filed like a skill or a machine");
    expect(said).not.toContain("Drop a folder of PROFILE.md files anywhere on this page");
  });
});

/**
 * And the other page with a folder-drop import, which had the same sentence
 * and the same hole under it.
 *
 * Here rather than in a file of its own because it is one fact about two
 * pages: both panes are drop targets, both draw `CreateMenu`, and the
 * failure this whole file exists to stop — *no screen said a folder worked
 * here* — is the same failure on either. A second file would be the same
 * assertion kept somewhere it could drift from this one.
 */
describe("the Skills screen offers a folder of skills the same way", () => {
  const SKILLS = readFileSync(fileURLToPath(new URL("./Skills.tsx", import.meta.url)), "utf8");

  it("offers it as an item in the page's one primary action", () => {
    expect(SKILLS).toContain('label: "Upload a folder"');
    expect(SKILLS).toContain("Or drop a folder on this page.");
  });

  it("does not narrate it at the foot of the list", () => {
    expect(SKILLS).not.toContain("Or drop a folder anywhere on this page.");
  });
});

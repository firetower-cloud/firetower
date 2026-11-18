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
 * So this asserts the standing sentence that says the page is a drop surface,
 * in both of its states: with a library, and empty, which is a different block
 * of markup and the one somebody meets first.
 *
 * **What this cannot see.** The third route in the primary action is inside a
 * popover that opens on a press, so it is not in this markup at all — and the
 * drag handlers firing, the review replacing the pane and an accept reaching
 * the server all need a browser. Those are the end-to-end evidence on the pull
 * request. What is here is the half that fails on a laptop in a second.
 */
import { describe, expect, it } from "vitest";
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

describe("the Profiles screen says a folder of profiles works here", () => {
  it("says so beside a library that already has profiles in it", () => {
    const said = readable(draw([profile("Designer")]));
    expect(said).toContain("Drop a folder of PROFILE.md files anywhere on this page");
  });

  it("says so on the empty state, which is where somebody starts", () => {
    const said = readable(draw([]));
    expect(said).toContain("No profiles yet");
    expect(said).toContain("drop in a folder of profiles you already have");
  });
});

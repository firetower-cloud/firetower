import { describe, expect, it } from "vitest";
import { machineGone } from "~/data";
import type { Host } from "~/api/generated/model";

const fleet = (hosts: Host[], over: { loading?: boolean; error?: string | null } = {}) => ({
  data: hosts,
  loading: false,
  error: null,
  ...over,
});

const host = (id: string): Host => ({
  id,
  name: id,
  compute: { type: "Server", host: id, key: { type: "Managed" } },
  state: "Online",
  path: `u/admin/${id}`,
  drained: false,
  reconnecting: false,
  docker: { status: "Unknown" },
});

/**
 * The state three surfaces used to arrive at by accident: the status bar drew
 * no machine segment, the rail dropped its glyph, and the composer stayed live
 * because the session is not `Ended`. One predicate, asked deliberately.
 */
describe("a session whose machine is no longer in the fleet", () => {
  it("is the one case where the host is missing from a list that loaded", () => {
    expect(machineGone("h_gone", fleet([host("build-box")]))).toBe(true);
    expect(machineGone("build-box", fleet([host("build-box")]))).toBe(false);
  });

  it("is not what a list that has not arrived means", () => {
    // Otherwise every workspace announces that its machine was removed for a
    // moment after each restart, which is both wrong and alarming.
    expect(machineGone("h_gone", fleet([], { loading: true }))).toBe(false);
    expect(machineGone("h_gone", fleet([], { error: "the server did not answer" }))).toBe(false);
  });

  it("says nothing about a session with no machine recorded at all", () => {
    expect(machineGone(undefined, fleet([host("build-box")]))).toBe(false);
    expect(machineGone("", fleet([host("build-box")]))).toBe(false);
  });
});

/**
 * What the Machines screen says about a machine that is gone.
 *
 * **The line under the card is gone, by request.** It read *"N sessions ran on
 * Firetower's own machine before it was removed. They can be read; they cannot
 * be picked up again. Show them"*, it rendered for as long as those sessions
 * existed — which is for good, since the count only goes to zero if the record
 * is deleted — and it is the footer this change removes.
 *
 * **It took the only unconditional route to the session list with it**, and
 * that is worth stating rather than discovering. The notice above the card is
 * gated on `chores > 0 && !hidden`: it goes by itself once the repositories
 * and profiles pointing at the machine are dealt with, and it can be dismissed
 * before then. The line was deliberately outside both gates. So with the line
 * removed, a deployment with no chores left — or one where somebody pressed
 * *Dismiss* — draws nothing at all for a removed machine, and the sessions
 * that ran on it are no longer reachable from this screen. That is the
 * consequence of the request, not a defect in carrying it out; the first test
 * below pins it so nobody has to re-derive it.
 *
 * The `"notice" | "foot" | null` state went with the line. Two controls for
 * one list needed to hold *where* it was open so it drew under whichever was
 * pressed; one control needs open or shut, so `listing` is a boolean and the
 * exported `Listing` type and `toggled` helper — which existed only to move
 * the list between the two — are gone with it.
 *
 * `renderToStaticMarkup` with a seeded cache: no jsdom, no network. That is
 * also the limit of this file — there is no click, so what is asserted is
 * which controls and copy are drawn, not what pressing one does.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getListHostsQueryKey, getRetiredHostsQueryKey } from "~/api/generated/hosts/hosts";
import { getListSessionsQueryKey } from "~/api/generated/sessions/sessions";
import { getListReposQueryKey } from "~/api/generated/repos/repos";
import { getListRolesQueryKey } from "~/api/generated/roles/roles";
import { ConfirmProvider } from "~/ui/Confirm";
import { Machines } from "./Machines";

/**
 * `WasHere` reads a per-machine dismissal on mount, and there is no jsdom.
 * At module scope rather than in a hook: a `describe` body below renders at
 * collection time, which is before any `beforeAll` would have run.
 */
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

/** A session that ran on the machine that is now gone. */
const session = {
  id: "s1",
  workspaceId: "w1",
  hostId: "h1",
  title: "Rebuild the index",
  branch: "agent/index",
  status: "running",
};

/** A repository Firetower can no longer clone: a path, on a machine that left. */
const pathRepo = { id: "r1", name: "monorepo", remote: "/srv/git/monorepo" };

/**
 * `chores` is what holds the notice open — path repositories plus profiles
 * pinned to the machine. With none, the notice does not draw, which is the
 * state the removed line was the whole of what was still on screen.
 */
function draw({ chores }: { chores: boolean }): string {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  cache.setQueryData(getListHostsQueryKey(), []);
  cache.setQueryData(getRetiredHostsQueryKey(), [{ id: "h1", name: "localhost" }]);
  cache.setQueryData(getListSessionsQueryKey(), [session]);
  cache.setQueryData(getListReposQueryKey(), chores ? [pathRepo] : []);
  cache.setQueryData(getListRolesQueryKey(), []);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <ConfirmProvider>
        <Machines live={true} />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

/** The sentence that was removed, in the two halves it was reported by. */
const FOOTER = "before it was";
const FOOTER_TAIL = "They can be read; they cannot be picked up again.";

describe("the line under a removed machine's card", () => {
  /**
   * **The assertion the revert fails.** Putting the footer back makes this
   * render contain it again — there is nothing else on screen in this state,
   * so the string is the whole of the difference.
   */
  it("is not drawn when the chores are done", () => {
    const html = draw({ chores: false });
    expect(html).not.toContain(FOOTER);
    expect(html).not.toContain(FOOTER_TAIL);
    expect(html).not.toContain("Show them");
    expect(html).not.toContain("Hide them");
  });

  it("is not drawn beneath the notice either", () => {
    const html = draw({ chores: true });
    expect(html).not.toContain(FOOTER);
    expect(html).not.toContain(FOOTER_TAIL);
    expect(html).not.toContain("Show them");
  });

  /**
   * And nothing was left standing in its place. With the chores done and no
   * notice, the screen has nothing to say about this machine at all — so the
   * session's own title, which the list would carry, is absent too.
   */
  it("leaves nothing behind for a machine with no chores left", () => {
    const html = draw({ chores: false });
    expect(html).not.toContain("Firetower's own machine");
    expect(html).not.toContain(session.title);
  });
});

describe("the notice above it, which is untouched", () => {
  const html = draw({ chores: true });

  it("still explains why the machine went", () => {
    expect(html).toContain("Firetower no longer runs agents on itself");
    expect(html).toContain("still points at it");
  });

  /** The one surviving route to the list, and the only one now. */
  it("still offers the sessions that ran there", () => {
    expect(html).toContain("The work that was running there");
    expect(html).toContain("Show what was running");
  });
});

/**
 * The state the second control needed, asserted at the source: a boolean and a
 * `"notice" | "foot" | null` union render identically while only one control
 * is drawn, so there is no markup that tells them apart. What there is to
 * protect is that the unreachable branch did not survive the line that reached
 * it — an `=== "foot"` left behind is a list nothing can open.
 */
describe("the state that held which copy was open", () => {
  const src = readFileSync(new URL("./Machines.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("keeps no branch on a control that is gone", () => {
    expect(src).not.toContain('"foot"');
  });

  it("drops the helper and the type that only moved the list between two", () => {
    expect(src).not.toMatch(/\btoggled\b/);
    expect(src).not.toMatch(/\btype Listing\b/);
  });

  /** One control, one flag, and the list drawn under it exactly once. */
  it("opens the list from the one control that remains", () => {
    expect(src).toContain("setShowRan((v) => !v)");
    expect(src.match(/<Ran sessions=\{ran\} \/>/g)).toHaveLength(1);
  });
});

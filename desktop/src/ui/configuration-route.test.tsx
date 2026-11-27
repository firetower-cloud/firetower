/**
 * `/configuration/server` draws one of four things, and *pending* is not one
 * of the refusals.
 *
 * The deployment pane is listed for a self-hosted administrator and nobody
 * else, and the pane decides whether to fall back to People. That decision
 * used to be one expression — `!mayOperateDeployment(mode, me.data?.user)` —
 * which answers **false for a role that has not arrived**, so People mounted
 * over the address somebody had typed, fetched its list and painted its
 * skeleton before being replaced a beat later. And for a `/auth/me` that
 * *failed* it answered false for good: an administrator opening their own
 * bookmark landed on People with nothing saying the pane they asked for
 * exists.
 *
 * `renderToStaticMarkup` with a seeded cache. `window` is stubbed to the one
 * field the navigation shim reads, because a hash router with no location
 * answers `/` and every state would be the same state.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getMeQueryKey } from "~/api/generated/auth/auth";
import { Configuration } from "~/ui/Configuration";

const had = Object.getOwnPropertyDescriptor(globalThis, "window");

beforeAll(() => {
  /* The shim reads `window.location.hash` and nothing else during a render —
     its listeners go on in an effect, which a static render never runs. */
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { hash: "#/configuration/server" } },
  });
});
afterAll(() => {
  if (had) Object.defineProperty(globalThis, "window", had);
  else delete (globalThis as { window?: unknown }).window;
});

/** What `/auth/me` answered, or how it failed to. */
function draw(me?: { role: string } | { failed: true } | { noRole: true }): string {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
  });
  if (me && "role" in me) {
    cache.setQueryData(getMeQueryKey(), { user: { id: "u_1", username: "kevin", role: me.role } });
  } else if (me && "noRole" in me) {
    /* A 200 with a body this client cannot get a role out of. */
    cache.setQueryData(getMeQueryKey(), { user: { id: "u_1", username: "kevin" } });
  } else if (me && "failed" in me) {
    const entry = cache.getQueryCache().build(cache, { queryKey: getMeQueryKey() } as never);
    entry.setState({
      status: "error",
      error: Object.assign(new Error("Something went wrong."), { status: 500 }),
      fetchStatus: "idle",
      errorUpdatedAt: Date.now(),
      errorUpdateCount: 1,
    } as never);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <Configuration />
    </QueryClientProvider>,
  );
}

/** People is unmistakable: it is the only one of the four with this heading. */
const isPeople = (html: string) => html.includes("<h1>People</h1>");

describe("opening the deployment pane's address", () => {
  /**
   * **Pending is not refusal.** Neither candidate is drawn, because neither
   * is known to be right — the shape both share is, and it carries no title,
   * since naming a pane is already an answer about whose it is.
   */
  it("draws neither pane while the role is still being read", () => {
    const html = draw();
    expect(isPeople(html)).toBe(false);
    expect(html).toContain("settling");
    expect(html).not.toContain("Telemetry");
    expect(html).not.toContain("That did not load");
  });

  /**
   * **A read that failed is not a member.** The question is answerable and
   * nobody has answered it, so it says so and offers the read again rather
   * than quietly landing an administrator somewhere else.
   */
  it("says the role could not be read, and offers it again, when the read failed", () => {
    const html = draw({ failed: true });
    expect(isPeople(html)).toBe(false);
    expect(html).toContain("That did not load");
    expect(html).toContain("Try again");
  });

  /** And the 200-with-no-role variant reaches the same screen. */
  it("says the same when the server answered with no role in it", () => {
    const html = draw({ noRole: true });
    expect(isPeople(html)).toBe(false);
    expect(html).toContain("That did not load");
    expect(html).toContain("Try again");
  });

  /**
   * **Only a role that arrived and says no falls back.** A moved pane must
   * not become a forbidden one, so a member gets the pane the destination
   * opens on rather than *you cannot see this*.
   */
  it("falls back to People for a member, once that is what the role says", () => {
    expect(isPeople(draw({ role: "member" }))).toBe(true);
  });

  /** An administrator gets the pane they asked for. */
  it("draws the deployment pane for a self-hosted administrator", () => {
    const html = draw({ role: "admin" });
    expect(isPeople(html)).toBe(false);
    expect(html).toContain("This Firetower");
  });
});

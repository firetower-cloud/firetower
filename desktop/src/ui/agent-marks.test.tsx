/**
 * The workbench header's strip of agent marks: which runs are in it.
 *
 * One mark per run in the workspace ran out of room the first time an agent
 * spawned a child per file — a dozen of them pushed past the space the strip
 * has and lay over the people and terminal controls to their right. A spawned
 * child is not a session anybody chose to open and the strip is a switch
 * between the ones they did, so the row is the runs with no `parentId` and the
 * `> 1` test is asked of *that* list: a workspace whose only other runs are
 * children draws nothing here rather than a row of one.
 *
 * **The run being read is the case worth a file of its own.** A child opened
 * by its own address is the run on screen, and the bare filter would drop the
 * one mark that says which session you are in — so it is kept whatever its
 * parentage, lit, beside the session that started it.
 *
 * Both halves: the rule asked directly, and the header drawn, because a rule
 * nothing is asserted to consult is a rule that governs nothing. The render is
 * `renderToStaticMarkup` with a seeded cache and the two subscriptions a
 * workspace cannot do without stood in for, the way
 * `installed-only.test.tsx` established.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getMeQueryKey } from "~/api/generated/auth/auth";
import { getGetSessionQueryKey, getListSessionsQueryKey } from "~/api/generated/sessions/sessions";
import { getListHostsQueryKey } from "~/api/generated/hosts/hosts";
import { getListRunsQueryKey } from "~/api/generated/updates/updates";
import type { Backend, Fleet } from "~/fleet";
import type { Session } from "~/api/generated/model";
import { strippedRuns } from "~/ui/Workbench";

vi.mock("~/bridge", () => ({
  bridge: {
    native: false,
    setTitle: () => {},
    setBadge: () => {},
    notify: () => {},
    minimize: () => {},
    zoom: () => {},
    close: () => {},
    save: async () => null,
    shoot: async () => null,
    canShoot: async () => false,
    loadArtifact: null,
    secrets: null,
  },
}));

const HERE: Backend = {
  id: "s_acme",
  org: "Acme",
  user: "kevin",
  mark: "Ac",
  url: "https://acme.example",
  reach: "live",
};
vi.mock("~/fleet", async (orig) => ({
  ...(await orig<typeof import("~/fleet")>()),
  useFleet: () => [{ backend: HERE, sessions: [], error: null } satisfies Fleet],
}));

/* The two things a workspace needs that are not data: `useSocket` throws
   outside its provider, and `useConversation` is the one store in the app
   with no server snapshot. */
vi.mock("~/api/socket", async (orig) => ({
  ...(await orig<typeof import("~/api/socket")>()),
  useSocket: () => ({ follow: () => () => {}, live: true }),
}));
vi.mock("~/api/conversation", async (orig) => {
  const real = await orig<typeof import("~/api/conversation")>();
  return {
    ...real,
    useConversation: () => ({
      conversation: real.nothing,
      echo: () => {},
      settle: () => {},
      remember: () => {},
      stopping: false,
      older: { more: false, loading: false, load: () => {} },
    }),
  };
});

/* ── The rule, asked directly ─────────────────────────────────────────── */

/** Just the shape `strippedRuns` reads, so the cases read as what they are. */
const run = (id: string, parentId?: string) => ({ id, parentId: parentId ?? null });

describe("which runs the strip is for", () => {
  it("keeps the sessions a person started", () => {
    const runs = [run("s_1"), run("s_2")];
    expect(strippedRuns(runs, "s_1").map((r) => r.id)).toEqual(["s_1", "s_2"]);
  });

  /* The defect, in the shape it was reported in: one workspace, one session
     somebody opened, twelve the agent spawned under it. */
  it("drops every run an agent spawned", () => {
    const runs = [run("s_1"), ...Array.from({ length: 12 }, (_, i) => run(`k_${i}`, "s_1"))];
    expect(strippedRuns(runs, "s_1").map((r) => r.id)).toEqual(["s_1"]);
  });

  /**
   * **And the strip is not drawn for one**, which is the half a filter alone
   * does not give you: the guard above it has to read the filtered list, or
   * the twelve become a row of one — a control that changes nothing, which
   * is exactly what the `> 1` test exists to prevent.
   */
  it("leaves one run behind, which is fewer than the strip is drawn for", () => {
    const runs = [run("s_1"), run("k_1", "s_1"), run("k_2", "s_1")];
    expect(strippedRuns(runs, "s_1").length).toBeLessThan(2);
  });

  /**
   * **The run being read stays, whatever started it.**
   *
   * Opening a child by its own address — from the Overview's team, from a
   * link, from the dashboard — makes it the conversation on screen. Dropping
   * it would leave the row that answers *which of these am I in* without the
   * one you are in, which is the state this must not reach.
   */
  it("keeps the run being read even when an agent spawned it", () => {
    const runs = [run("s_1"), run("k_1", "s_1"), run("k_2", "s_1")];
    expect(strippedRuns(runs, "k_1").map((r) => r.id)).toEqual(["s_1", "k_1"]);
  });

  /* Only that one, though. Reading a child does not bring its siblings back. */
  it("brings back the one being read and not its siblings", () => {
    const runs = [run("s_1"), run("k_1", "s_1"), run("k_2", "s_1"), run("k_3", "s_1")];
    expect(strippedRuns(runs, "k_2").map((r) => r.id)).toEqual(["s_1", "k_2"]);
  });

  /* And it keeps the workspace's own order, so a mark does not move under the
     pointer when the run being read changes. */
  it("keeps the order the workspace has them in", () => {
    const runs = [run("k_1", "s_1"), run("s_1"), run("k_2", "s_1")];
    expect(strippedRuns(runs, "k_2").map((r) => r.id)).toEqual(["s_1", "k_2"]);
  });
});

/* ── The header, drawn ────────────────────────────────────────────────── */

const WORK = {
  id: "s_1",
  workspaceId: "w_1",
  agent: "ClaudeCode",
  hostId: "h_1",
  title: "Move the session tokens",
  name: "auth refactor",
  branch: "agent/auth-refactor",
  status: "Working",
  createdAt: "2026-11-01T00:00:00Z",
  mayWrite: true,
  path: "u/kevin",
  number: 1,
  owner: "u_1",
  prompt: "",
  size: "Medium",
  updatedAt: "2026-11-01T00:00:00Z",
} as unknown as Session;

/** A session the agent spawned, in the same workspace. */
const child = (id: string, over: Partial<Session> = {}): Session =>
  ({ ...WORK, id, parentId: "s_1", name: id, title: `Child ${id}`, ...over }) as Session;

function stubWindow() {
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("window", {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { hash: "#/sessions/w_1", search: "", origin: "https://acme.example", protocol: "https:" },
    history: { pushState: () => {}, replaceState: () => {}, back: () => {}, forward: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => 0,
    innerWidth: 1440,
  });
}

/**
 * Draw a workspace and hand back the titles of the marks in its header.
 *
 * The marks are the only buttons titled `agent — title`, which is the string
 * the strip itself builds, so this reads them the way somebody hovering one
 * would rather than by a class that could change under it.
 */
async function marksIn(sessions: Session[], at: string): Promise<string[]> {
  vi.resetModules();
  stubWindow();
  const { Workbench } = await import("~/ui/Workbench");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  cache.setQueryData(getMeQueryKey(), { user: { username: "kevin", slug: "kevin", role: "admin" }, organization: { name: "Acme" } });
  cache.setQueryData(getListSessionsQueryKey(undefined), sessions);
  cache.setQueryData(getListRunsQueryKey(), []);
  for (const s of sessions) cache.setQueryData(getGetSessionQueryKey(s.id), s);
  cache.setQueryData(getListHostsQueryKey(), [{ hostId: "h_1", name: "studio", state: "Online", compute: { type: "Server" } }]);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <Workbench backend={HERE} workspace={at} />
    </QueryClientProvider>,
  );
  return [...html.matchAll(/title="([^"]*? — [^"]*?)"/g)]
    .map((m) => m[1])
    /* The header carries other titles with a dash in them — *End workspace*
       and the spawn reason among them. The marks are the ones naming an
       agent, which is what the strip's own template puts first. */
    .filter((t) => /^(Claude Code|Codex|CursorAgent|KimiCode|Shell) — /.test(t));
}

describe("the strip in the header", () => {
  /**
   * **The defect, drawn.** One session somebody opened and twelve the agent
   * spawned under it: before, thirteen marks over the controls at the right.
   */
  it("draws nothing for a workspace whose other runs are all spawned", async () => {
    const spawned = Array.from({ length: 12 }, (_, i) => child(`k_${i}`));
    expect(await marksIn([WORK, ...spawned], "w_1")).toEqual([]);
  });

  /* Two sessions somebody started is what the strip was always for, and it is
     untouched. */
  it("still draws a mark each for two sessions a person started", async () => {
    const second = { ...WORK, id: "s_2", agent: "Codex", title: "The migration", parentId: null } as Session;
    const marks = await marksIn([WORK, second], "w_1");
    expect(marks).toEqual(["Claude Code — Move the session tokens", "Codex — The migration"]);
  });

  /**
   * **Reading a child, it is on the strip beside the session that started
   * it** — the lit mark, and the way back. Without this the header would say
   * which agent is talking and offer no route to the one that spawned it.
   */
  it("draws the child being read beside its lead, and no other child", async () => {
    const marks = await marksIn(
      [WORK, child("k_1", { agent: "Codex", title: "The migration" }), child("k_2", { agent: "CursorAgent", title: "Token audit" })],
      "k_1",
    );
    expect(marks).toEqual(["Claude Code — Move the session tokens", "Codex — The migration"]);
  });

  /* And a workspace with one run has no strip, which it never did. */
  it("draws nothing for a workspace with one run", async () => {
    expect(await marksIn([WORK], "w_1")).toEqual([]);
  });
});

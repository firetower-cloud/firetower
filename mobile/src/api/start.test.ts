/**
 * The five answers the composer gives instead of asking.
 *
 * The home's start flow is a component and there is no renderer here, so what
 * is pinned is the fold underneath it: the name, the branch, the profile
 * order, what a search for a profile means, and whether the agent is a control
 * or a statement. Those are the parts that can be silently wrong — a branch
 * cut mid-word, a profile list that files Managers last, a pinned engine the
 * picker lets you change anyway.
 *
 * `branchFor` and `fewWords` are the desk's, retyped (there is no shared
 * module), so their cases are the desk's too: the two clients have to agree
 * about what a title is called, or one release cuts two branches for one
 * sentence.
 */
import { describe, expect, it } from "vitest";
import type { Account, AgentView, Host, Repo, Role } from "~/api/generated/model";
import {
  branchFor,
  fewWords,
  firstLine,
  nameFor,
  orderProfiles,
  pinnedAgent,
  profileMatches,
  repoLabel,
  resolveStart,
  runLabel,
  searchable,
  seededSettings,
} from "~/api/start";

const role = (over: Partial<Role> = {}): Role => ({
  id: "r1",
  name: "Engineer",
  does: "Writes the code and the tests",
  canDelegate: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  delegateScope: [],
  includeAlwaysOn: true,
  includeRepoDefaults: true,
  instructions: "",
  isDefault: false,
  mayShare: true,
  mayWrite: true,
  onChildLimit: "ask",
  onUsageLimit: "wait",
  path: "u/kev",
  placement: "lead",
  settings: {},
  skillScope: [],
  ...over,
});

const host = (over: Partial<Host> = {}): Host =>
  ({
    id: "h1",
    name: "build-box",
    state: "Online",
    cpus: 8,
    ...over,
  }) as Host;

const agentView = (over: Partial<AgentView> = {}): AgentView =>
  ({
    kind: "ClaudeCode",
    label: "Claude Code",
    supported: true,
    enabled: true,
    credentialSet: true,
    needsCredential: true,
    signsInWithACode: false,
    hosts: [{ hostId: "h1", hostName: "build-box", installed: true, behind: false, coveredByToken: true, mayUpdate: true }],
    ...over,
  }) as AgentView;

const account = (over: Partial<Account> = {}): Account =>
  ({
    id: "a1",
    kind: "ClaudeCode",
    name: "Work",
    enabled: true,
    state: "connected",
    credentialSet: true,
    isDefault: true,
    limits: [],
    mode: "Subscription",
    path: "u/kev",
    revision: 1,
    ...over,
  }) as Account;

const repo = (over: Partial<Repo> = {}): Repo =>
  ({ id: "p1", slug: "firetower-cloud/firetower", remote: "git@github.com:firetower-cloud/firetower.git", ...over }) as Repo;

const world = (over: Parameters<typeof resolveStart>[0] extends infer T ? Partial<T> : never = {}) =>
  resolveStart({
    draft: "Fix the amber meter",
    chose: { profileId: null, repoIds: [], hostId: "", agentKind: "", accountId: "" },
    profiles: [],
    repos: [repo()],
    hosts: [host()],
    agents: [agentView()],
    accounts: [account()],
    ...over,
  });

describe("the name", () => {
  it("is the first line and nothing after it", () => {
    expect(firstLine("Fix the amber meter\nand the legend under it")).toBe("Fix the amber meter");
    expect(nameFor(firstLine("Fix the amber meter\nmore"))).toBe("Fix the amber meter");
  });

  it("caps at 80, because it is a name and not a sentence", () => {
    const long = "a".repeat(200);
    expect(nameFor(long)).toHaveLength(80);
  });

  it("falls back to the repository, then to Workspace", () => {
    expect(nameFor("", "firetower-cloud/firetower")).toBe("firetower-cloud/firetower");
    expect(nameFor("")).toBe("Workspace");
  });
});

describe("the branch", () => {
  it("is the first line, slugged, under agent/", () => {
    expect(branchFor("Fix the amber meter")).toBe("agent/fix-the-amber-meter");
  });

  it("never cuts mid-word", () => {
    const cut = branchFor("Quota meter goes amber too early on the free plan");
    expect(cut.endsWith("-")).toBe(false);
    expect(cut.length).toBeLessThanOrEqual("agent/".length + 48);
    // The whole of the last word it kept, not three letters of the next one.
    expect(cut).toBe("agent/quota-meter-goes-amber-too-early-on-the-free");
  });

  it("drops a trailing article, so it reads as a name", () => {
    expect(fewWords("Quota meter rounds the wrong way")).toBe("quota-meter-rounds");
  });

  it("lets the task key lead, when there is one", () => {
    expect(branchFor("Quota meter goes amber too early", "NW-4120")).toBe(
      "agent/nw-4120-quota-meter-goes-amber",
    );
  });

  it("is agent/work rather than a bare agent/ when there are no words", () => {
    expect(branchFor("   ")).toBe("agent/work");
  });

  it("is absent with nothing checked out", () => {
    expect(world({ chose: { profileId: null, repoIds: [], hostId: "", agentKind: "", accountId: "" } }).branch)
      .toBeUndefined();
    expect(world({ chose: { profileId: null, repoIds: ["p1"], hostId: "", agentKind: "", accountId: "" } }).branch)
      .toBe("agent/fix-the-amber-meter");
  });
});

describe("the profile list", () => {
  it("floats the ones that can delegate, then files alphabetically", () => {
    const list = [
      role({ id: "1", name: "Zoe the QA" }),
      role({ id: "2", name: "Engineer" }),
      role({ id: "3", name: "Board lead", canDelegate: true }),
      role({ id: "4", name: "Another lead", canDelegate: true }),
    ];
    expect(orderProfiles(list).map((p) => p.name)).toEqual([
      "Another lead",
      "Board lead",
      "Engineer",
      "Zoe the QA",
    ]);
  });

  it("does not disturb what it was handed", () => {
    const list = [role({ id: "1", name: "B" }), role({ id: "2", name: "A" })];
    orderProfiles(list);
    expect(list.map((p) => p.name)).toEqual(["B", "A"]);
  });

  it("offers a search field only above three", () => {
    expect(searchable(3)).toBe(false);
    expect(searchable(4)).toBe(true);
  });
});

describe("searching for a profile", () => {
  const p = role({ name: "Security_advisor", does: "Reads a diff for anything that leaks" });

  it("matches the name or what it does", () => {
    expect(profileMatches(p, "advisor")).toBe(true);
    expect(profileMatches(p, "leaks")).toBe(true);
    expect(profileMatches(p, "designer")).toBe(false);
  });

  it("folds case, and reads an underscore as a space", () => {
    expect(profileMatches(p, "SECURITY ADVISOR")).toBe(true);
    expect(profileMatches(p, "security_advisor")).toBe(true);
  });

  it("leaves everything when nothing is typed", () => {
    expect(profileMatches(p, "   ")).toBe(true);
  });
});

describe("what the profile pins", () => {
  it("locks the agent pick when it names an engine", () => {
    const pinning = role({ id: "r9", agent: "Codex" });
    expect(pinnedAgent(pinning)).toBe("Codex");
    const r = world({ profiles: [pinning], chose: { profileId: "r9", repoIds: [], hostId: "", agentKind: "", accountId: "" }, agents: [agentView(), agentView({ kind: "Codex", label: "Codex", hosts: [] })] });
    expect(r.locked).toBe(true);
    expect(r.agent?.kind).toBe("Codex");
  });

  it("leaves it a control when it names none", () => {
    const plain = role({ id: "r8" });
    expect(pinnedAgent(plain)).toBeNull();
    expect(world({ profiles: [plain], chose: { profileId: "r8", repoIds: [], hostId: "", agentKind: "", accountId: "" } }).locked).toBe(false);
  });

  it("is not locked by there being no profile at all", () => {
    expect(world().locked).toBe(false);
    expect(pinnedAgent(null)).toBeNull();
  });

  it("seeds the settings only while its own engine is the one running", () => {
    const pinning = role({ agent: "Codex", settings: { model: "gpt-5", effort: "high" } });
    expect(seededSettings(pinning, "Codex")).toEqual({ model: "gpt-5", effort: "high" });
    expect(seededSettings(pinning, "ClaudeCode")).toEqual({});
    expect(seededSettings(null, "Codex")).toEqual({});
  });

  it("shows a pinned engine the machine cannot run, rather than substituting one", () => {
    const pinning = role({ id: "r9", agent: "Codex" });
    const r = world({
      profiles: [pinning],
      chose: { profileId: "r9", repoIds: [], hostId: "", agentKind: "", accountId: "" },
      agents: [agentView(), agentView({ kind: "Codex", label: "Codex", hosts: [] })],
    });
    expect(r.agent?.kind).toBe("Codex");
    expect(r.ready).toBe(false);
    expect(r.why).toEqual({ tone: "brick", say: "Codex is not installed on build-box." });
  });
});

describe("resolving what was never asked for", () => {
  it("takes the first online machine, and ignores one that is not", () => {
    expect(world({ hosts: [host({ id: "h0", name: "down", state: "Unreachable" }), host()] }).host?.id).toBe("h1");
    expect(world({ hosts: [host({ state: "Unreachable" })] }).host).toBeNull();
  });

  /* `listHosts` returns the control plane's own container first and nothing
     is installed on it — the case `mock-server.mjs` carries `localhost` to
     reproduce. "The first online machine" would default every workspace onto
     a machine that can run nothing. */
  it("skips an online machine with no agent on it", () => {
    const r = world({ hosts: [host({ id: "localhost", name: "localhost" }), host({ id: "h1", name: "this Mac" })] });
    expect(r.host?.id).toBe("h1");
    expect(r.ready).toBe(true);
  });

  it("prefers a machine the pinned engine runs on", () => {
    const pinning = role({ id: "r9", agent: "Codex" });
    const r = world({
      profiles: [pinning],
      chose: { profileId: "r9", repoIds: [], hostId: "", agentKind: "", accountId: "" },
      hosts: [host({ id: "h1", name: "claude-box" }), host({ id: "h2", name: "codex-box" })],
      agents: [
        agentView(),
        agentView({ kind: "Codex", label: "Codex", hosts: [{ hostId: "h2", hostName: "codex-box", installed: true, behind: false, coveredByToken: true, mayUpdate: true }] as never }),
      ],
      accounts: [account({ kind: "Codex" })],
    });
    expect(r.host?.id).toBe("h2");
    expect(r.ready).toBe(true);
  });

  it("still takes a machine chosen by hand, whatever is on it", () => {
    const r = world({
      hosts: [host({ id: "localhost", name: "localhost" }), host({ id: "h1" })],
      chose: { profileId: null, repoIds: [], hostId: "localhost", agentKind: "", accountId: "" },
    });
    expect(r.host?.id).toBe("localhost");
    expect(r.why?.say).toBe("Claude Code is not installed on localhost.");
  });

  it("falls back from a held machine that has gone unreachable", () => {
    const r = world({
      hosts: [host({ id: "h1", state: "Unreachable" }), host({ id: "h2", name: "spare" })],
      agents: [agentView({ hosts: [{ hostId: "h2", hostName: "spare", installed: true, behind: false, coveredByToken: true, mayUpdate: true }] as never })],
      chose: { profileId: null, repoIds: [], hostId: "h1", agentKind: "", accountId: "" },
    });
    expect(r.host?.id).toBe("h2");
    expect(r.ready).toBe(true);
  });

  it("takes an agent the machine can actually run", () => {
    const r = world({
      agents: [agentView({ kind: "Codex", label: "Codex", hosts: [] }), agentView()],
    });
    expect(r.agent?.kind).toBe("ClaudeCode");
  });

  it("takes that agent's default account, and never another agent's", () => {
    const r = world({
      accounts: [
        account({ id: "x", kind: "Codex", name: "Codex one" }),
        account({ id: "y", name: "Spare", isDefault: false }),
        account({ id: "z", name: "Mine", isDefault: true }),
      ],
    });
    expect(r.account?.id).toBe("z");
    expect(r.mine.map((a) => a.id)).toEqual(["y", "z"]);
  });

  it("will not offer an account that cannot spend", () => {
    const r = world({ accounts: [account({ credentialSet: false })] });
    expect(r.account).toBeNull();
    expect(r.ready).toBe(false);
    expect(r.why?.tone).toBe("dim");
  });

  it("needs no account for an agent that needs no credential", () => {
    const r = world({ agents: [agentView({ kind: "Shell", label: "Shell", needsCredential: false })], accounts: [] });
    expect(r.ready).toBe(true);
    expect(r.why).toBeNull();
  });
});

describe("why it will not send", () => {
  it("says the machine first, because an agent cannot be checked without one", () => {
    const r = world({ hosts: [], agents: [] });
    expect(r.why?.say).toMatch(/^No machine is online/);
  });

  it("calls an absence dim and a failure brick", () => {
    expect(world({ hosts: [] }).why?.tone).toBe("dim");
    expect(world({ agents: [agentView({ hosts: [] })] }).why?.tone).toBe("brick");
  });

  it("lets the server's refusal win the line", () => {
    const r = world({ refused: "No host is available to take this." });
    expect(r.why).toEqual({ tone: "brick", say: "No host is available to take this." });
  });

  /* The ↑ is the only control that can clear a refusal, so a refusal must not
     be allowed to disable it — otherwise escaping one means retyping the
     sentence. */
  it("but does not put the send button out", () => {
    expect(world({ refused: "No host is available to take this." }).ready).toBe(true);
  });

  it("is not ready on an empty draft, and says nothing about it", () => {
    const r = world({ draft: "   " });
    expect(r.ready).toBe(false);
    expect(r.why).toBeNull();
  });
});

describe("what the controls read", () => {
  it("prefers the model to the engine, and says so when there is neither", () => {
    expect(runLabel(agentView(), "Opus 5")).toBe("Opus 5");
    expect(runLabel(agentView(), undefined)).toBe("Claude Code");
    expect(runLabel(null, undefined)).toBe("No agent");
  });

  it("asks to connect only when there is nothing to add", () => {
    expect(repoLabel([], 0)).toBe("Connect a repository");
    expect(repoLabel([], 4)).toBe("Add a repository");
    expect(repoLabel([repo()], 4)).toBe("firetower-cloud/firetower");
    expect(repoLabel([repo(), repo({ id: "p2" }), repo({ id: "p3" })], 4)).toBe("3 repositories");
  });
});

/**
 * The five answers the composer gives instead of asking.
 *
 * The home's start flow is a component and there is no renderer here, so what
 * is pinned is the fold underneath it: the name, the branch, what the picker
 * offers and in what order, what a search for one means, what picking it would
 * do, and whether the agent is a control or a statement. Those are the parts
 * that can be silently wrong — a branch cut mid-word, a team that does not
 * name its lead, a count off by one, a pinned engine the picker lets you
 * change anyway.
 *
 * `branchFor` and `fewWords` are the desk's, retyped (there is no shared
 * module), so their cases are the desk's too: the two clients have to agree
 * about what a title is called, or one release cuts two branches for one
 * sentence.
 */
import { describe, expect, it } from "vitest";
import type { Account, AgentTeam, AgentView, Host, Repo, Role } from "~/api/generated/model";
import {
  branchFor,
  consequence,
  fewWords,
  firstLine,
  nameFor,
  pinnedAgent,
  repoLabel,
  resolveStart,
  runLabel,
  searchable,
  seededSettings,
  startableIn,
  startableMatches,
  startables,
  type StartAs,
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
    chose: { startAs: null, repoIds: [], hostId: "", agentKind: "", accountId: "" },
    profiles: [],
    teams: [],
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
    expect(world({ chose: { startAs: null, repoIds: [], hostId: "", agentKind: "", accountId: "" } }).branch)
      .toBeUndefined();
    expect(world({ chose: { startAs: null, repoIds: ["p1"], hostId: "", agentKind: "", accountId: "" } }).branch)
      .toBe("agent/fix-the-amber-meter");
  });
});

/** A team, with only the fields the picker reads. */
const team = (over: Partial<AgentTeam> = {}): AgentTeam =>
  ({
    id: "t1",
    name: "Product",
    lead: "r1",
    leadName: "Engineer",
    // Every seat in the tree, and what the lead can actually hand work to.
    // They agree on a flat, fully visible team and nowhere else; the picker
    // reads the second, which is what a spawn resolves against.
    positions: 8,
    reports: 7,
    path: "u/kev/product_12345678",
    mayWrite: true,
    mayShare: true,
    schedules: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  }) as AgentTeam;

describe("what the picker offers", () => {
  it("bands teams above profiles, alphabetically within each", () => {
    // Not a new preference. This list used to float the delegating profiles
    // to the top; reach has moved onto the team, so the position moves with
    // it rather than being a second rule.
    const all = startables(
      [team({ id: "t2", name: "Zebra" }), team({ id: "t1", name: "Product" })],
      [role({ id: "1", name: "Zoe the QA" }), role({ id: "2", name: "Engineer" })],
    );
    expect(all.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "team:Product",
      "team:Zebra",
      "profile:Engineer",
      "profile:Zoe the QA",
    ]);
  });

  it("keeps `orderProfiles`' sort among profiles while the old reach is live", () => {
    // Teams took the top; they did not take this. A Manager started bare
    // still hands work out during the window, which is the same fact that
    // earns it a chip and its own sentence. Dies with #497.
    const all = startables(
      [],
      [
        role({ id: "1", name: "Zoe the QA" }),
        role({ id: "2", name: "Engineer" }),
        role({ id: "3", name: "Board lead", canDelegate: true }),
        role({ id: "4", name: "Another lead", canDelegate: true }),
      ],
    );
    expect(all.map((s) => s.name)).toEqual([
      "Another lead",
      "Board lead",
      "Engineer",
      "Zoe the QA",
    ]);
  });

  it("names a team's lead and its size", () => {
    const [product] = startables([team()], [role()]);
    expect(product.does).toBe("Led by Engineer");
    expect(product.agents).toBe(8);
    expect(product.lead).toBe("Engineer");
  });

  it("shows a profile that leads a team twice, once bare and once as the team", () => {
    const all = startables([team()], [role()]);
    expect(all.map((s) => s.kind)).toEqual(["team", "profile"]);
    expect(all.every((s) => s.lead === "Engineer")).toBe(true);
  });

  it("offers no position, ever", () => {
    // A position only means something inside its tree. This is built from the
    // teams and the profiles and from nothing else.
    const all = startables([team()], [role()]);
    expect(all).toHaveLength(2);
  });

  it("will not start a team with no lead, or one whose lead you cannot use", () => {
    const [leadless] = startables([team({ lead: undefined, leadName: undefined })], []);
    expect(leadless.blocked).toBe("It has no lead, so there is nobody to start");
    const [hidden] = startables([team({ leadName: undefined })], []);
    expect(hidden.blocked).toBe("Its lead isn't a profile you can use");
  });

  it("does not disturb what it was handed", () => {
    const list = [role({ id: "1", name: "B" }), role({ id: "2", name: "A" })];
    startables([], list);
    expect(list.map((p) => p.name)).toEqual(["B", "A"]);
  });

  it("offers a search field only above three, counting the teams", () => {
    expect(searchable(3)).toBe(false);
    expect(searchable(4)).toBe(true);
    expect(searchable(startables([team()], [role(), role({ id: "r2" })]).length)).toBe(false);
  });
});

describe("searching the picker", () => {
  const [p] = startables(
    [],
    [role({ name: "Security_advisor", does: "Reads a diff for anything that leaks" })],
  );

  it("matches the name or what it does", () => {
    expect(startableMatches(p, "advisor")).toBe(true);
    expect(startableMatches(p, "leaks")).toBe(true);
    expect(startableMatches(p, "designer")).toBe(false);
  });

  it("folds case, and reads an underscore as a space", () => {
    expect(startableMatches(p, "SECURITY ADVISOR")).toBe(true);
    expect(startableMatches(p, "security_advisor")).toBe(true);
  });

  it("leaves everything when nothing is typed", () => {
    expect(startableMatches(p, "   ")).toBe(true);
  });

  it("finds a team by its lead, which is what anybody remembers about one", () => {
    const [product] = startables([team()], []);
    expect(startableMatches(product, "engineer")).toBe(true);
    expect(startableMatches(product, "prod")).toBe(true);
  });
});

/**
 * **The desk's sentence, to the character.** One agent or eight is the
 * largest difference in this sheet and it is harder on a phone, not easier,
 * so nothing here is shortened to save height.
 */
describe("what picking it would do", () => {
  const say = (teams: AgentTeam[], profiles: Role[], start: StartAs) =>
    consequence(startableIn(startables(teams, profiles), start));

  it("states a team's lead, and what it can reach", () => {
    expect(say([team()], [role()], { kind: "team", id: "t1" })).toBe(
      "Starts Engineer, Product's lead. It can hand work to 7 other agents in the team.",
    );
  });

  it("against a profile on its own, which cannot hand work to anybody", () => {
    expect(say([team()], [role()], { kind: "profile", id: "r1" })).toBe(
      "Starts Engineer on its own. It cannot hand work to anybody.",
    );
  });

  it("counts one other as one agent, not one agents", () => {
    expect(
      say([team({ positions: 2, reports: 1 })], [role()], { kind: "team", id: "t1" }),
    ).toBe("Starts Engineer, Product's lead. It can hand work to 1 other agent in the team.");
  });

  it("says a team of one cannot hand work on either", () => {
    expect(
      say([team({ positions: 1, reports: 0 })], [role()], { kind: "team", id: "t1" }),
    ).toBe(
      "Starts Engineer, Product's lead. Nothing reports to it yet, so it cannot hand work to anybody.",
    );
  });

  /** **#514 — the desk's row, to the character.** A deep team, or one holding
      a profile this person cannot see, reaches fewer agents than it has
      seats, and the sheet says the number the spawn will honour. */
  it("promises what the lead can reach, not how big the tree is", () => {
    expect(
      say([team({ positions: 7, reports: 2 })], [role()], { kind: "team", id: "t1" }),
    ).toBe("Starts Engineer, Product's lead. It can hand work to 2 other agents in the team.");
    const [deep] = startables([team({ positions: 7, reports: 2 })], [role()]);
    expect(deep!.agents).toBe(3);
  });

  it("does not claim a Manager cannot delegate while its old reach is live", () => {
    expect(say([], [role({ id: "r7", name: "Orchestrator", canDelegate: true })], {
      kind: "profile",
      id: "r7",
    })).toBe(
      "Starts Orchestrator on its own. Its own profile still lets it hand work out, which an agent team replaces.",
    );
  });

  it("says what is wrong with a row there is nothing to start", () => {
    expect(
      say([team({ lead: undefined, leadName: undefined })], [], { kind: "team", id: "t1" }),
    ).toBe("Product can't be started. It has no lead, so there is nobody to start.");
  });

  it("says nothing about a plain workspace, which the row already states", () => {
    expect(say([team()], [role()], null)).toBeNull();
  });
});

/**
 * **A team names its lead's profile too**, because the lead *is* a profile —
 * so the engine, the settings and the account resolve from one place whichever
 * way it was chosen. `create_session_as` makes the same resolution on the
 * server and refuses a team beside a different profile.
 */
describe("starting as a team", () => {
  it("runs the lead's profile, and carries its pinned engine", () => {
    const lead = role({ id: "r1", name: "Engineer", agent: "Codex" });
    const r = world({
      profiles: [lead],
      teams: [team()],
      chose: { startAs: { kind: "team", id: "t1" }, repoIds: [], hostId: "", agentKind: "", accountId: "" },
      agents: [agentView(), agentView({ kind: "Codex", label: "Codex", hosts: [] })],
    });
    expect(r.profile?.id).toBe("r1");
    expect(r.team?.name).toBe("Product");
    expect(r.locked).toBe(true);
    expect(r.startable?.kind).toBe("team");
  });

  it("and a profile named bare picks up no team at all", () => {
    // The distinction the picker carries: a profile that happens to lead a
    // team does not pick that team up by being named on its own.
    const r = world({
      profiles: [role({ id: "r1" })],
      teams: [team()],
      chose: { startAs: { kind: "profile", id: "r1" }, repoIds: [], hostId: "", agentKind: "", accountId: "" },
    });
    expect(r.profile?.id).toBe("r1");
    expect(r.team).toBeNull();
  });

  it("falls back from a team that can no longer be started, rather than sticking", () => {
    // The lead's profile was deleted while the composer sat open holding the
    // team. Sending it would be a refusal from the server about something
    // this screen could already see.
    const r = world({
      profiles: [role({ id: "r1" })],
      teams: [team({ lead: undefined, leadName: undefined })],
      chose: { startAs: { kind: "team", id: "t1" }, repoIds: [], hostId: "", agentKind: "", accountId: "" },
    });
    expect(r.startable).toBeUndefined();
    expect(r.profile).toBeNull();
    expect(r.team).toBeNull();
  });

  it("resolves to nothing when the team's lead is a profile it cannot see", () => {
    const r = world({
      profiles: [],
      teams: [team()],
      chose: { startAs: { kind: "team", id: "t1" }, repoIds: [], hostId: "", agentKind: "", accountId: "" },
    });
    expect(r.profile).toBeNull();
    expect(r.team?.id).toBe("t1");
  });
});

describe("what the profile pins", () => {
  it("locks the agent pick when it names an engine", () => {
    const pinning = role({ id: "r9", agent: "Codex" });
    expect(pinnedAgent(pinning)).toBe("Codex");
    const r = world({ profiles: [pinning], chose: { startAs: { kind: "profile", id: "r9" }, repoIds: [], hostId: "", agentKind: "", accountId: "" }, agents: [agentView(), agentView({ kind: "Codex", label: "Codex", hosts: [] })] });
    expect(r.locked).toBe(true);
    expect(r.agent?.kind).toBe("Codex");
  });

  it("leaves it a control when it names none", () => {
    const plain = role({ id: "r8" });
    expect(pinnedAgent(plain)).toBeNull();
    expect(world({ profiles: [plain], chose: { startAs: { kind: "profile", id: "r8" }, repoIds: [], hostId: "", agentKind: "", accountId: "" } }).locked).toBe(false);
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
      chose: { startAs: { kind: "profile", id: "r9" }, repoIds: [], hostId: "", agentKind: "", accountId: "" },
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
      chose: { startAs: { kind: "profile", id: "r9" }, repoIds: [], hostId: "", agentKind: "", accountId: "" },
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
      chose: { startAs: null, repoIds: [], hostId: "localhost", agentKind: "", accountId: "" },
    });
    expect(r.host?.id).toBe("localhost");
    expect(r.why?.say).toBe("Claude Code is not installed on localhost.");
  });

  it("falls back from a held machine that has gone unreachable", () => {
    const r = world({
      hosts: [host({ id: "h1", state: "Unreachable" }), host({ id: "h2", name: "spare" })],
      agents: [agentView({ hosts: [{ hostId: "h2", hostName: "spare", installed: true, behind: false, coveredByToken: true, mayUpdate: true }] as never })],
      chose: { startAs: null, repoIds: [], hostId: "h1", agentKind: "", accountId: "" },
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

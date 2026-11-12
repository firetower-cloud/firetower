/**
 * The create sheet is made of the product's controls, and they are wired.
 *
 * Every one of these assertions is something that shipped wrong. The sheet
 * was built with controls of its own — a native `<select>` for the repository
 * that could hold exactly one, a machine that was a sentence rather than a
 * picker, no model and no account control at all, and a Skills row that only
 * described what would happen. It typechecked and it looked finished.
 *
 * Rendered against a seeded cache under the keys the data hooks store under,
 * so what is here is what the sheet did with the answers it was handed — no
 * network. The menus are rendered separately, with the props the sheet passes
 * them: `RepoMenu` and the rest come from the composer, and a prop shape that
 * does not fit is a white screen on click rather than a type error.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewSchedule } from "./NewSchedule";
import { Menu, Opt, ProfileMenu, RepoMenu } from "~/ui/StartComposer";
import { unattendedValue } from "./controls";
import { getListReposQueryKey } from "~/api/generated/repos/repos";
import { getListHostsQueryKey } from "~/api/generated/hosts/hosts";
import { getListAgentsQueryKey, getAgentControlsQueryKey } from "~/api/generated/agents/agents";
import { getListAccountsQueryKey } from "~/api/generated/accounts/accounts";
import { getListSkillsQueryKey } from "~/api/generated/skills/skills";
import { getListRolesQueryKey } from "~/api/generated/roles/roles";
import type {
  Account,
  AgentView,
  Control,
  Host,
  Repo,
  Role,
  Schedule,
  Skill,
} from "~/api/generated/model";

const repo = (id: string, slug: string) => ({ id, slug, remote: `https://example.test/${slug}.git`, defaultBranch: "main" }) as Repo;

const host = {
  id: "h_01machine",
  name: "studio",
  state: "Online",
  compute: { type: "Server" },
  agents: [{ kind: "ClaudeCode", installed: true }],
} as unknown as Host;

const claude = {
  kind: "ClaudeCode",
  label: "Claude Code",
  needsCredential: true,
  supported: true,
  enabled: true,
  credentialSet: true,
  signsInWithACode: false,
  hosts: [{ hostId: host.id, installed: true }],
} as AgentView;

const account = {
  id: "acct_work",
  name: "Claude (work)",
  kind: "ClaudeCode",
  mode: "Subscription",
  enabled: true,
  state: "connected",
  credentialSet: true,
  isDefault: true,
  revision: 1,
  limits: [],
} as unknown as Account;

/** The mode control, with the marker the sheet reads to find "never ask". */
const MODE: Control = {
  kind: "mode",
  fallback: "Permissions",
  choices: [
    { label: "Ask everything", value: "default" },
    { label: "Accept edits", value: "acceptEdits", caution: "grants" },
    { label: "Never ask", value: "dontAsk", caution: "neverAsks" },
  ],
  // What this person last worked with — which is the one thing an unattended
  // run must not inherit.
  current: "acceptEdits",
} as Control;

/** The same control on the other engine, which spells it differently. */
const CODEX_MODES = [
  { label: "Ask when needed", value: "on-request" },
  { label: "Never ask", value: "never", caution: "neverAsks" as const },
];

const MODEL: Control = {
  kind: "model",
  fallback: "Model",
  choices: [
    { label: "Opus 5", value: "opus-5" },
    { label: "Haiku", value: "haiku" },
  ],
  current: "haiku",
} as Control;

const skill = (id: string, name: string, alwaysOn = false) =>
  ({ id, name, description: "", alwaysOn, defaultIn: [], tokens: 100 }) as unknown as Skill;

const role = (id: string, name: string) =>
  ({ id, name, does: "Reads the dependency diff", canDelegate: false, placement: "new" }) as unknown as Role;

function cache() {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  c.setQueryData(getListReposQueryKey(), [repo("r_01web", "acme/web"), repo("r_02api", "acme/api")]);
  c.setQueryData(getListHostsQueryKey(), [host]);
  c.setQueryData(getListAgentsQueryKey(), [claude]);
  c.setQueryData(getListAccountsQueryKey(), [account]);
  c.setQueryData(getListSkillsQueryKey(), [skill("sk_01", "House style"), skill("sk_02", "Always", true)]);
  c.setQueryData(getListRolesQueryKey(), [role("p_01", "Ada, the lead")]);
  c.setQueryData(getAgentControlsQueryKey("ClaudeCode"), [MODE, MODEL]);
  return c;
}

const sheet = () =>
  renderToStaticMarkup(
    <QueryClientProvider client={cache()}>
      <NewSchedule from={null} onClose={() => {}} />
    </QueryClientProvider>,
  );

describe("the create sheet", () => {
  it("drops the product's own chips rather than native selects", () => {
    const html = sheet();
    // A `<select>` in the body was the repository, the profile and the
    // machine. The cadence row still has them, so this is about the shelf and
    // the composer's footer: those chips are buttons.
    expect(html).toContain('data-which="repo"');
    expect(html).toContain("Add a repository");
    expect(html).toContain('data-which="machine"');
    // The machine is named, not described. "First available machine" was a
    // statement where a picker belonged.
    expect(html).not.toContain("First available machine");
    expect(html).toContain("studio");
    // The profile and what runs it.
    expect(html).toContain("Just an agent");
    expect(html).toContain("Claude Code");
    // And a skills chip that can be opened, rather than a line saying what
    // would have happened.
    expect(html).toContain("skills");
  });

  it("opens the permission mode on the choice the catalogue marks never-asks", () => {
    // Not `current`, which is what that person last picked at their desk —
    // `acceptEdits` here, which the server refuses for a schedule. And found
    // by the marker rather than by the word, which differs by engine.
    expect(unattendedValue(MODE)).toBe("dontAsk");
    expect(unattendedValue({ ...MODE, choices: CODEX_MODES })).toBe("never");
    // Everything else opens unset: the agent's own default applies and the
    // server writes down which one that was.
    expect(unattendedValue(MODEL)).toBeUndefined();
  });

  it("keeps the consequence summary in the body it scrolls with", () => {
    const html = sheet();
    const body = html.indexOf("s-sbody");
    const foot = html.indexOf("sh-foot");
    const summary = html.indexOf("Running unattended");
    expect(body).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(body);
    expect(summary).toBeLessThan(foot);
    // It was in a third row of its own, pinned between them.
    expect(html).not.toContain("s-pinned");
  });

  it("will not create one with no machine to run on", () => {
    const empty = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    empty.setQueryData(getListReposQueryKey(), []);
    empty.setQueryData(getListHostsQueryKey(), []);
    empty.setQueryData(getListAgentsQueryKey(), []);
    empty.setQueryData(getListAccountsQueryKey(), []);
    empty.setQueryData(getListSkillsQueryKey(), []);
    empty.setQueryData(getListRolesQueryKey(), []);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={empty}>
        <NewSchedule from={null} onClose={() => {}} />
      </QueryClientProvider>,
    );
    expect(html).toContain("No machine to run on yet.");
    expect(html).toContain("Pick a machine for it to run on");
  });
});

/** One as the server reports it, with everything an edit has to fill in. */
const saved = {
  id: "sch_01edit",
  name: "Dependency audit",
  prompt: "check every dependency for a newer version",
  repoId: "r_02api",
  repoSlug: "acme/api",
  repos: [{ id: "r_02api", slug: "acme/api" }],
  base: "trunk",
  hostId: host.id,
  hostName: "studio",
  active: true,
  pausedReason: null,
  approvedAt: "2026-11-01T08:30:00Z",
  revision: 3,
  deleteCleanRuns: false,
  workspacesKept: 0,
  runsTotal: 4,
  lastRun: null,
  streak: { failures: 0, counted: 0, unreachable: 0, questions: 0 },
  made: { byAgent: false, who: "You", fromSessionId: null, fromWorkspaceName: null, at: "2026-11-01T08:00:00Z" },
  createdAt: "2026-11-01T08:00:00Z",
  updatedAt: "2026-11-01T08:00:00Z",
  triggers: [
    {
      id: "trg_01",
      kind: "cron",
      cadence: { kind: "weekly", at: "06:15", day: "thursday" },
      timezone: "Europe/Paris",
      enabled: true,
      expr: "15 6 * * 4",
      reads: "Every Thursday at 06:15",
      nextFires: [],
      nextFireAt: null,
    },
  ],
  choices: {
    agent: "ClaudeCode",
    accountId: "acct_work",
    profile: null,
    settings: { model: "opus-5", mode: "dontAsk" },
    skills: ["sk_01"],
  },
} as unknown as Schedule;

/**
 * **Editing is the same sheet, filled in.**
 *
 * There was no way to edit a schedule at all: the button navigated to
 * `?edit=1` and nothing read it. And filling the form in was not possible
 * until `Schedule.choices` existed — the approved engine, subscription,
 * profile, controls and skills were in the pins and nothing exposed them, so
 * a form could only have reset every one of them to a fresh default and
 * called that an edit.
 */
describe("the sheet, editing one that exists", () => {
  const drawn = () =>
    renderToStaticMarkup(
      <QueryClientProvider client={cache()}>
        <NewSchedule from={null} editing={saved} onClose={() => {}} />
      </QueryClientProvider>,
    );

  it("says which act this is", () => {
    const html = drawn();
    expect(html).toContain("Edit schedule");
    expect(html).toContain("Save changes");
    // It was on, so saving is approving what it says now.
    expect(html).toContain("Saving this approves what it says now.");
  });

  it("fills in what the schedule already says", () => {
    const html = drawn();
    expect(html).toContain('value="Dependency audit"');
    expect(html).toContain("check every dependency for a newer version");
    // The repository it checks out, on the chip rather than as a count.
    expect(html).toContain("acme/api");
    // Its own cadence and zone, not the form's defaults.
    expect(html).toContain('value="weekly"');
    expect(html).toContain('value="thursday"');
    expect(html).toContain('value="06:15"');
    expect(html).toContain('value="Europe/Paris"');
    // And the branch it branches from, which is why Advanced is open.
    expect(html).toContain('value="trunk"');
  });

  it("keeps the engine's remembered controls out of it", () => {
    // `choices.settings` is what was approved. The mode here is the engine's
    // never-ask word, which is also what a new sheet would pick — the model
    // is the one that proves it came from the schedule rather than from the
    // catalogue's own default.
    expect(saved.choices.settings.model).toBe("opus-5");
    expect(drawn()).toContain("Opus 5");
  });

  it("leaves one that was switched off switched off", () => {
    const paused = { ...saved, active: false } as Schedule;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={cache()}>
        <NewSchedule from={null} editing={paused} onClose={() => {}} />
      </QueryClientProvider>,
    );
    expect(html).toContain("It stays switched off until you turn it on.");
  });
});

describe("the menus those chips drop", () => {
  it("renders the composer's repository menu, which takes several", () => {
    const html = renderToStaticMarkup(
      <RepoMenu
        repos={[repo("r_01web", "acme/web"), repo("r_02api", "acme/api")]}
        checkouts={[{ id: "r_01web", slug: "acme/web" }]}
        onToggle={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("acme/web");
    expect(html).toContain("acme/api");
    // Multi-select: the ticked one is marked and the other is still offered.
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');
  });

  it("renders the composer's machine menu with the machine in it", () => {
    const html = renderToStaticMarkup(
      <Menu>
        <Opt on onPick={() => {}} icon={null} title="studio" />
      </Menu>,
    );
    expect(html).toContain("studio");
  });

  it("renders the composer's profile menu", () => {
    const html = renderToStaticMarkup(
      <ProfileMenu profiles={[role("p_01", "Ada, the lead")]} profileId={null} onPick={() => {}} />,
    );
    expect(html).toContain("Ada, the lead");
    expect(html).toContain("Just an agent");
  });

});

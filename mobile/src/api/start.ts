/**
 * What the home composer is about to start, worked out from what it has.
 *
 * The form at `/new` asked six questions — a name, a branch, which
 * repositories, which machine, which agent, whose account — and five of them
 * have an obvious answer. **Asking for an answer you already have is most of
 * why a form was the wrong shape for a phone**, so this is where the answers
 * live: the machine is the first one online, the agent is whatever the profile
 * pins or else one the machine can actually run, the account is that agent's
 * default, and the name and the branch come off the first line you typed.
 *
 * Everything stays changeable. A resolved default is drawn as a *value*, not
 * as a decision somebody made for you — `StartBox`'s picks open over it.
 *
 * ## Why it is here and not in the screen
 *
 * `react-native` is stubbed under the test runner and there is no renderer, so
 * a component's behaviour cannot be asserted at all. The same reason `opens`
 * and `agentName` live in `workspaces.ts`: the interesting questions are a
 * fold over the contract, and a fold can be checked.
 *
 * ## The branch rule is the desk's, retyped rather than imported
 *
 * `slug`, `fewWords` and `branchFor` are `desktop/src/ui/StartComposer.tsx`'s,
 * to the character, because a branch named two ways is two branches within a
 * release. There is no module the two clients share — `workspaces.ts` and
 * `ship.ts` came over the same way — so the rule is stated twice and tested
 * twice, and the test is what keeps the two readings honest.
 */
import { usable } from "~/api/accounts";
import type { Account, Agent, AgentView, ControlKind, Host, Preferred, Repo, Role } from "~/api/generated/model";

/* The whole of it, uncapped: the length cap belongs to `fewWords`, which is
   the only thing that knows where a word ends. */
const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * A few words of a title, cut on a word boundary.
 *
 * *Quota meter goes amber too early on the free plan* becomes
 * `quota-meter-goes-amber` — enough to recognise in `git branch` and not a
 * sentence. Cut between words, never mid-word, because a branch ending in
 * `…-ea` reads as a typo.
 *
 * And never left ending on an article or a preposition. *Quota meter rounds
 * the wrong way* cut at twenty-four is `quota-meter-rounds-the`, which reads
 * as a sentence that was interrupted; dropping a trailing word of three
 * letters or fewer gives `quota-meter-rounds`, which reads as a name.
 */
export function fewWords(s: string, within = 24): string {
  const full = slug(s);
  if (full.length <= within) return full;
  const cut = full.slice(0, within + 1);
  const at = cut.lastIndexOf("-");
  const kept = at > 0 ? cut.slice(0, at) : full.slice(0, within);
  const parts = kept.split("-");
  return parts.length > 1 && parts[parts.length - 1].length <= 3
    ? parts.slice(0, -1).join("-")
    : kept;
}

/**
 * The branch a workspace will be cut on.
 *
 * **With a task key, the key leads**: `agent/nw-4120-quota-meter-goes-amber`.
 * It is stable, short, greppable and survives the title being edited; a few
 * words of the title follow because a branch list of bare keys tells you
 * nothing about what any of them was.
 *
 * Without one, this is the first line, slugged. A task with a URL and no key
 * falls back to exactly that.
 *
 * **The home never passes a key.** A task goes to `/new`, which is the one
 * arrival that carries one — and it is also the only arrival where the desk
 * draws the branch on screen, because that is where what is about to happen
 * is not otherwise visible. So nothing on the home draws a branch; it is
 * computed here and sent.
 */
export function branchFor(first: string, taskKey?: string | null): string {
  const key = taskKey ? slug(taskKey) : "";
  const stem = key ? [key, fewWords(first)].filter(Boolean).join("-") : fewWords(first, 48);
  return `agent/${stem || "work"}`;
}

/**
 * What the workspace is listed under: the first line of what you typed.
 *
 * Capped at 80 because it is a name a person reads in a list and not a
 * sentence, and `NewSession.name` says as much. The repository's slug is the
 * fallback — a bare workspace with nothing typed is *Workspace*, which is at
 * least true.
 */
export function nameFor(first: string, repoSlug?: string): string {
  return (first || repoSlug || "Workspace").slice(0, 80);
}

/** The first line of a draft, trimmed — the one both derivations read. */
export function firstLine(draft: string): string {
  return draft.split("\n")[0].trim();
}

/**
 * Delegating profiles first, then alphabetical.
 *
 * The desk's order, from `ProfileMenu`: the lead you'd start a board as is the
 * one you reach for most. `localeCompare` rather than `<`, so an accented name
 * files where a person would look for it.
 */
export function orderProfiles(profiles: Role[]): Role[] {
  return [...profiles].sort(
    (a, b) => Number(b.canDelegate) - Number(a.canDelegate) || a.name.localeCompare(b.name),
  );
}

/**
 * Whether a query leaves a profile.
 *
 * On the name **or** on what it does, which is how somebody looks for one
 * they set up months ago. `looselyMatches`' rule, which folds case and reads
 * an underscore as a space — a profile called `security_advisor` has to be
 * findable by typing *security advisor*.
 */
export function profileMatches(p: Pick<Role, "name" | "does">, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/_/g, " ");
  if (!q) return true;
  return `${p.name} ${p.does ?? ""}`.toLowerCase().replace(/_/g, " ").includes(q);
}

/**
 * Above how many profiles the sheet offers a search field.
 *
 * The desk's `when={profiles.length > 3}`, kept: a box over three rows you can
 * read at a glance is furniture pretending to be a control. And on a phone it
 * costs more than on a desk — see `ProfileSheet`, which must not focus it.
 */
export const SEARCH_ABOVE = 3;

/** Whether this many profiles earn a search field. */
export function searchable(count: number): boolean {
  return count > SEARCH_ABOVE;
}

/** Which engine a profile pins, if it pins one. Absent means the lead chooses. */
export function pinnedAgent(profile: Role | null | undefined): Agent | null {
  return (profile?.agent as Agent | undefined) ?? null;
}

/**
 * What the settings picker opens on, when a profile has an opinion.
 *
 * Only while the profile's own engine is the one that will run: a model is one
 * agent's, so carrying `claude-opus-4` into a Codex session would seed a
 * picker with a value it cannot offer. The desk's rule, from the effect above
 * `valueOf`.
 */
export function seededSettings(
  profile: Role | null | undefined,
  kind: Agent | null,
): Partial<Record<ControlKind, string>> {
  if (!profile || !kind || profile.agent !== kind) return {};
  const pins: Preferred = profile.settings ?? {};
  const seed: Partial<Record<ControlKind, string>> = {};
  (["model", "effort", "mode", "sandbox"] as ControlKind[]).forEach((k) => {
    const value = pins[k];
    if (value) seed[k] = value;
  });
  return seed;
}

/**
 * Why the composer cannot send, said once, above the card.
 *
 * `brick` is a failure and `dim` is an absence, and `STYLE.md` makes that
 * distinction load-bearing: a machine that is not there has not failed. Ember
 * is neither — it answers *is an agent waiting on you*, and this is a thing
 * **you** have not done yet.
 */
export type Refusal = { tone: "brick" | "dim"; say: string };

/** What the composer would send, and what is stopping it. */
export type Start = {
  profile: Role | null;
  /** The engine the profile pins. Non-null means the agent is shown, not chosen. */
  pinned: Agent | null;
  /** True when the agent pick is a statement rather than a control. */
  locked: boolean;
  host: Host | null;
  agent: AgentView | null;
  account: Account | null;
  /** Only this agent's accounts, and only the ones that can actually spend. */
  mine: Account[];
  /** The repositories that will be checked out, in the order they were picked. */
  repos: Repo[];
  name: string;
  /** Absent with nothing checked out: there is nothing to cut a branch from. */
  branch: string | undefined;
  ready: boolean;
  why: Refusal | null;
};

/** What has been chosen by hand, each empty until somebody chooses. */
export type Chose = {
  profileId: string | null;
  repoIds: string[];
  hostId: string;
  agentKind: string;
  accountId: string;
};

/**
 * Resolve the whole start from the lists this server answered with.
 *
 * Order matters in two places and both are deliberate:
 *
 * - **A pin is a pin.** When the profile names an engine, that engine is what
 *   is shown even if the machine cannot run it — the notice says so. Quietly
 *   substituting another would start a persona as something it is not.
 * - **One notice at a time, and the machine comes first.** An agent cannot be
 *   checked without a machine to check it on, so drawing both would report a
 *   fact nobody can yet know above the one thing actually stopping you. The
 *   desk's reasoning, from the block above its own notices.
 */
export function resolveStart(input: {
  draft: string;
  chose: Chose;
  profiles: Role[];
  repos: Repo[];
  hosts: Host[];
  agents: AgentView[];
  accounts: Account[];
  /** What the server said when a create was refused, already read for words. */
  refused?: string | null;
}): Start {
  const { draft, chose, profiles, repos, hosts, agents, accounts, refused } = input;

  const profile = profiles.find((p) => p.id === chose.profileId) ?? null;
  const pinned = pinnedAgent(profile);
  const wanted = pinned ?? chose.agentKind;

  /**
   * Online only, and **the first one that can actually run something**.
   *
   * A machine the scheduler cannot reach has not failed; it is not there, and
   * `new.tsx`'s picker has never offered one — so a held id that has since
   * gone unreachable falls back rather than sticking.
   *
   * The second half is the one that bites. `listHosts` returns the control
   * plane's own container first — `accounts.rs` calls `ensure_host("localhost")`
   * — and nothing is installed on it. "The first online machine" therefore
   * defaults every workspace onto a machine that can run no agent at all, and
   * the composer's only remaining job is to explain why it will not start. So
   * the default prefers a machine the wanted engine is installed on, then one
   * that can run *any* supported engine, and only then the first that
   * answers. A machine chosen by hand wins outright, because it was chosen.
   */
  const online = hosts.filter((h) => h.state === "Online");
  const carries = (h: Host, kind?: string) =>
    agents.some(
      (a) =>
        a.supported &&
        (!kind || a.kind === kind) &&
        a.hosts.some((x) => x.hostId === h.id && x.installed),
    );
  const host =
    online.find((h) => h.id === chose.hostId) ??
    (wanted ? online.find((h) => carries(h, wanted)) : undefined) ??
    online.find((h) => carries(h)) ??
    online[0] ??
    null;

  const runsHere = (a: AgentView) =>
    !!host && a.hosts.some((h) => h.hostId === host.id && h.installed);
  let agent = agents.find((a) => a.kind === wanted && a.supported) ?? null;
  if (!pinned && (!agent || !runsHere(agent))) {
    agent =
      agents.find((a) => a.supported && runsHere(a)) ??
      agent ??
      agents.find((a) => a.supported) ??
      null;
  }

  /* Only accounts for the agent that will run, and only ones that can spend.
     Offering a Codex login to a Claude Code session is a choice that cannot
     work, which is what `new.tsx`'s own filter says. */
  const mine = accounts.filter((a) => !!agent && a.kind === agent.kind && usable(a));
  const account =
    mine.find((a) => a.id === chose.accountId) ?? mine.find((a) => a.isDefault) ?? mine[0] ?? null;

  const chosenRepos = chose.repoIds
    .map((id) => repos.find((r) => r.id === id))
    .filter((r): r is Repo => !!r);

  const first = firstLine(draft);
  const name = nameFor(first, chosenRepos[0]?.slug);
  const branch = chosenRepos.length ? branchFor(first || name) : undefined;

  const installed = !!agent && runsHere(agent);
  const needsAccount = !!agent?.needsCredential;

  let why: Refusal | null = null;
  if (!host) {
    why = {
      tone: "dim",
      say: "No machine is online. Agents run on a machine added from the desktop app or the web console.",
    };
  } else if (!agent) {
    why = { tone: "dim", say: "No agent this server supports is installed." };
  } else if (!installed) {
    why = { tone: "brick", say: `${agent.label} is not installed on ${host.name}.` };
  } else if (needsAccount && !account) {
    why = {
      tone: "dim",
      say: `No account for ${agent.label}. One is added from the desktop or the web console.`,
    };
  }
  /* A refusal that came back from the server wins: it is the newest fact on
     the screen and it is the answer to the press that just failed.

     **It does not make the composer unready.** A refusal is about the attempt
     that failed, not about the launch — `NoCapacity` clears when a machine
     frees up and nothing on this screen changes when it does. Letting it put
     the ↑ out would leave the only control that could clear it disabled by
     the thing it would clear: you would have to retype the sentence to escape.
     The desk's `ready` leaves `create.isError` out for the same reason. */
  if (refused) why = { tone: "brick", say: refused };

  const ready =
    draft.trim().length > 0 && !!host && !!agent && installed && (!needsAccount || !!account);

  return {
    profile,
    pinned,
    locked: pinned !== null,
    host,
    agent,
    account,
    mine,
    repos: chosenRepos,
    name,
    branch,
    ready,
    why,
  };
}

/**
 * What the run pick reads: the model when the engine has said, else the
 * engine.
 *
 * The desk's `RunPicker` trigger does the same — a model is the thing you
 * change most and the thing you want to see without opening anything. An
 * agent that has not been resolved at all says so rather than drawing a
 * control that is a picture of one.
 */
export function runLabel(
  agent: AgentView | null,
  modelLabel: string | undefined,
): string {
  if (!agent) return "No agent";
  return modelLabel ?? agent.label;
}

/**
 * What the repository chip reads.
 *
 * Three sentences, and the first two are not the same one: with nothing on
 * this Firetower at all the chip is the way to connect one, and with
 * repositories present but none picked it is an invitation to add. A bare
 * workspace — no code, just an agent in a directory — is legitimate either
 * way; `new.tsx` has always been explicit about that, so neither label
 * refuses.
 */
export function repoLabel(picked: Repo[], available: number): string {
  if (picked.length === 0) return available === 0 ? "Connect a repository" : "Add a repository";
  if (picked.length === 1) return picked[0].slug;
  return `${picked.length} repositories`;
}

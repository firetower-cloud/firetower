/**
 * Profiles: the saved personas any agent can run — as a workspace's lead, or
 * as a teammate a lead hands work to. "Profiles" to the person; `role` on the
 * wire, where renaming would be churn for no one's benefit.
 *
 * A profile is **Placed** like a skill or a machine, so sharing one is the same
 * sheet everything else uses and nothing here reimplements filing. What a
 * profile is, beyond where it lives, is a handful of fields it carries and a
 * team — the other profiles it may delegate to. A profile with a team leads; a
 * profile without one is a worker. Same object either way; the team is the only
 * thing that makes one a manager.
 */
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  CircleDashed,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  Box,
  Cpu,
  Gauge,
  ShieldCheck,
  Plus,
  KeyRound,
  Search,
  Server,
  Sparkles,
  SquarePen,
  Star,
  Trash2,
  User,
  UserRound,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { Group as Rowset, Note, Rows, Section, Typed, WhereTo } from "~/ui/config/bits";
import { WhoCanAccess } from "~/ui/Sharing";
import { Pop } from "~/ui/Pop";
import { CreateMenu } from "~/ui/config/CreateMenu";
import { useStart } from "~/start";
import { AgentMark, AGENT_LABEL } from "~/components/AgentMark";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListRoles,
  getListRolesQueryKey,
  createRole,
  updateRole,
  deleteRole,
  setDefaultRole,
} from "~/api/generated/roles/roles";
import { useAgentControls } from "~/api/generated/agents/agents";
import { useAccounts, useAgents, useDirectories, useHosts, useSkills, why } from "~/data";
import { quota, usable, type Account } from "~/api/accounts";
import { ScopePicker, type ScopeItem } from "~/ui/config/ScopePicker";
import { SkillSources, useSkillSources } from "~/ui/config/SkillSources";
import { machineLabel, machines, stateLabel } from "~/api/environments";
import { canRun } from "~/components/WhereItRuns";
import type { Agent, Control, ControlKind, Role, NewRole } from "~/api/generated/model";
import { navigate } from "~/shims/next-navigation";
import { useConfirm } from "~/ui/Confirm";
import { Badge, IconButton } from "~/components/ui";

/**
 * One phrase for one idea, in all three fields that have it.
 *
 * Placement, Machine and Engine each say the same thing when they say nothing,
 * so they say it in the same words and wear the same mark — a dashed ring
 * (`CircleDashed`), because colour is spent and ember means an agent is waiting
 * on you. Three wordings for one state would unmake the idea that it is one.
 */
const OPEN = "Let the lead choose";

/**
 * What happens when nobody chooses, said on the open pill rather than in the
 * field's hint.
 *
 * Both halves, likelier branch first. In a hint it would read as a default the
 * profile sets, which is the one thing a profile must not have: a field here is
 * a commitment or a question, never a default something else may outrank.
 */
const OPEN_FALLBACK = {
  placement: "here, unless the lead says otherwise",
  machine: "Firetower picks, unless the lead names one",
  agent: "the lead's own, unless it names another",
};

/**
 * Where a child runs. **Three, and the open one first.**
 *
 * A third was added here once before and taken back out, and the reason is
 * worth keeping: it was reasoned from `Role.placement`, documented as
 * `lead | here | new`, which is the **response** model. `roles.rs` enforced
 * `PLACEMENT: [&str; 2] = ["here", "new"]` on the way in, and the effect below
 * coerced any unknown placement back to `here` on every render — so pressing
 * *Let the lead choose* snapped the selection straight back to *Same
 * workspace*. A pill that cannot stay pressed is a button that does not work,
 * which is exactly how it was reported. **A value in a response model is not an
 * option in a request model.**
 *
 * What makes it work this time is that the server takes it: `PLACEMENT` now
 * carries all three, `check()` accepts an absent engine and an absent machine,
 * and the coercing effect is gone from this file. The order is the drawing's
 * (`desktop-redesign.html:4447`) and the order every field here repeats: the
 * open answer first, wearing the open mark, and the commitments after it.
 */
const PLACEMENTS: { value: string; icon: LucideIcon; label: string; note: string }[] = [
  { value: "lead", icon: CircleDashed, label: OPEN, note: OPEN_FALLBACK.placement },
  { value: "here", icon: GitBranch, label: "Same workspace", note: "shares the lead's branch" },
  { value: "new", icon: GitBranchPlus, label: "Its own workspace", note: "a fresh branch" },
];

/** A mark for each run control, so its picker reads like the others. */
const CONTROL_ICON: Record<ControlKind, LucideIcon> = {
  model: Cpu,
  effort: Gauge,
  mode: ShieldCheck,
  sandbox: Box,
};

/**
 * An empty profile, for a new one. An Operator until made a Manager, and
 * **open on all three** — the drawing's own default
 * (`desktop-redesign.html:4414`), and the honest one: a new profile has not
 * decided where it runs, and two effects used to decide for it by force-picking
 * the first engine and the first machine on the list.
 */
const BLANK: Settled = {
  name: "",
  does: "",
  placement: "lead",
  agent: null,
  machine: null,
  account: null,
  settings: {},
  instructions: "",
  canDelegate: false,
  delegateScope: [],
  skillScope: [],
  // Both on, which is what the column defaults to and what makes a new
  // profile load the owner's usual set rather than nothing. Sent explicitly
  // rather than left off: absent tells the server to leave them as they are,
  // which on a profile that does not exist yet is the same answer — but the
  // two switches are what this screen draws, and a draft that omitted them
  // would draw them off while saving them on.
  includeAlwaysOn: true,
  includeRepoDefaults: true,
  directory: null,
};

export function Roles() {
  const start = useStart();
  const feed = useListRoles();
  const rows = {
    data: feed.data ?? [],
    loading: feed.isLoading,
    error: feed.error ? why(feed.error) : null,
  };
  const [editing, setEditing] = useState<{ id?: string; path?: string; draft: NewRole } | null>(
    null,
  );
  const [q, setQ] = useState("");
  const cache = useQueryClient();
  const confirm = useConfirm();

  // By name only. A description search returned the whole roster, because these
  // profiles reference each other ("hand off to the Security Advisor"), so the
  // term is in every one. Managers first, then alphabetical.
  const needle = q.trim().toLowerCase();
  const shown = rows.data
    .filter((r) => !needle || r.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.canDelegate) - Number(a.canDelegate) || a.name.localeCompare(b.name));

  const removeRole = async (role: Role) => {
    const ok = await confirm({
      title: `Delete "${role.name}"?`,
      body: "You can no longer start a workspace as it, and leads lose it from their reach. Agents already running are untouched.",
      action: "Delete profile",
      tone: "danger",
    });
    if (!ok) return;
    await deleteRole(role.id);
    await cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
  };

  if (editing) {
    /* **Read-only says what the screen is, rather than disabling its
       controls.** A profile somebody shared with you opened the full editor
       with a Save button that the server would refuse — which is worse than a
       greyed-out form, because it does not look withheld until after you have
       written something. It opens as a reading of itself instead, and says
       where it is changed. */
    const role = editing.id ? rows.data.find((r) => r.id === editing.id) : undefined;
    if (role && !role.mayWrite) return <Reading role={role} onClose={() => setEditing(null)} />;
    return <Editor state={editing} all={rows.data} onClose={() => setEditing(null)} />;
  }

  /* **Nothing at all, and nothing wrong.** The header action and the
     `WhereTo` come off the screen while it holds: the blank's own button is
     the same action, and a note about how a profile is filed is about
     operating profiles you do not have. A query that matched nothing is not
     this state — there *are* profiles — and it gets a `Note` instead. */
  const blank = !rows.loading && !rows.error && rows.data.length === 0;

  /* The page's one primary action, written once and worn in two places. */
  const newProfile = (
    <CreateMenu
      label="New profile"
      choices={[
        {
          icon: Sparkles,
          label: "Create with AI",
          note: "Describe it; an agent writes it for you.",
          onPick: () => start({ prompt: "Create a Firetower agent profile that " }),
        },
        {
          icon: SquarePen,
          label: "Write it myself",
          note: "Fill in the form by hand.",
          onPick: () => setEditing({ draft: { ...BLANK } }),
        },
      ]}
    />
  );

  return (
    <Section
      /* **Agent profiles**, which is what the rail calls it. "Profiles" alone
         is the account's word on every other product somebody has used. */
      title="Agent profiles"
      note="A saved way of working. One with a team leads, one without is a worker."
      action={blank ? undefined : newProfile}
      controls={
        rows.data.length > 0 ? (
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mute" strokeWidth={1.75} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search profiles…"
              aria-label="Search profiles"
              className="w-full rounded-md border border-line bg-ground py-1.5 pr-2.5 pl-8 text-ui text-bone transition-colors placeholder:text-mute focus:border-dim focus:outline-none"
            />
          </div>
        ) : undefined
      }
    >
      <Rows
        feed={{ data: shown, loading: rows.loading, error: rows.error }}
        icon={UsersRound}
        empty={
          needle ? (
            <Note
              icon={Search}
              control={
                <button onClick={() => setQ("")} className="btn quiet">
                  Clear
                </button>
              }
            >
              No profile matches <Typed>{q.trim()}</Typed>.
            </Note>
          ) : (
            "No profiles yet"
          )
        }
        /* **It says this is optional**, which is the one job the page's own
           sentence cannot do: nobody should read an empty list here as a
           thing they have failed to do. */
        note="Every workspace can run without one. Make one to stop repeating yourself."
        action={newProfile}
      >
        <Rowset>
          {shown.map((role) => (
            <RoleRow
              key={role.id}
              role={role}
              onOpen={() => setEditing({ id: role.id, path: role.path, draft: toDraft(role) })}
              onDelete={() => removeRole(role)}
            />
          ))}
        </Rowset>
      </Rows>

      {!blank && (
        <WhereTo>
          A profile is filed like a skill or a machine, so sharing one uses the same sheet.{" "}
          <b>The team is the only thing that makes one a manager</b>.
        </WhereTo>
      )}
    </Section>
  );
}

/**
 * A draft with both inheritance switches stated as a plain boolean.
 *
 * `boolean | null | undefined` on `NewRole`, because the API takes all three
 * and reads the absent two as *leave whatever is stored alone* — a sound
 * answer for a client that has never heard of these fields, and the wrong one
 * for this editor, which draws a switch per field and has nothing to draw for
 * "no opinion". It drew them **off**, for profiles that load four.
 *
 * So a draft has to have decided. Spelt as an intersection rather than
 * `Required<Pick<…>>`, which would leave `null` in: both of these are
 * questions with two answers by the time they reach a screen. `Settled` is
 * assignable to `NewRole` wherever one is wanted, so this narrows what a draft
 * promises without widening what anything reading one has to handle.
 */
type Settled = NewRole & { includeAlwaysOn: boolean; includeRepoDefaults: boolean };

/**
 * A profile as the form that edits it.
 *
 * Exported because Compute's notice about a removed machine unpins a profile
 * that pointed at it, and `update_role` takes the whole object: sending a
 * partial one would quietly blank every field it left out.
 *
 * **That hazard fired.** The two inheritance switches were added to `Role` and
 * to `NewRole` and not to here, so every existing profile opened with both off
 * — "It loads no skills from Firetower", over a button offering to save it that
 * way — and `Machines.tsx` sent the same gap with nobody at the keyboard. The
 * fields were optional on `NewRole`, so nothing failed. `role-draft.test.ts`
 * is what makes the next one fail instead of ship: it walks a `Role` whose
 * every field is enumerated by the type checker and insists each one is either
 * carried here or named as deliberately dropped.
 */
export function toDraft(r: Role): Settled {
  return {
    name: r.name,
    does: r.does,
    placement: r.placement,
    agent: r.agent ?? null,
    machine: r.machine ?? null,
    account: r.account ?? null,
    settings: r.settings ?? {},
    instructions: r.instructions,
    canDelegate: r.canDelegate,
    delegateScope: r.delegateScope ?? [],
    skillScope: r.skillScope ?? [],
    includeAlwaysOn: r.includeAlwaysOn,
    includeRepoDefaults: r.includeRepoDefaults,
    directory: null,
  };
}

/**
 * Fields of a `Role` that `toDraft` deliberately does not carry, and why.
 *
 * The server owns every one of them: four are identity or timestamps, two are
 * the answers to "may I" that the request is checked against rather than told,
 * and `isDefault` is set by its own endpoint so that setting one profile's can
 * unset another's. Exported for `role-draft.test.ts`, which treats anything
 * absent from a draft and absent from here as a field somebody forgot.
 */
export const SERVER_OWNED = [
  "id",
  "path",
  "createdAt",
  "updatedAt",
  "mayWrite",
  "mayShare",
  "isDefault",
] as const satisfies readonly (keyof Role)[];

/** One role in the list: its name, what it does, and the shape of it as chips. */
function RoleRow({
  role,
  onOpen,
  onDelete,
}: {
  role: Role;
  onOpen: () => void;
  onDelete: () => void;
}) {
  /* Named rather than lumped in with the unknown: labelling *anything*
     unrecognised as "lead picks where" is the same mistake as offering it as a
     choice — saying something definite about a value you do not know.

     An open machine is said and a pinned one is not. Committed is the ordinary
     case and spends no words; open is the exception, and the exception is the
     only thing worth a word on a list that is mostly read. */
  const place =
    role.placement === "here"
      ? "same workspace"
      : role.placement === "new"
        ? role.machine
          ? "new workspace"
          : "new workspace, any machine"
        : role.placement === "lead"
          ? "wherever the lead decides"
          : role.placement;
  const agent = role.agent as Agent | null;
  /* The glyph slot is already the engine's, so a changed glyph is read in
     place: a dashed ring among solid marks is the most scannable thing on the
     row and costs no width. Its accessible name carries the words, since the
     mark is the only thing carrying them. */
  const engine = agent ? `Engine: ${AGENT_LABEL[agent] ?? agent}` : "Engine: whichever the lead is running";

  return (
    /* One row, as every other pane draws one: the mark, the name over what it
       does, then the quiet facts on the right. The chips were three coloured
       blocks per row on a list that is mostly read. */
    <div className="r">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3.5 text-left">
        <span className="g" role="img" aria-label={engine} title={engine}>
          {agent ? <AgentMark agent={agent} size={16} /> : <CircleDashed className="h-4 w-4" strokeWidth={1.75} />}
        </span>
        <span className="tx">
          <b>{role.name}</b>
          <s>{role.does}</s>
        </span>
      </button>
      {role.canDelegate && <Badge>can delegate</Badge>}
      {role.isDefault && (
        <span className="said flex items-center gap-1">
          <Star className="h-3 w-3" strokeWidth={1.75} />
          default
        </span>
      )}
      <span className="said">{place}</span>
      {/* Where it is filed, which is also who else has it. "Only you" is the
          same fact said the way a person would say it. */}
      <span className="path">{role.mayWrite ? role.path : `${role.path} · shared with you`}</span>
      {role.mayWrite && (
        <IconButton
          of={Trash2}
          onClick={onDelete}
          label={`Delete ${role.name}`}
          hint="Delete profile"
          className="hov hover:text-brick"
        />
      )}
    </div>
  );
}

/** A small fact about a role, in the list. */
function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-raise px-1.5 py-0.5 text-micro text-mute">
      {children}
    </span>
  );
}

/**
 * A profile you may read and not change.
 *
 * The same facts the editor holds, as text — no fields, no Save, and nothing
 * greyed out. The line at the foot is the *where-this-lives note*: a boundary
 * read as a boundary rather than as a refusal, which is the same move People
 * and Teams make for the administration site.
 */
function Reading({ role, onClose }: { role: Role; onClose: () => void }) {
  const place =
    role.placement === "own" ? "its own workspace" : role.placement === "here" ? "the lead's workspace" : "wherever the lead decides";
  const agent = role.agent as Agent | null;
  const named = (ids: string[]) => ids.length;

  return (
    <Section
      title={role.name}
      note={role.does}
      action={
        <button onClick={onClose} className="btn plain">
          All profiles
        </button>
      }
    >
      <div className="space-y-5 px-3.5 py-4">
        <Reads label="Runs in">{place}</Reads>
        <Reads label="Agent">
          {agent ? (
            <span className="inline-flex items-center gap-1.5">
              <AgentMark agent={agent} size={13} className="text-dim" />
              {AGENT_LABEL[agent]}
            </span>
          ) : (
            "whichever the lead is running"
          )}
        </Reads>
        <Reads label="Hands work off">
          {role.canDelegate ? `yes — to ${named(role.delegateScope)} profile${named(role.delegateScope) === 1 ? "" : "s"}` : "no"}
        </Reads>
        {/* **One sentence, in all three places** — here, the editor's label
            and its empty note. "Skills it may read" and "whatever the
            workspace has" were both wrong twice over: a workspace has no
            skills, sessions do, and two in one workspace already carry
            different sets; and under a union nothing is "may" — the profile
            names a set. What it loads is said as what it loads. */}
        <Reads label="Skills it loads">{loadsWhat(role)}</Reads>
        {role.instructions.trim() && (
          <Reads label="Instructions">
            <span className="block whitespace-pre-wrap text-text">{role.instructions.trim()}</span>
          </Reads>
        )}
      </div>

      <p className="border-t border-line-soft px-3.5 py-3 text-meta text-mute">
        Shared with you. It is changed by whoever owns it, in the directory it is filed in — <span className="font-mono">{role.path}</span>.
      </p>
    </Section>
  );
}

/**
 * What a profile loads, for somebody who cannot open it.
 *
 * The sources it is drawing from rather than a number, because the number is
 * per viewer — `skill_defaults` is keyed on `user_id`, so a profile shared
 * through a directory resolves against whoever starts it, and a count taken
 * from this reader's library would be a different person's answer. The editor,
 * which can resolve against a repository, is where the figure lives.
 */
function loadsWhat(role: Role): string {
  const parts: string[] = [];
  if (role.includeAlwaysOn) parts.push("your always-on set");
  if (role.includeRepoDefaults) parts.push("this repository's defaults");
  const named = role.skillScope.length;
  if (named > 0) parts.push(`${named} named`);
  if (parts.length === 0) return "nothing — both sources are off and nothing is named";
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** One fact and its name, in the shape the rest of the pane reads in. */
function Reads({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-[9.5rem] shrink-0 text-ui text-dim">{label}</span>
      <span className="min-w-0 flex-1 text-ui text-bone">{children}</span>
    </div>
  );
}

/**
 * The three fields read back as one sentence: what a child actually gets.
 *
 * Open on all three is its own sentence rather than three clauses of "whatever
 * the lead asks for", which is the same fact said three times.
 */
export function whatAChildGets(
  draft: NewRole,
  machines: { id: string; label: string }[],
): ReactNode {
  const open = draft.placement === "lead" && !draft.machine && !draft.agent;
  if (open)
    return (
      <>
        A child gets whatever the lead asks for: <b>its workspace, its machine, its engine</b>.
      </>
    );
  const place =
    draft.placement === "here"
      ? "the lead's own workspace"
      : draft.placement === "new"
        ? "a workspace of its own"
        : "whichever workspace the lead asks for";
  const machine =
    draft.placement === "here"
      ? ""
      : machines.length === 0
        ? ", on the first machine you add"
        : draft.machine
          ? `, on ${machines.find((m) => m.id === draft.machine)?.label ?? "a pinned machine"}`
          : ", on a machine the lead names or Firetower picks";
  const engine = draft.agent
    ? `, running ${AGENT_LABEL[draft.agent as Agent] ?? draft.agent}`
    : ", running the engine the lead names";
  return (
    <>
      A child gets <b>{place + machine + engine}</b>.
    </>
  );
}

/**
 * Whether a pinned subscription still fits the engine a draft now names — and
 * so whether the form may drop it.
 *
 * **`answered` is the whole of it.** `useAccounts()` reads `[]` while its query
 * is in flight, so reconciling against the list before it lands finds every pin
 * absent: a profile opened from a cold cache lost a deliberate pick to *Your
 * default*, with nothing said, and Save wrote the loss back. An unanswered list
 * is not an answer and keeps the pin. An *answered* empty one is a real answer
 * — no usable subscription for this engine — and a stale pin still comes off,
 * which is why this reads the query's own state rather than inferring it from
 * the array's length.
 */
export function pinnedAccountFits(
  account: string,
  agent: NewRole["agent"],
  accounts: Account[],
  answered: boolean,
): boolean {
  if (!answered) return true;
  return accounts.some((a) => a.id === account && a.kind === agent && usable(a));
}

function Editor({
  state,
  all,
  onClose,
}: {
  state: { id?: string; path?: string; draft: NewRole };
  all: Role[];
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<NewRole>(state.draft);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const cache = useQueryClient();
  const confirm = useConfirm();
  const existing = !!state.id;

  // The default is its own action, saved the instant it is flipped rather than
  // on "Save changes" — it is a fact about this person, not a field of the
  // profile, and only one profile can hold it.
  const [isDefault, setIsDefault] = useState(
    () => all.find((r) => r.id === state.id)?.isDefault ?? false,
  );
  const [defaulting, setDefaulting] = useState(false);
  const toggleDefault = async () => {
    if (!state.id) return;
    const next = !isDefault;
    setDefaulting(true);
    setTrouble(null);
    try {
      await setDefaultRole(state.id, { on: next });
      setIsDefault(next);
      await cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
    } catch (e) {
      setTrouble(why(e));
    } finally {
      setDefaulting(false);
    }
  };

  // The agents to pin to are the ones Firetower can actually drive, read from
  // the server rather than listed here — so a fourth or a tenth agent turns up
  // in this menu the moment it is supported, without a change to this screen.
  const agents = useAgents();
  const agentOptions: Opt[] = agents.data
    .filter((a) => a.supported)
    .map((a) => ({
      value: a.kind as string | null,
      icon: <AgentMark agent={a.kind} size={16} />,
      label: a.label,
    }));
  // A role may already pin an agent that is no longer on offer; keep it
  // nameable rather than dropping the pin.
  if (draft.agent && !agentOptions.some((o) => o.value === draft.agent)) {
    const pinned = draft.agent as Agent;
    agentOptions.push({
      value: pinned,
      icon: <AgentMark agent={pinned} size={16} />,
      label: AGENT_LABEL[pinned] ?? pinned,
    });
  }

  /* The machines its own workspace can be pinned to, and the directories it
     can be filed in at creation — both read from the server, both optional.

     A row rather than a pill, which is the one place this form departs from the
     drawing (`desktop-redesign.html:4454` draws `pk("build-01", "32 vCPU · 64
     GB")`). A machine carries four facts — what it is called, what it is, how
     it is, and whether the pinned engine runs there — and the list is
     unbounded where the engines are four. So Machine takes the drawing's
     *other* idiom, `.pickrows` / `.pr2` (`:1747`), which is already how it
     draws a list of agents with a reason against each. */
  const { data: hosts } = useHosts();
  const machineRows = machines(hosts)
    .map((m) => ({ m, host: m.hosts[0] }))
    .filter((x) => !!x.host)
    .map((x) => ({
      id: x.host!.id,
      label: machineLabel(x.m),
      /* What you would choose by, as the host card says it: cores, memory,
         and how the machine itself is — "ready", "not answering". */
      says: [
        x.host!.cpus ? `${x.host!.cpus} cores` : null,
        x.host!.memoryMb ? `${Math.round(x.host!.memoryMb / 1024)} GB` : null,
        stateLabel(x.host!),
      ]
        .filter(Boolean)
        .join(" · "),
    }));
  /* Whether the engine this profile pins runs on a given machine — the same
     question the person-facing picker asks (`WhereItRuns.tsx:266`). With the
     engine open there is nothing to ask, and nothing is said. */
  const pinnedEngine = agents.data.find((a) => a.kind === draft.agent);
  const runsThere = (host: string) => (pinnedEngine ? canRun(pinnedEngine, host) : null);
  // The subscriptions it can run its engine on — the owner's own plus any lent
  // to them — narrowed to the chosen engine, since an account is per-engine.
  const { data: accounts, loading: accountsLoading } = useAccounts();
  /* The owner's default first, as a choice of its own rather than the absence
     of one. `account: null` has always meant "the owner's default for the
     engine, resolved when it launches" on the wire, and it is what every
     agent-authored profile has — but this form required a concrete id, so a
     profile pinned the subscription that *was* the default and went on
     pointing at it after somebody changed which one that is. */
  const accountOptions: Opt[] = [
    {
      value: null,
      icon: <UserRound className="h-4 w-4" strokeWidth={1.75} />,
      label: `Your default for ${draft.agent ? (AGENT_LABEL[draft.agent as Agent] ?? draft.agent) : "it"}`,
      note: "resolved when it launches",
    },
    ...accounts
      .filter((a) => a.kind === draft.agent && usable(a))
      .map((a) => ({
        value: a.id as string | null,
        icon: <KeyRound className="h-4 w-4" strokeWidth={1.75} />,
        label: a.name,
        note: a.ownerName ? `${a.ownerName}'s subscription` : quota(a),
      })),
  ];
  /* Whether there is a concrete one to offer at all, which is what decides
     between the picker and the sentence under it. */
  const connected = accountOptions.length > 1;

  // The run controls the chosen engine offers — model, effort, permissions,
  // sandbox. A profile may pin any of them or leave each on the engine's own
  // default; what it pins becomes the child's starting settings. Read per
  // engine, so the pickers match whatever that agent actually supports.
  const controlsQ = useAgentControls(draft.agent ?? "", { query: { enabled: !!draft.agent } });
  const controls = (draft.agent ? (controlsQ.data ?? []) : []) as Control[];

  const { data: dirs } = useDirectories();
  const dirOptions: Opt[] = [
    { value: null, icon: <User className="h-4 w-4" strokeWidth={1.75} />, label: "Yours", note: "Only you, until you share it." },
    ...dirs
      .filter((d) => d.level === "writer" || d.level === "admin")
      .map((d) => ({
        value: d.id,
        icon: <FolderGit2 className="h-4 w-4" strokeWidth={1.75} />,
        label: d.name,
      })),
  ];

  // What this profile can be scoped to reach — other profiles, and skills —
  // each tagged with the directory it's filed in so the picker can group them.
  const groupOf = (path: string) => {
    const [root, label] = path.split("/");
    return root === "u" ? "yours" : `d/${label}`;
  };
  const delegationItems: ScopeItem[] = all
    .filter((r) => r.id !== state.id)
    .map((r) => ({
      id: r.id,
      name: r.name,
      desc: r.does,
      group: groupOf(r.path),
      badge: r.canDelegate ? { text: "manager", tone: "sage" } : undefined,
    }));

  /* Where this profile is filed decides whether the Skills section's count is
     "yours" or everybody's: a profile in a directory is used by colleagues, and
     the first two of its three sources resolve against whoever starts it. */
  const shared = existing ? !!state.path?.startsWith("d/") : !!draft.directory;
  const skills = useSkillSources(draft, shared);

  const set = <K extends keyof NewRole>(k: K, v: NewRole[K]) => setDraft((d) => ({ ...d, [k]: v }));
  // Pin one run control, or clear it back to the engine's default (null).
  const setSetting = (kind: ControlKind, v: string | null) =>
    setDraft((d) => {
      const next = { ...(d.settings ?? {}) };
      if (v == null) delete next[kind];
      else next[kind] = v;
      return { ...d, settings: next };
    });
  const refresh = () => cache.invalidateQueries({ queryKey: getListRolesQueryKey() });

  /* Placement, and the machine that may no longer mean anything.
     *Same workspace* is the one placement where a machine can never apply — a
     child there runs wherever its lead does — so the pin comes off with the
     press. Nothing cleared it before, which is why the Machines screen's list
     of "profiles pinned to that machine" held two populations at once: ones
     where unpinning is what that button says, and `here` ones carrying a
     machine that had stopped meaning anything. Not an effect: a press is one
     change, and an effect that rewrites a field after a render is what made
     the last pill here unpressable. */
  const setPlacement = (to: string) =>
    setDraft((d) => ({ ...d, placement: to, machine: to === "here" ? null : d.machine }));

  /* **Three effects used to live here and all three are gone**, with the pills
     that make them wrong:

     - one force-picked the first engine on the list, so a new profile was
       pinned to an engine nobody chose;
     - one force-picked the first machine whenever the placement was `new`,
       for the same reason and with the same result;
     - one coerced any placement that was not `here` or `new` back to `here`
       on every render, which is why *Let the lead choose* could not stay
       pressed the last time somebody drew it.

     They have to go in the same commit as their pills, not before and not
     after: either half alone reproduces the defect for its field. What is left
     below is the one effect that is still true — a pin for one engine means
     nothing to another. */

  // A subscription belongs to one engine, so when the engine changes (or the
  // list loads) drop a pick that no longer fits. Not keyed on the account
  // itself, so a manual pick sticks — and it falls back to the owner's default
  // (`null`) rather than to whichever account happens to be first, which is now
  // a choice the form can actually offer.
  useEffect(() => {
    if (draft.account && !pinnedAccountFits(draft.account, draft.agent, accounts, !accountsLoading))
      set("account", null);
  }, [draft.agent, accounts, accountsLoading]);

  /* Run controls are per-engine, so a pin for one agent means nothing to
     another. When the person switches engines — *including to no engine at
     all* — drop the pins, but not on the first render, where an existing
     profile is loading its own. A ref remembers the last engine to tell the
     two apart.

     What came off is said rather than left to be noticed: `dropped` feeds the
     sentence that stands where Subscription and How it runs were, because
     clearing is invisible and silently discarding a value is the whole bug
     this screen is being changed for. */
  const lastAgent = useRef(draft.agent);
  const [dropped, setDropped] = useState<{ account: boolean; settings: number } | null>(null);
  useEffect(() => {
    if (lastAgent.current !== undefined && lastAgent.current !== draft.agent) {
      if (draft.agent === null) {
        setDropped({
          account: !!draft.account,
          settings: Object.values(draft.settings ?? {}).filter((v) => v != null).length,
        });
      } else {
        setDropped(null);
      }
      set("settings", {});
    }
    lastAgent.current = draft.agent;
  }, [draft.agent]);

  /* What a profile cannot do without, and nothing more. `valid` used to want
     an engine, a subscription and a machine-when-new, and all three are now
     legal as absent — the subscription always was (`api/roles.rs:25`: "Absent
     is fine — it means the owner's default at launch"), which made Save dead
     with nothing on screen saying which field was holding it. */
  const valid = draft.name.trim().length > 0 && draft.does.trim().length > 0;

  const save = async () => {
    setBusy(true);
    setTrouble(null);
    try {
      const body: NewRole = { ...draft, agent: draft.agent || null };
      if (existing) await updateRole(state.id!, body);
      else await createRole(body);
      await refresh();
      onClose();
    } catch (e) {
      setTrouble(why(e));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!state.id) return;
    const ok = await confirm({
      title: `Delete "${draft.name}"?`,
      body: "You can no longer start a workspace as it, and leads lose it from their teams. Agents already running are untouched.",
      action: "Delete profile",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteRole(state.id);
      await refresh();
      onClose();
    } catch (e) {
      setTrouble(why(e));
      setBusy(false);
    }
  };

  return (
    <div className="pg">
      <button
        onClick={onClose}
        className="flex items-center gap-1.5 py-1 text-ui text-dim transition-colors hover:text-bone"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
        All profiles
      </button>

      {/* **A heading.** The form opened straight onto "Name", so the screen
          never said which profile you were reading or what a profile is. */}
      <div className="pg-head mt-4">
        <div>
          <h1>{draft.name.trim() || "New profile"}</h1>
          {/* A new one has to say what a profile *is*; an existing one is
              already in front of you and says what it is for. The drawing
              has two ledes and the build was using the second for both. */}
          <p className="sub">
            {existing
              ? "What it is for, what it may do, and who it may hand work to."
              : "A saved way of working. Name it, say what it is for, and decide whether it leads or works."}
          </p>
        </div>
      </div>

      <div className="form">
        <Field label="Name" hint="What you start it as, and what a lead names to delegate to it — e.g. reviewer.">
          <input
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="reviewer"
            className="w-full rounded-md border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-dim focus:outline-none"
          />
        </Field>

        <Field
          label="Description"
          hint="What it does and when to reach for it — the line a lead reads to decide whether to hand it work, like a skill's description. Name the trigger, and the case to skip it."
        >
          <textarea
            value={draft.does}
            onChange={(e) => set("does", e.target.value)}
            rows={2}
            placeholder="Reviews a finished branch and reports problems as file:line. Use after a developer hands back — not for a one-line fix."
            className="w-full resize-y rounded-md border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-dim focus:outline-none"
          />
        </Field>

        <Group
          label="Placement"
          hint="Where a child runs when a lead delegates to it. Pin one and every spawn runs that way. Leave it open and the lead decides."
        >
          {/* **Pills, not a dropdown.** Three placements with a word of
              explanation each is a thing you read once and then point at; a
              select hides two of the three behind whichever is set. */}
          <div className="pickrow">
            {PLACEMENTS.map((p) => (
              <button
                key={p.value}
                type="button"
                aria-pressed={(draft.placement ?? "lead") === p.value}
                onClick={() => setPlacement(p.value)}
                className="pk"
              >
                <span className="ic">
                  <p.icon className="h-4 w-4" strokeWidth={1.75} />
                </span>
                {p.label}
                {p.note && <span className="sub">{p.note}</span>}
              </button>
            ))}
          </div>
        </Group>

        {/* Shown whenever the child *could* get a workspace of its own — its
            own, or the lead's to decide — and hidden only on *Same workspace*,
            the one case where a machine can never apply. A profile may pin a
            machine while leaving the placement open, which is a coherent thing
            to want: wherever the lead likes, but if it gets a workspace of its
            own it is on that machine. */}
        {draft.placement !== "here" && (
          <Group
            label="Machine"
            hint={
              draft.placement === "new"
                ? "Which machine its own workspace runs on. Pin one and every spawn runs there. Leave it open and the lead decides."
                : "Only reached if the lead gives it a workspace of its own — otherwise it runs wherever the lead does. Pin one, or leave it open and the lead decides."
            }
          >
            {machineRows.length > 0 ? (
              <>
                <div className="pickrows">
                  <button
                    type="button"
                    aria-pressed={(draft.machine ?? null) === null}
                    onClick={() => set("machine", null)}
                    className="pr2"
                  >
                    <span className="g">
                      <CircleDashed className="h-[17px] w-[17px]" strokeWidth={1.75} />
                    </span>
                    <span className="tx">
                      <b>{OPEN}</b>
                      <s>{OPEN_FALLBACK.machine}</s>
                    </span>
                    {(draft.machine ?? null) === null && (
                      <span className="g tick">
                        <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                      </span>
                    )}
                  </button>
                  {machineRows.map((m) => {
                    const ok = runsThere(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={draft.machine === m.id}
                        data-off={ok === false ? "true" : undefined}
                        onClick={() => set("machine", m.id)}
                        className="pr2"
                      >
                        <span className="g">
                          <Server className="h-[17px] w-[17px]" strokeWidth={1.75} />
                        </span>
                        <span className="tx">
                          <b>{m.label}</b>
                          <s>{m.says}</s>
                        </span>
                        {/* Marked rather than hidden, as every other picker
                            marks it: gone from a list looks like gone. */}
                        {ok === false && (
                          <span className="why">
                            {AGENT_LABEL[draft.agent as Agent] ?? draft.agent} is not installed
                            there
                          </span>
                        )}
                        {draft.machine === m.id && (
                          <span className="g tick">
                            <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {/* Whether a machine can run an engine depends on which engine,
                    and this profile leaves that open — so the column that would
                    say so is honestly missing rather than quietly absent. */}
                {draft.agent === null && (
                  <div className="inform">
                    <p>
                      Whether a machine can run an engine depends on which engine, and this profile
                      leaves that open. The lead is told at launch, not here.
                    </p>
                  </div>
                )}
              </>
            ) : (
              /* Not the pickers' "No machine to run on" block: a profile with
                 no machine is a state this screen produces and handles — the
                 lead names one, or Firetower picks — so this is information
                 rather than something in the way. */
              <div className="inform">
                <p>
                  <b>No machines yet.</b> That leaves this open, so a lead may name one and
                  Firetower picks otherwise — from whichever machines exist by then. Agents run on
                  a machine you add over ssh; Firetower does not run them on itself.
                </p>
                <button
                  type="button"
                  onClick={() => navigate("/configuration/machines/add")}
                  className="btn plain"
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                  Add a machine
                </button>
              </div>
            )}
          </Group>
        )}

        <Group
          label="Agent"
          hint="Which engine it runs on. Pin one and every spawn uses it. Leave it open and the lead decides."
        >
          {/* One flat row, the open answer first: having pressed *pin an
              engine* the only thing left to say is which, so a two-step would
              be a mode that carries no information. It also makes Agent read
              exactly like Placement and Machine, which is the one thing this
              change is for — `desktop-redesign.html:4458` draws it this way. */}
          <div className="pickrow">
            <button
              type="button"
              aria-pressed={(draft.agent ?? null) === null}
              onClick={() => set("agent", null)}
              className="pk"
            >
              <span className="ic">
                <CircleDashed className="h-4 w-4" strokeWidth={1.75} />
              </span>
              {OPEN}
              <span className="sub">{OPEN_FALLBACK.agent}</span>
            </button>
            {agentOptions.map((o) => (
              <button
                key={o.value ?? "__open"}
                type="button"
                aria-pressed={draft.agent === o.value}
                onClick={() => set("agent", o.value)}
                className="pk"
              >
                <span className="ic">{o.icon}</span>
                {o.label}
              </button>
            ))}
          </div>
        </Group>

        {/* A subscription belongs to one engine, so with the engine open there
            is nothing this field could hold: a visible picker here could only
            produce a refusal. It leaves, and the sentence below says why. */}
        {draft.agent !== null && (
          <Group
            label="Subscription"
            hint="Which subscription its engine authenticates with when it runs."
          >
            {connected ? (
              <div className="pickrow">
                {accountOptions.map((o) => (
                  <button
                    key={o.value ?? "__default"}
                    type="button"
                    aria-pressed={(draft.account ?? null) === o.value}
                    onClick={() => set("account", o.value)}
                    className="pk"
                  >
                    <span className="ic">{o.icon}</span>
                    {o.label}
                    {o.note && <span className="sub">{o.note}</span>}
                  </button>
                ))}
              </div>
            ) : (
              <div className="inform">
                <p>
                  <b>
                    No subscription connected for{" "}
                    {AGENT_LABEL[draft.agent as Agent] ?? draft.agent}.
                  </b>{" "}
                  You can save this profile — it will run on your default for{" "}
                  {AGENT_LABEL[draft.agent as Agent] ?? draft.agent} once one exists. A child
                  started before then is refused at launch, with nothing to authenticate with.
                </p>
                <button
                  type="button"
                  onClick={() => navigate("/configuration/agents")}
                  className="btn plain"
                >
                  <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} />
                  Connect {AGENT_LABEL[draft.agent as Agent] ?? draft.agent}
                </button>
              </div>
            )}
          </Group>
        )}

        {controls.length > 0 && (
          <Group
            label="How it runs"
            hint="Pin the model and run settings, or leave any on the engine's default. These override what you last used when a workspace starts as this profile."
          >
            <div className="flex flex-col gap-3">
              {controls.map((c) => {
                const Icon = CONTROL_ICON[c.kind];
                const options: Opt[] = [
                  {
                    value: null,
                    icon: <Icon className="h-4 w-4" strokeWidth={1.75} />,
                    label: "Engine default",
                    note: "Whatever the agent starts on.",
                  },
                  ...c.choices.map((ch) => ({
                    value: ch.value,
                    icon: <Icon className="h-4 w-4" strokeWidth={1.75} />,
                    label: ch.label,
                    note: ch.note ?? undefined,
                  })),
                ];
                return (
                  <div key={c.kind} className="flex flex-col gap-1.5">
                    <span className="text-micro font-medium text-mute">{c.fallback}</span>
                    <Select
                      ariaLabel={c.fallback}
                      value={draft.settings?.[c.kind] ?? null}
                      options={options}
                      onChange={(v) => setSetting(c.kind, v)}
                    />
                  </div>
                );
              })}
            </div>
          </Group>
        )}

        {/* **What stands where Subscription and How it runs were.**
            They do not grey out and they do not linger: they leave. Under a
            flat engine row that is not self-evidently cause and effect — the
            four engines stay put and two fields below move — so this says why
            they went, *and names what came off with them*. Clearing is
            otherwise invisible, and silently discarding a value somebody chose
            is the bug this whole screen is being changed for. */}
        {draft.agent === null && (
          <div className="fld">
            <div className="inform">
              <p>
                <b>Subscription and run settings belong to an engine</b>, so a profile that leaves
                the engine open carries neither. A child gets your default subscription for
                whatever engine it runs, on that engine's own settings.
                {dropped && (dropped.account || dropped.settings > 0) && (
                  <>
                    {" "}
                    Its{" "}
                    {[
                      dropped.account ? "pinned subscription" : null,
                      dropped.settings > 0
                        ? `${dropped.settings} run setting${dropped.settings === 1 ? "" : "s"}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" and ")}{" "}
                    came off with the engine.
                  </>
                )}
              </p>
            </div>
          </div>
        )}

        {/* One sentence reading the three fields back as what a spawn gets.
            The bug behind all of this is a lead reporting a build that never
            happened; a form that says what a spawn will be is the cheapest
            guard there is. */}
        <WhereTo>{whatAChildGets(draft, machineRows)}</WhereTo>

        <Group
          label="Delegation"
          hint="A Manager may hand work to any profile it can reach. Which one, and when, goes in the instructions below."
        >
          <Select
            ariaLabel="Delegation"
            value={draft.canDelegate ? "manager" : "operator"}
            options={[
              {
                value: "operator",
                icon: <User className="h-4 w-4" strokeWidth={1.75} />,
                label: "Operator",
                note: "Does the work and reports back. Can't delegate.",
              },
              {
                value: "manager",
                icon: <Users className="h-4 w-4" strokeWidth={1.75} />,
                label: "Manager",
                note: "Can hand work to any profile it can reach.",
              },
            ]}
            onChange={(v) => set("canDelegate", v === "manager")}
          />
        </Group>

        {draft.canDelegate && (
          <ScopePicker
            label="Can delegate to"
            hint="The subagents this Manager may hand work to. Anything off the list it can't see at all."
            items={delegationItems}
            selected={draft.delegateScope ?? []}
            onChange={(ids) => set("delegateScope", ids)}
            searchPlaceholder="Search profiles…"
            allNote="Any profile you can reach — and any you add later."
          />
        )}

        <SkillSources r={skills} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />

        <Field label="Instructions" hint="Composed into its prompt. Markdown; the agent reads all of it. A Manager names its delegates here.">
          <textarea
            value={draft.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            rows={10}
            placeholder={"# Reviewer\n\nYou review. You do not fix.\n\n## How to work\n- Read the diff and the tests first.\n- Report problems as `path:line — what, why`.\n\n## Don't\n- Don't edit files. Don't push."}
            className="scroll-slim w-full resize-y rounded-md border border-line bg-ground px-3 py-2 font-mono text-code leading-relaxed text-text placeholder:text-mute focus:border-dim focus:outline-none"
          />
        </Field>

        {existing ? (
          <>
            <Field label="Who can use it" hint="A profile in a directory can be used by anyone who can reach it.">
              <WhoCanAccess kind="role" id={state.id!} path={state.path} look="chip" />
            </Field>
            <Field
              label="Default"
              hint="Start new workspaces as this profile unless you pick another. Only one profile can be the default."
            >
              <button
                type="button"
                role="switch"
                aria-checked={isDefault}
                onClick={toggleDefault}
                disabled={defaulting}
                className={`flex items-center gap-2.5 rounded-md border px-3 py-2 text-left text-ui transition-colors disabled:opacity-60 ${
                  isDefault
                    ? "border-sage-deep bg-sage-tint text-sage"
                    : "border-line bg-ground text-dim hover:border-dim hover:text-bone"
                }`}
              >
                <span
                  className={`grid h-4 w-4 place-items-center rounded-full border ${
                    isDefault ? "border-sage bg-sage text-ground" : "border-mute"
                  }`}
                >
                  {isDefault && <Check className="h-3 w-3" strokeWidth={3.5} />}
                </span>
                {isDefault ? "Your default for new workspaces" : "Make this the default"}
              </button>
            </Field>
          </>
        ) : (
          <Group
            label="Where it lives"
            hint="Keep it yours, or file it in a directory so your team can use it too."
          >
            <Select
              ariaLabel="Where it lives"
              value={draft.directory ?? null}
              options={dirOptions}
              onChange={(v) => set("directory", v)}
            />
          </Group>
        )}

        {trouble && (
          <p className="rounded-md border border-brick-deep bg-brick-tint px-3 py-2 font-mono text-meta text-brick">
            {trouble}
          </p>
        )}

        {/* **`.formfoot`, and the message first.** It was a plain row with
            the primary at the left and no sentence at all, so the one thing
            worth knowing before you press — that nothing exists until you
            do — was nowhere on the screen. The primary is the ordinary pill:
            a sage-tinted button here said "this went well", which is a
            verdict about something that has not happened yet. */}
        <div className="formfoot">
          {/* The Skills section has first claim on this line: an over-budget
              profile starts with *no* skills at all on Codex, and one with
              both sources off and nothing named is a child that cannot even
              publish an artifact. Both are worth more than the standing note. */}
          <span className={`msg${skills.ownOver ? " bad" : skills.over || skills.loads.length === 0 || skills.skipped.length || skills.clashes.length ? " warn" : ""}`}>
            {skills.ownOver
              ? `Over ${skills.agentLabel}'s limit before this repository's defaults are counted — ${skills.ownSpend.toLocaleString("en-US")} of ${skills.budget.toLocaleString("en-US")}.`
              : skills.over
                ? `Over budget in ${skills.at?.split("/").pop() ?? "this repository"} — ${skills.spend.toLocaleString("en-US")} of ${skills.budget.toLocaleString("en-US")}. Another repository may fit.`
                : skills.loads.length === 0
                  ? "This child will have no Firetower skills at all."
                  : skills.clashes.length
                    ? `${skills.clashes.length === 1 ? "Two skills share the name" : "Skills share the names"} ${skills.clashes.map((g) => g[0].name).join(", ")} — ${skills.clashes.length === 1 ? "neither is sent" : "none is sent"}.`
                    : skills.skipped.length
                      ? `${skills.skipped.length} skill${skills.skipped.length === 1 ? "" : "s"} ${skills.skipped.length === 1 ? "has" : "have"} no approved version and will be skipped.`
                      : existing
                        ? "Saved when you press it. Running workspaces keep the profile they started with."
                        : "Nothing is created until you press this."}
          </span>
          {existing && (
            <button onClick={remove} disabled={busy} className="btn danger">
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              Delete
            </button>
          )}
          <button onClick={onClose} className="btn quiet">
            Cancel
          </button>
          {/* Over budget on always-on and the named list *alone* is broken
              under every checkout, so there is nothing to save. Where only a
              repository's defaults tip it over, that depends on a checkout
              nobody has made, so it warns and allows. */}
          <button onClick={save} disabled={!valid || busy || skills.ownOver} className="btn primary">
            {skills.ownOver
              ? "Can't save"
              : skills.loads.length === 0
                ? existing
                  ? "Save with no skills"
                  : "Create with no skills"
                : existing
                  ? "Save changes"
                  : "Create profile"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A labelled input, with its hint **above** the control.
 *
 * The hint sat underneath, which puts the explanation after the decision —
 * and in a form of eight fields it reads as a footnote to the thing above
 * rather than an introduction to the thing below. The drawing's `.fld` has
 * label, hint, box, in that order.
 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="fld">
      <span>{label}</span>
      {hint && <span className="hint">{hint}</span>}
      {children}
    </label>
  );
}

/**
 * Field, for a group of buttons rather than one input.
 *
 * The same heading and hint, but a `div` with a labelled group — a `label`
 * around a set of buttons hands every click to the first one, which is wrong
 * for a picker where each tile is its own control.
 */
function Group({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="fld">
      <span>{label}</span>
      {hint && <span className="hint">{hint}</span>}
      {children}
    </div>
  );
}

/**
 * What a Manager can currently hand work to — a reference, not an editor.
 *
 * The team is not a list you curate; it is every profile you can reach, and
 * which to use for what is said in the instructions. So this just names them,
 * so you know what handles exist to write down. It reaches out of the card the
 * way the lead reaches out of its own: by what the person can see.
 */
/** One option in a {@link Select}: what it is worth, and how it reads. */
type Opt = { value: string | null; icon: ReactNode; label: string; note?: string };

/**
 * A dropdown that shows a mark, not just a word.
 *
 * The one control both the Agent and the Placement fields use: a trigger that
 * wears the current choice, and a menu — the app's own `Pop`, so it escapes
 * this card's clipping and matches every other menu — that lists the rest. A
 * dropdown rather than a row of tiles because the list is open-ended: a new
 * supported agent is one more row here, not a reflow of the form.
 */
function Select({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string | null;
  options: Opt[];
  onChange: (v: string | null) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  // Nothing to pick yet — the list is still loading, or there is genuinely
  // nothing. A placeholder rather than a crash on `current.icon`.
  if (!current) {
    return (
      <div className="flex w-full items-center rounded-md border border-line bg-ground px-3 py-2 text-ui text-mute">
        —
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        onClick={(e) => setOpen(open ? null : e.currentTarget)}
        className="flex w-full items-center gap-2.5 rounded-md border border-line bg-ground px-3 py-2 text-left transition-colors hover:border-dim focus:border-dim focus:outline-none"
      >
        <span className="shrink-0 text-dim">{current.icon}</span>
        <span className="min-w-0 flex-1 truncate text-ui text-bone">{current.label}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-mute transition-transform ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      {open && (
        <Pop anchor={open} onClose={() => setOpen(null)} width={open.offsetWidth}>
          <div role="listbox" className="max-h-72 min-h-0 overflow-y-auto py-1">
            {options.map((o) => {
              const on = o.value === value;
              return (
                <button
                  key={o.value ?? "__open"}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(null);
                  }}
                  className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-raise"
                >
                  <span className={`mt-px shrink-0 ${on ? "text-bone" : "text-dim"}`}>{o.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-ui text-bone">{o.label}</span>
                    {o.note && <span className="block text-micro text-mute">{o.note}</span>}
                  </span>
                  <Check
                    className={`mt-px h-4 w-4 shrink-0 ${on ? "text-slate" : "text-transparent"}`}
                    strokeWidth={2.5}
                  />
                </button>
              );
            })}
          </div>
        </Pop>
      )}
    </>
  );
}

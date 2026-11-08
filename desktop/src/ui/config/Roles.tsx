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
import { usable } from "~/api/accounts";
import { ScopePicker, type ScopeItem } from "~/ui/config/ScopePicker";
import { SkillSources, useSkillSources } from "~/ui/config/SkillSources";
import { machineLabel, machines } from "~/api/environments";
import type { Agent, Control, ControlKind, Role, NewRole } from "~/api/generated/model";
import { useConfirm } from "~/ui/Confirm";
import { Badge, IconButton } from "~/components/ui";

/**
 * Where a child runs. **Two, because the server takes two.**
 *
 * A third was added here — *Let the lead choose* — reasoning from
 * `Role.placement`, documented as `lead | here | new`. **That is the response
 * model.** `CreateRoleBody.placement` and `UpdateRoleBody.placement` both say
 * *Required: "here" or "new"*, and `roles.rs` enforces it:
 * `PLACEMENT: [&str; 2] = ["here", "new"]`, refusing anything else with
 * *placement is "here" (the lead's workspace) or "new" (its own)*. So `lead`
 * is **readable and not writable** — a value the server will hand you and
 * will not take back.
 *
 * **A value in a response model is not an option in a request model.** That
 * is the whole mistake, and the comment this replaces made it in writing.
 *
 * What the user saw was not a save-time refusal. The effect below — main's,
 * which already called `lead` retired — coerces any unknown placement to
 * `here` on every render, so pressing *Let the lead choose* snapped the
 * selection straight back to *Same workspace*. A pill that cannot stay
 * pressed is a button that does not work, which is exactly how it was
 * reported.
 *
 * `lead` is still **read**: an older profile may carry it, and a profile you
 * cannot open is worse than one with an option you cannot set.
 */
const PLACEMENTS: { value: string; icon: LucideIcon; label: string; note: string }[] = [
  { value: "here", icon: GitBranch, label: "Same workspace", note: "Shares the lead's directory and branch." },
  { value: "new", icon: GitBranchPlus, label: "Its own workspace", note: "A fresh branch, on the machine you pin below." },
];

/** A mark for each run control, so its picker reads like the others. */
const CONTROL_ICON: Record<ControlKind, LucideIcon> = {
  model: Cpu,
  effort: Gauge,
  mode: ShieldCheck,
  sandbox: Box,
};

/** An empty profile, for a new one. An Operator until made a Manager. */
const BLANK: NewRole = {
  name: "",
  does: "",
  placement: "here",
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
  // rather than left off: absent means on to the server, but an existing
  // profile with a switch *off* has to be able to say so, and a draft that
  // omitted the field could never turn one back off.
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
 * A profile as the form that edits it.
 *
 * Exported because Compute's notice about a removed machine unpins a profile
 * that pointed at it, and `update_role` takes the whole object: sending a
 * partial one would quietly blank every field it left out.
 */
export function toDraft(r: Role): NewRole {
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
    directory: null,
  };
}

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
  /* `lead` is readable and not writable, so a row may still carry it. Named
     rather than lumped in with the unknown: labelling *anything* unrecognised
     as "lead picks where" is the same mistake as offering it as a choice —
     saying something definite about a value you do not know. */
  const place =
    role.placement === "here"
      ? "same workspace"
      : role.placement === "new"
        ? "new workspace"
        : role.placement === "lead"
          ? "lead picks where"
          : role.placement;
  const agent = role.agent as Agent | null;

  return (
    /* One row, as every other pane draws one: the mark, the name over what it
       does, then the quiet facts on the right. The chips were three coloured
       blocks per row on a list that is mostly read. */
    <div className="r">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3.5 text-left">
        <span className="g">
          {agent ? <AgentMark agent={agent} size={16} /> : <UsersRound className="h-4 w-4" strokeWidth={1.75} />}
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

  // The machines its own workspace can be pinned to, and the directories it
  // can be filed in at creation — both read from the server, both optional.
  const { data: hosts } = useHosts();
  const machineOptions: Opt[] = machines(hosts)
    .map((m) => ({ m, host: m.hosts[0]?.id }))
    .filter((x) => !!x.host)
    .map((x) => ({
      value: x.host! as string | null,
      icon: <Server className="h-4 w-4" strokeWidth={1.75} />,
      label: machineLabel(x.m),
    }));
  // The subscriptions it can run its engine on — the owner's own plus any lent
  // to them — narrowed to the chosen engine, since an account is per-engine.
  const { data: accounts } = useAccounts();
  const accountOptions: Opt[] = accounts
    .filter((a) => a.kind === draft.agent && usable(a))
    .map((a) => ({
      value: a.id as string | null,
      icon: <KeyRound className="h-4 w-4" strokeWidth={1.75} />,
      label: a.name,
      note: a.ownerName ? `${a.ownerName}'s subscription` : undefined,
    }));

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

  // Every profile pins an engine, and a new-workspace one pins a machine —
  // there is no open option, so default each to the first on offer the moment
  // it's needed and empty, and let the person change it.
  const firstAgent = agentOptions[0]?.value ?? null;
  useEffect(() => {
    if (!draft.agent && firstAgent) set("agent", firstAgent);
  }, [firstAgent, draft.agent]);
  const firstMachine = machineOptions[0]?.value ?? null;
  useEffect(() => {
    if (draft.placement === "new" && !draft.machine && firstMachine) set("machine", firstMachine);
  }, [draft.placement, draft.machine, firstMachine]);

  /* An older profile may hold the retired `lead` placement — the server will
     hand it back and will not take it, so the draft has to become one of the
     two it accepts. `here` for the same reason `BLANK` uses it: it is the one
     that needs nothing else chosen, and it is the server's own fallback when
     nothing says otherwise (`delegate.rs` defaults an open placement to
     `here`).

     **This is why the third pill did not work.** It ran on every render, so
     setting `lead` was undone before the press finished. Main added it when it
     retired the value; the pill was added here afterwards, against the read
     model, and the two have been fighting since. */
  useEffect(() => {
    if (draft.placement !== "here" && draft.placement !== "new") set("placement", "here");
  }, [draft.placement]);

  // A subscription belongs to one engine, so when the engine changes (or the
  // list loads) make the pick a valid one — kept if it still fits, else the
  // engine's default. Not keyed on the account itself, so a manual pick sticks.
  useEffect(() => {
    const forEngine = accounts.filter((a) => a.kind === draft.agent && usable(a));
    if (!forEngine.some((a) => a.id === draft.account)) {
      set("account", (forEngine.find((a) => a.isDefault) ?? forEngine[0])?.id ?? null);
    }
  }, [draft.agent, accounts]);

  // Run controls are per-engine, so a pin for one agent means nothing to
  // another. When the person switches engines, drop the pins — but not on the
  // first render (an existing profile loads its own), nor when a blank draft is
  // handed its first agent. A ref remembers the last engine to tell these apart.
  const lastAgent = useRef(draft.agent);
  useEffect(() => {
    if (lastAgent.current && lastAgent.current !== draft.agent) set("settings", {});
    lastAgent.current = draft.agent;
  }, [draft.agent]);

  const valid =
    draft.name.trim().length > 0 &&
    draft.does.trim().length > 0 &&
    !!draft.agent &&
    !!draft.account &&
    (draft.placement !== "new" || !!draft.machine);

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
          hint="Where a child runs when a lead delegates to it. Every spawn runs the same way."
        >
          {/* **Pills, not a dropdown.** Three placements with a word of
              explanation each is a thing you read once and then point at; a
              select hides two of the three behind whichever is set. */}
          <div className="pickrow">
            {PLACEMENTS.map((p) => (
              <button
                key={p.value ?? "here"}
                type="button"
                aria-pressed={(draft.placement ?? "here") === p.value}
                onClick={() => set("placement", p.value ?? "here")}
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

        {draft.placement === "new" && (
          <Group
            label="Machine"
            hint="Which machine its own workspace runs on."
          >
            {machineOptions.length > 0 ? (
              <div className="pickrow">
                {machineOptions.map((m) => (
                  <button
                    key={m.value ?? "any"}
                    type="button"
                    aria-pressed={(draft.machine ?? null) === m.value}
                    onClick={() => set("machine", m.value)}
                    className="pk"
                  >
                    <span className="ic">{m.icon}</span>
                    {m.label}
                    {m.note && <span className="sub">{m.note}</span>}
                  </button>
                ))}
              </div>
            ) : (
              /* Not the pickers' "No machine to run on" block: a profile with
                 no machine is a state this screen already produces and handles
                 — it runs wherever the workspace that uses it runs — so this
                 is information rather than something in the way. */
              <p className="rounded-md border border-line bg-ground px-3 py-2 text-meta text-mute">
                No machine yet, so this runs wherever the workspace that uses it runs. Add one
                under Compute to pin it.
              </p>
            )}
          </Group>
        )}

        <Group
          label="Agent"
          hint="Which engine it runs on. Every spawn uses it."
        >
          <Select
            ariaLabel="Agent"
            value={draft.agent ?? null}
            options={agentOptions}
            onChange={(v) => set("agent", v)}
          />
        </Group>

        <Group
          label="Subscription"
          hint="Which subscription its engine authenticates with when it runs."
        >
          {accountOptions.length > 0 ? (
            <Select
              ariaLabel="Subscription"
              value={draft.account ?? null}
              options={accountOptions}
              onChange={(v) => set("account", v)}
            />
          ) : (
            <p className="rounded-md border border-line bg-ground px-3 py-2 text-meta text-mute">
              No connected subscription for this agent. Connect one under Accounts.
            </p>
          )}
        </Group>

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
          <span className={`msg${skills.ownOver ? " bad" : skills.over || skills.loads.length === 0 || skills.skipped.length ? " warn" : ""}`}>
            {skills.ownOver
              ? `Over ${skills.agentLabel}'s limit before this repository's defaults are counted — ${skills.ownSpend.toLocaleString("en-US")} of ${skills.budget.toLocaleString("en-US")}.`
              : skills.over
                ? `Over budget in ${skills.at?.split("/").pop() ?? "this repository"} — ${skills.spend.toLocaleString("en-US")} of ${skills.budget.toLocaleString("en-US")}. Another repository may fit.`
                : skills.loads.length === 0
                  ? "This child will have no Firetower skills at all."
                  : skills.skipped.length
                    ? `${skills.skipped.length} named skill${skills.skipped.length === 1 ? "" : "s"} will be skipped.`
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

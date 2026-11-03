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
import { Rows, Section } from "~/ui/config/bits";
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
import { machineLabel, machines } from "~/api/environments";
import type { Agent, Control, ControlKind, Role, NewRole } from "~/api/generated/model";
import { useConfirm } from "~/ui/Confirm";

/** Where a child runs — a profile pins one. No "let the lead choose". */
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
  const cache = useQueryClient();
  const confirm = useConfirm();

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
    return <Editor state={editing} all={rows.data} onClose={() => setEditing(null)} />;
  }

  return (
    <Section
      title="Profiles"
      note="A saved persona any agent can run — a lead, a developer, a reviewer, a QA. Each carries what it does, where it runs, its instructions, and whether it may hand work off."
      action={
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
      }
    >
      <Rows feed={rows} empty="No profiles yet. Make one, and you can start a workspace as it or a lead can delegate to it.">
        {rows.data.map((role) => (
          <RoleRow
            key={role.id}
            role={role}
            onOpen={() => setEditing({ id: role.id, path: role.path, draft: toDraft(role) })}
            onDelete={() => removeRole(role)}
          />
        ))}
      </Rows>
    </Section>
  );
}

function toDraft(r: Role): NewRole {
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
  const place =
    role.placement === "here"
      ? "same workspace"
      : role.placement === "new"
        ? "new workspace"
        : "lead picks where";
  const agent = role.agent as Agent | null;

  return (
    <div className="group flex w-full items-start gap-3 border-b border-line-soft px-3.5 py-3 last:border-0 hover:bg-raise/50">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-3 text-left">
        <UsersRound className="mt-0.5 h-4 w-4 shrink-0 text-mute" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-ui text-bone">{role.name}</span>
            {role.isDefault && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded bg-slate-tint px-1.5 py-0.5 text-micro text-slate">
                <Star className="h-3 w-3" strokeWidth={1.75} />
                default
              </span>
            )}
            {!role.mayWrite && (
              <span className="shrink-0 text-micro text-mute">shared with you</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-meta text-dim">{role.does}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {role.canDelegate && (
              <span className="inline-flex items-center gap-1 rounded bg-sage-tint px-1.5 py-0.5 text-micro text-sage">
                <Users className="h-3 w-3" strokeWidth={1.75} />
                manager
              </span>
            )}
            <Chip>{place}</Chip>
            {agent && (
              <Chip>
                <AgentMark agent={agent} size={11} className="text-dim" />
                {AGENT_LABEL[agent]}
              </Chip>
            )}
          </div>
        </div>
      </button>
      {role.mayWrite && (
        <button
          onClick={onDelete}
          aria-label={`Delete ${role.name}`}
          title="Delete profile"
          className="shrink-0 rounded p-1.5 text-mute transition hover:bg-brick-tint hover:text-brick"
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.75} />
        </button>
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
  const { data: skillList } = useSkills();
  const delegationItems: ScopeItem[] = all
    .filter((r) => r.id !== state.id)
    .map((r) => ({
      id: r.id,
      name: r.name,
      desc: r.does,
      group: groupOf(r.path),
      badge: r.canDelegate ? { text: "manager", tone: "sage" } : undefined,
    }));
  const skillItems: ScopeItem[] = skillList.map((s) => ({
    id: s.id,
    name: s.name,
    desc: s.description,
    group: groupOf(s.path),
    badge: s.risk?.includes("scripts") ? { text: "scripts", tone: "brick" } : undefined,
  }));

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

  // An older profile may hold the retired "lead" placement; coerce it to a
  // concrete one so the draft matches what the picker shows and can be saved.
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
    <div className="px-1 pb-10">
      <button
        onClick={onClose}
        className="flex items-center gap-1.5 px-2.5 py-2.5 text-ui text-dim transition-colors hover:text-bone"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
        Profiles
      </button>

      <div className="space-y-4 px-2.5">
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
          <Select
            ariaLabel="Placement"
            value={draft.placement ?? "here"}
            options={PLACEMENTS.map((p) => ({
              value: p.value,
              icon: <p.icon className="h-4 w-4" strokeWidth={1.75} />,
              label: p.label,
              note: p.note,
            }))}
            onChange={(v) => set("placement", v ?? "here")}
          />
        </Group>

        {draft.placement === "new" && (
          <Group
            label="Machine"
            hint="Which machine its own workspace runs on."
          >
            {machineOptions.length > 0 ? (
              <Select
                ariaLabel="Machine"
                value={draft.machine ?? null}
                options={machineOptions}
                onChange={(v) => set("machine", v)}
              />
            ) : (
              <p className="rounded-md border border-line bg-ground px-3 py-2 text-meta text-mute">
                No machine is connected. Add one under Machines, or use the same workspace.
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
                    <span className="text-micro font-medium uppercase tracking-wide text-mute">{c.fallback}</span>
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

        <ScopePicker
          label="Skills it can load"
          hint="What it may load into context. Off the list means never written to its workspace."
          items={skillItems}
          selected={draft.skillScope ?? []}
          onChange={(ids) => set("skillScope", ids)}
          searchPlaceholder="Search skills…"
          allNote="Any skill you can use — and any you add later."
        />

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

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={save}
            disabled={!valid || busy}
            className="control border border-sage-deep bg-sage-tint font-medium text-sage hover:bg-sage-deep/40 disabled:border-line disabled:bg-raise disabled:text-mute"
          >
            {existing ? "Save changes" : "Create profile"}
          </button>
          <button
            onClick={onClose}
            className="control border border-line bg-raise text-text hover:text-bone"
          >
            Cancel
          </button>
          {existing && (
            <button
              onClick={remove}
              disabled={busy}
              className="control ml-auto border border-line bg-raise text-mute hover:border-brick-deep hover:text-brick"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

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
    <label className="flex flex-col gap-1.5">
      <span className="text-meta font-medium text-dim">{label}</span>
      {children}
      {hint && <span className="text-micro text-mute">{hint}</span>}
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
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <span className="text-meta font-medium text-dim">{label}</span>
      {children}
      {hint && <span className="text-micro text-mute">{hint}</span>}
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
          <div role="listbox" className="max-h-72 overflow-y-auto py-1">
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

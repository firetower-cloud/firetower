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
import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  CornerUpRight,
  GitBranch,
  GitBranchPlus,
  Plus,
  Sparkles,
  Trash2,
  Users,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { Rows, Section } from "~/ui/config/bits";
import { WhoCanAccess } from "~/ui/Sharing";
import { Pop } from "~/ui/Pop";
import { AgentMark, AGENT_LABEL } from "~/components/AgentMark";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListRoles,
  getListRolesQueryKey,
  createRole,
  updateRole,
  deleteRole,
} from "~/api/generated/roles/roles";
import { useAgents, why } from "~/data";
import type { Agent, Role, NewRole } from "~/api/generated/model";
import { useConfirm } from "~/ui/Confirm";

/** The open "let the lead choose" state, as placement stores it. */
const OPEN = "lead";

/** Where a child runs — the fixed set, each with the line that explains it. */
const PLACEMENTS: { value: string; icon: LucideIcon; label: string; note: string }[] = [
  { value: OPEN, icon: Sparkles, label: "Let the lead choose", note: "The lead decides where each child runs." },
  { value: "here", icon: GitBranch, label: "Same workspace", note: "Shares this directory and branch." },
  { value: "new", icon: GitBranchPlus, label: "Its own workspace", note: "A fresh branch off the default." },
];

/** An empty profile, for a new one. Placement and agent start open, no team. */
const BLANK: NewRole = {
  name: "",
  does: "",
  useWhen: "",
  notWhen: "",
  placement: "lead",
  agent: null,
  instructions: "",
  members: [],
};

export function Roles() {
  const feed = useListRoles();
  const rows = {
    data: feed.data ?? [],
    loading: feed.isLoading,
    error: feed.error ? why(feed.error) : null,
  };
  const [editing, setEditing] = useState<{ id?: string; path?: string; draft: NewRole } | null>(
    null,
  );

  if (editing) {
    return <Editor state={editing} all={rows.data} onClose={() => setEditing(null)} />;
  }

  return (
    <Section
      title="Profiles"
      note="A saved persona any agent can run — a lead, a developer, a reviewer, a QA. Each carries what it does, where it runs, its instructions, and the team it may hand work to."
      action={
        <button
          onClick={() => setEditing({ draft: { ...BLANK } })}
          className="control border border-line bg-raise text-ui text-text hover:border-dim hover:text-bone"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          New profile
        </button>
      }
    >
      <Rows feed={rows} empty="No profiles yet. Make one, and you can start a workspace as it or a lead can delegate to it.">
        {rows.data.map((role) => (
          <RoleRow
            key={role.id}
            role={role}
            onOpen={() => setEditing({ id: role.id, path: role.path, draft: toDraft(role) })}
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
    useWhen: r.useWhen,
    notWhen: r.notWhen,
    placement: r.placement,
    agent: r.agent ?? null,
    instructions: r.instructions,
    members: r.members.map((m) => m.id),
  };
}

/** One role in the list: its name, what it does, and the shape of it as chips. */
function RoleRow({ role, onOpen }: { role: Role; onOpen: () => void }) {
  const place =
    role.placement === "here"
      ? "same workspace"
      : role.placement === "new"
        ? "new workspace"
        : "lead picks where";
  const agent = role.agent as Agent | null;

  return (
    <button
      onClick={onOpen}
      className="flex w-full items-start gap-3 border-b border-line-soft px-3.5 py-3 text-left last:border-0 hover:bg-raise/50"
    >
      <UsersRound className="mt-0.5 h-4 w-4 shrink-0 text-mute" strokeWidth={1.75} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-ui text-bone">{role.name}</span>
          {!role.mayWrite && <span className="shrink-0 text-micro text-mute">shared with you</span>}
        </div>
        <p className="mt-0.5 truncate text-meta text-dim">{role.does}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {role.canDelegate && (
            <span className="inline-flex items-center gap-1 rounded bg-sage-tint px-1.5 py-0.5 text-micro text-sage">
              <Users className="h-3 w-3" strokeWidth={1.75} />
              leads {role.members.length}
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

  // The profile as the server last read it — for the inverse "reports to" edge,
  // which is a view of someone else's team rather than something edited here.
  const current = state.id ? all.find((r) => r.id === state.id) : undefined;

  // The agents to pin to are the ones Firetower can actually drive, read from
  // the server rather than listed here — so a fourth or a tenth agent turns up
  // in this menu the moment it is supported, without a change to this screen.
  const agents = useAgents();
  const agentOptions: Opt[] = [
    { value: null, icon: <Sparkles className="h-4 w-4" strokeWidth={1.75} />, label: "Let the lead choose", note: "The lead picks — its own agent, by default." },
    ...agents.data
      .filter((a) => a.supported)
      .map((a) => ({
        value: a.kind,
        icon: <AgentMark agent={a.kind} size={16} />,
        label: a.label,
      })),
  ];
  // A role may already pin an agent that is no longer on offer; keep it
  // nameable rather than silently reading as "let the lead choose".
  if (draft.agent && !agentOptions.some((o) => o.value === draft.agent)) {
    const pinned = draft.agent as Agent;
    agentOptions.push({
      value: pinned,
      icon: <AgentMark agent={pinned} size={16} />,
      label: AGENT_LABEL[pinned] ?? pinned,
    });
  }

  const set = <K extends keyof NewRole>(k: K, v: NewRole[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const refresh = () => cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
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

        <Field label="Does" hint="One line. The lead reads this to choose it.">
          <input
            value={draft.does}
            onChange={(e) => set("does", e.target.value)}
            placeholder="Reads a branch and reports problems with file:line. Never writes."
            className="w-full rounded-md border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-dim focus:outline-none"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Use when">
            <input
              value={draft.useWhen}
              onChange={(e) => set("useWhen", e.target.value)}
              placeholder="A developer has handed back."
              className="w-full rounded-md border border-line bg-ground px-3 py-2 text-meta text-bone placeholder:text-mute focus:border-dim focus:outline-none"
            />
          </Field>
          <Field label="Not when">
            <input
              value={draft.notWhen}
              onChange={(e) => set("notWhen", e.target.value)}
              placeholder="The diff is small enough to read yourself."
              className="w-full rounded-md border border-line bg-ground px-3 py-2 text-meta text-bone placeholder:text-mute focus:border-dim focus:outline-none"
            />
          </Field>
        </div>

        <Group
          label="Placement"
          hint="Where the child runs. Leave it open, or pin it so every spawn runs the same way."
        >
          <Select
            ariaLabel="Placement"
            value={draft.placement ?? OPEN}
            options={PLACEMENTS.map((p) => ({
              value: p.value,
              icon: <p.icon className="h-4 w-4" strokeWidth={1.75} />,
              label: p.label,
              note: p.note,
            }))}
            onChange={(v) => set("placement", v ?? OPEN)}
          />
        </Group>

        <Group
          label="Agent"
          hint="Which agent runs it. Leave it open, or pin one so every spawn uses it."
        >
          <Select
            ariaLabel="Agent"
            value={draft.agent ?? null}
            options={agentOptions}
            onChange={(v) => set("agent", v)}
          />
        </Group>

        <Group
          label="Team"
          hint="The profiles it can hand work to. Adding any makes this a lead that may delegate — to these, and one-off tasks. An empty team is a worker that does the job and reports back."
        >
          <TeamField
            all={all}
            selfId={state.id}
            memberIds={draft.members ?? []}
            onChange={(ids) => set("members", ids)}
          />
        </Group>

        {current && current.managedBy.length > 0 && (
          <Group label="Reports to" hint="Profiles that have this one on their team. Set from their editor, not here.">
            <div className="flex flex-wrap gap-1.5">
              {current.managedBy.map((m) => (
                <span
                  key={m.id}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-2.5 py-1.5 text-meta text-text"
                >
                  <CornerUpRight className="h-3.5 w-3.5 text-mute" strokeWidth={1.75} />
                  {m.name}
                </span>
              ))}
            </div>
          </Group>
        )}

        <Field label="Instructions" hint="Composed into its prompt. Markdown; the agent reads all of it.">
          <textarea
            value={draft.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            rows={10}
            placeholder={"# Reviewer\n\nYou review. You do not fix.\n\n## How to work\n- Read the diff and the tests first.\n- Report problems as `path:line — what, why`.\n\n## Don't\n- Don't edit files. Don't push."}
            className="scroll-slim w-full resize-y rounded-md border border-line bg-ground px-3 py-2 font-mono text-code leading-relaxed text-text placeholder:text-mute focus:border-dim focus:outline-none"
          />
        </Field>

        {existing && (
          <Field label="Who can use it" hint="A profile in a directory can be used by anyone who can reach it.">
            <WhoCanAccess kind="role" id={state.id!} path={state.path} look="chip" />
          </Field>
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
 * A profile's team: the list of teammates it may hand work to.
 *
 * Edited here as a set — add from the menu, remove with the ×, the whole list
 * is what gets saved. A gate line reads back what the team means, because the
 * fact that an empty team is a worker and a non-empty one is a lead is the
 * least obvious thing on the screen and the most important.
 */
function TeamField({
  all,
  selfId,
  memberIds,
  onChange,
}: {
  all: Role[];
  selfId?: string;
  memberIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const byId = new Map(all.map((r) => [r.id, r]));
  const members = memberIds.map((id) => byId.get(id)).filter(Boolean) as Role[];
  const candidates = all.filter((r) => r.id !== selfId && !memberIds.includes(r.id));

  const mark = (r: Role) =>
    r.agent ? (
      <AgentMark agent={r.agent as Agent} size={14} className="text-dim" />
    ) : (
      <UsersRound className="h-3.5 w-3.5 text-mute" strokeWidth={1.75} />
    );

  return (
    <div className="space-y-1.5">
      {members.map((r) => (
        <div
          key={r.id}
          className="flex items-center gap-2.5 rounded-lg border border-line bg-panel px-3 py-2.5"
        >
          <span className="shrink-0">{mark(r)}</span>
          <span className="min-w-0 flex-1 truncate">
            <span className="text-ui text-bone">{r.name}</span>
            {r.does && <span className="text-meta text-mute"> · {r.does}</span>}
          </span>
          {r.canDelegate && (
            <span className="shrink-0 rounded bg-sage-tint px-1.5 py-0.5 text-micro text-sage">
              leads {r.members.length}
            </span>
          )}
          <button
            type="button"
            aria-label={`Remove ${r.name}`}
            onClick={() => onChange(memberIds.filter((id) => id !== r.id))}
            className="shrink-0 text-mute transition-colors hover:text-brick"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      ))}

      {candidates.length > 0 ? (
        <>
          <button
            type="button"
            onClick={(e) => setOpen(open ? null : e.currentTarget)}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line bg-raise px-3 py-2.5 text-ui text-text transition-colors hover:border-dim hover:text-bone"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            Add a teammate
          </button>
          {open && (
            <Pop anchor={open} onClose={() => setOpen(null)} width={open.offsetWidth}>
              <div role="listbox" className="max-h-72 overflow-y-auto py-1">
                {candidates.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => {
                      onChange([...memberIds, r.id]);
                      setOpen(null);
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-raise"
                  >
                    <span className="shrink-0">{mark(r)}</span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-ui text-bone">{r.name}</span>
                      {r.does && <span className="text-meta text-mute"> · {r.does}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </Pop>
          )}
        </>
      ) : (
        members.length === 0 && (
          <p className="rounded-lg border border-dashed border-line bg-raise px-3 py-2.5 text-center text-meta text-mute">
            No other profiles yet to add. Make one, and it can join a team here.
          </p>
        )
      )}

      <div
        className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 ${
          members.length > 0
            ? "border-sage-deep bg-sage-tint"
            : "border-line bg-raise"
        }`}
      >
        <Users
          className={`h-4 w-4 shrink-0 ${members.length > 0 ? "text-sage" : "text-mute"}`}
          strokeWidth={1.75}
        />
        <span className="text-meta text-text">
          {members.length > 0 ? (
            <>
              <b className="font-medium text-sage">Leads a team of {members.length}.</b> When this
              profile starts a workspace it can delegate — to its team, and one-off tasks.
            </>
          ) : (
            <>
              <b className="font-medium text-dim">A worker.</b> With no team it does the task and
              reports back; it can't delegate.
            </>
          )}
        </span>
      </div>
    </div>
  );
}

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

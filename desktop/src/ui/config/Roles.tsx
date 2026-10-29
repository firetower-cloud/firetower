/**
 * Roles: the saved kinds of agent a lead can start.
 *
 * A role is **Placed** like a skill or a machine, so sharing one is the same
 * sheet everything else uses and nothing here reimplements filing. What a role
 * is, beyond where it lives, is a handful of fields a lead reads to choose it
 * and a few the control plane applies when a spawn names it — so unlike a
 * skill, a role *does* have an editor: it is text somebody writes, not a folder
 * an agent drops.
 */
import type { ReactNode } from "react";
import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  GitBranch,
  GitBranchPlus,
  Plus,
  Sparkles,
  Trash2,
  UsersRound,
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

/** An empty role, for a new one. Placement and agent start open. */
const BLANK: NewRole = {
  name: "",
  does: "",
  useWhen: "",
  notWhen: "",
  placement: "lead",
  agent: null,
  instructions: "",
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
    return <Editor state={editing} onClose={() => setEditing(null)} />;
  }

  return (
    <Section
      title="Subagents"
      note="A saved kind of agent a lead can start by name — a developer, a reviewer, a QA. Each carries what it does, when to use it, where it runs, and its instructions."
      action={
        <button
          onClick={() => setEditing({ draft: { ...BLANK } })}
          className="control border border-line bg-raise text-ui text-text hover:border-dim hover:text-bone"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          New subagent
        </button>
      }
    >
      <Rows feed={rows} empty="No subagents yet. Make one, and a lead can start it by name.">
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
  onClose,
}: {
  state: { id?: string; path?: string; draft: NewRole };
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<NewRole>(state.draft);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const cache = useQueryClient();
  const confirm = useConfirm();
  const existing = !!state.id;

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
      body: "Leads can no longer start this subagent. Children already running are untouched.",
      action: "Delete subagent",
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
        Subagents
      </button>

      <div className="space-y-4 px-2.5">
        <Field label="Name" hint="What a lead names to start it — e.g. reviewer.">
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

        <Field label="Instructions" hint="Composed into the child's prompt. Markdown; the agent reads all of it.">
          <textarea
            value={draft.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            rows={10}
            placeholder={"# Reviewer\n\nYou review. You do not fix.\n\n## How to work\n- Read the diff and the tests first.\n- Report problems as `path:line — what, why`.\n\n## Don't\n- Don't edit files. Don't push."}
            className="scroll-slim w-full resize-y rounded-md border border-line bg-ground px-3 py-2 font-mono text-code leading-relaxed text-text placeholder:text-mute focus:border-dim focus:outline-none"
          />
        </Field>

        {existing && (
          <Field label="Who can use it" hint="A subagent in a directory can be used by anyone who can reach it.">
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
            {existing ? "Save changes" : "Create subagent"}
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

/**
 * The profile form — **the one that both surfaces render.**
 *
 * A profile is edited in two places: the page at `/configuration/roles/<id>`,
 * and the *Profile* tab of a team map's drawer. They were two forms over one
 * object, which is two designs that agree until one of them changes. There
 * was even a *Full editor* button on the drawer to cross between them, which
 * is the shape of the problem admitting itself: a panel that has to send you
 * somewhere else is a panel missing the thing you came for.
 *
 * So this is the form, and the two surfaces are a page and a drawer around
 * it. The page gives it 640px and a sticky foot; the drawer gives it 392px
 * and a pinned one. Nothing else differs, and nothing can drift.
 *
 * ## What is here and what is not
 *
 * Every field of the profile, and none of the commit. `draft` and `setDraft`
 * come from the caller, and so does Save — because a page saves and closes
 * while a drawer saves and stays, and that is genuinely two behaviours. The
 * default flag is the caller's too: it is a fact about the person rather
 * than a field of the profile, and it writes the instant it is flipped.
 *
 * ## One control vocabulary
 *
 * **Every value chosen from a list is a dropdown.** It used to be pills for
 * placement, machine, engine, subscription and the two limit fields, on the
 * reasoning that three choices with a word of explanation each is a thing
 * you read once and then point at. In a 640px column that was arguable. Laid
 * out one under another in nine fields it is a wall, the pressed one is hard
 * to find, and at 392px every row wraps to three lines. A dropdown says what
 * is chosen in one line and offers the rest on a press — which is what the
 * run controls and the directory picker already did, so half this form was
 * one idiom and half the other.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Box,
  Check,
  ChevronDown,
  CircleDashed,
  Clock,
  Cpu,
  FolderGit2,
  Gauge,
  GitBranch,
  GitBranchPlus,
  KeyRound,
  MessageSquare,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  User,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { AgentMark, AGENT_LABEL } from "~/components/AgentMark";
import { Icon } from "~/components/ui";
import { Pop } from "~/ui/Pop";
import { WhereTo } from "~/ui/config/bits";
import { WhoCanAccess } from "~/ui/Sharing";
import { ProfilePlugins } from "~/ui/config/profile/ProfilePlugins";
import { BigText } from "~/ui/config/profile/BigText";
import { navigate } from "~/shims/next-navigation";
import { useAccounts, useAgents, useDirectories, useHosts } from "~/data";
import { quota, usable } from "~/api/accounts";
import { machineLabel, machines, stateLabel } from "~/api/environments";
import { canRun } from "~/components/WhereItRuns";
import { useAgentControls } from "~/api/generated/agents/agents";
import { getListRolesQueryKey } from "~/api/generated/roles/roles";
import { useQueryClient } from "@tanstack/react-query";
import { pinnedAccountFits } from "~/ui/config/Roles";
import type { Agent, Control, ControlKind, NewRole, Role } from "~/api/generated/model";

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

/**
 * What a lead may do about a child of this profile that has run out, in order
 * of how much latitude each grants.
 *
 * **Three rungs and no dashed ring.** The two-state rule governs one axis —
 * who decides a value, the profile or the lead — and on that axis a middle is
 * a lie. This field is not on it: none of the three means "not decided", so
 * none of them is *Let the lead choose*. A profile that says to wait has
 * decided, firmly. *How it runs* two fields above already grades three ways
 * for the same reason, and the strings are the owner's own.
 */
const ON_LIMIT: { value: string; icon: LucideIcon; label: string; note?: string }[] = [
  { value: "wait", icon: Clock, label: "Wait for human action" },
  {
    value: "same",
    icon: KeyRound,
    label: "Let the lead pick another subscription",
    note: "If the agent runs on Claude Code, it won't pick a subscription on Codex",
  },
  {
    value: "engine",
    icon: RefreshCw,
    label: "Let the lead pick another subscription and engine",
    note: "For example, allow to switch from Codex to Claude Code",
  },
];

/** And the Manager's own half: whether it spends that latitude or asks first. */
const ON_CHILD_LIMIT: { value: string; icon: LucideIcon; label: string; note: string }[] = [
  { value: "reroute", icon: RefreshCw, label: "Re-route it", note: "picks one and carries on" },
  {
    value: "ask",
    icon: MessageSquare,
    label: "Ask me first",
    note: "stops and puts the choice to you",
  },
];

/** A mark for each run control, so its picker reads like the others. */
const CONTROL_ICON: Record<ControlKind, LucideIcon> = {
  model: Cpu,
  effort: Gauge,
  mode: ShieldCheck,
  sandbox: Box,
};

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

/** One option in a {@link Select}: what it is worth, and how it reads. */

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
      <div className="box">
        <span className="text-mute">—</span>
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
        className="box w-full text-left"
      >
        <span className="shrink-0 text-dim">{current.icon}</span>
        <span className="min-w-0 flex-1 truncate text-bone">{current.label}</span>
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

export function ProfileForm({
  draft,
  setDraft,
  role,
  state,
  isDefault,
  defaulting,
  onToggleDefault,
}: {
  draft: NewRole;
  setDraft: React.Dispatch<React.SetStateAction<NewRole>>;
  /** The stored profile, where one exists. Read for the deprecation notice,
   *  which is about what is on the row rather than about the draft. */
  role?: Role;
  /** What the server knows this as: its id, and where it is filed. */
  state: { id?: string; path?: string };
  isDefault: boolean;
  defaulting: boolean;
  onToggleDefault: () => void;
}) {
  const existing = !!state.id;
  /* **Whether this profile still carries the old per-profile reach.** A
     profile made now never does; one made before teams existed may, and it
     goes on working until the column is dropped. The notice is drawn only
     for those, because telling everybody about a thing that is true of
     nobody is how a deprecation becomes furniture. */
  const oldReach = !!role?.canDelegate;
  const cache = useQueryClient();

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

  return (
      <div className="form">
        <Field label="Name">
          <span className="box">
            <input
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="reviewer"
            />
          </span>
        </Field>

        <Field
          label="Description"
          hint="What it does and when to use it"
        >
          <span className="box brief">
            <textarea
              value={draft.does}
              onChange={(e) => set("does", e.target.value)}
              rows={2}
              placeholder="Reviews a finished branch and reports problems as file:line. Use after a developer hands back — not for a one-line fix."
            />
          </span>
        </Field>

        <Group label="Workspace">
          <Select
            ariaLabel="Placement"
            value={draft.placement ?? "lead"}
            options={PLACEMENTS.map((p) => ({
              value: p.value,
              icon: <p.icon className="h-4 w-4" strokeWidth={1.75} />,
              label: p.label,
              note: p.note,
            }))}
            onChange={(v) => setPlacement(v ?? "lead")}
          />
        </Group>

        {/* Shown whenever the child *could* get a workspace of its own — its
            own, or the lead's to decide — and hidden only on *Same workspace*,
            the one case where a machine can never apply. A profile may pin a
            machine while leaving the placement open, which is a coherent thing
            to want: wherever the lead likes, but if it gets a workspace of its
            own it is on that machine. */}
        {draft.placement !== "here" && (
          <Group label="Machine">
            {machineRows.length > 0 ? (
              <>
                {/* The engine's verdict rides in the option's own note —
                    marked rather than hidden, as every other picker marks
                    it: gone from a list looks like gone. */}
                <Select
                  ariaLabel="Machine"
                  value={draft.machine ?? null}
                  options={[
                    {
                      value: null,
                      icon: <CircleDashed className="h-4 w-4" strokeWidth={1.75} />,
                      label: OPEN,
                      note: OPEN_FALLBACK.machine,
                    },
                    ...machineRows.map((m) => ({
                      value: m.id as string | null,
                      icon: <Server className="h-4 w-4" strokeWidth={1.75} />,
                      label: m.label,
                      note:
                        runsThere(m.id) === false
                          ? `${AGENT_LABEL[draft.agent as Agent] ?? draft.agent} is not installed there · ${m.says}`
                          : m.says,
                    })),
                  ]}
                  onChange={(v) => set("machine", v)}
                />
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

        <Group label="Agent">
          {/* The open answer first, wearing the open mark — the order every
              field here repeats. */}
          <Select
            ariaLabel="Agent"
            value={draft.agent ?? null}
            options={[
              {
                value: null,
                icon: <CircleDashed className="h-4 w-4" strokeWidth={1.75} />,
                label: OPEN,
                note: OPEN_FALLBACK.agent,
              },
              ...agentOptions,
            ]}
            onChange={(v) => set("agent", v)}
          />
        </Group>

        {/* **Above Subscription, below Agent.** Agent and How it runs are how
            a child behaves; Subscription and what follows it are which
            subscription pays. Grouping the pair that answers each question
            puts the two fields that leave with the engine next to each other
            too, so the note that replaces them stands in one place rather
            than between two survivors. */}
        {controls.length > 0 && (
          <Group
            label="How it runs"
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

        {/* A subscription belongs to one engine, so with the engine open there
            is nothing this field could hold: a visible picker here could only
            produce a refusal. It leaves, and the sentence below says why. */}
        {draft.agent !== null && (
          <Group label="Subscription">
            {connected ? (
              <Select
                ariaLabel="Subscription"
                value={draft.account ?? null}
                options={accountOptions}
                onChange={(v) => set("account", v)}
              />
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

        {/* **What stands where Subscription and How it runs were.**
            They do not grey out and they do not linger: they leave. Under a
            flat engine row that is not self-evidently cause and effect — the
            four engines stay put and two fields below move — so this says why
            they went, *and names what came off with them*. Clearing is
            otherwise invisible, and silently discarding a value somebody chose
            is the bug this whole screen is being changed for. */}
        {/* **The explanation goes; the consequence stays.** That subscription
            and run settings belong to an engine is background — true of every
            profile, and a paragraph above a field nobody is looking at. That
            *this* profile just lost a pinned subscription and two run
            settings is not: it happened a second ago because the engine was
            opened, it is invisible otherwise, and silently discarding a value
            somebody chose is the bug this screen was changed for. */}
        {draft.agent === null && dropped && (dropped.account || dropped.settings > 0) && (
          <div className="fld">
            <div className="inform">
              <p>
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
              </p>
            </div>
          </div>
        )}

        {/* **This one does not leave when the engine does**, and that is the
            property the whole field turns on. Subscription and How it runs go
            because they are *values belonging to an engine* — an account is
            for one engine and a model name is one engine's. A grant of
            latitude is not a value: "its lead may move it to another
            subscription" is as true of a child running whatever its lead runs
            as of one pinned to Claude Code. */}
        <Group label="If it reaches usage limit">
          {/* A ladder of three, so the order in the menu is the order of how
              much latitude each grants. */}
          <Select
            ariaLabel="If it reaches usage limit"
            value={draft.onUsageLimit ?? "wait"}
            options={ON_LIMIT.map((o) => ({
              value: o.value,
              icon: <o.icon className="h-4 w-4" strokeWidth={1.75} />,
              label: o.label,
              note: o.note,
            }))}
            onChange={(v) => set("onUsageLimit", v ?? "wait")}
          />
          {/* The consequence where it is being chosen, and only for the two
              rungs that have one. Waiting is what everything does today and
              needs no explaining. */}
          {draft.onUsageLimit === "same" && (
            <WhereTo className="aside">
              Nothing about what the child may <i>do</i> changes — same engine, same permissions.
              Only whose allowance pays for the rest of it.
            </WhereTo>
          )}
          {draft.onUsageLimit === "engine" && (
            <WhereTo className="aside">
              Choosing this <b>is</b> the acknowledgement that a different engine brings its own
              default permissions. Given here, once, instead of at the moment somebody is waiting.
            </WhereTo>
          )}
        </Group>


        {/* **No delegation controls, and that is the change.** Who hands work
            to whom is a team — `/configuration/agent-teams` — so a profile
            carries none of it. What is left here is a notice, and only for a
            profile that still holds the old reach: it is read until the
            compatibility window closes, nothing writes it any more, and
            somebody looking at this profile has to be able to find out why it
            still delegates. */}
        {oldReach && (
          <Group
            label="Delegation"
            hint="This profile carries the old per-profile reach. It is still read, and nothing writes it any more."
          >
            <WhereTo className="aside">
              <b>Delegation moved to teams.</b> This profile still carries{" "}
              {role?.delegateScope?.length
                ? `a list of ${role.delegateScope.length} profile${role.delegateScope.length === 1 ? "" : "s"} it may hand work to`
                : "reach over every profile you can see"}
              , from before teams existed. It goes on working until the old column is dropped, and
              saving this profile will not change it.{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => navigate("/configuration/agent-teams")}
              >
                Make a team with {role?.name ?? "this profile"} as its lead
              </button>{" "}
              and start that instead — a team says who is under whom, and two teams can hold the
              same profile with different reports in each.
            </WhereTo>
          </Group>
        )}

        {/* **Drawn for every profile now**, because any profile can lead a
            team — there is no Manager flag left to hide it behind, and a
            profile that is bare here and leads in another team would otherwise
            have nowhere to answer this. Meaningless where it leads nothing,
            and that costs one row; hiding it behind a flag that no longer
            exists would cost the answer. */}
        <Group label="When a child reaches usage limit">
          <Select
            ariaLabel="When a child runs out"
            value={draft.onChildLimit ?? "ask"}
            options={ON_CHILD_LIMIT.map((o) => ({
              value: o.value,
              icon: <o.icon className="h-4 w-4" strokeWidth={1.75} />,
              label: o.label,
              note: o.note,
            }))}
            onChange={(v) => set("onChildLimit", v ?? "ask")}
          />
        </Group>

        <ProfilePlugins
          scope={draft.skillScope ?? []}
          onChange={(skillScope) => setDraft((d) => ({ ...d, skillScope }))}
        />

        {/* **The one field somebody writes a document in**, so it carries a
            door to a room big enough for one. The box stays live and stays
            the source of truth — the editor writes through to the same
            string, so there is nothing to commit and nothing to lose. */}
        <Field label="Instructions">
          <BigText
            title="Instructions"
            value={draft.instructions ?? ""}
            onChange={(v) => set("instructions", v)}
            rows={10}
            placeholder={"# Reviewer\n\nYou review. You do not fix.\n\n## How to work\n- Read the diff and the tests first.\n- Report problems as `path:line — what, why`.\n\n## Don't\n- Don't edit files. Don't push."}
          />
        </Field>

        {existing ? (
          <>
            <Field label="Who can use it">
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
                onClick={onToggleDefault}
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
      </div>
  );
}

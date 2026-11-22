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
  Clock,
  ChevronLeft,
  CircleDashed,
  FolderDown,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  Box,
  Cpu,
  Gauge,
  ShieldCheck,
  Plus,
  KeyRound,
  MessageSquare,
  RefreshCw,
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
import { Blank, Dropping, Group as Rowset, Note, Rows, Section, Typed, WhereTo } from "~/ui/config/bits";
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
  planRoleImport,
  applyRoleImport,
  useRoleImportLimits,
} from "~/api/generated/roles/roles";
import { useAgentControls } from "~/api/generated/agents/agents";
import { useAccounts, useAgentTeams, useAgents, useDirectories, useHosts, useSkills, teamsUsing, why } from "~/data";
import { quota, usable, type Account } from "~/api/accounts";
import { ScopePicker, type ScopeItem } from "~/ui/config/ScopePicker";
import { SkillSources, useSkillSources } from "~/ui/config/SkillSources";
import { machineLabel, machines, stateLabel } from "~/api/environments";
import { canRun } from "~/components/WhereItRuns";
import type {
  Agent,
  CandidateDecision,
  Control,
  ControlKind,
  ImportDone,
  ImportPlan,
  ProfileDrop,
  Role,
  NewRole,
} from "~/api/generated/model";
import { ImportProfiles } from "~/ui/config/ImportProfiles";
import type { Selection } from "~/ui/config/import-plan";
import { readProfileDrop, readProfileFiles, type Dropped } from "~/profiles";
import { navigate } from "~/shims/next-navigation";
import { ProfileForm } from "~/ui/config/profile/ProfileForm";
import { AskedToDelete } from "~/ui/config/AskedToDelete";
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
  /* Today's behaviour, both of them — a new profile grants no latitude over
     its children and a new Manager asks before it spends anybody's allowance.
     Sent rather than left off, for the reason the two switches below are: an
     absent field means "leave it as it is", which on a profile that does not
     exist is the same answer, but the form draws these and a draft that
     omitted them would draw one thing and save another. */
  onUsageLimit: "wait",
  onChildLimit: "ask",
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
  // Which teams hold a position on each profile — the reading that replaced
  // "can delegate" on the row, and the thing a person needs before they delete
  // one.
  const teams = useAgentTeams();
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

  /* ── importing a folder of bundles ────────────────────────────────── */

  /** What the endpoint will take, so a drop can be refused before it is read. */
  const limits = useRoleImportLimits();
  const [over, setOver] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  /** What the last accept did, said once above the list it changed. */
  const [imported, setImported] = useState<ImportDone | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  /** Plan a drop, and show what it would do. */
  const look = async (drop: ProfileDrop) => {
    setImported(null);
    try {
      const plan = await planRoleImport(drop);
      setReview({ drop, plan, refused: null, applying: false });
    } catch (e) {
      /* A bound, named by the server: too many files, one too large, a path
         that climbs out. Not a plan — see `ImportProfiles`'s `refused`. */
      setReview({ drop, plan: null, refused: why(e), applying: false });
    }
  };

  /** Read what was dropped, within the bounds, then plan it. */
  const read = async (job: Promise<Dropped>) => {
    const { files, refused } = await job;
    if (refused) {
      setImported(null);
      setReview({ drop: { files: [], answers: [] }, plan: null, refused, applying: false });
      return;
    }
    /* Nothing at all — a drag that let go of a link, or a folder the reader
       skipped entirely. There is nothing to review and nothing to say. */
    if (files.length === 0) return;
    await look({ files, answers: [] });
  };

  /**
   * A drop nothing could be checked against.
   *
   * The bounds are the server's, so without them there is no size this window
   * may refuse at — and reading an archive to find out is the thing being
   * avoided. Rare: one small request, made when this screen opens.
   */
  const unbounded = async () => {
    const again = await confirm({
      title: "Nothing was read",
      body: "Firetower has not said what an import takes, so nothing was read. Try again, or reopen this screen.",
      action: "Try again",
      cancel: "Close",
    });
    if (again) await limits.refetch();
  };

  /** Answering a candidate plans again, which is what brings its diff. */
  const answer = async (key: string, decision: CandidateDecision) => {
    if (!review?.plan) return;
    const answers = [
      ...(review.drop.answers ?? []).filter((a) => a.key !== key),
      { key, answer: decision },
    ];
    await look({ files: review.drop.files, answers });
  };

  /**
   * Accept it.
   *
   * **What is sent is what was reviewed, minus whatever was unticked.** An
   * excluded row's file does not travel, so the plan the server derives for
   * itself holds the rows that are left — and the fingerprints of those rows
   * are what say they are the ones that were on screen.
   */
  const accept = async (sel: Selection) => {
    if (!review?.plan) return;
    const kept = review.plan.entries.filter((e) => !sel.excluded.has(e.path));
    const left = new Set(
      review.plan.entries.filter((e) => sel.excluded.has(e.path)).map((e) => e.path),
    );
    const drop: ProfileDrop = {
      files: review.drop.files.filter((f) => !left.has(f.path)),
      answers: (review.drop.answers ?? []).filter((a) => kept.some((e) => e.key === a.key)),
    };
    setReview({ ...review, applying: true });
    try {
      const done = await applyRoleImport({ drop, reviewed: kept.map((e) => e.digest) });
      await cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
      setReview(null);
      setImported(done);
    } catch (e) {
      /* **Nothing was written**, which the server's own sentence says. The
         plan it refused is the stale one on screen, so the way out is to read
         the current one — the same files, planned again. */
      setReview({ ...review, applying: false });
      const again = await confirm({
        title: "Nothing was imported",
        body: why(e),
        action: "Read it again",
        cancel: "Close",
      });
      if (again) await look(review.drop);
      else setReview(null);
    }
  };

  const surface = {
    onDragOver: (e: React.DragEvent) => {
      if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      const bounds = limits.data;
      if (!bounds) {
        void unbounded();
        return;
      }
      /* **Started while the event is live.** The entries of a `DataTransfer`
         are only readable during the handler, so the reading begins here and
         is awaited after. */
      void read(readProfileDrop(e.dataTransfer, bounds));
    },
  };

  /* By name only. A description search returned the whole roster, because
     these profiles reference each other ("hand off to the Security Advisor"),
     so the term is in every one.

     **Alphabetical, with nothing before it.** This used to put Managers
     first, and that column is gone: no profile delegates on its own any more,
     so sorting by it would be sorting by a fact that is only true of profiles
     nobody has moved into a team yet. Which teams use a profile is on the row
     instead, where it is read rather than ranked. */
  const needle = q.trim().toLowerCase();
  const shown = rows.data
    .filter((r) => !needle || r.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));

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

  /* **The review replaces the pane.** It is the whole of what somebody is
     doing until they accept it or leave, and it carries its own way back. */
  if (review && (review.plan || review.refused)) {
    return (
      <ImportProfiles
        plan={review.plan ?? nothingRead(limits.data)}
        refused={review.refused}
        applying={review.applying}
        onClose={() => setReview(null)}
        onApply={accept}
        onAnswer={(key, decision) => void answer(key, decision)}
      />
    );
  }

  if (editing) {
    /* **Read-only says what the screen is, rather than disabling its
       controls.** A profile somebody shared with you opened the full editor
       with a Save button that the server would refuse — which is worse than a
       greyed-out form, because it does not look withheld until after you have
       written something. It opens as a reading of itself instead, and says
       where it is changed. */
    const role = editing.id ? rows.data.find((r) => r.id === editing.id) : undefined;
    if (role && !role.mayWrite) return <Reading role={role} onClose={() => setEditing(null)} />;
    return <Editor state={editing} all={rows.data} role={role} onClose={() => setEditing(null)} />;
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
        {
          icon: FolderDown,
          label: "Import a folder",
          note: "PROFILE.md files you already have.",
          onPick: () => picker.current?.click(),
        },
      ]}
    />
  );

  return (
    <div {...surface} className="relative">
      {over && (
        <Dropping says="One profile, a folder of them, or a .zip of either. Nothing is written until you have looked." />
      )}
      {/* `webkitdirectory` is how a window asks for a folder, and the same
          input takes a .zip — one control rather than two, which is what
          `AddSkill` does for a skill. */}
      <input
        ref={picker}
        type="file"
        multiple
        // @ts-expect-error — webkitdirectory is not in the DOM types
        webkitdirectory=""
        directory=""
        className="hidden"
        onChange={(e) => {
          const bounds = limits.data;
          /* **Copied out before the input is cleared.** `value = ""` empties
             the `FileList` this handler is holding, not a stale copy of it,
             so reading after the reset reads nothing at all. The reset is
             what lets the same folder be picked twice running. */
          const chosen = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (!bounds) {
            void unbounded();
            return;
          }
          void read(readProfileFiles(chosen, bounds));
        }}
      />
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
      {imported && (
        <Note
          icon={Check}
          control={
            <button onClick={() => setImported(null)} className="btn quiet">
              Dismiss
            </button>
          }
        >
          {wrote(imported)}
        </Note>
      )}

      {/* An agent can ask for a deletion and cannot perform one. This is
          where the asking is answered. */}
      <AskedToDelete of="role" />

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
            /* **The blank carries the gesture rather than describing it.** The
               page is a drop surface while it is empty, and this is the
               sentence that says so. */
            <Blank icon={UsersRound} title="No profiles yet" action={newProfile}>
              Ask an agent to write one, or drop in a folder of profiles you already have.
            </Blank>
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
              inTeams={teamsUsing(teams.data, role.id)}
              onOpen={() => setEditing({ id: role.id, path: role.path, draft: toDraft(role) })}
              onDelete={() => removeRole(role)}
            />
          ))}
        </Rowset>
      </Rows>

      {!blank && (
        <WhereTo>
          A profile is filed like a skill or a machine, so sharing one uses the same sheet.{" "}
          <b>The team is the only thing that makes one a manager</b>. Drop a folder of
          PROFILE.md files anywhere on this page to import them.
        </WhereTo>
      )}
    </Section>
    </div>
  );
}

/**
 * A drop being reviewed: what it held, and what the server said about it.
 *
 * `plan` and `refused` are the two answers the endpoint gives and never both:
 * a drop past one of the published bounds is refused whole, so there is
 * nothing to classify per profile. `applying` is the accept in flight.
 */
type Review = {
  drop: ProfileDrop;
  plan: ImportPlan | null;
  refused: string | null;
  applying: boolean;
};

/**
 * The plan a refusal is drawn over: no entries, and the bounds.
 *
 * The review reads nothing else out of it in that state — the sentence is the
 * server's and the figures beside it are these, so somebody who has hit one
 * bound can see the rest without hitting them too. The same shape an empty
 * drop comes back as, which is why it is not a shape being invented here.
 *
 * The bounds are absent only while the one request that carries them is in
 * flight, and a drop is not read at all without them, so the zeroes are
 * unreachable rather than a default.
 */
const nothingRead = (limits: ImportPlan["limits"] | undefined): ImportPlan => ({
  appliable: false,
  whyNot: [],
  entries: [],
  ignored: [],
  limits: limits ?? { files: 0, fileBytes: 0, totalBytes: 0, depth: 0 },
});

/**
 * What an accept did, in the words that do not claim more than it did.
 *
 * Created and overwritten, counted apart. **A renamed folder is a new profile
 * and the one it was renamed from is still there**, so a sentence about five
 * profiles "imported" would describe a library that has six — the counts say
 * what happened and the list below shows it.
 */
function wrote(done: ImportDone): string {
  const made = done.wrote.filter((w) => w.created).length;
  const over = done.wrote.length - made;
  const profiles = (n: number) => (n === 1 ? "1 profile" : `${n} profiles`);
  if (made > 0 && over > 0) return `${profiles(made)} created, ${profiles(over)} overwritten.`;
  if (over > 0) return `${profiles(over)} overwritten.`;
  return `${profiles(made)} created.`;
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
    onUsageLimit: r.onUsageLimit,
    onChildLimit: r.onChildLimit,
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
 * `isDefault` is set by its own endpoint so that setting one profile's can
 * unset another's, and `key` is written only by an import adopting the folder
 * name a bundle came from — an editor that could change it would be an editor
 * that can make one file describe a different profile. Exported for
 * `role-draft.test.ts`, which treats anything absent from a draft and absent
 * from here as a field somebody forgot.
 */
export const SERVER_OWNED = [
  "id",
  "path",
  "key",
  "createdAt",
  "updatedAt",
  "mayWrite",
  "mayShare",
  "isDefault",
] as const satisfies readonly (keyof Role)[];

/** One role in the list: its name, what it does, and the shape of it as chips. */
function RoleRow({
  role,
  inTeams,
  onOpen,
  onDelete,
}: {
  role: Role;
  /** The teams holding a position on it, by name. */
  inTeams: string[];
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
      {/* Which teams hold a position on it — the reading that replaces
          "can delegate". A profile has no reach; a team does, and a profile
          in no team is simply one nothing has been built around yet. */}
      {inTeams.length > 0 && (
        <Badge>{inTeams.length === 1 ? inTeams[0] : `${inTeams.length} teams`}</Badge>
      )}
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

/**
 * A profile you may read and not change.
 *
 * The same facts the editor holds, as text — no fields, no Save, and nothing
 * greyed out. The line at the foot is the *where-this-lives note*: a boundary
 * read as a boundary rather than as a refusal, which is the same move People
 * and Teams make for the administration site.
 */
function Reading({ role, onClose }: { role: Role; onClose: () => void }) {
  const teams = useAgentTeams();
  const inTeams = teamsUsing(teams.data, role.id);
  /* `new`, which is what the server stores and has always stored. This read
     `own`, a value nothing sends, so a profile committed to its own workspace
     fell through to the last branch — harmless while that branch described a
     state nothing could be in, and wrong the moment *open* became real. This is
     the one view that is only ever read, by somebody who cannot open the form
     and check. */
  const place =
    role.placement === "new" ? "its own workspace" : role.placement === "here" ? "the lead's workspace" : "wherever the lead decides";
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
        <Reads label="In teams">
          {inTeams.length === 0
            ? "none — it hands work to nobody until a team puts somebody under it"
            : inTeams.join(", ")}
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
 *
 * **The short branch still carries the grant.** It once returned before
 * `recovery` was consulted, so a profile that had just been given a rung of
 * *If it reaches usage limit* read back as though it had not — on the shape
 * every new profile opens in, which makes it the common case rather than an
 * edge. The three open fields and the grant are different facts: one is what
 * the lead decides, the other is what the lead may later do, and leaving all
 * three open says nothing about the second.
 */
export function whatAChildGets(
  draft: NewRole,
  machines: { id: string; label: string }[],
): ReactNode {
  const open = draft.placement === "lead" && !draft.machine && !draft.agent;
  if (open)
    return (
      <>
        A child gets whatever the lead asks for: <b>its workspace, its machine, its engine</b>
        {recovery(draft)}.
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
      A child gets <b>{place + machine + engine}</b>
      {recovery(draft)}.
    </>
  );
}

/**
 * And what happens if that child runs out of allowance, as a clause of the
 * same sentence.
 *
 * A clause rather than a sentence of its own, and appended rather than
 * replacing what is already read back: the three things a child *gets* and
 * the one thing that may later be *done about it* are one fact about one
 * spawn, and the form's own reason for saying any of it is that a lead
 * reporting work that never happened is this whole area's bug.
 *
 * `wait` adds nothing. It is what every profile does and what the sentence
 * has always implied by saying nothing, so spending a clause on it would make
 * the common shape read as the exceptional one.
 */
function recovery(draft: NewRole): string {
  const engine = draft.agent ? (AGENT_LABEL[draft.agent as Agent] ?? draft.agent) : null;
  switch (draft.onUsageLimit) {
    case "same":
      return engine
        ? `, and if it runs out its lead may move it to another ${engine} subscription`
        : ", and if it runs out its lead may move it to another subscription for that engine";
    case "engine":
      return ", and if it runs out its lead may move it to another subscription, on another engine if it has to";
    default:
      return "";
  }
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
  role,
  onClose,
}: {
  state: { id?: string; path?: string; draft: NewRole };
  all: Role[];
  /** The stored profile, where one exists. Read for the deprecation notice,
   *  which is about what is on the row rather than about the draft. */
  role?: Role;
  onClose: () => void;
}) {
  /* **Whether this profile still carries the old per-profile reach.** A
     profile made now never does; one made before teams existed may, and it
     goes on working until the column is dropped. The notice is drawn only for
     those, because telling everybody about a thing that is true of nobody is
     how a deprecation becomes furniture. */
  const oldReach = !!role?.canDelegate;
  const [draft, setDraft] = useState<NewRole>(state.draft);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const cache = useQueryClient();
  const confirm = useConfirm();
  const existing = !!state.id;
  const refresh = () => cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
  /* Where this profile is filed decides whether the Skills section's count
     is "yours" or everybody's: a profile in a directory is used by
     colleagues, and the first two of its three sources resolve against
     whoever starts it. The form reads this too; the foot reads it to say
     whether Save is about to create a profile with no skills at all. */
  const shared = existing ? !!state.path?.startsWith("d/") : !!draft.directory;
  const skills = useSkillSources(draft, shared);

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

      {/* **The form is not written here.** It is `profile/ProfileForm`,
          which the team map's drawer renders too — one form over one object,
          so the two surfaces cannot say different things about it. What this
          screen owns is the page around it: the heading, the width, and a
          Save that closes. */}
      <div className="pf">
        <ProfileForm
          draft={draft}
          setDraft={setDraft}
          role={role}
          state={state}
          isDefault={isDefault}
          defaulting={defaulting}
          onToggleDefault={toggleDefault}
        />
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

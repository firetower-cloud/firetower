/**
 * Profiles: the saved personas any agent can run — as a workspace's lead, or
 * as a teammate a lead hands work to. "Profiles" to the person; `role` on the
 * wire, where renaming would be churn for no one's benefit.
 *
 * A profile is **identity**: its name, what it does, its instructions, its
 * skills, how it runs. Where it sits and who it may hand work to is a
 * *position* in an **agent team** — see `docs/agent-teams.md`. A profile is
 * **Placed** like a skill or a machine, so sharing one is the same sheet
 * everything else uses and nothing here reimplements filing.
 *
 * **This pane is a list, and the editor is the drawer.** It held a full-page
 * form for the same nineteen fields, and two editors writing one object is the
 * trap the agent-teams design removed: a profile opened from a team's map and
 * a profile opened from here are the same profile, and they now open the same
 * editor in the same right rail. `ProfileDrawer.tsx` is that editor; the pull
 * request has the field-by-field inventory of the move.
 *
 * What stayed here is what belongs to a list: finding one, making one,
 * importing a folder of them, and deleting one — which names every team it
 * holds a position in first, through the drawer's own confirmation, because
 * the teams are not on screen.
 */
import { useRef, useState } from "react";
import {
  Check,
  FolderDown,
  Plus,
  Search,
  Sparkles,
  SquarePen,
  Star,
  Trash2,
  UsersRound,
  CircleDashed,
} from "lucide-react";
import { Blank, Dropping, Group as Rowset, Note, Rows, Section, Typed, WhereTo } from "~/ui/config/bits";
import { CreateMenu } from "~/ui/config/CreateMenu";
import { useStart } from "~/start";
import { AgentMark, AGENT_LABEL } from "~/components/AgentMark";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListRoles,
  getListRolesQueryKey,
  createRole,
  deleteRole,
  planRoleImport,
  applyRoleImport,
  rolePositions,
  useRoleImportLimits,
} from "~/api/generated/roles/roles";
import { useDirectories, why } from "~/data";
import type {
  Agent,
  CandidateDecision,
  ImportDone,
  ImportPlan,
  ProfileDrop,
  Role,
} from "~/api/generated/model";
import { ImportProfiles } from "~/ui/config/ImportProfiles";
import type { Selection } from "~/ui/config/import-plan";
import { readProfileDrop, readProfileFiles, type Dropped } from "~/profiles";
import { useConfirm } from "~/ui/Confirm";
import { navigate } from "~/shims/next-navigation";
import { Badge, IconButton } from "~/components/ui";
import { Blast, EMPTY_PLACES, ProfileDrawer, WithRail } from "~/ui/config/ProfileDrawer";
import { NewProfileSheet, blankProfile } from "~/ui/config/TeamSheet";

export function Roles() {
  const start = useStart();
  const feed = useListRoles();
  const rows = {
    data: feed.data ?? [],
    loading: feed.isLoading,
    error: feed.error ? why(feed.error) : null,
  };
  /** Which profile the drawer holds. */
  const [opened, setOpened] = useState<string | null>(null);
  /**
   * Where the drawer has been asked to go next.
   *
   * **Asked rather than done**, because the drawer may be holding an unsaved
   * draft: pressing another row while one is half-edited, or the ground
   * behind a floating drawer, would otherwise throw the draft away without a
   * word. The drawer puts the same question up that leaving the pane does,
   * and answers through `onClose`.
   */
  const [want, setWant] = useState<{ to: string | null } | null>(null);
  const openRow = (id: string) => (opened ? setWant({ to: id }) : setOpened(id));
  const letGo = (to?: string | null) => {
    setWant(null);
    setOpened(to ?? null);
  };
  const [making, setMaking] = useState(false);
  const [q, setQ] = useState("");
  const cache = useQueryClient();
  const confirm = useConfirm();
  const dirs = useDirectories();

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

  // By name only. A description search returned the whole roster, because these
  // profiles reference each other ("hand off to the Security Advisor"), so the
  // term is in every one. Managers first, then alphabetical.
  const needle = q.trim().toLowerCase();
  const shown = rows.data
    .filter((r) => !needle || r.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.canDelegate) - Number(a.canDelegate) || a.name.localeCompare(b.name));

  /**
   * Delete a profile, naming every team it holds a position in first.
   *
   * **Deleting one cascades**: each position that references it goes, and
   * everything under those goes with them. The teams that lose them are not
   * on screen, so the confirmation names each and says how many positions it
   * loses — the same blast-radius pattern the map card's destructive control
   * establishes, and the same `Blast` the drawer's own delete uses, so there
   * is one wording for one fact.
   *
   * The placements are read on the press rather than held for every row: one
   * request, at the one moment anybody needs the answer.
   *
   * What comes back is the seats in teams this person can see **and a count
   * of the ones in teams they cannot** — the cascade does not filter, so a
   * confirmation built from the list alone would describe half of what the
   * press is about to do. See `Blast`.
   */
  const removeRole = async (role: Role) => {
    const used = await rolePositions(role.id).catch(() => EMPTY_PLACES);
    const takes = used.places.length + Math.max(0, used.withheld ?? 0);
    const ok = await confirm({
      title: `Delete ${role.name}?`,
      body: <Blast name={role.name} used={used} />,
      action: takes ? "Delete and take the positions out" : "Delete profile",
      tone: "danger",
    });
    if (!ok) return;
    await deleteRole(role.id);
    if (opened === role.id) letGo(null);
    await cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
  };

  /** Make one, then open it in the drawer — which is where the rest of it is. */
  const make = async (name: string, does: string, directory?: string | null) => {
    const made = await createRole({ ...blankProfile(name, does), directory: directory ?? null });
    await cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
    setMaking(false);
    setOpened(made.id);
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
          note: "Name it, then fill in the rest.",
          onPick: () => setMaking(true),
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
    /* **The pane, with the rail beside it.** The column exists whether or not
       the drawer is open, so opening it never changes which element scrolls
       and never drops a scroll position. The band is measured on this pane
       rather than on the window — see `right-rail.ts`. */
    <WithRail
      onDismiss={() => setWant({ to: null })}
      rail={
        opened
          ? () => (
              <ProfileDrawer
                key={opened}
                profile={opened}
                want={want ?? undefined}
                /* **Each position in *In teams* is a destination.** It opens
                   that team's map with that card selected — the address
                   carries both, so the link can be shared and the back
                   control returns here. */
                onGoToSeat={(team, position) =>
                  navigate(`/configuration/agent-teams/${team}/${position}`)
                }
                onClose={letGo}
              />
            )
          : null
      }
    >
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
      note="A saved way of working: what an agent is told, which skills it loads, and how it runs."
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
              onOpen={() => openRow(role.id)}
              on={opened === role.id}
              onDelete={() => removeRole(role)}
            />
          ))}
        </Rowset>
      </Rows>

      {!blank && (
        <WhereTo>
          A profile is filed like a skill or a machine, so sharing one uses the same sheet.{" "}
          <b>Who it hands work to is a position in an agent team</b>, not a field here. Drop a
          folder of PROFILE.md files anywhere on this page to import them.
        </WhereTo>
      )}
    </Section>

      {making && (
        <NewProfileSheet
          filing={(dirs.data ?? [])
            .filter((d) => d.level === "writer" || d.level === "admin")
            .map((d) => ({ id: d.id, name: d.name }))}
          onClose={() => setMaking(false)}
          onCreate={make}
        />
      )}
    </div>
    </WithRail>
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


/** One role in the list: its name, what it does, and the shape of it as chips. */
function RoleRow({
  role,
  on,
  onOpen,
  onDelete,
}: {
  role: Role;
  /** Whether the drawer beside the list is holding this one. */
  on?: boolean;
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
    <div className="r" data-on={on || undefined}>
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

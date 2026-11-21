/**
 * Agent teams: every team, making one, and the way into a team's map.
 *
 * A team is a name and a tree of positions. A **position** references a
 * profile, reports to another position, and carries instructions that apply
 * in that seat and nowhere else — so reach is a property of a relationship
 * rather than of a profile, and the same Designer can have three reports in
 * one team and none in another. `docs/agent-teams.md` is the whole of it.
 *
 * **`agent-teams`, not `teams`.** `teams` is a group of *people* and has been
 * since `people_teams_and_paths`, which is why this pane is
 * `/configuration/agent-teams` and `destinations.test.ts` still asserts the
 * people's route belongs to nobody in the rail.
 *
 * A row says who leads a team, who is in it, how many positions it holds and
 * how deep it goes, so the map is never the only way to see one.
 */
import { useMemo, useState } from "react";
import { ChevronRight, Network, Plus, Search, Trash2, TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createAgentTeam,
  deleteAgentTeam,
  getListAgentTeamsQueryKey,
  useListAgentTeams,
} from "~/api/generated/agent-teams/agent-teams";
import { createRole, getListRolesQueryKey, useListRoles } from "~/api/generated/roles/roles";
import type { AgentTeam, Role } from "~/api/generated/model";
import { why } from "~/data";
import { Badge, Button, Icon, IconButton } from "~/components/ui";
import { Blank, Group as Rowset, Note, Rows, Section, Typed, WhereTo } from "~/ui/config/bits";
import { navigate } from "~/shims/next-navigation";
import { useOpened } from "~/ui/opened";
import { useConfirm } from "~/ui/Confirm";
import { autoAddedCount, schedulesPinning } from "~/ui/config/team-elsewhere";
import {
  EngineMark,
  Field,
  Group,
  Line,
  NewProfileSheet,
  ProfilePicker,
  Sheet,
  blankProfile,
} from "~/ui/config/TeamSheet";
import { TeamMap, count } from "~/ui/config/TeamMap";

const HOME = "/configuration/agent-teams";

export function AgentTeams({ open, at }: { open: string | null; at?: string | null }) {
  const [opened, setOpened] = useOpened(open);
  const cache = useQueryClient();
  const confirm = useConfirm();
  const feed = useListAgentTeams();
  const roles = useListRoles();
  const [q, setQ] = useState("");
  /** The sheet, from the moment it opens to the moment a team exists. */
  const [naming, setNaming] = useState<{ name: string; lead: string | null } | null>(null);
  const [makingLead, setMakingLead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const teams = useMemo(() => feed.data ?? [], [feed.data]);
  const profiles = roles.data ?? [];
  const leads = useMemo(
    () => new Set(teams.map((t) => t.lead).filter((id): id is string => !!id)),
    [teams],
  );

  /* Matches the team, its lead, or **anybody in it**, which is how somebody
     finds the teams one profile sits in without opening every map. */
  const needle = q.trim().toLowerCase();
  const shown = teams.filter(
    (t) =>
      !needle ||
      [t.name, t.leadName ?? "", ...(t.members ?? [])].some((s) =>
        s.toLowerCase().includes(needle),
      ),
  );

  /* **Navigate, and let `useOpened` follow the address.** Setting the open
     team here as well would unmount the map before the leave guard could put
     its question on screen, which is the one moment the draft still exists. */
  const go = (id: string) => navigate(`${HOME}/${id}`);
  /** One seat, in one team: where a row of the drawer's *In teams* tab goes. */
  const goToSeat = (team: string, position: string) => navigate(`${HOME}/${team}/${position}`);

  const make = async () => {
    if (!naming?.lead || !naming.name.trim() || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const made = await createAgentTeam({
        name: naming.name.trim(),
        lead: { profile: naming.lead },
      });
      await cache.invalidateQueries({ queryKey: getListAgentTeamsQueryKey() });
      setNaming(null);
      go(made.id);
    } catch (e) {
      setProblem(why(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Delete a team: **immediately, once confirmed**, not as a pending edit.
   *
   * The map is a draft and nothing there writes until Save — but a delete is
   * not a change to the tree, it is the removal of the thing the draft lives
   * in. Queuing it would make Save sometimes mean *destroy this*, and would
   * leave the leave-guard asking whether to save changes to a team that is
   * on its way out. So it reads as the profile library's delete instead: a
   * `.hov` control on the row, a confirmation that states the blast radius,
   * and the write the moment it is accepted.
   *
   * The server withdraws the approval from every schedule pinning the team
   * before it removes it, so nothing is left pinning something that is gone;
   * `TeamBlast` says that is what is about to happen.
   */
  const remove = async (team: AgentTeam) => {
    const ok = await confirm({
      title: `Delete ${team.name}?`,
      body: <TeamBlast team={team} />,
      action: team.positions > 1 ? "Delete the team and its positions" : "Delete team",
      tone: "danger",
    });
    if (!ok) return;
    setProblem(null);
    try {
      await deleteAgentTeam(team.id);
      await cache.invalidateQueries({ queryKey: getListAgentTeamsQueryKey() });
    } catch (e) {
      /* Said on the pane rather than swallowed: a destructive press that
         quietly did nothing is the worst of the three outcomes. */
      setProblem(why(e));
    }
  };

  /** A profile made from the sheet becomes the lead the sheet was asking for. */
  const makeLead = async (name: string, does: string) => {
    const made = await createRole(blankProfile(name, does));
    await cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
    setMakingLead(false);
    setNaming((n) => ({ name: n?.name ?? "", lead: made.id }));
  };

  if (opened) {
    return (
      <TeamMap
        id={opened}
        /* The seat the address names, so a link from the drawer's *In teams*
           tab opens the card rather than the tree it is in. */
        at={at ?? null}
        onClose={() => navigate(HOME)}
        onGoToSeat={goToSeat}
      />
    );
  }

  const blank = !feed.isLoading && !feed.error && teams.length === 0;
  const newTeam = (
    <Button
      variant="primary"
      icon={Plus}
      onClick={() => setNaming({ name: "", lead: null })}
    >
      New team
    </Button>
  );

  return (
    <>
      <Section
        title="Agent teams"
        note="A team is a lead and the profiles under it. Its tree is what decides who may hand work to whom."
        action={blank ? undefined : newTeam}
        controls={
          teams.length > 0 ? (
            <label className="find">
              <Search className="h-[15px] w-[15px] shrink-0" strokeWidth={1.75} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search teams and profiles"
                aria-label="Search teams and the profiles in them"
                spellCheck={false}
                className="placeholder:text-mute focus:outline-none"
              />
            </label>
          ) : undefined
        }
      >
        <Rows
          feed={{
            data: shown,
            loading: feed.isLoading,
            error: feed.error ? why(feed.error) : null,
          }}
          icon={Network}
          onRetry={() => void feed.refetch()}
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
                No team, lead or member matches <Typed>{q.trim()}</Typed>.
              </Note>
            ) : (
              <Blank icon={Network} title="No agent teams yet" action={newTeam}>
                A team gives a profile reports. Make one to say who hands work to whom.
              </Blank>
            )
          }
        >
          <Rowset>
            {shown.map((team) => (
              <TeamRow
                key={team.id}
                team={team}
                onOpen={() => go(team.id)}
                onDelete={() => void remove(team)}
              />
            ))}
          </Rowset>
        </Rows>

        {problem && !naming && (
          <Note icon={TriangleAlert}>{problem}</Note>
        )}

        {!blank && (
          <WhereTo>
            A team is filed like a profile or a skill, so sharing one uses the same sheet.{" "}
            <b>A profile put into a team arrives bare</b>: whatever it leads somewhere else
            stays there.
          </WhereTo>
        )}
      </Section>

      {naming && !makingLead && (
        <Sheet
          title="New team"
          onClose={() => setNaming(null)}
          foot={
            <>
              <span className="msg">{problem}</span>
              <Button variant="quiet" onClick={() => setNaming(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => void make()}
                disabled={!naming.name.trim() || !naming.lead || busy}
              >
                {busy ? "Creating…" : "Create team"}
              </Button>
            </>
          }
        >
          <p className="max-w-[60ch] text-body leading-relaxed text-text">
            Pick the profile at the top of the tree. Everything under it is added on the map and
            belongs to this team only.
          </p>
          <Field label="Name">
            <Line
              value={naming.name}
              onChange={(name) => setNaming({ ...naming, name })}
              placeholder="Growth"
              autoFocus
            />
          </Field>
          {/* **A group, not a label.** Both halves of this field are buttons,
              and a `label` around a button forwards to it every click that
              misses one — which made picking a lead undo itself. `Group` says
              the rest. */}
          <Group label="Led by">
            {naming.lead ? (
              <Chosen
                role={profiles.find((p) => p.id === naming.lead)}
                onChange={() => setNaming({ ...naming, lead: null })}
              />
            ) : (
              <ProfilePicker
                profiles={profiles}
                onPick={(lead) => setNaming({ ...naming, lead })}
                onMake={() => setMakingLead(true)}
                makeLabel="Create a profile to lead it"
                tag={(p) => (leads.has(p.id) ? { says: "leads another team" } : null)}
              />
            )}
          </Group>
        </Sheet>
      )}

      {naming && makingLead && (
        <NewProfileSheet onClose={() => setMakingLead(false)} onCreate={makeLead} />
      )}
    </>
  );
}

/**
 * One team.
 *
 * What it is, then who is in it, then its size. The sub-line is a sentence
 * rather than facts joined by middle dots, which is the habit `STYLE.md`
 * names; the two numbers are their own columns, where they can be scanned
 * down the list.
 */
function TeamRow({
  team,
  onOpen,
  onDelete,
}: {
  team: AgentTeam;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const automatic = autoAddedCount(team);
  /* **A `.r` of its own rather than `Row`.** `Row` with an `onClick` *is* a
     button, and the delete is a button too — one inside the other is markup
     no browser agrees about and a press that lands on both. The profile
     library draws exactly this shape for exactly this reason: the opening
     press is its own control, and the row's actions are its siblings. */
  return (
    <div className="r">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3.5 text-left"
      >
        <span className="g">
          <Icon of={Network} size={16} />
        </span>
        <span className="tx">
          <b>{team.name}</b>
          <s>{who(team)}</s>
        </span>
      </button>
      {automatic > 0 && (
        <Badge tone="amber">
          {automatic === 1 ? "1 added automatically" : `${automatic} added automatically`}
        </Badge>
      )}
      <span className="said">{count(team.positions, "position")}</span>
      <span className="said">{team.depth} deep</span>
      {/* Revealed on hover **and on keyboard focus** — `.hov` is what carries
          both, and hover alone is this feature's stated must-not. */}
      {team.mayWrite && (
        <IconButton
          of={Trash2}
          onClick={onDelete}
          label={`Delete ${team.name}`}
          hint="Delete team"
          className="hov hover:text-brick"
        />
      )}
      <span className="g text-mute">
        <Icon of={ChevronRight} size={14} />
      </span>
    </div>
  );
}

/**
 * What deleting a team takes with it, said before the press.
 *
 * Three facts, and each is here because leaving it out has already gone
 * wrong on this feature once: a count that understated the blast radius, and
 * a confirmation that was silent about what it could not see.
 *
 * **The positions.** `AgentTeam.positions` counts the whole tree with the
 * lead in it and is not filtered by what the reader can see, so it is the
 * honest total — unlike `members`, which is.
 *
 * **The schedules.** Editing a team pauses the schedules that pin it and one
 * press starts each again (`schedules/Pinned.tsx` owns that sentence).
 * Deleting is strictly worse and must not borrow the softer word: the server
 * withdraws the approval before it deletes, and there is no team left to
 * approve again, so each schedule refuses at the launch gate until somebody
 * points it elsewhere. `AgentTeam.schedules` is already on the row — no
 * second request — and it is zero for anybody who could not save, which is
 * the same set that is shown this control at all.
 *
 * **The profiles.** The one thing somebody fears here is the one thing that
 * does not happen, so it is said rather than implied.
 */
export function TeamBlast({ team }: { team: AgentTeam }) {
  const pinned = schedulesPinning(team);
  return (
    <>
      <p>
        This deletes {team.name} and {count(team.positions, "position")} in it, the lead
        included.
      </p>
      {pinned > 0 && (
        <p>
          {pinned === 1
            ? "1 schedule runs as this team and loses its approval."
            : `${pinned} schedules run as this team and lose their approval.`}{" "}
          Editing a team pauses them and one press starts each again. This does not: there is no
          team left to approve, so {pinned === 1 ? "it refuses" : "each refuses"} to run until
          somebody points {pinned === 1 ? "it" : "them"} at another team.
        </p>
      )}
      <p>
        <b>The profiles are not deleted.</b> A position only references one — take the position
        away and the profile stays in your library, leading whatever it leads elsewhere.
      </p>
    </>
  );
}

/** Who leads it, and who else is in it. */
function who(team: AgentTeam): string {
  const lead = team.leadName ?? (team.lead ? "a profile you cannot see" : null);
  if (!lead) return "No lead. The profile that led it was deleted.";
  const members = team.members ?? [];
  if (members.length === 0) return `Led by ${lead}, with nobody under it yet.`;
  const first = members.slice(0, 3);
  const rest = members.length - first.length;
  const names = rest > 0 ? `${first.join(", ")} and ${rest} more` : list(first);
  return `Led by ${lead}, with ${names} under it.`;
}

/** `A`, `A and B`, `A, B and C`. */
function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function Chosen({ role, onChange }: { role: Role | undefined; onChange: () => void }) {
  return (
    <div className="leadpick">
      <span className="grid shrink-0 place-items-center text-dim">
        <EngineMark role={role} size={14} />
      </span>
      <b>{role?.name ?? "A profile you cannot see"}</b>
      <span className="ds">{role?.does}</span>
      <button onClick={onChange} className="btn quiet">
        Change
      </button>
    </div>
  );
}

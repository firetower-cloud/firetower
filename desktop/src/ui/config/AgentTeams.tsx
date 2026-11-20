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
import { ChevronRight, Network, Plus, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createAgentTeam,
  getListAgentTeamsQueryKey,
  useListAgentTeams,
} from "~/api/generated/agent-teams/agent-teams";
import { createRole, getListRolesQueryKey, useListRoles } from "~/api/generated/roles/roles";
import type { AgentTeam, Role } from "~/api/generated/model";
import { why } from "~/data";
import { Badge, Button, Icon } from "~/components/ui";
import { Blank, Group as Rowset, Note, Row, Rows, Section, Typed, WhereTo } from "~/ui/config/bits";
import { navigate } from "~/shims/next-navigation";
import { useOpened } from "~/ui/opened";
import { autoAddedCount } from "~/ui/config/team-elsewhere";
import {
  EngineMark,
  Field,
  Line,
  NewProfileSheet,
  ProfilePicker,
  Sheet,
  blankProfile,
} from "~/ui/config/TeamSheet";
import { TeamMap, count } from "~/ui/config/TeamMap";

const HOME = "/configuration/agent-teams";

export function AgentTeams({ open }: { open: string | null }) {
  const [opened, setOpened] = useOpened(open);
  const cache = useQueryClient();
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

  /** A profile made from the sheet becomes the lead the sheet was asking for. */
  const makeLead = async (name: string, does: string) => {
    const made = await createRole(blankProfile(name, does));
    await cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
    setMakingLead(false);
    setNaming((n) => ({ name: n?.name ?? "", lead: made.id }));
  };

  if (opened) {
    return (
      <TeamMap id={opened} onClose={() => navigate(HOME)} />
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
              <TeamRow key={team.id} team={team} onOpen={() => go(team.id)} />
            ))}
          </Rowset>
        </Rows>

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
              <span className="msg">
                {problem ?? "Nothing is created until you press Create team."}
              </span>
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
          <Field label="Led by">
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
          </Field>
          <p className="mt-3 mb-1 max-w-[60ch] text-meta leading-relaxed text-dim">
            Any profile can lead a team, and there is no setting to turn on first. This one
            starts with nothing under it. Add the rest on the map.
          </p>
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
function TeamRow({ team, onOpen }: { team: AgentTeam; onOpen: () => void }) {
  const automatic = autoAddedCount(team);
  return (
    <Row glyph={<Icon of={Network} size={16} />} name={team.name} sub={who(team)} onClick={onOpen}>
      {automatic > 0 && (
        <Badge tone="amber">
          {automatic === 1 ? "1 added automatically" : `${automatic} added automatically`}
        </Badge>
      )}
      <span className="said">{count(team.positions, "position")}</span>
      <span className="said">{team.depth} deep</span>
      <span className="g text-mute">
        <Icon of={ChevronRight} size={14} />
      </span>
    </Row>
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

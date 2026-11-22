/**
 * Agent teams: a lead profile, and the tree of positions under it.
 *
 * **A profile stopped carrying who it hands work to.** It used to, in
 * `delegate_scope`, which made teams exist in effect without existing as a
 * thing: you could not see who was capable of what, a profile's children
 * travelled with it into any team that borrowed it, delegation was one level
 * deep, and the default was unbounded. So identity and structure came apart. A
 * profile is identity — name, what it does, instructions, skills, how it runs.
 * A team is structure, and this is where it is drawn.
 *
 * The Designer in two teams is two positions referencing one profile, with
 * different children in each, because the team says so and the profile says
 * nothing.
 *
 * ## Two screens, one route
 *
 * The list — every team with its lead, its size and its depth, read without
 * opening anything — and the map, which is one team.
 * `/configuration/agent-teams` and `/configuration/agent-teams/<id>`. **Not
 * `/configuration/teams`**, which is teams of *people* and must not be reused.
 *
 * ## The map drafts; Save is the only commit
 *
 * Adding, removing, moving and telling all write to a draft held here. Discard
 * restores the whole state, the removed subtree included, because the tree
 * itself was never touched — which is why the remove control carries no
 * confirmation dialog: the undo is on screen the whole time, and the control's
 * own label states the count before it is pressed. Save sends the draft as one
 * `PUT`, so a team is never half-written.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Info,
  Network,
  PanelRightClose,
  Plus,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Blank, Group as Rowset, Note, Rows, Section, Typed, WhereTo } from "~/ui/config/bits";
import { WhoCanAccess } from "~/ui/Sharing";
import { CreateMenu } from "~/ui/config/CreateMenu";
import { useStart } from "~/start";
import { AgentMark, AGENT_LABEL } from "~/components/AgentMark";
import { Badge, Icon, IconButton } from "~/components/ui";
import { Pop } from "~/ui/Pop";
import { useConfirm } from "~/ui/Confirm";
import { navigate } from "~/shims/next-navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  createAgentTeam,
  deleteAgentTeam,
  getListAgentTeamsQueryKey,
  updateAgentTeam,
} from "~/api/generated/agent-teams/agent-teams";
import { useAgentTeams, useAgents, teamsUsing, why } from "~/data";
import {
  createRole,
  getListRolesQueryKey,
  updateRole,
  useListRoles,
} from "~/api/generated/roles/roles";
import type { Agent, AgentTeam, Position, Role } from "~/api/generated/model";
import {
  CW,
  IND,
  depthOf,
  layout,
  leadOf,
  subtreeOf,
  treeOf,
  type Card as Laid,
  type Laid as Plan,
} from "~/ui/config/teams/layout";
import {
  add,
  descendants,
  draftOf,
  markOf,
  pending,
  remove,
  reparent,
  tell,
  toWrite,
  type Change,
  type Draft,
} from "~/ui/config/teams/draft";

export function AgentTeams({ open: asked = null }: { open?: string | null }) {
  const feed = useAgentTeams();
  const open = asked ? feed.data.find((t) => t.id === asked) : undefined;

  // The address is the state, so a team can be linked to and the back button
  // works — the rule every other pane keeps.
  if (asked && !feed.loading && !open) {
    return (
      <Section title="Agent teams">
        <Blank icon={Network} title="That team isn’t here" shape="plate">
          It may have been deleted, or it may be one you cannot see. Nothing is hidden by this
          window — the server decides, and it did not offer this one.
        </Blank>
      </Section>
    );
  }
  if (open) return <Map team={open} />;
  return <TeamList feed={feed} />;
}

/* ── The list ──────────────────────────────────────────────────────────── */

/**
 * Every team, with what a person needs before opening one.
 *
 * **The map must not be the only way to see a team.** The lead, the size and
 * the depth are on the row, so "which of these runs eight agents" is answered
 * without a click.
 */
function TeamList({ feed }: { feed: ReturnType<typeof useAgentTeams> }) {
  const [q, setQ] = useState("");
  const [making, setMaking] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const confirm = useConfirm();
  const cache = useQueryClient();
  const start = useStart();

  const needle = q.trim().toLowerCase();
  const shown = feed.data.filter(
    (t) =>
      !needle ||
      t.name.toLowerCase().includes(needle) ||
      (leadOf(t)?.name ?? "").toLowerCase().includes(needle),
  );

  const removeTeam = async (team: AgentTeam) => {
    const lead = leadOf(team);
    const held = team.positions.length;
    const ok = await confirm({
      title: `Delete “${team.name}”?`,
      /* **What goes, and what does not.** The positions are the team's and go
         with it; the profiles were only ever referenced and stay in the
         library. Saying both is this sentence's whole job — somebody deleting
         a team of eight has to know they are not deleting eight profiles. */
      body: `The ${held} position${held === 1 ? "" : "s"} in it go. ${
        lead ? `${lead.name} and the other profiles stay` : "The profiles stay"
      } in your library and in any other team they are in.${
        lead ? ` Started on its own, ${lead.name} hands work to nobody.` : ""
      }${
        team.schedules > 0
          ? ` ${team.schedules} schedule${team.schedules === 1 ? " names" : "s name"} this team and will refuse to run.`
          : ""
      }`,
      action: "Delete team",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await deleteAgentTeam(team.id);
      await cache.invalidateQueries({ queryKey: getListAgentTeamsQueryKey() });
    } catch (e) {
      setTrouble(why(e));
    }
  };

  return (
    <Section
      title="Agent teams"
      note="A team is a lead and the profiles under it. What a position has directly beneath it is what that agent can hand work to — and a profile started on its own hands work to nobody."
      action={
        <CreateMenu
          label="New team"
          choices={[
            {
              icon: Network,
              label: "Draw one here",
              note: "Pick a lead, then put profiles under it.",
              onPick: () => setMaking(true),
            },
            {
              icon: Sparkles,
              label: "Ask an agent",
              note: "Describe what you want and let it build the team.",
              onPick: () =>
                start({
                  prompt:
                    "Create a Firetower agent team. Ask me what it should do, what each member is for and who reports to whom, then use `list_profiles`, `create_profile` for anything missing, and `create_team`. The team I want is ",
                }),
            },
          ]}
        />
      }
      controls={
        feed.data.length > 4 ? (
          <div className="relative w-full max-w-xs">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mute"
              strokeWidth={1.75}
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search teams and leads…"
              aria-label="Search agent teams"
              className="w-full rounded-md border border-line bg-ground py-1.5 pr-2.5 pl-8 text-ui text-bone transition-colors placeholder:text-mute focus:border-dim focus:outline-none"
            />
          </div>
        ) : undefined
      }
      trouble={feed.trouble}
      error={feed.error}
      settling={feed.loading}
    >
      {trouble && (
        <Note icon={TriangleAlert} control={<button onClick={() => setTrouble(null)} className="btn quiet">Dismiss</button>}>
          {trouble}
        </Note>
      )}
      <Rows
        feed={{ data: shown, loading: feed.loading, error: feed.error }}
        icon={Network}
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
              No team matches <Typed>{q.trim()}</Typed>. Search reads a team’s name and its
              lead’s.
            </Note>
          ) : (
            <Blank
              icon={Network}
              title="No agent teams yet"
              action={
                <button onClick={() => setMaking(true)} className="btn primary">
                  <Icon of={Plus} size={14} />
                  New team
                </button>
              }
            >
              Until a profile is in a team it hands work to nobody — it does its own work and
              reports back. A team is what gives one somebody to hand to.
            </Blank>
          )
        }
      >
        <Rowset>
          {shown.map((team) => (
            <TeamRow key={team.id} team={team} onDelete={() => removeTeam(team)} />
          ))}
        </Rowset>
      </Rows>
      {making && (
        <NewTeam
          onClose={() => setMaking(false)}
          onMade={(id) => navigate(`/configuration/agent-teams/${id}`)}
        />
      )}
    </Section>
  );
}

function TeamRow({ team, onDelete }: { team: AgentTeam; onDelete: () => void }) {
  const lead = leadOf(team);
  const agent = (lead?.agent ?? null) as Agent | null;
  const depth = depthOf(team);
  const size = team.positions.length;
  return (
    <div className="r">
      <button
        onClick={() => navigate(`/configuration/agent-teams/${team.id}`)}
        className="flex min-w-0 flex-1 items-center gap-3.5 text-left"
      >
        <span
          className="g"
          role="img"
          aria-label={
            agent
              ? `Its lead runs ${AGENT_LABEL[agent] ?? agent}`
              : "Its lead runs whichever engine you pick"
          }
        >
          {agent ? (
            <AgentMark agent={agent} size={16} />
          ) : (
            <CircleDashed className="h-4 w-4" strokeWidth={1.75} />
          )}
        </span>
        <span className="tx">
          <b>{team.name}</b>
          {/* **The lead is named on the row, always.** A team that does not
              name its lead is the misleading case: you never talk to a team,
              you talk to its lead, and the size says how many that brings. */}
          <s>
            Led by {lead?.name ?? "nobody"} · {size} agent{size === 1 ? "" : "s"} · {depth} level
            {depth === 1 ? "" : "s"} deep
          </s>
        </span>
      </button>
      {team.schedules > 0 && (
        <Badge>
          {team.schedules} schedule{team.schedules === 1 ? "" : "s"}
        </Badge>
      )}
      {team.mayWrite && (
        <IconButton of={Trash2} label={`Delete ${team.name}`} onClick={onDelete} />
      )}
      <span className="said">
        <Icon of={ChevronRight} size={14} />
      </span>
    </div>
  );
}

/* ── Making one ────────────────────────────────────────────────────────── */

/**
 * A new team: a name and a lead.
 *
 * **Any profile can lead.** There is no Manager flag to set first — that flag
 * is what this change removed — so the picker offers every profile, and the
 * team is drawn on the map afterwards.
 *
 * The lead is chosen through the same [`PickProfile`] the map's `+` uses, so
 * searching for one and making one that does not exist yet work the same way
 * in both places. A library of thirty profiles is a scroll otherwise, and
 * "the one I want is not here" is a dead end otherwise.
 */
function NewTeam({ onClose, onMade }: { onClose: () => void; onMade: (id: string) => void }) {
  const [name, setName] = useState("");
  const [lead, setLead] = useState<Role | null>(null);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const cache = useQueryClient();

  const make = async () => {
    if (!lead || !name.trim() || busy) return;
    setBusy(true);
    setTrouble(null);
    try {
      const made = await createAgentTeam({
        name: name.trim(),
        positions: [{ key: "lead", parent: null, profile: lead.id, extraInstructions: "" }],
      });
      await cache.invalidateQueries({ queryKey: getListAgentTeamsQueryKey() });
      onMade(made.id);
    } catch (e) {
      setTrouble(why(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-start justify-center bg-scrim pt-[10vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label="New agent team"
        className="flex max-h-[80vh] w-[29rem] flex-col overflow-hidden rounded-xl border border-line lift shadow-(--shadow-float)"
      >
        <div className="flex items-start gap-2 border-b border-line px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block text-ui text-bone">New team</span>
            <span className="block truncate text-micro text-mute">
              A lead, and the profiles under it
            </span>
          </span>
          <IconButton of={X} label="Close" onClick={onClose} />
        </div>

        <div className="dbody scroll-slim">
          <div className="dsec">
            <label className="lb" htmlFor="team-name">
              Name
            </label>
            <input
              id="team-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && make()}
              placeholder="Product"
              autoFocus
              className="field"
            />
          </div>

          <div className="dsec">
            <span className="lb">Lead</span>
            <PickProfile chosen={lead?.id ?? null} onPick={setLead} />
            <span className="said">
              Starting the team starts this profile, with the team behind it.
            </span>
          </div>

          {trouble && (
            <div className="dsec">
              <p className="text-ui text-brick">{trouble}</p>
            </div>
          )}
        </div>

        {/* Its own padding and its own rule, rather than `.dlgfoot` — that one
            is written to sit inside `.dlg`'s 18px of bottom padding, and this
            sheet has none: it is a head, a scrolling body and a foot. */}
        <div className="sh-foot">
          <span className="where">
            {lead ? `Starts ${lead.name}, with nothing under it yet.` : "Pick the profile that leads it."}
          </span>
          <button onClick={onClose} className="btn quiet">
            Cancel
          </button>
          <button
            onClick={make}
            disabled={busy || !lead || !name.trim()}
            className="btn primary disabled:opacity-50"
          >
            {busy ? "Making…" : "Make team"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Pick a profile, search a library of them, or make one that is not there.
 *
 * One component for the two places a profile is chosen — the lead of a new
 * team, and what goes under a card — because they are the same question and
 * because "the one I want does not exist yet" is a dead end in both. Making
 * one here creates it immediately and selects it: a profile is the library's,
 * not this team's, so there is nothing to roll back if the team is never made.
 */
function PickProfile({
  chosen,
  onPick,
  under,
}: {
  chosen: string | null;
  onPick: (r: Role) => void;
  /** Named when this is choosing what goes *under* something. */
  under?: string;
}) {
  const roles = useListRoles();
  const [q, setQ] = useState("");
  const [making, setMaking] = useState(false);
  const needle = q.trim().toLowerCase();
  const all = roles.data ?? [];
  const shown = all.filter(
    (r) => !needle || r.name.toLowerCase().includes(needle) || (r.does ?? "").toLowerCase().includes(needle),
  );

  return (
    <>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mute"
          strokeWidth={1.75}
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={under ? `Search profiles to put under ${under}…` : "Search profiles…"}
          aria-label="Search profiles"
          className="field pl-8"
        />
      </div>

      <div className="scroll-slim max-h-64 overflow-y-auto rounded-lg border border-line">
        {/* **First, and not behind an empty state.** Somebody with thirty
            profiles still reaches for one that is not among them, and a route
            that only appears when the list is empty is a route they never
            find. */}
        <button type="button" onClick={() => setMaking(true)} className="mi w-full items-center">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md border border-line text-dim">
            <Icon of={Plus} size={12} />
          </span>
          <span className="min-w-0 flex-1 text-left">
            <span className="block text-ui text-bone">New profile</span>
            <span className="block truncate text-micro text-mute">
              {needle ? `Make one called “${q.trim()}”` : "Name it and say what it does"}
            </span>
          </span>
        </button>

        {shown.map((r) => (
          <button
            key={r.id}
            type="button"
            aria-pressed={chosen === r.id}
            onClick={() => onPick(r)}
            className="mi w-full items-start"
          >
            <span className="mt-0.5 shrink-0">
              {r.agent ? (
                <AgentMark agent={r.agent as Agent} size={14} />
              ) : (
                <CircleDashed className="h-3.5 w-3.5 text-mute" strokeWidth={1.75} />
              )}
            </span>
            <span className="min-w-0 flex-1 text-left">
              <span className="block text-ui text-bone">{r.name}</span>
              <span className="block truncate text-micro text-mute">{r.does}</span>
            </span>
            {chosen === r.id && <Badge>chosen</Badge>}
          </button>
        ))}

        {shown.length === 0 && all.length > 0 && (
          <p className="px-3 py-2.5 text-micro text-mute">
            No profile matches “{q.trim()}”. Search reads the name and what it does.
          </p>
        )}
        {all.length === 0 && (
          <p className="px-3 py-2.5 text-micro text-mute">
            There are no profiles yet. A team is profiles and where they sit, so make the first
            one above.
          </p>
        )}
      </div>

      {making && (
        <NewProfile
          name={q.trim()}
          onClose={() => setMaking(false)}
          onMade={(r) => {
            setMaking(false);
            setQ("");
            onPick(r);
          }}
        />
      )}
    </>
  );
}

/**
 * Make a profile without leaving the team you are building.
 *
 * **Two fields and a fold.** A name and what it does are the two a profile
 * cannot be saved without — the server refuses either empty — and everything
 * else is a commitment the profile may simply not make: an unset engine, an
 * unset placement and empty instructions are all real, working answers. So
 * they are behind *Advanced*, open to anybody who wants them and skippable by
 * everybody else, rather than a form that asks six questions to get two.
 *
 * It writes immediately. A profile belongs to the library rather than to the
 * team being drawn, so there is nothing here to commit later and nothing to
 * undo if the team is abandoned — it is on the Agent profiles screen either
 * way, theirs to edit or delete.
 */
function NewProfile({
  name: seeded,
  onClose,
  onMade,
}: {
  name?: string;
  onClose: () => void;
  onMade: (r: Role) => void;
}) {
  const [name, setName] = useState(seeded ?? "");
  const [does, setDoes] = useState("");
  const [instructions, setInstructions] = useState("");
  const [agent, setAgent] = useState<string | null>(null);
  const [placement, setPlacement] = useState("lead");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const agents = useAgents();
  const cache = useQueryClient();

  const make = async () => {
    if (!name.trim() || !does.trim() || busy) return;
    setBusy(true);
    setTrouble(null);
    try {
      const made = await createRole({
        name: name.trim(),
        does: does.trim(),
        instructions,
        placement,
        agent,
        settings: {},
        skillScope: [],
      });
      await cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
      onMade(made);
    } catch (e) {
      setTrouble(why(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-start justify-center bg-scrim pt-[10vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label="New profile"
        className="flex max-h-[80vh] w-[28rem] flex-col overflow-hidden rounded-xl border border-line lift shadow-(--shadow-float)"
      >
        <div className="flex items-start gap-2 border-b border-line px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block text-ui text-bone">New profile</span>
            <span className="block truncate text-micro text-mute">
              What an agent is. Where it sits is the team's business.
            </span>
          </span>
          <IconButton of={X} label="Close" onClick={onClose} />
        </div>

        <div className="dbody scroll-slim">
          <div className="dsec">
            <span className="lb">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Reviewer"
              autoFocus
              className="field"
            />
          </div>

          <div className="dsec">
            <span className="lb">What it does</span>
            <input
              value={does}
              onChange={(e) => setDoes(e.target.value)}
              placeholder="Reads a finished branch and reports what is wrong with it."
              className="field"
            />
            <span className="said">
              The one line a lead reads before handing it work.
            </span>
          </div>

          <div className="dsec">
            <button
              type="button"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              className="flex items-center gap-1.5 text-meta text-dim hover:text-bone"
            >
              <Icon of={open ? ChevronDown : ChevronRight} size={14} />
              Advanced
              {!open && <span className="text-mute">— instructions, engine, placement</span>}
            </button>

            {open && (
              <div className="mt-3 flex flex-col gap-4">
                <div>
                  <span className="lb">Instructions</span>
                  <textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    rows={6}
                    placeholder={"# Reviewer\n\nYou review. You do not fix."}
                    className="field"
                  />
                  <span className="said">
                    Composed into its prompt, in every team. Markdown.
                  </span>
                </div>

                <div>
                  <span className="lb">Engine</span>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      aria-pressed={agent === null}
                      onClick={() => setAgent(null)}
                      className="pill"
                    >
                      <Icon of={CircleDashed} size={14} />
                      Let the lead choose
                    </button>
                    {agents.data
                      .filter((a) => a.supported)
                      .map((a) => (
                        <button
                          key={a.kind}
                          type="button"
                          aria-pressed={agent === a.kind}
                          onClick={() => setAgent(a.kind as string)}
                          className="pill"
                        >
                          <AgentMark agent={a.kind as Agent} size={13} />
                          {a.label}
                        </button>
                      ))}
                  </div>
                </div>

                <div>
                  <span className="lb">Where a child runs</span>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      ["lead", "Let the lead choose"],
                      ["here", "The lead's workspace"],
                      ["new", "Its own workspace"],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={placement === value}
                        onClick={() => setPlacement(value!)}
                        className="pill"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {trouble && (
            <div className="dsec">
              <p className="text-ui text-brick">{trouble}</p>
            </div>
          )}
        </div>

        <div className="sh-foot">
          <span className="where">
            {open ? "" : "Advanced can be set later on Agent profiles."}
          </span>
          <button onClick={onClose} className="btn quiet">
            Cancel
          </button>
          <button
            onClick={make}
            disabled={busy || !name.trim() || !does.trim()}
            className="btn primary disabled:opacity-50"
          >
            {busy ? "Making…" : "Make profile"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── The map ───────────────────────────────────────────────────────────── */

function Map({ team }: { team: AgentTeam }) {
  const roles = useListRoles();
  const [draft, setDraft] = useState<Draft>(() => draftOf(team));
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ parent: string; at: HTMLElement } | null>(null);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const cache = useQueryClient();

  const changes = useMemo(() => pending(team, draft), [team, draft]);
  const dirty = changes.length > 0;

  /* The stored team is the draft's base, so a team changed on the server while
     this was open re-bases rather than silently fighting the save. Only while
     nothing is pending: taking somebody's unsaved work away because a
     colleague renamed the team would be worse than a stale base. */
  useEffect(() => {
    if (!dirty) setDraft(draftOf(team));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team]);

  const laid = useMemo(() => layout(treeOf(draft.positions)), [draft]);

  /* **The tree is fitted to the canvas, not clipped by it.**
     Eight positions three levels deep is wider than the pane once the drawer
     has taken its share, and the first cut answered that by scrolling — so
     opening a card on the right sliced the card on the left in half, with a
     connector running off the edge into nothing. A reader cannot hold a shape
     they can only ever see two thirds of.

     So it scales down to fit, and stops at 0.72: below that the 13.5px name
     on a card is 9px, which is a drawing of a team rather than a team. Past
     that it scrolls, which is the honest answer for a genuinely huge one. It
     never scales *up* — a team of two is two cards, not two posters. */
  const canvas = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const watch = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box) setRoom({ w: box.width, h: box.height });
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const scale = useMemo(() => {
    if (!room.w || !laid.w) return 1;
    return Math.max(0.72, Math.min(1, room.w / laid.w, room.h / laid.h));
  }, [room, laid.w, laid.h]);

  /* Opening a card brings it into view, for the case scrolling is still the
     answer. `nearest` so a card already visible does not move — the map
     jumping on every click would be worse than the overlap. */
  useEffect(() => {
    if (!selected) return;
    const card = canvas.current?.querySelector<HTMLElement>(`[data-key="${selected}"]`);
    card?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selected]);
  const chosen = draft.positions.find((p) => p.id === selected) ?? null;
  const deep = laid.cards.reduce((d, c) => Math.max(d, c.depth + 1), 0);

  const save = async () => {
    setBusy(true);
    setTrouble(null);
    try {
      /* **Re-based from what came back, not from the refetch.** A position
         the map added carries a `draft:` key and comes back with a minted id,
         so comparing the draft against the saved team reads as one added and
         one removed — which leaves the map permanently dirty and the effect
         below permanently unable to re-base it. The response is the team as
         written, so it is what the draft becomes. */
      const saved = await updateAgentTeam(team.id, toWrite(draft));
      setDraft(draftOf(saved));
      await cache.invalidateQueries({ queryKey: getListAgentTeamsQueryKey() });
    } catch (e) {
      setTrouble(why(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={team.name}
      note={`Led by ${leadOf(team)?.name ?? "nobody"} · ${team.positions.length} agents`}
      action={
        <button onClick={() => navigate("/configuration/agent-teams")} className="btn plain">
          <Icon of={ChevronLeft} size={14} />
          All teams
        </button>
      }
    >
      {/* **The action row appears when there is something to commit.** A Save
          that is disabled most of the time is a control that mostly says no;
          the strip under the map already says that nothing writes until Save,
          so the button arrives with the first change and the row takes no
          height before that. `--row-tight`, because a 30px control cannot
          live in the 22px strip. */}
      {dirty && (
        <div className="maprow">
          <span className="pend">
            {changes.length} change{changes.length === 1 ? "" : "s"} not saved
          </span>
          <span className="flex-1" />
          <button onClick={() => setDraft(draftOf(team))} disabled={busy} className="btn quiet">
            Discard
          </button>
          <button
            onClick={save}
            disabled={busy || !team.mayWrite}
            className="btn primary disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      )}

      {trouble && <Note icon={TriangleAlert}>{trouble}</Note>}
      {/* **What Save does to the schedules that pin this team**, said before
          Save rather than discovered by a run being refused. Editing a team
          clears its approval, which pauses every schedule naming it. */}
      {dirty && team.schedules > 0 && (
        <Note icon={TriangleAlert}>
          Saving pauses {team.schedules} schedule{team.schedules === 1 ? "" : "s"} that pin this
          team. The next run of each is refused until somebody approves the new shape.
        </Note>
      )}
      {!team.mayWrite && (
        <WhereTo>
          <b>You can read this team and not change it.</b> Whoever administers the directory it is
          filed in can.
        </WhereTo>
      )}

      {/* **Two columns, not a panel under the map.** The drawer is the only
          full editor and it is read *against* the card it was opened from, so
          it docks beside the map in the app's own right-rail geometry rather
          than below it — where opening one pushes the thing it is about off
          the screen. Under 900px of pane there is no room for both and it
          stacks, which is the band rule the rest of the app keeps. */}
      {/* **The map takes the page's height, not the tree's.** Sizing the box
          to the drawing left the bottom half of the screen empty under a
          small team and gave a large one no more room than a small one. The
          box is the window; the tree is fitted into it. */}
      <div className="mapsplit" data-open={!!chosen}>
        <div className="mapbox">
          {/* Centred on each axis it fits on, and pinned on one it does not.
              Independently, because a tree is routinely wider than the room
              and shorter than it: all-or-nothing left a small team sitting in
              the top-left corner of a box twice its height. A scroll that
              starts in the middle is a tree you have to go and find, so the
              axis that scrolls pins. */}
          <div
            ref={canvas}
            className="mapcanvas scroll-slim"
            data-fits-x={laid.w * scale <= room.w + 1}
            data-fits-y={laid.h * scale <= room.h + 1}
          >
            {/* Centred when it fits, left-aligned when it does not — a tree
                that starts in the middle of a scroll is a tree you have to
                find. */}
            <div
              className="mapinner"
              style={{ width: laid.w, height: laid.h, transform: `scale(${scale})` }}
            >
              <Wires laid={laid} />
              {laid.cards.map((c) => (
                <MapCard
                  key={c.key}
                  card={c}
                  mark={markOf(team, draft, c.key)}
                  selected={selected === c.key}
                  writable={team.mayWrite}
                  under={subtreeOf(c).length}
                  onOpen={() => setSelected(selected === c.key ? null : c.key)}
                  onAdd={(at) => setAdding({ parent: c.key, at })}
                  onRemove={() => {
                    setDraft((d) => remove(d, c.key));
                    if (selected === c.key) setSelected(null);
                  }}
                />
              ))}
            </div>
          </div>
          {/* 22px. Counts and a sentence, and no controls at all. */}
          <div className="mapstrip">
            <span>
              {draft.positions.length} position{draft.positions.length === 1 ? "" : "s"} · {deep}{" "}
              level{deep === 1 ? "" : "s"} deep
            </span>
            <span className="flex-1" />
            <span className="truncate">
              {dirty
                ? changes.map(said).join(" · ")
                : "Adding, removing and moving write nothing until Save."}
            </span>
          </div>
        </div>

        {chosen && (
          <Drawer
            team={team}
            position={chosen}
            kids={draft.positions.filter((p) => p.parent === chosen.id)}
            elsewhere={draft.positions.filter(
              (p) =>
                p.id !== chosen.id &&
                p.id !== chosen.parent &&
                !descendants(draft.positions, chosen.id).some((x) => x.id === p.id),
            )}
            parentName={draft.positions.find((p) => p.id === chosen.parent)?.name ?? null}
            writable={team.mayWrite}
            onTell={(text) => setDraft((d) => tell(d, chosen.id, text))}
            onMove={(parent) => setDraft((d) => reparent(d, chosen.id, parent))}
            onClose={() => setSelected(null)}
          />
        )}
      </div>

      {adding && (
        <Pop anchor={adding.at} onClose={() => setAdding(null)} width={320}>
          <div className="flex flex-col gap-2.5 p-2.5">
            <p className="text-micro text-mute">
              Under {draft.positions.find((p) => p.id === adding.parent)?.name ?? "the lead"}. A
              profile that leads another team arrives here with nothing under it.
            </p>
            <PickProfile
              chosen={null}
              under={draft.positions.find((p) => p.id === adding.parent)?.name}
              onPick={(r) => {
                setDraft((d) => add(d, adding.parent, r.id, r.name, r.does, r.agent ?? null));
                setAdding(null);
              }}
            />
          </div>
        </Pop>
      )}
    </Section>
  );
}

/** One pending change, in a few words. */
function said(c: Change): string {
  switch (c.kind) {
    case "added":
      return `${c.name} added`;
    case "removed":
      return `${c.name} removed`;
    case "moved":
      return `${c.name} moved`;
    case "told":
      return `${c.name} told something new`;
    case "lead":
      return `${c.name} now leads`;
    case "renamed":
      return `renamed ${c.name}`;
  }
}

/**
 * The connectors.
 *
 * An elbow where children spread — down from the parent's bottom centre, along
 * the row, and down into each child's top centre — and a bracket where they
 * indent. One SVG behind the cards rather than borders on them, so a card's
 * own box is never part of the drawing and a card can move without the line
 * following it a frame late.
 */
function Wires({ laid }: { laid: Plan }) {
  return (
    <svg className="mapwires" width={laid.w} height={laid.h} aria-hidden="true">
      {laid.links.map((l, i) => {
        if (l.kind === "indent") {
          const x = l.from.x + IND / 2;
          const y1 = l.from.y + l.from.h;
          const y2 = l.to.y + l.to.h / 2;
          return <path key={i} d={`M ${x} ${y1} V ${y2} H ${l.to.x}`} fill="none" />;
        }
        const fx = l.from.x + CW / 2;
        const fy = l.from.y + l.from.h;
        const tx = l.to.x + CW / 2;
        const ty = l.to.y;
        const mid = fy + (ty - fy) / 2;
        return <path key={i} d={`M ${fx} ${fy} V ${mid} H ${tx} V ${ty}`} fill="none" />;
      })}
    </svg>
  );
}

/**
 * One card.
 *
 * Two controls, and **neither is reachable by hover alone**: `+` at the bottom
 * centre, on the connector trunk, because that is where the child appears; and
 * the destructive one at the top right, which states its blast radius in its
 * own label before it is pressed. The lead has no destructive control —
 * removing it would remove the team, which is done from the list.
 */
function MapCard({
  card,
  mark,
  selected,
  writable,
  under,
  onOpen,
  onAdd,
  onRemove,
}: {
  card: Laid;
  mark: "add" | "move" | null;
  selected: boolean;
  writable: boolean;
  /** How many go with it, for the remove control's own label. */
  under: number;
  onOpen: () => void;
  onAdd: (at: HTMLElement) => void;
  onRemove: () => void;
}) {
  const p = card.position;
  const agent = (p.agent ?? null) as Agent | null;
  const brief = p.extraInstructions.trim().split("\n").find((l) => l.trim()) ?? "";
  const kids = card.kids.length;
  const takes =
    under > 0
      ? `Take ${p.name} and the ${under} under it out of this team`
      : `Take ${p.name} out of this team`;
  return (
    <div
      className="oc"
      data-key={card.key}
      data-on={selected}
      data-lead={card.depth === 0}
      data-pend={mark ?? ""}
      style={{ left: card.x, top: card.y, width: card.w, height: card.h }}
      title={
        p.redacted
          ? "A profile you cannot see holds this position."
          : `${p.name}. ${p.does}${brief ? `\n\nIn this team: ${brief}` : ""}`
      }
    >
      <button type="button" className="ocopen" onClick={onOpen} aria-label={`Open ${p.name}`}>
        <span className="ocrow">
          <span className="g">
            {!p.redacted && agent ? (
              <AgentMark agent={agent} size={13} />
            ) : (
              <CircleDashed className="h-3.5 w-3.5 text-mute" strokeWidth={1.75} />
            )}
          </span>
          <span className="nm">{p.redacted ? "Not yours to see" : p.name}</span>
          {kids > 0 && (
            <span className="cnt" title={`${kids} directly under it here`}>
              {kids}
            </span>
          )}
        </span>
        {brief && <span className="brf">{brief}</span>}
      </button>
      {writable && (
        <button
          type="button"
          className="plus"
          title={`Put a profile under ${p.name}`}
          aria-label={`Put a profile under ${p.name}`}
          onClick={(e) => onAdd(e.currentTarget)}
        >
          <Plus className="h-3 w-3" strokeWidth={2} />
        </button>
      )}
      {writable && card.depth > 0 && (
        /* **The count, before it happens.** A collapsed branch is a blast
           radius you cannot see, so it is in the control's own label rather
           than in a dialog after the press — and there is no dialog, because
           this writes the draft and Discard brings the whole subtree back. */
        <button type="button" className="bin" title={takes} aria-label={takes} onClick={onRemove}>
          <X className="h-3 w-3" strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

/**
 * The drawer: where a position, and the profile under it, are edited.
 *
 * **Two tabs, because there are two objects and they reach differently.**
 * *Extra instructions* is this position in this team; *Profile* is the thing
 * every team that uses it shares. Drawn as one panel because you open it by
 * pressing one card and the question "is this mine or everyone's" is the one
 * a person gets wrong — so the panel answers it in a word, at the top, rather
 * than in a sentence nobody re-reads.
 *
 * **A position never replaces a profile field. It only adds.** So there is no
 * resolution order to define and no override semantics to explain — which is
 * why the first tab holds *extra* instructions rather than overrides.
 */
function Drawer({
  team,
  position,
  kids,
  elsewhere,
  parentName,
  writable,
  onTell,
  onMove,
  onClose,
}: {
  team: AgentTeam;
  position: Position;
  /** What it hands work to, as the draft now stands. */
  kids: Position[];
  /** Everywhere it could be moved to: not itself, not where it already is,
   *  and nothing beneath it — which is the one move that is not a tree. */
  elsewhere: Position[];
  parentName: string | null;
  writable: boolean;
  onTell: (text: string) => void;
  onMove: (parent: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"here" | "profile">("here");
  const [moving, setMoving] = useState<HTMLElement | null>(null);
  const teams = useAgentTeams();
  // Every team holding this profile — the consequence of editing the Profile
  // tab, which is not visible from here and is the thing somebody gets wrong.
  const alsoIn = teamsUsing(teams.data, position.profile);

  return (
    <aside className="mapdrawer" aria-label={`${position.name}, a position in ${team.name}`}>
      <div className="dhead">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui text-bone">
            {position.redacted ? "Not yours to see" : position.name}
          </span>
          <span className="block truncate text-micro text-mute">
            {team.name} · {position.parent ? "a position" : "the lead"}
          </span>
        </span>
        <IconButton of={PanelRightClose} label="Close" onClick={onClose} />
      </div>

      {/* The app's own right-rail index: plain text with an underline, not
          boxed chips. The index of a panel should not compete with it. */}
      <div className="itabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "here"}
          onClick={() => setTab("here")}
          className="itab"
        >
          Extra instructions
          {tab === "here" && <span className="ul" />}
        </button>
        <button
          role="tab"
          aria-selected={tab === "profile"}
          onClick={() => setTab("profile")}
          className="itab"
        >
          Profile
          {tab === "profile" && <span className="ul" />}
        </button>
      </div>

      <div className="dbody scroll-slim">
        {tab === "here" ? (
          <>
            <div className="dsec">
              <span className="lb">What it is told here</span>
              <textarea
                value={position.extraInstructions}
                onChange={(e) => onTell(e.target.value)}
                rows={7}
                disabled={!writable}
                placeholder={"Owns the web client.\nFollow the design system in docs/."}
                className="field"
              />
              <span className="said">
                Added to {position.name}’s own instructions, in {team.name} only.
              </span>
            </div>

            {position.parent && (
              <div className="dsec">
                <span className="lb">Reports to</span>
                {writable && elsewhere.length > 0 ? (
                  <>
                    <button
                      type="button"
                      className="field flex items-center justify-between text-left"
                      onClick={(e) => setMoving(moving ? null : e.currentTarget)}
                    >
                      {parentName ?? "the lead"}
                      <Icon of={ChevronDown} size={12} className="text-mute" />
                    </button>
                    {moving && (
                      <Pop anchor={moving} onClose={() => setMoving(null)} width={240}>
                        <div className="py-1">
                          {elsewhere.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              className="mi"
                              onClick={() => {
                                onMove(p.id);
                                setMoving(null);
                              }}
                            >
                              <span className="min-w-0 flex-1 truncate text-left text-ui text-bone">
                                {p.name}
                              </span>
                            </button>
                          ))}
                        </div>
                      </Pop>
                    )}
                    <span className="said">Moving it takes everything under it along.</span>
                  </>
                ) : (
                  <p className="text-ui text-text">{parentName ?? "the lead"}</p>
                )}
              </div>
            )}

            <div className="dsec">
              <span className="lb">
                Hands work to{kids.length > 0 ? ` · ${kids.length}` : ""}
              </span>
              {kids.length === 0 ? (
                <p className="text-ui text-mute">
                  Nobody. Press <b className="text-dim">+</b> on its card.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {kids.map((p) => (
                    <li key={p.id} className="flex items-center gap-2 text-ui text-text">
                      <span className="text-mute">
                        {p.agent ? <AgentMark agent={p.agent as Agent} size={12} /> : <Icon of={CircleDashed} size={12} />}
                      </span>
                      <span className="min-w-0 truncate">{p.name}</span>
                    </li>
                  ))}
                </ul>
              )}
              <span className="said">
                The positions directly under this one, and nothing else.
              </span>
            </div>
          </>
        ) : (
          <ProfileTab profile={position.profile} alsoIn={alsoIn} team={team} />
        )}
      </div>
    </aside>
  );
}

/**
 * The profile under this position, edited where it is read.
 *
 * **It says what it reaches before it is changed, not after.** Editing here
 * changes the profile in every team that holds it, and the other teams are
 * not on this screen — so the band names them. That is the one consequence a
 * person cannot see from the card they pressed.
 *
 * The three fields a profile cannot be without are here; the rest — the
 * engine, the machine, the skills, the limits — stay on Agent profiles, where
 * there is room to explain them. A link, rather than a second copy of a form
 * that is already long.
 */
function ProfileTab({
  profile,
  alsoIn,
  team,
}: {
  profile: string;
  alsoIn: string[];
  team: AgentTeam;
}) {
  const roles = useListRoles();
  const role = (roles.data ?? []).find((r) => r.id === profile);
  const [draft, setDraft] = useState<{ name: string; does: string; instructions: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const cache = useQueryClient();

  // Re-read when the profile arrives, or when another screen changed it —
  // but never over an edit in progress.
  useEffect(() => {
    if (role && !draft) {
      setDraft({ name: role.name, does: role.does, instructions: role.instructions });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role?.id]);

  if (!role || !draft) {
    return <p className="pt-3 text-ui text-mute">Reading the profile…</p>;
  }

  const changed =
    draft.name !== role.name || draft.does !== role.does || draft.instructions !== role.instructions;

  const save = async () => {
    setBusy(true);
    setTrouble(null);
    try {
      await updateRole(role.id, {
        name: draft.name,
        does: draft.does,
        instructions: draft.instructions,
        placement: role.placement,
        agent: role.agent,
        machine: role.machine,
        account: role.account,
        settings: role.settings,
        onUsageLimit: role.onUsageLimit,
        onChildLimit: role.onChildLimit,
        includeAlwaysOn: role.includeAlwaysOn,
        includeRepoDefaults: role.includeRepoDefaults,
        skillScope: role.skillScope ?? [],
      });
      await cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
      await cache.invalidateQueries({ queryKey: getListAgentTeamsQueryKey() });
    } catch (e) {
      setTrouble(why(e));
    } finally {
      setBusy(false);
    }
  };

  const others = alsoIn.filter((n) => n !== team.name);

  return (
    <>
      <div className="dsec">
        <p className="text-micro leading-relaxed text-mute">
          {others.length > 0 ? (
            <>
              <b className="font-medium text-dim">Shared.</b> {role.name} also holds a position in{" "}
              {others.join(", ")} — this changes it there too.
            </>
          ) : (
            <>
              <b className="font-medium text-dim">The profile, not this position.</b> Anything
              that puts {role.name} in another team carries these words with it.
            </>
          )}
        </p>
      </div>

      <div className="dsec">
        <span className="lb">Name</span>
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          disabled={!role.mayWrite}
          className="field"
        />
      </div>

      <div className="dsec">
        <span className="lb">What it does</span>
        <input
          value={draft.does}
          onChange={(e) => setDraft({ ...draft, does: e.target.value })}
          disabled={!role.mayWrite}
          className="field"
        />
        <span className="said">The one line a lead reads before handing it work.</span>
      </div>

      <div className="dsec">
        <span className="lb">Instructions</span>
        <textarea
          value={draft.instructions}
          onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
          rows={8}
          disabled={!role.mayWrite}
          className="field"
        />
      </div>

      {trouble && (
        <div className="dsec">
          <p className="text-ui text-brick">{trouble}</p>
        </div>
      )}

      <div className="dsec flex items-center gap-2">
        {role.mayWrite ? (
          /* **Its own Save.** The map's Save writes the team and must not
             write a profile — a map action that changed a profile would be
             the model leaking. Two objects, two commits, two buttons. */
          <>
            <button
              onClick={save}
              disabled={busy || !changed}
              className="btn primary disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save profile"}
            </button>
            {changed && (
              <button
                onClick={() =>
                  setDraft({ name: role.name, does: role.does, instructions: role.instructions })
                }
                className="btn quiet"
              >
                Revert
              </button>
            )}
          </>
        ) : (
          <p className="text-micro text-mute">
            Read-only. Whoever administers the directory it is filed in can change it.
          </p>
        )}
      </div>

      <div className="dsec flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={() => navigate(`/configuration/roles/${role.id}`)}
          className="text-meta text-dim underline underline-offset-2 hover:text-bone"
        >
          Engine, skills and the rest
        </button>
        {team.mayShare && (
          <WhoCanAccess kind="agentTeam" id={team.id} path={team.path} look="chip" label="Sharing" />
        )}
      </div>
    </>
  );
}

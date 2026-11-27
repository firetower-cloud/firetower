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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleDashed, Minus, Network, PanelRightClose, Plus, Search, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
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
  setDefaultRole,
  updateRole,
  useListRoles,
} from "~/api/generated/roles/roles";
import { ProfileForm } from "~/ui/config/profile/ProfileForm";
import { toDraft } from "~/ui/config/Roles";
import type { Agent, AgentTeam, NewRole, Position, Role } from "~/api/generated/model";
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
import { add, draftOf, grant, markOf, pending, remove, tell, toWrite, type Change, type Draft } from "~/ui/config/teams/draft";
import { useSkills } from "~/data";
import { Mark } from "~/ui/config/Library";

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

        {/* The same `.form` the drawer and the profile editor are, at a
            sheet's width. One set of components for every surface that edits
            a profile or a position. */}
        <div className="dbody scroll-slim">
          <div className="form">
            <label className="fld">
              <span>Name</span>
              <span className="box">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && make()}
                  placeholder="Product"
                  autoFocus
                />
              </span>
            </label>

            <div role="group" aria-label="Lead" className="fld">
              <span>Lead</span>
              <span className="hint">
                Starting the team starts this profile, with the team behind it.
              </span>
              <PickProfile chosen={lead?.id ?? null} onPick={setLead} />
            </div>

            {trouble && <p className="bad">{trouble}</p>}
          </div>
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
      {/* The glyph lives inside the box rather than in the padding of an
          input: `.box` is a row, so a mark is one more child of it. */}
      <span className="box">
        <Icon of={Search} size={14} className="shrink-0 text-mute" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={under ? `Search profiles to put under ${under}…` : "Search profiles…"}
          aria-label="Search profiles"
        />
      </span>

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
          <div className="form">
            <label className="fld">
              <span>Name</span>
              <span className="box">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Reviewer"
                  autoFocus
                />
              </span>
            </label>

            <label className="fld">
              <span>What it does</span>
              <span className="hint">The one line a lead reads before handing it work.</span>
              <span className="box">
                <input
                  value={does}
                  onChange={(e) => setDoes(e.target.value)}
                  placeholder="Reads a finished branch and reports what is wrong with it."
                />
              </span>
            </label>

            {/* **Two fields and a fold.** Everything behind it is a
                commitment the profile may simply not make — an unset engine,
                an unset placement and empty instructions are all real,
                working answers. */}
            <div className="fld">
              <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                className="flex items-center gap-1.5 self-start text-meta text-dim hover:text-bone"
              >
                <Icon of={open ? ChevronDown : ChevronRight} size={14} />
                Advanced
                {!open && <span className="text-mute">— instructions, engine, placement</span>}
              </button>
            </div>

            {open && (
              <>
                <label className="fld">
                  <span>Instructions</span>
                  <span className="hint">Composed into its prompt, in every team. Markdown.</span>
                  <span className="box mono">
                    <textarea
                      value={instructions}
                      onChange={(e) => setInstructions(e.target.value)}
                      rows={6}
                      placeholder={"# Reviewer\n\nYou review. You do not fix."}
                    />
                  </span>
                </label>

                <div role="group" aria-label="Engine" className="fld">
                  <span>Engine</span>
                  <span className="hint">Leave it open and the lead’s agent runs it.</span>
                  <div className="pickrow">
                    <button
                      type="button"
                      aria-pressed={agent === null}
                      onClick={() => setAgent(null)}
                      className="pk"
                    >
                      <span className="ic">
                        <Icon of={CircleDashed} size={14} />
                      </span>
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
                          className="pk"
                        >
                          <span className="ic">
                            <AgentMark agent={a.kind as Agent} size={14} />
                          </span>
                          {a.label}
                        </button>
                      ))}
                  </div>
                </div>

                <div role="group" aria-label="Where a child runs" className="fld">
                  <span>Where a child runs</span>
                  <div className="pickrow">
                    {[
                      ["lead", "Let the lead choose"],
                      ["here", "The lead’s workspace"],
                      ["new", "Its own workspace"],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={placement === value}
                        onClick={() => setPlacement(value!)}
                        className="pk"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {trouble && <p className="bad">{trouble}</p>}
          </div>
        </div>

        <div className="sh-foot">
          <span className="where" />
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

/** How far the canvas goes either way. Below a third the name on a card is
 *  six pixels, which is a drawing of a team rather than a team. */
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;

/**
 * One team, drawn on a canvas you drag.
 *
 * **The map is the page.** It was a boxed canvas in `.pg`'s 1000px column,
 * which gave a thing you arrange less room than the window it is in, and
 * answered a tree wider than the box by scrolling — so opening a card on the
 * right sliced the card on the left in half, with a connector running off the
 * edge into nothing. There is no column here: the canvas is the body, it pans
 * and zooms, and the chrome floats on it.
 *
 * **The drawer is an overlay, not a column.** A column takes width from the
 * map permanently and reflows the drawing every time one opens. This takes
 * none, and the map underneath does not move — except for the one nudge in
 * `clearOf`, when the card the drawer is about would otherwise be behind it.
 */
function Map({ team }: { team: AgentTeam }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(team));
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ parent: string; at: HTMLElement } | null>(null);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const cache = useQueryClient();

  const changes = useMemo(() => pending(team, draft), [team, draft]);
  const dirty = changes.length > 0;

  /* The stored team is the draft's base, so a team changed on the server
     while this was open re-bases rather than silently fighting the save.
     Only while nothing is pending: taking somebody's unsaved work away
     because a colleague renamed the team would be worse than a stale base. */
  useEffect(() => {
    if (!dirty) setDraft(draftOf(team));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team]);

  const laid = useMemo(() => layout(treeOf(draft.positions)), [draft]);

  /* ── Pan and zoom ──────────────────────────────────────────────────
     The view lives in a ref and is written straight to the one element that
     carries the transform. Keeping it in state would re-render every card on
     every pointer move to change a number no card reads. */
  const canvas = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const view = useRef({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  /** Whether a person has moved the view themselves. See the observer below. */
  const touched = useRef(false);
  /** Where the map was before the drawer pushed it aside, if it did. */
  const nudged = useRef<number | null>(null);
  const plan = useRef(laid);
  plan.current = laid;
  // The percentage on the toolbar is the one thing that does read it.
  const [zoom, setZoom] = useState(1);

  const apply = useCallback(() => {
    const w = world.current;
    if (!w) return;
    const { x, y, k } = view.current;
    w.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  }, []);

  /** One move, animated. Cleared afterwards so dragging stays immediate. */
  const ease = useCallback(() => {
    const w = world.current;
    if (!w) return;
    w.style.transition = "transform 260ms var(--ease-swift)";
    window.setTimeout(() => {
      if (world.current) world.current.style.transition = "";
    }, 280);
  }, []);

  const fit = useCallback(
    (animate?: boolean) => {
      const el = canvas.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const { w, h } = plan.current;
      if (!w || !box.width) return;
      // Never above 1: a team of two is two cards, not two posters.
      const k = Math.max(MIN_ZOOM, Math.min(1, (box.width - 48) / w, (box.height - 48) / h));
      /* **Centred on each axis it fits on, pinned on one it does not.**
         Independently, because a tree is routinely wider than the room and
         shorter than it. A big team in a narrow pane hits the zoom floor and
         still overflows — centred, that cuts it off on *both* sides with the
         lead nowhere near where you would look for it. Pinned, it starts at
         the top left and the rest is a drag away. */
      const wide = w * k > box.width - 48;
      const tall = h * k > box.height - 48;
      view.current = {
        k,
        x: wide ? 24 : (box.width - w * k) / 2,
        y: tall ? 24 : (box.height - h * k) / 2,
      };
      if (animate) ease();
      apply();
      setZoom(k);
    },
    [apply, ease],
  );

  const zoomAt = useCallback(
    (cx: number, cy: number, next: number) => {
      const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
      const v = view.current;
      // The point under the cursor stays under the cursor.
      view.current = { k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) };
      touched.current = true;
      apply();
      setZoom(k);
    },
    [apply],
  );

  const zoomMid = useCallback(
    (by: number) => {
      const el = canvas.current;
      if (!el) return;
      zoomAt(el.clientWidth / 2, el.clientHeight / 2, by);
    },
    [zoomAt],
  );

  // The transform belongs to this element and React does not write it, so it
  // is re-asserted after every render rather than only when the view changes.
  useLayoutEffect(apply);

  /* **Fitted when the room changes, unless somebody has moved the view.**
     Refitting unconditionally yanks a person back to the middle every time
     the window is resized or the rail's panel is collapsed, undoing a pan
     they chose. Refitting never leaves a map off screen after the pane
     halves in width. This is the line between the two. */
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const watch = new ResizeObserver(() => {
      if (!touched.current) fit(false);
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [fit]);

  // A different team is a different drawing: start it fitted, whatever the
  // last one was left at.
  useEffect(() => {
    touched.current = false;
    fit(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.id]);

  /* **Wheel is attached by hand, and only to the canvas.** React routes
     `onWheel` through a passive listener at the root, so `preventDefault` is
     ignored there and the whole app scrolls behind the map. Scoped to this
     element rather than the document, because a global wheel handler would
     swallow the gesture the annotation layer is driven by. */
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      touched.current = true;
      const box = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        /* **Exponential, not linear.** `k * (1 - deltaY/100)` is smooth for a
           trackpad pinch, where `deltaY` arrives a point or two at a time,
           and absurd for a wheel, where one notch is 120 and takes 100% to
           220% in a single click. A ratio per unit of scroll is the same
           gesture at both scales, and it cannot invert at large deltas. */
        zoomAt(
          e.clientX - box.left,
          e.clientY - box.top,
          view.current.k * Math.exp(-e.deltaY * 0.0022),
        );
        return;
      }
      view.current = { ...view.current, x: view.current.x - e.deltaX, y: view.current.y - e.deltaY };
      apply();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [apply, zoomAt]);

  /* **The drawer comes over the canvas, so the card it is about can end up
     under it.** A panel that hides the thing it describes is the failure an
     overlay invites. Move the map by the overlap, and only when there is
     one — a map that jumps on every click would be worse. */
  const clearOf = useCallback(
    (key: string) => {
      const el = canvas.current;
      const card = plan.current.cards.find((c) => c.key === key);
      if (!el || !card) return;
      const box = el.getBoundingClientRect();
      // `offsetWidth`, not the rect: the drawer is mid-slide and its rect
      // still says it is off the right edge covering nothing.
      const panel = document.querySelector<HTMLElement>(".mapdrawer");
      const wide = panel?.offsetWidth ?? 0;
      const covered = Math.max(0, box.right - (window.innerWidth - wide));
      if (covered <= 0 || covered >= box.width - CW) return;
      const over = view.current.x + (card.x + card.w) * view.current.k - (box.width - covered - 28);
      if (over > 0) {
        nudged.current = view.current.x;
        view.current = { ...view.current, x: view.current.x - over };
        ease();
        apply();
      }
    },
    [apply, ease],
  );

  /* **And put it back.** The nudge belongs to the drawer, so it is undone
     with it — otherwise opening three cards in a row walks the map off to
     the left and leaves it there, with the lead somewhere behind the rail.
     Skipped if a person has dragged since, because then the view is theirs
     and taking it back would be the map overruling them. */
  const unnudge = useCallback(() => {
    if (nudged.current === null) return;
    const x = nudged.current;
    nudged.current = null;
    view.current = { ...view.current, x };
    ease();
    apply();
  }, [apply, ease]);

  const shut = useCallback(() => {
    setSelected(null);
    unnudge();
  }, [unnudge]);

  const open = (key: string) => {
    if (selected === key) {
      shut();
      return;
    }
    // Back to where the map was before the last card pushed it, so two
    // cards in a row do not add up to two nudges.
    unnudge();
    setSelected(key);
    // After the drawer is in the DOM and has a width to measure.
    window.requestAnimationFrame(() => clearOf(key));
  };

  // Escape closes the drawer, wherever the focus is.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") shut();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, shut]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 90 : 28;
    const go: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    if (go[e.key]) {
      e.preventDefault();
      const [dx, dy] = go[e.key]!;
      view.current = { ...view.current, x: view.current.x + dx, y: view.current.y + dy };
      touched.current = true;
      apply();
      return;
    }
    if (e.key === "0") {
      e.preventDefault();
      touched.current = false;
      fit(true);
    }
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomMid(view.current.k * 1.2);
    }
    if (e.key === "-") {
      e.preventDefault();
      zoomMid(view.current.k / 1.2);
    }
  };

  const chosen = draft.positions.find((p) => p.id === selected) ?? null;
  const deep = laid.cards.reduce((d, c) => Math.max(d, c.depth + 1), 0);
  const lead = leadOf(team);

  const save = async () => {
    setBusy(true);
    setTrouble(null);
    try {
      /* **Re-based from what came back, not from the refetch.** A position
         the map added carries a `draft:` key and comes back with a minted
         id, so comparing the draft against the saved team reads as one added
         and one removed — which leaves the map permanently dirty and the
         effect above permanently unable to re-base it. */
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
    <div className="mappage">
      <div className="maphead">
        <span className="tx">
          <h1>{team.name}</h1>
          <span className="sub">
            Led by {lead?.name ?? "nobody"} · {draft.positions.length} agents
          </span>
        </span>
        <span className="acts">
          {/* **Arrives with the first change.** A Save that is disabled most
              of the time is a control that mostly says no, and the strip
              below already says nothing writes until Save. */}
          {dirty && (
            <>
              <span className="pendpill">
                {changes.length} change{changes.length === 1 ? "" : "s"} not saved
              </span>
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
            </>
          )}
          <button onClick={() => navigate("/configuration/agent-teams")} className="btn plain">
            <Icon of={ChevronLeft} size={14} />
            All teams
          </button>
        </span>
      </div>

      {/* Only ever drawn when there is something to say. The canvas is the
          page the rest of the time. */}
      {(trouble || !team.mayWrite || (dirty && team.schedules > 0)) && (
        <div className="mapnotes">
          {trouble && <Note icon={TriangleAlert}>{trouble}</Note>}
          {/* **What Save does to the schedules that pin this team**, said
              before Save rather than discovered by a run being refused. */}
          {dirty && team.schedules > 0 && (
            <Note icon={TriangleAlert}>
              Saving pauses {team.schedules} schedule{team.schedules === 1 ? "" : "s"} that pin
              this team. The next run of each is refused until somebody approves the new shape.
            </Note>
          )}
          {!team.mayWrite && (
            <WhereTo>
              <b>You can read this team and not change it.</b> Whoever administers the directory
              it is filed in can.
            </WhereTo>
          )}
        </div>
      )}

      <div className="canvaswrap">
        <div
          ref={canvas}
          className="mapcanvas"
          tabIndex={0}
          role="application"
          aria-label="Team map. Drag to pan, hold command and scroll to zoom."
          onKeyDown={onKeyDown}
          onPointerDown={(e) => {
            // A card's own controls are not a handle to drag the map by.
            if ((e.target as HTMLElement).closest("button")) return;
            drag.current = { x: e.clientX - view.current.x, y: e.clientY - view.current.y, id: e.pointerId };
            canvas.current?.setPointerCapture(e.pointerId);
            canvas.current?.classList.add("dragging");
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || e.pointerId !== d.id) return;
            view.current = { ...view.current, x: e.clientX - d.x, y: e.clientY - d.y };
            touched.current = true;
            nudged.current = null;
            apply();
          }}
          onPointerUp={() => {
            drag.current = null;
            canvas.current?.classList.remove("dragging");
          }}
          onPointerCancel={() => {
            drag.current = null;
            canvas.current?.classList.remove("dragging");
          }}
        >
          <div ref={world} className="mapworld" style={{ width: laid.w, height: laid.h }}>
            <Wires laid={laid} team={team} draft={draft} />
            {laid.cards.map((c) => (
              <MapCard
                key={c.key}
                card={c}
                mark={markOf(team, draft, c.key)}
                selected={selected === c.key}
                writable={team.mayWrite}
                under={subtreeOf(c).length}
                onOpen={() => open(c.key)}
                onAdd={(at) => setAdding({ parent: c.key, at })}
                onRemove={() => {
                  setDraft((d) => remove(d, c.key));
                  if (selected === c.key) shut();
                }}
              />
            ))}
          </div>
        </div>

        {/* Floating on the canvas rather than in the header: these are about
            what you are looking at, not about the team, and they belong
            beside the thing they move. */}
        <div className="maptools" role="toolbar" aria-label="View">
          <button
            className="maptool"
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => zoomMid(view.current.k / 1.2)}
          >
            <Icon of={Minus} size={14} />
          </button>
          <button className="maptool wide" title="Back to 100%" onClick={() => zoomMid(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button
            className="maptool"
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() => zoomMid(view.current.k * 1.2)}
          >
            <Icon of={Plus} size={14} />
          </button>
          <span className="maptoolsep" />
          <button
            className="maptool wide"
            title="Fit the whole team"
            onClick={() => {
              touched.current = false;
              fit(true);
            }}
          >
            Fit
          </button>
        </div>
      </div>

      {/* Counts and a sentence. No controls, ever. */}
      <div className="mapstrip">
        <span>
          {draft.positions.length} position{draft.positions.length === 1 ? "" : "s"} · {deep} level
          {deep === 1 ? "" : "s"} deep
        </span>
        <span className="flex-1" />
        <span className="says">
          {dirty
            ? changes.map(said).join(" · ")
            : "Drag to pan · ⌘-scroll to zoom · nothing writes until Save."}
        </span>
      </div>

      {chosen && (
        <>
          {/* **A pointer convenience, and not a tab stop.** Clicking the
              scrim closes the drawer; a keyboard has Escape and the Close
              button in the head, which are better routes than a focus ring
              drawn around the whole window. */}
          <button
            className="dveil"
            tabIndex={-1}
            aria-hidden
            onClick={shut}
          />
          <Drawer
            team={team}
            position={chosen}
            writable={team.mayWrite}
            onTell={(text) => setDraft((d) => tell(d, chosen.id, text))}
            onGrant={(ids) => setDraft((d) => grant(d, chosen.id, ids))}
            onClose={shut}
          />
        </>
      )}

      {adding && (
        <Pop anchor={adding.at} onClose={() => setAdding(null)} width={320}>
          {/* A `.fld`, because the picker is a field: it is the same label,
              hint and box stack here as it is in the new-team sheet, and
              `.box` is styled as a field's box. */}
          <div role="group" aria-label="Put a profile under this one" className="fld p-2.5">
            <span className="hint">
              Under {draft.positions.find((p) => p.id === adding.parent)?.name ?? "the lead"}. A
              profile that leads another team arrives here with nothing under it.
            </span>
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
    </div>
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
 * An elbow where children spread — down from the parent's bottom centre,
 * along the row, and down into each child's top centre — and a bracket where
 * they indent. **Both corners are rounded**, by the same radius the cards
 * are: a tree of square corners under cards of round ones reads as two
 * drawings. One SVG behind the cards rather than borders on them, so a card's
 * own box is never part of the drawing.
 */
function Wires({ laid, team, draft }: { laid: Plan; team: AgentTeam; draft: Draft }) {
  return (
    <svg className="mapwires" width={laid.w} height={laid.h} aria-hidden="true">
      {laid.links.map((l, i) => {
        // Drafted, and not yet written — the line arrives dashed with the card.
        const fresh = markOf(team, draft, l.to.key) === "add" ? "fresh" : undefined;
        if (l.kind === "indent") {
          const x = l.from.x + IND / 2;
          const y1 = l.from.y + l.from.h;
          const y2 = l.to.y + l.to.h / 2;
          return (
            <path key={i} className={fresh} d={`M ${x} ${y1} V ${y2 - 7} q 0 7 7 7 H ${l.to.x}`} />
          );
        }
        const fx = l.from.x + CW / 2;
        const fy = l.from.y + l.from.h;
        const tx = l.to.x + CW / 2;
        const ty = l.to.y;
        const mid = fy + (ty - fy) / 2;
        const s = Math.sign(tx - fx);
        const r = Math.min(10, Math.abs(tx - fx) / 2);
        const bend =
          r > 1
            ? `V ${mid - r} q 0 ${r} ${s * r} ${r} H ${tx - s * r} q ${s * r} 0 ${s * r} ${r} V ${ty}`
            : `V ${ty}`;
        return <path key={i} className={fresh} d={`M ${fx} ${fy} ${bend}`} />;
      })}
    </svg>
  );
}

/**
 * One card.
 *
 * Two controls, and **neither is reachable by hover alone**: `+` at the
 * bottom centre, on the connector trunk, because that is where the child
 * appears; and the destructive one at the top right, which states its blast
 * radius in its own label before it is pressed. The lead has no destructive
 * control — removing it would remove the team, which is done from the list.
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
              <AgentMark agent={agent} size={14} />
            ) : (
              <Icon of={CircleDashed} size={14} />
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
 * *Extra instructions* is this position in this team, and it is one field:
 * who it reports to and what it hands work to are the map, drawn an inch
 * away, and a list of them beside it was the same thing said twice.
 * *Profile* is the thing every team that uses it shares — that one keeps its
 * band, because the reach it has is the consequence a person cannot see from
 * the card they pressed.
 *
 * **It is the profile editor's form, at 392px.** `.form` → `.fld` → label,
 * hint, `.box`/`.pickrow`, and `.sh-foot` under it: the same components
 * `/configuration/roles/<id>` is built from, because two surfaces editing the
 * same two objects should not be two designs — and the only way they stay
 * that way as either changes is to be the same components rather than two
 * that match today.
 *
 * **A position never replaces a profile field. It only adds.** So there is no
 * resolution order to define and no override semantics to explain.
 */
function Drawer({
  team,
  position,
  writable,
  onTell,
  onGrant,
  onClose,
}: {
  team: AgentTeam;
  position: Position;
  writable: boolean;
  onTell: (text: string) => void;
  /** What this position adds to its profile's set, in this team only. */
  onGrant: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"here" | "profile">("here");
  const teams = useAgentTeams();
  // Every team holding this profile — the consequence of editing the Profile
  // tab, which is not visible from here and is the thing somebody gets wrong.
  const alsoIn = teamsUsing(teams.data, position.profile);

  return (
    <aside className="mapdrawer" aria-label={`${position.name}, a position in ${team.name}`}>
      <div className="dhead">
        <span className="tx">
          <span className="nm">{position.redacted ? "Not yours to see" : position.name}</span>
          <span className="where">
            {team.name} · {position.parent ? "a position" : "the lead"}
          </span>
        </span>
        <IconButton of={PanelRightClose} label="Close" onClick={onClose} />
      </div>

      {/* The app's own index: plain text with an underline, not boxed chips.
          The index of a panel should not compete with it. */}
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

      {tab === "here" ? (
        <>
          <div className="dbody scroll-slim">
            {/* **One field, and nothing else.** The band said in a sentence
                what the tab says in its name; *Reports to* and *Hands work
                to* were the map drawn again in a list, next to the map. A
                position is moved and given children on the canvas, which is
                where both already read at a glance. */}
            <div className="form">
              <label className="fld grows">
                <span>Extra instructions</span>
                <span className="hint">
                  Added to {position.name}’s own instructions when it runs in this team.
                </span>
                <span className="box mono">
                  <textarea
                    value={position.extraInstructions}
                    onChange={(e) => onTell(e.target.value)}
                    rows={10}
                    disabled={!writable}
                    placeholder={"Owns the web client.\nFollow the design system in docs/."}
                  />
                </span>
              </label>

              {/* **Adds; never replaces.** The same contract as the field
                  above, and the reason both are called extra — the profile
                  already said what this agent *is*, and a position that wants
                  one more thing says so without forking it. Empty means
                  nothing extra, which is why this is not the `ScopePicker` a
                  profile's own scope uses: there, empty means everything. */}
              <label className="fld">
                <span>Extra skills &amp; MCP</span>
                <span className="hint">
                  Added to what {position.name} already carries, in this team only.
                </span>
                <PositionSkills
                  selected={position.extraSkills ?? []}
                  onChange={onGrant}
                  disabled={!writable}
                />
              </label>
            </div>
          </div>
          {/* **`.sh-foot`, not `.formfoot`.** A page's foot sticks to the
              bottom of a scroll it belongs to; a sheet's is pinned outside
              one. A drawer is a sheet. */}
          <div className="sh-foot">
            <span className="where">
              Written when you press <b>Save</b> on the map.
            </span>
          </div>
        </>
      ) : (
        <ProfileTab profile={position.profile} alsoIn={alsoIn} team={team} />
      )}
    </aside>
  );
}

/**
 * The profile under this position — **the same form the page renders.**
 *
 * It was three fields and a *Full editor* button that sent you to
 * `/configuration/roles/<id>` for the other nine. A panel that has to send
 * you somewhere else for most of what you came for is a panel missing the
 * thing you came for, and two forms over one object are two designs that
 * agree until one of them changes. So this renders `ProfileForm`, which the
 * page renders too, and the button is gone because there is nowhere left to
 * send anybody.
 *
 * What this surface owns is the commit: a drawer saves and **stays**, where
 * the page saves and closes. The map is still behind it and the position you
 * pressed is still the subject.
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
  const [draft, setDraft] = useState<NewRole | null>(null);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState(false);
  const [defaulting, setDefaulting] = useState(false);
  const cache = useQueryClient();

  // Re-read when the profile arrives, or when another screen changed it —
  // but never over an edit in progress.
  useEffect(() => {
    if (role && !draft) {
      setDraft(toDraft(role));
      setIsDefault(role.isDefault ?? false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role?.id]);

  if (!role || !draft) {
    return (
      <div className="dbody">
        <p className="nobody">Reading the profile…</p>
      </div>
    );
  }

  const changed = JSON.stringify(draft) !== JSON.stringify(toDraft(role));

  const toggleDefault = async () => {
    const next = !isDefault;
    setDefaulting(true);
    setTrouble(null);
    try {
      await setDefaultRole(role.id, { on: next });
      setIsDefault(next);
      await cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
    } catch (e) {
      setTrouble(why(e));
    } finally {
      setDefaulting(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setTrouble(null);
    try {
      await updateRole(role.id, { ...draft, agent: draft.agent || null });
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
      <div className="dbody scroll-slim">
        <ProfileForm
          draft={draft}
          setDraft={setDraft as React.Dispatch<React.SetStateAction<NewRole>>}
          role={role}
          state={{ id: role.id, path: role.placement }}
          isDefault={isDefault}
          defaulting={defaulting}
          onToggleDefault={toggleDefault}
        />
        {trouble && <p className="bad px-0">{trouble}</p>}
      </div>

      <div className="sh-foot">
        <span className="where">
          {!role.mayWrite
            ? "Read-only. An administrator of its directory can change it."
            : others.length > 0
              ? `Changes it in ${others.join(", ")} too.`
              : "Changes every team."}
        </span>
        {role.mayWrite && (
          /* **Its own Save.** The map's Save writes the team and must not
             write a profile — a map action that changed a profile would be
             the model leaking. Two objects, two commits, two buttons. */
          <button
            onClick={save}
            disabled={busy || !changed}
            className="btn primary disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save profile"}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * The skills and servers a position adds, ticked from what the owner has.
 *
 * **Not the `ScopePicker` a profile's own scope uses.** That one reads an
 * empty selection as "everything the owner can reach" and says so on its
 * summary line; here empty means nothing extra, and a control that said "all"
 * for a position that adds nothing would be exactly backwards.
 */
function PositionSkills({
  selected,
  onChange,
  disabled,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const all = useSkills().data;
  const [open, setOpen] = useState(selected.length > 0);
  const [q, setQ] = useState("");
  const chosen = new Set(selected);
  const shown = all.filter((s) => {
    const t = q.trim().toLowerCase();
    return !t || `${s.displayName ?? ""} ${s.name} ${s.description}`.toLowerCase().includes(t);
  });

  if (!open) {
    return (
      <button type="button" className="out" disabled={disabled} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" strokeWidth={1.5} />
        {selected.length > 0 ? `${selected.length} added` : "Add something"}
      </button>
    );
  }
  return (
    <span className="box">
      <label className="srch w-full">
        <Search className="h-4 w-4 text-mute" strokeWidth={1.5} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your skills and MCP servers"
          aria-label="Search your skills and MCP servers"
        />
      </label>
      <div className="mt-1 max-h-60 overflow-y-auto">
        {shown.map((s) => {
          const on = chosen.has(s.id);
          return (
            <button
              key={s.id}
              type="button"
              className="prow tight w-full"
              disabled={disabled}
              aria-pressed={on}
              onClick={() =>
                onChange(on ? selected.filter((id) => id !== s.id) : [...selected, s.id])
              }
            >
              <Mark logo={s.logo} name={s.displayName || s.name} />
              <span className="lbl flex-1 truncate">{s.displayName || s.name}</span>
              {on && <Check className="h-4 w-4 shrink-0 text-sage" strokeWidth={2} />}
            </button>
          );
        })}
        {shown.length === 0 && (
          <p className="py-2 text-meta text-dim">Nothing of yours matches that.</p>
        )}
      </div>
    </span>
  );
}

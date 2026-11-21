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
import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Info,
  Network,
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
import { useAgentTeams, why } from "~/data";
import { useListRoles } from "~/api/generated/roles/roles";
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
 * A new team: a name and a lead, and nothing else.
 *
 * **Any profile can lead.** There is no Manager flag to set first — that flag
 * is what this change removed — so the picker offers every profile, and the
 * team is drawn on the map afterwards.
 */
function NewTeam({ onClose, onMade }: { onClose: () => void; onMade: (id: string) => void }) {
  const roles = useListRoles();
  const [name, setName] = useState("");
  const [lead, setLead] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const cache = useQueryClient();
  const chosen = roles.data?.find((r) => r.id === lead);

  const make = async () => {
    if (!lead || !name.trim() || busy) return;
    setBusy(true);
    setTrouble(null);
    try {
      const made = await createAgentTeam({
        name: name.trim(),
        positions: [{ key: "lead", parent: null, profile: lead, extraInstructions: "" }],
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
      className="fixed inset-0 z-[60] grid place-items-start justify-center bg-scrim pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label="New agent team"
        className="flex max-h-[76vh] w-[29rem] flex-col overflow-hidden rounded-xl border border-line lift shadow-(--shadow-float)"
      >
        <div className="flex items-start gap-2 border-b border-line px-3.5 py-2.5">
          <span className="min-w-0 flex-1">
            <span className="block text-ui text-bone">New team</span>
            <span className="block truncate text-micro text-mute">
              A lead, and the profiles under it
            </span>
          </span>
          <IconButton of={X} label="Close" onClick={onClose} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3.5 py-3.5">
          <label className="fld">
            <span>Name</span>
            <span className="hint">What you pick in the composer, and what a schedule pins.</span>
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

          <div className="fld">
            <span className="text-ui text-bone">Lead</span>
            <span className="hint">
              Starting the team starts this profile, with the team behind it. Any profile can
              lead.
            </span>
            <div className="scroll-slim max-h-56 overflow-y-auto rounded-lg border border-line">
              {(roles.data ?? []).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={lead === r.id}
                  onClick={() => setLead(r.id)}
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
                  {lead === r.id && <Badge>lead</Badge>}
                </button>
              ))}
              {(roles.data ?? []).length === 0 && (
                <p className="p-3 text-micro text-mute">
                  There are no profiles yet. Make one on Agent profiles first — a team is profiles
                  and where they sit.
                </p>
              )}
            </div>
          </div>

          {trouble && <p className="text-ui text-brick">{trouble}</p>}

          <WhereTo>
            {chosen ? (
              <>
                <b>Starts {chosen.name}.</b> It hands work to nobody until you put a profile under
                it — which is the next screen.
              </>
            ) : (
              <>
                <b>You never talk to a team.</b> You talk to its lead, with the team behind it. So
                pick the profile that should be in the conversation.
              </>
            )}
          </WhereTo>
        </div>

        <div className="dlgfoot">
          <button onClick={onClose} className="btn quiet">
            Cancel
          </button>
          <button onClick={make} disabled={busy || !lead || !name.trim()} className="btn primary disabled:opacity-50">
            {busy ? "Making…" : "Make team"}
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
      note={`Led by ${leadOf(team)?.name ?? "nobody"}. What a card has directly under it is what that agent can hand work to.`}
      action={
        <button onClick={() => navigate("/configuration/agent-teams")} className="btn plain">
          <Icon of={ChevronLeft} size={14} />
          All teams
        </button>
      }
    >
      {/* **The action row, at `--row-tight`.** Save and Discard live here and
          not in the status strip: the desk has one control height, 30px, and a
          30px control in 22px of chrome overhangs it top and bottom. The strip
          under the canvas carries counts and a sentence, and no controls. */}
      <div className="maprow">
        {dirty && (
          <span className="pend">
            {changes.length} change{changes.length === 1 ? "" : "s"} not saved
          </span>
        )}
        <span className="flex-1" />
        {dirty && (
          <button onClick={() => setDraft(draftOf(team))} disabled={busy} className="btn quiet">
            Discard
          </button>
        )}
        <button
          onClick={save}
          disabled={busy || !dirty || !team.mayWrite}
          className="btn primary disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>

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

      <div className="mapbox">
        <div
          className="mapcanvas scroll-slim"
          style={{ height: Math.min(560, Math.max(240, laid.h)) }}
        >
          <div className="mapinner" style={{ width: laid.w, height: laid.h }}>
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

      {adding && (
        <Pop anchor={adding.at} onClose={() => setAdding(null)} width={300}>
          <ProfilePicker
            roles={roles.data ?? []}
            under={draft.positions.find((p) => p.id === adding.parent)?.name ?? "the lead"}
            onPick={(r) => {
              setDraft((d) => add(d, adding.parent, r.id, r.name, r.does, r.agent ?? null));
              setAdding(null);
            }}
          />
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

/** The picker the `+` opens: any profile, including one that leads elsewhere. */
function ProfilePicker({
  roles,
  under,
  onPick,
}: {
  roles: Role[];
  under: string;
  onPick: (r: Role) => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = roles.filter((r) => !needle || r.name.toLowerCase().includes(needle));
  return (
    <div className="py-1">
      <div className="px-2.5 pb-1.5 pt-1">
        <p className="text-micro text-mute">
          Under {under}. A profile that leads another team arrives here with nothing under it.
        </p>
        <div className="relative mt-2">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mute"
            strokeWidth={1.75}
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search profiles…"
            aria-label="Search profiles"
            autoFocus
            className="w-full rounded-md border border-line bg-ground py-1.5 pr-2.5 pl-8 text-ui text-bone placeholder:text-mute focus:border-dim focus:outline-none"
          />
        </div>
      </div>
      <div className="scroll-slim max-h-72 overflow-y-auto">
        {shown.map((r) => (
          <button key={r.id} type="button" onClick={() => onPick(r)} className="mi items-start">
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
          </button>
        ))}
        {shown.length === 0 && <p className="p-3 text-micro text-mute">No profile of that name.</p>}
      </div>
    </div>
  );
}

/**
 * The drawer: where a position is edited.
 *
 * **A position never replaces a profile field. It only adds.** So there is no
 * resolution order to define and no override semantics to explain — which is
 * why what it holds is *extra instructions* rather than overrides. The band at
 * the top says which object is open and what changing it reaches, because a
 * profile and a position carry the same name and different consequences, and
 * the other team is not on screen.
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
  const [moving, setMoving] = useState<HTMLElement | null>(null);
  return (
    <aside className="mapdrawer" aria-label={`${position.name}, a position in ${team.name}`}>
      <div className="flex items-start gap-2 border-b border-line px-3.5 py-2.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui text-bone">
            {position.redacted ? "Not yours to see" : position.name}
          </span>
          <span className="block truncate text-micro text-mute">
            {team.name} · {position.parent ? "a position" : "the lead"}
          </span>
        </span>
        <IconButton of={X} label="Close" onClick={onClose} />
      </div>

      <div className="scroll-slim flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3.5 py-3.5">
        <WhereTo icon={<Icon of={Info} size={16} />}>
          <b>This team only.</b> What you type below is added to {position.name}’s own
          instructions when it runs <i>here</i>. Its name, what it does, its instructions and its
          skills belong to the profile, and changing those changes every team that uses it —{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => navigate(`/configuration/roles/${position.profile}`)}
          >
            open the profile
          </button>
          .
        </WhereTo>

        <label className="fld">
          <span>Extra instructions</span>
          <span className="hint">
            Markdown. It adds to the profile’s instructions and never replaces them — and it is
            what tells two positions of one profile apart.
          </span>
          <span className="box">
            <textarea
              value={position.extraInstructions}
              onChange={(e) => onTell(e.target.value)}
              rows={8}
              disabled={!writable}
              placeholder={"Owns the web client.\nFollow the design system in docs/."}
            />
          </span>
        </label>

        {position.parent && writable && elsewhere.length > 0 && (
          <div className="fld">
            <span className="text-ui text-bone">Reports to</span>
            <span className="hint">
              Moving it takes everything under it along. It cannot go under something already
              beneath it.
            </span>
            <button
              type="button"
              className="btn plain self-start"
              onClick={(e) => setMoving(moving ? null : e.currentTarget)}
            >
              {parentName ?? "the lead"}
            </button>
            {moving && (
              <Pop anchor={moving} onClose={() => setMoving(null)} width={248}>
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
          </div>
        )}

        <div className="fld">
          <span className="text-ui text-bone">Hands work to</span>
          <span className="hint">
            The positions directly under this one, and nothing else. This is the whole of what it
            may start.
          </span>
          {kids.length === 0 ? (
            <p className="text-ui text-dim">
              Nobody yet. Press <b>+</b> on its card and it gains somebody to hand to.
            </p>
          ) : (
            <ul>
              {kids.map((p) => (
                <li key={p.id} className="py-0.5 text-ui text-bone">
                  {p.name}
                </li>
              ))}
            </ul>
          )}
        </div>

        {team.mayShare && (
          <div className="fld">
            <span className="text-ui text-bone">Who can see this team</span>
            <span className="hint">
              A team is filed like a profile or a skill. Somebody who can see the team and not a
              profile in it sees that card redacted, so the shape stays true.
            </span>
            <WhoCanAccess kind="agentTeam" id={team.id} path={team.path} look="chip" label="Sharing" />
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * The two questions this screen asks that are forms rather than a yes.
 *
 * `Confirm` is the app's dialog and it answers one of those, which is why
 * taking a position out does not come through here — a removal is a draft
 * like everything else and commits on Save, so there is nothing to confirm.
 * What is left is *what shall this team be called and who leads it*, and
 * *which profile goes under this card*, and both are a field and a list.
 *
 * Shares `Confirm`'s ground, radius and float, at a width that fits a list:
 * a 27rem dialog with a scrolling picker in it is a dialog being used as a
 * form.
 */
import { useEffect, useRef, useState } from "react";
import { CircleDashed, Plus, Search } from "lucide-react";
import type { Agent, NewRole, Role } from "~/api/generated/model";
import { AgentMark } from "~/components/AgentMark";
import { Badge, Button, Icon } from "~/components/ui";

/**
 * A sheet: a title, a body that scrolls, and a foot.
 *
 * Escape closes it and so does the ground behind it, which is what `Confirm`
 * does and what anything modal in this window should.
 */
export function Sheet({
  title,
  onClose,
  foot,
  children,
}: {
  title: string;
  onClose: () => void;
  foot: React.ReactNode;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-start justify-center bg-scrim pt-[12vh] pb-[6vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label={title}
        className="sheetcard"
      >
        <div className="sh">
          <h2 className="text-lede font-mid text-bone">{title}</h2>
        </div>
        <div className="bd">{children}</div>
        <div className="ft">{foot}</div>
      </div>
    </div>
  );
}

/**
 * Leaving a screen that is holding unsaved work.
 *
 * **One question, one wording, wherever it is asked.** It was written for a
 * team's map, where Save being the only commit is the whole promise and
 * navigating away dropped the draft in silence. The profile drawer has the
 * identical question — somebody edits a profile and goes somewhere else — so
 * it gets the identical answer rather than a second one phrased differently.
 * Two engineers writing the same sentence twice is the failure this is being
 * shared to avoid.
 *
 * Three answers, in the order somebody reads them: **Stay here**, which is
 * the cautious one and so the quiet one; **Discard**, which is deliberate;
 * and **Save and go**, which is what most people came to do.
 *
 * `says` is what would be lost, and it is the caller's because only the
 * caller knows: a tree counts the cards that would go, a profile counts the
 * fields that would.
 */
export function LeaveSheet({
  what,
  says,
  saving,
  problem,
  onStay,
  onDiscard,
  onSave,
}: {
  /** What is holding the work, by name — the team, or the profile. */
  what: string;
  says: string;
  saving?: boolean;
  problem?: string | null;
  onStay: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  return (
    <Sheet
      title={`Save your changes to ${what}?`}
      onClose={onStay}
      foot={
        <>
          <span className="msg">{problem ?? ""}</span>
          <Button variant="quiet" onClick={onStay}>
            Stay here
          </Button>
          <Button variant="default" onClick={onDiscard}>
            Discard
          </Button>
          <Button variant="primary" disabled={saving} onClick={onSave}>
            {saving ? "Saving…" : "Save and go"}
          </Button>
        </>
      }
    >
      <p className="max-w-[60ch] text-body leading-relaxed text-text">{says}</p>
    </Sheet>
  );
}

/**
 * Which engine a profile runs on, or nothing when it has not said.
 *
 * `Role.agent` is a string on the wire and one of four in fact, and the cast
 * is `Roles`' own. It lives here so the three places that draw a profile's
 * mark make it once and agree.
 */
export function engineOf(role: Role | undefined | null): Agent | null {
  return (role?.agent as Agent | null) ?? null;
}

/** The mark a profile wears: its engine, or a dashed ring for "not said". */
export function EngineMark({ role, size = 14 }: { role: Role | undefined; size?: 12 | 14 | 16 }) {
  const agent = engineOf(role);
  return agent ? <AgentMark agent={agent} size={size} /> : <Icon of={CircleDashed} size={size} />;
}

/** A labelled field, the shape the drawer and the sheets share. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mt-3 flex flex-col gap-1.5">
      <span className="text-body font-medium text-bone">{label}</span>
      {hint && <span className="max-w-[62ch] text-meta leading-relaxed text-dim">{hint}</span>}
      {children}
    </label>
  );
}

/** One line of text. `Confirm`'s own field, at this sheet's density. */
export function Line({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <input
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className="h-10 w-full rounded-xl bg-ground px-3.5 text-ui text-bone placeholder:text-mute focus:outline-none focus:ring-[1.5px] focus:ring-bone focus:ring-inset"
    />
  );
}

/**
 * Pick a profile, or make one.
 *
 * The search box appears above three, which is `ProfileMenu`'s rule, and it
 * matches the name or what the profile does, which is `ProfileMenu`'s rule
 * too. The last row is the way out of a list that does not hold what
 * somebody wanted.
 */
export function ProfilePicker({
  profiles,
  onPick,
  onMake,
  makeLabel,
  tag,
}: {
  profiles: Role[];
  onPick: (id: string) => void;
  onMake: () => void;
  makeLabel: string;
  /**
   * What this list has to say about a profile, if anything, and whether
   * that stops it being picked.
   *
   * A blocked row is drawn and **not hidden**: a profile missing from a
   * search somebody typed reads as a profile that does not exist, and the
   * reason it cannot be picked is the thing worth saying.
   */
  tag?: (role: Role) => { says: string; blocked?: boolean } | null;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = profiles
    .filter((p) => !needle || `${p.name} ${p.does}`.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      {profiles.length > 3 && (
        <label className="find mt-2 mb-2.5 w-full">
          <Search className="h-[15px] w-[15px] shrink-0" strokeWidth={1.75} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search profiles"
            aria-label="Search profiles"
            spellCheck={false}
            className="placeholder:text-mute focus:outline-none"
          />
        </label>
      )}
      <div className="picklist">
        {shown.map((p) => {
          const note = tag?.(p) ?? null;
          return (
            <button
              key={p.id}
              type="button"
              disabled={!!note?.blocked}
              onClick={() => onPick(p.id)}
              className={note?.blocked ? "pr opacity-55" : "pr"}
            >
              <span className="g">
                <EngineMark role={p} size={14} />
              </span>
              <span className="nm">{p.name}</span>
              <span className="ds">{p.does}</span>
              {note && <Badge>{note.says}</Badge>}
            </button>
          );
        })}
        {shown.length === 0 && (
          <p className="px-3 py-3.5 text-meta text-mute">
            No profile matches “{q.trim()}”.
          </p>
        )}
        <button type="button" onClick={onMake} className="pr make">
          <span className="g">
            <Icon of={Plus} size={14} />
          </span>
          <span className="nm">{makeLabel}</span>
        </button>
      </div>
    </>
  );
}

/**
 * A new profile, from the two fields a profile needs.
 *
 * It is created **immediately**, and that is the one thing on this screen
 * that does not wait for Save: a profile is not the team's, and leaving a
 * half-made one in a draft would mean the map could discard something that
 * belongs to the library. The *position* it goes into is a draft like any
 * other, so discarding leaves the profile behind, in no team.
 */
export function NewProfileSheet({
  under,
  filing,
  onClose,
  onCreate,
}: {
  /** What it will sit under, when it is being made from a card. */
  under?: string;
  /**
   * The directories it could be filed into, when the caller has a choice to
   * offer. Absent on the map, where a profile made for a seat goes into the
   * person's own space and is filed afterwards through the sharing sheet like
   * anything else.
   */
  filing?: { id: string; name: string }[];
  onClose: () => void;
  onCreate: (name: string, does: string, directory?: string | null) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [does, setDoes] = useState("");
  const [where, setWhere] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const ready = !!name.trim() && !!does.trim() && !busy;
  const go = async () => {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      await onCreate(name.trim(), does.trim(), where);
    } catch (e) {
      if (alive.current) setProblem(e instanceof Error ? e.message : "That profile was not created.");
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <Sheet
      title={under ? `New profile, under ${under}` : "New profile"}
      onClose={onClose}
      foot={
        <>
          <span className="msg">{problem ?? "Nothing is created until you press Create profile."}</span>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void go()} disabled={!ready}>
            {busy ? "Creating…" : "Create profile"}
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Line value={name} onChange={setName} placeholder="Reviewer" autoFocus />
      </Field>
      <Field label="Description" hint="The line a lead reads when it is choosing whom to hand work to.">
        <textarea
          rows={3}
          value={does}
          onChange={(e) => setDoes(e.target.value)}
          placeholder="What it does, and when to reach for it."
          className="w-full resize-y rounded-xl bg-ground px-3.5 py-2.5 text-ui leading-relaxed text-bone placeholder:text-mute focus:outline-none focus:ring-[1.5px] focus:ring-bone focus:ring-inset"
        />
      </Field>
      {/* **Where it lives, at creation only.** A profile is filed from the
          moment it exists rather than created and moved, which is what every
          other Placed kind does; moving it afterwards is the sharing sheet's
          job, and there is one place a thing changes hands. */}
      {filing && filing.length > 0 && (
        <Field label="Where it lives" hint="Keep it yours, or file it where your team can use it.">
          <div className="pickrow">
            <button
              type="button"
              aria-pressed={where === null}
              onClick={() => setWhere(null)}
              className="pk"
            >
              Yours
              <span className="sub">only you, until you share it</span>
            </button>
            {filing.map((d) => (
              <button
                key={d.id}
                type="button"
                aria-pressed={where === d.id}
                onClick={() => setWhere(d.id)}
                className="pk"
              >
                {d.name}
              </button>
            ))}
          </div>
        </Field>
      )}
      <p className="mt-3 mb-1 text-meta text-dim">
        {filing && filing.length > 0
          ? "Name it and say what it does. Everything else has a sensible answer already, and the drawer is where you change any of it."
          : "These are the only two fields a profile needs."}
      </p>
    </Sheet>
  );
}

/**
 * A new profile from the two fields the sheet asks for, and nothing else.
 *
 * The same answers `Roles`' own blank draft gives, **sent rather than left
 * off**: an absent field tells the server to leave it as it is, which on a
 * profile that does not exist is the same answer — but a sheet that drew
 * nothing and saved something would be drawing one thing and writing another.
 */
export function blankProfile(name: string, does: string): NewRole {
  return {
    name,
    does,
    placement: "lead",
    agent: null,
    machine: null,
    account: null,
    settings: {},
    instructions: "",
    onUsageLimit: "wait",
    onChildLimit: "ask",
    canDelegate: false,
    delegateScope: [],
    skillScope: [],
    includeAlwaysOn: true,
    includeRepoDefaults: true,
    directory: null,
  };
}

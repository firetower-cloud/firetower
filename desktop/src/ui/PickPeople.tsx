"use client";

/**
 * Choosing a person or a team.
 *
 * **One list, not two.** A grant and an exception both take either kind, so
 * splitting them into separate controls would make somebody decide *what they
 * are picking* before they have decided *who*. Typing filters both; the headings
 * only say which is which.
 *
 * Whoever is already in the list does not appear. Adding somebody twice is not a
 * thing that can be meant, and offering it produces a row that silently replaces
 * the one above it.
 */
import { useMemo, useRef, useState } from "react";
import { UsersRound } from "lucide-react";
import { Icon } from "~/components/ui";
import { useListColleagues, useListTeams } from "~/api/generated/access/access";

export type Pickable = { id: string; name: string; kind: "person" | "team"; note?: string };

export function PickPeople({
  already,
  onPick,
  onClose,
  placeholder = "Find a person or a team",
  empty = "Everybody already has access.",
}: {
  /** Ids already in the list, which are not offered again. */
  already: string[];
  onPick: (who: Pickable) => void;
  onClose: () => void;
  placeholder?: string;
  /** What to say when `already` has swallowed the whole organisation. The list
   *  this belongs to is not always "access to this thing". */
  empty?: string;
}) {
  const { data: colleagues = [] } = useListColleagues();
  const { data: teams = [] } = useListTeams();
  const [find, setFind] = useState("");
  const box = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => {
    const q = find.trim().toLowerCase();
    const matches = (name: string) => !q || name.toLowerCase().includes(q);
    const people: Pickable[] = colleagues
      .filter((c) => !already.includes(c.id) && matches(c.username))
      .map((c) => ({ id: c.id, name: c.username, kind: "person" as const }));
    const groups: Pickable[] = teams
      .filter((t) => !already.includes(t.id) && matches(t.name))
      .map((t) => ({
        id: t.id,
        name: t.name,
        kind: "team" as const,
        note: t.everyone ? "everybody" : `${t.members} ${t.members === 1 ? "person" : "people"}`,
      }));
    return { people, groups, all: [...people, ...groups] };
  }, [colleagues, teams, already, find]);

  // The keyboard path, because this opens under a cursor already typing.
  const [at, setAt] = useState(0);
  const here = shown.all[Math.min(at, shown.all.length - 1)];

  return (
    <div className="px-3.5 pt-1 pb-2">
      <input
        ref={box}
        autoFocus
        value={find}
        onChange={(e) => {
          setFind(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") return onClose();
          if (e.key === "ArrowDown") { e.preventDefault(); setAt((n) => Math.min(n + 1, shown.all.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setAt((n) => Math.max(n - 1, 0)); }
          if (e.key === "Enter" && here) { e.preventDefault(); onPick(here); setFind(""); setAt(0); }
        }}
        placeholder={placeholder}
        className="w-full rounded-md border border-line bg-ground px-2.5 py-1.5 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none"
      />

      {shown.all.length === 0 ? (
        <p className="px-1 py-3 text-micro text-mute">
          {find.trim() ? `Nobody here is called “${find.trim()}”.` : empty}
        </p>
      ) : (
        <div className="mt-1.5 max-h-48 overflow-y-auto rounded-lg border border-line bg-panel">
          {shown.people.length > 0 && <Heading>People</Heading>}
          {shown.people.map((p) => (
            <Row key={p.id} who={p} on={p.id === here?.id} onPick={onPick} />
          ))}
          {shown.groups.length > 0 && <Heading>Teams</Heading>}
          {shown.groups.map((t) => (
            <Row key={t.id} who={t} on={t.id === here?.id} onPick={onPick} />
          ))}
        </div>
      )}
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-raise px-2.5 py-1 text-micro tracking-[0.06em] text-mute uppercase">
      {children}
    </div>
  );
}

function Row({ who, on, onPick }: { who: Pickable; on: boolean; onPick: (w: Pickable) => void }) {
  return (
    <button
      onMouseDown={(e) => {
        // Before blur, or the field closes the list out from under the click.
        e.preventDefault();
        onPick(who);
      }}
      className={`flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors ${
        on ? "bg-raise" : "hover:bg-raise/60"
      }`}
    >
      <Face who={who} />
      <span className="min-w-0 flex-1 truncate text-ui text-text">{who.name}</span>
      {who.note && <span className="shrink-0 text-micro text-mute">{who.note}</span>}
    </button>
  );
}

/** A team reads as a glyph, a person as their initial — so the two kinds are
 *  distinguishable at a glance in a list that mixes them. */
export function Face({ who }: { who: { name: string; kind: "person" | "team" } }) {
  if (who.kind === "team") {
    return (
      <span className="grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full border border-line bg-overlay text-dim">
        <Icon of={UsersRound} size={12} />
      </span>
    );
  }
  return (
    <span className="grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full bg-slate-deep text-micro text-bone">
      {who.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

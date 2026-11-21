/**
 * How many schedules saving an agent team would stop, said **before** Save.
 *
 * A schedule that runs as a team pins its whole tree at approval — for the
 * reason it already pins a profile revision rather than an id: an edit must
 * not be able to change what an unattended run does. So editing a team that
 * four schedules pin pauses four schedules, and the one place that is worth
 * knowing is the editor, before the press, not in the schedules list
 * afterwards.
 *
 * ## Where it is mounted, and why that is not here
 *
 * The team editor is the Agent teams map (#492), on a branch beside this one.
 * This is the notice and the sentence; the map's action row is where it goes,
 * beside Save, because that is the control it is about. One import:
 *
 * ```tsx
 * import { SchedulesPinned } from "~/ui/schedules/Pinned";
 * …
 * <SchedulesPinned count={team.schedules} mayWrite={team.mayWrite} />
 * ```
 *
 * `AgentTeam.schedules` is already on the team the map reads to draw its
 * tree, so there is no second request and nothing to fetch before Save. It
 * counts the **approved** schedules pinning the team, across every owner —
 * somebody else's schedule is no less stopped for being somebody else's — and
 * it does not depend on what the draft changed, because any save stops all of
 * them. It is shown only to somebody who could save — see the component.
 *
 * Drawn whenever the editor is open rather than only once something has been
 * edited: the whole point is that it is read before anybody decides to
 * change anything.
 *
 * ## Amber, not ember and not brick
 *
 * `STYLE.md` spends ember on *is an agent waiting on you* and brick on
 * destruction. This is neither: nothing is destroyed — the schedules come
 * back with one press each — and nothing is waiting. It is a consequence of
 * an action you have not taken yet, which is amber's stated job, and the
 * glyph is what makes it more than a hue.
 */
import { CalendarClock } from "lucide-react";
import { Icon } from "~/components/ui";

/**
 * The sentence, from the count.
 *
 * `null` at nothing, so the caller draws no box rather than a box saying
 * zero. Exported for its own test: the singular is the half that is silently
 * wrong, and "pauses 1 schedules" is the whole of what this exists to stop.
 */
export function pausedBySave(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "Saving this pauses 1 schedule that runs as this team. It will not run again until you turn it back on."
    : `Saving this pauses ${count} schedules that run as this team. They will not run again until you turn them back on.`;
}

/**
 * The notice, for the action row the Save button sits in.
 *
 * **Drawn for somebody who could press that Save, and nobody else.** It is a
 * consequence-of-saving notice, so beside a Save a reader cannot press it
 * says nothing useful to them either way — and the number it carries is
 * counted across **every owner**, which is exactly right for the person about
 * to stop those schedules and is a reading of other people's unattended work
 * to anybody else. A `Viewer` on a shared team would otherwise learn how many
 * approved schedules other people had pinned to it, and by watching the
 * number fall, when one of them stopped.
 *
 * The server answers `AgentTeam.schedules` as zero for a reader for the same
 * reason, so this is the belt to that braces: the gate is named here, where
 * the sentence is, rather than at each call site where it would be a thing to
 * remember.
 */
export function SchedulesPinned({ count, mayWrite }: { count: number; mayWrite: boolean }) {
  if (!mayWrite) return null;
  const says = pausedBySave(count);
  if (!says) return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-amber-deep bg-amber-tint px-3 py-2">
      <span className="grid shrink-0 place-items-center text-amber-soft">
        <Icon of={CalendarClock} size={14} />
      </span>
      <span className="min-w-0 flex-1 text-meta text-bone">{says}</span>
    </div>
  );
}

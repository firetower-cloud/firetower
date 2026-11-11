/**
 * Making one, as a sheet.
 *
 * **A sheet, not the composer dock.** What this is about is not on the page
 * behind it, and the dock is for starting work now — pressing Enter there
 * sends it. Here Enter inserts a newline and nothing submits, because the
 * prompt is a paragraph somebody is writing for an agent that cannot ask a
 * follow-up question.
 *
 * **The consequence summary is pinned above the footer.** It is six things a
 * person has to know before turning on an unattended run, and at the bottom
 * of a scrolling body they would approve without having seen them.
 *
 * **Four rows in it, not six.** The schedule, the repository, the machine and
 * the agent are set by controls six inches above, and repeating them would be
 * the same fact in a control, a label and a summary. What is left is what no
 * control says: what the run may do, what it costs, and what happens when it
 * cannot finish.
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, FolderGit2, Server, Shield, TriangleAlert, UsersRound, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Icon, IconButton } from "~/components/ui";
import { useRepos } from "~/data";
import { useListRoles } from "~/api/generated/roles/roles";
import {
  createSchedule,
  getListSchedulesQueryKey,
  readCadence,
} from "~/api/generated/schedules/schedules";
import type { Cadence, CadenceAnswer, Weekday } from "~/api/generated/model";
import type { Example } from "./examples";

/** The five. Custom is last, and it is the only one that takes an expression. */
const CADENCES: { kind: Cadence["kind"]; label: string; note?: string }[] = [
  { kind: "daily", label: "Every day" },
  { kind: "weekdays", label: "Weekdays", note: "Monday to Friday" },
  { kind: "weekly", label: "Every week", note: "Choose a day" },
  { kind: "monthly", label: "Every month", note: "Choose a date" },
  { kind: "custom", label: "Custom", note: "Cron expression" },
];

const DAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export function NewSchedule({ from, onClose }: { from: Example | null; onClose: () => void }) {
  const client = useQueryClient();
  const repos = useRepos();
  const profiles = useListRoles().data ?? [];

  const [name, setName] = useState(from?.name ?? "");
  const [prompt, setPrompt] = useState(from?.prompt ?? "");
  const [repoId, setRepoId] = useState<string>("");
  const [profile, setProfile] = useState<string>("");
  const [base, setBase] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [deleteClean, setDeleteClean] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const [kind, setKind] = useState<Cadence["kind"]>(from?.cadence.kind ?? "weekdays");
  const [at, setAt] = useState(("at" in (from?.cadence ?? {}) ? (from!.cadence as { at: string }).at : "") || "08:30");
  const [day, setDay] = useState<Weekday>("monday");
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [expr, setExpr] = useState("0 7 * * 1-5");

  /* The schedule's own zone, defaulted to this computer's because that is
     almost always the answer — and stored as the IANA name, never an offset,
     because an offset is wrong twice a year. */
  const [zone, setZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const cadence: Cadence = useMemo(() => {
    switch (kind) {
      case "daily":
        return { kind: "daily", at };
      case "weekly":
        return { kind: "weekly", at, day };
      case "monthly":
        return { kind: "monthly", at, on: { kind: "day", day: dayOfMonth } };
      case "custom":
        return { kind: "custom", expr };
      default:
        return { kind: "weekdays", at };
    }
  }, [kind, at, day, dayOfMonth, expr]);

  /**
   * **The server reads it back.** No client parses cron: the read-back and
   * the next three fire times come from the one implementation that also
   * advances the clock, so the two cannot disagree about daylight saving in
   * March. The same call is what refuses a cadence under fifteen minutes,
   * which is why the refusal appears under the control that caused it rather
   * than on submit.
   */
  const [reads, setReads] = useState<CadenceAnswer | null>(null);
  useEffect(() => {
    let dropped = false;
    const ask = setTimeout(async () => {
      try {
        const answer = await readCadence({ cadence, timezone: zone });
        if (!dropped) {
          setReads(answer);
          setRefused(null);
        }
      } catch (e) {
        if (!dropped) {
          setReads(null);
          setRefused(e instanceof Error ? e.message : "That is not a cadence Firetower can run.");
        }
      }
    }, 250);
    return () => {
      dropped = true;
      clearTimeout(ask);
    };
  }, [cadence, zone]);

  const norepo = !repoId;
  const tooOften = !!refused;

  const save = async () => {
    setSaving(true);
    try {
      await createSchedule({
        name,
        prompt,
        repoId: repoId || undefined,
        base: base || undefined,
        cadence,
        timezone: zone,
        profile: profile || undefined,
        deleteCleanRuns: deleteClean,
      });
      await client.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
      onClose();
    } catch (e) {
      setRefused(e instanceof Error ? e.message : "Firetower could not write that down.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="veil" data-wide onMouseDown={onClose}>
      <div className="sheet2 s-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sh-head">
          <h2>New schedule</h2>
          <IconButton of={X} label="Close" onClick={onClose} />
        </div>

        <div className="s-sbody">
          <div className="fld">
            <label htmlFor="sch-name">Name</label>
            <div className="box">
              <input
                id="sch-name"
                value={name}
                placeholder="Dependency audit"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>

          <div className="fld">
            <label htmlFor="sch-prompt">Prompt</label>
            <div className="s-compose">
              <div className="shelf">
                <select
                  className="sc"
                  value={repoId}
                  onChange={(e) => setRepoId(e.target.value)}
                  aria-label="Repository"
                >
                  <option value="">Add a repository</option>
                  {repos.data.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.slug}
                    </option>
                  ))}
                </select>
                {/* **A policy, never a host id.** A pinned machine that is
                    retired is a schedule that fails every morning, so this is
                    a statement rather than a picker. */}
                <span className="sc" title="Runs on whichever machine is free when the schedule fires.">
                  <span className="ic">
                    <Icon of={Server} size={16} />
                  </span>
                  First available machine
                </span>
              </div>
              <div className="s-in">
                <textarea
                  id="sch-prompt"
                  className="in"
                  rows={5}
                  value={prompt}
                  placeholder="What should the agent do?"
                  onChange={(e) => setPrompt(e.target.value)}
                  /* Enter is a newline. Nothing here submits on a key: this is
                     a paragraph, and the footer is where it is sent. */
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.stopPropagation();
                  }}
                />
                <div className="bar">
                  <select
                    className="chip"
                    value={profile}
                    onChange={(e) => setProfile(e.target.value)}
                    aria-label="Agent profile"
                  >
                    <option value="">Just an agent</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {/* The shipped "never ask" behaviour, which **denies rather
                      than bypasses**: what it is not allowed to do fails
                      instead of reaching somebody who is not there. It is not
                      a control here because there is only one answer that
                      makes sense unattended. */}
                  <span className="chip" title="Refuses anything not already allowed, rather than asking.">
                    <span className="ic">
                      <Icon of={Shield} size={16} />
                    </span>
                    Never ask
                  </span>
                </div>
              </div>
            </div>
            <p className="hint">
              Describe the result you expect. The agent cannot ask follow-up questions.
            </p>
          </div>

          <div className="fld">
            <label>Schedule</label>
            <div className="s-trig">
              <span className="s-kind" title="A clock is the only trigger available.">
                On a clock
              </span>
              <select
                className="s-pill"
                value={kind}
                onChange={(e) => setKind(e.target.value as Cadence["kind"])}
                aria-label="How often"
              >
                {CADENCES.map((c) => (
                  <option key={c.kind} value={c.kind}>
                    {c.label}
                    {c.note ? ` — ${c.note}` : ""}
                  </option>
                ))}
              </select>
              {kind === "weekly" && (
                <select
                  className="s-pill"
                  value={day}
                  onChange={(e) => setDay(e.target.value as Weekday)}
                  aria-label="Which day"
                >
                  {DAYS.map((d) => (
                    <option key={d} value={d}>
                      {d[0].toUpperCase() + d.slice(1)}
                    </option>
                  ))}
                </select>
              )}
              {kind === "monthly" && (
                <select
                  className="s-pill"
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(Number(e.target.value))}
                  aria-label="Which date"
                >
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              )}
              {kind === "custom" ? (
                /* Mono, because a cron expression is read character by
                   character. */
                <input
                  className="s-pill mono"
                  value={expr}
                  onChange={(e) => setExpr(e.target.value)}
                  aria-label="Cron expression"
                  data-bad={tooOften}
                />
              ) : (
                <input
                  className="s-pill mono"
                  type="time"
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                  aria-label="Time of day"
                />
              )}
              <select
                className="s-pill"
                value={zone}
                onChange={(e) => setZone(e.target.value)}
                aria-label="Time zone"
                title="The time stays the same through daylight saving changes."
              >
                {zones(zone, here).map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </div>

            {refused ? (
              /* **Brick, with a triangle — and deliberately not how a disk
                 refusal is drawn.** This one is correctable where you are
                 standing: the thing to change is six inches above the
                 message. */
              <div className="s-refuse">
                <Icon of={TriangleAlert} size={16} />
                <div>{refused}</div>
              </div>
            ) : (
              <p className="s-reads">
                {reads?.reads ?? "…"}
                {reads && reads.nextFires.length > 0 && (
                  <span className="s-fires">
                    Next three runs:{" "}
                    {reads.nextFires
                      .map((f) =>
                        new Date(f).toLocaleString(undefined, {
                          weekday: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        }),
                      )
                      .join(", ")}
                    .
                  </span>
                )}
                {here && here !== zone && (
                  <span className="s-fires" style={{ color: "var(--color-amber)" }}>
                    This computer is set to {here}. The schedule keeps {zone}, so it runs at that
                    zone&rsquo;s time rather than yours.
                  </span>
                )}
              </p>
            )}
          </div>

          <button className="s-fold" aria-expanded={advanced} onClick={() => setAdvanced((o) => !o)}>
            Advanced
            <Icon of={ChevronDown} size={14} />
          </button>

          {advanced && (
            <div className="s-adv">
              {/* **No base branch without a repository**: there is nothing to
                  branch from, and a picker offering `main` would be a control
                  the server has nothing to apply. */}
              {!norepo && (
                <div className="s-arow">
                  <span className="s-al">
                    <b>Base branch</b>
                    <s>Each run branches from here.</s>
                  </span>
                  <span className="s-av">
                    <input
                      className="s-pill mono"
                      value={base}
                      placeholder="main"
                      onChange={(e) => setBase(e.target.value)}
                      aria-label="Base branch"
                    />
                  </span>
                </div>
              )}

              {/* **No switch without a repository**, and the row stays with a
                  read-only line in its place. `session_work` answers an empty
                  list for a workspace with nothing checked out, so "nothing
                  uncommitted" is vacuously true and a clean-run rule would
                  read a bare workspace as the safe case — `ui/end.ts` already
                  learned this and calls it "the dangerous case, not the safe
                  one", because git never saw the directory, so every file the
                  agent made goes with it. The desktop asks about that
                  separately; a timer cannot ask, so it must not offer. */}
              <div className="s-arow">
                <span className="s-al">
                  <b>Delete the workspace after a clean run</b>
                  <s>
                    {norepo
                      ? "Not available without a repository. Nothing is checked out, so there is no way to tell what a run left behind."
                      : "A run that failed, needed you, or left work uncommitted keeps its workspace either way."}
                  </s>
                </span>
                <span className="s-av">
                  {norepo ? (
                    <span className="s-src">
                      Everything is <b>kept</b>
                    </span>
                  ) : (
                    <span
                      className="tog"
                      role="switch"
                      aria-checked={deleteClean}
                      tabIndex={0}
                      title={deleteClean ? "Keep every workspace instead" : "Delete clean runs again"}
                      onClick={() => setDeleteClean((o) => !o)}
                    >
                      <i />
                    </span>
                  )}
                </span>
              </div>

              {/* **No Skills control while a profile is set.** A profile
                  resolves one or the other, never both, so there is nothing
                  to choose between — and a read-only line stands in its place
                  here rather than on the composer, because on a schedule
                  there is no later moment to look at what a run loaded. */}
              <div className="s-arow">
                <span className="s-al">
                  <b>Skills</b>
                  <s>
                    {profile
                      ? "The profile decides what each run reads."
                      : norepo
                        ? "Uses your default skills unless you choose a set."
                        : "Uses this repository’s default skills unless you choose a set."}
                  </s>
                </span>
                <span className="s-av">
                  {profile ? (
                    <span className="s-src">
                      Set by <b>{profiles.find((p) => p.id === profile)?.name ?? "the profile"}</b>
                    </span>
                  ) : (
                    <span className="s-src">{norepo ? "Your defaults" : "Repository defaults"}</span>
                  )}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="s-pinned">
          <div className="s-sumbox">
            <h3>Running unattended</h3>
            <dl className="s-sum">
              <dt>Workspace</dt>
              <dd>
                {norepo
                  ? "A new one for each run, kept until you delete it. Nothing is checked out, so there is no way to tell what a run left behind."
                  : deleteClean
                    ? "A new one for each run, deleted as that run finishes. Kept instead if the run failed, needed you, or left work uncommitted. Nothing bounds how many are kept."
                    : "A new one for each run, kept until you delete it. Nothing bounds how many are kept."}
              </dd>
              <dt>Access</dt>
              <dd>
                Edits files and runs commands.{norepo ? "" : " Can use this repository’s secrets."}
              </dd>
              <dt>Usage</dt>
              <dd>From your own subscription allowance.</dd>
              <dt>If approval is needed</dt>
              <dd>The action is blocked. The run carries on.</dd>
              {/* The timeout stops the *waiting*, not the run: the only stop
                  this product has would mark the session ended, which deletes
                  the conversation — and the question with it — inside a
                  minute. */}
              <dt>If the agent needs you</dt>
              <dd>After 15 minutes it stops waiting. The workspace stays open, so you can still answer.</dd>
            </dl>
          </div>
        </div>

        <div className="sh-foot">
          <span className="where">An agent can propose a schedule for you to approve.</span>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={saving || tooOften || !name.trim() || !prompt.trim()}
            onClick={save}
          >
            Create schedule
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The zones to offer.
 *
 * The whole IANA list where the browser will give it, and otherwise the two
 * that matter — the one chosen and the one this computer is in — so the
 * control is never empty.
 */
function zones(chosen: string, here: string): string[] {
  const all =
    typeof Intl.supportedValuesOf === "function" ? (Intl.supportedValuesOf("timeZone") as string[]) : [];
  if (all.length > 0) return all;
  return Array.from(new Set([chosen, here, "UTC"].filter(Boolean)));
}

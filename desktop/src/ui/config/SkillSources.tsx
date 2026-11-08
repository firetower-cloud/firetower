/**
 * Which skills a profile loads.
 *
 * **Three sources, added together**: the owner's always-on set, their defaults
 * for the repositories the child checks out, and a list the profile names on
 * top. Nothing here subtracts, which is why `All` / `Only these` is gone —
 * under a union it has nothing to switch between — and why this is not
 * `ScopePicker`. Delegation's scope above it really is a filter and its empty
 * really does mean *any* (`delegate.rs` — an empty scope is "any"), so it keeps
 * that component and its wording. One component with two opposite semantics is
 * a file nobody can safely touch.
 *
 * **The resolved count is the point of the section.** Every failure in this
 * system is silent: a tick that did nothing, an empty scope that yielded zero,
 * a skill that runs a command before the model ever sees it. This is the one
 * place somebody sees the set before it is used, so the figure is a sentence
 * rather than a number, and the breakdown's only promise is that **its lines
 * sum to that figure**. Nothing outside the sum belongs in it — which is why
 * the machine's own `~/.claude/skills` is a qualifier on the always-on switch,
 * where the decision is made, and not a row.
 *
 * **The count is per viewer, and that is not a bug.** A profile is Placed, so
 * it can be filed into a directory and used by colleagues — and `skill_defaults`
 * is keyed on `user_id`, so the first two sources resolve against whoever
 * *starts* the run. That is what "the repository's defaults" means when the
 * repository is not yours. The named list is the part that does not: a skill in
 * somebody's own space is reachable by nobody else, and a colleague silently
 * gets fewer. Shared, the section says which ones.
 *
 * Drawn in the `profile-skills` prototype, on `components.html`'s own
 * primitives. See `docs/design-handoff.md` before changing what anything here
 * looks like.
 */
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Info, Plus, Search, X } from "lucide-react";
import type { Agent, NewRole, Skill } from "~/api/generated/model";
import { AGENT_LABEL } from "~/components/AgentMark";
import { useRepos, useSkills } from "~/data";
import {
  BUDGET,
  READS_HOST_DIRECTORY,
  RISK_ORDER,
  RISK_SAYS,
  RISK_SHORT,
  SMALLEST_BUDGET,
} from "~/skills";

/** The fields of a draft profile this section reads and writes. */
export type SkillDraft = Pick<
  NewRole,
  "agent" | "skillScope" | "includeAlwaysOn" | "includeRepoDefaults"
>;

/** `u/kevin/rust_review` → `yours`; `d/firetower/dataviz` → `d/firetower`. */
const groupOf = (path: string) => {
  const [root, label] = path.split("/");
  return root === "u" ? "yours" : `d/${label}`;
};

/**
 * A named skill with nothing approved to pin.
 *
 * `held` alone is not this. A skill that already had an approved version and
 * has gained one an agent wrote keeps loading the approved one — the hold only
 * stops the *new* version becoming current. What cannot be pinned is a skill
 * whose `current_version_id` is null, which the listing reports as version 0:
 * a draft an agent wrote and nobody has approved yet. `set_for_session` skips
 * exactly those, so they must not be in the count either.
 */
const unpinnable = (s: Skill) => s.version === 0;

export type Resolved = ReturnType<typeof useSkillSources>;

/**
 * The union, and everything the screen says about it.
 *
 * A hook rather than state inside the section, because the form's foot has to
 * say whether this is savable and the Save button has to be able to refuse —
 * so one computation, read in two places, instead of an answer lifted back up
 * through an effect.
 *
 * It mirrors `roles::skills_for` on the server, which is what actually decides.
 * The one thing it cannot mirror is visibility: everything `useSkills` returns
 * is already what this person can see, so a named id that resolves to nothing
 * here is one the server would drop too.
 */
export function useSkillSources(draft: SkillDraft, shared: boolean) {
  const { data: library } = useSkills();
  const { data: repos } = useRepos();
  const [lens, setLens] = useState<string | null>(null);
  const named = useMemo(() => new Set(draft.skillScope ?? []), [draft.skillScope]);

  // Which repository the figure is resolved for. Without naming one it would
  // be a guess, or a union across every repository that overstates every
  // child. Defaults to the first, and the row that claims the number is where
  // it is changed.
  const at = lens ?? repos[0]?.slug ?? null;

  return useMemo(() => {
    const alwaysList = library.filter((s) => s.alwaysOn);
    const repoList = at ? library.filter((s) => s.defaultIn.includes(at)) : [];

    const seen = new Set<string>();
    const from: { always: Skill[]; repo: Skill[]; named: Skill[] } = {
      always: [],
      repo: [],
      named: [],
    };
    const take = (into: Skill[], rows: Skill[]) => {
      for (const s of rows)
        if (!seen.has(s.id)) {
          seen.add(s.id);
          into.push(s);
        }
    };
    if (draft.includeAlwaysOn) take(from.always, alwaysList);
    if (draft.includeRepoDefaults) take(from.repo, repoList);
    // A name one of the two already supplied is counted once and attributed to
    // the first, so the lines always sum to the figure. Criterion 5.
    const dupes: Skill[] = [];
    for (const s of library)
      if (named.has(s.id)) {
        if (seen.has(s.id)) dupes.push(s);
        else {
          seen.add(s.id);
          from.named.push(s);
        }
      }

    const skipped = [...from.named, ...dupes].filter(unpinnable);
    const loads = [...from.always, ...from.repo, ...from.named].filter((s) => !unpinnable(s));
    const spend = loads.reduce((n, s) => n + s.tokens, 0);

    const agent = draft.agent ?? null;
    const budget = (agent && BUDGET[agent]) || SMALLEST_BUDGET;
    /* What the person controls exactly, under every checkout: their always-on
       set and the list. If those two alone clear the budget the profile is
       broken wherever it runs, so the save is refused rather than warned
       about — where only a repository's contribution tips it over, that depends
       on a checkout nobody has made yet. */
    const own = new Map<string, Skill>();
    for (const s of from.always) own.set(s.id, s);
    for (const s of library) if (named.has(s.id) && !unpinnable(s)) own.set(s.id, s);
    const ownSpend = [...own.values()].reduce((n, s) => n + s.tokens, 0);

    // What in the resolved set can act outside the model, worst first.
    const acts = new Map<string, Skill[]>();
    for (const s of loads)
      for (const r of s.risk) acts.set(r, [...(acts.get(r) ?? []), s]);

    // Named skills in somebody's own space, on a profile that is shared: the
    // one part of this that is not per-viewer-by-design.
    const personal = shared
      ? [...from.named, ...dupes].filter((s) => groupOf(s.path) === "yours")
      : [];

    const readsHost = agent ? !!READS_HOST_DIRECTORY[agent] : true;

    return {
      library,
      repos,
      at,
      setLens,
      named,
      alwaysList,
      repoList,
      from,
      dupes,
      skipped,
      loads,
      spend,
      budget,
      ownSpend,
      acts,
      personal,
      readsHost,
      includeAlwaysOn: !!draft.includeAlwaysOn,
      includeRepoDefaults: !!draft.includeRepoDefaults,
      agentLabel: agent ? (AGENT_LABEL[agent as Agent] ?? agent) : "Codex",
      /** Whether the profile pins an agent at all — the budget says which it
       *  used and why, every time. */
      pinned: !!agent,
      over: spend > budget,
      near: spend > budget * 0.8 && spend <= budget,
      /** Over the limit on what the person controls alone. Refuses the save. */
      ownOver: ownSpend > budget,
      shared,
    };
  }, [library, repos, at, draft.includeAlwaysOn, draft.includeRepoDefaults, draft.agent, named, shared]);
}

/** `1,599`. */
const n = (x: number) => x.toLocaleString("en-US");
const Mono = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono">{children}</span>
);

export function SkillSources({
  r,
  onChange,
}: {
  r: Resolved;
  onChange: (patch: Partial<NewRole>) => void;
}) {
  const [sheet, setSheet] = useState(false);
  const empty = r.loads.length === 0;
  const tone = r.over ? "bad" : empty ? "warn" : "";
  const here = r.at?.split("/").pop() ?? null;

  const budgetWhy = r.pinned
    ? `${r.agentLabel}'s limit, which this profile pins`
    : "Codex's limit — the smallest of the three, because this profile pins no agent";

  const fig = empty
    ? "It loads no skills from Firetower"
    : `It loads ${r.loads.length} skill${r.loads.length === 1 ? "" : "s"}${r.shared ? " for you" : ""}`;

  const says = r.over ? (
    <>
      <b>More than {r.agentLabel} will carry.</b> Past {n(r.budget)} tokens of descriptions it drops{" "}
      <b>every</b> skill, not the ones over the line — so this profile would start with none of them.
    </>
  ) : empty ? (
    <>
      <b>Not even the built-ins.</b> <Mono>firetower-artifacts</Mono> goes with them, and a child
      that cannot publish an artifact has no way to hand work back.
    </>
  ) : r.skipped.length ? (
    <>
      {r.skipped.length} named skill{r.skipped.length === 1 ? " is" : "s are"} waiting for review and
      will be skipped, so {r.skipped.length === 1 ? "it is" : "they are"} not in the count.
    </>
  ) : r.shared ? (
    <>
      The union of the three sources below, counted once each — resolved against <b>your</b>{" "}
      defaults and what <b>you</b> can reach.
    </>
  ) : (
    <>The union of the three sources below, counted once each.</>
  );

  /** One breakdown line. The cost is what its own skills spend. */
  const line = (count: number, label: React.ReactNode, set: Skill[]) => (
    <div className="ln">
      <span className="n">{count}</span>
      <span className="src">{label}</span>
      <span className="cost">{n(set.reduce((a, s) => a + s.tokens, 0))} tokens</span>
    </div>
  );
  const off = (label: React.ReactNode) => (
    <div className="ln off">
      <span className="n">0</span>
      <span className="src">{label} — switched off</span>
      <span className="cost">0 tokens</span>
    </div>
  );

  const actors = r.loads.filter((s) => s.risk.length > 0);
  const vectors = RISK_ORDER.filter((k) => r.acts.has(k)).map((k) => RISK_SHORT[k]);

  return (
    <div className="fld">
      <span>Skills it loads</span>
      {/* **"loads", not "can load".** `can load` is a permission label, and
          under a union no permission is granted or withheld — the profile
          names a set. The present tense also makes the sentence falsifiable,
          which is what the resolved count is for. */}
      <span className="hint">
        Three sources, added together. Each one stays in the model's context on every turn. Nothing
        here removes a skill — turning a source off is the only way to narrow it.
      </span>

      <div className="answer" data-tone={tone}>
        <div className="fig">{fig}</div>
        <div className="says">{says}</div>

        <div className="brk">
          {r.includeAlwaysOn
            ? line(
                r.from.always.length,
                r.shared ? "always-on, yours" : "your always-on skills",
                r.from.always,
              )
            : off(r.shared ? "always-on" : "your always-on skills")}
          {r.includeRepoDefaults
            ? line(
                r.from.repo.length,
                <>
                  defaults in {here ? <Mono>{here}</Mono> : "this repository"}
                  {r.shared ? ", yours" : ""}
                </>,
                r.from.repo,
              )
            : off(
                <>defaults in {here ? <Mono>{here}</Mono> : "this repository"}</>,
              )}
          {line(
            r.from.named.filter((s) => !unpinnable(s)).length,
            <>
              named below
              {r.dupes.length > 0 && (
                <span className="text-slate"> ({r.dupes.length} more already included)</span>
              )}
            </>,
            r.from.named.filter((s) => !unpinnable(s)),
          )}
          {r.skipped.length > 0 && (
            <div className="ln skip">
              <span className="n">{r.skipped.length}</span>
              <span className="src">
                <i />
                named, {r.skipped.every((s) => s.held) ? "waiting for review" : "with no approved version"} — skipped
              </span>
              <span className="cost">0 tokens</span>
            </div>
          )}
        </div>

        <div className="meter">
          <span className="bar" data-near={r.near} data-over={r.over}>
            <i style={{ width: `${Math.min(100, (r.spend / r.budget) * 100)}%` }} />
          </span>
          <span className="ct">
            {n(r.spend)} / {n(r.budget)} tokens
          </span>
          <span className="ag">{budgetWhy}</span>
        </div>

        {/* **Review is not a gate on what loads.** A hold is only ever set for
            a version *an agent* wrote that ships an executable, and a held one
            is skipped rather than run — so everything in the resolved set is,
            by construction, unheld. A skill a person imported carrying hooks
            or a shell command was never reviewed by anybody. */}
        {actors.length > 0 && (
          <div className="strip">
            <span className="risk">
              <i />
              <span>
                <b>
                  {actors.length} of the {r.loads.length} can act outside the model
                </b>{" "}
                — {vectors.join(", ")}. None is held for review: review only catches a version{" "}
                <em>an agent</em> wrote that ships an executable, and a skill waiting on one is
                skipped rather than loaded.
              </span>
            </span>
          </div>
        )}

        {r.shared && (
          <div className="strip who">
            {r.personal.length > 0 ? (
              <>
                <b>
                  {r.personal.length} named skill{r.personal.length === 1 ? " is" : "s are"} yours
                  alone.
                </b>{" "}
                {r.personal.map((s) => s.name).join(" and ")}{" "}
                {r.personal.length === 1 ? "is" : "are"} filed in your own space and this profile is
                shared, so a colleague who starts it gets{" "}
                {r.loads.length - r.personal.filter((s) => !unpinnable(s)).length}. Share{" "}
                {r.personal.length === 1 ? "it" : "them"} into the directory, or drop{" "}
                {r.personal.length === 1 ? "it" : "them"}.
              </>
            ) : (
              <>
                <b>Shared, so this count is yours.</b> Whoever starts it brings their own always-on
                set and their own defaults. Every named skill here is one everybody who can reach
                this profile can also reach.
              </>
            )}
          </div>
        )}
      </div>

      <div className="srcs">
        <div className={`src-row ${r.includeAlwaysOn ? "" : "dark"}`}>
          <span className="tx">
            <span className="l1">
              <span className="nm">{r.shared ? "Always-on skills" : "Your always-on skills"}</span>
              <span className="v">{r.alwaysList.length}</span>
            </span>
            <span className="ds">
              {r.shared
                ? "Whoever starts this profile brings their own always-on set. Yours is what the count above used."
                : "The ones you load everywhere, whatever the work is."}
            </span>
            <span className="names">
              {r.alwaysList.length > 0 ? (
                r.alwaysList.map((s) => <span key={s.id}>{s.name}</span>)
              ) : (
                <span className="text-mute">none on</span>
              )}
            </span>
            {/* The qualifier lives here, where the decision is made, and only
                when it changes one: off, on an agent that reads the machine's
                own directory as well. On the others the same fact is a
                reassurance, so it is said as one. */}
            {!r.includeAlwaysOn && r.readsHost && (
              <div className="review">
                <p>
                  <b>Off stops Firetower sending them.</b>{" "}
                  {r.pinned ? r.agentLabel : "Claude Code, if that is what the lead runs,"} also
                  reads the machine's own <code>~/.claude/skills</code>, which this switch does not
                  touch — so a skill installed there arrives anyway.
                </p>
              </div>
            )}
            {!r.includeAlwaysOn && !r.readsHost && (
              <div className="review slate">
                <p>
                  <b>Off really is off here.</b> {r.agentLabel} reads only the directory Firetower
                  writes for this session.
                </p>
              </div>
            )}
          </span>
          <button
            type="button"
            className="tog"
            role="switch"
            aria-checked={r.includeAlwaysOn}
            aria-label="Include always-on skills"
            onClick={() => onChange({ includeAlwaysOn: !r.includeAlwaysOn })}
          >
            <i />
          </button>
        </div>

        <div className={`src-row ${r.includeRepoDefaults ? "" : "dark"}`}>
          <span className="tx">
            <span className="l1">
              <span className="nm">
                {r.shared ? "Repository defaults" : "This repository's defaults"}
              </span>
              <span className="v">{r.repoList.length}</span>
            </span>
            <span className="ds">
              {r.shared
                ? "Whoever starts it brings their own defaults for the repositories this child checks out."
                : "What you have defaulted for the repositories this child checks out."}
            </span>
            <span className="names">
              {r.repoList.length > 0 ? (
                r.repoList.map((s) => <span key={s.id}>{s.name}</span>)
              ) : (
                <span className="text-mute">none here</span>
              )}
            </span>
            {r.repos.length > 0 && (
              <span className="lens">
                Counted for
                <select
                  value={r.at ?? ""}
                  aria-label="Which repository the count is for"
                  onChange={(e) => r.setLens(e.target.value)}
                >
                  {r.repos.map((repo) => (
                    <option key={repo.id} value={repo.slug}>
                      {repo.slug}
                    </option>
                  ))}
                </select>
                {r.repos.length > 1 && (
                  <span>
                    {r.repos
                      .filter((repo) => repo.slug !== r.at)
                      .map(
                        (repo) =>
                          `${repo.slug.split("/").pop()} has ${
                            r.library.filter((s) => s.defaultIn.includes(repo.slug)).length
                          }`,
                      )
                      .join(", ")}{" "}
                    — a child in another repository gets that one's defaults instead.
                  </span>
                )}
              </span>
            )}
          </span>
          <button
            type="button"
            className="tog"
            role="switch"
            aria-checked={r.includeRepoDefaults}
            aria-label="Include the repository's defaults"
            onClick={() => onChange({ includeRepoDefaults: !r.includeRepoDefaults })}
          >
            <i />
          </button>
        </div>

        <div className="src-row">
          <span className="tx">
            <span className="l1">
              <span className="nm">Always include these</span>
              <span className="v">{r.named.size}</span>
            </span>
            <span className="ds">
              Added on top of the two above, whether those are on or off.
              {r.named.size === 0 &&
                (r.loads.length
                  ? ` Nothing named, so it loads the ${r.loads.length} above.`
                  : " Nothing named and both sources are off, so it loads nothing from Firetower.")}
            </span>
            <div className="pickrow" style={{ marginTop: 9 }}>
              {[...r.named]
                .map((id) => r.library.find((s) => s.id === id))
                .filter((s): s is Skill => !!s)
                .map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`pk${s.held ? " held" : ""}`}
                    title={`Remove ${s.name}`}
                    onClick={() =>
                      onChange({ skillScope: [...r.named].filter((id) => id !== s.id) })
                    }
                  >
                    {s.name}
                    {s.held && <span className="sub">waiting for review</span>}
                    <span className="x">
                      <X className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </span>
                  </button>
                ))}
              <button type="button" className="pk" onClick={() => setSheet(true)}>
                <span className="ic">
                  <Plus className="h-[15px] w-[15px]" strokeWidth={1.5} />
                </span>
                Name a skill
              </button>
            </div>
          </span>
        </div>
      </div>

      {/* A fact, not an alert. The words do not overclaim either way: not
          "insecure", not "contained". */}
      <div className="host">
        <span className="g">
          <Info className="h-[17px] w-[17px]" strokeWidth={1.5} />
        </span>
        <div className="min-w-0">
          <b>The machine adds its own</b>
          {r.readsHost ? (
            <p>
              {r.pinned ? r.agentLabel : "Claude Code"} also reads <code>~/.claude/skills</code> on
              the machine, whatever is set here. Nothing on this screen pins, versions, scopes or
              records what is in there. This decides what Firetower sends. It is not everything the
              agent can read.
            </p>
          ) : (
            <p>
              {r.agentLabel} reads only the per-session directory Firetower writes, so the machine's
              own <code>~/.claude/skills</code> does not reach this profile. That is true of Codex,
              Kimi and Cursor and not of Claude Code.
            </p>
          )}
          {empty && (
            <p className="text-text">
              {r.readsHost
                ? "Both switched off and nothing named, so ~/.claude/skills is the only place this child's skills will come from. It is not hermetic — it is unrecorded."
                : "Both switched off and nothing named, so this child will read no skills at all."}
            </p>
          )}
        </div>
      </div>

      {sheet && (
        <Picker
          r={r}
          onClose={() => setSheet(false)}
          onKeep={(ids) => {
            onChange({ skillScope: ids });
            setSheet(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Naming skills, in the drawing's own Picker sheet.
 *
 * **Ticking edits a draft and `Keep these N` commits it**, as `SkillPicker`
 * already does — because the descriptions sit in the system prompt, so changing
 * the set changes the prompt prefix. One decision per batch is affordable where
 * one per checkbox is not.
 *
 * **No `Select all`.** One click to the exact failure the meter exists to
 * prevent, and under a union one click to putting other people's code on the
 * child's worker. `Clear` stays — undoing is cheap.
 */
function Picker({
  r,
  onClose,
  onKeep,
}: {
  r: Resolved;
  onClose: () => void;
  onKeep: (ids: string[]) => void;
}) {
  const [draft, setDraft] = useState<Set<string>>(() => new Set(r.named));
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const query = q.trim().toLowerCase();
  const rows = r.library.filter(
    (s) => !query || s.name.includes(query) || s.description.toLowerCase().includes(query),
  );
  // Where a skill comes from, never whether it is ticked: a row that moved
  // when it was clicked would make a long list unusable.
  const groups = [...new Set(rows.map((s) => groupOf(s.path)))].sort((a, b) =>
    a === "yours" ? 1 : b === "yours" ? -1 : a.localeCompare(b),
  );
  // What a switch already supplies, so a tick can say it adds nothing.
  const supplied = new Set([...r.from.always, ...r.from.repo].map((s) => s.id));
  const cost = r.library
    .filter((s) => draft.has(s.id) && !unpinnable(s))
    .reduce((a, s) => a + s.tokens, 0);

  const tick = (id: string) =>
    setDraft((d) => {
      const next = new Set(d);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return createPortal(
    <div
      className="veil fixed"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="sheet2" role="dialog" aria-modal="true" aria-label="Name a skill">
        <div className="sh-head">
          <h2>Which skills does this profile always load?</h2>
          <button type="button" className="bk" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
        <p className="sh-note">
          Added on top of the two sources, whichever way they are set. Naming one introduces it — it
          does not keep one you already had.
        </p>
        <div className="sh-field">
          <span className="g">
            <Search className="h-[15px] w-[15px] text-mute" strokeWidth={1.75} />
          </span>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a skill"
            aria-label="Find a skill"
          />
        </div>
        <div className="sh-body">
          {groups.length === 0 ? (
            <p className="sh-none">Nothing matches “{q}”.</p>
          ) : (
            groups.map((g) => {
              const gr = rows.filter((s) => groupOf(s.path) === g);
              const on = gr.filter((s) => draft.has(s.id)).length;
              return (
                <div key={g}>
                  <div className="sh-lab">
                    <span className="font-mono">{g}</span>
                    <span>
                      {on} of {gr.length}
                    </span>
                  </div>
                  {gr.map((s) => (
                    <Row
                      key={s.id}
                      s={s}
                      on={draft.has(s.id)}
                      supplied={supplied.has(s.id)}
                      mine={r.shared && groupOf(s.path) === "yours"}
                      open={open === s.id}
                      onOpen={() => setOpen(open === s.id ? null : s.id)}
                      onTick={() => tick(s.id)}
                    />
                  ))}
                </div>
              );
            })
          )}
        </div>
        <div className="sh-foot">
          <span className="where">
            <b>{draft.size}</b> named
            {draft.size > 0 && `, ${n(cost)} tokens`}
            {draft.size > 0 && (
              <>
                {" · "}
                <button type="button" className="text-slate" onClick={() => setDraft(new Set())}>
                  Clear
                </button>
              </>
            )}
          </span>
          <button type="button" className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => onKeep([...draft])}>
            {draft.size > 0 ? `Keep these ${draft.size}` : "Keep none"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * One skill in the sheet.
 *
 * No checkbox: selection is `aria-pressed`, a fill and a tick on the right.
 *
 * **All four `risk_of` categories, as marks rather than badges.** The Skills
 * screen already settled this — "a line of small amber marks rather than a row
 * of filled badges; four badges read as four errors" — so the escalation when a
 * tick is what introduces the risk is the drawing's own `.review` register: the
 * sentence, in amber, under the row.
 */
function Row({
  s,
  on,
  supplied,
  mine,
  open,
  onOpen,
  onTick,
}: {
  s: Skill;
  on: boolean;
  supplied: boolean;
  mine: boolean;
  open: boolean;
  onOpen: () => void;
  onTick: () => void;
}) {
  const clamped = s.description.length > 130;
  const risks = RISK_ORDER.filter((k) => s.risk.includes(k));
  return (
    <button
      type="button"
      className="sh-row skillrow"
      aria-pressed={on}
      data-open={open}
      onClick={onTick}
    >
      <span className="tx">
        <span className="l1">
          <b>{s.name}</b>
          {s.held && <span className="tag amber">waiting for review</span>}
          {mine && <span className="tag slate">yours alone</span>}
          {supplied && on && <span className="already">already included</span>}
        </span>
        <span className="ds">{s.description}</span>
        {(risks.length > 0 || clamped) && (
          <span className="risks">
            {risks.map((k) => (
              <span key={k} className="risk">
                <i />
                {open ? RISK_SAYS[k] : RISK_SHORT[k]}
              </span>
            ))}
            {clamped && (
              <span
                className="sh-more"
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onOpen();
                  }
                }}
              >
                {open ? "Less" : "More"}
              </span>
            )}
          </span>
        )}
        {on && unpinnable(s) && (
          <span className="risks">
            <span className="risk said">
              <i />
              It can&apos;t be pinned until you approve it, so it will be skipped and this profile
              runs without it.
            </span>
          </span>
        )}
        {on && !unpinnable(s) && risks.length > 0 && (
          <span className="risks">
            <span className="risk said">
              <i />
              Nothing holds this for review. Naming it puts{" "}
              {groupOf(s.path) === "yours" ? "your" : "its author's"} code on the child&apos;s
              worker.
            </span>
          </span>
        )}
      </span>
      <span className="why">{n(s.tokens)}</span>
      <span className="tick">
        <Check className="h-4 w-4" strokeWidth={2} />
      </span>
    </button>
  );
}

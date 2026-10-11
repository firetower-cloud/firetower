/**
 * Choosing what a session's agent reads.
 *
 * **One surface, and it is not the inspector.** Diff, Files and Commit all
 * answer *what has this agent done to my repository*; a skill selection is not
 * that, and a fourth tab beside them said it was. It opens from the composer,
 * next to the model and the mode — the other two things that decide how the
 * next turn is answered.
 *
 * **Nothing happens until it is confirmed.** Ticking a box edits a draft; the
 * session keeps reading what it was reading. This is worth a step of its own
 * for a reason that is invisible otherwise: the descriptions sit in the system
 * prompt, so changing the set changes the prompt prefix and the next turn
 * re-bills the whole conversation as uncached input. One of those per decision
 * is affordable; one per checkbox is not.
 *
 * **A list to scan, not to read.** One line per skill, separated by rules
 * rather than filled when ticked, so a run of ticked skills stays a list and
 * not a slab. The checkbox is the only sign of a tick; what will change is
 * said once, in the footer.
 *
 * **Groups are about where a skill comes from, never about whether it is
 * ticked.** A default stays in "Your defaults here" when it is turned off. A
 * row that moved when it was clicked would make a list of three hundred
 * unusable.
 *
 * **Defaults are set here, because this is when somebody knows.** Choosing
 * skills for a session on a repository is deciding what that repository
 * needs, so the footer offers to make the selection the default there. The
 * whole set, not additions — otherwise unticking never carries over.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Diamond, Search, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  chooseSkills,
  getListSkillsQueryKey,
  getSessionSkillsQueryKey,
  setRepoDefaults,
} from "~/api/generated/skills/skills";
import type { Session, Skill } from "~/api/generated/model";
import { navigate } from "~/shims/next-navigation";
import { useSessionSkillIds, useSkills, why } from "~/data";
import { sameSet } from "~/skills";

/**
 * Roughly what the agent will allow. The real limit differs per agent — Codex
 * states its own in `skills.max_context_tokens` — and the number that matters
 * is the cliff: past it Codex removes *every* description rather than the last
 * one, so a meter that only warned at the end would warn too late.
 */
const BUDGET: Record<string, number> = { ClaudeCode: 3000, Codex: 2000, KimiCode: 2250 };

export function SkillPicker({ session, onClose }: { session: Session; onClose: () => void }) {
  const all = useSkills();
  const live = useSessionSkillIds(session.id);
  const cache = useQueryClient();

  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /* The defaults switch. `null` until touched, so it can show what is already
     true; `targets` is which of the session's repositories it applies to. */
  const [want, setWant] = useState<boolean | null>(null);
  const [targets, setTargets] = useState<Set<string> | null>(null);
  const [listing, setListing] = useState(false);

  // The draft starts as whatever the session is running, once that has
  // arrived. Seeded in an effect rather than at first render, because the
  // answer is a request and an empty set is indistinguishable from "none yet".
  useEffect(() => {
    if (draft === null && !live.loading) setDraft(new Set(live.data));
  }, [draft, live.loading, live.data]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const picked = draft ?? new Set<string>();
  // An empty library has nothing to search, meter or confirm, so the window
  // shrinks to the one thing worth doing: going to add a skill.
  const empty = !all.loading && all.data.length === 0;
  const openLibrary = () => {
    onClose();
    navigate("/configuration/skills");
  };
  const budget = BUDGET[session.agent] ?? 3000;

  const spend = useMemo(
    () => all.data.filter((s) => picked.has(s.id)).reduce((n, s) => n + s.tokens, 0),
    [all.data, picked],
  );

  const defaultsHere = useMemo(
    () => new Set([...live.repos.flatMap((r) => r.defaults), ...live.alwaysOn]),
    [live.repos, live.alwaysOn],
  );

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s: Skill) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q);
    const rows = all.data.filter(match);
    // Membership is where a skill comes from. A tick never moves anything.
    return [
      { at: "default", title: "Your defaults here", rows: rows.filter((s) => defaultsHere.has(s.id)) },
      { at: "all", title: "All skills", rows: rows.filter((s) => !defaultsHere.has(s.id)) },
    ].filter((g) => g.rows.length > 0);
  }, [all.data, query, defaultsHere]);

  /* Two skills of one name cannot both be on. The agent answers to the name,
     so `/code-review` would be ambiguous and only one folder can be written —
     and the two may be legitimately different things, one yours and one shared
     with you. Refused here rather than resolved by renaming something behind
     somebody's back. */
  const clash = (() => {
    const seen = new Set<string>();
    for (const s of all.data.filter((s) => picked.has(s.id))) {
      if (seen.has(s.name)) return s.name;
      seen.add(s.name);
    }
    return null;
  })();

  const added = [...picked].filter((id) => !live.data.includes(id));
  const gone = live.data.filter((id) => !picked.has(id));
  const dirty = added.length > 0 || gone.length > 0;
  const over = spend > budget;
  const blocked = over || clash !== null;

  /* Whether the selection already is the default, per repository. On when
     every one matches and off otherwise — a switch has two positions, and the
     list under the chevron says which repositories already match. It follows
     the draft, so changing the selection visibly moves away from the default. */
  const repos = live.repos;
  const chosenRepos = targets ?? new Set(repos.map((r) => r.repoId));
  const matching = repos.filter((r) => sameSet(r.defaults, picked));
  // Nothing ticked is not a selection to make the default.
  const already = picked.size > 0 && repos.length > 0 && matching.length === repos.length;
  const on = want ?? already;
  const aimed = repos.filter((r) => chosenRepos.has(r.repoId));
  /* Turning it on makes each repository's defaults exactly the selection.
     Turning it off is just as explicit: these skills stop being defaults
     there, and whatever else was a default stays. */
  const setsDefaults = want === true && aimed.some((r) => !sameSet(r.defaults, picked));
  const clearsDefaults = want === false && aimed.some((r) => r.defaults.some((id) => picked.has(id)));
  const writesDefaults = setsDefaults || clearsDefaults;

  const confirm = async () => {
    // Nothing to send is still an answer: the window closes as it would have.
    if (!dirty && !writesDefaults) return onClose();
    setSaving(true);
    setFailed(null);
    try {
      if (dirty) await chooseSkills(session.id, { selected: [...picked] });
      if (setsDefaults) for (const r of aimed) await setRepoDefaults(r.repoId, { skills: [...picked] });
      if (clearsDefaults)
        for (const r of aimed)
          await setRepoDefaults(r.repoId, { skills: r.defaults.filter((id) => !picked.has(id)) });
      await cache.invalidateQueries({ queryKey: getSessionSkillsQueryKey(session.id) });
      if (writesDefaults) await cache.invalidateQueries({ queryKey: getListSkillsQueryKey() });
      onClose();
    } catch (e) {
      setFailed(why(e));
      setSaving(false);
    }
  };

  const status = failed ? (
    <span className="text-brick">{failed}</span>
  ) : clash ? (
    <span className="text-brick">
      Two are called <span className="font-mono">{clash}</span>. Only one can be on.
    </span>
  ) : over ? (
    <span className="text-brick">Over the limit. Past it the agent drops every skill.</span>
  ) : dirty ? (
    <span className="text-bone">
      {[added.length && `+${added.length}`, gone.length && `−${gone.length}`].filter(Boolean).join(" ")}
    </span>
  ) : clearsDefaults ? (
    "No longer the default once saved"
  ) : setsDefaults ? (
    "The default once saved"
  ) : (
    `${picked.size} on`
  );

  const repoWord = repos.length === 1 ? repos[0]!.slug : `${chosenRepos.size} repos`;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] grid place-items-start justify-center bg-ground/40 pt-[10vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        className={`flex max-h-[78vh] flex-col overflow-hidden rounded-xl border border-line bg-overlay shadow-(--shadow-float) ${
          empty ? "w-[min(26rem,93vw)]" : "w-[min(36rem,93vw)]"
        }`}
      >
        <div className="flex items-start gap-2 border-b border-line px-3.5 py-2.5">
          <span className="min-w-0 flex-1">
            <span className="block text-ui text-bone">Skills for this session</span>
            {!empty && (
              <span className="block truncate text-micro text-mute">Each one stays in the model's context on every turn</span>
            )}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>

        {empty ? (
          <div className="flex flex-col items-center px-8 pt-6 pb-8 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-full border border-line bg-raise text-dim">
              <Diamond className="h-4 w-4" strokeWidth={1.75} />
            </span>
            <p className="mt-4 text-ui text-bone">Your library has no skills yet</p>
            <p className="mt-1 max-w-[22rem] text-meta leading-relaxed text-mute">
              Import your skills first and then come back here.
            </p>
            <button
              autoFocus
              onClick={openLibrary}
              className="control mt-5 bg-bone font-medium text-ground hover:opacity-90"
            >
              Open Skills
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-line px-3.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={2} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills"
                className="h-10 min-w-0 flex-1 bg-transparent text-ui text-bone placeholder:text-mute focus:outline-none"
              />
            </div>

            <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
              {all.loading && <p className="px-3.5 py-8 text-center text-meta text-mute">Reading the library…</p>}
              {!all.loading && groups.length === 0 && (
                <div className="px-3.5 py-10 text-center">
                  <p className="text-meta text-mute">No skill matches “{query}”.</p>
                  <button
                    onClick={openLibrary}
                    className="mt-2 text-meta text-dim underline-offset-2 hover:text-bone hover:underline"
                  >
                    Add one on the Skills page
                  </button>
                </div>
              )}
              {groups.map((g) => {
                const capped = g.at === "all" && !query && !showAll && g.rows.length > 8;
                const rows = capped ? g.rows.slice(0, 6) : g.rows;
                return (
                  <div key={g.at}>
                    <div className="sticky top-0 z-10 flex items-baseline gap-1.5 bg-overlay px-3.5 pt-2.5 pb-1 text-micro">
                      <span className="text-dim">{g.title}</span>
                      <span className="tabular-nums text-mute">{g.rows.length}</span>
                    </div>
                    {rows.map((s) => (
                      <Row
                        key={s.id}
                        skill={s}
                        on={picked.has(s.id)}
                        onToggle={() =>
                          setDraft((d) => {
                            const next = new Set(d ?? []);
                            next.has(s.id) ? next.delete(s.id) : next.add(s.id);
                            return next;
                          })
                        }
                      />
                    ))}
                    {capped && (
                      <button
                        onClick={() => setShowAll(true)}
                        className="w-full px-3.5 py-2 text-left text-meta text-mute hover:bg-raise/60 hover:text-bone"
                      >
                        Show {g.rows.length - 6} more
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {repos.length > 0 && picked.size > 0 && (
              <div className="border-t border-line px-3.5 py-2.5">
                <div className="flex items-center gap-2.5">
                  <Switch
                    on={on}
                    onFlip={() => setWant(!on)}
                    label={`Use these by default in ${repoWord}`}
                  />
                  <span className="min-w-0 truncate text-meta text-dim">
                    {already && want === null ? "Default in " : "Use these by default in "}
                    <span className={repos.length === 1 ? "font-mono text-text" : "text-text"}>{repoWord}</span>
                  </span>
                  {repos.length > 1 && (
                    <button
                      onClick={() => setListing((v) => !v)}
                      aria-label="Choose repositories"
                      className="grid h-6 w-6 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"
                    >
                      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${listing ? "rotate-180" : ""}`} strokeWidth={2} />
                    </button>
                  )}
                </div>
                {listing && repos.length > 1 && (
                  <div className="mt-1.5 flex flex-col pl-[38px]">
                    {repos.map((r) => {
                      const ticked = chosenRepos.has(r.repoId);
                      return (
                        <button
                          key={r.repoId}
                          onClick={() =>
                            setTargets(() => {
                              const next = new Set(chosenRepos);
                              ticked ? next.delete(r.repoId) : next.add(r.repoId);
                              return next;
                            })
                          }
                          className="flex items-center gap-2.5 py-1 text-left text-meta text-dim hover:text-bone"
                        >
                          <Tick on={ticked} />
                          <span className="font-mono">{r.slug}</span>
                          {sameSet(r.defaults, picked) && <span className="text-mute">already the default</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-3 border-t border-line px-3.5 py-2.5">
              <div className="flex min-w-0 flex-1 items-center gap-2.5 text-micro text-mute">
                <span className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-raise">
                  <span
                    className={`block h-full rounded-full transition-[width] ${
                      over ? "bg-brick" : spend > budget * 0.8 ? "bg-kind-data" : "bg-sage"
                    }`}
                    style={{ width: `${Math.min(100, (spend / budget) * 100)}%` }}
                  />
                </span>
                <span className="shrink-0 tabular-nums">
                  {spend.toLocaleString()} / {budget.toLocaleString()} tokens
                </span>
                <span className="min-w-0 truncate">{status}</span>
              </div>
              <button onClick={onClose} className="control text-dim hover:text-bone">
                Cancel
              </button>
              <button
                disabled={blocked || saving}
                onClick={confirm}
                className="control bg-bone font-medium text-ground disabled:bg-raise disabled:text-mute"
              >
                {saving
                  ? "Saving…"
                  : clash || over
                    ? "Can't confirm"
                    : dirty
                      ? `Confirm ${picked.size} ${picked.size === 1 ? "skill" : "skills"}`
                      : writesDefaults
                        ? "Save"
                        : "Confirm"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** One skill on one line. The full description is on hover. */
function Row({ skill, on, onToggle }: { skill: Skill; on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={skill.description}
      className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left hover:bg-raise/60"
    >
      <Tick on={on} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
        <span className={`shrink-0 font-mono text-ui ${on ? "text-bone" : "text-text"}`}>{skill.name}</span>
        <span className="min-w-0 truncate text-meta text-mute">{skill.description}</span>
      </span>
    </button>
  );
}

function Tick({ on }: { on: boolean }) {
  return (
    <span
      role="checkbox"
      aria-checked={on}
      className={`grid h-[15px] w-[15px] shrink-0 place-items-center rounded ${
        on ? "bg-bone" : "border border-line"
      }`}
    >
      {on && <span className="block h-1.5 w-2.5 -translate-y-px rotate-[-45deg] border-b-2 border-l-2 border-ground" />}
    </span>
  );
}

function Switch({ on, onFlip, label }: { on: boolean; onFlip: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onFlip}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${on ? "bg-sage-deep" : "bg-raise"}`}
    >
      <span
        style={{ left: on ? 14 : 2 }}
        className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-[left,background-color] duration-150 ${
          on ? "bg-sage" : "bg-mute"
        }`}
      />
    </button>
  );
}

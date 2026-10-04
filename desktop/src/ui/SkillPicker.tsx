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
 * **Groups are about where a skill comes from, never about whether it is
 * ticked.** A default stays in "Default here" when it is turned off. A row that
 * moved when it was clicked would make a list of three hundred unusable.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { chooseSkills, getSessionSkillsQueryKey } from "~/api/generated/skills/skills";
import type { Session, Skill } from "~/api/generated/model";
import { useSessionSkillIds, useSkills, why } from "~/data";
import { RISK_SAYS } from "~/skills";

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
  const budget = BUDGET[session.agent] ?? 3000;

  const spend = useMemo(
    () => all.data.filter((s) => picked.has(s.id)).reduce((n, s) => n + s.tokens, 0),
    [all.data, picked],
  );

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s: Skill) =>
      !q || s.name.includes(q) || s.description.toLowerCase().includes(q);
    const rows = all.data.filter(match);
    // Membership is where a skill comes from. A tick never moves anything.
    const isDefault = (s: Skill) => s.defaultIn.length > 0 || s.alwaysOn;
    return [
      { at: "default", title: "Default here", why: "from your repositories, and your own always-on", rows: rows.filter(isDefault) },
      { at: "all", title: "All skills", why: "", rows: rows.filter((s) => !isDefault(s)) },
    ].filter((g) => g.rows.length > 0);
  }, [all.data, query]);

  /* Two skills of one name cannot both be on. The agent answers to the name,
     so `/code-review` would be ambiguous and only one folder can be written —
     and the two may be legitimately different things, one yours and one shared
     with you. Refused here rather than resolved by renaming something behind
     somebody's back. */
  const clash = (() => {
    const seen = new Map<string, string>();
    for (const s of all.data.filter((s) => picked.has(s.id))) {
      const was = seen.get(s.name);
      if (was) return s.name;
      seen.set(s.name, s.id);
    }
    return null;
  })();

  const added = [...picked].filter((id) => !live.data.includes(id));
  const gone = live.data.filter((id) => !picked.has(id));
  const dirty = added.length > 0 || gone.length > 0;
  const over = spend > budget;
  const blocked = over || clash !== null;

  const confirm = async () => {
    setSaving(true);
    setFailed(null);
    try {
      await chooseSkills(session.id, { selected: [...picked] });
      await cache.invalidateQueries({ queryKey: getSessionSkillsQueryKey(session.id) });
      onClose();
    } catch (e) {
      setFailed(why(e));
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-start justify-center bg-ground/60 pt-[9vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="grid max-h-[78vh] w-[min(44rem,93vw)] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl bg-overlay shadow-float"
      >
        <div className="flex items-start gap-3 px-5 pb-3 pt-4">
          <div className="min-w-0">
            <h2 className="text-title text-bone">Skills for this session</h2>
            <p className="mt-1 max-w-prose text-meta leading-relaxed text-mute">
              Every skill you turn on keeps its description in the model's context on every turn of this
              conversation. That is the number at the foot of this window. Nothing changes until you confirm.
            </p>
          </div>
          <button onClick={onClose} className="control ml-auto shrink-0 text-mute hover:bg-raise hover:text-bone">
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        <div className="px-5 pb-3">
          <div className="flex h-[30px] items-center gap-2 rounded-lg bg-ground px-2.5 shadow-[inset_0_1px_2px_rgb(0_0_0/0.35)]">
            <Search className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={2} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills by name or description"
              className="min-w-0 flex-1 bg-transparent text-ui text-bone outline-none placeholder:text-mute"
            />
            <span className="keycap shrink-0">esc</span>
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto px-3 pb-2 scroll-slim">
          {all.loading && <p className="px-2 py-8 text-center text-meta text-mute">Reading the library…</p>}
          {!all.loading && groups.length === 0 && (
            <p className="px-2 py-10 text-center text-meta text-mute">
              {query ? `No skill matches “${query}”.` : "No skills yet. Add one in Configuration → Skills."}
            </p>
          )}
          {groups.map((g) => {
            const capped = g.at === "all" && !query && !showAll;
            const rows = capped ? g.rows.slice(0, 4) : g.rows;
            return (
              <div key={g.at}>
                <div className="sticky top-0 z-10 flex items-baseline gap-2 bg-overlay px-2 pb-1 pt-3">
                  <span className="font-narrow text-micro uppercase tracking-[0.18em] text-mute">{g.title}</span>
                  {g.why && <span className="text-micro text-mute">{g.why}</span>}
                  <span className="ml-auto text-micro tabular-nums text-mute/60">{g.rows.length}</span>
                </div>
                {rows.map((s) => (
                  <Row
                    key={s.id}
                    skill={s}
                    on={picked.has(s.id)}
                    was={live.data.includes(s.id)}
                    onToggle={() =>
                      setDraft((d) => {
                        const next = new Set(d ?? []);
                        next.has(s.id) ? next.delete(s.id) : next.add(s.id);
                        return next;
                      })
                    }
                  />
                ))}
                {capped && g.rows.length > 4 && (
                  <button
                    onClick={() => setShowAll(true)}
                    className="mx-2 mt-1.5 w-[calc(100%-1rem)] rounded-lg bg-raise/60 py-2 text-meta text-mute hover:text-bone"
                  >
                    Show the other {g.rows.length - 4}, or search for one
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-[1fr_auto] items-center gap-4 border-t border-line-soft bg-panel px-5 py-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-baseline gap-2 text-meta text-dim">
              <span>Context</span>
              <b className="font-semibold tabular-nums text-text">{spend.toLocaleString()}</b>
              <span>
                of <span className="tabular-nums">{budget.toLocaleString()}</span> tokens
              </span>
              <span className="ml-auto text-micro text-mute">{session.agent === "ClaudeCode" ? "Claude Code" : session.agent}</span>
            </div>
            <span className="h-1 overflow-hidden rounded-full bg-ground shadow-[inset_0_1px_2px_rgb(0_0_0/0.4)]">
              <span
                className={`block h-full rounded-full transition-[width] ${over ? "bg-brick" : spend > budget * 0.8 ? "bg-kind-data" : "bg-sage"}`}
                style={{ width: `${Math.min(100, (spend / budget) * 100)}%` }}
              />
            </span>
            <span className="text-meta text-mute">
              {failed ? (
                <span className="text-brick">{failed}</span>
              ) : clash ? (
                <span className="text-brick">
                  Two of these are called <span className="font-mono">{clash}</span>. The agent answers
                  to the name, so only one of them can be on.
                </span>
              ) : over ? (
                <span className="text-brick">
                  Over. Past the limit an agent drops every skill description rather than the last one.
                </span>
              ) : dirty ? (
                <>
                  <b className="font-semibold text-bone">
                    {added.length > 0 && `+${added.length}`}
                    {added.length > 0 && gone.length > 0 && " "}
                    {gone.length > 0 && `−${gone.length}`}
                  </b>{" "}
                  — in effect from your next message
                </>
              ) : (
                `${picked.size} on, in step with the session`
              )}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {dirty && (
              <button className="control text-ui text-mute hover:text-bone" onClick={() => setDraft(new Set(live.data))}>
                Reset
              </button>
            )}
            <button className="control text-ui text-mute hover:text-bone" onClick={onClose}>
              Cancel
            </button>
            <button
              disabled={!dirty || blocked || saving}
              onClick={confirm}
              className="control bg-overlay text-ui font-semibold text-bone shadow-raise disabled:bg-raise disabled:font-normal disabled:text-mute"
            >
              {clash
                ? "Two of one name"
                : over
                  ? "Over budget"
                  : saving
                    ? "Confirming…"
                    : dirty
                      ? `Confirm ${picked.size} skills`
                      : "Nothing to confirm"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({ skill, on, was, onToggle }: { skill: Skill; on: boolean; was: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className={`grid w-full grid-cols-[15px_1fr] gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${on ? "bg-raise" : "hover:bg-raise/70"}`}>
      <span
        role="checkbox"
        aria-checked={on}
        className={`mt-0.5 grid h-[15px] w-[15px] place-items-center rounded ${on ? "bg-raise shadow-[inset_0_0_0_1px_#4a4a54]" : "shadow-[inset_0_0_0_1px_#3a3a42]"}`}
      >
        {on && <span className="block h-1.5 w-2.5 -translate-y-px rotate-[-45deg] border-b-2 border-l-2 border-bone" />}
      </span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-2">
          <span className={`truncate font-mono text-ui font-semibold ${on ? "text-bone" : "text-text"}`}>{skill.name}</span>
          <span className="ml-auto shrink-0 text-micro tabular-nums text-mute">v{skill.version}</span>
        </span>
        <span className="mt-0.5 line-clamp-2 block text-meta leading-snug text-mute">{skill.description}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {skill.defaultIn.map((r) => (
            <Tag key={r}>{r}</Tag>
          ))}
          {skill.alwaysOn && <Tag>always on for you</Tag>}
          {skill.risk.map((r) => (
            <Tag key={r} tone="brick" title={RISK_SAYS[r]}>
              {r}
            </Tag>
          ))}
          <Tag>{skill.tokens} tok</Tag>
          {on && !was && <Tag tone="sage">turning on</Tag>}
          {!on && was && <Tag tone="brick">turning off</Tag>}
        </span>
      </span>
    </button>
  );
}

function Tag({ children, tone, title }: { children: React.ReactNode; tone?: "brick" | "sage"; title?: string }) {
  const edge = tone === "brick" ? "border-brick-deep text-brick" : tone === "sage" ? "border-sage-deep text-sage" : "border-line-soft text-mute";
  return (
    <span title={title} className={`rounded-full border px-1.5 py-px text-micro ${edge}`}>
      {children}
    </span>
  );
}

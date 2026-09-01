"use client";

import { useEffect, useRef, useState } from "react";
import { Hash, Plus, X } from "lucide-react";
import { Icon } from "@/components/ui";
import { useListTasks } from "@/src/api/generated/tasks/tasks";
import {
  KEYWORDS,
  idOf,
  label,
  parseReference,
  type Keyword,
  type Reference,
} from "@/src/api/issues";

/**
 * The issues a pull request will name, and the way to add another.
 *
 * A chip is an issue plus what happens to it on merge, and that second half is
 * the reason this is not a list of links: `Closes` and `Refs` are different
 * promises, and which one a given issue gets is a decision somebody has to be
 * able to see and change. The issue a workspace was cut for arrives as
 * `Closes`, because that is what starting work on an issue means; everything
 * added here arrives as `Refs`, because adding a link is not the same as
 * promising to close it.
 */
export function IssueChips({
  refs,
  onChange,
  within,
  suggestions,
}: {
  refs: Reference[];
  onChange: (refs: Reference[]) => void;
  /** The repository being shipped to, so `#32` means something. */
  within?: string;
  /** What the describing run noticed, offered rather than applied. */
  suggestions: Reference[];
}) {
  const [adding, setAdding] = useState(false);

  const add = (ref: Reference) => {
    if (refs.some((held) => idOf(held) === idOf(ref))) return;
    onChange([...refs, ref]);
    setAdding(false);
  };

  return (
    <div className="space-y-1.5">
      <div className="rounded-md border border-line">
        {refs.map((ref, at) => (
          <div
            key={idOf(ref)}
            className="flex items-center gap-2 border-b border-line px-1.5 py-1 last:border-b-0"
          >
            <select
              value={ref.keyword}
              onChange={(e) =>
                onChange(
                  refs.map((held, i) =>
                    i === at ? { ...held, keyword: e.target.value as Keyword } : held,
                  ),
                )
              }
              aria-label={`What happens to ${label(ref, within)} when this merges`}
              className="h-6 shrink-0 cursor-pointer rounded-sm border border-line bg-ground px-1 text-meta text-dim focus:border-dim focus:outline-none"
            >
              {KEYWORDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>

            <span className="shrink-0 font-mono text-meta text-bone">{label(ref, within)}</span>
            {ref.title && (
              <span className="min-w-0 flex-1 truncate text-meta text-mute" title={ref.title}>
                {ref.title}
              </span>
            )}
            {ref.url && (
              <a
                href={ref.url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-meta text-mute transition-colors hover:text-bone"
                title="Read it"
              >
                ↗
              </a>
            )}

            <button
              onClick={() => onChange(refs.filter((_, i) => i !== at))}
              aria-label={`Don't mention ${label(ref, within)}`}
              title="Don't mention it"
              className={`shrink-0 rounded-sm p-0.5 text-mute transition-colors hover:text-bone ${
                ref.title ? "" : "ml-auto"
              }`}
            >
              <Icon of={X} size={12} />
            </button>
          </div>
        ))}

        <div className="relative flex items-center px-1.5 py-1">
          {refs.length === 0 && (
            <span className="text-meta text-mute">Nothing linked</span>
          )}
          <button
            onClick={() => setAdding((open) => !open)}
            className="ml-auto flex items-center gap-1 rounded-sm px-1 py-0.5 text-meta text-dim transition-colors hover:text-bone"
          >
            <Icon of={Plus} size={12} />
            Add issue
          </button>

          {adding && (
            <Picker within={within} onPick={add} onClose={() => setAdding(false)} />
          )}
        </div>
      </div>

      {/* Offered, never applied. These came out of a model reading a diff, and
          the cost of a number it invented is closing somebody else's issue on
          merge — so they sit here until somebody clicks one. */}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-meta text-mute">Mentioned in the conversation:</span>
          {suggestions.map((ref) => (
            <button
              key={idOf(ref)}
              onClick={() => add(ref)}
              title="Mention it in this pull request"
              className="flex items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 font-mono text-micro text-dim transition-colors hover:border-dim hover:text-bone"
            >
              <Icon of={Plus} size={12} />
              {label(ref, within)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Search, or paste.
 *
 * Both, because both are how people have an issue to hand. The search is the
 * tracker's, which means it can be rate-limited or down — so anything typed
 * that is already a reference is offered without a request, and pasting a URL
 * works when nothing else does.
 */
function Picker({
  within,
  onPick,
  onClose,
}: {
  within?: string;
  onPick: (ref: Reference) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => field.current?.focus(), []);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  // What was typed, if it is already an issue. No request, and it is what
  // makes this work when the tracker will not answer.
  const written = parseReference(typed, within);

  // Only open issues, only here. A closed one is rarely what somebody means to
  // link, and the whole of GitHub is not a picker.
  const { data, isLoading } = useListTasks(
    { repo: within, kind: "issue", state: "open", q: typed.trim() || undefined },
    { query: { enabled: !!within && !written, staleTime: 30_000 } },
  );
  const found = (data?.tasks ?? []).slice(0, 6);

  return (
    <div
      ref={box}
      className="absolute top-full right-0 z-30 mt-1 w-[340px] rounded-md border border-line bg-panel p-1 shadow-float"
    >
      <input
        ref={field}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const pick = written ?? asReference(found[0], within);
          if (pick) onPick(e.shiftKey ? { ...pick, keyword: "Closes" } : pick);
        }}
        placeholder="#123, acme/web#123, or paste a link"
        autoComplete="off"
        spellCheck={false}
        className="w-full rounded-sm bg-ground px-2 py-1.5 text-meta text-bone placeholder:text-mute focus:outline-none"
      />

      <div className="mt-1 max-h-[190px] overflow-y-auto">
        {written && (
          <Line
            onClick={() => onPick(written)}
            number={label(written, within)}
            title="Mention this issue"
          />
        )}

        {!written &&
          found.map((task) => {
            const ref = asReference(task, within);
            if (!ref) return null;
            return (
              <Line
                key={task.id}
                onClick={() => onPick(ref)}
                number={label(ref, within)}
                title={task.title}
              />
            );
          })}

        {!written && !isLoading && found.length === 0 && (
          <p className="px-2 py-1.5 text-meta leading-[1.5] text-mute">
            {within
              ? "Nothing open matches. A number or a link works too."
              : "No repository to search. Paste a link, or type acme/web#123."}
          </p>
        )}
        {!written && isLoading && <p className="px-2 py-1.5 text-meta text-mute">Looking…</p>}
      </div>

      <p className="border-t border-line px-2 pt-1.5 pb-0.5 text-micro text-mute">
        ↵ mention · ⇧↵ mention and close it
      </p>
    </div>
  );
}

function Line({
  onClick,
  number,
  title,
}: {
  onClick: () => void;
  number: string;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left transition-colors hover:bg-raise"
    >
      <Icon of={Hash} size={12} className="shrink-0 text-mute" />
      <span className="shrink-0 font-mono text-micro text-dim">{number}</span>
      <span className="min-w-0 flex-1 truncate text-meta text-text">{title}</span>
    </button>
  );
}

/** A row from the tracker, as something that can be written into a body. */
function asReference(
  task: { key: string; url: string; title: string; repo?: string | null } | undefined,
  within?: string,
): Reference | null {
  if (!task) return null;
  const found = parseReference(task.url, within) ?? parseReference(task.key, within);
  return found && { ...found, title: task.title, url: task.url };
}

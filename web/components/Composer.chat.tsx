"use client";

import { useMemo, useRef, useState } from "react";
import { useListFiles } from "@/src/api/generated/sessions/sessions";
import type { Attached, SlashCommand, Usage } from "@/src/api/generated/model";

/**
 * Saying something to the agent.
 *
 * Everything here exists because a message is not keystrokes. A terminal can
 * take a paste of text and nothing else — no picture, no file, no way to offer
 * completions for the thing you are half way through typing. This can, and the
 * three affordances below are the whole reason the composer was worth building
 * rather than reusing a prompt.
 */
export function ChatComposer({
  sessionId,
  live,
  working,
  commands,
  model,
  usage,
  branch,
  repo,
  onSend,
  onStop,
  failed,
}: {
  sessionId: string;
  live: boolean;
  working: boolean;
  commands: SlashCommand[];
  model?: string;
  usage?: Usage;
  branch?: string | null;
  repo?: string | null;
  onSend: (text: string, images: Attached[]) => void;
  onStop: () => void;
  failed: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<Attached[]>([]);
  const [over, setOver] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  /** What is being typed after a trigger character, if anything. */
  const token = triggerAt(draft);
  const suggestions = useSuggestions(sessionId, token, commands, live);

  // Which suggestion is under the keyboard, remembered against the thing being
  // typed. Tying it to the token is what resets it when somebody types another
  // character, without an effect that sets state and renders twice for it.
  const [choice, setChoice] = useState({ of: "", at: 0 });
  const typing = token ? token.kind + token.query : "";
  const highlighted =
    choice.of === typing ? Math.min(choice.at, Math.max(0, suggestions.length - 1)) : 0;
  const move = (at: number) => setChoice({ of: typing, at });

  /** Put a suggestion where the half-typed word was. */
  const finish = (value: string) => {
    if (!token) return;
    const before = draft.slice(0, token.at);
    const after = draft.slice(token.at + token.query.length + 1);
    setDraft(`${before}${token.kind}${value} ${after.trimStart()}`);
    box.current?.focus();
  };

  const submit = () => {
    const text = draft.trim();
    if (!text && images.length === 0) return;
    setDraft("");
    setImages([]);
    onSend(text, images);
  };

  return (
    <div
      onDragOver={(e) => {
        if (!live) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        if (!live) return;
        e.preventDefault();
        setOver(false);
        const found = await readImages(Array.from(e.dataTransfer.files));
        if (found.length) setImages((held) => [...held, ...found]);
      }}
      className={`rounded-[6px] transition-colors ${over ? "bg-raise" : ""}`}
    >
      {suggestions.length > 0 && (
        <ul className="mb-2 max-h-[220px] overflow-y-auto rounded-[6px] border border-line bg-panel py-1">
          {suggestions.map((s, i) => (
            <li key={s.value}>
              <button
                onMouseEnter={() => move(i)}
                onClick={() => finish(s.value)}
                className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left ${
                  i === highlighted ? "bg-raise" : ""
                }`}
              >
                <span className="font-mono text-[12px] text-bone">{s.value}</span>
                {s.hint && (
                  <span className="min-w-0 truncate text-[11.5px] text-mute">{s.hint}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((image, i) => (
            <div key={i} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:${image.mediaType};base64,${image.data}`}
                alt=""
                className="h-14 w-14 rounded-[4px] border border-line object-cover"
              />
              <button
                onClick={() => setImages((held) => held.filter((_, at) => at !== i))}
                aria-label="Remove image"
                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full border border-line bg-ground text-[11px] text-dim hover:text-bone"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* One box, and everything that belongs to composing a message lives
          inside it. The controls are on the floor of the box rather than
          floating beside it, which is what stops a message box reading as a
          form. */}
      <div
        className={`rounded-[14px] border bg-panel transition-colors ${
          over ? "border-ember" : "border-line focus-within:border-mute"
        }`}
      >
        <textarea
          ref={box}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={async (e) => {
            const found = await readImages(
              Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/")),
            );
            if (found.length) {
              // Only swallow the paste if it actually was a picture; a paste of
              // text and an image together should still deliver the text.
              if (!e.clipboardData.getData("text")) e.preventDefault();
              setImages((held) => [...held, ...found]);
            }
          }}
          onKeyDown={(e) => {
            if (suggestions.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                move((highlighted + 1) % suggestions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                move((highlighted - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                finish(suggestions[highlighted].value);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDraft((d) => `${d} `);
                return;
              }
            }
            // Enter sends. This is a message box, not an editor — a newline
            // needs a modifier.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder={
            live ? "Ask for follow-up changes, or attach an image" : "This session has finished."
          }
          disabled={!live}
          className="min-h-[54px] w-full resize-none bg-transparent px-3.5 pt-3 text-[13.5px] leading-[1.5] text-text placeholder:text-mute focus:outline-none disabled:opacity-50"
        />

        <div className="flex items-center gap-3 px-3 pb-2.5">
          {model && <span className="eyebrow truncate">{model}</span>}
          {repo && <span className="eyebrow hidden truncate sm:inline">{repo}</span>}
          {branch && <span className="eyebrow hidden truncate sm:inline">⑂ {branch}</span>}

          <div className="ml-auto flex items-center gap-2.5">
            {usage && <Context usage={usage} />}
            {working ? (
              <button
                onClick={onStop}
                aria-label="Stop the agent"
                title="Stop"
                className="grid h-9 w-9 place-items-center rounded-full border border-line text-dim transition-colors hover:border-brick hover:text-brick"
              >
                <span className="block h-2.5 w-2.5 rounded-[2px] bg-current" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!live || (!draft.trim() && images.length === 0)}
                aria-label="Send"
                title="Send"
                className="grid h-9 w-9 place-items-center rounded-full bg-ember text-[15px] leading-none text-ground transition-opacity disabled:opacity-30"
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>

      {failed && (
        <p className="mt-1.5 text-[11.5px] text-brick">
          That didn&apos;t reach the agent. It may have stopped.
        </p>
      )}
    </div>
  );
}

/**
 * How full the model's context is.
 *
 * A ring rather than a number, because the number is meaningless — nobody
 * knows what 121,107 of 1,000,000 feels like — and a ring filling up is
 * immediately readable at the size this is drawn. The figure is there on hover
 * for anybody who does want it.
 *
 * Only ember once it is nearly full. Ember is the colour of something wanting
 * a decision, and a context meter at eleven percent is not asking for one.
 */
function Context({ usage }: { usage: Usage }) {
  const full = fullness(usage);
  if (full === undefined) return null;

  const percent = Math.round(full * 100);
  const R = 8;
  const circumference = 2 * Math.PI * R;
  const tight = full > 0.85;

  return (
    <span
      title={`Context ${percent}% full${
        usage.contextUsed && usage.contextWindow
          ? ` — ${usage.contextUsed.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens`
          : ""
      }${usage.costUsd ? ` · $${usage.costUsd.toFixed(3)}` : ""}`}
      className="relative grid h-9 w-9 place-items-center"
    >
      <svg viewBox="0 0 20 20" className="h-[19px] w-[19px] -rotate-90">
        <circle cx="10" cy="10" r={R} fill="none" strokeWidth="2" className="stroke-line" />
        <circle
          cx="10"
          cy="10"
          r={R}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - full)}
          className={tight ? "stroke-ember" : "stroke-mute"}
        />
      </svg>
      <span
        className={`absolute font-mono text-[8.5px] ${tight ? "text-ember" : "text-mute"}`}
      >
        {percent}
      </span>
    </span>
  );
}

/** 0 to 1, when the agent has said enough to work it out. */
function fullness(usage: Usage): number | undefined {
  const { contextUsed, contextWindow } = usage;
  if (!contextUsed || !contextWindow) return undefined;
  return Math.min(1, Math.max(0, contextUsed / contextWindow));
}

/** A trigger character and what has been typed after it. */
type Token = { kind: "@" | "/"; at: number; query: string };

/**
 * What the cursor is in the middle of, if it is in the middle of anything.
 *
 * Only at the start of a word, so an email address is not a file mention and a
 * path is not a command.
 */
function triggerAt(draft: string): Token | undefined {
  const match = /(^|\s)([@/])([^\s]*)$/.exec(draft);
  if (!match) return undefined;
  return {
    kind: match[2] as "@" | "/",
    at: match.index + match[1].length,
    query: match[3],
  };
}

type Suggestion = { value: string; hint?: string };

/**
 * What to offer for the thing being typed.
 *
 * Files come from the session's own workspace, which the control plane already
 * knows how to list. Commands come from what the agent reported it had at
 * startup — so the list is whatever that install actually offers, rather than a
 * list we keep in step by hand.
 */
function useSuggestions(
  sessionId: string,
  token: Token | undefined,
  commands: SlashCommand[],
  live: boolean,
): Suggestion[] {
  // A file mention is relative to the workspace root, so this only ever asks
  // for the top level. Deeper paths are typed.
  const wanted = token?.kind === "@" && live;
  const { data: files } = useListFiles(
    sessionId,
    { path: directoryOf(token?.query ?? "") },
    { query: { enabled: wanted } },
  );

  return useMemo(() => {
    if (!token) return [];
    const query = token.query.toLowerCase();

    if (token.kind === "/") {
      return commands
        .filter((c) => c.name.toLowerCase().startsWith(query))
        .slice(0, 8)
        .map((c) => ({ value: c.name, hint: c.description ?? undefined }));
    }

    const within = directoryOf(token.query);
    const leaf = token.query.slice(within.length ? within.length + 1 : 0).toLowerCase();
    return (files ?? [])
      .filter((f) => f.name.toLowerCase().includes(leaf))
      .slice(0, 8)
      .map((f) => ({
        value: within ? `${within}/${f.name}` : f.name,
        hint: f.directory ? "directory" : undefined,
      }));
  }, [token, commands, files]);
}

/** The part of a half-typed path that is already a directory. */
function directoryOf(query: string): string {
  const cut = query.lastIndexOf("/");
  return cut < 0 ? "" : query.slice(0, cut);
}

/**
 * Read dropped or pasted images into something a message can carry.
 *
 * Images only. Anything else needs to be written into the workspace and
 * mentioned by path, which is a different thing and not this.
 */
async function readImages(files: File[]): Promise<Attached[]> {
  const pictures = files.filter((f) => f.type.startsWith("image/"));
  return Promise.all(
    pictures.map(
      (file) =>
        new Promise<Attached>((done, fail) => {
          const reader = new FileReader();
          reader.onerror = () => fail(reader.error);
          reader.onload = () => {
            const url = String(reader.result);
            // `data:image/png;base64,XXXX` — the message wants only the bytes.
            done({ mediaType: file.type, data: url.slice(url.indexOf(",") + 1) });
          };
          reader.readAsDataURL(file);
        }),
    ),
  );
}

"use client";

import { useMemo, useRef, useState } from "react";
import { useAttachFile, useListFiles } from "@/src/api/generated/sessions/sessions";
import type { Attached, SlashCommand, Usage } from "@/src/api/generated/model";
import { Picker, MODELS, MODES, EFFORTS } from "@/components/Settings.chat";

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
  mode,
  effort,
  usage,
  branch,
  repo,
  onSend,
  onSet,
  onStop,
  failed,
}: {
  sessionId: string;
  live: boolean;
  working: boolean;
  commands: SlashCommand[];
  model?: string;
  mode?: string;
  effort?: string;
  usage?: Usage;
  branch?: string | null;
  repo?: string | null;
  onSend: (text: string, images: Attached[]) => void;
  /** Put a setting into force, by saying so to the agent. */
  onSet: (kind: "model" | "mode" | "effort", value: string) => void;
  onStop: () => void;
  failed: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<Attached[]>([]);
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  /** Files put into the workspace, waiting to be mentioned in a message. */
  const [files, setFiles] = useState<{ name: string; path: string }[]>([]);
  const attach = useAttachFile();
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  /**
   * Take what somebody handed over, by whichever route suits it.
   *
   * Pictures go inside the message, because the model looks at them. Everything
   * else goes into the workspace, where the agent can read, grep, unzip or edit
   * it with the tools it already has — and where it costs nothing until it
   * does, so an archive never has to fit in a prompt.
   */
  const take = async (chosen: File[]) => {
    setRefused(null);
    const pictures = chosen.filter((f) => f.type.startsWith("image/"));
    const rest = chosen.filter((f) => !f.type.startsWith("image/"));

    const { kept, why } = await readImages(pictures);
    if (kept.length) setImages((held) => [...held, ...kept]);

    const complaints = why ? [why] : [];
    for (const file of rest) {
      if (file.size > BIGGEST_FILE) {
        complaints.push(`${file.name} is over ${BIGGEST_FILE / 1024 / 1024} MB.`);
        continue;
      }
      try {
        const { path } = await attach.mutateAsync({
          id: sessionId,
          data: { name: file.name, data: await base64(file) },
        });
        setFiles((held) => [...held, { name: file.name, path }]);
      } catch {
        complaints.push(`${file.name} could not be put in the workspace.`);
      }
    }

    if (complaints.length) setRefused(complaints.join(" "));
  };

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
    if (!text && images.length === 0 && files.length === 0) return;

    // Named, not described. The agent has its own tools for reading a file; all
    // it needs is where the file is.
    const mentioned = files.map((f) => f.path).join("\n");
    const message = mentioned ? (text ? `${text}\n\n${mentioned}` : mentioned) : text;

    setDraft("");
    setImages([]);
    setFiles([]);
    onSend(message, images);
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
        await take(Array.from(e.dataTransfer.files));
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

      {refused && (
        <p className="mb-2 text-[11.5px] text-brick">{refused}</p>
      )}

      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {files.map((file, i) => (
            <span
              key={file.path}
              className="flex items-center gap-1.5 rounded-[6px] border border-line bg-panel px-2 py-1"
              title={file.path}
            >
              <span className="max-w-[180px] truncate font-mono text-[11.5px] text-dim">
                {file.name}
              </span>
              <button
                onClick={() => setFiles((held) => held.filter((_, at) => at !== i))}
                aria-label={`Remove ${file.name}`}
                className="text-[11px] text-mute hover:text-bone"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {attach.isPending && (
        <p className="mb-2 text-[11.5px] text-mute">Putting it in the workspace…</p>
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
            const pictures = Array.from(e.clipboardData.files).filter((f) =>
              f.type.startsWith("image/"),
            );
            if (pictures.length === 0) return;
            // Only swallow the paste if it actually was a picture; a paste of
            // text and an image together should still deliver the text.
            if (!e.clipboardData.getData("text")) e.preventDefault();
            await take(pictures);
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

        {/* Controls, not captions. Everything here changes something; what is
            merely true about the session moved to the line underneath. */}
        <div className="flex items-center gap-1.5 px-2.5 pb-2">
          {/* Discoverable. Pasting and dropping both work and neither announces
              itself, so somebody who has not been told cannot know they can. */}
          <button
            onClick={() => picker.current?.click()}
            disabled={!live}
            aria-label="Attach a file"
            title="Attach a file or an image"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-[5px] text-[15px] leading-none text-mute transition-colors hover:bg-raise hover:text-bone disabled:opacity-40"
          >
            +
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={async (e) => {
              await take(Array.from(e.target.files ?? []));
              // Cleared, or choosing the same file twice does nothing.
              e.target.value = "";
            }}
          />

          <Picker
            choices={MODELS}
            current={model}
            fallback="Model"
            disabled={!live}
            onPick={(v) => onSet("model", v)}
          />
          <Picker
            choices={MODES}
            current={mode}
            fallback="Permissions"
            disabled={!live}
            onPick={(v) => onSet("mode", v)}
          />
          <Picker
            choices={EFFORTS}
            current={effort}
            fallback="Effort"
            disabled={!live}
            onPick={(v) => onSet("effort", v)}
          />

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

      {(repo || branch) && (
        <div className="mt-1.5 flex items-center gap-3 px-1 font-mono text-[11px] text-mute">
          {repo && <span className="truncate">{repo}</span>}
          {branch && <span className="min-w-0 truncate">⑂ {branch}</span>}
        </div>
      )}

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
      return rank(commands, query).slice(0, 8);
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

/**
 * Commands nobody types.
 *
 * The agent reports everything it can dispatch, which includes machinery: hooks
 * into its own workflow engine, a heap dump, consent prompts. Offering those in
 * a menu is offering somebody a way to break their session.
 */
const INTERNAL = new Set([
  "heapdump",
  "reload-skills",
  "workflow-launch-exec",
  "design-consent",
  "design-revoke",
  "auto-mode-setup",
  "run-skill-generator",
]);

/**
 * The ones worth putting first before anything has been typed.
 *
 * Chosen by testing which actually answer in a headless session rather than by
 * reading a list: `/context`, `/usage` and `/mcp` all return something useful,
 * while several of their neighbours return an empty string.
 *
 * `model` and `effort` are here too, even though the row below has pickers for
 * both — somebody who knows the command should not have to hunt for the button.
 */
const USEFUL = ["context", "usage", "compact", "mcp", "model", "effort", "config", "rename"];

/**
 * Order the commands by how likely this one is the one wanted.
 *
 * The agent hands over its whole list in whatever order it holds them, which on
 * a machine with a couple of dozen skills installed means the menu opens on
 * twenty-five variations of the same one. What somebody has typed comes first,
 * then what is short, then everything else.
 */
function rank(commands: SlashCommand[], query: string): Suggestion[] {
  const usable = commands.filter(
    (c) => !c.name.startsWith("__") && !INTERNAL.has(c.name),
  );

  if (!query) {
    const first = USEFUL.map((name) => usable.find((c) => c.name === name)).filter(
      (c): c is SlashCommand => c !== undefined,
    );
    const rest = usable.filter((c) => !USEFUL.includes(c.name));
    return [...first, ...rest].map(described);
  }

  const scored = usable
    .map((c) => {
      const name = c.name.toLowerCase();
      // A name that starts with what was typed beats one that merely contains
      // it, and a short name beats a long one — `model` before
      // `some-plugin:model-helper`.
      const where = name.startsWith(query) ? 0 : name.includes(query) ? 1 : -1;
      return { c, where };
    })
    .filter(({ where }) => where >= 0)
    .sort((a, b) => a.where - b.where || a.c.name.length - b.c.name.length);

  return scored.map(({ c }) => described(c));
}

function described(c: SlashCommand): Suggestion {
  return { value: c.name, hint: c.description ?? undefined };
}

/** The part of a half-typed path that is already a directory. */
function directoryOf(query: string): string {
  const cut = query.lastIndexOf("/");
  return cut < 0 ? "" : query.slice(0, cut);
}

/**
 * How large one image may be.
 *
 * Base64 inflates by about a third, and the whole thing travels as a single
 * line of JSON through every hop — the browser, the control plane, an SSH pipe,
 * the worker, and the agent's stdin — each of which holds it whole. Nothing in
 * that chain has a limit of its own, so this is the limit.
 *
 * Generous for what people actually attach: a screenshot is a megabyte or two.
 */
const BIGGEST = 5 * 1024 * 1024;

/**
 * How large any other file may be.
 *
 * More generous than an image, because this never enters the model's context —
 * it lands in the workspace and stays there until the agent reads it. Still
 * bounded: it travels as base64 in one JSON frame, and every hop between here
 * and the workspace holds that line whole.
 */
const BIGGEST_FILE = 10 * 1024 * 1024;

/** A file's bytes, base64, without the data-url prefix. */
function base64(file: File): Promise<string> {
  return new Promise((done, fail) => {
    const reader = new FileReader();
    reader.onerror = () => fail(reader.error);
    reader.onload = () => {
      const url = String(reader.result);
      done(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Read pictures into something a message can carry.
 *
 * Only pictures reach this — everything else goes to the workspace instead —
 * so what it refuses is only what is too large, and it says so rather than
 * dropping it silently.
 */
async function readImages(
  files: File[],
): Promise<{ kept: Attached[]; why?: string }> {
  if (files.length === 0) return { kept: [] };

  const small = files.filter((f) => f.size <= BIGGEST);
  const tooBig = files.length - small.length;

  const kept = await Promise.all(
    small.map(
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

  const complaints: string[] = [];
  if (tooBig > 0) {
    complaints.push(
      `${tooBig === 1 ? "That image is" : `${tooBig} images are`} over 5 MB.`,
    );
  }

  return { kept, why: complaints.join(" ") || undefined };
}

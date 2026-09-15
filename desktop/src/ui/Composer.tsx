/**
 * Saying something to the agent — for real.
 *
 * A message is not keystrokes: pictures go inside it, because the model looks
 * at them; every other file goes into the workspace with `attach_file` and is
 * only *named* in the message, because the agent has its own tools for reading
 * one and sending the bytes twice is waste. Both rules are the web build's.
 *
 * The pickers are drawn from what the agent reports it can change
 * (`session_controls`), not from a list kept here — a Codex session must not be
 * offered Opus. Choosing shows as chosen straight away (`remember`) because
 * Claude Code restates the model only at the start of the next turn, and the
 * server's answer overwrites it, so a refused request corrects itself.
 *
 * The meter is the agent's own report of its context window, off the last
 * finished turn. Adding up deltas here would drift.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, FileUp, ImageIcon, Loader2, Paperclip, Square, X } from "lucide-react";
import type { Conversation } from "~/api/conversation";
import type { Attached, Control, ControlKind, Session } from "~/api/generated/model";
import { useAttachFile, useInterruptSession, useListFiles, useSendTurn } from "~/api/generated/sessions/sessions";
import { useChooseControl, useSessionControls } from "~/api/generated/conversation/conversation";
import { takeDraft } from "~/workspace/draft";

type Chip = { name: string; kind: "image" | "file"; size: string; url?: string; path?: string };

const BIGGEST_IMAGE = 5 * 1024 * 1024;
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

const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

/** What is being typed after a trigger character, if anything. The web's rule. */
type Token = { kind: "@" | "/"; at: number; query: string };
function triggerAt(draft: string): Token | undefined {
  const match = /(^|\s)([@/])([^\s]*)$/.exec(draft);
  if (!match) return undefined;
  return { kind: match[2] as "@" | "/", at: match.index + match[1].length, query: match[3] };
}
const directoryOf = (q: string) => (q.includes("/") ? q.slice(0, q.lastIndexOf("/")) : "");

export function Composer({
  session,
  conversation,
  onEcho,
  onRemember,
  onStopping,
  disabled,
  asking,
}: {
  session: Session;
  conversation: Conversation;
  onEcho: (text: string, images: Attached[]) => void;
  onRemember: (of: "model" | "mode" | "effort", value: string) => void;
  /** Stop was pressed, or the request to stop came back refused. */
  onStopping: (asked: boolean) => void;
  disabled: boolean;
  asking: boolean;
}) {
  const send = useSendTurn();
  const attach = useAttachFile();
  const interrupt = useInterruptSession();
  const choose = useChooseControl();
  const controls = useSessionControls(session.id);

  // What a session can be asked to change is not known when it opens: an
  // agent that lists its own models answers a moment later. Saying which model
  // it is running is that moment, so it is the signal to ask again.
  const model = conversation.model;
  const askAgain = controls.refetch;
  useEffect(() => {
    askAgain();
  }, [model, askAgain]);

  const [text, setText] = useState(() => takeDraft(session.id) ?? "");
  const [images, setImages] = useState<Attached[]>([]);
  const [chips, setChips] = useState<Chip[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  /** Clicked, and not yet confirmed by the server or by the agent. */
  const [chosen, setChosen] = useState<Partial<Record<ControlKind, string>>>({});
  const box = useRef<HTMLTextAreaElement>(null);

  /* `/` offers the commands this install actually has, as the agent reported
     them at startup; `@` offers files off the worker, one directory at a time,
     relative to the workspace root. Both are the web build's affordances. */
  const token = triggerAt(text);
  const wantFiles = token?.kind === "@";
  const listing = useListFiles(session.id, { path: directoryOf(token?.query ?? "") }, { query: { enabled: !!wantFiles, staleTime: 30_000 } });
  const [pick, setPick] = useState(0);
  const suggestions: { value: string; hint?: string }[] = !token
    ? []
    : token.kind === "/"
      ? conversation.commands.filter((c) => c.name.toLowerCase().startsWith(token.query.toLowerCase())).slice(0, 8).map((c) => ({ value: `/${c.name}`, hint: c.description ?? undefined }))
      : ((listing.data ?? []) as { name: string; directory: boolean }[])
          .filter((f) => f.name.toLowerCase().startsWith((token.query.split("/").pop() ?? "").toLowerCase()))
          .slice(0, 8)
          .map((f) => {
            const dir = directoryOf(token.query);
            const full = (dir ? `${dir}/` : "") + f.name + (f.directory ? "/" : "");
            return { value: `@${full}`, hint: f.directory ? "directory" : undefined };
          });
  useEffect(() => setPick(0), [token?.query, token?.kind]);

  const accept = (value: string) => {
    if (!token) return;
    const before = text.slice(0, token.at);
    const after = text.slice(token.at + 1 + token.query.length);
    setText(`${before}${value}${value.endsWith("/") ? "" : " "}${after}`);
    box.current?.focus();
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const take = async (list: FileList | File[] | null) => {
    if (!list) return;
    setRefused(null);
    const files = [...list];
    const complaints: string[] = [];

    for (const file of files) {
      if (file.type.startsWith("image/")) {
        if (file.size > BIGGEST_IMAGE) {
          complaints.push(`${file.name} is over 5 MB.`);
          continue;
        }
        const data = await base64(file);
        setImages((held) => [...held, { mediaType: file.type, data }]);
        setChips((held) => [...held, { name: file.name, kind: "image", size: size(file.size), url: URL.createObjectURL(file) }]);
        continue;
      }
      if (file.size > BIGGEST_FILE) {
        complaints.push(`${file.name} is over 10 MB.`);
        continue;
      }
      try {
        const { path } = await attach.mutateAsync({ id: session.id, data: { name: file.name, data: await base64(file) } });
        setChips((held) => [...held, { name: file.name, kind: "file", size: size(file.size), path }]);
      } catch {
        complaints.push(`${file.name} could not be put in the workspace.`);
      }
    }
    if (complaints.length) setRefused(complaints.join(" "));
  };

  const drop = (i: number) => {
    const chip = chips[i];
    setChips((h) => h.filter((_, n) => n !== i));
    if (chip?.kind === "image") {
      const at = chips.slice(0, i).filter((c) => c.kind === "image").length;
      setImages((h) => h.filter((_, n) => n !== at));
    }
  };

  const submit = () => {
    if (send.isPending || disabled) return;
    const named = chips.filter((c) => c.path).map((c) => c.path).join("\n");
    const message = [text.trim(), named].filter(Boolean).join("\n\n");
    if (!message && images.length === 0) return;

    onEcho(message, images);
    send.mutate({ id: session.id, data: { text: message, images } });
    setText("");
    setImages([]);
    setChips([]);
  };

  /* Pressing stop asks the agent to end the turn; the turn ending is what says
     it worked, so the button waits on that rather than on the request it sent.
     A refusal is said out loud: a click that did nothing and reported nothing
     is indistinguishable from an agent that ignored it, and that is exactly
     what this button was before. */
  const stopping = conversation.stopping ?? false;
  const stop = () => {
    if (stopping) return;
    onStopping(true);
    interrupt.mutate(
      { id: session.id },
      {
        onError: (e) => {
          onStopping(false);
          setRefused(`The agent could not be stopped. ${e instanceof Error ? e.message : ""}`.trim());
        },
      },
    );
  };

  const set = (kind: ControlKind, value: string) => {
    if (kind === "model" || kind === "mode" || kind === "effort") onRemember(kind, value);
    setChosen((was) => ({ ...was, [kind]: value }));
    choose.mutate({ id: session.id, data: { kind, value } }, { onSuccess: () => controls.refetch() });
  };

  const offered: Control[] = controls.data ?? [];
  const usage = conversation.usage;
  const full = usage?.contextUsed && usage?.contextWindow ? usage.contextUsed / usage.contextWindow : null;

  return (
    <div className="shrink-0 px-8 pb-6">
      <div className="mx-auto w-full max-w-[46rem]">
        {refused && (
          <div className="mb-2 flex items-center gap-2 text-meta text-brick">
            <X className="h-3.5 w-3.5" strokeWidth={2} />
            {refused}
          </div>
        )}

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            take(e.dataTransfer.files);
          }}
          className={`relative rounded-2xl border bg-panel shadow-(--shadow-float) transition-colors duration-150 ${
            over ? "border-slate" : "border-line focus-within:border-line-soft"
          } ${disabled ? "opacity-60" : ""}`}
        >
          {over && (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl bg-ground/80">
              <span className="flex items-center gap-2 text-ui text-slate">
                <FileUp className="h-4 w-4" strokeWidth={1.75} />
                Drop it in the workspace
              </span>
            </div>
          )}

          {chips.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {chips.map((c, i) => (
                <span key={i} className="flex items-center gap-2 rounded-lg border border-line bg-raise py-1 pr-1 pl-2">
                  {c.url ? (
                    <img src={c.url} alt="" className="h-7 w-7 rounded object-cover" />
                  ) : (
                    <span className="grid h-7 w-7 place-items-center rounded bg-ground text-mute">
                      <ImageIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </span>
                  )}
                  <span className="max-w-[11rem] truncate font-mono text-meta text-text">{c.path ?? c.name}</span>
                  <span className="text-micro text-mute">{c.size}</span>
                  <button onClick={() => drop(i)} className="grid h-5 w-5 place-items-center rounded text-mute hover:bg-overlay hover:text-bone">
                    <X className="h-3 w-3" strokeWidth={2} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {suggestions.length > 0 && (
            <div className="mx-3 mt-3 overflow-hidden rounded-lg border border-line bg-overlay">
              {suggestions.map((sug, n) => (
                <button key={sug.value} onMouseEnter={() => setPick(n)} onMouseDown={(e) => { e.preventDefault(); accept(sug.value); }} data-on={n === pick} className="row w-full rounded-none">
                  <span className={`font-mono text-ui ${n === pick ? "text-bone" : "text-text"}`}>{sug.value}</span>
                  {sug.hint && <span className="truncate text-meta text-mute">{sug.hint}</span>}
                </button>
              ))}
            </div>
          )}

          <textarea
            ref={box}
            rows={1}
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => e.clipboardData.files.length && take(e.clipboardData.files)}
            onKeyDown={(e) => {
              if (suggestions.length > 0) {
                if (e.key === "ArrowDown") { e.preventDefault(); setPick((n) => Math.min(n + 1, suggestions.length - 1)); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setPick((n) => Math.max(n - 1, 0)); return; }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); accept(suggestions[pick].value); return; }
                if (e.key === "Escape") { setText(text + " "); return; }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              disabled ? "This session has ended." : asking ? "Answer above, or say something else" : "Say something to the agent"
            }
            className="scroll-slim block w-full resize-none bg-transparent px-4 py-3.5 text-read text-text placeholder:text-mute focus:outline-none"
          />

          <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
            <label className="control cursor-pointer text-mute hover:bg-raise hover:text-bone" title="Attach a file or an image">
              <Paperclip className="h-4 w-4" strokeWidth={1.75} />
              <input type="file" multiple className="hidden" onChange={(e) => take(e.target.files)} />
            </label>

            {offered.map((c) => (
              <Picker
                key={c.kind}
                control={c}
                value={chosen[c.kind] ?? c.current ?? (c.kind === "model" ? conversation.model : c.kind === "mode" ? conversation.mode : undefined)}
                onPick={(v) => set(c.kind, v)}
              />
            ))}

            {full !== null && (
              <span className="control gap-2 text-mute" title={`${Math.round(full * 100)}% of the context window used`}>
                <span className="h-1 w-14 overflow-hidden rounded-full bg-ground">
                  <span className={`block h-full rounded-full ${full > 0.75 ? "bg-ember" : "bg-slate"}`} style={{ width: `${Math.min(100, full * 100)}%` }} />
                </span>
                <span className="text-micro tabular-nums">{Math.round(full * 100)}%</span>
              </span>
            )}

            {conversation.working ? (
              <button
                onClick={stop}
                disabled={stopping}
                title={stopping ? "Stopping" : "Interrupt the agent"}
                className="ml-auto grid h-8 w-8 place-items-center rounded-full border border-line bg-raise text-bone transition-colors hover:bg-overlay disabled:text-mute disabled:hover:bg-raise"
              >
                {stopping ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />
                ) : (
                  <Square className="h-3.5 w-3.5" strokeWidth={2.5} />
                )}
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={disabled || (!text.trim() && images.length === 0 && chips.length === 0)}
                title="Send"
                className="ml-auto grid h-8 w-8 place-items-center rounded-full bg-bone text-ground transition-opacity duration-150 hover:opacity-90 disabled:bg-raise disabled:text-mute"
              >
                <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>

        <div className="mt-2 flex items-center gap-3 px-1 text-micro text-mute">
          <span className="flex items-center gap-1">
            <span className="keycap">⏎</span> send
          </span>
          <span className="flex items-center gap-1">
            <span className="keycap">⇧⏎</span> new line
          </span>
          {conversation.limits && conversation.limits.status !== "allowed" && (
            <span className="ml-auto text-ember-soft">{conversation.limits.window}: {conversation.limits.status}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function Picker({ control, value, onPick }: { control: Control; value?: string; onPick: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const here = control.choices.find((c) => c.value === value);
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="control text-mute hover:bg-raise hover:text-bone">
        {here?.label ?? control.fallback}
        <ChevronDown className="h-3 w-3" strokeWidth={2} />
      </button>
      {open && (
        <>
          <button className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-30 mb-1.5 w-[16rem] overflow-hidden rounded-lg border border-line bg-overlay p-1 shadow-(--shadow-float)">
            {control.choices.map((c) => (
              <button
                key={c.value}
                onClick={() => {
                  onPick(c.value);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-raise"
              >
                <Check className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${c.value === value ? "text-bone" : "text-transparent"}`} strokeWidth={2} />
                <span>
                  <span className={`block text-ui ${c.grave ? "text-brick" : "text-bone"}`}>{c.label}</span>
                  {c.note && <span className="block text-meta text-mute">{c.note}</span>}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

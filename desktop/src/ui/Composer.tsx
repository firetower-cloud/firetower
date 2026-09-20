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
import type { RefObject } from "react";
import { ArrowUp, Check, ChevronDown, FileText, ImageOff, Loader2, Paperclip, Square, X } from "lucide-react";
import type { Conversation } from "~/api/conversation";
import type { Attached, Control, ControlKind, Session } from "~/api/generated/model";
import { useAttachFile, useInterruptSession, useListFiles, useSendTurn } from "~/api/generated/sessions/sessions";
import { useChooseControl, useSessionControls } from "~/api/generated/conversation/conversation";
import { takeDraft } from "~/workspace/draft";
import { AccountLine, AccountNotice } from "~/ui/AccountSwitcher";
import { Mic } from "~/ui/voice/Mic";
import { VoiceDialog } from "~/ui/voice/Dialogs";
import { useVoice } from "~/ui/voice/useVoice";

/**
 * One attached thing, from the moment it is dropped.
 *
 * A chip appears before its upload finishes, so ten files read as ten things
 * happening rather than as nothing happening and then ten things existing. It
 * carries its own identity because removing one used to be an index sum — the
 * chip's position, counted against a second array of images — and that sum is
 * the kind that is wrong exactly when it matters, with a mixed batch.
 */
type Chip = {
  id: number;
  name: string;
  kind: "image" | "file";
  size: string;
  /** A thumbnail, for a picture. */
  url?: string;
  /** Where it landed in the workspace, once it has. */
  path?: string;
  /** The bytes that ride inside the message, for a picture. */
  image?: Attached;
  /** Still being read, or still on its way to the workspace. */
  pending?: boolean;
};

/**
 * Attaching files from outside the composer.
 *
 * The drop surface is the whole chat pane, which is a level up — but the rules
 * for what a file becomes, the chips, the size limits and the refusal line all
 * live here and should stay in one place. So the pane borrows this rather than
 * the state moving up to meet it. `refusals` is for things the caller already
 * knows are no good, a dropped folder being the only one so far.
 */
export type Hand = (files: File[], refusals?: string[]) => void;

const BIGGEST_IMAGE = 5 * 1024 * 1024;
/** Must match `attachments::BIGGEST` on the worker, which enforces it. */
const BIGGEST_FILE = 25 * 1024 * 1024;

/**
 * The most one message carries.
 *
 * A cap on the message rather than on the gesture: a second drop fills what is
 * left, so this cannot be walked around by dropping twice. Ten is more than
 * any real ask and few enough that a mis-aimed multi-select cannot start a
 * hundred uploads — they go one at a time, and there is no way to call them
 * back once started.
 */
const MOST = 10;

/**
 * How many of these will fit, and what to say about the ones that will not.
 *
 * Exported for its own test: the arithmetic is off-by-one bait, and the case
 * that matters — a batch that is partly accepted — is the one nobody tries by
 * hand.
 */
export function roomFor(held: number, offered: string[]): { fit: number; refusals: string[] } {
  const room = Math.max(0, MOST - held);
  if (offered.length <= room) return { fit: offered.length, refusals: [] };
  const over = offered.slice(room);
  const rest = over.length - 1;
  const named =
    rest === 0 ? `${over[0]} was` : `${over[0]} and ${rest} other${rest === 1 ? "" : "s"} were`;
  return { fit: room, refusals: [`${MOST} files at a time — ${named} not taken.`] };
}

const megabytes = (n: number) => `${n / 1024 / 1024} MB`;

/**
 * What the drop overlay says you can give it.
 *
 * There is no allowlist to recite — no `accept` on the picker and no type check
 * in `take` beyond picture-or-not — so the only thing worth saying in advance is
 * the size a file has to be under. Stated here, next to the numbers that
 * enforce it, so the two cannot drift.
 */
export const TAKES = `Up to ${MOST} files — images to ${megabytes(BIGGEST_IMAGE)}, everything else to ${megabytes(BIGGEST_FILE)}`;

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
  hand,
}: {
  session: Session;
  conversation: Conversation;
  onEcho: (text: string, images: Attached[]) => void;
  onRemember: (of: "model" | "mode" | "effort", value: string) => void;
  /** Stop was pressed, or the request to stop came back refused. */
  onStopping: (asked: boolean) => void;
  disabled: boolean;
  asking: boolean;
  /** Filled in with `take`, for the pane's drop surface to call. */
  hand?: RefObject<Hand | null>;
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
  const [chips, setChips] = useState<Chip[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const nextId = useRef(0);
  /* Chips whose thumbnail would not decode. A file can carry an `image/*` type
     and not be a picture — truncated, renamed, or written by something that
     guessed — and the browser's answer to that is a torn-page glyph that reads
     as the app being broken rather than the file. */
  const [unreadable, setUnreadable] = useState<Set<number>>(new Set());
  /* How many are on the message, read synchronously: two drops in the same
     tick both have to see the slots the other took, and state would not have
     landed yet. Reconciled from the real list after every render. */
  const held = useRef(0);
  /** Clicked, and not yet confirmed by the server or by the agent. */
  const [chosen, setChosen] = useState<Partial<Record<ControlKind, string>>>({});
  const box = useRef<HTMLTextAreaElement>(null);
  /* Dictation writes into `text` like a second pair of hands. It is given the
     box because stopping puts the caret back where the words ended, and the
     setter because everything it hears is an ordinary edit to the draft —
     there is no second field, and nothing it produces is sent on its own. */
  const voice = useVoice({ text, setText, box });
  const listening = voice.state.at !== "idle" && voice.state.at !== "asking";

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

  const settle = (id: number, done: Partial<Chip>) =>
    setChips((all) => all.map((c) => (c.id === id ? { ...c, ...done, pending: false } : c)));
  const forget = (id: number) => {
    setChips((all) => all.filter((c) => c.id !== id));
    held.current = Math.max(0, held.current - 1);
  };

  /* Whatever the real list says, that is how many are held. Cheap, and it
     undoes any drift the synchronous reservation above may have introduced. */
  useEffect(() => {
    held.current = chips.length;
  }, [chips]);

  const take = async (list: FileList | File[] | null, refusals: string[] = []) => {
    const offered = [...(list ?? [])];
    if (offered.length === 0 && refusals.length === 0) return;
    setRefused(null);
    const complaints: string[] = [...refusals];

    /* Too big is decided before anything is shown, so an oversize file never
       appears as a chip that then vanishes. */
    const sized = offered.filter((file) => {
      const cap = file.type.startsWith("image/") ? BIGGEST_IMAGE : BIGGEST_FILE;
      if (file.size <= cap) return true;
      complaints.push(`${file.name} is over ${megabytes(cap)}.`);
      return false;
    });

    const room = roomFor(held.current, sized.map((f) => f.name));
    const files = sized.slice(0, room.fit);
    complaints.push(...room.refusals);

    /* Said now, not at the end. Everything refused so far — too big, too many,
       a folder — was decided before a single byte moved, and hearing about it
       after ten uploads have finished is hearing about it too late to do
       anything. Failures found during the loop are added to this line as they
       happen. */
    if (complaints.length) setRefused(complaints.join(" "));

    /* Every chip at once, before the first byte moves: the slots are reserved
       in the same breath they are counted, and the row fills in place. */
    const taken = files.map((file) => ({
      file,
      chip: {
        id: nextId.current++,
        name: file.name,
        kind: (file.type.startsWith("image/") ? "image" : "file") as Chip["kind"],
        size: size(file.size),
        url: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        pending: true,
      } satisfies Chip,
    }));
    if (taken.length) {
      held.current += taken.length;
      setChips((all) => [...all, ...taken.map((t) => t.chip)]);
    }

    /* One at a time on purpose. Ten parallel uploads of twenty-five megabytes
       is ten bodies in flight through every hop at once; the spinner is what
       makes waiting legible, not concurrency. */
    for (const { file, chip } of taken) {
      try {
        const data = await base64(file);
        if (chip.kind === "image") {
          settle(chip.id, { image: { mediaType: file.type, data } });
          continue;
        }
        const { path } = await attach.mutateAsync({ id: session.id, data: { name: file.name, data } });
        settle(chip.id, { path });
      } catch {
        forget(chip.id);
        complaints.push(
          chip.kind === "image"
            ? `${file.name} could not be read.`
            : `${file.name} could not be put in the workspace.`,
        );
        setRefused(complaints.join(" "));
      }
    }
  };

  useEffect(() => {
    if (!hand) return;
    hand.current = (files, refusals) => void take(files, refusals);
    return () => {
      hand.current = null;
    };
  });

  /** Something is still being read or uploaded, so the message is incomplete. */
  const busy = chips.some((c) => c.pending);

  const submit = (said: string = text) => {
    /* Sending mid-upload would send the message without the file it was about
       — the path does not exist until the upload answers. */
    if (send.isPending || disabled || busy) return;
    const images = chips.flatMap((c) => (c.image ? [c.image] : []));
    const named = chips.filter((c) => c.path).map((c) => c.path).join("\n");
    const message = [said.trim(), named].filter(Boolean).join("\n\n");
    if (!message && images.length === 0) return;

    onEcho(message, images);
    send.mutate({ id: session.id, data: { text: message, images } });
    setText("");
    setChips([]);
    held.current = 0;
  };

  /* Send, pressed while still talking. Not a refusal and not a race: the last
     words are still arriving, so dictation is asked to settle and hands back
     the finished text. Sending `text` here instead would send the sentence
     minus whatever was in flight, which is the failure nobody would report as
     a bug — they would just re-type the end of the sentence and think nothing
     of it. */
  const say = () => (listening ? voice.stop((said) => submit(said)) : submit());

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
        <AccountNotice />
        {voice.blocked && (
          <VoiceDialog blocked={voice.blocked} onDismiss={voice.dismiss} onConfigure={voice.configure} />
        )}
        {refused && (
          <div className="mb-2 flex items-center gap-2 text-meta text-brick">
            <X className="h-3.5 w-3.5" strokeWidth={2} />
            {refused}
          </div>
        )}

        <div
          className={`relative rounded-2xl border border-line bg-panel shadow-(--shadow-float) transition-colors duration-150 focus-within:border-line-soft ${
            disabled ? "opacity-60" : ""
          }`}
        >
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {chips.map((c) => (
                <span key={c.id} className="flex items-center gap-2 rounded-lg border border-line bg-raise py-1 pr-1 pl-2">
                  {/* The thumbnail stays visible under the spinner: dimming it
                      says "not yet" without taking away what you dropped. */}
                  <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded bg-ground text-mute">
                    {c.url && !unreadable.has(c.id) && (
                      <img
                        src={c.url}
                        alt=""
                        onError={() => setUnreadable((was) => new Set(was).add(c.id))}
                        className={`h-7 w-7 rounded object-cover ${c.pending ? "opacity-30" : ""}`}
                      />
                    )}
                    {c.pending ? (
                      <Loader2 className="absolute h-3.5 w-3.5 animate-spin text-bone" strokeWidth={2.5} />
                    ) : unreadable.has(c.id) ? (
                      /* Says which of the two went wrong: the picture, not the app. */
                      <ImageOff className="h-3.5 w-3.5 text-brick" strokeWidth={1.75} />
                    ) : (
                      !c.url && <FileText className="h-3.5 w-3.5" strokeWidth={1.75} />
                    )}
                  </span>
                  {/* The name, not the path. Every attachment lands in the same
                      directory, so a truncated path makes eight files read as
                      eight identical chips — and the path is spelled out in the
                      message itself the moment this is sent. */}
                  <span
                    title={c.path ?? c.name}
                    className={`max-w-[11rem] truncate font-mono text-meta ${c.pending ? "text-mute" : "text-text"}`}
                  >
                    {c.name}
                  </span>
                  <span className="text-micro text-mute">{c.size}</span>
                  <button onClick={() => forget(c.id)} className="grid h-5 w-5 place-items-center rounded text-mute hover:bg-overlay hover:text-bone">
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
            onChange={(e) => voice.typed(e.target.value)}
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
                say();
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

            {voice.possible && <Mic state={voice.state} onStart={voice.start} onStop={voice.stop} />}

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
                onClick={say}
                disabled={disabled || busy || (!text.trim() && chips.length === 0)}
                title={busy ? "Waiting for the files" : "Send"}
                className="ml-auto grid h-8 w-8 place-items-center rounded-full bg-bone text-ground transition-opacity duration-150 hover:opacity-90 disabled:bg-raise disabled:text-mute"
              >
                <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>

        <div className="mt-2 flex items-center gap-3 px-1 text-micro text-mute">
          {/* While it listens the two keys are unchanged and already known, and
              the one thing worth the space is how to make it stop. */}
          {listening ? (
            <span className="text-dim">
              {voice.state.at === "connecting"
                ? "Connecting…"
                : voice.state.at === "settling"
                  ? "Finishing what you said…"
                  : "Listening — click to stop"}
            </span>
          ) : (
            <>
              <span className="flex items-center gap-1">
                <span className="keycap">⏎</span> send
              </span>
              <span className="flex items-center gap-1">
                <span className="keycap">⇧⏎</span> new line
              </span>
            </>
          )}
          {conversation.limits && conversation.limits.status !== "allowed" && (
            <span className="ml-auto text-ember-soft">{conversation.limits.window}: {conversation.limits.status}</span>
          )}
          <AccountLine />
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

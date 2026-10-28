/**
 * Saying something to the agent — for real.
 *
 * A message is not keystrokes: pictures go inside it, because the model looks
 * at them; every other file goes into the workspace with `attach_file` and is
 * only *named* in the message, because the agent has its own tools for reading
 * one and sending the bytes twice is waste. Both rules are the web build's.
 *
 * The settings behind the one control (`AgentPicker`) are drawn from what the
 * agent reports it can change (`session_controls`), not from a list kept here —
 * a Codex session must not be offered Opus. Choosing shows as chosen straight
 * away (`remember`) because Claude Code restates the model only at the start of
 * the next turn, and the server's answer overwrites it, so a refused request
 * corrects itself.
 *
 * The meter is the agent's own report of its context window, off the last
 * finished turn. Adding up deltas here would drift.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { ArrowUp, Diamond, FileText, ImageOff, Loader2, Paperclip, Square, X } from "lucide-react";
import { interruptible, type Conversation } from "~/api/conversation";
import type { Artifact, Attached, Control, ControlKind, Session } from "~/api/generated/model";
import { mentionArtifact, useListArtifacts } from "~/api/generated/artifacts/artifacts";
import { elapsed, minutesSince } from "~/api/view";
import { ArtifactShot } from "~/components/ArtifactShot";
import { handleFor, mentionBlock, MOST_ARTIFACTS, MOST_ROWS, originOf, rankArtifacts, withoutHandle, type Mention } from "~/mentions";
import { useAttachFile, useInterruptSession, useListFiles, useSendTurn } from "~/api/generated/sessions/sessions";
import { useChooseControl, useSessionControls } from "~/api/generated/conversation/conversation";
import { takeDraft } from "~/workspace/draft";
import { AccountLine, AccountNotice } from "~/ui/AccountSwitcher";
import { AgentPicker } from "~/ui/AgentPicker";
import { Mic } from "~/ui/voice/Mic";
import { VoiceDialog } from "~/ui/voice/Dialogs";
import { useVoice } from "~/ui/voice/useVoice";
import { SkillPicker } from "~/ui/SkillPicker";
import { useAgents, useSessionSkillIds, why } from "~/data";
import { fromDefaults } from "~/skills";

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
  kind: "image" | "file" | "artifact";
  size: string;
  /** A thumbnail, for a picture. */
  url?: string;
  /** Where it landed in the workspace, once it has. */
  path?: string;
  /** The bytes that ride inside the message, for a picture. */
  image?: Attached;
  /** Still being read, or still on its way to the workspace. */
  pending?: boolean;
  /** The artifact this stands for, and the handle the sentence refers to it by. */
  artifact?: Artifact;
  handle?: string;
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

/**
 * What is being typed after a trigger character, if anything. The web's rule,
 * read at the caret rather than at the end of the draft: an `@` in the middle
 * of a sentence somebody went back to is a trigger too.
 */
export type Token = { kind: "@" | "/"; at: number; query: string; end: number };
export function triggerAt(draft: string, caret: number = draft.length): Token | undefined {
  const head = draft.slice(0, caret);
  const match = /(^|\s)([@/])([^\s]*)$/.exec(head);
  if (!match) return undefined;
  return { kind: match[2] as "@" | "/", at: match.index + match[1].length, query: match[3], end: caret };
}

/** One row of the list above the box. */
type Suggestion =
  | { kind: "command"; value: string; hint?: string }
  | { kind: "file"; value: string; hint?: string }
  | { kind: "artifact"; artifact: Artifact };
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
  const acp = session.agent === "KimiCode" || session.agent === "CursorAgent";
  /* Only for this agent's name. `ClaudeCode` is how it is stored and sent;
     `Claude Code` is what this install calls it, and the menu is a place a
     person reads. */
  const agents = useAgents();
  const controls = useSessionControls(session.id, { query: { refetchInterval: acp ? 2000 : false } });

  // What a session can be asked to change is not known when it opens: an
  // agent that lists its own models answers a moment later. Saying which model
  // it is running is that moment, so it is the signal to ask again.
  const model = conversation.model;
  const askAgain = controls.refetch;
  useEffect(() => {
    askAgain();
  }, [model, askAgain]);

  const [text, setText] = useState(() => takeDraft(session.id) ?? "");
  /* Which skills this session is reading. The chip is an indicator and the
     modal is the control; the count is read from the server rather than kept
     here, so two windows on one session agree. */
  const [picking, setPicking] = useState(false);
  const skills = useSessionSkillIds(session.id);
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
     them at startup; `@` offers the artifacts this person can reach and then
     files off the worker, one directory at a time, relative to the workspace
     root. Commands and files are the web build's affordances; artifacts are
     `~/mentions`. The list is read at the caret, and Escape closes it until
     the next trigger — `dismissed` remembers which one was waved away. */
  const [caret, setCaret] = useState(0);
  const token = triggerAt(text, caret);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const at = token?.at;
  useEffect(() => {
    if (at === undefined) setDismissed(null);
  }, [at]);
  const open = token !== undefined && dismissed !== token.at;
  /* Where the caret belongs once the draft has been rewritten under it: a
     pick replaces the token with a handle, and the caret goes just after that
     rather than to the end of whatever sentence followed. Applied once the
     new text is drawn, because the box cannot be told before. */
  const wantCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (wantCaret.current === null || !el) return;
    const pos = wantCaret.current;
    wantCaret.current = null;
    el.setSelectionRange(pos, pos);
    setCaret(pos);
  }, [text]);

  /* What `Posters` keeps warm for every screen; no interval of its own. */
  const library = useListArtifacts();
  const wantFiles = open && token?.kind === "@";
  const listing = useListFiles(session.id, { path: directoryOf(token?.query ?? "") }, { query: { enabled: !!wantFiles, staleTime: 30_000 } });
  const [pick, setPick] = useState(0);

  const commands: Suggestion[] =
    open && token?.kind === "/"
      ? conversation.commands
          .filter((c) => c.name.toLowerCase().startsWith(token.query.toLowerCase()))
          .slice(0, MOST_ROWS)
          .map((c) => ({ kind: "command", value: `/${c.name}`, hint: c.description ?? undefined }))
      : [];
  const artifacts = open && token?.kind === "@" ? rankArtifacts(library.data ?? [], token.query, session.id) : [];
  const files: Suggestion[] =
    open && token?.kind === "@"
      ? ((listing.data ?? []) as { name: string; directory: boolean }[])
          .filter((f) => f.name.toLowerCase().startsWith((token.query.split("/").pop() ?? "").toLowerCase()))
          .map((f) => {
            const dir = directoryOf(token.query);
            const full = (dir ? `${dir}/` : "") + f.name + (f.directory ? "/" : "");
            return { kind: "file", value: `@${full}`, hint: f.directory ? "directory" : undefined };
          })
      : [];
  /* Eight rows in all, as the `/` list has always had: up to five artifacts,
     and the files fill what is left. */
  const shownArtifacts = artifacts.slice(0, MOST_ARTIFACTS);
  const shownFiles = files.slice(0, MOST_ROWS - shownArtifacts.length);
  const suggestions: Suggestion[] =
    token?.kind === "/" ? commands : [...shownArtifacts.map((artifact): Suggestion => ({ kind: "artifact", artifact })), ...shownFiles];
  /* An empty library is said once, so the feature can be found at all; the
     line goes as soon as a query is typed. */
  const libraryEmpty = library.isSuccess && (library.data?.length ?? 0) === 0;
  const panel = open && token !== undefined && (token.kind === "/" ? suggestions.length > 0 : suggestions.length > 0 || token.query !== "" || libraryEmpty);
  useEffect(() => setPick(0), [token?.query, token?.kind]);

  const mentioned = () => chips.flatMap((c) => (c.artifact && c.handle ? [{ artifact: c.artifact, handle: c.handle }] : []));

  /* A pick rewrites the token in place. A file or a command becomes its own
     text, as before. An artifact becomes a handle in the sentence and a chip
     in the row above it, and its page starts its way into the workspace. */
  const accept = (chosen: Suggestion) => {
    if (!token) return;
    const before = text.slice(0, token.at);
    const after = text.slice(token.end);
    const inserted =
      chosen.kind === "artifact"
        ? `@${handleFor(chosen.artifact, mentioned())} `
        : `${chosen.value}${chosen.value.endsWith("/") ? "" : " "}`;
    setText(`${before}${inserted}${after}`);
    wantCaret.current = before.length + inserted.length;
    box.current?.focus();
    if (chosen.kind === "artifact") void mention(chosen.artifact, inserted.trim().slice(1));
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

  /* The chip appears before the page has landed, like a dropped file's, and
     settles with where it went. A refusal — the host unreachable, the artifact
     gone since the list was drawn — takes the chip and its handle back and
     says so on the line the composer already has for that. */
  const mention = async (artifact: Artifact, handle: string) => {
    if (chips.some((c) => c.artifact?.id === artifact.id)) return;
    const chip: Chip = { id: nextId.current++, name: artifact.title, kind: "artifact", size: `v${artifact.version}`, pending: true, artifact, handle };
    held.current += 1;
    setChips((all) => [...all, chip]);
    try {
      const placed = await mentionArtifact(session.id, { artifactId: artifact.id });
      settle(chip.id, { path: placed.path });
    } catch (e) {
      forget(chip.id);
      setText((was) => withoutHandle(was, handle));
      setRefused(`${artifact.title} could not be put in the workspace. ${why(e)}`.trim());
    }
  };

  /* Removing the chip removes the handle: the chip is the attachment, and a
     handle left behind would read as a reference the agent cannot follow. */
  const drop = (c: Chip) => {
    forget(c.id);
    const handle = c.handle;
    if (handle) setText((was) => withoutHandle(was, handle));
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
    const named = chips.filter((c) => c.kind === "file" && c.path).map((c) => c.path).join("\n");
    /* A mention is an attachment too, named under the message — with the
       title, the version and where it came from, which a bare path would not
       say. The handle in the sentence is what each line resolves. */
    const mentions: Mention[] = chips.flatMap((c) =>
      c.kind === "artifact" && c.artifact && c.handle && c.path ? [{ handle: c.handle, artifact: c.artifact, path: c.path }] : [],
    );
    const message = [said.trim(), named, mentionBlock(mentions, session.id)].filter(Boolean).join("\n\n");
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
    if (acp) {
      if (choose.isPending) return;
      setRefused(null);
      choose.mutate({ id: session.id, data: { kind, value } }, {
        onError: (e) => setRefused(`The setting could not be confirmed. ${e instanceof Error ? e.message : ""}`.trim()),
        onSettled: () => controls.refetch(),
      });
      return;
    }
    if (kind === "model" || kind === "mode" || kind === "effort") onRemember(kind, value);
    setChosen((was) => ({ ...was, [kind]: value }));
    choose.mutate({ id: session.id, data: { kind, value } }, { onSuccess: () => controls.refetch() });
  };

  const offered: Control[] = controls.data ?? [];
  /* What a picker shows. `chosen` is the optimistic note of what was just
     clicked and an ACP session ignores it — `current` is what the agent has
     actually confirmed, and until that arrives the label must not claim a
     value that may yet be refused. The conversation's own model and mode are
     the last resort, for a control the agent has not reported on yet. */
  const shown = (c: Control) =>
    (acp ? c.current : chosen[c.kind] ?? c.current) ??
    (c.kind === "model" ? conversation.model : c.kind === "mode" ? conversation.mode : undefined) ??
    undefined;
  const usage = conversation.usage;
  const full = usage?.contextUsed && usage?.contextWindow ? usage.contextUsed / usage.contextWindow : null;

  return (
    <div className="shrink-0 px-8 pb-6">
      <div className="mx-auto w-full max-w-[46rem]">
        <AccountNotice />
        {voice.blocked && (
          <VoiceDialog blocked={voice.blocked} onDismiss={voice.dismiss} onConfigure={voice.configure} />
        )}
        {picking && <SkillPicker session={session} onClose={() => setPicking(false)} />}
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
                  <span className={`relative grid h-7 shrink-0 place-items-center overflow-hidden rounded bg-ground text-mute ${c.kind === "artifact" ? "w-11" : "w-7"}`}>
                    {c.artifact && (
                      /* The picture the library draws, dimmed the way a
                         thumbnail is while its bytes are on their way. */
                      <ArtifactShot artifact={c.artifact} framed={false} className={c.pending ? "opacity-30" : ""} />
                    )}
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
                      !c.url && !c.artifact && <FileText className="h-3.5 w-3.5" strokeWidth={1.75} />
                    )}
                  </span>
                  {/* The name, not the path. Every attachment lands in the same
                      directory, so a truncated path makes eight files read as
                      eight identical chips — and the path is spelled out in the
                      message itself the moment this is sent. */}
                  <span
                    title={c.path ?? c.name}
                    className={`max-w-[11rem] truncate text-meta ${c.kind === "artifact" ? "" : "font-mono"} ${c.pending ? "text-mute" : "text-text"}`}
                  >
                    {c.name}
                  </span>
                  <span className={`text-micro text-mute ${c.kind === "artifact" ? "font-mono" : ""}`}>{c.size}</span>
                  <button onClick={() => drop(c)} aria-label={`Remove ${c.name}`} className="grid h-5 w-5 place-items-center rounded text-mute hover:bg-overlay hover:text-bone">
                    <X className="h-3 w-3" strokeWidth={2} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Docked above the box rather than floated at the caret: the card
              grows upward, the way the model menu opens upward, and there is
              nothing to clip or to position. Two sections for `@`, each gone
              when empty, so a workspace with no artifacts sees the list it
              always had. */}
          {panel && token && (
            <div id="composer-suggestions" role="listbox" aria-label={token.kind === "@" ? "Artifacts and files to mention" : "Commands"} className="mx-3 mt-3 overflow-hidden rounded-lg border border-line bg-overlay">
              {token.kind === "/" ? (
                suggestions.map(
                  (sug, n) =>
                    sug.kind !== "artifact" && (
                      <Option key={sug.value} n={n} on={n === pick} onHover={() => setPick(n)} onPick={() => accept(sug)}>
                        <span className={`font-mono text-ui ${n === pick ? "text-bone" : "text-text"}`}>{sug.value}</span>
                        {sug.hint && <span className="truncate text-meta text-mute">{sug.hint}</span>}
                      </Option>
                    ),
                )
              ) : (
                <>
                  {(shownArtifacts.length > 0 || (token.query === "" && libraryEmpty)) && <Heading title="Artifacts" count={artifacts.length} />}
                  {token.query === "" && libraryEmpty && (
                    <p className="px-2.5 pb-2 text-meta text-mute">No artifacts yet. Ask an agent to make one and it will be listed here.</p>
                  )}
                  {shownArtifacts.map((a, n) => {
                    const here = a.fromSessionId === session.id;
                    return (
                      <Option key={a.id} n={n} on={n === pick} onHover={() => setPick(n)} onPick={() => accept({ kind: "artifact", artifact: a })}>
                        <span className="block w-9 shrink-0">
                          <ArtifactShot artifact={a} />
                        </span>
                        <span className={`truncate text-ui ${n === pick ? "text-bone" : "text-text"}`}>{a.title}</span>
                        <span className="shrink-0 font-mono text-micro text-mute">v{a.version}</span>
                        <span className={`truncate text-meta ${here ? "text-dim" : "text-mute"}`}>{originOf(a, session.id).label}</span>
                        <span className="ml-auto shrink-0 text-micro text-mute">{elapsed(minutesSince(a.updatedAt))}</span>
                      </Option>
                    );
                  })}
                  {artifacts.length > shownArtifacts.length && <More n={artifacts.length - shownArtifacts.length} />}
                  {shownFiles.length > 0 && <Heading title="Files" count={files.length} />}
                  {shownFiles.map((sug, i) => {
                    const n = shownArtifacts.length + i;
                    return (
                      sug.kind === "file" && (
                        <Option key={sug.value} n={n} on={n === pick} onHover={() => setPick(n)} onPick={() => accept(sug)}>
                          <span className={`font-mono text-ui ${n === pick ? "text-bone" : "text-text"}`}>{sug.value}</span>
                          {sug.hint && <span className="truncate text-meta text-mute">{sug.hint}</span>}
                        </Option>
                      )
                    );
                  })}
                  {files.length > shownFiles.length && <More n={files.length - shownFiles.length} />}
                  {suggestions.length === 0 && token.query !== "" && (
                    <p className="px-2.5 py-2 text-meta text-mute">Nothing called “{token.query}” — not an artifact, not a file.</p>
                  )}
                  {/* The keys where they are used, which is the desk's rule. */}
                  <div className="flex items-center gap-3 border-t border-line-soft px-2.5 py-1.5 text-micro text-mute">
                    <span className="flex items-center gap-1">
                      <span className="keycap">↑</span>
                      <span className="keycap">↓</span> move
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="keycap">⏎</span> mention
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="keycap">esc</span> leave it
                    </span>
                  </div>
                </>
              )}
            </div>
          )}

          <textarea
            ref={box}
            rows={1}
            value={text}
            disabled={disabled}
            aria-autocomplete="list"
            aria-expanded={panel}
            aria-controls={panel ? "composer-suggestions" : undefined}
            aria-activedescendant={panel && suggestions.length > 0 ? `composer-option-${pick}` : undefined}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
            onChange={(e) => {
              setCaret(e.target.selectionStart ?? e.target.value.length);
              voice.typed(e.target.value);
            }}
            onPaste={(e) => e.clipboardData.files.length && take(e.clipboardData.files)}
            onKeyDown={(e) => {
              if (panel && suggestions.length > 0) {
                if (e.key === "ArrowDown") { e.preventDefault(); setPick((n) => Math.min(n + 1, suggestions.length - 1)); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setPick((n) => Math.max(n - 1, 0)); return; }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); accept(suggestions[pick]); return; }
              }
              /* Leaves the sentence exactly as typed and stays away until the
                 next trigger — not the trailing space this used to add, which
                 was a visible edit to somebody's words. */
              if (panel && e.key === "Escape") { e.preventDefault(); setDismissed(token?.at ?? null); return; }
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

          {/* The controls wrap; send does not.
              Labels come from whichever agent this is and some are long —
              `Workspace + network`, `gpt-6.1-sol`. They used to wrap *inside* a
              fixed-height control, which put two lines of text in a 28px box
              and read as overlapping junk. Each control is one line now
              (`.control` says so), and when they no longer fit they move onto
              a second line whole, which is the one way this degrades without
              anything becoming unreadable.

              Squeezing them instead was tried and is worse: four controls
              sharing a narrow column shrink to `G…`, `Ask …` and an Effort
              button with no word in it at all. */}
          <div className="flex items-start gap-1.5 px-2.5 pb-2.5">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <label className="control shrink-0 cursor-pointer text-mute hover:bg-raise hover:text-bone" title="Attach a file or an image">
              <Paperclip className="h-4 w-4" strokeWidth={1.75} />
              <input type="file" multiple className="hidden" onChange={(e) => take(e.target.files)} />
            </label>

            {voice.possible && <Mic state={voice.state} onStart={voice.start} onStop={voice.stop} />}

            {/* Beside the model and the mode, because all three decide how the
                next turn is answered. Not ember: ember means an agent is
                waiting on somebody, and this is not that. */}
            <button
              onClick={() => setPicking(true)}
              title={
                fromDefaults(skills.data, skills.repos, skills.alwaysOn)
                  ? `Which skills this agent is reading: your ${fromDefaults(skills.data, skills.repos, skills.alwaysOn)}`
                  : "Which skills this agent is reading"
              }
              className="control shrink-0 gap-1.5 text-mute hover:bg-raise hover:text-bone"
            >
              <Diamond className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="tabular-nums">{skills.data.length}</span>
              <span>{skills.data.length === 1 ? "skill" : "skills"}</span>
            </button>

            <AgentPicker
              agent={session.agent}
              agentLabel={agents.data.find((a) => a.kind === session.agent)?.label}
              controls={offered}
              valueOf={shown}
              disabled={acp && choose.isPending}
              onPick={set}
            />

            {full !== null && (
              <span className="control shrink-0 gap-2 text-mute" title={`${Math.round(full * 100)}% of the context window used`}>
                <span className="h-1 w-14 overflow-hidden rounded-full bg-ground">
                  <span className={`block h-full rounded-full ${full > 0.75 ? "bg-ember" : "bg-slate"}`} style={{ width: `${Math.min(100, full * 100)}%` }} />
                </span>
                <span className="text-micro tabular-nums">{Math.round(full * 100)}%</span>
              </span>
            )}

            </div>

            {/* `interruptible`, not `working`: a subagent the turn left
                running keeps the session working, but an interrupt cannot
                reach it — so the button would report success and do nothing. */}
            {interruptible(conversation) ? (
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
                title={busy ? (chips.some((c) => c.pending && c.kind === "artifact") ? "Waiting for the artifact" : "Waiting for the files") : "Send"}
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


/**
 * One row of the list. Picking is on mouse down, with the default prevented,
 * so the box keeps the focus and the caret; hovering moves the highlight the
 * way the arrow keys do.
 */
function Option({ n, on, onHover, onPick, children }: { n: number; on: boolean; onHover: () => void; onPick: () => void; children: ReactNode }) {
  return (
    <button
      id={`composer-option-${n}`}
      role="option"
      aria-selected={on}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      data-on={on}
      className="row w-full rounded-none"
    >
      {children}
    </button>
  );
}

function Heading({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-baseline gap-1.5 px-2.5 pt-2 pb-0.5 text-micro">
      <span className="text-dim">{title}</span>
      <span className="tabular-nums text-mute">{count}</span>
    </div>
  );
}

function More({ n }: { n: number }) {
  return <p className="px-2.5 pb-1.5 text-meta text-mute">{n} more — keep typing</p>;
}

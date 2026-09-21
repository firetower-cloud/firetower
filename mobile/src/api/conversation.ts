/**
 * The conversation, folded into something drawable.
 *
 * The control plane sends lifecycle events — this item started, this text
 * arrived, this one finished — because that is what a stream can carry. A
 * screen wants the opposite: a list of things, each complete. This is the fold
 * between them, and it lives apart from the component so that what the events
 * mean is testable without rendering anything.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useSocket } from "./socket";
import { currentBackend } from "~/client/http";
import { getConversation } from "./generated/sessions/sessions";
import type {
  Attached,
  ConversationEvent,
  ItemKind,
  ItemStatus,
  PlanStep,
  Question,
  RequestKind,
  SlashCommand,
  Usage,
} from "./generated/model";

/** One subagent, and what it has been up to. */
export type Task = {
  id: string;
  /**
   * The tool call that spawned it.
   *
   * The link between the two halves: the agent asks for a subagent (a tool
   * call, with its own id) and the runtime reports one starting (a task, with
   * a different id). Only this field says they are the same thing.
   */
  item: string;
  description: string;
  /** Which kind of subagent, when the agent says. */
  agent?: string;
  status?: ItemStatus;
  /** The last thing it reported doing. */
  progress?: string;
  /** What it came back with. */
  summary?: string;
};

/**
 * A question the agent wants answered before it goes on.
 *
 * Not the same as an approval, even though both arrive the same way. One asks
 * whether something may happen; this asks which of several things should.
 */
export type Questionnaire = {
  req: string;
  questions: Question[];
};

/** Something the agent has stopped for and will not continue without. */
export type Asked = {
  req: string;
  kind: RequestKind;
  /** The tool's name — what it is, in one word. */
  detail: string;
  /** Everything it was given, for a card that shows the command or the path. */
  args: unknown;
};

/** One thing in the transcript, as the screen needs it. */
export type Item = {
  id: string;
  kind: ItemKind;
  title?: string;
  status?: ItemStatus;
  /** Which subagent owns this, when the main thread doesn't. */
  task?: string;
  /** What the agent said, or thought. */
  text: string;
  /** What a tool printed. */
  output: string;
  /** A tool's arguments, once they parse. */
  input?: unknown;
  /** Pictures sent with a message, when there were any. */
  images?: Attached[];
};

/** What the account's limits allow, as far as the agent has said. */
export type Limits = {
  /** `five_hour`, and whatever else turns up. */
  window: string;
  /** `allowed`, and whatever else turns up. */
  status: string;
  /** Unix seconds, when the agent gives one. */
  resetsAt: number | null;
};

export type Conversation = {
  items: Item[];
  plan: PlanStep[];
  /**
   * What the agent is blocked on, if anything.
   *
   * Kept apart from the transcript because it is not something that happened —
   * it is something waiting to. It sits above the composer, where the answer
   * goes.
   */
  asked: Asked[];
  /**
   * Work handed to subagents, in the order it was handed over.
   *
   * Apart from the transcript because it is a different voice. Interleaved,
   * several subagents narrate over each other and it reads as though the agent
   * you are talking to did all of it.
   */
  tasks: Task[];
  /** Questions waiting on an answer. */
  questions: Questionnaire[];
  /** True between a turn starting and finishing — the agent is busy. */
  working: boolean;
  /**
   * Somebody pressed stop, and the turn they pressed it on has not ended yet.
   *
   * Remembered here rather than in the composer because it is a fact about the
   * turn, and the turn ends here. It is also the only thing that can tell the
   * two endings apart: an interrupted turn comes back from the agent as a
   * failure, indistinguishable by reading it from one that broke — which is
   * why a turn somebody stopped on purpose used to be reported as "the agent
   * stopped without saying why". The control plane keeps the same flag for the
   * same reason; see `Progress::stopped`.
   */
  stopping?: boolean;
  /**
   * Why the last turn ended badly, in the agent's own words.
   *
   * Distinct from `trouble`, which is this end losing the stream. This is the
   * far end saying it will not go on: a failed turn used to leave nothing
   * behind but `working: false`, so a run that stopped because the account was
   * out of credits looked exactly like one that had finished — and, nothing
   * having been said, like an agent that had died. Cleared when a turn starts.
   */
  stopped?: string;
  /** The model this session is running, once it has said. */
  model?: string;
  /**
   * What the agent may do without asking.
   *
   * Restated at the start of every turn, so a control showing this is showing
   * what is in force rather than what was last asked for.
   */
  mode?: string;
  /**
   * How hard it has been told to think.
   *
   * Remembered rather than reported: the agent does not restate it, so this is
   * only what was chosen in this browser. Absent means nobody has chosen, which
   * a control should say by staying quiet rather than claiming a default.
   */
  effort?: string;
  /**
   * The commands this install offers, as the agent reported them at startup.
   *
   * Whatever that machine actually has, rather than a list kept in step by
   * hand.
   */
  commands: SlashCommand[];
  /**
   * What the last finished turn cost, and how full the context got.
   *
   * From the turn rather than accumulated here: the agent reports the state of
   * its own window, and adding up deltas would drift.
   */
  usage?: Usage;
  /**
   * What the account's own limits say, as of the last time the agent mentioned
   * them.
   *
   * Thin on purpose: a window, whether we are inside it, and when it starts
   * again. The agent reports no proportion, so nothing here can draw one.
   */
  limits?: Limits;
  /** How far we have read. The resume cursor. */
  lastLine: number;
  /**
   * When the agent last said anything, as a local clock reading.
   *
   * An agent heads-down in a ten-minute command looks exactly like a dead one:
   * a spinner that has been spinning since you got here, and no way to tell
   * whether it is thinking or gone. This is what lets the screen say "still
   * going, last heard 8s ago" rather than leaving somebody to guess.
   */
  heardAt?: number;
  /** Set when the stream could not be opened or fell over. */
  trouble?: string;
  /**
   * Whether the first read has come back.
   *
   * An empty transcript means two different things and a screen cannot tell
   * them apart without this: a session nobody has spoken to yet, and one whose
   * snapshot is still crossing the wire. Drawing the first while waiting on
   * the second is how "Nothing has been said yet." came to sit on top of a
   * conversation that was merely large — an assertion, made before there was
   * anything to assert it from.
   *
   * Set once the snapshot resolves *or* fails, because the fallback is to
   * replay off the stream and a screen that waits for certainty would wait for
   * ever.
   */
  arrived?: boolean;
  /**
   * How many events could not be folded. See `foldAll`.
   *
   * Kept so the screen can say so. A transcript that quietly stops is the
   * worst of the three possible outcomes — worse than an error, and much
   * worse than a gap that admits it is one.
   */
  skipped?: number;
};

/**
 * Marks a message that has been typed but has not been anywhere yet.
 *
 * The agent echoes every turn back, so these are always temporary — see
 * `ItemStarted`, which is where one gets replaced by the real thing.
 */
const TYPED = "typed-";

export const nothing: Conversation = {
  items: [],
  plan: [],
  asked: [],
  tasks: [],
  questions: [],
  commands: [],
  working: false,
  lastLine: 0,
};

/**
 * Apply one event.
 *
 * Returns a new conversation rather than mutating, because React decides
 * whether to redraw by identity. Kept pure and exported so the interesting
 * part — what an event does to the screen — can be tested directly.
 */
export function apply(state: Conversation, event: ConversationEvent): Conversation {
  const lastLine = Math.max(state.lastLine, event.lineNo);
  // Every event here came off the agent's stream, so any of them is proof it
  // is still there. Set before the switch so no branch can forget it.
  state = { ...state, heardAt: Date.now() };
  const items = state.items;

  /** Replace one item in place, leaving the rest alone. */
  const change = (id: string, how: (item: Item) => Item): Conversation => {
    const at = items.findIndex((i) => i.id === id);
    // An item we never saw start. Ordinary on a reconnect that resumed past
    // it, and not worth inventing a card for.
    if (at < 0) return { ...state, lastLine };
    const next = items.slice();
    next[at] = how(next[at]);
    return { ...state, items: next, lastLine };
  };

  switch (event.type) {
    case "SessionConfigured":
      // Sent again at the start of every turn, so this must not reset
      // anything — it is a restatement, not a new session. And one that says
      // only what changed — the mode, the moment somebody changed it — must
      // not blank out the rest.
      return {
        ...state,
        model: event.model || state.model,
        mode: event.mode || state.mode,
        commands: event.commands.length ? event.commands : state.commands,
        lastLine,
      };

    case "TurnStarted":
      return { ...state, working: true, stopped: undefined, stopping: false, lastLine };

    case "TurnCompleted":
      return {
        ...state,
        working: false,
        stopping: false,
        // Kept when a turn ends without saying, so the meter does not blank
        // between turns.
        usage: event.usage ?? state.usage,
        // Only what the agent actually said. A failed turn with nothing to say
        // still gets a line, because "it stopped and would not say why" is
        // itself worth showing rather than leaving as silence.
        //
        // Unless we are the reason it stopped, which is not trouble and does
        // not need explaining — the agent reports an interrupted turn as a
        // failure either way.
        stopped:
          event.status === "Completed" || state.stopping
            ? undefined
            : (event.detail ??
              (event.status === "Failed"
                ? "The agent stopped without saying why."
                : undefined)),
        lastLine,
      };

    case "ItemStarted": {
      // Already here. A stream that reconnects replays, and folding the same
      // line twice must not draw the same thing twice — React keys on these
      // ids, so a duplicate is a visible fault rather than a harmless one.
      //
      // Emptied rather than left alone, because `ContentDelta` appends: an item
      // whose start is being replayed is about to have every one of its deltas
      // replayed too, and keeping the old text would give it the same sentence
      // twice. A resume that begins *after* the start does not come through
      // here at all — its deltas land on what is already drawn, which is the
      // other half of the same rule.
      if (items.some((i) => i.id === event.item))
        return change(event.item, (item) => ({ ...item, text: "", output: "" }));

      // A message somebody typed is shown before it has been anywhere, so the
      // composer feels immediate. The agent echoes it back a moment later —
      // that copy is the real one, and it replaces the placeholder rather than
      // appearing beneath it.
      const typed =
        event.kind === "UserMessage"
          ? [...items].reverse().find((i) => i.id.startsWith(TYPED))
          : undefined;
      const settled =
        event.kind === "UserMessage" ? items.filter((i) => !i.id.startsWith(TYPED)) : items;

      return {
        ...state,
        lastLine,
        items: [
          ...settled,
          {
            id: event.item,
            kind: event.kind,
            title: event.title ?? undefined,
            task: event.task ?? undefined,
            text: "",
            output: "",
            // The item start arrives before its input, which is where the
            // server puts images. Keep the optimistic copy through that one
            // event gap so its thumbnail does not flash away on send.
            images: typed?.images,
          },
        ],
      };
    }

    case "ItemUpdated":
      return change(event.item, (item) => {
        // A message carries pictures; a tool call carries arguments. Both
        // arrive the same way, because both are "what came with this item".
        const carried = (event.data as { images?: Attached[] } | undefined)?.images;
        return carried
          ? {
              ...item,
              // The first copy may be the optimistic one moved over in
              // `ItemStarted`; the server then confirms the same images.
              images: sameImages(item.images, carried)
                ? item.images
                : [...(item.images ?? []), ...carried],
            }
          : { ...item, input: event.data };
      });

    case "ItemCompleted":
      return change(event.item, (item) => ({ ...item, status: event.status }));

    case "ContentDelta":
      return change(event.item, (item) =>
        event.stream === "ToolOutput"
          ? { ...item, output: item.output + event.delta }
          : event.stream === "ToolInput"
            ? item // arrives as JSON fragments; the parsed copy comes via ItemUpdated
            : { ...item, text: item.text + event.delta },
      );

    case "PlanUpdated":
      return { ...state, plan: event.steps, lastLine };

    case "Limited":
      return {
        ...state,
        working: ["rejected", "blocked"].includes(event.status) ? false : state.working,
        limits: { window: event.window, status: event.status, resetsAt: event.resetsAt ?? null },
        lastLine,
      };

    case "RequestOpened":
      // Re-sent whenever a watcher attaches, so the same question can arrive
      // more than once — a reload must not stack up three copies of one card.
      return state.asked.some((a) => a.req === event.req)
        ? { ...state, lastLine }
        : {
            ...state,
            lastLine,
            asked: [
              ...state.asked,
              {
                req: event.req,
                kind: event.kind,
                detail: event.detail,
                args: event.args,
              },
            ],
          };

    case "TaskStarted":
      return state.tasks.some((t) => t.id === event.task)
        ? { ...state, lastLine }
        : {
            ...state,
            lastLine,
            tasks: [
              ...state.tasks,
              {
                id: event.task,
                item: event.item,
                description: event.description,
                agent: event.agent ?? undefined,
              },
            ],
          };

    case "TaskProgress":
      return {
        ...state,
        lastLine,
        tasks: state.tasks.map((t) =>
          t.id === event.task ? { ...t, progress: event.detail } : t,
        ),
      };

    case "TaskCompleted":
      return {
        ...state,
        lastLine,
        tasks: state.tasks.map((t) =>
          t.id === event.task
            ? { ...t, status: event.status, summary: event.summary ?? undefined }
            : t,
        ),
      };

    case "UserInputRequested":
      // Re-sent whenever a watcher attaches, like an approval.
      return state.questions.some((q) => q.req === event.req)
        ? { ...state, lastLine }
        : {
            ...state,
            lastLine,
            questions: [
              ...state.questions,
              { req: event.req, questions: event.questions },
            ],
          };

    case "UserInputResolved":
      return {
        ...state,
        lastLine,
        questions: state.questions.filter((q) => q.req !== event.req),
      };

    case "RequestResolved":
      return {
        ...state,
        lastLine,
        asked: state.asked.filter((a) => a.req !== event.req),
      };

    default:
      // Everything else — subagent lifecycle, approvals, unnamed lines — is
      // carried but not drawn yet. Ignoring it must never lose the cursor.
      return { ...state, lastLine };
  }
}

/** Whether the server has confirmed the exact images already on the item. */
function sameImages(existing: Attached[] | undefined, received: Attached[]) {
  return (
    existing?.length === received.length &&
    existing.every(
      (image, at) =>
        image.mediaType === received[at].mediaType && image.data === received[at].data,
    )
  );
}

/* ---- where a conversation is kept ------------------------------------ */

/**
 * The conversations this window has read, and what is being done to them.
 *
 * Outside React on purpose. Held in the component that drew it, a transcript
 * died with the tab: opening a workspace, glancing at another and coming back
 * re-read the session from line one and re-folded it a token at a time, which
 * is watching the agent type the whole conversation again. There was no stale
 * cache to blame — there was no cache at all.
 *
 * Keyed by server *and* session, for the reason `backend.tsx` gives a
 * QueryClient per server: a session id is only unique within the Firetower that
 * minted it.
 */
type Held = {
  state: Conversation;
  /** Components drawing it, told when it changes. */
  watchers: Set<() => void>;
  /** Lines that arrived this frame and have not been folded in yet. */
  waiting: ConversationEvent[];
  /** The fold that is already scheduled, if there is one. */
  soon: number;
  /** How many hooks want this followed, and how to stop following it. */
  readers: number;
  stop?: () => void;
};

const held = new Map<string, Held>();

/**
 * How many conversations to keep once nothing is drawing them.
 *
 * Enough that moving between the workspaces somebody actually has open is
 * free, small enough that a long day of them is not a leak. Anything evicted
 * costs one request to read again, not a re-stream.
 */
const KEEP = 12;

/* A frame clock where there is one. Under a test runner there is not, and the
   point here is coalescing rather than the clock itself. */
const nextFrame: (fn: () => void) => number =
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 0) as unknown as number;
const dropFrame: (id: number) => void =
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;

function entry(key: string): Held {
  let it = held.get(key);
  if (!it) {
    it = { state: nothing, watchers: new Set(), waiting: [], soon: 0, readers: 0 };
    held.set(key, it);
  }
  return it;
}

function read(key: string): Conversation {
  return held.get(key)?.state ?? nothing;
}

/** Replace a conversation and redraw whatever is showing it. */
function put(key: string, next: Conversation) {
  const it = entry(key);
  it.state = next;
  // Re-inserted so the map reads least-recently-changed first, which is the
  // order `sweep` evicts in.
  held.delete(key);
  held.set(key, it);
  for (const watcher of it.watchers) watcher();
}

/**
 * Fold everything that has arrived since the last frame, in one go.
 *
 * The socket delivers each line as its own message, and every message is its
 * own task — so React's automatic batching, which works within a task, never
 * saw two of them together. One render per line meant one render per token on
 * anything with a backlog. Coalescing to a frame keeps live typing at the
 * refresh rate and makes a replay a paint rather than a performance.
 */
/**
 * Fold a run of events, surviving one that cannot be folded.
 *
 * `events.reduce(apply, state)` is the obvious way to write this and it has a
 * failure mode that is very hard to see: one event that throws takes the
 * whole batch with it. `drain` empties `waiting` *before* folding, so the
 * events are already gone; `put` never runs, so the state stays at the last
 * good value; nothing is logged where anybody would look. The transcript
 * stops dead at one line and every later line folds onto a conversation
 * missing its middle — which reads exactly like a large conversation that
 * failed to finish loading.
 *
 * One bad event should cost one event. The cursor still moves past it, or we
 * would ask the server for the same unreadable line for ever.
 */
export function foldAll(state: Conversation, events: ConversationEvent[]): Conversation {
  let next = state;
  for (const event of events) {
    try {
      next = apply(next, event);
    } catch (e) {
      console.warn("[firetower] could not fold a conversation event", event?.type, e);
      next = {
        ...next,
        lastLine: Math.max(next.lastLine, event?.lineNo ?? next.lastLine),
        skipped: (next.skipped ?? 0) + 1,
      };
    }
  }
  return next;
}

function drain(key: string) {
  const it = held.get(key);
  if (!it) return;
  if (it.soon) dropFrame(it.soon);
  it.soon = 0;
  if (!it.waiting.length) return;
  const arrived = it.waiting;
  it.waiting = [];
  put(key, foldAll(it.state, arrived));
}

/** Take a line, to be folded with whatever else lands in the same frame. */
function took(key: string, events: ConversationEvent[]) {
  const it = entry(key);
  it.waiting.push(...events);
  if (!it.soon) it.soon = nextFrame(() => drain(key));
}

/** Take a conversation out, and whatever was scheduled against it. */
function drop(key: string, it: Held) {
  if (it.soon) dropFrame(it.soon);
  it.stop?.();
  held.delete(key);
}

/** Forget the conversations nobody has looked at for longest. */
function sweep() {
  for (const [key, it] of held) {
    if (held.size <= KEEP) return;
    if (it.readers || it.watchers.size) continue;
    drop(key, it);
  }
}

/**
 * Drop everything belonging to one server.
 *
 * Called when a Firetower is disconnected, beside its QueryClient: a transcript
 * is the most private thing this window holds, and leaving it warm for a server
 * somebody has signed out of is not a cache, it is a copy.
 */
export function forgetConversations(backend: string) {
  for (const [key, it] of held) {
    if (key.startsWith(`${backend}:`)) drop(key, it);
  }
}

/**
 * Read a conversation, then keep reading it.
 *
 * ## The first paint is a request
 *
 * A session that has not been read yet is fetched whole, as one JSON document,
 * and folded in a single pass. The stream would have delivered exactly the same
 * events — but one frame at a time, in order, at the granularity the model
 * produced them, which a screen following the end of the transcript renders as
 * the conversation being typed out again from the top.
 *
 * Nothing is lost between the two. The subscription resumes at the snapshot's
 * own `lastLine`, and the control plane replays whatever the log has gained
 * since from the same table the snapshot came out of — so a line written
 * between the read and the subscribe arrives on the socket rather than falling
 * down the gap.
 *
 * ## And one follower, however many are watching
 *
 * The socket hands every frame to every listener on that subscription. Two
 * components on one conversation — the transcript and the port picker above it
 * — would each fold every delta into the same store, and `ContentDelta`
 * appends, so the agent would appear to say everything twice.
 */
function start(key: string, sessionId: string, follow: ReturnType<typeof useSocket>["follow"]) {
  let stop: (() => void) | undefined;
  let dropped = false;

  const listen = () => {
    if (dropped) return;
    stop = follow({
      topic: "conversation",
      id: sessionId,
      cursor: () => {
        // A line still waiting to be folded is one we have, and the server
        // must not send it again — `ContentDelta` appends, so a line replayed
        // is a sentence written twice.
        drain(key);
        return read(key).lastLine || undefined;
      },
      onFrame: (frame) => {
        if (frame.t === "error") {
          drain(key);
          put(key, { ...read(key), trouble: frame.message });
          return;
        }
        if (frame.t !== "line") return;
        took(key, frame.events as ConversationEvent[]);
      },
    });
  };

  if (read(key).lastLine > 0) {
    // Read once already, and still here. Pick up exactly where that left off.
    listen();
  } else {
    getConversation(sessionId)
      .then((snapshot) => {
        if (dropped) return;
        const folded = foldAll(read(key), snapshot.events as ConversationEvent[]);
        // The snapshot's own cursor, not the last line that drew something: a
        // log line can normalise to no events at all, and resuming from the
        // last *drawn* one would ask for those again on every open.
        put(key, { ...folded, lastLine: Math.max(folded.lastLine, snapshot.lastLine), arrived: true });
      })
      .catch((e) => {
        // Not fatal, and not worth a banner: the subscription below replays
        // from nothing, which is what this used to do every time.
        console.warn("[firetower] could not read the conversation, streaming it instead", e);
        // Streaming from nothing is still a conversation arriving, and a
        // screen left waiting on a promise that already rejected waits for
        // ever.
        if (!dropped) put(key, { ...read(key), arrived: true });
      })
      .finally(listen);
  }

  return () => {
    dropped = true;
    stop?.();
  };
}

/**
 * Follow a session's conversation.
 *
 * Took a `live` flag until the socket arrived: it decided whether to reopen the
 * stream after it closed, which mattered when this held a connection of its
 * own. Reconnection belongs to the socket now, and a session that has ended
 * still has a transcript worth reading, so there is nothing left for it to
 * decide.
 *
 * Holds no transcript of its own any more — see `held` above. Moving between
 * sessions is now a change of which key is read, so the previous conversation
 * is neither shown for a frame nor thrown away.
 */
export function useConversation(sessionId: string) {
  const { follow } = useSocket();
  // Read rather than subscribed to, as every generated request reads it: the
  // provider is keyed on the server, so changing one remounts this anyway.
  const key = `${currentBackend() ?? ""}:${sessionId}`;

  const state = useSyncExternalStore(
    useCallback(
      (fn: () => void) => {
        const it = entry(key);
        it.watchers.add(fn);
        return () => void it.watchers.delete(fn);
      },
      [key],
    ),
    useCallback(() => read(key), [key]),
  );

  useEffect(() => {
    const it = entry(key);
    it.readers += 1;
    if (it.readers === 1) it.stop = start(key, sessionId, follow);

    return () => {
      it.readers -= 1;
      if (it.readers > 0) return;
      it.stop?.();
      it.stop = undefined;
      // Whatever arrived in the last frame is part of what the cursor claims.
      drain(key);
      sweep();
    };
  }, [key, sessionId, follow]);

  /** Change what is held, with anything buffered folded in first. */
  const change = useCallback(
    (how: (current: Conversation) => Conversation) => {
      drain(key);
      put(key, how(read(key)));
    },
    [key],
  );

  /**
   * Show a setting as chosen before the agent confirms it.
   *
   * `init` restates the model and the mode, but only at the *start of the next
   * turn* — so without this a picker sits on the old value until somebody says
   * something else, which reads as the click not having worked.
   *
   * Overwritten by `init` when it arrives, so a request that was refused
   * corrects itself rather than lying indefinitely. Effort is never restated at
   * all, so for that this is the only record.
   */
  const remember = useCallback(
    (of: "model" | "mode" | "effort", value: string) => change((c) => ({ ...c, [of]: value })),
    [change],
  );

  /** Optimistically show what somebody just sent, before it comes back. */
  const echo = useCallback(
    (text: string, images: Attached[] = []) =>
      change((c) => ({
        ...c,
        working: true,
        items: [
          ...c.items,
          {
            id: `${TYPED}${Date.now()}`,
            kind: "UserMessage" as ItemKind,
            text,
            output: "",
            // Shown straight away, and replaced by the agent's echo of the same
            // message a moment later. Without this a picture vanishes between
            // pressing send and the round trip finishing.
            images,
          },
        ],
      })),
    [change],
  );

  /**
   * Note that stop has been pressed, before anything has come back.
   *
   * The button waits on the turn ending rather than on the request it sent,
   * because the request only says somebody was told.
   */
  const stopping = useCallback((asked: boolean) => change((c) => ({ ...c, stopping: asked })), [change]);

  /** Take a request off the screen the moment it is answered. */
  const settle = useCallback(
    (req: string) =>
      change((c) => ({
        ...c,
        asked: c.asked.filter((a) => a.req !== req),
        questions: c.questions.filter((q) => q.req !== req),
      })),
    [change],
  );

  return { conversation: state, echo, settle, remember, stopping };
}

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
  /**
   * True while the agent or anything it delegated to is busy.
   *
   * Not simply "a turn is open". A backgrounded subagent outlives the turn
   * that spawned it — the turn ends, and the agent is woken again when the
   * subagent reports — so clearing this on `TurnCompleted` left a session that
   * was still writing transcript looking finished, and took away the stop
   * button while work nobody could reach carried on. See `inTurn` for the
   * narrower fact.
   */
  working: boolean;
  /**
   * True between a turn starting and finishing, ignoring subagents.
   *
   * Kept apart from `working` because a subagent reporting has to know which
   * of the two it is ending: the session coming to rest, or one voice of
   * several going quiet while the agent is already off again.
   */
  inTurn?: boolean;
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
   * The oldest line this client has drawn, and the cursor for reading back.
   *
   * The other end of `lastLine`. A transcript now opens on its last several
   * exchanges rather than on all of them, so there are two edges to keep
   * rather than one: the end, where new lines arrive, and the beginning, which
   * moves backwards as somebody scrolls up.
   */
  firstLine: number;
  /**
   * Whether there is any conversation before `firstLine` left to read.
   *
   * False on a control plane too old to know about paging, because it sends
   * the whole conversation and says nothing about `hasMore` — which is exactly
   * right. There is nothing more to fetch, and the spinner never appears.
   */
  hasMore: boolean;
  /** A page of history is on its way. Draws the spinner above the transcript. */
  loadingOlder?: boolean;
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
  inTurn: false,
  lastLine: 0,
  firstLine: 0,
  hasMore: false,
};

/**
 * How many exchanges a read asks for, first and every time somebody scrolls
 * back.
 *
 * An exchange is one thing somebody said and everything the agent did about
 * it, so this is not twenty messages — it is twenty of them plus every tool
 * call between. Generous, because the desk has the memory and the network for
 * it and most sessions have fewer exchanges than this, in which case nothing
 * about this screen changes at all. The phone asks for far less; see
 * `mobile/src/api/conversation.ts`.
 */
const PAGE = 20;

/**
 * Apply one event.
 *
 * Returns a new conversation rather than mutating, because React decides
 * whether to redraw by identity. Kept pure and exported so the interesting
 * part — what an event does to the screen — can be tested directly.
 */
/**
 * Whether this subagent is still going.
 *
 * A task with no status has been started and has not reported. Named for what
 * it means rather than `!t.status`, because the same check decides three
 * things — the stop button, the working line, and whether the session is at
 * rest — and they must not drift apart.
 */
const adrift = (t: Task): boolean => t.status === undefined;

/**
 * What to call what is still running, once the turn itself has ended.
 *
 * A subagent's own progress line beats anything derived from the transcript
 * here: after the turn closes, the newest item is whatever the main agent did
 * last, and that is over. Shared by both clients so the two cannot drift into
 * describing the same state differently.
 */
export function delegating(tasks: Task[]): string {
  const running = tasks.filter(adrift);
  if (running.length > 1) return `${running.length} subagents working`;
  return running[0]?.progress ?? running[0]?.description ?? "A subagent is working";
}

/**
 * Whether the stop button has anything it can actually reach.
 *
 * Narrower than `working`, and deliberately. The control plane asks the agent
 * to interrupt only while a turn is open — `ClaudeNormaliser::working` is
 * `active_turn.is_some()`, and that is taken on the `result` line — so a
 * subagent the turn left running cannot be stopped from here. Offering the
 * button anyway would report success, send nothing, and leave a spinner up
 * until something unrelated cleared it.
 *
 * So: the session still reads as working, because it is, and the composer
 * stays honest about which half of that somebody can interrupt.
 */
export const interruptible = (c: Conversation): boolean => c.inTurn === true;

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
      return { ...state, working: true, inTurn: true, stopped: undefined, stopping: false, lastLine };

    case "TurnCompleted":
      return {
        ...state,
        // Only the turn ended. Anything it left running is still running, and
        // is still going to put more on this screen without being asked — so
        // the session is not back with you yet. A turn that *failed* or that
        // somebody stopped rests anyway: both are real endings, and both
        // report as `Failed`.
        working: event.status === "Completed" && state.tasks.some(adrift),
        inTurn: false,
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

    case "TaskCompleted": {
      const tasks = state.tasks.map((t) =>
        t.id === event.task
          ? { ...t, status: event.status, summary: event.summary ?? undefined }
          : t,
      );
      return {
        ...state,
        lastLine,
        tasks,
        // The turn may have ended a while ago and left this running. If it is
        // the last one, this is the moment the session actually stopped.
        //
        // `state.working &&` so a session that already came to rest — a turn
        // that failed, or one somebody stopped, with work still in flight —
        // cannot be talked back into looking busy by a straggler reporting.
        working: state.working && (state.inTurn === true || tasks.some(adrift)),
      };
    }

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
function drain(key: string) {
  const it = held.get(key);
  if (!it) return;
  if (it.soon) dropFrame(it.soon);
  it.soon = 0;
  if (!it.waiting.length) return;
  const arrived = it.waiting;
  it.waiting = [];
  put(key, arrived.reduce(apply, it.state));
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
    getConversation(sessionId, { tail: PAGE })
      .then((snapshot) => {
        if (dropped) return;
        const folded = (snapshot.events as ConversationEvent[]).reduce(apply, read(key));
        // The snapshot's own cursor, not the last line that drew something: a
        // log line can normalise to no events at all, and resuming from the
        // last *drawn* one would ask for those again on every open.
        put(key, {
          ...folded,
          lastLine: Math.max(folded.lastLine, snapshot.lastLine),
          firstLine: snapshot.firstLine ?? 0,
          hasMore: snapshot.hasMore ?? false,
        });
      })
      .catch((e) => {
        // Not fatal, and not worth a banner: the subscription below replays
        // from nothing, which is what this used to do every time.
        console.warn("[firetower] could not read the conversation, streaming it instead", e);
      })
      .finally(listen);
  }

  return () => {
    dropped = true;
    stop?.();
  };
}

/** A page of history, as the control plane sends it. */
type Page = {
  events: ConversationEvent[];
  /** Absent on a control plane too old to page, which sent everything. */
  firstLine?: number;
  hasMore?: boolean;
};

/**
 * Put a page of history on the front of a conversation.
 *
 * ## Why an old page is folded on its own
 *
 * Into an empty conversation, and only the `items` come out of the result. A
 * page of history describes the session *as it was* — the plan it had then,
 * the model it was running, whether a turn was in flight — and folding it onto
 * the held state would restate every one of those as though they were now.
 * Scrolling up would set the composer working on a turn that finished last
 * Tuesday. The transcript is the only part of an old page that is still true,
 * so it is the only part kept.
 *
 * `lastLine` is untouched for the same reason, and it matters more than the
 * rest: it is the socket's resume cursor. Moving it backwards would ask the
 * control plane to replay everything since, and `ContentDelta` appends — the
 * agent would appear to say the last hour again.
 *
 * Pure, and exported for the tests: this is where reading backwards is either
 * right or subtly wrong, and the wrongness is the kind that only shows up on
 * somebody's month-old session.
 */
export function prepend(now: Conversation, page: Page): Conversation {
  const older = page.events.reduce(apply, nothing).items;
  // What is drawn wins. The configuration carried onto every page, and a turn
  // that straddles the cut, can both come back twice — and React keys the
  // transcript on these ids, so a duplicate is a visible fault rather than a
  // harmless one.
  const drawn = new Set(now.items.map((i) => i.id));

  return {
    ...now,
    items: [...older.filter((i) => !drawn.has(i.id)), ...now.items],
    firstLine: page.firstLine ?? now.firstLine,
    // Absent means a control plane that does not page and has therefore
    // already sent everything. Not "ask again".
    hasMore: page.hasMore ?? false,
    loadingOlder: false,
  };
}

/**
 * Read the exchanges before the ones already drawn, and put them on the front.
 */
async function earlier(key: string, sessionId: string) {
  drain(key);
  const held = read(key);
  // Nothing to read, already reading, or a control plane too old to have said
  // whether there is more — in which case it already sent everything.
  if (held.loadingOlder || !held.hasMore || !held.firstLine) return;
  put(key, { ...held, loadingOlder: true });

  try {
    const page = await getConversation(sessionId, { before: held.firstLine, tail: PAGE });
    // Read again rather than reusing `held`: lines arrive on the socket while
    // this is in flight, and they have already been folded into what is here.
    drain(key);
    put(key, prepend(read(key), page));
  } catch (e) {
    // Left exactly as it was, with the spinner off. Scrolling to the top again
    // is the retry, and that is a better offer than a banner over a transcript
    // somebody is reading.
    console.warn("[firetower] could not read further back", e);
    drain(key);
    put(key, { ...read(key), loadingOlder: false });
  }
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

  /**
   * Read further back, for a transcript that has been scrolled to the top.
   *
   * Safe to call on every scroll event: `earlier` refuses when a page is
   * already in flight or when there is nothing before what is drawn, so the
   * observer that calls it does not have to be careful.
   */
  const older = useCallback(() => void earlier(key, sessionId), [key, sessionId]);

  return { conversation: state, echo, settle, remember, stopping, older };
}

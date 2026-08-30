/**
 * The conversation, folded into something drawable.
 *
 * The control plane sends lifecycle events — this item started, this text
 * arrived, this one finished — because that is what a stream can carry. A
 * screen wants the opposite: a list of things, each complete. This is the fold
 * between them, and it lives apart from the component so that what the events
 * mean is testable without rendering anything.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSocket } from "./socket";
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
      // anything — it is a restatement, not a new session.
      return {
        ...state,
        model: event.model,
        mode: event.mode || state.mode,
        commands: event.commands.length ? event.commands : state.commands,
        lastLine,
      };

    case "TurnStarted":
      return { ...state, working: true, lastLine };

    case "TurnCompleted":
      return {
        ...state,
        working: false,
        // Kept when a turn ends without saying, so the meter does not blank
        // between turns.
        usage: event.usage ?? state.usage,
        lastLine,
      };

    case "ItemStarted": {
      // Already here. A stream that reconnects replays, and folding the same
      // line twice must not draw the same thing twice — React keys on these
      // ids, so a duplicate is a visible fault rather than a harmless one.
      if (items.some((i) => i.id === event.item)) return { ...state, lastLine };

      // A message somebody typed is shown before it has been anywhere, so the
      // composer feels immediate. The agent echoes it back a moment later —
      // that copy is the real one, and it replaces the placeholder rather than
      // appearing beneath it.
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
          ? { ...item, images: [...(item.images ?? []), ...carried] }
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

/**
 * Follow a session's conversation.
 *
 * Read with `fetch` rather than `EventSource` because the session token is a
 * bearer header and `EventSource` cannot send one. The cost is doing our own
 * reconnection, which is the loop below; the alternative was putting a
 * credential in a query string, where it would end up in logs.
 */
/**
 * Follow a session's conversation.
 *
 * Took a `live` flag until the socket arrived: it decided whether to reopen the
 * stream after it closed, which mattered when this held a connection of its
 * own. Reconnection belongs to the socket now, and a session that has ended
 * still has a transcript worth reading, so there is nothing left for it to
 * decide.
 */
export function useConversation(sessionId: string) {
  const [state, setState] = useState<Conversation>(nothing);
  /** Read when resubscribing, without making it a dependency. */
  const cursor = useRef(0);
  const { follow } = useSocket();

  // Moving to another session starts from nothing rather than showing the last
  // one's transcript while this one loads. Adjusted during render rather than
  // in an effect: an effect would paint the wrong conversation first and then
  // correct it, which is a visible flash of somebody else's work.
  const [shownFor, setShownFor] = useState(sessionId);
  if (shownFor !== sessionId) {
    setShownFor(sessionId);
    setState(nothing);
  }

  // Followed over the page's one socket rather than a connection of its own.
  //
  // This used to hold an SSE stream per open agent tab, which is what capped a
  // workspace at three or four agents: a browser allows six connections per
  // origin on HTTP/1.1, and four of them held open here left nothing for
  // `POST /sessions` or `GET /agents` to run on. The tab that could not open
  // was not being refused — its request never got a connection.
  //
  // A subscription costs nothing, so this is now free to be open in as many
  // tabs as somebody wants.
  useEffect(() => {
    // Belongs with the subscription, and this re-runs when the session does.
    cursor.current = 0;
    return follow({
        topic: "conversation",
        id: sessionId,
        // Where this got to, read at resubscribe time — so a reconnect
        // continues rather than replaying the session from the top.
        cursor: () => cursor.current || undefined,
        onFrame: (frame) => {
          if (frame.t === "error") {
            setState((current) => ({ ...current, trouble: frame.message }));
            return;
          }
          if (frame.t !== "line") return;
          const event = frame.line as ConversationEvent;
          cursor.current = Math.max(cursor.current, event.lineNo);
          setState((current) => apply(current, event));
        },
    });
  }, [sessionId, follow]);

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
  const remember = useCallback((of: "model" | "mode" | "effort", value: string) => {
    setState((current) => ({ ...current, [of]: value }));
  }, []);

  /** Optimistically show what somebody just sent, before it comes back. */
  const echo = useCallback((text: string, images: Attached[] = []) => {
    setState((current) => ({
      ...current,
      working: true,
      items: [
        ...current.items,
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
    }));
  }, []);

  /** Take a request off the screen the moment it is answered. */
  const settle = useCallback((req: string) => {
    setState((current) => ({
      ...current,
      asked: current.asked.filter((a) => a.req !== req),
      questions: current.questions.filter((q) => q.req !== req),
    }));
  }, []);

  return { conversation: state, echo, settle, remember };
}

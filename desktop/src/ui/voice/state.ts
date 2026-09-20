/**
 * What dictation is doing, as one value.
 *
 * A machine rather than four booleans, because the states are genuinely
 * exclusive and the version of this with `recording`, `connecting` and
 * `failed` alongside each other had a fifth state nobody designed — all three
 * true at once — which is what the spinner stuck over a live waveform was.
 *
 * The blocked states are separate from the machine on purpose. "The mic is
 * off because macOS says no" is not a phase of listening; it is a thing
 * standing in front of listening, it wants a dialog rather than a button
 * shape, and it outlives any one attempt to start.
 */

/** Where dictation has got to. */
export type Voice =
  | { at: "idle" }
  /** The OS is asking. Ours says nothing over the top of the system prompt. */
  | { at: "asking" }
  /** Minting a ticket and opening the socket. */
  | { at: "connecting" }
  | {
      at: "listening";
      /** 0–1, off the analyser. Drives the bars, and nothing else. */
      level: number;
      /** How long the socket has been open. It is billed by the second. */
      seconds: number;
      /** The model's VAD thinks someone is talking right now. */
      hearing: boolean;
    }
  /** Asked to stop; waiting for the last words the model still owes us. */
  | { at: "settling" };

/**
 * Something is in the way, and a button cannot say what.
 *
 * Each of these is a dialog because each has an action behind it that is not
 * "press the microphone again" — paste a key, open System Settings, replace a
 * key that was revoked. A refusal you can only acknowledge stays on the
 * composer's own line instead; see `Composer`'s `refused`.
 */
export type Blocked =
  /**
   * This Firetower has no voice routes at all — it predates the feature.
   *
   * Its own state rather than an error, because it is neither the person's
   * fault nor a fault in the running system: the desktop updates on its own
   * and the control plane does not, so a new app against an old server is the
   * ordinary case, not the broken one.
   */
  | { why: "unsupported" }
  /** Nobody has given this Firetower a key yet. */
  | { why: "unconfigured"; mayConfigure: boolean }
  /** macOS is refusing, and will not ask again on its own. */
  | { why: "denied" }
  /** The key exists and OpenAI would not take it. */
  | { why: "rejected"; detail: string; mayConfigure: boolean };

/** What the composer is handed. */
export type Dictating = {
  state: Voice;
  blocked: Blocked | null;
  /** Press the microphone. Decides for itself whether it can start. */
  start: () => void;
  /**
   * Press stop. The text is kept; nothing is sent.
   *
   * `then` is handed the finished text, for the one caller that needs to do
   * something with it the instant it settles — pressing send while still
   * talking. It cannot read that off `text` itself: the last words land a
   * moment after stop is pressed, which is later than any closure it holds.
   */
  stop: (then?: (text: string) => void) => void;
  /**
   * The composer's `onChange`, routed through dictation.
   *
   * Everything typed goes through here so that a run in flight can follow an
   * edit made beside its words, or let go of them if the edit landed inside.
   * With nothing being dictated it is `setText`.
   */
  typed: (next: string) => void;
  /** Close whatever dialog is open without doing what it asked. */
  dismiss: () => void;
  /** Take the key the setup dialog collected, then start listening. */
  configure: (key: string) => Promise<void>;
  /** Whether the microphone should be drawn at all. False only off Tauri. */
  possible: boolean;
};

export const quiet: Voice = { at: "idle" };

/** Seconds as a clock, for the pill. */
export function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

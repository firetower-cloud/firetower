/**
 * Dictation, wired up.
 *
 * Holds the microphone, the socket and the run of text they are writing into,
 * and is the only thing that knows all three exist. The composer gets a value
 * it can draw and four things it can call.
 *
 * ## The order things start in
 *
 * The microphone is asked for *before* the ticket is minted, which looks
 * backwards — it means asking for a permission that may turn out to be
 * unusable. It is this way round because the permission prompt is the slow
 * step and it is slow in human time: somebody reads a dialog and decides.
 * Minting first would spend a ticket, whose whole life is about a minute long,
 * on that wait. Asking first spends nothing.
 *
 * ## The caps are here and nowhere else
 *
 * Because the client connects straight to OpenAI, the server cannot stop a
 * session once it has started — that is the trade the ticket makes for not
 * putting the control plane in the audio path. So the limits live here: a
 * ceiling on how long one dictation may run, and a shorter one on how long it
 * may run without hearing anything. A microphone left open on a desk overnight
 * is a bill, and it is the kind of bill nobody notices for a month.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { setVoiceKey, voiceState, voiceTicket } from "~/api/voice";
import { ApiError } from "~/client/http";
import { listen, Refused, type Capture } from "./capture";
import { close, open, reanchor, render, withDelta, withSegment, type Run } from "./splice";
import { transcribe, type Listening } from "./socket";
import { quiet, type Blocked, type Dictating, type Voice } from "./state";

/** The longest one dictation may run. Long enough for anything anybody says. */
const LONGEST = 5 * 60;
/** How long it may hear nothing before giving the microphone back. */
const PATIENCE = 20;

/**
 * What a refusal from the control plane actually means.
 *
 * Every failure used to land on "OpenAI rejected this Firetower's key", which
 * was a guess dressed as a diagnosis — and wrong in the commonest case of all.
 * A desktop build that updates itself, pointed at a control plane that has not
 * been updated, gets a plain 404 from Firetower; OpenAI is never reached. The
 * dialog said the key had been revoked, which would send somebody to their
 * billing page over a server they simply had not deployed.
 *
 * So the code decides, and only a genuine upstream refusal is reported as one.
 */
function standing(e: unknown, mayConfigure: boolean): Blocked {
  const code = e instanceof ApiError ? e.code : null;
  // Firetower does not know the route. An older control plane, not a fault.
  if (code === "NotFound") return { why: "unsupported" };
  // It knows, and is holding no key.
  if (code === "ProviderNotConfigured") return { why: "unconfigured", mayConfigure };
  if (code === "Forbidden") return { why: "unconfigured", mayConfigure: false };
  return { why: "rejected", detail: e instanceof Error ? e.message : "", mayConfigure };
}

/**
 * A fixed state, for drawing this without talking at it.
 *
 * The style page renders every state of the composer at once, which is the
 * only way to look at them side by side and the only way to review the ones
 * that are hard to reach on purpose — a revoked key, a denied permission. The
 * app never provides this, so in the real composer it costs one `useContext`
 * returning null.
 */
const Forced = createContext<Dictating | null>(null);
export const ForceVoice = Forced.Provider;

export function useVoice({
  text,
  setText,
  box,
}: {
  text: string;
  setText: (text: string) => void;
  box: RefObject<HTMLTextAreaElement | null>;
}): Dictating {
  const [state, setState] = useState<Voice>(quiet);
  const [blocked, setBlocked] = useState<Blocked | null>(null);

  const run = useRef<Run | null>(null);
  const mic = useRef<Capture | null>(null);
  const wire = useRef<Listening | null>(null);
  /** The last thing we wrote, so an edit can be told from an echo of our own. */
  const wrote = useRef<string>("");
  /**
   * Audio captured before there is a socket to send it to.
   *
   * The microphone starts the moment permission is granted, which is a
   * deliberate few hundred milliseconds before the ticket is minted and the
   * socket is open. Without this those chunks are dropped, and what is dropped
   * is the *first* thing said — which is the one part of a sentence people
   * notice missing, and the reason they stop trusting dictation.
   *
   * Capped, because this is only ever bridging a gap of well under a second;
   * if minting hangs, the right outcome is to lose the audio rather than to
   * grow a buffer for as long as somebody keeps talking.
   */
  const early = useRef<ArrayBuffer[]>([]);
  /** ~10s at 24kHz mono, which is far more than the gap it covers. */
  const EARLIEST = 100;
  /** When the model last heard a voice, for `PATIENCE`. */
  const lastHeard = useRef<number>(0);
  const started = useRef<number>(0);

  /* Read once, when the composer first draws. It changes only when somebody
     sets a key, and the dialog that does that updates it by hand — so this
     does not need to be a query with a cache and an invalidation. */
  const [setUp, setSetUp] = useState<{ configured: boolean; mayConfigure: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    voiceState()
      .then((s) => live && setSetUp(s))
      /* Swallowed here and asked again when the button is pressed. A server
         that was unreachable while the composer was drawing is not worth an
         error nobody asked for — but it must not be mistaken for a server that
         said yes, which is what `start` below is careful about. */
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const put = useCallback(
    (next: Run) => {
      run.current = next;
      const drawn = render(next);
      wrote.current = drawn;
      setText(drawn);
    },
    [setText],
  );

  /** Give everything back. The text is left exactly as it stands. */
  const release = useCallback(() => {
    mic.current?.stop();
    mic.current = null;
    wire.current?.close();
    wire.current = null;
    early.current = [];
  }, []);

  const stop = useCallback(
    (then?: (text: string) => void) => {
    if (!run.current) {
      release();
      setState(quiet);
      then?.(wrote.current);
      return;
    }
    setState({ at: "settling" });
    wire.current?.finish();

    /* A moment for the last words. The model owes us the end of whatever was
       being said when stop was pressed, and closing the socket on the same
       tick throws it away — which reads as the app eating your final sentence,
       every time, for the sake of a quarter of a second. */
    window.setTimeout(() => {
      release();
      const done = run.current ? close(run.current) : null;
      run.current = null;
      setState(quiet);
      if (!done) return;
      wrote.current = done.text;
      setText(done.text);
      if (then) {
        then(done.text);
        return;
      }
      const el = box.current;
      if (el) {
        el.focus();
        window.requestAnimationFrame(() => el.setSelectionRange(done.caret, done.caret));
      }
    }, 400);
    },
    [box, release, setText],
  );

  /* Held in a ref so the ticking effect below can call the current one without
     restarting its interval every time the closure changes. */
  const stopping = useRef(stop);
  stopping.current = stop;

  /** The clock, the caps, and nothing else. Runs only while listening. */
  useEffect(() => {
    if (state.at !== "listening") return;
    const tick = window.setInterval(() => {
      const now = Date.now();
      const seconds = (now - started.current) / 1000;
      if (seconds >= LONGEST || (now - lastHeard.current) / 1000 >= PATIENCE) {
        stopping.current();
        return;
      }
      setState((was) => (was.at === "listening" ? { ...was, seconds } : was));
    }, 250);
    return () => window.clearInterval(tick);
  }, [state.at]);

  /** Let go of the microphone if this unmounts mid-sentence. */
  useEffect(() => release, [release]);

  const begin = useCallback(async () => {
    setBlocked(null);
    setState({ at: "asking" });

    let capture: Capture;
    /* The level is smoothed across chunks: the peak of any 100ms window jumps
       around far more than the loudness anybody perceives, and bars driven
       straight off it look like a fault rather than a voice. */
    let level = 0;
    try {
      capture = await listen((pcm, peak) => {
        level = Math.max(peak, level * 0.82);
        if (wire.current) wire.current.send(pcm);
        else if (early.current.length < EARLIEST) early.current.push(pcm);
        setState((was) => (was.at === "listening" ? { ...was, level: Math.min(1, level * 1.6) } : was));
      });
    } catch (e) {
      setState(quiet);
      if (e instanceof Refused) setBlocked({ why: "denied" });
      else setBlocked(standing(e, !!setUp?.mayConfigure));
      return;
    }
    mic.current = capture;
    setState({ at: "connecting" });

    let ticket;
    try {
      ticket = await voiceTicket();
    } catch (e) {
      release();
      setState(quiet);
      setBlocked(standing(e, !!setUp?.mayConfigure));
      return;
    }

    const at = box.current?.selectionStart ?? text.length;
    put(open(text, at));
    started.current = Date.now();
    lastHeard.current = Date.now();

    const wiring = transcribe(ticket, (heard) => {
      if (!run.current) return;
      switch (heard.t) {
        /* Words arriving are proof somebody is talking, so they hold off the
           silence timeout in their own right. Leaving that to the VAD frames
           alone made `PATIENCE` depend on events the transcription docs do not
           actually promise — and the failure that buys you is the microphone
           switching itself off mid-sentence while the transcript is visibly
           still arriving. */
        case "delta":
          lastHeard.current = Date.now();
          put(withDelta(run.current, heard.text));
          return;
        case "segment":
          lastHeard.current = Date.now();
          put(withSegment(run.current, heard.text));
          return;
        case "speech":
          lastHeard.current = Date.now();
          setState((was) => (was.at === "listening" ? { ...was, hearing: heard.on } : was));
          return;
        case "failed":
          /* Words already on screen are kept — they are yours, and a socket
             that dropped after a sentence landed is not a reason to take it
             back. The dialog only appears when nothing was heard at all,
             because then there is nothing else to show for the attempt. */
          release();
          if (run.current && !render(run.current).trim()) {
            setBlocked({ why: "rejected", detail: heard.why, mayConfigure: !!setUp?.mayConfigure });
          }
          run.current = null;
          setState(quiet);
          return;
      }
    });

    /* Assigned before the backlog is flushed, so a chunk arriving mid-flush
       goes to the socket behind the ones already waiting rather than jumping
       in front of them. */
    wire.current = wiring;
    early.current.forEach((pcm) => wiring.send(pcm));
    early.current = [];

    setState({ at: "listening", level: 0, seconds: 0, hearing: false });
  }, [box, put, release, setUp, text]);

  const start = useCallback(() => {
    if (state.at !== "idle") return;
    void (async () => {
      /* Settled before the microphone is touched, even when it costs a request.
         Taking somebody's microphone — and making macOS ask for it — only to
         answer "this is not set up" is the wrong order, and it is the order
         this was in: the read above fails silently on an older server, which
         left the answer unknown, and unknown was being treated as yes. */
      let known = setUp;
      if (!known) {
        try {
          known = await voiceState();
          setSetUp(known);
        } catch (e) {
          setBlocked(standing(e, false));
          return;
        }
      }
      if (!known.configured) {
        setBlocked({ why: "unconfigured", mayConfigure: known.mayConfigure });
        return;
      }
      await begin();
    })();
  }, [begin, setUp, state.at]);

  const configure = useCallback(
    async (key: string) => {
      await setVoiceKey(key);
      setSetUp({ configured: true, mayConfigure: true });
      setBlocked(null);
      // You pressed the microphone; the thing you asked for is listening.
      void begin();
    },
    [begin],
  );

  /**
   * Somebody typed into the box.
   *
   * Routed through here rather than straight to `setText` so that a dictation
   * in flight can follow the edit — or let go of the text, if the edit landed
   * in the words it was writing. When nothing is being dictated this is
   * `setText` with an extra function call.
   */
  const typed = useCallback(
    (next: string) => {
      setText(next);
      if (!run.current || next === wrote.current) {
        wrote.current = next;
        return;
      }
      const moved = reanchor(run.current, next);
      wrote.current = next;
      if (moved) {
        run.current = moved;
        return;
      }
      // Theirs now. The microphone stays on — they are still talking, and the
      // next segment starts a fresh run from where the caret now is.
      run.current = open(next, box.current?.selectionStart ?? next.length);
    },
    [box, setText],
  );

  const real: Dictating = {
    state,
    blocked,
    start,
    stop,
    typed,
    dismiss: () => setBlocked(null),
    configure,
    possible: typeof navigator !== "undefined" && !!navigator.mediaDevices,
  };

  return useContext(Forced) ?? real;
}

/**
 * Getting the microphone, and turning it into PCM.
 *
 * The rate is asked for on the `AudioContext` rather than resampled by hand.
 * WebKit and Chromium will both give you 24kHz if you ask at construction, and
 * hand-rolled decimation — taking every other sample off a 48kHz stream — is
 * where dictation quality quietly dies: it aliases, the model hears a lisp,
 * and the transcript is subtly wrong in a way nobody traces back to here.
 *
 * Echo cancellation, noise suppression and gain control are all left on. This
 * is somebody talking at a laptop in a room, not a recording session, and the
 * browser's implementations are better than anything reasonable to do here.
 */

/** The system, or the browser, said no. Its own type so the caller can offer the fix. */
export class Refused extends Error {
  constructor() {
    super("the microphone was refused");
    this.name = "Refused";
  }
}

export type Capture = {
  /** Gives the microphone back. The OS indicator goes out when this runs. */
  stop: () => void;
};

/** The rate the transcription model wants. Anything else has to be resampled. */
export const RATE = 24_000;

export async function listen(onChunk: (pcm: ArrayBuffer, peak: number) => void): Promise<Capture> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    // `NotAllowedError` is a refusal; `NotFoundError` is a Mac with no
    // microphone at all. Both end the same way for the caller, and the dialog
    // that follows is about permission because that is the overwhelmingly
    // likelier of the two.
    throw new Refused();
  }

  const context = new AudioContext({ sampleRate: RATE });
  /* Safari starts a context suspended when it was not created inside a
     gesture. The click that got us here counts, but a second dictation
     started from the keyboard shortcut may not — so it is resumed either way
     rather than depending on how this was reached. */
  if (context.state === "suspended") await context.resume();

  try {
    await context.audioWorklet.addModule("/voice-worklet.js");
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    void context.close();
    throw e;
  }

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "pcm");
  node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; peak: number }>) =>
    onChunk(e.data.pcm, e.data.peak);
  source.connect(node);
  /* Not connected to the destination: the node produces no output, and wiring
     it to the speakers is how you get your own voice back at you through the
     laptop. The worklet runs regardless — it has an input that is live. */

  return {
    stop: () => {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      // The tracks first, so the orange dot in the menu bar goes out at the
      // moment the button says it has stopped rather than whenever the audio
      // graph finishes tearing down.
      stream.getTracks().forEach((t) => t.stop());
      void context.close();
    },
  };
}

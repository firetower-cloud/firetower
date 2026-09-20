/**
 * Microphone audio, as the bytes a transcription model wants.
 *
 * A real file on the app's own origin rather than a `blob:` URL built at
 * runtime, because `tauri.conf.json` sets `default-src 'self'` and a blob
 * worklet is refused by it — silently, as a rejected `addModule` promise that
 * looks exactly like a microphone that is not working.
 *
 * Plain JavaScript, untouched by the bundler: worklets run in the audio
 * rendering thread with no module graph around them.
 *
 * The peak is computed here rather than by a second `AnalyserNode` on the
 * graph, because every sample is already in hand at this point. The level
 * meter and the transcription therefore see exactly the same audio, which is
 * the property that makes the meter worth drawing at all — a meter fed from
 * somewhere else can bounce merrily while silence is being sent.
 */

/** 100ms at 24kHz. Small enough to feel live, big enough not to be all overhead. */
const CHUNK = 2400;

class Pcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.held = new Float32Array(CHUNK);
    this.n = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input yet is ordinary at the very start; returning true keeps the
    // node alive rather than letting the graph collect it.
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.held[this.n++] = channel[i];
      if (this.n === CHUNK) this.flush();
    }
    return true;
  }

  flush() {
    const out = new Int16Array(this.n);
    let peak = 0;
    for (let i = 0; i < this.n; i++) {
      const s = Math.max(-1, Math.min(1, this.held[i]));
      // Asymmetric on purpose: 16-bit signed has one more step below zero
      // than above it, and scaling both sides by 0x8000 clips every full-scale
      // positive sample.
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      const loud = s < 0 ? -s : s;
      if (loud > peak) peak = loud;
    }
    this.port.postMessage({ pcm: out.buffer, peak }, [out.buffer]);
    this.n = 0;
  }
}

registerProcessor("pcm", Pcm);

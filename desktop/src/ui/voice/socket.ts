/**
 * The transcription socket, opened straight at OpenAI.
 *
 * Not through Firetower. The server mints a short-lived ticket
 * (`POST /api/v1/voice/ticket`, which is where the real key lives and stays)
 * and this connects with that — so the audio does not take a detour through
 * the control plane, and the control plane does not spend its bandwidth or its
 * sockets on somebody talking.
 *
 * What the server keeps by minting rather than relaying: the key itself, the
 * model and every other session setting — those are baked in at mint time, so
 * a client cannot quietly promote itself to a more expensive model — the
 * audit line in the vault log, and the decision to mint at all.
 *
 * **Why the credential is in the subprotocol.** A browser cannot set headers
 * on a WebSocket. OpenAI's answer is to read it out of the subprotocol array,
 * under a name that says `insecure` — which refers to putting a *standing* API
 * key there. An ephemeral ticket is the thing that mechanism exists for.
 */

import type { VoiceTicket } from "~/api/generated/model";

/** What the socket tells the hook. */
export type Heard =
  /** The live segment, revised. Replaces what came before it. */
  | { t: "delta"; text: string }
  /** That segment is final and will not change again. */
  | { t: "segment"; text: string }
  /** The model's own voice detection, for the meter. */
  | { t: "speech"; on: boolean }
  /** It will not work, and saying so is the end of this socket. */
  | { t: "failed"; why: string };

const REALTIME = "wss://api.openai.com/v1/realtime?intent=transcription";

export type Listening = {
  /** A chunk of PCM16, as it comes off the worklet. */
  send: (pcm: ArrayBuffer) => void;
  /** Stop, and let the model finish the sentence it is holding. */
  finish: () => void;
  close: () => void;
};

/** Base64 without a data-url prefix, from raw bytes. */
function encode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // In blocks: `apply` on a 48,000-element array is a stack overflow, and the
  // chunk size that produced one was only ever hit by somebody who talked for
  // a while without pausing.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(binary);
}

export function transcribe(ticket: VoiceTicket, onHeard: (heard: Heard) => void): Listening {
  const ws = new WebSocket(REALTIME, [
    "realtime",
    `openai-insecure-api-key.${ticket.value}`,
    "openai-beta.realtime-v1",
  ]);

  /* Audio that arrives before the socket is open. The worklet starts the
     moment permission is granted, which is deliberately earlier than the
     socket finishes connecting — the alternative is clipping the first word
     off every dictation, which is exactly the word people re-record for. */
  let waiting: ArrayBuffer[] = [];
  let open = false;

  const append = (pcm: ArrayBuffer) =>
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: encode(pcm) }));

  ws.onopen = () => {
    open = true;
    waiting.forEach(append);
    waiting = [];
  };

  ws.onmessage = (event) => {
    let frame: { type?: string; delta?: string; transcript?: string; error?: { message?: string } };
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      return; // Not ours to interpret, and not worth ending a dictation over.
    }

    switch (frame.type) {
      case "conversation.item.input_audio_transcription.delta":
        if (frame.delta) onHeard({ t: "delta", text: frame.delta });
        return;
      case "conversation.item.input_audio_transcription.completed":
        if (frame.transcript) onHeard({ t: "segment", text: frame.transcript });
        return;
      case "input_audio_buffer.speech_started":
        onHeard({ t: "speech", on: true });
        return;
      case "input_audio_buffer.speech_stopped":
        onHeard({ t: "speech", on: false });
        return;
      case "error":
        onHeard({ t: "failed", why: frame.error?.message ?? "OpenAI refused the connection." });
        return;
    }
  };

  /* A close is only worth reporting when nothing has been said yet: after a
     sentence has landed, the words are already in the box and an error line
     about the socket is noise about something already finished. The hook
     decides; this only reports. */
  ws.onerror = () => onHeard({ t: "failed", why: "The connection to OpenAI failed." });

  return {
    send: (pcm) => {
      if (open && ws.readyState === WebSocket.OPEN) append(pcm);
      else if (!open) waiting.push(pcm);
    },
    finish: () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    },
    close: () => {
      ws.onmessage = null;
      ws.onerror = null;
      ws.close();
    },
  };
}

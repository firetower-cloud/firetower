/**
 * The caching policy for dictation's two reads. The requests themselves are
 * the generated client's.
 *
 * Nothing here re-implements an endpoint — `api/generated/voice` already has
 * all three, typed off the same OpenAPI document as everything else. What it
 * does not have is a policy, and both of these need one the generated hooks
 * would get wrong.
 *
 * **A ticket must never be cached.** It is a credential for somebody else's
 * service with about a minute to live. `useVoiceTicket` would hold it in the
 * query cache, hand it out again after it had expired, and put it in a
 * devtools panel besides. So it is called directly: fetched, used, dropped.
 *
 * **Whether voice is set up wants caching, but per server.** A composer is
 * mounted per open workspace and the answer is the same for all of them, so it
 * is asked once and shared. React Query would do this too, but `useVoice` needs
 * the answer inside a callback rather than as render state, which is not what
 * a hook is for.
 */
import { setVoiceKey as putKey, voiceState as readState } from "~/api/generated/voice/voice";
import type { VoiceState } from "~/api/generated/model";
import { currentBackend } from "~/client/http";

export type { VoiceState };
export { voiceTicket } from "~/api/generated/voice/voice";

/**
 * Keyed by server, because the answer belongs to the server: two Firetowers on
 * one Mac disagree about this, and the desktop talks to both. The promise is
 * held rather than the value, so tabs opening in the same tick share one
 * request instead of racing four.
 */
const asked = new Map<string, Promise<VoiceState>>();

export function voiceState(): Promise<VoiceState> {
  const server = currentBackend() ?? "";
  let held = asked.get(server);
  if (!held) {
    held = readState();
    asked.set(server, held);
    /* A failure must not become the cached answer for the rest of the session.
       This is read while a server is still connecting, and an unreachable
       Firetower at that moment would otherwise mean no microphone until the
       app was restarted. */
    held.catch(() => asked.delete(server));
  }
  return held;
}

/** Put a key in the vault, or replace the one that is there. */
export async function setVoiceKey(key: string): Promise<void> {
  await putKey({ key });
  /* Every other composer on this server is holding the answer from before
     there was a key. Dropped rather than rewritten, so the next one to ask
     gets it from the server that now knows. */
  asked.delete(currentBackend() ?? "");
}

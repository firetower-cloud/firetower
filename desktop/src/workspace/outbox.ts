/**
 * The first message for a workspace that does not exist yet.
 *
 * ## Why this is not just a send
 *
 * The New page sends what you typed by putting it in `NewSession.prompt`: the
 * control plane carries it inside `CreateWorkspace` and the worker hands it to
 * the agent as its opening prompt. That works precisely because it travels
 * *with* the launch.
 *
 * Attachments cannot. `NewSession` has no field for them, and the two calls
 * that would place them both need a workspace that exists:
 *
 * - `attach_file` runs `workspace_of` on the worker, and the workspace is made
 *   asynchronously after `create_session` has already answered.
 * - `send_turn` reaches the agent's socket, and the agent is the *last* step of
 *   the bring-up — after the clone, after the worktree, after the repository's
 *   own setup script. The worker waits thirty seconds for that socket and a
 *   setup script can comfortably outlast it.
 *
 * So pressing Start with a file attached cannot send anything yet, and the
 * honest answer is to wait for the bring-up rather than to race it. The
 * conversation already knows when it is over: `ready()` in `~/components/Steps`
 * is the predicate the transcript uses to draw the bring-up, and it is true
 * once every step that was going to run has and the last of them was `Launch`.
 *
 * ## Why a module rather than a component
 *
 * The New page navigates to the conversation the moment the session exists, so
 * whatever is waiting for the bring-up must outlive the page that started it.
 * This is a plain module driving the generated client: nothing here is mounted,
 * so nothing here is unmounted. The message appears in the transcript on its
 * own — the control plane holds what has been typed until the agent echoes it
 * (`fleet.typed`), which is the same path a message sent from the composer
 * takes.
 *
 * ## Why the bytes are not in `draft.ts`
 *
 * That handoff is `sessionStorage`, which is right for a sentence and wrong for
 * a picture: a 5 MB image is about 6.7 MB of base64 and the quota is around
 * five. The pictures wait in memory instead, which is sound because the hash
 * router never reloads the document — see `~/shims/next-navigation`.
 *
 * ## Why the server is part of every key
 *
 * The generated client has one *current* backend and resolves it when the call
 * is made, from module state the sidebar changes (`~/client/http`). So a
 * session id on its own does not say where to send anything: a window pointed
 * at another Firetower while a workspace comes up would have these calls made
 * against a server the person attached nothing on, and a server that answers
 * for an id it never minted would be handed their file. A parcel therefore
 * belongs to one server, every key here carries it, and every call that leaves
 * the machine is guarded by `mine`. Same reason `~/api/conversation` keys its
 * transcripts `server:session` and `~/backend` keeps a QueryClient each.
 */
import { useSyncExternalStore } from "react";
import type { Attached, Event, Session } from "~/api/generated/model";
import { attachFile, getSession, sendTurn } from "~/api/generated/sessions/sessions";
import { listEvents } from "~/api/generated/events/events";
import { ready, stepLines } from "~/components/Steps";
import { currentBackend } from "~/client/http";
import { base64 } from "~/ui/attach";
import { why } from "~/data";

/** A first message, waiting for somewhere to go. */
export type Parcel = {
  /** What was typed. */
  text: string;
  /** Pictures, already read: they ride inside the message. */
  images: Attached[];
  /** Everything else, to be put in the workspace once there is one. */
  files: File[];
};

/**
 * What could not be delivered, for whoever is on that conversation to say.
 *
 * `text` is present only when the message itself never went, and it is the
 * message as it would have been sent — including the paths of any files that
 * *did* land, so pressing send delivers everything without uploading anything
 * twice. When the message went and only a file was lost, there is nothing to
 * put back and only something to say.
 */
export type Trouble = { why: string; text?: string };

/**
 * Where a parcel is addressed.
 *
 * The server, because a session id only means anything on the one that minted
 * it — see the header. The workspace, because the conversation a person ends
 * up reading is chosen from the runs in it (`Workbench`) and that is not
 * always the run this was started for: a second agent added during the
 * bring-up, or this run ending, is enough to put another one on screen.
 */
export type Address = { server: string; sessionId: string; workspaceId?: string | null };

const held = new Map<string, Trouble>();
const watchers = new Set<() => void>();
/** Which sessions are already being delivered to, so nothing is sent twice. */
const going = new Set<string>();

const keyFor = (server: string, id: string) => `${server}:${id}`;

function hold(to: Address, trouble: Trouble) {
  /* Under the workspace as well as the session. `Composer` asks about the one
     run it is drawing, so a trouble filed only under the run that was started
     is a trouble nobody is ever shown — which is the silent loss this whole
     path exists to avoid. */
  held.set(keyFor(to.server, to.sessionId), trouble);
  if (to.workspaceId) held.set(keyFor(to.server, to.workspaceId), trouble);
  watchers.forEach((w) => w());
}

export function watch(listener: () => void): () => void {
  watchers.add(listener);
  return () => watchers.delete(listener);
}

/**
 * What could not be delivered to a conversation on a server, if anything.
 *
 * By either of the ids it can be asked for by: the run, or the workspace the
 * run belongs to. Separate from the hook below so that both the server and the
 * workspace are testable without a window.
 */
export function undelivered(server: string, sessionId: string, workspaceId?: string | null): Trouble | undefined {
  return held.get(keyFor(server, sessionId)) ?? (workspaceId ? held.get(keyFor(server, workspaceId)) : undefined);
}

/** Said once. Taken by the composer that said it, so it is not said again. */
export function forget(sessionId: string, workspaceId?: string | null) {
  const said = undelivered(currentBackend() ?? "", sessionId, workspaceId);
  if (!said) return;
  /* By what it is rather than by the keys it was asked for by: whoever read it
     knows the run it is drawing and the workspace that run is in, which are
     not necessarily the ids the parcel was filed under. */
  for (const [k, v] of held) if (v === said) held.delete(k);
  watchers.forEach((w) => w());
}

/**
 * What the New page could not deliver to this conversation, if anything.
 *
 * The conversation is where this belongs: it is the one screen that can both
 * say what went wrong and offer the message back. A person who is somewhere
 * else when it fails hears about it when they next open the workspace, which
 * is the first moment there is anywhere to say it.
 */
export function useUndelivered(sessionId: string, workspaceId?: string | null): Trouble | undefined {
  return useSyncExternalStore(
    watch,
    // The server is read rather than subscribed to, as every generated request
    // reads it: the provider is keyed on the server, so changing one remounts
    // this anyway.
    () => undelivered(currentBackend() ?? "", sessionId, workspaceId),
    () => undefined,
  );
}

/** How often the bring-up is asked about, and how long before giving up on it. */
const EVERY = 1500;
const GIVE_UP = 10 * 60 * 1000;

const nap = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The bring-up is over and it did not work. Not worth waiting out. */
class Stopped extends Error {}

/** What the window is pointed at now is not where this was going. */
const MOVED = "the window moved to another Firetower";

/**
 * Wait until the agent is listening.
 *
 * Ten minutes, because a first clone of a large repository followed by that
 * repository's own setup script is minutes of real work, and giving up sooner
 * would be giving up on the commonest slow case. A bring-up that *failed* is
 * not waited out at all — the failed step is in the same lines this reads.
 *
 * A read that itself fails is not an answer and does not end the wait: a
 * self-hosted control plane can be restarted while a workspace is coming up,
 * which looks like a 404 or a dropped connection and does not mean the message
 * cannot be delivered. So the last thing that went wrong is kept and only
 * reported if it never clears.
 *
 * The window being pointed at another Firetower is different in kind, and ends
 * the wait at once — there is nothing there to read and nothing there that may
 * be written.
 */
export async function untilReady(sessionId: string, mine: () => boolean): Promise<void> {
  const until = Date.now() + GIVE_UP;
  let unread: unknown = null;
  for (;;) {
    /* Asked of nobody else. The client picks its server when the call is made,
       so this would otherwise ask whatever Firetower is current about a
       session it never minted — and one that answers anyway, with a single
       `AgentLaunched` of its own, would be handed the person's file. */
    if (!mine()) throw new Stopped(MOVED);
    try {
      const session = (await getSession(sessionId)) as Session;
      const events = (await listEvents({ sessionId } as Parameters<typeof listEvents>[0])) as Event[];
      const lines = stepLines(session, events);
      if (ready(lines)) return;

      const broke = lines.find((l) => l.state === "failed");
      if (broke) throw new Stopped(broke.detail || `the workspace stopped at ${broke.step}`);
      if (session.status === "Failed") throw new Stopped("the workspace failed to start");
      if (session.status === "Ended") throw new Stopped("the workspace ended before the agent started");
      unread = null;
    } catch (e) {
      if (e instanceof Stopped) throw e;
      unread = e;
    }

    if (Date.now() > until) {
      throw new Error(unread ? why(unread) : "the workspace did not come up within ten minutes");
    }
    await nap(EVERY);
  }
}

/**
 * What delivery needs from the outside.
 *
 * Named so `run` can be tested: the interesting part of this file is the order
 * — wait, place, send — and what each failure does to the message, none of
 * which should need a control plane to exercise.
 */
export type Ports = {
  /** Whether the window is still pointed at the server this parcel is for. */
  mine: () => boolean;
  until: (sessionId: string) => Promise<void>;
  place: (sessionId: string, file: File) => Promise<string>;
  send: (sessionId: string, text: string, images: Attached[]) => Promise<void>;
};

/**
 * The real ones, for one server.
 *
 * Each call below resolves its server from module state when it is made rather
 * than from this closure, which is why `mine` exists: it is the whole of what
 * stands between a slow bring-up on one Firetower and an upload to another.
 */
function portsFor(server: string): Ports {
  const mine = () => currentBackend() === server;
  return {
    mine,
    until: (sessionId) => untilReady(sessionId, mine),
    place: async (sessionId, file) =>
      (await attachFile(sessionId, { name: file.name, data: await base64(file) })).path,
    send: async (sessionId, text, images) => void (await sendTurn(sessionId, { text, images })),
  };
}

/** What a file that could not be placed is worth saying. */
export function lost(names: string[]): string {
  if (names.length === 0) return "";
  const which = names.join(", ");
  return names.length === 1
    ? `${which} could not be put in the workspace. Attach it again to send it.`
    : `These could not be put in the workspace: ${which}. Attach them again to send them.`;
}

/**
 * What was attached and never got anywhere, named.
 *
 * Named rather than counted, because the person has to find these files again
 * to attach them a second time and "2 files" does not help them do that.
 */
export function nothingAttached(parcel: Pick<Parcel, "files" | "images">): string {
  const pictures = parcel.images.length;
  const what = [
    ...parcel.files.map((f) => f.name),
    pictures ? `${pictures} ${pictures === 1 ? "image" : "images"}` : "",
  ].filter(Boolean);
  return what.length ? `Nothing was attached: ${what.join(", ")}.` : "";
}

/**
 * The message, as `Composer.submit` builds one.
 *
 * Pictures are not in it — they travel beside it, because the model looks at
 * them. Everything else is named by the path it landed at, which is what the
 * agent can act on, one per line and a blank line below the sentence.
 */
export function firstMessage(text: string, paths: string[]): string {
  return [text.trim(), paths.join("\n")].filter(Boolean).join("\n\n");
}

/**
 * Deliver one parcel, and say what of it did not arrive.
 *
 * Files one at a time, as the composer does: ten parallel uploads of
 * twenty-five megabytes is ten bodies in flight through every hop at once. A
 * file that will not go is named and the rest carry on — losing the whole
 * message because one attachment failed would be the worse of the two.
 */
export async function run(sessionId: string, parcel: Parcel, ports: Ports): Promise<Trouble | null> {
  const placed: string[] = [];
  const missing: string[] = [];

  try {
    await ports.until(sessionId);
    /* And still ours now it has answered: the window can move between the last
       poll and the first upload, and `attach_file` would then be asked of
       whichever Firetower is current. */
    if (!ports.mine()) throw new Stopped(MOVED);
  } catch (e) {
    /* Nothing has moved, so nothing is half-sent. The words go back to the
       composer, and the attachments can only be named: there was never a
       workspace to put a file in, and handing the pictures to a composer that
       cannot reach the agent either would be theatre. */
    return { text: parcel.text, why: `Your first message was not sent — ${why(e)}. ${nothingAttached(parcel)}`.trim() };
  }

  for (const file of parcel.files) {
    /* Ten uploads of twenty-five megabytes is minutes, so this is asked again
       for each one rather than once for the loop. A file not sent is a file to
       name, which is what `missing` already says. */
    if (!ports.mine()) {
      missing.push(file.name);
      continue;
    }
    try {
      placed.push(await ports.place(sessionId, file));
    } catch {
      missing.push(file.name);
    }
  }

  const text = firstMessage(parcel.text, placed);
  if (!text && parcel.images.length === 0) return missing.length ? { why: lost(missing) } : null;

  /* The files that did land are named in this text and are on the server this
     parcel is for, so handing it back is what lets a second press — made while
     looking at that workspace — finish the job rather than start it again. */
  if (!ports.mine()) return { text, why: `Your first message was not sent — ${MOVED}. ${lost(missing)}`.trim() };

  try {
    /* Once, never twice. A socket that has accepted the frame has delivered it
       as far as anyone here can tell, so a retry on a lost answer would say the
       same thing to the agent a second time — the worker's own rule, and the
       reason `tell_when_listening` retries only a failure to connect. */
    await ports.send(sessionId, text, parcel.images);
  } catch (e) {
    /* The files that landed are already in the workspace and already named in
       this text, so handing it back is what lets a second press deliver all of
       it without putting anything there twice. */
    return { text, why: `Your first message was not sent — ${why(e)}. ${lost(missing)}`.trim() };
  }

  return missing.length ? { why: lost(missing) } : null;
}

/**
 * One attempt, from the server it belongs to.
 *
 * Named so that `post` can be tested: which server a parcel is for, and what
 * becomes of the words when the attempt ends, are the two things worth
 * exercising here and neither should need a control plane.
 */
export async function deliver(to: Address, parcel: Parcel, ports: Ports): Promise<void> {
  const one = keyFor(to.server, to.sessionId);
  if (going.has(one)) return;
  going.add(one);
  try {
    const trouble = await run(to.sessionId, parcel, ports).catch((e) => ({
      text: parcel.text,
      why: `Your first message was not sent — ${why(e)}.`,
    }));
    if (trouble) hold(to, trouble);
  } finally {
    going.delete(one);
  }
}

/**
 * Hand a first message to a session that is still coming up.
 *
 * Returns at once: the waiting happens here, not on the page that called.
 * Posting twice for one session does nothing the second time, because the
 * worker gives a second copy of a file a name of its own and the person would
 * end up with both.
 *
 * The server is taken now rather than when a call is made, which is the whole
 * of the difference between delivering this to the workspace it was attached
 * on and delivering it to whatever the sidebar is pointed at ten minutes
 * later.
 */
export function post(sessionId: string, parcel: Parcel, workspaceId?: string | null) {
  const server = currentBackend() ?? "";
  void deliver({ server, sessionId, workspaceId }, parcel, portsFor(server));
}

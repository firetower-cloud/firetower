/**
 * The channel of **this copy of the app**, which is not the installation's.
 *
 * Two things wear the word *channel* on the Updates screen and they are not
 * two of the same thing. The installation's is derived from the tag on the
 * image it is running, is an administrator's, and changing it rewrites a
 * deployment file for everybody connected to it. This one is a preference on
 * this machine, belongs to whoever is using the copy, and affects nobody else.
 * They are allowed to disagree — that was decided deliberately, because most
 * people running the app are not the person who upgrades the server.
 *
 * **Reversible, and worth saying where somebody opts in.** Leaving beta is a
 * preference being written back; nothing refuses it. What it does *not* do is
 * reinstall the general-access build — a copy is never moved to an older one.
 * So after leaving, a copy can be ahead of general access for a while, which
 * is a named state rather than an error and ends by itself the moment general
 * access reaches the build the copy holds.
 *
 * **The channel is an address, not a flag.** There is no channel concept in
 * the updater: beta's manifest is published at one URL and general access's at
 * another, and a check reads whichever this file names. The address is chosen
 * per check, in the shell, so a change here takes effect at the next check
 * with no restart.
 */
import { useSyncExternalStore } from "react";

/**
 * The two channels, spelled as the control plane spells them.
 *
 * Deliberately the same two words as the API's `Channel`, and deliberately not
 * that type: a copy's channel is Firetower's own construct — a local
 * preference plus a manifest at a second address — and importing the server's
 * enum here would suggest the server has a say in it. One vocabulary, two
 * owners.
 */
export type AppChannel = "general" | "beta";

const CHANNELS: AppChannel[] = ["general", "beta"];

const KEY = "firetower.channel";
/** Which channel's manifest served the build this copy is running. */
const FROM = "firetower.channel.installed";

/**
 * Where each channel's manifest lives.
 *
 * `null` means "use the address compiled into this bundle", which is the
 * permanent alias of general access — the one address every copy predating
 * channels reads, and the one that is certain to exist. Keeping general access
 * on it rather than naming `desktop-stable` costs nothing and removes a
 * failure mode: a copy that has never been on beta reads exactly what it read
 * before, and the runtime call is only ever made for the channel that needs
 * one. It is also the fallback the bootstrap wants when the preference below
 * cannot be read at all.
 */
const BETA = "https://github.com/firetower-cloud/firetower/releases/download/desktop-beta/latest.json";

/** The address a check should ask, for a channel. */
export function endpointFor(channel: AppChannel): string | null {
  return channel === "beta" ? BETA : null;
}

/**
 * The stored choice, defaulting to general access.
 *
 * A copy that has never chosen is on general access, which is both the safe
 * answer and the one its compiled address already serves.
 */
export function appChannel(): AppChannel {
  try {
    const held = window.localStorage.getItem(KEY);
    return CHANNELS.includes(held as AppChannel) ? (held as AppChannel) : "general";
  } catch {
    /* A window with no storage. The choice applies to this run and no further,
       and `endpointFor` sends the check to the compiled address. */
    return "general";
  }
}

const watching = new Set<() => void>();

export function setAppChannel(next: AppChannel) {
  if (next === appChannel()) return;
  try {
    window.localStorage.setItem(KEY, next);
  } catch {
    /* As above: it applies now, it just will not survive a restart. */
  }
  for (const tell of watching) tell();
}

/** The choice, as something a screen can subscribe to. */
export function useAppChannel(): AppChannel {
  return useSyncExternalStore(watch, appChannel, () => "general" as AppChannel);
}

function watch(onChange: () => void): () => void {
  watching.add(onChange);
  return () => void watching.delete(onChange);
}

/**
 * Which channel the running build came from.
 *
 * Written before an install, because the install relaunches and whatever is
 * not in storage by then is lost. It carries the version with it and is only
 * believed when the two agree: an install that failed after this was written
 * would otherwise leave a copy claiming a provenance for a build it never ran.
 *
 * `null` for a build installed by hand, and for every copy that has not taken
 * an update since this shipped. That is the honest answer — "we do not know
 * where this came from" — and the screen says nothing rather than guessing.
 */
export function installedFrom(version: string | null): AppChannel | null {
  if (!version) return null;
  try {
    const held = window.localStorage.getItem(FROM);
    if (!held) return null;
    const [said, channel] = held.split(" ");
    return said === version && CHANNELS.includes(channel as AppChannel)
      ? (channel as AppChannel)
      : null;
  } catch {
    return null;
  }
}

/** Remember where a build about to be installed came from. */
export function rememberInstalledFrom(version: string, channel: AppChannel) {
  try {
    window.localStorage.setItem(FROM, `${version} ${channel}`);
  } catch {
    /* The version cell loses its "from beta" suffix. Nothing else changes. */
  }
}

/** What a channel is called on screen. */
export function channelName(channel: AppChannel): string {
  return channel === "beta" ? "Beta" : "General access";
}

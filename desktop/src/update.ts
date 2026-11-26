/**
 * Which build this is, which channel it is on, and whether a newer one is out.
 *
 * The app asks its channel's `latest.json`, checks the file's signature against
 * the public key it was built with, and keeps the answer. It asks again every
 * ten minutes, because a window that stays open for a fortnight used to find
 * out about a release by being restarted — which is the one moment nobody is
 * thinking about updates.
 *
 * **The asking moved into the shell** (`src-tauri/src/updater.rs`, reached
 * through `~/update-shell`). A copy's channel is an address, and choosing one
 * at runtime is available only from the shell language — so the whole
 * check / download / install sequence had to go with it, an update being a
 * resource whose handle that side owns. This file is otherwise what it was:
 * the watch, the shared check, and what a failure means.
 *
 * The address is read per check from the local preference, so switching a copy
 * between channels takes effect at the next check and needs no restart. There
 * is no downgrade allowance anywhere in the path: the plugin's "only if newer"
 * rule is what makes leaving beta mean *stop receiving new betas* rather than
 * *put the general-access build back*.
 *
 * A find is said in two places and interrupts in neither: the rail's Updates
 * row reads "Update available" in slate, and the Updates screen offers it.
 * The exception is the first find of a run, still put in front of somebody a
 * few seconds after start-up — nothing is in flight then, so it is the
 * cheapest moment to take it. Everything after that waits to be noticed,
 * because a dialog that reappears every ten minutes is a nag.
 *
 * Taking it downloads, installs and relaunches.
 *
 * Only inside the native shell: a browser tab has nothing to update, so the
 * version is never known, nothing is ever found, and both surfaces stay quiet.
 */
import { useSyncExternalStore } from "react";
import { bridge } from "~/bridge";
import { installedApp } from "~/installed-app";
import type { AppChannel } from "~/channel";
import { appChannel, endpointFor, rememberInstalledFrom } from "~/channel";
import type { Progress } from "~/update-shell";
import { check, install, version as askVersion } from "~/update-shell";

export type Build = {
  /** What this window runs. Null until the shell answers, and in a browser tab. */
  version: string | null;
  /** The build that is out, if a check found a newer one. */
  newer: string | null;
  /** The channel the last check asked. */
  channel: AppChannel;
  /**
   * The channel the manifest that answered said it was, when it said so.
   *
   * Read from the manifest and **never acted on** — the updater has no channel
   * concept and ignores the field. It is here so a copy can say where a build
   * it is being offered came from.
   */
  from: string | null;
  /** How far a download has got, while one is running. */
  taking: Progress | null;
};

/** How often a window asks again. Releases are monthly; windows live for days. */
const EVERY = 10 * 60_000;

const NOTHING: Build = { version: null, newer: null, channel: "general", from: null, taking: null };

/* The same object until something actually changes — `useSyncExternalStore`
   compares what the snapshot returns against what it returned last time, and a
   fresh object on every read is an infinite render. */
let build: Build = NOTHING;
const watching = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** An install in flight. Nothing is re-checked under one. */
let taking = false;
/** The check in flight, so two callers wait on one request. */
let looking: Promise<void> | null = null;

function settle(next: Build) {
  if (
    next.version === build.version &&
    next.newer === build.newer &&
    next.channel === build.channel &&
    next.from === build.from &&
    next.taking === build.taking
  ) {
    return;
  }
  build = next;
  for (const tell of watching) tell();
}

/** One check, shared: the watch and anything that wants a fresh answer now. */
export function look(): Promise<void> {
  looking ??= ask().finally(() => {
    looking = null;
  });
  return looking;
}

async function ask(): Promise<void> {
  if (!installedApp() || taking) return;

  /* Asked once and kept. Its own try, so a shell that will not say which build
     it is does not also cost us the check. */
  if (!build.version) {
    try {
      settle({ ...build, version: await askVersion() });
    } catch {
      /* The row leaves the version out. */
    }
  }

  /* **Twice at most, and only when the preference moved under the check.**
     Somebody presses Beta and the screen asks straight away; if a ten-minute
     check was already in flight against the old address, `look()` hands them
     that one — and an answer for the channel they just left is the thing they
     would notice. So the channel is read before and after, and a check that
     was overtaken is made again. Bounded, because a preference being flipped
     faster than the network answers must not become a loop. */
  for (let attempt = 0; attempt < 2; attempt++) {
    const on = appChannel();
    try {
      const found = await check(endpointFor(on));
      // An install started while we were asking: it owns the held update now.
      if (taking) return;
      settle({ ...build, newer: found?.version ?? null, channel: on, from: found?.channel ?? null });
    } catch {
      // No network, a release with no updater assets, a signature that does not
      // check: all of them mean "not now", none of them is the person's. What a
      // previous check found stands — a dropped connection is not a release
      // being withdrawn. The channel still moves, because the preference did.
      settle({ ...build, channel: on });
    }
    if (appChannel() === on) return;
  }
}

/** What the last check settled on. For anything that is not a component. */
export function currentBuild(): Build {
  return build;
}

/**
 * The same, as something a screen can subscribe to.
 *
 * Subscribing is what starts the watch, so there is no separate thing to
 * remember to start. It is never stopped: the rail reads this on every screen,
 * so there is always a reader, and an interval torn down and rebuilt on every
 * remount is one that asks twice for nothing.
 */
export function useBuild(): Build {
  return useSyncExternalStore(watch, currentBuild, () => NOTHING);
}

function watch(onChange: () => void): () => void {
  watching.add(onChange);
  if (!timer) {
    void look();
    timer = setInterval(() => void look(), EVERY);
  }
  return () => void watching.delete(onChange);
}

/**
 * Take it: download, install, relaunch.
 *
 * What the last check found is what is installed, so the version on the button
 * is the version that arrives. It throws rather than swallowing, because a
 * download that fails after somebody pressed the button has to be readable on
 * the screen they pressed it from.
 *
 * Where the build came from is written down **before** the install, because
 * the install relaunches the window and anything not in storage by then is
 * lost. It is stored with its version and only believed when the two agree, so
 * an install that failed leaves no claim behind.
 */
export async function takeUpdate(): Promise<void> {
  if (!build.newer) throw new Error("There is nothing to install — check again.");
  rememberInstalledFrom(build.newer, build.channel);
  taking = true;
  settle({ ...build, taking: { downloaded: 0, total: null } });
  try {
    await install((p) => settle({ ...build, taking: p }));
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } finally {
    taking = false;
    settle({ ...build, taking: null });
  }
}

/**
 * The failures that replacing the running copy in place produces, as each
 * operating system words them.
 *
 * `std::io::ErrorKind::PermissionDenied` reaches the window as whatever the
 * platform's `strerror` said, so there is a small set of sentences rather than
 * a code to match on — and the same errno arrives spelled either way
 * depending on how deep in the stack it was turned into a string, which is
 * why both the words and the numbers are here.
 *
 * Five errnos, and each one is a real way for this to end:
 *
 *   * `EACCES` (13) and `EROFS` (30) — a directory this account does not own,
 *     and a read-only mount. A file in a read-only mount fails differently
 *     from one in a directory you cannot write to, so both spellings are
 *     listed.
 *   * `ERROR_ACCESS_DENIED` (5) is Windows's own, worded its own way.
 *   * `EPERM` (1) — "Operation not permitted". Not the same as `EACCES`: it
 *     is what an immutable file or a sandbox policy returns, and it reaches a
 *     person who has already checked that they own the directory.
 *   * `ETXTBSY` (26) — "Text file busy", the kernel refusing to open a file
 *     for writing while it is being executed. It is the likeliest of the five
 *     here, because on Linux the file the updater overwrites *is* the program
 *     that is running.
 *
 * The numbers carry a `\b` so that `os error 1` is not also read out of
 * `os error 13`, or `os error 5` out of a timeout's `os error 55`.
 */
const CANNOT_WRITE =
  /permission denied|access is denied|operation not permitted|read-only file system|text file busy|os error (?:1|5|13|26|30)\b/i;

/**
 * What a failed install means, and the next thing to do about it.
 *
 * **"Try it again in a few minutes" is right for most of these and wrong for
 * one.** A download that did not arrive, a release still uploading, a
 * connection that dropped: all of them pass. An update that could not write
 * over the running copy never fixes itself, and telling somebody to wait sends
 * them round the same loop for as long as they are willing to.
 *
 * No platform branch, because there is nothing platform-specific about the
 * answer: an installation this account cannot write to is one on all three,
 * and only the likelihood differs. It is likeliest on Linux, where the
 * download *is* the installation and somebody has very reasonably put it
 * somewhere like `/opt`, and there is no way to ask for privileges mid-update
 * as Windows has. `docs/linux.md` says it the first time; this is the second,
 * to the one person it has already happened to.
 */
export function whyUpdateFailed(e: unknown): string {
  /* A Tauri command rejects with a bare string, so a failure arrives here
     sometimes as an `Error` and sometimes as the sentence itself. Both are
     read, because the one that matters most — the platform's own words about
     a file it would not overwrite — is the half this would otherwise drop. */
  const said = (typeof e === "string" ? e : (e as { message?: string })?.message)?.trim() ?? "";
  if (CANNOT_WRITE.test(said)) {
    return `Firetower could not replace its own files: either it is installed somewhere this account cannot write to, or a copy of it is still running. Move it somewhere you can write to, or close the other copy, and take the update again — waiting on its own will not help. (${said})`;
  }
  /* The plugin's messages are phrases rather than sentences — "the release is
     still uploading" — so the full stop is added here instead of being asked
     for from every place that throws one. */
  const ended = said && !/[.!?]$/.test(said) ? `${said}.` : said;
  return `${ended || "That didn't work."} Try it again in a few minutes.`;
}

/* "Later" is remembered for this run only; a build you skipped is offered
   again next time, because the answer to "later" is later. In between, the
   rail keeps saying so quietly. */
let offered = false;

/**
 * The first find of a run, put in front of somebody. Once.
 *
 * Yes downloads, installs and relaunches. A failure after yes is a notification
 * rather than a dialog — the dialog is gone by then, and the Updates screen is
 * where it can be tried again and read properly.
 */
export async function offerUpdate(
  found: Build,
  ask: (q: { title: string; body: string; action: string }) => Promise<boolean>,
) {
  if (offered || !found.newer) return;
  offered = true;
  const ok = await ask({
    title: `${found.newer} is out.`,
    body: `You are on ${found.version ?? "an older build"}. The update downloads, installs and relaunches Firetower; your servers and their tokens stay.`,
    action: "Update and relaunch",
  });
  if (!ok) return;
  try {
    await takeUpdate();
  } catch (e) {
    bridge.notify("The update did not install", whyUpdateFailed(e));
  }
}

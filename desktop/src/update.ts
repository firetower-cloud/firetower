/**
 * Which build this is, and whether a newer one is out.
 *
 * The app asks the GitHub release's `latest.json`, checks the file's signature
 * against the public key it was built with, and keeps the answer. It asks
 * again every ten minutes, because a window that stays open for a fortnight
 * used to find out about a release by being restarted — which is the one
 * moment nobody is thinking about updates.
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
import type { Update } from "@tauri-apps/plugin-updater";
import { bridge } from "~/bridge";

export type Build = {
  /** What this window runs. Null until the shell answers, and in a browser tab. */
  version: string | null;
  /** The build that is out, if a check found a newer one. */
  newer: string | null;
};

/** How often a window asks again. Releases are monthly; windows live for days. */
const EVERY = 10 * 60_000;

const NOTHING: Build = { version: null, newer: null };

/* The same object until something actually changes — `useSyncExternalStore`
   compares what the snapshot returns against what it returned last time, and a
   fresh object on every read is an infinite render. */
let build: Build = NOTHING;
const watching = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * What the last check found, held for the install rather than fetched twice.
 *
 * It is a handle on a resource the Rust side owns, so the one being replaced
 * is closed: a window open for a day asks a hundred and forty-four times, and
 * a hundred and forty-four of these left open is a leak nobody sees until the
 * shell runs out of them.
 */
let held: Update | null = null;
/** An install in flight. Nothing is re-checked or closed under one. */
let taking = false;
/** The check in flight, so two callers wait on one request. */
let looking: Promise<void> | null = null;

function settle(next: Build) {
  if (next.version === build.version && next.newer === build.newer) return;
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
  if (!bridge.native || taking) return;

  /* Asked once and kept. Its own try, so a shell that will not say which build
     it is does not also cost us the check. */
  if (!build.version) {
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      settle({ ...build, version: await getVersion() });
    } catch {
      /* The row leaves the version out. */
    }
  }

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const found = await check();
    // An install started while we were asking: it is holding `held`.
    if (taking) {
      await found?.close().catch(() => {});
      return;
    }
    const was = held;
    held = found;
    if (was && was !== found) void was.close().catch(() => {});
    settle({ ...build, newer: found?.version ?? null });
  } catch {
    // No network, a release with no updater assets, a signature that does not
    // check: all of them mean "not now", none of them is the person's. What a
    // previous check found stands — a dropped connection is not a release
    // being withdrawn.
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
 */
export async function takeUpdate(): Promise<void> {
  if (!held) throw new Error("There is nothing to install — check again.");
  taking = true;
  try {
    await held.downloadAndInstall();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } finally {
    taking = false;
  }
}

/**
 * The permission failures, as each operating system words them.
 *
 * `std::io::ErrorKind::PermissionDenied` reaches the window as whatever the
 * platform's `strerror` said, so there is a small set of sentences rather than
 * a code to match on. The read-only one is separate because a file in a
 * read-only mount fails differently from one in a directory you do not own.
 */
const CANNOT_WRITE =
  /permission denied|os error 13|access is denied|os error 5|read-only file system|os error 30/i;

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
  const said = (e as { message?: string })?.message?.trim() ?? "";
  if (CANNOT_WRITE.test(said)) {
    return `Firetower could not replace its own files: it is installed somewhere this account cannot write to. Move it somewhere you can write to and take the update again — waiting will not help. (${said})`;
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

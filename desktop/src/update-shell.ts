/**
 * The shell's half of the update path — three calls wide, and no wider.
 *
 * **Why there is a module here at all.** The check, the download and the
 * install now happen in Rust (`src-tauri/src/updater.rs`), because choosing
 * the manifest address at runtime is available only from the shell language
 * and an update is a resource whose handle that side owns. Left at that, the
 * renderer would be calling `invoke("update_check")` from the middle of
 * `update.ts`, and every test of what this app does about a new build would
 * have to assert on the shape of an inter-process call instead of on
 * behaviour.
 *
 * So the boundary is kept here, as a module with three functions. `update.ts`
 * imports it and `update.test.ts` mocks it, which is the same seam the
 * plugin's own module was before — the tests moved one import and kept their
 * subjects.
 *
 * Nothing happens in a browser tab: a tab has no build of its own to move, so
 * a check finds nothing and an install refuses rather than reaching for a
 * bridge that is not there.
 */
import { installedApp } from "~/installed-app";

/** One check's answer. */
export type Found = {
  /** The version the manifest announces. */
  version: string;
  /** The version this copy is running, as the shell knows it. */
  currentVersion: string;
  /** The release's notes, when the manifest carries them. */
  notes: string | null;
  /**
   * The channel the manifest names, **for display only**.
   *
   * The updater has no channel concept; this is a field Firetower's own
   * publish job writes and the plugin ignores. Nothing branches on it — it is
   * here so a copy can say where its build came from.
   */
  channel: string | null;
};

/** How far along a download is. */
export type Progress = { downloaded: number; total: number | null };

/**
 * Ask one address whether there is a newer build.
 *
 * `endpoint` is `null` for "use the one compiled into this bundle", which is
 * the permanent general-access alias — the bootstrap's fallback and the
 * address anything bypassing this path still reads.
 */
export async function check(endpoint: string | null): Promise<Found | null> {
  if (!installedApp()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<Found | null>("update_check", { endpoint });
}

/**
 * Install what the last check found, reporting progress as it downloads.
 *
 * It throws rather than swallowing: a download that fails after somebody
 * pressed the button has to be readable on the screen they pressed it from.
 */
export async function install(onProgress?: (p: Progress) => void): Promise<void> {
  if (!installedApp()) throw new Error("There is nothing to install — check again.");
  const [{ invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ]);
  /* Listening is set up before the install is asked for, because the first
     chunk can land before an `await` later in this function would have got
     round to subscribing — and the progress nobody saw is the progress for
     the first half of a hundred megabytes. */
  const stop = onProgress
    ? await listen<Progress>("update://progress", (e) => onProgress(e.payload))
    : null;
  try {
    await invoke("update_install");
  } finally {
    stop?.();
  }
}

/** What this window is running. Null in a browser tab, and when the shell will not say. */
export async function version(): Promise<string | null> {
  if (!installedApp()) return null;
  const { getVersion } = await import("@tauri-apps/api/app");
  return await getVersion();
}

/**
 * A newer build, offered once at start.
 *
 * The app asks the GitHub release's `latest.json`, checks the file's
 * signature against the public key it was built with, and if there is
 * something newer asks — in the Updates screen's words — whether to take it.
 * Yes downloads, installs and relaunches. No is remembered for this run only;
 * a build you skipped is offered again next time, because the answer to
 * "later" is later.
 *
 * Only inside the native shell: a browser tab has nothing to update.
 */
import { bridge } from "~/bridge";

export async function offerUpdate(ask: (q: { title: string; body: string; action: string }) => Promise<boolean>) {
  if (!bridge.native) return;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return;
    const ok = await ask({
      title: `${update.version} is out.`,
      body: `You are on ${update.currentVersion}. The update downloads, installs and relaunches Firetower; your servers and their tokens stay.`,
      action: "Update and relaunch",
    });
    if (!ok) return;
    await update.downloadAndInstall();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch {
    // No network, a release with no updater assets, a signature that does
    // not check: all of them mean "not now", none of them is the person's.
  }
}

/**
 * Getting something out of a workspace.
 *
 * A workspace is a directory on somebody else's machine that is deleted when
 * the work ends, and until this existed git was the only way anything left
 * one. That was fine while every workspace was a checkout. It is not fine for
 * a workspace with no repository in it — a render, a report, a scrape — where
 * the files the agent made are the whole point and `git push` is not available
 * to save them.
 *
 * Two shapes, because a directory has no single stream of bytes:
 *
 *   * `fileUrl` — the file as it is on disk. Only for a file.
 *   * `archiveUrl` — the path as one zip. A directory, a file, or the whole
 *     workspace when the path is empty.
 *
 * Both are plain URLs handed to `bridge.save`, which is where the two surfaces
 * genuinely differ: the shell asks where to put it and streams it there, a
 * browser tab hands it to the download manager.
 */
import { apiBase, token } from "~/client/http";
import { bridge, type SavePhase } from "~/bridge";

export type { SavePhase };

/** The file itself, byte for byte. */
export function fileUrl(sessionId: string, path: string): string {
  const url = new URL(`${apiBase()}/api/v1/sessions/${sessionId}/file`);
  url.searchParams.set("path", path);
  return url.toString();
}

/** The path as a zip. An empty path is the whole workspace. */
export function archiveUrl(sessionId: string, path: string): string {
  const url = new URL(`${apiBase()}/api/v1/sessions/${sessionId}/archive`);
  if (path) url.searchParams.set("path", path);
  return url.toString();
}

/** `out/clips/one.mp4` → `one.mp4`. What the save sheet should open showing. */
export function leafOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? "workspace";
}

/**
 * Save a file out of a workspace.
 *
 * Resolves to where it landed, or `null` if the save sheet was dismissed —
 * which is not a failure and must not be reported as one.
 */
export function downloadFile(
  sessionId: string,
  path: string,
  onPhase?: (phase: SavePhase) => void,
): Promise<string | null> {
  // Straight to the bytes: nothing is built for this one, the worker opens the
  // file and measures it in a syscall.
  onPhase?.("downloading");
  return bridge.save(fileUrl(sessionId, path), leafOf(path), token(), onPhase);
}

/**
 * Save a path out of a workspace as a zip.
 *
 * The suggested name is the server's business too — it names the whole
 * workspace after the workspace when the path is empty, which this cannot do
 * because it does not know the workspace's name. They agree on the extension
 * and that is all they need to agree on: the sheet opens on this name, and
 * what the server sends is what gets written either way.
 */
export function downloadArchive(
  sessionId: string,
  path: string,
  onPhase?: (phase: SavePhase) => void,
): Promise<string | null> {
  // The zip is built before anything is sent, and on a directory of video that
  // is most of the wait. Said up front rather than inferred, because there is
  // no event for "started deflating" — the first thing anybody hears from the
  // worker is the finished size.
  onPhase?.("compressing");
  return bridge.save(archiveUrl(sessionId, path), `${leafOf(path)}.zip`, token(), onPhase);
}

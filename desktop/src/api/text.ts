"use client";

/**
 * A file out of a workspace, as text — or as a picture.
 *
 * The generated client has `downloadFile`, but it is typed for a binary
 * download and returns nothing — it exists so the Files panel can save a blob.
 * Reading a file *into* a tab is a different question, so it gets its own
 * small thing rather than a cast.
 *
 * Bounded on purpose. A tab is for reading, and a repository always contains
 * something that is not: a lockfile, a minified bundle, a checked-in binary.
 * Past the limit this reports what it is instead of trying to draw it.
 *
 * Images are the exception to "binary means nothing to draw": a screenshot is
 * the thing you wanted to look at. They arrive as a blob URL rather than as a
 * `<img src>` pointed at the endpoint, because the desktop shell's CSP allows
 * `blob:` and `data:` for images but not `http:` — and because the request
 * needs an `authorization` header that an `<img>` cannot send.
 */

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiBase, token, ApiError } from "~/client/http";

/** As much of a file as is worth putting on a screen. */
export const MOST = 512 * 1024;

/**
 * And as much of a picture.
 *
 * Larger than the text cap because the two limits are about different things.
 * 512 KB of text is longer than anyone reads; 512 KB is a *small* screenshot,
 * and a retina capture of a full window is routinely two or three megabytes.
 * Still bounded — it is held in memory here, and the worker refuses anything
 * over 100 MB before this is ever reached.
 */
export const MOST_IMAGE = 10 * 1024 * 1024;

export type Contents =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "image"; url: string; mediaType: string; bytes: number }
  | { kind: "binary"; bytes: number }
  | { kind: "huge"; bytes: number };

/**
 * What a picture's extension says it is.
 *
 * By extension rather than by sniffing the bytes, unlike the binary check
 * below: the magic numbers here are per-format and the browser is going to
 * re-check them anyway when it decodes. A file that lies about its extension
 * renders as a broken image, which is the honest outcome.
 */
const IMAGES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

/** The media type to draw this path as, or nothing if it is not a picture. */
export function imageTypeOf(path: string): string | null {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return IMAGES[ext] ?? null;
}

/** Whether a tab for this path should draw it rather than set it in a gutter. */
export function isImage(path: string): boolean {
  return imageTypeOf(path) !== null;
}

/**
 * What arrived, and what can be done with it.
 *
 * Separate from the request so it can be asked the awkward questions directly:
 * a PNG that is really a text file, a text file with a NUL in it, a screenshot
 * past the cap. The order matters — extension first for pictures, then size,
 * then content — and getting it wrong is how a screenshot ends up described as
 * "a binary file, nothing to draw".
 */
export function decide(path: string, buffer: ArrayBuffer): Contents {
  const media = imageTypeOf(path);

  if (media) {
    // Size before drawing, and the picture's own cap rather than the text one.
    if (buffer.byteLength > MOST_IMAGE) return { kind: "huge", bytes: buffer.byteLength };
    return {
      kind: "image",
      url: URL.createObjectURL(new Blob([buffer], { type: media })),
      mediaType: media,
      bytes: buffer.byteLength,
    };
  }

  if (buffer.byteLength > MOST) return { kind: "huge", bytes: buffer.byteLength };

  const bytes = new Uint8Array(buffer);
  // A NUL in the first few KB is the oldest and still the most reliable
  // test for "this was never meant to be read". Cheaper and less wrong
  // than trusting a file extension, which a repository will lie about.
  if (bytes.subarray(0, 8192).includes(0)) {
    return { kind: "binary", bytes: buffer.byteLength };
  }

  return {
    kind: "text",
    text: new TextDecoder().decode(bytes),
    truncated: false,
  };
}

export function useFileText(sessionId: string, path: string) {
  const media = imageTypeOf(path);
  releaseBlobs(useQueryClient());

  const query = useQuery<Contents, ApiError | Error>({
    queryKey: ["file-text", sessionId, path],
    queryFn: async () => {
      const url = new URL(`${apiBase()}/api/v1/sessions/${sessionId}/file`);
      url.searchParams.set("path", path);

      const auth = token();
      const answer = await fetch(url, {
        headers: auth ? { authorization: `Bearer ${auth}` } : undefined,
      });

      if (!answer.ok) {
        const body = await answer.json().catch(() => null);
        throw new Error(body?.message ?? `Couldn't read that file (${answer.status}).`);
      }

      return decide(path, await answer.arrayBuffer());
    },
    // A file open in a tab while an agent is editing it should catch up, but
    // not so eagerly that reading one costs a request a second.
    //
    // Off for pictures. Each poll would mint a fresh blob URL — a new object
    // held by the browser until it is revoked, and a new `src` for the `<img>`
    // to flash through — so a screenshot left open for an hour would leak
    // three hundred and sixty copies of itself to show you the same pixels.
    refetchInterval: media ? false : 10_000,
    staleTime: 5_000,
  });

  return query;
}

/**
 * Hand a picture's memory back when its cache entry goes.
 *
 * A blob URL is a reference the browser holds until it is revoked, and the
 * obvious place to revoke one — an unmount effect in the tab — is wrong here:
 * React Query keeps the entry for `gcTime` after the last watcher leaves, so
 * switching to the conversation and back would find the cached url already
 * dead and draw a broken image.
 *
 * The cache's own lifetime is the right one, so the revoke is hung off the
 * cache's `removed` event. Registered once per client — the flag is on the
 * client rather than in a module-level set because each backend gets its own,
 * and a client that is thrown away should take its listener with it.
 */
function releaseBlobs(client: QueryClient) {
  const marked = client as QueryClient & { __ftReleasesBlobs?: boolean };
  if (marked.__ftReleasesBlobs) return;
  marked.__ftReleasesBlobs = true;

  client.getQueryCache().subscribe((event) => {
    if (event.type !== "removed") return;
    const data = event.query.state.data as Contents | undefined;
    if (data?.kind === "image") URL.revokeObjectURL(data.url);
  });
}

/** Whether this is something to render rather than to show as code. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

/** The part of a path that identifies it on a tab. */
export function leafOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

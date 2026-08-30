"use client";

/**
 * A file out of a workspace, as text.
 *
 * The generated client has `downloadFile`, but it is typed for a binary
 * download and returns nothing — it exists so the Files panel can save a blob.
 * Reading a file *into* a tab is a different question, so it gets its own
 * small thing rather than a cast.
 *
 * Bounded on purpose. A tab is for reading, and a repository always contains
 * something that is not: a lockfile, a minified bundle, a checked-in binary.
 * Past the limit this reports what it is instead of trying to draw it.
 */

import { useQuery } from "@tanstack/react-query";
import { apiBase, token, ApiError } from "./http";

/** As much of a file as is worth putting on a screen. */
export const MOST = 512 * 1024;

export type Contents =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "binary"; bytes: number }
  | { kind: "huge"; bytes: number };

export function useFileText(sessionId: string, path: string) {
  return useQuery<Contents, ApiError | Error>({
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

      const buffer = await answer.arrayBuffer();
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
    },
    // A file open in a tab while an agent is editing it should catch up, but
    // not so eagerly that reading one costs a request a second.
    refetchInterval: 10_000,
    staleTime: 5_000,
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

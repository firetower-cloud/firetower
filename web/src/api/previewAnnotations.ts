import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiBase, ApiError, token } from "./http";
import { z } from "zod";
import type { PreviewAnnotation, KeepAnnotation } from "./generated/model";
export type {
  ElementSnapshot,
  PreviewAnnotation,
  KeepAnnotation,
} from "./generated/model";

// The picker executes in an untrusted application. Validate its messages before
// allowing them into React state, storage, or an authenticated API request.
export const snapshotSchema = z
  .object({
    path: z
      .string()
      .max(2048)
      .startsWith("/")
      .refine((s) => !/[?#\r\n]/.test(s)),
    selector: z.string().max(2048),
    ancestors: z.array(z.string().max(500)).max(12),
    label: z.string().max(500),
    html: z.string().max(16000),
    capturedAt: z.string().max(64),
    viewport: z
      .array(z.number().finite().min(-10000000).max(10000000))
      .length(2),
    scroll: z.array(z.number().finite().min(-10000000).max(10000000)).length(2),
    bounds: z.array(z.number().finite().min(-10000000).max(10000000)).length(4),
    truncated: z.boolean(),
  })
  .strict();

/** Unlike the main API client, an embedded panel must never navigate to a login
 * form inside an untrusted page. Sign-in is offered in a separate, trusted tab. */
export async function annotationRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  try {
    const auth = token();
    if (auth) headers.set("authorization", `Bearer ${auth}`);
  } catch {
    /* The panel offers a separate window when storage is blocked. */
  }
  const response = await fetch(apiBase() + path, { ...init, headers });
  if (!response.ok) throw await ApiError.from(response);
  return response.json() as Promise<T>;
}
const endpoint = (session: string) =>
  `/api/v1/sessions/${encodeURIComponent(session)}/annotations`;
export function usePreviewAnnotations(session: string, enabled = true) {
  const client = useQueryClient();
  const key = ["preview-annotations", session];
  const query = useQuery({
    queryKey: key,
    queryFn: () => annotationRequest<PreviewAnnotation[]>(endpoint(session)),
    enabled: enabled && !!session,
    refetchInterval: 3000,
    retry: false,
  });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  return {
    ...query,
    notes: query.data ?? [],
    refresh,
    keep: async (note: KeepAnnotation) => {
      const saved = await annotationRequest<PreviewAnnotation>(
        endpoint(session),
        { method: "PUT", body: JSON.stringify(note) },
      );
      await refresh();
      return saved;
    },
    drop: async (notes: PreviewAnnotation[]) => {
      await annotationRequest(endpoint(session), {
        method: "DELETE",
        body: JSON.stringify({
          notes: notes.map(({ id, revision }) => ({ id, revision })),
        }),
      });
      await refresh();
    },
    send: async (notes: PreviewAnnotation[]) => {
      try {
        await annotationRequest(endpoint(session) + "/send", {
          method: "POST",
          body: JSON.stringify({
            notes: notes.map(({ id, revision }) => ({ id, revision })),
          }),
        });
      } finally {
        await refresh();
      }
    },
  };
}

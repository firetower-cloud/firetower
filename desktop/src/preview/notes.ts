/**
 * Notes on a preview, kept on the control plane.
 *
 * The same endpoints the web's panel uses — `annotations` to list, keep and
 * drop, `annotations/send` to hand a set to the agent as one turn. The
 * control plane commits a "sending" marker before it contacts the worker, so
 * a retry after a lost acknowledgement never becomes a second turn.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { http } from "~/client/http";
import type { KeepAnnotation, PreviewAnnotation } from "@/src/api/generated/model";

const at = (session: string) => `/api/v1/sessions/${encodeURIComponent(session)}/annotations`;
const json = (body: unknown): RequestInit => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function usePreviewNotes(session: string, port: number, enabled: boolean) {
  const cache = useQueryClient();
  const key = ["preview-annotations", session];
  const query = useQuery({
    queryKey: key,
    queryFn: () => http<PreviewAnnotation[]>(at(session)),
    enabled,
    refetchInterval: 3000,
    retry: false,
  });
  const refresh = () => cache.invalidateQueries({ queryKey: key });
  const all = query.data ?? [];
  const notes = all.filter((n) => n.port === port);

  const keep = useMutation({
    mutationFn: (note: KeepAnnotation) => http<PreviewAnnotation>(at(session), { method: "PUT", ...json(note) }),
    onSettled: refresh,
  });
  const drop = useMutation({
    mutationFn: (which: PreviewAnnotation[]) =>
      http<unknown>(at(session), { method: "DELETE", ...json({ notes: which.map(({ id, revision }) => ({ id, revision })) }) }),
    onSettled: refresh,
  });
  const send = useMutation({
    mutationFn: (which: PreviewAnnotation[]) =>
      http<unknown>(`${at(session)}/send`, { method: "POST", ...json({ notes: which.map(({ id, revision }) => ({ id, revision })) }) }),
    onSettled: refresh,
  });

  return { notes, loading: query.isPending && enabled, error: query.error, keep, drop, send, refresh };
}

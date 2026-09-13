/**
 * Shipping what the agent did.
 *
 * `src/api/ship.ts` is the contract: `shipping(session, work)` reduces every
 * checkout's state to one stage — uncommitted → unpushed → pushed → open — and
 * one honest label for the button. This draws that, then runs the sequence the
 * web's ShipSheet runs: commit the kept files with the title as the message,
 * push, and open the pull request with the body and its issue trailer.
 *
 * The title and body come from `describe_session` — the run's own proposal —
 * and are a draft to edit, not a box to fill. Nothing acts on them until the
 * button.
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GitBranch, GitPullRequest, Loader2, RefreshCw } from "lucide-react";
import type { Session } from "@/src/api/generated/model";
import {
  getGetSessionQueryKey,
  getListSessionsQueryKey,
  getSessionWorkQueryKey,
  useCommitSession,
  useDescribeSession,
  useOpenPullRequest,
  usePushSession,
  useSessionWork,
} from "@/src/api/generated/sessions/sessions";
import { awaiting, done, shipping } from "@/src/api/ship";
import { idOf, label as refLabel, parseReference, withTrailer, type Reference } from "@/src/api/issues";
import { isLive } from "~/mock/http";
import { shipFor } from "~/mock/backends";
import type { Changed } from "~/ui/Inspector";

import { why } from "~/data";

export function Ship({ session, branch, files }: { session: Session; branch?: string; files: Changed[] }) {
  const live = isLive();
  const cache = useQueryClient();

  const { data: work, isError: workFailed } = useSessionWork(session.id, {
    query: {
      enabled: live,
      // Faster while a request is open and its merge is what changes next.
      refetchInterval: (q) => (q.state.data && awaiting(shipping(session, q.state.data)) ? 5_000 : 30_000),
    },
  });
  const ship = live ? shipping(session, work, workFailed) : fixtureShip(session);

  const describe = useDescribeSession();
  const commit = useCommitSession();
  const push = usePushSession();
  const open = useOpenPullRequest();

  const [title, setTitle] = useState(session.proposedTitle ?? "");
  const [body, setBody] = useState(session.proposedBody ?? "");
  const [draft, setDraft] = useState(false);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const within = session.repo ?? undefined;
  const [refs, setRefs] = useState<Reference[]>(() => {
    const r = session.taskKey ? parseReference(session.taskKey, within) : null;
    return r ? [r] : [];
  });
  const [typedRef, setTypedRef] = useState("");

  const keeping = files.filter((f) => !leaving.has(f.path));
  const added = keeping.reduce((n, f) => n + f.added, 0);
  const removed = keeping.reduce((n, f) => n + f.removed, 0);

  /* Asked once when there is something to describe and nothing written yet. */
  useEffect(() => {
    if (!live || title || describe.isPending || describe.isSuccess || files.length === 0) return;
    describe.mutate({ id: session.id }, { onSuccess: (p) => { setTitle(p.title); setBody(p.body); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, files.length]);

  const refresh = () =>
    Promise.all([
      cache.invalidateQueries({ queryKey: getSessionWorkQueryKey(session.id) }),
      cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) }),
      cache.invalidateQueries({ queryKey: getListSessionsQueryKey() }),
    ]);

  const opening = ship.stage === "uncommitted" || ship.stage === "unpushed" || ship.stage === "pushed";

  const go = async () => {
    if (!live) return;
    setTrouble(null);
    try {
      if (ship.stage === "uncommitted") {
        setStep(`Committing ${keeping.length} files`);
        await commit.mutateAsync({ id: session.id, data: { message: title.trim() || null, paths: keeping.map((f) => f.path) } });
      }
      if (ship.stage === "uncommitted" || ship.stage === "unpushed" || ship.stage === "open-behind") {
        setStep(`Pushing ${branch ?? "the branch"}`);
        await push.mutateAsync({ id: session.id });
      }
      if (opening) {
        setStep("Opening the pull request");
        const made = await open.mutateAsync({ id: session.id, data: { title: title.trim() || null, body: withTrailer(body, refs, within), draft } });
        window.open(made.url, "_blank", "noreferrer");
      }
      await refresh();
    } catch (e) {
      setTrouble(why(e) ?? "That didn't work.");
    } finally {
      setStep(null);
    }
  };

  const busy = !!step;

  return (
    <div className="p-3.5">
      <div className="flex items-center gap-2 font-mono text-meta text-mute">
        <GitBranch className="h-3.5 w-3.5" strokeWidth={1.75} />
        <span className="truncate text-dim">{branch}</span>
        <span>→</span>
        <span>{work?.[0]?.base ?? session.base ?? "main"}</span>
      </div>

      {done(ship) ? (
        <div className="mt-4 rounded-lg border border-line bg-ground px-3 py-3">
          <p className="flex items-center gap-2 text-ui text-sage"><GitPullRequest className="h-4 w-4" strokeWidth={1.75} />{ship.stage === "merged" ? "Merged." : ship.stage === "closed" ? "Closed without merging." : "The pull request is open."}</p>
          {ship.links.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="control mt-2 w-full justify-center border border-line bg-raise text-bone hover:bg-overlay">Open it on GitHub</a>
          ))}
        </div>
      ) : (
        <>
          {ship.stage === "unknown" && <p className="mt-3 text-meta text-kind-data">{ship.blocked}</p>}

          {(ship.stage === "uncommitted" || opening) && (
            <>
              <div className="mt-3.5 flex items-center gap-2">
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={describe.isPending ? "Describing the change…" : "Title"} className="min-w-0 flex-1 rounded-lg border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" />
                <button disabled={describe.isPending || !live} onClick={() => describe.mutate({ id: session.id }, { onSuccess: (p) => { setTitle(p.title); setBody(p.body); } })} title="Ask the run to describe itself again" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-ground text-mute hover:text-bone disabled:opacity-50">
                  {describe.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />}
                </button>
              </div>
              <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What this does, and why." className="scroll-slim mt-2 w-full resize-none rounded-lg border border-line bg-ground px-3 py-2 text-meta leading-relaxed text-text placeholder:text-mute focus:border-slate-deep focus:outline-none" />
            </>
          )}

          {ship.stage === "uncommitted" && (
            <div className="mt-3.5">
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="text-ui text-dim">{keeping.length} of {files.length} files</span>
                <span className="font-mono text-micro text-mute"><span className="text-sage">+{added}</span> <span className="text-brick">−{removed}</span></span>
              </div>
              <div className="overflow-hidden rounded-lg border border-line">
                {files.map((f) => {
                  const going = !leaving.has(f.path);
                  return (
                    <button key={f.path} onClick={() => setLeaving((h) => { const n = new Set(h); n.has(f.path) ? n.delete(f.path) : n.add(f.path); return n; })} className="flex w-full items-center gap-2.5 border-b border-line-soft px-2.5 py-2 text-left last:border-0 transition-colors hover:bg-raise/60">
                      <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${going ? "border-sage-deep bg-sage-tint text-sage" : "border-line text-transparent"}`}>
                        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 fill-none stroke-current stroke-2"><path d="M1.5 5.2 4 7.5 8.5 2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </span>
                      <span className={`min-w-0 flex-1 truncate font-mono text-meta ${going ? "text-dim" : "text-mute line-through"}`}>{f.path}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {opening && (
            <div className="mt-3.5">
              <div className="flex flex-wrap items-center gap-1.5">
                {refs.map((r, i) => (
                  <span key={idOf(r)} className="flex items-center gap-1.5 rounded-md border border-line bg-ground px-2 py-1 font-mono text-micro text-dim">
                    {refLabel(r, within)}
                    <button onClick={() => setRefs(refs.filter((_, n) => n !== i))} className="text-mute hover:text-bone">×</button>
                  </span>
                ))}
                <input
                  value={typedRef}
                  onChange={(e) => setTypedRef(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    const r = parseReference(typedRef.trim(), within);
                    if (r && !refs.some((h) => idOf(h) === idOf(r))) setRefs([...refs, r]);
                    setTypedRef("");
                  }}
                  placeholder={refs.length ? "+ #issue" : "Closes #issue"}
                  className="min-w-[7rem] flex-1 rounded-md border border-line bg-ground px-2 py-1 font-mono text-micro text-bone placeholder:text-mute focus:outline-none"
                />
              </div>
              <label className="mt-2.5 flex items-center gap-2 text-meta text-dim">
                <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
                Open as a draft
              </label>
            </div>
          )}

          {trouble && <p className="mt-3 rounded-lg border border-brick-deep bg-brick-tint px-3 py-2 font-mono text-meta text-brick">{trouble}</p>}

          <button
            disabled={busy || !live || !!ship.blocked || (ship.stage === "uncommitted" && keeping.length === 0)}
            onClick={go}
            title={ship.blocked ?? undefined}
            className="control mt-3.5 w-full justify-center border border-sage-deep bg-sage-tint font-medium text-sage transition-colors hover:bg-sage-deep/40 disabled:border-line disabled:bg-raise disabled:text-mute"
          >
            {step ? <><Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />{step}</> : ship.label}
          </button>
          {!live && <p className="mt-2 text-center text-micro text-mute">A fixture: nothing is committed.</p>}
        </>
      )}
    </div>
  );
}

/** The demo's stage, in the real shape. */
function fixtureShip(session: Session): ReturnType<typeof shipping> {
  const s = shipFor(session.workspaceId ?? session.id);
  const stage = s.stage === "open" ? "open" : s.stage;
  return { stage, label: s.label, links: s.stage === "open" ? [{ slug: session.repo ?? "", url: session.pullRequest ?? "#" }] : [], count: s.files.length } as ReturnType<typeof shipping>;
}

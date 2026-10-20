/**
 * Shipping what the agent did.
 *
 * `src/api/ship.ts` is the contract: `shipping(session, work)` reduces every
 * checkout's state to one stage — uncommitted → unpushed → pushed → open — and
 * one honest label for the button. This draws that, then runs the sequence the
 * web's ShipSheet runs: commit the kept files with the title as the message,
 * push, and open the request with the body and its issue trailer.
 *
 * **What the request is called comes from the host.** GitLab says merge
 * request, GitHub and Gitea say pull request, and the word reaches the button,
 * the sequence above it and the link out — so it is read once from the git host
 * this session's repository is on and passed to `shipping`.
 *
 * The title and body come from `describe_session` — the run's own proposal —
 * and are a draft to edit, not a box to fill. Nothing acts on them until the
 * button.
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, GitBranch, GitPullRequest, Loader2, RefreshCw } from "lucide-react";
import type { Session } from "~/api/generated/model";
import {
  getGetSessionQueryKey,
  getListSessionsQueryKey,
  getSessionWorkQueryKey,
  useCommitSession,
  useDescribeSession,
  useOpenPullRequest,
  usePushSession,
  useSessionWork,
} from "~/api/generated/sessions/sessions";
import {
  awaiting,
  berths,
  byDirectory,
  done,
  leafOf,
  middled,
  requestFor,
  shipping,
  type Berth,
  type Said,
} from "~/api/ship";
import { idOf, label as refLabel, parseReference, withTrailer, type Reference } from "~/api/issues";
import type { Changed } from "~/ui/Inspector";

import { HostMark } from "~/components/ui";
import { useHostOf, why } from "~/data";
import { openExternal } from "~/open";

export function Ship({ session, branch, files }: { session: Session; branch?: string; files: Changed[] }) {
  const cache = useQueryClient();
  const hostOf = useHostOf();
  const host = hostOf(session.repo);
  const noun = host?.changeNoun ?? "pull request";
  /* Sentence-initial, for the lines that start with it. */
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);

  const { data: work, isError: workFailed } = useSessionWork(session.id, {
    query: {
      // Faster while a request is open and its merge is what changes next.
      refetchInterval: (q) =>
        q.state.data && awaiting(shipping(session, q.state.data, false, noun)) ? 5_000 : 30_000,
    },
  });
  const ship = shipping(session, work, workFailed, noun);
  /* Each repository's own noun — a GitLab beside a GitHub says the right word
     in its own section rather than borrowing the session's. */
  const nounFor = (slug: string) => hostOf(slug)?.changeNoun ?? "pull request";
  /* **One section per repository, once there is more than one.** A single
     stage for a session is a lie the moment two repositories are at different
     steps — one pushed and one rejected reduced to a label describing neither,
     and the failure named a branch with no repository beside it. */
  const perRepo = useMemo(
    () => berths(session, work, files, workFailed, nounFor),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, work, files, workFailed],
  );
  const many = perRepo.length > 1;

  const describe = useDescribeSession();
  const commit = useCommitSession();
  const push = usePushSession();
  const open = useOpenPullRequest();

  const [title, setTitle] = useState(session.proposedTitle ?? "");
  const [body, setBody] = useState(session.proposedBody ?? "");
  const [draft, setDraft] = useState(false);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<string | null>(null);
  /* The foot button's key, which is not a checkout path. */
  const ALL = "*";
  /* Which button is running, so only that one spins. */
  const [busyAt, setBusyAt] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const within = session.repo ?? undefined;
  const [refs, setRefs] = useState<Reference[]>(() => {
    const r = session.taskKey ? parseReference(session.taskKey, within) : null;
    return r ? [r] : [];
  });
  const [typedRef, setTypedRef] = useState("");

  /**
   * What a repository says for itself, where it has been asked to differ.
   *
   * Keyed by checkout path, and **absent means "follow the shared block"** —
   * not "empty". Most sessions that touch two repositories are one piece of
   * work across a boundary, so the common case has to stay one title typed
   * once; an override is an edit somebody asks for, and until they do the
   * section tracks the block above it live.
   */
  const [own, setOwn] = useState<Record<string, Said>>({});
  const saidFor = (at: string): Said =>
    own[at] ?? { title, body, refs, draft };
  const customise = (at: string) =>
    setOwn((h) => ({ ...h, [at]: { title, body, refs: [...refs], draft } }));
  const follow = (at: string) =>
    setOwn((h) => {
      const n = { ...h };
      delete n[at];
      return n;
    });

  /* One place that flips a file, because the grouped list flips a whole
     directory by calling it for each of its own. */
  const toggle = (paths: string[]) =>
    setLeaving((held) => {
      const next = new Set(held);
      const anyKept = paths.some((p) => !next.has(p));
      for (const p of paths) {
        if (anyKept) next.add(p);
        else next.delete(p);
      }
      return next;
    });

  const keeping = files.filter((f) => !leaving.has(f.path));
  const added = keeping.reduce((n, f) => n + f.added, 0);
  const removed = keeping.reduce((n, f) => n + f.removed, 0);

  /* Asked once when there is something to describe and nothing written yet. */
  useEffect(() => {
    if (title || describe.isPending || describe.isSuccess || files.length === 0) return;
    describe.mutate({ id: session.id }, { onSuccess: (p) => { setTitle(p.title); setBody(p.body); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.length]);

  const refresh = () =>
    Promise.all([
      cache.invalidateQueries({ queryKey: getSessionWorkQueryKey(session.id) }),
      cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) }),
      cache.invalidateQueries({ queryKey: getListSessionsQueryKey() }),
      // Committing empties the working-tree diff; the tree's marks follow.
      cache.invalidateQueries({ queryKey: [`/api/v1/sessions/${session.id}/diff`] }),
    ]);

  // Not for a session that is creating the trunk: there is no branch on the
  // far end to open a request against, and every host refuses one. `shipping`
  // has already said so in the label, and this is the sequence that label names.
  const opening =
    !ship.seeds &&
    (ship.stage === "uncommitted" || ship.stage === "unpushed" || ship.stage === "pushed");

  /**
   * Run the sequence — for the whole session, or for one repository.
   *
   * `at` is a checkout path. Absent means every one, which is what the foot
   * button sends and what every caller sent before repositories could be
   * acted on singly. The stage comes from whichever is being shipped, so a
   * repository that is merely unpushed does not get committed again because
   * its neighbour has uncommitted work.
   */
  /**
   * Ship one repository: commit what it keeps, push it, open its request.
   *
   * **The trailer is built against *this* repository**, which is the whole
   * reason `withTrailer` takes a slug. A closing keyword only closes an issue
   * in its own repository, so a bare `#42` belonging to the API repo has to
   * come out as `Refs acme/api#42` in the web one — qualified, and downgraded
   * because it cannot close across a boundary. Computed once with the
   * session's repository and broadcast, as it was, the same `Closes #42` went
   * into both requests and merging the second closed an unrelated issue.
   */
  const one = async (b: Berth<Changed>) => {
    const at = b.checkout.path ?? "";
    const said = saidFor(at);
    const mine = b.files.filter((f) => !leaving.has(f.path));
    const { stage, seeds } = b.ship;
    setBusyAt(at);

    if (stage === "uncommitted") {
      setStep(`Committing ${mine.length} files in ${b.checkout.slug}`);
      await commit.mutateAsync({
        id: session.id,
        data: { message: said.title.trim() || null, paths: mine.map((f) => f.path), checkout: at },
      });
    }
    if (stage === "uncommitted" || stage === "unpushed" || stage === "open-behind") {
      setStep(seeds ? "Pushing, and creating the trunk" : `Pushing ${b.checkout.branch}`);
      await push.mutateAsync({ id: session.id, data: { checkout: at } });
    }
    if (!seeds && (stage === "uncommitted" || stage === "unpushed" || stage === "pushed")) {
      setStep(`Opening the ${nounFor(b.checkout.slug)}`);
      const made = await open.mutateAsync({
        id: session.id,
        data: { ...requestFor(said, b.checkout.slug), checkout: at },
      });
      void openExternal(made.url);
    }
  };

  /**
   * One repository, or all of them in turn.
   *
   * Even the foot button goes repository by repository rather than sending one
   * request with no checkout: each needs its own trailer, and once a section
   * can be customised, its own words too.
   */
  const go = async (only?: Berth<Changed>) => {
    setTrouble(null);
    const queue = only ? [only] : perRepo.filter((b) => !done(b.ship) && !b.ship.blocked);
    try {
      if (queue.length === 0) {
        // Nothing resolved yet — the old whole-session call, which is still
        // right when the work list has not arrived.
        setBusyAt(ALL);
        await push.mutateAsync({ id: session.id, data: { checkout: undefined } });
      }
      for (const b of queue) {
        if (!only) setBusyAt(ALL);
        await one(b);
      }
      await refresh();
    } catch (e) {
      setTrouble(why(e) ?? "That didn't work.");
    } finally {
      setStep(null);
      setBusyAt(null);
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
          <p className="flex items-center gap-2 text-ui text-sage"><GitPullRequest className="h-4 w-4" strokeWidth={1.75} />{ship.stage === "merged" ? "Merged." : ship.stage === "closed" ? "Closed without merging." : `The ${noun} is open.`}</p>
          {ship.links.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="control mt-2 w-full justify-center border border-line bg-raise text-bone hover:bg-overlay">Open it on {hostOf(l.slug)?.label ?? host?.label ?? "the host"}</a>
          ))}
        </div>
      ) : (
        <>
          {/* **The request that is already out, while there is still work to
              do.** `ship.links` was only drawn under `done`, so a branch with
              a request open and an uncommitted file showed no sign of it —
              the sheet read as though nothing had ever been opened, which is
              exactly what it was reported as. Quiet, because the button below
              is still the thing to press; present, because "there is already
              one of these" changes what that button means. */}
          {ship.links.length > 0 && (
            <div className="mt-3 space-y-1">
              {ship.links.map((l) => (
                <a
                  key={l.url}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 text-meta text-mute hover:text-bone"
                >
                  <GitPullRequest className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                  <span className="truncate">
                    {/* What became of it, not merely that it exists. "Already
                        opened" over a button reading "open a new one" is two
                        lines disagreeing about the same request — and the one
                        that resolves it is the state. */}
                    {l.state === "merged"
                      ? `${Noun} merged — these commits need a new one`
                      : l.state === "closed"
                        ? `${Noun} closed without merging`
                        : ship.stage === "open-behind"
                          ? `The ${noun} is open — pushing updates it`
                          : `The ${noun} is open`}
                  </span>
                  <ExternalLink className="h-3 w-3 shrink-0" strokeWidth={1.75} />
                </a>
              ))}
            </div>
          )}

          {ship.stage === "unknown" && <p className="mt-3 text-meta text-kind-data">{ship.blocked}</p>}

          {(ship.stage === "uncommitted" || opening) && (
            <>
              <div className="mt-3.5 flex items-center gap-2">
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={describe.isPending ? "Describing the change…" : "Title"} className="min-w-0 flex-1 rounded-lg border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" />
                <button disabled={describe.isPending} onClick={() => describe.mutate({ id: session.id }, { onSuccess: (p) => { setTitle(p.title); setBody(p.body); } })} title="Ask the run to describe itself again" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-ground text-mute hover:text-bone disabled:opacity-50">
                  {describe.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />}
                </button>
              </div>
              <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What this does, and why." className="scroll-slim mt-2 w-full resize-none rounded-lg border border-line bg-ground px-3 py-2 text-meta leading-relaxed text-text placeholder:text-mute focus:border-slate-deep focus:outline-none" />
            </>
          )}

          {many
            ? perRepo.map((b) => (
                <Berthed
                  key={b.checkout.path ?? b.checkout.slug}
                  berth={b}
                  noun={nounFor(b.checkout.slug)}
                  kind={hostOf(b.checkout.slug)?.kind}
                  leaving={leaving}
                  onToggle={toggle}
                  busy={busyAt === (b.checkout.path ?? "")}
                  anyBusy={busyAt !== null}
                  step={step}
                  onGo={() => void go(b)}
                  said={saidFor(b.checkout.path ?? "")}
                  mine={!!own[b.checkout.path ?? ""]}
                  onCustomise={() => customise(b.checkout.path ?? "")}
                  onFollow={() => follow(b.checkout.path ?? "")}
                  onSay={(said) => setOwn((h) => ({ ...h, [b.checkout.path ?? ""]: said }))}
                />
              ))
            : ship.stage === "uncommitted" && (
                <div className="mt-3.5">
                  <div className="mb-1.5 flex items-baseline justify-between">
                    <span className="text-ui text-dim">{keeping.length} of {files.length} files</span>
                    <span className="font-mono text-micro text-mute"><span className="text-sage">+{added}</span> <span className="text-brick">−{removed}</span></span>
                  </div>
                  <Files files={files} checkout="" single leaving={leaving} onToggle={toggle} />
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
            disabled={busy || !!ship.blocked || (ship.stage === "uncommitted" && keeping.length === 0)}
            onClick={() => void go()}
            title={ship.blocked ?? undefined}
            className="control mt-3.5 w-full justify-center border border-sage-deep bg-sage-tint font-medium text-sage transition-colors hover:bg-sage-deep/40 disabled:border-line disabled:bg-raise disabled:text-mute"
          >
            {busyAt === ALL && step ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />{step}</>
            ) : many ? (
              `Ship all ${perRepo.length} repositories`
            ) : (
              ship.label
            )}
          </button>
        </>
      )}
    </div>
  );
}

/* ── One repository's section ──────────────────────────────────────────── */

/**
 * One repository, collapsed to a line until it is opened.
 *
 * The header carries everything you need without opening it: which repository,
 * which branch it is going to, what step it is at, and whether it failed. That
 * is the whole point — a session holding two repositories used to show one
 * branch line, one file list and one button, so "one pushed, one rejected" had
 * nowhere to be said.
 *
 * Open by default while there is still something to decide, shut once the work
 * is out: a merged repository is a line, and the one with eighty-one files
 * waiting is the one you want in front of you.
 */
function Berthed({
  berth,
  noun,
  kind,
  leaving,
  onToggle,
  busy,
  anyBusy,
  step,
  onGo,
  said,
  mine,
  onCustomise,
  onFollow,
  onSay,
}: {
  berth: Berth<Changed>;
  noun: string;
  kind?: string;
  leaving: Set<string>;
  onToggle: (paths: string[]) => void;
  busy: boolean;
  anyBusy: boolean;
  step: string | null;
  onGo: () => void;
  /** What this repository will say — the shared words until it is customised. */
  said: Said;
  /** Whether it has words of its own. */
  mine: boolean;
  onCustomise: () => void;
  onFollow: () => void;
  onSay: (said: Said) => void;
}) {
  const { checkout: c, ship, files } = berth;
  const settled = done(ship);
  const [shut, setShut] = useState(settled);
  const open = !shut;

  const kept = files.filter((f) => !leaving.has(f.path));
  const added = kept.reduce((n, f) => n + f.added, 0);
  const removed = kept.reduce((n, f) => n + f.removed, 0);
  const nothingKept = ship.stage === "uncommitted" && kept.length === 0;

  return (
    <div className="mt-2.5 overflow-hidden rounded-lg border border-line">
      <button
        onClick={() => setShut(!shut)}
        className="flex w-full items-center gap-2.5 bg-raise px-2.5 py-2 text-left"
      >
        <HostMark kind={kind} size={13} className="shrink-0 text-mute" />
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-bone">{c.slug}</span>
        <span className="shrink-0 font-mono text-micro text-mute">
          {files.length > 0 ? `${files.length} file${files.length === 1 ? "" : "s"}` : ship.stage}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-mute transition-transform ${open ? "" : "-rotate-90"}`}
          strokeWidth={2}
        />
      </button>

      {open && (
        <div className="border-t border-line px-2.5 py-2">
          <div className="flex items-center gap-2 font-mono text-micro text-mute">
            <GitBranch className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            <span className="truncate text-dim">{c.branch}</span>
            <span>→</span>
            <span>{c.base ?? "main"}</span>
          </div>

          {ship.links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 flex items-center gap-2 text-meta text-mute hover:text-bone"
            >
              <GitPullRequest className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
              <span className="truncate">
                {l.state === "merged"
                  ? `${noun} merged`
                  : l.state === "closed"
                    ? `${noun} closed without merging`
                    : `The ${noun} is open`}
              </span>
              <ExternalLink className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            </a>
          ))}

          {ship.blocked && <p className="mt-1.5 text-meta text-kind-data">{ship.blocked}</p>}

          {files.length > 0 && (
            <>
              <div className="mt-2 mb-1 flex items-baseline justify-between">
                <span className="text-meta text-dim">
                  {kept.length} of {files.length} files
                </span>
                <span className="font-mono text-micro text-mute">
                  <span className="text-sage">+{added}</span> <span className="text-brick">−{removed}</span>
                </span>
              </div>
              <Files
                files={files}
                checkout={c.path ?? ""}
                single={false}
                leaving={leaving}
                onToggle={onToggle}
              />
            </>
          )}

          {/* **Its own words, where it has asked for them.** A line until
              then: most sessions holding two repositories are one change
              across a boundary, and making everybody write two titles to
              serve the minority that are not is a tax on the common case. */}
          {!settled && (
            <div className="mt-2 border-t border-line-soft pt-2">
              {mine ? (
                <>
                  <div className="flex items-center gap-2 text-micro text-kind-data">
                    Its own message
                    <button onClick={onFollow} className="ml-auto text-mute underline decoration-line underline-offset-2 hover:text-bone">
                      use the shared one
                    </button>
                  </div>
                  <input
                    value={said.title}
                    onChange={(e) => onSay({ ...said, title: e.target.value })}
                    placeholder="Title"
                    className="mt-1.5 w-full rounded-md border border-line bg-ground px-2 py-1 text-meta text-bone placeholder:text-mute focus:outline-none"
                  />
                  <textarea
                    rows={3}
                    value={said.body}
                    onChange={(e) => onSay({ ...said, body: e.target.value })}
                    placeholder="What this does, and why."
                    className="scroll-slim mt-1.5 w-full resize-none rounded-md border border-line bg-ground px-2 py-1 text-micro leading-relaxed text-text placeholder:text-mute focus:outline-none"
                  />
                  <Refs
                    refs={said.refs}
                    within={c.slug}
                    onChange={(refs) => onSay({ ...said, refs })}
                  />
                  <label className="mt-1.5 flex items-center gap-2 text-micro text-dim">
                    <input
                      type="checkbox"
                      checked={said.draft}
                      onChange={(e) => onSay({ ...said, draft: e.target.checked })}
                    />
                    Open as a draft
                  </label>
                </>
              ) : (
                <button
                  onClick={onCustomise}
                  className="text-micro text-mute underline decoration-line underline-offset-2 hover:text-bone"
                >
                  Customise the message for {c.slug}
                </button>
              )}
            </div>
          )}

          {!settled && (
            <button
              disabled={anyBusy || !!ship.blocked || nothingKept}
              onClick={onGo}
              title={ship.blocked ?? undefined}
              className="control mt-2 w-full justify-center border border-line bg-ground text-bone transition-colors hover:bg-overlay disabled:text-mute"
            >
              {busy && step ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />{step}</>
              ) : (
                ship.label
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The references a request will carry, as chips you can add to and remove.
 *
 * `within` is the repository this one opens in, so a reference belonging
 * somewhere else is drawn qualified — `acme/api#42` rather than `#42` — which
 * is also exactly how it will be written into the body. What you see is what
 * the trailer says.
 */
function Refs({
  refs,
  within,
  onChange,
}: {
  refs: Reference[];
  within?: string;
  onChange: (refs: Reference[]) => void;
}) {
  const [typed, setTyped] = useState("");
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {refs.map((r, i) => (
        <span
          key={idOf(r)}
          className="flex items-center gap-1.5 rounded-md border border-line bg-ground px-1.5 py-0.5 font-mono text-micro text-dim"
        >
          {refLabel(r, within)}
          <button onClick={() => onChange(refs.filter((_, n) => n !== i))} className="text-mute hover:text-bone">
            ×
          </button>
        </span>
      ))}
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          const r = parseReference(typed.trim(), within);
          if (r && !refs.some((h) => idOf(h) === idOf(r))) onChange([...refs, r]);
          setTyped("");
        }}
        placeholder={refs.length ? "+ #issue" : "Closes #issue"}
        className="min-w-[6rem] flex-1 rounded-md border border-line bg-ground px-1.5 py-0.5 font-mono text-micro text-bone placeholder:text-mute focus:outline-none"
      />
    </div>
  );
}

/* ── The file list, at any size ────────────────────────────────────────── */

/** How many files before the flat list becomes groups. */
const GROUP_OVER = 8;

/**
 * The files about to be committed.
 *
 * **Flat while it is short, grouped once it is not.** A handful of files is
 * best read as a handful of files; eighty-one is not, and the job the list
 * actually does at that size is scanning for the one thing that should not be
 * there — a lockfile, a scratch note, a stray `.env`.
 *
 * Alphabetical order puts the least interesting files first, which is why a
 * plain cap does not help: the eight you would show are `.env.example`,
 * `.github/…`, `AGENTS.md`, `Makefile`. Directories carry the shape instead,
 * biggest first, and unticking a generated folder becomes one press rather
 * than twelve.
 *
 * Rows inside a group show the **filename only** — the directory is the header
 * above them — so nothing is truncated away. The group header is the one place
 * a long path can appear, and it is cut in the middle.
 */
function Files({
  files,
  checkout,
  single,
  leaving,
  onToggle,
}: {
  files: Changed[];
  checkout: string;
  single: boolean;
  leaving: Set<string>;
  onToggle: (paths: string[]) => void;
}) {
  const [shut, setShut] = useState<Set<string>>(new Set());
  const groups = useMemo(
    () => byDirectory(files, checkout, single),
    [files, checkout, single],
  );
  const grouped = files.length > GROUP_OVER && groups.length > 1;

  if (files.length === 0) return null;

  if (!grouped) {
    return (
      <div className="overflow-hidden rounded-lg border border-line">
        {files.map((f) => (
          <Row key={f.path} file={f} kept={!leaving.has(f.path)} onToggle={onToggle} whole />
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line">
      {groups.map((g) => {
        const paths = g.files.map((f) => f.path);
        const kept = paths.filter((p) => !leaving.has(p)).length;
        const open = !shut.has(g.dir);
        return (
          <div key={g.dir || "."} className="border-b border-line-soft last:border-0">
            <div className="flex items-center gap-2.5 bg-raise/60 px-2.5 py-1.5">
              <Tick
                state={kept === 0 ? "none" : kept === paths.length ? "all" : "some"}
                onClick={() => onToggle(paths)}
              />
              <button
                onClick={() => setShut((h) => { const n = new Set(h); n.has(g.dir) ? n.delete(g.dir) : n.add(g.dir); return n; })}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-micro text-bone">
                  {g.dir ? middled(g.dir, 38) : "in the repository root"}
                </span>
                <span className="shrink-0 font-mono text-micro text-mute">{g.files.length}</span>
                <ChevronDown
                  className={`h-3 w-3 shrink-0 text-mute transition-transform ${open ? "" : "-rotate-90"}`}
                  strokeWidth={2}
                />
              </button>
            </div>
            {open &&
              g.files.map((f) => (
                <Row key={f.path} file={f} kept={!leaving.has(f.path)} onToggle={onToggle} />
              ))}
          </div>
        );
      })}
    </div>
  );
}

/** One file. `whole` draws the path, which is right when there is no header. */
function Row({
  file,
  kept,
  onToggle,
  whole = false,
}: {
  file: Changed;
  kept: boolean;
  onToggle: (paths: string[]) => void;
  whole?: boolean;
}) {
  return (
    <button
      onClick={() => onToggle([file.path])}
      className="flex w-full items-center gap-2.5 border-b border-line-soft px-2.5 py-1.5 text-left last:border-0 transition-colors hover:bg-raise/60"
    >
      <Tick state={kept ? "all" : "none"} />
      <span
        className={`min-w-0 flex-1 truncate font-mono text-meta ${kept ? "text-dim" : "text-mute line-through"}`}
      >
        {whole ? file.path : leafOf(file.path)}
      </span>
      <span className="shrink-0 font-mono text-micro text-mute">
        {file.added > 0 && <span className="text-sage">+{file.added}</span>}
        {file.removed > 0 && <span className="text-brick"> −{file.removed}</span>}
      </span>
    </button>
  );
}

/** Kept, dropped, or a directory with some of each. */
function Tick({ state, onClick }: { state: "all" | "some" | "none"; onClick?: () => void }) {
  const on = state !== "none";
  return (
    <span
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
        on ? "border-sage-deep bg-sage-tint text-sage" : "border-line text-transparent"
      }`}
    >
      {state === "some" ? (
        <span className="h-0.5 w-2 rounded bg-sage" />
      ) : (
        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 fill-none stroke-current stroke-2">
          <path d="M1.5 5.2 4 7.5 8.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

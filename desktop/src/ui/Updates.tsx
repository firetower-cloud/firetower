/**
 * Upgrading Firetower from Firetower.
 *
 * **Reading is not upgrading.** Everybody can see what this Firetower runs and
 * whether a release is out — somebody who cannot tell that their work runs on
 * something months old cannot ask for anything about it. The controls are what
 * narrow: moving the deployment is an administrator's, and moving one machine
 * belongs to whoever administers that machine.
 *
 * **A machine is brought level with the control plane, never past it.** The
 * server refuses the rest, and this screen offers exactly the version the
 * server would accept. A worker ahead of the control plane is a worker talking
 * to something that does not know its protocol, and whoever put it there may
 * have no right to move the control plane after it.
 *
 * The web's flow, kept: `get_updates` says what is running and what is out;
 * `check_updates` asks again; `plan_update` for a version says which files the
 * upgrade wants to write and whether your edits are in the way; `create_run`
 * starts it for the targets you chose; a run's steps are polled every two
 * seconds while it is active and it can be cancelled or continued when it
 * stops to ask. `back_up_now` is the thing to press first.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowUp, Building2, Check, CircleDot, Download, Loader2, Monitor, Play, RefreshCw, Save, Server, Square, X } from "lucide-react";
import { Icon } from "~/components/ui";
import type { FilePlan, HostTarget, UpdateRun, UpdateStatus } from "~/api/generated/model";
import {
  getGetUpdatesQueryKey,
  getListRunsQueryKey,
  useBackUpNow,
  useCancelRun,
  useCheckUpdates,
  useContinueRun,
  useCreateRun,
  useGetRun,
  useGetUpdates,
  useListRuns,
  usePlanUpdate,
} from "~/api/generated/updates/updates";
import type { Chosen } from "~/api/updates";
import { ACTIVE, canStart, countEnded, needsChoice, willWrite, wouldEnd } from "~/api/updates";
import { useBackendKey } from "~/backend";
import { bridge } from "~/bridge";
import { look, takeUpdate, useBuild } from "~/update";

import { why } from "~/data";

export function Updates() {
  const cache = useQueryClient();
  const status = useGetUpdates({ query: { refetchInterval: 60_000 } });
  const runs = useListRuns({ query: { refetchInterval: 30_000 } });
  const check = useCheckUpdates();
  const backUp = useBackUpNow();
  const build = useBuild();
  const [planning, setPlanning] = useState<Chosen | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  /* Ticked on the page, so the list you are choosing from stays in front of
     you while you choose. Pre-ticked with the machines that can actually
     move: the common case is "all of them", and the uncommon one is one
     click away either direction. */
  const [ticked, setTicked] = useState<string[]>([]);
  const [primed, setPrimed] = useState(false);
  const refresh = () => Promise.all([cache.invalidateQueries({ queryKey: getGetUpdatesQueryKey() }), cache.invalidateQueries({ queryKey: getListRunsQueryKey() })]);

  /* The app's own section is drawn before the server is heard from, and still
     drawn when it refuses. This app updates itself from GitHub without asking
     any Firetower anything, so a deployment that is down is not a reason to
     hide the one button on this screen that still works — and the rail sends
     people here for that button. */
  if (status.isPending) return <Page><ThisApp /><p className="mt-7 flex items-center gap-2 text-read text-mute"><Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />Asking what is running…</p></Page>;
  if (status.error) return <Page><ThisApp /><p className="mt-7 text-read text-brick">{why(status.error)}</p></Page>;

  const s = status.data as UpdateStatus;
  const active = ((runs.data ?? []) as UpdateRun[]).find((r) => ACTIVE.includes(r.state));
  const mayMoveEverything = s.controlPlane.mayUpgrade ?? false;
  if (!primed) {
    setPrimed(true);
    setTicked(s.hosts.filter((h) => h.mayUpgrade).map((h) => h.hostId));
  }
  const movable = mayMoveEverything && s.controlPlane.upgradable && !active && s.updateAvailable && s.latest?.version !== s.current;
  const behind = s.hosts.filter((h) => h.mayUpgrade);
  const level = build.newer ? `${build.newer} is out for this app.` : "Up to date.";

  /* What the heading says is what this person can do something about. "A newer
     version is out" to somebody who cannot install it is a notice with no
     action behind it; what they can act on is a machine of theirs that is
     behind what the deployment is already running.

     The deployment speaks first when it has something to say, because moving
     it is the larger and rarer act — but when it has nothing, the heading is
     this app's, and never "Up to date." over a section offering a new build.
     The rail sends people here in slate for either one; a screen that then
     said there was nothing to take would be the bug. */
  const headline = mayMoveEverything
    ? !s.updateAvailable
      ? level
      : s.latest?.version === s.current
        ? "Some machines are behind."
        : `${s.latest?.version ?? "A newer version"} is out.`
    : behind.length > 0
      ? behind.length === 1
        ? `${behind[0].name} is behind.`
        : `${behind.length} machines are behind.`
      : s.updateAvailable
        ? `${s.latest?.version ?? "A newer version"} is out.`
        : level;

  /* **What you tick is on the page, not in a dialog.** The plan used to be a
     modal that carried the targets, the file list and the decisions all at
     once — so choosing *what* to move and reading *what that writes* happened
     in the same box, and the box covered the machine list you were choosing
     from. The drawing splits them: the machines are a list with a checkbox
     each, and the plan is a panel on the page that replaces them once you
     have asked for it. */
  return (
    <Page>
      {/* **A run in progress is what the screen is about.** It was a line
          reading "A run is already in progress." above a list of machines
          you could no longer act on, with the steps folded away behind a row
          in Past runs — so the one thing happening was the one thing you had
          to go and find. */}
      <div className="upd-hero">
        <h1>{active ? `Moving ${movingWhat(s, active)} to ${active.toVersion}` : headline}</h1>
        <p>
          {active
            ? "You can leave this. The run carries on without the window open, and it stops to ask if it needs you."
            : <>
                Running <span className="font-mono text-bone">{s.current}</span>
                {s.checkedAt && <span className="text-mute"> · checked {new Date(s.checkedAt).toLocaleTimeString()}</span>}
              </>}
        </p>
        {s.checkError && <p className="mt-1 text-meta text-brick">{s.checkError}</p>}
      </div>

      {active ? (
        <Run id={active.id} onChange={refresh} />
      ) : planning ? (
        <Plan
          status={s}
          chosen={planning}
          onClose={() => {
            setPlanning(null);
            void refresh();
          }}
        />
      ) : (
        <>
          <div className="upd-row">
            <span className="g"><Icon of={Building2} size={20} /></span>
            <span className="tx">
              <b>This Firetower</b>
              <s>The control plane and everything it serves</s>
            </span>
            <span className="ver">{s.controlPlane.version}</span>
            <span className="acts">
              {movable && (
                <button onClick={() => setPlanning({ controlPlane: true, hostIds: [] })} className="btn primary">
                  <Icon of={Download} size={14} />Upgrade to {s.latest?.version}
                </button>
              )}
              {/* Both trains asked at once: a check that moved half of it is
                  one somebody presses twice. */}
              <button disabled={check.isPending} onClick={() => { void look(); check.mutate(undefined as never, { onSuccess: refresh }); }} className="btn quiet">
                <Icon of={RefreshCw} size={14} />{check.isPending ? "Checking…" : "Check again"}
              </button>
            </span>
          </div>
          {/* Why the deployment cannot move itself is a paragraph, and a
              paragraph does not go in a row — it was pushing the version and
              the verdict off the end of one. Only to somebody who could act
              on it: a member cannot run `firetower upgrade` on the host, and
              telling them to is telling them to go and fail. */}
          {mayMoveEverything && !s.controlPlane.upgradable && s.controlPlane.reason && (
            <p className="mt-2 flex items-start gap-2 rounded-lg bg-raise px-3 py-2 text-micro leading-relaxed text-mute">
              <Icon of={AlertTriangle} size={12} />
              <span className="min-w-0 flex-1">{s.controlPlane.reason}</span>
            </p>
          )}

          <ThisApp />

          {s.hosts.length > 0 && (
            <section className="upd-sec">
              <h2>Machines</h2>
              <p className="note">
                A machine is brought level with the control plane and never past it — a worker ahead of it is a worker
                talking to something that does not know its protocol. Moving one belongs to whoever administers that
                machine.
              </p>
              <div className="mt-3">
                {s.hosts.map((h) => (
                  <Machine
                    key={h.hostId}
                    host={h}
                    to={s.current}
                    on={ticked.includes(h.hostId)}
                    blocked={!!active}
                    onTick={() => setTicked(ticked.includes(h.hostId) ? ticked.filter((x) => x !== h.hostId) : [...ticked, h.hostId])}
                  />
                ))}
              </div>
              <div className="run-foot mt-[18px] flex flex-wrap items-center gap-[7px]">
                {mayMoveEverything && (
                  <button disabled={backUp.isPending} onClick={() => backUp.mutate(undefined as never)} className="btn plain">
                    <Icon of={Save} size={14} />{backUp.isPending ? "Backing up…" : backUp.isSuccess ? "Backed up" : "Back up now"}
                  </button>
                )}
                <button
                  disabled={ticked.length === 0 || !!active}
                  onClick={() => setPlanning({ controlPlane: false, hostIds: ticked })}
                  className="btn primary"
                >
                  <Icon of={ArrowUp} size={14} />
                  Plan the update for {ticked.length === 1 ? "1 machine" : `${ticked.length} machines`}
                </button>
                {mayMoveEverything && (
                  <span className="text-ui text-dim">
                    Back up first. It takes a few seconds and it is the thing to press before anything else.
                  </span>
                )}
              </div>
            </section>
          )}

          <section className="upd-sec">
            <h2>Past runs</h2>
            {((runs.data ?? []) as UpdateRun[]).length === 0 && <p className="note">No upgrade has been run from here yet.</p>}
            <div className="mt-3">
              {((runs.data ?? []) as UpdateRun[]).map((r) => (
                <button key={r.id} onClick={() => setOpened(opened === r.id ? null : r.id)} className="diffrow w-full text-left">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.state === "succeeded" ? "bg-sage" : r.state === "failed" ? "bg-brick" : ACTIVE.includes(r.state) ? "animate-pulse bg-slate" : "bg-line"}`} />
                  <span className="p">{r.fromVersion} → {r.toVersion}</span>
                  <span className="n">{r.state}</span>
                  <span className="n">{new Date(r.createdAt).toLocaleString()}</span>
                </button>
              ))}
            </div>
            {opened && <Run id={opened} onChange={refresh} />}
          </section>
        </>
      )}
    </Page>
  );
}

/**
 * This app's own build, which is not the deployment's.
 *
 * Two release trains that happen to share a screen. The Mac app updates itself
 * from its own GitHub release and anybody may update their own copy; the
 * deployment below is moved by a run and mostly by an administrator. Different
 * version numbers, different permissions — so a section of its own rather than
 * a fourth row in a list that would then have to explain which is which.
 *
 * First on the screen because it is the one thing here that is always the
 * reader's own to do.
 *
 * Nothing in a browser tab: a tab has no build of its own to move.
 */
function ThisApp() {
  const build = useBuild();
  const [taking, setTaking] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  if (!bridge.native) return null;

  /* No confirmation. Nothing is lost — the servers and their tokens stay, and
     what it ends is this window, which is the thing the button says. */
  const go = () => {
    setTrouble(null);
    setTaking(true);
    takeUpdate().catch((e) => {
      setTrouble(why(e));
      setTaking(false);
    });
  };

  return (
    <>
      <div className="upd-row">
        <span className="g"><Icon of={Monitor} size={20} /></span>
        <span className="tx">
          <b>This app</b>
          <s>Updates itself from GitHub — it does not ask the deployment</s>
        </span>
        <span className="ver">{build.version ?? "—"}</span>
        <span className="acts">
          {build.newer ? (
            <button disabled={taking} onClick={go} className="btn primary">
              <Icon of={taking ? Loader2 : Download} size={14} className={taking ? "animate-spin" : undefined} />
              {taking ? "Downloading…" : `Update to ${build.newer} and relaunch`}
            </button>
          ) : (
            <span className="text-ui text-dim">Up to date</span>
          )}
        </span>
      </div>
      {trouble && (
        <p className="mt-2 flex items-start gap-2 rounded-lg bg-raise px-3 py-2 text-micro leading-relaxed text-brick">
          <Icon of={AlertTriangle} size={12} />
          <span className="min-w-0 flex-1">{trouble} Try it again in a few minutes.</span>
        </p>
      )}
    </>
  );
}

/**
 * One machine, and the one thing that can be done to it.
 *
 * The target is the control plane's version, not the newest release — that is
 * the only version the server will accept for a machine on its own, so it is
 * the only one worth putting on a button.
 */
function Machine({ host, to, on, blocked, onTick }: { host: HostTarget; to: string; on: boolean; blocked: boolean; onTick: () => void }) {
  /* A machine somebody else administers is **listed with its box dimmed**,
     with the reason. Not hidden — a list that omits the machines you cannot
     move is a list that cannot be reconciled against the fleet — and not
     drawn with a greyed-out button either, which is how an interface says
     you are being withheld from. It recedes, and says whose it is. */
  const mine = host.mayUpgrade && !blocked;
  const said = !host.upgradable
    ? (host.version === to ? "level with the control plane" : (host.reason ?? "cannot be moved from here"))
    : host.mayUpgrade
      ? `behind — can be brought to ${to}`
      : "behind — you do not administer this one";

  return (
    <button type="button" disabled={!mine} onClick={onTick} aria-pressed={on} className="mach">
      <span className="box" data-on={mine && on} data-off={!mine}>
        {mine && on && <Check className="h-[11px] w-[11px]" strokeWidth={3} />}
      </span>
      <span className="g"><Icon of={Server} size={16} /></span>
      <span className="tx">
        <b>{host.name}</b>
        <s>
          {said}
          {!host.online && " · offline"}
          {host.drained ? " · drained" : ""}
          {host.sessions.length > 0 && ` · ${host.sessions.length} running`}
        </s>
      </span>
      <span className="ver">{host.version ?? "—"}</span>
    </button>
  );
}

/* ── One run ───────────────────────────────────────────────────────────── */

function Run({ id, onChange }: { id: string; onChange: () => void }) {
  const run = useGetRun(id, { query: { refetchInterval: (q) => (q.state.data && !ACTIVE.includes((q.state.data as UpdateRun).state) ? false : 2_000) } });
  const cancel = useCancelRun();
  const carryOn = useContinueRun();
  const r = run.data as UpdateRun | undefined;
  if (!r) return null;

  const began = r.startedAt ?? r.createdAt;

  return (
    <div className="run">
      <div className="top">
        {ACTIVE.includes(r.state) && <span className="typing"><i /><i /><i /></span>}
        <b>{ACTIVE.includes(r.state) ? `Started ${ago(began)}` : `${r.fromVersion} → ${r.toVersion} · ${r.state}`}</b>
        {r.state === "waitingDecision" && <button disabled={carryOn.isPending} onClick={() => carryOn.mutate({ id }, { onSuccess: onChange })} className="btn primary">Continue anyway</button>}
        {ACTIVE.includes(r.state) && (
          <button disabled={cancel.isPending} onClick={() => cancel.mutate({ id }, { onSuccess: onChange })} className="btn quiet">
            <Icon of={Square} size={14} />Cancel
          </button>
        )}
      </div>
      {r.error && <p className="why flex items-start gap-2 text-brick"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />{r.error}</p>}
      {/* **The glyph carries the state, not a coloured dot.** A tick for what
          is done, the typing marks for what is happening, a hollow circle for
          what has not started — the same three marks the rest of the app uses
          for the same three things. */}
      <ol className="steps">
        {(r.steps ?? []).map((st) => (
          <li key={st.position}>
            <div className="stepr" data-s={st.state === "done" ? "done" : st.state === "running" ? "now" : st.state}>
              <span className="g">
                {st.state === "done" ? <Check className="h-[15px] w-[15px]" strokeWidth={2} />
                  : st.state === "running" ? <span className="typing"><i /><i /><i /></span>
                  : st.state === "failed" ? <AlertTriangle className="h-[14px] w-[14px] text-brick" strokeWidth={2} />
                  : <CircleDot className="h-[14px] w-[14px]" strokeWidth={1.75} />}
              </span>
              <span className="t">{st.title}{st.target ? <span className="ml-2 font-mono text-micro text-mute">{st.target}</span> : null}</span>
              <span className="el">{st.detail}</span>
            </div>
            {st.log && (st.state === "failed" || st.state === "warned" || st.state === "running") && <pre className="scroll-slim mt-1 ml-7 max-h-40 overflow-auto rounded-md bg-panel px-3 py-2 font-mono text-micro whitespace-pre-wrap text-dim">{st.log}</pre>}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What a run is moving — the machines by name when it is a few, else the
    deployment itself. The heading is the sentence, so it has to read. */
function movingWhat(s: UpdateStatus, r: UpdateRun): string {
  if (r.targets?.controlPlane !== false) return "this Firetower";
  const named = (r.targets?.hostIds ?? []).map((id: string) => s.hosts.find((h) => h.hostId === id)?.name).filter(Boolean) as string[];
  if (named.length === 0) return "this Firetower";
  if (named.length <= 2) return named.join(" and ");
  return `${named.length} machines`;
}

/** "61 seconds ago", in the drawing's words rather than a clock time. */
function ago(at: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
  if (s < 90) return `${s} second${s === 1 ? "" : "s"} ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

/* ── Planning one ──────────────────────────────────────────────────────── */

/**
 * What the upgrade will write, before it writes it.
 *
 * **A panel on the page, not a dialog over it.** It was a modal that carried
 * the targets, the file list and the per-file decisions at once — so it
 * covered the machine list you had just chosen from, and the question "what
 * am I moving" and the question "what does that overwrite" were asked in the
 * same box. The targets are chosen on the page now and this answers the
 * second question alone.
 */
function Plan({ status, chosen, onClose }: { status: UpdateStatus; chosen: Chosen; onClose: () => void }) {
  const version = chosen.controlPlane ? (status.latest?.version ?? "") : status.current;
  const plan = usePlanUpdate();
  const create = useCreateRun();
  const [replace, setReplace] = useState<Record<string, boolean>>({});
  const [whenIdle, setWhenIdle] = useState(true);
  const [asked, setAsked] = useState(false);

  if (!asked) {
    setAsked(true);
    plan.mutate({ data: { version, controlPlane: chosen.controlPlane } });
  }

  const p = plan.data;
  const files = (p?.files ?? []) as FilePlan[];
  /* The decision defaults to **keeping yours**, which is where this departs
     from the drawing: there the one edited file reads `write` and the button
     offers to keep it, so the default is to overwrite. A default that
     silently destroys somebody's edits is not a default, so the shape and the
     words are the drawing's and the starting position is the safe one — the
     button always offers the other answer, and the `k` column says which is
     in force. Recorded in `redesign-reconciliation.md` as deliberate. */
  const kept = (f: FilePlan) => !(replace[f.name] ?? false);
  const choosing = files.filter(needsChoice);
  const shown = files.slice(0, 4);
  const more = files.length - shown.length;
  const ending = countEnded(wouldEnd(status, chosen));

  const where = chosen.controlPlane
    ? "this Firetower"
    : chosen.hostIds.length === 1
      ? (status.hosts.find((h) => h.hostId === chosen.hostIds[0])?.name ?? "that machine")
      : `${chosen.hostIds.length} machines`;

  const go = () =>
    create.mutate(
      {
        data: {
          version,
          controlPlane: chosen.controlPlane,
          hostIds: chosen.hostIds,
          whenIdle,
          endSessions: !whenIdle,
          files: files.map((f) => ({ name: f.name, replace: replace[f.name] ?? !needsChoice(f) })),
        },
      },
      { onSuccess: onClose },
    );

  return (
    <div className="run">
      <div className="top">
        <b>What {version} wants to write on {where}</b>
        <button onClick={onClose} className="btn quiet"><Icon of={X} size={14} />Close</button>
      </div>

      {plan.isPending && <p className="why flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />Working out what changes…</p>}
      {plan.error && <p className="why text-brick">{why(plan.error)}</p>}

      {p && (
        <>
          <p className="why">
            {files.length === 0
              ? "Nothing on disk changes. The machines are reinstalled at this version."
              : <>
                  {files.length} file{files.length === 1 ? "" : "s"}.
                  {choosing.length > 0
                    ? ` ${choosing.length === 1 ? "One of them you have" : `${choosing.length} of them you have`} edited since it was installed — keep your version and the upgrade skips it, or take theirs and yours is overwritten.`
                    : " None of them you have edited, so nothing of yours is in the way."}
                </>}
          </p>

          {p.envMissing.length > 0 && (
            <p className="why flex items-start gap-2 text-text">
              <Icon of={AlertTriangle} size={14} className="mt-0.5 shrink-0 text-kind-data" />
              This version wants {p.envMissing.join(", ")} set in the environment.
            </p>
          )}
          {p.updaterUpgrade && <p className="why">The updater itself is upgraded first.</p>}

          {files.length > 0 && (
            <div className="plan-files">
              {shown.map((f) => (
                <div key={f.name} className="diffrow">
                  <span className="k">{f.verdict === "New" ? "new" : needsChoice(f) ? (kept(f) ? "skip" : "write") : willWrite(f, true) ? "write" : "keep"}</span>
                  <span className="p">{f.name}</span>
                  {needsChoice(f) && <span className="n inway">your edits are in the way</span>}
                </div>
              ))}
              {more > 0 && (
                <div className="diffrow text-mute">
                  <span className="k" />
                  <span className="p font-sans text-mute">and {more} more</span>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* One checkbox, not two. "Wait until nothing is running" and "End what
          is running" were a pair that could both be off, which is a third
          state nobody meant. */}
      <label className="why flex items-center gap-2 text-text">
        <input type="checkbox" checked={whenIdle} onChange={(e) => setWhenIdle(e.target.checked)} />
        Wait until nothing is running
        {!whenIdle && ending > 0 && <span className="text-kind-data">— {ending} session{ending === 1 ? "" : "s"} end{ending === 1 ? "s" : ""}</span>}
      </label>

      <div className="foot">
        <button disabled={!canStart(chosen, p) || create.isPending} onClick={go} className="btn primary">
          <Icon of={Play} size={14} />{create.isPending ? "Starting…" : "Start the upgrade"}
        </button>
        {choosing.length > 0 && (
          <button
            onClick={() => setReplace(Object.fromEntries(choosing.map((f) => [f.name, kept(f)])))}
            className="btn plain"
          >
            {choosing.every(kept)
              ? `Take theirs and overwrite ${choosing.length === 1 ? "that file" : "those files"}`
              : `Keep my version of ${choosing.length === 1 ? "that file" : "those files"}`}
          </button>
        )}
        <button onClick={onClose} className="btn quiet">Back</button>
      </div>
    </div>
  );
}


function Page({ children }: { children: React.ReactNode }) {
  return <div className="scroll-slim h-full overflow-y-auto"><div className="mx-auto max-w-[52rem] px-6 py-6 pb-16">{children}</div></div>;
}

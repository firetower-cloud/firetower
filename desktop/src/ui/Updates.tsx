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
import { AlertTriangle, Check, Download, Loader2, RefreshCw, Save, X } from "lucide-react";
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
import { ACTIVE, canStart, countEnded, everythingUpgradable, needsChoice, willWrite, wouldEnd } from "~/api/updates";
import { useBackendKey } from "~/backend";
import { useConfirm } from "~/ui/Confirm";

import { why } from "~/data";

export function Updates() {
  const cache = useQueryClient();
  const status = useGetUpdates({ query: { refetchInterval: 60_000 } });
  const runs = useListRuns({ query: { refetchInterval: 30_000 } });
  const check = useCheckUpdates();
  const backUp = useBackUpNow();
  const [planning, setPlanning] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const refresh = () => Promise.all([cache.invalidateQueries({ queryKey: getGetUpdatesQueryKey() }), cache.invalidateQueries({ queryKey: getListRunsQueryKey() })]);

  if (status.isPending) return <Page><p className="flex items-center gap-2 text-read text-mute"><Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />Asking what is running…</p></Page>;
  if (status.error) return <Page><p className="text-read text-brick">{why(status.error)}</p></Page>;

  const s = status.data as UpdateStatus;
  const active = ((runs.data ?? []) as UpdateRun[]).find((r) => ACTIVE.includes(r.state));
  const mayMoveEverything = s.controlPlane.mayUpgrade ?? false;
  const behind = s.hosts.filter((h) => h.mayUpgrade);

  /* What the heading says is what this person can do something about. "A newer
     version is out" to somebody who cannot install it is a notice with no
     action behind it; what they can act on is a machine of theirs that is
     behind what the deployment is already running. */
  const headline = mayMoveEverything
    ? !s.updateAvailable
      ? "Up to date."
      : s.latest?.version === s.current
        ? "Some machines are behind."
        : `${s.latest?.version ?? "A newer version"} is out.`
    : behind.length > 0
      ? behind.length === 1
        ? `${behind[0].name} is behind.`
        : `${behind.length} machines are behind.`
      : s.updateAvailable
        ? `${s.latest?.version ?? "A newer version"} is out.`
        : "Up to date.";

  return (
    <Page>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-display text-bone">{headline}</h1>
          <p className="mt-2 text-read text-dim">
            Running <span className="font-mono text-text">{s.current}</span>
            {s.checkedAt && <span className="text-mute"> · checked {new Date(s.checkedAt).toLocaleTimeString()}</span>}
          </p>
          {s.checkError && <p className="mt-1 text-meta text-brick">{s.checkError}</p>}
        </div>
        <button disabled={check.isPending} onClick={() => check.mutate(undefined as never, { onSuccess: refresh })} className="control border border-line bg-raise text-dim hover:bg-overlay disabled:text-mute"><Icon of={RefreshCw} size={12} />{check.isPending ? "Checking…" : "Check now"}</button>
      </div>

      <Label>The deployment</Label>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <Row
          name="Control plane"
          note={s.controlPlane.updater.reachable ? `updater ${s.controlPlane.updater.version ?? ""}` : "no updater"}
          version={s.controlPlane.version}
          sessions={s.controlPlane.sessions.length}
          said={
            !s.updateAvailable || s.latest?.version === s.current
              ? "up to date"
              : mayMoveEverything
                ? s.controlPlane.upgradable ? null : "cannot move itself"
                : "an administrator moves this"
          }
          action={mayMoveEverything && s.controlPlane.upgradable && !active && s.updateAvailable && s.latest?.version !== s.current
            ? <button onClick={() => setPlanning(true)} className="control bg-bone font-medium text-ground hover:opacity-90"><Icon of={Download} size={12} />Upgrade to {s.latest?.version}</button>
            : null}
        />
      </div>

      {/* Why the deployment cannot move itself is a paragraph, and a paragraph
          does not go in a row — it was pushing the version and the verdict off
          the end of one. Only to somebody who could act on it: a member cannot
          run `firetower upgrade` on the host, and telling them to is telling
          them to go and fail. */}
      {mayMoveEverything && !s.controlPlane.upgradable && s.controlPlane.reason && (
        <p className="mt-2 flex items-start gap-2 rounded-lg border border-line bg-ground px-3 py-2 text-micro leading-relaxed text-mute">
          <Icon of={AlertTriangle} size={12} />
          <span className="min-w-0 flex-1">{s.controlPlane.reason}</span>
        </p>
      )}

      {s.hosts.length > 0 && (
        <>
          <Label>Machines</Label>
          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            {s.hosts.map((h) => (
              <Machine key={h.hostId} host={h} to={s.current} blocked={!!active} onDone={refresh} />
            ))}
          </div>
        </>
      )}

      {mayMoveEverything && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button disabled={backUp.isPending} onClick={() => backUp.mutate(undefined as never)} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute"><Icon of={Save} size={12} />{backUp.isPending ? "Backing up…" : backUp.isSuccess ? "Backed up" : "Back up now"}</button>
          {active && <span className="text-meta text-kind-data">A run is in progress.</span>}
        </div>
      )}

      <Label>Runs</Label>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {((runs.data ?? []) as UpdateRun[]).length === 0 && <p className="px-3.5 py-4 text-ui text-mute">No upgrade has been run from here yet.</p>}
        {((runs.data ?? []) as UpdateRun[]).map((r) => (
          <button key={r.id} onClick={() => setOpened(opened === r.id ? null : r.id)} className="flex w-full items-center gap-3 border-b border-line-soft px-3.5 py-2.5 text-left last:border-0 hover:bg-raise/60">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.state === "succeeded" ? "bg-sage" : r.state === "failed" ? "bg-brick" : ACTIVE.includes(r.state) ? "animate-pulse bg-slate" : "bg-line"}`} />
            <span className="min-w-0 flex-1 truncate font-mono text-ui text-text">{r.fromVersion} → {r.toVersion}</span>
            <span className="text-meta text-mute">{r.state}</span>
            <span className="font-mono text-micro text-mute">{new Date(r.createdAt).toLocaleString()}</span>
          </button>
        ))}
      </div>
      {opened && <Run id={opened} onChange={refresh} />}

      {planning && <Plan status={s} onClose={() => { setPlanning(false); refresh(); }} />}
    </Page>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-7 mb-2 text-meta tracking-[0.08em] text-mute uppercase">{children}</h2>;
}

/**
 * One machine, and the one thing that can be done to it.
 *
 * The target is the control plane's version, not the newest release — that is
 * the only version the server will accept for a machine on its own, so it is
 * the only one worth putting on a button.
 */
function Machine({ host, to, blocked, onDone }: { host: HostTarget; to: string; blocked: boolean; onDone: () => void }) {
  const confirm = useConfirm();
  const create = useCreateRun();
  const [trouble, setTrouble] = useState<string | null>(null);

  const go = async (whenIdle: boolean) => {
    setTrouble(null);
    create.mutate(
      { data: { version: to, controlPlane: false, hostIds: [host.hostId], whenIdle, endSessions: !whenIdle, files: [] } },
      { onSuccess: () => void onDone(), onError: (e) => setTrouble(why(e)) },
    );
  };

  const ask = async () => {
    if (host.sessions.length === 0) return void go(false);
    // Said out loud, with the titles: somebody administering a directory can
    // end work that is not theirs, and the only defensible version of that is
    // one where they read what they are ending first.
    const ok = await confirm({
      title: `Bring ${host.name} up to ${to}?`,
      body: (
        <>
          It is reinstalled, so what is running on it ends —{" "}
          <b className="text-bone">{host.sessions.length === 1 ? "one session" : `${host.sessions.length} sessions`}</b>
          {host.sessions.length <= 4 && <>: {host.sessions.join(", ")}</>}. Whoever is in them loses what they have not saved.
        </>
      ),
      action: "End them and upgrade",
      tone: "danger",
    });
    if (ok) void go(false);
  };

  return (
    <div className="flex items-center gap-3 border-b border-line-soft px-3.5 py-2.5 last:border-0">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${host.online ? "bg-sage" : "bg-line"}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui text-bone">{host.name}</span>
        <span className="block text-micro text-mute">
          {host.online ? "online" : "offline"}{host.drained ? " · drained" : ""}
          {host.sessions.length > 0 && ` · ${host.sessions.length} running`}
          {trouble && <span className="text-brick"> · {trouble}</span>}
        </span>
      </span>
      <span className="font-mono text-meta text-dim">{host.version ?? "—"}</span>
      {host.mayUpgrade ? (
        <button disabled={blocked || create.isPending} onClick={() => void ask()} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">
          <Icon of={Download} size={12} />{create.isPending ? "Starting…" : `Bring up to ${to}`}
        </button>
      ) : (
        <span className="text-micro text-mute">{host.version === to ? "up to date" : host.upgradable ? "somebody who administers it can move it" : (host.reason ?? "")}</span>
      )}
    </div>
  );
}

function Row({ name, version, said, sessions, note, action }: { name: string; version: string; said: string | null; sessions: number; note: string; action: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-line-soft px-3.5 py-2.5 last:border-0">
      <span className="min-w-0 flex-1">
        <span className="block text-ui text-bone">{name}</span>
        <span className="block text-micro text-mute">{note}{sessions ? ` · ${sessions} running` : ""}</span>
      </span>
      <span className="font-mono text-meta text-dim">{version}</span>
      {action ?? <span className="truncate text-right text-micro text-mute">{said}</span>}
    </div>
  );
}

/* ── One run ───────────────────────────────────────────────────────────── */

function Run({ id, onChange }: { id: string; onChange: () => void }) {
  const run = useGetRun(id, { query: { refetchInterval: (q) => (q.state.data && !ACTIVE.includes((q.state.data as UpdateRun).state) ? false : 2_000) } });
  const cancel = useCancelRun();
  const carryOn = useContinueRun();
  const r = run.data as UpdateRun | undefined;
  if (!r) return null;

  return (
    <div className="mt-2 rounded-xl border border-line bg-panel px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-ui text-bone">{r.fromVersion} → {r.toVersion}</span>
        <span className="text-meta text-mute">{r.state}{r.startedBy ? ` · by ${r.startedBy}` : ""}{r.whenIdle ? " · when idle" : ""}</span>
        <span className="ml-auto flex gap-1.5">
          {r.state === "waitingDecision" && <button disabled={carryOn.isPending} onClick={() => carryOn.mutate({ id }, { onSuccess: onChange })} className="control bg-bone font-medium text-ground hover:opacity-90">Continue anyway</button>}
          {ACTIVE.includes(r.state) && <button disabled={cancel.isPending} onClick={() => cancel.mutate({ id }, { onSuccess: onChange })} className="control border border-line text-dim hover:border-brick-deep hover:text-brick">Cancel</button>}
        </span>
      </div>
      {r.error && <p className="mt-2 flex items-start gap-2 text-meta text-brick"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />{r.error}</p>}
      <ol className="mt-3 space-y-1.5">
        {r.steps.map((st) => (
          <li key={st.position}>
            <div className="flex items-center gap-2.5 text-ui">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.state === "done" ? "bg-sage" : st.state === "running" ? "animate-pulse bg-slate" : st.state === "failed" ? "bg-brick" : st.state === "warned" ? "bg-kind-data" : "bg-line"}`} />
              <span className={st.state === "pending" ? "text-mute" : st.state === "failed" ? "text-brick" : "text-text"}>{st.title}</span>
              <span className="font-mono text-micro text-mute">{st.target}</span>
              {st.detail && <span className="min-w-0 truncate text-meta text-mute">{st.detail}</span>}
            </div>
            {st.log && (st.state === "failed" || st.state === "warned" || st.state === "running") && <pre className="scroll-slim mt-1 max-h-40 overflow-auto rounded-md bg-ground px-3 py-2 font-mono text-micro whitespace-pre-wrap text-dim">{st.log}</pre>}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ── Planning one ──────────────────────────────────────────────────────── */

function Plan({ status, onClose }: { status: UpdateStatus; onClose: () => void }) {
  const version = status.latest?.version ?? "";
  const plan = usePlanUpdate();
  const create = useCreateRun();
  const [chosen, setChosen] = useState(() => everythingUpgradable(status));
  const [replace, setReplace] = useState<Record<string, boolean>>({});
  const [whenIdle, setWhenIdle] = useState(true);
  const [endSessions, setEndSessions] = useState(false);
  // What the plan on screen was asked about. Ticking the control plane on or
  // off changes the answer — with it off there are no deployment files in the
  // run at all — so the question is put again rather than once.
  const [asked, setAsked] = useState<boolean | null>(null);

  if (asked !== chosen.controlPlane) {
    setAsked(chosen.controlPlane);
    plan.mutate({ data: { version, controlPlane: chosen.controlPlane } });
  }

  const p = plan.data;
  const files = (p?.files ?? []) as FilePlan[];
  const ending = countEnded(wouldEnd(status, chosen));

  const go = () =>
    create.mutate(
      { data: { version, controlPlane: chosen.controlPlane, hostIds: chosen.hostIds, whenIdle, endSessions, files: files.map((f) => ({ name: f.name, replace: replace[f.name] ?? !needsChoice(f) })) } },
      { onSuccess: onClose },
    );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ground/70 py-[8vh] backdrop-blur-[3px]" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-[38rem] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--shadow-float)">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-title text-bone">Upgrade to {version}</h2>
          <button onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"><X className="h-4 w-4" strokeWidth={1.75} /></button>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div>
            <span className="text-ui text-dim">What to upgrade</span>
            <div className="mt-1.5 space-y-1">
              <div>
                <label className="flex items-center gap-2 text-ui text-text"><input type="checkbox" checked={chosen.controlPlane} disabled={!status.controlPlane.upgradable} onChange={(e) => setChosen({ ...chosen, controlPlane: e.target.checked })} />Control plane <span className="font-mono text-micro text-mute">{status.controlPlane.version}</span></label>
                {/* Why this one cannot move — an unreachable updater, most
                    often — belongs against this row and nowhere else. Said
                    across the whole sheet it reads as the reason the upgrade
                    is off, which it is not: the workers below are unaffected. */}
                {!status.controlPlane.upgradable && status.controlPlane.reason && <p className="mt-0.5 pl-6 text-micro text-mute">{status.controlPlane.reason}</p>}
              </div>
              {status.hosts.map((h) => (
                <label key={h.hostId} className="flex items-center gap-2 text-ui text-text"><input type="checkbox" checked={chosen.hostIds.includes(h.hostId)} disabled={!h.upgradable} onChange={(e) => setChosen({ ...chosen, hostIds: e.target.checked ? [...chosen.hostIds, h.hostId] : chosen.hostIds.filter((x) => x !== h.hostId) })} />{h.name} <span className="font-mono text-micro text-mute">{h.version ?? "—"}</span>{!h.upgradable && <span className="text-micro text-mute">{h.reason}</span>}</label>
              ))}
            </div>
          </div>

          {plan.isPending && chosen.controlPlane && <p className="flex items-center gap-2 text-meta text-mute"><Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />Working out what changes…</p>}
          {plan.error && chosen.controlPlane && <p className="text-meta text-brick">{why(plan.error)}</p>}
          {p && (
            <>
              {p.envMissing.length > 0 && <p className="flex items-start gap-2 rounded-lg border border-kind-data/40 bg-ground px-3 py-2 text-meta text-text"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-kind-data" strokeWidth={1.75} />This version wants {p.envMissing.join(", ")} set in the environment.</p>}
              {p.updaterUpgrade && <p className="text-meta text-mute">The updater itself is upgraded first.</p>}
              {files.length > 0 && (
                <div>
                  <span className="text-ui text-dim">Files the upgrade writes</span>
                  <div className="mt-1.5 divide-y divide-line-soft overflow-hidden rounded-lg border border-line">
                    {files.map((f) => (
                      <div key={f.name} className="flex items-center gap-2.5 px-3 py-2">
                        <span className="min-w-0 flex-1"><span className="block font-mono text-ui text-text">{f.name}</span><span className="block text-micro text-mute">{f.verdict}{f.yourEdits ? " · you edited this" : ""}{f.releaseChange ? ` · ${f.releaseChange}` : ""}</span></span>
                        {needsChoice(f) ? (
                          <div className="track"><button data-on={!(replace[f.name] ?? false)} onClick={() => setReplace({ ...replace, [f.name]: false })}>Keep mine</button><button data-on={replace[f.name] ?? false} onClick={() => setReplace({ ...replace, [f.name]: true })}>Replace</button></div>
                        ) : (
                          <span className="text-micro text-mute">{willWrite(f, true) ? "written" : "untouched"}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-ui text-text"><input type="checkbox" checked={whenIdle} onChange={(e) => setWhenIdle(e.target.checked)} />Wait until nothing is running</label>
            <label className="flex items-center gap-2 text-ui text-text"><input type="checkbox" checked={endSessions} onChange={(e) => setEndSessions(e.target.checked)} />End what is running{ending > 0 && <span className="text-meta text-kind-data">— {ending} session{ending === 1 ? "" : "s"}</span>}</label>
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-line bg-ground/40 px-5 py-3">
          <button onClick={onClose} className="control ml-auto text-mute hover:bg-raise hover:text-bone">Cancel</button>
          <button disabled={!canStart(chosen, p) || create.isPending} onClick={go} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">{create.isPending ? "Starting…" : <><Check className="h-3.5 w-3.5" strokeWidth={2} />Start the upgrade</>}</button>
        </div>
      </div>
    </div>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <div className="scroll-slim h-full overflow-y-auto"><div className="mx-auto max-w-[52rem] px-6 py-6 pb-16">{children}</div></div>;
}

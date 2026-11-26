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
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowUp, Building2, Check, CircleDot, Download, Info, Loader2, Play, RefreshCw, Save, Server, Square, X } from "lucide-react";
import { Icon } from "~/components/ui";
import type { ChannelStatus, FilePlan, HostTarget, UpdateRun, UpdateStatus } from "~/api/generated/model";
import { Act, Channel, Package } from "~/api/generated/model";
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
  usePlanChannel,
  usePlanUpdate,
  useSwitchChannel,
} from "~/api/generated/updates/updates";
import type { Chosen } from "~/api/updates";
import {
  ACTIVE,
  aheadOfGeneral,
  canStart,
  channelBlock,
  channelsShown,
  countEnded,
  mismatch,
  needsChoice,
  pinsFor,
  servesChannels,
  saysChannel,
  willWrite,
  wouldEnd,
} from "~/api/updates";
import { useBackendKey } from "~/backend";
import { installedApp } from "~/installed-app";
import type { AppChannel } from "~/channel";
import { installedFrom, revealChannels, setAppChannel, useAppChannel, useChannelsRevealed } from "~/channel";
import type { Span } from "~/releases";
import { span as readSpan } from "~/releases";
import { look, takeUpdate, useBuild, whyUpdateFailed } from "~/update";
import type { ChannelAct } from "./updates/Channel";
import { ChannelSection, SwitchPanel } from "./updates/Channel";
import { ChangelogSpan } from "./updates/Span";
import { ThisApp } from "./updates/ThisApp";

import { why } from "~/data";

/** Where a copy that predates channels is sent to join beta by hand. */
const RELEASES = "https://github.com/firetower-cloud/firetower/releases";

export function Updates() {
  const cache = useQueryClient();
  const status = useGetUpdates({ query: { refetchInterval: 60_000 } });
  const runs = useListRuns({ query: { refetchInterval: 30_000 } });
  const check = useCheckUpdates();
  const backUp = useBackUpNow();
  const build = useBuild();
  const revealed = useChannelsRevealed();
  const appChannel = useAppChannel();
  const [planning, setPlanning] = useState<Chosen | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  /* Ticked on the page, so the list you are choosing from stays in front of
     you while you choose. Pre-ticked with the machines that can actually
     move: the common case is "all of them", and the uncommon one is one
     click away either direction. */
  const [ticked, setTicked] = useState<string[]>([]);
  const [primed, setPrimed] = useState(false);
  /** The channel act somebody has asked to see the consequences of. */
  const [switching, setSwitching] = useState<ChannelAct | null>(null);
  const refresh = () => Promise.all([cache.invalidateQueries({ queryKey: getGetUpdatesQueryKey() }), cache.invalidateQueries({ queryKey: getListRunsQueryKey() })]);

  /* What this copy is, for `channelsShown` below. Read before the early
     returns, because the two of them draw the app's own section and it asks
     the same question. */
  const copy = {
    channel: appChannel,
    from: installedFrom(build.version),
    ahead: aheadOfGeneral(build.version, pinsFor(status.data?.channel, Package.desktop)?.general),
  };

  /* The app's own section is drawn before the server is heard from, and still
     drawn when it refuses. This app updates itself from GitHub without asking
     any Firetower anything, so a deployment that is down is not a reason to
     hide the one button on this screen that still works — and the rail sends
     people here for that button. */
  if (status.isPending) return <Page><Copy status={undefined} shown={channelsShown(revealed, null, copy)} /><p className="mt-7 flex items-center gap-2 text-read text-mute"><Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />Asking what is running…</p></Page>;
  if (status.error) return <Page><Copy status={undefined} shown={channelsShown(revealed, null, copy)} /><p className="mt-7 text-read text-brick">{why(status.error)}</p></Page>;

  const s = status.data as UpdateStatus;
  /* **What the server can serve, read from the answer rather than from a
     version.** A control plane that predates channels returns no `channel`,
     and a screen that then drew a switch would be offering a path that is not
     there. The API is additive-only, so the field's presence *is* the
     capability. */
  const channel: ChannelStatus | null = servesChannels(s) ? s.channel : null;
  const inTheWay = channel ? channelBlock(channel) : null;
  /* **Whether this screen names the channels at all.** Off until somebody
     asks, at the foot of the page — and on regardless for anybody already on
     beta, by any of the four routes `channelsShown` names. The preference is
     local to this copy and grants nothing: the installation's channel is
     still the tag in `firetower.yml`, still an administrator's, and still
     only moved by the switch flow below. */
  const shown = channelsShown(revealed, channel, copy);
  const active = ((runs.data ?? []) as UpdateRun[]).find((r) => ACTIVE.includes(r.state));
  const mayMoveEverything = s.controlPlane.mayUpgrade ?? false;
  if (!primed) {
    setPrimed(true);
    setTicked(s.hosts.filter((h) => h.mayUpgrade).map((h) => h.hostId));
  }
  /* **No upgrade button where the upgrade would refuse.** A tag that names no
     channel fetches a version the updater was not told to fetch, exactly as an
     exact-version pin does, so the way forward is the block above the channel
     rows and not this button. Only when the server can say — an older control
     plane keeps the behaviour it has. */
  const movable =
    mayMoveEverything &&
    s.controlPlane.upgradable &&
    !active &&
    s.updateAvailable &&
    s.latest?.version !== s.current &&
    !inTheWay;
  const behind = s.hosts.filter((h) => h.mayUpgrade);
  /* **Never "Up to date." over a check that did not land.** This is the line
     both of the heading's quiet branches fall to, and a check that stopped
     now offers nothing — the server keeps the figure the last good one found
     so the screen can hold still, but shows it rather than offering it. So
     the deployment has nothing to *take*, which is not the same fact as the
     fleet being level, and the brick line under this already says what went
     wrong. A heading claiming agreement above a line saying the opposite is
     the sentence somebody acts on.

     This app's own build still speaks first when it has one: that is a
     different check, it did not fail, and it is the thing on this screen
     there is actually something to do about. */
  const level = build.newer
    ? `${build.newer} is out for this app.`
    : s.checkError
      ? "The last check could not say what is out."
      : "Up to date.";

  /* What the heading says is what this person can do something about. "A newer
     version is out" to somebody who cannot install it is a notice with no
     action behind it; what they can act on is a machine of theirs that is
     behind what the deployment is already running.

     The deployment speaks first when it has something to say, because moving
     it is the larger and rarer act — but when it has nothing, the heading is
     this app's, and never "Up to date." over a section offering a new build.
     The rail sends people here in slate for either one; a screen that then
     said there was nothing to take would be the bug. */
  const headline = inTheWay && inTheWay.tone === "amber"
    ? "This Firetower cannot upgrade until its image line changes."
    : mayMoveEverything
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
      ) : switching ? (
        <Switching
          asked={switching}
          onClose={() => {
            setSwitching(null);
            void refresh();
          }}
        />
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
              {/* **The tag goes in the cell that already says what is
                  running**, a step quieter, because the channel *is* that
                  tag. It costs no colour, which a channel is not allowed to. */}
              <s>{saysChannel(shown ? channel : null)}</s>
            </span>
            <span className="ver">
              {s.controlPlane.version}
              {channel && (channel.tag
                ? <i data-unknown={!channel.recognised || undefined}>:{channel.tag}</i>
                : <i data-unknown>tag unknown</i>)}
            </span>
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

          {channel ? (
            <ChannelSection channel={channel} blocked={!!active} shown={shown} onAct={setSwitching} />
          ) : (
            /* **A newer client against an older control plane.** Not a control
               it cannot serve, and not silence either: the mismatch is real
               and is explained in terms naming both versions. */
            <div className="note2">
              <span className="g"><Icon of={Info} size={14} /></span>
              <p>{mismatch(s.current, build.version)}</p>
            </div>
          )}

          <Copy status={s} shown={shown} />

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
      <Reveal shown={shown} revealed={revealed} />
    </Page>
  );
}

/**
 * The line that puts the release channels on the page, and takes them off.
 *
 * **A footnote, and deliberately not a control.** Beta is for the few people
 * who want every release as it is cut; for everybody else it was a larger
 * version number on the one screen whose job is to say what is running and
 * what is out. So it is one underlined line under a rule, at the foot, below
 * everything the screen is actually for — the weight of a thing you find
 * because you went looking, rather than a toggle competing with the buttons
 * above it.
 *
 * **It discloses; it does not permit.** Nothing here moves a channel. The
 * installation's is the tag in `firetower.yml`, install-wide, an
 * administrator's, and changed only by the switch flow that rewrites the file
 * and upgrades behind it. This copy's is the segmented control the line
 * brings back. Pressing this grants nothing to anybody.
 *
 * **Not drawn when the channels are already on the page for another reason.**
 * Somebody on beta sees the sections whatever the preference says, so a line
 * offering to hide them would be offering something it cannot do. It appears
 * again the moment they are off beta and the preference is the only thing
 * holding them open.
 */
function Reveal({ shown, revealed }: { shown: boolean; revealed: boolean }) {
  if (shown && !revealed) return null;
  return (
    <p className="upd-foot">
      <button
        type="button"
        onClick={() => revealChannels(!revealed)}
        aria-pressed={revealed}
        className="upd-foot-act"
      >
        {revealed ? "Hide pre-release channels" : "Pre-release channels"}
      </button>
    </p>
  );
}

/**
 * This copy of the app, wired to its stores.
 *
 * The section itself is `updates/ThisApp.tsx` and is pure, so a harness can
 * walk every one of its states. This is the half that reads the preference,
 * the build, the installation's manifest and the releases feed.
 *
 * **Its own channel is read and written here and nowhere else.** The
 * preference is local to this machine, the address it names is chosen per
 * check in the shell, and a change takes effect at the next check without a
 * restart — which is why pressing the control asks for one straight away
 * rather than waiting up to ten minutes to be believed.
 *
 * **Nothing in a browser tab, and the rest of this screen stays.** A tab has
 * no build of its own to move — it updates by being reloaded — so the whole
 * section goes. What is above and below it is about the control plane and the
 * machines, which is just as real on a page a control plane served, and the
 * headline below already falls back to the deployment's answer because
 * `build.newer` is null where there is no build to check. `~/installed-app`
 * carries the rule.
 */
function Copy({ status, shown }: { status: UpdateStatus | undefined; shown: boolean }) {
  const build = useBuild();
  const channel = useAppChannel();
  const [trouble, setTrouble] = useState<string | null>(null);
  const [spanOpen, setSpanOpen] = useState(false);
  const [span, setSpan] = useState<Span | null>(null);
  const [spanPending, setSpanPending] = useState(false);

  /* What general access holds for *the app*, from the installation's own
     manifest read. It is the only way a copy can know it is ahead: its own
     check against the general address correctly returns nothing, and
     "nothing" is not "ahead". A server too old to say leaves it unknown, and
     the block is not drawn rather than guessed at. */
  const generalPin = pinsFor(status?.channel, Package.desktop)?.general ?? null;

  useEffect(() => {
    if (!spanOpen || !build.version || !build.newer) return;
    let live = true;
    setSpanPending(true);
    void readSpan("desktop", build.version, build.newer)
      .then((found) => live && setSpan(found))
      .finally(() => live && setSpanPending(false));
    return () => {
      live = false;
    };
  }, [spanOpen, build.version, build.newer]);

  if (!installedApp()) return null;

  /* No confirmation. Nothing is lost — the servers and their tokens stay, and
     what it ends is this window, which is the thing the button says. */
  const go = () => {
    setTrouble(null);
    takeUpdate().catch((e) => {
      /* `whyUpdateFailed` rather than `why`, because this one failure carries
         its own next step: an update that could not write over the running
         copy is not one to try again in a few minutes. */
      setTrouble(whyUpdateFailed(e));
    });
  };

  const pick = (next: AppChannel) => {
    setAppChannel(next);
    setSpanOpen(false);
    setSpan(null);
    /* The address is chosen per check, so this is the whole of "takes effect
       at the next check". No restart, and nothing is installed by it. */
    void look();
  };

  return (
    <ThisApp
      build={build}
      channel={channel}
      onChannel={pick}
      from={installedFrom(build.version)}
      generalPin={generalPin}
      installationChannel={status && servesChannels(status) ? status.channel.channel : null}
      trouble={trouble}
      onTake={go}
      span={span}
      spanOpen={spanOpen}
      spanPending={spanPending}
      onSpan={() => setSpanOpen(!spanOpen)}
      releasePage={RELEASES}
      shown={shown}
    />
  );
}

/**
 * The switch, from the press to the run.
 *
 * The plan is asked for as soon as the panel opens, because the thing being
 * decided *is* what it would write — a panel that made you press again to find
 * that out would be asking you to agree first.
 */
function Switching({ asked, onClose }: { asked: ChannelAct; onClose: () => void }) {
  const plan = usePlanChannel();
  const go = useSwitchChannel();
  const backUp = useBackUpNow();
  const [requested, setRequested] = useState(false);

  if (!requested) {
    setRequested(true);
    plan.mutate({ data: { channel: asked.channel, files: [] } });
  }

  return (
    <SwitchPanel
      plan={plan.data}
      pending={plan.isPending}
      /* The server's own sentence, which is the one it published when it
         refused. Nothing here rewrites it. */
      trouble={plan.error ? why(plan.error) : go.error ? why(go.error) : null}
      lastBackup={null}
      backingUp={backUp.isPending}
      backedUp={backUp.isSuccess}
      onBackUp={() => backUp.mutate(undefined as never)}
      starting={go.isPending}
      onGo={(files) =>
        go.mutate(
          {
            data: {
              channel: asked.channel,
              /* Required for beta, and taken as read only because the block
                 above has already said what it means. A pin is not a move and
                 does not ask for it. */
              acknowledgeOneWay: asked.act === Act.switch,
              files,
            },
          },
          { onSuccess: onClose },
        )
      }
      onClose={onClose}
    />
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
  const [span, setSpan] = useState<Span | null>(null);
  const [spanPending, setSpanPending] = useState(false);

  if (!asked) {
    setAsked(true);
    plan.mutate({ data: { version, controlPlane: chosen.controlPlane } });
  }

  /* **The whole jump, not the newest release.** General access is a pin a
     maintainer moves deliberately, so an upgrade routinely skips versions and
     the newest release's notes would be the wrong answer on most of them.
     Read once per panel, on the press that opened it. */
  const from = status.current;
  useEffect(() => {
    if (!chosen.controlPlane || !version || version === from) return;
    let live = true;
    setSpanPending(true);
    void readSpan("controlPlane", from, version)
      .then((found) => live && setSpan(found))
      .finally(() => live && setSpanPending(false));
    return () => {
      live = false;
    };
  }, [chosen.controlPlane, version, from]);

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

      {chosen.controlPlane && version !== from && (
        <>
          <h4 className="mt-6 text-read font-medium text-bone">What changed</h4>
          <p className="why">
            General access skips versions as a matter of course, so this is every version in the jump
            rather than the newest one. Assembled per package; the app's own releases are in its own
            section.
          </p>
          <ChangelogSpan span={span} pending={spanPending} />
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

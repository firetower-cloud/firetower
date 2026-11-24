/**
 * The Updates screen's channel states, one at a time.
 *
 * **Not a mock of the sections — the sections**, imported, handed a
 * `ChannelStatus` from `channel-states.ts` and a `Build` from here. Reaching
 * them in the product needs a control plane on the branch that serves them
 * and an updater beside it; without this there is no way to look at a frozen
 * pin, a member's view or a span over the cap at all, let alone at four
 * widths in two themes.
 *
 * The address is the state: `/channels.html#frozen`, `#member`, `#b3`.
 * `shoot-channels.mjs` drives exactly these, so the parity pictures and the
 * assertions are of the same thing.
 *
 * Dev only. Vite serves it; it is not a build entry, so it cannot reach a
 * production bundle — the same arrangement as `demo.html` and `review.html`.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Building2, Download, RefreshCw } from "lucide-react";
import { Icon } from "~/components/ui";
import type { ChannelStatus, UpgradePlan } from "~/api/generated/model";
import { Act, Channel } from "~/api/generated/model";
import { aheadOfGeneral, channelBlock, channelsShown, pinsFor, saysChannel } from "~/api/updates";
import type { AppChannel } from "~/channel";
import type { Span } from "~/releases";
import type { Build } from "~/update";
import { ChannelSection, SwitchPanel } from "~/ui/updates/Channel";
import { ChangelogSpan } from "~/ui/updates/Span";
import { ThisApp } from "~/ui/updates/ThisApp";
import { CHANNEL_STATES, CHANNEL_STATE_NAMES, type ChannelState } from "~/ui/updates/channel-states";
import "~/theme";
import "~/styles.css";

const RELEASES = "https://github.com/firetower-cloud/firetower/releases";

/* ── What this copy is, per state ──────────────────────────────────────── */

const build = (over: Partial<Build> = {}): Build => ({
  version: "0.28.1",
  newer: null,
  channel: "general",
  from: null,
  taking: null,
  ...over,
});

/** The prototype's B states: three facts, and the rest is derived. */
const COPIES: Record<string, { build: Build; channel: AppChannel; from: AppChannel | null }> = {
  /** B1 — on general access, two versions behind it. */
  b1: { build: build({ newer: "0.29.1" }), channel: "general", from: null },
  /** B2 — on beta, with beta's build offered. */
  b2: { build: build({ newer: "0.30.0", channel: "beta" }), channel: "beta", from: null },
  /** B3 — switched back while ahead. Not an error, and nothing is offered. */
  b3: { build: build({ version: "0.30.0" }), channel: "general", from: "beta" },
  /** B4 — the two channels disagreeing, which is supported. */
  b4: { build: build({ version: "0.30.0", channel: "beta" }), channel: "beta", from: "beta" },
  /** A download in flight, so the progress the shell forwards is drawn. */
  downloading: {
    build: build({ newer: "0.29.1", taking: { downloaded: 61 * 1024 * 1024, total: 140 * 1024 * 1024 } }),
    channel: "general",
    from: null,
  },
};

/* ── The plan a switch produces ────────────────────────────────────────── */

const REPO = "ghcr.io/firetower-cloud/firetower";
const diff = (from: string, to: string) =>
  [
    "@@ -56,7 +56,7 @@ services:",
    "   firetower:",
    `-    image: ${REPO}:${from}`,
    `+    image: ${REPO}:${to}`,
    "     restart: unless-stopped",
    "@@ -137,7 +137,7 @@ services:",
    "   updater:",
    `-    image: ${REPO}-updater:${from}`,
    `+    image: ${REPO}-updater:${to}`,
    "     restart: unless-stopped",
  ].join("\n");

const switchPlan = (act: Act): UpgradePlan => ({
  version: act === Act.pin ? "0.54.1" : "0.56.0",
  files: [],
  envMissing: [],
  updaterUpgrade: false,
  channelChange: {
    channel: act === Act.pin ? Channel.general : Channel.beta,
    from: Channel.general,
    act,
    tag: act === Act.pin ? "stable" : "beta",
    version: act === Act.pin ? "0.54.1" : "0.56.0",
    irreversible: act !== Act.pin,
    file: "firetower.yml",
    lines: [
      { from: `${REPO}:${act === Act.pin ? "latest" : "stable"}`, to: `${REPO}:${act === Act.pin ? "stable" : "beta"}` },
      {
        from: `${REPO}-updater:${act === Act.pin ? "latest" : "stable"}`,
        to: `${REPO}-updater:${act === Act.pin ? "stable" : "beta"}`,
      },
    ],
    diff: act === Act.pin ? diff("latest", "stable") : diff("stable", "beta"),
  },
});

/* ── A span, without the network ───────────────────────────────────────── */

const note = (version: string, day: number, body: string) => ({
  version,
  publishedAt: new Date(Date.UTC(2026, 10, day)).toISOString(),
  notes: body,
  url: `${RELEASES}/tag/firetower-v${version}`,
});

const SECTION =
  "### Features\n\n* **server:** run an agent on a clock\n* **schedules:** edit one, in the sheet that made it\n\n### Bug Fixes\n\n* **server:** a pause lands before the run the sweep was about to start\n* **worker:** say why an agent did not start\n* **web:** keep On Linux when the release lookup failed\n";

const SPAN: Span = {
  package: "controlPlane",
  from: "0.50.0",
  to: "0.54.1",
  versions: [
    note("0.54.1", 11, "### Bug Fixes\n\n* **desktop:** reduce inner padding in the macOS app icon\n"),
    note("0.54.0", 10, SECTION),
    note("0.53.1", 9, "### Bug Fixes\n\n* **server:** an account that ran out is left mid-turn\n"),
    note("0.53.0", 9, SECTION),
    note("0.52.0", 8, SECTION),
    note("0.51.0", 5, SECTION),
  ],
  shortfallBelow: null,
  compareHref: `${RELEASES}/compare/firetower-v0.50.0...firetower-v0.54.1`,
  trouble: null,
};

/** A span that stopped at the cap: the boundary is named, never dropped. */
const LONG_SPAN: Span = {
  ...SPAN,
  from: "0.31.0",
  versions: Array.from({ length: 30 }, (_, i) =>
    note(`0.${54 - i}.0`, Math.max(1, 15 - (i % 14)), SECTION),
  ),
  shortfallBelow: "0.25.0",
  compareHref: `${RELEASES}/compare/firetower-v0.31.0...firetower-v0.54.1`,
};

/* ── The states, by address ────────────────────────────────────────────── */

type Panel = "none" | "switch" | "pin" | "plan" | "planlong";

type Scene = {
  channel: ChannelState | null;
  copy: keyof typeof COPIES;
  panel: Panel;
  /**
   * Whether the line at the foot has been pressed. **The preference, not the
   * answer** — what gets drawn is `channelsShown`, which also lets through
   * anybody already on beta. `undefined` keeps the states above as they were
   * photographed, with the channels on the page.
   */
  revealed?: boolean;
};

const SCENES: Record<string, Scene> = {
  /* A — the installation's channel. Drawn with the channels shown, which is
     what every one of these states is about; `hidden` below is the default
     page, and `onBeta` is the copy that gets them back regardless. */
  general: { channel: "general", copy: "b1", panel: "none" },
  beta: { channel: "beta", copy: "b1", panel: "none" },
  frozen: { channel: "frozen", copy: "b1", panel: "none" },
  unrecognised: { channel: "unrecognised", copy: "b1", panel: "none" },
  pinned: { channel: "pinned", copy: "b1", panel: "none" },
  noUpdater: { channel: "noUpdater", copy: "b1", panel: "none" },
  member: { channel: "member", copy: "b1", panel: "none" },
  manifestUnreadable: { channel: "manifestUnreadable", copy: "b1", panel: "none" },
  manifestVanished: { channel: "manifestVanished", copy: "b1", panel: "none" },
  manifestAbsent: { channel: "manifestAbsent", copy: "b1", panel: "none" },
  /** A control plane too old to know about channels at all. */
  oldServer: { channel: null, copy: "b1", panel: "none" },
  /* The panels. */
  switch: { channel: "general", copy: "b1", panel: "switch" },
  pin: { channel: "frozen", copy: "b1", panel: "pin" },
  plan: { channel: "general", copy: "b1", panel: "plan" },
  planlong: { channel: "general", copy: "b1", panel: "planlong" },
  /* B — this copy. */
  b1: { channel: "general", copy: "b1", panel: "none" },
  b2: { channel: "general", copy: "b2", panel: "none" },
  b3: { channel: "general", copy: "b3", panel: "none" },
  b4: { channel: "general", copy: "b4", panel: "none" },
  downloading: { channel: "general", copy: "downloading", panel: "none" },
  /* ── The channels, hidden and revealed ────────────────────────────────
     `hidden` is the page everybody gets: a general-access installation, a
     copy on general access, nobody having asked for anything. `hiddenMember`
     is the same for somebody who does not administer it — the reader the
     change is most for. `revealed` is the line at the foot pressed.
     `onBetaHidden` is the edge the preference must not win: the installation
     is on beta, so the sections are drawn whatever the preference says. */
  hidden: { channel: "general", copy: "b1", panel: "none", revealed: false },
  hiddenMember: { channel: "member", copy: "b1", panel: "none", revealed: false },
  revealed: { channel: "general", copy: "b1", panel: "none", revealed: true },
  /* The installation is on beta and nobody has asked for anything: the
     sections are drawn regardless, because a screen that would not name the
     channel it is running is lying about what is installed. */
  onBetaHidden: { channel: "beta", copy: "b1", panel: "none", revealed: false },
  /* Same, by way of this copy rather than the installation. */
  copyOnBetaHidden: { channel: "general", copy: "b2", panel: "none", revealed: false },
  /* And by way of provenance alone — switched back, still running the build
     beta gave it. */
  copyFromBetaHidden: { channel: "general", copy: "b3", panel: "none", revealed: false },
  /* A decision block with the channels hidden: it has to keep working, and it
     names `:beta` because that is one of the two tags the line may become. */
  hiddenFrozen: { channel: "frozen", copy: "b1", panel: "none", revealed: false },
};

const NAMES = Object.keys(SCENES);
const asked = window.location.hash.replace(/^#/, "");
const first = NAMES.includes(asked) ? asked : "general";

function Harness() {
  const [name, setName] = useState(first);
  const scene = SCENES[name] ?? SCENES.general;
  const channel: ChannelStatus | null = scene.channel ? CHANNEL_STATES[scene.channel] : null;
  const copy = COPIES[scene.copy];
  /* **The product's own rule, not the scene's.** The preference comes off the
     scene rather than out of storage — a value that leaked between scenes
     would make each picture depend on the one before it — but what is
     *drawn* goes through `channelsShown`, exactly as `Updates.tsx` does. So
     a scene asking for the channels to be hidden on an installation that is
     on beta gets them anyway, which is the whole point of that rule and has
     to be visible in the picture rather than only in a test. */
  const shown =
    scene.revealed === undefined ||
    channelsShown(scene.revealed, channel, {
      channel: copy.channel,
      from: copy.from,
      ahead: aheadOfGeneral(copy.build.version, pinsFor(channel ?? undefined, "desktop")?.general),
    });
  const [channelPick, setChannelPick] = useState<AppChannel>(copy.channel);
  const [spanOpen, setSpanOpen] = useState(false);
  const [acted, setActed] = useState<string | null>(null);

  /* The state the shoot script reads back, so an assertion is about what the
     page was handed rather than about a guess at it. */
  (window as unknown as { __STATE__: unknown }).__STATE__ = { name, channel, copy };

  const show = (next: string) => {
    setName(next);
    setChannelPick(COPIES[SCENES[next].copy].channel);
    setSpanOpen(false);
    setActed(null);
    window.location.hash = next;
  };

  const block = channel ? channelBlock(channel) : null;
  const headline =
    block && block.tone === "amber"
      ? "This Firetower cannot upgrade until its image line changes."
      : "0.54.1 is out.";

  return (
    <div className="flex h-full flex-col bg-panel">
      <div
        data-harness="bar"
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-ground px-3 py-2"
      >
        {NAMES.map((n) => (
          <button key={n} className="fp" aria-pressed={name === n} onClick={() => show(n)}>
            {n}
          </button>
        ))}
      </div>

      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto bg-ground">
        <div className="pg mx-auto max-w-[52rem] px-6 py-6 pb-16">
          <div className="upd-hero">
            <h1>{headline}</h1>
            <p>
              Running <span className="font-mono text-bone">0.50.0</span>
              <span className="text-mute"> · checked 14:32</span>
            </p>
          </div>

          {scene.panel === "switch" || scene.panel === "pin" ? (
            <SwitchPanel
              plan={switchPlan(scene.panel === "pin" ? Act.pin : Act.switch)}
              pending={false}
              trouble={null}
              lastBackup="6 days ago, before 0.50.0 was installed"
              backingUp={false}
              backedUp={false}
              onBackUp={() => setActed("backed up")}
              onGo={() => setActed("switched")}
              onClose={() => show("general")}
              starting={false}
            />
          ) : scene.panel === "plan" || scene.panel === "planlong" ? (
            <div className="run">
              <div className="top">
                <b>What 0.54.1 wants to write on this Firetower</b>
              </div>
              <p className="why">
                2 files. One of them you have edited since it was installed — keep your version and the
                upgrade skips it, or take theirs and yours is overwritten.
              </p>
              <div className="plan-files">
                <div className="diffrow">
                  <span className="k">write</span>
                  <span className="p">firetower.yml</span>
                  <span className="n">the release changes it</span>
                </div>
                <div className="diffrow">
                  <span className="k">skip</span>
                  <span className="p">Caddyfile</span>
                  <span className="n inway">your edits are in the way</span>
                </div>
              </div>
              <h4 className="mt-6 text-read font-medium text-bone">What changed</h4>
              <p className="why">
                General access skips versions as a matter of course, so this is every version in the
                jump rather than the newest one. Assembled per package; the app's own releases are in
                its own section.
              </p>
              <ChangelogSpan
                span={scene.panel === "planlong" ? LONG_SPAN : SPAN}
                pending={false}
              />
              <div className="foot">
                <button className="btn primary">Start the upgrade</button>
                <button className="btn quiet">Back</button>
              </div>
            </div>
          ) : (
            <>
              <div className="upd-row">
                <span className="g">
                  <Icon of={Building2} size={20} />
                </span>
                <span className="tx">
                  <b>This Firetower</b>
                  <s>{saysChannel(shown ? channel : null)}</s>
                </span>
                <span className="ver">
                  0.50.0
                  {channel &&
                    (channel.tag ? (
                      <i data-unknown={!channel.recognised || undefined}>:{channel.tag}</i>
                    ) : (
                      <i data-unknown>tag unknown</i>
                    ))}
                </span>
                <span className="acts">
                  {!block && channel?.mayChange && (
                    <button className="btn primary">
                      <Icon of={Download} size={14} />
                      Upgrade to 0.54.1
                    </button>
                  )}
                  <button className="btn quiet">
                    <Icon of={RefreshCw} size={14} />
                    Check again
                  </button>
                </span>
              </div>

              {channel ? (
                <ChannelSection
                  channel={channel}
                  blocked={false}
                  shown={shown}
                  onAct={(a) => {
                    setActed(`${a.act} ${a.channel}`);
                    show(a.act === Act.pin ? "pin" : "switch");
                  }}
                />
              ) : (
                <div className="note2">
                  <span className="g" />
                  <p>
                    This Firetower is 0.30.1 and does not report release channels. This app is 0.28.1,
                    which can read them. Nothing is wrong with either; the installation's channel
                    appears here once it has been upgraded. Your own copy's channel, below, is
                    unaffected.
                  </p>
                </div>
              )}

              <ThisApp
                build={{ ...copy.build, channel: channelPick }}
                channel={channelPick}
                onChannel={setChannelPick}
                from={copy.from}
                generalPin={pinsFor(channel ?? undefined, "desktop")?.general ?? null}
                installationChannel={channel ? channel.channel : null}
                trouble={null}
                onTake={() => setActed("taking the update")}
                span={SPAN}
                spanOpen={spanOpen}
                spanPending={false}
                onSpan={() => setSpanOpen(!spanOpen)}
                releasePage={RELEASES}
                shown={shown}
              />
            </>
          )}

          {/* The same condition `Reveal` applies in the product: no line where
              the channels are already on the page for another reason, because
              it would be offering to hide something it cannot. */}
          {scene.panel === "none" && !(shown && !scene.revealed) && (
            <p className="upd-foot">
              <button type="button" className="upd-foot-act" aria-pressed={!!scene.revealed}>
                {scene.revealed ? "Hide pre-release channels" : "Pre-release channels"}
              </button>
            </p>
          )}

          {acted && <p className="mt-6 text-meta text-mute">harness: {acted}</p>}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);

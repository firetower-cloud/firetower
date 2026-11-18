/**
 * Every state the channel screen can be in, as the API would return it.
 *
 * One specimen per state in the approved prototype, so the harness that draws
 * them and the tests that assert about them are about the same objects. The
 * sentences in `problem` and `reason` are the control plane's own, copied from
 * `crates/ft-server/src/updates/channel.rs` — the screen never writes its own
 * words over a refusal, so a specimen that invented them would be testing
 * something the product does not do.
 */
import type { ChannelStatus, ManifestView, Offer, Pins } from "~/api/generated/model";
import { Act, Channel, ManifestOutcome, Package } from "~/api/generated/model";

const REPO = "ghcr.io/firetower-cloud/firetower";

/** What the two channels hold, per package. */
const PINS: Pins[] = [
  {
    package: Package.controlPlane,
    beta: "0.56.0",
    general: "0.54.1",
    generalPromotedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
  },
  {
    package: Package.desktop,
    beta: "0.30.0",
    general: "0.29.1",
    generalPromotedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
  },
];

const MANIFEST: ManifestView = {
  outcome: ManifestOutcome.found,
  problem: null,
  schemaVersion: 1,
  packages: PINS,
  readAt: new Date().toISOString(),
  url: "https://github.com/firetower-cloud/firetower/releases/download/channels/channels.json",
};

const GENERAL: Offer = {
  channel: Channel.general,
  tag: "stable",
  offers: "Releases a maintainer has promoted.",
  version: "0.54.1",
  since: PINS[0].generalPromotedAt,
  on: true,
  action: null,
  irreversible: false,
  reason: null,
};

const BETA: Offer = {
  channel: Channel.beta,
  tag: "beta",
  offers: "Every release, as soon as it is cut.",
  version: "0.56.0",
  since: null,
  on: false,
  action: Act.switch,
  irreversible: true,
  reason: null,
};

const base = (): ChannelStatus => ({
  channel: Channel.general,
  tag: "stable",
  image: `${REPO}:stable`,
  recognised: true,
  pinned: false,
  problem: null,
  switchable: true,
  reason: null,
  mayChange: true,
  manifest: MANIFEST,
  offers: [{ ...GENERAL }, { ...BETA }],
});

/** The states, by the name the prototype gives each one. */
export const CHANNEL_STATES = {
  /** A1 — at rest, on general access. */
  general: base(),

  /** A2 — on beta. General access is drawn with the reason it cannot be taken. */
  beta: {
    ...base(),
    channel: Channel.beta,
    tag: "beta",
    image: `${REPO}:beta`,
    offers: [
      {
        ...GENERAL,
        on: false,
        action: null,
        reason:
          "this Firetower is running 0.56.0, which is newer than the 0.54.1 general access holds. Nothing is ever moved backwards.",
      },
      { ...BETA, on: true, action: null, reason: "this Firetower is on beta" },
    ],
  } as ChannelStatus,

  /** A7 — the pre-channel floating tag. Frozen, and the message names why. */
  frozen: {
    ...base(),
    tag: "latest",
    image: `${REPO}:latest`,
    recognised: false,
    problem:
      ":latest does not name a channel, so this Firetower is treated as general access — which is the safe answer, and an assumption rather than a reading.",
    offers: [
      { ...GENERAL, action: Act.pin },
      { ...BETA, action: Act.switch },
    ],
  } as ChannelStatus,

  /** A8 — a tag that names no channel at all. */
  unrecognised: {
    ...base(),
    tag: "edge",
    image: `${REPO}:edge`,
    recognised: false,
    problem:
      ":edge does not name a channel, so this Firetower is treated as general access — which is the safe answer, and an assumption rather than a reading.",
    offers: [
      { ...GENERAL, action: Act.pin },
      { ...BETA, action: Act.switch },
    ],
  } as ChannelStatus,

  /** An exact version in the image line: no upgrade can move it at all. */
  pinned: {
    ...base(),
    tag: "0.55.0",
    image: `${REPO}:0.55.0`,
    recognised: false,
    pinned: true,
    switchable: false,
    problem:
      ":0.55.0 does not name a channel, so this Firetower is treated as general access — which is the safe answer, and an assumption rather than a reading.",
    reason: `${REPO} is pinned to :0.55.0 in firetower.yml, which the updater will not move. Change that line to :stable for general access, or to :beta, and the switch can be taken.`,
    offers: [
      {
        ...GENERAL,
        action: null,
        reason: `${REPO} is pinned to :0.55.0 in firetower.yml, which the updater will not move. Change that line to :stable for general access, or to :beta, and the switch can be taken.`,
      },
      {
        ...BETA,
        action: null,
        reason: `${REPO} is pinned to :0.55.0 in firetower.yml, which the updater will not move. Change that line to :stable for general access, or to :beta, and the switch can be taken.`,
      },
    ],
  } as ChannelStatus,

  /** A9 — nothing to ask what image is running. A third answer, not a false one. */
  noUpdater: {
    ...base(),
    tag: null,
    image: null,
    recognised: false,
    switchable: false,
    problem:
      "The updater is what reports the image this Firetower is running, so without one the channel cannot be read and cannot be changed from here. General access is the assumption. No FIRETOWER_UPDATER_TOKEN is set, so the updater refuses everything.",
    reason:
      "The updater is what reports the image this Firetower is running, so without one the channel cannot be read and cannot be changed from here. General access is the assumption.",
    offers: [
      { ...GENERAL, action: null, reason: "the updater beside this control plane cannot be asked" },
      { ...BETA, action: null, reason: "the updater beside this control plane cannot be asked" },
    ],
  } as ChannelStatus,

  /** A10 — reading is not upgrading. The channel as a fact, with no control. */
  member: { ...base(), mayChange: false } as ChannelStatus,

  /** The manifest did not read. Never a zero, and never the newest release. */
  manifestUnreadable: {
    ...base(),
    switchable: false,
    reason:
      "the channel manifest at https://github.com/firetower-cloud/firetower/releases/download/channels/channels.json answered 429 Too Many Requests. Nothing is being moved.",
    manifest: {
      ...MANIFEST,
      outcome: ManifestOutcome.unreadable,
      problem:
        "the channel manifest at https://github.com/firetower-cloud/firetower/releases/download/channels/channels.json answered 429 Too Many Requests",
    },
    offers: [
      {
        ...GENERAL,
        version: null,
        since: null,
        action: null,
        reason: "the channel manifest could not be read. Nothing is being moved.",
      },
      {
        ...BETA,
        version: null,
        action: null,
        reason: "the channel manifest could not be read. Nothing is being moved.",
      },
    ],
  } as ChannelStatus,

  /**
   * **The document was read before and is gone.** Not the same thing as a
   * read that failed: this one gets worse while nobody acts on it, because
   * every installation reading it is told the same until it is republished.
   */
  manifestVanished: {
    ...base(),
    switchable: false,
    reason:
      "the channel manifest has gone from https://github.com/firetower-cloud/firetower/releases/download/channels/channels.json. This installation has read one before, so the document has been destroyed rather than never published — it has to be put back, and waiting will not bring it back. Nothing is being moved.",
    manifest: {
      ...MANIFEST,
      outcome: ManifestOutcome.vanished,
      problem:
        "the channel manifest has gone from https://github.com/firetower-cloud/firetower/releases/download/channels/channels.json. This installation has read one before, so the document has been destroyed rather than never published — it has to be put back, and waiting will not bring it back.",
    },
    offers: [
      {
        ...GENERAL,
        action: null,
        reason: "the channel manifest has gone. Nothing is being moved.",
      },
      {
        ...BETA,
        action: null,
        reason: "the channel manifest has gone. Nothing is being moved.",
      },
    ],
  } as ChannelStatus,

  /** Nothing published yet — the bootstrap case, and not a problem. */
  manifestAbsent: {
    ...base(),
    switchable: false,
    reason:
      "no channel manifest has been published yet, so neither channel names a version. This Firetower follows the newest release, as it did before channels existed.",
    manifest: { ...MANIFEST, outcome: ManifestOutcome.absent, packages: [], problem: null },
    offers: [
      { ...GENERAL, version: null, since: null, action: null, reason: "no channel manifest has been published yet" },
      { ...BETA, version: null, action: null, reason: "no channel manifest has been published yet" },
    ],
  } as ChannelStatus,
} satisfies Record<string, ChannelStatus>;

export type ChannelState = keyof typeof CHANNEL_STATES;

export const CHANNEL_STATE_NAMES = Object.keys(CHANNEL_STATES) as ChannelState[];

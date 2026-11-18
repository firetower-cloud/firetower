import type {
  Act,
  ChannelStatus,
  FilePlan,
  HostTarget,
  Offer,
  Package,
  ManifestView,
  Pins,
  RunState,
  StepState,
  UpdateRun,
  UpdateStatus,
  UpgradePlan,
} from "./generated/model";
import { Channel, ManifestOutcome } from "./generated/model";

/**
 * What the Updates screen works out for itself.
 *
 * Pure, so the questions a run raises — what would end, what is behind, how
 * long it took — are answered the same way on the screen and under a test.
 */

/** Which of the targets a person may tick. */
export type Chosen = { controlPlane: boolean; hostIds: string[] };

/** Everything that can be moved, ticked. What the screen starts with. */
export function everythingUpgradable(status: UpdateStatus): Chosen {
  return {
    controlPlane: status.controlPlane.upgradable,
    hostIds: status.hosts.filter((h) => h.upgradable).map((h) => h.hostId),
  };
}

/** Nothing ticked means nothing to do. */
export function nothingChosen(chosen: Chosen): boolean {
  return !chosen.controlPlane && chosen.hostIds.length === 0;
}

/**
 * Whether the run may be started.
 *
 * The plan is a condition only when the control plane is a target. It answers
 * what an upgrade writes to the deployment's files, and a worker upgrade
 * writes none of them — so waiting for one either way is what left a worker
 * alone and behind on a deployment whose updater was never configured, under
 * a message about a container that had no part in it.
 */
export function canStart(chosen: Chosen, plan: UpgradePlan | undefined): boolean {
  if (nothingChosen(chosen)) return false;
  return !chosen.controlPlane || !!plan;
}

/**
 * The sessions that end if the chosen targets are reinstalled now, by title
 * and by where they are — what the confirmation has to say out loud.
 */
export function wouldEnd(
  status: UpdateStatus,
  chosen: Chosen,
): { where: string; sessions: string[] }[] {
  const ended: { where: string; sessions: string[] }[] = [];
  // Nothing for the control plane. A session could once run as a child of its
  // process, so recreating the container ended whatever was in it; nothing
  // runs there now, and `ControlPlaneTarget` has no `sessions` to read.
  for (const host of status.hosts) {
    if (chosen.hostIds.includes(host.hostId) && host.sessions.length > 0) {
      ended.push({ where: host.name, sessions: host.sessions });
    }
  }
  return ended;
}

export function countEnded(ended: { sessions: string[] }[]): number {
  return ended.reduce((n, e) => n + e.sessions.length, 0);
}

/** "2 sessions" / "a session" — the number, said. */
export function sessionsWord(n: number): string {
  return n === 1 ? "a session" : `${n} sessions`;
}

/** What a host row says on its right-hand side. */
export function hostNote(host: HostTarget): string {
  if (host.reason) return host.reason;
  if (host.sessions.length > 0) return `ends ${sessionsWord(host.sessions.length)}`;
  return "idle";
}

/** Whether a file needs a decision from a person before a run may write it. */
export function needsChoice(file: FilePlan): boolean {
  return file.verdict === "Edited";
}

/** Whether a file is written at all, given the choice made about it. */
export function willWrite(file: FilePlan, replace: boolean): boolean {
  switch (file.verdict) {
    case "Update":
    case "New":
      return true;
    case "Edited":
      return replace;
    default:
      return false;
  }
}

export const ACTIVE: RunState[] = ["planned", "waitingIdle", "waitingDecision", "running"];

export const isActive = (run: { state: RunState }) => ACTIVE.includes(run.state);

/** A run's state, in a word for a badge. */
export const RUN_LABEL: Record<RunState, string> = {
  planned: "starting",
  waitingIdle: "waiting for idle",
  waitingDecision: "waiting for you",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

export function runTone(state: RunState): "sage" | "brick" | "slate" | "neutral" {
  switch (state) {
    case "succeeded":
      return "sage";
    case "failed":
      return "brick";
    case "waitingDecision":
      return "brick";
    case "running":
    case "waitingIdle":
    case "planned":
      return "slate";
    default:
      return "neutral";
  }
}

/** Whether this run is stopped waiting for somebody to answer. */
export const needsAnAnswer = (run: { state: RunState }) => run.state === "waitingDecision";

/** The glyph in front of a step. */
export function stepGlyph(state: StepState): string {
  switch (state) {
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "running":
      return "●";
    case "warned":
      return "!";
    case "skipped":
      return "–";
    default:
      return "○";
  }
}

/** How long something took, or has been going: "4m12s", "18s", "1h03m". */
export function duration(from?: string | null, to?: string | null): string {
  if (!from) return "";
  const start = new Date(from).getTime();
  const end = to ? new Date(to).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** One line for the history: what moved, how it went, how long. */
export function runSummary(run: UpdateRun): string {
  const parts = [`${run.fromVersion} → ${run.toVersion}`, RUN_LABEL[run.state]];
  const took = duration(run.startedAt, run.finishedAt);
  if (took && !isActive(run)) parts.push(took);
  return parts.join(" · ");
}

/**
 * The profile menu's Updates row, and the mark on the avatar above it.
 *
 * Two release trains answer to one row: this app's own build, and the
 * deployment it is pointed at. Either one being behind is something there is to
 * take, so either one lights the mark.
 *
 * **`dot` means one thing: there is an update to take.** Nothing else may set
 * it. It is the only signal on the avatar besides the ember one, it is read
 * without hover and without opening anything, and a mark that can mean several
 * things means nothing — so a run already going, a failed check or an unread
 * release note do not get to borrow it. `ProfileMenu.tsx` says the same thing
 * at the site that draws it.
 *
 * **`label` carries what the mark cannot: which version.** The mark says
 * something is in here; the row says what, and "Update available" with no
 * number is a sentence you have to open the screen to act on. The deployment's
 * release wins when both trains are behind — it is the thing the Updates screen
 * acts on, and the app's own build moves itself.
 *
 * A run in progress says so in words and takes no mark. It is worth knowing
 * about, there is nothing in it to decide, and you are the one who started it.
 */
export function updatesRow(
  status: UpdateStatus | undefined,
  /** The build that is out, if this app's own check found a newer one. */
  newBuild: string | null,
): { label: string; dot: boolean } {
  if (status?.updateAvailable || newBuild) {
    const ready = (status?.updateAvailable ? status.latest?.version : null) ?? newBuild;
    return { label: ready ? `Update available — ${ready}` : "Update available", dot: true };
  }
  return { label: status?.activeRun ? "Upgrading…" : "Updates", dot: false };
}

/** A diff, line by line, with what each line is. */
export function diffLines(diff: string): { kind: "add" | "del" | "hunk" | "meta" | "same"; text: string }[] {
  return diff
    .split("\n")
    .filter((l, i, all) => !(i === all.length - 1 && l === ""))
    .map((text) => {
      if (text.startsWith("+++") || text.startsWith("---")) return { kind: "meta" as const, text };
      if (text.startsWith("@@")) return { kind: "hunk" as const, text };
      if (text.startsWith("+")) return { kind: "add" as const, text };
      if (text.startsWith("-")) return { kind: "del" as const, text };
      return { kind: "same" as const, text };
    });
}

/* ── Channels ───────────────────────────────────────────────────────────
   **Two things on this screen wear the word, and they are not two of the
   same thing.** Everything below is about the *installation's* channel: the
   tag on the image it is running, an administrator's, and the same for
   everybody connected to it. The channel of *this copy of the app* is a
   local preference and lives in `~/channel`.

   The server publishes a control or the reason there is none, per channel
   row, so nothing here decides what may be done — it decides what a row
   *says*, which is the half the API deliberately leaves to a screen. */

/**
 * Whether this control plane can answer about channels at all.
 *
 * **The client is newer than the server it is pointed at more often than the
 * reverse**, because a copy's channel is its own and most people running the
 * app are not the person who upgrades the server. So the screen reads the
 * answer rather than the version: a control plane that predates channels
 * returns an `UpdateStatus` with no `channel` on it, and a screen that then
 * drew a switch would be offering a path that 404s.
 *
 * Not a version comparison. The API is additive-only, so the presence of the
 * field *is* the capability, and a window stated in version numbers would
 * have to be widened every time beta ran ahead — which is routine rather than
 * exceptional.
 */
export function servesChannels(status: UpdateStatus | undefined): boolean {
  return !!status?.channel;
}

/**
 * How to say a mismatch, when there is a real one.
 *
 * Both versions, named. "Your client is too new" is an error with no action
 * behind it — a copy is never downgraded — so this says what the server is,
 * what this copy is, and which of the two moving would fix it.
 */
export function mismatch(serverVersion: string, appVersion: string | null): string {
  return `This Firetower is ${serverVersion} and does not report release channels. This app is ${appVersion ?? "a newer build"}, which can read them. Nothing is wrong with either; the installation's channel appears here once it has been upgraded. Your own copy's channel, below, is unaffected.`;
}

/** The block a channel's state wants drawn above the rows, if any. */
export type ChannelBlock = {
  kind: "pinned" | "frozen" | "unrecognised" | "noUpdater";
  tone: "amber" | "slate";
};

/**
 * The one thing about this installation's channel that needs attention.
 *
 * At most one, in the order an operator would have to fix them. The tone is
 * the design's rule rather than a severity dial: **amber means read this
 * before you act and the installation cannot move until you do**; slate
 * states a fact that is not in the way.
 *
 *   * `pinned` — the image line names an exact version. No upgrade can move
 *     this installation at all until it changes. Amber.
 *   * `frozen` — the pre-channel floating tag. It follows the newest build
 *     published, which is beta's, so the updater fetches a version it was not
 *     told to fetch and refuses. It is unrecognised like the others and it is
 *     the only unrecognised tag that is *actively* handing this installation
 *     the wrong build, which is why it is the one that goes amber.
 *   * `unrecognised` — `edge`, a two-part tag, a local build. Treated as
 *     general access, which is the safe answer, and said rather than assumed.
 *     Slate: nothing is broken until an upgrade is attempted.
 *   * `noUpdater` — nothing to ask what image is running. Slate.
 */
export function channelBlock(channel: ChannelStatus): ChannelBlock | null {
  if (!channel.tag) return { kind: "noUpdater", tone: "slate" };
  if (channel.pinned) return { kind: "pinned", tone: "amber" };
  if (!channel.recognised) {
    return channel.tag === FLOATING
      ? { kind: "frozen", tone: "amber" }
      : { kind: "unrecognised", tone: "slate" };
  }
  return null;
}

/**
 * The tag that existed before channels and kept its conventional meaning:
 * the newest build published, which under a continuous beta is beta's.
 *
 * Named here rather than inferred, because it is the one tag the
 * specification calls out by name — "not a channel, and not what an operator
 * should pin" — and it is also the one somebody will pin by mistake.
 */
export const FLOATING = "latest";

/** The offer that would make an unrecognised tag name the channel it is treated as. */
export function pinOffer(channel: ChannelStatus): Offer | undefined {
  return channel.offers.find((o) => o.action === "pin");
}

/** The offer that would move this installation to the other channel. */
export function switchOffer(channel: ChannelStatus): Offer | undefined {
  return channel.offers.find((o) => o.action === "switch");
}

/** What one channel row's right-hand cell carries. */
export type RowVerdict =
  | { kind: "on" }
  | { kind: "act"; act: Act; irreversible: boolean }
  | { kind: "said"; said: string };

/**
 * One channel row, decided.
 *
 * **No control the server would refuse, and none this reader may not take.**
 * The action comes from the server; `mayChange` narrows it to an
 * administrator. A member is not shown a greyed-out button — that is how an
 * interface says you are being withheld from — they are shown the fact and
 * whose it is.
 *
 * The sentence in the `said` case is kept short on purpose: the server's full
 * reason is a paragraph and goes under the rows, where a paragraph fits. A
 * row that grew to hold one pushed the version and the verdict off the end.
 */
export function rowVerdict(
  offer: Offer,
  channel: ChannelStatus,
  mayChange: boolean,
  blocked: boolean,
): RowVerdict {
  if (offer.on && channel.recognised) return { kind: "on" };
  if (!mayChange) {
    return { kind: "said", said: offer.on ? "On this installation" : "You do not administer this Firetower" };
  }
  if (blocked) return { kind: "said", said: "An upgrade is running" };
  /* A pin is offered in the block above the rows, where its consequence and
     its diff are — so the row it belongs to says what the row is for. */
  if (offer.action === "pin") return { kind: "said", said: "Assumed" };
  if (offer.action) return { kind: "act", act: offer.action, irreversible: offer.irreversible };
  if (!channel.tag) return { kind: "said", said: "Needs the updater" };
  return { kind: "said", said: offer.on ? "On this installation" : "Not available yet" };
}

/**
 * What a channel row's second line says: what it offers, and what it holds.
 *
 * The version is the manifest's, never the newest release — a manifest that
 * could not be read says so rather than putting a zero here.
 */
export function rowOffers(offer: Offer): string {
  const holds = offer.version
    ? offer.since
      ? `${offer.version}, promoted ${ago(offer.since)}.`
      : `${offer.version}.`
    : "No version yet.";
  return `${offer.offers} ${holds}`;
}

/** "5 days ago", in the drawing's words rather than a date. */
export function ago(at: string): string {
  const days = Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}

/** What one package's channels hold, from the installation's last manifest read. */
export function pinsFor(channel: ChannelStatus | undefined, pkg: Package): Pins | undefined {
  return channel?.manifest.packages.find((p) => p.package === pkg);
}

/**
 * What the installation's channel row says on its second line.
 *
 * The row already carried one line of explanation; this replaces it with the
 * one fact that now matters. An assumption says so — a channel that could not
 * be read is never asserted.
 */
export function saysChannel(channel: ChannelStatus | null): string {
  if (!channel) return "The control plane and everything it serves";
  if (!channel.tag || !channel.recognised) {
    return "The control plane and everything it serves. Treated as general access.";
  }
  return channel.channel === Channel.beta
    ? "On beta. Every release reaches this installation."
    : "On general access. Releases a maintainer has promoted.";
}

/** What is wrong with the channel manifest, if anything. */
export type ManifestTrouble = {
  /** `destroyed` is the one that gets worse while nobody acts on it. */
  kind: "destroyed" | "unreadable";
  /** The server's own sentence for this outcome. */
  problem: string | null;
};

/**
 * Whether the document that says what every installation upgrades to is in
 * trouble, and which kind.
 *
 * **Two states a person ever sees, and they must not look alike.** A read
 * that failed is transient — a rate limit, a network blip — and the right
 * answer is to wait. A document that *was* read before and has gone has been
 * **destroyed**, and waiting makes it worse: until somebody republishes it,
 * every installation reading it is told the same thing. If the copy for the
 * two reads the same, the distinction has bought nothing.
 *
 * `absent` is neither: nothing has been published yet, which is the bootstrap
 * case and the only one that is not a problem — the installation follows the
 * newest release, as it did before channels existed.
 */
export function manifestTrouble(manifest: ManifestView): ManifestTrouble | null {
  const { outcome } = manifest;
  if (outcome === ManifestOutcome.found || outcome === ManifestOutcome.absent) return null;
  return {
    kind: outcome === ManifestOutcome.vanished ? "destroyed" : "unreadable",
    problem: manifest.problem ?? null,
  };
}

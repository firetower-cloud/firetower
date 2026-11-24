import { describe, expect, it } from "vitest";
import type {
  ChannelStatus,
  FilePlan,
  Offer,
  HostTarget,
  UpdateRun,
  UpdateStatus,
  UpgradePlan,
} from "./generated/model";
import {
  canStart,
  channelBlock,
  countEnded,
  diffLines,
  duration,
  everythingUpgradable,
  hostNote,
  manifestTrouble,
  mismatch,
  needsChoice,
  pinOffer,
  pinsFor,
  rowOffers,
  rowVerdict,
  servesChannels,
  switchOffer,
  nothingChosen,
  runSummary,
  isActive,
  needsAnAnswer,
  RUN_LABEL,
  runTone,
  stepGlyph,
  updatesRow,
  willWrite,
  wouldEnd,
} from "./updates";

const host = (over: Partial<HostTarget> = {}): HostTarget => ({
  hostId: "h_1",
  name: "fire-01",
  version: "0.30.1",
  online: true,
  drained: false,
  upgradable: true,
  reason: null,
  sessions: [],
  ...over,
});

const channel = (over: Partial<ChannelStatus> = {}): ChannelStatus => ({
  channel: "general",
  tag: "stable",
  image: "ghcr.io/firetower-cloud/firetower:stable",
  recognised: true,
  pinned: false,
  problem: null,
  switchable: true,
  reason: null,
  mayChange: true,
  manifest: {
    outcome: "found",
    problem: null,
    schemaVersion: 1,
    packages: [],
    readAt: null,
    url: "https://example.test/channels.json",
  },
  offers: [],
  ...over,
});

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  current: "0.30.1",
  latest: {
    version: "0.31.0",
    publishedAt: null,
    notesUrl: null,
    notes: null,
    cliMinimum: null,
  },
  checkedAt: null,
  checkError: null,
  updateAvailable: true,
  controlPlane: {
    version: "0.30.1",
    upgradable: true,
    reason: null,
    updater: { configured: true, reachable: true, version: "0.30.1", apiVersion: 1, problem: null },
  },
  hosts: [
    host(),
    host({ hostId: "h_2", name: "hetzner-2", sessions: ["web"] }),
    host({ hostId: "h_3", name: "gcp-old", upgradable: false, reason: "up to date" }),
  ],
  activeRun: null,
  channel: channel(),
  ...over,
});

describe("what starts ticked", () => {
  it("is everything that can be moved, and nothing that cannot", () => {
    const chosen = everythingUpgradable(status());
    expect(chosen.controlPlane).toBe(true);
    expect(chosen.hostIds).toEqual(["h_1", "h_2"]);
    expect(nothingChosen(chosen)).toBe(false);
    expect(nothingChosen({ controlPlane: false, hostIds: [] })).toBe(true);
  });
});

describe("whether the upgrade may be started", () => {
  const plan: UpgradePlan = { version: "0.31.0", files: [], envMissing: [], updaterUpgrade: false };

  it("waits for the plan when the control plane is going to move", () => {
    expect(canStart({ controlPlane: true, hostIds: [] }, undefined)).toBe(false);
    expect(canStart({ controlPlane: true, hostIds: [] }, plan)).toBe(true);
  });

  it("does not wait for it when only workers are", () => {
    // The plan answers what the upgrade writes to the deployment's files, and
    // a worker upgrade writes none of them. A deployment whose updater is not
    // configured cannot be planned at all — which used to leave a worker
    // behind with no way to move it.
    expect(canStart({ controlPlane: false, hostIds: ["h_1"] }, undefined)).toBe(true);
  });

  it("needs something ticked either way", () => {
    expect(canStart({ controlPlane: false, hostIds: [] }, plan)).toBe(false);
    expect(canStart({ controlPlane: false, hostIds: [] }, undefined)).toBe(false);
  });
});

describe("what a run would end", () => {
  it("names the sessions by where they are", () => {
    const ended = wouldEnd(status(), { controlPlane: true, hostIds: ["h_1", "h_2"] });
    // The control plane is not in it: nothing runs in its container, so
    // recreating it ends nothing.
    expect(ended).toEqual([{ where: "hetzner-2", sessions: ["web"] }]);
    expect(countEnded(ended)).toBe(1);
  });

  it("counts only what was chosen", () => {
    expect(countEnded(wouldEnd(status(), { controlPlane: false, hostIds: ["h_1"] }))).toBe(0);
  });
});

describe("a host row's note", () => {
  it("says why when there is a reason, otherwise what it costs", () => {
    expect(hostNote(host({ reason: "installed by hand" }))).toBe("installed by hand");
    expect(hostNote(host({ sessions: ["a"] }))).toBe("ends a session");
    expect(hostNote(host({ sessions: ["a", "b"] }))).toBe("ends 2 sessions");
    expect(hostNote(host())).toBe("idle");
  });
});

describe("deployment files", () => {
  const file = (verdict: FilePlan["verdict"]): FilePlan => ({
    name: "firetower.yml",
    verdict,
    releaseChange: null,
    yourEdits: null,
  });

  it("only an edited file asks", () => {
    expect(needsChoice(file("Edited"))).toBe(true);
    expect(needsChoice(file("Update"))).toBe(false);
  });

  it("writes what the release changed, and an edited file only when told", () => {
    expect(willWrite(file("Update"), false)).toBe(true);
    expect(willWrite(file("New"), false)).toBe(true);
    expect(willWrite(file("Edited"), false)).toBe(false);
    expect(willWrite(file("Edited"), true)).toBe(true);
    expect(willWrite(file("Unchanged"), true)).toBe(false);
  });
});

describe("history", () => {
  const run = (over: Partial<UpdateRun> = {}): UpdateRun => ({
    id: "upg_1",
    fromVersion: "0.30.1",
    toVersion: "0.31.0",
    targets: { controlPlane: true, hostIds: [] },
    whenIdle: false,
    state: "succeeded",
    startedBy: null,
    createdAt: "2026-09-11T14:02:00Z",
    startedAt: "2026-09-11T14:02:00Z",
    finishedAt: "2026-09-11T14:06:12Z",
    error: null,
    steps: [],
    ...over,
  });

  it("says what moved, how it went and how long it took", () => {
    expect(runSummary(run())).toBe("0.30.1 → 0.31.0 · succeeded · 4m12s");
    expect(runSummary(run({ state: "running", finishedAt: null }))).toBe(
      "0.30.1 → 0.31.0 · running",
    );
  });

  it("measures durations in the unit they are read in", () => {
    expect(duration("2026-09-11T14:02:00Z", "2026-09-11T14:02:18Z")).toBe("18s");
    expect(duration("2026-09-11T14:02:00Z", "2026-09-11T15:05:00Z")).toBe("1h03m");
    expect(duration(null)).toBe("");
  });
});

/* What was `showsDot` is folded in here. It answered "is there anything in
   Updates worth a mark", which spanned an available update *and* a run already
   going — and the mark it fed was the rail's Updates icon. The icon has gone,
   the mark is the avatar's, and the avatar's mark means exactly one thing, so
   the two answers had to come apart. The cases it covered are the cases
   below. */
describe("the profile menu's Updates row, and the avatar's mark", () => {
  const level = { updateAvailable: false } as const;

  it("names the version when the deployment is behind", () => {
    expect(updatesRow(status(), null)).toEqual({ label: "Update available — 0.31.0", dot: true });
  });

  it("names this app's own build on a deployment that is level", () => {
    expect(updatesRow(status(level), "0.42.0")).toEqual({ label: "Update available — 0.42.0", dot: true });
  });

  /* The deployment's release wins. It is the thing the Updates screen acts
     on; the app moves its own build without being asked. */
  it("prefers the deployment's release when both trains are behind", () => {
    expect(updatesRow(status(), "0.42.0")).toEqual({ label: "Update available — 0.31.0", dot: true });
  });

  /* Belt and braces: a deployment can say it is behind without naming what
     it is behind, and "Update available" with no number still beats silence. */
  it("still says it when nothing named a version", () => {
    expect(updatesRow(status({ latest: null }), null)).toEqual({ label: "Update available", dot: true });
  });

  /* **A run already going takes no mark.** It is worth knowing about, there is
     nothing in it to decide, and you are the one who started it — so it says
     so in the row and leaves the avatar alone. The mark is for an available
     update and for nothing else. */
  it("says a run is going in words, and does not mark the avatar", () => {
    expect(updatesRow(status({ ...level, activeRun: "upg_1" }), null)).toEqual({
      label: "Upgrading…",
      dot: false,
    });
  });

  it("marks the update rather than the run when both are true at once", () => {
    expect(updatesRow(status({ activeRun: "upg_1" }), "0.42.0")).toEqual({
      label: "Update available — 0.31.0",
      dot: true,
    });
  });

  it("says nothing before the first answer", () => {
    expect(updatesRow(undefined, null)).toEqual({ label: "Updates", dot: false });
  });
});

describe("a diff on screen", () => {
  it("knows which lines are which", () => {
    const lines = diffLines("--- a\n+++ a\n@@ -1 +1 @@\n-old\n+new\n same\n");
    expect(lines.map((l) => l.kind)).toEqual(["meta", "meta", "hunk", "del", "add", "same"]);
  });
});

describe("a run that stopped to ask", () => {
  it("is still active, so the screen keeps showing it", () => {
    // There is nowhere else to answer. A run that vanished from the screen
    // would be one nobody could carry on or stop.
    expect(isActive({ state: "waitingDecision" })).toBe(true);
    expect(needsAnAnswer({ state: "waitingDecision" })).toBe(true);
  });

  it("is not mistaken for one that is merely running", () => {
    expect(needsAnAnswer({ state: "running" })).toBe(false);
    expect(needsAnAnswer({ state: "failed" })).toBe(false);
  });

  it("reads as something wanting attention rather than as progress", () => {
    expect(runTone("waitingDecision")).toBe("brick");
    expect(RUN_LABEL.waitingDecision).toBe("waiting for you");
  });
});

describe("a step that did not do what it was for", () => {
  it("is neither a tick nor a cross", () => {
    const warned = stepGlyph("warned");
    expect(warned).not.toBe(stepGlyph("done"));
    expect(warned).not.toBe(stepGlyph("failed"));
    expect(warned).not.toBe(stepGlyph("pending"));
  });
});

/* ── Channels ───────────────────────────────────────────────────────────
   **One screen, two things wearing the word.** Everything here is the
   installation's channel; the copy's is `~/channel` and is tested there. The
   server publishes an action or the reason there is none, so what is asserted
   below is what a *row* says — never what may be done, which is not this
   client's to decide. */

const offer = (over: Partial<Offer> = {}): Offer => ({
  channel: "general",
  tag: "stable",
  offers: "Releases a maintainer has promoted.",
  version: "0.54.1",
  since: null,
  on: true,
  action: null,
  irreversible: false,
  reason: null,
  ...over,
});

const bothOffers = (over: { general?: Partial<Offer>; beta?: Partial<Offer> } = {}): Offer[] => [
  offer(over.general),
  offer({
    channel: "beta",
    tag: "beta",
    offers: "Every release, as soon as it is cut.",
    version: "0.56.0",
    on: false,
    irreversible: true,
    action: "switch",
    ...over.beta,
  }),
];

describe("whether this control plane can speak about channels at all", () => {
  it("reads the answer rather than a version", () => {
    expect(servesChannels(status())).toBe(true);
  });

  /* A control plane that predates channels. The screen must present no
     control it cannot serve — a switch here would be a path that 404s. */
  it("says no when the server did not carry a channel", () => {
    const old = status();
    delete (old as Partial<UpdateStatus>).channel;
    expect(servesChannels(old)).toBe(false);
    expect(servesChannels(undefined)).toBe(false);
  });

  it("explains a real mismatch in terms naming both versions", () => {
    const said = mismatch("0.30.1", "0.44.0");
    expect(said).toContain("0.30.1");
    expect(said).toContain("0.44.0");
    /* "Your client is too new" is an error with nothing behind it: a copy is
       never downgraded, so the sentence has to name what would fix it. */
    expect(said).toMatch(/upgraded/);
  });
});

describe("the one thing in the way of an installation's channel", () => {
  it("is nothing at all when the tag names a channel", () => {
    expect(channelBlock(channel())).toBeNull();
  });

  /* The pre-channel floating tag: it follows the newest build published,
     which under a continuous beta is beta's, so an upgrade fetches a version
     it was not told to fetch and stops. The only unrecognised tag that is
     actively handing this installation the wrong build. */
  it("is amber for the tag that freezes an installation", () => {
    expect(channelBlock(channel({ tag: "latest", recognised: false }))).toEqual({
      kind: "frozen",
      tone: "amber",
    });
  });

  it("is amber for an exact version, which nothing can move", () => {
    expect(channelBlock(channel({ tag: "0.55.0", recognised: false, pinned: true }))).toEqual({
      kind: "pinned",
      tone: "amber",
    });
  });

  /* `edge`, a two-part tag, a local build. Treated as general access, said
     rather than assumed — and nothing is in the way until an upgrade is
     attempted, so it states a fact rather than asking to be read first. */
  it("is slate for a tag that merely names no channel", () => {
    for (const tag of ["edge", "0.54", "dev-kp"]) {
      expect(channelBlock(channel({ tag, recognised: false }))).toEqual({
        kind: "unrecognised",
        tone: "slate",
      });
    }
  });

  it("is the updater's absence when there is nothing to ask", () => {
    expect(channelBlock(channel({ tag: null, recognised: false }))).toEqual({
      kind: "noUpdater",
      tone: "slate",
    });
  });
});

describe("what one channel row says", () => {
  const ch = channel({ offers: bothOffers() });

  it("marks the channel in force", () => {
    expect(rowVerdict(ch.offers[0], ch, true, false)).toEqual({ kind: "on" });
  });

  it("offers the switch the server offered, and says it cannot be undone", () => {
    expect(rowVerdict(ch.offers[1], ch, true, false)).toEqual({
      kind: "act",
      act: "switch",
      irreversible: true,
    });
  });

  /**
   * **A member sees a fact, not a disabled control.** Reading is not
   * upgrading, and a greyed-out button is how an interface says you are being
   * withheld from. "Why does my colleague have this" is the question a channel
   * creates and this screen is where it gets answered — so the row is drawn
   * and the control is not.
   */
  it("gives a non-administrator the fact and no control", () => {
    expect(rowVerdict(ch.offers[1], ch, false, false)).toEqual({
      kind: "said",
      said: "You do not administer this Firetower",
    });
    /* And still sees which channel is in force — the fact is the whole
       reason the row is drawn for them at all. */
    expect(rowVerdict(ch.offers[0], ch, false, false)).toEqual({ kind: "on" });
  });

  it("offers nothing while a run is going", () => {
    expect(rowVerdict(ch.offers[1], ch, true, true)).toEqual({
      kind: "said",
      said: "An upgrade is running",
    });
  });

  /* A pin is offered in the block above the rows, where its consequence and
     its diff are. The row says what it is: an assumption. */
  it("calls an assumed channel assumed, rather than putting the pin in the row", () => {
    const assumed = channel({
      tag: "edge",
      recognised: false,
      offers: bothOffers({ general: { action: "pin" } }),
    });
    expect(rowVerdict(assumed.offers[0], assumed, true, false)).toEqual({
      kind: "said",
      said: "Assumed",
    });
    expect(pinOffer(assumed)?.channel).toBe("general");
    expect(switchOffer(assumed)?.channel).toBe("beta");
  });

  it("says why there is nothing to do when the server would not act", () => {
    const stuck = channel({
      switchable: false,
      reason: "an upgrade is in progress",
      offers: bothOffers({ beta: { action: null, reason: "an upgrade is in progress" } }),
    });
    expect(rowVerdict(stuck.offers[1], stuck, true, false)).toEqual({
      kind: "said",
      said: "Not available yet",
    });
  });
});

describe("what a channel row holds", () => {
  it("names the version and when general access reached it", () => {
    const since = new Date(Date.now() - 5 * 86_400_000).toISOString();
    expect(rowOffers(offer({ since }))).toBe(
      "Releases a maintainer has promoted. 0.54.1, promoted 5 days ago.",
    );
  });

  /**
   * **Never a zero, and never the newest release.** A manifest that could not
   * be read leaves the figure unknown; writing `0.0.0` or falling back to the
   * feed is precisely the failure the manifest exists to prevent.
   */
  it("says there is no version rather than inventing one", () => {
    expect(rowOffers(offer({ version: null, since: null }))).toContain("No version yet");
    expect(rowOffers(offer({ version: null, since: null }))).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it("leaves the date off when the manifest records none — beta has none by design", () => {
    expect(rowOffers(offer({ channel: "beta", version: "0.56.0", since: null, on: true }))).toBe(
      "Releases a maintainer has promoted. 0.56.0.",
    );
  });
});

/**
 * **A row names a version only when this installation is on that channel.**
 *
 * What general access was reading was beta's number — larger than the one the
 * hero reports, out of reach of any upgrade from here, and next to a channel
 * switch rather than an update. A reader who does not administer this
 * Firetower got the bigger number and no control at all.
 *
 * General access names its own either way, which is the rule rather than an
 * exception: it is the floor every installation is offered, so it is never
 * the number that cannot be had, and somebody on beta is told what general
 * holds because that is the version leaving beta waits for.
 */
describe("whose version a row may name", () => {
  it("leaves beta's number off for an installation on general access", () => {
    const [, beta] = bothOffers();
    expect(rowOffers(beta)).toBe("Every release, as soon as it is cut.");
    expect(rowOffers(beta)).not.toMatch(/\d+\.\d+\.\d+/);
  });

  /* The row this installation is on is unchanged — the hero's number and the
     row's are then the same number, which is the point. */
  it("still names general access's own number there", () => {
    const [general] = bothOffers();
    expect(rowOffers(general)).toBe("Releases a maintainer has promoted. 0.54.1.");
  });

  it("names both when the installation is on beta", () => {
    const [general, beta] = bothOffers({
      general: { on: false, action: null },
      beta: { on: true, action: null },
    });
    expect(rowOffers(beta)).toBe("Every release, as soon as it is cut. 0.56.0.");
    expect(rowOffers(general)).toBe("Releases a maintainer has promoted. 0.54.1.");
  });

  /* An unrecognised tag, an exact-version pin and a missing updater are all
     treated as general access, and `on` already says so — so they get general
     access's number and not beta's, without the rule naming them. */
  it("treats a tag that names no channel as general access, beta's number included", () => {
    const [general, beta] = bothOffers({
      general: { action: "pin" },
      beta: { action: "switch" },
    });
    expect(rowOffers(general)).toContain("0.54.1");
    expect(rowOffers(beta)).not.toMatch(/\d+\.\d+\.\d+/);
  });

  /**
   * **The field is not emptied — the row declines to draw it.** The API is
   * additive-only and `servesChannels` reads field *presence*, so nulling
   * `version` server-side would be a different and worse change. It is also
   * what the switch confirmation needs: `SwitchPanel` names the version it
   * would install, because that is the moment somebody is accepting beta and
   * a confirmation that will not say what it is installing is worse than the
   * problem being fixed. It takes it from `UpgradePlan.channelChange`, which
   * nothing here touches; `shoot-channels.mjs` asserts the rendered button
   * still reads "Switch to beta and upgrade to 0.56.0".
   */
  it("keeps the version on the offer for the confirmation to name", () => {
    const beta = switchOffer(channel({ offers: bothOffers() }));
    expect(rowOffers(beta!)).not.toMatch(/\d+\.\d+\.\d+/);
    expect(beta?.version).toBe("0.56.0");
  });
});

describe("what a channel holds for one package", () => {
  it("is read out of the installation's own manifest", () => {
    const ch = channel({
      manifest: {
        outcome: "found",
        problem: null,
        schemaVersion: 1,
        readAt: null,
        url: "https://example.test/channels.json",
        packages: [
          { package: "controlPlane", beta: "0.56.0", general: "0.54.1", generalPromotedAt: null },
          { package: "desktop", beta: "0.30.0", general: "0.29.1", generalPromotedAt: null },
        ],
      },
    });
    expect(pinsFor(ch, "desktop")?.general).toBe("0.29.1");
    expect(pinsFor(ch, "controlPlane")?.beta).toBe("0.56.0");
    expect(pinsFor(undefined, "desktop")).toBeUndefined();
  });
});

/**
 * **A destroyed document and a failed read are not the same state.**
 *
 * They behave identically — both refuse and move nothing — which is exactly
 * why the interface has to tell them apart: the only difference a person ever
 * sees is the words, and the next action differs completely. One clears by
 * itself. The other gets worse until somebody republishes the document.
 */
describe("what is wrong with the channel manifest", () => {
  const view = (outcome: string, problem: string | null = "something") =>
    ({
      outcome,
      problem,
      schemaVersion: 1,
      packages: [],
      readAt: null,
      url: "https://example.test/channels.json",
    }) as unknown as Parameters<typeof manifestTrouble>[0];

  it("is nothing when it read", () => {
    expect(manifestTrouble(view("found", null))).toBeNull();
  });

  /* Absence is the bootstrap case and the only one that is not a problem: the
     installation follows the newest release, as it did before channels. */
  it("is nothing when none has ever been published", () => {
    expect(manifestTrouble(view("absent", null))).toBeNull();
  });

  it("is the destroyed one when a document that read before has gone", () => {
    expect(manifestTrouble(view("vanished", "it has gone"))).toEqual({
      kind: "destroyed",
      problem: "it has gone",
    });
  });

  it("is the transient one for a read that merely failed", () => {
    for (const outcome of ["unreadable", "malformed", "incomplete"]) {
      expect(manifestTrouble(view(outcome))?.kind).toBe("unreadable");
    }
  });

  /* The whole point of the distinction. If these ever collapse into one, the
     screen says "try again later" about a document somebody has to go and
     put back. */
  it("never reports a destroyed document as a read that might work next time", () => {
    expect(manifestTrouble(view("vanished"))?.kind).not.toBe(
      manifestTrouble(view("unreadable"))?.kind,
    );
  });
});

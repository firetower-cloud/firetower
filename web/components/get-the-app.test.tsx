import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ManifestView } from "@/src/api/generated/model";
import {
  BetaRoute,
  type Build,
  DownloadCard,
  GetTheApp,
  betaOffer,
  downloadNote,
  generalNote,
  generalPin,
  showsOnLinux,
  tileLine,
} from "./GetTheApp";

/** Where the page sends anybody it cannot hand a release page to. */
const RELEASES_INDEX = "https://github.com/firetower-cloud/firetower/releases";

/** The rendered block as somebody reads it: text, with the markup taken out. */
function words(node: React.ReactNode): string {
  return renderToStaticMarkup(node)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Three states, three sentences — the thing a download tile could not say.
 *
 * Still looking, answered-and-there-is-no-such-file, and could-not-ask were
 * one state with one sentence, and the sentence was the hopeful one. So a
 * release whose macOS job never ran said "Looking for the general-access release…"
 * underneath a tile that would never become a link, for as long as anybody
 * was prepared to sit in front of it.
 */
describe("the line under a platform's name", () => {
  const linux = { hint: "AppImage, x86_64" };

  it("is what the file is, once there is one to download", () => {
    expect(tileLine({ ...linux, href: "…/Firetower_0.29.1_amd64.AppImage", settled: true, resolved: true })).toBe(
      "AppImage, x86_64",
    );
  });

  it("says it is still looking only while it is still looking", () => {
    expect(tileLine({ ...linux, settled: false, resolved: true })).toBe("Looking for the general-access release…");
  });

  it("says so when the release answered and has nothing for this platform", () => {
    expect(tileLine({ ...linux, settled: true, resolved: true })).toBe("Not in this release");
  });

  it("does not blame the platform for a lookup that failed", () => {
    // Nothing is known about what the release holds, so "Not in this release"
    // would be a claim we cannot make. The card says "Couldn't reach GitHub"
    // once, under the tiles, and each tile goes on describing its platform.
    expect(tileLine({ ...linux, settled: true, resolved: false })).toBe("AppImage, x86_64");
  });

  it("tells the same three apart for macOS and Windows", () => {
    const mac = { hint: "Apple silicon and Intel" };
    expect(tileLine({ ...mac, settled: false, resolved: true })).toBe("Looking for the general-access release…");
    expect(tileLine({ ...mac, settled: true, resolved: true })).toBe("Not in this release");
    expect(tileLine({ ...mac, href: "…/Firetower_0.29.1_macos.dmg", settled: true, resolved: true })).toBe(
      "Apple silicon and Intel",
    );
  });
});

/**
 * The block under the tiles, which is advice rather than a download.
 *
 * It carries where to keep the AppImage, the known gaps, and this card's only
 * link to `docs/linux.md`. So which states it appears in is the same question
 * as which states that link exists in, and the answer follows the tiles: a
 * lookup that failed is not a release with nothing in it.
 */
describe("whether On Linux is drawn", () => {
  it("is drawn while the lookup is still out", () => {
    // What it says is true whatever the lookup returns, and the card should
    // not grow under somebody's cursor when the links arrive.
    expect(showsOnLinux({ settled: false, resolved: true })).toBe(true);
  });

  it("is drawn once there is an AppImage to keep somewhere", () => {
    expect(showsOnLinux({ settled: true, resolved: true, linux: "…/Firetower_0.29.1_amd64.AppImage" })).toBe(true);
  });

  it("is drawn when the lookup failed, where nothing is known about the release", () => {
    // The tile above is still offering "AppImage, x86_64" in this state, and
    // where to keep a file is not a claim about any particular release. This
    // is also the only state in which the reader has least to go on, so it is
    // the worst one in which to remove the link to the documentation.
    expect(showsOnLinux({ settled: true, resolved: false })).toBe(true);
  });

  it("is hidden only when the release was read and has no AppImage", () => {
    // The one case where there positively is no Linux download: the tile says
    // "Not in this release" itself, and advice about a file nobody can get
    // from here is noise.
    expect(showsOnLinux({ settled: true, resolved: true })).toBe(false);
  });
});

/**
 * The version line on the Download card, which names a channel and its pin.
 *
 * It used to say *Latest*, which is a date-ish claim and says nothing about
 * which channel the three tiles under it are on. The block below opens by
 * saying the downloads above are general access, so there has to be something
 * above it making that claim — and the number beside it has to be the
 * general-access pin rather than the newest release, which is a beta from the
 * first release left unpromoted.
 */
describe("the version line under Download", () => {
  it("names the channel and the version it is pinned to", () => {
    expect(downloadNote({ state: "pinned", version: "0.29.1" })).toBe("General access: 0.29.1");
  });

  it("still names the channel while the pin is being looked up", () => {
    // The channel is known either way — it is which build these tiles are —
    // so the line does not fall back to saying nothing about it.
    expect(downloadNote({ state: "looking" })).toBe("The general-access release");
  });

  it("says the version is unknown rather than putting a hopeful one there", () => {
    // The line a page would print if it quietly used the newest release is
    // indistinguishable from the correct one. This one is not.
    expect(downloadNote({ state: "none", why: "no channel manifest has been published yet." })).toBe(
      "General access: unknown",
    );
  });
});

/** The channel manifest as this control plane reports having read it. */
function view(over: Partial<ManifestView> = {}): ManifestView {
  return {
    outcome: "found",
    url: "https://github.com/firetower-cloud/firetower/releases/download/channels/channels.json",
    packages: [
      { package: "controlPlane", beta: "0.58.0", general: "0.55.0" },
      { package: "desktop", beta: "0.30.0", general: "0.29.1" },
    ],
    ...over,
  };
}

/** A read of this server that answered, with whatever document it holds. */
const asked = (manifest: ManifestView) => generalPin({ pending: false, failed: false, manifest });

/**
 * The general-access pin, which is a value read from a document.
 *
 * The page performed one lookup — the newest desktop release — and used it
 * for the version line and the tiles. That is correct only while the two
 * channels are level. From the first release deliberately left unpromoted the
 * newest desktop release is a *beta*, and this card would have been handing
 * out beta bundles under a general-access label.
 *
 * So the pin comes from the channel manifest, through this control plane, and
 * **nothing here can reach the releases feed** — not as a fallback, not on a
 * failed read, not on an absent document. That is the defect, and it is
 * closed by this function having no way to commit it.
 */
describe("the general-access pin", () => {
  it("is the desktop package's general pin, from the document this server read", () => {
    expect(asked(view())).toEqual({ state: "pinned", version: "0.29.1" });
  });

  it("is not the desktop package's beta pin, which is the version beside it", () => {
    // Two pins per package, and taking the wrong one is the same wrong build
    // under the same label as taking the newest release.
    expect(asked(view())).not.toMatchObject({ version: "0.30.0" });
  });

  it("is still looking while this server has not answered", () => {
    expect(generalPin({ pending: true, failed: false })).toEqual({ state: "looking" });
  });

  it("offers nothing when this server could not be asked at all", () => {
    // Not the same as a manifest that is not there: nothing has been learnt
    // about the manifest either way.
    const pin = generalPin({ pending: false, failed: true });
    expect(pin.state).toBe("none");
    expect(pin).toMatchObject({ why: expect.stringContaining("could not be asked") });
  });

  /**
   * The six outcomes, kept apart, because what the operator does next differs:
   * ask again after a failed fetch, republish a destroyed document, fix a
   * malformed one, wait for a promotion that has not happened. Collapsing
   * them into one "could not check" is the mistake this design has paid for
   * more than once.
   */
  it("tells a destroyed manifest from one that was never published", () => {
    const vanished = asked(view({ outcome: "vanished", packages: [] }));
    const absent = asked(view({ outcome: "absent", packages: [] }));
    expect(vanished).toMatchObject({ state: "none" });
    expect(absent).toMatchObject({ state: "none" });
    // The destroyed one names the act and the remedy, and says that waiting
    // is not one — it is the only outcome here that gets worse unattended.
    expect(vanished.state === "none" && vanished.why).toContain("destroyed");
    expect(vanished.state === "none" && vanished.why).toContain("put it back");
    expect(vanished.state === "none" && vanished.why).not.toBe(absent.state === "none" && absent.why);
    // And the bootstrap one does not read as a failure, because it is not one.
    expect(absent.state === "none" && absent.why).toContain("has been published yet");
    expect(absent.state === "none" && absent.why).not.toContain("destroyed");
  });

  it("tells a failed read from a document that is not this document", () => {
    const unreadable = asked(view({ outcome: "unreadable", packages: [], problem: "GitHub answered 403" }));
    const malformed = asked(view({ outcome: "malformed", packages: [], problem: "not JSON" }));
    const incomplete = asked(view({ outcome: "incomplete", packages: [], problem: "names no desktop.general" }));
    // Ask again; fix it; fix it. Three sentences, three next actions.
    expect(unreadable.state === "none" && unreadable.why).toContain("asking again");
    expect(malformed.state === "none" && malformed.why).toContain("has to be fixed");
    expect(incomplete.state === "none" && incomplete.why).toContain("has to be fixed");
    expect(unreadable.state === "none" && unreadable.why).not.toBe(malformed.state === "none" && malformed.why);
    // And this server's own words travel with them, for whoever has to act.
    expect(unreadable).toMatchObject({ detail: "GitHub answered 403" });
  });

  it("offers nothing when the document read and names no desktop version", () => {
    // A document written before the desktop had a channel, or before its
    // first promotion. It read — so this is not a failure — and there is
    // still nothing here to hand anybody.
    const pin = asked(view({ packages: [{ package: "controlPlane", beta: "0.58.0", general: "0.55.0" }] }));
    expect(pin.state).toBe("none");
    expect(pin.state === "none" && pin.why).toContain("no general-access version for the desktop app");
  });

  it("never hands back a version from an outcome that is not an answer", () => {
    // The whole rule in one assertion: a read that went wrong must never be
    // allowed to look like a general-access version, of any kind.
    for (const outcome of ["absent", "vanished", "unreadable", "malformed", "incomplete"] as const) {
      expect(asked(view({ outcome, packages: [] }))).toMatchObject({ state: "none" });
    }
  });

  it("keeps the pin from the last document that read, and says the newest read did not", () => {
    // The control plane leaves the held document alone when a read fails, and
    // `outcome` is what says the figures may be behind. A stale general-access
    // pin is still general access — it is never a beta — so the card goes on
    // offering it, with the failure said out loud beside it.
    const pin = asked(view({ outcome: "unreadable", problem: "GitHub answered 403" }));
    expect(pin).toMatchObject({ state: "pinned", version: "0.29.1" });
    expect(pin.state === "pinned" && pin.behind).toContain("asking again");
  });
});

/** A general-access release that resolved, with all three bundles on it. */
const BUILT: Build = {
  settled: true,
  read: true,
  mac: "https://example.invalid/Firetower_0.29.1_macos.dmg",
  windows: "https://example.invalid/Firetower_0.29.1_x64-setup.exe",
  linux: "https://example.invalid/Firetower_0.29.1_amd64.AppImage",
};

/**
 * The line under the tiles, which exists because a pin can fail and the
 * newest release cannot.
 *
 * Every state that cannot offer a build says which one it is, and says that
 * the newest release is not being put there instead. That sentence is the
 * one somebody would otherwise supply for themselves.
 */
describe("the note under the tiles", () => {
  it("says nothing while there is nothing to say", () => {
    expect(generalNote({ state: "looking" }, { settled: false, read: false })).toBeUndefined();
    expect(generalNote({ state: "pinned", version: "0.29.1" }, BUILT)).toBeUndefined();
  });

  it("carries the reason there is no build, and that the newest is not a substitute", () => {
    const note = generalNote(asked(view({ outcome: "vanished", packages: [] })), {
      settled: true,
      read: false,
    });
    expect(note?.says).toContain("no general-access build to offer");
    expect(note?.says).toContain("destroyed");
    expect(note?.next).toContain("The newest release is not offered in its place");
    expect(note?.next).toContain("a release nobody has promoted is a beta");
  });

  it("names the version it went looking for when the pin has no release", () => {
    const note = generalNote({ state: "pinned", version: "0.29.1" }, { settled: true, read: false, missing: "gone" });
    expect(note?.says).toContain("0.29.1");
    expect(note?.says).toContain("desktop-v0.29.1");
    expect(note?.next).toContain("The newest release is not offered in its place");
  });

  it("says when the build on offer is from a read that is no longer the latest", () => {
    const note = generalNote(asked(view({ outcome: "unreadable", problem: "GitHub answered 403" })), BUILT);
    expect(note?.says).toContain("0.29.1");
    expect(note?.says).toContain("the most recent read did not succeed");
    expect(note?.detail).toBe("GitHub answered 403");
  });
});

/** The newest releases, with beta two versions ahead of general access. */
const AHEAD = {
  reached: true,
  beta: {
    version: "0.30.0",
    href: "https://example.invalid/desktop-v0.30.0",
    mac: "https://example.invalid/Firetower_0.30.0_macos.dmg",
    windows: "https://example.invalid/Firetower_0.30.0_x64-setup.exe",
    linux: "https://example.invalid/Firetower_0.30.0_amd64.AppImage",
  },
};

/**
 * The card as a whole, in the state this ticket exists for: **beta ahead of
 * general access**.
 *
 * Every assertion above is about a function, and all of them would go on
 * passing if the card were wired back to the feed — which is the regression
 * this change is most exposed to, and the shape of defect #388 named. So this
 * renders the card with both versions in hand and checks which one reaches
 * which part of it.
 */
describe("the Download card with beta ahead of general access", () => {
  const markup = renderToStaticMarkup(
    <DownloadCard pin={{ state: "pinned", version: "0.29.1" }} build={BUILT} releases={AHEAD} />,
  );

  it("names the general-access version on the version line", () => {
    expect(words(<DownloadCard pin={{ state: "pinned", version: "0.29.1" }} build={BUILT} releases={AHEAD} />)).toContain(
      "General access: 0.29.1",
    );
  });

  it("hands out the general-access bundles, on all three tiles", () => {
    expect(markup).toContain('href="https://example.invalid/Firetower_0.29.1_macos.dmg"');
    expect(markup).toContain('href="https://example.invalid/Firetower_0.29.1_x64-setup.exe"');
    expect(markup).toContain('href="https://example.invalid/Firetower_0.29.1_amd64.AppImage"');
  });

  it("offers no beta bundle under the general-access label", () => {
    // The failure this whole ticket is about: a download tile pointing at the
    // newest release, which is a beta the moment one is left unpromoted.
    expect(markup).not.toContain("Firetower_0.30.0_macos.dmg");
    expect(markup).not.toContain("Firetower_0.30.0_x64-setup.exe");
    expect(markup).not.toContain("Firetower_0.30.0_amd64.AppImage");
  });

  it("still offers the newest release under Beta builds, which is what a beta is", () => {
    const read = words(<DownloadCard pin={{ state: "pinned", version: "0.29.1" }} build={BUILT} releases={AHEAD} />);
    expect(read).toContain("Beta builds");
    expect(read).toContain("0.30.0");
    expect(markup).toContain('href="https://example.invalid/desktop-v0.30.0"');
  });
});

/**
 * The card when the pin could not be read, which is where honesty costs
 * something: there is a person on this page who wants a file.
 */
describe("the Download card without a pin", () => {
  const vanished = <DownloadCard pin={asked(view({ outcome: "vanished", packages: [] }))} build={{ settled: true, read: false }} releases={AHEAD} />;

  it("offers nothing at all rather than the newest release", () => {
    const markup = renderToStaticMarkup(vanished);
    expect(markup).not.toContain(".dmg");
    expect(markup).not.toContain("-setup.exe");
    expect(markup).not.toContain(".AppImage");
  });

  it("says which of the six it was, and that the newest release is not a stand-in", () => {
    const read = words(vanished);
    expect(read).toContain("destroyed");
    expect(read).toContain("The newest release is not offered in its place");
    expect(read).toContain("General access: unknown");
  });

  it("does not claim anything about a release it never read", () => {
    // "Not in this release" would be a statement about a release nobody has
    // named. The tiles go on describing their platforms.
    const read = words(vanished);
    expect(read).not.toContain("Not in this release");
    expect(read).toContain("Apple silicon and Intel");
  });

  it("still carries the route onto beta, which does not depend on the pin", () => {
    const read = words(vanished);
    expect(read).toContain("Beta builds");
    expect(read).toContain("0.30.0");
  });

  it("draws the reason above the faintest tiers, like every other sentence here", () => {
    // `--color-dim` is 2.94:1 on `--color-panel`, below the floor for normal
    // text and spent on counts, timestamps and paths. This sentence decides
    // whether somebody goes and republishes a document, so it is not drawn in
    // a tier the design reserves for things nobody has to read. The server's
    // own words for the failure are the one part that *is* a diagnostic, and
    // are the one part in that tier.
    const markup = renderToStaticMarkup(vanished);
    const says = markup.match(/<p class="([^"]+)">There is no general-access build/);
    expect(says?.[1]).toContain("text-text");
    expect(says?.[1]).not.toContain("text-dim");
    expect(says?.[1]).not.toContain("text-mute");
    const next = markup.match(/<p class="([^"]+)">The newest release is not offered/);
    expect(next?.[1]).toContain("text-text");
    expect(next?.[1]).not.toContain("text-mute");
  });
});

/** A lookup that found a beta build with bundles on it. */
const FOUND = {
  version: "0.56.0",
  betaRelease: "https://example.invalid/desktop-v0.56.0",
  mac: "https://example.invalid/Firetower_0.56.0_macos.dmg",
  windows: "https://example.invalid/Firetower_0.56.0_x64-setup.exe",
  linux: "https://example.invalid/Firetower_0.56.0_amd64.AppImage",
};

/**
 * What the route can honestly offer, which is not always a build.
 *
 * Two states hand the reader the releases index instead of a release page,
 * and they are different sentences — so they are different values here rather
 * than one boolean, and neither of them keeps the version.
 */
describe("what the beta route can offer", () => {
  it("names the build and links at its own page when there is one", () => {
    expect(betaOffer(FOUND)).toEqual({
      version: "0.56.0",
      href: "https://example.invalid/desktop-v0.56.0",
    });
  });

  it("falls back to the index when nothing resolved, and says which case that is", () => {
    // Still looking, GitHub refused, or no desktop release in the feed. The
    // refusal is the common one: sixty unauthenticated calls an hour, per
    // address, shared by everyone behind an admin console.
    expect(betaOffer({})).toEqual({ href: RELEASES_INDEX, insteadOf: "unknown" });
    expect(betaOffer({ version: "0.56.0" })).toEqual({ href: RELEASES_INDEX, insteadOf: "unknown" });
  });

  it("will not name a build whose bundles never uploaded", () => {
    // The three tiles above already say "Not in this release". A confident
    // version here, linking at an empty page, would be the only part of the
    // card still claiming there is something to download.
    expect(betaOffer({ version: "0.56.0", betaRelease: "https://example.invalid/r" })).toEqual({
      href: RELEASES_INDEX,
      insteadOf: "empty",
    });
  });

  it("names a build on the strength of any one platform", () => {
    expect(betaOffer({ ...FOUND, mac: undefined, windows: undefined }).version).toBe("0.56.0");
  });
});

/**
 * The route onto beta for a copy that cannot reach it any other way.
 *
 * This is the whole reason the page is load-bearing rather than a download
 * list, so the tests are about what it *says*. Every one of these sentences
 * is the only place a reader is told the thing, and a quiet edit that drops
 * one leaves a correct-looking page that misleads.
 */
describe("the beta route", () => {
  const drawn = words(<BetaRoute found={FOUND} />);

  it("says why a manual install is necessary, and not only that one is", () => {
    // The compiled-in updater address is the fact the whole route rests on:
    // a copy can only read a different address by updating, and it can only
    // update through the address it has. Without this the hand-install reads
    // as an arbitrary inconvenience somebody should have automated.
    expect(drawn).toContain("its update address is compiled into the bundle");
    expect(drawn).toContain("the only way to a different address is to install from it once");
  });

  it("scopes that reason to the copies it is true of", () => {
    // It is true of a copy that predates the channel release. A copy that
    // carries it chooses its endpoint per check — which is what the next
    // sentence means by a switch in the app under Updates — so stating the
    // requirement of every copy made the two contradict each other one line
    // apart. The page said exactly that, and must not again.
    expect(drawn).toContain("A copy that predates all of this cannot be switched from inside itself");
    expect(drawn).not.toContain("Every copy carries its update address inside the bundle");
  });

  it("offers the beta bundle, at the release page it is actually on", () => {
    const markup = renderToStaticMarkup(<BetaRoute found={FOUND} />);
    expect(markup).toContain('href="https://example.invalid/desktop-v0.56.0"');
    expect(drawn).toContain("Beta builds on GitHub");
  });

  it("carries the version beta is at", () => {
    expect(drawn).toContain("0.56.0");
  });

  it("says what happens after the hand-install", () => {
    // Once, not a habit: the copy is on beta from then on and updates itself.
    expect(drawn).toContain("From the next release on, that copy updates on beta by itself");
  });

  it("says switching back stops new betas rather than reverting the build", () => {
    expect(drawn).toContain("Switching back in the app stops new betas");
    expect(drawn).toContain("It does not reinstall the general-access build");
    expect(drawn).toContain("a copy is never moved back to an older one");
  });

  it("says the route is permanent, by naming the other situation it answers", () => {
    // A copy that stopped updating needs the same download, which is why the
    // route does not go away when everybody has taken the channel release.
    expect(drawn).toContain("The same download is how a copy that stopped updating is brought back");
    expect(drawn).toContain("rather than being a one-off for this change");
  });

  it("does not present the route as temporary", () => {
    // The route is permanent, so nothing may hedge it into a migration step
    // somebody is waiting to withdraw. These are the words that would.
    for (const hedge of [
      "for now",
      "until ",
      "temporar",
      "migrat",
      "in the meantime",
      "eventually",
      // Not a bare "soon": "as soon as it is cut" is the sentence that says
      // beta is continuous, which is the opposite of a hedge.
      "coming soon",
      "for the time being",
      "scaffold",
      "one-time",
      "transition",
      "interim",
      "no longer be needed",
    ]) {
      expect(drawn.toLowerCase()).not.toContain(hedge);
    }
  });

  it("says a bundle installed by hand is not checked the way an update is", () => {
    // This route goes around the updater's signature check, which is the one
    // thing on the automatic path nobody has to remember to do. The page that
    // sends somebody down it owes them the alternative.
    expect(drawn).toContain("An automatic update is verified against a signing key inside the app");
    expect(drawn).toContain("A bundle you install by hand is not");
  });

  it("names what each platform does on its own, because the three differ", () => {
    expect(drawn).toContain("macOS is notarised");
    expect(drawn).toContain("The Windows installer is not signed");
    expect(drawn).toContain("nothing checks an AppImage you run");
  });

  it("points at the signature rather than a checksum", () => {
    // A digest published on the same release as the bundle it describes
    // proves only that the two agree. The separate signing key is the
    // guarantee, so that is what the page sends somebody to check.
    expect(drawn).toContain("a detached signature is published beside the bundle");
    expect(drawn.toLowerCase()).not.toContain("checksum");
    expect(drawn.toLowerCase()).not.toContain("sha256");
    expect(renderToStaticMarkup(<BetaRoute found={FOUND} />)).toContain("verifying-a-download.md");
  });

  it("says so when the link is the index rather than the release page", () => {
    // The reader has just been told to use *the release page* and is being
    // handed thirty releases across three packages. Two links with two labels
    // and one destination, with no sign which is the fallback, is the state
    // this is here to prevent.
    const missed = words(<BetaRoute found={{}} />);
    expect(missed).toContain("All releases on GitHub");
    expect(missed).toContain("could not be looked up just now");
    expect(missed).toContain("the newest one tagged desktop-v");
    expect(missed).not.toContain("Beta builds on GitHub");
  });

  it("says something different when the release is there and its bundles are not", () => {
    const empty = words(<BetaRoute found={{ version: "0.56.0", betaRelease: "https://e.invalid/r" }} />);
    expect(empty).toContain("the newest release has no bundles on it yet");
    // And no confident version against a download nobody can get.
    expect(empty).not.toContain("0.56.0");
  });

  it("still has somewhere to send a reader when the lookup failed", () => {
    // Every sentence here is true whatever the release holds, so the block is
    // drawn in that state too. The same argument `showsOnLinux` makes for the
    // block above it.
    const markup = renderToStaticMarkup(<BetaRoute found={{}} />);
    expect(markup).toContain(`href="${RELEASES_INDEX}"`);
    expect(words(<BetaRoute found={{}} />)).toContain("Beta builds");
  });

  it("answers no question ember answers, and adds no tone", () => {
    // `desktop/STYLE.md`: ember means one thing — something is waiting on you
    // — and nothing else may use it. A new section is told apart by position
    // and weight, never by a new hue.
    const markup = renderToStaticMarkup(<BetaRoute found={FOUND} />);
    for (const tone of ["ember", "sage", "brick", "slate"]) {
      expect(markup).not.toContain(tone);
    }
  });

  it("draws every one of its sentences above the faintest tiers", () => {
    // `--color-dim` is recorded in the sheet at 2.94:1 on `--color-panel`,
    // under the floor for normal text and spent on counts, timestamps and
    // paths; `--color-mute` is fainter still. These sentences decide whether
    // somebody hand-installs a build, so all four are `--color-text` —
    // including the closing one, which carries the permanence of the route
    // and is an aside by being `--text-meta` and last, not by fading.
    const markup = renderToStaticMarkup(<BetaRoute found={FOUND} />);
    for (const sentence of [
      "The downloads above are general access",
      "A copy that predates all of this",
      "Switching back in the app stops new betas",
      "The same download is how a copy that stopped updating",
    ]) {
      // The paragraph's own class, not a window before it — a window picks
      // up the version badge, which is `--color-dim` and correctly so.
      const tag = markup.match(new RegExp(`<p class="([^"]+)">${sentence}`));
      expect(tag?.[1]).toBeDefined();
      expect(tag?.[1]).toContain("text-text");
      expect(tag?.[1]).not.toContain("text-dim");
      expect(tag?.[1]).not.toContain("text-mute");
    }
  });

  it("keeps the closing line's link above the line it sits in", () => {
    // Lifting the prose and leaving the link where it was would put a link
    // one tier *below* its own sentence, which reads as a disabled control.
    // `OnLinux` and this card's footer line both take the same step up.
    const markup = renderToStaticMarkup(<BetaRoute found={FOUND} />);
    const link = markup.match(/<a class="([^"]+)"[^>]*>Beta builds on GitHub/);
    expect(link?.[1]).toContain("text-bone");
    expect(link?.[1]).not.toContain("text-dim");
  });
});

/**
 * That the page actually carries the route.
 *
 * Every test above renders `BetaRoute` directly, so all of them pass with the
 * block deleted from the card — which is the regression this ticket is most
 * exposed to: the block dropped, moved into another card, or put behind a
 * condition that is false in production. This renders the page itself.
 *
 * Server rendering, so no effect runs and the release lookup never answers.
 * That is the state the assertions want anyway: the sentences are the same in
 * every state of the lookup, and this proves they reach the page in the one
 * state a reader is guaranteed to see first.
 */
describe("the Get the app page", () => {
  const page = words(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <GetTheApp />
    </QueryClientProvider>,
  );

  it("carries the beta route, in the Download card", () => {
    expect(page).toContain("Beta builds");
    expect(page).toContain("Download");
  });

  it("carries all four of the sentences the route exists to say", () => {
    expect(page).toContain("A copy that predates all of this cannot be switched from inside itself");
    expect(page).toContain("From the next release on, that copy updates on beta by itself");
    expect(page).toContain("Switching back in the app stops new betas");
    expect(page).toContain("The same download is how a copy that stopped updating is brought back");
  });

  it("carries the version line as a channel", () => {
    expect(page).toContain("The general-access release");
  });
});

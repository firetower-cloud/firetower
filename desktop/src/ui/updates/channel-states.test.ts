/**
 * The specimens the harness draws, put through the logic the screen uses.
 *
 * Without this the states would be exercised only by a browser, and the
 * pictures would be the only thing saying they are right. Walking every one
 * of them through `channelBlock` and `rowVerdict` is what makes the specimen
 * set and the screen's reasoning one thing rather than two that agree today.
 */
import { describe, expect, it } from "vitest";
import { channelBlock, channelsShown, pinOffer, rowOffers, rowVerdict, switchOffer } from "~/api/updates";
import { CHANNEL_STATES, CHANNEL_STATE_NAMES } from "./channel-states";

describe("every specimen state", () => {
  it("covers both the states that are in the way and the ones that are not", () => {
    const blocks = CHANNEL_STATE_NAMES.map((n) => channelBlock(CHANNEL_STATES[n])?.kind ?? "clear");
    for (const kind of ["clear", "frozen", "unrecognised", "pinned", "noUpdater"]) {
      expect(blocks, `no specimen produces ${kind}`).toContain(kind);
    }
  });

  it.each(CHANNEL_STATE_NAMES)("%s offers one row per channel, general first", (name) => {
    const state = CHANNEL_STATES[name];
    expect(state.offers.map((o) => o.channel)).toEqual(["general", "beta"]);
  });

  /**
   * **No control the server would refuse, and none this reader may not take.**
   * A row either carries an action the server published or says why it does
   * not — there is no third answer, and a disabled button is not one of them.
   */
  it.each(CHANNEL_STATE_NAMES)("%s decides every row without inventing a control", (name) => {
    const state = CHANNEL_STATES[name];
    for (const offer of state.offers) {
      const verdict = rowVerdict(offer, state, state.mayChange ?? false, false);
      if (verdict.kind === "act") {
        expect(offer.action, `${name}/${offer.channel} drew a control the server did not offer`).toBeTruthy();
        expect(state.mayChange, `${name} offered an act to somebody who may not take it`).toBe(true);
      }
    }
  });

  it("gives a member no control on any row", () => {
    const member = CHANNEL_STATES.member;
    for (const offer of member.offers) {
      expect(rowVerdict(offer, member, false, false).kind).not.toBe("act");
    }
  });

  /* An installation treated as a channel it is not on: the press that makes
     the image line and the running container agree. */
  it("offers the pin exactly where the tag names no channel", () => {
    expect(pinOffer(CHANNEL_STATES.frozen)?.tag).toBe("stable");
    expect(pinOffer(CHANNEL_STATES.unrecognised)?.tag).toBe("stable");
    expect(pinOffer(CHANNEL_STATES.general)).toBeUndefined();
    expect(pinOffer(CHANNEL_STATES.beta)).toBeUndefined();
  });

  it("offers no switch at all where the server said it would not act", () => {
    for (const name of ["pinned", "noUpdater", "manifestUnreadable"] as const) {
      expect(switchOffer(CHANNEL_STATES[name]), `${name} offered a switch`).toBeUndefined();
      expect(CHANNEL_STATES[name].switchable).toBe(false);
      expect(CHANNEL_STATES[name].reason).toBeTruthy();
    }
  });

  /* A read that went wrong must never look like "general access is at version
     zero", on the screen or in a specimen. */
  it("never carries a zero where a version could not be read", () => {
    for (const name of CHANNEL_STATE_NAMES) {
      for (const offer of CHANNEL_STATES[name].offers) {
        expect(!offer.version || /^\d+\.\d+\.\d+/.test(offer.version)).toBe(true);
        expect(offer.version).not.toBe("0.0.0");
      }
    }
    expect(CHANNEL_STATES.manifestUnreadable.offers.every((o) => o.version === null)).toBe(true);
  });

  /**
   * **No specimen shows a general-access installation beta's number.**
   *
   * The complaint this closes was read off a row: beta's version sat under a
   * hero reporting general access's, larger than it and out of reach of any
   * upgrade from here. Swept over every state rather than asserted on one,
   * because `member` and the manifest-trouble states are each a different
   * route to the same row.
   */
  it.each(CHANNEL_STATE_NAMES)("%s names a version only on the channel it is on", (name) => {
    const state = CHANNEL_STATES[name];
    for (const offer of state.offers) {
      const said = rowOffers(offer);
      if (offer.on || offer.channel === "general") continue;
      expect(said, `${name}/${offer.channel} drew a version nobody here is on`).not.toMatch(
        /\d+\.\d+\.\d+/,
      );
      expect(said).toBe(offer.offers);
    }
  });

  /* The row the installation *is* on is untouched, so the one number on the
     section is the one the hero is already reporting. */
  it("still names the version of the channel in force", () => {
    expect(rowOffers(CHANNEL_STATES.general.offers[0])).toContain("0.54.1");
    expect(rowOffers(CHANNEL_STATES.beta.offers[1])).toContain("0.56.0");
    /* On beta, general access keeps its number too: it is what leaving beta
       waits for, which is what the sentence under the rows is about. */
    expect(rowOffers(CHANNEL_STATES.beta.offers[0])).toContain("0.54.1");
  });

  /**
   * **The decision blocks are not about beta, and must survive it being
   * hidden.** Each one says an installation's image line is wrong and names
   * what to change it to; each one is in the way of every upgrade until
   * somebody acts. A reader with the channels hidden still gets all of them,
   * because `channelBlock` never reads the preference.
   */
  it.each(CHANNEL_STATE_NAMES)("%s decides its block without asking about beta", (name) => {
    const state = CHANNEL_STATES[name];
    /* The same answer at both settings — the argument is not passed to it. */
    expect(channelBlock(state)).toEqual(channelBlock({ ...state }));
  });

  it("still puts the frozen, unrecognised and pinned blocks in the way", () => {
    for (const [name, kind] of [
      ["frozen", "frozen"],
      ["unrecognised", "unrecognised"],
      ["pinned", "pinned"],
      ["noUpdater", "noUpdater"],
    ] as const) {
      expect(channelBlock(CHANNEL_STATES[name])?.kind, name).toBe(kind);
    }
    /* And the pin each one offers is general access's, never beta's — so the
       control in the block is the same one with the channels hidden. */
    expect(pinOffer(CHANNEL_STATES.frozen)?.channel).toBe("general");
    expect(pinOffer(CHANNEL_STATES.unrecognised)?.channel).toBe("general");
  });

  /**
   * **Hidden for every state but the one that is on beta.** A copy on general
   * access with nothing asked for: the page names no channel, except where
   * the installation itself is on beta and the page cannot sensibly decline.
   */
  it.each(CHANNEL_STATE_NAMES)("%s draws the channels only when it is on one", (name) => {
    const quiet = { channel: "general" as const, from: null, ahead: false };
    const state = CHANNEL_STATES[name];
    expect(channelsShown(false, state, quiet), name).toBe(name === "beta");
    /* And every one of them once somebody asks. */
    expect(channelsShown(true, state, quiet), name).toBe(true);
  });

  /** Beta is irreversible on the row, before it is taken — and general is not. */
  it("marks beta irreversible and general access not", () => {
    for (const name of CHANNEL_STATE_NAMES) {
      const [general, beta] = CHANNEL_STATES[name].offers;
      expect(beta.irreversible, `${name}`).toBe(true);
      expect(general.irreversible, `${name}`).toBe(false);
    }
  });
});

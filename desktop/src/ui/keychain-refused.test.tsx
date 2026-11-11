/**
 * The card for a sign-in that cannot be kept, on a platform that is not this
 * one.
 *
 * Same reason as `voice/refusal.test.tsx`: every word of the Linux case is
 * invisible from a Mac, and the first version of the microphone dialog told a
 * Windows user that macOS was blocking it. This one has three platforms' worth
 * of nouns in it — keyring, Keychain, Credential Manager — and the one with no
 * keyring running is the platform nobody here is developing on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/* A refusal is standing, for the one server. The registry itself is not what
   is under test here — `because` is, since it decides which of the two
   stories the card tells. */
const standing = vi.hoisted(() => ({
  unkept: { serverId: "s_acme", because: "signIn" } as Record<string, unknown>,
}));
vi.mock("~/servers", () => ({
  unkeptSignIn: () => standing.unkept,
  unkeptSaid: () => {},
  onUnkept: () => () => {},
  signedOut: () => {},
}));

/** The card as it renders on `where`, with the module graph rebuilt so
    `platform.ts` reads the stubbed navigator rather than a cached answer. */
async function refusedOn(where: string, unkept: Record<string, unknown> = { because: "signIn" }) {
  standing.unkept = { serverId: "s_acme", ...unkept };
  vi.resetModules();
  vi.stubGlobal("navigator", { userAgentData: { platform: where } });
  const { KeychainRefused } = await import("./KeychainRefused");
  return renderToStaticMarkup(<KeychainRefused />);
}

afterEach(() => vi.unstubAllGlobals());

describe("there is nowhere to keep the sign-in", () => {
  it("names the thing that actually said no", async () => {
    const linux = await refusedOn("Linux");
    expect(linux).toContain("no keyring running on this machine");
    expect(linux).toContain("gnome-keyring or KWallet");
    expect(linux).not.toContain("macOS");

    expect(await refusedOn("macOS")).toContain("macOS would not let Firetower into your keychain");
    expect(await refusedOn("Windows")).toContain("Credential Manager");
  });

  it("says the session will not survive, on all three", async () => {
    for (const where of ["Linux", "macOS", "Windows"]) {
      expect(await refusedOn(where)).toContain("the next launch will ask for your password again");
    }
  });

  /* The same rule the microphone dialog's Linux case follows, applied to all
     three here: there is no one pane on any platform to send anybody to, and
     a button that opens the wrong settings application is worse than a
     sentence that admits it. */
  it("offers no deep link anywhere", async () => {
    for (const where of ["Linux", "macOS", "Windows"]) {
      const card = await refusedOn(where);
      expect(card).toContain("Use it for this session");
      expect(card).not.toContain("Open System Settings");
      expect(card).not.toContain("Open Settings");
      expect(card).not.toContain("x-apple.systempreferences");
      expect(card).not.toContain("ms-settings");
    }
  });
});

/**
 * The other story the card has to tell.
 *
 * A token an older build had already written into this machine's
 * `localStorage` and that cannot be moved into the keychain. `servers.ts` ends
 * that sign-in rather than run a session on a credential sitting in a
 * world-readable file — so there is nothing to offer for this session, and the
 * card that says there is would be the only untrue sentence on the screen.
 */
describe("an old build's sign-in that could not be moved", () => {
  it("does not offer a session it has already ended", async () => {
    for (const where of ["Linux", "macOS", "Windows"]) {
      const card = await refusedOn(where, { because: "legacy", revoked: "confirmed" });
      expect(card).not.toContain("You are signed in now");
      expect(card).not.toContain("Use it for this session");
      // And no Back either: there is nothing left to go back from.
      expect(card).not.toContain(">Back<");
      expect(card).toContain("Sign in again");
    }
  });

  it("says where the sign-in had been, and that it is over", async () => {
    const card = await refusedOn("Linux", { because: "legacy", revoked: "confirmed" });
    expect(card).toContain("An older version of Firetower had kept your sign-in in a file");
    expect(card).toContain("you will need to sign in again");
    // The platform's own blocker is still the first thing said.
    expect(card).toContain("no keyring running on this machine");
  });
});


/**
 * The two sentences that must only ever be said when they are true.
 *
 * The card announced that an old sign-in had been ended on every legacy path,
 * including the two where the server answered 500 and where the machine was
 * offline — so it was telling somebody their credential was dead while it
 * still answered 200 and its bytes were still readable in a `0644` file. And
 * a sign-out this machine could not make stick said nothing at all.
 */
describe("saying only what actually happened", () => {
  it("claims the old sign-in was ended only once the server has confirmed it", async () => {
    const sure = await refusedOn("Linux", { because: "legacy", revoked: "confirmed" });
    expect(sure).toContain("has been ended with your Firetower");
    expect(sure).toContain("no good to anybody");
    expect(sure).not.toContain("could not reach your Firetower");
  });

  it("says plainly when it could not, and what to do instead", async () => {
    const unsure = await refusedOn("Linux", { because: "legacy", revoked: "unconfirmed" });
    expect(unsure).toContain("could not reach your Firetower to end that old sign-in");
    expect(unsure).toContain("keep trying while this window is open");
    expect(unsure).toContain("the copy in that file still works");
    expect(unsure).toContain("sign out of everything from a Firetower you trust");
    // And it must not say the reassuring thing.
    expect(unsure).not.toContain("no good to anybody");
    expect(unsure).not.toContain("has been ended with your Firetower");
  });

  it("owns up to a sign-out it could not make stick, naming the store", async () => {
    const stuck = await refusedOn("Linux", { because: "signOut" });
    expect(stuck).toContain("Firetower couldn’t finish signing you out");
    expect(stuck).toContain("could not take the sign-in out of your keyring");
    expect(stuck).toContain("may come back at the next launch");
    // Not a procedure, so not the numbered steps, and not a sign-in story.
    expect(stuck).not.toContain("gnome-keyring or KWallet");
    expect(stuck).not.toContain("You are signed in now");

    expect(await refusedOn("macOS", { because: "signOut" })).toContain("out of your keychain");
    expect(await refusedOn("Windows", { because: "signOut" })).toContain("out of Credential Manager");
  });
});

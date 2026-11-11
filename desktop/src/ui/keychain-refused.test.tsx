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
   is under test here. */
vi.mock("~/servers", () => ({
  unkeptSignIn: () => "s_acme",
  unkeptSaid: () => {},
  onUnkept: () => () => {},
  signedOut: () => {},
}));

/** The card as it renders on `where`, with the module graph rebuilt so
    `platform.ts` reads the stubbed navigator rather than a cached answer. */
async function refusedOn(where: string) {
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

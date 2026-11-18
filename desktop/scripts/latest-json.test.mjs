import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { manifest, publicKey, readAssets, updaterPublicKey } from "./latest-json.mjs";
import fixtures from "./minisign-fixtures.json" with { type: "json" };

/**
 * The signatures in `minisign-fixtures.json` were made by `tauri signer` —
 * the CLI version this repository pins, the same code path that signs a real
 * release — and not by anything in this repository.
 *
 * That matters more than it usually would. `latest-json.mjs` carries a
 * minisign verifier, and a verifier checked only against signatures it made
 * itself proves that it agrees with its own mistakes. Two of the fixtures are
 * here to be refused, and a refusal is only evidence if the thing refused is
 * a genuinely valid signature of something else.
 *
 * `desktop/scripts/minisign-fixtures.sh` regenerates them.
 */
const bytes = (from) => Buffer.from(fixtures.signed[from].payload, "base64");

/** One asset on the release: the name it was uploaded under, and the pair. */
const asset = (name, from) => ({
  name,
  signature: fixtures.signed[from].signature,
  payload: () => bytes(from),
});

/* The four artifacts a `desktop-v*` release carries once Linux is on it,
   named exactly as `tauri-action` uploads them — which for macOS is not the
   name the archive was signed under, and no longer has to be. */
const release = () => [
  asset("Firetower_universal.app.tar.gz", "mac"),
  asset("Firetower_0.29.1_x64-setup.exe", "windows"),
  asset("Firetower_0.29.1_x64_en-US.msi", "msi"),
  asset("Firetower_0.29.1_amd64.AppImage", "appimage"),
];

const built = (assets, over = {}) =>
  manifest({
    version: "0.29.1",
    repo: "firetower-cloud/firetower",
    tag: "desktop-v0.29.1",
    assets,
    pubkey: fixtures.pubkey,
    pubDate: "2026-11-11T18:13:34.188Z",
    ...over,
  });

const url = (name) => `https://github.com/firetower-cloud/firetower/releases/download/desktop-v0.29.1/${name}`;

/* A minisign signature file's comment lines, rewritten. The untrusted one is
   covered by nothing at all and the trusted one by the fourth line, so the
   first of these leaves a wholly valid signature behind and the second does
   not — which is the difference the tests below turn on. */
const recomment = (signature, line, text) => {
  const lines = Buffer.from(signature.trim(), "base64").toString("utf8").split("\n");
  lines[line] = text;
  return Buffer.from(lines.join("\n"), "utf8").toString("base64");
};
const replace = (assets, suffix, over) =>
  assets.map((a) => (a.name.endsWith(suffix) ? { ...a, ...over } : a));

describe("the manifest every installed copy reads", () => {
  it("says which channel it is, for the screen and for nothing else", () => {
    // The plugin has no channel concept and ignores this. It is here so the
    // Updates screen can answer "why do I have this build and my colleague
    // does not" — no version string carries the channel, and the two channels
    // are two addresses serving two of these documents.
    expect(built(release()).channel).toBe("beta");
    expect(built(release(), { channel: "general" }).channel).toBe("general");
    // Defaulted rather than required, because a release is a beta deploy and
    // the general-access write is the deliberate one.
    expect(
      manifest({
        version: "0.29.1",
        repo: "firetower-cloud/firetower",
        tag: "desktop-v0.29.1",
        assets: release(),
        pubkey: fixtures.pubkey,
      }).channel,
    ).toBe("beta");
  });

  it("carries the keys the CLI wrote, and Linux's two beside them", () => {
    // Not a subset: these are the keys on the published desktop-v0.29.1
    // manifest, which is what installed copies are already asking for. One
    // dropped is an update that stops being offered to whoever asks for it.
    expect(Object.keys(built(release()).platforms)).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "darwin-aarch64-app",
      "darwin-x86_64-app",
      "windows-x86_64",
      "windows-x86_64-nsis",
      "windows-x86_64-msi",
      "linux-x86_64",
      "linux-x86_64-appimage",
    ]);
  });

  it("points each platform at this release's own asset", () => {
    const { platforms } = built(release());
    expect(platforms["linux-x86_64"].url).toBe(url("Firetower_0.29.1_amd64.AppImage"));
    expect(platforms["linux-x86_64"].signature).toBe(fixtures.signed.appimage.signature);
    // The universal archive under both of macOS's architectures, which is
    // what one universal binary means.
    expect(platforms["darwin-aarch64"].url).toBe(url("Firetower_universal.app.tar.gz"));
    expect(platforms["darwin-x86_64"].url).toBe(platforms["darwin-aarch64"].url);
    // Windows's plain key is the NSIS installer; the .msi keeps its alias.
    expect(platforms["windows-x86_64"].url).toBe(url("Firetower_0.29.1_x64-setup.exe"));
    expect(platforms["windows-x86_64-msi"].url).toBe(url("Firetower_0.29.1_x64_en-US.msi"));
  });

  it("escapes a name that is legal in an asset and not in a URL", () => {
    // GitHub flattens spaces and brackets on upload, but not `+`, `#` or `&` —
    // any of which a product name could carry, and all of which mean something
    // else in a URL.
    const named = replace(release(), ".AppImage", { name: "Firetower+beta_1.0_amd64.AppImage" });
    expect(built(named).platforms["linux-x86_64"].url).toBe(url("Firetower%2Bbeta_1.0_amd64.AppImage"));
  });

  it("takes the wrapped AppImage too, if the bundler ever goes back to writing one", () => {
    const wrapped = replace(release(), ".AppImage", { name: "Firetower_0.29.1_amd64.AppImage.tar.gz" });
    expect(built(wrapped).platforms["linux-x86_64"].url).toBe(url("Firetower_0.29.1_amd64.AppImage.tar.gz"));
  });

  it("refuses to choose when both an AppImage and a wrapped one are there", () => {
    const both = [...release(), asset("Firetower_0.29.1_amd64.AppImage.tar.gz", "appimage")];
    expect(() => built(both)).toThrow(/2 candidates for the Linux AppImage/);
  });
});

/**
 * The reason this file exists rather than `uploadVersionJSON`.
 *
 * That one is read → merge-its-own-platform → delete → re-upload per leg, with
 * no lock, so two legs finishing seconds apart lose one platform between them
 * and nothing anywhere goes red. The property that replaces it is not "the
 * legs are ordered" — it is that the manifest is built once, from every
 * signature on the release, and that a missing one is a failure rather than a
 * smaller manifest.
 */
describe("legs finishing together", () => {
  it("cannot drop each other's platform, whatever order they arrived in", () => {
    const first = built(release());
    const reversed = built(release().reverse());
    const shuffled = built([release()[2], release()[0], release()[3], release()[1]]);
    expect(reversed).toEqual(first);
    expect(shuffled).toEqual(first);
  });

  it("will not publish a manifest with Linux missing from it", () => {
    const withoutLinux = release().filter((a) => !a.name.endsWith(".AppImage"));
    expect(() => built(withoutLinux)).toThrow(/the Linux AppImage/);
    // And the message has to say what to do, because the job that reads it is
    // the last one in a release everybody is waiting on.
    expect(() => built(withoutLinux)).toThrow(/Re-run the leg/);
  });

  it("will not publish one with macOS or Windows missing either", () => {
    expect(() => built(release().filter((a) => !a.name.endsWith(".app.tar.gz")))).toThrow(
      /the macOS app/,
    );
    expect(() => built(release().filter((a) => !a.name.endsWith("-setup.exe")))).toThrow(
      /the Windows installer/,
    );
  });

  it("names every platform it is missing, not the first one", () => {
    expect(() => built([release()[0]])).toThrow(
      /the Windows installer, the Windows \.msi, the Linux AppImage/,
    );
  });
});

/**
 * The pairing, which is now the signature verifying over the payload and not
 * anything read out of the signature.
 *
 * Both of the shapes below were found by breaking the version of this that
 * compared the `file:` in the signature against the asset's name. Each one
 * produced a manifest that looked complete from here and that every installed
 * copy on that platform then refused — an update outage nobody notices until
 * people stop being offered updates.
 */
describe("what it refuses to copy into the manifest", () => {
  it("a signature that is not one", () => {
    const empty = replace(release(), ".AppImage", { signature: "" });
    expect(() => built(empty)).toThrow(/not a minisign signature/);

    const rubbish = replace(release(), ".AppImage", {
      signature: Buffer.from("<!DOCTYPE html>").toString("base64"),
    });
    expect(() => built(rubbish)).toThrow(/not a minisign signature/);
  });

  /**
   * The first reproduction: the previous release's signature, beside this
   * release's archive.
   *
   * `getAssetName` calls the macOS archive `Firetower.app.tar.gz` in every
   * version, so desktop-v0.29.0's signature names exactly what
   * desktop-v0.29.1's archive is called and every check made from names
   * accepts it. Rebuilding an existing tag is a supported operation — the
   * workflow takes one by `workflow_dispatch` — so this is not a contrivance,
   * it is what happens on the second build of a tag.
   */
  it("a signature from the previous release of the same platform", () => {
    const stale = replace(release(), ".app.tar.gz", {
      signature: fixtures.signed.macPrevious.signature,
    });
    expect(() => built(stale)).toThrow(/is not a signature of Firetower_universal\.app\.tar\.gz/);
    // It says what to do, rather than inviting somebody to hand-edit it.
    expect(() => built(stale)).toThrow(/re-run the leg that produced the pair/);

    // The control, and the reason this test means anything: that same
    // signature is perfectly good over the archive it was made for. What is
    // being refused is the pairing, not the signature.
    const own = replace(release(), ".app.tar.gz", {
      signature: fixtures.signed.macPrevious.signature,
      payload: () => bytes("macPrevious"),
    });
    expect(built(own).platforms["darwin-aarch64"].signature).toBe(
      fixtures.signed.macPrevious.signature,
    );
  });

  /**
   * The second: the name typed into the field nothing covers.
   *
   * minisign's *untrusted* comment is signed by nothing, so rewriting it
   * leaves a wholly valid signature of the Windows installer behind — which is
   * what made this pass a check that searched the decoded signature for
   * `file:`. Reading an untrusted field to decide what a signature is a
   * signature of is the error, and there is no longer any field being read.
   */
  it("a signature whose untrusted comment names this platform's payload", () => {
    const forged = recomment(
      fixtures.signed.windows.signature,
      0,
      "untrusted comment: file:Firetower_0.29.1_amd64.AppImage",
    );
    const crossed = replace(release(), ".AppImage", { signature: forged });
    expect(() => built(crossed)).toThrow(/is not a signature of Firetower_0\.29\.1_amd64\.AppImage/);

    // The control: that forgery is still a valid signature of the Windows
    // installer, so what is refused above is the pairing and not the edit.
    const windows = replace(release(), "-setup.exe", { signature: forged });
    expect(built(windows).platforms["windows-x86_64"].signature).toBe(forged);
  });

  it("a signature made with a key the app does not check against", () => {
    const wrongKey = replace(release(), "-setup.exe", {
      signature: fixtures.signed.windowsOtherKey.signature,
    });
    // Named as a signing secret to look at, not a build to re-run: a good
    // signature from the wrong key is refused by every installed copy.
    expect(() => built(wrongKey)).toThrow(/was made with key [0-9A-F]{16}, and the app checks against [0-9A-F]{16}/);
    expect(() => built(wrongKey)).toThrow(/TAURI_SIGNING_PRIVATE_KEY/);
  });

  it("a payload with one byte changed in it", () => {
    const tampered = replace(release(), ".AppImage", {
      payload: () => {
        const b = bytes("appimage");
        b[0] ^= 1;
        return b;
      },
    });
    expect(() => built(tampered)).toThrow(/is not a signature of Firetower_0\.29\.1_amd64\.AppImage/);
  });

  it("a signature whose trusted comment was edited after it was signed", () => {
    // Unlike the untrusted one, this is covered — by the signature on the
    // fourth line. The payload signature still verifies, and an installed
    // copy would still refuse the update, so this does not get published.
    const edited = recomment(
      fixtures.signed.appimage.signature,
      2,
      "trusted comment: timestamp:1794420350\tfile:something-else",
    );
    const entry = replace(release(), ".AppImage", { signature: edited });
    expect(() => built(entry)).toThrow(/its trusted comment does not verify/);
  });

  /**
   * The rename that used to need a rule of its own, and now needs none.
   *
   * `tauri-action` appends `_<arch>` to the stem of macOS's `.app.tar.gz` on
   * upload, so that archive alone sits on the release under a name it was not
   * signed under. That was a hole that had to be left open in a name
   * comparison, and every attack above went through it. Bytes do not have the
   * problem: the archive is the archive whatever it is called.
   */
  it("needs no exception for the one asset that is renamed on upload", () => {
    expect(
      Buffer.from(fixtures.signed.mac.signature, "base64").toString("utf8"),
    ).toContain("file:Firetower.app.tar.gz");
    expect(built(release()).platforms["darwin-aarch64"].url).toBe(
      url("Firetower_universal.app.tar.gz"),
    );

    // And the latitude it used to need is gone with it: a different archive
    // under a name the old rule would have accepted is refused.
    const other = replace(release(), ".app.tar.gz", {
      name: "Firetower_universal.app.tar.gz",
      payload: () => bytes("macPrevious"),
    });
    expect(() => built(other)).toThrow(/is not a signature of/);
  });

  it("two versions' assets on one release", () => {
    const twice = [...release(), asset("Firetower_0.29.0_amd64.AppImage", "appimage")];
    expect(() => built(twice)).toThrow(/2 candidates for the Linux AppImage/);
  });
});

describe("the key it verifies against", () => {
  it("is the one the app was built with", () => {
    // Read from tauri.conf.json rather than passed in: a manifest verified
    // against any other key is one every installed copy still refuses.
    const key = publicKey(updaterPublicKey());
    expect(key.id).toHaveLength(8);
    expect(key.key.asymmetricKeyType).toBe("ed25519");
  });

  it("is refused if it is not a minisign public key", () => {
    expect(() => built(release(), { pubkey: "" })).toThrow(/not a minisign public key/);
    expect(() => built(release(), { pubkey: Buffer.from("hello\nthere\n").toString("base64") })).toThrow(
      /not a minisign public key/,
    );
  });
});

/**
 * Reading the release off disk, which is where the payloads come from.
 *
 * The publish job downloads every asset rather than just the `.sig` files, so
 * a signature with nothing to check against means an asset is missing from
 * the release — a different fault from a bad signature, and one that must not
 * be published either.
 */
describe("the assets a job downloaded", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "latest-json-"));

  it("pairs each signature with the artifact beside it", () => {
    const d = dir();
    writeFileSync(join(d, "Firetower_0.29.1_amd64.AppImage"), bytes("appimage"));
    writeFileSync(join(d, "Firetower_0.29.1_amd64.AppImage.sig"), fixtures.signed.appimage.signature);
    // The `.dmg` has no signature and is not an updater artifact; it is on the
    // release and is not an entry.
    writeFileSync(join(d, "Firetower_0.29.1_macos.dmg"), "not an updater artifact");

    const assets = readAssets(d);
    expect(assets.map((a) => a.name)).toEqual(["Firetower_0.29.1_amd64.AppImage"]);
    expect(assets[0].payload()).toEqual(bytes("appimage"));
  });

  it("refuses a signature whose artifact is not on the release", () => {
    const d = dir();
    writeFileSync(join(d, "Firetower_0.29.1_amd64.AppImage.sig"), fixtures.signed.appimage.signature);
    expect(() => readAssets(d)).toThrow(
      /Firetower_0\.29\.1_amd64\.AppImage\.sig is on the release and Firetower_0\.29\.1_amd64\.AppImage is not/,
    );
    expect(() => readAssets(d)).toThrow(/Re-run the leg/);
  });
});

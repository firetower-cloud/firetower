import { describe, expect, it } from "vitest";
import { manifest } from "./latest-json.mjs";

/* A well-formed minisign signature file's contents: base64 of two comment
   lines and the signature. What is in it does not matter here — only that the
   manifest copies it across verbatim and refuses anything that is not one. */
const sig = (file) =>
  Buffer.from(
    `untrusted comment: signature from tauri secret key\nRWQN3dDhlYmi8aREd+mp\ntrusted comment: timestamp:1794420350\tfile:${file}\nKZGhGQ7hzIfduLIFOD5J\n`,
  ).toString("base64");

/* The four artifacts a `desktop-v*` release carries once Linux is on it, named
   exactly as the bundler names them — the mac and Windows three are the asset
   names off desktop-v0.29.1. */
const signatures = () => [
  { name: "Firetower_universal.app.tar.gz", signature: sig("Firetower.app.tar.gz") },
  { name: "Firetower_0.29.1_x64-setup.exe", signature: sig("Firetower_0.29.1_x64-setup.exe") },
  { name: "Firetower_0.29.1_x64_en-US.msi", signature: sig("Firetower_0.29.1_x64_en-US.msi") },
  { name: "Firetower_0.29.1_amd64.AppImage", signature: sig("Firetower_0.29.1_amd64.AppImage") },
];

const built = (signatures_, over = {}) =>
  manifest({
    version: "0.29.1",
    repo: "firetower-cloud/firetower",
    tag: "desktop-v0.29.1",
    signatures: signatures_,
    pubDate: "2026-11-11T18:13:34.188Z",
    ...over,
  });

const url = (name) => `https://github.com/firetower-cloud/firetower/releases/download/desktop-v0.29.1/${name}`;

describe("the manifest every installed copy reads", () => {
  it("carries the keys the CLI wrote, and Linux's two beside them", () => {
    // Not a subset: these are the keys on the published desktop-v0.29.1
    // manifest, which is what installed copies are already asking for. One
    // dropped is an update that stops being offered to whoever asks for it.
    expect(Object.keys(built(signatures()).platforms)).toEqual([
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
    const { platforms } = built(signatures());
    expect(platforms["linux-x86_64"].url).toBe(url("Firetower_0.29.1_amd64.AppImage"));
    expect(platforms["linux-x86_64"].signature).toBe(sig("Firetower_0.29.1_amd64.AppImage"));
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
    const named = [
      ...signatures().filter((s) => !s.name.endsWith(".AppImage")),
      { name: "Firetower+beta_1.0_amd64.AppImage", signature: sig("Firetower+beta_1.0_amd64.AppImage") },
    ];
    expect(built(named).platforms["linux-x86_64"].url).toBe(url("Firetower%2Bbeta_1.0_amd64.AppImage"));
  });

  it("takes the wrapped AppImage too, if the bundler ever goes back to writing one", () => {
    const wrapped = [
      ...signatures().filter((s) => !s.name.endsWith(".AppImage")),
      { name: "Firetower_0.29.1_amd64.AppImage.tar.gz", signature: sig("Firetower_0.29.1_amd64.AppImage.tar.gz") },
    ];
    expect(built(wrapped).platforms["linux-x86_64"].url).toBe(url("Firetower_0.29.1_amd64.AppImage.tar.gz"));
  });

  it("refuses to choose when both an AppImage and a wrapped one are there", () => {
    const both = [
      ...signatures(),
      { name: "Firetower_0.29.1_amd64.AppImage.tar.gz", signature: sig("Firetower_0.29.1_amd64.AppImage.tar.gz") },
    ];
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
    const first = built(signatures());
    const reversed = built(signatures().reverse());
    const shuffled = built([signatures()[2], signatures()[0], signatures()[3], signatures()[1]]);
    expect(reversed).toEqual(first);
    expect(shuffled).toEqual(first);
  });

  it("will not publish a manifest with Linux missing from it", () => {
    const withoutLinux = signatures().filter((s) => !s.name.endsWith(".AppImage"));
    expect(() => built(withoutLinux)).toThrow(/the Linux AppImage/);
    // And the message has to say what to do, because the job that reads it is
    // the last one in a release everybody is waiting on.
    expect(() => built(withoutLinux)).toThrow(/Re-run the leg/);
  });

  it("will not publish one with macOS or Windows missing either", () => {
    expect(() => built(signatures().filter((s) => !s.name.endsWith(".app.tar.gz")))).toThrow(
      /the macOS app/,
    );
    expect(() => built(signatures().filter((s) => !s.name.endsWith("-setup.exe")))).toThrow(
      /the Windows installer/,
    );
  });

  it("names every platform it is missing, not the first one", () => {
    expect(() => built([signatures()[0]])).toThrow(
      /the Windows installer, the Windows \.msi, the Linux AppImage/,
    );
  });
});

describe("what it refuses to copy into the manifest", () => {
  it("a signature that is not one", () => {
    const empty = signatures().map((s) => (s.name.endsWith(".AppImage") ? { ...s, signature: "" } : s));
    expect(() => built(empty)).toThrow(/not a minisign signature/);

    const rubbish = signatures().map((s) =>
      s.name.endsWith(".AppImage") ? { ...s, signature: Buffer.from("<!DOCTYPE html>").toString("base64") } : s,
    );
    expect(() => built(rubbish)).toThrow(/not a minisign signature/);
  });

  it("two versions' assets on one release", () => {
    const twice = [
      ...signatures(),
      { name: "Firetower_0.29.0_amd64.AppImage", signature: sig("Firetower_0.29.0_amd64.AppImage") },
    ];
    expect(() => built(twice)).toThrow(/2 candidates for the Linux AppImage/);
  });
});

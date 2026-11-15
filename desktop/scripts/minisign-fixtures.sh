#!/usr/bin/env bash
# Regenerates minisign-fixtures.json, which latest-json.test.mjs verifies
# against.
#
# The signatures in there are made by `tauri signer`, from the CLI version this
# repository pins — the same code path that signs a real release — rather than
# by anything in this repository. That is the point of them: `latest-json.mjs`
# contains a minisign verifier, and a verifier tested only against signatures
# it produced itself proves that it agrees with its own mistakes. Two of the
# fixtures exist to be refused, and they have to be genuinely valid signatures
# of something else or refusing them means nothing.
#
# The key is thrown away afterwards and signs nothing that leaves this file.
# `latest-json.mjs` verifies releases against `plugins.updater.pubkey` from
# tauri.conf.json and this does not touch it.
set -euo pipefail
cd "$(dirname "$0")/.."

tauri=node_modules/.bin/tauri
[ -x "$tauri" ] || { echo "run pnpm install in desktop/ first" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

CI=1 "$tauri" signer generate -p "" -w "$work/a.key" -f --ci >/dev/null
CI=1 "$tauri" signer generate -p "" -w "$work/b.key" -f --ci >/dev/null
mkdir -p "$work/v291" "$work/v290" "$work/otherkey"

# The four artifacts of a release, under the names the bundler signs them
# under. Their contents only have to differ from each other.
printf 'macOS app archive, version 0.29.1' > "$work/v291/Firetower.app.tar.gz"
printf 'NSIS installer, version 0.29.1' > "$work/v291/Firetower_0.29.1_x64-setup.exe"
printf 'MSI installer, version 0.29.1' > "$work/v291/Firetower_0.29.1_x64_en-US.msi"
printf 'AppImage, version 0.29.1' > "$work/v291/Firetower_0.29.1_amd64.AppImage"
# The previous release's macOS archive. Different bytes, and `getAssetName`
# gives it the same name in every version — which is why a stale signature
# passes any check made from names.
printf 'macOS app archive, version 0.29.0' > "$work/v290/Firetower.app.tar.gz"
# One payload signed with a key the app was not built with.
cp "$work/v291/Firetower_0.29.1_x64-setup.exe" "$work/otherkey/"

for f in "$work"/v291/* "$work"/v290/*; do
    "$tauri" signer sign -f "$work/a.key" -p "" "$f" >/dev/null
done
"$tauri" signer sign -f "$work/b.key" -p "" "$work/otherkey/Firetower_0.29.1_x64-setup.exe" >/dev/null

WORK="$work" node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const work = process.env.WORK;
const box = (p) => readFileSync(`${work}/${p}`, "utf8").trim();
const pair = (dir, name) => ({
  payload: readFileSync(`${work}/${dir}/${name}`).toString("base64"),
  signature: box(`${dir}/${name}.sig`),
});
writeFileSync("scripts/minisign-fixtures.json", `${JSON.stringify({
  _: [
    "Signatures made by the Tauri CLI this repository pins (2.11.4) — the same",
    "`tauri signer` that signs a real release — over the payloads in here, with",
    "a throwaway key. Regenerate with desktop/scripts/minisign-fixtures.sh.",
    "`payload` is base64 of the bytes signed; `signature` is the `.sig` verbatim.",
  ],
  pubkey: box("a.key.pub"),
  otherPubkey: box("b.key.pub"),
  signed: {
    mac: pair("v291", "Firetower.app.tar.gz"),
    macPrevious: pair("v290", "Firetower.app.tar.gz"),
    windows: pair("v291", "Firetower_0.29.1_x64-setup.exe"),
    msi: pair("v291", "Firetower_0.29.1_x64_en-US.msi"),
    appimage: pair("v291", "Firetower_0.29.1_amd64.AppImage"),
    windowsOtherKey: pair("otherkey", "Firetower_0.29.1_x64-setup.exe"),
  },
}, null, 2)}\n`);
'
echo "wrote desktop/scripts/minisign-fixtures.json"

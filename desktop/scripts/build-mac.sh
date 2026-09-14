#!/usr/bin/env bash
# Build the macOS app and its .dmg here, unsigned.
#
#   desktop/scripts/build-mac.sh              # this Mac's architecture
#   desktop/scripts/build-mac.sh --universal  # Apple Silicon + Intel in one file
#
# Unsigned means Gatekeeper asks on first open (right-click → Open); the
# release workflow is where signing and notarization happen. The result lands
# in src-tauri/target/<target>/release/bundle/dmg/.
set -euo pipefail
cd "$(dirname "$0")/.."

target=()
if [[ "${1:-}" == "--universal" ]]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
  target=(--target universal-apple-darwin)
fi

pnpm install --frozen-lockfile
(cd ../web && pnpm install --frozen-lockfile)
# No updater artifacts here: they need the release's private key, and an
# unsigned local build is not something the updater should ever hand out.
pnpm tauri build --bundles app,dmg --config '{"bundle":{"createUpdaterArtifacts":false}}' ${target[@]+"${target[@]}"}

echo
find src-tauri/target -path '*/release/bundle/dmg/*.dmg' -newer package.json -print

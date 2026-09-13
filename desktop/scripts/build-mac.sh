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
pnpm tauri build --bundles dmg ${target[@]+"${target[@]}"}

echo
find src-tauri/target -path '*/release/bundle/dmg/*.dmg' -newer package.json -print

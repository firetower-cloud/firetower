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

triple=""
target=()
if [[ "${1:-}" == "--universal" ]]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
  triple="universal-apple-darwin"
  target=(--target "$triple")
fi

pnpm install --frozen-lockfile
# No updater artifacts here: they need the release's private key, and an
# unsigned local build is not something the updater should ever hand out.
pnpm tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}' ${target[@]+"${target[@]}"}

# Through the same script the release runs, so what you try by hand is the
# installer other people will open.
bundle="src-tauri/target/${triple:+$triple/}release/bundle"
version=$(node -p "require('./src-tauri/tauri.conf.json').version")
arch=${triple:+universal}
dmg="$bundle/dmg/Firetower_${version}_${arch:-$(uname -m | sed s/arm64/aarch64/)}.dmg"
scripts/make-dmg.sh "$bundle/macos/Firetower.app" "$dmg"

echo
echo "$dmg"

#!/usr/bin/env bash
# Assemble the macOS disk image.
#
#   make-dmg.sh <Firetower.app> <out.dmg>
#
# An installer is four things: the app, the shortcut to drag it onto, the
# window layout, and the icon of the mounted disk. Tauri's own bundler writes
# the layout by asking Finder to arrange the window, which needs a logged-in
# session — so it cannot run on a build machine, and its own fallback there
# drops the layout and produces a bare folder.
#
# This makes the image from a staging folder instead: nothing is mounted while
# it is built, no Finder is involved, and the same file comes out on every
# machine.
#
# `dmg/DS_Store` is that layout, snapshotted from a disk image arranged on a
# Mac. The window size, the background and where the two icons sit are in
# `src-tauri/tauri.conf.json` under `bundle.macOS.dmg`; change them there, then
# regenerate on a Mac:
#
#   pnpm tauri build --bundles app,dmg
#   hdiutil attach -readonly -nobrowse -mountpoint /tmp/ft src-tauri/target/release/bundle/dmg/*.dmg
#   cp /tmp/ft/.DS_Store dmg/DS_Store && hdiutil detach /tmp/ft
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)

app=${1:?the .app to package}
out=${2:?the .dmg to write}

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
# Committed without its leading dot: a file named .DS_Store is ignored
# everywhere, this repository included.
cp "$here/dmg/DS_Store" "$stage/.DS_Store"
cp "$here/src-tauri/icons/icon.icns" "$stage/.VolumeIcon.icns"
# The layout names this path, so the name and the folder both matter.
mkdir "$stage/.background"
cp "$here/dmg/background.png" "$stage/.background/background.png"

# mktemp makes a private directory, and that mode would travel into the image.
chmod -R go+rX,go-w "$stage"

mkdir -p "$(dirname "$out")"
hdiutil create -volname Firetower -srcfolder "$stage" -ov -format UDZO "$out"

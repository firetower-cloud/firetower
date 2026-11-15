#!/usr/bin/env bash
# Put the AppImage packaging tools where Tauri's bundler looks, pinned and
# verified, and hand the AppImage runtime to `appimagetool` by name — so that
# nothing in the packaging chain downloads anything.
#
#   appimage-tools.sh
#
# ## Why a build step has to do this at all
#
# `tauri build --bundles appimage` does not package an AppImage on its own. It
# fetches five files from the internet at build time and runs them — and every
# one of those fetches is `if !path.exists() { download }` into
# `${XDG_CACHE_HOME:-$HOME/.cache}/tauri/`
# (`crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs`, CLI
# 2.11.4, which is what this repository's lockfile pins and what
# `tauri-action` therefore runs). So a file already sitting at the path it
# would write to is a file it uses without asking anybody.
#
# That is the whole mechanism for those five: seed the cache, and their
# downloads do not happen. The sixth, further down, needs a different one.
#
# Two of the five are more than a convenience:
#
#   * `linuxdeploy-plugin-gtk.sh` was being fetched from a **mutable branch**
#     and is **executed** during packaging. Whoever can push to that branch
#     could run anything in this job.
#   * `AppRun-x86_64` is copied **inside** the AppImage, so it is not build
#     tooling at all — it becomes code on the machine of everybody who
#     downloads Firetower.
#
# ## The sixth download, one level further down
#
# Seeding the cache stops the bundler's own five. It does not stop
# `appimagetool`, which the pinned `linuxdeploy-plugin-appimage` carries
# inside it (commit `8e5b4c0`): handed an AppDir, that binary fetches the
# **AppImage runtime** — the small ELF prepended to the squashfs, and the
# first code that runs when somebody launches the download — from
# `type2-runtime`'s `continuous` tag. A rolling tag, with no digest anywhere.
# Its fetch checks that the transfer succeeded and that the length looks
# plausible, and nothing else (`src/appimagetool_fetch_runtime.cpp`).
#
# That runtime ends up **inside the artifact Tauri then signs**. An upstream
# asset replaced under that rolling tag would be embedded, signed with our own
# updater key, and accepted as genuine Firetower by every installed copy — a
# real signature over somebody else's code. It is also the code
# `appimage-guard.sh` has to execute in order to extract the artifact it
# checks.
#
# The cache cannot help here, because nothing looks for this file on disk. So
# it is pinned below like the other five and handed over by name instead:
# `linuxdeploy-plugin-appimage` turns `$LDAI_RUNTIME_FILE` into
# `appimagetool --runtime-file` (read out of the pinned binary itself, not
# only out of its source), and in `appimagetool` that option is an `if`/`else`
# against the download rather than a preference — a runtime it cannot read
# stops packaging with "Unable to load provided runtime file" and never falls
# back to fetching one. `appimage-guard.sh` then checks the runtime that was
# actually embedded against this pin, so losing the variable fails a build
# instead of quietly restoring the download.
#
# ## Why the linuxdeploy version is a bug fix and not housekeeping
#
# The copy Tauri hands out (`tauri-apps/binary-releases`, tag `linuxdeploy`,
# asset uploaded 2024-07-29) predates `libwayland-client.so.0` entering the
# AppImage excludelist on 2024-11-03, so it bundles the build machine's copy
# into the AppDir, where it shadows the host's at run time. Mesa's EGL always
# comes from the host and needs a newer libwayland than Ubuntu 22.04's 1.20 —
# so EGL fails to initialise, WebKit's web process aborts with
# `EGL_BAD_PARAMETER`, and the person who downloaded it gets a white window.
# That is upstream tauri#15976, fixed in CLI 2.12.0 by bumping this same
# binary; we are deliberately not bumping the CLI, so we bump the binary.
#
# Verified by extracting both: the pin below carries `libwayland-client.so.0`
# in its baked-in excludelist and the one Tauri would fetch does not.
#
# ## What a mismatch means
#
# It fails the build. It never falls through to letting the bundler fetch an
# unpinned copy — a pin that silently degrades to "whatever is on master
# today" is not a pin. If a digest here stops matching, upstream moved: read
# what moved and decide, rather than pasting the new digest in.
#
# ## Do not cache this directory between runs
#
# Tauri mutates `linuxdeploy-x86_64.AppImage` **in place** after reading it:
# it runs `dd` to zero three bytes at offset 8, removing the AppImage magic so
# desktop integration tools ignore it. So the digest of the file this script
# placed is not the digest of the file still sitting there after a build. That
# is why every run downloads and overwrites rather than checking what is
# already on disk and keeping it — which also means a cached `~/.cache/tauri`
# would buy nothing and a digest check against one would fail for the wrong
# reason.
set -euo pipefail

# The pins are x86_64 — the only Linux build we ship — and the digests are of
# course architecture-specific, so this refuses to guess on anything else.
arch=$(uname -m)
if [ "$arch" != "x86_64" ]; then
    echo "appimage-tools.sh: pinned for x86_64, running on $arch" >&2
    echo "Nothing here is right for another architecture: pick the pins and" >&2
    echo "verify the digests for it, rather than reusing these." >&2
    exit 2
fi

# `dirs::cache_dir()` on Linux, which is what the bundler resolves.
cache="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
mkdir -p "$cache"

# One line per tool: the file name the bundler looks for, where it was fetched
# from, and the SHA-256 of what that source served when it was pinned. The
# digest is the guarantee; the URL is only an address.
#
# **The file names are 2.11.4's.** CLI 2.12.0 renames the linuxdeploy entry (it
# carries the version in the name), so a lockfile bump past it leaves this
# script seeding a path nobody reads and the bundler quietly downloading its
# own copies again — with no error anywhere. The guard in `appimage-guard.sh`
# is what notices; keep them together.
#
# The two scripts are pinned at a commit rather than at `master`, which is what
# the bundler asks for. Both commits are byte-identical to what `master` served
# when they were pinned, so this changed nothing about the build the day it
# landed — including that the GTK plugin still exports `GDK_BACKEND=x11`
# inside the AppImage. Tauri's fork reverted upstream's removal of that in
# b5eb8d05 (2024-01-04) and has kept it since; pinning upstream's copy instead
# would have changed which display backend every Linux user gets, which is not
# this change's business.
#
# `runtime-x86_64` is the exception to "the name the bundler looks for":
# nothing looks for it, and the line below is the only place its path comes
# from. It is pinned to a dated tag (`20251108`) rather than to `continuous`,
# for the same reason as the AppImage plugin — `continuous` is rewritten on
# every upstream push, so a digest pinned to it breaks within days and the
# pressure is then to paste the new digest in without reading what moved.
#
# **A dated tag is not an immutable one, and nothing here relies on it being
# one.** GitHub's release API reports `"immutable": false` for this tag, as it
# does for every tag pinned above; upstream could replace the asset tomorrow.
# What makes this a pin is the digest. If the asset is replaced, the check
# below fails and the build stops — the substitute is never accepted and never
# packaged, which is the property worth having. The tag only has to be stable
# enough that a passing build keeps passing.
#
# Roughly half its bytes differ from what `continuous` serves today, so this
# does change which runtime ships; that is the point of pinning it, and the
# first CI run on this branch is where anything wrong with it shows up loudly.
tools=$(cat <<'PINS'
linuxdeploy-x86_64.AppImage https://github.com/linuxdeploy/linuxdeploy/releases/download/1-alpha-20251107-1/linuxdeploy-x86_64.AppImage c20cd71e3a4e3b80c3483cef793cda3f4e990aca14014d23c544ca3ce1270b4d
AppRun-x86_64 https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64 f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f
linuxdeploy-plugin-gtk.sh https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/dda522bce37387f1b853d9095713bfaa924c8423/linuxdeploy-plugin-gtk.sh 7804c9eef13e59bf2783aad9882ef9db8f3f3f9e8d631874b1d348d550a3693f
linuxdeploy-plugin-gstreamer.sh https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/2a2e67491c32995a3f279ad0ecbe77abd512b42a/linuxdeploy-plugin-gstreamer.sh c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94
linuxdeploy-plugin-appimage.AppImage https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/1-alpha-20250213-1/linuxdeploy-plugin-appimage-x86_64.AppImage 992d502a248e14ab185448ddf6f6e7d25558cb84d4623c354c3af350c25fccb3
runtime-x86_64 https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64 2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d
PINS
)

staged=$(mktemp -d)
trap 'rm -rf "$staged"' EXIT

echo "Seeding $cache"
while read -r name url want; do
    [ -n "$name" ] || continue

    # Downloaded beside the cache and only moved into it once the digest is
    # right, so a failure here cannot leave a half-written or unverified file
    # at a path the bundler would then treat as "already there".
    if ! curl --fail --silent --show-error --location --retry 3 --retry-delay 2 \
        --output "$staged/$name" "$url"; then
        echo "appimage-tools.sh: could not fetch $name from $url" >&2
        exit 1
    fi

    got=$(sha256sum "$staged/$name" | cut -d' ' -f1)
    if [ "$got" != "$want" ]; then
        {
            echo
            echo "appimage-tools.sh: $name is not the file we pinned."
            echo "  from     $url"
            echo "  expected $want"
            echo "  got      $got"
            echo
            echo "This fails the build on purpose. The bundler's own fallback"
            echo "is to download an unpinned copy and run it, and that is the"
            echo "thing this script exists to prevent — so do not 'fix' this"
            echo "by updating the digest until you know what moved upstream"
            echo "and why. A moved tag on somebody else's repository and a"
            echo "compromised one look identical from here."
        } >&2
        exit 1
    fi

    chmod +x "$staged/$name"
    mv -f "$staged/$name" "$cache/$name"
    echo "  $name  $got"
done <<EOF
$tools
EOF

# The runtime is the one pin nothing picks up by itself: the bundler does not
# look for it, so it reaches `appimagetool` as an environment variable, which
# `linuxdeploy-plugin-appimage` turns into `--runtime-file`. Exported for the
# steps that follow when this runs in Actions, and printed otherwise so that a
# build driven by hand in this shell can be given the same thing.
runtime="$cache/runtime-x86_64"
if [ ! -s "$runtime" ]; then
    echo "appimage-tools.sh: $runtime is not there after seeding" >&2
    exit 1
fi

if [ -n "${GITHUB_ENV:-}" ]; then
    echo "LDAI_RUNTIME_FILE=$runtime" >> "$GITHUB_ENV"
    echo
    echo "LDAI_RUNTIME_FILE=$runtime"
    echo "  exported, so the bundle step hands this runtime to appimagetool"
    echo "  rather than letting it fetch one. appimage-guard.sh checks the"
    echo "  runtime that ends up embedded against the pin above."
else
    echo
    echo "Not running in Actions, so nothing was exported. Before bundling:"
    echo "  export LDAI_RUNTIME_FILE=$runtime"
fi

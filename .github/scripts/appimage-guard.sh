#!/usr/bin/env bash
# Fails the build if the AppImage we just made carries libwayland-client.
#
#   appimage-guard.sh <Firetower_x.y.z_amd64.AppImage>
#
# ## What it is looking for, and why only that one library
#
# An AppImage puts its own `usr/lib` ahead of the host's. Most of what
# linuxdeploy bundles is the point of the format. `libwayland-client.so.0` is
# the exception: Mesa's EGL is loaded from the **host** — a GPU driver cannot
# be bundled — and a current Mesa needs a newer libwayland than the one a
# build machine on Ubuntu 22.04 would copy in. Shadow the host's copy with
# that older one and EGL never initialises: the web process aborts with
# `EGL_BAD_PARAMETER` and the person who downloaded Firetower gets a white
# window with nothing in the log they could act on. That is why
# `libwayland-client.so.0` is on the AppImage excludelist, and
# `appimage-tools.sh` is why our linuxdeploy is new enough to honour it.
#
# `libwayland-egl`, `libwayland-cursor` and `libwayland-server` are **expected
# and fine** — they are not what the host's EGL resolves symbols against — so
# this only ever objects to `-client`. It prints the ones it found either way,
# so a passing run still shows that it looked.
#
# ## Why this is a build step and not a note in a pull request
#
# The fix upstream is a one-line version bump inside the CLI, and the CLI is
# pinned by `desktop/pnpm-lock.yaml`. Bumping that lockfile past 2.12.0 — an
# ordinary, unrelated, entirely reasonable thing for somebody to do — changes
# the file name the bundler looks for in its cache, so `appimage-tools.sh`
# would carry on seeding a path nothing reads, the bundler would quietly
# download its own unpinned copies again, and the only symptom would be a
# white window on somebody else's machine weeks later. Nothing else in the
# build would go red.
#
# So the property is asserted against the artifact itself, where no version
# of anything can talk it out of being true. To see it work, invert the test
# on a scratch branch and watch the job fail.
set -euo pipefail

image=${1:?the .AppImage to check}
image=$(cd "$(dirname "$image")" && pwd)/$(basename "$image")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# `--appimage-extract` unpacks in the working directory and needs no FUSE,
# which a container or a hardened runner may not have.
chmod +x "$image"
(cd "$work" && "$image" --appimage-extract >/dev/null)

root="$work/squashfs-root"
if [ ! -d "$root" ]; then
    echo "appimage-guard.sh: $image did not extract — nothing was checked." >&2
    exit 1
fi

echo "Wayland libraries inside $(basename "$image"):"
find "$root" -name 'libwayland-*' -printf '  %P\n' | sort || true

shadowed=$(find "$root" -name 'libwayland-client*' -printf '%P\n' | sort)
if [ -n "$shadowed" ]; then
    {
        echo
        echo "appimage-guard.sh: this AppImage bundles libwayland-client."
        echo "$shadowed" | sed 's/^/  /'
        echo
        echo "It would shadow the host's copy, Mesa's EGL would fail to"
        echo "initialise against it, and the window would come up white on"
        echo "any reasonably current distribution — with nothing in the log"
        echo "that names this as the cause."
        echo
        echo "The usual reason is that the packaging tools were not the"
        echo "pinned ones: check that .github/scripts/appimage-tools.sh ran"
        echo "in this job, and that it is still seeding the file names the"
        echo "installed @tauri-apps/cli looks for (they changed in 2.12.0)."
    } >&2
    exit 1
fi

echo "No libwayland-client. The host's copy is the one that will be used."

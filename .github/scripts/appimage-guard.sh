#!/usr/bin/env bash
# Checks the AppImage we just made: the runtime embedded in it is the pinned
# one, and it carries no libwayland-client. Either answer fails the build.
#
#   LDAI_RUNTIME_FILE=<pinned runtime> appimage-guard.sh <Firetower_x.y.z_amd64.AppImage>
#
# `appimage-tools.sh` exports that variable; this needs it to have anything to
# compare the embedded runtime against.
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
#
# ## The runtime, checked before this script runs it
#
# `appimagetool` prepends the AppImage runtime to the squashfs, so the first
# bytes of this file *are* that runtime: the first code that executes when
# somebody launches the download, part of what Tauri signs, and the code the
# extraction below has to execute in order to see inside the artifact at all.
#
# `appimage-tools.sh` pins it and hands it over as `$LDAI_RUNTIME_FILE`. This
# is where that is confirmed to be the runtime that actually got embedded —
# and it is done before the extraction, because running it first and asking
# afterwards is the wrong order for the one file here nobody has checked yet.
#
# Without this the pin is worth only as much as an environment variable
# surviving a refactor. `appimagetool` fetches the runtime from a rolling
# upstream tag whenever `--runtime-file` is absent, and a build that had
# quietly gone back to doing that would look exactly like a good one.
set -euo pipefail

image=${1:?the .AppImage to check}
image=$(cd "$(dirname "$image")" && pwd)/$(basename "$image")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

runtime=${LDAI_RUNTIME_FILE:-}
if [ -z "$runtime" ] || [ ! -s "$runtime" ]; then
    {
        echo "appimage-guard.sh: \$LDAI_RUNTIME_FILE does not name a runtime."
        echo
        echo "It is set by .github/scripts/appimage-tools.sh, which pins the"
        echo "runtime and verifies its digest before a build starts. This"
        echo "script needs it to say whether the runtime embedded in the"
        echo "artifact is that one, so run that script in this job before"
        echo "the bundle step."
        echo
        echo "With it unset the honest answer is that nobody knows which"
        echo "runtime is inside this AppImage — so this fails, rather than"
        echo "skipping the one check that would notice a downloaded one."
    } >&2
    exit 1
fi

size=$(stat -c%s "$runtime")

# The runtime is the first `size` bytes of the file, and `appimagetool`
# rewrites exactly sixteen of them: an MD5 over the finished image, into the
# runtime's own `.digest_md5` section. Measured rather than assumed — a
# packaging run with the network blocked differs from the pinned file in these
# bytes and no others, with `.upd_info` and `.sha256_sig` left alone because
# no update information is embedded and nothing here signs with gpg.
#
# The offset is a constant on purpose. It is a property of a file pinned by
# SHA-256, so it cannot quietly go stale: any other runtime fails its digest
# check in `appimage-tools.sh` long before a build arrives here.
digest_md5_at=932096
digest_md5_len=16

head -c "$size" "$image" > "$work/embedded"
if ! cmp -s -n "$digest_md5_at" "$runtime" "$work/embedded" ||
    ! cmp -s -i "$((digest_md5_at + digest_md5_len))" "$runtime" "$work/embedded"; then
    {
        echo
        echo "appimage-guard.sh: the runtime inside this AppImage is not the"
        echo "pinned one."
        echo "  pinned   $runtime"
        echo "           $(sha256sum "$runtime" | cut -d' ' -f1)"
        echo "  embedded first $size bytes of $(basename "$image")"
        echo "           $(sha256sum "$work/embedded" | cut -d' ' -f1)"
        echo "  (the two are expected to differ only in 16 bytes at offset"
        echo "  $digest_md5_at, which is the .digest_md5 section)"
        echo
        echo "The runtime is the first code that runs when somebody launches"
        echo "this download, and it is inside what the updater key signs. The"
        echo "usual reason for this is that \$LDAI_RUNTIME_FILE did not reach"
        echo "the bundle step, so appimagetool fetched its own from"
        echo "type2-runtime's rolling 'continuous' tag — in which case this"
        echo "release would carry a real signature over code nobody pinned."
        echo
        echo "Do not update the pin to make this pass. Find out whether the"
        echo "variable was lost or the upstream asset moved."
    } >&2
    exit 1
fi

echo "Embedded runtime is the pinned $(basename "$runtime") ($size bytes)."

# `--appimage-extract` unpacks in the working directory and needs no FUSE,
# which a container or a hardened runner may not have. The runtime this runs
# is the one checked above.
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

#!/usr/bin/env bash
# Move the rolling worker release onto a version, by copying that version's own
# published files across.
#
#   publish-worker-rolling.sh 0.57.0
#
# `usefiretower.com/worker.sh` redirects to the `worker-latest` release, and the
# script it serves downloads its binary from the same release — so this one
# release decides what a hand-run
#
#   curl -fsSL https://usefiretower.com/worker.sh | sh
#
# puts on a machine. It is the recommended line in the install documentation,
# which is why what it holds is a correctness question rather than a
# convenience one.
#
# ## It follows general access, and a promotion is the only thing that moves it
#
# It used to be moved by `release.yml`, on every release, and its own published
# notes said so. That was true while there was one channel, because the newest
# build *was* general access. Under a continuous beta it is false the moment
# the channels diverge: the rolling release then holds a **beta** worker, and
# somebody following the install guide on a general-access installation
# installs a worker newer than their control plane — which is refused, rather
# than merely odd, because nothing ever moves a worker ahead of its control
# plane. #459, and the same defect as #454 in a second place: a pointer meaning
# *newest* is correct only while the channels are equal.
#
# So it is a pointer at general access, like `:stable` and `desktop-latest`,
# and like them it is moved by `promote.yml` alone. The worker still has **no
# channel of its own** — #419, and the worker section of `docs/channels.md`.
# This is not a worker channel; it is the general-access pointer answering for
# the one path that has no control plane to ask.
#
# The control-plane-generated authorize command is unaffected either way: it
# pins the control plane's own version (`--version X.Y.Z`), so a machine added
# through the interface gets the matching binary whatever channel the
# installation is on. This fixes the hand-run path only.
#
# ## Written after the channel manifest, deliberately
#
# `promote.yml`'s rule is that each package's last write is the one that
# package's own readers consult. The control plane has two sets of readers now:
# installations, which consult the channel manifest, and a person hand-running
# the installer, who consults this release. The manifest still goes first,
# because the two failure directions are not symmetrical:
#
#   * this release **behind** the pin hands out a worker older than the control
#     plane, which the control plane replaces over its own ssh connection on the
#     first connection. An install-then-reinstall, not a failure.
#   * this release **ahead** of the pin hands out a worker newer than the
#     control plane, which is the refusal this whole change exists to prevent.
#
# So an interruption between the two leaves the rolling release lagging, which
# is the recoverable direction, and the re-run finishes the job. Every step
# here is idempotent.
#
# It refuses outright if the channel manifest does not say that general access
# is *exactly* this version: a rerun of an old job must not drag the rolling
# release back behind a newer promotion, and a run whose manifest write did not
# land must not publish a worker nothing has been told to want.
#
# ## The files are the release's own, byte for byte
#
# Nothing is rebuilt and nothing is regenerated. The set is taken from the
# versioned release's `SHA256SUMS` — the document the installer itself verifies
# against — so "the versioned release and the rolling release hold the same
# files" is true by construction rather than by two lists agreeing. Each file
# is checked against that document before it is published and the published
# copies are read back and compared afterwards.
#
# Environment: GH_TOKEN, GITHUB_REPOSITORY, RUNNER_TEMP.
set -euo pipefail

RELEASE=worker-latest
SUMS=SHA256SUMS
ONE_LINER='curl -fsSL https://usefiretower.com/worker.sh | sh'

VERSION="${1:?usage: $0 <version>}"
TAG="firetower-v$VERSION"

here="$(cd "$(dirname "$0")" && pwd)"
work="${RUNNER_TEMP:-/tmp}/worker-rolling"
rm -rf "$work"
mkdir -p "$work/from" "$work/landed"

# macOS has `shasum` and not `sha256sum`. This runs on an Ubuntu runner, but
# its tests run wherever somebody is working, and a script that cannot be run
# outside CI is one nobody checks before pushing. The installer script does the
# same dance for the same reason.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

# ── is general access actually here? ────────────────────────────────────────
#
# Asked of the published manifest rather than taken from the caller, because
# `needs:` does not re-run a job: rerunning this one from an older promotion
# would otherwise move the rolling release back behind a newer one, with
# nothing to notice.
#
# The read's status is taken on its own line and never inside a condition: a
# command substitution inside an `if` is exempt from `set -e`, so a failed read
# would yield an empty string and fall through to whichever branch is written
# first — and "there is no manifest" is the one thing a failed read must never
# be mistaken for. That exact bug was found in this branch's own code once
# already.
state=$("$here/read-channel-manifest.sh" "$work/held.json")
if [ "$state" != present ]; then
  echo "::error::There is no published channel manifest, so nothing says $VERSION is on general" \
       "access — and this release is a general-access pointer. $RELEASE has NOT been touched." \
       "The promotion's manifest write has to land before this runs; re-run the promotion." >&2
  exit 1
fi

# Through the writer's own parser and refusals, not a second looser copy in
# `jq`: a gate that validates differently from the writer is a gate that passes
# documents the writer then refuses.
pins=$(node "$here/channel-manifest.mjs" preflight --held "$work/held.json" --set "control_plane:general=$VERSION")
printf '%s\n' "$pins"
general=$(printf '%s\n' "$pins" | sed -n 's/^held control_plane\.general=//p')
if [ "$general" != "$VERSION" ]; then
  echo "::error::The channel manifest says control_plane general access is '${general:-nothing}', not $VERSION." \
       "$RELEASE follows general access and is not being moved to a version that is not on it." \
       "$RELEASE has NOT been touched. If the promotion's manifest write did not land, re-run the" \
       "promotion; if a newer one overtook this run, promote that version instead." >&2
  exit 1
fi

# ── the set, taken from the release's own checksum file ─────────────────────

if ! gh release download "$TAG" -R "$GITHUB_REPOSITORY" -p "$SUMS" -D "$work/from" --clobber; then
  echo "::error::$TAG has no $SUMS on it, or it would not download, so there is no set of files to" \
       "copy and no document to check them against. $RELEASE has NOT been touched." >&2
  exit 1
fi

# `awk` on the last field: `sha256sum` writes `<hash>  <name>` and names here
# never contain a space. The name pattern is a refusal rather than a
# formality — these names become paths and `gh` arguments.
names=$(awk 'NF { print $NF }' "$work/from/$SUMS")
# The same list on one line, for the membership test and for the messages. Two
# forms rather than `$(echo $names)` three times over, because an unquoted
# expansion in a message is a glob waiting for a file to match it.
listed=$(awk 'NF { printf "%s ", $NF }' "$work/from/$SUMS")
if [ -z "$names" ]; then
  echo "::error::$TAG's $SUMS lists nothing. $RELEASE has NOT been touched." >&2
  exit 1
fi
for name in $names; do
  case "$name" in
    *[!A-Za-z0-9._-]*|.*)
      echo "::error::$TAG's $SUMS names '$name', which is not a plain asset name." \
           "$RELEASE has NOT been touched." >&2
      exit 1 ;;
  esac
done

# **A floor, by name.** The set comes from `SHA256SUMS` so that the two releases
# cannot hold different files — but a `SHA256SUMS` listing only the two macOS
# tarballs would publish a rolling release that silently cannot serve Linux, and
# the only thing that catches that is saying which shapes have to be in it. The
# same reasoning as the two-platform floor on the image index, and the same
# failure it was written for: a set that is self-consistent and incomplete.
for want in \
  firetower-worker-darwin-arm64.tar.gz \
  firetower-worker-darwin-x86_64.tar.gz \
  firetower-worker-linux-arm64.tar.gz \
  firetower-worker-linux-x86_64.tar.gz \
  worker.sh
do
  case " $listed " in
    *" $want "*) ;;
    *) echo "::error::$TAG's $SUMS does not list $want, so $VERSION is not a complete worker release." \
            "It lists: $listed. $RELEASE has NOT been touched." >&2
       exit 1 ;;
  esac
done

for name in $names; do
  if ! gh release download "$TAG" -R "$GITHUB_REPOSITORY" -p "$name" -D "$work/from" --clobber; then
    echo "::error::$TAG's $SUMS lists $name but it would not download." \
         "$RELEASE has NOT been touched." >&2
    exit 1
  fi
done

# Before anything is published, not after. The checksum file is what the
# installer itself verifies against, so a set that does not satisfy it here is
# a set that would fail on somebody's machine instead.
( cd "$work/from" && sha256 -c "$SUMS" ) || {
  echo "::error::$TAG's files do not match its own $SUMS. $RELEASE has NOT been touched." >&2
  exit 1
}

# ── publish ─────────────────────────────────────────────────────────────────

if ! gh release view "$RELEASE" -R "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  gh release create "$RELEASE" -R "$GITHUB_REPOSITORY" --prerelease \
    --title "worker: general access" \
    --notes "The general-access worker, for \`$ONE_LINER\`. Moved by a promotion." \
    >/dev/null
fi

# One file per call, and **`SHA256SUMS` last**. `--clobber` deletes before it
# uploads, so there is a window on every file; publishing the checksum file
# after the files it describes means the window is always "the installer
# refuses a set it cannot verify" rather than "the installer installs a binary
# nothing vouched for". A re-run closes it.
for name in $names; do
  if [ "$name" = "$SUMS" ]; then continue; fi
  gh release upload "$RELEASE" "$work/from/$name" -R "$GITHUB_REPOSITORY" --clobber
done
gh release upload "$RELEASE" "$work/from/$SUMS" -R "$GITHUB_REPOSITORY" --clobber

# What this release is, said on the release itself. It is read by whoever
# wonders what the one-liner is about to install, and the old wording — "Moved
# on every release" — is the claim #459 was opened for.
gh release edit "$RELEASE" -R "$GITHUB_REPOSITORY" \
  --title "worker: general access ($VERSION)" \
  --notes "The general-access worker ($VERSION), for \`$ONE_LINER\`.

Moved by \`promote.yml\` when general access moves, and by nothing else — a release does **not** move it, so it never serves a beta worker to somebody following the install guide. $TAG holds the same files.

To install a particular version instead: \`… | sh -s -- --version $VERSION\`. The command Firetower hands you when you add a machine already pins its own version, so a machine added through the interface gets the matching binary whatever channel the installation is on. See docs/channels.md."

# ── and is that what a reader now gets? ─────────────────────────────────────
#
# The uploads are not one transaction, so the only statement worth making is
# about what is published afterwards: every file on the rolling release is the
# same byte sequence as the file on the versioned release. That is the whole
# promise — the two can never disagree — and it is cheap to simply check.
for name in $names; do
  if ! gh release download "$RELEASE" -R "$GITHUB_REPOSITORY" -p "$name" -D "$work/landed" --clobber; then
    echo "::error::$name was uploaded to $RELEASE and then could not be read back." \
         "Nothing is being assumed about what is published there. Re-run." >&2
    exit 1
  fi
  if ! cmp -s "$work/landed/$name" "$work/from/$name"; then
    echo "::error::$RELEASE's $name is not the $name on $TAG. The two releases have to hold the" \
         "same files or the installer's own checksum check will fail on somebody's machine. Re-run." >&2
    exit 1
  fi
done

echo "$RELEASE now holds $VERSION: $listed"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### the rolling worker release"
    echo "\`$RELEASE\` → **$VERSION**, copied from \`$TAG\`."
    echo ""
    echo "A hand-run \`$ONE_LINER\` now installs $VERSION."
  } >>"$GITHUB_STEP_SUMMARY"
fi

#!/usr/bin/env bash
# Move one or more channel pins in the published channel manifest.
#
#   publish-channel-pin.sh control_plane:beta=0.57.0 [desktop:beta=0.21.0 ...]
#
# Called by `release.yml` to put a released version on beta, and by
# `promote.yml` as the **last** step of a promotion. That it is last is the
# whole design: the manifest is what every installation reads, so nothing has
# been promoted until this upload lands. A failure before it leaves an
# inconsistent registry but a consistent world — the tags have moved, but
# nothing has been told to want them — and the run can simply be repeated.
#
# One writer, deliberately. Both callers go through this script rather than
# each having a copy of the rule, because two copies of a rule is one copy of
# a rule. The read is `read-channel-manifest.sh`'s, for the same reason, and
# the decision is `channel-manifest.mjs`'s — which is the half worth unit
# testing on documents rather than against a network.
#
# Environment: GH_TOKEN, GITHUB_REPOSITORY, RUNNER_TEMP.
set -euo pipefail

# The manifest lives on a rolling release of its own. It has to: it is mutable
# by design, so it cannot live at an immutable ref, and the host's own notion
# of "latest release" is whichever package released most recently — the
# desktop's, half the time. `worker-latest` and `desktop-latest` are the same
# pattern. Marked a prerelease so the control plane's `!draft && !prerelease`
# filter keeps skipping it when it enumerates actual versions.
RELEASE=channels
ASSET=channels.json

[ "$#" -gt 0 ] || { echo "usage: $0 <package>:<channel>=<version> ..." >&2; exit 64; }

here="$(cd "$(dirname "$0")" && pwd)"
work="${RUNNER_TEMP:-/tmp}/channel-manifest"
rm -rf "$work"
mkdir -p "$work"

# ── read what is published ─────────────────────────────────────────────────
#
# Exits non-zero for anything that is not an answer and not an absence, and
# nothing below then runs — which is what makes "it could not read it" and
# "it moved nothing" the same sentence.
#
# The read's status is taken on its own line and not inside the `if`, which is
# not a style choice: a command substitution *inside* a condition is exempt
# from `set -e`, so a failed read would yield an empty string, miss `present`,
# and fall through to the bootstrap branch — which is "there is no manifest",
# which is the one thing a failed read must never be mistaken for.
held=()
state=$("$here/read-channel-manifest.sh" "$work/held.json")
if [ "$state" = present ]; then
  held=(--held "$work/held.json")
else
  echo "No channel manifest published yet — this run writes the first one."
  if ! gh release view "$RELEASE" -R "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    gh release create "$RELEASE" -R "$GITHUB_REPOSITORY" --prerelease \
      --title "channels" \
      --notes "Which version each channel points at, per package. Written by the release workflow (\`beta\`) and by \`promote.yml\` (\`general\`). See docs/channels.md." \
      >/dev/null
  fi
fi

# ── decide ─────────────────────────────────────────────────────────────────
#
# A refusal exits non-zero from here, so the upload below never happens and
# every pointer is left where it was.
sets=()
for spec in "$@"; do sets+=(--set "$spec"); done

# `${x[@]+"${x[@]}"}`, because `held` is empty on the bootstrap run and an
# empty array under `set -u` is an unbound variable on bash 3.2 — which is
# what a Mac runs, and what this script's tests run on.
echo "Pinning:"
node "$here/channel-manifest.mjs" pin ${held[@]+"${held[@]}"} "${sets[@]}" --out "$work/$ASSET"

# ── publish ────────────────────────────────────────────────────────────────
#
# Clobbering, because the document is a pointer rather than a version: there is
# exactly one of it and the new one replaces the old. This upload is the commit
# point of a promotion.
gh release upload "$RELEASE" "$work/$ASSET" -R "$GITHUB_REPOSITORY" --clobber
echo "published:"
cat "$work/$ASSET"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### channel manifest"
    echo '```json'
    cat "$work/$ASSET"
    echo '```'
  } >>"$GITHUB_STEP_SUMMARY"
fi

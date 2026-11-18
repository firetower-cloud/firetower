#!/usr/bin/env bash
# Move one or more channel pins in the published channel manifest.
#
#   publish-channel-pin.sh control_plane:beta=0.57.0 [desktop:beta=0.21.0 ...]
#
# Called by `release.yml` to put a released version on beta, and by
# `promote.yml` as the **last** step of a promotion. That it is last is the
# whole design: the manifest is what every installation reads, so nothing has
# been promoted until this upload lands.
#
# One writer, deliberately. Both callers go through this script rather than
# each having a copy of the rule, because two copies of a rule is one copy of a
# rule. The read is `read-channel-manifest.sh`'s and the decision is
# `channel-manifest.mjs`'s, for the same reason.
#
# Environment: GH_TOKEN, GITHUB_REPOSITORY, RUNNER_TEMP.
#
# ## Why this loops: a shared script is not a serialised writer
#
# A release and a promotion can overlap. Both read the whole document, change
# different pins, and upload the whole document — so the later upload restores
# the earlier writer's view and silently undoes it. Reproduced: a release read
# `general 0.55.0`, a promotion committed `0.57.0`, the release finished and
# put `0.55.0` back. Both exited zero.
#
# So every attempt **reads, decides, writes, and then reads back what landed**.
# If the document on the release is not the one this attempt wrote, somebody
# else wrote in between — and the answer is not to fail but to go round again,
# re-reading *their* document and re-applying these pins on top of it. The
# updates commute (different packages, different channels) and never move
# backwards, so re-applying converges and both survive.
#
# **Why not a shared Actions concurrency group**, which is the obvious
# alternative and was the suggested remedy: a group would serialise these two
# writers, but a *pending* run in a group is cancelled when a third arrives —
# `desktop-release.yml`'s header documents that being measured on this
# repository, which is why it carries `queue: max`. A release whose manifest
# write was evicted while pending would move the `beta` image tag and never
# record it, which is a new failure in place of the old one. A group is also
# blind to anything that is not a workflow run: a rerun of an old job, or
# somebody replacing the asset by hand. Re-reading and re-applying is correct
# without depending on any of that, and a group can be added on top later for
# contention rather than for correctness. This is a deliberate deviation from
# the stated remediation and the reasoning is here so it can be overruled.
set -euo pipefail

# The manifest lives on a rolling release of its own. It has to: it is mutable
# by design, so it cannot live at an immutable ref, and the host's own notion
# of "latest release" is whichever package released most recently — the
# desktop's, half the time. `worker-latest` and `desktop-latest` are the same
# pattern. Marked a prerelease so the control plane's `!draft && !prerelease`
# filter keeps skipping it when it enumerates actual versions.
RELEASE=channels
ASSET=channels.json
PREVIOUS=channels.previous.json
ATTEMPTS=5

[ "$#" -gt 0 ] || { echo "usage: $0 <package>:<channel>=<version> ..." >&2; exit 64; }

here="$(cd "$(dirname "$0")" && pwd)"
work="${RUNNER_TEMP:-/tmp}/channel-manifest"
rm -rf "$work"
mkdir -p "$work"

sets=()
for spec in "$@"; do sets+=(--set "$spec"); done

attempt=1
while :; do
  echo "── attempt $attempt of $ATTEMPTS ──"

  # ── read what is published ───────────────────────────────────────────────
  #
  # Exits non-zero for anything that is not an answer and not an absence, and
  # nothing below then runs — which is what makes "it could not read it" and
  # "it moved nothing" the same sentence.
  #
  # The read's status is taken on its own line and not inside the `if`, which
  # is not a style choice: a command substitution *inside* a condition is
  # exempt from `set -e`, so a failed read would yield an empty string, miss
  # `present`, and fall through to the bootstrap branch — which is "there is no
  # manifest", the one thing a failed read must never be mistaken for.
  held=()
  rm -f "$work/held.json"
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

  # ── decide ───────────────────────────────────────────────────────────────
  #
  # A refusal exits non-zero from here, so nothing below runs and every pointer
  # is left where it was.
  #
  # `${x[@]+"${x[@]}"}`, because `held` is empty on the bootstrap run and an
  # empty array under `set -u` is an unbound variable on bash 3.2 — which is
  # what a Mac runs, and what this script's tests run on.
  echo "Pinning:"
  node "$here/channel-manifest.mjs" pin ${held[@]+"${held[@]}"} "${sets[@]}" --out "$work/$ASSET"

  # ── publish ──────────────────────────────────────────────────────────────
  #
  # **The previous document first, and always.** `--clobber` deletes before it
  # uploads, so an upload that fails in between leaves the release with no
  # manifest at all — and absence is the bootstrap case, which would then
  # accept a version older than the pin that had just been destroyed. It was
  # reproduced exactly that way. Leaving `channels.previous.json` behind is
  # what lets `read-channel-manifest.sh` tell a repository that has never
  # promoted from one whose manifest has been destroyed, and it is also the
  # copy a person recovers from.
  #
  # Uploaded before `$ASSET` is touched, so if *this* upload is the one that
  # fails, the live manifest is still there and untouched.
  if [ "$state" = present ]; then
    cp "$work/held.json" "$work/$PREVIOUS"
    gh release upload "$RELEASE" "$work/$PREVIOUS" -R "$GITHUB_REPOSITORY" --clobber
  fi

  gh release upload "$RELEASE" "$work/$ASSET" -R "$GITHUB_REPOSITORY" --clobber

  # ── and did it land, unaltered? ──────────────────────────────────────────
  #
  # The compare-and-swap. Reading back is the only way to find out whether
  # another writer landed between this attempt's read and its write — and if
  # one did, going round again re-reads *their* document and re-applies these
  # pins on top, so both survive.
  rm -f "$work/landed.json"
  state=$("$here/read-channel-manifest.sh" "$work/landed.json")
  if [ "$state" != present ]; then
    echo "::error::The manifest was uploaded and then could not be read back." \
         "Nothing is being assumed about what is published. Re-run." >&2
    exit 1
  fi
  if cmp -s "$work/landed.json" "$work/$ASSET"; then
    echo "published:"
    cat "$work/$ASSET"
    break
  fi

  echo "::warning::Another writer changed the channel manifest during this attempt." \
       "Re-reading it and re-applying these pins on top of theirs."
  attempt=$((attempt + 1))
  if [ "$attempt" -gt "$ATTEMPTS" ]; then
    echo "::error::Gave up after $ATTEMPTS attempts: something is rewriting the channel" \
         "manifest faster than this can read it back. These pins are NOT published." >&2
    exit 1
  fi
done

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### channel manifest"
    echo '```json'
    cat "$work/$ASSET"
    echo '```'
  } >>"$GITHUB_STEP_SUMMARY"
fi

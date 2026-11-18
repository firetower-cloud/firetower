#!/usr/bin/env bash
# Read the published channel manifest, with the outcomes kept apart.
#
#   read-channel-manifest.sh <where-to-write-it>
#
# Prints `absent` or `present` on stdout; writes the document to the path given
# when it is `present`. Exits non-zero for everything else, having printed why.
#
# ## The outcomes, which are not interchangeable
#
# Inherited from `desktop-release.yml`'s publish job, and binding on everything
# that touches this document:
#
#   * **no release at all, or a release carrying nothing** — absence. There is
#     nothing to go backwards past and this run is the one that creates it.
#     This is `github.token` on its own repository, so a 404 is absence rather
#     than a permission it was refused.
#   * **a manifest that reads** — the answer.
#   * **anything else** — a rate limit, a network failure, a document that will
#     not download, **or a release that plainly held a manifest and now does
#     not**. Stop, and move nothing.
#
# That last clause is a finding rather than a precaution. `gh release upload
# --clobber` **deletes the existing asset before uploading its replacement**,
# so an upload that fails in between leaves the release with no manifest on it
# at all. Absence then means two incompatible things — "nothing was ever
# published" and "what was published has been destroyed" — and the first of
# them is the bootstrap case, which accepts any version including one older
# than the pin that was just lost. It was reproduced exactly that way.
#
# So `publish-channel-pin.sh` always leaves `channels.previous.json` on the
# release before it touches `channels.json`, and this read treats a release
# carrying that but not the manifest as the destroyed case. A read that goes
# wrong must never be allowed to look like "general access is at version zero",
# and neither must a write that went wrong.
#
# Environment: GH_TOKEN, GITHUB_REPOSITORY, RUNNER_TEMP.
set -euo pipefail

RELEASE=channels
ASSET=channels.json
PREVIOUS=channels.previous.json

out="${1:?usage: $0 <path to write the manifest to>}"
err="${RUNNER_TEMP:-/tmp}/channel-manifest-read.err"
rm -f "$out"

# Every asset name on the release, one per line. `--jq` over the release rather
# than a blind download, so "no release", "a release carrying nothing" and "a
# release whose manifest is missing" are three answerable questions before
# anything is fetched — and so the error from the read is kept rather than
# discarded.
names=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$RELEASE" \
  --jq '.assets[].name' 2>"$err") || names="__failed__"

if [ "$names" = "__failed__" ]; then
  if ! grep -q '(HTTP 404)' "$err"; then
    cat "$err" >&2
    echo "Could not read the published channel manifest, so nothing is being moved." >&2
    echo "This is not the same as there not being one. Re-run once the read works." >&2
    exit 1
  fi
  echo absent
  exit 0
fi

if ! printf '%s\n' "$names" | grep -qx "$ASSET"; then
  # The release exists but the manifest is not on it. Which of the two things
  # that means is decided by whether a manifest was ever published here.
  if printf '%s\n' "$names" | grep -qx "$PREVIOUS"; then
    echo "The $RELEASE release carries $PREVIOUS but no $ASSET." >&2
    echo "A manifest was published here and is now missing — this is a destroyed" >&2
    echo "manifest, not a repository that has never promoted, and it is NOT the" >&2
    echo "bootstrap case. Nothing is being moved." >&2
    echo >&2
    echo "To recover: check $PREVIOUS on the $RELEASE release, confirm it is the" >&2
    echo "document you expect, and re-upload it as $ASSET. Then re-run." >&2
    exit 1
  fi
  echo absent
  exit 0
fi

dir="${RUNNER_TEMP:-/tmp}/channel-manifest-held"
rm -rf "$dir"
if ! gh release download "$RELEASE" -R "$GITHUB_REPOSITORY" -p "$ASSET" -D "$dir" --clobber; then
  echo "The published channel manifest would not download, so nothing is being moved." >&2
  echo "This is not the same as there not being one. Re-run once the download works." >&2
  exit 1
fi
mv "$dir/$ASSET" "$out"
echo present

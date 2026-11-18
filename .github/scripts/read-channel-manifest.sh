#!/usr/bin/env bash
# Read the published channel manifest, with the three outcomes kept apart.
#
#   read-channel-manifest.sh <where-to-write-it>
#
# Prints `absent` or `present` on stdout; writes the document to the path given
# when it is `present`. Exits non-zero for everything else, having printed why.
#
# ## The three outcomes, which are not interchangeable
#
# Inherited verbatim from `desktop-release.yml`'s publish job, and binding on
# everything that touches this document:
#
#   * **no release, or one with no manifest on it yet** — absence. There is
#     nothing to go backwards past and this run is the one that creates it.
#     This is `github.token` on its own repository, so a 404 is absence rather
#     than a permission it was refused.
#   * **a manifest that reads** — the answer.
#   * **anything else** — a rate limit, a network failure, a document that will
#     not download. **Stop, and move nothing.**
#
# That last one is the entire point, and it is the failure the desktop job was
# rewritten to remove: a read that went wrong was all it took to permit the one
# thing the rule exists to prevent. A read that goes wrong must never be
# allowed to look like "general access is at version zero".
#
# Environment: GH_TOKEN, GITHUB_REPOSITORY, RUNNER_TEMP.
set -euo pipefail

RELEASE=channels
ASSET=channels.json

out="${1:?usage: $0 <path to write the manifest to>}"
err="${RUNNER_TEMP:-/tmp}/channel-manifest-read.err"
rm -f "$out"

assets=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$RELEASE" \
  --jq "[.assets[] | select(.name == \"$ASSET\")] | length" 2>"$err") || assets=""

if [ -z "$assets" ]; then
  if ! grep -q '(HTTP 404)' "$err"; then
    cat "$err" >&2
    echo "Could not read the published channel manifest, so nothing is being moved." >&2
    echo "This is not the same as there not being one. Re-run once the read works." >&2
    exit 1
  fi
  echo absent
  exit 0
fi

if [ "$assets" = 0 ]; then
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

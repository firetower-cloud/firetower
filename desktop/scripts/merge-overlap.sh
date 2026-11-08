#!/usr/bin/env bash
# Where main's change landed in something we had rewritten.
#
# **Not an assertion — a list.** The check somebody wants here is "each of
# main's hunks still has an equivalent in our version", and that is semantic
# equivalence between two rewrites of the same file. There is no cheap honest
# way to assert it: a textual check says nothing when both sides moved, and a
# check that cries wolf on twenty-seven files gets switched off.
#
# What *is* cheap is naming the ground where a fix can disappear, so the
# reading is bounded and repeatable rather than remembered. A file high in
# both columns is where to look first.
#
#   desktop/scripts/merge-overlap.sh <merge-base> <merge-commit>
set -euo pipefail

BASE="${1:-153c27c4}"
MERGE="${2:-157ed6af}"

echo "  Files main changed that we had also changed, between $BASE and the merge:"
echo
comm -12 \
  <(git diff --name-only "$BASE" origin/main -- desktop/src | sort) \
  <(git diff --name-only "$BASE" "${MERGE}^" -- desktop/src | sort) |
while read -r f; do
  m=$(git diff --numstat "$BASE" origin/main -- "$f" | awk '{print $1+$2}')
  o=$(git diff --numstat "$BASE" "${MERGE}^" -- "$f" | awk '{print $1+$2}')
  printf "    %-48s main %5s · ours %6s\n" "${f#desktop/src/}" "${m:-0}" "${o:-0}"
done
echo
echo "  Read the high-in-both rows first. Each of main's hunks there needs an"
echo "  equivalent in our version, or a reason it does not."

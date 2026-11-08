#!/usr/bin/env bash
# No commit authored on this branch touches the backend.
#
# Criteria 52–53. This used to be `git diff --stat main -- api/ crates/
# migrations/` and expected to be empty — which held right up until the branch
# merged main and *contained* main's backend commits, at which point the diff
# against the old base was 148 files and said nothing at all.
#
# The question was never "does this branch differ from some base in api/". It
# is "did we write anything there", so it is asked of our own commits.
#
#   desktop/scripts/check-backend-untouched.sh [base]
set -euo pipefail

BASE="${1:-origin/main}"
PATHS=(api/ crates/ migrations/)

bad=0
while read -r sha; do
  [ -z "$sha" ] && continue
  if [ -n "$(git show --stat --format='' "$sha" -- "${PATHS[@]}")" ]; then
    echo "  touched the backend: $(git log -1 --format='%h %s' "$sha")"
    bad=1
  fi
done < <(git log --format='%H' --no-merges "$BASE..HEAD")

if [ "$bad" = 1 ]; then
  echo
  echo "  Criteria 52–53: the redesign does not change the backend."
  exit 1
fi
echo "  No commit on this branch touches ${PATHS[*]}."

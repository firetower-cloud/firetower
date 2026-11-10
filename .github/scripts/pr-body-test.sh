#!/usr/bin/env sh
# Runs every body in `.github/fixtures/pr-bodies` past `pr-body.sh`.
#
# Every bug the body reader has had was found by running it against a body,
# never by reading it — six of them, across six passes. So the bodies that
# found them are kept, with the verdict each one has to reach, and this runs on
# every pull request alongside the check itself. Something loosened by accident
# fails here first.
#
# Rather more than half of these are honest bodies that have to keep passing.
# That is deliberate: four of the six were false failures, and a false failure
# costs a contributor where a missed bypass costs a review.
#
# Every expectation in `expected.tsv` is derived from GitHub's own renderer, by
# POSTing the body to `/markdown` and reading the HTML that comes back. Twice a
# fixture has been the thing that was wrong rather than the code, and both
# times it was because somebody wrote down what they expected instead of
# asking.
#
# This talks to the network, because `pr-body.sh` does — it is the same call on
# the same path, which is the point. Set `GH_TOKEN` to avoid the unauthenticated
# rate limit. Run it from anywhere; it finds the fixtures beside itself.
set -eu

here=$(dirname "$0")
fixtures="$here/../fixtures/pr-bodies"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Two diffs, because the only thing the body reader asks of the diff is whether
# anybody can see the result of it.
printf '%s\n' desktop/src/ui/TasksPage.tsx mobile/src/ui/Tasks.tsx > "$tmp/ui.files"
printf '%s\n' crates/ft-server/src/lib.rs docs/acp.md > "$tmp/backend.files"
printf '12\t0\tx\n' > "$tmp/numstat"
: > "$tmp/summary"

pass=0
fail=0

while IFS="$(printf '\t')" read -r name diff want; do
    case "$name" in ''|'#'*) continue ;; esac

    out=$(BODY="$(cat "$fixtures/$name.md")" TITLE="feat(desktop): a change" \
          GITHUB_STEP_SUMMARY="$tmp/summary" "$here/pr-body.sh" "$tmp/$diff.files" "$tmp/numstat" 2>&1) \
        && code=0 || code=$?

    got=""
    case "$out" in *"shows none of it"*)          got="$got+no-evidence" ;; esac
    case "$out" in *"changed after they are"*)    got="$got+not-hosted" ;; esac
    case "$out" in *"missing sections"*)          got="$got+missing-sections" ;; esac
    case "$out" in *"✓ the pull request"*)        got="$got+ok" ;; esac
    got=${got#+}

    want_code=1
    [ "$want" = ok ] && want_code=0

    if [ "$got" = "$want" ] && [ "$code" -eq "$want_code" ]; then
        pass=$((pass + 1))
        printf '  ok    %-26s %s\n' "$name" "$got"
    else
        fail=$((fail + 1))
        printf '  FAIL  %-26s wanted %s (exit %s), got %s (exit %s)\n' \
            "$name" "$want" "$want_code" "${got:-nothing}" "$code"
    fi
done < "$fixtures/expected.tsv"

echo
if [ "$fail" -ne 0 ]; then
    echo "$fail of $((pass + fail)) bodies reached the wrong verdict."
    echo "Each one in $fixtures is there because it was a bug once."
    exit 1
fi
echo "all $pass bodies reach the verdict they are supposed to"

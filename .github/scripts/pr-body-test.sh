#!/usr/bin/env sh
# Runs every body in `.github/fixtures/pr-bodies` past `pr-body.sh`.
#
# Three bugs in the body reader have been found so far and all three were found
# by running it, never by reading it. So the bodies that found them are kept,
# with the verdict each one has to reach, and this runs on every pull request
# alongside the check itself. A regex in `pr-body.sh` that is loosened by
# accident fails here first.
#
# Every expectation in `expected.tsv` was rendered through GitHub's own
# markdown API before it was written down. That matters more than it sounds:
# the whole family of bugs is the difference between what a check reads and
# what a reader sees, so agreeing with ourselves proves nothing.
#
# Run it from anywhere; it finds the fixtures beside itself.
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

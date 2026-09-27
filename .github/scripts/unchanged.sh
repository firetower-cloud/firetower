#!/usr/bin/env sh
# Fails if the generator that just ran changed anything under the given paths.
#
# Used by the `contract` workflow after it regenerates, and by `just gen-check`,
# so a local run and a CI run reach the same verdict.
#
# Two questions, because one of them used to go unasked. `git diff` catches a
# file the generator rewrote, and prints it, which is what somebody reading a
# failed job wants. But a diff cannot see a file that did not exist before —
# and a new tag in the contract means a whole new generated file — so untracked
# files are asked about separately. A check that only ran the diff would pass a
# pull request that forgot to add them.
#
# Both compare against the index rather than HEAD, so staging the regenerated
# files counts as having dealt with them.
set -eu

if [ "$#" -eq 0 ]; then
    echo "usage: unchanged.sh <path>..." >&2
    exit 2
fi

git --no-pager diff -- "$@"

rewritten=$(git diff --name-only -- "$@")
added=$(git ls-files --others --exclude-standard -- "$@")

if [ -n "$rewritten" ] || [ -n "$added" ]; then
    {
        echo
        echo "The committed output is not what the sources produce."
        echo
        if [ -n "$rewritten" ]; then
            echo "$rewritten" | sed 's/^/  rewritten  /'
        fi
        if [ -n "$added" ]; then
            echo "$added" | sed 's/^/  new        /'
        fi
        echo
        echo "Run 'just gen' and commit what it changes. If nothing in your"
        echo "branch touched the contract then the generator itself moved —"
        echo "check the pinned orval version."
    } >&2
    exit 1
fi

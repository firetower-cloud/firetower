#!/bin/sh
# The `docker` a session finds first.
#
# A container a session starts is not a child of that session. It is a child of
# the daemon, which lives in this worker container's own cgroup — so without
# being told otherwise it comes up beside the workspace that asked for it and
# inherits none of that workspace's limits. Telling it otherwise is
# `--cgroup-parent`, and the only place holding both the workspace's cgroup and
# the command being run is here, in front of the client.
#
# On `$PATH` at /usr/local/bin, ahead of the real client at /usr/bin/docker.
#
# ## What this is not
#
# Not a boundary. A session that runs `/usr/bin/docker` directly goes straight
# past this, and is meant to be able to — a worker is `--privileged`, and
# anything inside it could have the machine if it wanted one. This divides a
# machine fairly between workspaces that are all trying to work. It does not
# defend one from another.
#
# ## Failing open, deliberately
#
# Every path through here ends in the real client with the caller's own
# arguments. A workspace whose container escaped its cgroup is a workspace
# accounted wrongly; a shim that refused the command is a session that cannot
# bring its database up. The first is a bad number and the second is a broken
# product, so anything this cannot work out is passed through untouched.

set -eu

REAL=/usr/bin/docker

# Not in a session, or a worker whose machine could not be divided up — see
# `cgroup::available`. Nothing to add, so add nothing.
if [ -z "${FIRETOWER_CGROUP_PARENT:-}" ] || [ ! -x "$REAL" ]; then
    exec "$REAL" "$@"
fi

# Already said, by an agent that knew what it wanted. Theirs wins: the point is
# to give containers a home, not to overrule somebody who picked one.
for arg in "$@"; do
    case $arg in
        --cgroup-parent|--cgroup-parent=*) exec "$REAL" "$@" ;;
    esac
done

# How many of the arguments belong to the command itself rather than to its
# subcommand. `docker compose -f a.yml up` has one; `docker compose up` has
# none. Used twice below, and both times the order has to survive: `-f` is
# positional, and the later file is the one that wins.
leading() {
    count=0
    for a in "$@"; do
        case $a in
            up|run|create|start) break ;;
        esac
        count=$((count + 1))
    done
    echo "$count"
}

case ${1:-} in
    # The two that make a container directly. `--cgroup-parent` goes in after
    # the subcommand and before everything else, where a flag is always allowed.
    run|create)
        subcommand=$1
        shift
        exec "$REAL" "$subcommand" --cgroup-parent="$FIRETOWER_CGROUP_PARENT" "$@"
        ;;

    compose)
        shift
        n=$(leading "$@")

        # Asked of Compose rather than read out of a file, because Compose is
        # what knows: which files it discovered when it was given none, what an
        # `extends` pulled in, and which profile is on. Through the real client,
        # or this would call itself.
        #
        # In a subshell, so the argument list can be taken apart without
        # losing it. Rotating one argument from the front to the back `$#`
        # times returns the list unchanged, which makes it the one way to
        # index into `"$@"` in POSIX sh without flattening the quoting — a
        # compose file whose path has a space in it stays one argument.
        services=$(
            i=0
            while [ "$i" -lt "$n" ]; do
                arg=$1
                shift
                set -- "$@" "$arg"
                i=$((i + 1))
            done
            # The subcommand and its own arguments are at the front now.
            tail_count=$(($# - n))
            i=0
            while [ "$i" -lt "$tail_count" ]; do
                shift
                i=$((i + 1))
            done
            "$REAL" compose "$@" config --services 2>/dev/null
        ) || services=""

        # A compose file with a problem in it, or a project with no services.
        # Either way the error worth showing is the real command's, not this
        # one's.
        [ -n "$services" ] || exec "$REAL" compose "$@"

        override=$(mktemp -t firetower-cgroup-XXXXXX.yml) || exec "$REAL" compose "$@"
        # A worker that stays up for weeks would otherwise collect one of these
        # per `compose up`.
        trap 'rm -f "$override"' EXIT INT TERM

        printf 'services:\n' > "$override"
        echo "$services" | while IFS= read -r service; do
            [ -n "$service" ] || continue
            printf '  %s:\n    cgroup_parent: %s\n' \
                "$service" "$FIRETOWER_CGROUP_PARENT" >> "$override"
        done

        # Whether the caller named any files themselves. This decides how the
        # override gets in, and getting it wrong is not subtle: a bare `-f`
        # switches Compose's own discovery off, so a caller who passed no files
        # would find their `compose.yaml` had stopped existing and every service
        # in it had "neither an image nor a build context".
        named_a_file=no
        i=0
        for arg in "$@"; do
            [ "$i" -lt "$n" ] || break
            case $arg in
                -f|--file|-f=*|--file=*) named_a_file=yes ;;
            esac
            i=$((i + 1))
        done

        if [ "$named_a_file" = yes ]; then
            # Theirs are already there, so this only has to come after them —
            # `-f` is positional and the later file merges over the earlier.
            i=0
            total=$#
            while [ "$i" -lt "$total" ]; do
                arg=$1
                shift
                if [ "$i" -eq "$n" ]; then
                    set -- "$@" -f "$override"
                fi
                set -- "$@" "$arg"
                i=$((i + 1))
            done
            # A subcommand in last place means the insertion point above is
            # never reached.
            if [ "$n" -eq "$total" ]; then
                set -- "$@" -f "$override"
            fi
        else
            # Nothing named, so Compose was going to discover its own — and
            # naming ours would stop it. `COMPOSE_FILE` is the way in that adds
            # to that list instead of replacing it, and it is what Compose reads
            # before it starts looking.
            #
            # Discovery is reproduced rather than asked for, because there is no
            # command that reports which files Compose *would* read. Same names
            # in the same order, nearest directory first.
            if [ -z "${COMPOSE_FILE:-}" ]; then
                found=""
                dir=$PWD
                while [ -n "$dir" ]; do
                    for base in compose.yaml compose.yml \
                                docker-compose.yaml docker-compose.yml; do
                        [ -f "$dir/$base" ] || continue
                        found="$dir/$base"
                        # The sibling Compose picks up on its own, when there is
                        # one. Left out, a project that keeps its ports in an
                        # override file would come up without them.
                        stem=${base%.*}
                        ext=${base##*.}
                        if [ -f "$dir/$stem.override.$ext" ]; then
                            found="$found${COMPOSE_PATH_SEPARATOR:-:}$dir/$stem.override.$ext"
                        fi
                        break
                    done
                    [ -n "$found" ] && break
                    [ "$dir" = "/" ] && break
                    dir=$(dirname "$dir")
                done
                # Nothing found is a project Compose will refuse too, and its
                # refusal is the better one to show.
                [ -n "$found" ] || exec "$REAL" compose "$@"
                COMPOSE_FILE="$found"
            fi
            COMPOSE_FILE="$COMPOSE_FILE${COMPOSE_PATH_SEPARATOR:-:}$override"
            export COMPOSE_FILE
        fi

        # Not `exec`: the override has to outlive the command reading it, so
        # this waits and then lets the trap clean up.
        if "$REAL" compose "$@"; then
            exit 0
        else
            exit $?
        fi
        ;;
esac

exec "$REAL" "$@"

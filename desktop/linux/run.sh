#!/usr/bin/env bash
# The harness, from a Mac.
#
#   desktop/linux/run.sh            # build the image, then run every phase
#   desktop/linux/run.sh build      # one phase of check.sh (see its header)
#   desktop/linux/run.sh --shell    # a prompt in the container
#
# The source is mounted read-only and copied inside, so a Linux `target/` and
# a Linux `node_modules/` never land in the checkout a Mac is also building in.
# Cargo's registry, the build directory, pnpm's store and `node_modules` are
# named volumes, so the second run does not pay for the first one's downloads.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
desktop=$(dirname "$here")
image=${IMAGE:-firetower-linux-check:latest}

docker build -f "$here/Dockerfile.check" -t "$image" "$here"

mkdir -p "$here/shots"

# Both are empty in one of the two forms below, and `${a[@]+"${a[@]}"}` is
# what expands an empty array to nothing rather than to an error: macOS ships
# bash 3.2, where `"${a[@]}"` on an empty array is unbound under `set -u`, so
# the plain spelling killed `run.sh` and `run.sh build` before a container
# started. This is the only bash on a Mac that needs no install, so it is the
# one this has to run on.
entry=()
args=("$@")
if [ "${1:-}" = "--shell" ]; then args=(); entry=(--entrypoint /bin/bash); fi

# A tty only if there is one to give. Without this the same script cannot be
# run by hand and from a job.
tty=(-i)
[ -t 0 ] && tty=(-it)

# The label is how teardown finds this container. `$FIRETOWER_SESSION` is the
# session id the worker exports into every session — `ft_core::SESSION_ENV` —
# and `ft_worker::docker::sweep` removes everything carrying it when a session
# ends, so a container left running here is cleared up with the rest of what
# that session started. This read `$FT_SESSION` until #342, a name assigned
# nowhere in the tree, so the label was always the literal `local` and the
# sweep matched nothing: the one thing the label exists to prevent.
#
# Run by hand from a Mac — which is what this script is for — there is no
# session and no sweep is ever coming. Refusing to start would break that use;
# `local` is worse than useless, being both unswept and indistinguishable from
# a session id. So the fallback names the person instead, and the script says
# out loud that nothing will come for it and what to type when it has to go.
session=${FIRETOWER_SESSION:-}
if [ -z "$session" ]; then
  session="manual-$(id -un)-$$"
  cat >&2 <<EOF
run.sh: FIRETOWER_SESSION is unset, so nothing will sweep this container.
  --rm removes it when it exits on its own. If this script is killed first:
  docker ps -a --filter label=com.firetower.session=$session
  docker rm -f \$(docker ps -aq --filter label=com.firetower.session=$session)
EOF
fi

# arm64 on an Apple Silicon daemon, which is the native and therefore the
# honest choice for a render check: emulated x86_64 would make every "is the
# renderer blank" answer about QEMU. x86_64 packaging is a separate question
# and the answer to it is a CI job, not this.
exec docker run --rm "${tty[@]}" \
  --label "com.firetower.session=$session" \
  --shm-size=1g \
  -v "$desktop:/src:ro" \
  -v "$here/shots:/out" \
  -v ft-linux-cargo-registry:/usr/local/cargo/registry \
  -v ft-linux-target:/work/desktop/src-tauri/target \
  -v ft-linux-node-modules:/work/desktop/node_modules \
  -v ft-linux-pnpm-store:/pnpm-store \
  -e npm_config_store_dir=/pnpm-store \
  ${entry[@]+"${entry[@]}"} \
  "$image" ${args[@]+"${args[@]}"}

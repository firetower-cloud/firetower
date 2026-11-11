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

entry=()
args=("$@")
if [ "${1:-}" = "--shell" ]; then args=(); entry=(--entrypoint /bin/bash); fi

# A tty only if there is one to give. Without this the same script cannot be
# run by hand and from a job.
tty=(-i)
[ -t 0 ] && tty=(-it)

# arm64 on an Apple Silicon daemon, which is the native and therefore the
# honest choice for a render check: emulated x86_64 would make every "is the
# renderer blank" answer about QEMU. x86_64 packaging is a separate question
# and the answer to it is a CI job, not this.
exec docker run --rm "${tty[@]}" \
  --label "com.firetower.session=${FT_SESSION:-local}" \
  --shm-size=1g \
  -v "$desktop:/src:ro" \
  -v "$here/shots:/out" \
  -v ft-linux-cargo-registry:/usr/local/cargo/registry \
  -v ft-linux-target:/work/desktop/src-tauri/target \
  -v ft-linux-node-modules:/work/desktop/node_modules \
  -v ft-linux-pnpm-store:/pnpm-store \
  -e npm_config_store_dir=/pnpm-store \
  "${entry[@]}" \
  "$image" ${args[@]+"${args[@]}"}

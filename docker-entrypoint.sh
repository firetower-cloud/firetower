#!/bin/sh
# Start the Docker daemon, then hand over to whatever this container was asked
# to run.
#
# ## Why this exists rather than the worker supervising dockerd
#
# `firetower-worker --stdio` is one process per control-plane connection — see
# `DockerTransport::connect`, which runs it under `docker exec` with
# `kill_on_drop`. It dies whenever the control plane disconnects, which is the
# ordinary case this whole design is built to survive; it is why agents run
# under tmux rather than as children of the worker.
#
# A daemon parented to that process would be killed on every reconnect, taking
# every running compose stack with it. So it belongs to the container, like
# tmux does. The worker reports its state instead of owning it, which is the
# part that actually wanted knowing — see `docker_state` in ft-worker.
#
# ## Failure is not fatal, deliberately
#
# Every exit path here reaches `exec "$@"`. A worker that cannot run a daemon
# still has to serve terminals, git and agents, and those are worth far more
# than Docker is. What a failure must not do is be silent: the log stays at
# DAEMON_LOG for the worker to read and put in front of somebody.
#
# **No `set -e`, and that is the reason.** This script stands between the
# container and its command, so a non-zero exit anywhere in it is a worker that
# does not start at all — no terminals, no git, no agents, over something as
# small as an unwritable log directory. Every step below either cannot fail or
# says what it will do when it does. `set -u` stays: an unset variable here is
# a typo in this file, not a condition of the machine.

set -u

DAEMON_LOG=/var/log/firetower/dockerd.log
# `|| :` throughout. If this fails, the redirections below fail too and the
# daemon still starts — losing the log is worth less than losing the worker.
mkdir -p "$(dirname "$DAEMON_LOG")" 2>/dev/null || :

# Set by container.rs when it did not create this container privileged. There
# is no point starting a daemon that cannot work, and the failure it would
# leave in the log looks like a bug rather than a choice somebody made.
if [ "${FIRETOWER_WORKER_DOCKER:-}" = "off" ]; then
    echo "firetower: Docker is turned off for this worker (FIRETOWER_WORKER_DOCKER=off)" \
        | tee "$DAEMON_LOG"
    exec "$@"
fi

if ! command -v dockerd >/dev/null 2>&1; then
    echo "firetower: no dockerd in this image; sessions here have no Docker" \
        | tee "$DAEMON_LOG"
    exec "$@"
fi

# Already running, because this container was restarted rather than created.
if [ -S /var/run/docker.sock ] && docker info >/dev/null 2>&1; then
    exec "$@"
fi

# Whether this container was given the privileges a daemon needs.
#
# **What this prevents is a wrong diagnosis, not a failure.** Without
# `--privileged` dockerd starts, logs two hundred cheerful lines about loading
# plugins, and then dies registering its bridge driver with `iptables ...
# Permission denied (you must be root)`. A session sees "cannot connect to the
# Docker daemon"; whoever reads the log sees an iptables error, and iptables
# errors read as a firewall problem on the host rather than as a missing flag
# on the `docker run` that created this container.
#
# Both capabilities are checked because fixing either one alone still leaves a
# broken worker: CAP_NET_ADMIN is what the bridge and its NAT chain need, and
# CAP_SYS_ADMIN is what mounting an image's layers needs. A container missing
# them was created without `--privileged` — by a CLI too old to pass it, most
# likely — and the fix is on the machine outside this one.
#
# **Fails open.** An unreadable or unparseable `CapEff` is not evidence of
# anything, and declining to start a daemon that would have worked is a worse
# outcome than the log line this check exists to improve.
#
# `CapEff` is a 64-bit mask in hex; CAP_SYS_ADMIN is bit 21 and CAP_NET_ADMIN
# is bit 12. `$((0x...))` is arithmetic every POSIX shell has, which is why
# this needs neither capsh nor python — neither is in the image.
caps=$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status 2>/dev/null)
case "$caps" in
    # Empty, or something that is not a hex number. Treated as "we do not
    # know", which starts the daemon exactly as before.
    '' | *[!0-9A-Fa-f]*) caps='' ;;
esac

if [ -n "$caps" ] &&
    { [ "$(((0x$caps >> 21) & 1))" -eq 0 ] || [ "$(((0x$caps >> 12) & 1))" -eq 0 ]; }; then
    # Two lines, and the second one says everything. The worker reports the
    # *last* complaint in this file as the reason Docker is not running — see
    # `why_not` in ft-worker — so the line that has to stand on its own is the
    # one at the bottom.
    {
        echo "firetower: Docker cannot run here: this container was created without --privileged."
        echo "firetower: dockerd needs CAP_SYS_ADMIN to mount image layers and CAP_NET_ADMIN to create its bridge, and this container has neither. Recreate it with \`firetower worker upgrade\` to get a worker that can run Docker."
    } | tee "$DAEMON_LOG"
    exec "$@"
fi

# The packet size of the network this container is on.
#
# **The failure this prevents has no error message.** dockerd gives its bridge
# an MTU of 1500 whatever it is running on. Where the outer network is smaller
# — a cloud VPC at 1450, a VPN, most overlay networks — a nested container's
# large packets are silently dropped, and what somebody sees is `docker pull`
# hanging forever at "Downloading" with no failure and nothing in any log.
#
# Read from the interface holding the default route, which is the one the
# nested bridge will actually egress through.
#
# From /proc rather than from `ip`: iproute2 is not in debian-slim, and adding
# a package so that one number can be read would be a poor trade. A default
# route is the row in /proc/net/route whose destination is all zeroes, and its
# interface's MTU is a file.
outer_mtu=''
while read -r iface dest _rest; do
    [ "$dest" = "00000000" ] || continue
    [ -r "/sys/class/net/$iface/mtu" ] || continue
    read -r outer_mtu < "/sys/class/net/$iface/mtu"
    break
done < /proc/net/route

daemon_args="--host=unix:///var/run/docker.sock"
case "$outer_mtu" in
    # Unreadable or not a number. The daemon's own default is no worse than a
    # guess, and a bad `--mtu` would stop it starting at all.
    ''|*[!0-9]*) outer_mtu='' ;;
    *) daemon_args="$daemon_args --mtu=$outer_mtu" ;;
esac

# cgroup v2 delegation. A privileged container gets `/sys/fs/cgroup` writable
# and the daemon sorts itself out; this only covers the older hosts where the
# controllers have to be handed down explicitly before containerd will start.
if [ -f /sys/fs/cgroup/cgroup.controllers ] && [ -w /sys/fs/cgroup ]; then
    mkdir -p /sys/fs/cgroup/init
    # Best effort throughout: a host where this is unnecessary refuses it, and
    # that refusal is not a reason to stop.
    xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
    sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers \
        > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
fi

echo "firetower: starting dockerd${outer_mtu:+ (mtu $outer_mtu)}" > "$DAEMON_LOG"
# shellcheck disable=SC2086 # deliberately split: these are separate arguments
dockerd $daemon_args >> "$DAEMON_LOG" 2>&1 &

# Waited for here rather than left for the first session to discover.
#
# A session that runs `docker compose up` a second after starting would
# otherwise meet "cannot connect to the daemon" from a daemon that was three
# hundred milliseconds from being ready. Thirty seconds is long enough for a
# cold start on a slow disk and short enough that a daemon which is never
# coming up does not hold the container's own start-up open.
i=0
while [ "$i" -lt 60 ]; do
    if docker info >/dev/null 2>&1; then
        echo "firetower: dockerd ready" >> "$DAEMON_LOG"
        break
    fi
    i=$((i + 1))
    sleep 0.5
done

if ! docker info >/dev/null 2>&1; then
    # Said here as well as logged, because this is the one line that appears in
    # `docker logs` on the machine, where somebody looking for it will be.
    echo "firetower: dockerd did not come up; sessions here have no Docker." >&2
    echo "firetower: see $DAEMON_LOG inside this container for why." >&2
fi

# The container's real command, as pid 1's child — `sleep infinity` today.
exec "$@"

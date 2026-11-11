#!/bin/sh
# This machine, coming up.
#
# The host keys are made here rather than in the image, so that no two
# machines built from it share a private key — and into /etc/ssh/keys, which
# is a volume, so that the same container stopped and started again is the
# same machine to anything holding a known_hosts entry for it. That is what a
# reboot is, and the control plane's `StrictHostKeyChecking=accept-new` would
# refuse it otherwise.
set -eu

for kind in ed25519 rsa; do
    key="/etc/ssh/keys/ssh_host_${kind}_key"
    if [ ! -f "$key" ]; then
        echo "worker-sim: making this machine's $kind host key"
        ssh-keygen -q -t "$kind" -N "" -f "$key"
    fi
done
chmod 600 /etc/ssh/keys/ssh_host_*_key

# `exec`, so sshd is pid 1 and `docker kill` reaches it rather than this shell.
exec /usr/sbin/sshd -D -e

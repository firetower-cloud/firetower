# A machine Firetower can be given, with nothing on it that a real one would
# not have.
#
# What a worker needs is in `install/worker.sh`: git, tmux, a POSIX shell, curl,
# tar — and an sshd, because that is how Firetower reaches it. They are all
# installed here so that `--skip-packages` has nothing to report, which is the
# flag the control plane itself uses: it does not run sudo on anybody's machine.
#
# No worker binary. `run.sh up` installs one built from the checkout you are
# testing, through the same `install/worker.sh --from -` that "Install the
# worker" runs over ssh.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        openssh-server git tmux curl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

# An ordinary account, because that is what a worker runs as: the binary lives
# in its home and Firetower connects as it. Not root — `install/worker.sh`
# refuses sudo, and a worker with root is not the thing being tested.
RUN useradd --create-home --shell /bin/bash firetower

# Keys only. There is no password on this account and nothing should be able to
# guess its way in even on a container network.
#
# The host keys live under /etc/ssh/keys, which is a volume: see the entrypoint
# below for why they are not made here.
RUN mkdir -p /run/sshd /etc/ssh/keys /home/firetower/.ssh \
    && chown firetower:firetower /home/firetower/.ssh \
    && chmod 700 /home/firetower/.ssh \
    && printf '%s\n' \
        'PasswordAuthentication no' \
        'PermitRootLogin no' \
        'PubkeyAuthentication yes' \
        'AcceptEnv LANG LC_*' \
        'HostKey /etc/ssh/keys/ssh_host_ed25519_key' \
        'HostKey /etc/ssh/keys/ssh_host_rsa_key' \
        > /etc/ssh/sshd_config.d/worker-sim.conf

# This machine's identity, made the first time it starts and kept on a volume
# after that.
#
# **Not `RUN ssh-keygen -A`.** A host key baked into an image is a private key
# every container built from it shares and anybody holding the image has — and
# an image like this one gets copied around and rebuilt from a cache. Made at
# start-up instead, into a volume, which is also what keeps the two properties
# this harness needs: a `docker kill` and `docker start` is the *same* machine,
# because the keys are still there, and `StrictHostKeyChecking=accept-new` on
# the control plane does not refuse it; a container recreated from scratch is
# genuinely a new one and says so.
COPY start.sh /usr/local/bin/worker-sim-start
RUN chmod 755 /usr/local/bin/worker-sim-start

EXPOSE 22
# In the foreground as PID 1, so `docker kill` is the power cut it claims to be.
CMD ["/usr/local/bin/worker-sim-start"]

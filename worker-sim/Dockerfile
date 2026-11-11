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
RUN mkdir -p /run/sshd /home/firetower/.ssh \
    && chown firetower:firetower /home/firetower/.ssh \
    && chmod 700 /home/firetower/.ssh \
    && printf '%s\n' \
        'PasswordAuthentication no' \
        'PermitRootLogin no' \
        'PubkeyAuthentication yes' \
        'AcceptEnv LANG LC_*' \
        > /etc/ssh/sshd_config.d/worker-sim.conf

# Host keys are made at build time, so a restart is the same machine as far as
# `StrictHostKeyChecking=accept-new` is concerned — which is what a reboot is.
RUN ssh-keygen -A

EXPOSE 22
# In the foreground as PID 1, so `docker kill` is the power cut it claims to be.
CMD ["/usr/sbin/sshd", "-D", "-e"]

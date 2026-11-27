# The control plane, as a thing a stranger can run.
#
# One image, one port. The interface is compiled into the binary rather than
# served beside it, so there is no Node process here, no second container to
# version in step, and no reverse proxy needed to make two origins look like
# one. See crates/ft-server/src/web.rs.
#
# **It runs no agents.** It used to: the control plane could spawn a worker as
# a child of its own process, which put an agent in here as the same user, with
# this container's filesystem, its environment, and the database credentials,
# root key and updater token in it. That is gone, and so are the packages it
# needed — git, tmux and Node. Agents run on machines added over ssh.
#
# What is left is what the control plane itself shells out to: `ssh` to reach a
# machine (transport.rs), `sh` through it, `ssh-keygen` for its own key pair
# (sshkey.rs), and `curl` at build time for the worker tarballs below.

# The interface first, because the Rust build embeds its output. There are two
# bundles of it and the binary carries both: the application at the root address
# and the administration site beside it. A binary built with only one serves
# neither and says which is missing, so neither of these stages is optional —
# see crates/ft-server/src/web.rs.
#
# Both are pinned to the machine doing the building: they produce JavaScript,
# which is the same bytes whatever it was built on, and emulating them under
# QEMU for a foreign architecture would cost minutes for nothing.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS renderer
WORKDIR /desktop

# Pinned explicitly, where the stage below reads a pin out of
# `web/package.json`. `desktop/package.json` carries no `packageManager` field,
# so corepack would otherwise activate whatever its own default happens to be on
# this base image — a version number nothing else that touches this tree uses.
# 11 is what .github/workflows/desktop.yml installs for the same lockfile.
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

# The lockfile alone first, so changing a component does not re-install
# everything.
COPY desktop/package.json desktop/pnpm-lock.yaml desktop/pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

# Only what Vite reads. The Tauri shell is a sibling of these and is not built
# here — this image has no native window to put it in, and its Rust crate would
# pull a second toolchain into a stage that exists to produce JavaScript.
COPY desktop/index.html desktop/vite.config.ts desktop/tsconfig*.json ./
COPY desktop/src ./src
COPY desktop/public ./public
RUN pnpm build

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
WORKDIR /web

RUN corepack enable

# The lockfile alone first, so changing a component does not re-install
# everything.
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

COPY web/ ./
RUN pnpm build

# Cross-compiled, not emulated — the same arrangement as Dockerfile.worker, and
# for the same reason: an arm64 image should be compiled at full speed on an
# amd64 runner.
FROM --platform=$BUILDPLATFORM rust:1-bookworm AS build
WORKDIR /src

ARG BUILDARCH
ARG TARGETARCH

RUN if [ "$BUILDARCH" != "$TARGETARCH" ]; then \
        apt-get update && case "$TARGETARCH" in \
            amd64) apt-get install -y --no-install-recommends \
                       gcc-x86-64-linux-gnu libc6-dev-amd64-cross ;; \
            arm64) apt-get install -y --no-install-recommends \
                       gcc-aarch64-linux-gnu libc6-dev-arm64-cross ;; \
            *) echo "no cross toolchain known for $TARGETARCH" >&2; exit 1 ;; \
        esac && rm -rf /var/lib/apt/lists/*; \
    fi

RUN case "$TARGETARCH" in \
        amd64) echo x86_64-unknown-linux-gnu  > /target ;; \
        arm64) echo aarch64-unknown-linux-gnu > /target ;; \
        *) echo "no Rust target known for $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && rustup target add "$(cat /target)"

ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc
ENV CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY migrations ./migrations
# Embedded in the control plane: the worker installer it runs over ssh.
COPY install ./install

# Where the two previous stages left the interface. rust-embed reads these at
# compile time, so they have to be in place before cargo runs rather than copied
# in after.
COPY --from=renderer /desktop/dist ./desktop/dist
COPY --from=web /web/out ./web/out

RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    # Only this binary. The package also builds `firetower-worker`, which
    # belongs on a machine rather than in here: nothing in this image runs a
    # worker.
    cargo build --release -p ft-cli --bin firetower --target "$(cat /target)" \
    && cp "target/$(cat /target)/release/firetower" /firetower

FROM debian:bookworm-slim

# openssh-client because a machine is reached by ssh-ing to it,
# ca-certificates because that and everything else is over TLS, and curl for
# the worker tarballs fetched below.
#
# **No git, no tmux, no Node.** They were here because an agent could run in
# this container: git to clone, tmux so it outlived the connection that started
# it, Node to fetch and run it. They are what a *machine* needs, which is why
# `host_readiness` asks a machine for them, and nothing in this image shells
# out to any of the three. (`vault.rs`'s `GIT` is the name of a credential
# scope, not a binary.)
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssh-client ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /firetower /usr/local/bin/firetower

# The worker this control plane installs onto machines: the tarballs released
# with this version, for every shape a machine can be. Streamed down the ssh
# connection by "Install the worker", so a machine never has to reach GitHub
# and the worker a control plane installs is the one it was released with.
#
# Best effort. A development build (`VERSION` unset, or a version with no
# release yet) has none, and the installer then downloads as it would for
# anybody — the directory is simply empty.
ARG VERSION=0.0.0-dev
ENV FIRETOWER_WORKER_ARTIFACTS=/usr/share/firetower/workers
RUN mkdir -p "$FIRETOWER_WORKER_ARTIFACTS" \
    && for shape in darwin-arm64 darwin-x86_64 linux-x86_64 linux-arm64; do \
        asset="firetower-worker-$shape.tar.gz"; \
        curl -fsSL --retry 3 -o "$FIRETOWER_WORKER_ARTIFACTS/$asset" \
            "https://github.com/firetower-cloud/firetower/releases/download/firetower-v$VERSION/$asset" \
        || { rm -f "$FIRETOWER_WORKER_ARTIFACTS/$asset"; echo "no released worker for $shape at $VERSION; machines will download"; }; \
    done \
    && ls -la "$FIRETOWER_WORKER_ARTIFACTS"

# The root key, the token, and anything else this install owns. A volume in the
# compose file: losing it means every stored credential has to be added again.
ENV FIRETOWER_HOME=/var/lib/firetower
RUN mkdir -p "$FIRETOWER_HOME"
VOLUME /var/lib/firetower

# A home on the volume rather than under the container's own root, which is
# thrown away every time this image is upgraded.
#
# Nothing runs an agent in here any more, so this is the control plane's own:
# where ssh keeps what it is given and where anything else that wants `$HOME`
# finds one that outlives the container.
ENV HOME=/var/lib/firetower/home
RUN mkdir -p "$HOME"

# A container that only listened on loopback would be reachable by nothing.
# Firetower refuses to bind this without authentication configured, so the two
# settings belong next to each other.
ENV FIRETOWER_BIND=0.0.0.0
ENV FIRETOWER_PORT=4400

# So the control plane knows its filesystem is not the operator's.
#
# It matters for one message: a key path is read in here, and `~/.ssh/id_ed25519`
# names a file that exists on their machine and not in this one. Saying "no such
# file" alone sends them to check the wrong filesystem.
#
# Set from the image rather than sniffed from `/.dockerenv`, so it is a fact
# about how this was built instead of a guess about where it is running.
ENV FIRETOWER_CONTAINER=1

EXPOSE 4400

ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.title="Firetower" \
      org.opencontainers.image.description="Run any coding agent, on your own servers, from anywhere." \
      org.opencontainers.image.source="https://github.com/firetower-cloud/firetower" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

# `/readyz` rather than `/healthz`: a control plane that cannot reach its
# database is up and useless, and compose should wait for the second thing.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
    CMD ["/usr/local/bin/firetower", "healthcheck"]

ENTRYPOINT ["/usr/local/bin/firetower"]
CMD ["serve"]

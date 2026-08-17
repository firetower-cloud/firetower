# The control plane, as a thing a stranger can run.
#
# One image, one port. The interface is compiled into the binary rather than
# served beside it, so there is no Node process here, no second container to
# version in step, and no reverse proxy needed to make two origins look like
# one. See crates/ft-server/src/web.rs.
#
# It can also run sessions itself, exactly as `just dev` does on a laptop: the
# control plane spawns `firetower worker --stdio` as a child process, and
# `localhost` is a real host in the fleet. That is why git, tmux, Node and an
# agent are installed below.
#
# The trade that makes is the same one a workstation already makes — an agent
# running as the same user, able to read the root key. Firetower has always
# treated `localhost` as a real host rather than a special case, and a
# container is no different. Keep them apart by adding a second machine over
# ssh, which needs nothing from this image.

# The interface first, because the Rust build embeds its output.
#
# Pinned to the machine doing the building: this stage produces JavaScript,
# which is the same bytes whatever it was built on, and emulating it under QEMU
# for a foreign architecture would cost minutes for nothing.
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

# Where the previous stage left the interface. rust-embed reads this at compile
# time, so it has to be in place before cargo runs rather than copied in after.
COPY --from=web /web/out ./web/out

RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release -p ft-cli --target "$(cat /target)" \
    && cp "target/$(cat /target)/release/firetower" /firetower

FROM debian:bookworm-slim

# git for repositories, tmux so an agent outlives the connection that started
# it, openssh-client because a server is reached by ssh-ing to it, and
# ca-certificates because all of that is over TLS.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git tmux openssh-client ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# An agent, so this is somewhere work can actually run rather than only a place
# to watch it from. Node is here for the agent, not for Firetower — the
# interface is already inside the binary.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /firetower /usr/local/bin/firetower

# The root key, the token, and anything else this install owns. A volume in the
# compose file: losing it means every stored credential has to be added again.
ENV FIRETOWER_HOME=/var/lib/firetower
RUN mkdir -p "$FIRETOWER_HOME"
VOLUME /var/lib/firetower

# A container that only listened on loopback would be reachable by nothing.
# Firetower refuses to bind this without authentication configured, so the two
# settings belong next to each other.
ENV FIRETOWER_BIND=0.0.0.0
ENV FIRETOWER_PORT=4400

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

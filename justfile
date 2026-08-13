# Firetower — every command anyone needs.
# `just doctor` first if something looks wrong.

_default:
    @just --list

# Check you have the tools, before a missing one surfaces as a confusing error.
doctor:
    #!/usr/bin/env bash
    missing=0
    check() {
        if command -v "$1" >/dev/null 2>&1; then
            printf '  ok       %-12s %s\n' "$1" "$(${2:-true} 2>/dev/null | head -1)"
        else
            printf '  MISSING  %-12s %s\n' "$1" "$3"; missing=1
        fi
    }
    echo
    check cargo       "cargo --version"       "https://rustup.rs"
    check git         "git --version"         "install git"
    check tmux        "tmux -V"               "brew install tmux"
    check node        "node --version"        "brew install node"
    check pnpm        "pnpm --version"        "brew install pnpm"
    check cargo-watch "cargo-watch --version" "cargo install cargo-watch"
    echo
    [ $missing -eq 0 ] || { echo "  Install what's missing, then run just doctor again."; exit 1; }
    echo "  Everything's here. Run: just setup"

# Install dependencies. Once, after cloning.
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm --dir web install
    cargo fetch
    # Never clobbers an existing one — this is the only place your client id lives.
    if [ ! -f .env ]; then
        cp .env.example .env
        echo "  wrote .env — see 'Connecting repositories' in the README"
    fi

# Control plane and web application, both with reload.
#
# Whichever half exits first takes the other down, so a crash is visible
# immediately rather than leaving you with half a running system and the error
# scrolled off the top. Only our own children are killed — `kill 0` would take
# the calling shell with it.
dev:
    #!/usr/bin/env bash
    set -uo pipefail
    pids=()
    cleanup() {
        trap - EXIT INT TERM
        for pid in "${pids[@]:-}"; do
            [ -n "$pid" ] || continue
            pkill -P "$pid" 2>/dev/null || true   # the wrapper's own child
            kill "$pid" 2>/dev/null || true
        done
    }
    trap cleanup EXIT INT TERM

    cargo watch -x 'run -p ft-cli -- serve --dev' & pids+=($!)
    NEXT_PUBLIC_FIRETOWER_API=http://localhost:4400 pnpm --dir web dev & pids+=($!)

    # `wait -n` would be tidier but needs bash 4.3, and macOS ships 3.2.
    # Polling is portable and a second of latency is irrelevant here.
    while :; do
        for pid in "${pids[@]}"; do
            kill -0 "$pid" 2>/dev/null || exit 1
        done
        sleep 1
    done

# Rust types -> contract -> typed client. No pipeline, just this.
gen:
    cargo run --quiet -p ft-server --bin gen-openapi
    cd web && pnpm orval && pnpm tsc --noEmit

# Fails if the committed contract is stale. What a CI job would run.
gen-check: gen
    git diff --exit-code api/ web/src/api/generated

# The release artifact. Web first: the Rust build embeds its output.
build:
    pnpm --dir web build
    cargo build --release

# The small static binary that gets copied to a host.
build-worker:
    cargo build --release --no-default-features --target x86_64-unknown-linux-musl

test:
    cargo test --workspace
    cd web && pnpm tsc --noEmit

lint:
    cargo clippy --workspace --all-targets -- -D warnings
    cargo fmt --check
    cd web && pnpm lint

# Start fresh. The control plane's database is a cache — it rebuilds from
# the workers on reconnect.
reset:
    rm -rf ~/.firetower/firetower.db*

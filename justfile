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
    check docker      "docker --version"      "https://docs.docker.com/get-docker"
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

# Start the database and wait until it will actually answer.
db:
    #!/usr/bin/env bash
    set -euo pipefail
    docker compose up -d postgres
    printf '  waiting for postgres'
    for _ in $(seq 1 60); do
        if docker compose exec -T postgres pg_isready -q 2>/dev/null; then
            echo " — ready"
            exit 0
        fi
        printf '.'
        sleep 1
    done
    echo
    echo "  postgres did not come up. Try: docker compose logs postgres"
    exit 1

# Everything in containers, the way a server would run it.
up:
    docker compose --profile full up --build

# Control plane and web application, both with reload.
#
# Whichever half exits first takes the other down, so a crash is visible
# immediately rather than leaving you with half a running system and the error
# scrolled off the top. Only our own children are killed — `kill 0` would take
# the calling shell with it.
dev: db
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

# The image a container host runs. Slow the first time, cached after.
worker-image:
    docker build -f Dockerfile.worker --build-arg VERSION=dev -t firetower/worker:dev .

# Both architectures, the way the workflow builds them.
#
# Loads nothing: a manifest with two platforms in it can't live in a local image
# store. This is for finding out that the cross-compile broke here rather than
# in CI ten minutes later.
worker-image-check:
    docker buildx build -f Dockerfile.worker \
        --platform linux/amd64,linux/arm64 --build-arg VERSION=dev .

# The small static binary that gets copied to a host.
build-worker:
    cargo build --release --no-default-features --target x86_64-unknown-linux-musl

# The database tests need Postgres; `just db` is enough to satisfy them.
test: db
    cargo test --workspace
    cd web && pnpm tsc --noEmit

lint:
    cargo clippy --workspace --all-targets -- -D warnings
    cargo fmt --check
    cd web && pnpm lint
    just check-style

# Drop the schemas the tests leave behind.
#
# Each test that touches Postgres works in a schema of its own, and a run
# leaves one per test. They are swept by the next run that starts more than an
# hour later, so this is only for when you want the space back now — or when a
# tool you have pointed at the database is drowning in them.
db-clean:
    #!/usr/bin/env bash
    set -euo pipefail
    # One statement each, not one transaction: a thousand schemas in a single
    # transaction exhausts max_locks_per_transaction and rolls the lot back.
    docker compose exec -T postgres psql -U "${POSTGRES_USER:-firetower}" -d "${POSTGRES_DB:-firetower}" -tAc \
        "SELECT format('DROP SCHEMA %I CASCADE;', schema_name) FROM information_schema.schemata \
          WHERE schema_name LIKE 'test\_%' ESCAPE '\'" \
      | docker compose exec -T postgres psql -U "${POSTGRES_USER:-firetower}" -d "${POSTGRES_DB:-firetower}" -q
    echo "  swept. Reclaim the disk with: just db-vacuum"

# Give the space back to the filesystem. Only worth it after db-clean.
db-vacuum:
    docker compose exec -T postgres psql -U "${POSTGRES_USER:-firetower}" -d "${POSTGRES_DB:-firetower}" -c "VACUUM FULL;"

# Start fresh. The control plane's database is a cache — it rebuilds from
# the workers on reconnect.
reset:
    docker compose down -v
    rm -rf ~/.firetower/worker

# The design system, enforced. Sizes and colours belong in web/app/globals.css;
# written at the point of use they drift a half-pixel apart across twenty files
# and the app stops looking like one thing.
check-style:
    #!/usr/bin/env bash
    set -uo pipefail
    found=$(grep -rnE 'text-\[[0-9.]+px\]|rounded-\[[0-9]+px\]|(bg|text|border)-\[#[0-9a-fA-F]{3,8}\]' \
        web/app web/components web/src --include='*.tsx' || true)
    if [ -n "$found" ]; then
        echo "$found"
        echo
        echo "  Off the scale. Use a token from web/app/globals.css."
        exit 1
    fi
    echo "  On the scale."

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
    echo "  For the phone — only needed if you are working on mobile/:"
    check xcodebuild  "xcodebuild -version"   "Xcode, from the App Store"
    check pod         "pod --version"         "brew install cocoapods"
    check adb         "adb --version"         "Android Studio, or brew install --cask android-commandlinetools"
    echo
    [ $missing -eq 0 ] || { echo "  Install what's missing, then run just doctor again."; exit 1; }
    echo "  Everything's here. Run: just setup"

# Install dependencies. Once, after cloning.
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm --dir web install
    pnpm --dir mobile install
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

    # A worker built here is what "Install the worker" sends to a machine of
    # this shape, so a checkout can be tried on a real host without a release.
    FIRETOWER_WORKER_ARTIFACTS=target/artifacts cargo watch -x 'run -p ft-cli -- serve --dev' & pids+=($!)
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
#
# Two contracts: the control plane's, which all three clients are generated
# from, and the updater's, which nothing is generated from — both sides of it
# compile the same `ft-updater-api` crate — but which is written out so a
# change to it is a diff somebody reviews.
gen:
    cargo run --quiet -p ft-server --bin gen-openapi
    cargo run --quiet -p ft-updater --bin firetower-updater -- openapi > api/updater.json
    cd web && pnpm orval && pnpm tsc --noEmit
    cd desktop && pnpm orval && pnpm tsc --noEmit
    cd mobile && pnpm orval && pnpm tokens && pnpm tsc --noEmit

# Fails if the committed contract is stale. What a CI job would run.
gen-check: gen
    git diff --exit-code api/ web/src/api/generated desktop/src/api/generated mobile/src/api/generated mobile/src/design

# The release artifact. Web first: the Rust build embeds its output.
build:
    pnpm --dir web build
    cargo build --release

# The worker, packed the way a release publishes it, for this machine's shape.
#
# Lands in target/artifacts as firetower-worker-<os>-<arch>.tar.gz. A control
# plane started with FIRETOWER_WORKER_ARTIFACTS pointing there — `just dev`
# does — installs it onto a machine of the same shape instead of downloading a
# release, and `install/worker.sh --from <that file>` does the same by hand.
build-worker:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo build --release -p ft-cli --no-default-features --bin firetower-worker
    case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "unsupported: $(uname -s)" >&2; exit 1 ;; esac
    case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x86_64 ;; *) echo "unsupported: $(uname -m)" >&2; exit 1 ;; esac
    mkdir -p target/artifacts
    tar -czf "target/artifacts/firetower-worker-$os-$arch.tar.gz" -C target/release firetower-worker
    echo "  target/artifacts/firetower-worker-$os-$arch.tar.gz"

# The phone. `mobile-ios` and `mobile-android` build and install a dev client;
# `mobile` alone starts Metro for one that is already installed.
mobile:
    cd mobile && pnpm start

mobile-ios:
    cd mobile && pnpm ios

mobile-android:
    cd mobile && pnpm android

# The design tokens, from web/app/globals.css. Part of `just gen`; here on its
# own for when only a colour changed.
tokens:
    cd mobile && pnpm tokens

# The database tests need Postgres; `just db` is enough to satisfy them.
test: db
    cargo test --workspace
    cd web && pnpm tsc --noEmit
    cd desktop && pnpm tsc --noEmit && pnpm test
    cd mobile && pnpm tsc --noEmit && pnpm test

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

# Prove a session can actually run things. Run this *inside* a session.
#
# Everything here is a claim that cannot be checked from the machine hosting
# the worker: whether the daemon in this container works, whether a compose
# service is reachable on this container's loopback, and whether a preview
# reaches the same bytes. That last one is the one worth running — it is what
# distinguishes a daemon publishing ports into this network namespace from one
# publishing them somewhere the tunnel cannot see.
#
#   just session-check
#   PREVIEW_URL=https://<session>-8080-<sig>.<domain> just session-check
#
# The preview is skipped without a URL, because a session cannot derive its own
# — the hostname is signed by the control plane. Copy it from the session's
# preview for port 8080.
session-check:
    #!/usr/bin/env bash
    set -uo pipefail
    passed=0; failed=0; skipped=0
    ok()   { printf '  \033[32mok\033[0m       %s\n' "$1"; passed=$((passed+1)); }
    no()   { printf '  \033[31mFAILED\033[0m   %s\n' "$1"; failed=$((failed+1)); }
    skip() { printf '  skipped  %s\n' "$1"; skipped=$((skipped+1)); }
    try()  { if eval "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }

    work=$(mktemp -d)

    # A project of this check's own, not the session's.
    #
    # The session sets COMPOSE_PROJECT_NAME for everything it runs, so without
    # this the check would share a project with whatever the agent already has
    # up — and `compose down --remove-orphans` would then tear down that work,
    # because from this directory's compose file every one of its containers is
    # an orphan. Isolating also makes the teardown assertion below mean
    # something rather than counting somebody else's containers.
    export COMPOSE_PROJECT_NAME="ft-session-check-$$"

    # Whatever happens, this check does not leave a stack running.
    trap 'cd "$work" 2>/dev/null && docker compose down -v --remove-orphans >/dev/null 2>&1; rm -rf "$work"' EXIT

    echo
    echo "  Tools"
    for tool in docker just pnpm cargo git tmux node; do
        try "$tool" "command -v $tool"
    done

    echo
    echo "  Daemon"
    try "docker version"          "docker version"
    try "docker compose version"  "docker compose version"
    try "docker run hello-world"  "docker run --rm hello-world"

    echo
    echo "  A compose stack, reachable on this container's loopback"
    cd "$work"
    # printf rather than a heredoc: `just` dedents a recipe body, and YAML is
    # the one format where being dedented by four spaces is silent corruption.
    printf 'services:\n  web:\n    image: nginx:alpine\n    ports: ["8080:80"]\n' > compose.yaml
    if docker compose up -d >/dev/null 2>&1; then
        ok "docker compose up"
        if curl -sf --retry 15 --retry-delay 1 http://127.0.0.1:8080 2>/dev/null | grep -q nginx; then
            ok "127.0.0.1:8080 answers"
        else
            no "127.0.0.1:8080 answers"
        fi
    else
        no "docker compose up"
    fi

    echo
    echo "  The preview reaches the same bytes"
    if [ -z "${PREVIEW_URL:-}" ]; then
        skip "no PREVIEW_URL given — see the comment above this recipe"
    elif curl -sf --retry 5 --retry-delay 1 "$PREVIEW_URL" 2>/dev/null | grep -q nginx; then
        ok "$PREVIEW_URL"
    else
        no "$PREVIEW_URL — the daemon is publishing where the tunnel cannot see"
    fi

    echo
    echo "  Builds"
    printf 'FROM alpine\nRUN echo built\n' > Dockerfile
    try "docker build" "docker build -t ft-session-check ."

    echo
    echo "  Teardown leaves nothing"
    docker compose down -v --remove-orphans >/dev/null 2>&1
    left=$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" | wc -l)
    if [ "$left" -eq 0 ]; then ok "no containers left"; else no "$left container(s) left"; fi

    echo
    printf '  %d passed, %d failed, %d skipped\n\n' "$passed" "$failed" "$skipped"
    [ "$failed" -eq 0 ]

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
        web/app web/components web/src mobile/app mobile/src --include='*.tsx' || true)
    if [ -n "$found" ]; then
        echo "$found"
        echo
        echo "  Off the scale. Use a token from web/app/globals.css."
        exit 1
    fi
    echo "  On the scale."

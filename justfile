# Firetower — every command anyone needs.
# `just doctor` first if something looks wrong.

# Which Compose project the recipes here act on, passed as `-p` rather than
# left to compose to work out.
#
# Compose resolves a project name from COMPOSE_PROJECT_NAME *first* and the
# `name:` in compose.yaml only if that is unset — and inside a Firetower
# session COMPOSE_PROJECT_NAME is set, to `ft-<session id>`
# (`crates/ft-worker/src/lib.rs`, where the session's environment is built).
# So a bare `docker compose` in this file acts on whichever stack the shell
# happens to be in: inside a session, that session's own; outside one,
# whatever else answers to `firetower-dev`. `just reset` tearing down the
# session that ran it is the same bug as `just db` adopting its containers.
#
# The name is compose.yaml's, for the reasons written there. Override it for a
# second stack or a test, which is the one thing the environment must not be
# able to do by accident:
#
#   just project=firetower-scratch db
project := "firetower-dev"
compose := "docker compose -p " + project

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
    # The desktop client is a pnpm workspace of its own, and `just test` runs
    # its tests (`just gen` regenerates its client too). Without this a fresh
    # clone gets through setup and fails the first `just test` on a missing
    # node_modules — in the one command whose job is to leave nothing missing.
    pnpm --dir desktop install
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
    {{compose}} up -d postgres
    printf '  waiting for postgres'
    for _ in $(seq 1 60); do
        if {{compose}} exec -T postgres pg_isready -q 2>/dev/null; then
            echo " — ready"
            exit 0
        fi
        printf '.'
        sleep 1
    done
    echo
    echo "  postgres did not come up. Try: {{compose}} logs postgres"
    exit 1

# Everything in containers: the database and the development image, with reload.
#
# Published on 127.0.0.1, so the stack answers this machine and not the network
# around it. HOST_BIND in .env.example is how to change that on
# purpose, and says what it costs.
up:
    {{compose}} --profile full up --build

# Control plane and web application, both with reload. The database first.
dev: db _dev

# The same two processes, for somewhere the database is already running —
# `dev` above is this with `db` in front of it.
#
# The compose file runs this one: there `postgres` is a service beside the
# control plane and `depends_on` has waited for it, so starting it again would
# be `docker compose up -d postgres` from inside a container of that very
# stack — compose re-entering itself, which the development image has no
# docker client to even attempt. Underscored because it is the wrong thing to
# run by hand on a machine: the control plane would come up with nothing to
# connect to. Use `just dev`.
#
# Whichever half exits first takes the other down, so a crash is visible
# immediately rather than leaving you with half a running system and the error
# scrolled off the top. Only our own children are killed — `kill 0` would take
# the calling shell with it.
_dev:
    #!/usr/bin/env bash
    set -uo pipefail

    # The interface's dependencies, if nothing has installed them yet. On a
    # machine that is `just setup`'s job and this costs one directory check;
    # in the compose stack web/node_modules is a volume of its own, which
    # starts empty, and nothing else there would ever fill it.
    #
    # `cd` rather than `--dir`, because pnpm's own version is pinned in
    # web/package.json and a pnpm that came from corepack resolves that pin
    # from the working directory instead of from `--dir`. Run from the
    # repository root — which has no package.json — it fetches its own newest
    # pnpm and then refuses to use it on `web/`.
    if [ ! -d web/node_modules ]; then
        (cd web && pnpm install) || exit 1
    fi

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
    # The API's address lives in web/.env.development, committed, so that one
    # file answers it wherever the interface runs — and so that an environment
    # variable can override it, which is what the compose stack needs: there
    # the browser is on the host and the control plane behind a published port.
    #
    # `cd` for the reason above, and `exec` so that this is still one process
    # rather than a subshell holding one: the cleanup reaps `$!` and its
    # children, and a layer in between would leave the dev server running.
    (cd web && exec pnpm dev) & pids+=($!)

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

# Fails if the committed contract is stale. Mirrored by the `contract` workflow,
# which runs the same script so a local verdict and a CI verdict agree.
gen-check: gen
    .github/scripts/same-orval.sh
    .github/scripts/unchanged.sh api/ web/src/api/generated desktop/src/api/generated mobile/src/api/generated mobile/src/design

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
    {{compose}} exec -T postgres psql -U "${POSTGRES_USER:-firetower}" -d "${POSTGRES_DB:-firetower}" -tAc \
        "SELECT format('DROP SCHEMA %I CASCADE;', schema_name) FROM information_schema.schemata \
          WHERE schema_name LIKE 'test\_%' ESCAPE '\'" \
      | {{compose}} exec -T postgres psql -U "${POSTGRES_USER:-firetower}" -d "${POSTGRES_DB:-firetower}" -q
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
    {{compose}} exec -T postgres psql -U "${POSTGRES_USER:-firetower}" -d "${POSTGRES_DB:-firetower}" -c "VACUUM FULL;"

# Start fresh.
#
# The database is a cache and nothing else — it rebuilds from the workers on
# reconnect — so this is the cheap, recoverable way back to a clean slate, and
# almost always the one you want. It is also the whole of what this recipe
# does: worker state is `just worker-wipe`, a different kind of operation,
# which is where the warning lives.
#
# The last line of each of these comments is the only one `just --list` shows,
# so for these two it is the summary and not the tail of the paragraph.
#
# Drop the control plane's database and bring it back empty.
reset: && db
    {{compose}} down -v

# Wipe this machine's worker state: its clones, every session's worktree, the
# event log, the installed binary.
#
# **Not the other half of `just reset`.** Nothing under the worker root is a
# cache of anything — a worktree holds the only copy of whatever has not been
# pushed yet — and on a machine that is also a worker host, which CONTRIBUTING
# recommends, that is every session running here and not only yours. One
# laptop measured 47 live worktrees and 54GB when #339 was filed, and 60 and
# 80GB when this was written a few hours later — it grows while you read it.
#
# So it refuses while any worktree is still on disk, and refuses *first*,
# before anything is removed. There is deliberately no flag that overrides it,
# and the refusal deliberately prints no destructive command either — not even
# the one a person would run by hand. An agent is the likeliest caller here,
# and an agent treats a runnable line in an error as an instruction, so a
# printed `rm -rf` would be the `--force` flag again through a channel that is
# easier to act on than argv. It names the directory and says it has to be
# removed by hand; reconstructing the command is a person's deliberate act.
#
# FIRETOWER_WORKER_ROOT picks the root, the same variable and the same default
# as install/worker.sh, so this wipes the root the worker here actually uses.
#
# DESTRUCTIVE — every session's worktree on this machine. Refuses while any is live; `just reset` is the clean slate you want.
worker-wipe:
    #!/usr/bin/env bash
    set -euo pipefail

    root="${FIRETOWER_WORKER_ROOT:-$HOME/.firetower/worker}"

    if [ ! -d "$root" ]; then
        echo "  $root does not exist — nothing to wipe."
        exit 0
    fi

    # The guard, above every destructive line in this recipe rather than below
    # one of them. The version this replaced ran `docker compose down -v`
    # first, so a check added anywhere further down would have fired with the
    # database already gone — refusing after the irreversible half is not
    # refusing.
    live=0
    if [ -d "$root/worktrees" ]; then
        live=$(find "$root/worktrees" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')
    fi

    if [ "$live" -ne 0 ]; then
        # `du` on 80GB of worktrees takes a moment, and it is the number that
        # makes the refusal land, so it is worth the wait.
        size=$(du -sh "$root" 2>/dev/null | cut -f1 | tr -d '[:space:]')
        exec >&2
        echo
        echo "  Refusing — $root is a live worker root."
        echo
        echo "      $live live session worktree(s) in $root/worktrees"
        echo "      $size on disk"
        echo
        echo "  This machine hosts Firetower sessions, so that directory is not"
        echo "  scratch. It holds the working tree of every session running here,"
        echo "  uncommitted work and all. None of it comes back from upstream and"
        echo "  not all of it is yours to lose."
        echo
        # Checked rather than guessed, and the most useful line here when it
        # fires: #339 was found by an agent that was itself running inside this
        # directory, which is the case a warning about "live worktrees" is
        # easiest to read past.
        case "$PWD/" in
            "$root"/*)
                echo "  You are standing in it, so this would delete the working tree"
                echo "  you are running in, mid-command:"
                echo
                echo "      $PWD"
                echo
                ;;
        esac
        echo "  If you wanted a clean slate, you wanted the database:"
        echo
        echo "      just reset"
        echo
        echo "  If you really are decommissioning the worker on this machine: end"
        echo "  those sessions first — their worktrees go with them — and run this"
        echo "  again. That is the supported route and it leaves nothing behind."
        echo
        echo "  Short of that, the directory above has to be removed by hand, by"
        echo "  somebody who has looked at what is in it."
        echo
        echo "  This recipe prints no command for that and takes no flag that"
        echo "  overrides it. Both on purpose: an argument that can be passed is one"
        echo "  an agent will pass, and a destructive line printed in an error is one"
        echo "  an agent will read as an instruction and run. What it would cost is"
        echo "  every unpushed commit on this machine, most of it somebody else's."
        echo "  See #339."
        echo
        exit 1
    fi

    rm -rf "$root"
    echo "  wiped $root"

# The design system, enforced. Sizes and colours belong in web/app/globals.css;
# written at the point of use they drift a half-pixel apart across twenty files
# and the app stops looking like one thing.
check-style:
    #!/usr/bin/env bash
    set -uo pipefail
    # `fontSize: 11.5` is the same offence as `text-[11.5px]` and it is the
    # one that got through: the file tree and the diff carried their own sizes
    # for months, so a phone-wide type scale went up around them and left the
    # two screens made entirely of text exactly as small as they were.
    #
    # `desktop/src` was missing from this list until the redesign, which is why
    # it had nine of these in it — including the two screens made entirely of
    # text, again.
    #
    found=$(grep -rnE 'text-\[[0-9.]+px\]|rounded-\[[0-9]+px\]|(bg|text|border)-\[#[0-9a-fA-F]{3,8}\]|fontSize: *[0-9]' \
        web/app web/components web/src mobile/app mobile/src desktop/src --include='*.tsx' || true)
    # A colour written into a `style` prop is the same offence, and the regex
    # above structurally could not see it: it only ever looked for `#rrggbb`
    # inside a Tailwind arbitrary value. So `backgroundColor: "rgba(0,0,0,0.45)"`
    # sailed through — which is how a hard-coded *dark* scrim survived into the
    # light theme in `mobile/app/workspace/[id].tsx`, beside four call sites
    # that correctly read `color.scrim`. A check that cannot catch a literal in
    # the position people actually write it is not a check.
    #
    # Anchored to the properties that take a colour, which is what keeps it
    # honest: `shadowColor: "#000"` is idiomatic React Native and stays legal,
    # because the shadow tokens are CSS strings a native shadow cannot read.
    # `mobile/` only for now — `desktop/src` has pre-existing literals of this
    # shape and widening the net is its own change, not this one's.
    tint='(backgroundColor|borderColor|borderTopColor|borderBottomColor|borderLeftColor|borderRightColor|tintColor|placeholderTextColor|underlayColor|fill|stroke)'
    painted=$(grep -rnE "$tint: *\"(#|rgba?\(|hsla?\()" mobile/app mobile/src --include='*.tsx' || true)
    if [ -n "$painted" ]; then
        found="$found$painted"
    fi
    if [ -n "$found" ]; then
        echo "$found"
        echo
        echo "  Off the scale. Use a token from web/app/globals.css."
        exit 1
    fi
    # And the sheet itself is in two places, because the desk compiles its own
    # Tailwind and cannot import the web app's. They used to drift — the desk's
    # copy was missing `--color-amber`, so `text-amber` in `config/Skills.tsx`
    # resolved to nothing and the *needs review* tag had no colour at all. One
    # file is the source; the other is a copy and has to prove it.
    if ! diff -q web/app/globals.css desktop/src/globals.css >/dev/null; then
        diff -u web/app/globals.css desktop/src/globals.css | head -40
        echo
        echo "  desktop/src/globals.css has drifted. Copy web/app/globals.css over it;"
        echo "  anything the desk alone needs belongs in desktop/src/styles.css."
        exit 1
    fi
    echo "  On the scale."

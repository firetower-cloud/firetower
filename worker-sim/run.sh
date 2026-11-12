#!/usr/bin/env bash
#
# A Linux worker in a container, and the ways to break it.
#
#   ./worker-sim/run.sh up                      the stack, up and registered
#   ./worker-sim/run.sh kill worker             a power cut
#   ./worker-sim/run.sh start worker            the reboot
#   ./worker-sim/run.sh restart-worker worker   the worker process only
#   ./worker-sim/run.sh down                    take it away
#
# `docs/worker-sim.md` is the whole of it: what each command simulates, what
# this cannot simulate, and how to get a browser onto the control plane it
# starts.
#
# ── Why this is written so defensively ───────────────────────────────────────
#
# It is run on machines that are themselves live Firetower workers, where the
# host's tmux server is holding somebody's real work and the host's
# `firetower-worker` is serving it. A command that widens by one character —
# a label filter that matches another project, a `kill` with no target, a
# `compose down` that resolves to the wrong project — does not fail loudly: it
# takes the fleet down, and with it the channel anybody would use to say stop.
#
# So, as behaviour rather than as convention:
#
#   * the Compose project is hardcoded, and the environment cannot redirect it;
#   * every destructive action names exactly one container, resolved to an id
#     and proved to carry this project's label before anything happens;
#   * no command here defaults to a target. A missing argument is a usage
#     message and a non-zero exit;
#   * nothing is pruned, ever, by anything;
#   * no tmux command runs outside a `docker exec` into a container this script
#     resolved.
set -euo pipefail

# ── The project, and nothing else ────────────────────────────────────────────

# Hardcoded. Not `${COMPOSE_PROJECT_NAME:-…}`, not derived from the directory
# name: `firetower` and `firetower-dev` are both taken, by a real deployment
# and by the dev stack, and a project name is the namespace for volumes as well
# as containers. Resolving to either of those would mean this script's teardown
# removing somebody's database.
readonly PROJECT=ft-worker-sim

# Firetower sets COMPOSE_PROJECT_NAME for everything a session runs, and a
# `-p` flag beats it — but `COMPOSE_FILE` and `COMPOSE_PROFILES` have no flag
# that shadows them as safely, so the environment is taken out of the question
# instead of argued with.
unset COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# What gets mounted and compiled. The checkout this script lives in by
# default; `SIM_REPO` points it at another one — a clean clone of the commit
# under test is the honest way to test a commit.
readonly REPO="$(cd "${SIM_REPO:-$HERE/..}" && pwd)"
readonly API_PORT="${SIM_API_PORT:-14400}"
readonly API="http://localhost:$API_PORT"
readonly ADMIN_USER=admin
# What the docs tell you to type, and what this uses from the second run on.
readonly ADMIN_PASSWORD=worker-sim-admin
# What the control plane seeds the account from. An account created that way is
# marked as needing a new password, and *every* endpoint then answers
# `PasswordChangeRequired` until it has one — so the first run replaces it
# rather than trying to work around it. (Found by this failing: `up` got as far
# as asking the control plane for its ssh key and was refused.)
readonly ADMIN_FIRST_PASSWORD=worker-sim-initial
# What the machine is called in the fleet. `run.sh up` is idempotent on it.
readonly MACHINE=worker-sim

say()  { printf '  %s\n' "$*"; }
step() { printf '\n  \033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n  error: %s\n\n' "$*" >&2; exit 1; }

compose() {
    # `SIM_REPO` is read by the compose file's bind mount, so it has to be in
    # the environment of the command rather than only in this shell.
    SIM_REPO="$REPO" docker compose -p "$PROJECT" -f "$HERE/compose.yaml" "$@"
}

usage() {
    sed -n '3,10p' "${BASH_SOURCE[0]}" | sed 's/^#\{0,1\} \{0,1\}//'
    printf '\n  every command:\n\n'
    printf '    up                       bring it up, install the worker, wait until the machine is ready\n'
    printf '    status                   what is running, and what the control plane makes of the machine\n'
    printf '    kill <container>         a power cut: SIGKILL to the container. tmux and every agent in it die\n'
    printf '    start <container>        the reboot: the same container again, with /tmp cleared\n'
    printf '    restart-worker <container>   the worker process only. tmux survives, so nothing may be stranded\n'
    printf '    logs <container>         follow one container, read-only\n'
    printf '    psql                     a prompt on the control plane database\n'
    printf '    ui                       build the interface and say where to point a browser\n'
    printf '    agent <name>             fetch an agent onto the machine (claude-code, codex)\n'
    printf '    down [--volumes]         remove this project'"'"'s containers, and its build caches with --volumes\n\n'
    printf '  <container> is a service name — worker, control, postgres — or a full\n'
    printf '  ft-worker-sim-* container name. There is no default: a command that\n'
    printf '  destroys something has to say what.\n\n'
}

# ── Resolving a target, which is the whole safety model ──────────────────────

# Sets TARGET to exactly one container id, or stops the script.
#
# **Through a variable rather than through stdout, and this is not style.**
# `id="$(resolve "$1")"` puts the refusal inside a command substitution, where
# `exit` ends a subshell and not this script — and bash gives a `local x=$(…)`
# assignment the exit status of `local`, so `set -e` does not see the failure
# either. Written that way, `run.sh kill` with no argument printed nothing,
# exited 0, and would have gone on to act on an empty target. That is the exact
# shape of the accident this file exists to make impossible, so the refusal
# happens in this shell.
#
# The label filter below only *enumerates candidates*; it never reaches a
# command that acts. Each candidate is then inspected for this project's label
# and matched on its exact name or its exact Compose service, and TARGET is set
# only if exactly one container answered. A name that matches two containers,
# or none, or one in another project, stops everything rather than being
# guessed at — `docker kill` takes whatever it is handed, so the proof has to
# happen before it is handed anything.
TARGET=""
resolve() {
    TARGET=""
    local want="${1:-}"
    [ -n "$want" ] || die "name a container — worker, control or postgres. Nothing here has a default target."

    local found=() id name service project
    while read -r id; do
        [ -n "$id" ] || continue
        name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's|^/||')" || continue
        project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$id" 2>/dev/null)" || continue
        service="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id" 2>/dev/null)" || continue
        [ "$project" = "$PROJECT" ] || continue
        if [ "$want" = "$name" ] || [ "$want" = "$service" ]; then
            found+=("$id")
        fi
    done < <(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")

    if [ "${#found[@]}" -eq 0 ]; then
        die "no container called '$want' in project $PROJECT. Try: $0 status"
    fi
    if [ "${#found[@]}" -gt 1 ]; then
        die "'$want' matches ${#found[@]} containers in $PROJECT. Name one exactly."
    fi
    TARGET="${found[0]}"
}

# The name and project of a resolved id, printed before anything happens to it.
# Nothing in this script destroys something it has not first said out loud.
preflight() {
    local what="$1" id="$2"
    local name project
    name="$(docker inspect -f '{{.Name}}' "$id" | sed 's|^/||')"
    project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$id")"
    [ "$project" = "$PROJECT" ] || die "refusing: $name is in project '$project', not $PROJECT"
    say "about to: $what"
    say "  container  $name"
    say "  project    $project (verified)"
}

# ── The API, which is how a machine gets registered ─────────────────────────

TOKEN=""

# One call, with nothing secret in its arguments.
#
# A process list is readable by anything running as anybody, so what goes in
# an argv is published for as long as the call takes. Both halves of this call
# would otherwise be there: `curl -d '{"password":"…"}'` puts the password in
# one, and `-H "authorization: Bearer …"` puts a working session token in the
# other — which is a credential for this control plane until it expires, not a
# lesser thing than the password.
#
# So the body comes down a pipe (`-d @-`) and the header comes out of a file
# that only this account can read (`-H @file`, curl 7.55 and later). What is
# left on the command line is a method and a URL.
api() {
    local method="$1" path="$2" body="${3:-}"
    local args=(-sS -X "$method" "$API$path" -H 'content-type: application/json')
    [ -n "$HEADERS" ] && args+=(-H "@$HEADERS")
    if [ -n "$body" ]; then
        printf '%s' "$body" | curl "${args[@]}" -d @-
    else
        curl "${args[@]}"
    fi
}

# Where the authorization header waits, readable by this account and nobody
# else, for as long as this script runs.
HEADERS=""
hold_token() {
    [ -n "$HEADERS" ] || HEADERS="$(mktemp "${TMPDIR:-/tmp}/worker-sim-auth.XXXXXX")"
    chmod 600 "$HEADERS"
    printf 'authorization: Bearer %s\n' "$TOKEN" > "$HEADERS"
}
trap '[ -n "$HEADERS" ] && rm -f "$HEADERS"' EXIT

# A tiny JSON reader, so this needs nothing installed. Values here are ids,
# names and states — no quotes, no nesting — and `jq` is used when it is there.
field() {
    local key="$1"
    if command -v jq >/dev/null 2>&1; then
        jq -r ".$key // empty" 2>/dev/null
    else
        sed -n "s/.*\"$key\":\"\([^\"]*\)\".*/\1/p" | head -1
    fi
}

login() {
    api POST /api/v1/auth/login \
        "{\"username\":\"$ADMIN_USER\",\"password\":\"$1\"}" | field token
}

# Signed in, and holding a token that actually works.
#
# Those are two things. A seeded account signs in perfectly and is then refused
# by every endpoint with `PasswordChangeRequired` until the temporary password
# has been replaced, so the token is tried on something before it is trusted.
sign_in() {
    local was="$ADMIN_PASSWORD"
    TOKEN="$(login "$ADMIN_PASSWORD")"
    if [ -z "$TOKEN" ]; then
        was="$ADMIN_FIRST_PASSWORD"
        TOKEN="$(login "$ADMIN_FIRST_PASSWORD")"
        [ -n "$TOKEN" ] || die "could not sign in to $API as $ADMIN_USER"
    fi
    hold_token

    # `/api/v1/setup` is the one endpoint the gate exempts — it is how an
    # interface finds out it has to ask for a new password — so it is also the
    # only honest way to ask whether this token is gated. Asking a *gated*
    # endpoint and matching its error works until somebody exempts another one.
    case "$(api GET /api/v1/setup)" in
        *'"needsPassword":true'*)
            local answer
            answer="$(api POST /api/v1/auth/password \
                "{\"current\":\"$was\",\"new\":\"$ADMIN_PASSWORD\"}")"
            TOKEN="$(printf '%s' "$answer" | field token)"
            [ -n "$TOKEN" ] \
                || die "the seeded password could not be replaced, and nothing works until it is: $answer"
            hold_token
            say "replaced the seeded password; it is $ADMIN_PASSWORD from here on"
            ;;
    esac
}

# A fresh install wants its organisation named before anything can be filed in
# it. Skipped when it has been.
finish_setup() {
    case "$(api GET /api/v1/setup)" in
        *'"needsOrganization":true'*)
            local named
            named="$(api POST /api/v1/setup/organization '{"name":"Worker sim"}')"
            case "$named" in
                *'"code"'*) die "could not name the organisation: $named" ;;
            esac
            api POST /api/v1/setup/complete >/dev/null
            say "named the organisation"
            ;;
    esac
}

# ── up ───────────────────────────────────────────────────────────────────────

wait_for_api() {
    local waited=0
    printf '  waiting for the control plane'
    # It compiles the checkout on the first run, which is minutes rather than
    # seconds — so this waits a long time before giving up, and says why.
    while [ "$waited" -lt 900 ]; do
        if curl -fsS "$API/readyz" >/dev/null 2>&1; then
            printf ' — up after %ss\n' "$waited"
            return 0
        fi
        printf '.'
        sleep 3
        waited=$((waited + 3))
    done
    printf '\n'
    die "the control plane never answered $API/readyz. Try: $0 logs control"
}

# Forget what this machine's ssh key used to be.
#
# A container that is recreated — a rebuilt image, `down` and `up` again — is
# genuinely a new machine and answers with new host keys, and the control plane
# refuses it: `worker answered with a different host key than last time`, which
# is `StrictHostKeyChecking` doing exactly its job. A fleet wants that refusal.
# A harness that rebuilds the machine on purpose wants the operator's answer to
# it, which is to forget the old entry and learn the new one.
#
# Narrow on purpose: one host, by name, in the control plane's own
# `known_hosts`. Nothing here touches the key of anything else, and nothing
# here runs against a machine outside this project.
forget_host_key() {
    local control="$1"
    docker exec "$control" \
        ssh-keygen -R worker -f /home/firetower/ssh/known_hosts >/dev/null 2>&1 || true
}

install_worker_binary() {
    local worker="$1"
    step "Building the worker for Linux, in the control plane's own toolchain"
    # In the container, so this is a Linux binary whatever you are running on,
    # and in the same profile as the control plane so the two share every
    # dependency artifact in the `target` volume. Debug on purpose: this is a
    # binary to test the protocol against, not a release.
    compose exec -T control \
        cargo build -p ft-cli --no-default-features --bin firetower-worker
    compose exec -T control \
        sh -c 'cd /target/debug && tar -czf - firetower-worker' > "$HERE/.worker.tar.gz"
    say "$(du -h "$HERE/.worker.tar.gz" | cut -f1) tarball"

    step "Installing it on the machine, the way the control plane would"
    local key
    key="$(api GET /api/v1/ssh-key | field publicKey)"
    [ -n "$key" ] || die "the control plane would not say what its ssh key is"
    # The installer goes in as a file because `--from -` already owns stdin —
    # and into the home directory rather than /tmp, because /tmp here is the
    # tmpfs that makes a restart a reboot and `docker cp` writes *under* it.
    # (Found by this failing with "cannot open /tmp/worker.sh".)
    docker cp "$REPO/install/worker.sh" "$worker:/home/firetower/worker.sh" >/dev/null
    docker exec -i -u firetower "$worker" \
        sh /home/firetower/worker.sh --from - --skip-packages --authorize "$key" \
        < "$HERE/.worker.tar.gz"
    rm -f "$HERE/.worker.tar.gz"
}

machine_id() {
    api GET /api/v1/hosts \
        | jq -r --arg name "$MACHINE" '.[] | select(.name == $name) | .id' 2>/dev/null \
        | head -1
}

# Sets MACHINE_ROW, for the same reason `resolve` sets TARGET: a function that
# both narrates and returns a value through stdout returns the narration too.
MACHINE_ROW=""
register_machine() {
    # `Managed`, not `Default`. Default means "let ssh choose", which in this
    # container means `/root/.ssh` and nothing authorised anywhere; `Managed` is
    # the key Firetower made for itself and the one `install/worker.sh
    # --authorize` just put on the machine. Getting this wrong is a machine that
    # stays Unreachable with `worker refused the key`, which is what it did.
    local answer id
    answer="$(api POST /api/v1/hosts \
        "{\"name\":\"$MACHINE\",\"compute\":{\"type\":\"Server\",\"host\":\"worker\",\"user\":\"firetower\",\"key\":{\"type\":\"Managed\"}}}")"
    id="$(printf '%s' "$answer" | field id)"
    if [ -z "$id" ]; then
        # Already added is the ordinary answer to running `up` twice.
        id="$(machine_id)"
        [ -n "$id" ] || die "could not add the machine, and it is not already there: $answer"
        say "the machine was already registered"
    else
        say "registered $MACHINE"
    fi
    MACHINE_ROW="$id"
}

machine_state() {
    api GET /api/v1/hosts \
        | jq -r --arg name "$MACHINE" '.[] | select(.name == $name) | .state' 2>/dev/null \
        | head -1
}

wait_until_online() {
    local waited=0 state
    printf '  waiting for %s to report ready' "$MACHINE"
    while [ "$waited" -lt 180 ]; do
        state="$(machine_state)"
        if [ "$state" = "Online" ]; then
            printf ' — Online after %ss\n' "$waited"
            return 0
        fi
        printf '.'
        sleep 2
        waited=$((waited + 2))
    done
    printf '\n'
    say "it is still '$state'. The machine is added either way — see: $0 status"
    api GET /api/v1/hosts | jq -r --arg name "$MACHINE" \
        '.[] | select(.name == $name) | .diagnosis | select(. != null) | "  " + .summary + " — " + .detail' 2>/dev/null || true
    return 1
}

# What the control plane will actually be built from, said out loud.
#
# **The binary follows your editor, not your git history.** The repository is
# bind-mounted and the control plane is `cargo run`, so what comes up is the
# working tree at the moment it compiles — uncommitted changes included. That
# is the right default for developing, and a trap for testing: a QA pass ran
# against 551 lines of somebody's unsaved work and was only caught because it
# thought to check from inside the container.
#
# So it is printed every time, and a dirty tree stops `up` unless somebody
# says they meant it. A harness that quietly tests something other than what
# you asked it to is worse than no harness.
say_what_is_mounted() {
    local head dirty
    head="$(git -C "$REPO" log -1 --format='%h %s' 2>/dev/null || echo 'not a git checkout')"
    dirty="$(git -C "$REPO" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

    say "building   $head"
    if [ "${dirty:-0}" -eq 0 ]; then
        say "tree       clean — this is that commit and nothing else"
        return 0
    fi

    say "tree       ${dirty} uncommitted file(s) — THE CONTROL PLANE WILL INCLUDE THEM"
    if [ "${SIM_ALLOW_DIRTY:-0}" = "1" ] || [ "${1:-}" = "--dirty" ]; then
        say "           (--dirty given, carrying on)"
        return 0
    fi
    printf '\n'
    say "Refusing, because this is how a test pass comes to be about the wrong code."
    say "To test the commit:   git stash push -u -m worker-sim   (or commit)"
    say "To test what you have: $0 up --dirty"
    say "Or point the harness at a clean clone: SIM_REPO=/path/to/clone $0 up"
    printf '\n'
    exit 1
}

cmd_up() {
    command -v docker >/dev/null 2>&1 || die "docker is not on PATH"
    command -v jq >/dev/null 2>&1 \
        || die "jq is not on PATH, and reading a fleet of one out of a list by hand is how a harness lies to you"
    command -v curl >/dev/null 2>&1 || die "curl is not on PATH"
    step "Bringing up $PROJECT"
    say "project    $PROJECT"
    say "api        $API"
    say "repo       $REPO"
    say_what_is_mounted "${1:-}"
    compose up -d --build
    wait_for_api
    sign_in
    finish_setup
    resolve control
    forget_host_key "$TARGET"
    resolve worker
    install_worker_binary "$TARGET"
    register_machine
    wait_until_online || true
    step "Ready"
    say "control plane   $API  ($ADMIN_USER / $ADMIN_PASSWORD)"
    say "machine         $MACHINE  ($MACHINE_ROW)"
    say "a power cut     $0 kill worker"
    say "the reboot      $0 start worker"
    printf '\n'
}

# ── The breakages ───────────────────────────────────────────────────────────

cmd_kill() {
    resolve "${1:-}"
    preflight "docker kill (a power cut: SIGKILL to pid 1, nothing is asked to stop)" "$TARGET"
    docker kill "$TARGET" >/dev/null
    say "killed. tmux and every agent in it are gone; the workspace on disk is not."
    say "bring it back with: $0 start ${1}"
}

cmd_start() {
    resolve "${1:-}"
    preflight "docker start (the reboot: the same container, with /tmp cleared)" "$TARGET"
    docker start "$TARGET" >/dev/null
    say "started. The control plane reconnects on its own backoff."
}

cmd_restart_worker() {
    resolve "${1:-}"
    local id="$TARGET"
    preflight "docker exec pkill -x firetower-worker (the worker process only)" "$id"
    # Inside the container, which is the only place a process is killed by
    # anything in this file: that container's own pid namespace. The host's
    # worker is in another one and cannot be reached from here.
    #
    # `-fx`, so the *whole command line* has to equal that string — an exact
    # match rather than a pattern that could widen. Not `pkill -x
    # firetower-worker`, which refuses outright: Linux truncates a process
    # name to 15 characters and this one is 16, so there is nothing for `-x`
    # to match. (That is how this was found.) The command line itself comes
    # from `transport::worker_command`, which is `exec firetower-worker "$@"`
    # with `--stdio`.
    #
    # The worker is sshd's child, so killing it drops the control plane's
    # connection and the supervisor dials again and starts a new one. tmux is
    # not its child and does not notice — which is the case that must leave
    # every agent exactly where it was.
    if docker exec "$id" pkill -fx 'firetower-worker --stdio'; then
        say "the worker process is gone. tmux is untouched:"
        docker exec -u firetower "$id" tmux ls 2>&1 | sed 's/^/    /' || true
        say "nothing here may be stranded — that is acceptance criterion 2."
    else
        say "no firetower-worker was running in that container."
    fi
}

# ── Looking ─────────────────────────────────────────────────────────────────

cmd_status() {
    step "$PROJECT"
    compose ps || true
    step "What the control plane was built from"
    # Asked of the container rather than of this shell: the mount is the
    # answer, and a second checkout at a different commit is exactly the
    # confusion this is here to end.
    resolve control
    docker exec "$TARGET" sh -c \
        'cd /workspace && git log -1 --format="  %h %s" 2>/dev/null; printf "  "; git status --porcelain 2>/dev/null | wc -l | tr -d " "; echo " uncommitted file(s)"' \
        2>/dev/null || say "  (the control plane is not running)"
    if curl -fsS "$API/readyz" >/dev/null 2>&1; then
        sign_in
        step "The fleet, as the control plane sees it"
        api GET /api/v1/hosts | tr '}' '}\n' | sed 's/^,//' | sed 's/^/  /'
        step "Sessions"
        api GET /api/v1/sessions | tr '}' '}\n' | sed 's/^,//' | sed 's/^/  /'
    else
        say "the control plane is not answering on $API"
    fi
    printf '\n'
}

cmd_logs() {
    resolve "${1:-}"
    docker logs -f --tail 100 "$TARGET"
}

cmd_psql() {
    resolve postgres
    docker exec -it "$TARGET" psql -U firetower -d firetower
}

cmd_agent() {
    local name="${1:-}"
    [ -n "$name" ] || die "name an agent: claude-code, codex"
    resolve worker
    say "fetching $name onto the machine (a download; it is not signed in by this)"
    docker exec -u firetower "$TARGET" \
        /home/firetower/.firetower/worker/bin/firetower-worker agents add "$name"
}

cmd_ui() {
    step "The interface, compiled into the control plane"
    # The binary embeds `web/out` at compile time, so the export has to exist
    # before the control plane is built — and `web/out` is committed empty.
    if [ ! -f "$REPO/web/out/index.html" ]; then
        say "building web/out (a minute or two, once)"
        (cd "$REPO/web" && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null)
    fi
    # No `touch` needed to make that stick: `crates/ft-server/build.rs` watches
    # `web/out` precisely so that building the interface rebuilds the binary
    # that carries it.
    compose up -d --force-recreate control
    wait_for_api
    step "Open it"
    say "$API  ($ADMIN_USER / $ADMIN_PASSWORD)"
    say "the desktop app is the surface the recovery card is on — see docs/worker-sim.md"
    printf '\n'
}

# ── down ────────────────────────────────────────────────────────────────────

# Deliberately not `docker compose down`.
#
# That command resolves a project from flags, the file and the environment, and
# its blast radius is whatever it resolved — which is the failure this whole
# file is shaped against. So the teardown enumerates this project's containers,
# removes them one at a time by id, and then removes the network and volumes it
# can prove belong to it. There is no prune here and there is no filter that
# reaches a command which acts.
cmd_down() {
    local volumes=0
    [ "${1:-}" = "--volumes" ] && volumes=1

    step "Removing $PROJECT"
    local ids=() id
    while read -r id; do
        [ -n "$id" ] && ids+=("$id")
    done < <(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")

    if [ "${#ids[@]}" -eq 0 ]; then
        say "nothing of this project is here"
    fi
    for id in "${ids[@]:-}"; do
        [ -n "$id" ] || continue
        preflight "docker rm -f (one container, by id)" "$id"
        docker rm -f "$id" >/dev/null
    done

    # The network, by its exact name, and only once its label agrees.
    local net="${PROJECT}_default"
    if [ "$(docker network inspect -f '{{index .Labels "com.docker.compose.project"}}' "$net" 2>/dev/null)" = "$PROJECT" ]; then
        say "removing network $net"
        docker network rm "$net" >/dev/null
    fi

    if [ "$volumes" -eq 1 ]; then
        # Named one by one on purpose: these are this project's own, and a
        # volume whose label does not say so is left alone.
        local volume
        for volume in "${PROJECT}_postgres" "${PROJECT}_cargo" "${PROJECT}_target" \
                      "${PROJECT}_home" "${PROJECT}_sshd"; do
            if [ "$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$volume" 2>/dev/null)" = "$PROJECT" ]; then
                say "removing volume $volume"
                docker volume rm "$volume" >/dev/null
            fi
        done
    else
        say "build caches kept, so the next 'up' is quick. '$0 down --volumes' takes them."
    fi
    printf '\n'
}

# ── The one entry point ─────────────────────────────────────────────────────

case "${1:-}" in
    up)             shift; cmd_up "$@" ;;
    down)           shift; cmd_down "$@" ;;
    status)         shift; cmd_status "$@" ;;
    kill)           shift; cmd_kill "${1:-}" ;;
    start)          shift; cmd_start "${1:-}" ;;
    restart-worker) shift; cmd_restart_worker "${1:-}" ;;
    logs)           shift; cmd_logs "${1:-}" ;;
    psql)           shift; cmd_psql ;;
    agent)          shift; cmd_agent "${1:-}" ;;
    ui)             shift; cmd_ui ;;
    # No default that does anything. A bare invocation is a usage message.
    ""|-h|--help|help) usage; exit 2 ;;
    *)              printf '\n  unknown command: %s\n' "$1" >&2; usage; exit 2 ;;
esac

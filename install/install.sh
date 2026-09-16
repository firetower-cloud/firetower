#!/bin/sh
# Install Firetower — the control plane — on this machine.
#
#   curl -fsSL https://usefiretower.com/install.sh | sh
#
# Firetower is built server-first: the control plane runs on a Linux machine —
# a VPS, a cloud VM, a box in your office — and you connect to it from
# wherever you are, with the desktop client on your Mac or Windows machine, or
# the mobile app. This script is for that Linux machine.
#
# It gets three things onto the machine and then gets out of the way:
#
#   1. Docker, with the Compose plugin, if there is none — using Docker's own
#      installer, after showing you the line and asking.
#   2. Node, if there is none or it is older than 20 — the runtime the
#      Firetower CLI runs on.
#   3. The Firetower CLI, `npm i -g @firetower/cli`.
#
# Then it hands over to `firetower install`, which asks you the questions that
# are yours to answer — the domain, how it is reached — checks the machine,
# writes the deployment, generates the secrets and starts it. Nothing here
# decides any of that for you.
#
# Options:
#   --skip-docker   this machine manages Docker its own way; do not offer to
#                   install it (firetower install still checks it is there)
#   --deps-only     stop after the CLI is installed, before firetower install
#   --yes           install what is missing without asking, for a machine
#                   nobody is watching. firetower install still asks its own
#                   questions; nothing here answers those.
set -eu

SKIP_DOCKER=0
DEPS_ONLY=0
YES=0

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --skip-docker) SKIP_DOCKER=1; shift ;;
        --deps-only)   DEPS_ONLY=1; shift ;;
        --yes|-y)      YES=1; shift ;;
        -h|--help)     sed -n '2,27p' "$0" 2>/dev/null || say "see https://usefiretower.com/docs"; exit 0 ;;
        *)             die "unknown option: $1. This script takes no other options; firetower install asks its own questions." ;;
    esac
done

# ── where this is ────────────────────────────────────────────────────

case "$(uname -s)" in
    Linux) ;;
    Darwin)
        say "Firetower is built server-first: the control plane runs on a Linux"
        say "machine — a VPS, a cloud VM, a box in your office — and you connect to"
        say "it from this Mac with the desktop client. Run this line on that Linux"
        say "machine. Docs: https://usefiretower.com/docs/self-hosting"
        exit 1 ;;
    *) die "Firetower's control plane runs on Linux; this is $(uname -s)." ;;
esac
# The control plane needs Docker, and a container has no daemon to give it.
# Unless Docker is somebody else's business here — which is what the flag says,
# and what lets this be tested in one.
if [ "$SKIP_DOCKER" -eq 0 ] && [ -f /.dockerenv ]; then
    die "this is a container. The control plane runs on the machine itself, with Docker — run this on the host."
fi

# Over ssh or from a console, the PATH may not have what packages just put
# there. Look where they go.
PATH="$PATH:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/snap/bin"
export PATH

# sudo only when not already root — a fresh VPS is often root and often has no
# sudo at all.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || die "this needs root for packages: run it as root, or install sudo."
    SUDO="sudo"
fi

PM=""
for candidate in apt-get dnf yum zypper pacman apk; do
    if command -v "$candidate" >/dev/null 2>&1; then PM="$candidate"; break; fi
done

# The one "yes" this script asks for, per thing it installs. Read from the
# terminal rather than stdin, because stdin is this script when it arrives
# through curl.
ask() {
    if [ "$YES" -eq 1 ]; then return 0; fi
    if ( exec < /dev/tty ) 2>/dev/null; then
        printf '%s [y/N] ' "$1"
        read -r answer < /dev/tty || answer=""
        case "$answer" in y|Y|yes|YES) return 0 ;; esac
        return 1
    fi
    say "(no terminal to ask on)"
    return 1
}

# Run a line after showing it. Everything this script changes on the machine
# goes through here, so nothing happens that was not printed first.
run() {
    say "  $1"
    if ask "Run it now?"; then
        sh -c "$1"
    else
        die "not run. Do it yourself, then run this script again."
    fi
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

# ── 1. Docker, with Compose ──────────────────────────────────────────

if [ "$SKIP_DOCKER" -eq 0 ]; then
    if command_exists docker; then
        say "Docker: $(docker --version 2>/dev/null || say present)"
    else
        say "Docker is not installed. Docker's own installer puts it there, with the"
        say "Compose plugin, on every distribution it supports:"
        run "curl -fsSL https://get.docker.com | ${SUDO:+$SUDO }sh"
        command_exists docker || die "docker is still not on PATH after installing it."
    fi

    if docker compose version >/dev/null 2>&1 || ${SUDO:+$SUDO} docker compose version >/dev/null 2>&1; then
        :
    else
        say "Docker is here but the Compose plugin is not — the distribution's own"
        say "Docker package leaves it out. The deployment is a compose file, so:"
        case "$PM" in
            apt-get) run "$SUDO apt-get update && $SUDO apt-get install -y docker-compose-plugin" ;;
            dnf)     run "$SUDO dnf install -y docker-compose-plugin" ;;
            yum)     run "$SUDO yum install -y docker-compose-plugin" ;;
            *)       die "install the Docker Compose plugin for this distribution, then run this again: https://docs.docker.com/compose/install/linux/" ;;
        esac
    fi

    # The daemon has to answer the account that will run firetower install.
    if [ -n "$SUDO" ] && ! docker info >/dev/null 2>&1; then
        say "This account cannot talk to the Docker daemon yet. Adding it to the"
        say "docker group — which takes effect at your next login:"
        run "$SUDO usermod -aG docker $(id -un)"
        warn "log out and back in before running firetower install; until then the daemon refuses this account."
        NEEDS_RELOGIN=1
    fi
fi

# ── 2. Node ──────────────────────────────────────────────────────────

node_ok() {
    command_exists node || return 1
    major="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
    [ "${major:-0}" -ge 20 ]
}

if node_ok; then
    say "Node: $(node --version)"
else
    if command_exists node; then
        say "Node $(node --version) is too old; the Firetower CLI needs 20 or newer."
    else
        say "Node is not installed. The Firetower CLI runs on it."
    fi
    case "$PM" in
        apt-get) run "curl -fsSL https://deb.nodesource.com/setup_22.x | ${SUDO:+$SUDO }bash - && $SUDO apt-get install -y nodejs" ;;
        dnf)     run "curl -fsSL https://rpm.nodesource.com/setup_22.x | ${SUDO:+$SUDO }bash - && $SUDO dnf install -y nodejs" ;;
        yum)     run "curl -fsSL https://rpm.nodesource.com/setup_22.x | ${SUDO:+$SUDO }bash - && $SUDO yum install -y nodejs" ;;
        zypper)  run "$SUDO zypper install -y nodejs22 npm22" ;;
        pacman)  run "$SUDO pacman -S --noconfirm nodejs npm" ;;
        apk)     run "$SUDO apk add nodejs npm" ;;
        *)       die "install Node 20 or newer for this distribution, then run this again: https://nodejs.org/en/download" ;;
    esac
    node_ok || die "node is still missing or too old after installing it."
fi

# ── 3. The CLI ───────────────────────────────────────────────────────

# Global, so `firetower upgrade`, `status` and `doctor` are there afterwards.
# npm's global prefix may be root-owned on a machine where root installed
# Node; then the install needs sudo, and says so.
prefix="$(npm prefix -g 2>/dev/null || say /usr/local)"
if [ -w "$prefix/lib" ] 2>/dev/null || [ -z "$SUDO" ]; then
    run "npm i -g @firetower/cli@latest"
else
    run "$SUDO npm i -g @firetower/cli@latest"
fi

FIRETOWER="$(command -v firetower 2>/dev/null || true)"
if [ -z "$FIRETOWER" ] && [ -x "$prefix/bin/firetower" ]; then
    FIRETOWER="$prefix/bin/firetower"
    warn "$prefix/bin is not on PATH. Add it to your shell's profile:"
    warn "  export PATH=\"$prefix/bin:\$PATH\""
fi
[ -n "$FIRETOWER" ] || die "the CLI installed but firetower is not on PATH."
say "Firetower CLI: $("$FIRETOWER" --version 2>/dev/null | grep -m1 . || say installed)"

if [ "$DEPS_ONLY" -eq 1 ]; then
    say ""
    say "Everything firetower install needs is here. Next:"
    say "  firetower install"
    exit 0
fi

if [ "${NEEDS_RELOGIN:-0}" -eq 1 ]; then
    say ""
    say "Log out and back in so this account can talk to Docker, then:"
    say "  firetower install"
    exit 0
fi

# ── 4. Over to firetower install ─────────────────────────────────────

say ""
say "Handing over to firetower install. It will ask about the domain and how"
say "the machine is reached, check the machine, and start Firetower."
say ""
# stdin is this script when it came through curl; the CLI needs the terminal
# for its questions.
if ( exec < /dev/tty ) 2>/dev/null; then
    exec "$FIRETOWER" install < /dev/tty
else
    say "No terminal to ask on. Run it yourself:"
    say "  firetower install"
    exit 0
fi

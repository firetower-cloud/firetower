#!/bin/sh
# Install a Firetower worker on this machine.
#
#   curl -fsSL https://usefiretower.com/worker.sh | sh
#
# Puts one binary in ~/.firetower/worker/bin, and nothing anywhere else. No
# sudo for that; sudo only for the packages the machine is missing, and only
# after saying which and asking. Nothing on the machine is changed that this
# script did not name first.
#
# What a worker needs: git, tmux, a POSIX shell, curl and tar — and an sshd,
# because that is how Firetower reaches it. Agents are fetched by the worker
# itself, as standalone binaries; nothing else has to be installed for them.
#
# Options, all optional:
#   --authorize KEY   add Firetower's public key to ~/.ssh/authorized_keys
#   --version X.Y.Z   this release rather than the newest
#   --from FILE       a worker tarball to install instead of downloading;
#                     `-` reads it from stdin (the control plane uses this)
#   --agent NAME      also fetch an agent: claude-code or codex
#   --yes             install missing packages without asking
#
# The same script runs over ssh when you press "Install the worker" in
# Firetower, so what happens there is exactly what happens here.
set -eu

# Over ssh this runs with the daemon's own PATH, which has nothing the account
# installed on it — not Homebrew, not /usr/local. Look where package managers
# put things, so a `brew` that is there is found, and a `tmux` just installed
# is found by the check that follows.
PATH="$PATH:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:$HOME/.local/bin"
export PATH

RELEASES="${FIRETOWER_RELEASES:-https://github.com/firetower-cloud/firetower/releases}"
ROOT="${FIRETOWER_WORKER_ROOT:-$HOME/.firetower/worker}"
BIN="$ROOT/bin"

VERSION=""
FROM=""
AUTHORIZE=""
AGENT=""
YES=0

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --authorize) [ $# -ge 2 ] || die "--authorize needs a key"; AUTHORIZE="$2"; shift 2 ;;
        --version)   [ $# -ge 2 ] || die "--version needs a version"; VERSION="${2#v}"; shift 2 ;;
        --from)      [ $# -ge 2 ] || die "--from needs a file, or -"; FROM="$2"; shift 2 ;;
        --agent)     [ $# -ge 2 ] || die "--agent needs a name"; AGENT="$2"; shift 2 ;;
        --yes|-y)    YES=1; shift ;;
        -h|--help)   sed -n '2,25p' "$0" 2>/dev/null || say "see https://usefiretower.com/docs"; exit 0 ;;
        *)           die "unknown option: $1" ;;
    esac
done

# ── what this machine is ─────────────────────────────────────────────

case "$(uname -s)" in
    Darwin) OS=darwin ;;
    Linux)  OS=linux ;;
    MINGW*|MSYS*|CYGWIN*) die "Windows is not a worker platform. Install into WSL2, which is Linux from here on." ;;
    *) die "no worker is published for $(uname -s)" ;;
esac
case "$(uname -m)" in
    arm64|aarch64) ARCH=arm64 ;;
    x86_64|amd64)  ARCH=x86_64 ;;
    *) die "no worker is published for $OS on $(uname -m)" ;;
esac
ASSET="firetower-worker-$OS-$ARCH.tar.gz"

if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    die "do not run this with sudo: the worker installs into the account's own home, and Firetower connects as that account. Run it as $SUDO_USER."
fi

# ── the package manager, and what is missing ─────────────────────────

PM=""
for candidate in brew apt-get dnf yum pacman apk zypper; do
    if command -v "$candidate" >/dev/null 2>&1; then PM="$candidate"; break; fi
done

# How to install packages with whatever this machine has. Printed before it is
# run, and never run without a yes.
install_line() {
    case "$PM" in
        brew)    say "brew install $*" ;;
        apt-get) say "sudo apt-get update && sudo apt-get install -y $*" ;;
        dnf)     say "sudo dnf install -y $*" ;;
        yum)     say "sudo yum install -y $*" ;;
        pacman)  say "sudo pacman -S --noconfirm $*" ;;
        apk)     say "sudo apk add $*" ;;
        zypper)  say "sudo zypper install -y $*" ;;
    esac
}

MISSING=""
for tool in git tmux curl tar; do
    command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"
done
MISSING="${MISSING# }"

# The one "yes" this script ever asks for. Read from the terminal rather than
# stdin, because stdin is this script when it arrives through curl.
ask() {
    if [ "$YES" -eq 1 ]; then return 0; fi
    # `-r /dev/tty` is true over ssh too; only opening it says whether there
    # is a terminal on the other end.
    if ( exec < /dev/tty ) 2>/dev/null; then
        printf '%s [y/N] ' "$1"
        read -r answer < /dev/tty || answer=""
        case "$answer" in y|Y|yes|YES) return 0 ;; esac
        return 1
    fi
    say "(no terminal to ask on)"
    return 1
}

if [ -n "$MISSING" ]; then
    say "This machine is missing: $MISSING"
    if [ "$OS" = darwin ] && [ -z "$PM" ]; then
        say "Homebrew is not installed, and that is how tmux gets onto a Mac."
        say "Install it from https://brew.sh, then run this again — or install"
        say "$MISSING another way and run this again."
        die "missing: $MISSING"
    fi
    if [ -z "$PM" ]; then
        die "no package manager was found. Install $MISSING and run this again."
    fi
    # shellcheck disable=SC2086 # one argument per package is the point
    line="$(install_line $MISSING)"
    say "To install: $line"
    if ask "Run it now?"; then
        sh -c "$line" || die "installing $MISSING failed. Install it by hand and run this again."
    else
        die "install $MISSING and run this again, or pass --yes to let this script do it."
    fi
    for tool in $MISSING; do
        command -v "$tool" >/dev/null 2>&1 || die "$tool is still not on PATH after installing it"
    done
fi

# ── the worker itself ────────────────────────────────────────────────

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t firetower)"
trap 'rm -rf "$TMP"' EXIT INT TERM

if [ "$FROM" = "-" ]; then
    cat > "$TMP/$ASSET"
    [ -s "$TMP/$ASSET" ] || die "nothing arrived on stdin"
elif [ -n "$FROM" ]; then
    [ -f "$FROM" ] || die "no such file: $FROM"
    cp "$FROM" "$TMP/$ASSET"
else
    if [ -n "$VERSION" ]; then
        base="$RELEASES/download/v$VERSION"
        which="$VERSION"
    else
        base="$RELEASES/latest/download"
        which="the newest release"
    fi
    say "Fetching firetower-worker ($which) for $OS $ARCH…"
    if ! curl -fsSL --retry 3 -o "$TMP/$ASSET" "$base/$ASSET"; then
        die "could not fetch $base/$ASSET — is there a release for this version, and is this machine online?"
    fi
    if curl -fsSL --retry 3 -o "$TMP/SHA256SUMS" "$base/SHA256SUMS" 2>/dev/null; then
        expected="$(grep " $ASSET\$" "$TMP/SHA256SUMS" | cut -d' ' -f1 || true)"
        if command -v sha256sum >/dev/null 2>&1; then
            actual="$(sha256sum "$TMP/$ASSET" | cut -d' ' -f1)"
        else
            actual="$(shasum -a 256 "$TMP/$ASSET" | cut -d' ' -f1)"
        fi
        [ -n "$expected" ] || die "$ASSET is not listed in the release's SHA256SUMS"
        [ "$actual" = "$expected" ] || die "$ASSET did not match its published checksum"
    else
        warn "the release has no SHA256SUMS; installing without verifying"
    fi
fi

tar -xzf "$TMP/$ASSET" -C "$TMP" || die "$ASSET is not a tarball this tar can read"
[ -f "$TMP/firetower-worker" ] || die "the tarball had no firetower-worker in it"

# Into place through a temporary name, so a copy that stops half way leaves
# nothing that looks like a worker.
mkdir -p "$BIN"
mv "$TMP/firetower-worker" "$BIN/.incoming"
chmod 755 "$BIN/.incoming"
mv "$BIN/.incoming" "$BIN/firetower-worker"

installed="$("$BIN/firetower-worker" --version 2>/dev/null || true)"
[ -n "$installed" ] || die "$BIN/firetower-worker does not run on this machine"
say "Installed $installed to $BIN"

# ── the key, and the agent ───────────────────────────────────────────

if [ -n "$AUTHORIZE" ]; then
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    touch "$HOME/.ssh/authorized_keys"
    chmod 600 "$HOME/.ssh/authorized_keys"
    if grep -qF -- "$AUTHORIZE" "$HOME/.ssh/authorized_keys"; then
        say "Firetower's key is already in ~/.ssh/authorized_keys"
    else
        printf '%s\n' "$AUTHORIZE" >> "$HOME/.ssh/authorized_keys"
        say "Authorised Firetower's key for $(id -un)"
    fi
fi

if [ -n "$AGENT" ]; then
    say "Fetching $AGENT…"
    "$BIN/firetower-worker" agents add "$AGENT" || die "fetching $AGENT failed"
fi

# ── can Firetower get in? ────────────────────────────────────────────

sshd_running() {
    if [ "$OS" = darwin ]; then
        launchctl print system/com.openssh.sshd >/dev/null 2>&1
    else
        { command -v systemctl >/dev/null 2>&1 && { systemctl is-active --quiet ssh || systemctl is-active --quiet sshd; }; } \
            || pgrep -x sshd >/dev/null 2>&1
    fi
}

if ! sshd_running; then
    if [ "$OS" = darwin ]; then
        warn "Remote Login is off, so Firetower cannot reach this Mac. Turn it on in"
        warn "System Settings → General → Sharing → Remote Login, or: sudo systemsetup -setremotelogin on"
    else
        warn "no sshd is running, so Firetower cannot reach this machine."
        warn "$(install_line openssh-server 2>/dev/null || say 'install openssh-server') && sudo systemctl enable --now ssh"
    fi
fi

# ── the verdict ──────────────────────────────────────────────────────

say ""
if [ -n "$AGENT" ]; then
    "$BIN/firetower-worker" doctor --agent "$AGENT" || true
else
    "$BIN/firetower-worker" doctor || true
fi
say ""
say "Add this machine in Firetower: Compute → Add a machine → $(id -un)@$(hostname 2>/dev/null || say this-machine)"

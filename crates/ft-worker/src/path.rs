//! The `PATH` this machine actually has, as opposed to the one sshd hands out.
//!
//! A worker is started by sshd running a command, and a command started that
//! way gets the daemon's own `PATH` — `/usr/bin:/bin:/usr/sbin:/sbin` on macOS,
//! not much more on Linux. Nothing the account set up is in it: not Homebrew,
//! not `~/.local/bin`, not what a package manager put under `/usr/local`. So a
//! machine with `tmux` installed reports `tmux` missing, and the person who just
//! installed it goes looking at the wrong thing.
//!
//! The fix lives here rather than in a dotfile, because a dotfile is one more
//! thing to get right on every machine and the wrong one is read for the wrong
//! kind of shell. This asks the account's login shell what it thinks `PATH` is,
//! adds the places a tool goes when a package manager puts it there, and keeps
//! everything sshd gave us. Order matters and is deliberate: what the
//! environment already said comes first, what the login shell said next, and
//! the well-known directories last — so a `git` the account chose still wins
//! over the one in `/usr/bin`, and nothing here reorders a `PATH` that was
//! already complete.

use std::ffi::OsString;
use std::path::PathBuf;

/// Where a package manager puts a tool, on the machines a worker runs on.
///
/// Homebrew first, in both its homes; `/usr/local` for everything that installs
/// itself there; the two per-account directories a `pip --user`, a `cargo
/// install` or a Go build land in; and `/snap/bin` for Ubuntu. Not `/usr/bin`
/// and friends — those are in every `PATH` there is, and repeating them adds
/// nothing.
fn well_known() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
        PathBuf::from("/snap/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".cargo").join("bin"));
        dirs.push(home.join("go").join("bin"));
    }
    dirs
}

/// What the account's login shell says `PATH` is.
///
/// `$SHELL -l -c 'printf %s "$PATH"'`: a login shell, so `/etc/profile`,
/// `/etc/zprofile` and the account's own profile run — which on macOS is what
/// puts Homebrew on the path — and not an interactive one, so nothing prompts
/// and nothing waits for a keyboard. Bounded, because a profile can do
/// anything, and one that hangs must not take the worker with it.
///
/// `None` when there is no `SHELL`, the shell did not answer, or it answered
/// with nothing. All three mean the same thing here: nothing to add.
async fn from_login_shell() -> Option<Vec<PathBuf>> {
    let shell = std::env::var_os("SHELL")?;
    if shell.is_empty() {
        return None;
    }

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::process::Command::new(&shell)
            .args(["-l", "-c", "printf %s \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;

    if !output.status.success() {
        return None;
    }

    // Only the last line. A profile that echoes something on the way through
    // — a greeting, a warning about an unset variable — puts it before the
    // answer, and the answer is one line.
    let said = String::from_utf8_lossy(&output.stdout);
    let last = said.lines().last()?.trim();
    if last.is_empty() {
        return None;
    }
    Some(std::env::split_paths(last).collect())
}

/// The environment's `PATH`, then the login shell's, then the well-known
/// directories — each directory once, in the order it was first seen.
pub async fn resolve() -> OsString {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&existing).collect();

    let mut add = |more: Vec<PathBuf>| {
        for dir in more {
            if !dir.as_os_str().is_empty() && !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    };

    if let Some(login) = from_login_shell().await {
        add(login);
    }
    add(well_known());

    std::env::join_paths(dirs).unwrap_or(existing)
}

/// Make [`resolve`] this process's own `PATH`.
///
/// Once, at start-up, before anything runs `git` or `tmux` — after which every
/// `Command` in the worker, every tmux server it starts and every readiness
/// check inherits it. The one place, so that no caller has to remember.
pub async fn adopt() {
    let path = resolve().await;
    std::env::set_var("PATH", &path);
    tracing::debug!(path = %path.to_string_lossy(), "PATH adopted");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn what_was_already_there_comes_first_and_is_not_repeated() {
        let resolved = resolve().await;
        let existing = std::env::var_os("PATH").unwrap_or_default();

        let got: Vec<PathBuf> = std::env::split_paths(&resolved).collect();
        let had: Vec<PathBuf> = std::env::split_paths(&existing).collect();

        assert!(
            got.starts_with(&had),
            "the existing PATH has to survive, in order: {got:?} vs {had:?}"
        );

        let mut seen = std::collections::HashSet::new();
        for dir in &got {
            assert!(seen.insert(dir), "{} appears twice", dir.display());
        }
    }

    #[tokio::test]
    async fn the_well_known_places_are_added() {
        let resolved = resolve().await;
        let got: Vec<PathBuf> = std::env::split_paths(&resolved).collect();
        assert!(got.contains(&PathBuf::from("/usr/local/bin")));
        assert!(got.contains(&PathBuf::from("/opt/homebrew/bin")));
    }
}

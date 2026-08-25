//! The agents this machine can run, and where they came from.
//!
//! Agents used to be baked into the worker image. That does not survive
//! contact with a third one: each is a few hundred megabytes, they are
//! published on their own schedules, and a new one would mean a new Firetower
//! release before anybody could use it.
//!
//! So they are installed onto the volume instead — the same volume that
//! already survives `docker rm -f` and holds mirrors, worktrees and the event
//! log. Recreating a container to upgrade the worker keeps them.
//!
//! **Nothing here touches a credential.** Installing a binary and signing it
//! in are separate acts, and only the first happens on this machine: what an
//! agent authenticates with is held by the control plane and handed over per
//! session.

use anyhow::{bail, Context, Result};
use ft_core::Agent;
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// Where installed agents live, under the worker's own state directory.
pub fn root(state: &Path) -> PathBuf {
    state.join("agents")
}

/// One agent this machine has, and which copy answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub kind: Agent,
    pub version: String,
    /// The directory holding its `bin`.
    pub bin: PathBuf,
}

/// Everything Firetower has installed here.
///
/// Reads the directory rather than remembering: an operator who deleted one by
/// hand is telling us something, and a record that disagreed with the disk
/// would be worse than no record.
pub async fn installed(state: &Path) -> Vec<Installed> {
    let mut out = Vec::new();
    for kind in Agent::all() {
        if let Some(one) = newest(state, kind).await {
            out.push(one);
        }
    }
    out
}

/// The newest version of one agent, if any is here.
pub async fn newest(state: &Path, kind: Agent) -> Option<Installed> {
    let dir = root(state).join(directory(kind));
    let mut entries = tokio::fs::read_dir(&dir).await.ok()?;

    let mut versions: Vec<String> = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            versions.push(entry.file_name().to_string_lossy().to_string());
        }
    }

    // Lexicographic, which is wrong for 10 versus 9 and right for everything
    // else. What is here is what we put here, one version at a time, so the
    // question rarely arises — and `agents install` names the version it kept.
    versions.sort();
    let version = versions.pop()?;
    let bin = dir.join(&version).join("node_modules").join(".bin");
    tokio::fs::metadata(&bin).await.ok()?;

    Some(Installed { kind, version, bin })
}

/// The `PATH` a process should have to find these.
///
/// **Appended, never prepended.** A machine that has its own `claude` — a
/// version manager, a build somebody pinned, a package the operator installed
/// — keeps using it, and ours answers only when nothing else does. Prepending
/// would silently override a choice somebody made deliberately.
pub async fn path_with_agents(state: &Path) -> std::ffi::OsString {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&existing).collect();

    for one in installed(state).await {
        dirs.push(one.bin);
    }

    std::env::join_paths(dirs).unwrap_or(existing)
}

/// Give a command the agents this machine has.
pub async fn with_agents(command: &mut Command, state: &Path) {
    command.env("PATH", path_with_agents(state).await);
}

/// Fetch one, into a directory named for the version it turned out to be.
///
/// Installed beside whatever is already there rather than over it: a fetch
/// that fails half way leaves the working copy alone, and going back to the
/// previous version is a directory that is still sitting there.
pub async fn install(state: &Path, kind: Agent, version: Option<&str>) -> Result<Installed> {
    let package = kind
        .package()
        .with_context(|| format!("{} is not something Firetower installs", kind.label()))?;

    let wanted = match version {
        Some(v) => format!("{package}@{v}"),
        None => format!("{package}@latest"),
    };

    let dir = root(state).join(directory(kind));
    tokio::fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("making {}", dir.display()))?;

    // Into a scratch directory first, then renamed once it is whole.
    let staging = dir.join(".installing");
    let _ = tokio::fs::remove_dir_all(&staging).await;
    tokio::fs::create_dir_all(&staging)
        .await
        .with_context(|| format!("making {}", staging.display()))?;

    // `--no-audit --no-fund` are noise on a machine nobody is reading, and
    // `--omit=dev` because we want the thing, not its test suite.
    let output = Command::new("npm")
        .arg("install")
        .arg("--prefix")
        .arg(&staging)
        .arg("--no-audit")
        .arg("--no-fund")
        .arg("--omit=dev")
        .arg(&wanted)
        .output()
        .await
        .context("running npm — is node installed on this machine?")?;

    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr);
        let _ = tokio::fs::remove_dir_all(&staging).await;
        bail!(
            "installing {} failed: {}",
            kind.label(),
            said.lines().last().unwrap_or("npm said nothing").trim()
        );
    }

    let version = installed_version(&staging, package)
        .await
        .unwrap_or_else(|| version.unwrap_or("unknown").to_string());

    let home = dir.join(&version);
    let _ = tokio::fs::remove_dir_all(&home).await;
    tokio::fs::rename(&staging, &home)
        .await
        .with_context(|| format!("moving {} into place", kind.label()))?;

    let bin = home.join("node_modules").join(".bin");
    tokio::fs::metadata(&bin)
        .await
        .with_context(|| format!("{} installed but has no bin directory", kind.label()))?;

    Ok(Installed { kind, version, bin })
}

/// Remove every copy of one.
pub async fn remove(state: &Path, kind: Agent) -> Result<()> {
    let dir = root(state).join(directory(kind));
    match tokio::fs::remove_dir_all(&dir).await {
        Ok(()) => Ok(()),
        // Already gone is the wanted state.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("removing {}", dir.display())),
    }
}

/// What the installed package says its version is.
///
/// From the package's own manifest rather than from what we asked for, because
/// `@latest` does not say what it resolved to and a directory called `latest`
/// would be a lie the day after.
async fn installed_version(prefix: &Path, package: &str) -> Option<String> {
    let manifest = prefix
        .join("node_modules")
        .join(package)
        .join("package.json");
    let text = tokio::fs::read_to_string(manifest).await.ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("version")?.as_str().map(str::to_string)
}

/// The directory name for an agent. Stable, and never the label.
fn directory(kind: Agent) -> &'static str {
    match kind {
        Agent::ClaudeCode => "claude-code",
        Agent::Codex => "codex",
        Agent::Shell => "shell",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn nothing_installed_is_an_empty_answer_rather_than_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(installed(dir.path()).await.is_empty());
        assert!(newest(dir.path(), Agent::ClaudeCode).await.is_none());
    }

    /// A machine's own copy wins. Ours is the fallback, which is why it goes on
    /// the end.
    #[tokio::test]
    async fn our_copies_are_appended_so_the_machines_own_still_wins() {
        let dir = tempfile::tempdir().unwrap();
        let bin = root(dir.path())
            .join("claude-code")
            .join("2.1.0")
            .join("node_modules")
            .join(".bin");
        tokio::fs::create_dir_all(&bin).await.unwrap();

        let path = path_with_agents(dir.path()).await;
        let dirs: Vec<_> = std::env::split_paths(&path).collect();

        assert_eq!(
            dirs.last().map(|p| p.as_path()),
            Some(bin.as_path()),
            "ours must be last, or it overrides a binary somebody chose"
        );
        assert!(dirs.len() > 1, "the existing PATH has to survive");
    }

    /// Removing what is not there is success: the wanted state is "absent".
    #[tokio::test]
    async fn removing_something_absent_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        remove(dir.path(), Agent::Codex).await.unwrap();
    }

    #[tokio::test]
    async fn a_shell_is_not_something_we_fetch() {
        let dir = tempfile::tempdir().unwrap();
        let refused = install(dir.path(), Agent::Shell, None).await;
        assert!(refused.is_err(), "there is nothing to fetch for a shell");
    }
}

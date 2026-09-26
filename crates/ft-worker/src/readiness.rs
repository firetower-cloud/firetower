//! Launch prerequisites, measured with the same PATH the agent receives.
//! Checks never install packages or change the host's configuration.
use ft_core::{Agent, Readiness, Requirement};
use std::{ffi::OsStr, path::Path, time::Duration};
use tokio::process::Command;

async fn output(program: &str, args: &[&str], path: &OsStr) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args).env("PATH", path).kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(3), command.output())
        .await
        .ok()?
        .ok()?;
    if !result.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&result.stdout)
            .lines()
            .next()
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect(),
    )
}

async fn tool(
    name: &str,
    program: &str,
    args: &[&str],
    required: bool,
    remedy: &str,
    path: &OsStr,
) -> Requirement {
    let found = output(program, args, path).await;
    Requirement {
        name: name.into(),
        available: found.is_some(),
        required,
        detail: found
            .unwrap_or_else(|| "Missing, failed, or did not answer within 3 seconds".into()),
        remedy: Some(remedy.into()),
    }
}

pub async fn check(root: &Path, agent: Option<Agent>) -> Readiness {
    let path = crate::runtime::path_with_agents(root).await;
    check_with_path(root, agent, &path).await
}

/// The command that installs a package on this machine, for the remedy.
///
/// Named after whichever package manager is on the PATH the checks run with,
/// so the panel shows `brew install tmux` on a Mac and `sudo apt-get install
/// -y tmux` on Debian — something to copy, rather than a sentence about
/// package managers. `sudo` only where the manager needs it: Homebrew
/// refuses to run as root.
fn package_remedy(package: &str, path: &OsStr) -> String {
    let has = |program: &str| std::env::split_paths(path).any(|dir| dir.join(program).is_file());
    if has("brew") {
        format!("brew install {package}")
    } else if has("apt-get") {
        format!("sudo apt-get update && sudo apt-get install -y {package}")
    } else if has("dnf") {
        format!("sudo dnf install -y {package}")
    } else if has("yum") {
        format!("sudo yum install -y {package}")
    } else if has("pacman") {
        format!("sudo pacman -S --noconfirm {package}")
    } else if has("apk") {
        format!("sudo apk add {package}")
    } else if has("zypper") {
        format!("sudo zypper install -y {package}")
    } else {
        format!("Install {package} using this machine's package manager.")
    }
}

async fn check_with_path(root: &Path, agent: Option<Agent>, path: &OsStr) -> Readiness {
    let git_fix = package_remedy("git", path);
    let tmux_fix = package_remedy("tmux", path);
    let (git, tmux, shell, user) = tokio::join!(
        tool("Git", "git", &["--version"], true, &git_fix, path),
        tool("tmux", "tmux", &["-V"], true, &tmux_fix, path),
        tool(
            "Shell",
            "sh",
            &["-c", "printf 'sh available'"],
            true,
            "Install a POSIX shell and make sh available on PATH.",
            path
        ),
        output("id", &["-un"], path),
    );
    let mut checks = vec![
        Requirement {
            name: "Firetower worker".into(),
            available: true,
            required: true,
            detail: env!("CARGO_PKG_VERSION").into(),
            remedy: None,
        },
        git,
        tmux,
        shell,
    ];
    // A uniquely named temporary file checks actual write access, including
    // read-only mounts. Dropping it only removes this check's own file.
    let writable = tempfile::Builder::new()
        .prefix(".readiness-")
        .tempfile_in(root);
    checks.push(Requirement {
        name: "Worker state directory".into(),
        available: writable.is_ok(),
        required: true,
        detail: match &writable {
            Ok(_) => root.display().to_string(),
            Err(e) => e.to_string(),
        },
        remedy: Some(
            "Give the connection account write access to the worker state directory.".into(),
        ),
    });
    if let Some(agent) = agent {
        checks.push(tool(agent.label(), agent.command(), &["--version"], true,
            "Install this agent on the machine, or let Firetower fetch it: the readiness panel offers Install, and `firetower-worker agents add` does the same by hand.", path).await);
        // Answering `--version` is the whole of what the check above proves,
        // and for Codex that is not enough to run a session.
        if agent == Agent::Codex {
            checks.push(code_mode_host(path));
        }
    }
    Readiness { checks, user }
}

/// The sidecar Codex runs every tool through.
///
/// Looked for beside whichever `codex` the PATH answers with, rather than
/// anywhere on the PATH, because that is where `codex` looks: a machine with
/// its own Codex earlier on the PATH is asked about that one. Its own check
/// because `codex --version` answers perfectly without it, and the session it
/// goes on to run cannot read a file.
fn code_mode_host(path: &OsStr) -> Requirement {
    let found = std::env::split_paths(path)
        .find(|dir| dir.join(Agent::Codex.command()).is_file())
        .map(|dir| dir.join(crate::runtime::CODE_MODE_HOST))
        .filter(|host| host.is_file());

    Requirement {
        name: "Codex code-mode host".into(),
        available: found.is_some(),
        required: true,
        detail: match &found {
            Some(host) => host.display().to_string(),
            None => format!(
                "{} is not beside the codex binary, so Codex can answer and cannot read, edit or run anything",
                crate::runtime::CODE_MODE_HOST
            ),
        },
        remedy: Some(
            "Reinstall Codex so the sidecar lands with it: the readiness panel offers Install, and `firetower-worker agents add codex` does the same by hand."
                .into(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake(dir: &Path, name: &str, body: &str) {
        let file = dir.join(name);
        std::fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[tokio::test]
    async fn reports_all_missing_requirements_without_installing_anything() {
        let root = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let result =
            check_with_path(root.path(), Some(Agent::ClaudeCode), bin.path().as_os_str()).await;
        assert!(!result.ready());
        for name in ["Git", "tmux", "Shell", "Claude Code"] {
            assert!(
                result
                    .checks
                    .iter()
                    .any(|c| c.name == name && !c.available && c.required),
                "{name}"
            );
        }
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        assert_eq!(std::fs::read_dir(bin.path()).unwrap().count(), 0);
    }

    /// git, tmux, a shell and the agent. Nothing else is asked of a machine —
    /// not Node, not Docker.
    #[tokio::test]
    async fn an_existing_agent_needs_nothing_but_git_tmux_and_a_shell() {
        let root = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        for command in ["git", "tmux", "sh", "claude"] {
            fake(bin.path(), command, "echo ready");
        }
        fake(bin.path(), "id", "echo editor");
        let result =
            check_with_path(root.path(), Some(Agent::ClaudeCode), bin.path().as_os_str()).await;
        assert!(result.ready(), "{}", result.missing());
        assert_eq!(result.user.as_deref(), Some("editor"));
        assert!(
            !result
                .checks
                .iter()
                .any(|c| c.name == "npm" || c.name == "Node.js"),
            "Node is not a requirement of a machine"
        );
        assert!(
            !result
                .checks
                .iter()
                .any(|c| c.name.contains("code-mode host")),
            "the code-mode host is Codex's, and only Codex's"
        );
    }

    #[tokio::test]
    async fn broken_agent_and_unwritable_state_block_launch() {
        let root = tempfile::NamedTempFile::new().unwrap();
        let bin = tempfile::tempdir().unwrap();
        for command in ["git", "tmux", "sh"] {
            fake(bin.path(), command, "echo ready");
        }
        fake(bin.path(), "claude", "exit 1");
        let result =
            check_with_path(root.path(), Some(Agent::ClaudeCode), bin.path().as_os_str()).await;
        assert!(!result.ready());
        assert!(result.missing().contains("Worker state directory"));
        assert!(result.missing().contains("Claude Code"));
    }

    /// A Codex that answers `--version` is not a Codex that can work: without
    /// the sidecar it runs its tools through, every file read and command it
    /// is asked for fails. So the sidecar is asked about separately, and is
    /// required.
    #[test]
    fn codex_without_its_code_mode_host_is_not_ready() {
        let bin = tempfile::tempdir().unwrap();
        fake(bin.path(), "codex", "echo ready");

        let lacking = code_mode_host(bin.path().as_os_str());
        assert!(!lacking.available);
        assert!(lacking.required);
        assert!(lacking.detail.contains("codex-code-mode-host"));

        fake(bin.path(), "codex-code-mode-host", "echo ready");
        let whole = code_mode_host(bin.path().as_os_str());
        assert!(whole.available, "{}", whole.detail);
    }

    /// Beside the `codex` that would run, not anywhere on the PATH: a machine
    /// with its own Codex first is asked about that one, because that is the
    /// one whose sidecar would be spawned.
    #[test]
    fn the_host_is_looked_for_beside_the_codex_that_answers() {
        let theirs = tempfile::tempdir().unwrap();
        let ours = tempfile::tempdir().unwrap();
        fake(theirs.path(), "codex", "echo ready");
        fake(ours.path(), "codex", "echo ready");
        fake(ours.path(), "codex-code-mode-host", "echo ready");

        let path = std::env::join_paths([theirs.path(), ours.path()]).unwrap();
        assert!(
            !code_mode_host(&path).available,
            "ours answering for theirs would hide a broken install"
        );

        let path = std::env::join_paths([ours.path(), theirs.path()]).unwrap();
        assert!(code_mode_host(&path).available);
    }

    /// The remedy is the command, in the words of whatever package manager
    /// is there — so it can be copied rather than read.
    #[test]
    fn a_missing_package_is_answered_with_the_command_that_installs_it() {
        let bin = tempfile::tempdir().unwrap();
        fake(bin.path(), "brew", "exit 0");
        assert_eq!(
            package_remedy("tmux", bin.path().as_os_str()),
            "brew install tmux"
        );

        let debian = tempfile::tempdir().unwrap();
        fake(debian.path(), "apt-get", "exit 0");
        assert!(package_remedy("tmux", debian.path().as_os_str()).starts_with("sudo apt-get"));

        let bare = tempfile::tempdir().unwrap();
        assert!(package_remedy("tmux", bare.path().as_os_str()).contains("package manager"));
    }

    #[tokio::test]
    async fn hanging_executable_is_bounded() {
        let bin = tempfile::tempdir().unwrap();
        fake(bin.path(), "git", "exec /bin/sleep 30");
        let start = std::time::Instant::now();
        assert!(output("git", &["--version"], bin.path().as_os_str())
            .await
            .is_none());
        assert!(start.elapsed() < Duration::from_secs(6));
    }
}

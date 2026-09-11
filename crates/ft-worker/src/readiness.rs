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

async fn check_with_path(root: &Path, agent: Option<Agent>, path: &OsStr) -> Readiness {
    let (git, tmux, shell, node, npm, user) = tokio::join!(
        tool("Git", "git", &["--version"], true, "Install git using this machine's package manager.", path),
        tool("tmux", "tmux", &["-V"], true, "Install tmux using this machine's package manager.", path),
        tool("Shell", "sh", &["-c", "printf 'sh available'"], true, "Install a POSIX shell and make sh available on PATH.", path),
        tool("Node.js", "node", &["--version"], false, "Install a Node.js version supported by your agent if you need npm-based agent installation.", path),
        tool("npm", "npm", &["--version"], false, "Install npm if you want to install agents through npm.", path),
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
            "Install this agent on the selected environment and ensure its executable is on the worker's PATH. See docs/host-execution.md.", path).await);
    }
    checks.extend([node, npm]);
    Readiness { checks, user }
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

    #[tokio::test]
    async fn existing_agent_does_not_require_npm_or_docker() {
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
        assert!(result
            .checks
            .iter()
            .any(|c| c.name == "npm" && !c.available && !c.required));
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

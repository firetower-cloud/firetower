//! The agent's home on a host.
//!
//! Every session gets a tmux session of its own. That's what lets you close the
//! laptop: the agent's parent is the tmux server, not the worker, so restarting
//! the worker — or losing the network — doesn't touch anything that's running.
//!
//! It also means a worker that comes back can find what's still alive by asking
//! tmux, rather than having to have remembered.

use anyhow::{bail, Context, Result};
use std::path::Path;
use tokio::process::Command;

/// One agent, running or not.
#[derive(Debug, Clone)]
pub struct Tmux {
    name: String,
}

impl Tmux {
    /// Named after the session, so `tmux ls` on a host is readable by a human
    /// wondering what Firetower has running.
    ///
    /// What runs in here is the supervisor holding an agent's pipes, not a
    /// terminal anybody attaches to. tmux is here for what it was always here
    /// for — being the parent that outlives a worker — and no longer for being
    /// a screen.
    pub fn for_session(session_id: &str) -> Self {
        Self::named(format!("firetower-{session_id}"))
    }

    /// A tmux session by name — the shell a session opens alongside its agent.
    pub fn named(name: String) -> Self {
        Self { name }
    }

    /// The environment the session was started with.
    ///
    /// Asked of tmux rather than remembered, because it is the one place these
    /// values already are: they were handed over with `-e` when the agent
    /// started, and a worker deliberately writes them nowhere. Lines that are
    /// not `KEY=value` — tmux prints `-KEY` for one it was told to unset — are
    /// skipped.
    pub async fn environment(&self) -> Result<Vec<(String, String)>> {
        let output = Command::new("tmux")
            .args(["show-environment", "-t", &self.name])
            .output()
            .await
            .context("reading the session environment")?;

        if !output.status.success() {
            bail!(
                "reading the environment of {}: {}",
                self.name,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }

        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.split_once('='))
            .filter(|(name, _)| !name.starts_with('-'))
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect())
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Start the agent, detached, in the worktree.
    ///
    /// Environment goes through `-e`, which sets it per session. Setting it on
    /// our own process instead does not work: tmux takes a new session's
    /// environment from the *server*, so whatever the first client happened to
    /// export would be frozen in and a rotated token would never reach a new
    /// session.
    ///
    /// The cost is that values pass through the tmux client's arguments, which
    /// on Linux are world-readable for as long as that call takes. On a host
    /// with untrusted users that is a real window, and closing it means putting
    /// a small wrapper between tmux and the agent to hand the environment over
    /// a socket — the same trick used for git credentials. Worth doing when
    /// shared hosts matter; not yet.
    pub async fn start(&self, cwd: &Path, command: &str, env: &[(String, String)]) -> Result<()> {
        if self.exists().await {
            bail!("{} is already running", self.name);
        }

        let mut tmux = Command::new("tmux");
        tmux.args([
            "new-session",
            "-d",
            "-s",
            &self.name,
            "-c",
            cwd.to_str().unwrap_or("."),
        ]);

        for (key, value) in env {
            tmux.arg("-e").arg(format!("{key}={value}"));
        }

        // And again, in front of the command itself.
        //
        // `-e` is not enough on its own: **tmux does not give the first pane
        // the `PATH` it was handed here.** Every other variable arrives — this
        // was found with one that did and one that didn't, on tmux 3.3a — but
        // `PATH` is taken from the server's own environment instead, so the
        // pane gets whatever started the tmux server and never ours.
        //
        // That matters because the agents are on the volume now rather than in
        // the image, and the only thing that says where they are *is* `PATH`.
        // Without this the agent is not on it, and the session fails at
        // `starting codex: No such file or directory` — which reads as a
        // missing install rather than a dropped variable.
        //
        // `-e` stays as well: it is what a window opened later inherits, and
        // somebody attaching to poke around should find the same agent the
        // session ran.
        tmux.arg(format!("{} {}", env_prefix(env), command));

        let output = tmux.output().await.context("starting tmux")?;
        if !output.status.success() {
            bail!(
                "tmux couldn't start {}: {}",
                self.name,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }

        // No status bar. It's tmux telling you about tmux, and here the frame
        // around the terminal already says which session you're looking at.
        let _ = Command::new("tmux")
            .args(["set-option", "-t", &self.name, "status", "off"])
            .output()
            .await;

        Ok(())
    }

    pub async fn exists(&self) -> bool {
        Command::new("tmux")
            .args(["has-session", "-t", &self.name])
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Everything on screen and above it.
    ///
    /// Sent when you open a session, so a long-running agent shows its history
    /// rather than whatever it happens to print next.
    pub async fn scrollback(&self) -> Result<String> {
        let output = Command::new("tmux")
            .args(["capture-pane", "-p", "-e", "-S", "-", "-t", &self.name])
            .output()
            .await
            .context("capturing the pane")?;

        if !output.status.success() {
            bail!(
                "capturing {}: {}",
                self.name,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// Tear it down. Absent is success — the desired state is "not running".
    pub async fn kill(&self) -> Result<()> {
        if !self.exists().await {
            return Ok(());
        }
        let output = Command::new("tmux")
            .args(["kill-session", "-t", &self.name])
            .output()
            .await
            .context("killing the tmux session")?;

        if !output.status.success() {
            bail!(
                "killing {}: {}",
                self.name,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }

    /// Which sessions are ours, for a worker picking up where it left off.
    pub async fn ours() -> Result<Vec<String>> {
        let output = Command::new("tmux")
            .args(["list-sessions", "-F", "#{session_name}"])
            .output()
            .await
            .context("listing tmux sessions")?;

        // No server running means no sessions, which is not a failure.
        if !output.status.success() {
            return Ok(Vec::new());
        }

        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|l| l.strip_prefix("firetower-"))
            .map(str::to_string)
            .collect())
    }
}

/// `env 'K=V' 'K=V'` — the environment, set by the shell tmux runs the command
/// with rather than by tmux itself.
///
/// Quoted the same way `structured::tmux_command` quotes its arguments, because
/// this is prepended to exactly that string and goes to the same shell. A value
/// holding a quote is a token, not an attack, but it would break the command
/// just as effectively.
fn env_prefix(env: &[(String, String)]) -> String {
    let mut out = String::from("env");
    for (key, value) in env {
        out.push(' ');
        out.push_str(&quote(&format!("{key}={value}")));
    }
    out
}

fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Unique per test, so a failure never leaves a name that breaks the next run.
    fn unique(tag: &str) -> Tmux {
        Tmux::for_session(&format!("test-{tag}-{}", std::process::id()))
    }

    /// The one tmux drops.
    ///
    /// `-e PATH=…` sets the session environment and the first pane never sees
    /// it — tmux uses the server's own `PATH` instead. Everything else passes,
    /// which is what made this hard to see: the agent's `CODEX_HOME` arrived
    /// and the agent itself could not be found.
    #[tokio::test]
    async fn the_first_pane_gets_the_path_it_was_given() {
        let dir = TempDir::new().unwrap();
        let tmux = unique("path");
        let marker = dir.path().join("seen");

        // A directory holding one program, which is only findable through the
        // PATH we pass — exactly the shape of an agent on the volume.
        let bin = dir.path().join("bin");
        tokio::fs::create_dir_all(&bin).await.unwrap();
        let program = bin.join("firetower-test-agent");
        tokio::fs::write(
            &program,
            format!("#!/bin/sh\necho found > {}\n", marker.display()),
        )
        .await
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755))
                .await
                .unwrap();
        }

        let path = format!(
            "{}:{}",
            std::env::var("PATH").unwrap_or_default(),
            bin.display()
        );
        tmux.start(
            dir.path(),
            "firetower-test-agent",
            &[("PATH".to_string(), path)],
        )
        .await
        .unwrap();

        for _ in 0..50 {
            if marker.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let _ = tmux.kill().await;

        assert!(
            marker.exists(),
            "the pane could not run a program that was on the PATH it was given"
        );
    }

    #[tokio::test]
    async fn an_agent_outlives_the_command_that_started_it() {
        let dir = TempDir::new().unwrap();
        let tmux = unique("detach");

        tmux.start(dir.path(), "sleep 30", &[]).await.unwrap();
        assert!(
            tmux.exists().await,
            "the session should be running detached"
        );

        tmux.kill().await.unwrap();
        assert!(!tmux.exists().await);
    }

    #[tokio::test]
    async fn killing_something_already_gone_is_fine() {
        // Tearing down twice happens whenever a retry meets a success.
        unique("absent").kill().await.unwrap();
    }

    #[tokio::test]
    async fn the_environment_reaches_the_agent() {
        let dir = TempDir::new().unwrap();
        let tmux = unique("env");

        // The command writes the variable out, proving it arrived.
        tmux.start(
            dir.path(),
            "printenv FIRETOWER_TEST_SECRET > seen.txt; sleep 5",
            &[("FIRETOWER_TEST_SECRET".into(), "s3cret-value".into())],
        )
        .await
        .unwrap();

        // Wait for content, not for the file: the redirect creates it before
        // the command writes, so existence alone is a race the test loses.
        let mut seen = String::new();
        for _ in 0..40 {
            seen = tokio::fs::read_to_string(dir.path().join("seen.txt"))
                .await
                .unwrap_or_default();
            if !seen.trim().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        tmux.kill().await.unwrap();

        assert_eq!(
            seen.trim(),
            "s3cret-value",
            "the agent should see the value"
        );
    }

    #[tokio::test]
    async fn scrollback_returns_what_the_agent_printed() {
        let dir = TempDir::new().unwrap();
        let tmux = unique("scroll");

        tmux.start(dir.path(), "echo hello-from-the-agent; sleep 10", &[])
            .await
            .unwrap();

        let mut seen = String::new();
        for _ in 0..40 {
            seen = tmux.scrollback().await.unwrap_or_default();
            if seen.contains("hello-from-the-agent") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        tmux.kill().await.unwrap();

        assert!(seen.contains("hello-from-the-agent"), "{seen:?}");
    }

    #[tokio::test]
    async fn a_worker_can_find_what_it_left_running() {
        let dir = TempDir::new().unwrap();
        let tmux = unique("adopt");
        let id = tmux.name().strip_prefix("firetower-").unwrap().to_string();

        tmux.start(dir.path(), "sleep 30", &[]).await.unwrap();
        let found = Tmux::ours().await.unwrap();
        tmux.kill().await.unwrap();

        assert!(found.contains(&id), "{found:?}");
    }
}

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

        let mut args: Vec<String> = ["new-session", "-d", "-s"]
            .iter()
            .map(|a| a.to_string())
            .collect();
        args.push(self.name.clone());
        args.push("-c".into());
        args.push(cwd.to_str().unwrap_or(".").to_string());

        for (key, value) in env {
            args.push("-e".into());
            args.push(format!("{key}={value}"));
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
        //
        // The cgroup join goes first of all, ahead of the environment and the
        // command, because it has to happen while this pane is still a shell
        // and before it becomes the agent. Every call into here starts a pane
        // in a workspace's directory, which is the one thing that says which
        // workspace it belongs to — see `cgroup::join_command` for why the
        // pane has to move itself rather than be moved.
        args.push(format!(
            "{} {} {}",
            crate::cgroup::join_command(cwd),
            env_prefix(env),
            command
        ));

        // Before tmux is asked, because what tmux says when this is too big is
        // `command too long` — four words that name neither the session, nor
        // the environment, nor the variable that did it. This says all three.
        if let Some(why) = too_long(&args, env) {
            bail!("{} cannot be started: {why}", self.name);
        }

        let output = Command::new("tmux")
            .args(&args)
            .output()
            .await
            .context("starting tmux")?;
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

    /// Check existence without treating a failed tmux probe as proof of
    /// absence. Watcher EOF may indicate an agent exit, but only a known
    /// `has-session` miss is enough evidence to close its conversation.
    pub(crate) async fn checked_exists(&self) -> Result<bool> {
        let output = Command::new("tmux")
            .args(["has-session", "-t", &self.name])
            .output()
            .await
            .context("checking the tmux session")?;

        checked_exists_output(
            &self.name,
            output.status.success(),
            output.status.code(),
            &String::from_utf8_lossy(&output.stderr),
        )
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

/// What one tmux command line holds, in bytes.
///
/// A tmux client packs the whole of `argv` into a single message to its
/// server, and that message is capped: `MAX_IMSGSIZE` (16384) less the header
/// (16) less the argument count (4). Measured against tmux 3.3a, which takes
/// 16364 bytes of packed arguments and refuses 16365 with `command too long`.
///
/// Nothing here can raise it. What a session can do is stay under it, which is
/// why the one value with no ceiling — a profile's system prompt — travels as
/// a file now rather than as a variable. See `agentd::persona_path`.
const COMMAND_LIMIT: usize = 16_364;

/// Why this launch will not fit, if it will not.
///
/// The environment is counted twice on purpose: it is in `argv` twice, once
/// as `-e` arguments and once inlined in front of the command, and somebody
/// reading "9 kB of environment, 16 kB of room" would otherwise be right to
/// think there was space. Naming the largest variable is the whole point —
/// it is almost always one value rather than a hundred small ones.
fn too_long(args: &[String], env: &[(String, String)]) -> Option<String> {
    // A packed argument is its bytes and a terminator, which is what tmux
    // measures.
    let packed: usize = args.iter().map(|arg| arg.len() + 1).sum();
    if packed <= COMMAND_LIMIT {
        return None;
    }

    let biggest = env
        .iter()
        .max_by_key(|(key, value)| key.len() + value.len())
        .map(|(key, value)| {
            format!(
                ", the largest being {key} at {}",
                size(key.len() + value.len() + 1)
            )
        });

    Some(format!(
        "its environment does not fit in a tmux command line. tmux takes {} and this launch is \
         {}, because a session's environment travels in it twice — {} of variables{}. Shorten \
         what this session carries: a profile's instructions, or a repository variable holding a \
         key or a file.",
        size(COMMAND_LIMIT),
        size(packed),
        size(env.iter().map(|(k, v)| k.len() + v.len() + 1).sum()),
        biggest.unwrap_or_default(),
    ))
}

/// Bytes, as somebody reading an error wants them.
fn size(bytes: usize) -> String {
    match bytes < 1024 {
        true => format!("{bytes} B"),
        false => format!("{:.1} kB", bytes as f64 / 1024.0),
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

fn checked_exists_output(
    name: &str,
    success: bool,
    exit_code: Option<i32>,
    stderr: &str,
) -> Result<bool> {
    if success {
        return Ok(true);
    }

    let stderr = stderr.trim();
    if exit_code == Some(1)
        && (stderr == format!("can't find session: {name}")
            || stderr.starts_with("no server running on "))
    {
        return Ok(false);
    }

    anyhow::bail!(
        "checking {}: {}",
        name,
        if stderr.is_empty() {
            "tmux has-session failed without a diagnostic"
        } else {
            stderr
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Unique per test, so a failure never leaves a name that breaks the next run.
    fn unique(tag: &str) -> Tmux {
        Tmux::for_session(&format!("test-{tag}-{}", std::process::id()))
    }

    /// An ordinary session is nowhere near the ceiling, and must not be told
    /// it is.
    #[test]
    fn an_ordinary_launch_fits() {
        let env = vec![
            ("PATH".to_string(), "/usr/bin:/bin".repeat(10)),
            (
                "CLAUDE_CODE_OAUTH_TOKEN".to_string(),
                "sk-ant-oat".repeat(8),
            ),
            (
                "FIRETOWER_SESSION".to_string(),
                "s_01m6pbz9p4bn16xpj8".into(),
            ),
        ];
        let args = vec![
            "new-session".to_string(),
            "-d".into(),
            "-s".into(),
            "firetower-s_01m6pbz9p4bn16xpj8".into(),
        ];
        assert!(too_long(&args, &env).is_none());
    }

    /// And when it does not fit, the sentence has to be the one that saves the
    /// next hour: which variable, and how big.
    #[test]
    fn an_oversized_environment_names_what_filled_it() {
        let persona = "You are the Orchestrator. ".repeat(400);
        let env = vec![
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ("FIRETOWER_PERSONA".to_string(), persona),
        ];
        // What `start` builds: the variables as `-e` arguments, then the same
        // variables again inlined in front of the command.
        let mut args = vec!["new-session".to_string()];
        for (key, value) in &env {
            args.push("-e".into());
            args.push(format!("{key}={value}"));
        }
        args.push(env_prefix(&env));

        let why = too_long(&args, &env).expect("this does not fit");
        assert!(why.contains("FIRETOWER_PERSONA"), "{why}");
        assert!(why.contains("twice"), "{why}");
    }

    /// Exactly at the ceiling still goes — the limit tmux enforces is the one
    /// measured against it, not one rounded down for comfort.
    #[test]
    fn the_last_byte_that_fits_is_allowed() {
        let args = vec!["x".repeat(COMMAND_LIMIT - 1)];
        assert!(too_long(&args, &[]).is_none());
        let args = vec!["x".repeat(COMMAND_LIMIT)];
        assert!(too_long(&args, &[]).is_some());
    }

    #[test]
    fn checked_presence_only_treats_known_tmux_misses_as_absent() {
        assert!(checked_exists_output("firetower-s_test", true, Some(0), "").unwrap());
        assert!(!checked_exists_output(
            "firetower-s_test",
            false,
            Some(1),
            "can't find session: firetower-s_test\n"
        )
        .unwrap());
        assert!(!checked_exists_output(
            "firetower-s_test",
            false,
            Some(1),
            "no server running on /tmp/tmux-501/default\n"
        )
        .unwrap());
        assert!(checked_exists_output(
            "firetower-s_test",
            false,
            Some(1),
            "failed to connect to server: resource temporarily unavailable\n"
        )
        .is_err());
        assert!(checked_exists_output("firetower-s_test", false, Some(1), "").is_err());
        assert!(checked_exists_output(
            "firetower-s_test",
            false,
            Some(2),
            "can't find session: firetower-s_test"
        )
        .is_err());
        assert!(checked_exists_output(
            "firetower-s_test",
            false,
            None,
            "can't find session: firetower-s_test"
        )
        .is_err());
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

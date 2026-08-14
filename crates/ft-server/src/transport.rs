//! How the control plane reaches a worker.
//!
//! A transport hands back a reader and a writer. That's the whole contract —
//! the protocol doesn't care whether the bytes travel down a pipe to a child
//! process, through an SSH tunnel, or over a websocket the worker opened
//! outbound. Local today, SSH next, hosted later, one daemon throughout.

use anyhow::{Context, Result};
use async_trait::async_trait;
use std::process::Stdio;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// A live bidirectional connection to a worker.
pub struct Connection {
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
    /// Held so the child isn't reaped while we're talking to it.
    _child: Option<Child>,
}

#[async_trait]
pub trait Transport: Send + Sync {
    /// Human-readable, for logs and the Compute view.
    fn describe(&self) -> String;
    async fn connect(&self) -> Result<Connection>;
}

/// The worker as a child process on this machine.
///
/// The command is `firetower worker --stdio`. Reaching a remote host adds
/// `ssh <target>` in front of exactly that — which is why the local milestone is
/// the real system rather than a stand-in for it.
pub struct LocalTransport {
    exe: std::path::PathBuf,
    root: std::path::PathBuf,
}

impl LocalTransport {
    pub fn new(root: impl Into<std::path::PathBuf>) -> Result<Self> {
        Ok(Self {
            exe: std::env::current_exe().context("locating the firetower binary")?,
            root: root.into(),
        })
    }
}

#[async_trait]
impl Transport for LocalTransport {
    fn describe(&self) -> String {
        "local child process".to_string()
    }

    async fn connect(&self) -> Result<Connection> {
        let mut child = Command::new(&self.exe)
            .arg("worker")
            .arg("--stdio")
            .arg("--root")
            .arg(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // the worker's logs belong in ours, not in the frame stream
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .context("spawning the local worker")?;

        let stdout: ChildStdout = child.stdout.take().context("worker stdout was not piped")?;
        let stdin: ChildStdin = child.stdin.take().context("worker stdin was not piped")?;

        Ok(Connection {
            reader: Box::new(stdout),
            writer: Box::new(stdin),
            _child: Some(child),
        })
    }
}

/// A worker on another machine, reached over SSH.
///
/// Not wired up yet — it exists here so the shape of the trait is settled by a
/// second implementation rather than by one.
/// A worker in a container on this machine.
///
/// `docker exec` gives the same bidirectional pipe an ssh session does, with no
/// sshd to run, no key to manage and no host key to verify. The worker cannot
/// tell the difference — which is the whole point of the transport being an
/// abstraction.
pub struct DockerTransport {
    pub container: String,
    pub root: std::path::PathBuf,
}

#[async_trait]
impl Transport for DockerTransport {
    fn describe(&self) -> String {
        format!("docker exec {}", self.container)
    }

    async fn connect(&self) -> Result<Connection> {
        let mut child = Command::new("docker")
            .arg("exec")
            // Interactive without a tty: frames are bytes, and a tty would
            // helpfully translate newlines and corrupt them.
            .arg("-i")
            .arg(&self.container)
            .arg("firetower")
            .arg("worker")
            .arg("--stdio")
            .arg("--root")
            .arg(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("connecting to container {}", self.container))?;

        let stdout = child.stdout.take().context("docker stdout was not piped")?;
        let stdin = child.stdin.take().context("docker stdin was not piped")?;

        Ok(Connection {
            reader: Box::new(stdout),
            writer: Box::new(stdin),
            _child: Some(child),
        })
    }
}

pub struct SshTransport {
    pub target: String,
    pub root: std::path::PathBuf,
}

#[async_trait]
impl Transport for SshTransport {
    fn describe(&self) -> String {
        format!("ssh {}", self.target)
    }

    async fn connect(&self) -> Result<Connection> {
        let mut child = Command::new("ssh")
            // Without these, adding a host that isn't there hangs instead of
            // failing: ssh waits on a password prompt nobody can answer, or on
            // a TCP connection that will never be refused.
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("ConnectTimeout=10")
            // A host that answers with a different key is not the one we
            // trusted. Accepting it silently is how credentials reach the
            // wrong machine.
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new")
            .arg(&self.target)
            .arg("firetower")
            .arg("worker")
            .arg("--stdio")
            .arg("--root")
            .arg(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("connecting to {}", self.target))?;

        let stdout = child.stdout.take().context("ssh stdout was not piped")?;
        let stdin = child.stdin.take().context("ssh stdin was not piped")?;

        Ok(Connection {
            reader: Box::new(stdout),
            writer: Box::new(stdin),
            _child: Some(child),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transport_describes_itself_for_the_log() {
        let ssh = SshTransport {
            target: "root@203.0.113.44".into(),
            root: "/var/lib/firetower".into(),
        };
        assert_eq!(ssh.describe(), "ssh root@203.0.113.44");
    }

    #[test]
    fn local_and_ssh_differ_only_in_how_the_command_is_reached() {
        // Both run `firetower worker --stdio`. That is the entire difference
        // between the local milestone and the remote one.
        let local = LocalTransport::new("/tmp/ft").unwrap();
        assert_eq!(local.describe(), "local child process");
    }
}

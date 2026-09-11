//! Running a command on a machine, on the way to upgrading its worker.
//!
//! The same path a worker is reached by, ending in a shell command rather than
//! in `firetower-worker --stdio`. For a server that is `ssh … 'script'`, with
//! the same options, the same known_hosts and the same key — materialised from
//! the vault for the length of the command and read from tmpfs, exactly as a
//! connection does. For a container on this machine it is `sh -c`.
//!
//! The script is one string, quoted by the caller. Nothing from a form reaches
//! it unquoted — see `worker::quote`.

use anyhow::{Context, Result};
use async_trait::async_trait;
use std::process::Stdio;

/// How long one command may take. A `docker pull` of a worker image on a slow
/// link is minutes; ten is past any reasonable pull and short of forever.
const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);

#[derive(Debug, Clone)]
pub struct Output {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.status == Some(0)
    }
}

#[async_trait]
pub trait Runner: Send + Sync {
    /// For the log: where the command is run.
    fn describe(&self) -> String;
    async fn run(&self, script: &str) -> Result<Output>;
}

/// `sh -c` on this machine, for a worker container Firetower runs here.
pub struct LocalRunner;

#[async_trait]
impl Runner for LocalRunner {
    fn describe(&self) -> String {
        "this machine".to_string()
    }

    async fn run(&self, script: &str) -> Result<Output> {
        let mut command = tokio::process::Command::new("sh");
        command.arg("-c").arg(script);
        finish(command).await
    }
}

/// Over ssh, as the worker connection goes.
pub struct SshRunner {
    pub transport: crate::transport::SshTransport,
}

#[async_trait]
impl Runner for SshRunner {
    fn describe(&self) -> String {
        format!("ssh {}", self.transport.destination)
    }

    async fn run(&self, script: &str) -> Result<Output> {
        let mut command = self.transport.command().await?;
        // One argument: ssh joins its arguments with spaces and hands the
        // result to the remote login shell, so the script arrives as it was
        // written, quoting and all.
        command.arg(script);
        finish(command).await
    }
}

async fn finish(mut command: tokio::process::Command) -> Result<Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(COMMAND_TIMEOUT, command.output())
        .await
        .context("the command did not finish in time")?
        .context("running the command")?;
    Ok(Output {
        status: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_local_script_runs_and_its_output_comes_back() {
        let out = LocalRunner
            .run("echo out; echo err >&2; exit 3")
            .await
            .unwrap();
        assert_eq!(out.status, Some(3));
        assert_eq!(out.stdout.trim(), "out");
        assert_eq!(out.stderr.trim(), "err");
        assert!(!out.ok());
    }
}

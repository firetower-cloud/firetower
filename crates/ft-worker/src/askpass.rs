//! Handing a credential to git without writing it anywhere.
//!
//! The obvious approaches all leak. A token in the remote URL is written to
//! `.git/config` in plaintext and stays in the reflog. A token in `argv` is
//! visible to `ps`. A token in an environment variable lives for the whole
//! process and appears in `ps e` on some platforms.
//!
//! So the credential stays in the worker's memory and git fetches it over a
//! socket that exists only while the command runs. What the environment carries
//! is the socket's path, which is not a secret.
//!
//! None of this defends against something already running as you — an agent in
//! a workspace could read our memory. What it does buy is that nothing durable
//! is left behind: no file, no config entry, no history.

use anyhow::{Context, Result};
use ft_proto::Credential;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::task::JoinHandle;

/// A live credential server. Dropping it stops answering and removes the socket.
pub struct Askpass {
    dir: tempfile::TempDir,
    socket: PathBuf,
    /// What `GIT_ASKPASS` points at — a script, not the binary.
    bridge: PathBuf,
    server: JoinHandle<()>,
}

impl Askpass {
    /// Start serving `credential` to whatever connects, until dropped.
    ///
    /// `helper` is the program that knows how to reach the socket — our own
    /// binary. It is not what `GIT_ASKPASS` points at: see below.
    pub async fn start(credential: Credential, helper: &Path) -> Result<Self> {
        // 0700 by construction, so the socket isn't world-connectable.
        let dir = tempfile::Builder::new()
            .prefix("firetower-cred-")
            .tempdir()
            .context("creating the credential socket directory")?;
        let socket = dir.path().join("sock");

        let listener =
            UnixListener::bind(&socket).with_context(|| format!("binding {}", socket.display()))?;

        // git runs `$GIT_ASKPASS "<prompt>"` — no subcommand, ever. Pointing it
        // straight at our binary means the prompt arrives where a subcommand
        // name is expected, and the program exits with a usage error rather
        // than answering. This one-line script bridges git's contract to ours.
        let bridge = dir.path().join("askpass");
        tokio::fs::write(
            &bridge,
            format!("#!/bin/sh\nexec {} askpass \"$@\"\n", helper.display()),
        )
        .await
        .context("writing the askpass bridge")?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&bridge, std::fs::Permissions::from_mode(0o700))
                .await
                .context("making the askpass bridge executable")?;
        }

        let server = tokio::spawn(async move {
            // git asks twice — once for the username, once for the password —
            // and may retry, so this serves until the command is done with it.
            while let Ok((stream, _)) = listener.accept().await {
                let credential = credential.clone();
                tokio::spawn(async move {
                    let _ = answer(stream, credential).await;
                });
            }
        });

        Ok(Self {
            dir,
            socket,
            bridge,
            server,
        })
    }

    /// What to put in git's environment so it asks us.
    pub fn env(&self) -> Vec<(String, String)> {
        vec![
            ("GIT_ASKPASS".into(), self.bridge.display().to_string()),
            (
                super::askpass::SOCKET_VAR.into(),
                self.socket.display().to_string(),
            ),
            // Without this, a repository we can't read makes git block on a
            // terminal that isn't there. A probe that hangs is worse than one
            // that fails.
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ]
    }

    /// Keeps the directory alive for as long as the socket is needed.
    pub fn path(&self) -> &Path {
        self.dir.path()
    }
}

impl Drop for Askpass {
    fn drop(&mut self) {
        self.server.abort();
    }
}

/// Where the helper looks for the socket. The path is not a secret.
pub const SOCKET_VAR: &str = "FIRETOWER_ASKPASS_SOCK";

/// One exchange: git's prompt in, the matching value out.
async fn answer(stream: UnixStream, credential: Credential) -> Result<()> {
    let mut reader = BufReader::new(stream);
    let mut prompt = String::new();
    reader.read_line(&mut prompt).await?;

    // "Username for 'https://host': " or "Password for 'https://u@host': "
    let value = if prompt
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("username")
    {
        &credential.username
    } else {
        &credential.secret
    };

    let stream = reader.get_mut();
    stream.write_all(value.as_bytes()).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    Ok(())
}

/// The other end, run as `firetower askpass <prompt>` by git itself.
///
/// Prints the value on stdout, which is the entire `GIT_ASKPASS` contract.
pub async fn respond_as_helper(prompt: &str) -> Result<String> {
    let socket = std::env::var(SOCKET_VAR)
        .with_context(|| format!("{SOCKET_VAR} is not set — git called us unexpectedly"))?;

    let mut stream = UnixStream::connect(&socket)
        .await
        .with_context(|| format!("connecting to {socket}"))?;

    stream.write_all(prompt.as_bytes()).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    stream.shutdown().await.ok();

    let mut reader = BufReader::new(stream);
    let mut value = String::new();
    reader.read_line(&mut value).await?;
    Ok(value.trim_end_matches('\n').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn it_answers_the_username_and_the_password_differently() {
        let credential = Credential {
            username: "x-access-token".into(),
            secret: "s3cret".into(),
        };
        let helper = PathBuf::from("/nonexistent");
        let server = Askpass::start(credential, &helper).await.unwrap();

        // stand in for git, which sets this before calling the helper
        std::env::set_var(SOCKET_VAR, server.env()[1].1.clone());

        let user = respond_as_helper("Username for 'https://example.com': ")
            .await
            .unwrap();
        let pass = respond_as_helper("Password for 'https://x@example.com': ")
            .await
            .unwrap();

        assert_eq!(user, "x-access-token");
        assert_eq!(pass, "s3cret");
    }

    #[tokio::test]
    async fn the_socket_goes_away_with_the_server() {
        let credential = Credential {
            username: "u".into(),
            secret: "s".into(),
        };
        let path;
        {
            let server = Askpass::start(credential, Path::new("/nonexistent"))
                .await
                .unwrap();
            path = server.path().to_path_buf();
            assert!(path.join("sock").exists());
        }
        assert!(!path.exists(), "the credential socket outlived its command");
    }
}

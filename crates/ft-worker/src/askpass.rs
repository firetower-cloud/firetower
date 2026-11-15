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

/// A path as one shell word, whatever is in it.
///
/// **This was interpolated bare, and a path is not a shell word.** The script
/// is generated from `current_exe()`, which is wherever this binary happens
/// to live — and on a machine where that path contained a parenthesis, the
/// bridge came out as `exec /tmp/x/firetower-worker (1) askpass "$@"`. Under
/// dash that is a syntax error at line 2, so git got no credential and every
/// fetch failed with `unable to read askpass response`. Nothing said the
/// script was the problem.
///
/// Single quotes, because inside them a POSIX shell takes every character
/// literally — spaces, brackets, `$`, backslashes, newlines. The one
/// character that cannot appear is a single quote itself, so each one is
/// closed, escaped and reopened: `'it'\''s'`. That is the whole of it, and it
/// is exact rather than a list of characters somebody remembered.
fn quoted(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
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
            format!("#!/bin/sh\nexec {} askpass \"$@\"\n", quoted(helper)),
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

    /// **The bridge has to survive the path it is generated from.**
    ///
    /// A parenthesis in `current_exe()` produced `exec …/worker (1) askpass
    /// "$@"`, which dash rejects at line 2 — so git got no credential and
    /// every fetch failed saying it could not read the askpass response.
    /// Nothing in that message mentions the script.
    ///
    /// Checked two ways, because a syntax check passes things that do not
    /// run: `sh -n` is the failure that was reported, and executing it is the
    /// thing that actually has to work. The helper here is a script of its
    /// own that writes down what it was called with, so this asserts the
    /// arguments arrive as well.
    #[tokio::test]
    async fn the_bridge_survives_a_path_a_shell_would_choke_on() {
        let home = tempfile::tempdir().unwrap();
        let awkward = home.path().join("Firetower (dev) 2.0");
        tokio::fs::create_dir_all(&awkward).await.unwrap();
        let helper = awkward.join("firetower-worker (1)");
        let said = awkward.join("said");
        tokio::fs::write(
            &helper,
            format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\n", quoted(&said)),
        )
        .await
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700))
                .await
                .unwrap();
        }

        let server = Askpass::start(
            Credential {
                username: "u".into(),
                secret: "s".into(),
            },
            &helper,
        )
        .await
        .unwrap();
        let bridge = server.env()[0].1.clone();

        let checked = tokio::process::Command::new("/bin/sh")
            .arg("-n")
            .arg(&bridge)
            .output()
            .await
            .unwrap();
        assert!(
            checked.status.success(),
            "the bridge is not a script this shell can read: {}",
            String::from_utf8_lossy(&checked.stderr)
        );

        let ran = tokio::process::Command::new(&bridge)
            .arg("Password for 'https://x@example.com': ")
            .output()
            .await
            .unwrap();
        assert!(
            ran.status.success(),
            "the bridge did not run: {}",
            String::from_utf8_lossy(&ran.stderr)
        );
        let args = tokio::fs::read_to_string(&said).await.unwrap();
        assert_eq!(
            args.lines().next(),
            Some("askpass"),
            "git's prompt has to arrive after our own subcommand: {args:?}"
        );
    }

    /// Every character a path can hold and a shell can misread.
    #[test]
    fn a_path_becomes_one_shell_word() {
        assert_eq!(quoted(Path::new("/tmp/plain")), "'/tmp/plain'");
        assert_eq!(
            quoted(Path::new("/tmp/with (1)/and a space")),
            "'/tmp/with (1)/and a space'"
        );
        assert_eq!(
            quoted(Path::new("/tmp/$HOME;rm -rf /")),
            "'/tmp/$HOME;rm -rf /'"
        );
        // The one character single quotes cannot hold: closed, escaped,
        // reopened.
        assert_eq!(quoted(Path::new("/tmp/it's")), "'/tmp/it'\\''s'");
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

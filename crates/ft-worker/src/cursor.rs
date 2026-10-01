//! Browser sign-in for Cursor Agent using its file credential store.
//!
//! The CLI normally uses the macOS Keychain. A worker needs a portable file
//! for the control-plane vault, so each login gets a private HOME and opts in
//! to Cursor's file store. Only `.cursor/auth.json` leaves that temporary home.
use anyhow::{bail, Context, Result};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader, Lines},
    process::{Child, ChildStdout, Command},
    task::JoinHandle,
};

const TO_LINK: Duration = Duration::from_secs(20);
const EXPIRES: Duration = Duration::from_secs(600);
const DIAGNOSTIC_WAIT: Duration = Duration::from_secs(2);

pub struct Pending {
    pub user_code: String,
    pub verification_url: String,
}

pub struct Waiting {
    child: Child,
    lines: Lines<BufReader<ChildStdout>>,
    stderr: JoinHandle<Vec<u8>>,
    home: PathBuf,
}

/// Drain the CLI's error pipe without ever putting its raw text in a journal.
/// Error messages can contain login links or account identifiers; only a
/// coarse actionable category is exposed to the account connection flow.
async fn limited_stderr(mut pipe: impl AsyncRead + Unpin) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut buf = [0; 1024];
    while let Ok(n) = pipe.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let room = 8192usize.saturating_sub(kept.len());
        kept.extend_from_slice(&buf[..n.min(room)]);
    }
    kept
}

fn failure_hint(stderr: &[u8]) -> &'static str {
    let message = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if [
        "quota",
        "rate limit",
        "usage limit",
        "billing",
        "entitlement",
    ]
    .iter()
    .any(|word| message.contains(word))
    {
        "Cursor account usage or entitlement was refused; check the account dashboard"
    } else if [
        "unauthorized",
        "forbidden",
        "authentication",
        "not logged in",
    ]
    .iter()
    .any(|word| message.contains(word))
    {
        "Cursor rejected authentication; reconnect this account"
    } else if ["network", "timeout", "timed out", "enotfound", "connect"]
        .iter()
        .any(|word| message.contains(word))
    {
        "the worker could not reach Cursor; check its network access"
    } else {
        "retry account connection and check the worker's Cursor network access"
    }
}

/// Make macOS's `~/.cursor/auth.json` and Linux's
/// `$XDG_CONFIG_HOME/cursor/auth.json` resolve to the same private file.
pub async fn prepare_home(home: &Path) -> Result<()> {
    let credentials = home.join(".cursor");
    tokio::fs::create_dir_all(&credentials).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{symlink, PermissionsExt};
        tokio::fs::set_permissions(&credentials, std::fs::Permissions::from_mode(0o700)).await?;
        let alias = home.join("cursor");
        match tokio::fs::symlink_metadata(&alias).await {
            Ok(meta)
                if meta.file_type().is_symlink()
                    && tokio::fs::read_link(&alias).await? == Path::new(".cursor") =>
            {
                ()
            }
            Ok(_) => bail!("Cursor credential alias is not the expected private symlink"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => symlink(".cursor", &alias)?,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

pub async fn start(state: &Path, home: &Path) -> Result<(Pending, Waiting)> {
    tokio::fs::create_dir_all(home).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700)).await?;
    }
    prepare_home(home).await?;
    let mut command = Command::new("cursor-agent");
    command
        .arg("login")
        .env("HOME", home)
        .env("AGENT_CLI_CREDENTIAL_STORE", "file")
        .env("NO_OPEN_BROWSER", "1")
        .env("CURSOR_CONFIG_DIR", home.join("config"))
        .env("CURSOR_DATA_DIR", home.join("data"))
        .env("XDG_CONFIG_HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::runtime::with_agents(&mut command, state).await;
    let mut child = command.spawn().context("starting Cursor Agent login")?;
    let stdout = child.stdout.take().context("Cursor login has no stdout")?;
    let stderr = tokio::spawn(limited_stderr(
        child.stderr.take().context("Cursor login has no stderr")?,
    ));
    let mut lines = BufReader::new(stdout).lines();
    let pending = match tokio::time::timeout(TO_LINK, read_link(&mut lines)).await {
        Ok(Ok(pending)) => pending,
        Ok(Err(error)) => {
            let status = match tokio::time::timeout(DIAGNOSTIC_WAIT, child.wait()).await {
                Ok(status) => status?,
                Err(_) => {
                    let _ = child.start_kill();
                    bail!("{error}; Cursor login stayed open after closing its output");
                }
            };
            let details = tokio::time::timeout(DIAGNOSTIC_WAIT, stderr)
                .await
                .ok()
                .and_then(|result| result.ok())
                .unwrap_or_default();
            bail!(
                "{error}; process exited with {status}: {}",
                failure_hint(&details)
            );
        }
        Err(_) => {
            let _ = child.start_kill();
            bail!("Cursor Agent login did not print a link within 20 seconds; check that the worker can reach cursor.com and retry sign-in");
        }
    };
    Ok((
        pending,
        Waiting {
            child,
            lines,
            stderr,
            home: home.to_path_buf(),
        },
    ))
}

async fn read_link<R: tokio::io::AsyncBufRead + Unpin>(lines: &mut Lines<R>) -> Result<Pending> {
    while let Some(line) = lines.next_line().await? {
        if let Some(at) = line.find("https://cursor.com/loginDeepControl?") {
            let url: String = line[at..]
                .chars()
                .take_while(|c| !c.is_whitespace())
                .collect();
            return Ok(Pending {
                user_code: String::new(),
                verification_url: url,
            });
        }
    }
    bail!("Cursor Agent login exited before printing its browser link; check the worker's Cursor network access and retry sign-in")
}

impl Waiting {
    pub async fn finish(mut self) -> Result<Vec<u8>> {
        let outcome = tokio::time::timeout(EXPIRES, async {
            while self.lines.next_line().await?.is_some() {}
            let status = self.child.wait().await?;
            let details = tokio::time::timeout(DIAGNOSTIC_WAIT, self.stderr)
                .await
                .ok()
                .and_then(|result| result.ok())
                .unwrap_or_default();
            anyhow::ensure!(
                status.success(),
                "Cursor Agent login failed with {status}: {}",
                failure_hint(&details)
            );
            let path = self.home.join(".cursor/auth.json");
            let bytes = tokio::fs::read(&path).await.context(
                "Cursor login completed without a portable auth file; reconnect the account",
            )?;
            anyhow::ensure!(
                !bytes.is_empty(),
                "Cursor auth file is empty; reconnect the account"
            );
            Ok::<_, anyhow::Error>(bytes)
        })
        .await;
        let _ = self.child.start_kill();
        outcome.context("Cursor login link expired")?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn parses_browser_login_without_inventing_a_device_code() {
        let output = b"Starting login process...\nOpen a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=abc&uuid=def\n";
        let mut lines = BufReader::new(&output[..]).lines();
        let pending = read_link(&mut lines).await.unwrap();
        assert!(pending.user_code.is_empty());
        assert_eq!(
            pending.verification_url,
            "https://cursor.com/loginDeepControl?challenge=abc&uuid=def"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn one_private_credential_path_serves_macos_and_linux() {
        let temp = tempfile::tempdir().unwrap();
        prepare_home(temp.path()).await.unwrap();
        let native = temp.path().join(".cursor/auth.json");
        tokio::fs::write(&native, b"fixture").await.unwrap();
        assert_eq!(
            tokio::fs::read(temp.path().join("cursor/auth.json"))
                .await
                .unwrap(),
            b"fixture"
        );
    }

    #[test]
    fn login_errors_expose_a_cause_without_echoing_provider_text() {
        assert!(
            failure_hint(b"billing quota exhausted for account someone@example.com")
                .contains("usage or entitlement")
        );
        assert!(failure_hint(b"Unauthorized token abc123").contains("reconnect"));
        assert!(!failure_hint(b"Unauthorized token abc123").contains("abc123"));
    }
}

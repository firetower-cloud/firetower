//! Worker-mediated browser sign-in for Mistral Vibe.
//!
//! Vibe's ACP server can delegate browser authentication to its client. The
//! worker starts the attempt, sends the sign-in URL to the control plane, and
//! keeps `vibe-acp` alive while the user approves it. Completion returns an API
//! key, which Vibe writes to `.env` when the OS keyring is disabled. Firetower
//! vaults only that file; no Mistral model or session request is made here.

use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const AUTH_METHOD: &str = "browser-auth-delegated";
/// The first PyInstaller start took about 25 seconds on macOS before Vibe
/// answered `--version`; leave headroom for cold ACP startup and sign-in setup.
const TO_LINK: Duration = Duration::from_secs(45);
/// Bound approval polling. Vibe's delegated auth keeps the provider attempt
/// alive for a limited time and this gives the user ten minutes to approve it.
const EXPIRES: Duration = Duration::from_secs(10 * 60);
const REAP: Duration = Duration::from_secs(2);

/// What the user needs to finish Mistral's browser sign-in.
#[derive(Debug, Clone)]
pub struct Pending {
    /// Mistral uses a link instead of a short code.
    pub user_code: String,
    /// Query parameters are part of this temporary sign-in link. Keep it out
    /// of logs and errors; the account connection UI is the only recipient.
    pub verification_url: String,
}

/// A delegated sign-in attempt that is waiting for approval.
pub struct Waiting {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    attempt_id: String,
    home: PathBuf,
}

/// Ask Vibe to start a delegated Mistral sign-in in a fresh, private home.
///
/// `VIBE_HOME` keeps settings and credentials away from the worker operator's
/// account. The keyring-disable and telemetry settings come from
/// `Agent::env`; an inherited API key is removed so it cannot shadow the
/// account being connected.
pub async fn start(state: &Path, home: &Path) -> Result<(Pending, Waiting)> {
    tokio::fs::create_dir_all(home)
        .await
        .context("making the private Mistral Vibe home")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700))
            .await
            .context("protecting the private Mistral Vibe home")?;
    }

    // A login must start without an earlier credential that could be returned
    // as if it belonged to this account connection.
    match tokio::fs::symlink_metadata(home.join(".env")).await {
        Ok(_) => bail!("the private Mistral Vibe home already contains credentials"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("checking the private Mistral Vibe home"),
    }

    let mut command = Command::new(ft_core::Agent::MistralVibe.command());
    command
        .env_remove("VIBE_HOME")
        .env("VIBE_HOME", home)
        .env_remove("MISTRAL_API_KEY")
        .envs(ft_core::Agent::MistralVibe.env().iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // ACP diagnostics can contain provider details. They are not needed
        // for the user-facing sign-in result.
        .stderr(Stdio::null())
        // Dropping a pending login must stop Vibe's process as well.
        .kill_on_drop(true);
    crate::runtime::with_agents(&mut command, state).await;
    start_with_command(command, home).await
}

async fn start_with_command(mut command: Command, home: &Path) -> Result<(Pending, Waiting)> {
    let mut child = command
        .spawn()
        .context("starting Mistral Vibe ACP sign-in — is Mistral Vibe installed on this host?")?;
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            stop_child(&mut child).await;
            bail!("Mistral Vibe ACP has no input stream");
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            stop_child(&mut child).await;
            bail!("Mistral Vibe ACP has no output stream");
        }
    };
    let mut stdin = stdin;
    let mut lines = BufReader::new(stdout).lines();

    let handshake = tokio::time::timeout(TO_LINK, async {
        let initialized = rpc_call(
            &mut stdin,
            &mut lines,
            1,
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientInfo": {
                    "name": "firetower",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                // Vibe maps ACP `clientCapabilities._meta` into
                // `ClientCapabilities.field_meta` and only advertises the
                // delegated flow when this opt-in is true.
                "clientCapabilities": {
                    "_meta": { "browser-auth-delegated": true }
                },
            }),
        )
        .await?;
        ensure!(
            initialized.get("protocolVersion").and_then(Value::as_u64) == Some(1),
            "Mistral Vibe negotiated an unsupported ACP protocol version"
        );
        ensure!(
            advertises_auth_method(&initialized, AUTH_METHOD),
            "Mistral Vibe did not advertise delegated browser sign-in"
        );

        let started = rpc_call(
            &mut stdin,
            &mut lines,
            2,
            "authenticate",
            json!({ "methodId": AUTH_METHOD, "action": "start" }),
        )
        .await?;
        let (pending, attempt_id) = parse_started_auth(&started)?;
        Ok::<_, anyhow::Error>((pending, attempt_id))
    })
    .await;

    let (pending, attempt_id) = match handshake {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            stop_child(&mut child).await;
            return Err(error);
        }
        Err(_) => {
            stop_child(&mut child).await;
            bail!("Mistral Vibe did not return a browser sign-in link within 45 seconds; check the worker network and retry")
        }
    };

    Ok((
        pending,
        Waiting {
            child,
            stdin,
            lines,
            attempt_id,
            home: home.to_path_buf(),
        },
    ))
}

impl Waiting {
    /// Wait for approval, then return only the portable Mistral API key file.
    pub async fn finish(mut self) -> Result<Vec<u8>> {
        let outcome = tokio::time::timeout(EXPIRES, self.complete()).await;
        stop_child(&mut self.child).await;

        match outcome {
            Err(_) => bail!("Mistral browser sign-in expired; start a new account connection"),
            Ok(Err(error)) => Err(error),
            Ok(Ok(())) => collect_key_file(&self.home).await,
        }
    }

    /// Abandon the remote poll and stop the process that owns the attempt.
    pub async fn cancel(mut self) -> Result<()> {
        stop_child(&mut self.child).await;
        Ok(())
    }

    async fn complete(&mut self) -> Result<()> {
        let response = rpc_call(
            &mut self.stdin,
            &mut self.lines,
            3,
            "authenticate",
            json!({
                "methodId": AUTH_METHOD,
                "action": "complete",
                "attemptId": self.attempt_id,
            }),
        )
        .await?;
        ensure!(
            auth_completed(&response),
            "Mistral Vibe did not confirm that browser sign-in completed"
        );
        Ok(())
    }
}

async fn rpc_call(
    stdin: &mut ChildStdin,
    lines: &mut Lines<BufReader<ChildStdout>>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value> {
    let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    stdin
        .write_all(format!("{request}\n").as_bytes())
        .await
        .with_context(|| format!("sending Mistral Vibe ACP {method}"))?;
    stdin.flush().await.ok();
    next_result(lines, id, method).await
}

/// Read past notifications and replies to earlier calls until this call's ID
/// answers. Provider error messages are intentionally discarded: they may
/// contain the temporary sign-in URL or an account identifier.
async fn next_result<R>(lines: &mut Lines<BufReader<R>>, id: u64, method: &str) -> Result<Value>
where
    R: AsyncRead + Unpin,
{
    while let Some(line) = lines.next_line().await? {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // A server-initiated ACP request can use the same numeric ID as one
        // of our requests because JSON-RPC IDs are directional. It is not a
        // response, so it must not be mistaken for this call's answer.
        if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
            || value.get("method").is_some()
        {
            continue;
        }
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            let code = error
                .get("code")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            bail!("Mistral Vibe refused ACP {method} (JSON-RPC error {code})");
        }
        return value
            .get("result")
            .cloned()
            .with_context(|| format!("Mistral Vibe's ACP {method} reply had no result"));
    }
    bail!("Mistral Vibe ACP stopped before answering {method}")
}

fn advertises_auth_method(initialized: &Value, expected: &str) -> bool {
    initialized
        .get("authMethods")
        .and_then(Value::as_array)
        .is_some_and(|methods| {
            methods
                .iter()
                .any(|method| method.get("id").and_then(Value::as_str) == Some(expected))
        })
}

fn parse_started_auth(result: &Value) -> Result<(Pending, String)> {
    let details = result
        .get("_meta")
        .and_then(|meta| meta.get(AUTH_METHOD))
        .context("Mistral Vibe's delegated sign-in reply had no auth metadata")?;
    let attempt_id = details
        .get("attemptId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .context("Mistral Vibe's delegated sign-in reply had no attempt ID")?
        .to_string();
    let url = details
        .get("signInUrl")
        .and_then(Value::as_str)
        .filter(|url| is_mistral_signin_url(url))
        .context("Mistral Vibe's delegated sign-in reply had no valid sign-in URL")?
        .to_string();

    Ok((
        Pending {
            user_code: String::new(),
            verification_url: url,
        },
        attempt_id,
    ))
}

fn is_mistral_signin_url(url: &str) -> bool {
    url.strip_prefix("https://console.mistral.ai/")
        .is_some_and(|path| !path.is_empty())
}

fn auth_completed(result: &Value) -> bool {
    result
        .get("_meta")
        .and_then(|meta| meta.get(AUTH_METHOD))
        .and_then(|details| details.get("status"))
        .and_then(Value::as_str)
        == Some("completed")
}

async fn collect_key_file(home: &Path) -> Result<Vec<u8>> {
    let path = home.join(".env");
    let metadata = tokio::fs::symlink_metadata(&path)
        .await
        .context("Mistral Vibe completed sign-in but wrote no .env credential file")?;
    ensure!(
        metadata.file_type().is_file(),
        "Mistral Vibe's .env credential is not a regular file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode & !0o077))
                .await
                .context("protecting the Mistral Vibe credential file")?;
        }
    }

    let bytes = tokio::fs::read(&path)
        .await
        .context("reading the Mistral Vibe credential file")?;
    let text =
        std::str::from_utf8(&bytes).context("Mistral Vibe's .env credential file is not UTF-8")?;
    let parsed = ft_core::dotenv::parse(text);
    let key = parsed
        .variables
        .iter()
        .find(|variable| variable.name == "MISTRAL_API_KEY")
        .map(|variable| variable.value.as_str())
        .filter(|value| !value.trim().is_empty())
        .context("Mistral Vibe completed sign-in but wrote no API key")?;

    // The home is fresh, but only the key itself belongs in Firetower's vault.
    // If Vibe or an ambient setup added other variables, do not carry them.
    Ok(ft_core::dotenv::render(&[ft_core::dotenv::Variable {
        name: "MISTRAL_API_KEY".into(),
        value: key.into(),
    }])
    .into_bytes())
}

async fn stop_child(child: &mut Child) {
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.start_kill();
    }
    let _ = tokio::time::timeout(REAP, child.wait()).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_mistral_console_links_are_returned() {
        assert!(is_mistral_signin_url(
            "https://console.mistral.ai/codestral/cli/authenticate?challenge=private"
        ));
        assert!(!is_mistral_signin_url(
            "http://console.mistral.ai/codestral/cli/authenticate?challenge=private"
        ));
        assert!(!is_mistral_signin_url(
            "https://evil.example/codestral/cli/authenticate?challenge=private"
        ));
    }

    #[test]
    fn delegated_auth_uses_acp_metadata_and_keeps_the_attempt_id_private() {
        let result = json!({
            "_meta": {
                "browser-auth-delegated": {
                    "attemptId": "private-attempt",
                    "expiresAt": "2026-11-08T12:00:00Z",
                    "signInUrl": "https://console.mistral.ai/codestral/cli/authenticate?challenge=private",
                }
            }
        });
        let (pending, attempt_id) = parse_started_auth(&result).unwrap();
        assert!(pending.user_code.is_empty());
        assert!(pending
            .verification_url
            .starts_with("https://console.mistral.ai/"));
        assert_eq!(attempt_id, "private-attempt");
    }

    #[tokio::test]
    async fn response_reader_skips_notifications_and_correlates_the_id() {
        let stream = concat!(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":3,"method":"session/request_permission","params":{}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"result":{"wrong":true}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":3,"result":{"right":true}}"#,
            "\n",
        );
        let mut lines = BufReader::new(stream.as_bytes()).lines();
        let found = next_result(&mut lines, 3, "authenticate").await.unwrap();
        assert_eq!(found, json!({"right":true}));
    }

    #[tokio::test]
    async fn provider_error_text_is_not_returned_to_callers() {
        let stream = concat!(
            r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32000,"message":"https://console.mistral.ai/private?token=secret"}}"#,
            "\n",
        );
        let mut lines = BufReader::new(stream.as_bytes()).lines();
        let error = next_result(&mut lines, 4, "authenticate")
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("-32000"));
        assert!(!error.contains("console.mistral.ai"));
        assert!(!error.contains("secret"));
    }

    #[tokio::test]
    async fn collection_returns_only_a_nonempty_key_file() {
        let home = tempfile::tempdir().unwrap();
        tokio::fs::write(
            home.path().join(".env"),
            "# Vibe credential\nexport MISTRAL_API_KEY='key=with=equals'\nOTHER_SECRET=do-not-vault\n",
        )
        .await
        .unwrap();
        let bytes = collect_key_file(home.path()).await.unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        let parsed = ft_core::dotenv::parse(text);
        assert_eq!(parsed.variables.len(), 1);
        assert_eq!(parsed.variables[0].name, "MISTRAL_API_KEY");
        assert_eq!(parsed.variables[0].value, "key=with=equals");
        assert!(!text.contains("OTHER_SECRET"));
    }

    #[tokio::test]
    async fn an_empty_or_missing_key_file_is_refused_without_echoing_contents() {
        let home = tempfile::tempdir().unwrap();
        assert!(collect_key_file(home.path()).await.is_err());
        tokio::fs::write(home.path().join(".env"), "MISTRAL_API_KEY=''\n")
            .await
            .unwrap();
        let error = collect_key_file(home.path()).await.unwrap_err().to_string();
        assert!(error.contains("no API key"));
        assert!(!error.contains("''"));
    }

    /// Starts the real ACP auth flow and stops it as soon as Vibe returns the
    /// browser link. It never opens the link, completes sign-in, or makes a
    /// model request. The full link stays in memory and is not printed.
    #[tokio::test]
    #[ignore = "requires vibe-acp on PATH and network access; does not approve sign-in"]
    async fn real_vibe_acp_advertises_and_starts_delegated_browser_auth() {
        let state = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (pending, waiting) = start(state.path(), home.path())
            .await
            .expect("Vibe should advertise delegated browser sign-in");
        assert!(pending.user_code.is_empty());
        assert!(pending
            .verification_url
            .starts_with("https://console.mistral.ai/"));
        waiting.cancel().await.unwrap();
    }
}

//! Signing Codex in on a host that has no browser.
//!
//! Codex's ordinary login serves a page on `localhost:1455` and waits for a
//! browser to arrive. That works on a laptop and cannot work here: the browser
//! is on somebody's desk and the agent is in a container on a server, and
//! nothing connects the two. So we drive the other variant — a device code —
//! where the machine asks OpenAI for a short code, a person approves that code
//! from wherever they are, and the tokens are delivered to the machine that
//! asked.
//!
//! **Nothing about the credential passes through the person's browser**, and
//! nothing passes through Firetower on the way in. What the browser does is
//! prove to OpenAI that the machine asking is asking on somebody's behalf.
//!
//! This is the same shape as the GitHub sign-in Firetower already has, down to
//! the two fields worth showing: a code, and where to type it.
//!
//! ## Why the app-server rather than `codex login --device-auth`
//!
//! The CLI does the same thing and prints it as prose, in colour, for a person
//! to read. The app-server answers with `{ loginId, userCode, verificationUrl }`
//! and says when it finished. Parsing the first would mean depending on
//! sentences somebody is free to rewrite.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// How long a device code stays good.
///
/// Theirs, not ours — the CLI says fifteen minutes. We hold the same number so
/// that a caller waiting on us gives up with something to say instead of
/// hanging until a socket notices.
const EXPIRES: Duration = Duration::from_secs(15 * 60);

/// The file Codex keeps its credential in, inside a `CODEX_HOME`.
pub const AUTH: &str = "auth.json";

/// What to show somebody so they can approve this machine.
#[derive(Debug, Clone)]
pub struct Pending {
    /// The code to type. Short, and meant to be read aloud.
    pub user_code: String,
    /// Where to type it.
    pub verification_url: String,
    /// Codex's handle for this attempt, needed only to cancel it.
    pub login_id: String,
}

/// A login that has been started and is waiting for a person.
///
/// Holds the app-server open, because the process that asked for the code is
/// the one being told the answer. Dropping this abandons the attempt.
pub struct Waiting {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    login_id: String,
    home: PathBuf,
}

/// Ask for a device code, in a `CODEX_HOME` of the caller's choosing.
///
/// `home` is where the credential will land, so it is the caller's business
/// where that is: a scratch directory it intends to read and destroy, or a
/// person's own directory on this host.
pub async fn start(state: &Path, home: &Path) -> Result<(Pending, Waiting)> {
    tokio::fs::create_dir_all(home)
        .await
        .with_context(|| format!("making {}", home.display()))?;

    let mut command = Command::new(ft_core::Agent::Codex.command());
    command
        .arg("app-server")
        .env("CODEX_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Its own diagnostics are not ours to relay, and a full pipe nobody
        // reads would eventually block it.
        .stderr(Stdio::null())
        // An abandoned login must not leave a process polling OpenAI for
        // fifteen minutes. Dropping the handle is how giving up is spelled
        // here, so dropping it has to be what stops it.
        .kill_on_drop(true);
    crate::runtime::with_agents(&mut command, state).await;

    let mut child = command
        .spawn()
        .context("starting the Codex app-server — is Codex installed on this host?")?;

    let mut stdin = child.stdin.take().context("app-server has no stdin")?;
    let stdout = child.stdout.take().context("app-server has no stdout")?;
    let mut lines = BufReader::new(stdout).lines();

    // It will not answer anything else until this one.
    call(
        &mut stdin,
        &mut lines,
        1,
        "initialize",
        json!({
            "clientInfo": {
                "name": "firetower",
                "version": env!("CARGO_PKG_VERSION"),
            }
        }),
    )
    .await
    .context("the app-server would not start a conversation")?;

    let started = call(
        &mut stdin,
        &mut lines,
        2,
        "account/login/start",
        json!({ "type": "chatgptDeviceCode" }),
    )
    .await
    .context("asking for a device code")?;

    let login_id = field(&started, "loginId")?;
    let pending = Pending {
        user_code: field(&started, "userCode")?,
        verification_url: field(&started, "verificationUrl")?,
        login_id: login_id.clone(),
    };

    Ok((
        pending,
        Waiting {
            child,
            stdin,
            lines,
            login_id,
            home: home.to_path_buf(),
        },
    ))
}

impl Waiting {
    /// Wait for somebody to approve it, then hand back the credential.
    ///
    /// Returns the bytes of `auth.json` rather than a parsed thing on purpose:
    /// its shape is Codex's to change, and everything Firetower does with it —
    /// store it, write it back out — works on the file as it found it.
    pub async fn finish(mut self) -> Result<Vec<u8>> {
        let outcome = tokio::time::timeout(EXPIRES, self.completed()).await;
        // Whatever happened, this process has no further use.
        let _ = self.child.start_kill();

        match outcome {
            Err(_) => bail!("nobody approved the code before it expired"),
            Ok(Err(e)) => Err(e),
            Ok(Ok(())) => {
                let path = self.home.join(AUTH);
                tokio::fs::read(&path)
                    .await
                    .with_context(|| format!("Codex said it signed in but wrote no {AUTH}"))
            }
        }
    }

    /// Give up, and tell Codex so rather than just walking away.
    pub async fn cancel(mut self) -> Result<()> {
        let _ = call(
            &mut self.stdin,
            &mut self.lines,
            3,
            "account/login/cancel",
            json!({ "loginId": self.login_id }),
        )
        .await;
        let _ = self.child.start_kill();
        Ok(())
    }

    /// Read until it says the login finished.
    async fn completed(&mut self) -> Result<()> {
        while let Some(line) = self.lines.next_line().await? {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("method").and_then(Value::as_str) != Some("account/login/completed") {
                continue;
            }

            let params = value.get("params").cloned().unwrap_or(Value::Null);
            if params.get("success").and_then(Value::as_bool) == Some(true) {
                return Ok(());
            }
            let why = params
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Codex did not say why");
            bail!("the sign-in was refused: {why}");
        }
        bail!("the app-server stopped before the sign-in finished")
    }
}

/// One request, and the answer to it.
///
/// Skips anything that is not the answer. An app-server volunteers
/// notifications — what the daemon is doing, what changed elsewhere — and a
/// client that treated the next line as its reply would read one of those.
async fn call(
    stdin: &mut ChildStdin,
    lines: &mut Lines<BufReader<ChildStdout>>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value> {
    let request = json!({ "id": id, "method": method, "params": params });
    stdin
        .write_all(format!("{request}\n").as_bytes())
        .await
        .with_context(|| format!("sending {method}"))?;
    stdin.flush().await.ok();

    while let Some(line) = lines.next_line().await? {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("no reason given");
            bail!("{method} was refused: {message}");
        }
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }

    bail!("the app-server stopped without answering {method}")
}

/// One string out of a result, named in the error when it is not there.
fn field(value: &Value, name: &str) -> Result<String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_string)
        .with_context(|| format!("the app-server's answer had no {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole point of `call`: an app-server talks unprompted, and the next
    /// line after a request is often not the answer to it.
    #[tokio::test]
    async fn a_reply_is_found_past_the_notifications_in_front_of_it() {
        let stream = concat!(
            r#"{"method":"remoteControl/status/changed","params":{"status":"disabled"}}"#,
            "\n",
            r#"{"id":7,"result":{"userCode":"D4ZX-BRUC8"}}"#,
            "\n",
        );

        // The read half on its own is enough to test the skipping.
        let mut lines = BufReader::new(stream.as_bytes()).lines();
        let mut found = None;
        while let Some(line) = lines.next_line().await.unwrap() {
            let value: Value = serde_json::from_str(&line).unwrap();
            if value.get("id").and_then(Value::as_u64) == Some(7) {
                found = value.get("result").cloned();
                break;
            }
        }
        assert_eq!(
            found.as_ref().and_then(|r| r.get("userCode")),
            Some(&json!("D4ZX-BRUC8"))
        );
    }

    #[test]
    fn a_missing_field_says_which_one() {
        let said = field(&json!({ "userCode": "X" }), "verificationUrl").unwrap_err();
        assert!(
            said.to_string().contains("verificationUrl"),
            "the error has to name the field: {said}"
        );
    }
}

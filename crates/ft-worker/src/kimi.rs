//! Signing a Kimi account in on this machine, for the vault to keep.
//!
//! The same shape as [`crate::codex`], and for the same reason: the credential
//! is handed to whoever asked for the code, so the asking has to happen on a
//! host rather than in the control plane. Nothing about it travels through a
//! browser on our side.
//!
//! Kimi says this itself. Its ACP `initialize` reply advertises a terminal
//! auth method — `kimi acp --login`, with `KIMI_CODE_HOME` in the environment
//! it expects — which is exactly what this runs.
//!
//! What comes back is a *bundle*, not a file. Codex round-trips through
//! `auth.json`; Kimi splits the same thing between `config.toml`, which names
//! the provider, and `credentials/<hash>.json`, which holds the tokens. The
//! hash is not a name anything can predict, so both travel as a JSON object of
//! path to contents and are written back out exactly as they were found.
use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader, Lines};
use tokio::process::{Child, ChildStderr, Command};

/// How long a device code is good for. Kimi says 1800s; the wait is bounded
/// here so an abandoned sign-in cannot hold a process open forever.
const EXPIRES: Duration = Duration::from_secs(1800);

/// Getting as far as the code should be quick. If Kimi has not printed one by
/// now it is not going to, and the person is owed the reason rather than a
/// spinner.
const TO_CODE: Duration = Duration::from_secs(60);

/// What to show somebody so they can approve this machine.
#[derive(Debug, Clone)]
pub struct Pending {
    /// The short code. Shown, not clicked.
    pub user_code: String,
    /// Where to type it.
    pub verification_url: String,
}

/// A sign-in that has a code out and is waiting on a person.
pub struct Waiting {
    child: Child,
    lines: Lines<BufReader<ChildStderr>>,
    home: PathBuf,
}

/// Start `kimi acp --login` against a home of its own and read out the code.
///
/// `region` picks which Kimi the account lives on — `global` is kimi.ai and
/// `mainland-cn` is kimi.com. They are different account namespaces, so the
/// wrong one signs in successfully as the wrong person.
pub async fn start(state: &Path, home: &Path, region: &str) -> Result<(Pending, Waiting)> {
    tokio::fs::create_dir_all(home)
        .await
        .with_context(|| format!("making {}", home.display()))?;

    let mut command = Command::new(ft_core::Agent::KimiCode.command());
    command
        .arg("acp")
        .arg("--login")
        .arg("--region")
        .arg(region)
        .env("KIMI_CODE_HOME", home)
        .stdin(Stdio::null())
        // **stderr, not stdout.** Kimi prints the device code, the URL and the
        // word it finishes on to stderr and leaves stdout empty — stdout is
        // for the ACP stream this invocation never gets as far as. Reading the
        // other one meant waiting out the timeout on every single sign-in.
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // An abandoned login must not leave a process polling Kimi for half an
        // hour. Dropping the handle is how giving up is spelled here.
        .kill_on_drop(true);
    crate::runtime::with_agents(&mut command, state).await;

    let mut child = command
        .spawn()
        .context("starting the Kimi device login — is Kimi Code installed on this host?")?;
    let stderr = child.stderr.take().context("kimi login has no stderr")?;
    let mut lines = BufReader::new(stderr).lines();

    let pending = match tokio::time::timeout(TO_CODE, read_code(&mut lines)).await {
        Ok(found) => found?,
        Err(_) => {
            let _ = child.start_kill();
            bail!("Kimi did not print a device code");
        }
    };

    Ok((
        pending,
        Waiting {
            child,
            lines,
            home: home.to_path_buf(),
        },
    ))
}

/// Read until the device URL and code appear.
///
/// Kimi prints them as prose rather than as JSON, so this reads the prose. The
/// URL carries the code as `user_code`, which is what makes it parseable
/// without matching on the sentence around it.
async fn read_code<R: tokio::io::AsyncBufRead + Unpin>(lines: &mut Lines<R>) -> Result<Pending> {
    while let Some(line) = lines.next_line().await? {
        let Some(at) = line.find("https://") else {
            continue;
        };
        let url: String = line[at..]
            .chars()
            .take_while(|c| !c.is_whitespace())
            .collect();
        let Some(code) = url.split("user_code=").nth(1) else {
            continue;
        };
        let code = code
            .split('&')
            .next()
            .unwrap_or(code)
            .trim()
            .trim_end_matches('.')
            .to_string();
        if code.is_empty() {
            continue;
        }
        return Ok(Pending {
            user_code: code,
            verification_url: url,
        });
    }
    bail!("the Kimi login ended before it printed a code")
}

impl Waiting {
    /// Wait for somebody to approve it, then hand back the bundle.
    ///
    /// The bytes are a JSON object of relative path to file contents, which is
    /// what [`ft_core::Agent::credential_bundle`] says this agent stores. Its
    /// shape is Kimi's to change and nothing here reads inside the files.
    pub async fn finish(mut self) -> Result<Vec<u8>> {
        let outcome = tokio::time::timeout(EXPIRES, self.completed()).await;
        // Whatever happened, this process has no further use.
        let _ = self.child.start_kill();

        match outcome {
            Err(_) => bail!("nobody approved the code before it expired"),
            Ok(Err(e)) => Err(e),
            Ok(Ok(())) => collect(&self.home).await,
        }
    }

    /// Give up. There is nothing to tell Kimi — the device flow is a poll, and
    /// stopping the process is what abandoning it means.
    pub async fn cancel(mut self) -> Result<()> {
        let _ = self.child.start_kill();
        Ok(())
    }

    /// Read until it says the login finished.
    async fn completed(&mut self) -> Result<()> {
        while let Some(line) = self.lines.next_line().await? {
            let said = line.trim();
            if said.starts_with("Logged in") {
                return Ok(());
            }
            if let Some(why) = said.strip_prefix("Login failed:") {
                bail!("the sign-in was refused:{why}");
            }
        }
        bail!("the Kimi login ended without saying whether it worked")
    }
}

/// Everything the agent's home needs to be that account again.
///
/// `config.toml` and every file under `credentials/`. Only those: the same
/// directory also accumulates session records, logs and an update cache, and
/// none of that is a credential or belongs in a vault.
async fn collect(home: &Path) -> Result<Vec<u8>> {
    let mut bundle = Map::new();

    let config = home.join("config.toml");
    match tokio::fs::read_to_string(&config).await {
        Ok(text) => {
            bundle.insert("config.toml".into(), Value::String(text));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            bail!("Kimi said it signed in but wrote no config.toml")
        }
        Err(e) => return Err(e).context("reading config.toml"),
    }

    let dir = home.join("credentials");
    let mut entries = tokio::fs::read_dir(&dir)
        .await
        .context("Kimi said it signed in but wrote no credentials")?;
    let mut found = 0usize;
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let text = tokio::fs::read_to_string(entry.path())
            .await
            .with_context(|| format!("reading credentials/{name}"))?;
        bundle.insert(format!("credentials/{name}"), Value::String(text));
        found += 1;
    }
    if found == 0 {
        bail!("Kimi said it signed in but left no credential behind");
    }

    Ok(serde_json::to_vec(&json!(bundle))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn code_from(said: &str) -> Result<Pending> {
        let mut lines = BufReader::new(said.as_bytes()).lines();
        read_code(&mut lines).await
    }

    #[tokio::test]
    async fn the_code_is_read_out_of_the_url_rather_than_the_sentence() {
        // Kimi prints prose. The code is in the URL as well as the sentence,
        // and the URL is the part that is not phrasing.
        let said = "\nOpening browser for Kimi device login: https://www.kimi.ai/code/authorize_device?user_code=LNLO-O21O\nIf the browser did not open, paste the URL above and enter code: LNLO-O21O\nCode expires in 1800s.\n";
        let found = code_from(said).await.unwrap();
        assert_eq!(found.user_code, "LNLO-O21O");
        assert_eq!(
            found.verification_url,
            "https://www.kimi.ai/code/authorize_device?user_code=LNLO-O21O"
        );
    }

    #[tokio::test]
    async fn a_login_that_says_nothing_useful_is_an_error_not_an_empty_code() {
        assert!(code_from("starting\nsomething else\n").await.is_err());
    }

    #[tokio::test]
    async fn a_url_without_a_code_is_not_mistaken_for_one() {
        let said = "see https://www.kimi.ai/code for help\nhttps://www.kimi.ai/code/authorize_device?user_code=AAAA-BBBB\n";
        assert_eq!(code_from(said).await.unwrap().user_code, "AAAA-BBBB");
    }

    #[tokio::test]
    async fn the_bundle_carries_the_config_and_every_credential() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        tokio::fs::write(home.join("config.toml"), "default_model = \"x\"")
            .await
            .unwrap();
        tokio::fs::create_dir_all(home.join("credentials"))
            .await
            .unwrap();
        tokio::fs::write(home.join("credentials/kimi-code-env-abc.json"), "{\"a\":1}")
            .await
            .unwrap();
        // Logs and session records live here too, and are not credentials.
        tokio::fs::write(home.join("kimi.log"), "noise")
            .await
            .unwrap();

        let bytes = collect(home).await.unwrap();
        let bundle: std::collections::BTreeMap<String, String> =
            serde_json::from_slice(&bytes).unwrap();

        assert_eq!(bundle.len(), 2, "the log is not part of the credential");
        assert_eq!(bundle["config.toml"], "default_model = \"x\"");
        assert_eq!(bundle["credentials/kimi-code-env-abc.json"], "{\"a\":1}");
    }

    /// The one thing the unit tests above cannot catch: *which stream* a real
    /// Kimi prints the code on. Parsing was never the bug — reading stdout
    /// while Kimi wrote to stderr was, and no amount of feeding strings to
    /// `read_code` would have said so.
    ///
    /// Ignored because it needs `kimi` on `PATH` and reaches Moonshot's device
    /// endpoint. Run it against a real install after touching this file:
    /// `cargo test -p ft-worker kimi -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "needs a real kimi on PATH and the network"]
    async fn a_real_kimi_prints_its_code_where_we_read() {
        let state = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (pending, waiting) = start(state.path(), home.path(), "global")
            .await
            .expect("kimi should print a device code");

        assert!(
            pending.verification_url.starts_with("https://"),
            "{}",
            pending.verification_url
        );
        assert!(
            pending.user_code.len() >= 4,
            "a code, not an empty string: {:?}",
            pending.user_code
        );
        // Nobody is going to approve it, and leaving it polling for half an
        // hour is not this test's business.
        waiting.cancel().await.unwrap();
    }

    #[tokio::test]
    async fn a_home_with_no_credential_is_a_sign_in_that_did_not_happen() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("config.toml"), "x = 1")
            .await
            .unwrap();
        tokio::fs::create_dir_all(dir.path().join("credentials"))
            .await
            .unwrap();
        assert!(collect(dir.path()).await.is_err());
    }
}

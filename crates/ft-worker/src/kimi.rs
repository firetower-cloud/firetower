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
///
/// **Must stay under the control plane's `PROBE_TIMEOUT`, which is 30s.** That
/// side gives up on the whole request when its own clock runs out, and its
/// message is the generic one about a host not answering. This was 60s, so the
/// specific reason below could never reach anybody: every failure to read a
/// code was reported as a worker that had gone quiet. A real login prints its
/// code in about a second, so the headroom here is already generous.
const TO_CODE: Duration = Duration::from_secs(20);
/// How long to let the login process finish writing after it says it is done.
///
/// It exits of its own accord once the tokens are on disk; this is only the
/// bound on waiting for a process that has stopped behaving like one.
const SETTLE: Duration = Duration::from_secs(15);

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

        // "Logged in" is said before the tokens are on disk, and `kimi acp
        // --login` exits once they are — so the word is the wrong moment to
        // read and the exit is the right one. Killing at the word stored a
        // credential that looked entirely correct and was not: Kimi writes the
        // file as a skeleton when the flow starts and fills it in at the end,
        // so what got vaulted was `access_token: ""`, `expires_at: 0`. The
        // account then showed as connected and every session it ran failed with
        // `OAuthUnauthorizedError`, which is the worst shape a bug can have —
        // it looks like the agent's fault.
        if matches!(outcome, Ok(Ok(()))) {
            let _ = tokio::time::timeout(SETTLE, self.child.wait()).await;
        }
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
pub(crate) async fn collect(home: &Path) -> Result<Vec<u8>> {
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
    // The one thing read inside a file here, against the rule stated above,
    // because the alternative was proven worse: a skeleton credential vaults
    // cleanly, reports the account as connected, and fails every session it
    // runs with an error that reads like the agent's fault. If Kimi renames
    // this field the login fails loudly, which is the better of the two.
    if !signed(&bundle) {
        bail!(
            "Kimi wrote a credential with no token in it \u{2014} the sign-in did not finish. \
             Try again, and approve the code before it expires."
        );
    }

    Ok(serde_json::to_vec(&json!(bundle))?)
}

/// Whether any collected credential actually carries a token.
fn signed(bundle: &Map<String, Value>) -> bool {
    bundle.iter().any(|(name, body)| {
        name.starts_with("credentials/")
            && body
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .is_some_and(|json| {
                    json["access_token"].as_str().is_some_and(|t| !t.is_empty())
                })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The skeleton Kimi writes when a login starts is not a credential.
    ///
    /// Read at the wrong moment it vaults perfectly: right filename, right
    /// shape, every key present. Then the account shows connected and every
    /// session it runs dies with `OAuthUnauthorizedError`, which reads like the
    /// agent is broken rather than like the sign-in never finished.
    #[tokio::test]
    async fn a_credential_with_no_token_in_it_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        tokio::fs::write(home.join("config.toml"), "default_model = \"x\"")
            .await
            .unwrap();
        tokio::fs::create_dir_all(home.join("credentials"))
            .await
            .unwrap();
        // Verbatim from the one that was stored, tokens and all.
        tokio::fs::write(
            home.join("credentials/kimi-code-env-0e4f99c6.json"),
            r#"{"access_token":"","refresh_token":"","expires_at":0,"scope":"user_info","token_type":"Bearer","expires_in":0}"#,
        )
        .await
        .unwrap();

        let refused = collect(home).await.unwrap_err().to_string();
        assert!(
            refused.contains("no token in it"),
            "the reason has to name the sign-in, not the agent: {refused}",
        );
    }

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
        tokio::fs::write(
            home.join("credentials/kimi-code-env-abc.json"),
            r#"{"access_token":"a-real-looking-token","refresh_token":"r","expires_at":1}"#,
        )
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
        assert_eq!(
            bundle["credentials/kimi-code-env-abc.json"],
            r#"{"access_token":"a-real-looking-token","refresh_token":"r","expires_at":1}"#,
        );
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

/// What a plan has left, asked of Kimi directly.
///
/// ACP does not carry this. Kimi's own `/usage` prints a "Plan usage" box with
/// the 5-hour and monthly windows in it, but that is built in
/// `src/tui/components/messages/usage-panel.ts` — terminal code that never
/// crosses the wire. Over ACP the same command answers with two lines, context
/// and session total, and nothing about the quota. So the only way to have the
/// number is to go and ask for it.
///
/// **The token is borrowed, never refreshed.** Kimi's access tokens last
/// fifteen minutes, and refreshing one means holding the other half of an OAuth
/// dance that the agent is also dancing — rotate the refresh token and the
/// agent's own copy dies. Instead this reads the credential out of the live
/// session's home, which the agent itself keeps current, and uses it as found.
/// Called right after a turn, it is as fresh as the request that turn just
/// made. Expired is a 401, which is a `None` and not an error worth raising.
pub async fn allowance(home: &Path) -> Option<Vec<Allowance>> {
    let config = tokio::fs::read_to_string(home.join("config.toml")).await.ok()?;
    // One key out of a TOML file, rather than a parser and a dependency for it.
    // The file is Kimi's and this is the only line of it we have ever wanted.
    let base = config
        .lines()
        .find_map(|l| l.trim().strip_prefix("base_url"))
        .and_then(|rest| rest.split('"').nth(1))?
        .trim_end_matches('/')
        .to_owned();

    let mut dir = tokio::fs::read_dir(home.join("credentials")).await.ok()?;
    let mut token = None;
    while let Ok(Some(entry)) = dir.next_entry().await {
        let text = tokio::fs::read_to_string(entry.path()).await.ok()?;
        let json: Value = serde_json::from_str(&text).ok()?;
        if let Some(found) = json["access_token"].as_str().filter(|t| !t.is_empty()) {
            token = Some(found.to_owned());
            break;
        }
    }

    let answer = reqwest::Client::new()
        .get(format!("{base}/usages"))
        .bearer_auth(token?)
        .header("accept", "application/json")
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !answer.status().is_success() {
        return None;
    }
    Some(windows(&answer.json::<Value>().await.ok()?))
}

/// One quota window, as Firetower spells them.
#[derive(Debug, Clone, PartialEq)]
pub struct Allowance {
    pub window: String,
    pub used_percent: f32,
    /// Unix seconds, where Kimi gave a reset time.
    pub resets_at: Option<i64>,
}

/// The windows out of a `/usages` body.
///
/// Kimi reports each as a ratio of one with an ISO reset time; Firetower keeps
/// whole percents and unix seconds, which is what every other agent's limits
/// are already stored as. Names are mapped rather than passed through, so a
/// five-hour window from Kimi lands in the same bucket as one from Codex.
fn windows(body: &Value) -> Vec<Allowance> {
    let usages = &body["usages"];
    [
        ("limit_5h", "five_hour"),
        ("limit_7d", "seven_day"),
        ("limit_month_total", "month"),
        ("limit_month_code", "month_code"),
    ]
    .iter()
    .filter_map(|(theirs, ours)| {
        let entry = usages.get(theirs)?;
        let ratio = entry["used_ratio"].as_f64()?;
        Some(Allowance {
            window: (*ours).to_string(),
            // To a tenth, which is as far as the number means anything: the
            // provider recomputes it on its own schedule and a second decimal
            // would be precision we invented.
            used_percent: ((ratio * 1000.0).round() / 10.0).clamp(0.0, 100.0) as f32,
            resets_at: entry["reset_time"]
                .as_str()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|t| t.timestamp()),
        })
    })
    .collect()
}

#[cfg(test)]
mod quota_tests {
    use super::*;

    /// A real `/usages` body, in the shape Kimi's own parser describes.
    #[test]
    fn the_windows_kimi_reports_become_the_ones_firetower_stores() {
        let body = serde_json::json!({
            "usages": {
                "limit_5h": { "used_ratio": 0.0, "reset_time": "2026-10-09T23:17:00Z" },
                "limit_7d": { "used_ratio": 0.014, "reset_time": "2026-10-26T15:23:00Z" },
                "limit_month_total": { "used_ratio": 0.5, "reset_time": "2026-11-01T00:00:00Z" },
                // No reset time on this one, which is allowed and is a None.
                "limit_month_code": { "used_ratio": 0.996 }
            },
            "boosterWallet": null
        });

        let found = windows(&body);
        let named: Vec<_> = found.iter().map(|w| w.window.as_str()).collect();
        assert_eq!(named, ["five_hour", "seven_day", "month", "month_code"]);

        // Ratios of one become per cent, to a tenth. The decimal is the whole
        // point: 1.4% read as 1% is the difference between a quiet month and
        // twice the burn rate, and Kimi is the only provider that reports it.
        let pct: Vec<_> = found.iter().map(|w| w.used_percent).collect();
        assert_eq!(pct, [0.0, 1.4, 50.0, 99.6], "0.014 is 1.4%, not 1%");

        assert_eq!(found[0].resets_at, Some(1_791_587_820));
        assert_eq!(found[1].resets_at, Some(1_793_028_180));
        assert_eq!(found[2].resets_at, Some(1_793_491_200));
        assert_eq!(found[3].resets_at, None, "it did not say, so we do not");
    }

    /// Anything that is not that body reports nothing, rather than zero.
    ///
    /// A quota of 0% used and a quota nobody told us about look identical once
    /// they are drawn as a bar, and only one of them is true.
    #[test]
    fn a_body_that_says_nothing_yields_no_windows() {
        for body in [
            serde_json::json!({}),
            serde_json::json!({ "usages": {} }),
            serde_json::json!({ "usages": { "limit_5h": {} } }),
            serde_json::json!({ "usages": { "limit_5h": { "used_ratio": "lots" } } }),
            serde_json::json!({ "error": { "message": "nope" } }),
        ] {
            assert!(windows(&body).is_empty(), "{body}");
        }
    }
}

/// What the agent's credential looks like right now, as a fingerprint.
///
/// Kimi rewrites the file every time it refreshes, which it does roughly every
/// fifteen minutes while a session is working. The vault needs the new one, but
/// not four times an hour for the same bytes, so the caller keeps the last
/// fingerprint and only collects when it changes.
///
/// `None` where there is nothing to fingerprint, which is every agent that does
/// not keep a bundle and every home that has not been written yet.
pub(crate) async fn fingerprint(home: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};

    let mut dir = tokio::fs::read_dir(home.join("credentials")).await.ok()?;
    // Sorted, because a directory hands its entries back in whatever order it
    // likes and a fingerprint that depends on that would change for nothing.
    let mut files = Vec::new();
    while let Ok(Some(entry)) = dir.next_entry().await {
        if let Ok(bytes) = tokio::fs::read(entry.path()).await {
            files.push((entry.file_name(), bytes));
        }
    }
    if files.is_empty() {
        return None;
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hash = Sha256::new();
    for (name, bytes) in &files {
        hash.update(name.as_encoded_bytes());
        hash.update(bytes);
    }
    Some(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
mod rotation_tests {
    use super::*;

    async fn home_with(token: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::create_dir_all(dir.path().join("credentials")).await.unwrap();
        tokio::fs::write(dir.path().join("config.toml"), "default_model = \"x\"").await.unwrap();
        tokio::fs::write(
            dir.path().join("credentials/kimi-code-env-abc.json"),
            format!(r#"{{"access_token":"a","refresh_token":"{token}","expires_at":1}}"#),
        )
        .await
        .unwrap();
        dir
    }

    /// A refresh changes the fingerprint; nothing else does.
    #[tokio::test]
    async fn a_rotated_credential_is_a_different_fingerprint() {
        let home = home_with("R1").await;
        let first = fingerprint(home.path()).await.expect("there is a credential");

        // Reading it again says the same thing, or the vault would be rewritten
        // every minute for bytes it already has.
        assert_eq!(fingerprint(home.path()).await.as_deref(), Some(first.as_str()));

        // Kimi spends R1 and is given R2.
        tokio::fs::write(
            home.path().join("credentials/kimi-code-env-abc.json"),
            r#"{"access_token":"b","refresh_token":"R2","expires_at":2}"#,
        )
        .await
        .unwrap();
        let second = fingerprint(home.path()).await.expect("still a credential");
        assert_ne!(first, second, "a refresh has to be noticed");
    }

    /// A home with nothing in it is every agent that keeps no bundle.
    #[tokio::test]
    async fn a_home_without_credentials_has_no_fingerprint() {
        let bare = tempfile::tempdir().unwrap();
        assert_eq!(fingerprint(bare.path()).await, None);

        tokio::fs::create_dir_all(bare.path().join("credentials")).await.unwrap();
        assert_eq!(fingerprint(bare.path()).await, None, "an empty directory is not a credential");
    }

    /// What Kimi leaves when a refresh fails must never reach the vault.
    ///
    /// It blanks the file in place, which changes the fingerprint — so the
    /// rotation path fires on exactly the bytes it would be worst to keep. The
    /// guard that stops it is in `collect`, which is why this asserts there.
    #[tokio::test]
    async fn a_blanked_credential_is_noticed_but_refused() {
        let home = home_with("R1").await;
        let before = fingerprint(home.path()).await.unwrap();

        tokio::fs::write(
            home.path().join("credentials/kimi-code-env-abc.json"),
            r#"{"access_token":"","refresh_token":"","expires_at":0}"#,
        )
        .await
        .unwrap();
        assert_ne!(before, fingerprint(home.path()).await.unwrap(), "it did change");

        let refused = collect(home.path()).await.unwrap_err().to_string();
        assert!(refused.contains("no token in it"), "{refused}");
    }
}

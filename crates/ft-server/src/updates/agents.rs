//! What version of each agent its publisher is serving, and who is behind it.
//!
//! A worker fetches an agent once, at install, and then keeps it: the binary is
//! told not to replace itself, because the version a session runs should be the
//! one Firetower chose and the Agents screen shows. What was missing is the
//! other half of that promise — nothing ever said the choice had gone stale, so
//! a host quietly ran whatever was newest the day it was added.
//!
//! Asked here rather than on each host. The control plane already asks GitHub
//! about its own releases, so this is one more question from a machine that is
//! already asking, and it needs nothing from a worker: putting it in the probe
//! would mean a field on a worker message, a `PROTOCOL_VERSION` bump, and every
//! worker in a fleet offline until it was upgraded — for a number that changes
//! nothing about whether a session runs.
//!
//! **Not a stored cache.** Unlike the control plane's own release, nothing here
//! has to survive a restart: an empty answer for the first twenty seconds after
//! boot is a screen that says nothing yet, which is true.

use super::version;
use anyhow::{Context, Result};
use ft_core::Agent;
use std::collections::HashMap;
use std::sync::Arc;

/// Where to ask about each. Overridable one at a time, for a test or a mirror.
#[derive(Clone, Debug)]
pub struct Feeds {
    claude: String,
    codex: String,
    kimi: String,
}

impl Feeds {
    pub const CLAUDE_ENV: &'static str = "FIRETOWER_AGENT_FEED_CLAUDE_CODE";
    pub const CODEX_ENV: &'static str = "FIRETOWER_AGENT_FEED_CODEX";
    pub const KIMI_ENV: &'static str = "FIRETOWER_AGENT_FEED_KIMI_CODE";

    pub fn from_env() -> Self {
        Self {
            claude: from_env_or(Self::CLAUDE_ENV, Agent::ClaudeCode),
            codex: from_env_or(Self::CODEX_ENV, Agent::Codex),
            kimi: from_env_or(Self::KIMI_ENV, Agent::KimiCode),
        }
    }

    fn url(&self, kind: Agent) -> Option<&str> {
        match kind {
            Agent::ClaudeCode => Some(&self.claude),
            Agent::Codex => Some(&self.codex),
            Agent::KimiCode => Some(&self.kimi),
            // Shell has no publisher; Cursor uses verified pinned archives.
            Agent::Shell | Agent::CursorAgent => None,
        }
    }
}

fn from_env_or(key: &str, kind: Agent) -> String {
    std::env::var(key)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            ft_core::releases::newest_url(kind).expect("every agent Firetower fetches has a feed")
        })
}

/// What a publisher last said, or why it could not be asked.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Published {
    /// A bare version. `None` means nobody knows, which is not "up to date".
    pub version: Option<String>,
    pub checked_at: Option<chrono::DateTime<chrono::Utc>>,
    pub error: Option<String>,
}

/// The newest published version of each agent, as last asked.
#[derive(Clone, Default)]
pub struct Releases(Arc<tokio::sync::RwLock<HashMap<Agent, Published>>>);

impl Releases {
    /// The newest version of one agent, if a check has succeeded.
    pub async fn newest(&self, kind: Agent) -> Option<String> {
        self.0
            .read()
            .await
            .get(&kind)
            .and_then(|p| p.version.clone())
    }

    /// Ask every publisher, and keep what each said.
    ///
    /// One failure is one agent nobody knows about, not a failed refresh: a
    /// download service being down should not take the other two rows off the
    /// screen with it.
    pub async fn refresh(&self, http: &reqwest::Client, feeds: &Feeds) {
        for kind in Agent::all() {
            let Some(url) = feeds.url(kind) else { continue };
            let found = match newest(http, kind, url).await {
                Ok(version) => Published {
                    version: Some(version),
                    checked_at: Some(chrono::Utc::now()),
                    error: None,
                },
                Err(e) => {
                    tracing::warn!("asking what {} has published: {e:#}", kind.label());
                    Published {
                        version: None,
                        checked_at: Some(chrono::Utc::now()),
                        error: Some(format!("{e:#}")),
                    }
                }
            };
            self.0.write().await.insert(kind, found);
        }
    }
}

/// Ask one publisher what its newest version is.
async fn newest(http: &reqwest::Client, kind: Agent, url: &str) -> Result<String> {
    let response = http
        .get(url)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .with_context(|| format!("reaching {url}"))?
        .error_for_status()
        .with_context(|| format!("{url} refused"))?;

    match kind {
        // Codex's releases are a list, and the CLI is not the only thing tagged
        // in that repository — see `ft_core::releases::CODEX_RELEASE_LIST`.
        Agent::Codex => {
            let body: serde_json::Value =
                response.json().await.context("reading the release list")?;
            pick_codex(&body)
        }
        // The others answer with the version itself, which is what their own
        // installers read.
        _ => read_version(&response.text().await.context("reading the answer")?),
    }
}

/// A download service's `latest`, which is a bare version and nothing else.
///
/// Validated rather than trusted: one of these answering with an HTML error
/// page would otherwise become a "version" every host was behind.
pub fn read_version(said: &str) -> Result<String> {
    let said = said.trim();
    ft_core::releases::version_in(said)
        .with_context(|| format!("no version in the answer: {said:.60}"))
}

/// The newest Codex CLI in a list of releases.
///
/// A draft, a pre-release, or another package's tag is not one — the same
/// filtering, for the same reason, as [`super::check::pick_release`].
///
/// Pre-releases are refused twice over, because this repository publishes them
/// constantly: at the time of writing its three newest tags are all alphas of
/// `0.161.0`, against a newest release of `0.159.2`. GitHub's flag is the first
/// filter and the version's own pre-release part is the second — a mislabelled
/// alpha would otherwise win on ordering alone and be pushed to a fleet as the
/// version to be on.
pub fn pick_codex(body: &serde_json::Value) -> Result<String> {
    let releases = body.as_array().context("the release list is not a list")?;
    releases
        .iter()
        .filter(|r| !flag(r, "draft") && !flag(r, "prerelease"))
        .filter_map(|r| r.get("tag_name").and_then(|v| v.as_str()))
        .filter_map(|tag| tag.strip_prefix(ft_core::releases::CODEX_TAG_PREFIX))
        .filter_map(version::parse)
        .filter(|v| v.pre.is_empty())
        .max()
        .map(|v| v.to_string())
        .context("no Codex CLI release in the list")
}

fn flag(release: &serde_json::Value, name: &str) -> bool {
    release.get(name).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Whether what a host has is older than what is published.
///
/// Both sides arrive as whatever a binary printed on one hand and whatever a
/// publisher served on the other, so both are read for the version inside them.
///
/// **Anything unreadable is not behind.** Telling somebody to reinstall because
/// a version string could not be parsed is worse than saying nothing, and a
/// host *ahead* of the feed — a build somebody pinned on purpose — is not
/// behind either.
pub fn behind(installed: Option<&str>, published: Option<&str>) -> bool {
    let Some(installed) = installed.and_then(ft_core::releases::version_in) else {
        return false;
    };
    let Some(published) = published.and_then(ft_core::releases::version_in) else {
        return false;
    };
    match (version::parse(&installed), version::parse(&published)) {
        (Some(here), Some(there)) => version::is_newer(&there, &here),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the download services answer with.
    #[test]
    fn a_bare_version_is_read_as_one() {
        assert_eq!(read_version("2.1.290\n").unwrap(), "2.1.290");
        assert_eq!(read_version("  2.1.1  ").unwrap(), "2.1.1");
    }

    /// The failure that matters: a service answering with something that is not
    /// a version at all. Every host would otherwise be reported behind it.
    #[test]
    fn an_answer_that_is_not_a_version_is_refused() {
        assert!(read_version("<html>504 Gateway Timeout</html>").is_err());
        assert!(read_version("").is_err());
        assert!(read_version("latest").is_err());
    }

    /// The shape GitHub returns, trimmed to what is read — and carrying the
    /// tags that are not the CLI, which is the whole reason this is a list.
    #[test]
    fn the_newest_codex_cli_is_picked_out_of_everything_else_tagged() {
        let body = serde_json::json!([
            { "tag_name": "0.4.0", "draft": false, "prerelease": false },
            { "tag_name": "rust-v0.156.1", "draft": false, "prerelease": false },
            { "tag_name": "rust-v0.157.0", "draft": false, "prerelease": true },
            { "tag_name": "rust-v0.155.0", "draft": false, "prerelease": false },
            { "tag_name": "rust-v0.160.0", "draft": true, "prerelease": false },
        ]);
        assert_eq!(pick_codex(&body).unwrap(), "0.156.1");
    }

    /// An alpha that GitHub did not flag is still an alpha.
    ///
    /// The shape is real: `openai/codex` tags alphas of a version well above its
    /// newest release, so ordering alone would hand a fleet a pre-release.
    #[test]
    fn an_unflagged_prerelease_is_still_refused() {
        let body = serde_json::json!([
            { "tag_name": "rust-v0.161.0-alpha.4", "draft": false, "prerelease": false },
            { "tag_name": "rust-v0.160.0-alpha.6.1", "draft": false, "prerelease": false },
            { "tag_name": "rust-v0.159.2", "draft": false, "prerelease": false },
        ]);
        assert_eq!(pick_codex(&body).unwrap(), "0.159.2");
    }

    /// A list with no CLI release in it is not an answer of "nothing newer".
    #[test]
    fn a_list_without_a_cli_release_is_an_error() {
        let body =
            serde_json::json!([{ "tag_name": "0.4.0", "draft": false, "prerelease": false }]);
        assert!(pick_codex(&body).is_err());
        assert!(pick_codex(&serde_json::json!({})).is_err());
    }

    /// Read out of what each binary actually prints, not out of a bare version.
    #[test]
    fn a_host_is_behind_only_when_both_sides_are_readable_and_it_is_older() {
        assert!(behind(Some("2.1.273 (Claude Code)"), Some("2.1.290")));
        assert!(behind(Some("codex-cli 0.155.0"), Some("0.156.1")));

        assert!(!behind(Some("2.1.290 (Claude Code)"), Some("2.1.290")));
        assert!(
            !behind(Some("2.1.300 (Claude Code)"), Some("2.1.290")),
            "a build somebody pinned ahead of the feed is not stale"
        );
    }

    /// Never a claim on a guess: not knowing is not being behind.
    #[test]
    fn nothing_unreadable_is_ever_reported_as_behind() {
        assert!(!behind(None, Some("2.1.290")));
        assert!(!behind(Some("2.1.273"), None));
        assert!(!behind(None, None));
        assert!(!behind(Some("installed from source"), Some("2.1.290")));
        assert!(!behind(Some("2.1.273"), Some("who knows")));
    }

    /// An override is per publisher, so pointing one at a stub leaves the
    /// others alone.
    #[test]
    fn a_feed_falls_back_to_the_publisher_it_is_named_for() {
        let feeds = Feeds {
            claude: "http://127.0.0.1:1/latest".into(),
            codex: from_env_or("FIRETOWER_AGENT_FEED_NOT_SET_ANYWHERE", Agent::Codex),
            kimi: from_env_or("FIRETOWER_AGENT_FEED_NOT_SET_ANYWHERE", Agent::KimiCode),
        };
        assert_eq!(
            feeds.url(Agent::ClaudeCode),
            Some("http://127.0.0.1:1/latest")
        );
        assert_eq!(
            feeds.url(Agent::Codex),
            Some(ft_core::releases::CODEX_RELEASE_LIST)
        );
        assert!(feeds
            .url(Agent::KimiCode)
            .is_some_and(|u| u.starts_with(ft_core::releases::KIMI_RELEASES)));
        assert_eq!(feeds.url(Agent::Shell), None);
    }

    #[tokio::test]
    async fn an_agent_nobody_has_asked_about_has_no_newest_version() {
        let releases = Releases::default();
        assert_eq!(releases.newest(Agent::ClaudeCode).await, None);
    }
}

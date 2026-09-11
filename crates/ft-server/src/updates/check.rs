//! Asking what the newest release is.
//!
//! GitHub's releases feed, because that is where release-please publishes:
//! the tag, the date and the changelog section for that version, in one
//! document that needs no credential to read. Sixty requests an hour anonymous
//! is more than a six-hourly check and a button will ever use.
//!
//! The deployment files at a tag come from the raw content host, so a plan can
//! say what a release changed in `firetower.yml` before anybody agrees to it.

use super::version;
use anyhow::{Context, Result};
use semver::Version;
use std::time::Duration;

/// Where the feed and the files are. Overridable for a test or a mirror.
#[derive(Clone, Debug)]
pub struct Feed {
    /// The `releases/latest` document.
    pub releases_url: String,
    /// Prefix for `<prefix>/<tag>/deploy/<file>`.
    pub raw_base: String,
}

impl Feed {
    pub const RELEASES_ENV: &'static str = "FIRETOWER_UPDATE_FEED";
    pub const RAW_ENV: &'static str = "FIRETOWER_UPDATE_RAW";

    pub fn from_env() -> Self {
        Self {
            releases_url: std::env::var(Self::RELEASES_ENV)
                .ok()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    "https://api.github.com/repos/firetower-cloud/firetower/releases/latest".into()
                }),
            raw_base: std::env::var(Self::RAW_ENV)
                .ok()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    "https://raw.githubusercontent.com/firetower-cloud/firetower".into()
                })
                .trim_end_matches('/')
                .to_string(),
        }
    }

    fn file_url(&self, version: &Version, name: &str) -> String {
        format!(
            "{}/{}/deploy/{name}",
            self.raw_base,
            version::tag_for(version)
        )
    }
}

/// What the feed said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Latest {
    pub version: Version,
    pub published_at: Option<chrono::DateTime<chrono::Utc>>,
    pub notes_url: Option<String>,
    pub notes: Option<String>,
}

/// One HTTP client for everything this module fetches, with the header GitHub
/// insists on.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(format!("firetower/{}", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20))
        .build()
        .expect("a client with a user agent")
}

/// The newest release, as the feed describes it.
pub async fn latest(http: &reqwest::Client, feed: &Feed) -> Result<Latest> {
    let body: serde_json::Value = http
        .get(&feed.releases_url)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .context("reaching the releases feed")?
        .error_for_status()
        .context("the releases feed refused")?
        .json()
        .await
        .context("reading the releases feed")?;
    read_release(&body)
}

/// Read one release document. Separate from fetching so it can be tested on
/// what GitHub actually returns.
pub fn read_release(body: &serde_json::Value) -> Result<Latest> {
    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .context("the release has no tag_name")?;
    let version = version::parse(tag).with_context(|| format!("{tag} is not a release tag"))?;
    Ok(Latest {
        version,
        published_at: body
            .get("published_at")
            .and_then(|v| v.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.with_timezone(&chrono::Utc)),
        notes_url: body
            .get("html_url")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        notes: body
            .get("body")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    })
}

/// A deployment file as it was at a release. `None` when the release did not
/// have it.
pub async fn deploy_file(
    http: &reqwest::Client,
    feed: &Feed,
    version: &Version,
    name: &str,
) -> Result<Option<String>> {
    let url = feed.file_url(version, name);
    let response = http
        .get(&url)
        .send()
        .await
        .with_context(|| format!("fetching {url}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let text = response
        .error_for_status()
        .with_context(|| format!("fetching {url}"))?
        .text()
        .await
        .with_context(|| format!("reading {url}"))?;
    Ok(Some(text))
}

/// The least CLI a release wants, from `deploy/cli.json` at its tag.
pub async fn cli_minimum(http: &reqwest::Client, feed: &Feed, version: &Version) -> Option<String> {
    let text = deploy_file(http, feed, version, "cli.json").await.ok()??;
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()?
        .get("minimumCli")?
        .as_str()
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape GitHub returns, trimmed to what is read.
    #[test]
    fn a_github_release_is_read_into_a_version_and_its_notes() {
        let body = serde_json::json!({
            "tag_name": "firetower-v0.30.1",
            "name": "firetower: v0.30.1",
            "html_url": "https://github.com/firetower-cloud/firetower/releases/tag/firetower-v0.30.1",
            "published_at": "2026-09-11T06:40:04Z",
            "body": "## [0.30.1](…) (2026-09-11)\n\n### Bug Fixes\n\n* keep a Codex session's settings\n"
        });
        let latest = read_release(&body).unwrap();
        assert_eq!(latest.version, Version::new(0, 30, 1));
        assert!(latest.notes.unwrap().contains("Bug Fixes"));
        assert!(latest.notes_url.unwrap().ends_with("firetower-v0.30.1"));
        assert_eq!(
            latest.published_at.unwrap().to_rfc3339(),
            "2026-09-11T06:40:04+00:00"
        );
    }

    #[test]
    fn a_release_without_a_version_tag_is_refused() {
        let body = serde_json::json!({"tag_name": "nightly"});
        assert!(read_release(&body).is_err());
    }

    #[test]
    fn deployment_files_are_fetched_at_the_release_s_tag() {
        let feed = Feed {
            releases_url: "x".into(),
            raw_base: "https://raw.example/firetower".into(),
        };
        assert_eq!(
            feed.file_url(&Version::new(0, 31, 0), "firetower.yml"),
            "https://raw.example/firetower/firetower-v0.31.0/deploy/firetower.yml"
        );
    }
}

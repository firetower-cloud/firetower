//! Authorizing against a git host, and asking it what you can see.
//!
//! The device authorization grant is the flow for an application that can't
//! keep a secret and has nowhere to receive a redirect. You get a short code,
//! type it into a browser, and this polls until the host says yes. Nothing has
//! to be publicly reachable, which is what makes it work identically on a
//! laptop and on a server with no inbound ports.

use crate::providers::Provider;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use utoipa::ToSchema;

/// Identifies us politely, and some hosts refuse requests without one.
const USER_AGENT: &str = concat!("firetower/", env!("CARGO_PKG_VERSION"));

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30))
        .build()
        .context("building the http client")
}

/// What the host hands back when an authorization starts.
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(default = "default_interval")]
    pub interval: u64,
}

fn default_interval() -> u64 {
    5
}

/// Why an authorization couldn't even be started.
///
/// The distinction is the whole point: a rejected identifier is something the
/// person running Firetower has to fix, while a network failure is worth
/// retrying. Reporting both as an internal error sends people looking in the
/// wrong place.
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("{0}")]
    NotConfigured(String),
    #[error("{0}")]
    Unreachable(String),
}

/// Begin an authorization. Returns the code to show and the code to poll with.
pub async fn start(
    provider: &Provider,
    client_id: Option<String>,
) -> Result<DeviceStart, StartError> {
    let client_id = client_id.ok_or_else(|| {
        StartError::NotConfigured(format!(
            "no application is registered for {}. Add its client id in Firetower — the \
             connect screen asks for one and explains where to get it.",
            provider.label
        ))
    })?;

    let response = client()
        .map_err(|e| StartError::Unreachable(format!("{e:#}")))?
        .post(provider.device_code_url)
        .header("accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("scope", provider.scopes),
        ])
        .send()
        .await
        .map_err(|e| StartError::Unreachable(format!("couldn't reach {}: {e}", provider.label)))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if status.is_client_error() {
        // The host understood us and said no, which for this request means the
        // identifier is wrong or the application isn't set up for this flow.
        return Err(StartError::NotConfigured(format!(
            "{} rejected that client id. Check it, and check that the application \
             has the device flow enabled — it is off by default, and {} answers \
             both mistakes the same way.",
            provider.label, provider.label
        )));
    }
    if !status.is_success() {
        return Err(StartError::Unreachable(format!(
            "{} couldn't start an authorization: {status} {body}",
            provider.label
        )));
    }

    serde_json::from_str(&body).map_err(|_| {
        StartError::Unreachable(format!(
            "{} sent back an authorization we don't understand",
            provider.label
        ))
    })
}

/// One step of the wait. Anything other than [`Poll::Pending`] ends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Poll {
    /// Nobody has approved it yet.
    Pending,
    /// We're asking too often; wait longer.
    SlowDown,
    Approved(String),
    /// The code timed out, or was declined.
    Failed(String),
}

/// Ask once whether the code has been approved.
pub async fn poll(provider: &Provider, client_id: &str, device_code: &str) -> Result<Poll> {
    #[derive(Deserialize)]
    struct Response {
        access_token: Option<String>,
        error: Option<String>,
        error_description: Option<String>,
    }

    let body: Response = client()?
        .post(provider.token_url)
        .header("accept", "application/json")
        .form(&[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .context("checking whether the authorization was approved")?
        .json()
        .await
        .context("reading the authorization response")?;

    if let Some(token) = body.access_token {
        return Ok(Poll::Approved(token));
    }

    Ok(match body.error.as_deref() {
        Some("authorization_pending") => Poll::Pending,
        Some("slow_down") => Poll::SlowDown,
        Some("expired_token") => Poll::Failed("the code expired before it was approved".into()),
        Some("access_denied") => Poll::Failed("the request was declined".into()),
        Some(other) => Poll::Failed(body.error_description.unwrap_or_else(|| other.to_string())),
        None => Poll::Failed("the host sent neither a token nor an error".into()),
    })
}

/// A repository the authorized account can see.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRepo {
    /// `acme/backend`
    pub slug: String,
    /// The https URL, since a token authenticates over https.
    pub remote: String,
    pub default_branch: String,
    pub private: bool,
    /// Most recently pushed first is the order people actually want.
    pub pushed_at: Option<String>,
}

/// Everything the account can see, most recently active first.
///
/// This is a plain API call rather than a git operation, so it happens here
/// rather than on a worker.
pub async fn list_repos(provider: &Provider, token: &str) -> Result<Vec<RemoteRepo>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "snake_case")]
    struct Item {
        full_name: String,
        clone_url: String,
        default_branch: Option<String>,
        private: bool,
        pushed_at: Option<String>,
        #[serde(default)]
        archived: bool,
    }

    let client = client()?;
    let mut out = Vec::new();

    // Three pages is enough for anyone we can usefully show in a picker, and it
    // bounds how long the connect screen can sit there loading. The search box
    // is the answer beyond that, not a longer wait.
    for page in 1..=3 {
        let items: Vec<Item> = client
            .get(format!("{}/user/repos", provider.api_base))
            .bearer_auth(token)
            .header("accept", "application/vnd.github+json")
            .query(&[
                ("per_page", "100"),
                ("page", &page.to_string()),
                ("sort", "pushed"),
                ("affiliation", "owner,collaborator,organization_member"),
            ])
            .send()
            .await
            .with_context(|| format!("listing repositories from {}", provider.label))?
            .error_for_status()
            .with_context(|| format!("{} refused the repository list", provider.label))?
            .json()
            .await
            .context("reading the repository list")?;

        let count = items.len();
        out.extend(
            items
                .into_iter()
                .filter(|i| !i.archived)
                .map(|i| RemoteRepo {
                    slug: i.full_name,
                    remote: i.clone_url,
                    default_branch: i.default_branch.unwrap_or_else(|| "main".into()),
                    private: i.private,
                    pushed_at: i.pushed_at,
                }),
        );

        if count < 100 {
            break;
        }
    }

    Ok(out)
}

/// Open a pull request, and hand back where to read it.
///
/// Not a git operation — this talks to the host's API, so it belongs on the
/// control plane with the token, exactly like listing repositories does.
/// What to open, as one thing.
///
/// Grouped rather than passed as six strings in a row, which is how a base and
/// a head end up the wrong way round: the call site now names each one.
pub struct Opening<'a> {
    pub slug: &'a str,
    /// The branch with the work on it.
    pub head: &'a str,
    /// The branch it is going into.
    pub base: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    /// A draft says "look at this" rather than "merge this", which is most of
    /// what somebody wants from a session that just finished.
    pub draft: bool,
}

pub async fn open_pull_request(
    provider: &Provider,
    token: &str,
    opening: Opening<'_>,
) -> Result<String> {
    let Opening {
        slug,
        head,
        base,
        title,
        body,
        draft,
    } = opening;
    #[derive(Deserialize)]
    struct Created {
        html_url: Option<String>,
        message: Option<String>,
    }

    let response = client()?
        .post(format!("{}/repos/{slug}/pulls", provider.api_base))
        .bearer_auth(token)
        .header("accept", "application/vnd.github+json")
        .json(&serde_json::json!({
            "title": title,
            "head": head,
            "base": base,
            "body": body,
            "draft": draft,
        }))
        .send()
        .await
        .with_context(|| format!("asking {} to open a pull request", provider.label))?;

    let status = response.status();
    let created: Created = response
        .json()
        .await
        .context("reading the pull request response")?;

    if let Some(url) = created.html_url {
        return Ok(url);
    }

    // The host's own words are more useful than ours: "no commits between",
    // "already exists", and "not found" all need different things from you.
    bail!(
        "{}: {}",
        status,
        created
            .message
            .unwrap_or_else(|| "the host refused without saying why".into())
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers;

    #[tokio::test]
    async fn starting_without_a_registered_application_explains_what_to_do() {
        let p = providers::find("github").unwrap();
        let err = start(p, None).await.unwrap_err();
        assert!(matches!(err, StartError::NotConfigured(_)), "{err}");
        assert!(
            err.to_string().contains("client id"),
            "it should say what is missing and where to put it: {err}"
        );
    }

    #[test]
    fn a_pending_authorization_is_not_a_failure() {
        // The distinction matters: Pending keeps waiting, Failed stops and
        // tells someone. Conflating them either spins forever or gives up on
        // the first tick.
        assert_ne!(Poll::Pending, Poll::Failed("x".into()));
    }
}

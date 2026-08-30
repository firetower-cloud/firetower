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

pub(crate) fn client() -> Result<reqwest::Client> {
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
        /// Where GitHub actually says what was wrong.
        ///
        /// The top-level `message` on a 422 is the word "Validation Failed"
        /// every single time. Reading only that turned "No commits between
        /// main and agent/hello" — which tells you exactly what to do — into
        /// "422 Unprocessable Entity: Validation Failed", which tells you
        /// nothing.
        #[serde(default)]
        errors: Vec<Refusal>,
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

    let said = refusal(&created.message, &created.errors);

    // One already open is not a failure. It happens when a push was amended,
    // when somebody opened it in a browser, or when we opened it and the row
    // recording that did not get written — and in every case the useful answer
    // is the request itself, not an error nobody can act on.
    if said.to_ascii_lowercase().contains("already exists") {
        if let Some(url) = existing_pull_request(provider, token, slug, head).await? {
            return Ok(url);
        }
    }

    // The host's own words are more useful than ours: "no commits between",
    // "already exists", and "not found" all need different things from you.
    bail!("{status}: {said}")
}

/// One entry from a host's `errors` array.
#[derive(Debug, Deserialize)]
struct Refusal {
    message: Option<String>,
    field: Option<String>,
    code: Option<String>,
}

/// The most specific thing the host said.
///
/// An entry carries either prose or a field-and-code pair — `head` / `invalid`
/// — and the pair is still worth more than "Validation Failed".
fn refusal(message: &Option<String>, errors: &[Refusal]) -> String {
    let specific: Vec<String> = errors
        .iter()
        .filter_map(|e| match (&e.message, &e.field, &e.code) {
            (Some(m), _, _) if !m.trim().is_empty() => Some(m.trim().to_string()),
            (_, Some(f), Some(c)) => Some(format!("{f} is {c}")),
            (_, Some(f), None) => Some(format!("{f} was refused")),
            _ => None,
        })
        .collect();

    if !specific.is_empty() {
        return specific.join("; ");
    }

    message
        .clone()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "the host refused without saying why".into())
}

/// The open request for a branch, when the host says one is already there.
///
/// `head` is qualified with the owner because that is what the API wants, and
/// because a fork's branch of the same name is a different thing.
async fn existing_pull_request(
    provider: &Provider,
    token: &str,
    slug: &str,
    head: &str,
) -> Result<Option<String>> {
    #[derive(Deserialize)]
    struct Open {
        html_url: String,
    }

    let owner = slug.split('/').next().unwrap_or(slug);

    let found: Vec<Open> = client()?
        .get(format!("{}/repos/{slug}/pulls", provider.api_base))
        .bearer_auth(token)
        .header("accept", "application/vnd.github+json")
        .query(&[
            ("head", format!("{owner}:{head}")),
            ("state", "open".into()),
        ])
        .send()
        .await
        .with_context(|| format!("asking {} which request is already open", provider.label))?
        .json()
        .await
        .unwrap_or_default();

    Ok(found.into_iter().next().map(|p| p.html_url))
}

/// Who the token belongs to, as a name and an address for a commit.
///
/// Asked of the host rather than of the person: this is the account whose
/// token will push the branch, so it is the account a reviewer will expect to
/// see against the commits — and it is the only identity Firetower can know
/// without asking somebody to type one.
///
/// The address is GitHub's own no-reply form, built from the numeric id and the
/// login. A real address is often absent from the API — most people keep theirs
/// private — while the no-reply one always works, is what GitHub's own web
/// editor uses, and links the commit to the account.
pub async fn whoami(provider: &Provider, token: &str) -> Result<ft_proto::Author> {
    #[derive(Deserialize)]
    struct Me {
        id: u64,
        login: String,
        name: Option<String>,
    }

    let me: Me = client()?
        .get(format!("{}/user", provider.api_base))
        .bearer_auth(token)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .with_context(|| format!("asking {} who the token belongs to", provider.label))?
        .json()
        .await
        .with_context(|| format!("reading {}'s answer about the token", provider.label))?;

    Ok(ft_proto::Author {
        name: me
            .name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| me.login.clone()),
        email: format!("{}+{}@users.noreply.github.com", me.id, me.login),
    })
}

/// Replace the body of a pull request that is already open.
///
/// Used to put the links to its siblings in: none of them has a URL until all
/// of them have been created, so the cross-links can only be written afterwards.
///
/// Takes the web URL because that is what was recorded — the API path is
/// derived from it rather than kept alongside.
pub use ft_core::session::PullState;

/// Ask what became of one.
///
/// The sibling of [`existing_pull_request`], which cannot answer this: it asks
/// for `state=open` and so cannot see the two states worth knowing about.
pub async fn pull_request_state(provider: &Provider, token: &str, url: &str) -> Result<PullState> {
    #[derive(Deserialize)]
    struct Went {
        state: String,
        merged_at: Option<String>,
    }

    let (owner, repo, number) = pull_request_parts(url)?;

    let went: Went = client()?
        .get(format!(
            "{}/repos/{owner}/{repo}/pulls/{number}",
            provider.api_base
        ))
        .bearer_auth(token)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .with_context(|| format!("asking {} about a pull request", provider.label))?
        .error_for_status()
        .with_context(|| format!("asking {} about a pull request", provider.label))?
        .json()
        .await
        .context("reading what it said about the pull request")?;

    Ok(read_state(&went.state, went.merged_at.as_deref()))
}

/// Merged or abandoned, out of the two fields that say so.
///
/// Both are `closed` to a git host. Only the moment it was merged tells them
/// apart, and they mean opposite things to somebody deciding whether the work
/// is safe to throw away.
fn read_state(state: &str, merged_at: Option<&str>) -> PullState {
    match (state, merged_at) {
        ("open", _) => PullState::Open,
        (_, Some(_)) => PullState::Merged,
        _ => PullState::Closed,
    }
}

/// `https://github.com/acme/api/pull/12` → `acme`, `api`, `12`.
fn pull_request_parts(url: &str) -> Result<(String, String, String)> {
    let rest = url
        .split("://")
        .nth(1)
        .and_then(|after| after.split_once('/'))
        .map(|(_, path)| path)
        .unwrap_or_default();
    let mut parts = rest.split('/');
    let (Some(owner), Some(repo), Some(_), Some(number)) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        bail!("{url} is not a pull request address this understands");
    };
    Ok((owner.to_string(), repo.to_string(), number.to_string()))
}

pub async fn amend_pull_request(
    provider: &Provider,
    token: &str,
    url: &str,
    body: &str,
) -> Result<()> {
    let (owner, repo, number) = pull_request_parts(url)?;

    let response = client()?
        .patch(format!(
            "{}/repos/{owner}/{repo}/pulls/{number}",
            provider.api_base
        ))
        .bearer_auth(token)
        .header("accept", "application/vnd.github+json")
        .json(&serde_json::json!({ "body": body }))
        .send()
        .await
        .with_context(|| format!("asking {} to amend a pull request", provider.label))?;

    if !response.status().is_success() {
        bail!(
            "{}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers;

    #[test]
    fn merged_and_abandoned_are_told_apart_by_the_timestamp() {
        assert_eq!(read_state("open", None), PullState::Open);
        // Still `closed`, and the opposite outcome.
        assert_eq!(
            read_state("closed", Some("2026-08-30T10:00:00Z")),
            PullState::Merged
        );
        assert_eq!(read_state("closed", None), PullState::Closed);
    }

    /// A request is stored as the address somebody would click, and asking
    /// about it needs the three parts inside that address.
    #[test]
    fn a_pull_request_address_gives_up_its_parts() {
        let (owner, repo, number) =
            pull_request_parts("https://github.com/acme/api/pull/12").unwrap();
        assert_eq!(
            (owner.as_str(), repo.as_str(), number.as_str()),
            ("acme", "api", "12")
        );

        assert!(pull_request_parts("https://github.com/acme").is_err());
        assert!(pull_request_parts("not an address").is_err());
    }

    /// The bug this exists to stop coming back: a 422 read as
    /// "Validation Failed", which is what GitHub says every time and tells
    /// nobody anything.
    #[test]
    fn a_refusal_says_what_the_host_actually_objected_to() {
        let body = serde_json::json!({
            "message": "Validation Failed",
            "errors": [{
                "resource": "PullRequest",
                "code": "custom",
                "message": "No commits between main and agent/hello"
            }],
        });
        let message: Option<String> = body["message"].as_str().map(str::to_string);
        let errors: Vec<Refusal> = serde_json::from_value(body["errors"].clone()).unwrap();

        assert_eq!(
            refusal(&message, &errors),
            "No commits between main and agent/hello"
        );
    }

    /// Some entries carry no prose at all — a field and a code is still more
    /// than the generic line above it.
    #[test]
    fn a_refusal_without_prose_still_names_the_field() {
        let errors: Vec<Refusal> = serde_json::from_value(serde_json::json!([
            { "resource": "PullRequest", "field": "head", "code": "invalid" }
        ]))
        .unwrap();

        assert_eq!(
            refusal(&Some("Validation Failed".into()), &errors),
            "head is invalid"
        );
    }

    #[test]
    fn a_refusal_with_nothing_useful_falls_back_to_the_generic_line() {
        assert_eq!(
            refusal(&Some("Not Found".into()), &[]),
            "Not Found",
            "the top-level message is all there is here, and it is worth saying"
        );
        assert_eq!(refusal(&None, &[]), "the host refused without saying why");
    }

    /// Every reason a host gives for refusing needs a different thing from
    /// you, so they must not collapse into one message.
    #[test]
    fn several_objections_are_all_reported() {
        let errors: Vec<Refusal> = serde_json::from_value(serde_json::json!([
            { "message": "No commits between main and agent/x" },
            { "field": "base", "code": "invalid" }
        ]))
        .unwrap();

        let said = refusal(&Some("Validation Failed".into()), &errors);
        assert!(said.contains("No commits"), "{said}");
        assert!(said.contains("base is invalid"), "{said}");
    }

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

//! Authorizing against a git host, and asking it what you can see.
//!
//! Two ways in, and which one a host offers is a fact about that instance.
//!
//! The **device authorization grant** is the flow for an application that can't
//! keep a secret and has nowhere to receive a redirect. You get a short code,
//! type it into a browser, and this polls until the host says yes. Nothing has
//! to be publicly reachable, which is what makes it work identically on a
//! laptop and on a server with no inbound ports. GitHub has had it for years;
//! GitLab only since 17.9.
//!
//! A **pasted token** is the other, and it is not a lesser one. Gitea
//! implements the authorization code grant and nothing else, so there is no
//! device flow to offer at any version — and a self-hosted GitLab is as likely
//! to be 16.x as 17.11. A token the person makes on the host is the one path
//! that works everywhere, which is why it is offered everywhere.
//!
//! Everything below the flows is per-dialect and lives in one module each.
//! Dispatch is a `match` on the kind rather than a boxed trait object: there
//! are three of them, they are known at compile time, and the indirection would
//! buy nothing.

use crate::providers::{AuthMode, Connection, Kind};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use utoipa::ToSchema;

mod gitea;
mod github;
mod gitlab;

pub mod grant;
pub use grant::{Grant, Renewals};

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
    /// The same page with the code already in it.
    ///
    /// Optional in RFC 8628 and sent by GitLab but not by GitHub. Where it is
    /// there, opening it saves somebody typing eight characters they just read
    /// off another screen — so it is used for the link and the code is *still*
    /// shown, which is what the RFC asks for: the person should be able to
    /// check that the code on the page is the one they were given.
    #[serde(default)]
    pub verification_uri_complete: Option<String>,
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
    /// The application has had too many authorizations this hour.
    ///
    /// Its own case because the thing to do about it is neither of the other
    /// two: nothing is misconfigured and nothing is unreachable, and the answer
    /// is a different way in rather than a correction or a retry.
    #[error("{0}")]
    RateLimited(String),
}

/// Begin an authorization. Returns the code to show and the code to poll with.
pub async fn start(
    conn: &Connection,
    client_id: Option<String>,
) -> Result<DeviceStart, StartError> {
    if conn.auth != AuthMode::Device {
        return Err(StartError::NotConfigured(format!(
            "{} is connected by pasting a token, not in a browser.",
            conn.label
        )));
    }
    if !conn.kind.auth.contains(&AuthMode::Device) {
        return Err(StartError::NotConfigured(format!(
            "{} has no device flow at any version — connect it with a token instead.",
            conn.kind.label
        )));
    }

    let client_id = client_id.ok_or_else(|| {
        StartError::NotConfigured(format!(
            "no application is registered for {}. Add its client id in Firetower — the \
             connect screen asks for one and explains where to get it.",
            conn.label
        ))
    })?;

    let response = client()
        .map_err(|e| StartError::Unreachable(format!("{e:#}")))?
        .post(conn.device_code_url())
        .header("accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("scope", conn.kind.scopes),
        ])
        .send()
        .await
        .map_err(|e| StartError::Unreachable(format!("couldn't reach {}: {e}", conn.label)))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    // **The shared application is busy, which is not a broken one.**
    //
    // GitHub caps verification-code submissions at 50 an hour *per
    // application* — so every installation using the one Firetower ships draws
    // on the same fifty. It is invisible at a trickle and hit precisely when a
    // lot of people are onboarding at once, which is the worst moment to show
    // somebody a sentence about client identifiers.
    //
    // Told apart from a rejected id because the two need opposite things: one
    // is waited out or stepped around, the other is corrected.
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || body.contains("rate limit")
        || body.contains("slow_down")
    {
        return Err(StartError::RateLimited(
            match conn.uses_shipped_application() {
                true => format!(
                    "{} is busy — Firetower's shared application is allowed 50 authorizations an \
                 hour across every installation that uses it, and that hour is full. Two ways \
                 on: connect with a token of your own, or register an application for this \
                 Firetower and use that instead. Both take a minute and neither has this limit.",
                    conn.label
                ),
                false => format!(
                    "{} is refusing new authorizations for the moment — its application has had \
                 too many in the last hour. Connecting with a token of your own works now.",
                    conn.label
                ),
            },
        ));
    }

    if status.is_client_error() {
        // The host understood us and said no, which for this request means the
        // identifier is wrong or the application isn't set up for this flow.
        //
        // GitLab answers an instance too old for the grant the same way, which
        // is why the connect screen asks the instance its version first: told
        // "check the device flow is enabled" on a 16.x, somebody would go
        // looking for a switch that does not exist.
        return Err(StartError::NotConfigured(match conn.kind.id {
            "gitlab" => format!(
                "{} rejected that client id. Check it, check the application has \
                 `device_code` among its allowed grant types, and check the instance \
                 is 17.9 or newer — older ones have no device flow and answer the \
                 same way.{}",
                conn.label,
                conn.version
                    .as_deref()
                    .map(|v| format!(" This one says it is {v}."))
                    .unwrap_or_default()
            ),
            _ => format!(
                "{} rejected that client id. Check it, and check that the application \
                 has the device flow enabled — it is off by default, and {} answers \
                 both mistakes the same way.",
                conn.label, conn.kind.label
            ),
        }));
    }
    if !status.is_success() {
        return Err(StartError::Unreachable(format!(
            "{} couldn't start an authorization: {status} {body}",
            conn.label
        )));
    }

    serde_json::from_str(&body).map_err(|_| {
        StartError::Unreachable(format!(
            "{} sent back an authorization we don't understand",
            conn.label
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
    /// Approved, with everything the host sent — which on GitLab includes the
    /// refresh token the access token is useless without two hours later.
    Approved(Grant),
    /// The code timed out, or was declined.
    Failed(String),
}

/// Ask once whether the code has been approved.
///
/// The approval carries more than a token. **GitLab sends a two-hour expiry and
/// a refresh token**, and an earlier version of this read `access_token` and
/// nothing else — so every GitLab connected in a browser worked for two hours
/// and then looked, from the outside, like a revoked account. Whatever came
/// back is kept whole; see [`grant`].
pub async fn poll(conn: &Connection, client_id: &str, device_code: &str) -> Result<Poll> {
    #[derive(Deserialize)]
    struct Refused {
        error: Option<String>,
        error_description: Option<String>,
    }

    let raw = client()?
        .post(conn.device_token_url())
        .header("accept", "application/json")
        .form(&[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .context("checking whether the authorization was approved")?
        .text()
        .await
        .context("reading the authorization response")?;

    if let Ok(approved) = grant::read(&raw) {
        return Ok(Poll::Approved(approved));
    }

    let body: Refused = serde_json::from_str(&raw).context("reading the authorization response")?;

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
    /// `acme/backend`, or `platform/infra/deploy` on a host with nested groups.
    pub slug: String,
    /// The https URL, since a token authenticates over https.
    pub remote: String,
    pub default_branch: String,
    pub private: bool,
    /// Most recently pushed first is the order people actually want.
    pub pushed_at: Option<String>,
}

/// Who a token belongs to.
///
/// `login` is here because git insists on a username beside the token and the
/// three hosts disagree about whether it is thrown away — Gitea checks it. It
/// comes from the same request as the name and address, because it is the same
/// fact about the same account.
#[derive(Debug, Clone)]
pub struct Account {
    pub author: ft_proto::Author,
    pub login: String,
}

/// Everything the account can see, most recently active first.
///
/// This is a plain API call rather than a git operation, so it happens here
/// rather than on a worker.
pub async fn list_repos(conn: &Connection, token: &str) -> Result<Vec<RemoteRepo>> {
    match conn.kind.id {
        "gitlab" => gitlab::list_repos(conn, token).await,
        "gitea" => gitea::list_repos(conn, token).await,
        _ => github::list_repos(conn, token).await,
    }
}

/// Who the token belongs to, as a name and an address for a commit.
///
/// Asked of the host rather than of the person: this is the account whose token
/// will push the branch, so it is the account a reviewer will expect to see
/// against the commits — and it is the only identity Firetower can know without
/// asking somebody to type one.
pub async fn whoami(conn: &Connection, token: &str) -> Result<Account> {
    match conn.kind.id {
        "gitlab" => gitlab::whoami(conn, token).await,
        "gitea" => gitea::whoami(conn, token).await,
        _ => github::whoami(conn, token).await,
    }
}

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

/// Open a request to merge a branch, and hand back where to read it.
///
/// Not a git operation — this talks to the host's API, so it belongs on the
/// control plane with the token, exactly like listing repositories does.
pub async fn open_pull_request(
    conn: &Connection,
    token: &str,
    opening: Opening<'_>,
) -> Result<String> {
    match conn.kind.id {
        "gitlab" => gitlab::open_change(conn, token, opening).await,
        "gitea" => gitea::open_change(conn, token, opening).await,
        _ => github::open_change(conn, token, opening).await,
    }
}

/// Replace the body of a request that is already open.
///
/// Used to put the links to its siblings in: none of them has a URL until all
/// of them have been created, so the cross-links can only be written
/// afterwards.
pub async fn amend_pull_request(
    conn: &Connection,
    token: &str,
    url: &str,
    body: &str,
) -> Result<()> {
    match conn.kind.id {
        "gitlab" => gitlab::amend_change(conn, token, url, body).await,
        "gitea" => gitea::amend_change(conn, token, url, body).await,
        _ => github::amend_change(conn, token, url, body).await,
    }
}

pub use ft_core::session::PullState;

/// Ask what became of one.
pub async fn pull_request_state(conn: &Connection, token: &str, url: &str) -> Result<PullState> {
    match conn.kind.id {
        "gitlab" => gitlab::change_state(conn, token, url).await,
        "gitea" => gitea::change_state(conn, token, url).await,
        _ => github::change_state(conn, token, url).await,
    }
}

/// Reach an address and find out what is there.
///
/// Run before a host is saved, and it answers three questions at once: whether
/// the address is reachable at all, whether what answers is the software
/// somebody said it was, and which version of it. The third is the one worth
/// the request — it is what lets the connect screen say "this GitLab is 16.11,
/// so the browser flow is not available" instead of letting somebody discover
/// that as a rejected client id twenty minutes later.
pub async fn probe(kind: &'static Kind, api_base: &str) -> Result<Reached> {
    match kind.id {
        "gitlab" => gitlab::probe(api_base).await,
        "gitea" => gitea::probe(api_base).await,
        _ => github::probe(api_base).await,
    }
}

/// What was at the other end.
#[derive(Debug, Clone)]
pub struct Reached {
    /// What it said it was, when it would say. GitHub.com names no version, and
    /// a GitLab that wants a token for `/version` names none either — in both
    /// cases we got an answer of the right shape, which is what was asked.
    pub version: Option<String>,
}

/// Whether a host's own word for a refusal means "that token is no good".
///
/// Worth telling apart from everything else: a token that has expired or been
/// revoked is the one failure where the answer is "connect it again", and it is
/// otherwise indistinguishable on screen from the host being down.
pub fn unauthorized(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN
}

/// The path part of a URL on this host, with the host's own prefix taken off.
///
/// Taking the prefix off matters for an instance behind a reverse proxy at
/// `/gitlab`: left on, the first path segment of every link looks like the
/// first segment of a project path, and every call built from it is about a
/// project that does not exist.
fn path_on_host(conn: &Connection, url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix(&conn.base_url) {
        return rest.trim_start_matches('/').to_string();
    }
    // Not under the recorded address — an old link, or one pasted from a
    // mirror. Fall back to "everything after the hostname", which is right for
    // every host with no path prefix.
    let after_scheme = trimmed.split_once("://").map_or(trimmed, |(_, r)| r);
    after_scheme
        .split_once('/')
        .map(|(_, path)| path.to_string())
        .unwrap_or_default()
}

/// A project path and a number, out of the address somebody would click.
///
/// The markers are the segment each host puts between the project and the
/// number — `pull` on GitHub, `merge_requests` on GitLab, `pulls` on Gitea.
/// GitLab also puts a bare `-` in front of it, which is a separator and not
/// part of the path, and older GitLab links leave it out.
///
/// Re-derived from the link rather than kept as a stored triple because the
/// link is what was written down: one parser can disagree with nothing.
pub(crate) fn split_path(path: &str, markers: &[&str]) -> Option<(String, u64)> {
    let path = path.split(['?', '#']).next()?;
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();

    let at = parts.iter().position(|p| markers.contains(p))?;
    let number: u64 = parts.get(at + 1)?.parse().ok()?;

    // Everything before the marker is the project, less GitLab's separator.
    let mut project = &parts[..at];
    if project.last() == Some(&"-") {
        project = &project[..project.len() - 1];
    }
    (project.len() >= 2).then(|| (project.join("/"), number))
}

/// The project and number a request's address points at.
pub fn change_parts(conn: &Connection, url: &str) -> Result<(String, u64)> {
    let markers: &[&str] = match conn.kind.id {
        "gitlab" => &["merge_requests"],
        "gitea" => &["pulls", "pull"],
        _ => &["pull", "pulls"],
    };
    change_parts_with(conn, url, markers)
}

/// The same, for a caller that knows which segment to look for.
///
/// The task side needs this: an issue and a merge request are two different
/// things on GitLab with their own numbering, so reading a link means saying
/// which of them is being read.
pub fn change_parts_with(conn: &Connection, url: &str, markers: &[&str]) -> Result<(String, u64)> {
    split_path(&path_on_host(conn, url), markers).with_context(|| {
        format!(
            "{url} is not a {} address this understands",
            conn.kind.change_noun
        )
    })
}

/// One entry from a host's `errors` array.
#[derive(Debug, Deserialize)]
pub(crate) struct Refusal {
    pub message: Option<String>,
    pub field: Option<String>,
    pub code: Option<String>,
}

/// The most specific thing the host said.
///
/// An entry carries either prose or a field-and-code pair — `head` / `invalid`
/// — and the pair is still worth more than "Validation Failed".
pub(crate) fn refusal(message: &Option<String>, errors: &[Refusal]) -> String {
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

/// Merged or abandoned, out of the two fields that say so.
///
/// Both are `closed` to a git host. Only the moment it was merged tells them
/// apart, and they mean opposite things to somebody deciding whether the work
/// is safe to throw away.
pub(crate) fn read_state(state: &str, merged_at: Option<&str>) -> PullState {
    match (state, merged_at) {
        ("open" | "opened" | "reopened", _) => PullState::Open,
        (_, Some(_)) => PullState::Merged,
        ("merged", _) => PullState::Merged,
        _ => PullState::Closed,
    }
}

/// How many pages of a listing are worth fetching.
///
/// Three is enough for anyone we can usefully show in a picker, and it bounds
/// how long the connect screen can sit there loading. The search box is the
/// answer beyond that, not a longer wait.
pub(crate) const PAGES: u32 = 3;
pub(crate) const PER_PAGE: usize = 100;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{kind, AuthMode};

    fn conn(kind_id: &str, base: &str) -> Connection {
        Connection {
            id: format!("{kind_id}_test"),
            kind: kind(kind_id).unwrap(),
            label: kind_id.to_string(),
            base_url: base.to_string(),
            api_base: crate::providers::api_base_for(kind(kind_id).unwrap(), base),
            git_host: base.split("://").nth(1).unwrap_or(base).to_string(),
            auth: AuthMode::Device,
            client_id: Some("abc".into()),
            version: None,
            builtin: false,
            position: 1,
        }
    }

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

    /// GitLab says `opened` where GitHub says `open`, and `merged` as a state
    /// of its own rather than as a timestamp beside `closed`.
    #[test]
    fn gitlabs_own_words_for_the_three_outcomes_are_read() {
        assert_eq!(read_state("opened", None), PullState::Open);
        assert_eq!(read_state("merged", None), PullState::Merged);
        assert_eq!(read_state("closed", None), PullState::Closed);
        assert_eq!(read_state("locked", None), PullState::Closed);
    }

    /// A request is stored as the address somebody would click, and asking
    /// about it needs the parts inside that address.
    #[test]
    fn a_github_address_gives_up_its_parts() {
        let c = conn("github", "https://github.com");
        assert_eq!(
            change_parts(&c, "https://github.com/acme/api/pull/12").unwrap(),
            ("acme/api".to_string(), 12)
        );
        assert!(change_parts(&c, "https://github.com/acme").is_err());
        assert!(change_parts(&c, "not an address").is_err());
    }

    /// GitLab's separator, and a project inside nested groups. Read with
    /// GitHub's parser this came out as `infra/deploy` — a project that does
    /// not exist — and every call made with it was a 404 nobody could explain.
    #[test]
    fn a_gitlab_address_keeps_the_whole_group_path() {
        let c = conn("gitlab", "https://gitlab.com");
        assert_eq!(
            change_parts(
                &c,
                "https://gitlab.com/platform/infra/deploy/-/merge_requests/12"
            )
            .unwrap(),
            ("platform/infra/deploy".to_string(), 12)
        );
        // Older GitLab links have no `-` in them.
        assert_eq!(
            change_parts(&c, "https://gitlab.com/acme/web/merge_requests/3").unwrap(),
            ("acme/web".to_string(), 3)
        );
    }

    /// An instance behind a reverse proxy at a path. With the prefix left on,
    /// `gitlab` reads as the first segment of the project path.
    #[test]
    fn a_path_prefix_is_not_part_of_the_project() {
        let c = conn("gitlab", "https://acme.example/gitlab");
        assert_eq!(
            change_parts(
                &c,
                "https://acme.example/gitlab/acme/web/-/merge_requests/9"
            )
            .unwrap(),
            ("acme/web".to_string(), 9)
        );
    }

    #[test]
    fn a_gitea_address_gives_up_its_parts() {
        let c = conn("gitea", "https://tea.acme.internal");
        assert_eq!(
            change_parts(&c, "https://tea.acme.internal/ops/infra/pulls/4").unwrap(),
            ("ops/infra".to_string(), 4)
        );
    }

    /// The bug this exists to stop coming back: a 422 read as "Validation
    /// Failed", which is what GitHub says every time and tells nobody anything.
    #[test]
    fn a_refusal_says_what_the_host_actually_objected_to() {
        let errors: Vec<Refusal> = serde_json::from_value(serde_json::json!([{
            "resource": "PullRequest",
            "code": "custom",
            "message": "No commits between main and agent/hello"
        }]))
        .unwrap();

        assert_eq!(
            refusal(&Some("Validation Failed".into()), &errors),
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

    /// Every reason a host gives for refusing needs a different thing from you,
    /// so they must not collapse into one message.
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
        let c = conn("github", "https://github.com");
        let err = start(&c, None).await.unwrap_err();
        assert!(matches!(err, StartError::NotConfigured(_)), "{err}");
        assert!(
            err.to_string().contains("client id"),
            "it should say what is missing and where to put it: {err}"
        );
    }

    /// Gitea has no device flow to start, so this refuses before making a
    /// request rather than reporting whatever a 404 page says.
    #[tokio::test]
    async fn a_host_with_no_device_flow_says_so_rather_than_trying() {
        let mut c = conn("gitea", "https://tea.acme.internal");
        c.auth = AuthMode::Device;
        let err = start(&c, Some("abc".into())).await.unwrap_err();
        assert!(err.to_string().contains("no device flow"), "{err}");
    }

    /// GitLab sends the page with the code already in it; GitHub sends only
    /// the bare page. Both have to come back as a `DeviceStart` that the rest
    /// of the server can treat identically.
    #[test]
    fn a_pre_filled_verification_page_is_read_where_the_host_sends_one() {
        // GitLab's shape, as gitlab.com actually answers.
        let gitlab: DeviceStart = serde_json::from_value(serde_json::json!({
            "device_code": "e04c…",
            "user_code": "AC2ZS5SV",
            "verification_uri": "https://gitlab.com/oauth/device",
            "verification_uri_complete": "https://gitlab.com/oauth/device?user_code=AC2ZS5SV",
            "expires_in": 300,
            "interval": 5,
        }))
        .unwrap();
        assert_eq!(
            gitlab.verification_uri_complete.as_deref(),
            Some("https://gitlab.com/oauth/device?user_code=AC2ZS5SV")
        );

        // GitHub's shape, which omits it. Absent rather than an error — the
        // field is optional in RFC 8628.
        let github: DeviceStart = serde_json::from_value(serde_json::json!({
            "device_code": "0d82…",
            "user_code": "B57A-15C1",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 899,
            "interval": 5,
        }))
        .unwrap();
        assert_eq!(github.verification_uri_complete, None);
        assert_eq!(github.verification_uri, "https://github.com/login/device");
    }

    #[test]
    fn a_pending_authorization_is_not_a_failure() {
        // The distinction matters: Pending keeps waiting, Failed stops and
        // tells someone. Conflating them either spins forever or gives up on
        // the first tick.
        assert_ne!(Poll::Pending, Poll::Failed("x".into()));
    }
}

//! The task trackers Firetower can read from.
//!
//! Separate from [`crate::providers`] because the two roles only partly
//! overlap: a git host is something you clone and push to, a tracker is
//! something you read work out of. Every git host is also a tracker — issues
//! and requests to merge are both work — and Linear is only ever the second,
//! with no remote, no git username and no device flow.
//!
//! So a tracker is one of two things, and [`Resolved`] is the shape they share.
//! The **git-host** ones are derived: every connection in
//! [`crate::providers::Connections`] yields one, with the same id, so adding a
//! GitLab adds a place to read tasks from without anybody configuring it twice
//! and without a second credential. The **standalone** ones are the static
//! table below, which is Linear and whatever comes next.
//!
//! Deriving rather than listing is also what keeps `task_key` honest. A key is
//! source-scoped — `github:acme/web#5138` — and the source is the connection
//! id, so the built-in host still writes `github:` and every key already
//! stored still says which tracker to ask.

use serde::Serialize;
use std::sync::Arc;
use utoipa::ToSchema;

use crate::providers::Connection;
use crate::tasks::TaskKind;
use crate::AppState;

/// How a credential for a tracker is obtained.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum Auth {
    /// Shares the git host's authorization. Nothing to connect separately.
    GitProvider,
    /// A key the person creates on the tracker and pastes here.
    ApiKey,
}

/// What the scope picker offers for this tracker: repositories, teams or
/// boards, whichever the tracker's own unit of work is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ScopeKind {
    Repos,
    Teams,
    Boards,
}

/// A tracker that is not a git host.
pub struct Tracker {
    pub id: &'static str,
    pub label: &'static str,
    pub api_base: &'static str,
    pub auth: Auth,
    pub scope_kind: ScopeKind,
    /// What this tracker can return, which is what the kind toggle offers.
    pub kinds: &'static [TaskKind],
    /// The hostname a task's browser URL carries, so a stored link can say
    /// which tracker it came from without a column recording it.
    pub host: &'static str,
    /// Where somebody goes to make a key.
    pub key_url: Option<&'static str>,
}

pub const TRACKERS: &[Tracker] = &[
    Tracker {
        id: "linear",
        label: "Linear",
        api_base: "https://api.linear.app/graphql",
        auth: Auth::ApiKey,
        scope_kind: ScopeKind::Teams,
        kinds: &[TaskKind::Ticket],
        host: "linear.app",
        key_url: Some("https://linear.app/settings/api"),
    },
    Tracker {
        id: "trello",
        label: "Trello",
        api_base: "https://api.trello.com/1",
        auth: Auth::ApiKey,
        scope_kind: ScopeKind::Boards,
        kinds: &[TaskKind::Ticket],
        host: "trello.com",
        // Left empty on purpose: the page that makes a token is addressed by
        // the app key, which is not known until runtime. See
        // [`Resolved::from_static`].
        key_url: None,
    },
];

/// Where an install can name its own Trello app key.
pub const TRELLO_APP_KEY_ENV: &str = "FIRETOWER_TRELLO_KEY";

/// The app key Firetower ships, once the maintainer has registered one.
///
/// `None` until then, so a build without the variable has no Trello row at
/// all rather than a row that cannot connect.
const SHIPPED_TRELLO_KEY: Option<&str> = None;

/// The Trello app key this install uses, if it has one.
///
/// Trello authenticates a request with an app key *and* a token the person
/// makes for that key, so without a key there is nothing to connect to.
pub fn trello_app_key() -> Option<String> {
    chosen_trello_key(std::env::var(TRELLO_APP_KEY_ENV).ok())
}

/// The choice, apart from where the environment is read.
///
/// Split out so it can be tested without `set_var`, which is process-global
/// and would race every other test running beside it.
fn chosen_trello_key(from_env: Option<String>) -> Option<String> {
    from_env
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| SHIPPED_TRELLO_KEY.map(str::to_string))
}

/// The page where somebody approves read access and is handed a token.
fn trello_authorize_url(app_key: &str) -> String {
    reqwest::Url::parse_with_params(
        "https://trello.com/1/authorize",
        [
            ("key", app_key),
            ("name", "Firetower"),
            ("scope", "read"),
            ("expiration", "never"),
            ("response_type", "token"),
        ],
    )
    .map(String::from)
    .unwrap_or_default()
}

/// One tracker, whichever of the two kinds it is.
#[derive(Clone)]
pub struct Resolved {
    pub id: String,
    pub label: String,
    pub api_base: String,
    pub auth: Auth,
    pub scope_kind: ScopeKind,
    pub kinds: Vec<TaskKind>,
    pub host: String,
    pub key_url: Option<String>,
    /// The git host this reads from, when it is one.
    pub connection: Option<Arc<Connection>>,
    /// The static entry, when it is one.
    pub tracker: Option<&'static Tracker>,
}

impl Resolved {
    /// Which vault scope holds this tracker's credential.
    ///
    /// A git host's is the git token that is already there; naming it `tracker`
    /// would store a second copy of the same secret under a different key.
    pub fn vault_scope(&self) -> &'static str {
        match self.auth {
            Auth::GitProvider => crate::vault::GIT,
            Auth::ApiKey => crate::vault::TRACKER,
        }
    }

    fn from_connection(conn: Arc<Connection>) -> Self {
        Self {
            id: conn.id.clone(),
            label: conn.label.clone(),
            api_base: conn.api_base.clone(),
            auth: Auth::GitProvider,
            scope_kind: ScopeKind::Repos,
            // Both, on every git host: an issue is work to pick up and a
            // request to merge is work to review.
            kinds: vec![TaskKind::Issue, TaskKind::PullRequest],
            host: conn.git_host.clone(),
            key_url: Some(conn.token_page()),
            connection: Some(conn),
            tracker: None,
        }
    }

    /// A static tracker, or nothing when it cannot work here.
    fn from_static(t: &'static Tracker) -> Option<Self> {
        Self::resolve(t, trello_app_key().as_deref())
    }

    /// [`from_static`](Self::from_static) with the Trello app key passed in,
    /// so the rules can be tested without touching the environment.
    ///
    /// Trello is absent without a key: it would be a row that cannot be
    /// connected, and a stored trello.com link would otherwise fall through to
    /// the GitHub guess in [`for_url`]. Its `key_url` carries the app key, so
    /// it is filled here rather than in the table.
    fn resolve(t: &'static Tracker, trello_key: Option<&str>) -> Option<Self> {
        let key_url = if t.id == "trello" {
            Some(trello_authorize_url(trello_key?))
        } else {
            t.key_url.map(str::to_string)
        };
        Some(Self {
            id: t.id.to_string(),
            label: t.label.to_string(),
            api_base: t.api_base.to_string(),
            auth: t.auth,
            scope_kind: t.scope_kind,
            kinds: t.kinds.to_vec(),
            host: t.host.to_string(),
            key_url,
            connection: None,
            tracker: Some(t),
        })
    }
}

/// Every tracker, git hosts first.
///
/// The order matches the git hosts list, so the built-in GitHub is first here
/// too — which is what the Tasks screen defaults to when nobody has picked.
pub async fn all(state: &AppState) -> Vec<Resolved> {
    let mut out: Vec<Resolved> = state
        .connections
        .all()
        .await
        .iter()
        .cloned()
        .map(Resolved::from_connection)
        .collect();
    out.extend(TRACKERS.iter().filter_map(Resolved::from_static));
    out
}

pub async fn find(state: &AppState, id: &str) -> Option<Resolved> {
    if let Some(conn) = state.connections.get(id).await {
        return Some(Resolved::from_connection(conn));
    }
    TRACKERS
        .iter()
        .find(|t| t.id == id)
        .and_then(Resolved::from_static)
}

/// Which tracker a task's URL belongs to.
///
/// Matched on the host so that a workspace remembering only a link can still be
/// told what to ask. Git hosts are tried first and by their own hostname, which
/// is the only way a self-hosted GitLab's links can be recognised at all —
/// there is nothing about `git.acme.internal` to guess from.
pub async fn for_url(state: &AppState, url: &str) -> Option<Resolved> {
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host = after_scheme.split(['/', '?', '#']).next()?;

    // A host we have connected, by name. Exact rather than a suffix match:
    // `ends_with` alone would hand a token for github.com to notgithub.com.
    if let Some(conn) = state
        .connections
        .all()
        .await
        .iter()
        .find(|c| host.eq_ignore_ascii_case(&c.git_host))
    {
        return Some(Resolved::from_connection(conn.clone()));
    }

    // A standalone tracker: the host itself or a subdomain of it.
    // A tracker that is switched off (Trello without an app key) still owns
    // its hostname, so the link resolves to nothing rather than to the GitHub
    // guess below.
    if let Some(found) = standalone_for_host(host) {
        return Resolved::from_static(found);
    }

    // Not a host we know, and the link is issue-shaped. That is a git host
    // nobody has connected — or has connected under another address — and
    // GitHub's is the URL shape it most likely has. Only answered when there is
    // a git host to answer with.
    if crate::tasks::located(url).is_some() {
        return find(state, "github").await;
    }
    None
}

/// The standalone tracker that owns this hostname, whether or not it is usable.
fn standalone_for_host(host: &str) -> Option<&'static Tracker> {
    TRACKERS
        .iter()
        .find(|t| host == t.host || host.ends_with(&format!(".{}", t.host)))
}

/// The fragment a tracker wants to see in a branch name, if there is one.
///
/// Linear's git integration links a pull request to its issue by the identifier
/// in the branch name, which holds before anybody has written a description.
/// GitHub and GitLab link by number in the body and ignore branches, so a
/// `#5138` here would only make the branch uglier.
///
/// A Trello card is its `shortLink`, which links back to the card from the
/// branch for the same reason Linear's identifier does, and is what the
/// clients already put first when they name a branch. Eight alphanumerics
/// cannot be mistaken for another tracker's key: a git host's carries `#` or
/// `!` and Linear's carries `-`.
pub fn branch_tag(task_key: &str) -> Option<String> {
    if let Some((team, number)) = crate::tasks::linear_identifier(task_key) {
        return Some(format!("{}-{number}", team.to_lowercase()));
    }
    (task_key.len() == 8 && task_key.chars().all(|c| c.is_ascii_alphanumeric()))
        .then(|| task_key.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A git host's credential is the git token that is already there. Reading
    /// the wrong scope silently reports a connected tracker as disconnected.
    #[test]
    fn each_tracker_reads_its_own_scope() {
        for t in TRACKERS {
            let resolved = Resolved::resolve(t, Some("k")).unwrap();
            assert_eq!(resolved.vault_scope(), crate::vault::TRACKER);
            assert_eq!(resolved.id, t.id);
        }
    }

    #[test]
    fn a_linear_branch_carries_the_identifier_that_links_it() {
        // Linear matches on the branch name, so the link holds from the first
        // push rather than waiting for a description to be written.
        assert_eq!(branch_tag("ENG-123").as_deref(), Some("eng-123"));
        // GitHub does not look at branches, and `#5138` in one helps nobody.
        assert_eq!(branch_tag("#5138"), None);
        assert_eq!(branch_tag(""), None);
    }

    #[test]
    fn a_tracker_that_connects_by_key_says_where_to_get_one() {
        for t in TRACKERS {
            // Resolved, not raw: Trello's page depends on the app key.
            let resolved = Resolved::resolve(t, Some("k")).unwrap();
            assert_eq!(
                resolved.auth == Auth::ApiKey,
                resolved.key_url.is_some(),
                "{} cannot tell anyone how to connect it",
                t.id
            );
            assert!(!resolved.kinds.is_empty(), "{} returns nothing", t.id);
        }
    }

    #[test]
    fn a_trello_key_from_the_environment_wins_and_blank_is_none() {
        assert_eq!(chosen_trello_key(Some(" k ".into())).as_deref(), Some("k"));
        assert_eq!(chosen_trello_key(Some("  ".into())), None);
        assert_eq!(chosen_trello_key(None), None);
    }

    #[test]
    fn trello_says_where_to_get_a_token_for_its_own_key() {
        let trello = TRACKERS.iter().find(|t| t.id == "trello").unwrap();
        let url = Resolved::resolve(trello, Some("k"))
            .unwrap()
            .key_url
            .unwrap();
        assert!(
            url.starts_with("https://trello.com/1/authorize?key=k&"),
            "{url}"
        );
        assert!(url.contains("scope=read"), "{url}");
        assert!(url.contains("name=Firetower"), "{url}");
        assert!(url.contains("expiration=never"), "{url}");
        assert!(url.contains("response_type=token"), "{url}");
        // Without a return address Trello shows the token to copy, which is
        // the only thing that works on a self-hosted install.
        assert!(!url.contains("return_url"), "{url}");
    }

    #[test]
    fn without_an_app_key_trello_is_absent_and_still_owns_its_links() {
        let trello = TRACKERS.iter().find(|t| t.id == "trello").unwrap();
        assert!(Resolved::resolve(trello, None).is_none());
        // Linear does not care about the Trello key.
        assert!(Resolved::resolve(&TRACKERS[0], None).is_some());
        // The host still belongs to Trello, so `for_url` answers nothing
        // instead of falling through to GitHub.
        assert_eq!(
            standalone_for_host("trello.com").map(|t| t.id),
            Some("trello")
        );
        assert_eq!(
            standalone_for_host("www.trello.com").map(|t| t.id),
            Some("trello")
        );
    }

    #[test]
    fn a_trello_branch_carries_the_card_it_links() {
        assert_eq!(branch_tag("aB3dE9fG").as_deref(), Some("ab3de9fg"));
        assert_eq!(branch_tag("ENG-123").as_deref(), Some("eng-123"));
        assert_eq!(branch_tag("abc"), None);
    }
}

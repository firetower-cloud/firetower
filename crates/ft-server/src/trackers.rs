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

/// What the scope picker offers for this tracker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ScopeKind {
    Repos,
    Teams,
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

pub const TRACKERS: &[Tracker] = &[Tracker {
    id: "linear",
    label: "Linear",
    api_base: "https://api.linear.app/graphql",
    auth: Auth::ApiKey,
    scope_kind: ScopeKind::Teams,
    kinds: &[TaskKind::Ticket],
    host: "linear.app",
    key_url: Some("https://linear.app/settings/api"),
}];

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

    fn from_static(t: &'static Tracker) -> Self {
        Self {
            id: t.id.to_string(),
            label: t.label.to_string(),
            api_base: t.api_base.to_string(),
            auth: t.auth,
            scope_kind: t.scope_kind,
            kinds: t.kinds.to_vec(),
            host: t.host.to_string(),
            key_url: t.key_url.map(str::to_string),
            connection: None,
            tracker: Some(t),
        }
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
    out.extend(TRACKERS.iter().map(Resolved::from_static));
    out
}

pub async fn find(state: &AppState, id: &str) -> Option<Resolved> {
    if let Some(conn) = state.connections.get(id).await {
        return Some(Resolved::from_connection(conn));
    }
    TRACKERS
        .iter()
        .find(|t| t.id == id)
        .map(Resolved::from_static)
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
    if let Some(found) = TRACKERS
        .iter()
        .find(|t| host == t.host || host.ends_with(&format!(".{}", t.host)))
    {
        return Some(Resolved::from_static(found));
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

/// The fragment a tracker wants to see in a branch name, if there is one.
///
/// Linear's git integration links a pull request to its issue by the identifier
/// in the branch name, which holds before anybody has written a description.
/// GitHub and GitLab link by number in the body and ignore branches, so a
/// `#5138` here would only make the branch uglier.
pub fn branch_tag(task_key: &str) -> Option<String> {
    let (team, number) = crate::tasks::linear_identifier(task_key)?;
    Some(format!("{}-{number}", team.to_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A git host's credential is the git token that is already there. Reading
    /// the wrong scope silently reports a connected tracker as disconnected.
    #[test]
    fn each_tracker_reads_its_own_scope() {
        let linear = Resolved::from_static(&TRACKERS[0]);
        assert_eq!(linear.vault_scope(), crate::vault::TRACKER);
        assert_eq!(linear.id, "linear");
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
            assert_eq!(
                t.auth == Auth::ApiKey,
                t.key_url.is_some(),
                "{} cannot tell anyone how to connect it",
                t.id
            );
            assert!(!t.kinds.is_empty(), "{} returns nothing", t.id);
        }
    }
}

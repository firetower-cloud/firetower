//! The task trackers Firetower can read from.
//!
//! Separate from [`crate::providers`] because the two roles only overlap on
//! GitHub: a git host is something you clone and push to, a tracker is
//! something you read work out of. Linear is only ever the second, and has no
//! remote, no git username and no device flow.

use serde::Serialize;
use utoipa::ToSchema;

use crate::tasks::TaskKind;

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
    /// Where somebody goes to make a key, when that is how it connects.
    pub key_url: Option<&'static str>,
}

impl Tracker {
    /// Which vault scope holds this tracker's credential.
    ///
    /// GitHub's is the git token that is already there; naming it `tracker`
    /// would store a second copy of the same secret under a different key.
    pub fn vault_scope(&self) -> &'static str {
        match self.auth {
            Auth::GitProvider => crate::vault::GIT,
            Auth::ApiKey => crate::vault::TRACKER,
        }
    }
}

pub const TRACKERS: &[Tracker] = &[
    Tracker {
        id: "github",
        label: "GitHub",
        api_base: "https://api.github.com",
        auth: Auth::GitProvider,
        scope_kind: ScopeKind::Repos,
        kinds: &[TaskKind::Issue, TaskKind::PullRequest],
        host: "github.com",
        key_url: None,
    },
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
];

pub fn find(id: &str) -> Option<&'static Tracker> {
    TRACKERS.iter().find(|t| t.id == id)
}

/// Which tracker a task's URL belongs to.
///
/// Matched on the host so that a workspace remembering only a link can still
/// be told what to ask. A self-hosted git server falls through to GitHub,
/// which is the only tracker whose URL shape it can have.
pub fn for_url(url: &str) -> Option<&'static Tracker> {
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host = after_scheme.split(['/', '?', '#']).next()?;

    // The host itself or a subdomain of it, never a suffix match: `ends_with`
    // alone would hand a token for github.com to notgithub.com.
    let found = TRACKERS
        .iter()
        .find(|t| host == t.host || host.ends_with(&format!(".{}", t.host)));
    if let Some(found) = found {
        return Some(found);
    }

    // Not a host we know. An issue or pull path is GitHub's shape, and a
    // self-hosted GitHub is the case that reaches here.
    crate::tasks::located(url).and(find("github"))
}

/// The fragment a tracker wants to see in a branch name, if there is one.
///
/// Linear's git integration links a pull request to its issue by the
/// identifier in the branch name, which holds before anybody has written a
/// description. GitHub links by number in the body and ignores branches, so a
/// `#5138` here would only make the branch uglier.
pub fn branch_tag(task_key: &str) -> Option<String> {
    let (team, number) = crate::tasks::linear_identifier(task_key)?;
    Some(format!("{}-{number}", team.to_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_says_which_tracker_it_came_from() {
        assert_eq!(
            for_url("https://linear.app/acme/issue/ENG-123/promo-codes").map(|t| t.id),
            Some("linear")
        );
        assert_eq!(
            for_url("https://github.com/acme/web/issues/32").map(|t| t.id),
            Some("github")
        );
    }

    /// `ends_with` on its own would match notgithub.com and evil-linear.app,
    /// which are domains anybody can buy.
    ///
    /// Shown on paths that are not issue-shaped, because one that is falls
    /// through to the self-hosted case below on purpose.
    #[test]
    fn a_host_that_merely_ends_in_a_known_one_is_not_it() {
        assert!(for_url("https://notgithub.com/acme/web").is_none());
        assert!(for_url("https://evil-linear.app/acme/issue/ENG-1/x").is_none());
        // A real subdomain still is.
        assert_eq!(
            for_url("https://eu.linear.app/acme/issue/ENG-1/x").map(|t| t.id),
            Some("linear")
        );
    }

    #[test]
    fn a_self_hosted_git_host_is_still_github_shaped() {
        assert_eq!(
            for_url("https://git.acme.internal/acme/web/issues/7").map(|t| t.id),
            Some("github")
        );
        // Nothing issue-shaped about it, so nothing to guess.
        assert!(for_url("https://example.com/whatever").is_none());
    }

    /// The two credentials are different secrets under different scopes, and
    /// a tracker reading the wrong one silently reports itself disconnected.
    #[test]
    fn each_tracker_reads_its_own_scope() {
        assert_eq!(find("github").unwrap().vault_scope(), crate::vault::GIT);
        assert_eq!(find("linear").unwrap().vault_scope(), crate::vault::TRACKER);
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

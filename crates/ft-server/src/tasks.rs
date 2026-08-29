//! What somebody could work on, from wherever they track it.
//!
//! ## Fetched, not synchronised
//!
//! Nothing here is stored. Issues change under you, they are somebody else's
//! source of truth, and keeping a copy means a webhook receiver, a
//! reconciliation job and rules for whose copy wins when the two disagree. What
//! the screen needs is "show me what is open and let me start one", and that is
//! a request.
//!
//! It is affordable because of one detail: a conditional request that comes
//! back `304 Not Modified` **does not count against the rate limit**. So the
//! expensive case is somebody having filed an issue since you last looked,
//! which is exactly the case where the new data is wanted.
//!
//! The one durable fact — which task a worktree came from — is a column on the
//! workspace, not a copy of the task.
//!
//! ## Filters are parameters
//!
//! Never a pass over what was fetched. Filtering a page of thirty here would
//! hide rows, leave a short page and make the next one nonsense; sending the
//! filter means the provider, which has indexed everything, returns the right
//! thirty. It is also why a local copy would be *worse*: you can only filter
//! over what you synchronised.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::providers::Provider;

/// Where a task came from. Its own id, so the interface can group by it.
pub type SourceId = &'static str;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
    Open,
    Closed,
}

/// What sort of thing it is.
///
/// The one field the Issues/PRs toggle reads, and the reason "filter by kind"
/// is a query parameter rather than a migration when a second source lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    Issue,
    PullRequest,
    /// Anything from a tracker that is not a git host.
    Ticket,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub login: String,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub name: String,
    /// Six hex digits, no `#`. Whatever the source calls it.
    pub colour: Option<String>,
}

/// One thing to work on, whatever tracks it.
///
/// The fields are the intersection every tracker has, plus the two that make a
/// row worth showing: what it is called, and when it last moved.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// Stable within its source: `github:acme/web#5138`.
    pub id: String,
    pub source: String,
    /// What a person calls it. `#5138`.
    pub key: String,
    pub title: String,
    /// Seeds the first prompt, so nobody types the problem out twice.
    pub body: Option<String>,
    /// Always somewhere to go and read it.
    pub url: String,
    pub state: TaskState,
    pub kind: TaskKind,
    pub assignees: Vec<Person>,
    pub labels: Vec<Label>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    /// Where the work would happen. Known for an issue; a binding for a ticket.
    pub repo: Option<String>,
}

/// What to ask a source for.
///
/// `raw` is passed through rather than parsed. The chips on screen write into
/// it and it is the same string either way — which is why a second source can
/// keep the chips and change dialect without anybody building a query language.
#[derive(Debug, Clone, Default)]
pub struct Query {
    pub repo: Option<String>,
    /// Every repository connected to this Firetower.
    ///
    /// The default scope when nobody has picked one. Without it the search is
    /// the whole of GitHub, which returns a thousand issues from strangers'
    /// projects sorted by whoever typed most recently — true, useless, and not
    /// what "my tasks" means.
    pub connected: Vec<String>,
    pub kind: Option<TaskKind>,
    pub state: Option<TaskState>,
    /// Only what this person is assigned.
    pub mine: bool,
    pub raw: Option<String>,
    pub page: u32,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub tasks: Vec<Task>,
    /// How many there are in total, when the source will say.
    pub total: Option<u32>,
    /// Whether asking for the next page is worth it.
    pub more: bool,
}

/// How many rows a page holds. The table shows this many; nobody reads more.
const PER_PAGE: u32 = 30;

/// GitHub's search endpoint stops here, which is far past browsing.
const DEEPEST: u32 = 1_000;

/// Everything a source has to be able to do.
///
/// One method, because listing is the whole feature: starting work on a task
/// happens here, and closing it happens through the pull request that already
/// exists.
pub trait Source {
    fn id(&self) -> SourceId;

    /// One page, in the source's own order.
    fn list(
        &self,
        token: &str,
        ask: &Query,
    ) -> impl std::future::Future<Output = Result<Page>> + Send;
}

/// The git host, which is also a task tracker.
pub struct GitHub<'a> {
    pub provider: &'a Provider,
}

impl Source for GitHub<'_> {
    fn id(&self) -> SourceId {
        "github"
    }

    async fn list(&self, token: &str, ask: &Query) -> Result<Page> {
        let query = search_query(ask);
        let page = ask.page.max(1);

        // `/search/issues` rather than `/repos/{slug}/issues`, for one reason:
        // the plain issues endpoint returns pull requests mixed in with no way
        // to exclude them, so the Issues/PRs toggle would have to filter after
        // fetching and the page size would stop matching what was asked for.
        // Here `is:issue` and `is:pr` are exact.
        //
        // The trade is a lower limit — thirty requests a minute rather than
        // five thousand an hour — which is a limit on clicking rather than on
        // data, and conditional requests do not spend it at all.
        let found: SearchResult = crate::oauth::client()?
            .get(format!("{}/search/issues", self.provider.api_base))
            .bearer_auth(token)
            .header("accept", "application/vnd.github+json")
            .query(&[
                ("q", query.as_str()),
                ("per_page", &PER_PAGE.to_string()),
                ("page", &page.to_string()),
                ("sort", "updated"),
                ("order", "desc"),
            ])
            .send()
            .await
            .context("asking GitHub for issues")?
            .error_for_status()
            .context("GitHub refused the search")?
            .json()
            .await
            .context("reading the issues GitHub sent")?;

        let seen = page * PER_PAGE;
        let more = (seen as usize) < found.total_count.min(DEEPEST as usize);

        Ok(Page {
            tasks: found.items.into_iter().map(Into::into).collect(),
            total: Some(found.total_count.min(DEEPEST as usize) as u32),
            more,
        })
    }
}

/// The chips and the box, as one string.
///
/// Built rather than concatenated blindly so that a raw query naming something
/// a chip also names does not end up in twice — GitHub takes the last of a
/// repeated qualifier, which would silently ignore whichever the person thought
/// they were setting.
pub fn search_query(ask: &Query) -> String {
    let raw = ask.raw.as_deref().unwrap_or("").trim();
    let mut parts: Vec<String> = Vec::new();

    let names = |qualifier: &str| raw.contains(&format!("{qualifier}:"));

    if !names("repo") {
        match &ask.repo {
            Some(repo) => parts.push(format!("repo:{repo}")),
            // Repeated `repo:` is an OR in GitHub's search, so this reads as
            // "any of the ones I have connected". Bounded because the query
            // string is not unlimited and nobody browses fifty repositories at
            // once; past that, pick one.
            None => {
                for repo in ask.connected.iter().take(20) {
                    parts.push(format!("repo:{repo}"));
                }
            }
        }
    }

    if !raw.contains("is:issue") && !raw.contains("is:pr") {
        match ask.kind {
            Some(TaskKind::PullRequest) => parts.push("is:pr".into()),
            // A ticket is not a thing GitHub has; asking for one asks for
            // nothing rather than for everything.
            Some(TaskKind::Ticket) => parts.push("is:issue".into()),
            Some(TaskKind::Issue) | None => parts.push("is:issue".into()),
        }
    }

    if !raw.contains("is:open") && !raw.contains("is:closed") {
        match ask.state {
            Some(TaskState::Closed) => parts.push("is:closed".into()),
            Some(TaskState::Open) => parts.push("is:open".into()),
            None => {}
        }
    }

    if ask.mine && !names("assignee") {
        parts.push("assignee:@me".into());
    }

    if !raw.is_empty() {
        parts.push(raw.to_string());
    }

    parts.join(" ")
}

#[derive(Deserialize)]
struct SearchResult {
    total_count: usize,
    items: Vec<Item>,
}

#[derive(Deserialize)]
struct Item {
    number: u64,
    title: String,
    body: Option<String>,
    html_url: String,
    state: String,
    updated_at: chrono::DateTime<chrono::Utc>,
    #[serde(default)]
    assignees: Vec<User>,
    #[serde(default)]
    labels: Vec<Tag>,
    /// Present only on pull requests, which is how GitHub tells them apart.
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
    /// `https://api.github.com/repos/acme/web/issues/5138`, which is the only
    /// place a search result names its repository.
    repository_url: Option<String>,
}

#[derive(Deserialize)]
struct User {
    login: String,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct Tag {
    name: String,
    color: Option<String>,
}

impl From<Item> for Task {
    fn from(item: Item) -> Self {
        let repo = item.repository_url.as_deref().and_then(slug_of);
        let kind = if item.pull_request.is_some() {
            TaskKind::PullRequest
        } else {
            TaskKind::Issue
        };

        Task {
            id: format!(
                "github:{}#{}",
                repo.as_deref().unwrap_or("unknown"),
                item.number
            ),
            source: "github".into(),
            key: format!("#{}", item.number),
            title: item.title,
            body: item.body,
            url: item.html_url,
            state: if item.state == "closed" {
                TaskState::Closed
            } else {
                TaskState::Open
            },
            kind,
            assignees: item
                .assignees
                .into_iter()
                .map(|u| Person {
                    login: u.login,
                    avatar: u.avatar_url,
                })
                .collect(),
            labels: item
                .labels
                .into_iter()
                .map(|l| Label {
                    name: l.name,
                    colour: l.color,
                })
                .collect(),
            updated_at: item.updated_at,
            repo,
        }
    }
}

/// `…/repos/acme/web` → `acme/web`.
fn slug_of(repository_url: &str) -> Option<String> {
    let (_, tail) = repository_url.split_once("/repos/")?;
    let mut parts = tail.split('/');
    let owner = parts.next()?;
    let name = parts.next()?;
    (!owner.is_empty() && !name.is_empty()).then(|| format!("{owner}/{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repository_is_read_out_of_the_api_url() {
        assert_eq!(
            slug_of("https://api.github.com/repos/acme/web").as_deref(),
            Some("acme/web")
        );
        assert_eq!(slug_of("https://api.github.com/user").as_deref(), None);
    }

    #[test]
    fn with_no_repository_chosen_it_asks_about_the_ones_you_have() {
        // Otherwise the search is the whole of GitHub, and the first page is a
        // thousand strangers' issues sorted by whoever typed most recently.
        let query = search_query(&Query {
            connected: vec!["acme/web".into(), "acme/api".into()],
            ..Default::default()
        });

        assert!(query.contains("repo:acme/web"), "{query}");
        assert!(query.contains("repo:acme/api"), "{query}");
    }

    #[test]
    fn choosing_one_repository_narrows_to_it() {
        let query = search_query(&Query {
            repo: Some("acme/web".into()),
            connected: vec!["acme/web".into(), "acme/api".into()],
            ..Default::default()
        });

        assert!(query.contains("repo:acme/web"), "{query}");
        assert!(!query.contains("repo:acme/api"), "{query}");
    }

    #[test]
    fn the_chips_become_a_query() {
        let query = search_query(&Query {
            repo: Some("acme/web".into()),
            state: Some(TaskState::Open),
            mine: true,
            ..Default::default()
        });

        assert!(query.contains("repo:acme/web"), "{query}");
        assert!(query.contains("is:issue"), "{query}");
        assert!(query.contains("is:open"), "{query}");
        assert!(query.contains("assignee:@me"), "{query}");
    }

    #[test]
    fn what_somebody_typed_wins_over_the_chip_beside_it() {
        // GitHub takes the last of a repeated qualifier, so sending both would
        // silently ignore whichever they thought they were setting. Typing is
        // the more deliberate act, so it is the one that stands.
        let query = search_query(&Query {
            repo: Some("acme/web".into()),
            mine: true,
            state: Some(TaskState::Open),
            raw: Some("repo:acme/other assignee:someone is:closed".into()),
            ..Default::default()
        });

        assert!(!query.contains("repo:acme/web"), "{query}");
        assert!(!query.contains("assignee:@me"), "{query}");
        assert!(!query.contains("is:open"), "{query}");
        assert!(query.contains("repo:acme/other"), "{query}");
    }

    #[test]
    fn asking_for_pull_requests_asks_for_pull_requests() {
        let query = search_query(&Query {
            kind: Some(TaskKind::PullRequest),
            ..Default::default()
        });
        assert!(query.contains("is:pr"), "{query}");
        assert!(!query.contains("is:issue"), "{query}");
    }

    #[test]
    fn a_search_result_becomes_a_task() {
        let item: Item = serde_json::from_value(serde_json::json!({
            "number": 5138,
            "title": "Promo codes fail to apply for EU checkout",
            "body": "Steps to reproduce…",
            "html_url": "https://github.com/acme/web/issues/5138",
            "state": "open",
            "updated_at": "2026-08-29T12:00:00Z",
            "assignees": [{ "login": "maya", "avatar_url": "https://…/maya.png" }],
            "labels": [{ "name": "bug", "color": "d73a4a" }],
            "repository_url": "https://api.github.com/repos/acme/web",
        }))
        .unwrap();

        let task: Task = item.into();
        assert_eq!(task.id, "github:acme/web#5138");
        assert_eq!(task.key, "#5138");
        assert_eq!(task.kind, TaskKind::Issue);
        assert_eq!(task.state, TaskState::Open);
        assert_eq!(task.repo.as_deref(), Some("acme/web"));
        assert_eq!(task.assignees[0].login, "maya");
        assert_eq!(task.labels[0].name, "bug");
    }

    #[test]
    fn a_pull_request_is_told_apart_by_the_key_github_puts_on_it() {
        let item: Item = serde_json::from_value(serde_json::json!({
            "number": 12,
            "title": "Bump the runtime",
            "html_url": "https://github.com/acme/web/pull/12",
            "state": "open",
            "updated_at": "2026-08-29T12:00:00Z",
            "pull_request": { "url": "https://api.github.com/repos/acme/web/pulls/12" },
            "repository_url": "https://api.github.com/repos/acme/web",
        }))
        .unwrap();

        assert_eq!(Task::from(item).kind, TaskKind::PullRequest);
    }
}

//! Reading work out of Gitea.
//!
//! Gitea's issue API is GitHub's with one useful difference and one awkward
//! one. The useful one: `/repos/issues/search` takes a `q` *and* structured
//! parameters, and it searches across everything the account can see, so there
//! is no `repo:` qualifier to assemble. The awkward one: it has no equivalent
//! of GitHub's `is:pr` within a search — `type` picks issues or pulls and
//! cannot do both — which is fine, because the kind toggle is exactly that
//! choice.
//!
//! Forgejo answers the same API, so a Forgejo instance reads here too.

use anyhow::{Context, Result};
use serde::Deserialize;

use super::{Label, Page, Person, Query, Source, Task, TaskKind, TaskState, PER_PAGE};
use crate::providers::Connection;

pub struct Gitea<'a> {
    pub conn: &'a Connection,
}

/// Gitea's own header form for a personal access token.
fn authed(request: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    request.header("authorization", format!("token {token}"))
}

impl Source for Gitea<'_> {
    async fn list(&self, token: &str, ask: &Query) -> Result<Page> {
        if ask.kind == Some(TaskKind::Ticket) {
            return Ok(Page {
                tasks: Vec::new(),
                total: None,
                more: false,
                next: None,
            });
        }

        let page = ask.page.max(1);
        let mut params: Vec<(&str, String)> = vec![
            ("limit", PER_PAGE.to_string()),
            ("page", page.to_string()),
            (
                "type",
                match ask.kind {
                    Some(TaskKind::PullRequest) => "pulls".into(),
                    _ => "issues".to_string(),
                },
            ),
            (
                "state",
                match ask.state {
                    Some(TaskState::Closed) => "closed".into(),
                    Some(TaskState::Open) => "open".into(),
                    None => "all".to_string(),
                },
            ),
        ];

        // One repository if one was picked. Gitea's cross-repository search
        // takes a name rather than an owner/name pair, so this is the one place
        // the slug has to be split.
        if let Some(repo) = ask.repo.as_deref() {
            if let Some((owner, name)) = repo.split_once('/') {
                params.push(("owner", owner.to_string()));
                params.push(("q", name.to_string()));
            }
        }

        if ask.mine {
            params.push(("assigned", "true".into()));
        }
        if let Some(raw) = ask.raw.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
            // Gitea takes one free-text term and no qualifiers, so whatever was
            // typed is the term. Anything cleverer here would be a dialect
            // Gitea does not have.
            params.push(("q", raw.to_string()));
        }

        let items: Vec<Item> = authed(
            crate::oauth::client()?.get(format!("{}/repos/issues/search", self.conn.api_base)),
            token,
        )
        .query(&params)
        .send()
        .await
        .with_context(|| format!("asking {} for issues", self.conn.label))?
        .error_for_status()
        .with_context(|| format!("{} refused the issue search", self.conn.label))?
        .json()
        .await
        .with_context(|| format!("reading the issues {} sent", self.conn.label))?;

        let more = items.len() as u32 == PER_PAGE;
        Ok(Page {
            tasks: items
                .into_iter()
                .map(|i| i.into_task(&self.conn.id))
                .collect(),
            // Gitea reports no total on this endpoint, so the heading counts
            // what is on the page — the same arrangement Linear has.
            total: None,
            more,
            next: None,
        })
    }

    async fn one(&self, token: &str, url: &str) -> Result<Task> {
        // Like GitHub, a pull request is an issue at the same number, so one
        // path answers for both and the link may say either.
        let (slug, number) =
            crate::oauth::change_parts_with(self.conn, url, &["issues", "pulls", "pull"])
                .with_context(|| format!("{url} is not an issue"))?;

        let item: Item = authed(
            crate::oauth::client()?.get(format!(
                "{}/repos/{slug}/issues/{number}",
                self.conn.api_base
            )),
            token,
        )
        .send()
        .await
        .with_context(|| format!("asking {} about {slug}#{number}", self.conn.label))?
        .error_for_status()
        .with_context(|| format!("{} would not say what {slug}#{number} is", self.conn.label))?
        .json()
        .await
        .context("reading what it said")?;

        Ok(item.into_task(&self.conn.id))
    }
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
    assignees: Option<Vec<User>>,
    #[serde(default)]
    labels: Option<Vec<Tag>>,
    /// Present only on pull requests, which is how Gitea tells them apart —
    /// the same arrangement as GitHub.
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
    repository: Option<Repository>,
}

#[derive(Deserialize)]
struct Repository {
    full_name: Option<String>,
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

impl Item {
    fn into_task(self, source: &str) -> Task {
        let repo = self.repository.and_then(|r| r.full_name);

        Task {
            id: format!(
                "{source}:{}#{}",
                repo.as_deref().unwrap_or("unknown"),
                self.number
            ),
            source: source.to_string(),
            key: format!("#{}", self.number),
            title: self.title,
            body: self.body,
            url: self.html_url,
            state: match self.state.as_str() {
                "closed" => TaskState::Closed,
                _ => TaskState::Open,
            },
            kind: match self.pull_request.is_some() {
                true => TaskKind::PullRequest,
                false => TaskKind::Issue,
            },
            assignees: self
                .assignees
                .unwrap_or_default()
                .into_iter()
                .map(|u| Person {
                    login: u.login,
                    avatar: u.avatar_url,
                })
                .collect(),
            labels: self
                .labels
                .unwrap_or_default()
                .into_iter()
                .map(|l| Label {
                    name: l.name,
                    // Gitea sends it without the `#`, like GitHub does.
                    colour: l.color.map(|c| c.trim_start_matches('#').to_string()),
                })
                .collect(),
            updated_at: self.updated_at,
            repo,
        }
    }
}

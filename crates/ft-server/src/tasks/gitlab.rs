//! Reading work out of GitLab.
//!
//! **There is no search query language to pass through.** GitHub takes one
//! string — `repo:acme/web is:issue is:open` — and that is what made `raw` a
//! passthrough in the first place. GitLab takes structured parameters and a
//! plain `search` term, so the chips become fields and anything typed that is
//! not a qualifier this understands becomes the search term. The line under the
//! controls still shows what was sent, which is the promise that mattered.
//!
//! **Issues and merge requests are two endpoints**, not one with a flag. On
//! GitHub every pull request is an issue at the same number; on GitLab they are
//! separate things with separate numbering, so the kind toggle picks the path
//! rather than adding a qualifier.

use anyhow::{Context, Result};
use serde::Deserialize;

use super::{Label, Page, Person, Query, Source, Task, TaskKind, TaskState, PER_PAGE};
use crate::providers::Connection;

pub struct GitLab<'a> {
    pub conn: &'a Connection,
}

/// A project path as one path segment. See `oauth::gitlab`.
fn encoded(path: &str) -> String {
    path.replace('/', "%2F")
}

impl Source for GitLab<'_> {
    async fn list(&self, token: &str, ask: &Query) -> Result<Page> {
        let merge_requests = ask.kind == Some(TaskKind::PullRequest);
        let page = ask.page.max(1);

        // A ticket is not a thing GitLab has, so asking for one asks for
        // nothing rather than for everything.
        if ask.kind == Some(TaskKind::Ticket) {
            return Ok(Page {
                tasks: Vec::new(),
                total: None,
                more: false,
                next: None,
            });
        }

        let what = match merge_requests {
            true => "merge_requests",
            false => "issues",
        };

        // One project if one was picked, otherwise everything this account can
        // see. Unlike GitHub there is no way to name twenty projects in one
        // request, so the connected set cannot be the default scope — `scope=all`
        // plus the account's own membership is the nearest honest equivalent.
        let url = match ask.repo.as_deref() {
            Some(repo) => format!("{}/projects/{}/{what}", self.conn.api_base, encoded(repo)),
            None => format!("{}/{what}", self.conn.api_base),
        };

        let mut params: Vec<(&str, String)> = vec![
            ("per_page", PER_PAGE.to_string()),
            ("page", page.to_string()),
            ("order_by", "updated_at".into()),
            ("sort", "desc".into()),
        ];
        // Only meaningful on the instance-wide paths; harmless on a project's.
        if ask.repo.is_none() {
            params.push(("scope", "all".into()));
        }

        let asked = Asked::read(ask.raw.as_deref().unwrap_or(""));

        if let Some(state) = asked.state.or(ask.state.map(|s| match s {
            // GitLab's words, which are not GitHub's. `opened` rather than
            // `open`, and a merge request has `merged` as a state of its own.
            TaskState::Open => "opened".to_string(),
            TaskState::Closed => match merge_requests {
                true => "merged".to_string(),
                false => "closed".to_string(),
            },
        })) {
            params.push(("state", state));
        }

        if let Some(assignee) = asked.assignee {
            params.push(("assignee_username", assignee));
        } else if ask.mine {
            // GitLab has no `@me` for this parameter, but it does take the
            // scope, which means the same thing and needs no extra request to
            // find out who we are.
            params.push(("scope", "assigned_to_me".into()));
        }

        for label in &asked.labels {
            params.push(("labels", label.clone()));
        }
        if let Some(search) = asked.search.filter(|s| !s.is_empty()) {
            params.push(("search", search));
        }

        let response = super::super::oauth::client()?
            .get(&url)
            .bearer_auth(token)
            .query(&params)
            .send()
            .await
            .with_context(|| format!("asking {} for {what}", self.conn.label))?;

        let response = response
            .error_for_status()
            .with_context(|| format!("{} refused the {what} list", self.conn.label))?;

        // GitLab reports the total in a header rather than in the body, and
        // omits it entirely past a threshold on large instances. Read where it
        // is there, and the page count is honest without it.
        let total = response
            .headers()
            .get("x-total")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u32>().ok());

        let items: Vec<Item> = response
            .json()
            .await
            .with_context(|| format!("reading the {what} {} sent", self.conn.label))?;

        let more = items.len() as u32 == PER_PAGE;
        Ok(Page {
            tasks: items
                .into_iter()
                .map(|i| i.into_task(&self.conn.id, merge_requests))
                .collect(),
            total,
            more,
            next: None,
        })
    }

    async fn one(&self, token: &str, url: &str) -> Result<Task> {
        let (project, number, merge_request) = located(self.conn, url)
            .with_context(|| format!("{url} is not an issue or merge request"))?;

        let what = match merge_request {
            true => "merge_requests",
            false => "issues",
        };

        let item: Item = super::super::oauth::client()?
            .get(format!(
                "{}/projects/{}/{what}/{number}",
                self.conn.api_base,
                encoded(&project)
            ))
            .bearer_auth(token)
            .send()
            .await
            .with_context(|| format!("asking {} about {project}#{number}", self.conn.label))?
            .error_for_status()
            .with_context(|| {
                format!(
                    "{} would not say what {project}#{number} is",
                    self.conn.label
                )
            })?
            .json()
            .await
            .context("reading what it said")?;

        Ok(item.into_task(&self.conn.id, merge_request))
    }
}

/// What the query box asked for, in GitLab's terms.
///
/// The qualifiers people already type at GitHub are understood where they mean
/// the same thing, and everything else becomes the search term. The point is
/// that typing `assignee:ana` does what it looks like rather than searching for
/// the literal text.
#[derive(Debug, Default, PartialEq, Eq)]
struct Asked {
    state: Option<String>,
    assignee: Option<String>,
    labels: Vec<String>,
    search: Option<String>,
}

impl Asked {
    fn read(raw: &str) -> Self {
        let mut out = Self::default();
        let mut words: Vec<&str> = Vec::new();

        for word in raw.split_whitespace() {
            match word.split_once(':') {
                Some(("state", v)) => out.state = Some(v.to_string()),
                // GitHub's spelling of the same thing, because it is what
                // somebody who has used the other screen will type.
                Some(("is", "open")) => out.state = Some("opened".into()),
                Some(("is", "closed")) => out.state = Some("closed".into()),
                Some(("is", "merged")) => out.state = Some("merged".into()),
                Some(("assignee", v)) => out.assignee = Some(v.trim_start_matches('@').to_string()),
                Some(("label", v)) => out.labels.push(v.to_string()),
                // GitLab's own name for the same parameter.
                Some(("labels", v)) => out.labels.extend(v.split(',').map(str::to_string)),
                _ => words.push(word),
            }
        }

        out.search = Some(words.join(" ")).filter(|s| !s.is_empty());
        out
    }
}

/// An issue or a merge request, which differ in two field names.
#[derive(Deserialize)]
struct Item {
    iid: u64,
    title: String,
    description: Option<String>,
    web_url: String,
    state: String,
    updated_at: chrono::DateTime<chrono::Utc>,
    #[serde(default)]
    assignees: Vec<User>,
    #[serde(default)]
    labels: Vec<String>,
    /// The project this belongs to, as a number. GitLab's list endpoints give
    /// this and not the path, so the path comes out of the web URL instead —
    /// which is the same place the picker's slug came from.
    #[allow(dead_code)]
    project_id: Option<u64>,
}

#[derive(Deserialize)]
struct User {
    username: String,
    avatar_url: Option<String>,
}

impl Item {
    fn into_task(self, source: &str, merge_request: bool) -> Task {
        // The project path out of the web URL. GitLab's list endpoints report
        // `project_id` and nothing else, and a numeric id in a task key would
        // be a second name for a project that the slug beside it could
        // disagree with.
        let repo = project_of(&self.web_url);

        // **`!` for a merge request, `#` for an issue.** On GitHub a pull
        // request *is* the issue at that number, so one key covers both. On
        // GitLab they are separate things with separate numbering, and issue 1
        // and merge request 1 both existing is the ordinary case — so a key
        // that spelled both `#1` could not tell them apart, and the one stored
        // on a workspace would be ambiguous about what the work was cut from.
        //
        // `!1` is GitLab's own notation, which is also what it renders as a
        // link in a description — so this is the form to read *and* the form to
        // write.
        let sigil = match merge_request {
            true => '!',
            false => '#',
        };

        Task {
            id: format!(
                "{source}:{}{sigil}{}",
                repo.as_deref().unwrap_or("unknown"),
                self.iid
            ),
            source: source.to_string(),
            key: format!("{sigil}{}", self.iid),
            title: self.title,
            body: self.description,
            url: self.web_url,
            state: match self.state.as_str() {
                "opened" | "reopened" | "locked" => TaskState::Open,
                _ => TaskState::Closed,
            },
            kind: match merge_request {
                true => TaskKind::PullRequest,
                false => TaskKind::Issue,
            },
            assignees: self
                .assignees
                .into_iter()
                .map(|u| Person {
                    login: u.username,
                    avatar: u.avatar_url,
                })
                .collect(),
            // GitLab's labels are bare strings on these endpoints — there is a
            // `with_labels_details` parameter that returns colours, and it
            // costs a join per row for a swatch.
            labels: self
                .labels
                .into_iter()
                .map(|name| Label { name, colour: None })
                .collect(),
            updated_at: self.updated_at,
            repo,
        }
    }
}

/// The project path out of a GitLab web URL.
///
/// `https://gitlab.com/platform/infra/deploy/-/issues/7` → `platform/infra/deploy`.
/// Everything up to the `/-/` separator and past the hostname, which is the
/// only place a list response names the project in a form anybody can use.
fn project_of(web_url: &str) -> Option<String> {
    let after_scheme = web_url.split_once("://").map_or(web_url, |(_, r)| r);
    let (_, path) = after_scheme.split_once('/')?;
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    let at = parts
        .iter()
        .position(|p| *p == "-" || *p == "issues" || *p == "merge_requests")?;
    (at >= 2).then(|| parts[..at].join("/"))
}

/// What a GitLab link points at, and which of the two things it is.
fn located(conn: &Connection, url: &str) -> Option<(String, u64, bool)> {
    let merge_request = url.contains("/merge_requests/");
    let markers: &[&str] = match merge_request {
        true => &["merge_requests"],
        false => &["issues"],
    };
    // One parser for both, in `oauth`, because a link is a link and the only
    // difference is the word in the middle of it.
    crate::oauth::change_parts_with(conn, url, markers)
        .ok()
        .map(|(project, number)| (project, number, merge_request))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An issue and a merge request at the same number are different things on
    /// GitLab, and a key that spelled both `#1` was ambiguous about what a
    /// workspace had been cut from.
    #[test]
    fn an_issue_and_a_merge_request_at_one_number_are_told_apart() {
        let item = |iid: u64| -> Item {
            serde_json::from_value(serde_json::json!({
                "iid": iid,
                "title": "x",
                "web_url": "https://gitlab.com/platform/infra/deploy/-/issues/1",
                "state": "opened",
                "updated_at": "2026-08-29T12:00:00Z",
            }))
            .unwrap()
        };

        let issue = item(1).into_task("gl", false);
        let merge = item(1).into_task("gl", true);

        assert_eq!(issue.id, "gl:platform/infra/deploy#1");
        assert_eq!(merge.id, "gl:platform/infra/deploy!1");
        assert_ne!(issue.id, merge.id, "the whole point");

        // And what a person reads is GitLab's own notation, which is also what
        // GitLab renders as a link inside a description.
        assert_eq!(issue.key, "#1");
        assert_eq!(merge.key, "!1");
    }

    #[test]
    fn the_project_comes_out_of_the_web_url() {
        assert_eq!(
            project_of("https://gitlab.com/acme/web/-/issues/7").as_deref(),
            Some("acme/web")
        );
        // Nested groups, which is the case a two-segment assumption breaks.
        assert_eq!(
            project_of("https://gitlab.com/platform/infra/deploy/-/merge_requests/2").as_deref(),
            Some("platform/infra/deploy")
        );
        // An older link with no separator.
        assert_eq!(
            project_of("https://gitlab.com/acme/web/issues/7").as_deref(),
            Some("acme/web")
        );
        assert_eq!(project_of("https://gitlab.com/acme").as_deref(), None);
    }

    /// The qualifiers somebody who has used the GitHub screen will type, read
    /// as the things they mean rather than searched for as text.
    #[test]
    fn the_query_box_is_read_rather_than_passed_through() {
        let asked = Asked::read("is:open assignee:@ana label:bug promo codes");
        assert_eq!(asked.state.as_deref(), Some("opened"));
        assert_eq!(asked.assignee.as_deref(), Some("ana"));
        assert_eq!(asked.labels, vec!["bug"]);
        assert_eq!(asked.search.as_deref(), Some("promo codes"));
    }

    #[test]
    fn gitlabs_own_spellings_work_too() {
        let asked = Asked::read("state:merged labels:bug,ux");
        assert_eq!(asked.state.as_deref(), Some("merged"));
        assert_eq!(asked.labels, vec!["bug", "ux"]);
        assert_eq!(asked.search, None);
    }

    #[test]
    fn a_plain_search_stays_a_plain_search() {
        let asked = Asked::read("checkout flow");
        assert_eq!(
            asked,
            Asked {
                state: None,
                assignee: None,
                labels: Vec::new(),
                search: Some("checkout flow".into()),
            }
        );
    }
}

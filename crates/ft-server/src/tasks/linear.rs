//! Linear, read over its GraphQL API.
//!
//! Two things differ from a git host and everything else follows from them.
//!
//! Paging is by cursor, not by number, and a connection carries no total — so
//! [`Page::total`] is `None` here and [`Page::next`] carries the cursor the
//! next request resumes from.
//!
//! Filtering is a structure rather than a search string. The chips build one
//! directly; what somebody typed in the box is read for the qualifiers below
//! and whatever is left over becomes a text match. As with GitHub, a typed
//! qualifier beats the chip beside it — typing is the more deliberate act.

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::{Label, Page, Person, Query, Source, SourceId, Task, TaskKind, TaskState};
use crate::trackers::Tracker;

/// The states Linear calls a state, grouped the two ways a person asks.
const LIVE: [&str; 4] = ["triage", "backlog", "unstarted", "started"];
const DONE: [&str; 2] = ["completed", "canceled"];

/// Every field a row renders, and nothing deeper.
///
/// Nesting multiplies against the page size in Linear's complexity budget, so
/// the one nested connection here is bounded.
const FIELDS: &str = r#"
    identifier
    title
    description
    url
    updatedAt
    state { name type }
    assignee { displayName avatarUrl }
    labels(first: 10) { nodes { name color } }
"#;

pub struct Linear<'a> {
    pub tracker: &'a Tracker,
}

impl Source for Linear<'_> {
    fn id(&self) -> SourceId {
        "linear"
    }

    async fn list(&self, key: &str, ask: &Query) -> Result<Page> {
        // Linear has no pull requests. Asking for them asks for nothing rather
        // than for everything.
        if ask.kind == Some(TaskKind::PullRequest) {
            return Ok(Page {
                tasks: Vec::new(),
                total: None,
                more: false,
                next: None,
            });
        }

        let query = format!(
            r#"query Tasks($first: Int!, $after: String, $filter: IssueFilter) {{
                issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {{
                    pageInfo {{ hasNextPage endCursor }}
                    nodes {{ {FIELDS} }}
                }}
            }}"#
        );

        let found: Listed = ask_linear(
            self.tracker,
            key,
            &query,
            json!({
                "first": super::PER_PAGE,
                "after": ask.cursor,
                "filter": filter_for(ask),
            }),
        )
        .await?;

        let more = found.issues.page_info.has_next_page;
        Ok(Page {
            tasks: found.issues.nodes.into_iter().map(Into::into).collect(),
            total: None,
            more,
            next: more.then_some(found.issues.page_info.end_cursor).flatten(),
        })
    }

    async fn one(&self, key: &str, url: &str) -> Result<Task> {
        let identifier =
            identifier_of(url).with_context(|| format!("{url} is not a Linear issue"))?;
        let (team, number) = split_identifier(&identifier)
            .with_context(|| format!("{identifier} is not a Linear issue identifier"))?;

        // By team and number rather than by `issue(id:)`, which wants the
        // internal uuid. The identifier is what the link carries and what a
        // person reads.
        let query = format!(
            r#"query Task($team: String!, $number: Float!) {{
                issues(first: 1, filter: {{
                    team: {{ key: {{ eq: $team }} }},
                    number: {{ eq: $number }}
                }}) {{
                    nodes {{ {FIELDS} }}
                }}
            }}"#
        );

        let found: Listed = ask_linear(
            self.tracker,
            key,
            &query,
            json!({ "team": team, "number": number }),
        )
        .await?;

        found
            .issues
            .nodes
            .into_iter()
            .next()
            .map(Into::into)
            .with_context(|| format!("Linear has no {identifier}"))
    }
}

/// Who the key belongs to. Used to refuse one that does not work at the moment
/// it is offered, rather than storing it and failing on the next screen.
pub async fn viewer(tracker: &Tracker, key: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Me {
        viewer: Named,
    }
    #[derive(Deserialize)]
    struct Named {
        name: String,
    }

    let me: Me = ask_linear(
        tracker,
        key,
        "query Viewer { viewer { id name } }",
        json!({}),
    )
    .await?;
    Ok(me.viewer.name)
}

/// A team the key can see. What the scope picker offers.
#[derive(Debug, Clone, Deserialize)]
pub struct Team {
    pub key: String,
    pub name: String,
}

pub async fn teams(tracker: &Tracker, key: &str) -> Result<Vec<Team>> {
    #[derive(Deserialize)]
    struct Found {
        teams: Nodes<Team>,
    }

    let found: Found = ask_linear(
        tracker,
        key,
        "query Teams { teams(first: 100) { nodes { key name } } }",
        json!({}),
    )
    .await?;

    let mut teams = found.teams.nodes;
    teams.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(teams)
}

/// One request, and the GraphQL error handling every caller would repeat.
///
/// GraphQL answers `200 OK` with an `errors` array, so a failed query looks
/// like a successful request until you read the body.
async fn ask_linear<T: serde::de::DeserializeOwned>(
    tracker: &Tracker,
    key: &str,
    query: &str,
    variables: Value,
) -> Result<T> {
    #[derive(Deserialize)]
    struct Answer<T> {
        data: Option<T>,
        #[serde(default)]
        errors: Vec<Complaint>,
    }

    #[derive(Deserialize)]
    struct Complaint {
        message: String,
    }

    let response = crate::oauth::client()?
        .post(tracker.api_base)
        // A personal key goes in bare. `Bearer` is for an OAuth token, and
        // Linear rejects the one wearing the other's prefix.
        .header("authorization", key)
        .header("content-type", "application/json")
        .json(&json!({ "query": query, "variables": variables }))
        .send()
        .await
        .context("asking Linear")?;

    if let Some(left) = response
        .headers()
        .get("x-ratelimit-requests-remaining")
        .and_then(|v| v.to_str().ok())
    {
        tracing::debug!("linear requests left this hour: {left}");
    }

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        bail!("Linear refused the key. It may have been revoked.");
    }

    let answer: Answer<T> = response
        .error_for_status()
        .context("Linear refused the request")?
        .json()
        .await
        .context("reading what Linear sent")?;

    if let Some(data) = answer.data {
        return Ok(data);
    }

    bail!(
        "{}",
        answer
            .errors
            .into_iter()
            .map(|e| e.message)
            .collect::<Vec<_>>()
            .join("; ")
    )
}

/// `https://linear.app/acme/issue/ENG-123/promo-codes` → `ENG-123`.
///
/// Forgiving about the tail for the same reason the GitHub parser is: a link
/// out of the address bar carries a slug, and often a comment anchor.
pub fn identifier_of(url: &str) -> Option<String> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let path = rest.split(['?', '#']).next()?;
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();

    let at = parts.iter().position(|p| *p == "issue")?;
    let identifier = parts.get(at + 1)?;
    split_identifier(identifier).map(|_| identifier.to_uppercase())
}

/// `ENG-123` → `("ENG", 123)`.
pub fn split_identifier(identifier: &str) -> Option<(String, u64)> {
    let (team, number) = identifier.rsplit_once('-')?;
    if team.is_empty() || !team.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some((team.to_uppercase(), number.parse().ok()?))
}

/// What somebody typed in the box, read for the qualifiers Linear has.
#[derive(Debug, Default, PartialEq, Eq)]
struct Typed {
    team: Option<String>,
    state: Option<String>,
    assignee: Option<String>,
    project: Option<String>,
    priority: Option<String>,
    labels: Vec<String>,
    /// Everything that was not a qualifier, joined back up.
    text: Option<String>,
}

impl Typed {
    fn read(raw: &str) -> Self {
        let mut out = Typed::default();
        let mut loose: Vec<&str> = Vec::new();

        for word in raw.split_whitespace() {
            let Some((name, value)) = word.split_once(':') else {
                loose.push(word);
                continue;
            };
            let value = value.trim_matches('"');
            if value.is_empty() {
                loose.push(word);
                continue;
            }
            match name.to_ascii_lowercase().as_str() {
                "team" => out.team = Some(value.to_uppercase()),
                "state" | "status" => out.state = Some(value.to_string()),
                "assignee" => out.assignee = Some(value.to_string()),
                "project" => out.project = Some(value.to_string()),
                "priority" => out.priority = Some(value.to_string()),
                "label" => out.labels.push(value.to_string()),
                _ => loose.push(word),
            }
        }

        out.text = (!loose.is_empty()).then(|| loose.join(" "));
        out
    }
}

/// The chips and the box, as one `IssueFilter`.
fn filter_for(ask: &Query) -> Value {
    let typed = Typed::read(ask.raw.as_deref().unwrap_or("").trim());
    let mut filter = Map::new();

    if let Some(team) = typed.team.clone().or_else(|| ask.team.clone()) {
        filter.insert("team".into(), json!({ "key": { "eq": team } }));
    }

    match typed.state.as_deref() {
        Some(named) => filter.insert("state".into(), state_named(named)),
        None => match ask.state {
            Some(TaskState::Open) => {
                filter.insert("state".into(), json!({ "type": { "in": LIVE } }))
            }
            Some(TaskState::Closed) => {
                filter.insert("state".into(), json!({ "type": { "in": DONE } }))
            }
            None => None,
        },
    };

    match typed.assignee.as_deref() {
        Some("me") | Some("@me") => {
            filter.insert("assignee".into(), json!({ "isMe": { "eq": true } }));
        }
        Some(who) => {
            filter.insert(
                "assignee".into(),
                json!({ "or": [
                    { "email": { "eqIgnoreCase": who } },
                    { "displayName": { "eqIgnoreCase": who } },
                ]}),
            );
        }
        None if ask.mine => {
            filter.insert("assignee".into(), json!({ "isMe": { "eq": true } }));
        }
        None => {}
    }

    if let Some(project) = &typed.project {
        filter.insert(
            "project".into(),
            json!({ "name": { "containsIgnoreCase": project } }),
        );
    }

    if let Some(priority) = typed
        .priority
        .as_deref()
        .and_then(|p| p.parse::<f64>().ok())
    {
        filter.insert("priority".into(), json!({ "eq": priority }));
    }

    // One `some` clause can only name one label, so several become several
    // clauses that all have to hold.
    if !typed.labels.is_empty() {
        let each: Vec<Value> = typed
            .labels
            .iter()
            .map(|name| json!({ "labels": { "some": { "name": { "eqIgnoreCase": name } } } }))
            .collect();
        filter.insert("and".into(), Value::Array(each));
    }

    if let Some(text) = &typed.text {
        filter.insert(
            "or".into(),
            json!([
                { "title": { "containsIgnoreCase": text } },
                { "description": { "containsIgnoreCase": text } },
            ]),
        );
    }

    Value::Object(filter)
}

/// `state:started`, `state:open`, or the name of a column on a board.
fn state_named(named: &str) -> Value {
    let lower = named.to_ascii_lowercase();
    match lower.as_str() {
        "open" => json!({ "type": { "in": LIVE } }),
        "closed" | "done" => json!({ "type": { "in": DONE } }),
        _ if LIVE.contains(&lower.as_str()) || DONE.contains(&lower.as_str()) => {
            json!({ "type": { "eq": lower } })
        }
        _ => json!({ "name": { "eqIgnoreCase": named } }),
    }
}

#[derive(Deserialize)]
struct Listed {
    issues: Connection,
}

#[derive(Deserialize)]
struct Connection {
    #[serde(default)]
    nodes: Vec<Issue>,
    #[serde(default, rename = "pageInfo")]
    page_info: PageInfo,
}

#[derive(Deserialize)]
struct Nodes<T> {
    #[serde(default = "Vec::new")]
    nodes: Vec<T>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    #[serde(default)]
    has_next_page: bool,
    #[serde(default)]
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Issue {
    identifier: String,
    title: String,
    description: Option<String>,
    url: String,
    updated_at: chrono::DateTime<chrono::Utc>,
    state: Option<State>,
    assignee: Option<Member>,
    labels: Option<Nodes<Tag>>,
}

#[derive(Deserialize)]
struct State {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Member {
    display_name: String,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct Tag {
    name: String,
    color: Option<String>,
}

impl From<Issue> for Task {
    fn from(issue: Issue) -> Self {
        let open = issue
            .state
            .as_ref()
            .map(|s| !DONE.contains(&s.kind.as_str()))
            .unwrap_or(true);

        Task {
            id: format!("linear:{}", issue.identifier),
            source: "linear".into(),
            key: issue.identifier,
            title: issue.title,
            body: issue.description,
            url: issue.url,
            state: if open {
                TaskState::Open
            } else {
                TaskState::Closed
            },
            kind: TaskKind::Ticket,
            assignees: issue
                .assignee
                .into_iter()
                .map(|who| Person {
                    login: who.display_name,
                    avatar: who.avatar_url,
                })
                .collect(),
            labels: issue
                .labels
                .map(|l| l.nodes)
                .unwrap_or_default()
                .into_iter()
                .map(|tag| Label {
                    name: tag.name,
                    // Linear writes `#5e6ad2`; a colour here is six hex digits
                    // and the screen puts the hash back on.
                    colour: tag
                        .color
                        .map(|c| c.trim_start_matches('#').to_string())
                        .filter(|c| !c.is_empty()),
                })
                .collect(),
            updated_at: issue.updated_at,
            // Linear does not know where the work happens, so the workspace
            // form asks.
            repo: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_issue_link_gives_up_its_identifier() {
        assert_eq!(
            identifier_of("https://linear.app/acme/issue/ENG-123/promo-codes-fail").as_deref(),
            Some("ENG-123")
        );
        // From the address bar, after clicking a comment.
        assert_eq!(
            identifier_of("https://linear.app/acme/issue/ENG-123#comment-9").as_deref(),
            Some("ENG-123")
        );
        assert_eq!(
            identifier_of("linear.app/acme/issue/eng-123/x").as_deref(),
            Some("ENG-123")
        );
    }

    #[test]
    fn something_that_is_not_a_linear_issue_is_not_one() {
        assert!(identifier_of("https://linear.app/acme/team/ENG/all").is_none());
        assert!(identifier_of("https://github.com/acme/web/issues/32").is_none());
        assert!(identifier_of("https://linear.app/acme/issue/notanid/x").is_none());
        assert!(identifier_of("").is_none());
    }

    #[test]
    fn an_identifier_splits_into_a_team_and_a_number() {
        assert_eq!(split_identifier("ENG-123"), Some(("ENG".to_string(), 123)));
        // Teams get named with digits in them.
        assert_eq!(split_identifier("A1-7"), Some(("A1".to_string(), 7)));
        assert_eq!(split_identifier("ENG"), None);
        assert_eq!(split_identifier("-1"), None);
        assert_eq!(split_identifier("ENG-x"), None);
    }

    #[test]
    fn the_chips_become_a_filter() {
        let filter = filter_for(&Query {
            team: Some("ENG".into()),
            state: Some(TaskState::Open),
            mine: true,
            ..Default::default()
        });

        assert_eq!(filter["team"]["key"]["eq"], "ENG");
        assert_eq!(filter["assignee"]["isMe"]["eq"], true);
        assert_eq!(filter["state"]["type"]["in"], json!(LIVE));
    }

    #[test]
    fn closed_asks_for_the_two_states_that_mean_finished() {
        let filter = filter_for(&Query {
            state: Some(TaskState::Closed),
            ..Default::default()
        });
        assert_eq!(filter["state"]["type"]["in"], json!(DONE));
    }

    #[test]
    fn what_somebody_typed_wins_over_the_chip_beside_it() {
        // Same rule as GitHub: two sources for one qualifier means one of them
        // is silently ignored, and typing is the more deliberate act.
        let filter = filter_for(&Query {
            team: Some("ENG".into()),
            mine: true,
            state: Some(TaskState::Open),
            raw: Some("team:DES assignee:maya state:completed".into()),
            ..Default::default()
        });

        assert_eq!(filter["team"]["key"]["eq"], "DES");
        assert_eq!(filter["state"]["type"]["eq"], "completed");
        assert!(filter["assignee"].get("isMe").is_none());
        assert_eq!(filter["assignee"]["or"][0]["email"]["eqIgnoreCase"], "maya");
    }

    #[test]
    fn anything_that_is_not_a_qualifier_is_searched_for() {
        let filter = filter_for(&Query {
            raw: Some("promo codes".into()),
            ..Default::default()
        });

        assert_eq!(
            filter["or"][0]["title"]["containsIgnoreCase"],
            "promo codes"
        );
        assert_eq!(
            filter["or"][1]["description"]["containsIgnoreCase"],
            "promo codes"
        );
    }

    #[test]
    fn several_labels_all_have_to_hold() {
        // One `some` clause names one label, so asking for two is two clauses.
        let filter = filter_for(&Query {
            raw: Some("label:bug label:checkout".into()),
            ..Default::default()
        });

        let each = filter["and"].as_array().unwrap();
        assert_eq!(each.len(), 2);
        assert_eq!(each[0]["labels"]["some"]["name"]["eqIgnoreCase"], "bug");
        assert_eq!(
            each[1]["labels"]["some"]["name"]["eqIgnoreCase"],
            "checkout"
        );
    }

    #[test]
    fn a_state_nobody_recognises_is_read_as_the_name_of_a_column() {
        let filter = filter_for(&Query {
            raw: Some("state:\"In Review\"".into()),
            ..Default::default()
        });
        // Quotes with a space still split, so only the first word survives —
        // what matters is that it is read as a name rather than a type.
        assert!(filter["state"].get("name").is_some(), "{filter}");
    }

    #[test]
    fn nothing_asked_for_is_an_empty_filter_rather_than_a_wrong_one() {
        assert_eq!(filter_for(&Query::default()), json!({}));
    }

    #[test]
    fn an_issue_becomes_a_task() {
        let issue: Issue = serde_json::from_value(json!({
            "identifier": "ENG-123",
            "title": "Promo codes fail to apply for EU checkout",
            "description": "Steps to reproduce…",
            "url": "https://linear.app/acme/issue/ENG-123/promo-codes",
            "updatedAt": "2026-08-29T12:00:00Z",
            "state": { "name": "In Progress", "type": "started" },
            "assignee": { "displayName": "maya", "avatarUrl": "https://…/maya.png" },
            "labels": { "nodes": [{ "name": "bug", "color": "#d73a4a" }] },
        }))
        .unwrap();

        let task: Task = issue.into();
        assert_eq!(task.id, "linear:ENG-123");
        assert_eq!(task.key, "ENG-123");
        assert_eq!(task.kind, TaskKind::Ticket);
        assert_eq!(task.state, TaskState::Open);
        assert_eq!(task.assignees[0].login, "maya");
        // The screen puts the hash back on, so keeping Linear's would render
        // `##d73a4a` and no colour at all.
        assert_eq!(task.labels[0].colour.as_deref(), Some("d73a4a"));
        // Nowhere to work — the workspace form asks.
        assert_eq!(task.repo, None);
    }

    #[test]
    fn a_finished_issue_reads_as_closed() {
        for kind in DONE {
            let issue: Issue = serde_json::from_value(json!({
                "identifier": "ENG-1",
                "title": "x",
                "url": "https://linear.app/acme/issue/ENG-1/x",
                "updatedAt": "2026-08-29T12:00:00Z",
                "state": { "name": "Done", "type": kind },
            }))
            .unwrap();
            assert_eq!(Task::from(issue).state, TaskState::Closed, "{kind}");
        }
    }

    #[test]
    fn an_issue_with_nobody_on_it_and_no_labels_still_reads() {
        let issue: Issue = serde_json::from_value(json!({
            "identifier": "ENG-2",
            "title": "x",
            "url": "https://linear.app/acme/issue/ENG-2/x",
            "updatedAt": "2026-08-29T12:00:00Z",
            "state": null,
            "assignee": null,
            "labels": { "nodes": [] },
        }))
        .unwrap();

        let task: Task = issue.into();
        assert!(task.assignees.is_empty());
        assert!(task.labels.is_empty());
        assert_eq!(task.state, TaskState::Open);
    }

    #[test]
    fn the_cursor_only_comes_back_when_there_is_another_page() {
        let end: Connection = serde_json::from_value(json!({
            "nodes": [],
            "pageInfo": { "hasNextPage": false, "endCursor": "abc" },
        }))
        .unwrap();
        // A cursor on the last page would put a Next button under a list that
        // has nothing after it.
        assert!(!end.page_info.has_next_page);
    }
}

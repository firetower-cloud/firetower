//! GitLab's dialect.
//!
//! Three things are different from GitHub in ways that reach the whole way up:
//!
//! * **A project is addressed by its full path, URL-encoded.** `platform/infra`
//!   is `platform%2Finfra` in every path below. GitLab also accepts a numeric
//!   id, and it would be shorter — but then a repository's row would have to
//!   carry an opaque number alongside the slug, and the two could disagree the
//!   moment somebody moved a project between groups. The path is what the slug
//!   already is.
//! * **Groups nest.** `platform/infra/deploy` is one project three levels down,
//!   not a project called `infra/deploy`. Any code that assumes two segments is
//!   wrong here.
//! * **It is called a merge request**, and its state is a word rather than a
//!   word plus a timestamp: `opened`, `closed`, `merged`, `locked`.

use super::{
    client, read_state, Account, Opening, PullState, Reached, RemoteRepo, PAGES, PER_PAGE,
};
use crate::providers::Connection;
use anyhow::{bail, Context, Result};
use serde::Deserialize;

/// A project path as a single path segment.
///
/// Every project-scoped call needs this, and forgetting it is a 404 that reads
/// as "no such project" rather than as a mistake in the request.
fn encoded(path: &str) -> String {
    // Only `/` has to go. Reimplemented rather than pulled in as a dependency
    // because a project path is `[a-z0-9_.-]` and slashes by construction —
    // GitLab will not accept anything else in one — so there is nothing else
    // here to escape.
    path.replace('/', "%2F")
}

pub(super) async fn list_repos(conn: &Connection, token: &str) -> Result<Vec<RemoteRepo>> {
    #[derive(Deserialize)]
    struct Project {
        path_with_namespace: String,
        http_url_to_repo: String,
        default_branch: Option<String>,
        visibility: Option<String>,
        last_activity_at: Option<String>,
        #[serde(default)]
        archived: bool,
    }

    let client = client()?;
    let mut out = Vec::new();

    for page in 1..=PAGES {
        let projects: Vec<Project> = client
            .get(format!("{}/projects", conn.api_base))
            .bearer_auth(token)
            .query(&[
                ("membership", "true"),
                // A project somebody can see but not push to is not one they
                // can start work in, and the picker is a list of places to
                // start work. `developer` is the lowest role that can push a
                // branch and open a merge request.
                ("min_access_level", "30"),
                ("order_by", "last_activity_at"),
                ("sort", "desc"),
                ("per_page", &PER_PAGE.to_string()),
                ("page", &page.to_string()),
                // Without this GitLab returns the whole statistics and
                // permissions tree per project, which on a big instance is
                // megabytes for a list of names.
                ("simple", "false"),
            ])
            .send()
            .await
            .with_context(|| format!("listing projects from {}", conn.label))?
            .error_for_status()
            .with_context(|| format!("{} refused the project list", conn.label))?
            .json()
            .await
            .context("reading the project list")?;

        let count = projects.len();
        out.extend(
            projects
                .into_iter()
                .filter(|p| !p.archived)
                .map(|p| RemoteRepo {
                    slug: p.path_with_namespace,
                    remote: p.http_url_to_repo,
                    default_branch: p.default_branch.unwrap_or_else(|| "main".into()),
                    private: p.visibility.as_deref() != Some("public"),
                    pushed_at: p.last_activity_at,
                }),
        );

        if count < PER_PAGE {
            break;
        }
    }

    Ok(out)
}

/// Who the token belongs to.
///
/// GitLab hands back a public email that is frequently blank, and unlike GitHub
/// it mints no no-reply address to fall back on. So one is built the way
/// GitLab's own commits do it — `<id>-<username>@users.noreply.<host>` is what
/// GitLab.com uses — and on a self-hosted instance the host is the instance's
/// own, which is the only address that could be right there.
pub(super) async fn whoami(conn: &Connection, token: &str) -> Result<Account> {
    #[derive(Deserialize)]
    struct Me {
        id: u64,
        username: String,
        name: Option<String>,
        /// Only present when the account has chosen to make one public.
        email: Option<String>,
        commit_email: Option<String>,
    }

    let me: Me = client()?
        .get(format!("{}/user", conn.api_base))
        .bearer_auth(token)
        .send()
        .await
        .with_context(|| format!("asking {} who the token belongs to", conn.label))?
        .error_for_status()
        .with_context(|| format!("{} would not say who the token belongs to", conn.label))?
        .json()
        .await
        .with_context(|| format!("reading {}'s answer about the token", conn.label))?;

    // What the account itself says it commits as, first — GitLab has a field
    // for exactly this question and it is more likely to be what a reviewer
    // expects than anything we could derive.
    let email = me
        .commit_email
        .filter(|e| !e.trim().is_empty())
        .or_else(|| me.email.filter(|e| !e.trim().is_empty()))
        .unwrap_or_else(|| {
            let host = conn.git_host.strip_prefix("www.").unwrap_or(&conn.git_host);
            format!("{}-{}@users.noreply.{host}", me.id, me.username)
        });

    Ok(Account {
        author: ft_proto::Author {
            name: me
                .name
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| me.username.clone()),
            email,
        },
        login: me.username,
    })
}

pub(super) async fn open_change(
    conn: &Connection,
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
        web_url: Option<String>,
        /// GitLab's refusals are either a string or an object of field → list
        /// of reasons, and which one depends on the endpoint.
        message: Option<serde_json::Value>,
        error: Option<String>,
    }

    // A draft is a title prefix on GitLab rather than a flag, and it is the
    // prefix that makes the pipeline treat it as one — there is no field to
    // set. `Draft:` is the current spelling; `WIP:` is the old one and GitLab
    // still honours it, but writing the current one is what its own interface
    // does.
    let title = match draft && !title.to_ascii_lowercase().starts_with("draft:") {
        true => format!("Draft: {title}"),
        false => title.to_string(),
    };

    let response = client()?
        .post(format!(
            "{}/projects/{}/merge_requests",
            conn.api_base,
            encoded(slug)
        ))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "source_branch": head,
            "target_branch": base,
            "title": title,
            "description": body,
            // The branch is the session's and nothing else will ever use it, so
            // letting GitLab tidy it up on merge is what somebody would do by
            // hand afterwards.
            "remove_source_branch": true,
        }))
        .send()
        .await
        .with_context(|| format!("asking {} to open a merge request", conn.label))?;

    let status = response.status();
    let created: Created = response
        .json()
        .await
        .context("reading the merge request response")?;

    if let Some(url) = created.web_url {
        return Ok(url);
    }

    let said = said(&created.message, &created.error);

    // GitLab's words for "there is already one of these" name the branch rather
    // than the request, and the useful answer is the request itself.
    if said.to_ascii_lowercase().contains("already exists") {
        if let Some(url) = existing(conn, token, slug, head).await? {
            return Ok(url);
        }
    }

    bail!("{status}: {said}")
}

/// What GitLab objected to, out of either shape it says it in.
///
/// `{"message": {"source_branch": ["can't be blank"]}}` and
/// `{"message": "403 Forbidden"}` are both ordinary answers, and reading only
/// one of them reports the other as nothing at all.
fn said(message: &Option<serde_json::Value>, error: &Option<String>) -> String {
    if let Some(error) = error.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        return error.to_string();
    }

    match message {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|i| i.as_str())
            .collect::<Vec<_>>()
            .join("; "),
        Some(serde_json::Value::Object(fields)) => {
            let mut out: Vec<String> = Vec::new();
            for (field, reasons) in fields {
                match reasons {
                    serde_json::Value::Array(list) => {
                        for reason in list.iter().filter_map(|r| r.as_str()) {
                            out.push(format!("{field} {reason}"));
                        }
                    }
                    serde_json::Value::String(reason) => out.push(format!("{field} {reason}")),
                    _ => {}
                }
            }
            match out.is_empty() {
                true => "the host refused without saying why".to_string(),
                false => out.join("; "),
            }
        }
        _ => "the host refused without saying why".to_string(),
    }
}

async fn existing(
    conn: &Connection,
    token: &str,
    slug: &str,
    head: &str,
) -> Result<Option<String>> {
    #[derive(Deserialize)]
    struct Open {
        web_url: String,
    }

    let found: Vec<Open> = client()?
        .get(format!(
            "{}/projects/{}/merge_requests",
            conn.api_base,
            encoded(slug)
        ))
        .bearer_auth(token)
        .query(&[("source_branch", head), ("state", "opened")])
        .send()
        .await
        .with_context(|| format!("asking {} which request is already open", conn.label))?
        .json()
        .await
        .unwrap_or_default();

    Ok(found.into_iter().next().map(|m| m.web_url))
}

pub(super) async fn change_state(conn: &Connection, token: &str, url: &str) -> Result<PullState> {
    #[derive(Deserialize)]
    struct Went {
        state: String,
    }

    let (slug, number) = super::change_parts(conn, url)?;

    let went: Went = client()?
        .get(format!(
            "{}/projects/{}/merge_requests/{number}",
            conn.api_base,
            encoded(&slug)
        ))
        .bearer_auth(token)
        .send()
        .await
        .with_context(|| format!("asking {} about a merge request", conn.label))?
        .error_for_status()
        .with_context(|| format!("asking {} about a merge request", conn.label))?
        .json()
        .await
        .context("reading what it said about the merge request")?;

    // No timestamp needed: GitLab has a state for merged, where GitHub has
    // `closed` plus the moment it happened.
    Ok(read_state(&went.state, None))
}

pub(super) async fn amend_change(
    conn: &Connection,
    token: &str,
    url: &str,
    body: &str,
) -> Result<()> {
    let (slug, number) = super::change_parts(conn, url)?;

    let response = client()?
        .put(format!(
            "{}/projects/{}/merge_requests/{number}",
            conn.api_base,
            encoded(&slug)
        ))
        .bearer_auth(token)
        .json(&serde_json::json!({ "description": body }))
        .send()
        .await
        .with_context(|| format!("asking {} to amend a merge request", conn.label))?;

    if !response.status().is_success() {
        bail!(
            "{}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        );
    }
    Ok(())
}

/// `/version`, which wants a token on most instances.
///
/// A 401 is therefore a *success* here: something answered, and the thing that
/// answers that path with a 401 is a GitLab. The version is the prize when it
/// comes — it is what tells somebody their instance is too old for the browser
/// flow — but reachability is the answer the screen cannot do without.
pub(super) async fn probe(api_base: &str) -> Result<Reached> {
    #[derive(Deserialize)]
    struct Version {
        version: Option<String>,
    }

    let response = client()?
        .get(format!("{api_base}/version"))
        .send()
        .await
        .context("reaching it")?;

    let status = response.status();
    if !status.is_success() && !super::unauthorized(status) {
        bail!("it answered {status}, which is not what a GitLab API does");
    }

    Ok(Reached {
        version: response
            .json::<Version>()
            .await
            .ok()
            .and_then(|v| v.version),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every project-scoped path is built from this, and a slash left in it is
    /// a 404 that reads as "no such project".
    #[test]
    fn a_nested_project_path_becomes_one_segment() {
        assert_eq!(encoded("acme/web"), "acme%2Fweb");
        assert_eq!(
            encoded("platform/infra/deploy"),
            "platform%2Finfra%2Fdeploy"
        );
    }

    /// GitLab says what was wrong in two different shapes depending on the
    /// endpoint, and reading only one of them reports the other as silence.
    #[test]
    fn a_refusal_is_read_in_either_shape_gitlab_sends_it() {
        assert_eq!(
            said(&Some(serde_json::json!("403 Forbidden")), &None),
            "403 Forbidden"
        );
        assert_eq!(
            said(
                &Some(serde_json::json!({ "source_branch": ["can't be blank"] })),
                &None
            ),
            "source_branch can't be blank"
        );
        assert_eq!(
            said(&Some(serde_json::json!(["branch missing"])), &None),
            "branch missing"
        );
        // `error` is what the OAuth-shaped endpoints use, and it wins because
        // it is the more specific field when both are somehow present.
        assert_eq!(
            said(
                &Some(serde_json::json!("ignored")),
                &Some("invalid_grant".into())
            ),
            "invalid_grant"
        );
        assert_eq!(said(&None, &None), "the host refused without saying why");
    }

    /// Several reasons at once is the ordinary case for a validation failure,
    /// and collapsing them to the first loses the one somebody needed.
    #[test]
    fn every_reason_gitlab_gives_is_reported() {
        let said = said(
            &Some(serde_json::json!({
                "source_branch": ["can't be blank"],
                "target_branch": ["does not exist"],
            })),
            &None,
        );
        assert!(said.contains("source_branch can't be blank"), "{said}");
        assert!(said.contains("target_branch does not exist"), "{said}");
    }
}

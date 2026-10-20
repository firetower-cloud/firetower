//! GitHub's dialect: `/user/repos`, `/repos/{slug}/pulls`, `/user`.
//!
//! Also GitHub Enterprise Server, which is the same API under a different
//! address — the whole of the difference is in `api_base`, which is why that is
//! stored on the connection rather than derived from the kind.

use super::{
    client, read_state, refusal, Account, Opening, PullState, Reached, Refusal, RemoteRepo, PAGES,
    PER_PAGE,
};
use crate::providers::Connection;
use anyhow::{bail, Context, Result};
use serde::Deserialize;

/// What every request here says it wants back.
const ACCEPT: &str = "application/vnd.github+json";

pub(super) async fn list_repos(conn: &Connection, token: &str) -> Result<Vec<RemoteRepo>> {
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

    for page in 1..=PAGES {
        let items: Vec<Item> = client
            .get(format!("{}/user/repos", conn.api_base))
            .bearer_auth(token)
            .header("accept", ACCEPT)
            .query(&[
                ("per_page", PER_PAGE.to_string().as_str()),
                ("page", &page.to_string()),
                ("sort", "pushed"),
                ("affiliation", "owner,collaborator,organization_member"),
            ])
            .send()
            .await
            .with_context(|| format!("listing repositories from {}", conn.label))?
            .error_for_status()
            .with_context(|| format!("{} refused the repository list", conn.label))?
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

        if count < PER_PAGE {
            break;
        }
    }

    Ok(out)
}

/// Who the token belongs to.
///
/// The address is GitHub's own no-reply form, built from the numeric id and the
/// login. A real address is often absent from the API — most people keep theirs
/// private — while the no-reply one always works, is what GitHub's own web
/// editor uses, and links the commit to the account.
///
/// On an Enterprise install the domain is the same: `users.noreply.github.com`
/// is what GHES generates too.
pub(super) async fn whoami(conn: &Connection, token: &str) -> Result<Account> {
    #[derive(Deserialize)]
    struct Me {
        id: u64,
        login: String,
        name: Option<String>,
    }

    let me: Me = client()?
        .get(format!("{}/user", conn.api_base))
        .bearer_auth(token)
        .header("accept", ACCEPT)
        .send()
        .await
        .with_context(|| format!("asking {} who the token belongs to", conn.label))?
        .error_for_status()
        .with_context(|| format!("{} would not say who the token belongs to", conn.label))?
        .json()
        .await
        .with_context(|| format!("reading {}'s answer about the token", conn.label))?;

    Ok(Account {
        author: ft_proto::Author {
            name: me
                .name
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| me.login.clone()),
            email: format!("{}+{}@users.noreply.github.com", me.id, me.login),
        },
        login: me.login,
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
        .post(format!("{}/repos/{slug}/pulls", conn.api_base))
        .bearer_auth(token)
        .header("accept", ACCEPT)
        .json(&serde_json::json!({
            "title": title,
            "head": head,
            "base": base,
            "body": body,
            "draft": draft,
        }))
        .send()
        .await
        .with_context(|| format!("asking {} to open a pull request", conn.label))?;

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
        if let Some(url) = existing(conn, token, slug, head).await? {
            return Ok(url);
        }
    }

    // The host's own words are more useful than ours: "no commits between",
    // "already exists", and "not found" all need different things from you.
    bail!("{status}: {said}")
}

/// The open request for a branch, when the host says one is already there.
///
/// `head` is qualified with the owner because that is what the API wants, and
/// because a fork's branch of the same name is a different thing.
async fn existing(
    conn: &Connection,
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
        .get(format!("{}/repos/{slug}/pulls", conn.api_base))
        .bearer_auth(token)
        .header("accept", ACCEPT)
        .query(&[
            ("head", format!("{owner}:{head}")),
            ("state", "open".into()),
        ])
        .send()
        .await
        .with_context(|| format!("asking {} which request is already open", conn.label))?
        .json()
        .await
        .unwrap_or_default();

    Ok(found.into_iter().next().map(|p| p.html_url))
}

pub(super) async fn change_state(conn: &Connection, token: &str, url: &str) -> Result<PullState> {
    #[derive(Deserialize)]
    struct Went {
        state: String,
        merged_at: Option<String>,
    }

    let (slug, number) = super::change_parts(conn, url)?;

    let went: Went = client()?
        .get(format!("{}/repos/{slug}/pulls/{number}", conn.api_base))
        .bearer_auth(token)
        .header("accept", ACCEPT)
        .send()
        .await
        .with_context(|| format!("asking {} about a pull request", conn.label))?
        .error_for_status()
        .with_context(|| format!("asking {} about a pull request", conn.label))?
        .json()
        .await
        .context("reading what it said about the pull request")?;

    Ok(read_state(&went.state, went.merged_at.as_deref()))
}

pub(super) async fn amend_change(
    conn: &Connection,
    token: &str,
    url: &str,
    body: &str,
) -> Result<()> {
    let (slug, number) = super::change_parts(conn, url)?;

    let response = client()?
        .patch(format!("{}/repos/{slug}/pulls/{number}", conn.api_base))
        .bearer_auth(token)
        .header("accept", ACCEPT)
        .json(&serde_json::json!({ "body": body }))
        .send()
        .await
        .with_context(|| format!("asking {} to amend a pull request", conn.label))?;

    if !response.status().is_success() {
        bail!(
            "{}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        );
    }
    Ok(())
}

/// `/meta`, which is unauthenticated on both GitHub.com and Enterprise.
///
/// Enterprise reports `installed_version`; GitHub.com has no version to report
/// and says nothing, which is still a successful answer of the right shape.
pub(super) async fn probe(api_base: &str) -> Result<Reached> {
    #[derive(Deserialize)]
    struct Meta {
        installed_version: Option<String>,
    }

    let response = client()?
        .get(format!("{api_base}/meta"))
        .header("accept", ACCEPT)
        .send()
        .await
        .context("reaching it")?;

    let status = response.status();
    if !status.is_success() && !super::unauthorized(status) {
        bail!("it answered {status}, which is not what a GitHub API does");
    }

    Ok(Reached {
        version: response
            .json::<Meta>()
            .await
            .ok()
            .and_then(|m| m.installed_version),
    })
}

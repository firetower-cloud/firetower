//! Gitea's dialect, which is GitHub's with three differences that matter.
//!
//! * **There is no device flow.** Gitea implements the authorization code grant
//!   with PKCE and OpenID Connect, and nothing else. A token each is the only
//!   way in, which is why [`crate::providers::AuthMode`] is a property of a
//!   connection rather than a thing every host is assumed to have.
//! * **It checks the username beside the token.** GitHub throws it away and
//!   GitLab reads past it; Gitea refuses a push where it does not match the
//!   account. So the login is read from `whoami` and kept, and
//!   [`crate::providers::GitUsername::Login`] is what says so.
//! * **Authentication is `token <value>`, not `Bearer <value>`.** Gitea accepts
//!   both for API tokens in current versions, but `token` is what it has always
//!   accepted, and this is a host people run old versions of.
//!
//! Forgejo is Gitea's fork and answers this same API, so a Forgejo instance
//! connects as a Gitea and works.

use super::{
    client, read_state, Account, Opening, PullState, Reached, RemoteRepo, PAGES, PER_PAGE,
};
use crate::providers::Connection;
use anyhow::{bail, Context, Result};
use serde::Deserialize;

/// Gitea's own header form for a personal access token.
fn authed(request: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    request.header("authorization", format!("token {token}"))
}

pub(super) async fn list_repos(conn: &Connection, token: &str) -> Result<Vec<RemoteRepo>> {
    #[derive(Deserialize)]
    struct Repo {
        full_name: String,
        clone_url: String,
        default_branch: Option<String>,
        #[serde(default)]
        private: bool,
        updated_at: Option<String>,
        #[serde(default)]
        archived: bool,
        /// Whether this account can push. Gitea lists what you can see, which
        /// on an open instance is everything.
        permissions: Option<Permissions>,
    }

    #[derive(Deserialize)]
    struct Permissions {
        #[serde(default)]
        push: bool,
    }

    let client = client()?;
    let mut out = Vec::new();

    for page in 1..=PAGES {
        let repos: Vec<Repo> = authed(client.get(format!("{}/user/repos", conn.api_base)), token)
            .query(&[("limit", PER_PAGE.to_string()), ("page", page.to_string())])
            .send()
            .await
            .with_context(|| format!("listing repositories from {}", conn.label))?
            .error_for_status()
            .with_context(|| format!("{} refused the repository list", conn.label))?
            .json()
            .await
            .context("reading the repository list")?;

        let count = repos.len();
        out.extend(
            repos
                .into_iter()
                // A repository nobody can push to is not somewhere to start
                // work. Absent permissions mean an older Gitea that does not
                // report them, and the kind thing there is to show it.
                .filter(|r| !r.archived && r.permissions.as_ref().is_none_or(|p| p.push))
                .map(|r| RemoteRepo {
                    slug: r.full_name,
                    remote: r.clone_url,
                    default_branch: r.default_branch.unwrap_or_else(|| "main".into()),
                    private: r.private,
                    pushed_at: r.updated_at,
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
/// Gitea reports a real email and it is not optional the way GitHub's is, so
/// there is no no-reply form to invent. Where one is somehow absent, the
/// fallback is built on the instance's own hostname, because an address at
/// anybody else's would be worse than wrong.
pub(super) async fn whoami(conn: &Connection, token: &str) -> Result<Account> {
    #[derive(Deserialize)]
    struct Me {
        id: u64,
        login: String,
        full_name: Option<String>,
        email: Option<String>,
    }

    let me: Me = authed(client()?.get(format!("{}/user", conn.api_base)), token)
        .send()
        .await
        .with_context(|| format!("asking {} who the token belongs to", conn.label))?
        .error_for_status()
        .with_context(|| format!("{} would not say who the token belongs to", conn.label))?
        .json()
        .await
        .with_context(|| format!("reading {}'s answer about the token", conn.label))?;

    let email = me
        .email
        .filter(|e| !e.trim().is_empty())
        .unwrap_or_else(|| format!("{}-{}@users.noreply.{}", me.id, me.login, conn.git_host));

    Ok(Account {
        author: ft_proto::Author {
            name: me
                .full_name
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| me.login.clone()),
            email,
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
    }

    // Like GitLab, a draft is a title prefix rather than a field. Gitea reads
    // `WIP:` by default and that prefix is configurable per instance, so this
    // writes the one its own interface offers.
    let title = match draft && !title.to_ascii_uppercase().starts_with("WIP:") {
        true => format!("WIP: {title}"),
        false => title.to_string(),
    };

    let response = authed(
        client()?.post(format!("{}/repos/{slug}/pulls", conn.api_base)),
        token,
    )
    .json(&serde_json::json!({
        "head": head,
        "base": base,
        "title": title,
        "body": body,
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

    let said = created
        .message
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "the host refused without saying why".into());

    if said.to_ascii_lowercase().contains("already exists") {
        if let Some(url) = existing(conn, token, slug, head).await? {
            return Ok(url);
        }
    }

    bail!("{status}: {said}")
}

async fn existing(
    conn: &Connection,
    token: &str,
    slug: &str,
    head: &str,
) -> Result<Option<String>> {
    #[derive(Deserialize)]
    struct Open {
        html_url: String,
        head: Option<Branch>,
    }

    #[derive(Deserialize)]
    struct Branch {
        #[serde(rename = "ref")]
        name: Option<String>,
    }

    // Gitea has no `head` filter on this endpoint, so the branch is matched
    // here rather than asked for.
    let found: Vec<Open> = authed(
        client()?.get(format!("{}/repos/{slug}/pulls", conn.api_base)),
        token,
    )
    .query(&[("state", "open"), ("limit", "50")])
    .send()
    .await
    .with_context(|| format!("asking {} which request is already open", conn.label))?
    .json()
    .await
    .unwrap_or_default();

    Ok(found
        .into_iter()
        .find(|p| {
            p.head
                .as_ref()
                .and_then(|h| h.name.as_deref())
                // Gitea reports it bare on some versions and fully qualified on
                // others.
                .is_some_and(|r| r == head || r == format!("refs/heads/{head}"))
        })
        .map(|p| p.html_url))
}

pub(super) async fn change_state(conn: &Connection, token: &str, url: &str) -> Result<PullState> {
    #[derive(Deserialize)]
    struct Went {
        state: String,
        merged: Option<bool>,
        merged_at: Option<String>,
    }

    let (slug, number) = super::change_parts(conn, url)?;

    let went: Went = authed(
        client()?.get(format!("{}/repos/{slug}/pulls/{number}", conn.api_base)),
        token,
    )
    .send()
    .await
    .with_context(|| format!("asking {} about a pull request", conn.label))?
    .error_for_status()
    .with_context(|| format!("asking {} about a pull request", conn.label))?
    .json()
    .await
    .context("reading what it said about the pull request")?;

    // Gitea reports both a flag and a timestamp; either one proves it merged,
    // and older versions have been known to send only the flag.
    let merged = went
        .merged_at
        .clone()
        .or_else(|| went.merged.unwrap_or(false).then(|| "merged".to_string()));
    Ok(read_state(&went.state, merged.as_deref()))
}

pub(super) async fn amend_change(
    conn: &Connection,
    token: &str,
    url: &str,
    body: &str,
) -> Result<()> {
    let (slug, number) = super::change_parts(conn, url)?;

    let response = authed(
        client()?.patch(format!("{}/repos/{slug}/pulls/{number}", conn.api_base)),
        token,
    )
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

/// `/version`, which is unauthenticated on Gitea and names the version plainly.
///
/// The one host of the three where this probe answers the question it was asked
/// without qualification.
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
        bail!("it answered {status}, which is not what a Gitea API does");
    }

    Ok(Reached {
        version: response
            .json::<Version>()
            .await
            .ok()
            .and_then(|v| v.version),
    })
}

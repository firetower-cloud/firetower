//! The repositories sessions cut worktrees from.
//!
//! Connecting one reaches for it first, on the host that would do the cloning:
//! only that machine knows what it can see, and an answer from anywhere else
//! would be a guess about someone else's network.

use super::{credential_for, ApiError, ApiResult, ErrorCode};
use crate::{providers, AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use ft_core::{Repo, RepoId};
use ft_proto::ProbeFailure;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[utoipa::path(
    get, path = "/api/v1/repos", tag = "repos",
    responses((status = 200, body = Vec<Repo>)),
)]
pub(super) async fn list_repos(State(state): State<AppState>) -> ApiResult<Json<Vec<Repo>>> {
    Ok(Json(state.db.repos().await?))
}

/// Connect a repository. Nothing is cloned until a session needs it.
///
/// No default branch here on purpose. Connecting reaches for the remote anyway,
/// and what it answers with is the truth — a branch named by the caller was
/// accepted and then ignored, which is worse than not asking.
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewRepo {
    /// `acme/backend`
    pub slug: String,
    /// Anything git can clone: a URL, or a path for a local repository.
    pub remote: String,
    /// Runs once per session, before the agent starts.
    #[serde(default)]
    pub setup: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRequest {
    /// A URL or a path on the host that will do the cloning.
    pub remote: String,
}

/// What we learned by actually reaching for the repository.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResponse {
    /// Derived from the remote, and editable before saving.
    pub slug: String,
    /// Read from the remote rather than assumed.
    pub default_branch: String,
}

/// Whether a remote is a directory here rather than something reachable.
pub(super) fn is_local_path(remote: &str) -> bool {
    remote.starts_with('/') || remote.starts_with('.') || remote.starts_with('~')
}

/// `https://host/acme/backend.git` and `git@host:acme/backend.git` both give
/// `acme/backend`; a path gives its last component.
fn slug_from_remote(remote: &str) -> String {
    let trimmed = remote.trim().trim_end_matches('/').trim_end_matches(".git");

    if trimmed.starts_with('/') || trimmed.starts_with('.') || trimmed.starts_with('~') {
        return trimmed.rsplit('/').next().unwrap_or(trimmed).to_string();
    }

    let path = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed)
        .split_once(':')
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);

    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    match parts.as_slice() {
        [.., owner, name] if parts.len() >= 2 && owner.contains('.') && parts.len() == 2 => {
            name.to_string()
        }
        [.., owner, name] => format!("{owner}/{name}"),
        [name] => name.to_string(),
        [] => trimmed.to_string(),
    }
}

/// Turn a refusal into something worth reading.
fn probe_error(remote: &str, failure: ProbeFailure) -> ApiError {
    match failure {
        ProbeFailure::Denied => ApiError::new(
            ErrorCode::RepoAccessDenied,
            match providers::for_remote(remote) {
                Some(p) => format!(
                    "{} refused access. If it's private, authorize {} first.",
                    remote, p.label
                ),
                None => format!(
                    "{remote} refused access. Firetower uses the git credentials \
                     already on the host — if `git ls-remote` works there, it works here."
                ),
            },
        ),
        ProbeFailure::Unreachable => ApiError::new(
            ErrorCode::RepoUnreachable,
            format!("couldn't reach {remote}"),
        ),
        ProbeFailure::NotARepository => ApiError::new(
            ErrorCode::RepoUnusable,
            format!("{remote} isn't a git repository"),
        ),
        ProbeFailure::GitMissing => ApiError::new(
            ErrorCode::RepoUnreachable,
            "git isn't installed on that host".to_string(),
        ),
    }
}

/// Pick the host that would do the cloning.
async fn probing_host(state: &AppState) -> Result<ft_core::HostId, ApiError> {
    let hosts = state.db.hosts().await?;
    let host = hosts
        .iter()
        .find(|h| h.state == ft_core::HostState::Online)
        .ok_or_else(|| {
            ApiError::new(
                ErrorCode::HostUnreachable,
                "no host is available to check the repository",
            )
        })?;
    Ok(host.id.clone())
}

/// Can we reach it, and what is it called?
///
/// Answered by a worker, because the worker is what holds the credentials and
/// what will do the clone. Anything decided here would be a guess about someone
/// else's network.
#[utoipa::path(
    post, path = "/api/v1/repos/probe", tag = "repos",
    request_body = ProbeRequest,
    responses(
        (status = 200, body = ProbeResponse),
        (status = 400, body = ApiError),
        (status = 401, body = ApiError),
    ),
)]
pub(super) async fn probe_repo(
    State(state): State<AppState>,
    Json(req): Json<ProbeRequest>,
) -> ApiResult<Json<ProbeResponse>> {
    let remote = req.remote.trim();
    if remote.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "paste a repository URL or a path",
        ));
    }

    let host = probing_host(&state).await?;
    let info = state
        .fleet
        .probe(
            &host,
            remote,
            credential_for(&state, remote, &format!("checking {remote}")).await,
        )
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
        .map_err(|f| probe_error(remote, f))?;

    if info.empty {
        return Err(ApiError::new(
            ErrorCode::RepoUnusable,
            format!("{remote} has no commits yet, so there's nothing to branch from"),
        ));
    }

    Ok(Json(ProbeResponse {
        slug: slug_from_remote(remote),
        default_branch: info.default_branch,
    }))
}

#[utoipa::path(
    post, path = "/api/v1/repos", tag = "repos",
    request_body = NewRepo,
    responses((status = 201, body = Repo), (status = 400, body = ApiError)),
)]
pub(super) async fn create_repo(
    State(state): State<AppState>,
    Json(req): Json<NewRepo>,
) -> ApiResult<(StatusCode, Json<Repo>)> {
    let remote = req.remote.trim();
    if remote.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a repository needs a remote",
        ));
    }

    // Proving it works before saving it is the whole point. A row written from
    // two unchecked strings turns into a session that dies during clone, long
    // after anyone could connect the failure to what they typed.
    let host = probing_host(&state).await?;
    let info = state
        .fleet
        .probe(
            &host,
            remote,
            credential_for(&state, remote, &format!("connecting {remote}")).await,
        )
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
        .map_err(|f| probe_error(remote, f))?;

    if info.empty {
        return Err(ApiError::new(
            ErrorCode::RepoUnusable,
            format!("{remote} has no commits yet, so there's nothing to branch from"),
        ));
    }

    let slug = match req.slug.trim() {
        "" => slug_from_remote(remote),
        given => given.to_string(),
    };

    let repo = state
        .db
        .ensure_repo(&slug, remote, &info.default_branch, req.setup.as_deref())
        .await?;

    Ok((StatusCode::CREATED, Json(repo)))
}

/// The branches a session can start from.
///
/// Asked of the remote rather than read from a cached list: a branch pushed a
/// minute ago should be offerable, and the probe that answers this is the same
/// one that validated the repository in the first place.
#[utoipa::path(
    get, path = "/api/v1/repos/{id}/branches", tag = "repos",
    params(("id" = String, Path, description = "Repository id")),
    responses((status = 200, body = Branches), (status = 404, body = ApiError)),
)]
pub(super) async fn repo_branches(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Branches>> {
    let repo = state
        .db
        .repo(&RepoId::from_stored(id))
        .await?
        .ok_or_else(|| ApiError::not_found("repository"))?;

    let host = probing_host(&state).await?;
    let info = state
        .fleet
        .probe(
            &host,
            &repo.remote,
            credential_for(
                &state,
                &repo.remote,
                &format!("listing branches of {}", repo.slug),
            )
            .await,
        )
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
        .map_err(|f| probe_error(&repo.remote, f))?;

    Ok(Json(Branches {
        default_branch: info.default_branch,
        branches: info.branches,
    }))
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub default_branch: String,
    pub branches: Vec<String>,
}

/// Disconnect a repository.
///
/// Refuses while sessions are still running on it — silently orphaning live
/// work is worse than making someone finish or stop it first. The on-disk
/// mirror is a cache and stays; it is not this button's business.
#[utoipa::path(
    delete, path = "/api/v1/repos/{id}", tag = "repos",
    params(("id" = String, Path, description = "Repository id")),
    responses((status = 204), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn delete_repo(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let id = RepoId::from_stored(id);
    let repo = state
        .db
        .repo(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("repository"))?;

    let live = state.db.live_sessions_for_repo(&repo.slug).await?;
    if !live.is_empty() {
        return Err(ApiError::new(
            ErrorCode::RepoInUse,
            format!(
                "{} still has {} running: {}",
                repo.slug,
                if live.len() == 1 {
                    "a session".to_string()
                } else {
                    format!("{} sessions", live.len())
                },
                live.join(", ")
            ),
        ));
    }

    state.db.delete_repo(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_here_is_told_apart_from_a_remote() {
        assert!(is_local_path("/Users/kevin/code/backend"));
        assert!(is_local_path("./backend"));
        assert!(!is_local_path("https://github.com/acme/backend.git"));
        assert!(!is_local_path("git@github.com:acme/backend.git"));
    }

    #[test]
    fn a_slug_comes_out_of_whatever_shape_the_remote_is() {
        for (remote, expected) in [
            ("https://github.com/acme/backend.git", "acme/backend"),
            ("https://github.com/acme/backend", "acme/backend"),
            ("git@github.com:acme/backend.git", "acme/backend"),
            ("ssh://git@git.example.com/acme/backend.git", "acme/backend"),
            ("/Users/kevin/code/backend", "backend"),
            ("/Users/kevin/code/backend/", "backend"),
        ] {
            assert_eq!(slug_from_remote(remote), expected, "{remote}");
        }
    }

    #[test]
    fn a_refusal_on_a_known_host_points_at_authorizing_it() {
        let e = probe_error("https://github.com/acme/private.git", ProbeFailure::Denied);
        assert!(e.message.contains("authorize"), "{}", e.message);
    }

    #[test]
    fn a_refusal_anywhere_else_points_at_the_credentials_already_there() {
        let e = probe_error("/Users/kevin/code/backend", ProbeFailure::Denied);
        assert!(e.message.contains("ls-remote"), "{}", e.message);
    }
}

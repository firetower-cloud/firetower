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
    let mut repos = state.db.repos().await?;
    // Names only, and from one read of the vault rather than one per
    // repository. Nothing is decrypted: a screen that says how many variables a
    // session will bring has no business opening any of them.
    let held = state.vault.names().await?;

    for repo in &mut repos {
        let scope = env_scope(&repo.id);
        repo.env = held
            .iter()
            .filter(|(s, _)| *s == scope)
            .map(|(_, name)| name.clone())
            .collect();
    }

    Ok(Json(repos))
}

/// Where a repository's variables live in the vault.
///
/// By id rather than by slug: a slug has a `/` in it, and these end up in a URL
/// path on the way to being revealed.
pub fn env_scope(id: &RepoId) -> String {
    format!("repo:{id}")
}

/// Change what a repository does before an agent starts.
///
/// Both fields are optional, and absent means "leave it alone" rather than
/// "clear it" — a form that edits one must not wipe the other.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RepoChanges {
    /// A shell command, or an empty string to run nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<String>,
    /// Where to write the variables in the workspace, or an empty string for
    /// no file at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_file: Option<String>,
}

#[utoipa::path(
    patch, path = "/api/v1/repos/{id}", tag = "repos",
    params(("id" = String, Path, description = "Repository id")),
    request_body = RepoChanges,
    responses((status = 200, body = Repo), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn update_repo(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<RepoChanges>,
) -> ApiResult<Json<Repo>> {
    let id = RepoId::from_stored(id);
    state
        .db
        .repo(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("repository"))?;

    // A path out of the workspace is not a path in it. The worker joins this
    // onto the worktree, and `../../.ssh/authorized_keys` would be joined just
    // as happily.
    let file = req.env_file.as_deref().map(str::trim);
    if let Some(path) = file.filter(|p| !p.is_empty()) {
        if path.starts_with('/') || path.split('/').any(|part| part == "..") {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                "the file goes somewhere inside the workspace — a relative path with no `..`",
            ));
        }
    }

    state
        .db
        .update_repo(
            &id,
            req.setup
                .as_deref()
                .map(|s| Some(s.trim()).filter(|s| !s.is_empty())),
            file.map(|p| Some(p).filter(|p| !p.is_empty())),
        )
        .await?;

    let repos = list_repos(State(state)).await?;
    repos
        .0
        .into_iter()
        .find(|r| r.id == id)
        .map(Json)
        .ok_or_else(|| ApiError::not_found("repository"))
}

/// The variables a session on this repository will be given.
///
/// Names, never values. One value comes back from one route, the same one
/// everything else in the vault uses, and that route writes to the log first.
#[utoipa::path(
    get, path = "/api/v1/repos/{id}/env", tag = "repos",
    params(("id" = String, Path, description = "Repository id")),
    responses((status = 200, body = Vec<String>), (status = 404, body = ApiError)),
)]
pub(super) async fn list_repo_env(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<String>>> {
    let id = RepoId::from_stored(id);
    state
        .db
        .repo(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("repository"))?;

    let scope = env_scope(&id);
    Ok(Json(
        state
            .vault
            .names()
            .await?
            .into_iter()
            .filter(|(s, _)| *s == scope)
            .map(|(_, name)| name)
            .collect(),
    ))
}

/// Variables to hold for this repository.
///
/// Either typed one at a time, or pasted as a whole `.env` — the same route,
/// because they are the same thing arriving in two shapes, and the file is the
/// shape people already have.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewEnv {
    #[serde(default)]
    pub variables: Vec<EnvVariable>,
    /// A pasted `.env`, parsed here rather than in a browser: quoting is where
    /// this goes wrong, and there should be one implementation of it.
    #[serde(default)]
    pub dotenv: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct EnvVariable {
    pub name: String,
    pub value: String,
}

/// What was stored, and what was not.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StoredEnv {
    /// Every variable this repository now has, in order.
    pub names: Vec<String>,
    /// Lines that were skipped, and why — said rather than swallowed, because
    /// a variable that silently never arrives is a long afternoon.
    pub skipped: Vec<String>,
}

#[utoipa::path(
    put, path = "/api/v1/repos/{id}/env", tag = "repos",
    params(("id" = String, Path, description = "Repository id")),
    request_body = NewEnv,
    responses((status = 200, body = StoredEnv), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn put_repo_env(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<NewEnv>,
) -> ApiResult<Json<StoredEnv>> {
    let id = RepoId::from_stored(id);
    let repo = state
        .db
        .repo(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("repository"))?;

    let mut keeping: Vec<ft_core::dotenv::Variable> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    for typed in req.variables {
        let name = typed.name.trim().to_string();
        match ft_core::dotenv::check(&name) {
            Ok(()) => keeping.push(ft_core::dotenv::Variable {
                name,
                value: typed.value,
            }),
            Err(reason) => skipped.push(reason),
        }
    }

    if let Some(text) = req.dotenv.as_deref() {
        let parsed = ft_core::dotenv::parse(text);
        keeping.extend(parsed.variables);
        skipped.extend(
            parsed
                .rejected
                .into_iter()
                .map(|r| format!("line {}: {}", r.line, r.reason)),
        );
    }

    if keeping.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            if skipped.is_empty() {
                "nothing to store".to_string()
            } else {
                skipped.join("; ")
            },
        ));
    }

    let scope = env_scope(&id);
    for variable in &keeping {
        state
            .vault
            .put(
                &scope,
                &variable.name,
                &variable.value,
                &format!("set for {} on the repository screen", repo.slug),
            )
            .await?;
    }

    let names = list_repo_env(State(state), Path(id.to_string())).await?.0;
    Ok(Json(StoredEnv { names, skipped }))
}

#[utoipa::path(
    delete, path = "/api/v1/repos/{id}/env/{name}", tag = "repos",
    params(
        ("id" = String, Path, description = "Repository id"),
        ("name" = String, Path, description = "Variable name"),
    ),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn remove_repo_env(
    State(state): State<AppState>,
    Path((id, name)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let id = RepoId::from_stored(id);
    let repo = state
        .db
        .repo(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("repository"))?;

    state
        .vault
        .forget(
            &env_scope(&id),
            &name,
            &format!("removed from {} on the repository screen", repo.slug),
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
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
    /// True when only this machine could clone it — an ssh remote or a path.
    #[serde(default)]
    pub only_here: bool,
}

/// Whether a remote is a directory here rather than something reachable.
pub(super) fn is_local_path(remote: &str) -> bool {
    remote.starts_with('/') || remote.starts_with('.') || remote.starts_with('~')
}

/// Whether every host could clone this, or only this one.
///
/// A token Firetower holds is sent with the work, so an https remote clones
/// anywhere with a route to it. Two shapes can't use one:
///
/// - `git@host:acme/thing` authenticates with an ssh key. Yours is on this
///   machine and travels nowhere, and git never asks the askpass helper, so the
///   token we attach is quietly ignored.
/// - a path is a directory that exists here and nowhere else.
///
/// Both clone perfectly on this machine and fail on every other one, so the
/// difference is worth saying at the moment a URL is pasted rather than during
/// a clone half an hour later.
pub(super) fn only_here(remote: &str) -> bool {
    let remote = remote.trim();
    if is_local_path(remote) {
        return true;
    }
    if remote.starts_with("ssh://") {
        return true;
    }
    // `git@host:path` — an `@` and a `:` before any `/`, which is the scp-like
    // form and not a URL.
    match remote.split_once('@') {
        Some((_, rest)) => rest
            .split_once(':')
            .is_some_and(|(host, _)| !host.contains('/')),
        None => false,
    }
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
/// Which host was asked, for a message that would otherwise be about nothing
/// in particular. The answer depends entirely on the machine that gave it —
/// its network, its credentials, its git — so a failure has to name it.
fn asked(host: &ft_core::Host) -> String {
    match host.compute {
        ft_core::Compute::Local => "this machine".to_string(),
        _ => host.name.clone(),
    }
}

fn probe_error(remote: &str, failure: ProbeFailure, host: &ft_core::Host) -> ApiError {
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
        // The bucket everything unrecognised falls into, so it is also where a
        // probe that timed out and a connection that dropped mid-question end
        // up. Naming the host is the difference between looking at the right
        // machine and looking at your own.
        ProbeFailure::Unreachable => ApiError::new(
            ErrorCode::RepoUnreachable,
            format!(
                "{} couldn't reach {remote}. If it works from a terminal there,                  check the control plane's log for what git said.",
                asked(host)
            ),
        ),
        ProbeFailure::NotARepository => ApiError::new(
            ErrorCode::RepoUnusable,
            format!("{remote} isn't a git repository"),
        ),
        ProbeFailure::GitMissing => ApiError::new(
            ErrorCode::RepoUnreachable,
            format!("git isn't installed on {}", asked(host)),
        ),
    }
}

/// This machine, when it can answer.
///
/// Always this one and never a server. A repository belongs to no host — every
/// host clones it with the same provider token — so which machine looks is
/// arbitrary, and picking a remote one made the same paste succeed or fail for
/// reasons that had nothing to do with the repository. This is also the only
/// machine where a local path means anything.
///
/// `None` when it isn't reachable. That is not a refusal: saving a URL does not
/// need a worker, and the caller carries on without one.
async fn local_host(state: &AppState) -> Option<ft_core::Host> {
    state
        .db
        .hosts()
        .await
        .ok()?
        .into_iter()
        .find(|h| h.compute == ft_core::Compute::Local && h.state == ft_core::HostState::Online)
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

    let host = local_host(&state).await.ok_or_else(|| {
        ApiError::new(
            ErrorCode::HostUnreachable,
            "this machine's worker isn't running, so nothing can read the remote",
        )
    })?;
    let info = state
        .fleet
        .probe(
            &host.id,
            remote,
            credential_for(&state, remote, &format!("checking {remote}")).await,
        )
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
        .map_err(|f| probe_error(remote, f, &host))?;

    if info.empty {
        return Err(ApiError::new(
            ErrorCode::RepoUnusable,
            format!("{remote} has no commits yet, so there's nothing to branch from"),
        ));
    }

    Ok(Json(ProbeResponse {
        slug: slug_from_remote(remote),
        default_branch: info.default_branch,
        only_here: only_here(remote),
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

    // Looked at when something can look, and saved either way.
    //
    // Reading the remote catches a typo while the person who made it is still
    // on the form, and it is where the trunk's real name comes from. Neither is
    // worth refusing to record a URL over: the row is a URL, and a session that
    // clones it later answers the same question against the machine that
    // actually matters.
    let mut trunk = None;

    if let Some(host) = local_host(&state).await {
        match state
            .fleet
            .probe(
                &host.id,
                remote,
                credential_for(&state, remote, &format!("connecting {remote}")).await,
            )
            .await
        {
            Ok(Ok(info)) => {
                if info.empty {
                    return Err(ApiError::new(
                        ErrorCode::RepoUnusable,
                        format!("{remote} has no commits yet, so there's nothing to branch from"),
                    ));
                }
                trunk = Some(info.default_branch);
            }

            // Facts about what was typed, and true from any machine.
            Ok(Err(f @ (ProbeFailure::NotARepository | ProbeFailure::Denied))) => {
                return Err(probe_error(remote, f, &host))
            }

            // Facts about this machine right now — a network that is down, a
            // worker that stopped answering. Neither says anything about the
            // repository, so the URL is kept and read later.
            Ok(Err(f)) => {
                tracing::info!(remote, ?f, "saving without checking it");
            }
            Err(e) => {
                tracing::info!(remote, "saving without checking it: {e:#}");
            }
        }
    }

    let slug = match req.slug.trim() {
        "" => slug_from_remote(remote),
        given => given.to_string(),
    };

    let repo = state
        .db
        .ensure_repo(&slug, remote, trunk.as_deref(), req.setup.as_deref())
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

    let host = local_host(&state).await.ok_or_else(|| {
        ApiError::new(
            ErrorCode::HostUnreachable,
            "this machine's worker isn't running, so nothing can read the remote",
        )
    })?;
    let info = state
        .fleet
        .probe(
            &host.id,
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
        .map_err(|f| probe_error(&repo.remote, f, &host))?;

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

    fn somewhere(name: &str, compute: ft_core::Compute) -> ft_core::Host {
        ft_core::Host {
            id: ft_core::HostId::new(),
            name: name.into(),
            state: ft_core::HostState::Online,
            compute,
            drained: false,
            cpus: None,
            memory_mb: None,
            worker_version: None,
            diagnosis: None,
            reconnecting: false,
        }
    }

    #[test]
    fn a_refusal_on_a_known_host_points_at_authorizing_it() {
        let e = probe_error(
            "https://github.com/acme/private.git",
            ProbeFailure::Denied,
            &somewhere("localhost", ft_core::Compute::Local),
        );
        assert!(e.message.contains("authorize"), "{}", e.message);
    }

    #[test]
    fn a_refusal_anywhere_else_points_at_the_credentials_already_there() {
        let e = probe_error(
            "/Users/kevin/code/backend",
            ProbeFailure::Denied,
            &somewhere("localhost", ft_core::Compute::Local),
        );
        assert!(e.message.contains("ls-remote"), "{}", e.message);
    }

    /// The answer depends entirely on the machine that gave it — its network,
    /// its credentials, its git. A failure that doesn't say which machine sends
    /// you to check the wrong one, which is exactly what happened.
    #[test]
    fn a_failure_says_which_machine_was_asked() {
        let e = probe_error(
            "https://github.com/acme/thing.git",
            ProbeFailure::Unreachable,
            &somewhere(
                "fire-01",
                ft_core::Compute::Server {
                    host: "fire-01".into(),
                    user: None,
                    port: None,
                    identity_file: None,
                    host_key: None,
                    container: None,
                },
            ),
        );
        assert!(e.message.contains("fire-01"), "{}", e.message);

        let here = probe_error(
            "https://github.com/acme/thing.git",
            ProbeFailure::Unreachable,
            &somewhere("localhost", ft_core::Compute::Local),
        );
        assert!(here.message.contains("this machine"), "{}", here.message);
    }
}

#[cfg(test)]
mod portability_tests {
    use super::only_here;

    /// The token Firetower holds is sent with the work, so an https remote is
    /// the same everywhere. These two are not, and both look like they are.
    #[test]
    fn an_ssh_remote_and_a_path_only_work_on_this_machine() {
        assert!(only_here("git@github.com:acme/thing.git"));
        assert!(only_here("ssh://git@github.com/acme/thing.git"));
        assert!(only_here("/Users/kevin/code/thing"));
        assert!(only_here("~/code/thing"));
        assert!(only_here("./thing"));
    }

    #[test]
    fn an_https_remote_travels() {
        assert!(!only_here("https://github.com/acme/thing.git"));
        assert!(!only_here("https://user@github.com/acme/thing.git"));
        assert!(!only_here("http://internal.example/acme/thing.git"));
    }
}

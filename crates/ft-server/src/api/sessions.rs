//! Sessions, and what you do with the work one produced.
//!
//! Starting one is the only place the control plane decides anything on its
//! own: it is what sees every host, so it is what picks. Everything after that
//! is asking the worker that holds the workspace.

use super::agents::agent_env;
use super::repos::is_local_path;
use super::{credential_for, ApiError, ApiResult, ErrorCode};
use crate::oauth;
use crate::providers;
use crate::vault;
use crate::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use ft_core::{session::title_from, NewSession, Session, SessionId, SessionStatus};
use ft_proto::{CreateWorkspace, ToWorker};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Sessions, newest first.
///
/// Without `limit` this returns everything, which is what the dashboard wants —
/// it has to see every running session to say anything true about the fleet.
/// With one, it pages.
#[utoipa::path(
    get, path = "/api/v1/sessions", tag = "sessions",
    params(
        ("limit" = Option<u32>, Query, description = "How many to return"),
        ("before" = Option<String>, Query, description = "Continue after this id"),
    ),
    responses((status = 200, body = Vec<Session>)),
)]
pub(super) async fn list_sessions(
    State(state): State<AppState>,
    Query(page): Query<Page>,
) -> ApiResult<Json<Vec<Session>>> {
    Ok(Json(
        state
            .db
            .sessions_page(page.limit, page.before.as_deref())
            .await?,
    ))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct Page {
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub before: Option<String>,
}

/// End every session that is still running.
///
/// Destructive in the same way as ending one, multiplied — every workspace goes
/// and anything unpushed with it. The count comes back so the interface can say
/// what it did rather than guess.
#[utoipa::path(
    post, path = "/api/v1/sessions/end-all", tag = "sessions",
    responses((status = 200, body = EndedAll)),
)]
pub(super) async fn end_all_sessions(State(state): State<AppState>) -> ApiResult<Json<EndedAll>> {
    let live = state.db.live_sessions().await?;

    let mut ended = 0;
    let mut unreachable = 0;

    for session in live {
        // A host we can't talk to keeps its sessions; marking them ended here
        // would be a lie the next reconnect corrects.
        if !state.fleet.is_connected(&session.host_id).await {
            unreachable += 1;
            continue;
        }

        match state
            .fleet
            .send(
                &session.host_id,
                ToWorker::Destroy {
                    session_id: session.id.clone(),
                    force: true,
                },
            )
            .await
        {
            Ok(()) => ended += 1,
            Err(e) => {
                tracing::warn!(session = %session.id, "ending: {e:#}");
                unreachable += 1;
            }
        }
    }

    Ok(Json(EndedAll { ended, unreachable }))
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EndedAll {
    pub ended: u32,
    /// Left alone because their host wasn't answering.
    pub unreachable: u32,
}

#[utoipa::path(
    get, path = "/api/v1/sessions/{id}", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = Session), (status = 404, body = ApiError)),
)]
pub(super) async fn get_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Session>> {
    state
        .db
        .session(&SessionId::from_stored(id))
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("session"))
}

#[utoipa::path(
    post, path = "/api/v1/sessions", tag = "sessions",
    request_body = NewSession,
    responses(
        (status = 201, body = Session),
        (status = 404, body = ApiError, description = "repository is not connected"),
        (status = 409, body = ApiError, description = "no host can take it"),
    ),
)]
pub(super) async fn create_session(
    State(state): State<AppState>,
    Json(req): Json<NewSession>,
) -> ApiResult<(StatusCode, Json<Session>)> {
    if req.prompt.trim().is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a session needs a prompt",
        ));
    }

    // No repository is a bare agent: a workspace with nothing checked out.
    let repo = match &req.repo_id {
        None => None,
        Some(id) => Some(state.db.repo(id).await?.ok_or_else(|| {
            ApiError::new(
                ErrorCode::RepoNotConnected,
                "that repository isn't connected",
            )
        })?),
    };

    // Scheduling is the control plane's job — it is the only thing that sees
    // every host. Today there is one, so this is the whole scheduler.
    let hosts = state.db.hosts().await?;
    let host = match &req.host_id {
        // Named explicitly, so a drained one is still refused below rather
        // than silently swapped for another.
        Some(id) => hosts.iter().find(|h| &h.id == id),
        None => hosts
            .iter()
            .find(|h| h.state == ft_core::HostState::Online && !h.drained),
    }
    .ok_or_else(|| ApiError::new(ErrorCode::NoCapacity, "no host is available to take this"))?;

    if host.drained {
        return Err(ApiError::new(
            ErrorCode::NoCapacity,
            format!("{} is draining and isn't taking new work", host.name),
        ));
    }

    if !state.fleet.is_connected(&host.id).await {
        return Err(ApiError::new(
            ErrorCode::HostUnreachable,
            format!("{} isn't responding", host.name),
        ));
    }

    // A path is a path on *this* machine. Anywhere else it is a directory that
    // doesn't exist, and the session would fail several steps later with a git
    // error that says nothing about why.
    if repo
        .as_ref()
        .is_some_and(|r| is_local_path(&r.remote) && host.compute != ft_core::Compute::Local)
    {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "{} is a folder on this machine, so it can only run on this machine. \
                 Connect it by URL to use it on {}.",
                repo.as_ref().map(|r| r.remote.as_str()).unwrap_or_default(),
                host.name
            ),
        ));
    }

    // A branch the caller named has to exist, or the worktree fails later with
    // a git error rather than here with an answer.
    // Everything about a checkout is absent together, so "no repository" is one
    // missing value rather than four empty strings.
    let checkout = repo.as_ref().map(|repo| {
        let base = req
            .base
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| repo.default_branch.clone());

        let branch = ft_core::sanitize_branch(
            &req.branch
                .as_deref()
                .map(str::trim)
                .filter(|b| !b.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("agent/{}", ft_core::slugify(&req.prompt))),
        );

        (repo, base, branch)
    });

    // Named by whoever starts the session when they say so — this is what ends
    // up on a pull request, and a slug made from a sentence is a poor thing to
    // live with. Falling back to one is better than refusing.

    let id = SessionId::new();
    let title = title_from(&req.prompt);

    // Named after the branch when there is one; after the session otherwise.
    let workspace = checkout
        .as_ref()
        .map(|(_, _, branch)| ft_core::workspace_name(branch))
        .unwrap_or_else(|| id.as_str().to_string());
    let agent_name = format!("{:?}", req.agent);

    // Decided here, before the worker has been asked to do any of it, so the
    // session page has the whole shape of the work the moment it loads.
    let steps = ft_core::Step::plan(
        repo.is_some(),
        repo.as_ref()
            .and_then(|r| r.setup.as_deref())
            .is_some_and(|s| !s.trim().is_empty()),
    );

    state
        .db
        .insert_session(
            &id,
            &host.id,
            repo.as_ref().map(|r| r.slug.as_str()),
            &title,
            &req.prompt,
            checkout.as_ref().map(|(_, _, b)| b.as_str()),
            checkout.as_ref().map(|(_, b, _)| b.as_str()),
            &agent_name,
            req.size,
            &steps,
        )
        .await?;

    state
        .fleet
        .send(
            &host.id,
            ToWorker::CreateWorkspace(Box::new(CreateWorkspace {
                session_id: id.clone(),
                repo: checkout
                    .as_ref()
                    .map(|(repo, base, branch)| ft_proto::RepoSpec {
                        remote: repo.remote.clone(),
                        slug: repo.slug.clone(),
                        base: base.clone(),
                        branch: branch.clone(),
                    }),
                workspace,
                prompt: req.prompt.clone(),
                agent: req.agent,
                size: req.size,
                setup: repo.as_ref().and_then(|r| r.setup.clone()),
                // Resolved here, sent with the work, and held in memory on the
                // host. Never written to a worker's disk.
                env: agent_env(&state, req.agent, &id).await?,
                // Sent with the work rather than held by the host: the worker
                // keeps it in memory for this session and writes it nowhere.
                credential: match repo.as_ref() {
                    Some(r) => {
                        credential_for(&state, &r.remote, &format!("starting {id} on {}", r.slug))
                            .await
                    }
                    None => None,
                },
            })),
        )
        .await?;

    let session = state
        .db
        .session(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;

    Ok((StatusCode::CREATED, Json(session)))
}

#[utoipa::path(
    delete, path = "/api/v1/sessions/{id}", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 202), (status = 404, body = ApiError)),
)]
pub(super) async fn destroy_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let id = SessionId::from_stored(id);
    let session = state
        .db
        .session(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;

    if session.status == SessionStatus::Ended {
        return Err(ApiError::new(ErrorCode::SessionEnded, "already ended"));
    }

    state
        .fleet
        .send(
            &session.host_id,
            ToWorker::Destroy {
                session_id: id,
                force: false,
            },
        )
        .await?;

    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Done {
    pub detail: String,
}

/// The session, its host, and the credential its remote needs.
async fn session_context(
    state: &AppState,
    id: &SessionId,
) -> Result<(Session, ft_core::HostId), ApiError> {
    let session = state
        .db
        .session(id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;

    if session.status == SessionStatus::Ended {
        return Err(ApiError::new(
            ErrorCode::SessionEnded,
            "that session has ended",
        ));
    }

    let host = session.host_id.clone();
    if !state.fleet.is_connected(&host).await {
        return Err(ApiError::new(
            ErrorCode::HostUnreachable,
            "the host running this session isn't responding",
        ));
    }
    Ok((session, host))
}

async fn act(state: &AppState, id: &SessionId, action: ft_proto::Action) -> ApiResult<Json<Done>> {
    let (session, host) = session_context(state, id).await?;

    // Committing and pushing are about a checkout. Stopping isn't.
    if session.repo.is_none() && !matches!(action, ft_proto::Action::Stop) {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this session has no repository, so there is nothing to commit or push",
        ));
    }

    // Only the remote needs one, and only some of these touch it. A bare agent
    // has no remote at all.
    let credential = match session.repo.as_deref() {
        Some(slug) => match state.db.repo_by_slug(slug).await? {
            Some(repo) => credential_for(state, &repo.remote, &format!("{action:?} on {id}")).await,
            None => None,
        },
        None => None,
    };

    match state
        .fleet
        .run_action(&host, id, action, credential)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
    {
        Ok(detail) => Ok(Json(Done { detail })),
        Err(why) => Err(ApiError::new(ErrorCode::ActionFailed, why)),
    }
}

/// Stop the agent. The workspace and its branch stay.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/stop", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = Done), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn stop_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Done>> {
    act(&state, &SessionId::from_stored(id), ft_proto::Action::Stop).await
}

/// Push the branch, so the work outlives the workspace.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/push", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = Done), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn push_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Done>> {
    act(&state, &SessionId::from_stored(id), ft_proto::Action::Push).await
}

/// What is in this workspace that isn't safely elsewhere.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/work", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = ft_core::WorkSummary), (status = 404, body = ApiError)),
)]
pub(super) async fn session_work(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<ft_core::WorkSummary>> {
    let id = SessionId::from_stored(id);
    let (session, host) = session_context(&state, &id).await?;

    if session.repo.is_none() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this session has no repository, so there is nothing to summarise",
        ));
    }

    state
        .fleet
        .summarize(&host, &id)
        .await
        .map(Json)
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))
}

/// What this session changed, file by file.
///
/// Split on the server: it is a pure function over text that is easy to get
/// subtly wrong, and doing it once here beats doing it in every client.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/diff", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = Vec<ft_core::FileDiff>), (status = 404, body = ApiError)),
)]
pub(super) async fn session_diff(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<ft_core::FileDiff>>> {
    let id = SessionId::from_stored(id);
    let (_, host) = session_context(&state, &id).await?;

    match state
        .fleet
        .run_action(&host, &id, ft_proto::Action::Diff, None)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
    {
        Ok(diff) => Ok(Json(ft_core::split_diff(&diff))),
        Err(why) => Err(ApiError::new(ErrorCode::ActionFailed, why)),
    }
}

/// Open a pull request for this session's branch.
///
/// An API call to the git host rather than a git operation, so it happens here
/// with the token we already hold — the same shape as listing repositories.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/pull-request", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    request_body = NewPullRequest,
    responses(
        (status = 200, body = PullRequest),
        (status = 401, body = ApiError),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
    ),
)]
pub(super) async fn open_pull_request(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<NewPullRequest>,
) -> ApiResult<Json<PullRequest>> {
    let id = SessionId::from_stored(id);
    let (session, _) = session_context(&state, &id).await?;

    // Required rather than derived. A title made from the opening sentence of a
    // prompt reads like "I would like remove", and it is the first thing a
    // reviewer sees.
    let title = req
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| ApiError::new(ErrorCode::InvalidRequest, "a pull request needs a title"))?;

    let slug = session.repo.as_deref().ok_or_else(|| {
        ApiError::new(
            ErrorCode::InvalidRequest,
            "this session has no repository, so there is nothing to open",
        )
    })?;

    let repo = state
        .db
        .repo_by_slug(slug)
        .await?
        .ok_or_else(|| ApiError::not_found("repository"))?;

    let provider = providers::for_remote(&repo.remote).ok_or_else(|| {
        ApiError::new(
            ErrorCode::InvalidRequest,
            "that repository isn't on a host Firetower can open pull requests on",
        )
    })?;

    let token = state
        .vault
        .get(
            vault::GIT,
            provider.id,
            &format!("opening a pull request for {}", repo.slug),
        )
        .await?
        .ok_or_else(|| {
            ApiError::new(
                ErrorCode::ProviderNotConnected,
                format!("authorize {} first", provider.label),
            )
        })?;

    oauth::open_pull_request(
        provider,
        &token,
        &repo.slug,
        session.branch.as_deref().unwrap_or_default(),
        session.base.as_deref().unwrap_or_default(),
        title,
        // The description is the prompt: what was asked for is the most useful
        // thing a reviewer can be told, and nobody wants to retype it.
        req.body.as_deref().unwrap_or(&session.prompt),
    )
    .await
    .map(|url| Json(PullRequest { url }))
    .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewPullRequest {
    /// Written by whoever opens it.
    pub title: Option<String>,
    /// Defaults to the session's prompt.
    pub body: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub url: String,
}

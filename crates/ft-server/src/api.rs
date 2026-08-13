//! The HTTP surface.
//!
//! Handlers carry `#[utoipa::path]`, types derive `ToSchema`, and the document
//! generated from them is the single contract the typed client is built from.
//! A field renamed here becomes a compile error in the web application rather
//! than a runtime surprise.

use crate::oauth::{self, RemoteRepo};
use crate::providers::{self, PendingAuth, ProviderStatus};
use crate::secrets::Secrets;
use crate::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::sse::{self, Sse},
    response::{IntoResponse, Response},
    Json,
};
use ft_core::{
    session::title_from, Agent, Event, Host, NewSession, Repo, RepoId, Session, SessionId,
    SessionStatus,
};
use ft_proto::{CreateWorkspace, Credential, ProbeFailure, ToWorker};
use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::BroadcastStream;
use utoipa::{OpenApi, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

/// Every non-success response, so failures are as typed as everything else.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: ErrorCode,
    /// For humans and logs. The interface should switch on `code` and write its
    /// own copy — only it knows the context and what to offer next.
    pub message: String,
}

/// The catalogue is the type, so there is no separate list to keep in sync.
#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
pub enum ErrorCode {
    InvalidRequest,
    NotFound,
    NoCapacity,
    HostUnreachable,
    RepoNotConnected,
    SessionEnded,
    /// This build has no registered application for that git host.
    ProviderNotConfigured,
    /// Nobody has authorized that git host yet.
    ProviderNotConnected,
    /// We reached the repository's host and were refused.
    RepoAccessDenied,
    /// We could not reach the repository at all.
    RepoUnreachable,
    /// Reachable, but there is nothing there to work from.
    RepoUnusable,
    /// Disconnecting would orphan running work.
    RepoInUse,
    Internal,
}

impl ErrorCode {
    fn status(self) -> StatusCode {
        match self {
            Self::InvalidRequest => StatusCode::BAD_REQUEST,
            Self::NotFound | Self::RepoNotConnected => StatusCode::NOT_FOUND,
            Self::ProviderNotConfigured => StatusCode::NOT_IMPLEMENTED,
            Self::ProviderNotConnected | Self::RepoAccessDenied => StatusCode::UNAUTHORIZED,
            Self::RepoUnreachable | Self::RepoUnusable => StatusCode::BAD_REQUEST,
            Self::NoCapacity | Self::HostUnreachable | Self::SessionEnded | Self::RepoInUse => {
                StatusCode::CONFLICT
            }
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    fn not_found(what: &str) -> Self {
        Self::new(ErrorCode::NotFound, format!("no such {what}"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.code.status(), Json(self)).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!("{e:#}");
        Self::new(ErrorCode::Internal, format!("{e:#}"))
    }
}

type ApiResult<T> = Result<T, ApiError>;

/// What the web application needs before it can do anything else.
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub version: String,
    /// Where the event stream lives. Config, never assumed same-origin — which
    /// is what lets one bundle serve localhost and a hosted deployment alike.
    pub events_path: String,
}

#[derive(Deserialize, ToSchema)]
pub struct Since {
    #[serde(default)]
    pub since: i64,
}

#[utoipa::path(
    get, path = "/api/v1/bootstrap", tag = "meta",
    responses((status = 200, body = Bootstrap)),
)]
async fn bootstrap() -> Json<Bootstrap> {
    Json(Bootstrap {
        version: env!("CARGO_PKG_VERSION").to_string(),
        events_path: "/api/v1/events".to_string(),
    })
}

#[utoipa::path(
    get, path = "/api/v1/hosts", tag = "hosts",
    responses((status = 200, body = Vec<Host>)),
)]
async fn list_hosts(State(state): State<AppState>) -> ApiResult<Json<Vec<Host>>> {
    Ok(Json(state.db.hosts().await?))
}

#[utoipa::path(
    get, path = "/api/v1/repos", tag = "repos",
    responses((status = 200, body = Vec<Repo>)),
)]
async fn list_repos(State(state): State<AppState>) -> ApiResult<Json<Vec<Repo>>> {
    Ok(Json(state.db.repos().await?))
}

/// Connect a repository. Nothing is cloned until a session needs it.
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewRepo {
    /// `acme/backend`
    pub slug: String,
    /// Anything git can clone: a URL, or a path for a local repository.
    pub remote: String,
    #[serde(default = "default_branch")]
    pub default_branch: String,
    /// Runs once per session, before the agent starts.
    #[serde(default)]
    pub setup: Option<String>,
}

fn default_branch() -> String {
    "main".to_string()
}

// ── git hosts ──────────────────────────────────────────────────────────

/// An authorization in flight, and the task doing the waiting.
pub struct Pending {
    pub auth: PendingAuth,
    pub task: tokio::task::JoinHandle<()>,
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The token that applies to a remote, if we hold one.
///
/// A remote we have no token for isn't an error: local paths and self-hosted
/// git work off whatever credentials the worker already has.
fn credential_for(remote: &str) -> Option<Credential> {
    let provider = providers::for_remote(remote)?;
    let secret = Secrets::get(provider.id).ok().flatten()?;
    Some(Credential {
        username: provider.git_username.to_string(),
        secret,
    })
}

#[utoipa::path(
    get, path = "/api/v1/providers", tag = "providers",
    responses((status = 200, body = Vec<ProviderStatus>)),
)]
async fn list_providers(State(state): State<AppState>) -> ApiResult<Json<Vec<ProviderStatus>>> {
    let pending = state.pending.read().await;
    Ok(Json(
        providers::PROVIDERS
            .iter()
            .map(|p| ProviderStatus {
                id: p.id.to_string(),
                label: p.label.to_string(),
                connected: Secrets::get(p.id).ok().flatten().is_some(),
                configured: p.client_id().is_some(),
                pending: pending.get(p.id).map(|p| p.auth.clone()),
            })
            .collect(),
    ))
}

/// Start an authorization and begin waiting for it to be approved.
///
/// Returns immediately with the code to show. The waiting happens here rather
/// than in the browser so that closing the tab doesn't abandon it.
#[utoipa::path(
    post, path = "/api/v1/providers/{id}/authorize", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    responses(
        (status = 200, body = PendingAuth),
        (status = 404, body = ApiError),
        (status = 501, body = ApiError),
    ),
)]
async fn authorize_provider(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<PendingAuth>> {
    let provider = providers::find(&id).ok_or_else(|| ApiError::not_found("provider"))?;

    if provider.client_id().is_none() {
        return Err(ApiError::new(
            ErrorCode::ProviderNotConfigured,
            format!(
                "this build has no application registered for {}. Register one and set \
                 FIRETOWER_{}_CLIENT_ID",
                provider.label,
                provider.id.to_uppercase()
            ),
        ));
    }

    let started = oauth::start(provider).await.map_err(|e| match e {
        oauth::StartError::NotConfigured(m) => ApiError::new(ErrorCode::ProviderNotConfigured, m),
        oauth::StartError::Unreachable(m) => ApiError::new(ErrorCode::HostUnreachable, m),
    })?;

    let auth = PendingAuth {
        user_code: started.user_code.clone(),
        verification_uri: started.verification_uri.clone(),
    };

    let pending = state.pending.clone();
    let device_code = started.device_code.clone();
    let mut interval = std::time::Duration::from_secs(started.interval.max(1));
    let provider_id = provider.id.to_string();

    let task = tokio::spawn(async move {
        // The host tells us how often it will answer; asking faster earns a
        // slow_down and gets us nowhere.
        loop {
            tokio::time::sleep(interval).await;

            match oauth::poll(provider, &device_code).await {
                Ok(oauth::Poll::Pending) => continue,
                Ok(oauth::Poll::SlowDown) => {
                    interval += std::time::Duration::from_secs(5);
                }
                Ok(oauth::Poll::Approved(token)) => {
                    if let Err(e) = Secrets::store(provider.id, &token) {
                        tracing::error!("storing the {} token: {e:#}", provider.label);
                    } else {
                        tracing::info!("{} authorized", provider.label);
                    }
                    pending.write().await.remove(&provider_id);
                    return;
                }
                Ok(oauth::Poll::Failed(why)) => {
                    tracing::warn!("{} authorization ended: {why}", provider.label);
                    pending.write().await.remove(&provider_id);
                    return;
                }
                Err(e) => {
                    tracing::warn!("polling {}: {e:#}", provider.label);
                }
            }
        }
    });

    state.pending.write().await.insert(
        provider.id.to_string(),
        Pending {
            auth: auth.clone(),
            task,
        },
    );

    Ok(Json(auth))
}

/// Sign out: forget the token and stop any authorization still waiting.
#[utoipa::path(
    delete, path = "/api/v1/providers/{id}", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
async fn disconnect_provider(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let provider = providers::find(&id).ok_or_else(|| ApiError::not_found("provider"))?;
    state.pending.write().await.remove(provider.id);
    Secrets::forget(provider.id)
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?;
    Ok(StatusCode::NO_CONTENT)
}

/// What the authorized account can see. This is the picker's data.
#[utoipa::path(
    get, path = "/api/v1/providers/{id}/repos", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    responses(
        (status = 200, body = Vec<RemoteRepo>),
        (status = 401, body = ApiError),
        (status = 404, body = ApiError),
    ),
)]
async fn list_provider_repos(Path(id): Path<String>) -> ApiResult<Json<Vec<RemoteRepo>>> {
    let provider = providers::find(&id).ok_or_else(|| ApiError::not_found("provider"))?;

    let token = Secrets::get(provider.id)
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?
        .ok_or_else(|| {
            ApiError::new(
                ErrorCode::ProviderNotConnected,
                format!("{} hasn't been authorized yet", provider.label),
            )
        })?;

    oauth::list_repos(provider, &token)
        .await
        .map(Json)
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))
}

// ── repositories ───────────────────────────────────────────────────────

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
async fn probe_repo(
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
        .probe(&host, remote, credential_for(remote))
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
async fn create_repo(
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
        .probe(&host, remote, credential_for(remote))
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
async fn delete_repo(
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

#[utoipa::path(
    get, path = "/api/v1/sessions", tag = "sessions",
    responses((status = 200, body = Vec<Session>)),
)]
async fn list_sessions(State(state): State<AppState>) -> ApiResult<Json<Vec<Session>>> {
    Ok(Json(state.db.sessions().await?))
}

#[utoipa::path(
    get, path = "/api/v1/sessions/{id}", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = Session), (status = 404, body = ApiError)),
)]
async fn get_session(
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
async fn create_session(
    State(state): State<AppState>,
    Json(req): Json<NewSession>,
) -> ApiResult<(StatusCode, Json<Session>)> {
    if req.prompt.trim().is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a session needs a prompt",
        ));
    }

    let repo = state.db.repo(&req.repo_id).await?.ok_or_else(|| {
        ApiError::new(
            ErrorCode::RepoNotConnected,
            "that repository isn't connected",
        )
    })?;

    // Scheduling is the control plane's job — it is the only thing that sees
    // every host. Today there is one, so this is the whole scheduler.
    let hosts = state.db.hosts().await?;
    let host = match &req.host_id {
        Some(id) => hosts.iter().find(|h| &h.id == id),
        None => hosts.iter().find(|h| h.state == ft_core::HostState::Online),
    }
    .ok_or_else(|| ApiError::new(ErrorCode::NoCapacity, "no host is available to take this"))?;

    if !state.fleet.is_connected(&host.id).await {
        return Err(ApiError::new(
            ErrorCode::HostUnreachable,
            format!("{} isn't responding", host.name),
        ));
    }

    let id = SessionId::new();
    let branch = format!("agent/{}", ft_core::slugify(&req.prompt));
    let title = title_from(&req.prompt);
    let agent_name = format!("{:?}", req.agent);

    state
        .db
        .insert_session(
            &id,
            &host.id,
            &repo.slug,
            &title,
            &req.prompt,
            &branch,
            &repo.default_branch,
            &agent_name,
            req.size,
        )
        .await?;

    state
        .fleet
        .send(
            &host.id,
            ToWorker::CreateWorkspace(Box::new(CreateWorkspace {
                session_id: id.clone(),
                remote: repo.remote.clone(),
                repo_slug: repo.slug.clone(),
                base: repo.default_branch.clone(),
                branch,
                prompt: req.prompt.clone(),
                agent: req.agent,
                size: req.size,
                setup: repo.setup.clone(),
                env: vec![],
                // Sent with the work rather than held by the host: the worker
                // keeps it in memory for this session and writes it nowhere.
                credential: credential_for(&repo.remote),
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
async fn destroy_session(
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

/// Replay. The live feed is the event stream; this is the backfill after a hard
/// refresh, and the fallback when a stream can't be held open.
#[utoipa::path(
    get, path = "/api/v1/events", tag = "events",
    params(("since" = i64, Query, description = "Last sequence number seen")),
    responses((status = 200, body = Vec<Event>)),
)]
async fn list_events(
    State(state): State<AppState>,
    Query(q): Query<Since>,
) -> ApiResult<Json<Vec<Event>>> {
    Ok(Json(state.db.events_since(q.since).await?))
}

/// The live feed.
///
/// Server-sent events rather than a socket: the data only ever flows down, and
/// the browser then supplies reconnection and replay for free. Each event
/// carries its sequence number as the SSE id, so a client that drops picks up
/// exactly where it left off via `Last-Event-ID` — the resume cursor is the
/// platform's problem, not ours.
#[utoipa::path(
    get, path = "/api/v1/events/stream", tag = "events",
    responses((status = 200, description = "text/event-stream of SessionEvent")),
)]
async fn stream_events(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Sse<impl Stream<Item = Result<sse::Event, std::convert::Infallible>>> {
    let resume_from = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(i64::MAX); // no header: start live, no history replay

    // Anything the client missed, before anything new — so ordering holds
    // across a reconnect.
    let backlog = if resume_from == i64::MAX {
        Vec::new()
    } else {
        state.db.events_since(resume_from).await.unwrap_or_default()
    };

    // A lagging subscriber drops frames rather than blocking the fleet; the
    // client recovers by reconnecting with its last id.
    let live = BroadcastStream::new(state.fleet.subscribe()).filter_map(|r| async move { r.ok() });

    let stream = futures::stream::iter(backlog).chain(live).map(|event| {
        Ok(sse::Event::default()
            .id(event.seq.to_string())
            .event("session")
            .json_data(&event)
            .unwrap_or_else(|_| sse::Event::default().comment("unserialisable event")))
    });

    Sse::new(stream).keep_alive(
        sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("keep-alive"),
    )
}

/// Registered so the generated client gets a type and a validator for the
/// stream, even though no path returns one. The schema document doubles as a
/// type registry rather than only a list of paths.
#[derive(OpenApi)]
#[openapi(
    info(title = "Firetower", version = env!("CARGO_PKG_VERSION")),
    components(schemas(
        Event,
        Agent,
        SessionStatus,
        ft_core::EventKind,
        ft_core::HostState,
        ProviderStatus,
        PendingAuth,
        RemoteRepo
    ))
)]
pub struct ApiDoc;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(bootstrap))
        .routes(routes!(list_hosts))
        .routes(routes!(list_repos, create_repo))
        .routes(routes!(delete_repo))
        .routes(routes!(probe_repo))
        .routes(routes!(list_providers))
        .routes(routes!(authorize_provider))
        .routes(routes!(disconnect_provider))
        .routes(routes!(list_provider_repos))
        .routes(routes!(list_sessions, create_session))
        .routes(routes!(get_session, destroy_session))
        .routes(routes!(list_events))
        .routes(routes!(stream_events))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn error_codes_map_to_sensible_statuses() {
        assert_eq!(ErrorCode::NotFound.status(), StatusCode::NOT_FOUND);
        assert_eq!(ErrorCode::HostUnreachable.status(), StatusCode::CONFLICT);
        assert_eq!(
            ErrorCode::Internal.status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn an_error_serialises_with_a_code_the_interface_can_switch_on() {
        let json = serde_json::to_string(&ApiError::new(
            ErrorCode::HostUnreachable,
            "fire-02 isn't responding",
        ))
        .unwrap();
        assert!(json.contains("\"code\":\"HostUnreachable\""), "{json}");
    }

    #[test]
    fn the_document_describes_every_route() {
        let doc = ApiDoc::openapi();
        let json = serde_json::to_string(&doc).unwrap();
        for path in [
            "/api/v1/bootstrap",
            "/api/v1/sessions",
            "/api/v1/hosts",
            "/api/v1/events",
        ] {
            assert!(
                json.contains(path) || router().split_for_parts().1.paths.paths.contains_key(path),
                "{path} is missing from the contract"
            );
        }
    }
}

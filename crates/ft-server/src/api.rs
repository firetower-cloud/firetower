//! The HTTP surface.
//!
//! Handlers carry `#[utoipa::path]`, types derive `ToSchema`, and the document
//! generated from them is the single contract the typed client is built from.
//! A field renamed here becomes a compile error in the web application rather
//! than a runtime surprise.

use crate::oauth::{self, RemoteRepo};
use crate::providers::{self, PendingAuth, ProviderStatus};
use crate::secrets::{self, Secrets};
use crate::{fleet, AppState};
use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{Path, Query, State},
    http::StatusCode,
    response::sse::{self, Sse},
    response::{IntoResponse, Response},
    Json,
};
use ft_core::{
    session::title_from, Agent, AgentMode, AgentPresence, Event, Host, NewSession, Repo, RepoId,
    Session, SessionId, SessionStatus,
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
    /// The host tried and it didn't work — nothing to commit, push rejected.
    ActionFailed,
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
            Self::NoCapacity
            | Self::HostUnreachable
            | Self::SessionEnded
            | Self::RepoInUse
            | Self::ActionFailed => StatusCode::CONFLICT,
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

/// Replay, optionally for a single session.
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Replay {
    #[serde(default)]
    pub since: i64,
    #[serde(default)]
    pub session_id: Option<String>,
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

/// What an agent needs in its environment to authenticate.
///
/// Resolved at the moment a workspace starts rather than stored alongside the
/// secret: which variable carries it is a delivery detail, and freezing it into
/// a row would make it a migration the day an agent changes its mind.
async fn agent_env(state: &AppState, kind: Agent) -> Result<Vec<(String, String)>, ApiError> {
    let Some((_, mode, _, _)) = state
        .db
        .agent_modes()
        .await?
        .into_iter()
        .find(|(k, ..)| *k == kind)
    else {
        return Ok(Vec::new());
    };

    let Some(secret) = state.db.agent_secret(kind).await? else {
        return Ok(Vec::new());
    };

    let variable = match mode {
        AgentMode::Subscription => kind.token_setup().map(|(_, var)| var),
        AgentMode::ApiKey => kind.api_key_var(),
        AgentMode::NotNeeded => None,
    };

    Ok(variable
        .map(|v| vec![(v.to_string(), secret)])
        .unwrap_or_default())
}

/// The token that applies to a remote, if we hold one.
///
/// A remote we have no token for isn't an error: local paths and self-hosted
/// git work off whatever credentials the worker already has.
async fn credential_for(remote: &str) -> Option<Credential> {
    let provider = providers::for_remote(remote)?;
    let secret = Secrets::get(secrets::GIT, provider.id)
        .await
        .ok()
        .flatten()?;
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

    let mut out = Vec::new();
    for p in providers::PROVIDERS {
        out.push(ProviderStatus {
            id: p.id.to_string(),
            label: p.label.to_string(),
            // The flag, not the token: reading the token is a blocking call the
            // operating system may put behind a prompt, and this endpoint only
            // renders a screen.
            connected: state.db.has_credential(secrets::GIT, p.id).await?,
            configured: p.client_id().is_some(),
            pending: pending.get(p.id).map(|p| p.auth.clone()),
        });
    }
    Ok(Json(out))
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
    let db = state.db.clone();
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
                    match Secrets::store(secrets::GIT, provider.id, &token).await {
                        Ok(()) => {
                            let _ = db.mark_credential(secrets::GIT, provider.id).await;
                            tracing::info!("{} authorized", provider.label);
                        }
                        Err(e) => tracing::error!("storing the {} token: {e:#}", provider.label),
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
    Secrets::forget(secrets::GIT, provider.id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?;
    state.db.clear_credential(secrets::GIT, provider.id).await?;
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

    let token = Secrets::get(secrets::GIT, provider.id)
        .await
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

// ── agents ─────────────────────────────────────────────────────────────

/// One agent kind, its configuration, and where it's actually present.
///
/// Joined here rather than left to the interface: the screen shows one row per
/// kind, so it should cost one request.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    pub kind: Agent,
    pub label: String,
    /// `None` until someone configures it.
    pub mode: Option<AgentMode>,
    pub enabled: bool,
    /// Whether a credential is held. Only ever true in `ApiKey` mode — a
    /// subscription lives in the agent's own config on the host.
    pub credential_set: bool,
    /// True when nothing needs configuring, which is only the plain shell.
    pub needs_credential: bool,
    /// What to run locally to get a token, when this agent works that way.
    pub token_command: Option<String>,
    pub hosts: Vec<AgentOnHost>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentOnHost {
    pub host_id: String,
    pub host_name: String,
    pub installed: bool,
    pub version: Option<String>,
    /// `None` when this agent can't be asked without being started, which is
    /// not the same as being signed out.
    pub logged_in: Option<bool>,
    /// Which account this host spends against, when it will say.
    pub account: Option<String>,
    /// Whether the token we hold applies to this host.
    pub covered_by_token: bool,
    /// When we last asked. Absent means never.
    pub checked_at: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureAgent {
    pub mode: AgentMode,
    /// The token from `claude setup-token`, or a metered API key — whichever
    /// the mode calls for. Required for both; ignored for an agent that needs
    /// no credential.
    pub secret: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

fn agent_from_path(kind: &str) -> Result<Agent, ApiError> {
    Agent::from_name(kind).ok_or_else(|| ApiError::not_found("agent"))
}

#[utoipa::path(
    get, path = "/api/v1/agents", tag = "agents",
    responses((status = 200, body = Vec<AgentView>)),
)]
async fn list_agents(State(state): State<AppState>) -> ApiResult<Json<Vec<AgentView>>> {
    let modes = state.db.agent_modes().await?;
    let presence = state.db.presence().await?;
    let hosts = state.db.hosts().await?;

    let mut views = Vec::new();
    for kind in Agent::all() {
        let configured = modes.iter().find(|(k, ..)| *k == kind);

        views.push(AgentView {
            kind,
            label: kind.label().to_string(),
            mode: configured.map(|(_, m, ..)| *m),
            enabled: configured.map(|(_, _, e, _)| *e).unwrap_or(true),
            // Whether one is set, never the value itself.
            credential_set: configured.map(|(.., set)| *set).unwrap_or(false),
            needs_credential: kind.needs_credential(),
            // What to run, and where. The command happens on your own machine
            // because that is where a browser is.
            token_command: kind.token_setup().map(|(cmd, _)| cmd.to_string()),
            hosts: hosts
                .iter()
                .map(|h| {
                    let seen = presence
                        .iter()
                        .find(|p| p.host == h.id && p.found.kind == kind);

                    AgentOnHost {
                        host_id: h.id.to_string(),
                        host_name: h.name.clone(),
                        installed: seen.map(|p| p.found.installed).unwrap_or(false),
                        version: seen.and_then(|p| p.found.version.clone()),
                        logged_in: seen.and_then(|p| p.found.logged_in),
                        account: seen.and_then(|p| p.found.account.clone()),
                        // A host is usable either because someone signed in
                        // there, or because our token covers it. Different
                        // facts, and the screen shows which.
                        covered_by_token: configured
                            .map(|(_, m, _, set)| *m == AgentMode::Subscription && *set)
                            .unwrap_or(false),
                        checked_at: seen.map(|p| p.checked_at.clone()),
                    }
                })
                .collect(),
        });
    }

    Ok(Json(views))
}

/// Configure how an agent authenticates.
#[utoipa::path(
    put, path = "/api/v1/agents/{kind}", tag = "agents",
    params(("kind" = String, Path, description = "Agent kind")),
    request_body = ConfigureAgent,
    responses((status = 204), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
async fn configure_agent(
    State(state): State<AppState>,
    Path(kind): Path<String>,
    Json(req): Json<ConfigureAgent>,
) -> ApiResult<StatusCode> {
    let kind = agent_from_path(&kind)?;

    if !kind.needs_credential() && req.mode != AgentMode::NotNeeded {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("{} has nothing to authenticate", kind.label()),
        ));
    }

    let secret = req
        .secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if matches!(req.mode, AgentMode::Subscription | AgentMode::ApiKey) && secret.is_none() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            match kind.token_setup() {
                Some((command, _)) => format!("run `{command}` and paste what it prints"),
                None => "that mode needs a key".to_string(),
            },
        ));
    }

    // Passing it through clears whatever the previous mode stored, so a key
    // never lingers behind a subscription.
    state
        .db
        .set_agent_mode(kind, req.mode, req.enabled, secret)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// Forget an agent's configuration and any credential with it.
#[utoipa::path(
    delete, path = "/api/v1/agents/{kind}", tag = "agents",
    params(("kind" = String, Path, description = "Agent kind")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
async fn forget_agent(
    State(state): State<AppState>,
    Path(kind): Path<String>,
) -> ApiResult<StatusCode> {
    let kind = agent_from_path(&kind)?;
    state.db.forget_agent(kind).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Re-ask every reachable host what it has.
///
/// Hosts we can't reach are skipped rather than failing the request: their last
/// answer stays on screen, which is more useful than an error.
#[utoipa::path(
    post, path = "/api/v1/agents/check", tag = "agents",
    responses((status = 200, body = Vec<AgentView>)),
)]
async fn check_agents(State(state): State<AppState>) -> ApiResult<Json<Vec<AgentView>>> {
    for host in state.db.hosts().await? {
        if !state.fleet.is_connected(&host.id).await {
            continue;
        }
        match state.fleet.probe_agents(&host.id).await {
            Ok(found) => state.db.record_presence(&host.id, &found).await?,
            Err(e) => tracing::warn!(host = %host.name, "asking about agents: {e:#}"),
        }
    }
    list_agents(State(state)).await
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
        .probe(&host, remote, credential_for(remote).await)
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
        .probe(&host, remote, credential_for(remote).await)
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
async fn repo_branches(
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
        .probe(&host, &repo.remote, credential_for(&repo.remote).await)
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

    // A branch the caller named has to exist, or the worktree fails later with
    // a git error rather than here with an answer.
    let base = match req.base.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(chosen) => chosen.to_string(),
        None => repo.default_branch.clone(),
    };

    // Named by whoever starts the session when they say so — this is what ends
    // up on a pull request, and a slug made from a sentence is a poor thing to
    // live with. Falling back to one is better than refusing.
    let branch = ft_core::sanitize_branch(
        &req.branch
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("agent/{}", ft_core::slugify(&req.prompt))),
    );
    let workspace = ft_core::workspace_name(&branch);

    let id = SessionId::new();
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
            &base,
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
                base: base.clone(),
                branch,
                workspace,
                prompt: req.prompt.clone(),
                agent: req.agent,
                size: req.size,
                setup: repo.setup.clone(),
                // Resolved here, sent with the work, and held in memory on the
                // host. Never written to a worker's disk.
                env: agent_env(&state, req.agent).await?,
                // Sent with the work rather than held by the host: the worker
                // keeps it in memory for this session and writes it nowhere.
                credential: credential_for(&repo.remote).await,
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
    params(
        ("since" = i64, Query, description = "Last sequence number seen"),
        ("sessionId" = Option<String>, Query, description = "Only this session's events"),
    ),
    responses((status = 200, body = Vec<Event>)),
)]
async fn list_events(
    State(state): State<AppState>,
    Query(q): Query<Replay>,
) -> ApiResult<Json<Vec<Event>>> {
    let session = q.session_id.map(SessionId::from_stored);
    Ok(Json(
        state.db.events_since_for(q.since, session.as_ref()).await?,
    ))
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

// ── what you do with a session's work ──────────────────────────────────

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

async fn act(
    state: &AppState,
    id: &SessionId,
    action: ft_proto::Action,
) -> ApiResult<Json<Done>> {
    let (session, host) = session_context(state, id).await?;

    // Only the remote needs one, and only some of these touch it.
    let credential = match state.db.repo_by_slug(&session.repo).await? {
        Some(repo) => credential_for(&repo.remote).await,
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
async fn stop_session(
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
async fn push_session(
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
async fn session_work(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<ft_core::WorkSummary>> {
    let id = SessionId::from_stored(id);
    let (_, host) = session_context(&state, &id).await?;

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
async fn session_diff(
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
async fn open_pull_request(
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
        .ok_or_else(|| {
            ApiError::new(
                ErrorCode::InvalidRequest,
                "a pull request needs a title",
            )
        })?;

    let repo = state
        .db
        .repo_by_slug(&session.repo)
        .await?
        .ok_or_else(|| ApiError::not_found("repository"))?;

    let provider = providers::for_remote(&repo.remote).ok_or_else(|| {
        ApiError::new(
            ErrorCode::InvalidRequest,
            "that repository isn't on a host Firetower can open pull requests on",
        )
    })?;

    let token = Secrets::get(secrets::GIT, provider.id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?
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
        &session.branch,
        &session.base,
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

/// The terminal.
///
/// A websocket rather than the event stream: this is the one thing in Firetower
/// that genuinely flows both ways, byte at a time, and where latency is felt.
///
/// Output arrives as binary frames of raw terminal bytes. Input goes back the
/// same way; a text frame is a control message, which today means resizing.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/pty", tag = "sessions",
    params(
        ("id" = String, Path, description = "Session id"),
        ("cols" = Option<u16>, Query, description = "Terminal width"),
        ("rows" = Option<u16>, Query, description = "Terminal height"),
    ),
    responses((status = 101, description = "Terminal stream")),
)]
async fn session_pty(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(size): Query<TerminalSize>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let id = SessionId::from_stored(id);
    upgrade.on_upgrade(move |socket| drive_terminal(socket, state, id, size))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct TerminalSize {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

/// What a browser can say about its terminal, beyond typing into it.
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum FromViewer {
    Resize { cols: u16, rows: u16 },
}

async fn drive_terminal(
    mut socket: WebSocket,
    state: AppState,
    session_id: SessionId,
    size: TerminalSize,
) {
    let Ok(Some(session)) = state.db.session(&session_id).await else {
        let _ = socket
            .send(Message::Text("no such session".to_string().into()))
            .await;
        return;
    };

    let host = session.host_id;
    let (cols, rows) = (size.cols.unwrap_or(120), size.rows.unwrap_or(32));

    let mut output = match state.fleet.watch(&host, &session_id, cols, rows).await {
        Ok(rx) => rx,
        Err(e) => {
            let _ = socket.send(Message::Text(format!("{e:#}").into())).await;
            return;
        }
    };

    loop {
        tokio::select! {
            // Output first: a burst from the agent should reach the screen
            // before we go looking for keystrokes.
            biased;

            received = output.recv() => match received {
                Ok(fleet::Terminal::Data(bytes)) => {
                    if socket.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                Ok(fleet::Terminal::Closed) => break,
                // Lagging means the viewer couldn't keep up and frames were
                // dropped. The screen is now wrong in a way that redrawing
                // can't fix, so end it rather than show a corrupted terminal.
                Err(_) => break,
            },

            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    if state.fleet.send_input(&host, &session_id, &bytes).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Text(text))) => {
                    if let Ok(FromViewer::Resize { cols, rows }) = serde_json::from_str(&text) {
                        let _ = state.fleet.resize(&host, &session_id, cols, rows).await;
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            },
        }
    }

    state.fleet.unwatch(&host, &session_id).await;
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
        RemoteRepo,
        AgentMode,
        AgentPresence,
        ft_core::WorkSummary,
        ft_core::FileDiff
    ))
)]
pub struct ApiDoc;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(bootstrap))
        .routes(routes!(list_hosts))
        .routes(routes!(list_repos, create_repo))
        .routes(routes!(delete_repo))
        .routes(routes!(repo_branches))
        .routes(routes!(probe_repo))
        .routes(routes!(list_agents))
        .routes(routes!(configure_agent, forget_agent))
        .routes(routes!(check_agents))
        .routes(routes!(list_providers))
        .routes(routes!(authorize_provider))
        .routes(routes!(disconnect_provider))
        .routes(routes!(list_provider_repos))
        .routes(routes!(list_sessions, create_session))
        .routes(routes!(get_session, destroy_session))
        .routes(routes!(list_events))
        .routes(routes!(stream_events))
        .routes(routes!(session_pty))
        .routes(routes!(stop_session))
        .routes(routes!(push_session))
        .routes(routes!(session_diff))
        .routes(routes!(open_pull_request))
        .routes(routes!(session_work))
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

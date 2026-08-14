//! The HTTP surface.
//!
//! Handlers carry `#[utoipa::path]`, types derive `ToSchema`, and the document
//! generated from them is the single contract the typed client is built from.
//! A field renamed here becomes a compile error in the web application rather
//! than a runtime surprise.

use crate::oauth::{self, RemoteRepo};
use crate::providers::{self, PendingAuth, ProviderStatus};
use crate::vault;
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

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewHost {
    /// What you'll call it. Defaults to something derived from the kind.
    pub name: Option<String>,
    pub compute: ft_core::Compute,
}

/// Add somewhere for agents to run.
///
/// Connecting happens straight away rather than on the next restart, so a
/// mistake in an address is a message here instead of a host that silently
/// never works.
#[utoipa::path(
    post, path = "/api/v1/hosts", tag = "hosts",
    request_body = NewHost,
    responses((status = 201, body = Host), (status = 400, body = ApiError), (status = 409, body = ApiError)),
)]
async fn create_host(
    State(state): State<AppState>,
    Json(req): Json<NewHost>,
) -> ApiResult<(StatusCode, Json<Host>)> {
    let name = match req.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(given) => given.to_string(),
        None => match &req.compute {
            ft_core::Compute::Local => "localhost".to_string(),
            ft_core::Compute::Container { name, .. } => name.clone(),
            // `root@fire-01` is an address; `fire-01` is what you call it.
            ft_core::Compute::Server { target, .. } => target
                .rsplit('@')
                .next()
                .unwrap_or(target)
                .split(':')
                .next()
                .unwrap_or(target)
                .to_string(),
        },
    };

    // This machine is registered at start-up and always present. Adding a
    // second one would be two workers over the same directories.
    if req.compute == ft_core::Compute::Local {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this machine is always available and doesn't need adding",
        ));
    }

    if state.db.host_by_name(&name).await?.is_some() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("there is already a host called {name}"),
        ));
    }

    if let ft_core::Compute::Container { image, name } = &req.compute {
        start_container(image, name)
            .await
            .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?;
    }

    let host = state.db.ensure_host(&name, req.compute).await?;

    // Connect now, so a bad address is a message rather than a silence.
    let transport = fleet::Fleet::transport_for(&host, &state.home)
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?;

    if let Err(e) = state.fleet.connect(host.id.clone(), transport).await {
        state.db.delete_host(&host.id).await?;
        return Err(ApiError::new(
            ErrorCode::HostUnreachable,
            format!("couldn't reach it: {e:#}"),
        ));
    }

    let host = state
        .db
        .host_by_name(&name)
        .await?
        .ok_or_else(|| ApiError::not_found("host"))?;

    Ok((StatusCode::CREATED, Json(host)))
}

/// Bring up a worker container, or reuse the one that's already running.
///
/// Firetower owns the lifecycle of containers it creates. One it didn't create
/// is left alone rather than silently adopted.
async fn start_container(image: &str, name: &str) -> anyhow::Result<()> {
    use anyhow::Context;
    use tokio::process::Command;

    // Checked before running anything, because Docker's own answer is to try
    // pulling from a registry this image was never published to — and "pull
    // access denied" sends you looking for a login you don't need.
    let present = Command::new("docker")
        .args(["image", "inspect", image])
        .output()
        .await
        .context("is Docker running?")?;

    if !present.status.success() {
        anyhow::bail!(
            "the worker image {image} hasn't been built yet. Run `just worker-image` \
             — it takes a few minutes the first time and is cached after."
        );
    }

    let running = Command::new("docker")
        .args(["inspect", "-f", "{{.State.Running}}", name])
        .output()
        .await
        .context("is Docker running?")?;

    match String::from_utf8_lossy(&running.stdout).trim() {
        "true" => return Ok(()),
        "false" => {
            Command::new("docker")
                .args(["start", name])
                .output()
                .await?;
            return Ok(());
        }
        _ => {}
    }

    let created = Command::new("docker")
        .args(["run", "-d", "--name", name, image, "sleep", "infinity"])
        .output()
        .await
        .context("starting the worker container")?;

    if !created.status.success() {
        anyhow::bail!(
            "docker refused: {}",
            String::from_utf8_lossy(&created.stderr).trim()
        );
    }
    Ok(())
}

/// Stop sending work here, or start again.
#[utoipa::path(
    post, path = "/api/v1/hosts/{id}/drain", tag = "hosts",
    params(("id" = String, Path, description = "Host id")),
    request_body = Drain,
    responses((status = 204), (status = 404, body = ApiError)),
)]
async fn drain_host(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<Drain>,
) -> ApiResult<StatusCode> {
    let id = ft_core::HostId::from_stored(id);
    state.db.set_drained(&id, req.drained).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct Drain {
    pub drained: bool,
}

/// Forget a host.
///
/// Refuses while sessions are running on it, and says which — the same rule as
/// disconnecting a repository, for the same reason.
#[utoipa::path(
    delete, path = "/api/v1/hosts/{id}", tag = "hosts",
    params(("id" = String, Path, description = "Host id")),
    responses((status = 204), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
async fn delete_host(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let id = ft_core::HostId::from_stored(id);
    let hosts = state.db.hosts().await?;
    let host = hosts
        .iter()
        .find(|h| h.id == id)
        .ok_or_else(|| ApiError::not_found("host"))?;

    // Removing it would leave a fresh install with nowhere to run anything,
    // and it comes straight back on the next start anyway.
    if host.compute == ft_core::Compute::Local {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this machine is always available and can't be removed",
        ));
    }

    let live = state.db.live_sessions_on(&id).await?;
    if !live.is_empty() {
        return Err(ApiError::new(
            ErrorCode::RepoInUse,
            format!(
                "{} still has {} running: {}",
                host.name,
                if live.len() == 1 {
                    "a session".to_string()
                } else {
                    format!("{} sessions", live.len())
                },
                live.join(", ")
            ),
        ));
    }

    state.db.delete_host(&id).await?;
    Ok(StatusCode::NO_CONTENT)
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
async fn agent_env(
    state: &AppState,
    kind: Agent,
    session: &SessionId,
) -> Result<Vec<(String, String)>, ApiError> {
    let Some((_, mode, _)) = state
        .db
        .agent_modes()
        .await?
        .into_iter()
        .find(|(k, ..)| *k == kind)
    else {
        return Ok(Vec::new());
    };

    let variable = match mode {
        AgentMode::Subscription => kind.token_setup().map(|(_, var)| var),
        AgentMode::ApiKey => kind.api_key_var(),
        AgentMode::NotNeeded => None,
    };
    // Ask for the variable first: an agent with nothing to carry a token in is
    // not a reason to open the vault, and every open is a line in its log.
    let Some(variable) = variable else {
        return Ok(Vec::new());
    };

    let Some(secret) = state
        .vault
        .get(
            vault::AGENT,
            &agent_key(kind),
            &format!("starting {session} with {}", kind.label()),
        )
        .await?
    else {
        return Ok(Vec::new());
    };

    Ok(vec![(variable.to_string(), secret.to_string())])
}

/// How an agent is named in the vault — the same spelling the database uses.
fn agent_key(kind: Agent) -> String {
    format!("{kind:?}")
}

/// How a mode reads in the access log, which is written for a person.
fn mode_words(mode: AgentMode) -> &'static str {
    match mode {
        AgentMode::Subscription => "a subscription token",
        AgentMode::ApiKey => "a metered API key",
        AgentMode::NotNeeded => "no credential",
    }
}

/// The token that applies to a remote, if we hold one.
///
/// A remote we have no token for isn't an error: local paths and self-hosted
/// git work off whatever credentials the worker already has.
async fn credential_for(state: &AppState, remote: &str, why: &str) -> Option<Credential> {
    let provider = providers::for_remote(remote)?;
    let secret = state
        .vault
        .get(vault::GIT, provider.id, why)
        .await
        // A credential that will not open is a real failure, but not this
        // caller's to report: it is logged where it happens, and here it means
        // the same as having none.
        .ok()
        .flatten()?;
    Some(Credential {
        username: provider.git_username.to_string(),
        secret: secret.to_string(),
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
            connected: state.vault.holds(vault::GIT, p.id).await?,
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
    let vault = state.vault.clone();
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
                    match vault
                        .put(
                            vault::GIT,
                            provider.id,
                            &token,
                            &format!("{} authorized in a browser", provider.label),
                        )
                        .await
                    {
                        Ok(()) => tracing::info!("{} authorized", provider.label),
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
    state
        .vault
        .forget(vault::GIT, provider.id, "signed out of the git host")
        .await?;
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
async fn list_provider_repos(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<RemoteRepo>>> {
    let provider = providers::find(&id).ok_or_else(|| ApiError::not_found("provider"))?;

    let token = state
        .vault
        .get(vault::GIT, provider.id, "listing repositories to pick from")
        .await?
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
        // The vault answers whether one is set without decrypting anything, so
        // rendering this screen never touches a credential.
        let credential_set = state.vault.holds(vault::AGENT, &agent_key(kind)).await?;

        views.push(AgentView {
            kind,
            label: kind.label().to_string(),
            mode: configured.map(|(_, m, ..)| *m),
            enabled: configured.map(|(_, _, e)| *e).unwrap_or(true),
            // Whether one is set, never the value itself.
            credential_set,
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
                            .map(|(_, m, _)| *m == AgentMode::Subscription && credential_set)
                            .unwrap_or(false),
                        checked_at: seen.map(|p| p.checked_at.to_rfc3339()),
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

    state.db.set_agent_mode(kind, req.mode, req.enabled).await?;

    // Whatever the previous mode stored goes, so an API key never lingers
    // behind a subscription as something a workspace could still be handed.
    match secret {
        Some(value) => {
            state
                .vault
                .put(
                    vault::AGENT,
                    &agent_key(kind),
                    value,
                    &format!("{} configured with {}", kind.label(), mode_words(req.mode)),
                )
                .await?
        }
        None => {
            state
                .vault
                .forget(
                    vault::AGENT,
                    &agent_key(kind),
                    &format!("{} no longer authenticates", kind.label()),
                )
                .await?
        }
    }

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
    state
        .vault
        .forget(
            vault::AGENT,
            &agent_key(kind),
            &format!("{} was removed", kind.label()),
        )
        .await?;
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

// ── secrets ────────────────────────────────────────────────────────────

/// A credential Firetower holds. Its name, and nothing else.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HeldSecret {
    pub scope: String,
    pub name: String,
}

/// One line of the access log.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccessEntry {
    pub id: i64,
    pub scope: String,
    pub name: String,
    /// `Write`, `Read`, `Delete`, or `Failed`.
    pub action: String,
    /// What the credential was wanted for, in words.
    pub reason: String,
    pub at: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultView {
    /// Where the key that unlocks all of this lives — in words, never the key.
    pub root_key: String,
    pub held: Vec<HeldSecret>,
    pub access: Vec<AccessEntry>,
    /// Whether the log's chain of digests still holds end to end.
    pub intact: bool,
    /// The first entry that doesn't follow from the one before it, if any.
    pub broken_at: Option<i64>,
}

/// What is stored, and every time it was touched.
///
/// Names and history only. A value comes back from exactly one route, which is
/// `reveal_secret` below, and that one writes to the log before it answers.
#[utoipa::path(
    get, path = "/api/v1/secrets", tag = "secrets",
    responses((status = 200, body = VaultView)),
)]
async fn list_secrets(State(state): State<AppState>) -> ApiResult<Json<VaultView>> {
    let (intact, broken_at) = match state.vault.verify().await? {
        vault::Verification::Intact { .. } => (true, None),
        vault::Verification::Broken { at } => (false, Some(at)),
    };

    Ok(Json(VaultView {
        root_key: state.key_source.to_string(),
        held: state
            .vault
            .names()
            .await?
            .into_iter()
            .map(|(scope, name)| HeldSecret { scope, name })
            .collect(),
        access: state
            .vault
            .access(100)
            .await?
            .into_iter()
            .map(|a| AccessEntry {
                id: a.id,
                scope: a.scope,
                name: a.name,
                action: a.action,
                reason: a.reason,
                at: a.at.to_rfc3339(),
            })
            .collect(),
        intact,
        broken_at,
    }))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSecret {
    /// What to store from now on. The previous value is not recoverable.
    pub value: String,
}

/// A value, on its way to a person who asked for it.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RevealedSecret {
    pub scope: String,
    pub name: String,
    pub value: String,
}

/// Put a credential on screen.
///
/// A `POST` because it changes something: it writes a `Reveal` into the access
/// log, which is what makes this defensible at all. A `GET` would also sit in
/// browser history and proxy logs, which a credential shouldn't.
///
/// This is the one route that hands a stored value back, and it exists because
/// a credential you cannot inspect is one you cannot verify or copy elsewhere.
/// The cost is real: anything that can reach this API can read every token
/// here, and the log is what is left to notice it.
#[utoipa::path(
    post, path = "/api/v1/secrets/{scope}/{name}/reveal", tag = "secrets",
    params(
        ("scope" = String, Path, description = "Secret scope"),
        ("name" = String, Path, description = "Secret name"),
    ),
    responses((status = 200, body = RevealedSecret), (status = 404, body = ApiError)),
)]
async fn reveal_secret(
    State(state): State<AppState>,
    Path((scope, name)): Path<(String, String)>,
) -> ApiResult<Json<RevealedSecret>> {
    let value = state
        .vault
        .reveal(&scope, &name, "shown on the Secrets screen")
        .await?
        .ok_or_else(|| ApiError::not_found("secret"))?;

    Ok(Json(RevealedSecret {
        scope,
        name,
        value: value.to_string(),
    }))
}

/// Replace a credential with a new one.
///
/// Only for a name that already exists. Storing under an arbitrary name would
/// let this screen fill up with values nothing ever reads — what a credential is
/// *for* is decided where it is used, not here.
#[utoipa::path(
    put, path = "/api/v1/secrets/{scope}/{name}", tag = "secrets",
    params(
        ("scope" = String, Path, description = "Secret scope"),
        ("name" = String, Path, description = "Secret name"),
    ),
    request_body = ReplaceSecret,
    responses((status = 204), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
async fn replace_secret(
    State(state): State<AppState>,
    Path((scope, name)): Path<(String, String)>,
    Json(req): Json<ReplaceSecret>,
) -> ApiResult<StatusCode> {
    let value = req.value.trim();
    if value.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "paste the new value, or remove this credential instead",
        ));
    }

    if !state.vault.holds(&scope, &name).await? {
        return Err(ApiError::not_found("secret"));
    }

    state
        .vault
        .put(&scope, &name, value, "replaced on the Secrets screen")
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Remove a credential.
///
/// Whatever used it goes back to having none — an agent shows as needing one
/// again, a git host shows as not authorized. The log entry stays.
#[utoipa::path(
    delete, path = "/api/v1/secrets/{scope}/{name}", tag = "secrets",
    params(
        ("scope" = String, Path, description = "Secret scope"),
        ("name" = String, Path, description = "Secret name"),
    ),
    responses((status = 204)),
)]
async fn remove_secret(
    State(state): State<AppState>,
    Path((scope, name)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    state
        .vault
        .forget(&scope, &name, "removed on the Secrets screen")
        .await?;
    Ok(StatusCode::NO_CONTENT)
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

/// Whether a remote is a directory here rather than something reachable.
fn is_local_path(remote: &str) -> bool {
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
async fn list_sessions(
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
async fn end_all_sessions(State(state): State<AppState>) -> ApiResult<Json<EndedAll>> {
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
        ft_core::FileDiff,
        ft_core::Compute
    ))
)]
pub struct ApiDoc;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(bootstrap))
        .routes(routes!(list_hosts, create_host))
        .routes(routes!(delete_host))
        .routes(routes!(drain_host))
        .routes(routes!(list_repos, create_repo))
        .routes(routes!(delete_repo))
        .routes(routes!(repo_branches))
        .routes(routes!(probe_repo))
        .routes(routes!(list_agents))
        .routes(routes!(configure_agent, forget_agent))
        .routes(routes!(check_agents))
        .routes(routes!(list_secrets))
        .routes(routes!(replace_secret, remove_secret))
        .routes(routes!(reveal_secret))
        .routes(routes!(list_providers))
        .routes(routes!(authorize_provider))
        .routes(routes!(disconnect_provider))
        .routes(routes!(list_provider_repos))
        .routes(routes!(list_sessions, create_session))
        .routes(routes!(end_all_sessions))
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

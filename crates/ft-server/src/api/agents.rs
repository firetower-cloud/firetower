//! The agents themselves: how each authenticates, and where it is installed.
//!
//! Both halves matter and neither is enough alone. A token Firetower holds
//! travels to every host; a subscription lives in the agent's own config on
//! the one machine it was signed in on. So "can this agent run" is a question
//! about a particular host, never a global one.

use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::providers::PendingAuth;
use crate::vault::Key;
use crate::{vault, AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use ft_core::{Agent, AgentMode, SessionId};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// What an agent needs in its environment to authenticate.
///
/// Resolved at the moment a workspace starts rather than stored alongside the
/// secret: which variable carries it is a delivery detail, and freezing it into
/// a row would make it a migration the day an agent changes its mind.
/// Whose agent configuration a request means.
///
/// An agent authenticates with somebody's subscription or somebody's key, so
/// there has to be a somebody. Refused rather than defaulted when
/// authentication is off.
fn owner(principal: &Principal) -> Result<&str, ApiError> {
    principal.owner().ok_or_else(|| {
        ApiError::new(
            ErrorCode::Unauthorized,
            "configuring an agent needs an account, and authentication is switched off",
        )
    })
}

pub(super) async fn agent_env(
    state: &AppState,
    kind: Agent,
    session: &SessionId,
    owner: &str,
) -> Result<Vec<(String, String)>, ApiError> {
    let Some((_, mode, _)) = state
        .db
        .agent_modes(owner)
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
            Key::of(vault::AGENT, &agent_key(kind), owner),
            &format!("starting {session} with {}", kind.label()),
        )
        .await?
    else {
        return Ok(Vec::new());
    };

    Ok(vec![(variable.to_string(), secret.to_string())])
}

/// The files an agent needs in its own directory, with what goes in them.
///
/// The other shape of the same thing `agent_env` returns. Which one an agent
/// uses is the agent's business: Claude Code reads a variable, Codex reads
/// `auth.json`, and both come from the same vault row.
///
/// Only for a subscription. An API key is a string and belongs in a variable;
/// writing one into a file Codex expects to hold OAuth tokens would produce a
/// worse error than not writing it at all.
pub(super) async fn agent_home(
    state: &AppState,
    kind: Agent,
    session: &SessionId,
    owner: &str,
) -> Result<Vec<(String, String)>, ApiError> {
    let Some(file) = kind.credential_file() else {
        return Ok(Vec::new());
    };

    let Some((_, AgentMode::Subscription, _)) = state
        .db
        .agent_modes(owner)
        .await?
        .into_iter()
        .find(|(k, ..)| *k == kind)
    else {
        return Ok(Vec::new());
    };

    let Some(secret) = state
        .vault
        .get(
            Key::of(vault::AGENT, &agent_key(kind), owner),
            &format!("starting {session} with {}", kind.label()),
        )
        .await?
    else {
        return Ok(Vec::new());
    };

    Ok(vec![(file.to_string(), secret.to_string())])
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
    /// Whether Firetower can actually run this one.
    ///
    /// An agent Firetower has no driver for is still listed — it is installed
    /// on your hosts and you can see that it is — but a session cannot be
    /// started on it, and a row that does not say so is a row that lets
    /// somebody find out the hard way.
    pub supported: bool,
    /// What to run locally to get a token, when this agent works that way.
    pub token_command: Option<String>,
    /// Whether this one signs a machine in with a code instead.
    ///
    /// Separate from `supported`: a credential is worth having before there is
    /// a driver to spend it, and it is the half that needs a person.
    pub signs_in_with_a_code: bool,
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
pub(super) async fn list_agents(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<AgentView>>> {
    let owner = owner(&principal)?;
    let modes = state.db.agent_modes(owner).await?;
    let presence = state.db.presence().await?;
    let hosts = state.db.hosts().await?;

    let mut views = Vec::new();
    for kind in Agent::all() {
        let configured = modes.iter().find(|(k, ..)| *k == kind);
        // The vault answers whether one is set without decrypting anything, so
        // rendering this screen never touches a credential.
        let credential_set = state
            .vault
            .holds(Key::of(vault::AGENT, &agent_key(kind), owner))
            .await?;

        views.push(AgentView {
            kind,
            label: kind.label().to_string(),
            mode: configured.map(|(_, m, ..)| *m),
            enabled: configured.map(|(_, _, e)| *e).unwrap_or(true),
            // Whether one is set, never the value itself.
            credential_set,
            needs_credential: kind.needs_credential(),
            supported: kind.speaks_a_protocol(),
            // What to run, and where. The command happens on your own machine
            // because that is where a browser is.
            token_command: kind.token_setup().map(|(cmd, _)| cmd.to_string()),
            signs_in_with_a_code: kind.signs_in_with_a_code(),
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
pub(super) async fn configure_agent(
    Extension(principal): Extension<Principal>,
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

    let owner = owner(&principal)?;
    state
        .db
        .set_agent_mode(owner, kind, req.mode, req.enabled)
        .await?;

    // Whatever the previous mode stored goes, so an API key never lingers
    // behind a subscription as something a workspace could still be handed.
    match secret {
        Some(value) => {
            state
                .vault
                .put(
                    Key::of(vault::AGENT, &agent_key(kind), owner),
                    value,
                    &format!("{} configured with {}", kind.label(), mode_words(req.mode)),
                )
                .await?
        }
        None => {
            state
                .vault
                .forget(
                    Key::of(vault::AGENT, &agent_key(kind), owner),
                    &format!("{} no longer authenticates", kind.label()),
                )
                .await?
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

/// What a sign-in needs from the caller.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SignIn {
    /// Which host should do it. Any that has the agent, by default.
    ///
    /// It matters only in that OpenAI delivers the credential to whichever
    /// machine asked for the code — and that machine hands it straight to us,
    /// so which one it was stops mattering the moment it lands.
    pub host_id: Option<String>,
}

/// Sign an agent in with a device code, on a host.
///
/// Returns as soon as there is a code to show. Approving it happens in a
/// browser, wherever the person is, and can take a quarter of an hour — so the
/// waiting is a task here rather than a request left open.
///
/// Only Codex works this way. Claude Code hands you a token to paste, which is
/// `configure_agent`.
#[utoipa::path(
    post, path = "/api/v1/agents/{kind}/login", tag = "agents",
    params(("kind" = String, Path, description = "Agent kind")),
    request_body = SignIn,
    responses(
        (status = 200, body = PendingAuth),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
        (status = 503, body = ApiError),
    ),
)]
pub(super) async fn sign_agent_in(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(kind): Path<String>,
    Json(req): Json<SignIn>,
) -> ApiResult<Json<PendingAuth>> {
    let kind = agent_from_path(&kind)?;
    let owner = owner(&principal)?.to_string();

    if !kind.signs_in_with_a_code() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            match kind.token_setup() {
                Some((command, _)) => format!(
                    "{} does not sign in with a code. Run `{command}` and paste what it prints.",
                    kind.label()
                ),
                None => format!("{} does not sign in with a code", kind.label()),
            },
        ));
    }

    let host = choose_host(&state, kind, req.host_id.as_deref()).await?;

    let (pending, finished) = state
        .fleet
        .codex_login(&host)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?;

    let answer = PendingAuth {
        user_code: pending.user_code.clone(),
        verification_uri: pending.verification_url.clone(),
    };

    let vault = state.vault.clone();
    let db = state.db.clone();
    tokio::spawn(async move {
        match finished.await {
            Ok(Ok(credential)) => {
                // The credential first, the mode second. A mode saying it is
                // signed in with nothing behind it is the worse of the two
                // half-states to be interrupted in.
                if let Err(e) = vault
                    .put(
                        Key::of(vault::AGENT, &agent_key(kind), &owner),
                        &credential,
                        &format!("{} signed in with a device code", kind.label()),
                    )
                    .await
                {
                    tracing::error!("storing the {} credential: {e:#}", kind.label());
                    return;
                }
                if let Err(e) = db
                    .set_agent_mode(&owner, kind, AgentMode::Subscription, true)
                    .await
                {
                    tracing::error!("recording that {} is signed in: {e:#}", kind.label());
                }
                tracing::info!("{} signed in", kind.label());
            }
            Ok(Err(why)) => tracing::warn!("the {} sign-in did not finish: {why}", kind.label()),
            Err(_) => tracing::warn!("the {} sign-in was abandoned", kind.label()),
        }
    });

    Ok(Json(answer))
}

/// Which host should do the signing in.
///
/// One that has the agent, because a machine without it cannot ask for a code.
/// Named explicitly when the caller cares; otherwise any, since the credential
/// comes back to us either way and the choice leaves no trace.
async fn choose_host(
    state: &AppState,
    kind: Agent,
    asked_for: Option<&str>,
) -> Result<ft_core::HostId, ApiError> {
    let presence = state.db.presence().await?;
    let hosts = state.db.hosts().await?;

    let has_it = |host: &ft_core::HostId| {
        presence
            .iter()
            .any(|p| &p.host == host && p.found.kind == kind && p.found.installed)
    };

    let chosen = match asked_for {
        Some(wanted) => hosts
            .into_iter()
            .find(|h| h.id.as_str() == wanted)
            .ok_or_else(|| ApiError::not_found("host"))
            .and_then(|h| {
                if has_it(&h.id) {
                    Ok(h.id)
                } else {
                    Err(ApiError::new(
                        ErrorCode::InvalidRequest,
                        format!("{} is not installed on that host", kind.label()),
                    ))
                }
            })?,
        None => hosts
            .into_iter()
            .find(|h| has_it(&h.id))
            .map(|h| h.id)
            .ok_or_else(|| {
                ApiError::new(
                    ErrorCode::HostUnreachable,
                    format!(
                        "no host has {} installed. Add it with \
                         `firetower worker agents add codex`.",
                        kind.label()
                    ),
                )
            })?,
    };

    Ok(chosen)
}

/// Forget an agent's configuration and any credential with it.
#[utoipa::path(
    delete, path = "/api/v1/agents/{kind}", tag = "agents",
    params(("kind" = String, Path, description = "Agent kind")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn forget_agent(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(kind): Path<String>,
) -> ApiResult<StatusCode> {
    let kind = agent_from_path(&kind)?;
    let owner = owner(&principal)?;
    state.db.forget_agent(owner, kind).await?;
    state
        .vault
        .forget(
            Key::of(vault::AGENT, &agent_key(kind), owner),
            &format!("{} was removed", kind.label()),
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// What a host is being asked to fetch.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InstallAgent {
    /// Which machine gets it. Agents are per host: a token travels, a binary
    /// does not.
    pub host_id: String,
    /// Which version. The newest published one when nobody says.
    pub version: Option<String>,
}

/// Fetch an agent onto a host.
///
/// The alternative was a shell command on the machine itself, which is fine
/// for a server somebody is already logged in to and useless for the container
/// Firetower is running inside. The work happens on the host either way — this
/// only means nobody has to reach it by hand.
///
/// Slow on purpose: the request is held until npm is done, because the answer
/// somebody wants is which version they now have.
#[utoipa::path(
    post, path = "/api/v1/agents/{kind}/install", tag = "agents",
    params(("kind" = String, Path, description = "Agent kind")),
    request_body = InstallAgent,
    responses(
        (status = 200, body = Vec<AgentView>),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
        (status = 503, body = ApiError),
    ),
)]
pub(super) async fn install_agent(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(kind): Path<String>,
    Json(req): Json<InstallAgent>,
) -> ApiResult<Json<Vec<AgentView>>> {
    let kind = agent_from_path(&kind)?;

    // Not every agent is something we fetch. Saying so here means the worker
    // is never asked a question it can only refuse.
    if kind.package().is_none() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("{} is not something Firetower installs", kind.label()),
        ));
    }

    let host = state
        .db
        .hosts()
        .await?
        .into_iter()
        .find(|h| h.id.as_str() == req.host_id)
        .ok_or_else(|| ApiError::not_found("host"))?;

    if !state.fleet.is_connected(&host.id).await {
        return Err(ApiError::new(
            ErrorCode::HostUnreachable,
            format!("{} is not connected", host.name),
        ));
    }

    let version = state
        .fleet
        .install_agent(&host.id, kind, req.version.as_deref())
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?;

    tracing::info!(host = %host.name, "installed {} {version}", kind.label());

    // Ask rather than assume. The install said what it fetched; whether that
    // is now the copy answering on `PATH` is a different question, and the
    // host is the only one who can answer it.
    match state.fleet.probe_agents(&host.id).await {
        Ok(found) => state.db.record_presence(&host.id, &found).await?,
        Err(e) => tracing::warn!(host = %host.name, "asking what it has now: {e:#}"),
    }

    list_agents(State(state), Extension(principal)).await
}

/// Re-ask every reachable host what it has.
///
/// Hosts we can't reach are skipped rather than failing the request: their last
/// answer stays on screen, which is more useful than an error.
#[utoipa::path(
    post, path = "/api/v1/agents/check", tag = "agents",
    responses((status = 200, body = Vec<AgentView>)),
)]
pub(super) async fn check_agents(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<AgentView>>> {
    for host in state.db.hosts().await? {
        if !state.fleet.is_connected(&host.id).await {
            continue;
        }
        match state.fleet.probe_agents(&host.id).await {
            Ok(found) => state.db.record_presence(&host.id, &found).await?,
            Err(e) => tracing::warn!(host = %host.name, "asking about agents: {e:#}"),
        }
    }
    list_agents(State(state), Extension(principal)).await
}

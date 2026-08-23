//! The agents themselves: how each authenticates, and where it is installed.
//!
//! Both halves matter and neither is enough alone. A token Firetower holds
//! travels to every host; a subscription lives in the agent's own config on
//! the one machine it was signed in on. So "can this agent run" is a question
//! about a particular host, never a global one.

use super::{ApiError, ApiResult, ErrorCode};
use crate::{vault, AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use ft_core::{Agent, AgentMode, SessionId};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// What an agent needs in its environment to authenticate.
///
/// Resolved at the moment a workspace starts rather than stored alongside the
/// secret: which variable carries it is a delivery detail, and freezing it into
/// a row would make it a migration the day an agent changes its mind.
pub(super) async fn agent_env(
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
pub(super) async fn list_agents(State(state): State<AppState>) -> ApiResult<Json<Vec<AgentView>>> {
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
            supported: kind.speaks_a_protocol(),
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
pub(super) async fn configure_agent(
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
pub(super) async fn forget_agent(
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
pub(super) async fn check_agents(State(state): State<AppState>) -> ApiResult<Json<Vec<AgentView>>> {
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

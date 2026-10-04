//! The agents themselves: how each authenticates, and where it is installed.
//!
//! Both halves matter and neither is enough alone. A token Firetower holds
//! travels to every host; a subscription lives in the agent's own config on
//! the one machine it was signed in on. So "can this agent run" is a question
//! about a particular host, never a global one.

use super::access::may_share;
use super::{ApiError, ApiResult, ErrorCode};
use crate::access::FiledKind;
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
    let carried = agent_credential(
        &state.db,
        &state.vault,
        kind,
        owner,
        session,
        &format!("starting {session} with {}", kind.label()),
    )
    .await?;
    Ok(carried
        .into_iter()
        .map(|(name, secret)| (name, secret.0))
        .collect())
}

/// The variable this account's agent authenticates with, and its value.
///
/// Shared by everything that starts one of these agents, which is no longer
/// only a session: describing a change runs a short-lived agent of its own on
/// the host, from the worker daemon rather than from inside the session, so it
/// inherits nothing and has to be handed the same credential. Sent with the
/// request that needs it, exactly as a git credential is.
///
/// `why` is written into the vault's access log, so it should say which run
/// this was for.
pub(crate) async fn agent_credential(
    db: &crate::db::Db,
    vault: &crate::vault::Vault,
    kind: Agent,
    owner: &str,
    session: &SessionId,
    why: &str,
) -> anyhow::Result<Vec<(String, ft_proto::Secret)>> {
    let Some(account) = super::accounts::selected(db, owner, session).await? else {
        return Ok(Vec::new());
    };
    let mode = if account.mode == "ApiKey" {
        AgentMode::ApiKey
    } else {
        AgentMode::Subscription
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

    let Some(secret) = vault.get(account.credential(), why).await? else {
        return Ok(Vec::new());
    };

    Ok(vec![(variable.to_string(), secret.to_string().into())])
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
    if kind.credential_file().is_none() && !kind.credential_bundle() {
        return Ok(Vec::new());
    }

    let Some(account) = super::accounts::selected(&state.db, owner, session).await? else {
        return Ok(Vec::new());
    };
    if account.mode != "Subscription" {
        return Ok(Vec::new());
    }

    let Some(secret) = state
        .vault
        .get(
            account.credential(),
            &format!("starting {session} with {}", kind.label()),
        )
        .await?
    else {
        return Ok(Vec::new());
    };

    if kind.credential_bundle() {
        // Path to contents, exactly as the sign-in collected it. A bundle that
        // will not parse is a credential we cannot write out, and guessing at
        // half of it would start the agent as nobody.
        let files: std::collections::BTreeMap<String, String> =
            serde_json::from_str(secret.to_string().as_str()).map_err(|e| {
                ApiError::new(
                    ErrorCode::InvalidRequest,
                    format!(
                        "the stored {} credential is not readable: {e}",
                        kind.label()
                    ),
                )
            })?;
        return Ok(files.into_iter().collect());
    }

    let file = kind
        .credential_file()
        .expect("checked above: not a bundle, so it names a file");
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
    /// Whether the default account holds a credential that travels: a
    /// subscription token or an API key. False when nothing is connected yet.
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
    /// Whether this one uses a worker-mediated browser sign-in, with or without a short code.
    ///
    /// Separate from `supported`: a credential is worth having before there is
    /// a driver to spend it, and it is the half that needs a person.
    pub signs_in_with_a_code: bool,
    /// The newest version its publisher is serving, when the control plane has
    /// managed to ask.
    ///
    /// One per kind rather than per host: what is published does not depend on
    /// which machine is behind it. `None` means nobody has asked yet, or the
    /// publisher could not be reached — neither of which is "up to date".
    pub latest_version: Option<String>,
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
    /// Whether what is installed here is older than what is published.
    ///
    /// False whenever that cannot be established — an unreadable version on
    /// either side, or a publisher nobody has reached. Saying nothing beats
    /// telling somebody to reinstall on a guess.
    pub behind: bool,
    /// Whether the person asking may actually move this one.
    ///
    /// Installing an agent is administrative and felt by everybody running on
    /// the machine, so it is the same question `may_share` answers about a
    /// machine's fate — see `api::hosts::to_administer`. Answered here rather
    /// than in `status`, because this is the layer that knows who is asking;
    /// the Updates screen settles `may_upgrade` the same way.
    ///
    /// Separate from `behind` on purpose. A colleague's machine being stale is
    /// worth seeing; it is not yours to fix, and a button that 403s is worse
    /// than no button.
    pub may_update: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureAgent {
    pub mode: AgentMode,
    /// The token from `claude setup-token`, or a metered API key — whichever
    /// the mode calls for. Absent, the mode must be the one already set and
    /// only `enabled` changes; ignored for an agent that needs no credential.
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

    // Which of them this person may actually move an agent onto, settled once
    // rather than per agent kind. Installing one is administrative and felt by
    // everybody running on the machine, so it is `may_share` about the machine
    // — the same question `api::hosts::to_administer` asks before draining or
    // renaming one, and the same way `api::updates::as_seen_by` settles its
    // own button.
    let mut administers: std::collections::HashSet<String> = std::collections::HashSet::new();
    match principal.user.as_ref() {
        // Development mode, nobody to be, nothing to withhold.
        None => administers.extend(hosts.iter().map(|h| h.id.as_str().to_string())),
        Some(me) => {
            for host in &hosts {
                if may_share(&state, me, FiledKind::Machine, host.id.as_str())
                    .await
                    .is_ok()
                {
                    administers.insert(host.id.as_str().to_string());
                }
            }
        }
    }

    let mut views = Vec::new();
    for kind in Agent::all() {
        let configured = modes.iter().find(|(k, ..)| *k == kind);
        // Read, never fetched: this is a GET, and a screen should not wait on
        // three download services to draw. The six-hourly check and the Check
        // all button are what fill this in.
        let latest_version = state.updates.agent_releases.newest(kind).await;
        // The vault answers whether one is set without decrypting anything, so
        // rendering this screen never touches a credential.
        let default = super::accounts::default_account(&state.db, owner, kind).await?;
        let credential_set = match default.as_ref() {
            // Through the account, so that a subscription filed into a
            // directory still reads as connected: its credential is sealed
            // under the directory now, not under whoever connected it.
            Some(a) => state.vault.holds(a.credential()).await?,
            // Nothing selected: the pre-accounts row, which is still keyed by
            // agent kind under the person.
            None => {
                state
                    .vault
                    .holds(Key::of(vault::AGENT, &agent_key(kind), owner))
                    .await?
            }
        };

        views.push(AgentView {
            kind,
            label: kind.label().to_string(),
            mode: default
                .as_ref()
                .map(|a| {
                    if a.mode == "ApiKey" {
                        AgentMode::ApiKey
                    } else {
                        AgentMode::Subscription
                    }
                })
                .or_else(|| configured.map(|(_, m, ..)| *m)),
            // Whether it is offered when starting work is a fact about the
            // agent, not about any one account — an account's own `enabled`
            // says whether *it* can still be picked.
            enabled: configured.map(|(_, _, e)| *e).unwrap_or(true),
            // Whether one is set, never the value itself.
            credential_set,
            needs_credential: kind.needs_credential(),
            supported: kind.speaks_a_protocol(),
            // What to run, and where. The command happens on your own machine
            // because that is where a browser is.
            token_command: kind.token_setup().map(|(cmd, _)| cmd.to_string()),
            signs_in_with_a_code: kind.signs_in_with_a_code(),
            latest_version: latest_version.clone(),
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
                        behind: seen.is_some_and(|p| p.found.installed)
                            && crate::updates::agents::behind(
                                seen.and_then(|p| p.found.version.as_deref()),
                                latest_version.as_deref(),
                            ),
                        may_update: administers.contains(h.id.as_str()),
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

    let owner = owner(&principal)?;

    // No secret and the same mode as before is a change to `enabled` alone:
    // the credential, wherever it lives, stays as it is.
    if matches!(req.mode, AgentMode::Subscription | AgentMode::ApiKey) && secret.is_none() {
        let current = match super::accounts::default_account(&state.db, owner, kind).await? {
            Some(account) => Some(if account.mode == "ApiKey" {
                AgentMode::ApiKey
            } else {
                AgentMode::Subscription
            }),
            None => state
                .db
                .agent_modes(owner)
                .await?
                .into_iter()
                .find(|(k, ..)| *k == kind)
                .map(|(_, mode, _)| mode),
        };
        if current == Some(req.mode) {
            state
                .db
                .set_agent_mode(owner, kind, req.mode, req.enabled)
                .await?;
            return Ok(StatusCode::NO_CONTENT);
        }
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            match kind.token_setup() {
                Some((command, _)) => format!("run `{command}` and paste what it prints"),
                None => "that mode needs a key".to_string(),
            },
        ));
    }

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
    /// The named account to authenticate. Made first with `create_account`.
    pub account_id: Option<String>,
    /// Which host should do it. Any that has the agent, by default.
    ///
    /// It matters only in that OpenAI delivers the credential to whichever
    /// machine asked for the code — and that machine hands it straight to us,
    /// so which one it was stops mattering the moment it lands.
    pub host_id: Option<String>,
    /// Which Kimi the account lives on: `global` for kimi.ai, `mainland-cn`
    /// for kimi.com. Omit for the default, and for every other agent.
    ///
    /// They are separate account namespaces rather than mirrors, so picking
    /// the wrong one signs a different person in and reports success.
    pub region: Option<String>,
}

/// Sign an agent in with a device code, on a host.
///
/// Returns as soon as there is a code to show. Approving it happens in a
/// browser, wherever the person is, and can take a quarter of an hour — so the
/// waiting is a task here rather than a request left open.
///
/// Only Codex works this way. Claude Code hands you a token to paste, which
/// goes in the `secret` of `create_account`.
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

    // A sign-in lands on a named account, made first. Nothing here invents
    // one: an account row with no name and no credential is what a person
    // sees as a connection that never happened.
    let account_id = req.account_id.ok_or_else(|| {
        ApiError::new(
            ErrorCode::InvalidRequest,
            "create the account first, then sign it in",
        )
    })?;
    let account = super::accounts::mine(&state.db, &owner, &account_id).await?;
    if account.kind != agent_key(kind) || account.mode != "Subscription" {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this account does not use device sign-in for this agent",
        ));
    }
    // A second attempt on one that failed starts from pending again, so the
    // outcome of this attempt is what the list shows. One already connected
    // keeps working until the new credential replaces the old.
    sqlx::query("UPDATE agent_accounts SET state='pending' WHERE id=$1 AND user_id=$2 AND state<>'connected'")
        .bind(&account_id)
        .bind(&owner)
        .execute(state.db.pool())
        .await?;
    let host = choose_host(&state, kind, req.host_id.as_deref()).await?;

    let (pending, finished) = state
        .fleet
        .agent_login(&host, kind, req.region.clone())
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
                if let Err(e) =
                    super::accounts::connect(&db, &vault, &owner, &account_id, &credential).await
                {
                    tracing::warn!("recording the sign-in: {e:?}");
                    let _ = sqlx::query("UPDATE agent_accounts SET state='sign-in failed' WHERE id=$1 AND state='pending'")
                        .bind(&account_id).execute(db.pool()).await;
                    return;
                }
                tracing::info!("{} signed in", kind.label());
            }
            Ok(Err(why)) => tracing::warn!("the {} sign-in did not finish: {why}", kind.label()),
            Err(_) => tracing::warn!("the {} sign-in was abandoned", kind.label()),
        }
        let _ = sqlx::query(
            "UPDATE agent_accounts SET state='sign-in failed' WHERE id=$1 AND state='pending'",
        )
        .bind(&account_id)
        .execute(db.pool())
        .await;
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
    sqlx::query("UPDATE agent_accounts SET enabled=false,is_default=false WHERE user_id=$1 AND credential_key=$2")
        .bind(owner).bind(agent_key(kind)).execute(state.db.pool()).await?;
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
/// Slow on purpose: the request is held until the download is done, because
/// the answer somebody wants is which version they now have. A minute is
/// normal — these are binaries of a few hundred megabytes.
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
    if !kind.installable() {
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

    // Whose machine it is. Putting a binary on one is felt by everybody running
    // on it, so it is the same question `api::hosts::to_administer` asks before
    // renaming or draining it — a machine became personal when paths arrived,
    // and this handler did not notice.
    //
    // Gated here as well as on `update_agent`, or the gate there is decoration:
    // the fleet-wide press and this button fetch the same binary onto the same
    // machine, and a member refused the first would simply press the second.
    if let Some(me) = principal.user.as_ref() {
        may_share(&state, me, FiledKind::Machine, host.id.as_str())
            .await
            .map_err(|e| match e.code {
                ErrorCode::NotFound => e,
                _ => ApiError::new(
                    ErrorCode::Forbidden,
                    "that machine is somebody else's to change",
                ),
            })?;
    }

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

/// What one host got out of an update, named so a partial run is readable.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Updated {
    pub host_id: String,
    pub host_name: String,
    /// What it has now, when it worked.
    pub version: Option<String>,
    /// Why it did not, when it didn't.
    pub error: Option<String>,
}

/// Bring every host that is behind onto the published version.
///
/// One press for a fleet, because the alternative is the same button once per
/// machine and a list of which ones you have already done.
///
/// Three decisions worth stating:
///
/// * **The version is resolved once, here, and every host is given it by name.**
///   Asking each of them for `latest` instead would split a fleet across two
///   versions if a release landed in the middle of the run — the same reason the
///   worker pins Codex's sidecar to the CLI that will spawn it.
/// * **Only hosts that are behind.** A host already on it is not reinstalled,
///   and a host with a build somebody pinned *ahead* of the feed is left alone:
///   [`crate::updates::agents::behind`] refuses to call either one stale.
/// * **One at a time, and a failure does not stop the rest.** Clearer about
///   which host went wrong, and it keeps several hundred-megabyte downloads off
///   one uplink. A run where two of five hosts failed is a useful answer.
/// * **Only machines this person administers.** Installing an agent is felt by
///   everybody running on the machine, so it is the question `may_share` answers
///   about a machine's fate rather than about using one — see
///   `api::hosts::to_administer`. Without this, "every host that is behind"
///   would mean every host in the organisation, and one member could reinstall
///   under a colleague's running sessions. Skipped rather than refused, so a
///   fleet somebody part-owns still moves the part that is theirs.
#[utoipa::path(
    post, path = "/api/v1/agents/{kind}/update", tag = "agents",
    params(("kind" = String, Path, description = "Agent kind")),
    responses(
        (status = 200, body = Vec<Updated>),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
    ),
)]
pub(super) async fn update_agent(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(kind): Path<String>,
) -> ApiResult<Json<Vec<Updated>>> {
    owner(&principal)?;
    let kind = agent_from_path(&kind)?;
    if !kind.installable() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("{} is not something Firetower installs", kind.label()),
        ));
    }

    // Asked again rather than taken from the cache: this is the one request
    // where being a few hours out of date would send a fleet to the wrong
    // version, and it costs one HTTP call.
    state
        .updates
        .agent_releases
        .refresh(&state.updates.http, &state.updates.agent_feeds)
        .await;
    let Some(version) = state.updates.agent_releases.newest(kind).await else {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "nobody could say what the newest {} is, so there is nothing to move to",
                kind.label()
            ),
        ));
    };

    let presence = state.db.presence().await?;
    let mut updated = Vec::new();
    for host in state.db.hosts().await? {
        // The same predicate the `mayUpdate` on the row came from, so the
        // button and what it does can never disagree. `hosts_for` at admin
        // level is a near miss rather than an equivalent — it reads grants and
        // exceptions, where `may_share` also lets an administrator of the
        // organisation act and keeps a personal root private from one. A list
        // filtered one way and an action gated the other is a button that does
        // nothing for exactly the people most likely to press it.
        let may = match principal.user.as_ref() {
            // Development mode, nobody to be, nothing to withhold.
            None => true,
            Some(me) => may_share(&state, me, FiledKind::Machine, host.id.as_str())
                .await
                .is_ok(),
        };
        if !may {
            continue;
        }
        let seen = presence
            .iter()
            .find(|p| p.host == host.id && p.found.kind == kind);
        let installed = seen.filter(|p| p.found.installed);
        let Some(installed) = installed else { continue };
        if !crate::updates::agents::behind(installed.found.version.as_deref(), Some(&version)) {
            continue;
        }
        // Skipped rather than reported: a machine that is off is not a machine
        // that failed to update, and the row keeps its last known version.
        if !state.fleet.is_connected(&host.id).await {
            continue;
        }

        let one = match state
            .fleet
            .install_agent(&host.id, kind, Some(&version))
            .await
        {
            Ok(now) => {
                tracing::info!(host = %host.name, "updated {} to {now}", kind.label());
                // Ask rather than assume — see `install_agent`.
                match state.fleet.probe_agents(&host.id).await {
                    Ok(found) => state.db.record_presence(&host.id, &found).await?,
                    Err(e) => {
                        tracing::warn!(host = %host.name, "asking what it has now: {e:#}")
                    }
                }
                Updated {
                    host_id: host.id.to_string(),
                    host_name: host.name.clone(),
                    version: Some(now),
                    error: None,
                }
            }
            Err(e) => {
                tracing::warn!(host = %host.name, "updating {}: {e:#}", kind.label());
                Updated {
                    host_id: host.id.to_string(),
                    host_name: host.name.clone(),
                    version: None,
                    error: Some(format!("{e:#}")),
                }
            }
        };
        updated.push(one);
    }

    Ok(Json(updated))
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
    // Both halves of the comparison this button is pressed to answer. Asking
    // the hosts what they have and not asking the publishers what is newest
    // would refresh the stale side and leave the other as it was at boot.
    state
        .updates
        .agent_releases
        .refresh(&state.updates.http, &state.updates.agent_feeds)
        .await;
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

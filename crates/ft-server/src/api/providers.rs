//! Authorizing a git host, so repositories can be listed and cloned.
//!
//! The waiting happens here rather than in the browser: an authorization is
//! approved on another device, and closing the tab shouldn't abandon it.

use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::oauth::{self, RemoteRepo};
use crate::providers::{self, PendingAuth, ProviderStatus};
use crate::vault::Key;
use crate::{vault, AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Serialize;
use utoipa::ToSchema;

/// Whose git connection a request means.
///
/// Refused rather than defaulted when authentication is off: with nobody
/// signed in there is no account to authorize a git host as, and quietly using
/// the install's own would hand one person's token to whoever asked next.
fn owner(principal: &Principal) -> Result<&str, ApiError> {
    principal.owner().ok_or_else(|| {
        ApiError::new(
            ErrorCode::Unauthorized,
            "connecting a git host needs an account, and authentication is switched off",
        )
    })
}

/// The identity this person's commits carry on this host.
///
/// What they set wins; what their token says is the default, kept the first
/// time it is asked for so a commit is never waiting on a request to GitHub;
/// and `None` means nobody knows, which the worker answers with an identity of
/// its own rather than refusing to commit.
pub(super) async fn identity_for(
    state: &AppState,
    provider: &'static providers::Provider,
    owner: &str,
) -> Option<ft_proto::Author> {
    if let Ok(Some(set)) = state.db.git_identity(owner, provider.id).await {
        return Some(set);
    }

    let token = state
        .vault
        .get(
            Key::of(vault::GIT, provider.id, owner),
            "reading who commits belong to",
        )
        .await
        .ok()
        .flatten()?;

    let author = match oauth::whoami(provider, &token).await {
        Ok(author) => author,
        Err(e) => {
            tracing::warn!("could not read the {} identity: {e:#}", provider.label);
            return None;
        }
    };

    if let Err(e) = state
        .db
        .remember_git_identity(owner, provider.id, &author, "host")
        .await
    {
        // Worth a line, not worth failing: the commit is the point, and the
        // next one asks again.
        tracing::warn!("could not record the git identity: {e:#}");
    }

    Some(author)
}

/// What a person's commits are signed with, and where that came from.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
    /// `host` — read from your token. `set` — you typed it, and nothing
    /// overwrites it.
    pub source: String,
}

/// Who this person's commits are authored as on this host.
#[utoipa::path(
    get, path = "/api/v1/providers/{id}/identity", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    responses(
        (status = 200, body = GitIdentity),
        (status = 404, body = ApiError, description = "Nothing to derive one from"),
    ),
)]
pub(super) async fn get_identity(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<GitIdentity>> {
    let provider = providers::find(&id).ok_or_else(|| ApiError::not_found("provider"))?;
    let owner = owner(&principal)?;

    // Asked before it is answered, so the screen can say which of the two this
    // is — a value you typed reads differently from one we guessed.
    let stored = state.db.git_identity(owner, provider.id).await?.is_some();

    let author = identity_for(&state, provider, owner).await.ok_or_else(|| {
        ApiError::new(
            ErrorCode::ProviderNotConnected,
            format!(
                "authorize {} first, or set a name and address yourself",
                provider.label
            ),
        )
    })?;

    let source = if stored {
        state
            .db
            .git_identity_source(owner, provider.id)
            .await?
            .unwrap_or_else(|| "host".into())
    } else {
        "host".to_string()
    };

    Ok(Json(GitIdentity {
        name: author.name,
        email: author.email,
        source,
    }))
}

/// What to sign commits with, typed rather than derived.
#[derive(Debug, serde::Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetIdentity {
    pub name: String,
    pub email: String,
}

/// Say who your commits should be authored as.
///
/// Kept as `set`, which the derived answer never overwrites: the reason to
/// type one is that what the host said was not the address you wanted on your
/// branches.
#[utoipa::path(
    put, path = "/api/v1/providers/{id}/identity", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    request_body = SetIdentity,
    responses((status = 204), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn set_identity(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(req): Json<SetIdentity>,
) -> ApiResult<StatusCode> {
    let provider = providers::find(&id).ok_or_else(|| ApiError::not_found("provider"))?;
    let owner = owner(&principal)?;

    let name = req.name.trim();
    let email = req.email.trim();
    if name.is_empty() || email.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a commit needs both a name and an address",
        ));
    }
    // Not validated beyond this. Git accepts anything here, and a rule of our
    // own would be one more thing to be wrong about somebody's address.
    if !email.contains('@') {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "that does not look like an email address",
        ));
    }

    state
        .db
        .remember_git_identity(
            owner,
            provider.id,
            &ft_proto::Author {
                name: name.to_string(),
                email: email.to_string(),
            },
            "set",
        )
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// Go back to whatever the git host says you are called.
#[utoipa::path(
    delete, path = "/api/v1/providers/{id}/identity", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn clear_identity(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let provider = providers::find(&id).ok_or_else(|| ApiError::not_found("provider"))?;
    state
        .db
        .forget_git_identity(owner(&principal)?, provider.id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

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

#[utoipa::path(
    get, path = "/api/v1/providers", tag = "providers",
    responses((status = 200, body = Vec<ProviderStatus>)),
)]
pub(super) async fn list_providers(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<ProviderStatus>>> {
    // Whose connections these are. Two people on one Firetower each authorize
    // GitHub as themselves, and each sees only their own.
    let owner = owner(&principal)?;
    let pending = state.pending.read().await;

    let mut out = Vec::new();
    for p in providers::PROVIDERS {
        out.push(ProviderStatus {
            id: p.id.to_string(),
            label: p.label.to_string(),
            // The flag, not the token: reading the token is a blocking call the
            // operating system may put behind a prompt, and this endpoint only
            // renders a screen.
            connected: state.vault.holds(Key::of(vault::GIT, p.id, owner)).await?,
            configured: providers::client_id(&state.accounts, p.id).await.is_some(),
            pending: pending
                .get(&format!("{}:{owner}", p.id))
                .map(|p| p.auth.clone()),
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
pub(super) async fn authorize_provider(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<PendingAuth>> {
    let provider = providers::find(&id).ok_or_else(|| ApiError::not_found("provider"))?;
    let owner = owner(&principal)?.to_string();

    let client_id = providers::client_id(&state.accounts, provider.id).await;

    if client_id.is_none() {
        return Err(ApiError::new(
            ErrorCode::ProviderNotConfigured,
            format!(
                "no application is registered for {}. Add its client id — the connect screen \
                 asks for one and explains where to get it.",
                provider.label,
            ),
        ));
    }

    // Held for the polling task below, which needs it on every attempt.
    let polling_id = client_id.clone().expect("checked just above");

    let started = oauth::start(provider, client_id)
        .await
        .map_err(|e| match e {
            oauth::StartError::NotConfigured(m) => {
                ApiError::new(ErrorCode::ProviderNotConfigured, m)
            }
            oauth::StartError::Unreachable(m) => ApiError::new(ErrorCode::HostUnreachable, m),
        })?;

    let auth = PendingAuth {
        user_code: started.user_code.clone(),
        verification_uri: started.verification_uri.clone(),
    };

    // Keyed by person as well as host: two people authorizing GitHub at the
    // same moment are two authorizations, and one map key would have the
    // second overwrite the first.
    let waiting_on = format!("{}:{owner}", provider.id);
    let pending = state.pending.clone();
    let vault = state.vault.clone();
    let device_code = started.device_code.clone();
    let mut interval = std::time::Duration::from_secs(started.interval.max(1));
    let provider_id = waiting_on.clone();

    let task = tokio::spawn(async move {
        // The host tells us how often it will answer; asking faster earns a
        // slow_down and gets us nowhere.
        loop {
            tokio::time::sleep(interval).await;

            match oauth::poll(provider, &polling_id, &device_code).await {
                Ok(oauth::Poll::Pending) => continue,
                Ok(oauth::Poll::SlowDown) => {
                    interval += std::time::Duration::from_secs(5);
                }
                Ok(oauth::Poll::Approved(token)) => {
                    match vault
                        .put(
                            Key::of(vault::GIT, provider.id, &owner),
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
        waiting_on,
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
pub(super) async fn disconnect_provider(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let provider = providers::find(&id).ok_or_else(|| ApiError::not_found("provider"))?;
    let owner = owner(&principal)?;
    state
        .pending
        .write()
        .await
        .remove(&format!("{}:{owner}", provider.id));
    state
        .vault
        .forget(
            Key::of(vault::GIT, provider.id, owner),
            "signed out of the git host",
        )
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
pub(super) async fn list_provider_repos(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<RemoteRepo>>> {
    let provider = providers::find(&id).ok_or_else(|| ApiError::not_found("provider"))?;

    // Asked with this person's token: the picker must show what they can
    // clone, not what somebody else can.
    let token = state
        .vault
        .get(
            Key::of(vault::GIT, provider.id, owner(&principal)?),
            "listing repositories to pick from",
        )
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

/// The client id for a git host, supplied by whoever is setting this up.
#[derive(Debug, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClientId {
    /// GitHub's looks like `Ov23li…`. Public by design: a device-flow
    /// application has no paired secret.
    pub client_id: String,
}

/// Register an application to authorize against.
///
/// Asked twice on purpose: once in the setup wizard, where it is skippable,
/// and again on the connect-a-repository screen at the moment somebody wants
/// the thing it enables. Stored rather than configured, so it takes effect
/// without a restart.
#[utoipa::path(
    post, path = "/api/v1/providers/{id}/client-id", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    request_body = ClientId,
    responses(
        (status = 204, description = "Stored"),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
    ),
)]
pub(super) async fn set_client_id(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<ClientId>,
) -> ApiResult<axum::http::StatusCode> {
    let provider = providers::find(&id).ok_or_else(|| ApiError::not_found("provider"))?;

    let value = request.client_id.trim();
    if value.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a client id is needed, or leave it alone",
        ));
    }

    state
        .accounts
        .set_setting(&providers::setting_key(provider.id), value)
        .await?;

    tracing::info!(provider = provider.id, "a client id was registered");
    Ok(axum::http::StatusCode::NO_CONTENT)
}

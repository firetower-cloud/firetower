//! Authorizing a git host, so repositories can be listed and cloned.
//!
//! The waiting happens here rather than in the browser: an authorization is
//! approved on another device, and closing the tab shouldn't abandon it.

use super::{ApiError, ApiResult, ErrorCode};
use crate::oauth::{self, RemoteRepo};
use crate::providers::{self, PendingAuth, ProviderStatus};
use crate::{vault, AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};

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
) -> ApiResult<Json<Vec<ProviderStatus>>> {
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
            configured: providers::client_id(&state.accounts, p.id).await.is_some(),
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
pub(super) async fn authorize_provider(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<PendingAuth>> {
    let provider = providers::find(&id).ok_or_else(|| ApiError::not_found("provider"))?;

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

            match oauth::poll(provider, &polling_id, &device_code).await {
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
pub(super) async fn disconnect_provider(
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
pub(super) async fn list_provider_repos(
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

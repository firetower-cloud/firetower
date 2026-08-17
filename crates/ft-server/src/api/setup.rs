//! Finishing setting up.
//!
//! There is no step here that creates an account. The administrator exists
//! before this control plane answers its first request — from `ADMIN_USERNAME`
//! and `ADMIN_INITIAL_PASSWORD`, or generated and printed once — so there is no
//! window in which a fresh Firetower on a public address is waiting for whoever
//! finds it first to claim it.
//!
//! What is left is what only a person can answer: a password that did not come
//! from a file, a name for the organisation, and optionally a GitHub
//! application to authorize against.

use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::AppState;
use axum::{extract::State, Extension, Json};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Which parts of setting up are still outstanding.
///
/// Read before anything else, so the interface knows whether to show the
/// wizard, and how much of it.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetupState {
    /// The signed-in account's password came from a file.
    pub needs_password: bool,
    /// Nobody has named the organisation yet.
    pub needs_organization: bool,
    /// No GitHub application is configured. Not a blocker — it is skippable,
    /// and pasting a repository URL works without one.
    pub needs_github: bool,
    pub organization: Option<crate::accounts::Organization>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NameOrganization {
    pub name: String,
}

#[utoipa::path(
    get, path = "/api/v1/setup", tag = "setup",
    responses((status = 200, body = SetupState)),
)]
pub(super) async fn setup_state(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<SetupState>> {
    let organization = state.accounts.organization().await?;

    Ok(Json(SetupState {
        needs_password: principal.must_change_password(),
        needs_organization: organization.is_none(),
        needs_github: crate::providers::client_id(&state.accounts, "github")
            .await
            .is_none(),
        organization,
    }))
}

#[utoipa::path(
    post, path = "/api/v1/setup/organization", tag = "setup",
    request_body = NameOrganization,
    responses(
        (status = 200, body = crate::accounts::Organization),
        (status = 409, body = ApiError, description = "Already set up"),
    ),
)]
pub(super) async fn name_organization(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<NameOrganization>,
) -> ApiResult<Json<crate::accounts::Organization>> {
    let user = principal
        .user
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "nobody is signed in"))?;

    // The database decides, not this handler: `installation` holds one row, so
    // two requests arriving together cannot both succeed.
    let organization = state
        .accounts
        .finish_setup(&user.org_id, &request.name)
        .await
        .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;

    tracing::info!(organization = %organization.name, "set up");
    Ok(Json(organization))
}

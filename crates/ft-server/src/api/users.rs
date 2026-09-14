//! The organisation, and who is in it — for administrators.
//!
//! Everything here is admin-only, and the check is one function so it cannot
//! be forgotten on a route. A member gets 403 and nothing else; the pages
//! hide what a member cannot do, but the refusal is here.
//!
//! Passwords made here are said once, in the answer, and never again: the
//! person they are for has to replace them the first time they sign in.

use super::{ApiError, ApiResult, ErrorCode};
use crate::accounts::{Organization, User};
use crate::auth::Principal;
use crate::AppState;
use axum::{
    extract::{Path, State},
    Extension, Json,
};
use ft_core::UserId;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// The signed-in administrator, or a refusal.
fn admin(principal: &Principal) -> ApiResult<&User> {
    let user = principal
        .user
        .as_ref()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "nobody is signed in"))?;
    if user.role != "admin" {
        return Err(ApiError::new(
            ErrorCode::Forbidden,
            "only an administrator can do that",
        ));
    }
    Ok(user)
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationName {
    pub name: String,
}

/// Rename the organisation.
#[utoipa::path(
    patch, path = "/api/v1/organization", tag = "organization",
    request_body = OrganizationName,
    responses((status = 200, body = Organization), (status = 403, body = ApiError)),
)]
pub(super) async fn rename_organization(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<OrganizationName>,
) -> ApiResult<Json<Organization>> {
    let me = admin(&principal)?;
    let organization = state
        .accounts
        .rename_organization(&me.org_id, &request.name)
        .await
        .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;
    tracing::info!(by = %me.username, name = %organization.name, "organisation renamed");
    Ok(Json(organization))
}

/// Everyone in the organisation.
#[utoipa::path(
    get, path = "/api/v1/users", tag = "organization",
    responses((status = 200, body = Vec<User>), (status = 403, body = ApiError)),
)]
pub(super) async fn list_users(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<User>>> {
    let me = admin(&principal)?;
    Ok(Json(state.accounts.users_of(&me.org_id).await?))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewUser {
    pub username: String,
    /// `admin` or `member`.
    pub role: String,
}

/// A user, and the password made for them — shown once, never again.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreatedUser {
    pub user: User,
    pub password: String,
}

/// Add a user. The answer carries their temporary password.
#[utoipa::path(
    post, path = "/api/v1/users", tag = "organization",
    request_body = NewUser,
    responses((status = 200, body = CreatedUser), (status = 400, body = ApiError), (status = 403, body = ApiError)),
)]
pub(super) async fn create_user(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<NewUser>,
) -> ApiResult<Json<CreatedUser>> {
    let me = admin(&principal)?;
    let (user, password) = state
        .accounts
        .create_user(&me.org_id, &request.username, &request.role)
        .await
        .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;
    tracing::info!(by = %me.username, user = %user.username, role = %user.role, "user added");
    Ok(Json(CreatedUser { user, password }))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserChange {
    /// `admin` or `member`, when the role changes.
    pub role: Option<String>,
    /// Switched off, or back on.
    pub disabled: Option<bool>,
}

/// Change a user's role, or switch them off or on.
#[utoipa::path(
    patch, path = "/api/v1/users/{id}", tag = "organization",
    params(("id" = String, Path, description = "User id")),
    request_body = UserChange,
    responses((status = 200, body = User), (status = 400, body = ApiError), (status = 403, body = ApiError)),
)]
pub(super) async fn change_user(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(request): Json<UserChange>,
) -> ApiResult<Json<User>> {
    let me = admin(&principal)?;
    let id = UserId::from_stored(id);
    let mut user = one_of_ours(&state, me, &id).await?;
    if let Some(disabled) = request.disabled {
        if disabled && id == me.id {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                "you cannot switch yourself off",
            ));
        }
        user = state
            .accounts
            .set_disabled(&id, disabled)
            .await
            .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;
    }
    if let Some(role) = request.role {
        user = state
            .accounts
            .set_role(&id, &role)
            .await
            .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;
    }
    tracing::info!(by = %me.username, user = %user.username, role = %user.role, disabled = user.disabled, "user changed");
    Ok(Json(user))
}

/// What a reset hands back: the new temporary password, said once.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TemporaryPassword {
    pub password: String,
}

/// Give a user a new temporary password. Their sessions end; they replace it on sign-in.
#[utoipa::path(
    post, path = "/api/v1/users/{id}/password", tag = "organization",
    params(("id" = String, Path, description = "User id")),
    responses((status = 200, body = TemporaryPassword), (status = 403, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn reset_user_password(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<TemporaryPassword>> {
    let me = admin(&principal)?;
    let id = UserId::from_stored(id);
    let user = one_of_ours(&state, me, &id).await?;
    let password = state
        .accounts
        .reset_password(&id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;
    tracing::info!(by = %me.username, user = %user.username, "password reset");
    Ok(Json(TemporaryPassword { password }))
}

/// Remove a user for good. Their workspaces go with them; prefer switching off.
#[utoipa::path(
    delete, path = "/api/v1/users/{id}", tag = "organization",
    params(("id" = String, Path, description = "User id")),
    responses((status = 204), (status = 400, body = ApiError), (status = 403, body = ApiError)),
)]
pub(super) async fn delete_user(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<axum::http::StatusCode> {
    let me = admin(&principal)?;
    let id = UserId::from_stored(id);
    if id == me.id {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "you cannot remove yourself",
        ));
    }
    let user = one_of_ours(&state, me, &id).await?;
    state
        .accounts
        .delete_user(&id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;
    tracing::info!(by = %me.username, user = %user.username, "user removed");
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// The user, if they are in the administrator's organisation. Another
/// organisation's user is "no such user": nothing to enumerate across a line.
async fn one_of_ours(state: &AppState, me: &User, id: &UserId) -> ApiResult<User> {
    state
        .accounts
        .user_by_id(id)
        .await?
        .filter(|u| u.org_id == me.org_id)
        .ok_or_else(|| ApiError::new(ErrorCode::NotFound, "no such user"))
}

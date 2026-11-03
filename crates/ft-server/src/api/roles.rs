//! Roles: the saved kinds of agent a lead can start.
//!
//! Every read pastes `filed_where` through `crate::roles`, so a role somebody
//! has no grant on is absent rather than refused — the same rule as every
//! other kind. Filing one into a directory is not here: a role is
//! `FiledKind::Role`, so the sharing endpoints that already exist do it.

use super::access::whoever;
use super::{ApiError, ApiResult, ErrorCode};
use crate::access::Level;
use crate::auth::Principal;
use crate::roles::{NewRole, Role};
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};

/// A refusal somebody can act on, rather than a 500 with a backtrace in it.
fn refused(e: crate::roles::Refused) -> ApiError {
    ApiError::new(ErrorCode::InvalidRequest, e.to_string())
}

/// A pinned subscription has to be one this person may use and has to be for
/// the profile's engine. Absent is fine — it means the owner's default at
/// launch, which is what an agent-authored profile gets.
async fn check_account(state: &AppState, owner: &str, new: &crate::roles::NewRole) -> ApiResult<()> {
    let Some(account) = new.account.as_deref().filter(|a| !a.is_empty()) else {
        return Ok(());
    };
    let agent = new
        .agent
        .as_deref()
        .and_then(ft_core::Agent::from_name)
        .ok_or_else(|| ApiError::new(ErrorCode::InvalidRequest, "pick an agent first"))?;
    super::accounts::validate(state, owner, account, agent).await?;
    Ok(())
}

#[utoipa::path(
    get, path = "/api/v1/roles", tag = "roles",
    responses((status = 200, body = Vec<Role>), (status = 401, body = ApiError)),
)]
pub(super) async fn list_roles(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<Role>>> {
    let me = whoever(&principal)?;
    Ok(Json(
        state.roles.visible(me.id.as_str(), Level::Viewer).await?,
    ))
}

#[utoipa::path(
    post, path = "/api/v1/roles", tag = "roles",
    request_body = NewRole,
    responses((status = 201, body = Role), (status = 400, body = ApiError)),
)]
pub(super) async fn create_role(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(new): Json<NewRole>,
) -> ApiResult<(StatusCode, Json<Role>)> {
    let me = whoever(&principal)?;
    crate::roles::check(&new).map_err(refused)?;
    check_account(&state, me.id.as_str(), &new).await?;

    let id = state
        .roles
        .create(me.org_id.as_str(), me.id.as_str(), &me.slug, &new)
        .await?;

    // Hand it to a directory, when one was named — the same operation the
    // sharing sheet performs later, at the one moment nobody has to be told it
    // changed hands. Only where this person may write; a directory they cannot
    // reach is "not found" rather than a different error.
    if let Some(directory) = new.directory.as_deref().filter(|d| !d.is_empty()) {
        let target = state
            .access
            .directory(directory)
            .await?
            .ok_or_else(|| ApiError::not_found("directory"))?;
        let may = matches!(
            state.access.level_on(me.id.as_str(), directory).await?,
            Some(level) if level >= Level::Writer
        );
        if !may {
            return Err(ApiError::not_found("directory"));
        }
        let from = state
            .access
            .path_of(crate::access::FiledKind::Role, id.as_str())
            .await?
            .ok_or_else(|| ApiError::not_found("role"))?;
        let whose = principal
            .user
            .as_ref()
            .map(|u| u.username.clone())
            .unwrap_or_else(|| me.id.as_str().to_string());
        state
            .access
            .transfer(
                &state.vault,
                crate::access::FiledKind::Role,
                id.as_str(),
                &from.moved_to(ft_core::path::DIRECTORY, &target.slug),
                &whose,
            )
            .await?;
    }

    let made = state
        .roles
        .one(me.id.as_str(), id.as_str(), Level::Viewer)
        .await?
        .ok_or_else(|| ApiError::not_found("role"))?;
    Ok((StatusCode::CREATED, Json(made)))
}

#[utoipa::path(
    put, path = "/api/v1/roles/{id}", tag = "roles",
    params(("id" = String, Path, description = "Role id")),
    request_body = NewRole,
    responses((status = 200, body = Role), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn update_role(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(new): Json<NewRole>,
) -> ApiResult<Json<Role>> {
    let me = whoever(&principal)?;
    crate::roles::check(&new).map_err(refused)?;
    check_account(&state, me.id.as_str(), &new).await?;

    // Absent rather than refused when they may not change it, for the reason
    // every other read gives: a role you cannot reach is one you are not told
    // exists.
    if !state.roles.update(me.id.as_str(), &id, &new).await? {
        return Err(ApiError::not_found("role"));
    }
    let now = state
        .roles
        .one(me.id.as_str(), &id, Level::Viewer)
        .await?
        .ok_or_else(|| ApiError::not_found("role"))?;
    Ok(Json(now))
}

/// Turn this profile into the person's default for new workspaces, or off.
#[derive(Debug, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoleDefault {
    pub on: bool,
}

#[utoipa::path(
    put, path = "/api/v1/roles/{id}/default", tag = "roles",
    params(("id" = String, Path, description = "Role id")),
    request_body = RoleDefault,
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn set_default_role(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(body): Json<RoleDefault>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    if !state.roles.set_default(me.id.as_str(), &id, body.on).await? {
        return Err(ApiError::not_found("role"));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete, path = "/api/v1/roles/{id}", tag = "roles",
    params(("id" = String, Path, description = "Role id")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn delete_role(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    if !state.roles.delete(me.id.as_str(), &id).await? {
        return Err(ApiError::not_found("role"));
    }
    Ok(StatusCode::NO_CONTENT)
}

//! The organisation, and who is in it — for administrators.
//!
//! Everything here is admin-only, and the check is one function so it cannot
//! be forgotten on a route. A member gets 403 and nothing else; the pages
//! hide what a member cannot do, but the refusal is here.
//!
//! Passwords made here are said once, in the answer, and never again: the
//! person they are for has to replace them the first time they sign in.

use super::{ApiError, ApiResult, ErrorCode};
use crate::access::Reach;
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

/// Everything one person reaches, and everything that is theirs.
///
/// **For deciding about them, which is the one time this question is asked.**
/// Every other read goes the other way — "may this person see this thing",
/// answered per row by `filed_where`. Offboarding needs the reverse, because
/// removing somebody without being shown what goes with them is a decision
/// taken blind.
///
/// An administrator's. It names things across the whole installation,
/// including ones the person asking may not be able to reach themselves, which
/// is exactly what makes it useful and exactly why it is gated.
#[utoipa::path(
    get, path = "/api/v1/users/{id}/reach", tag = "organization",
    params(("id" = String, Path, description = "User id")),
    responses((status = 200, body = Reach), (status = 403, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn user_reach(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Reach>> {
    let me = admin(&principal)?;
    let id = UserId::from_stored(id);
    one_of_ours(&state, me, &id).await?;
    Ok(Json(state.access.reach(id.as_str()).await?))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    /// `person` or `directory`.
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HandOver {
    pub kind: crate::access::FiledKind,
    pub id: String,
    pub to: Destination,
}

/// What to do about everything that is theirs, decided before anything happens.
///
/// **Every row answered, or none of it runs.** A half-specified offboarding is
/// the thing this exists to prevent: the old path was one `DELETE` behind a
/// warning written in the abstract, and whatever it swept was found out
/// afterwards or not at all.
///
/// Two answers per row and not three. *Hand over* moves it; *let go* means it
/// goes with them, which is deletion for a workspace, a subscription or a
/// secret and a move to `Shared` for a machine — compute is real and the
/// organisation is still running on it. A third option spelled "delete" would
/// be a lie on the one kind that is never deleted.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Offboarding {
    #[serde(default)]
    pub hand_over: Vec<HandOver>,
    /// Acknowledged as going with them. Named rather than implied, so that
    /// nothing is lost by somebody not having scrolled.
    #[serde(default)]
    pub let_go: Vec<super::access::FiledRef>,
    /// Switched off, or removed for good.
    pub then: String,
}

/// Hand their work over, then take the account away — in one transaction.
#[utoipa::path(
    post, path = "/api/v1/users/{id}/offboard", tag = "organization",
    params(("id" = String, Path, description = "User id")),
    request_body = Offboarding,
    responses(
        (status = 204),
        (status = 400, body = ApiError, description = "Something of theirs was left undecided"),
        (status = 403, body = ApiError),
    ),
)]
pub(super) async fn offboard_user(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(request): Json<Offboarding>,
) -> ApiResult<axum::http::StatusCode> {
    let me = admin(&principal)?;
    let id = UserId::from_stored(id);
    if id == me.id {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "you cannot offboard yourself",
        ));
    }
    let user = one_of_ours(&state, me, &id).await?;

    // Asked again here rather than trusted from the screen: what is theirs can
    // change between drawing the list and agreeing to it, and the whole promise
    // is that nothing is swept unseen.
    let reach = state.access.reach(id.as_str()).await?;
    let mut undecided: Vec<String> = Vec::new();
    for owned in &reach.owns {
        let decided = request
            .hand_over
            .iter()
            .any(|h| h.kind == owned.kind && h.id == owned.id)
            || request
                .let_go
                .iter()
                .any(|l| l.kind == owned.kind && l.id == owned.id);
        if !decided {
            undecided.push(owned.name.clone());
        }
    }
    if !undecided.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "nothing happens until everything of theirs is decided — still waiting on {}",
                undecided.join(", ")
            ),
        ));
    }

    let remove = match request.then.as_str() {
        "remove" => true,
        "disable" => false,
        other => {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                format!("{other} is not something to do with an account"),
            ))
        }
    };

    let mut tx = state.db.pool().begin().await?;
    for hand in &request.hand_over {
        let from = state
            .access
            .path_of(hand.kind, &hand.id)
            .await?
            .ok_or_else(|| ApiError::not_found(hand.kind.singular()))?;
        let root = match hand.to.kind.as_str() {
            "directory" => {
                let d = state
                    .access
                    .directory(&hand.to.id)
                    .await?
                    .ok_or_else(|| ApiError::not_found("directory"))?;
                from.moved_to(ft_core::path::DIRECTORY, &d.slug)
            }
            _ => {
                let slug = state.access.personal_root(&hand.to.id).await?;
                from.moved_to(ft_core::path::PERSONAL, &slug)
            }
        };
        state
            .access
            .transfer_in(&mut tx, &state.vault, hand.kind, &hand.id, &root, &me.username)
            .await?;
    }

    if remove {
        // Whatever was let go is still at their root, and this is what takes
        // it: workspaces and subscriptions cascade, secrets are deleted, and
        // machines move to `Shared`. Anything handed over above has already
        // left, so none of it is caught by that.
        state.accounts.delete_user_in(&mut tx, &id).await?;
    } else {
        sqlx::query("UPDATE users SET disabled = true WHERE id = $1")
            .bind(id.as_str())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    tracing::info!(
        by = %me.username, user = %user.username,
        handed = request.hand_over.len(), let_go = request.let_go.len(),
        removed = remove, "offboarded"
    );
    Ok(axum::http::StatusCode::NO_CONTENT)
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

    // Refused while anything is still theirs. This used to sweep: workspaces
    // and secrets deleted, machines moved, and the only warning a sentence true
    // of anybody — *their workspaces go too* — which told you nothing about
    // this person. What is theirs now has to be decided row by row, through
    // `offboard`, and this stays as the short path for somebody who holds
    // nothing.
    let theirs = state.access.reach(id.as_str()).await?.owns;
    if !theirs.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "{} still has {} thing{} of their own. Decide what happens to each before removing them.",
                user.username,
                theirs.len(),
                if theirs.len() == 1 { "" } else { "s" }
            ),
        ));
    }

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

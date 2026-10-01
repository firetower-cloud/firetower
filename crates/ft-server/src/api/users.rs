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
    /// Where to write to them. Required for anybody added from now on; the
    /// accounts that predate it keep their absence rather than a guess.
    pub email: String,
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
        .create_user(&me.org_id, &request.username, &request.email, &request.role)
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
    /// An address, for an account made before one was asked for, or when
    /// somebody's has changed.
    pub email: Option<String>,
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
    if let Some(email) = request.email.as_deref() {
        user = state
            .accounts
            .set_email(&id, email)
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

/// Who takes over a directory they were the last administrator of.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Successor {
    pub directory: String,
    /// A person or a team, as a grant names either.
    pub subject_kind: crate::access::SubjectKind,
    pub subject_id: String,
}

/// Agreeing to what happens when somebody goes.
///
/// **Nothing of theirs can be handed to anybody.** What is filed at
/// `u/<them>/…` is theirs, and an administrator removing the account may
/// destroy it — the account is going either way — but may never pass it on.
/// Handing somebody's private work to a third party is the one outcome its
/// owner never agreed to, and the only way out of a personal root is the owner
/// moving it themselves, before they go.
///
/// A directory is the opposite: it is the organisation's, so being its last
/// administrator is a job to hand on, and that is the one decision here.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Offboarding {
    /// Read back and compared with what is actually theirs, so that agreeing to
    /// a list means agreeing to *that* list. It can change between the screen
    /// drawing it and somebody pressing the button.
    #[serde(default)]
    pub destroy: Vec<super::access::FiledRef>,
    #[serde(default)]
    pub successors: Vec<Successor>,
    /// Switched off, or removed for good.
    pub then: String,
}

/// Destroy what was theirs and take the account away — in one transaction.
#[utoipa::path(
    post, path = "/api/v1/users/{id}/offboard", tag = "organization",
    params(("id" = String, Path, description = "User id")),
    request_body = Offboarding,
    responses(
        (status = 204),
        (status = 400, body = ApiError, description = "The list agreed to is not what is theirs"),
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

    let reach = state.access.reach(id.as_str()).await?;
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

    // Agreeing to a list has to mean agreeing to *that* list. What is theirs can
    // change between the screen drawing it and somebody pressing the button —
    // they are still working until the moment they are switched off.
    if remove {
        let missing: Vec<&str> = reach
            .owns
            .iter()
            .filter(|o| {
                !request
                    .destroy
                    .iter()
                    .any(|d| d.kind == o.kind && d.id == o.id)
            })
            .map(|o| o.name.as_str())
            .collect();
        if !missing.is_empty() {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                format!(
                    "this would also destroy {} — look again before agreeing",
                    missing.join(", ")
                ),
            ));
        }
    }

    // Before the account goes, so a directory is never briefly without one.
    for s in &request.successors {
        state
            .access
            .set_grant(
                &s.directory,
                s.subject_kind,
                &s.subject_id,
                crate::access::Level::Admin,
                &me.id,
            )
            .await?;
    }

    let mut tx = state.db.pool().begin().await?;
    if remove {
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
        destroyed = reach.owns.len(), successors = request.successors.len(),
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

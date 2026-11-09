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
async fn check_account(
    state: &AppState,
    owner: &str,
    new: &crate::roles::NewRole,
) -> ApiResult<()> {
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

/// Every skill a profile names has to be one this person can actually see.
///
/// **A tick grants now, so it needs authorising.** Under the intersection this
/// replaces, `skill_scope` needed no check at all: a spawn took the owner's own
/// defaults and kept only the ids on the list, so an id they could not reach
/// dropped out on its own and the list could only ever subtract. A tick now
/// *introduces* a skill, profiles are shareable (`roles.rs` — a role is Placed),
/// and a skill is executable (`docs/skills.md` §8). Without this, somebody with
/// Writer on a shared profile could name a skill only they can see, and a
/// colleague who started that profile would materialise and run it on their own
/// worker under their own credentials.
///
/// Refused rather than quietly filtered, which is the opposite of what the
/// session's own skill selection does — and right for the opposite reason. That
/// one is a live choice about one conversation; this one is written down and
/// read by everybody who can reach the profile, so a save that silently kept
/// less than the screen showed would be a profile that does not do what the
/// person was told it does. `skills_for` and `set_for_session` filter at spawn
/// as well: this is the half that can explain itself to somebody.
async fn check_skills(state: &AppState, owner: &str, new: &NewRole) -> ApiResult<()> {
    if new.skill_scope.is_empty() {
        return Ok(());
    }
    let reachable: std::collections::HashMap<String, String> = state
        .skills
        .visible(owner, Level::Viewer)
        .await?
        .into_iter()
        .map(|s| (s.id.as_str().to_string(), s.name))
        .collect();
    let out: Vec<&str> = new
        .skill_scope
        .iter()
        .filter(|id| !reachable.contains_key(*id))
        .map(String::as_str)
        .collect();
    if !out.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "{} of the skills named aren't ones you can use, so this profile can't load \
                 them: {}",
                out.len(),
                out.join(", "),
            ),
        ));
    }

    // Two of one name is a profile that cannot do what it says: a skill's
    // folder on a worker is its name, so only one of them can be written and
    // `Skills::set_for_session` sends neither rather than picking. A collision
    // is a warning at import and never a refusal (`docs/skills.md` §1), so the
    // library really does hold two — and a profile is read by everybody who
    // can reach it, which is why this is refused here and filtered there.
    //
    // Only the list. The two switches resolve per viewer against whoever
    // *starts* the run, so a tick that collides with somebody else's always-on
    // set is not knowable from here; the editor's count says so instead.
    let mut together: std::collections::BTreeMap<&str, Vec<&str>> = Default::default();
    for id in &new.skill_scope {
        if let Some(name) = reachable.get(id) {
            together.entry(name.as_str()).or_default().push(id);
        }
    }
    let clashing: Vec<String> = together
        .iter()
        .filter(|(_, ids)| ids.len() > 1)
        .map(|(name, ids)| format!("{name} ({})", ids.join(", ")))
        .collect();
    if !clashing.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "two of the skills named share a name, and a skill's folder on a worker is its \
                 name — so neither could be loaded. Drop one, or rename it in the library: {}",
                clashing.join("; "),
            ),
        ));
    }
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
    check_skills(&state, me.id.as_str(), &new).await?;

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
    check_skills(&state, me.id.as_str(), &new).await?;

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
    if !state
        .roles
        .set_default(me.id.as_str(), &id, body.on)
        .await?
    {
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

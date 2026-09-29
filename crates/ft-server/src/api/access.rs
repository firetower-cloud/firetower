//! Teams, directories, and who may do what in them.
//!
//! **Two kinds of permission meet here, and they are not the same one.**
//!
//! Being an *administrator of the organisation* is about the installation:
//! adding people, defining teams, and reaching a directory whose last
//! administrator has left. Being an *administrator of a directory* is about the
//! things filed in it. An organisation administrator is deliberately not given
//! the second by holding the first — they can grant it to themselves, and that
//! leaves a row with their name on it in a list everybody with access can read.
//! The alternative is somebody who can open every conversation on the
//! installation without anybody being able to tell.
//!
//! **Teams are an administrator's, directories are anybody's.** Who is in a
//! team is a fact about the organisation and wrong when just anyone can edit
//! it. A directory is how somebody shares their own work, and making that an
//! administrator's errand means it does not happen.

use super::{ApiError, ApiResult, ErrorCode};
use crate::access::{Directory, Filed, FiledKind, Grant, Level, SubjectKind, Team};
use crate::accounts::User;
use crate::auth::Principal;
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use ft_core::{ResourcePath, UserId};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Whoever is asking, or a refusal.
///
/// Authentication being off leaves nobody to check grants against, and a
/// request with no person cannot be answered here rather than being answered
/// generously: every reply on this path is about somebody in particular.
pub(super) fn whoever(principal: &Principal) -> ApiResult<&User> {
    principal
        .user
        .as_ref()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "nobody is signed in"))
}

/// Whoever is asking, if they administer the organisation.
pub(super) fn org_admin(principal: &Principal) -> ApiResult<&User> {
    let user = whoever(principal)?;
    if user.role != "admin" {
        return Err(ApiError::new(
            ErrorCode::Forbidden,
            "only an administrator can do that",
        ));
    }
    Ok(user)
}

/// Refuse unless they may do this much in this directory.
///
/// **Not one refusal for both failures**, unlike the reads of a session. There
/// the two are collapsed deliberately: telling somebody a session exists is
/// telling them something they were not meant to learn. Here, a directory
/// somebody holds *any* grant in is one already on their own list — so
/// answering "no such directory" when they ask to rename it says something they
/// know to be false, and the useful answer is that this needs more than they
/// have. No grant at all is still absent rather than forbidden.
async fn at_least(state: &AppState, me: &User, directory: &str, level: Level) -> ApiResult<Level> {
    match state.access.level_on(me.id.as_str(), directory).await? {
        Some(held) if held >= level => Ok(held),
        Some(_) => Err(ApiError::new(
            ErrorCode::Forbidden,
            match level {
                Level::Admin => "only somebody who administers this directory can do that",
                Level::Writer => "you can look in this directory, but not work in it",
                Level::Viewer => "you cannot see this directory",
            },
        )),
        None => Err(ApiError::not_found("directory")),
    }
}

/// Refuse unless they may change the grants here.
///
/// Administering the directory, or administering the organisation — the second
/// only so that a directory nobody administers is fixable by somebody.
async fn may_administer(state: &AppState, me: &User, directory: &str) -> ApiResult<()> {
    if me.role == "admin" {
        // Still has to be a real directory, and still has to be in their own
        // organisation: an administrator of one installation is nobody here.
        let found = state.access.directory(directory).await?;
        if found.is_some() {
            return Ok(());
        }
        return Err(ApiError::not_found("directory"));
    }
    at_least(state, me, directory, Level::Admin)
        .await
        .map(|_| ())
}

// ── the people a grant can name ─────────────────────────────────────────

/// Somebody to hand a grant to.
///
/// Deliberately not `User`, which carries a role and whether they are switched
/// off — an administrator's facts about somebody. This is a name and an id,
/// which is all that granting needs, and it is what makes sharing possible for
/// a member: listing the organisation's users is an administrator's request,
/// and without this a member could only share with people they could already
/// guess the id of.
///
/// Also not `Person`, which this contract already uses for an account on a git
/// host.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Colleague {
    pub id: UserId,
    pub username: String,
}

/// Everybody in the organisation, by name.
#[utoipa::path(
    get, path = "/api/v1/colleagues", tag = "access",
    responses((status = 200, body = Vec<Colleague>), (status = 401, body = ApiError)),
)]
pub(super) async fn list_colleagues(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<Colleague>>> {
    let me = whoever(&principal)?;
    Ok(Json(
        state
            .accounts
            .users_of(&me.org_id)
            .await?
            .into_iter()
            .map(|u| Colleague {
                id: u.id,
                username: u.username,
            })
            .collect(),
    ))
}

// ── teams ───────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewTeam {
    pub name: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TeamName {
    pub name: String,
}

/// Every team in the organisation.
///
/// Readable by anybody, because granting to a team means choosing one from a
/// list. Membership is a separate request.
#[utoipa::path(
    get, path = "/api/v1/teams", tag = "access",
    responses((status = 200, body = Vec<Team>), (status = 401, body = ApiError)),
)]
pub(super) async fn list_teams(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<Team>>> {
    let me = whoever(&principal)?;
    Ok(Json(state.access.teams(me.org_id.as_str()).await?))
}

#[utoipa::path(
    post, path = "/api/v1/teams", tag = "access",
    request_body = NewTeam,
    responses((status = 200, body = Team), (status = 403, body = ApiError)),
)]
pub(super) async fn create_team(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<NewTeam>,
) -> ApiResult<Json<Team>> {
    let me = org_admin(&principal)?;
    let team = state
        .access
        .create_team(&me.org_id, &request.name)
        .await
        .map_err(said)?;
    tracing::info!(by = %me.username, team = %team.name, "team created");
    Ok(Json(team))
}

#[utoipa::path(
    patch, path = "/api/v1/teams/{id}", tag = "access",
    params(("id" = String, Path,)),
    request_body = TeamName,
    responses((status = 204), (status = 403, body = ApiError)),
)]
pub(super) async fn rename_team(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(request): Json<TeamName>,
) -> ApiResult<StatusCode> {
    org_admin(&principal)?;
    state
        .access
        .rename_team(&id, &request.name)
        .await
        .map_err(said)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Remove a team, and with it everything it could reach.
#[utoipa::path(
    delete, path = "/api/v1/teams/{id}", tag = "access",
    params(("id" = String, Path,)),
    responses((status = 204), (status = 403, body = ApiError)),
)]
pub(super) async fn delete_team(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let me = org_admin(&principal)?;
    state.access.delete_team(&id).await.map_err(said)?;
    tracing::info!(by = %me.username, team = %id, "team removed, with its grants");
    Ok(StatusCode::NO_CONTENT)
}

/// Who is in a team.
///
/// Empty for the team that is everybody — it has no membership rows by design,
/// and an interface says "everyone in the organisation" rather than listing
/// them twice.
#[utoipa::path(
    get, path = "/api/v1/teams/{id}/members", tag = "access",
    params(("id" = String, Path,)),
    responses((status = 200, body = Vec<Colleague>), (status = 401, body = ApiError)),
)]
pub(super) async fn list_team_members(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<Colleague>>> {
    let me = whoever(&principal)?;
    let members = state.access.members(&id).await?;
    let everybody = state.accounts.users_of(&me.org_id).await?;
    Ok(Json(
        everybody
            .into_iter()
            .filter(|u| members.iter().any(|m| m.as_str() == u.id.as_str()))
            .map(|u| Colleague {
                id: u.id,
                username: u.username,
            })
            .collect(),
    ))
}

#[utoipa::path(
    put, path = "/api/v1/teams/{id}/members/{person}", tag = "access",
    params(("id" = String, Path,), ("person" = String, Path,)),
    responses((status = 204), (status = 403, body = ApiError)),
)]
pub(super) async fn add_team_member(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, person)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    org_admin(&principal)?;
    state.access.add_member(&id, &person).await.map_err(said)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete, path = "/api/v1/teams/{id}/members/{person}", tag = "access",
    params(("id" = String, Path,), ("person" = String, Path,)),
    responses((status = 204), (status = 403, body = ApiError)),
)]
pub(super) async fn remove_team_member(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, person)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    org_admin(&principal)?;
    state
        .access
        .remove_member(&id, &person)
        .await
        .map_err(said)?;
    Ok(StatusCode::NO_CONTENT)
}

// ── directories ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewDirectory {
    pub name: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryName {
    pub name: String,
}

/// The directories somebody can see.
///
/// An administrator of the organisation gets all of them, including ones they
/// have no grant in — `level` is still their own and still absent there. That
/// is not a way to read what is inside: it is how a directory whose last
/// administrator left can be found by the person who can fix it.
#[utoipa::path(
    get, path = "/api/v1/directories", tag = "access",
    responses((status = 200, body = Vec<Directory>), (status = 401, body = ApiError)),
)]
pub(super) async fn list_directories(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<Directory>>> {
    let me = whoever(&principal)?;
    let directories = if me.role == "admin" {
        state
            .access
            .directories_in(me.org_id.as_str(), me.id.as_str())
            .await?
    } else {
        state.access.directories_for(me.id.as_str()).await?
    };
    Ok(Json(directories))
}

#[utoipa::path(
    post, path = "/api/v1/directories", tag = "access",
    request_body = NewDirectory,
    responses((status = 200, body = Directory), (status = 401, body = ApiError)),
)]
pub(super) async fn create_directory(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<NewDirectory>,
) -> ApiResult<Json<Directory>> {
    let me = whoever(&principal)?;
    let directory = state
        .access
        .create_directory(&me.org_id, &request.name, &me.id)
        .await
        .map_err(said)?;
    tracing::info!(by = %me.username, directory = %directory.name, "directory created");
    Ok(Json(directory))
}

#[utoipa::path(
    patch, path = "/api/v1/directories/{id}", tag = "access",
    params(("id" = String, Path,)),
    request_body = DirectoryName,
    responses((status = 204), (status = 403, body = ApiError)),
)]
pub(super) async fn rename_directory(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(request): Json<DirectoryName>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    may_administer(&state, me, &id).await?;
    state
        .access
        .rename_directory(&id, &request.name)
        .await
        .map_err(said)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete, path = "/api/v1/directories/{id}", tag = "access",
    params(("id" = String, Path,)),
    responses((status = 204), (status = 400, body = ApiError), (status = 403, body = ApiError)),
)]
pub(super) async fn delete_directory(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    may_administer(&state, me, &id).await?;
    state.access.delete_directory(&id).await.map_err(said)?;
    tracing::info!(by = %me.username, directory = %id, "directory removed");
    Ok(StatusCode::NO_CONTENT)
}

// ── grants ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewGrant {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub level: Level,
}

/// Who may do what in a directory.
///
/// Readable by anybody who may look in it, not only by whoever administers it.
/// Somebody working in a shared directory should be able to see who else is in
/// the room, and an agent's conversation is exactly the thing you want to know
/// the audience for before you type into it.
#[utoipa::path(
    get, path = "/api/v1/directories/{id}/grants", tag = "access",
    params(("id" = String, Path,)),
    responses((status = 200, body = Vec<Grant>), (status = 404, body = ApiError)),
)]
pub(super) async fn list_grants(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<Grant>>> {
    let me = whoever(&principal)?;
    if me.role == "admin" {
        may_administer(&state, me, &id).await?;
    } else {
        at_least(&state, me, &id, Level::Viewer).await?;
    }
    Ok(Json(state.access.grants_on(&id).await?))
}

#[utoipa::path(
    put, path = "/api/v1/directories/{id}/grants", tag = "access",
    params(("id" = String, Path,)),
    request_body = NewGrant,
    responses((status = 204), (status = 400, body = ApiError), (status = 403, body = ApiError)),
)]
pub(super) async fn set_grant(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(request): Json<NewGrant>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    may_administer(&state, me, &id).await?;
    state
        .access
        .set_grant(
            &id,
            request.subject_kind,
            &request.subject_id,
            request.level,
            &me.id,
        )
        .await
        .map_err(said)?;
    tracing::info!(
        by = %me.username, directory = %id,
        subject = %request.subject_id, level = %request.level.as_str(),
        "grant set"
    );
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete, path = "/api/v1/directories/{id}/grants/{kind}/{subject}", tag = "access",
    params(("id" = String, Path,), ("kind" = String, Path,), ("subject" = String, Path,)),
    responses((status = 204), (status = 400, body = ApiError), (status = 403, body = ApiError)),
)]
pub(super) async fn revoke_grant(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, kind, subject)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    may_administer(&state, me, &id).await?;
    let kind = SubjectKind::parse(&kind)
        .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, e.to_string()))?;
    state
        .access
        .revoke(&id, kind, &subject)
        .await
        .map_err(said)?;
    tracing::info!(by = %me.username, directory = %id, subject = %subject, "grant revoked");
    Ok(StatusCode::NO_CONTENT)
}

// ── filing things ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub items: Vec<FiledRef>,
}

/// One thing to move, named the way `Filed` names it.
///
/// **Not `Placed`.** That is already a schema in this contract — where an
/// attached file landed in a workspace — and utoipa registers a type by its
/// short name, so a second `Placed` silently becomes whichever of the two the
/// generator reached last. The clients then typecheck against a shape the
/// server never sends.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FiledRef {
    pub kind: FiledKind,
    pub id: String,
}

/// What is filed here.
///
/// Needs a look in the directory, the same as reading its grants: this is the
/// list a grant applies to, and somebody deciding whether to share a directory
/// has to be able to see what they would be sharing.
#[utoipa::path(
    get, path = "/api/v1/directories/{id}/items", tag = "access",
    params(("id" = String, Path,)),
    responses((status = 200, body = Vec<Filed>), (status = 404, body = ApiError)),
)]
pub(super) async fn list_items(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<Filed>>> {
    let me = whoever(&principal)?;
    if me.role == "admin" {
        may_administer(&state, me, &id).await?;
    } else {
        at_least(&state, me, &id, Level::Viewer).await?;
    }
    // By slug, not by id. What is filed here is every path under `d.<slug>`, and
    // the slug is the only part of a directory that appears in one.
    let directory = state
        .access
        .directory(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("directory"))?;
    Ok(Json(state.access.filed_in(&directory.slug).await?))
}

/// Whether this person may decide who else reaches something.
///
/// It is theirs — in their own space — or they administer the directory it is
/// filed in, or they administer the organisation. One rule for all four kinds,
/// machines included: a machine is filed at `u/<whoever added it>/…` now, so
/// whoever added it shares it the same way they share a workspace.
///
/// What protects a machine everybody is running on is the same thing that
/// protects everything else in a directory — taking it out needs *admin* there,
/// and the shared directory grants writer. So a member can put their own server
/// in and cannot pull the fleet's out from under everybody.
async fn may_share(
    state: &AppState,
    me: &User,
    kind: FiledKind,
    id: &str,
) -> ApiResult<ResourcePath> {
    let at = state
        .access
        .path_of(kind, id)
        .await?
        .ok_or_else(|| ApiError::not_found(kind.singular()))?;

    if me.role == "admin" {
        return Ok(at);
    }

    match at.root() {
        // Their own space needs no grant — that is what a personal root is.
        Some((ft_core::path::PERSONAL, slug))
            if slug == state.access.personal_root(me.id.as_str()).await? =>
        {
            Ok(at)
        }
        Some((ft_core::path::DIRECTORY, slug)) => {
            let directory = state
                .access
                .directory_by_slug(me.org_id.as_str(), slug)
                .await?
                .ok_or_else(|| ApiError::not_found("directory"))?;
            at_least(state, me, directory.id.as_str(), Level::Admin).await?;
            Ok(at)
        }
        // Somebody else's own space, or a path with no root behind it. Absent
        // rather than refused, like every other read: "you may not move this
        // machine" tells them a machine of that id exists, which is the thing
        // they were not meant to learn. `at_least` above is what answers 403,
        // and only for a directory they can already see.
        _ => Err(ApiError::not_found(kind.singular())),
    }
}

/// File these things in this directory.
///
/// **The only thing that changes who can reach something.** Nothing about the
/// thing itself moves: a workspace keeps its worktree, its branch and the
/// agents running in it. What changes is the audience — and, deliberately, who
/// owns it: filing something in a directory hands it to that directory, and
/// whoever put it there keeps access as somebody the directory grants.
///
/// Both ends are checked: [`may_share`] for the thing, and at least working
/// access on the directory it is going to — filing your own work somewhere you
/// may only look would put it out of your own reach.
///
/// A refusal stops the run. The ones already filed stay filed, and the sentence
/// says which one failed, rather than one verdict over a list half applied.
#[utoipa::path(
    put, path = "/api/v1/directories/{id}/items", tag = "access",
    params(("id" = String, Path,)),
    request_body = Placement,
    responses((status = 204), (status = 403, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn file_items(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(request): Json<Placement>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    let target = state
        .access
        .directory(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("directory"))?;
    at_least(&state, me, &id, Level::Writer).await?;

    for item in &request.items {
        let from = may_share(&state, me, item.kind, &item.id).await?;
        let to = from.moved_to(ft_core::path::DIRECTORY, &target.slug);
        state
            .access
            .transfer(&state.vault, item.kind, &item.id, &to, &me.username)
            .await
            .map_err(said)?;
        tracing::info!(by = %me.username, kind = %item.kind.singular(), from = %from, to = %to, "filed");
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Take these back into your own space.
///
/// The counterpart of filing: a thing is always somewhere, so "unshare" is not
/// removal, it is moving it home. Whoever does it ends up owning it, which is
/// the same rule read backwards.
#[utoipa::path(
    delete, path = "/api/v1/directories/{id}/items", tag = "access",
    params(("id" = String, Path,)),
    request_body = Placement,
    responses((status = 204), (status = 403, body = ApiError)),
)]
pub(super) async fn unfile_items(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(request): Json<Placement>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    let mine = state.access.personal_root(me.id.as_str()).await?;
    let out_of = state
        .access
        .directory(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("directory"))?;

    for item in &request.items {
        let from = may_share(&state, me, item.kind, &item.id).await?;
        // The directory in the path has to be the one in the request. Otherwise
        // a screen showing a stale list would quietly take something out of
        // wherever it had since been moved to, which nobody asked for.
        if from.directory_slug() != Some(out_of.slug.as_str()) {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                format!(
                    "that {} is not filed in {} any more",
                    item.kind.singular(),
                    out_of.name
                ),
            ));
        }
        let to = from.moved_to(ft_core::path::PERSONAL, &mine);
        state
            .access
            .transfer(&state.vault, item.kind, &item.id, &to, &me.username)
            .await
            .map_err(said)?;
        tracing::info!(by = %me.username, from = %from, to = %to, "taken back");
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Turn a sentence the access layer wrote into one the interface can show.
///
/// Every refusal in `crate::access` is already a sentence meant for a person —
/// "somebody has to be able to administer this directory" — so the work here is
/// only to choose a status. `InvalidRequest` rather than `Internal`, because
/// all of them are answers to something that was asked wrongly.
fn said(e: anyhow::Error) -> ApiError {
    ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}"))
}

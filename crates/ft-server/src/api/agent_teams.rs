//! Agent teams: the endpoints behind the Agent teams screen.
//!
//! Every read pastes `filed_where` through `crate::agent_teams`, so a team
//! somebody has no grant on is **absent rather than refused** — the same rule
//! as every other Placed kind. Filing one into a directory is not here: a team
//! is `FiledKind::AgentTeam`, so the sharing endpoints that already exist do
//! it.
//!
//! The write is a whole tree, and **Save is the only commit**: the map #492
//! draws edits a draft and sends it here once. That is why there is no
//! add-a-position endpoint and no reorder endpoint — a tree is one object, and
//! two half-applied writes is the thing a draft exists to prevent.

use super::access::whoever;
use super::{ApiError, ApiResult, ErrorCode};
use crate::access::Level;
use crate::agent_teams::{AgentTeam, Limits, NewAgentTeam, TeamWithPositions};
use crate::auth::Principal;
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};

/// A refusal somebody can act on, rather than a 500 with a backtrace in it.
fn refused(e: crate::agent_teams::Refused) -> ApiError {
    ApiError::new(ErrorCode::InvalidRequest, e.to_string())
}

/// The same, for a refusal raised from inside a write.
///
/// `crate::agent_teams` reports a profile nobody can see, an id that is not
/// this team's and a tree over the limits as a [`crate::agent_teams::Refused`],
/// which arrives here as an `anyhow::Error` like any other. Anything else is
/// still the 500 it was.
fn wrote(e: anyhow::Error) -> ApiError {
    match e.downcast::<crate::agent_teams::Refused>() {
        Ok(no) => refused(no),
        Err(e) => e.into(),
    }
}

#[utoipa::path(
    get, path = "/api/v1/agent-teams", tag = "agentTeams",
    responses((status = 200, body = Vec<AgentTeam>), (status = 401, body = ApiError)),
)]
pub(super) async fn list_agent_teams(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<AgentTeam>>> {
    let me = whoever(&principal)?;
    Ok(Json(
        state
            .agent_teams
            .visible(me.id.as_str(), Level::Viewer)
            .await?,
    ))
}

/// How deep a team may go and how many positions it may hold.
///
/// A fact about this build rather than about anybody's data, so it needs no
/// authorisation beyond being signed in — the same shape
/// `/api/v1/roles/import/limits` has. It exists so the editor can refuse a
/// twelfth level where the person drew it, instead of after a round trip.
#[utoipa::path(
    get, path = "/api/v1/agent-teams/limits", tag = "agentTeams",
    responses((status = 200, body = Limits), (status = 401, body = ApiError)),
)]
pub(super) async fn agent_team_limits(
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Limits>> {
    whoever(&principal)?;
    Ok(Json(Limits::default()))
}

#[utoipa::path(
    get, path = "/api/v1/agent-teams/{id}", tag = "agentTeams",
    params(("id" = String, Path, description = "Agent team id")),
    responses((status = 200, body = TeamWithPositions), (status = 404, body = ApiError)),
)]
pub(super) async fn get_agent_team(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<TeamWithPositions>> {
    let me = whoever(&principal)?;
    state
        .agent_teams
        .detail(me.id.as_str(), &id, Level::Viewer)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("agent team"))
}

#[utoipa::path(
    post, path = "/api/v1/agent-teams", tag = "agentTeams",
    request_body = NewAgentTeam,
    responses((status = 201, body = TeamWithPositions), (status = 400, body = ApiError)),
)]
pub(super) async fn create_agent_team(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(new): Json<NewAgentTeam>,
) -> ApiResult<(StatusCode, Json<TeamWithPositions>)> {
    let me = whoever(&principal)?;
    crate::agent_teams::check(&new).map_err(refused)?;

    // A directory it is filed in from the first insert, rather than a create
    // and then a move: a team should never exist for a moment in the wrong
    // place. Only where this person may write; a directory they cannot reach
    // is "not found" rather than a different error.
    let filed = match new.directory.as_deref().filter(|d| !d.is_empty()) {
        Some(directory) => {
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
            Some(target.slug)
        }
        None => None,
    };

    let slug = state.access.personal_root(me.id.as_str()).await?;
    let id = state
        .agent_teams
        .create(
            me.org_id.as_str(),
            me.id.as_str(),
            &slug,
            filed.as_deref(),
            &new,
        )
        .await
        .map_err(wrote)?;

    let made = state
        .agent_teams
        .detail(me.id.as_str(), id.as_str(), Level::Viewer)
        .await?
        .ok_or_else(|| ApiError::not_found("agent team"))?;
    Ok((StatusCode::CREATED, Json(made)))
}

#[utoipa::path(
    put, path = "/api/v1/agent-teams/{id}", tag = "agentTeams",
    params(("id" = String, Path, description = "Agent team id")),
    request_body = NewAgentTeam,
    responses(
        (status = 200, body = TeamWithPositions),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
    ),
)]
pub(super) async fn update_agent_team(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(new): Json<NewAgentTeam>,
) -> ApiResult<Json<TeamWithPositions>> {
    let me = whoever(&principal)?;
    crate::agent_teams::check(&new).map_err(refused)?;
    if !state
        .agent_teams
        .write(me.id.as_str(), &id, &new)
        .await
        .map_err(wrote)?
    {
        return Err(ApiError::not_found("agent team"));
    }
    state
        .agent_teams
        .detail(me.id.as_str(), &id, Level::Viewer)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("agent team"))
}

#[utoipa::path(
    delete, path = "/api/v1/agent-teams/{id}", tag = "agentTeams",
    params(("id" = String, Path, description = "Agent team id")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn delete_agent_team(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    if !state.agent_teams.delete(me.id.as_str(), &id).await? {
        return Err(ApiError::not_found("agent team"));
    }
    Ok(StatusCode::NO_CONTENT)
}

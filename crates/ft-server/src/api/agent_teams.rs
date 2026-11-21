//! Agent teams: the lead and the tree of positions under it.
//!
//! Every read pastes `filed_where` through `crate::agent_teams`, so a team
//! somebody has no grant on is absent rather than refused — the same rule as
//! every other kind. Filing one into a directory is not here: a team is
//! `FiledKind::AgentTeam`, so the sharing endpoints that already exist do it.
//!
//! Four endpoints and no fifth. The map drafts and Save commits, so there is
//! one write for a whole tree rather than one per card — see
//! [`crate::agent_teams::AgentTeams::replace`].

use super::access::whoever;
use super::{ApiError, ApiResult, ErrorCode};
use crate::access::Level;
use crate::agent_teams::{AgentTeam, NewAgentTeam, Refused, Tree};
use crate::auth::Principal;
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};

/// A refusal somebody can act on, rather than a 500 with a backtrace in it.
fn wrote(e: anyhow::Error) -> ApiError {
    match e.downcast::<Refused>() {
        Ok(no) => ApiError::new(ErrorCode::InvalidRequest, no.to_string()),
        Err(e) => e.into(),
    }
}

/// A team has a name, and every profile it names has to be one this person can
/// actually use.
///
/// **Refused rather than quietly filtered.** A team is read by everybody who
/// can reach it and it decides what a running agent may do, so a save that
/// silently kept less than the screen showed would be a team that does not do
/// what the person was told it does. `positions_in` redacts on the way out,
/// which is the half that can be honest about a team somebody else built; this
/// is the half that can explain itself to the person writing one.
async fn check(state: &AppState, owner: &str, new: &NewAgentTeam) -> ApiResult<()> {
    if new.name.trim().is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a team needs a name — it is what the composer offers and what a schedule pins",
        ));
    }
    let tree = Tree::read(new).map_err(wrote)?;
    let reachable: std::collections::HashSet<String> = state
        .roles
        .visible(owner, Level::Viewer)
        .await?
        .into_iter()
        .map(|r| r.id)
        .collect();
    // Named back as the ids the caller sent. A name would be the name of
    // something they are not supposed to know exists.
    let out: Vec<String> = tree
        .profiles()
        .into_iter()
        .filter(|id| !reachable.contains(id))
        .collect();
    if !out.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "{} of the profiles named aren't ones you can use, so they can't hold a position \
                 in this team: {}",
                out.len(),
                out.join(", "),
            ),
        ));
    }
    Ok(())
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

#[utoipa::path(
    post, path = "/api/v1/agent-teams", tag = "agentTeams",
    request_body = NewAgentTeam,
    responses((status = 201, body = AgentTeam), (status = 400, body = ApiError)),
)]
pub(super) async fn create_agent_team(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(new): Json<NewAgentTeam>,
) -> ApiResult<(StatusCode, Json<AgentTeam>)> {
    let me = whoever(&principal)?;
    check(&state, me.id.as_str(), &new).await?;

    // The directory is resolved to a slug before the write rather than moved
    // afterwards, because a team is created with its whole tree in one
    // transaction and a move would be a second write to roll back.
    let directory = match new.directory.as_deref().filter(|d| !d.is_empty()) {
        Some(id) => {
            let target = state
                .access
                .directory(id)
                .await?
                .ok_or_else(|| ApiError::not_found("directory"))?;
            let may = matches!(
                state.access.level_on(me.id.as_str(), id).await?,
                Some(level) if level >= Level::Writer
            );
            if !may {
                return Err(ApiError::not_found("directory"));
            }
            Some(target.slug)
        }
        None => None,
    };

    let id = state
        .agent_teams
        .create(
            me.org_id.as_str(),
            me.id.as_str(),
            &me.slug,
            directory.as_deref(),
            &new,
        )
        .await
        .map_err(wrote)?;
    let made = state
        .agent_teams
        .one(me.id.as_str(), id.as_str(), Level::Viewer)
        .await?
        .ok_or_else(|| ApiError::not_found("agent team"))?;
    Ok((StatusCode::CREATED, Json(made)))
}

#[utoipa::path(
    get, path = "/api/v1/agent-teams/{id}", tag = "agentTeams",
    params(("id" = String, Path, description = "Agent team id")),
    responses((status = 200, body = AgentTeam), (status = 404, body = ApiError)),
)]
pub(super) async fn one_agent_team(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<AgentTeam>> {
    let me = whoever(&principal)?;
    state
        .agent_teams
        .one(me.id.as_str(), &id, Level::Viewer)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("agent team"))
}

#[utoipa::path(
    put, path = "/api/v1/agent-teams/{id}", tag = "agentTeams",
    params(("id" = String, Path, description = "Agent team id")),
    request_body = NewAgentTeam,
    responses((status = 200, body = AgentTeam), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn update_agent_team(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(new): Json<NewAgentTeam>,
) -> ApiResult<Json<AgentTeam>> {
    let me = whoever(&principal)?;
    check(&state, me.id.as_str(), &new).await?;
    // Absent rather than refused when they may not change it, for the reason
    // every other read gives: a team you cannot reach is one you are not told
    // exists.
    if !state
        .agent_teams
        .replace(me.id.as_str(), &id, &new)
        .await
        .map_err(wrote)?
    {
        return Err(ApiError::not_found("agent team"));
    }
    let now = state
        .agent_teams
        .one(me.id.as_str(), &id, Level::Viewer)
        .await?
        .ok_or_else(|| ApiError::not_found("agent team"))?;
    Ok(Json(now))
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

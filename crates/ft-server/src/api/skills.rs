//! The skill library, and what each session is reading from it.
//!
//! Every read here pastes `filed_where` through `crate::skills`, so a skill
//! somebody has no grant on is absent rather than refused — the same rule as
//! every other kind. Filing one into a directory is not here at all: a skill is
//! `FiledKind::Skill`, so the sharing endpoints that already exist do it.

use super::access::whoever;
use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::skills::{NewSkill, Skill, SkillDetail, SkillVersion};
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use ft_core::SessionId;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::access::Level;

/// A refusal somebody can act on, rather than a 500 with a backtrace in it.
fn refused(e: crate::skills::Refused) -> ApiError {
    ApiError::new(ErrorCode::InvalidRequest, e.to_string())
}

#[utoipa::path(
    get, path = "/api/v1/skills", tag = "skills",
    responses((status = 200, body = Vec<Skill>), (status = 401, body = ApiError)),
)]
pub(super) async fn list_skills(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<Skill>>> {
    let me = whoever(&principal)?;
    Ok(Json(
        state.skills.visible(me.id.as_str(), Level::Viewer).await?,
    ))
}

#[utoipa::path(
    post, path = "/api/v1/skills", tag = "skills",
    request_body = NewSkill,
    responses((status = 201, body = Skill), (status = 400, body = ApiError)),
)]
pub(super) async fn create_skill(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(new): Json<NewSkill>,
) -> ApiResult<(StatusCode, Json<Skill>)> {
    let me = whoever(&principal)?;
    crate::skills::check(&new).map_err(refused)?;

    let id = state
        .skills
        .create(me.org_id.as_str(), me.id.as_str(), &me.slug, &new)
        .await?;

    let made = state
        .skills
        .one(me.id.as_str(), id.as_str(), Level::Viewer)
        .await?
        .ok_or_else(|| ApiError::not_found("skill"))?;
    Ok((StatusCode::CREATED, Json(made)))
}

/// What is being changed about a skill without making a version of it.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillNaming {
    pub name: String,
    pub description: String,
}

#[utoipa::path(
    patch, path = "/api/v1/skills/{id}", tag = "skills",
    params(("id" = String, Path, description = "The skill")),
    request_body = SkillNaming,
    responses((status = 200, body = Skill), (status = 404, body = ApiError)),
)]
pub(super) async fn rename_skill(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(body): Json<SkillNaming>,
) -> ApiResult<Json<Skill>> {
    let me = whoever(&principal)?;
    // Writer, because this changes something. Reading it at Viewer and then
    // writing is the mistake `paths-and-ownership.md` names first.
    state
        .skills
        .one(me.id.as_str(), &id, Level::Writer)
        .await?
        .ok_or_else(|| ApiError::not_found("skill"))?;

    crate::skills::check_name(&body.name).map_err(refused)?;
    if body.description.trim().is_empty()
        || body.description.chars().count() > crate::skills::BIGGEST_DESCRIPTION
    {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a description says what the skill does and when to use it, in under 1024 characters",
        ));
    }

    state
        .skills
        .rename(&id, &body.name, &body.description)
        .await?;
    state
        .skills
        .one(me.id.as_str(), &id, Level::Viewer)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("skill"))
}

#[utoipa::path(
    delete, path = "/api/v1/skills/{id}", tag = "skills",
    params(("id" = String, Path, description = "The skill")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn delete_skill(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    state
        .skills
        .one(me.id.as_str(), &id, Level::Writer)
        .await?
        .ok_or_else(|| ApiError::not_found("skill"))?;

    // Deciding that a thing stops existing is the same right as deciding where
    // it is filed, so it asks the question the sharing screen asks rather than
    // a second one that could disagree with it.
    super::access::may_share(&state, me, crate::access::FiledKind::Skill, &id).await?;

    state.skills.delete(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get, path = "/api/v1/skills/{id}/detail", tag = "skills",
    params(("id" = String, Path, description = "The skill")),
    responses((status = 200, body = SkillDetail), (status = 404, body = ApiError)),
)]
pub(super) async fn skill_detail(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<SkillDetail>> {
    let me = whoever(&principal)?;
    state
        .skills
        .detail(me.id.as_str(), &id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("skill"))
}

#[utoipa::path(
    get, path = "/api/v1/skills/{id}/versions", tag = "skills",
    params(("id" = String, Path, description = "The skill")),
    responses((status = 200, body = Vec<SkillVersion>), (status = 404, body = ApiError)),
)]
pub(super) async fn list_versions(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<SkillVersion>>> {
    let me = whoever(&principal)?;
    Ok(Json(state.skills.versions(me.id.as_str(), &id).await?))
}

#[utoipa::path(
    post, path = "/api/v1/skills/{id}/versions", tag = "skills",
    params(("id" = String, Path, description = "The skill")),
    request_body = NewSkill,
    responses((status = 201, body = Skill), (status = 400, body = ApiError)),
)]
pub(super) async fn add_version(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(new): Json<NewSkill>,
) -> ApiResult<(StatusCode, Json<Skill>)> {
    let me = whoever(&principal)?;
    state
        .skills
        .one(me.id.as_str(), &id, Level::Writer)
        .await?
        .ok_or_else(|| ApiError::not_found("skill"))?;
    crate::skills::check(&new).map_err(refused)?;

    state.skills.add_version(&id, me.id.as_str(), &new).await?;
    let made = state
        .skills
        .one(me.id.as_str(), &id, Level::Viewer)
        .await?
        .ok_or_else(|| ApiError::not_found("skill"))?;
    Ok((StatusCode::CREATED, Json(made)))
}

/// Turning a default on or off, for one repository or for everywhere.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DefaultIn {
    /// Absent means every workspace this person starts.
    #[serde(default)]
    pub repo_id: Option<String>,
    pub on: bool,
}

#[utoipa::path(
    put, path = "/api/v1/skills/{id}/default", tag = "skills",
    params(("id" = String, Path, description = "The skill")),
    request_body = DefaultIn,
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn set_default(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(body): Json<DefaultIn>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    // A default is this person's own, so seeing the skill is enough to want it
    // — but the skill still has to be one they can see.
    state
        .skills
        .one(me.id.as_str(), &id, Level::Viewer)
        .await?
        .ok_or_else(|| ApiError::not_found("skill"))?;

    state
        .skills
        .set_default(me.id.as_str(), &id, body.repo_id.as_deref(), body.on)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// What a session is reading, and what it would read if nothing was chosen.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionSkills {
    /// The skills this session has pinned.
    pub selected: Vec<String>,
}

/// The whole selection, never a delta.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChooseSkills {
    pub selected: Vec<String>,
}

#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/skills", tag = "skills",
    params(("id" = String, Path, description = "The session")),
    responses((status = 200, body = SessionSkills), (status = 404, body = ApiError)),
)]
pub(super) async fn session_skills(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<SessionId>,
) -> ApiResult<Json<SessionSkills>> {
    let me = whoever(&principal)?;
    state
        .db
        .session_of(me.id.as_str(), &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;
    Ok(Json(SessionSkills {
        selected: state.skills.of_session(id.as_str()).await?,
    }))
}

#[utoipa::path(
    put, path = "/api/v1/sessions/{id}/skills", tag = "skills",
    params(("id" = String, Path, description = "The session")),
    request_body = ChooseSkills,
    responses((status = 200, body = SessionSkills), (status = 404, body = ApiError)),
)]
pub(super) async fn choose_skills(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<SessionId>,
    Json(body): Json<ChooseSkills>,
) -> ApiResult<Json<SessionSkills>> {
    let me = whoever(&principal)?;
    // Choosing what an agent reads is working in the place, so it takes the
    // Writer method rather than the one that only answers "may I watch this".
    state
        .db
        .session_to_work_in(me.id.as_str(), &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;

    // Only skills this person can actually see. A selection naming one they
    // cannot reach would otherwise pin it, and the next read would show them a
    // skill they were never granted.
    let reachable: std::collections::HashSet<String> = state
        .skills
        .visible(me.id.as_str(), Level::Viewer)
        .await?
        .into_iter()
        .map(|s| s.id.as_str().to_string())
        .collect();
    let chosen: Vec<String> = body
        .selected
        .into_iter()
        .filter(|s| reachable.contains(s))
        .collect();

    state
        .skills
        .set_for_session(id.as_str(), me.id.as_str(), &chosen)
        .await?;

    // Out to the machine it is running on, as the whole selection. The worker
    // writes what is new and removes what is gone; every agent here watches
    // its own skills directory, so nothing restarts.
    //
    // Best effort, and deliberately after the pins are written: a worker that
    // is unreachable right now picks the set up when the agent is next
    // started, because that reads the pins. Refusing the change because a
    // machine is asleep would lose a decision somebody already made.
    if let Some(session) = state.db.session_of(me.id.as_str(), &id).await? {
        let bundles = state
            .skills
            .bundles_for_session(id.as_str())
            .await
            .unwrap_or_default();
        if let Err(e) = state
            .fleet
            .send(
                &session.host_id,
                ft_proto::ToWorker::SetSkills {
                    session_id: id.clone(),
                    skills: bundles,
                },
            )
            .await
        {
            tracing::warn!(session = %id, "telling the worker its skills changed: {e:#}");
        }

        // Kimi, and only Kimi, has to be told in words.
        //
        // The other two notice on their own: Claude Code re-injects the list
        // of skills before each message, and Codex watches the directory and
        // re-lists. Kimi reacts to the directory changing by refreshing the
        // `/skill:` menu it sends *us* — verified in a live session, where it
        // sent a fresh command list each time while the model went on
        // answering from the set it had when the conversation opened.
        //
        // So this is a turn, which means the agent will answer it. That cost
        // is the point: an agent that says what it can now see is an agent
        // that has looked.
        if session.agent == ft_core::Agent::KimiCode {
            let note = format!(
                "The skills available to you have just changed — there are now {} of them. \
                 Re-read what you have rather than relying on the list from earlier in this \
                 conversation, and say which skills you can see now.",
                chosen.len()
            );
            if let Err(e) = state
                .fleet
                .send_turn(&session.host_id, &id, &note, &[])
                .await
            {
                // Not a failure of the change — the skills are on disk and
                // pinned either way. The likeliest cause is a turn already in
                // flight, which cannot take a second prompt.
                tracing::warn!(session = %id, "could not tell Kimi its skills changed: {e:#}");
            }
        }
    }

    Ok(Json(SessionSkills { selected: chosen }))
}

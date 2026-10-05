//! The skill library, and what each session is reading from it.
//!
//! Every read here pastes `filed_where` through `crate::skills`, so a skill
//! somebody has no grant on is absent rather than refused — the same rule as
//! every other kind. Filing one into a directory is not here at all: a skill is
//! `FiledKind::Skill`, so the sharing endpoints that already exist do it.

use super::access::whoever;
use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::skills::{Asking, Collision, Match, NewSkill, Resolve, Skill, SkillDetail, SkillVersion};
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

    // Asked again here, a moment after the review screen asked. That screen's
    // answer can be a second old — somebody else may have added a version in
    // between — and two library rows of one name is the thing this exists to
    // prevent.
    let digest = crate::skills::Skills::digest_of_new(&new)?;
    if let Some(found) = state
        .skills
        .matching(
            me.id.as_str(),
            &[Asking {
                name: new.name.clone(),
                files: Vec::new(),
            }],
        )
        .await?
        .into_iter()
        .next()
        .and_then(|m| m.found)
    {
        if found.mine {
            let same = state.skills.current_digest(found.id.as_str()).await?;
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                if same.as_deref() == Some(digest.as_str()) {
                    format!(
                        "you already have {} at v{}, and this is the same bundle",
                        new.name, found.version
                    )
                } else {
                    format!(
                        "you already have a skill called {} — add a version to it, \
                         or give this one a name of its own",
                        new.name
                    )
                },
            ));
        }
    }

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

/// What this person already has, for a set of bundles about to be imported.
///
/// Its own request rather than a flag on the import, because the answer is
/// what somebody reads *before* deciding — a row that says "you already have
/// this, unchanged" has to be drawn while there is still a choice.
#[utoipa::path(
    post, path = "/api/v1/skills/match", tag = "skills",
    request_body = Vec<Asking>,
    responses((status = 200, body = Vec<Match>), (status = 401, body = ApiError)),
)]
pub(super) async fn match_skills(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(asking): Json<Vec<Asking>>,
) -> ApiResult<Json<Vec<Match>>> {
    let me = whoever(&principal)?;
    Ok(Json(state.skills.matching(me.id.as_str(), &asking).await?))
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

    // Nothing to add. An unchanged re-drop should leave the history alone
    // rather than writing a version that differs from the one before it in
    // nothing but its date.
    let digest = crate::skills::Skills::digest_of_new(&new)?;
    if state.skills.current_digest(&id).await? == Some(digest) {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this is the bundle it already has, so there is no version to add",
        ));
    }

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
    /// Each repository in the session, with this person's defaults there.
    /// What the picker's "use these by default" switch reads and compares.
    #[serde(default)]
    pub repos: Vec<RepoDefaults>,
    /// The skills this person has on in every workspace.
    #[serde(default)]
    pub always_on: Vec<String>,
}

/// One repository and the skills somebody has on by default in it.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RepoDefaults {
    pub repo_id: String,
    pub slug: String,
    pub defaults: Vec<String>,
}

/// The whole set of defaults for one repository.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RepoSkillDefaults {
    pub skills: Vec<String>,
}

/// Make this person's defaults in one repository exactly these skills.
///
/// Set from the session picker, at the moment somebody has just decided what
/// a repository needs. Defaults belong to the person, so the only check is
/// that each skill is one they can see.
#[utoipa::path(
    put, path = "/api/v1/repos/{id}/skill-defaults", tag = "skills",
    params(("id" = String, Path, description = "The repository")),
    request_body = RepoSkillDefaults,
    responses((status = 204), (status = 401, body = ApiError)),
)]
pub(super) async fn set_repo_defaults(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(body): Json<RepoSkillDefaults>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    let reachable: std::collections::HashSet<String> = state
        .skills
        .visible(me.id.as_str(), Level::Viewer)
        .await?
        .into_iter()
        .map(|s| s.id.as_str().to_string())
        .collect();
    let skills: Vec<String> = body.skills.into_iter().filter(|s| reachable.contains(s)).collect();
    state
        .skills
        .replace_defaults_in(me.id.as_str(), &id, &skills)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The session's repositories with this person's defaults in each.
async fn repo_defaults(
    state: &AppState,
    me: &str,
    session: &ft_core::Session,
) -> anyhow::Result<Vec<RepoDefaults>> {
    let mut out = Vec::new();
    for c in &session.checkouts {
        let Some(repo) = &c.repo_id else { continue };
        if out.iter().any(|r: &RepoDefaults| r.repo_id == repo.as_str()) {
            continue;
        }
        out.push(RepoDefaults {
            repo_id: repo.to_string(),
            slug: c.slug.clone(),
            defaults: state.skills.defaults_in(me, repo.as_str()).await?,
        });
    }
    Ok(out)
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
    let session = state
        .db
        .session_of(me.id.as_str(), &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;
    Ok(Json(SessionSkills {
        selected: state.skills.of_session(id.as_str()).await?,
        repos: repo_defaults(&state, me.id.as_str(), &session).await?,
        always_on: state.skills.always_on(me.id.as_str()).await?,
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

    let repos = match state.db.session_of(me.id.as_str(), &id).await? {
        Some(session) => repo_defaults(&state, me.id.as_str(), &session).await?,
        None => Vec::new(),
    };
    Ok(Json(SessionSkills {
        selected: chosen,
        repos,
        always_on: state.skills.always_on(me.id.as_str()).await?,
    }))
}

/// Skills to look at before moving them into a directory.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillIds {
    pub skills: Vec<String>,
}

/// Which of these skills the directory already has one of the same name for.
///
/// Asked by the share window before anything moves, so each collision can be
/// shown with a choice rather than discovered as a refusal.
#[utoipa::path(
    post, path = "/api/v1/directories/{id}/skills/collisions", tag = "skills",
    params(("id" = String, Path, description = "The directory")),
    request_body = SkillIds,
    responses((status = 200, body = Vec<Collision>), (status = 403, body = ApiError)),
)]
pub(super) async fn skill_collisions(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(body): Json<SkillIds>,
) -> ApiResult<Json<Vec<Collision>>> {
    let me = whoever(&principal)?;
    let directory = state
        .access
        .directory(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("directory"))?;
    super::access::at_least(&state, me, &id, Level::Writer).await?;
    Ok(Json(state.skills.collisions(&directory.slug, &body.skills).await?))
}

/// One skill to move, and what to do if the directory has one of its name.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShareOne {
    pub id: String,
    #[serde(default)]
    pub resolve: Option<Resolve>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShareSkills {
    pub skills: Vec<ShareOne>,
}

/// Move several skills into a directory.
///
/// Everything is checked before anything moves: that each skill is this
/// person's to move, that no two of them share a name, and that every name
/// the directory already has comes with a decision. A skill merged into the
/// directory's copy hands its sessions over, and their workers are told.
#[utoipa::path(
    post, path = "/api/v1/directories/{id}/skills", tag = "skills",
    params(("id" = String, Path, description = "The directory")),
    request_body = ShareSkills,
    responses((status = 204), (status = 400, body = ApiError), (status = 403, body = ApiError)),
)]
pub(super) async fn share_skills(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(body): Json<ShareSkills>,
) -> ApiResult<StatusCode> {
    use crate::access::FiledKind;
    let me = whoever(&principal)?;
    let directory = state
        .access
        .directory(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("directory"))?;
    super::access::at_least(&state, me, &id, Level::Writer).await?;

    let mut checked = Vec::with_capacity(body.skills.len());
    let mut names = std::collections::HashSet::new();
    for one in &body.skills {
        let from = super::access::may_share(&state, me, FiledKind::Skill, &one.id).await?;
        let skill = state
            .skills
            .one(me.id.as_str(), &one.id, Level::Viewer)
            .await?
            .ok_or_else(|| ApiError::not_found("skill"))?;
        // Two going in under one name would collide with each other.
        if one.resolve != Some(Resolve::Keep) && !names.insert(skill.name.clone()) {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                format!("two of these are called {}; a directory holds one", skill.name),
            ));
        }
        checked.push((one, from, skill));
    }

    let ids: Vec<String> = body.skills.iter().map(|s| s.id.clone()).collect();
    let collisions = state.skills.collisions(&directory.slug, &ids).await?;
    for c in &collisions {
        let asked = body.skills.iter().find(|s| s.id == c.skill_id.as_str());
        if asked.and_then(|s| s.resolve).is_none() {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                format!("{} already has a skill called {}", directory.name, c.name),
            ));
        }
    }

    let mut touched: Vec<String> = Vec::new();
    for (one, from, _) in checked {
        match collisions.iter().find(|c| c.skill_id.as_str() == one.id) {
            None => {
                let to = from.moved_to(ft_core::path::DIRECTORY, &directory.slug);
                state
                    .access
                    .transfer(&state.vault, FiledKind::Skill, &one.id, &to, &me.username)
                    .await
                    .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;
            }
            Some(c) => match one.resolve {
                Some(Resolve::Keep) | None => {}
                Some(r) => touched.extend(
                    state
                        .skills
                        .merge_into(
                            &one.id,
                            c.existing_id.as_str(),
                            me.id.as_str(),
                            r == Resolve::AddVersion,
                        )
                        .await?,
                ),
            },
        }
    }

    // Sessions that held a merged copy now hold the directory's. Their
    // workers get the whole selection again; best effort, like a choice made
    // in the picker, because the pins are what the next start reads.
    touched.sort();
    touched.dedup();
    for (session, host) in state.skills.hosts_of(&touched).await.unwrap_or_default() {
        let bundles = state.skills.bundles_for_session(&session).await.unwrap_or_default();
        if let Err(e) = state
            .fleet
            .send(
                &ft_core::HostId::from_stored(host),
                ft_proto::ToWorker::SetSkills {
                    session_id: SessionId::from_stored(session.clone()),
                    skills: bundles,
                },
            )
            .await
        {
            tracing::warn!(%session, "telling the worker its skills changed: {e:#}");
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

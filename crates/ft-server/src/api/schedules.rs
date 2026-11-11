//! Work that starts itself, over HTTP.
//!
//! Listed by owner and never filed: a schedule is not shared, so the question
//! is "is it mine" and the predicate is in the query.
//!
//! **Three things the server does rather than the client.** It compiles the
//! cadence and computes the next three fire times, so no client parses cron
//! and there is one implementation in the product. It enforces the
//! fifteen-minute floor on write, so the API refuses it and not only the form.
//! And it counts the streak off the run history on every read, so the words a
//! paused schedule shows are derivable rather than frozen in a column.

use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::schedules::{cadence, launch, pause, settle};
use crate::AppState;
use ft_core::schedule::{Cadence, Provenance, Schedule, ScheduleRun, TriggerKind};
use ft_core::{RepoId, ScheduleId, ScheduleRunId, TriggerId, UserId};

/// Whose schedules these are.
///
/// There is no owning one as nobody: a schedule spends a subscription and
/// pushes with a git token, and neither exists without an account.
fn owner(principal: &Principal) -> ApiResult<&str> {
    principal.owner().ok_or_else(|| {
        ApiError::new(
            ErrorCode::Unauthorized,
            "a schedule runs as somebody, so this needs signing in",
        )
    })
}

/// What the API accepts to write one down.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewSchedule {
    pub name: String,
    pub prompt: String,
    /// Omit for a bare agent. Several things are different without one — see
    /// `deleteCleanRuns`.
    #[serde(default)]
    pub repo_id: Option<RepoId>,
    /// The branch each run starts from. Only meaningful with a repository.
    #[serde(default)]
    pub base: Option<String>,
    pub cadence: Cadence,
    /// An IANA name. Required, and not defaulted to the server's own zone:
    /// "09:00" means nothing without saying whose nine.
    pub timezone: String,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default = "default_agent")]
    pub agent: ft_core::Agent,
    #[serde(default)]
    pub account_id: Option<String>,
    /// Model, effort, permissions and sandbox. **Pinned explicitly** — see
    /// [`pins_for`].
    #[serde(default)]
    pub settings: ft_core::controls::Preferred,
    /// The skills each run reads. `null` takes the repository's defaults *at
    /// creation* and pins the result.
    #[serde(default)]
    pub skills: Option<Vec<String>>,
    /// Whether a clean run's workspace is deleted. Ignored without a
    /// repository, where nothing is ever deleted automatically.
    #[serde(default = "yes")]
    pub delete_clean_runs: bool,
    /// The conversation that asked for this, when an agent did.
    #[serde(default)]
    pub from_session_id: Option<String>,
}

fn default_agent() -> ft_core::Agent {
    ft_core::Agent::ClaudeCode
}
fn yes() -> bool {
    true
}

/// What a cadence would do, before anything is written down.
///
/// The create form needs the read-back and the next three fire times while
/// somebody is still typing, and it must not compute them itself.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CadenceQuestion {
    pub cadence: Cadence,
    pub timezone: String,
}

/// The answer: what it means, and when it would fire.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CadenceAnswer {
    pub expr: String,
    pub reads: String,
    pub next_fires: Vec<chrono::DateTime<chrono::Utc>>,
}

/// One run of one schedule, with the schedule's name beside it.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunOf {
    #[serde(flatten)]
    pub run: ScheduleRun,
    pub schedule_name: String,
}

#[derive(Debug, Deserialize, ToSchema, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    /// How many to return. Twenty is what the page draws.
    #[serde(default)]
    pub limit: Option<i64>,
}

/// Every schedule of yours, newest change first.
#[utoipa::path(
    get, path = "/api/v1/schedules", tag = "schedules",
    responses((status = 200, body = Vec<Schedule>)),
)]
pub(super) async fn list_schedules(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<Schedule>>> {
    let person = owner(&principal)?;
    let mut out = Vec::new();
    for row in state.db.schedules_of(person).await? {
        out.push(assemble(&state, row).await?);
    }
    Ok(Json(out))
}

/// Write one down. **Inactive and unapproved**, whoever asked.
///
/// Turning it on is a separate act, which is the whole of "an agent may
/// propose but may not activate" — and it is the same code path for a person,
/// so there is one rule rather than two.
#[utoipa::path(
    post, path = "/api/v1/schedules", tag = "schedules",
    request_body = NewSchedule,
    responses(
        (status = 201, body = Schedule),
        (status = 400, body = ApiError, description = "the cadence fires too often, or is not one"),
        (status = 404, body = ApiError, description = "that repository isn't connected"),
    ),
)]
pub(super) async fn create_schedule(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(req): Json<NewSchedule>,
) -> ApiResult<(axum::http::StatusCode, Json<Schedule>)> {
    let person = owner(&principal)?.to_string();
    let id = ScheduleId::new();
    write_one(&state, &person, &person, &id, req, true).await?;
    let row = state
        .db
        .schedule_of(&person, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("schedule"))?;
    Ok((
        axum::http::StatusCode::CREATED,
        Json(assemble(&state, row).await?),
    ))
}

/// Shared by the handler and the MCP tool, so a proposal cannot reach a
/// weaker check than a person does.
pub(crate) async fn write_one(
    state: &AppState,
    owner_id: &str,
    created_by: &str,
    id: &ScheduleId,
    req: NewSchedule,
    fresh: bool,
) -> ApiResult<()> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a schedule needs a name",
        ));
    }
    if req.prompt.trim().is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a schedule needs something to ask for — nobody is there to say it later",
        ));
    }

    // **The repository, as the person who named it.** The same predicate every
    // launch re-checks; naming somebody else's here would be the ownership
    // hole with a timer attached.
    if let Some(repo) = &req.repo_id {
        if state.db.repo_of(owner_id, repo).await?.is_none() {
            return Err(ApiError::new(
                ErrorCode::RepoNotConnected,
                "that repository isn't connected",
            ));
        }
    }

    // The floor, on write, with the reason in the refusal.
    let clock = cadence::Clock::of(&req.cadence, &req.timezone)
        .map_err(|refused| ApiError::new(ErrorCode::InvalidRequest, refused.0))?;

    let spec = spec_for(&req);
    let pins = pins_for(state, owner_id, &req).await?;
    let delete_clean_runs = req.repo_id.is_some() && req.delete_clean_runs;

    if fresh {
        state
            .db
            .insert_schedule(
                id,
                owner_id,
                created_by,
                req.from_session_id.as_deref(),
                name,
                &spec,
                &pins,
                delete_clean_runs,
            )
            .await?;
    } else {
        state
            .db
            .update_schedule(id, name, &spec, &pins, delete_clean_runs)
            .await?;
        state.db.replace_triggers(id).await?;
    }

    state
        .db
        .insert_trigger(
            &TriggerId::new(),
            id,
            crate::schedules::kind_name(TriggerKind::Cron),
            &crate::schedules::trigger_config(&req.cadence, &req.timezone, &clock),
            // **No clock until it is approved and on.** A trigger with a fire
            // time is one the sweep will act on, and nothing may run before a
            // person turns it on.
            None,
        )
        .await?;
    Ok(())
}

/// The `NewSession` a run is started from, as approved.
///
/// Stored as the JSON it will be read back as rather than as a typed struct,
/// because what was approved is a *text* — and a build that adds a field to
/// `NewSession` must not retroactively change what an approved schedule does.
fn spec_for(req: &NewSchedule) -> serde_json::Value {
    let mut spec = serde_json::json!({
        "name": req.name.trim(),
        "prompt": req.prompt.trim(),
        "agent": req.agent,
        // Neither is a control on this surface, and both are written rather
        // than left to a default: `Equal` is what a workspace takes when
        // nobody says, and an unattended run should yield to whoever is at
        // their desk.
        //
        // Serialized from the values rather than written as strings, so a
        // rename on either enum is a compile error here instead of a spec
        // that silently fails to read back.
        "size": ft_core::WorkspaceSize::Medium,
        "share": ft_core::Share::Yields,
    });
    if let Some(repo) = &req.repo_id {
        spec["repoId"] = serde_json::json!(repo.as_str());
        if let Some(base) = req.base.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
            spec["base"] = serde_json::json!(base);
        }
    }
    // **No `hostId`.** A schedule pins a policy — any machine that is free —
    // and never a host: a pinned machine that is retired is a schedule that
    // fails every morning.
    spec
}

/// What must not be resolved again at launch.
///
/// **`settings: {}` is not "the defaults".** `carry_preferences` fills any
/// unset control field from whatever that person was last working with, so an
/// absent field means "whatever they were doing at 5pm yesterday" and would
/// change what the 9am unattended run does. All four are written in
/// explicitly, from the shipped defaults where the request left them unset.
async fn pins_for(
    state: &AppState,
    owner_id: &str,
    req: &NewSchedule,
) -> ApiResult<serde_json::Value> {
    let mut settings = req.settings.clone();
    // The permission mode, which has a default on this surface and only one
    // sensible one: it refuses anything not already allowed rather than
    // asking, because an unattended run has nobody to ask. **Not
    // `bypassPermissions`** — that is not in the menu this reads from, and it
    // is refused below whoever sends it.
    if settings.mode.is_none() {
        settings.mode = Some(NEVER_ASK.to_string());
    }
    if let Some(mode) = settings.mode.as_deref() {
        if mode == "bypassPermissions" {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                "bypassPermissions is not a mode a schedule may run in. An unattended run \
                 refuses what it is not allowed to do rather than being allowed more.",
            ));
        }
    }

    // The skills each run reads, resolved **now** and pinned. An absent list
    // is resolved from the repository's defaults at creation, because leaving
    // it absent would resolve it afresh at every launch — which is the thing
    // approval is supposed to fix.
    let repos: Vec<ft_core::RepoId> = req.repo_id.clone().into_iter().collect();
    let skills: Vec<String> = match &req.skills {
        Some(chosen) => chosen.clone(),
        None => state
            .skills
            .defaults_for(owner_id, &repos)
            .await
            .unwrap_or_default(),
    };

    // The subscription this will spend, resolved now. Pinned because "the
    // default" is a preference somebody can change, and a schedule approved
    // against one subscription must not quietly start spending another.
    let account = match &req.account_id {
        Some(id) => Some(id.clone()),
        None => super::accounts::default_account(&state.db, owner_id, req.agent)
            .await
            .ok()
            .flatten()
            .map(|a| a.id),
    };

    // The versions those skills resolve to **now**, so the gate can fail
    // closed when one has gone rather than substituting the current one —
    // which is the substitution pinning exists to prevent.
    let versions = state
        .skills
        .current_versions(&skills)
        .await
        .unwrap_or_default();

    Ok(serde_json::json!({
        "settings": settings,
        "skills": skills,
        "accountId": account,
        "profile": req.profile,
        "skillVersionIds": versions,
    }))
}

/// The shipped "never ask" behaviour: it refuses rather than bypasses.
const NEVER_ASK: &str = "dontAsk";

/// One schedule of yours.
#[utoipa::path(
    get, path = "/api/v1/schedules/{id}", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id")),
    responses((status = 200, body = Schedule), (status = 404, body = ApiError)),
)]
pub(super) async fn one_schedule(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Schedule>> {
    let row = mine(&state, &principal, &id).await?;
    Ok(Json(assemble(&state, row).await?))
}

/// Change what it runs.
///
/// **An edit clears the approval and bumps the revision**, so the next
/// occurrence is refused until a person approves again — a schedule an agent
/// proposed and somebody approved is an authorization over a particular text.
/// A run already in flight carries the revision it started on and is
/// untouched.
#[utoipa::path(
    patch, path = "/api/v1/schedules/{id}", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id")),
    request_body = NewSchedule,
    responses((status = 200, body = Schedule), (status = 404, body = ApiError)),
)]
pub(super) async fn update_schedule(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(req): Json<NewSchedule>,
) -> ApiResult<Json<Schedule>> {
    let row = mine(&state, &principal, &id).await?;
    let person = owner(&principal)?.to_string();
    write_one(&state, &row.owner_id, &person, &row.id, req, false).await?;
    // Off until somebody approves it again, and its clock stopped with it.
    state.db.set_schedule_active(&row.id, false, None).await?;
    let row = state
        .db
        .schedule_of(&person, &row.id)
        .await?
        .ok_or_else(|| ApiError::not_found("schedule"))?;
    Ok(Json(assemble(&state, row).await?))
}

/// Approve it and turn it on.
///
/// The one act an agent may not do. A person doing it is what makes a proposal
/// an ordinary schedule — the row afterwards is identical to one somebody
/// wrote.
#[utoipa::path(
    post, path = "/api/v1/schedules/{id}/approve", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id")),
    responses((status = 200, body = Schedule), (status = 404, body = ApiError)),
)]
pub(super) async fn approve_schedule(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Schedule>> {
    let row = mine(&state, &principal, &id).await?;
    state
        .db
        .approve_schedule(&row.id, owner(&principal)?)
        .await?;
    turn_on(&state, &row).await?;
    reread(&state, &principal, &row.id).await
}

/// Stop future runs. **Never touches a run in flight** — that is a separate
/// control, and the two are different questions.
#[utoipa::path(
    post, path = "/api/v1/schedules/{id}/pause", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id")),
    responses((status = 200, body = Schedule), (status = 404, body = ApiError)),
)]
pub(super) async fn pause_schedule(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Schedule>> {
    let row = mine(&state, &principal, &id).await?;
    // **`paused_reason` stays null**, which is how "you paused this" is told
    // apart from "this gave up". The two have to read differently.
    state.db.set_schedule_active(&row.id, false, None).await?;
    for trigger in state.db.triggers_of(&row.id).await? {
        state.db.set_next_fire_at(&trigger.id, None).await?;
    }
    reread(&state, &principal, &row.id).await
}

/// Turn it back on.
///
/// Only ever a person. **Answering a question after a schedule has paused does
/// not resume it**, and nothing else does either: Firetower never turns a
/// schedule back on.
#[utoipa::path(
    post, path = "/api/v1/schedules/{id}/resume", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id")),
    responses(
        (status = 200, body = Schedule),
        (status = 409, body = ApiError, description = "it has not been approved"),
    ),
)]
pub(super) async fn resume_schedule(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Schedule>> {
    let row = mine(&state, &principal, &id).await?;
    if row.approved_at.is_none() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this schedule has not been approved yet, so there is nothing to turn back on",
        ));
    }
    turn_on(&state, &row).await?;
    reread(&state, &principal, &row.id).await
}

/// Mark it on and give its triggers a clock.
async fn turn_on(state: &AppState, row: &crate::db::ScheduleRow) -> ApiResult<()> {
    state.db.set_schedule_active(&row.id, true, None).await?;
    let now = chrono::Utc::now();
    for trigger in state.db.triggers_of(&row.id).await? {
        let next = crate::schedules::clock_of(&trigger.config).and_then(|c| c.next_after(now));
        state.db.set_next_fire_at(&trigger.id, next).await?;
    }
    Ok(())
}

/// Start one now.
///
/// **The clock is not moved**, and the run is marked `manual` — the pause rule
/// reads only scheduled runs, so three presses that each asked something must
/// not pause a schedule that has never failed on its own clock.
#[utoipa::path(
    post, path = "/api/v1/schedules/{id}/run", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id")),
    responses((status = 202, body = StartedRun), (status = 404, body = ApiError)),
)]
pub(super) async fn run_schedule_now(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<(axum::http::StatusCode, Json<StartedRun>)> {
    let row = mine(&state, &principal, &id).await?;
    if row.approved_at.is_none() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this schedule has not been approved yet",
        ));
    }
    let run = launch::run_now(&state, &row)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;
    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(StartedRun {
            run_id: run.as_str().to_string(),
        }),
    ))
}

/// Which run a press of Run now started.
///
/// **Not `Done`.** `sessions::Done` already owns that name in the contract,
/// and two schemas of one name there means the second quietly becomes the
/// first — the generated client would have typed this as `{ detail }` and
/// nothing would have said so until a field read `undefined`.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartedRun {
    pub run_id: String,
}

/// Delete it.
///
/// **Never stops a run.** One in flight finishes and its workspace stays. The
/// history goes, because the summary table is the only record of it.
#[utoipa::path(
    delete, path = "/api/v1/schedules/{id}", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn delete_schedule(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<axum::http::StatusCode> {
    let row = mine(&state, &principal, &id).await?;
    state.db.delete_schedule(&row.id).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// This schedule's runs, newest first.
#[utoipa::path(
    get, path = "/api/v1/schedules/{id}/runs", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id"), Limit),
    responses((status = 200, body = Vec<ScheduleRun>), (status = 404, body = ApiError)),
)]
pub(super) async fn schedule_runs(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Query(limit): Query<Limit>,
) -> ApiResult<Json<Vec<ScheduleRun>>> {
    let row = mine(&state, &principal, &id).await?;
    let rows = state
        .db
        .runs_of(&row.id, limit.limit.unwrap_or(20).clamp(1, 200))
        .await?;
    Ok(Json(rows.iter().map(as_run).collect()))
}

/// Every run from every schedule of yours, newest first.
#[utoipa::path(
    get, path = "/api/v1/schedule-runs", tag = "schedules",
    params(Limit),
    responses((status = 200, body = Vec<RunOf>)),
)]
pub(super) async fn all_runs(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Query(limit): Query<Limit>,
) -> ApiResult<Json<Vec<RunOf>>> {
    let person = owner(&principal)?;
    let rows = state
        .db
        .runs_for(person, limit.limit.unwrap_or(50).clamp(1, 500))
        .await?;
    Ok(Json(
        rows.iter()
            .map(|(name, row)| RunOf {
                run: as_run(row),
                schedule_name: name.clone(),
            })
            .collect(),
    ))
}

/// What a cadence would do.
///
/// Here rather than in the client, which is the whole of criterion 10: there
/// is one cron implementation in the product, and the row renders what it is
/// told.
#[utoipa::path(
    post, path = "/api/v1/schedules/cadence", tag = "schedules",
    request_body = CadenceQuestion,
    responses(
        (status = 200, body = CadenceAnswer),
        (status = 400, body = ApiError, description = "it fires too often, or is not a cadence"),
    ),
)]
pub(super) async fn read_cadence(
    State(_state): State<AppState>,
    Extension(_principal): Extension<Principal>,
    Json(req): Json<CadenceQuestion>,
) -> ApiResult<Json<CadenceAnswer>> {
    let clock = cadence::Clock::of(&req.cadence, &req.timezone)
        .map_err(|refused| ApiError::new(ErrorCode::InvalidRequest, refused.0))?;
    Ok(Json(CadenceAnswer {
        expr: clock.expr().to_string(),
        reads: clock.reads(),
        next_fires: clock.next_fires(chrono::Utc::now(), 3),
    }))
}

/// Mine, or not found.
async fn mine(
    state: &AppState,
    principal: &Principal,
    id: &str,
) -> ApiResult<crate::db::ScheduleRow> {
    state
        .db
        .schedule_of(owner(principal)?, &ScheduleId::from_stored(id.to_string()))
        .await?
        .ok_or_else(|| ApiError::not_found("schedule"))
}

async fn reread(
    state: &AppState,
    principal: &Principal,
    id: &ScheduleId,
) -> ApiResult<Json<Schedule>> {
    let row = state
        .db
        .schedule_of(owner(principal)?, id)
        .await?
        .ok_or_else(|| ApiError::not_found("schedule"))?;
    Ok(Json(assemble(state, row).await?))
}

/// A row, plus everything a page draws beside it.
async fn assemble(state: &AppState, row: crate::db::ScheduleRow) -> ApiResult<Schedule> {
    let triggers: Vec<_> = state
        .db
        .triggers_of(&row.id)
        .await?
        .iter()
        .filter_map(|t| crate::schedules::trigger_of(t, row.active))
        .collect();

    let (runs_total, workspaces_kept) = state.db.run_counts(&row.id).await?;

    // **Counted off the history, every read.** Nothing is stored, which is
    // what lets one rule read three ways — the page says which by counting
    // the same rows it is already drawing.
    let window = state.db.runs_for_streak(&row.id, pause::WINDOW).await?;
    let counted: Vec<_> = window.iter().map(settle::as_counted).collect();
    let streak = pause::streak(&counted);

    let last_run = state.db.runs_of(&row.id, 1).await?.first().map(as_run);

    let repo_id = row
        .spec
        .get("repoId")
        .and_then(|v| v.as_str())
        .map(|s| RepoId::from_stored(s.to_string()));
    let repo_slug = match &repo_id {
        Some(id) => state.db.repo_of(&row.owner_id, id).await?.map(|r| r.slug),
        None => None,
    };

    let by_agent = row.from_session_id.is_some();
    let who = match by_agent {
        true => row
            .pins
            .get("proposedBy")
            .and_then(|v| v.as_str())
            .unwrap_or("An agent")
            .to_string(),
        false => state
            .accounts
            .user_by_id(&UserId::from_stored(row.created_by.clone()))
            .await
            .ok()
            .flatten()
            .map(|u| u.username)
            .unwrap_or_else(|| "You".to_string()),
    };

    Ok(Schedule {
        id: row.id.clone(),
        name: row.name.clone(),
        prompt: row
            .spec
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        repo_id,
        repo_slug,
        base: row
            .spec
            .get("base")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        active: row.active,
        paused_reason: crate::schedules::paused_reason(row.paused_reason.as_deref()),
        approved_at: row.approved_at,
        revision: row.revision,
        triggers,
        delete_clean_runs: row.delete_clean_runs,
        workspaces_kept,
        streak,
        runs_total,
        last_run,
        made: Provenance {
            by_agent,
            who,
            from_session_id: row.from_session_id.clone(),
            from_workspace_name: row
                .pins
                .get("fromWorkspaceName")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            at: row.created_at,
        },
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// One stored run, as a client reads it.
pub(crate) fn as_run(row: &crate::db::RunRow) -> ScheduleRun {
    let counted = settle::as_counted(row);
    ScheduleRun {
        id: ScheduleRunId::from_stored(row.id.as_str()),
        schedule_id: row.schedule_id.clone(),
        fire_at: row.fire_at,
        revision: row.revision,
        state: counted.state,
        outcome: counted.outcome,
        source: crate::schedules::run_source(&row.source),
        detail: row.detail.clone(),
        summary: row.summary.clone(),
        session_id: row.session_id.clone(),
        workspace_kept: row.workspace_kept,
        host_name: row.host_name.clone(),
        error_code: row.error_code.clone(),
        launched_at: row.launched_at,
        ended_at: row.ended_at,
    }
}

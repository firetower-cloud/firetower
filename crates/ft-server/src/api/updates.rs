//! Upgrading from the screen: what is available, what it would change, and
//! the run that does it.
//!
//! Administrators only. Recreating the control plane and every worker is the
//! one action here that touches every person's work at once.

use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::updates::{runs, status, store, version, NewRun, UpdateRun, UpdateStatus, UpgradePlan};
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use utoipa::ToSchema;

fn admin_only(principal: &Principal) -> ApiResult<()> {
    match &principal.user {
        // Authentication off is a development mode; there is nobody to be.
        None => Ok(()),
        Some(user) if user.role == "admin" => Ok(()),
        Some(_) => Err(ApiError::new(
            ErrorCode::Forbidden,
            "only an administrator can upgrade Firetower",
        )),
    }
}

/// Where everything stands against the newest release.
#[utoipa::path(
    get, path = "/api/v1/updates", tag = "updates",
    responses((status = 200, body = UpdateStatus)),
)]
pub(super) async fn get_updates(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<UpdateStatus>> {
    admin_only(&principal)?;
    Ok(Json(status::status(&state).await?))
}

/// Ask the releases feed now rather than waiting for the next check.
#[utoipa::path(
    post, path = "/api/v1/updates/check", tag = "updates",
    responses((status = 200, body = UpdateStatus)),
)]
pub(super) async fn check_updates(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<UpdateStatus>> {
    admin_only(&principal)?;
    status::check(&state).await?;
    Ok(Json(status::status(&state).await?))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequest {
    pub version: String,
}

/// What moving the control plane to a release would do to the deployment's
/// files. Asked before agreeing, so an edited `firetower.yml` is a diff on
/// the screen rather than a surprise on the machine.
#[utoipa::path(
    post, path = "/api/v1/updates/plan", tag = "updates",
    request_body = PlanRequest,
    responses((status = 200, body = UpgradePlan), (status = 400, body = ApiError)),
)]
pub(super) async fn plan_update(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(req): Json<PlanRequest>,
) -> ApiResult<Json<UpgradePlan>> {
    admin_only(&principal)?;
    let to = version::parse(&req.version).ok_or_else(|| {
        ApiError::new(
            ErrorCode::InvalidRequest,
            format!("{} is not a version", req.version),
        )
    })?;
    status::plan(&state, &to)
        .await
        .map(Json)
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))
}

/// Start an upgrade.
#[utoipa::path(
    post, path = "/api/v1/updates/runs", tag = "updates",
    request_body = NewRun,
    responses(
        (status = 201, body = UpdateRun),
        (status = 400, body = ApiError),
        (status = 409, body = ApiError, description = "One is already in progress, or something is running that was not acknowledged"),
    ),
)]
pub(super) async fn create_run(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(req): Json<NewRun>,
) -> ApiResult<(StatusCode, Json<UpdateRun>)> {
    admin_only(&principal)?;

    let to = version::parse(&req.version).ok_or_else(|| {
        ApiError::new(
            ErrorCode::InvalidRequest,
            format!("{} is not a version", req.version),
        )
    })?;
    let current = status::status(&state).await?;
    if current.latest.as_ref().map(|l| l.version.as_str()) != Some(to.to_string().as_str()) {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "{to} is not the release the last check found{}. Check again and choose that one.",
                current
                    .latest
                    .as_ref()
                    .map(|l| format!(" ({})", l.version))
                    .unwrap_or_default()
            ),
        ));
    }
    if !req.control_plane && req.host_ids.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "nothing was chosen to upgrade",
        ));
    }

    // What would be ended, if it is not going to be waited for.
    let mut running: Vec<String> = Vec::new();
    if req.control_plane {
        if !current.control_plane.upgradable {
            return Err(ApiError::new(
                ErrorCode::ActionFailed,
                current
                    .control_plane
                    .reason
                    .unwrap_or_else(|| "the control plane cannot be upgraded from here".into()),
            ));
        }
        running.extend(current.control_plane.sessions.iter().cloned());
    }
    let mut host_names = Vec::new();
    for id in &req.host_ids {
        let target = current
            .hosts
            .iter()
            .find(|h| &h.host_id == id)
            .ok_or_else(|| ApiError::not_found("host"))?;
        if !target.upgradable {
            return Err(ApiError::new(
                ErrorCode::ActionFailed,
                format!(
                    "{}: {}",
                    target.name,
                    target
                        .reason
                        .clone()
                        .unwrap_or_else(|| "cannot be upgraded".into())
                ),
            ));
        }
        running.extend(target.sessions.iter().cloned());
        host_names.push((id.clone(), target.name.clone()));
    }
    if !req.when_idle && !running.is_empty() && !req.end_sessions {
        return Err(ApiError::new(
            ErrorCode::RepoInUse,
            format!(
                "{} running: {}. Upgrade when idle, or acknowledge that they end.",
                if running.len() == 1 {
                    "a session is".to_string()
                } else {
                    format!("{} sessions are", running.len())
                },
                running.join(", ")
            ),
        ));
    }

    let plan = if req.control_plane {
        store::Plan {
            files: status::files_to_write(&state, &to, &req.files)
                .await
                .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?,
        }
    } else {
        store::Plan::default()
    };

    let targets = store::Targets {
        control_plane: req.control_plane,
        host_ids: req.host_ids.clone(),
    };
    let run = store::Run {
        id: format!("upg_{}", ulid::Ulid::new().to_string().to_lowercase()),
        from_version: version::current().to_string(),
        to_version: to.to_string(),
        targets: targets.clone(),
        when_idle: req.when_idle,
        plan,
        state: crate::updates::RunState::Planned,
        started_by: principal.owner().map(str::to_string),
        created_at: chrono::Utc::now(),
        started_at: None,
        finished_at: None,
        error: None,
    };
    let steps = runs::steps_for(&targets, &host_names);
    state
        .updates
        .store
        .create_run(&run, &steps)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;

    tracing::info!(
        run = %run.id,
        by = %principal.subject,
        "upgrade to {to} started: control plane {}, {} host(s)",
        req.control_plane,
        req.host_ids.len()
    );
    runs::spawn(state.clone(), run.id.clone()).await;

    let view = read_run(&state, &run.id).await?;
    Ok((StatusCode::CREATED, Json(view)))
}

/// Past and present runs, newest first.
#[utoipa::path(
    get, path = "/api/v1/updates/runs", tag = "updates",
    responses((status = 200, body = Vec<UpdateRun>)),
)]
pub(super) async fn list_runs(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<UpdateRun>>> {
    admin_only(&principal)?;
    let mut views = Vec::new();
    for run in state.updates.store.runs().await? {
        let steps = state.updates.store.steps(&run.id).await?;
        views.push(UpdateRun::from_store(run, steps));
    }
    Ok(Json(views))
}

#[utoipa::path(
    get, path = "/api/v1/updates/runs/{id}", tag = "updates",
    params(("id" = String, Path, description = "Run id")),
    responses((status = 200, body = UpdateRun), (status = 404, body = ApiError)),
)]
pub(super) async fn get_run(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<UpdateRun>> {
    admin_only(&principal)?;
    Ok(Json(read_run(&state, &id).await?))
}

/// Stop a run that has not started changing anything yet.
///
/// A run that is waiting for machines to be idle is cancelled and the
/// machines put back in service. One that is already recreating something is
/// left to finish that step — half a recreate is worse than a whole one.
#[utoipa::path(
    post, path = "/api/v1/updates/runs/{id}/cancel", tag = "updates",
    params(("id" = String, Path, description = "Run id")),
    responses((status = 200, body = UpdateRun), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn cancel_run(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<UpdateRun>> {
    admin_only(&principal)?;
    let run = read_run(&state, &id).await?;
    if run.state.is_over() {
        return Ok(Json(run));
    }
    if !state.updates.store.request_cancel(&id).await? {
        return Err(ApiError::new(
            ErrorCode::ActionFailed,
            "this run is already changing something and will finish that step; it cannot be stopped half way",
        ));
    }
    Ok(Json(read_run(&state, &id).await?))
}

async fn read_run(state: &AppState, id: &str) -> ApiResult<UpdateRun> {
    let run = state
        .updates
        .store
        .run(id)
        .await?
        .ok_or_else(|| ApiError::not_found("run"))?;
    let steps = state.updates.store.steps(id).await?;
    Ok(UpdateRun::from_store(run, steps))
}

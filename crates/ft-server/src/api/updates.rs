//! Upgrading from the screen: what is available, what it would change, and
//! the run that does it.
//!
//! Administrators only. Recreating the control plane and every worker is the
//! one action here that touches every person's work at once.

use super::access::may_share;
use super::{ApiError, ApiResult, ErrorCode};
use crate::access::FiledKind;
use crate::auth::Principal;
use crate::updates::{
    channel, runs, status, store, version, NewRun, UpdateRun, UpdateStatus, UpgradePlan,
};
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use utoipa::ToSchema;

/// Moving the deployment itself.
///
/// The control plane is not a resource anybody holds a grant on — it is the
/// whole installation, and the machine every other machine is reached from. So
/// this one stays the organisation's.
fn admin_only(principal: &Principal) -> ApiResult<()> {
    match &principal.user {
        // Authentication off is a development mode; there is nobody to be.
        None => Ok(()),
        Some(user) if user.role == "admin" => Ok(()),
        Some(_) => Err(ApiError::new(
            ErrorCode::Forbidden,
            "only an administrator of this Firetower can upgrade the control plane",
        )),
    }
}

/// The deployment as one person sees it.
///
/// **Reading is not upgrading.** Everybody can see what this Firetower is
/// running and whether a release is out — a member who cannot tell that their
/// work runs on something months old cannot ask for anything about it. What
/// narrows is the machines, to the ones they could already see, and the
/// controls, to the ones the server would actually honour.
///
/// Administering a machine is `may_share`, which is the single definition of it
/// everywhere else: they own it, they administer the directory it is filed in,
/// or they administer the organisation. There is no second rule here.
async fn as_seen_by(
    state: &AppState,
    principal: &Principal,
    mut status: UpdateStatus,
) -> ApiResult<UpdateStatus> {
    let Some(me) = principal.user.as_ref() else {
        // Development mode, nobody to be, nothing to hide.
        status.control_plane.may_upgrade = true;
        status.channel.may_change = true;
        for h in &mut status.hosts {
            h.may_upgrade = h.upgradable;
        }
        return Ok(status);
    };

    status.control_plane.may_upgrade = me.role == "admin";
    // A member sees the channel and cannot move it. Hiding it would leave
    // "why does my colleague have this" unanswered on the one screen that
    // could answer it.
    status.channel.may_change = me.role == "admin";

    let visible: std::collections::HashSet<String> = state
        .db
        .hosts_for(me.id.as_str(), crate::access::Level::Viewer)
        .await?
        .into_iter()
        .map(|h| h.id.as_str().to_string())
        .collect();
    status.hosts.retain(|h| visible.contains(&h.host_id));

    // Behind the *control plane*, not behind the newest release. A worker may
    // be brought up to what the deployment is running and no further: one taken
    // past it is a worker talking to a control plane that does not know the
    // protocol yet, and whoever did it may have no way to move the control
    // plane after them.
    for h in &mut status.hosts {
        let behind = h
            .version
            .as_deref()
            .and_then(version::parse)
            .map(|theirs| version::is_newer(&version::current(), &theirs))
            .unwrap_or(true);
        h.may_upgrade = behind
            && may_share(state, me, FiledKind::Machine, &h.host_id)
                .await
                .is_ok();
    }

    Ok(status)
}

/// What a workers-only run is allowed to move to.
///
/// The version the control plane is on, and only that. A machine behind it can
/// be brought level; nothing can be taken past it, by anybody — an
/// administrator doing a workers-only run to the newest release would strand
/// them just as thoroughly, and would then have to upgrade the control plane to
/// rescue machines that had stopped being able to talk to it.
fn level_with_the_control_plane(to: &str) -> ApiResult<()> {
    let current = version::current().to_string();
    if to == current {
        return Ok(());
    }
    Err(ApiError::new(
        ErrorCode::InvalidRequest,
        format!(
            "a machine can be brought up to {current}, which is what this Firetower is running, \
             and no further. Upgrading the control plane is what moves everything to {to}."
        ),
    ))
}

/// Where everything stands against the newest release.
///
/// Readable by anybody. What it says is narrowed to them — see [`as_seen_by`].
#[utoipa::path(
    get, path = "/api/v1/updates", tag = "updates",
    responses((status = 200, body = UpdateStatus)),
)]
pub(super) async fn get_updates(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<UpdateStatus>> {
    let status = status::status(&state).await?;
    Ok(Json(as_seen_by(&state, &principal, status).await?))
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
    status::check(&state).await?;
    let status = status::status(&state).await?;
    Ok(Json(as_seen_by(&state, &principal, status).await?))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequest {
    pub version: String,
    /// Whether the control plane is one of the targets.
    ///
    /// The deployment's files are the control plane's own business, and the
    /// updater is what reads them — so a run that moves workers only is
    /// planned without asking it anything. Defaults to true: a client that
    /// predates this field is one that only ever planned the whole thing.
    #[serde(default = "planning_the_control_plane")]
    pub control_plane: bool,
}

fn planning_the_control_plane() -> bool {
    true
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
    // A plan is the deployment's files. A workers-only run rewrites none of
    // them, so there is nothing here a member could learn by asking.
    if req.control_plane {
        admin_only(&principal)?;
    }
    let to = version::parse(&req.version).ok_or_else(|| {
        ApiError::new(
            ErrorCode::InvalidRequest,
            format!("{} is not a version", req.version),
        )
    })?;
    status::plan(&state, &to, req.control_plane)
        .await
        .map(Json)
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))
}

// ── the channel ──────────────────────────────────────────────────────

/// Which channel this installation is on, and what each channel offers.
///
/// Readable by anybody, like the rest of this screen: the channel explains
/// which releases a person is being offered, and a member who cannot see it
/// has no way to ask about it. `mayChange` is what narrows — only an
/// administrator may move it, and a client should draw a fact rather than a
/// control when that is false.
///
/// The same answer is on `GET /api/v1/updates` as `channel`, for the screen
/// that wants both in one ask.
#[utoipa::path(
    get, path = "/api/v1/updates/channel", tag = "updates",
    responses((status = 200, body = channel::ChannelStatus)),
)]
pub(super) async fn get_channel(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<channel::ChannelStatus>> {
    let mut found = channel::status(&state, None).await;
    found.may_change = match &principal.user {
        None => true,
        Some(me) => me.role == "admin",
    };
    Ok(Json(found))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPlanRequest {
    /// The channel to move to. The one in force is a legitimate answer: it
    /// is how an installation running an unrecognised tag comes to actually
    /// be on the channel it is being treated as.
    pub channel: channel::Channel,
    /// What to do about a deployment file the release changed and somebody
    /// here has edited — the same choice an ordinary upgrade asks for.
    #[serde(default)]
    pub files: Vec<crate::updates::FileChoice>,
}

/// What switching would write, before it is taken.
///
/// An ordinary upgrade plan, plus `channelChange`: the image lines as they
/// are and as they would be, the version the installation would be moved
/// onto in the same act, and whether that act can be undone.
#[utoipa::path(
    post, path = "/api/v1/updates/channel/plan", tag = "updates",
    request_body = ChannelPlanRequest,
    responses((status = 200, body = UpgradePlan), (status = 400, body = ApiError)),
)]
pub(super) async fn plan_channel(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(req): Json<ChannelPlanRequest>,
) -> ApiResult<Json<UpgradePlan>> {
    admin_only(&principal)?;
    let (switch, _, mut plan) = channel::plan(&state, req.channel, &req.files)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;
    plan.channel_change = Some(switch);
    Ok(Json(plan))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SwitchRequest {
    pub channel: channel::Channel,
    /// Taken as read: moving to beta cannot be undone. Required for beta,
    /// where `irreversible` on the plan is the sentence a client has to put
    /// in front of somebody first; ignored for general access, which can.
    #[serde(default)]
    pub acknowledge_one_way: bool,
    #[serde(default)]
    pub files: Vec<crate::updates::FileChoice>,
}

/// Switch channel: rewrite both image lines and move onto that channel's
/// version, as one run.
///
/// **One act, not two.** The channel is read back from the container that is
/// running, so writing the file alone would leave the installation reporting
/// general access while its file said beta — a switch that appears not to
/// have worked. So this is an ordinary upgrade run with the image lines moved
/// in the same step that recreates the control plane, which means the
/// rollback that already exists puts both back together.
///
/// Nothing here is automatic. A channel decides which release is offered and
/// nothing else about how it is taken: this call is the press, and the run it
/// makes is the same run the Upgrade button makes.
#[utoipa::path(
    post, path = "/api/v1/updates/channel", tag = "updates",
    request_body = SwitchRequest,
    responses(
        (status = 201, body = UpdateRun),
        (status = 400, body = ApiError),
        (status = 409, body = ApiError, description = "One is already in progress"),
    ),
)]
pub(super) async fn switch_channel(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(req): Json<SwitchRequest>,
) -> ApiResult<(StatusCode, Json<UpdateRun>)> {
    admin_only(&principal)?;

    // Read again rather than trusting what the screen was shown: the channel
    // comes from the running container, and this is the moment it matters.
    let found = channel::status(&state, None).await;
    if let Some(reason) = found.reason.clone() {
        return Err(ApiError::new(ErrorCode::ActionFailed, reason));
    }
    let offer = found
        .offers
        .iter()
        .find(|o| o.channel == req.channel)
        .ok_or_else(|| ApiError::not_found("channel"))?;
    if offer.action.is_none() {
        return Err(ApiError::new(
            ErrorCode::ActionFailed,
            offer
                .reason
                .clone()
                .unwrap_or_else(|| "this channel cannot be taken from here".into()),
        ));
    }
    if offer.irreversible && !req.acknowledge_one_way {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "moving to {} cannot be undone: it installs every release as it is cut, and its \
                 migrations run on this database. Migrations do not run backwards, so coming back \
                 to general access means restoring a dump and losing everything written since. \
                 Say that first, take a backup, and send acknowledgeOneWay.",
                req.channel.name()
            ),
        ));
    }

    let (switch, files, _) = channel::plan(&state, req.channel, &req.files)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;

    let targets = store::Targets {
        control_plane: true,
        // The machines are not moved by a switch. A worker is brought level
        // with the control plane afterwards, from the control this screen
        // already has, so the switch is one decision rather than two bundled
        // into one press.
        host_ids: Vec::new(),
        channel: Some(req.channel),
    };
    let run = store::Run {
        id: format!("upg_{}", ulid::Ulid::new().to_string().to_lowercase()),
        from_version: version::current().to_string(),
        to_version: switch.version.clone(),
        targets: targets.clone(),
        when_idle: false,
        plan: store::Plan {
            files,
            tag: Some(switch.tag.clone()),
        },
        state: crate::updates::RunState::Planned,
        started_by: principal.owner().map(str::to_string),
        created_at: chrono::Utc::now(),
        started_at: None,
        finished_at: None,
        error: None,
    };
    let steps = runs::steps_for(&targets, &[]);
    state
        .updates
        .store
        .create_run(&run, &steps)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;

    tracing::info!(
        run = %run.id,
        by = %principal.subject,
        "channel: {} → {} (:{}), moving to {}",
        switch.from.name(),
        switch.channel.name(),
        switch.tag,
        switch.version,
    );
    runs::spawn(state.clone(), run.id.clone()).await;

    Ok((StatusCode::CREATED, Json(read_run(&state, &run.id).await?)))
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
    // Asked per target, not once for the run. Moving the deployment is the
    // organisation's; moving a machine belongs to whoever administers that
    // machine, which is the same question the sharing sheet asks.
    if req.control_plane {
        admin_only(&principal)?;
    }
    if let Some(me) = principal.user.as_ref() {
        for host_id in &req.host_ids {
            may_share(&state, me, FiledKind::Machine, host_id).await?;
        }
    }

    let to = version::parse(&req.version).ok_or_else(|| {
        ApiError::new(
            ErrorCode::InvalidRequest,
            format!("{} is not a version", req.version),
        )
    })?;
    let current = status::status(&state).await?;
    if req.control_plane {
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
    } else {
        level_with_the_control_plane(&to.to_string())?;
    }
    if !req.control_plane && req.host_ids.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "nothing was chosen to upgrade",
        ));
    }

    // What would be ended, if it is not going to be waited for.
    let mut running: Vec<String> = Vec::new();
    // Nothing is added to `running` for the control plane: nothing runs in its
    // container, so recreating it ends nothing. Only the machines below can
    // have sessions to lose.
    if req.control_plane && !current.control_plane.upgradable {
        return Err(ApiError::new(
            ErrorCode::ActionFailed,
            current
                .control_plane
                .reason
                .unwrap_or_else(|| "the control plane cannot be upgraded from here".into()),
        ));
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
        let files = status::files_to_write(&state, &to, &req.files)
            .await
            .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;
        // The compose file is the intent and the container is the fact. They
        // agree on every ordinary upgrade, and where they do not — the
        // release that first moves an installation onto a channel tag — the
        // file is the one to believe.
        let tag = channel::fetch_tag(&state, &files).await;
        store::Plan { files, tag }
    } else {
        store::Plan::default()
    };

    let targets = store::Targets {
        control_plane: req.control_plane,
        host_ids: req.host_ids.clone(),
        channel: None,
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
/// A run somebody may watch or stop.
///
/// Theirs, or anybody's if they administer the organisation. A member who
/// upgrades a machine has to be able to see what they started — an action whose
/// progress is invisible to whoever took it is an action nobody trusts twice —
/// and a run nobody may look at is a run nobody can cancel either.
fn ours(principal: &Principal, run: &UpdateRun) -> ApiResult<()> {
    match &principal.user {
        None => Ok(()),
        Some(me) if me.role == "admin" => Ok(()),
        Some(me) if run.started_by.as_deref() == Some(me.id.as_str()) => Ok(()),
        Some(_) => Err(ApiError::not_found("run")),
    }
}

#[utoipa::path(
    get, path = "/api/v1/updates/runs", tag = "updates",
    responses((status = 200, body = Vec<UpdateRun>)),
)]
pub(super) async fn list_runs(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<UpdateRun>>> {
    let mut views = Vec::new();
    for run in state.updates.store.runs().await? {
        let steps = state.updates.store.steps(&run.id).await?;
        let view = UpdateRun::from_store(run, steps);
        if ours(&principal, &view).is_ok() {
            views.push(view);
        }
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
    let run = read_run(&state, &id).await?;
    ours(&principal, &run)?;
    Ok(Json(run))
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
    let run = read_run(&state, &id).await?;
    ours(&principal, &run)?;
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

/// Carry on with a run that stopped to ask.
///
/// Only a run waiting on the backup reaches this, and the answer is always the
/// same one: go ahead without a backup. Its step keeps the `Warned` state, so
/// the history says the upgrade went ahead without one.
#[utoipa::path(
    post, path = "/api/v1/updates/runs/{id}/continue", tag = "updates",
    params(("id" = String, Path, description = "Run id")),
    responses((status = 200, body = UpdateRun), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn continue_run(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<UpdateRun>> {
    let run = read_run(&state, &id).await?;
    ours(&principal, &run)?;
    if run.state != crate::updates::RunState::WaitingDecision {
        return Err(ApiError::new(
            ErrorCode::ActionFailed,
            "this run is not waiting for an answer",
        ));
    }
    state
        .updates
        .store
        .set_run_state(&id, crate::updates::RunState::Running)
        .await?;
    crate::updates::runs::spawn(state.clone(), id.clone()).await;
    Ok(Json(read_run(&state, &id).await?))
}

/// Take a backup now, outside an upgrade.
///
/// Until this existed a backup only ever ran inside an upgrade, so there was
/// no way to find out it was broken except by trying to upgrade — which is how
/// one got found.
#[utoipa::path(
    post, path = "/api/v1/updates/backup", tag = "updates",
    responses((status = 200, body = String), (status = 409, body = ApiError)),
)]
pub(super) async fn back_up_now(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<String>> {
    admin_only(&principal)?;
    let updater = state
        .updates
        .updater
        .as_ref()
        .map_err(|absent| ApiError::new(ErrorCode::ActionFailed, absent.explain()))?;
    let job = updater
        .start(ft_updater_api::JobKind::Backup {
            from_version: env!("CARGO_PKG_VERSION").to_string(),
        })
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;
    Ok(Json(job.id.0))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The rule that stops somebody stranding a machine ahead of the control
    /// plane — which they may then have no right to move after it.
    #[test]
    fn a_machine_may_be_brought_level_and_no_further() {
        let running = version::current().to_string();
        assert!(level_with_the_control_plane(&running).is_ok());

        let ahead = "99.0.0";
        let refused = level_with_the_control_plane(ahead).expect_err("past the control plane");
        let said = format!("{refused:?}");
        assert!(said.contains(&running), "says what it is running: {said}");
        assert!(
            said.contains("Upgrading the control plane"),
            "and what would move it: {said}"
        );
    }
}

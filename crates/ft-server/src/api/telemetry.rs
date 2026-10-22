//! Telemetry: the outbox, the acknowledgement, and the switch.
//!
//! The control plane does not call out. It computes a digest per completed UTC
//! day into an outbox and waits to be collected; a desktop app reads this
//! surface, posts what it finds to the address it is given, and says so.
//!
//! ## Who may call what
//!
//! Collecting is any signed-in person's, because a courier is whoever happens
//! to open the app — restricting it to administrators would mean an
//! organisation whose admin is on holiday stops reporting. What they can see by
//! doing so is daily counts about an organisation they are already a member of.
//!
//! Changing the setting is an administrator's, and the organisation's rather
//! than the person's: one switch for the whole install, so turning it off means
//! off rather than off-for-me-but-not-my-colleagues.
//!
//! ## There is no flag for the client to check
//!
//! A disabled install simply has nothing in its outbox — `sweep` stops
//! computing and discards what it had. So the client never decides whether to
//! send; it asks what is owed and is told nothing. The enforcement is on the
//! server, where it cannot be skipped by an old or modified build.

use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::telemetry;
use crate::AppState;
use axum::{
    extract::{Query, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

/// The signed-in administrator, or a refusal.
fn admin(principal: &Principal) -> ApiResult<()> {
    let user = principal
        .user
        .as_ref()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "nobody is signed in"))?;
    if user.role != "admin" {
        return Err(ApiError::new(
            ErrorCode::Forbidden,
            "only an administrator can change what this install reports",
        ));
    }
    Ok(())
}

/// Which desktop is collecting.
#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct Collecting {
    /// The client's own version, remembered so the digest can report the
    /// distribution of desktops in use.
    ///
    /// Told to the server rather than added to the payload on the way past, so
    /// that `/telemetry/preview` shows the whole document. A preview missing a
    /// field the client would add is not a preview.
    #[serde(default)]
    pub courier: Option<String>,
}

/// What is owed, and where it goes.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Outbox {
    /// Where to post each payload.
    ///
    /// Given by the server so there is one source of truth for the address and
    /// no hostname compiled into a shipped binary that cannot be corrected.
    pub endpoint: String,
    /// Newest first — see `telemetry::undelivered` for why that end leads.
    /// Empty when telemetry is off, which is how the client is told without
    /// being trusted to check.
    pub digests: Vec<telemetry::Pending>,
}

#[utoipa::path(
    get, path = "/api/v1/telemetry/pending", tag = "telemetry",
    params(Collecting),
    responses((status = 200, body = Outbox)),
)]
pub async fn pending(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Query(who): Query<Collecting>,
) -> ApiResult<Json<Outbox>> {
    principal
        .user
        .as_ref()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "nobody is signed in"))?;

    if let Some(courier) = who.courier.as_deref() {
        telemetry::note_courier(&state.accounts, courier).await?;
    }

    // Off is enforced here rather than by the caller.
    if !telemetry::enabled(&state.accounts).await? {
        return Ok(Json(Outbox {
            endpoint: telemetry::endpoint(),
            digests: Vec::new(),
        }));
    }

    Ok(Json(Outbox {
        endpoint: telemetry::endpoint(),
        // The whole window, because the whole window is the most that can ever
        // be owed: `KEEP_UNDELIVERED_DAYS` bounds what is computed and `prune`
        // drops anything past it. A fortnight was the number here, and it was
        // the wrong kind of caution — a digest is a few hundred bytes, so the
        // cap saved nothing measurable, while any backlog longer than the cap
        // needed several rounds to clear and left the newest day until last.
        //
        // The per-request body limit this might otherwise argue with is the
        // gateway's, and that is per POST: the client posts one digest at a
        // time, so the size of this batch never reaches it.
        digests: telemetry::undelivered(&state.db, telemetry::KEEP_UNDELIVERED_DAYS).await?,
    }))
}

/// Which days got through.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Delivered {
    pub days: Vec<chrono::NaiveDate>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Acknowledged {
    /// How many were still owed and are now not. Fewer than asked for means
    /// another client got there first, which is ordinary.
    pub acknowledged: u64,
}

#[utoipa::path(
    post, path = "/api/v1/telemetry/delivered", tag = "telemetry",
    request_body = Delivered,
    responses((status = 200, body = Acknowledged)),
)]
pub async fn delivered(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<Delivered>,
) -> ApiResult<Json<Acknowledged>> {
    principal
        .user
        .as_ref()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "nobody is signed in"))?;

    let acknowledged = telemetry::mark_delivered(&state.db, &body.days).await?;
    Ok(Json(Acknowledged { acknowledged }))
}

/// Exactly what would leave this install.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub enabled: bool,
    pub endpoint: String,
    /// The most recent completed day, computed now.
    ///
    /// Computed rather than read from the outbox so that it answers even on an
    /// install where collection is off and the outbox is therefore empty —
    /// which is the state somebody deciding whether to turn it on is in.
    #[schema(value_type = Object)]
    pub example: serde_json::Value,
    /// How many days are waiting to be collected.
    pub waiting: usize,
}

#[utoipa::path(
    get, path = "/api/v1/telemetry/preview", tag = "telemetry",
    responses((status = 200, body = Preview)),
)]
pub async fn preview(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Preview>> {
    principal
        .user
        .as_ref()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "nobody is signed in"))?;

    let yesterday = chrono::Utc::now().date_naive() - chrono::Duration::days(1);
    let digest = telemetry::build(&state.db, &state.accounts, yesterday).await?;

    Ok(Json(Preview {
        enabled: telemetry::enabled(&state.accounts).await?,
        endpoint: telemetry::endpoint(),
        example: serde_json::to_value(&digest)
            .map_err(|e| ApiError::new(ErrorCode::Internal, format!("rendering a digest: {e}")))?,
        waiting: telemetry::undelivered(&state.db, 60).await?.len(),
    }))
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetSettings {
    pub enabled: bool,
}

#[utoipa::path(
    get, path = "/api/v1/telemetry/settings", tag = "telemetry",
    responses((status = 200, body = Settings)),
)]
pub async fn telemetry_settings(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Settings>> {
    principal
        .user
        .as_ref()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "nobody is signed in"))?;

    Ok(Json(Settings {
        enabled: telemetry::enabled(&state.accounts).await?,
    }))
}

#[utoipa::path(
    put, path = "/api/v1/telemetry/settings", tag = "telemetry",
    request_body = SetSettings,
    responses((status = 200, body = Settings)),
)]
pub async fn set_telemetry_settings(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<SetSettings>,
) -> ApiResult<Json<Settings>> {
    admin(&principal)?;

    telemetry::set_enabled(&state.accounts, body.enabled).await?;

    if body.enabled {
        // Sweep now rather than waiting up to an hour for the next one.
        // Without this, an administrator who turns collection on sees "waiting:
        // 0" on the page they turned it on from, which reads as broken rather
        // than as pending.
        //
        // Failure is not the caller's: the setting is saved either way, and the
        // hourly sweep will pick the days up regardless.
        match telemetry::sweep(&state.db, &state.accounts, chrono::Utc::now().date_naive()).await {
            Ok(n) => tracing::info!("telemetry turned on; computed {n} digest(s)"),
            Err(e) => tracing::warn!("telemetry turned on, but computing digests failed: {e:#}"),
        }
    } else {
        // Switching off throws away what was computed and not yet collected.
        // Otherwise "off" would stop new digests while the ones already made
        // went out on the next client to connect, which is the one behaviour
        // that would make this setting a lie.
        let dropped = telemetry::discard_undelivered(&state.db).await?;
        tracing::info!("telemetry turned off; discarded {dropped} undelivered digest(s)");
    }

    Ok(Json(Settings {
        enabled: body.enabled,
    }))
}

//! Connecting a task tracker that is not a git host.
//!
//! GitHub arrives already connected — its tracker credential is the git token
//! from [`super::providers`]. Linear has no device flow and no repositories, so
//! it connects by a key somebody makes in Linear and pastes here. The key is
//! tried before it is stored: one that does not work is a thing to say now,
//! not on the next screen.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::tasks::{linear_teams, linear_viewer, TaskKind};
use crate::trackers::{self, Auth, ScopeKind};
use crate::vault::Key;
use crate::AppState;

fn owner(principal: &Principal) -> Result<&str, ApiError> {
    principal.owner().ok_or_else(|| {
        ApiError::new(
            ErrorCode::Unauthorized,
            "connecting a tracker needs an account, and authentication is switched off",
        )
    })
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrackerStatus {
    pub id: String,
    pub label: String,
    /// We hold a credential for it.
    pub connected: bool,
    pub auth: Auth,
    /// Whether the scope picker offers repositories or teams.
    pub scope_kind: ScopeKind,
    /// What this tracker can return, so the kind toggle offers no more.
    pub kinds: Vec<TaskKind>,
    /// Where somebody goes to make a key, when that is how it connects.
    pub key_url: Option<String>,
}

/// One thing the list can be narrowed to: a repository, or a team.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskScope {
    /// What goes on the wire: `acme/web`, or `ENG`.
    pub key: String,
    /// What a person reads.
    pub label: String,
}

#[utoipa::path(
    get, path = "/api/v1/trackers", tag = "trackers",
    responses((status = 200, body = Vec<TrackerStatus>)),
)]
pub(super) async fn list_trackers(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<TrackerStatus>>> {
    let owner = owner(&principal)?;

    let mut out = Vec::new();
    for t in trackers::TRACKERS {
        out.push(TrackerStatus {
            id: t.id.to_string(),
            label: t.label.to_string(),
            // Whether one is held, never the value: this only renders a screen.
            connected: state
                .vault
                .holds(Key::of(t.vault_scope(), t.id, owner))
                .await?,
            auth: t.auth,
            scope_kind: t.scope_kind,
            kinds: t.kinds.to_vec(),
            key_url: t.key_url.map(str::to_string),
        });
    }
    Ok(Json(out))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrackerKey {
    /// Linear's look like `lin_api_…`.
    pub key: String,
}

/// What connecting worked out to, so the screen can say whose account it is.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub account: String,
}

/// Store a key for a tracker, once it is known to work.
#[utoipa::path(
    put, path = "/api/v1/trackers/{id}/key", tag = "trackers",
    params(("id" = String, Path, description = "Tracker id")),
    request_body = TrackerKey,
    responses(
        (status = 200, body = Connected),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError, description = "The tracker refused the key"),
    ),
)]
pub(super) async fn set_tracker_key(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(request): Json<TrackerKey>,
) -> ApiResult<Json<Connected>> {
    let tracker = trackers::find(&id).ok_or_else(|| ApiError::not_found("tracker"))?;
    let owner = owner(&principal)?;

    if tracker.auth != Auth::ApiKey {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "{} connects with the git host, not with a key",
                tracker.label
            ),
        ));
    }

    let key = request.key.trim();
    if key.is_empty() {
        return Err(ApiError::new(ErrorCode::InvalidRequest, "a key is needed"));
    }

    // Tried before it is kept. A key that does not work stored anyway is an
    // empty task list on another screen with nothing saying why.
    let account = linear_viewer(tracker, key)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ProviderNotConnected, format!("{e:#}")))?;

    state
        .vault
        .put(
            Key::of(tracker.vault_scope(), tracker.id, owner),
            key,
            &format!("{} connected with a key", tracker.label),
        )
        .await?;

    tracing::info!(tracker = tracker.id, "a tracker was connected");
    Ok(Json(Connected { account }))
}

/// Forget the key. Nothing else about the tracker is ours to remove.
#[utoipa::path(
    delete, path = "/api/v1/trackers/{id}", tag = "trackers",
    params(("id" = String, Path, description = "Tracker id")),
    responses((status = 204), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn disconnect_tracker(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let tracker = trackers::find(&id).ok_or_else(|| ApiError::not_found("tracker"))?;

    if tracker.auth != Auth::ApiKey {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("disconnect {} from the git host instead", tracker.label),
        ));
    }

    state
        .vault
        .forget(
            Key::of(tracker.vault_scope(), tracker.id, owner(&principal)?),
            "disconnected the tracker",
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// What the list can be narrowed to. The scope picker's data.
#[utoipa::path(
    get, path = "/api/v1/trackers/{id}/scopes", tag = "trackers",
    params(("id" = String, Path, description = "Tracker id")),
    responses(
        (status = 200, body = Vec<TaskScope>),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError, description = "That tracker has not been connected"),
    ),
)]
pub(super) async fn list_tracker_scopes(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<TaskScope>>> {
    let tracker = trackers::find(&id).ok_or_else(|| ApiError::not_found("tracker"))?;

    match tracker.scope_kind {
        // The repositories this Firetower is connected to, not everything the
        // token can see: the picker narrows a list that is already scoped to
        // them.
        ScopeKind::Repos => Ok(Json(
            state
                .db
                .repos()
                .await?
                .into_iter()
                .map(|r| TaskScope {
                    key: r.slug.clone(),
                    label: r.slug,
                })
                .collect(),
        )),
        ScopeKind::Teams if tracker.id == "linear" => {
            let credential = super::tasks::credential_for(
                &state,
                &principal,
                tracker,
                "listing teams to pick from",
            )
            .await?;

            linear_teams(tracker, &credential)
                .await
                .map(|teams| {
                    Json(
                        teams
                            .into_iter()
                            .map(|t| TaskScope {
                                label: format!("{} · {}", t.key, t.name),
                                key: t.key,
                            })
                            .collect(),
                    )
                })
                .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))
        }
        ScopeKind::Teams => Err(ApiError::not_found("tracker")),
    }
}

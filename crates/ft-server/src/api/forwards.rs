//! Ports of a session's workspace, opened on this machine.
//!
//! Three operations and no cleverness. What makes this worth a module rather
//! than three lines in `sessions` is the two answers that are not a port:
//! whether opening one would help whoever is asking, and whether one is needed
//! at all.
//!
//! See [`crate::forward`] for why a real port rather than a path under the
//! interface.

use super::sessions::session_context;
use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::forward::Forwarded;
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    Extension, Json,
};
use ft_core::SessionId;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// What the interface needs to decide what to show.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Ports {
    /// Ports already open on this machine for this session.
    pub forwards: Vec<Forwarded>,
    /// Whether opening one would reach the person asking.
    ///
    /// False when the control plane is somewhere other than the machine
    /// holding the browser: the port would be opened there, and sending
    /// somebody to `localhost` would send them to their own machine — where
    /// there is either nothing, or something else of theirs. The interface
    /// says so rather than offering a link that goes to the wrong place.
    pub available_here: bool,
    /// Whether a port needs forwarding at all.
    ///
    /// A worker that is a child process of this control plane shares this
    /// machine's network, so its dev server is already on `localhost`. There
    /// is nothing to tunnel, and forwarding anyway would bind a second port
    /// that loops out and straight back in.
    pub already_reachable: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewForward {
    /// The port inside the session's workspace.
    pub port: u16,
}

/// Ports open for this session, and whether opening one would help.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/forwards", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = Ports), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn list_forwards(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Ports>> {
    let id = SessionId::from_stored(id);
    let (_, host) = session_context(&state, &principal, &id).await?;

    Ok(Json(Ports {
        forwards: state.forwards.list(&id).await,
        available_here: available_here(&headers),
        already_reachable: already_reachable(&state, &host).await,
    }))
}

/// Open a port on this machine for one inside the session.
///
/// The same number whenever this machine will give it, because an application
/// that hardcodes its own address only works if it does.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/forwards", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    request_body = NewForward,
    responses(
        (status = 201, body = Forwarded),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
    ),
)]
pub(super) async fn create_forward(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<NewForward>,
) -> ApiResult<(StatusCode, Json<Forwarded>)> {
    let id = SessionId::from_stored(id);
    let (_, host) = session_context(&state, &principal, &id).await?;

    // Refused rather than opened uselessly. A port bound beside a control plane
    // somebody reached over the network is one nobody can see.
    if !available_here(&headers) {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this Firetower is not running on your machine, so it cannot open a port on it",
        ));
    }

    if already_reachable(&state, &host).await {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this session's worker runs on your machine, so its ports are already reachable",
        ));
    }

    state
        .forwards
        .start(&state.fleet, &host, &id, req.port)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
        .map(|forwarded| (StatusCode::CREATED, Json(forwarded)))
        // "nothing is listening on 3000 in this workspace" — a sentence
        // somebody can act on, which is the whole reason the worker connects
        // once before this returns.
        .map_err(|refused| ApiError::new(ErrorCode::InvalidRequest, refused))
}

/// Close a port opened for this session.
#[utoipa::path(
    delete, path = "/api/v1/sessions/{id}/forwards/{port}", tag = "sessions",
    params(
        ("id" = String, Path, description = "Session id"),
        ("port" = u16, Path, description = "The port inside the workspace"),
    ),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn delete_forward(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, port)): Path<(String, u16)>,
) -> ApiResult<StatusCode> {
    let id = SessionId::from_stored(id);
    session_context(&state, &principal, &id).await?;

    if state.forwards.stop(&id, port).await {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("forward"))
    }
}

/// Whether the browser that sent this request is on the machine we are on.
///
/// The address the interface was loaded from is the honest signal, and it is
/// the only one available: nothing else in a request says where the person
/// reading it is sitting.
fn available_here(headers: &HeaderMap) -> bool {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());

    crate::forward::Forwards::available_here(host)
}

/// Whether this session's ports are already on this machine's `localhost`.
///
/// True for a worker that is a child process here: it shares this machine's
/// network namespace, so its dev server is reachable without any of this. A
/// worker in a container publishes nothing and needs the tunnel, even when the
/// container is on this very machine.
async fn already_reachable(state: &AppState, host: &ft_core::HostId) -> bool {
    matches!(
        state.db.host_by_id(host).await,
        Ok(Some(host)) if host.compute == ft_core::Compute::Local
    )
}

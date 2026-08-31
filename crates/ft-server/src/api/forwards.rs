//! Reaching a port of a session's workspace.
//!
//! Two ways, and the interface uses the first.
//!
//! **A hostname.** [`preview_address`] hands back
//! `<session>-<port>-<signature>.localhost`, which needs nothing published and
//! works whether or not this control plane is in a container. See
//! [`crate::preview`].
//!
//! **A port on this machine.** The rest of this module. Only useful when the
//! control plane is a process on the machine holding the browser — not in a
//! container, which is how the production install ships — but it is what a
//! real port is for: curl, Postman, a phone on the same wifi. See
//! [`crate::forward`].

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
use utoipa::{IntoParams, ToSchema};

/// Where a session's port can be opened in a browser.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAddress {
    /// Ready to put in an `iframe` or paste into a tab.
    pub url: String,
    /// The port inside the session's workspace.
    pub port: u16,
}

#[derive(Debug, Deserialize, IntoParams)]
pub(super) struct WhichPort {
    /// The port inside the session's workspace.
    port: u16,
}

/// The address a session's port can be reached at.
///
/// Signed rather than stored, so it survives a restart of the control plane and
/// there is nothing to expire. Nothing is opened by asking: the tunnel is built
/// when the browser actually arrives, which is also when "nothing is listening
/// on 3000" would be found out — and that is a page saying so rather than an
/// error here, because by then a browser is looking at it.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/preview", tag = "sessions",
    params(("id" = String, Path, description = "Session id"), WhichPort),
    responses((status = 200, body = PreviewAddress), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn preview_address(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(id): Path<String>,
    axum::extract::Query(which): axum::extract::Query<WhichPort>,
) -> ApiResult<Json<PreviewAddress>> {
    let id = SessionId::from_stored(id);
    // Asked for the ownership check, not for the host: whoever opens the
    // address is admitted by its signature, and this is where we decide
    // whether they are allowed one at all.
    session_context(&state, &principal, &id).await?;

    let preview = crate::preview::Preview {
        session: id,
        port: which.port,
    };

    Ok(Json(PreviewAddress {
        url: state.names.url(scheme_of(&headers), &preview),
        port: which.port,
    }))
}

/// Behind Caddy this process is only ever spoken to over plain HTTP, so its own
/// connection says nothing about what the browser used. The proxy in front is
/// the only thing that knows, and this is how it says so.
fn scheme_of(headers: &HeaderMap) -> &'static str {
    let forwarded = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if forwarded.eq_ignore_ascii_case("https") {
        "https"
    } else {
        "http"
    }
}

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
    // A container is reached at `localhost` and binds its own loopback, which
    // is not the one the browser is on. The `Host` header cannot tell those
    // apart — it says the browser reached us at a loopback name, not that our
    // loopback is the browser's — so it is asked second.
    if crate::forward::Forwards::in_a_container() {
        return false;
    }

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
    // Not when we are in a container. The worker is then a child process
    // sharing the *container's* network, so its dev server is on a loopback
    // the browser cannot reach — and telling somebody to open `localhost:3000`
    // sends them to their own machine, which is the bug this whole check
    // exists to avoid.
    if crate::forward::Forwards::in_a_container() {
        return false;
    }

    matches!(
        state.db.host_by_id(host).await,
        Ok(Some(host)) if host.compute == ft_core::Compute::Local
    )
}

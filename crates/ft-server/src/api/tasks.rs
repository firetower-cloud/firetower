//! Listing what somebody could work on.
//!
//! A thin handler on purpose: everything about *what a task is* lives in
//! `crate::tasks`, so adding a second tracker is implementing a trait and
//! adding a line here rather than reworking a screen.

use axum::{
    extract::{Query as Params, State},
    Extension, Json,
};
use serde::Deserialize;

use crate::api::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::tasks::{self, Source, TaskKind, TaskState};
use crate::vault::{self, Key};
use crate::{providers, AppState};

/// Whose tasks. The same shape every handler here uses.
fn owner(principal: &Principal) -> Result<&str, ApiError> {
    principal
        .owner()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "sign in to use this Firetower"))
}

/// This person's token for a tracker, or the reason there isn't one.
///
/// Asked with their own credential so the answer is what *they* can see, and
/// charged to their own rate limit rather than to a pool.
///
/// Wrapped as the vault handed it over, rather than unwrapped for
/// convenience: it derefs to `&str` at every call site that needs one, and
/// keeping the wrapper is what erases it from memory afterwards.
async fn token_for(
    state: &AppState,
    principal: &Principal,
    provider: &crate::providers::Provider,
    why: &str,
) -> Result<zeroize::Zeroizing<String>, ApiError> {
    state
        .vault
        .get(Key::of(vault::GIT, provider.id, owner(principal)?), why)
        .await?
        .ok_or_else(|| {
            ApiError::new(
                ErrorCode::ProviderNotConnected,
                format!("{} hasn't been authorized yet", provider.label),
            )
        })
}

/// What to list.
///
/// `q` is passed to the source rather than parsed. The chips on screen write
/// into it and it is one string either way, which is what lets a second source
/// keep the same controls and speak its own dialect.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Listing {
    /// Which tracker. The only one today is `github`.
    pub source: Option<String>,
    /// `acme/web`, when the source has repositories.
    pub repo: Option<String>,
    /// `issue` or `pullRequest`.
    pub kind: Option<TaskKind>,
    /// `open` or `closed`.
    pub state: Option<TaskState>,
    /// Only what this person is assigned.
    #[serde(default)]
    pub mine: bool,
    /// The query box, verbatim.
    pub q: Option<String>,
    #[serde(default)]
    pub page: u32,
}

/// What could be worked on.
///
/// Read from the tracker every time rather than from a copy here. Issues are
/// somebody else's source of truth and change under us; a conditional request
/// that has not changed costs nothing, and one that has is exactly the moment
/// the new data is wanted.
#[utoipa::path(
    get, path = "/api/v1/tasks", tag = "tasks",
    params(
        ("source" = Option<String>, Query, description = "Which tracker; github by default"),
        ("repo" = Option<String>, Query, description = "acme/web, when the source has repositories"),
        ("kind" = Option<TaskKind>, Query, description = "issue or pullRequest"),
        ("state" = Option<TaskState>, Query, description = "open or closed"),
        ("mine" = Option<bool>, Query, description = "Only what you are assigned"),
        ("q" = Option<String>, Query, description = "The query box, passed to the source verbatim"),
        ("page" = Option<u32>, Query, description = "One-based"),
    ),
    responses(
        (status = 200, body = tasks::Page),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
    ),
)]
pub(super) async fn list_tasks(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Params(ask): Params<Listing>,
) -> ApiResult<Json<tasks::Page>> {
    let id = ask.source.as_deref().unwrap_or("github");
    let provider = providers::find(id).ok_or_else(|| ApiError::not_found("source"))?;

    let token = token_for(&state, &principal, provider, "listing tasks to work on").await?;

    // Scoped to what this Firetower is connected to unless somebody narrows it
    // further. A task list that answers about repositories you have never heard
    // of is not a task list.
    let connected = state
        .db
        .repos()
        .await?
        .into_iter()
        .map(|r| r.slug)
        .collect();

    let query = tasks::Query {
        repo: ask.repo,
        connected,
        kind: ask.kind,
        state: ask.state,
        mine: ask.mine,
        raw: ask.q,
        page: ask.page,
    };

    tasks::GitHub { provider }
        .list(&token, &query)
        .await
        .map(Json)
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))
}

/// What to look up. A link, because a link is what gets stored and pasted.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Locating {
    /// Which tracker. The only one today is `github`.
    pub source: Option<String>,
    /// Where a person would read it: `https://github.com/acme/web/issues/32`.
    pub url: String,
}

/// One task, by its link.
///
/// A workspace remembers the task it was cut for as a key and a URL — two
/// facts of ours that survive the tracker going down. Everything a person
/// wants to *see* about it (what it is called, whether it is still open) is
/// somebody else's, and is asked for here.
///
/// Whoever calls this must be able to carry on without it: an issue that
/// cannot be read is still an issue you can reference by number.
#[utoipa::path(
    get, path = "/api/v1/tasks/one", tag = "tasks",
    params(
        ("source" = Option<String>, Query, description = "Which tracker; github by default"),
        ("url" = String, Query, description = "Where a person would read it"),
    ),
    responses(
        (status = 200, body = tasks::Task),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
    ),
)]
pub(super) async fn get_task(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Params(ask): Params<Locating>,
) -> ApiResult<Json<tasks::Task>> {
    let id = ask.source.as_deref().unwrap_or("github");
    let provider = providers::find(id).ok_or_else(|| ApiError::not_found("source"))?;
    let token = token_for(&state, &principal, provider, "reading a task").await?;

    tasks::GitHub { provider }
        .one(&token, &ask.url)
        .await
        .map(Json)
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))
}

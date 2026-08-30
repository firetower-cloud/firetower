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

    // Asked with this person's token, so the list is what *they* can see — and
    // charged to their own rate limit rather than to a pool.
    let token = state
        .vault
        .get(
            Key::of(vault::GIT, provider.id, owner(&principal)?),
            "listing tasks to work on",
        )
        .await?
        .ok_or_else(|| {
            ApiError::new(
                ErrorCode::ProviderNotConnected,
                format!("{} hasn't been authorized yet", provider.label),
            )
        })?;

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

//! The event feed: a live stream, and the replay that backfills it.
//!
//! Both answer the same question from different distances, which is why they
//! share a cursor. A browser that lost the stream asks for everything since
//! the last sequence it saw and carries on.

use super::ApiResult;
use crate::AppState;
use axum::{
    extract::{Query, State},
    response::sse::{self, Sse},
    Json,
};
use ft_core::{Event, SessionId};
use futures::{Stream, StreamExt};
use serde::Deserialize;
use tokio_stream::wrappers::BroadcastStream;
use utoipa::ToSchema;

/// Replay, optionally for a single session.
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Replay {
    #[serde(default)]
    pub since: i64,
    #[serde(default)]
    pub session_id: Option<String>,
}

/// Replay. The live feed is the event stream; this is the backfill after a hard
/// refresh, and the fallback when a stream can't be held open.
#[utoipa::path(
    get, path = "/api/v1/events", tag = "events",
    params(
        ("since" = i64, Query, description = "Last sequence number seen"),
        ("sessionId" = Option<String>, Query, description = "Only this session's events"),
    ),
    responses((status = 200, body = Vec<Event>)),
)]
pub(super) async fn list_events(
    State(state): State<AppState>,
    Query(q): Query<Replay>,
) -> ApiResult<Json<Vec<Event>>> {
    let session = q.session_id.map(SessionId::from_stored);
    Ok(Json(
        state.db.events_since_for(q.since, session.as_ref()).await?,
    ))
}

/// The live feed.
///
/// Server-sent events rather than a socket: the data only ever flows down, and
/// the browser then supplies reconnection and replay for free. Each event
/// carries its sequence number as the SSE id, so a client that drops picks up
/// exactly where it left off via `Last-Event-ID` — the resume cursor is the
/// platform's problem, not ours.
#[utoipa::path(
    get, path = "/api/v1/events/stream", tag = "events",
    responses((status = 200, description = "text/event-stream of SessionEvent")),
)]
pub(super) async fn stream_events(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Sse<impl Stream<Item = Result<sse::Event, std::convert::Infallible>>> {
    let resume_from = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(i64::MAX); // no header: start live, no history replay

    // Anything the client missed, before anything new — so ordering holds
    // across a reconnect.
    let backlog = if resume_from == i64::MAX {
        Vec::new()
    } else {
        state.db.events_since(resume_from).await.unwrap_or_default()
    };

    // A lagging subscriber drops frames rather than blocking the fleet; the
    // client recovers by reconnecting with its last id.
    let live = BroadcastStream::new(state.fleet.subscribe()).filter_map(|r| async move { r.ok() });

    let stream = futures::stream::iter(backlog).chain(live).map(|event| {
        Ok(sse::Event::default()
            .id(event.seq.to_string())
            .event("session")
            .json_data(&event)
            .unwrap_or_else(|_| sse::Event::default().comment("unserialisable event")))
    });

    Sse::new(stream).keep_alive(
        sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("keep-alive"),
    )
}

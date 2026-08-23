//! What the agent said, and saying something back.
//!
//! The other half of a session from [`terminal`](super::terminal). A session
//! whose agent speaks a protocol is read here rather than attached to: the
//! browser gets a conversation it can draw — messages, tool calls, the question
//! that stopped it — instead of a screen it has to render.
//!
//! ## Why the events are derived on the way out
//!
//! What is stored is the lines the agent wrote, unread. Turning them into a
//! conversation happens here, per request, rather than once on the way in.
//! That costs a pass over the session every time somebody opens it, and buys
//! the thing that makes reading somebody else's output format survivable: the
//! mapping is not baked into the record. Correct it and every conversation
//! ever recorded is correct too, without a migration.

use axum::{
    extract::{Path, Query, State},
    response::sse::{self, Sse},
    Json,
};
use ft_core::normalise::ClaudeNormaliser;
use ft_core::{SessionId, TurnEvent};
use futures::stream::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::BroadcastStream;
use utoipa::ToSchema;

use super::{ApiError, ApiResult, ErrorCode};
use crate::fleet::AgentSpeech;
use crate::AppState;

/// One thing that happened, and where in the log it was said.
///
/// The line number travels with the event because several events can come from
/// one line, and a client's cursor has to be a position in the agent's log
/// rather than a count of what it drew.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEvent {
    pub line_no: u64,
    #[serde(flatten)]
    pub event: TurnEvent,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub events: Vec<ConversationEvent>,
    /// How far this reply got. Hand it back as `sinceLine` to continue.
    pub last_line: u64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Since {
    /// Zero, or absent, means the whole conversation.
    #[serde(default)]
    pub since_line: u64,
}

/// Everything the agent has said so far.
///
/// A snapshot. Use the stream for a session that is still running — this is for
/// one that has finished, and for a first paint that wants to be a single
/// request rather than a connection.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/conversation", tag = "sessions",
    params(
        ("id" = String, Path, description = "Session id"),
        ("sinceLine" = Option<u64>, Query, description = "Continue from this line"),
    ),
    responses((status = 200, body = Conversation), (status = 404, body = ApiError)),
)]
pub(super) async fn get_conversation(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(since): Query<Since>,
) -> ApiResult<Json<Conversation>> {
    let id = SessionId::from_stored(id);
    let lines = state
        .db
        .agent_lines_since(&id, 0)
        .await
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?;

    // Always normalised from the beginning, even when only the tail is wanted:
    // a tool result means nothing without the call it answers, and the
    // normaliser holds that. Cheaper than it looks — this is a fold over lines
    // already in memory — and correct, which the alternative is not.
    let mut normaliser = ClaudeNormaliser::new();
    let mut events = Vec::new();
    let mut last_line = 0;
    for (line_no, line) in lines {
        let line_no = line_no.max(0) as u64;
        last_line = line_no;
        for event in normaliser.push(&line) {
            if line_no > since.since_line {
                events.push(ConversationEvent { line_no, event });
            }
        }
    }

    Ok(Json(Conversation { events, last_line }))
}

/// The conversation as it happens.
///
/// Server-sent events, like the session feed: it only ever flows down, and the
/// browser supplies reconnection for free. Each event carries its line number
/// as the SSE id, so a client that drops resumes from `Last-Event-ID` and the
/// cursor is the platform's problem rather than ours.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/conversation/stream", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, description = "text/event-stream of ConversationEvent")),
)]
pub(super) async fn stream_conversation(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> ApiResult<Sse<impl Stream<Item = Result<sse::Event, std::convert::Infallible>>>> {
    let id = SessionId::from_stored(id);
    let session = state
        .db
        .session(&id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?
        .ok_or_else(|| ApiError::new(ErrorCode::NotFound, "no such session"))?;

    let resume_from = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);

    // Subscribing before reading is what closes the gap: a line that arrives
    // while the backlog is being replayed waits in the channel rather than
    // being missed, and is skipped below if the replay already had it.
    // A session on a host that is not answering still has a history worth
    // reading; it just will not grow while nobody can reach it.
    let already = state.db.last_agent_line(&id).await.unwrap_or(0).max(0) as u64;
    let live = match state
        .fleet
        .watch_agent(&session.host_id, &id, already)
        .await
    {
        Ok(receiver) => receiver,
        Err(e) => {
            tracing::debug!(session = %id, "not following live: {e:#}");
            tokio::sync::broadcast::channel(1).1
        }
    };

    let stored = state.db.agent_lines_since(&id, 0).await.unwrap_or_default();

    // One normaliser for the whole connection: the backlog leaves it holding
    // the state the live lines are about to need.
    let mut normaliser = ClaudeNormaliser::new();
    let mut backlog = Vec::new();
    let mut replayed = 0u64;
    for (line_no, line) in stored {
        let line_no = line_no.max(0) as u64;
        replayed = line_no;
        for event in normaliser.push(&line) {
            if line_no > resume_from {
                backlog.push(ConversationEvent { line_no, event });
            }
        }
    }

    let following = BroadcastStream::new(live)
        .filter_map(|frame| async move { frame.ok() })
        .flat_map(move |speech| {
            let events = match speech {
                AgentSpeech::Line { line_no, line } if line_no > replayed => normaliser
                    .push(&line)
                    .into_iter()
                    .map(|event| ConversationEvent { line_no, event })
                    .collect(),
                // Already replayed from the table above.
                AgentSpeech::Line { .. } => Vec::new(),
                // Approvals reach the browser as part of the conversation in
                // their own right; there is nothing in the log for them,
                // because the agent is blocked rather than talking.
                AgentSpeech::Asks { .. } | AgentSpeech::Closed => Vec::new(),
            };
            futures::stream::iter(events)
        });

    let stream = futures::stream::iter(backlog)
        .chain(following)
        .map(|event| {
            Ok(sse::Event::default()
                .id(event.line_no.to_string())
                .event("turn")
                .json_data(&event)
                .unwrap_or_else(|_| sse::Event::default().comment("unserialisable event")))
        });

    Ok(Sse::new(stream).keep_alive(
        sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub text: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Sent {
    pub sent: bool,
}

/// Say something to the agent.
///
/// A message rather than keystrokes, which is the difference that matters: it
/// cannot arrive while the agent is not listening, and it cannot be half-typed.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/turn", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    request_body = Turn,
    responses((status = 200, body = Sent), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn send_turn(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(turn): Json<Turn>,
) -> ApiResult<Json<Sent>> {
    let id = SessionId::from_stored(id);
    if turn.text.trim().is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "there is nothing to send",
        ));
    }
    let host = host_of(&state, &id).await?;

    state
        .fleet
        .send_turn(&host, &id, ft_core::turn::user_message(&turn.text))
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?;

    Ok(Json(Sent { sent: true }))
}

/// Stop what the agent is doing, without ending the session.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/interrupt", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = Sent), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn interrupt_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Sent>> {
    let id = SessionId::from_stored(id);
    let host = host_of(&state, &id).await?;

    state
        .fleet
        .interrupt(&host, &id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?;

    Ok(Json(Sent { sent: true }))
}

/// Which machine is holding this session's agent.
async fn host_of(state: &AppState, id: &SessionId) -> ApiResult<ft_core::HostId> {
    let session = state
        .db
        .session(id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?
        .ok_or_else(|| ApiError::new(ErrorCode::NotFound, "no such session"))?;

    Ok(session.host_id)
}

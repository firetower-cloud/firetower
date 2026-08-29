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
    Extension, Json,
};
use ft_core::normalise::Reader;
use ft_core::{SessionId, TurnEvent};
use futures::stream::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::BroadcastStream;
use utoipa::ToSchema;

use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
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
    let mut normaliser = reader_for(&state, &id).await;
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

/// Everything a session has said since `resume_from`, and everything it says
/// next.
///
/// Split out from the SSE handler so the multiplexed socket carries exactly the
/// same events as the endpoint it replaces — the normaliser, the backlog and
/// the gap-closing subscribe-before-read are all subtle enough that a second
/// copy would drift.
///
/// The caller has already established that this session is theirs.
pub(crate) async fn conversation_events(
    state: &AppState,
    host_id: &ft_core::HostId,
    id: &SessionId,
    resume_from: u64,
) -> impl Stream<Item = ConversationEvent> + Send {
    // Subscribing before reading is what closes the gap: a line that arrives
    // while the backlog is being replayed waits in the channel rather than
    // being missed, and is skipped below if the replay already had it.
    // A session on a host that is not answering still has a history worth
    // reading; it just will not grow while nobody can reach it.
    let already = state.db.last_agent_line(id).await.unwrap_or(0).max(0) as u64;
    let live = match state
        .fleet
        .watch_agent(host_id, id, already)
        .await
    {
        Ok(receiver) => receiver,
        Err(e) => {
            tracing::debug!(session = %id, "not following live: {e:#}");
            tokio::sync::broadcast::channel(1).1
        }
    };

    let stored = state.db.agent_lines_since(id, 0).await.unwrap_or_default();
    // Anything the agent is already blocked on, so opening a waiting session
    // shows the question rather than a transcript that stops for no reason.
    let waiting = state.fleet.asked(id).await;

    // One normaliser for the whole connection: the backlog leaves it holding
    // the state the live lines are about to need.
    let mut normaliser = reader_for(&state, &id).await;
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

    for question in waiting {
        if let AgentSpeech::Asks {
            req,
            tool_name,
            input,
        } = question
        {
            backlog.push(ConversationEvent {
                line_no: replayed,
                event: wanted(req, tool_name, input),
            });
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
                // A question is not in the log — the agent is blocked rather
                // than talking — so it carries the line it interrupted. That
                // keeps the resume cursor monotonic: a question stamped zero
                // would send a reconnecting client back to the start.
                AgentSpeech::Asks {
                    req,
                    tool_name,
                    input,
                } => vec![ConversationEvent {
                    line_no: replayed,
                    event: wanted(req, tool_name, input),
                }],
                AgentSpeech::Closed => Vec::new(),
            };
            futures::stream::iter(events)
        });

    futures::stream::iter(backlog).chain(following)
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
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> ApiResult<Sse<impl Stream<Item = Result<sse::Event, std::convert::Infallible>>>> {
    let id = SessionId::from_stored(id);
    // Somebody else's conversation is "no such session". This stream carries
    // everything an agent said and everything it was told, so it is the last
    // thing that should answer to an id somebody guessed.
    let session = state
        .db
        .session_of(owner(&principal)?, &id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?
        .ok_or_else(|| ApiError::new(ErrorCode::NotFound, "no such session"))?;

    let resume_from = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);

    let stream = conversation_events(&state, &session.host_id, &id, resume_from)
        .await
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
    /// Pictures pasted or dropped into the composer.
    ///
    /// Carried inside the message rather than written to the workspace: there
    /// is nothing to clean up afterwards and no approval prompt for reading a
    /// file somebody just handed over.
    #[serde(default)]
    pub images: Vec<ft_core::turn::Attached>,
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
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(turn): Json<Turn>,
) -> ApiResult<Json<Sent>> {
    let id = SessionId::from_stored(id);
    if turn.text.trim().is_empty() && turn.images.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "there is nothing to send",
        ));
    }
    let host = host_of(&state, &principal, &id).await?;

    state
        .fleet
        .send_turn(&host, &id, &turn.text, &turn.images)
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
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Sent>> {
    let id = SessionId::from_stored(id);
    let host = host_of(&state, &principal, &id).await?;

    state
        .fleet
        .interrupt(&host, &id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?;

    Ok(Json(Sent { sent: true }))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    /// Which question. The agent's own id for the call it is blocked on.
    pub req: String,
    pub decision: ft_core::turn::Decision,
}

/// Answer something the agent is waiting on.
///
/// Until this arrives the agent is stopped, holding the tool call open. There
/// is no timeout anywhere on that path: somebody may be asleep, and an agent
/// that gave up and denied would be worse than one that waited.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/answer", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    request_body = Answer,
    responses((status = 200, body = Sent), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn answer_request(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(answer): Json<Answer>,
) -> ApiResult<Json<Sent>> {
    let id = SessionId::from_stored(id);
    let host = host_of(&state, &principal, &id).await?;

    state
        .fleet
        .answer(&host, &id, answer.req, &answer.decision)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?;

    Ok(Json(Sent { sent: true }))
}

/// What the agent has stopped for, as the interface should draw it.
///
/// Two different things arrive through one channel, because both are tool calls
/// that fall through to the permission prompt. They are not the same question:
/// one asks whether something may happen, and the other asks which of several
/// things should. Drawn identically, the second becomes a card offering
/// "allow" and "deny" to a question about output format.
/// The pickers this session offers.
///
/// Per session rather than a constant in the browser, because which knobs a
/// session has is a fact about the agent it runs — and it was three constants
/// in a React file for as long as there was one agent to be right about.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/controls", tag = "conversation",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = Vec<ft_core::controls::Control>), (status = 404, body = ApiError)),
)]
pub(super) async fn session_controls(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<ft_core::controls::Control>>> {
    let id = SessionId::from_stored(id);
    // For the ownership check, which is the whole reason to look it up.
    host_of(&state, &principal, &id).await?;
    Ok(Json(state.fleet.controls(&id).await))
}

/// What to change, and to what.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Chosen {
    pub kind: ft_core::controls::ControlKind,
    pub value: String,
}

/// Change one of them.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/controls", tag = "conversation",
    params(("id" = String, Path, description = "Session id")),
    request_body = Chosen,
    responses((status = 200, body = Sent), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn choose_control(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(chosen): Json<Chosen>,
) -> ApiResult<Json<Sent>> {
    let id = SessionId::from_stored(id);
    let host = host_of(&state, &principal, &id).await?;

    state
        .fleet
        .choose(&host, &id, chosen.kind, &chosen.value)
        .await
        .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;

    Ok(Json(Sent { sent: true }))
}

/// The reader for whichever agent wrote this session's lines.
///
/// A session whose agent cannot be looked up is read as Claude Code: it is the
/// older shape, and reading a Codex line with it produces nothing rather than
/// something wrong.
async fn reader_for(state: &AppState, id: &SessionId) -> Reader {
    let agent = state
        .db
        .session_agent(id)
        .await
        .ok()
        .flatten()
        .map(|(agent, _)| agent)
        .unwrap_or(ft_core::Agent::ClaudeCode);
    Reader::for_agent(agent)
}

fn wanted(req: String, tool_name: String, input: serde_json::Value) -> TurnEvent {
    if let Some(questions) = ft_core::normalise::questions_from_input(&input) {
        if !questions.is_empty() {
            return TurnEvent::UserInputRequested {
                req: ft_core::RequestId::new(req),
                questions,
            };
        }
    }
    TurnEvent::RequestOpened {
        req: ft_core::RequestId::new(req),
        kind: ft_core::normalise::classify_request(&tool_name),
        detail: tool_name,
        args: input,
    }
}

/// A denial, said in a way the agent will act on rather than distrust.
///
/// The reason is attributed rather than stated. A tool result that simply says
/// "call it pear.txt instead" reads to an agent exactly like an instruction
/// smuggled into data, and a good one refuses it — one did, in testing, and
/// reported the redirection as a prompt injection attempt instead of following
/// it. Which is correct behaviour, and the reason this wrapping exists: the
/// sentence really is from the person watching, so it should say so.
///
/// It does not make the agent obey. It makes an instruction from a person
/// distinguishable from one that arrived in a tool's output, which is the only
/// thing we can honestly offer.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// What it was called. Only the last part is kept, and it is scrubbed.
    pub name: String,
    /// The bytes, base64.
    pub data: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Placed {
    /// Where it landed, relative to the workspace — which is what to say to the
    /// agent, and what it can act on.
    pub path: String,
}

/// Put a file into the session's workspace.
///
/// For everything that is not a picture. A picture goes inside the message,
/// because the model looks at it; anything else is better as a file the agent
/// can read, grep, unzip or edit with the tools it already has — and it costs
/// nothing until it does, so a large archive never has to fit in a prompt.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/attach", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    request_body = Attachment,
    responses((status = 200, body = Placed), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn attach_file(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(file): Json<Attachment>,
) -> ApiResult<Json<Placed>> {
    let id = SessionId::from_stored(id);
    let host = host_of(&state, &principal, &id).await?;

    let path = state
        .fleet
        .run_action(
            &host,
            &id,
            ft_proto::Action::Attach {
                name: file.name,
                data: file.data,
            },
            None,
        )
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
        .map_err(|why| ApiError::new(ErrorCode::ActionFailed, why))?;

    Ok(Json(Placed { path }))
}

/// Whose sessions a request means.
fn owner(principal: &Principal) -> Result<&str, ApiError> {
    principal.owner().ok_or_else(|| {
        ApiError::new(
            ErrorCode::Unauthorized,
            "a session belongs to an account, and authentication is switched off",
        )
    })
}

/// Which machine is holding this session's agent.
async fn host_of(
    state: &AppState,
    principal: &Principal,
    id: &SessionId,
) -> ApiResult<ft_core::HostId> {
    let session = state
        .db
        .session_of(owner(principal)?, id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?
        .ok_or_else(|| ApiError::new(ErrorCode::NotFound, "no such session"))?;

    Ok(session.host_id)
}

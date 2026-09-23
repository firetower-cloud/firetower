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
    /// The first line this reply covers.
    ///
    /// Hand it back as `before` to read the exchange in front of it. Equal to
    /// the log's own first line when there is nothing earlier, which is also
    /// when `hasMore` is false.
    pub first_line: u64,
    /// Whether there is anything before `firstLine` still to read.
    ///
    /// Always false when neither `tail` nor `before` was asked for, because
    /// then this reply is the whole conversation.
    pub has_more: bool,
}

/// How much of a conversation to send, and from where.
///
/// Absent fields mean what every client meant before any of them existed: the
/// whole thing, from the beginning. An old client sends none of these and gets
/// back exactly what it always did.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Since {
    /// Zero, or absent, means the whole conversation.
    #[serde(default)]
    pub since_line: u64,
    /// How many exchanges to send, counting back from the end.
    ///
    /// An exchange is one thing somebody said and everything the agent did
    /// about it — what a person means by "message" when they ask for the last
    /// twenty. Absent means all of them.
    pub tail: Option<u32>,
    /// Read the exchanges *before* this line instead of the last ones.
    ///
    /// The `firstLine` of the page already in hand. Needs `tail` beside it to
    /// say how many; on its own it does nothing, because "everything before
    /// line n" is not a page, it is the same unbounded read with a smaller
    /// number on it.
    pub before: Option<u64>,
    /// A ceiling on how many events one reply may carry.
    ///
    /// One exchange can be enormous — a turn that read forty files, or one
    /// carrying a screenshot — so a page counted only in exchanges is not
    /// bounded in any way a phone cares about. Exchanges are dropped from the
    /// front of the page until it fits, never past the last one.
    pub max_events: Option<u32>,
}

/// The ceiling when a caller does not name one.
///
/// Generous: this is a backstop against one pathological turn, not the page
/// size. The page size is `tail`, and a page that routinely hits this means
/// the caller asked for too many exchanges.
const MOST_EVENTS: u32 = 4000;

/// Whether this event is where one exchange ends and the next begins.
///
/// A page has to be cut somewhere, and the only safe place is between
/// exchanges. Cut anywhere else and an item is split across two pages — a
/// `ContentDelta` whose `ItemStarted` is on the other page is dropped on the
/// floor by every client that folds it, because `apply` has nothing to append
/// it to and says so by doing nothing.
///
/// A subagent's messages are not boundaries. They are the agent talking to
/// itself inside somebody else's turn, and cutting there would put half a
/// turn on each page.
fn opens_an_exchange(event: &TurnEvent) -> bool {
    matches!(
        event,
        TurnEvent::ItemStarted {
            kind: ft_core::turn::ItemKind::UserMessage,
            task: None,
            ..
        }
    )
}

/// The few events a page cannot be read without, wherever they happened.
///
/// `SessionConfigured` is said once, at the top of the log: a page cut after it
/// leaves the model picker blank and the slash-command list empty. A plan and a
/// limit replace rather than accumulate, so only the last one before the window
/// is worth carrying — and carrying it is the difference between a paged
/// transcript and one that has quietly forgotten what it is running.
///
/// Returned as indices rather than events so nothing has to be cloned.
fn carried(all: &[ConversationEvent], start: usize) -> Vec<usize> {
    let mut configured = None;
    let mut planned = None;
    let mut limited = None;

    for (at, held) in all[..start].iter().enumerate() {
        match held.event {
            TurnEvent::SessionConfigured { .. } => configured = Some(at),
            TurnEvent::PlanUpdated { .. } => planned = Some(at),
            TurnEvent::Limited { .. } => limited = Some(at),
            _ => {}
        }
    }

    let mut out: Vec<usize> = [configured, planned, limited]
        .into_iter()
        .flatten()
        .collect();
    out.sort_unstable();
    out
}

/// Which slice of the folded conversation a request is asking for.
///
/// Half-open, as an index into the events. `(0, all.len())` is the whole
/// thing, which is what an absent `tail` means and therefore what every client
/// written before this existed gets.
fn window(all: &[ConversationEvent], opens: &[usize], want: &Since) -> (usize, usize) {
    let Some(tail) = want.tail.filter(|n| *n > 0) else {
        return (0, all.len());
    };

    // A page ends where the one the caller already has begins.
    let end = match want.before {
        Some(before) => all.partition_point(|held| held.line_no < before),
        None => all.len(),
    };

    // Only the exchanges that open inside what is left.
    let reachable = &opens[..opens.partition_point(|&at| at < end)];

    // The nth exchange back — or the very beginning, when there are fewer than
    // that. The beginning is index zero rather than the first exchange's own
    // start, because what comes before the first exchange is the bring-up and
    // the session's configuration, and a first page without those is a first
    // page missing its head.
    let mut nth = reachable.len().saturating_sub(tail as usize);
    let mut start = if nth == 0 { 0 } else { reachable[nth] };

    // Drop exchanges off the front until the page fits, but never the last
    // one: a page with nothing in it is worse than a page that is too big.
    // This applies even when the whole conversation was asked for — one
    // pathological turn is exactly the case the ceiling exists for, and a
    // short session is not automatically a small one.
    let cap = want.max_events.unwrap_or(MOST_EVENTS).max(1) as usize;
    while nth + 1 < reachable.len() && end - start > cap {
        nth += 1;
        start = reachable[nth];
    }

    (start, end)
}

/// Everything the agent has said so far — or the last few exchanges of it.
///
/// A snapshot, and what a client opens a session with: one request, folded in
/// one pass, rather than a backlog arriving down the stream an event at a time
/// — which a screen following the end of a transcript draws as the whole
/// conversation being typed out again. The stream is what carries it from
/// there, resumed at `lastLine`.
///
/// ## Why the window is on the way out rather than in the query
///
/// The obvious pagination is `LIMIT`, and it cannot be done here. What is
/// stored is the agent's raw log, one row per line; an exchange is tens to
/// thousands of those, a line normalises into zero or more events, and the
/// normaliser has to have seen every line before a given one to be right about
/// it. There is no row anybody can point at and call the twentieth message
/// from the end without having read everything in front of it.
///
/// So the read and the fold are unchanged, and only what is *serialised* is
/// cut. That leaves the cost where it is cheap — a local table and a fold in
/// this process — and takes it off the wire, which for a phone on a mobile
/// network is the part measured in seconds. A session whose transcript carries
/// a year of pasted screenshots sends the last two exchanges of them.
///
/// If the fold itself ever becomes the cost, the answer is a derived index of
/// where each exchange starts, and a normaliser seeded to that point. That is
/// a migration, a backfill and a new way for the index to disagree with the
/// log, so it wants a measurement first.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/conversation", tag = "sessions",
    params(
        ("id" = String, Path, description = "Session id"),
        ("sinceLine" = Option<u64>, Query, description = "Continue from this line"),
        ("tail" = Option<u32>, Query, description = "Only the last N exchanges. Absent means all of them."),
        ("before" = Option<u64>, Query, description = "The N exchanges before this line, rather than the last N"),
        ("maxEvents" = Option<u32>, Query, description = "Ceiling on events in one reply. 4000 by default."),
    ),
    responses((status = 200, body = Conversation), (status = 404, body = ApiError)),
)]
pub(super) async fn get_conversation(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Query(since): Query<Since>,
) -> ApiResult<Json<Conversation>> {
    let id = SessionId::from_stored(id);

    // Somebody else's conversation is "no such session", as it is on the stream
    // beside this. Both carry everything an agent said and everything it was
    // told; this one went without the check while it was the endpoint nothing
    // called, and it is now how every session is opened.
    state
        .db
        .session_of(owner(&principal)?, &id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?
        .ok_or_else(|| ApiError::new(ErrorCode::NotFound, "no such session"))?;

    let normaliser = reader_for(&state, &id).await;

    paged(&state.db, &id, normaliser, &since)
        .await
        .map(Json)
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))
}

/// Read a session's log, fold it, and cut the page that was asked for.
///
/// Split out from the handler so it can be exercised against a real database
/// holding real agent output. The handler's own half — whose session this is,
/// and which normaliser the agent needs — is the part that needs an
/// `AppState`; this is the part that needs lines, and the two tested together
/// only ever proved that the router works.
async fn paged(
    db: &crate::db::Db,
    id: &SessionId,
    mut normaliser: Reader,
    since: &Since,
) -> anyhow::Result<Conversation> {
    let lines = db.agent_lines_since(id, 0).await?;

    // Always normalised from the beginning, even when only the tail is wanted:
    // a tool result means nothing without the call it answers, and the
    // normaliser holds that. Cheaper than it looks — this is a fold over lines
    // already in memory — and correct, which the alternative is not.
    let mut all: Vec<ConversationEvent> = Vec::new();
    // Where each exchange starts, as an index into `all`.
    let mut opens: Vec<usize> = Vec::new();
    let mut last_line = 0;
    for (line_no, line) in lines {
        let line_no = line_no.max(0) as u64;
        last_line = line_no;
        // The boundary is the start of the *line*, not of the event that
        // announced it. `TurnStarted` comes off the same line as the message
        // that began the turn, and a page that cut between the two would open
        // with an agent that is not working on a turn nobody started.
        let began = all.len();
        let mut opened = false;
        for event in normaliser.push(&line) {
            if !opened && opens_an_exchange(&event) {
                opens.push(began);
                opened = true;
            }
            all.push(ConversationEvent { line_no, event });
        }
    }

    let (start, end) = window(&all, &opens, since);
    let keep = carried(&all, start);
    let has_more = start > 0;
    // The window's own first line, not the carried events' — those are older by
    // definition, and a client handing one back as `before` would ask for the
    // same page again for ever.
    let first_line = all.get(start).map(|held| held.line_no).unwrap_or(last_line);

    let events = all
        .into_iter()
        .enumerate()
        .filter(|(at, _)| (*at >= start && *at < end) || keep.contains(at))
        .map(|(_, held)| held)
        .filter(|held| held.line_no > since.since_line)
        .collect();

    Ok(Conversation {
        events,
        last_line,
        first_line,
        has_more,
    })
}

/// Everything a session has said since `resume_from`, and everything it says
/// next — **one log line at a time**.
///
/// Split out from the SSE handler so the multiplexed socket carries exactly the
/// same events as the endpoint it replaces — the normaliser, the backlog and
/// the gap-closing subscribe-before-read are all subtle enough that a second
/// copy would drift.
///
/// ## Why a line, and not an event
///
/// One line of the agent's log normalises into several events, and a client's
/// resume cursor is a position in *that log* — so an event is not a place it
/// can stop. Delivered one event at a time, a client that dropped after two of
/// a line's three had the cursor of a line it had only partly applied: it
/// resumed past the third, which was then lost for good. It could not simply
/// be re-sent either, because `ContentDelta` appends — a line delivered twice
/// is a paragraph written twice.
///
/// Yielding whole lines makes the boundary exact in both directions. Every
/// event of a line arrives together or not at all, so a cursor is only ever
/// between lines, where re-sending and skipping are both impossible.
///
/// The caller has already established that this session is theirs.
pub(crate) async fn conversation_events(
    state: &AppState,
    host_id: &ft_core::HostId,
    id: &SessionId,
    resume_from: u64,
) -> impl Stream<Item = Vec<ConversationEvent>> + Send {
    // Subscribing before reading is what closes the gap: a line that arrives
    // while the backlog is being replayed waits in the channel rather than
    // being missed, and is skipped below if the replay already had it.
    // A session on a host that is not answering still has a history worth
    // reading; it just will not grow while nobody can reach it.
    let already = state.db.last_agent_line(id).await.unwrap_or(0).max(0) as u64;
    let live = match state.fleet.watch_agent(host_id, id, already).await {
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
    let mut normaliser = reader_for(state, id).await;
    let mut backlog: Vec<Vec<ConversationEvent>> = Vec::new();
    let mut replayed = 0u64;
    let mut echoed: Vec<String> = Vec::new();
    let mut gathering: std::collections::HashMap<String, String> = Default::default();
    for (line_no, line) in stored {
        let line_no = line_no.max(0) as u64;
        replayed = line_no;
        let mut batch = Vec::new();
        for event in normaliser.push(&line) {
            // What the agent has said back, so a message still waiting to be
            // echoed can be told from one that already has been. The text
            // arrives as deltas against the item, so it has to be gathered
            // rather than read off the ending.
            match &event {
                ft_core::TurnEvent::ItemStarted {
                    item,
                    kind: ft_core::turn::ItemKind::UserMessage,
                    ..
                } => {
                    gathering.insert(item.as_str().to_string(), String::new());
                }
                ft_core::TurnEvent::ContentDelta { item, delta, .. } => {
                    if let Some(held) = gathering.get_mut(item.as_str()) {
                        held.push_str(delta);
                    }
                }
                ft_core::TurnEvent::ItemCompleted { item, .. } => {
                    if let Some(said) = gathering.remove(item.as_str()) {
                        echoed.push(said);
                    }
                }
                _ => {}
            }
            if line_no > resume_from {
                batch.push(ConversationEvent { line_no, event });
            }
        }
        deliver(&mut backlog, batch);
    }

    // Anything typed at this session that the agent has not repeated back yet.
    //
    // A transcript is the agent's own output replayed, so until the echo
    // arrives there is nothing here to draw and the message somebody sent
    // simply was not on the screen after a reload. An agent in the middle of a
    // long command does not echo for as long as that command runs.
    state.fleet.echoed(id, &echoed).await;
    for pending in state.fleet.typed(id).await {
        replayed += 1;
        let item = ft_core::turn::ItemId::new(format!("pending-{}", pending.at.timestamp_millis()));
        // The three together, as one line: the delta is the message's whole
        // text, so a client that took the start and missed this would show an
        // empty bubble, and one that took it twice would show it twice.
        deliver(
            &mut backlog,
            vec![
                ConversationEvent {
                    line_no: replayed,
                    event: ft_core::TurnEvent::ItemStarted {
                        item: item.clone(),
                        kind: ft_core::turn::ItemKind::UserMessage,
                        title: None,
                        task: None,
                    },
                },
                ConversationEvent {
                    line_no: replayed,
                    event: ft_core::TurnEvent::ContentDelta {
                        item: item.clone(),
                        stream: ft_core::turn::StreamKind::UserText,
                        delta: pending.text.clone(),
                    },
                },
                ConversationEvent {
                    line_no: replayed,
                    event: ft_core::TurnEvent::ItemCompleted {
                        item,
                        status: ft_core::turn::ItemStatus::Completed,
                    },
                },
            ],
        );
    }

    let asking: Vec<ConversationEvent> = waiting
        .into_iter()
        .filter_map(|question| match question {
            AgentSpeech::Asks {
                req,
                tool_name,
                input,
            } => Some(ConversationEvent {
                line_no: replayed,
                event: wanted(req, tool_name, input),
            }),
            _ => None,
        })
        .collect();
    deliver(&mut backlog, asking);

    let following = BroadcastStream::new(live)
        .filter_map(|frame| async move { frame.ok() })
        .filter_map(move |speech| {
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
            // Every event here came off one line, so the batch is already a
            // whole one. An empty batch is a line that drew nothing.
            async move { (!events.is_empty()).then_some(events) }
        });

    futures::stream::iter(backlog).chain(following)
}

/// Add a line's events to the backlog, keeping one batch per line number.
///
/// The typed messages and the open questions are stamped with the last line the
/// agent wrote rather than lines of their own, so two of these can share a
/// number. They have to go out together: a cursor sitting on that number means
/// "everything stamped with it has been applied", and that has to be true of
/// all of it or none.
fn deliver(backlog: &mut Vec<Vec<ConversationEvent>>, batch: Vec<ConversationEvent>) {
    let Some(line_no) = batch.first().map(|e| e.line_no) else {
        return;
    };
    match backlog.last_mut() {
        Some(last) if last[0].line_no == line_no => last.extend(batch),
        _ => backlog.push(batch),
    }
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
        // Flattened back out: this endpoint's cursor is `Last-Event-ID`, which
        // the browser sets from whatever it saw last and we do not control. The
        // socket is where the exact boundary lives.
        .flat_map(futures::stream::iter)
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
    let who = owner(&principal)?.to_string();
    let session = state
        .db
        .session_of(&who, &id)
        .await?
        .ok_or_else(|| ApiError::new(ErrorCode::NotFound, "no such session"))?;
    super::accounts::ensure_not_switching(&state.db, &id).await?;
    let host = session.host_id.clone();

    // Speaking to a session whose agent has gone brings it back first.
    //
    // The ordinary way to arrive here is an upgrade: recreating the container
    // ends every agent on the machine, and the first anybody knows of it is
    // typing into one. Making that restart the agent rather than report a
    // corpse is the difference between an upgrade being invisible and every
    // workspace on the machine being abandoned.
    //
    // Only from `Failed`, which is the state a worker error puts a session in,
    // so this cannot fire for a session that is merely busy. And only once: the
    // relaunch either works or leaves the same state behind, and the next
    // message is somebody deciding to try again rather than a loop.
    if session.status == ft_core::SessionStatus::Failed {
        crate::api::sessions::relaunch(&state, &session, &who).await?;
        // Long enough for the supervisor to bind its socket, which is all this
        // is waiting for — the agent behind it can still be starting, because
        // what we send lands on a pipe it will read when it is ready. If it is
        // not there even so, the turn fails the way it did before and now says
        // so.
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }

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
    super::accounts::ensure_not_switching(&state.db, &id).await?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use ft_core::turn::{ItemId, ItemKind, ItemStatus, StreamKind, TurnId};

    /// What `get_conversation` builds before it windows: every event of a
    /// folded log, and where each exchange starts.
    ///
    /// Built here rather than by normalising fixture lines because the thing
    /// under test is the cut, not the fold. The fold has its own tests in
    /// `ft-core`, and going through it would make every case here depend on
    /// one agent's output format.
    struct Folded {
        all: Vec<ConversationEvent>,
        opens: Vec<usize>,
    }

    impl Folded {
        fn new() -> Self {
            Self {
                all: Vec::new(),
                opens: Vec::new(),
            }
        }

        /// One line, and everything it normalised into. Mirrors the loop in
        /// the handler, including that a boundary marks the line's first
        /// event rather than the event that announced it.
        fn line(&mut self, line_no: u64, events: Vec<TurnEvent>) -> &mut Self {
            let began = self.all.len();
            let mut opened = false;
            for event in events {
                if !opened && opens_an_exchange(&event) {
                    self.opens.push(began);
                    opened = true;
                }
                self.all.push(ConversationEvent { line_no, event });
            }
            self
        }

        /// One exchange: somebody speaks, the agent answers, the turn ends.
        ///
        /// Three lines, because a page that cuts in the wrong place is only
        /// visible when an exchange is more than one.
        fn exchange(&mut self, nth: u64) -> &mut Self {
            let at = nth * 10;
            let item = ItemId::new(format!("msg-{nth}"));
            self.line(
                at,
                vec![
                    TurnEvent::TurnStarted {
                        turn: TurnId::new(format!("turn-{nth}")),
                    },
                    TurnEvent::ItemStarted {
                        item: item.clone(),
                        kind: ItemKind::UserMessage,
                        title: None,
                        task: None,
                    },
                    TurnEvent::ContentDelta {
                        item: item.clone(),
                        stream: StreamKind::UserText,
                        delta: format!("ask {nth}"),
                    },
                    TurnEvent::ItemCompleted {
                        item,
                        status: ItemStatus::Completed,
                    },
                ],
            );
            let said = ItemId::new(format!("said-{nth}"));
            self.line(
                at + 1,
                vec![TurnEvent::ItemStarted {
                    item: said.clone(),
                    kind: ItemKind::AssistantMessage,
                    title: None,
                    task: None,
                }],
            );
            self.line(
                at + 2,
                vec![TurnEvent::ContentDelta {
                    item: said,
                    stream: StreamKind::AssistantText,
                    delta: format!("answer {nth}"),
                }],
            );
            self
        }
    }

    /// A conversation that opens with its configuration, then `n` exchanges.
    fn folded(n: u64) -> Folded {
        let mut it = Folded::new();
        it.line(
            1,
            vec![TurnEvent::SessionConfigured {
                model: "opus".into(),
                mode: "acceptEdits".into(),
                tools: vec![],
                commands: vec![],
            }],
        );
        for nth in 1..=n {
            it.exchange(nth);
        }
        it
    }

    fn want(tail: Option<u32>, before: Option<u64>) -> Since {
        Since {
            since_line: 0,
            tail,
            before,
            max_events: None,
        }
    }

    /// The lines a page covers, which is what a client sees as the transcript.
    fn lines(events: &[ConversationEvent]) -> Vec<u64> {
        let mut out: Vec<u64> = events.iter().map(|e| e.line_no).collect();
        out.dedup();
        out
    }

    /// Everything a page carries, windowed and with the sticky events in front
    /// — the handler's own output, without the database.
    fn page(it: &Folded, want: &Since) -> (Vec<u64>, bool, u64) {
        let (start, end) = window(&it.all, &it.opens, want);
        let keep = carried(&it.all, start);
        let events: Vec<ConversationEvent> = it
            .all
            .iter()
            .enumerate()
            .filter(|(at, _)| (*at >= start && *at < end) || keep.contains(at))
            .map(|(_, held)| ConversationEvent {
                line_no: held.line_no,
                event: held.event.clone(),
            })
            .filter(|held| held.line_no > want.since_line)
            .collect();
        let first_line = it.all.get(start).map(|h| h.line_no).unwrap_or(0);
        (lines(&events), start > 0, first_line)
    }

    /// The whole point of the backward-compatibility promise: a client that
    /// knows nothing about paging asks for nothing and gets what it always
    /// got.
    #[test]
    fn no_paging_asked_for_is_the_whole_conversation() {
        let it = folded(4);
        let (start, end) = window(&it.all, &it.opens, &want(None, None));

        assert_eq!((start, end), (0, it.all.len()));
        let (drawn, more, first) = page(&it, &want(None, None));
        assert_eq!(
            drawn,
            vec![1, 10, 11, 12, 20, 21, 22, 30, 31, 32, 40, 41, 42]
        );
        assert!(!more, "there is nothing before the beginning");
        assert_eq!(first, 1);
    }

    #[test]
    fn a_tail_is_the_last_exchanges_whole() {
        let it = folded(4);
        let (drawn, more, first) = page(&it, &want(Some(2), None));

        // Exchanges three and four, every line of both — and *not* line 20.
        assert_eq!(drawn, vec![1, 30, 31, 32, 40, 41, 42]);
        assert!(more, "there are two exchanges in front of this page");
        // The window's own start, not the configuration carried in front of it.
        assert_eq!(first, 30);
    }

    /// The cut is between exchanges, never inside one. An item whose
    /// `ItemStarted` is on the other side of the cut has its deltas dropped by
    /// every client that folds them, so this is the property that matters most.
    #[test]
    fn a_page_never_splits_an_exchange() {
        let it = folded(5);
        for tail in 1..=5 {
            let (start, end) = window(&it.all, &it.opens, &want(Some(tail), None));
            if start == 0 {
                continue;
            }
            let opened = matches!(
                it.all[start].event,
                TurnEvent::TurnStarted { .. } | TurnEvent::ItemStarted { .. }
            );
            assert!(opened, "tail={tail} cut at {:?}", it.all[start].event);
            assert_eq!(end, it.all.len());
        }
    }

    /// `TurnStarted` comes off the same line as the message that began the
    /// turn. A page that began at the message instead of at the line would
    /// open with the agent idle on a turn nobody started.
    #[test]
    fn a_page_opens_with_the_turn_not_the_message() {
        let it = folded(3);
        let (start, _) = window(&it.all, &it.opens, &want(Some(1), None));

        assert!(matches!(it.all[start].event, TurnEvent::TurnStarted { .. }));
    }

    /// Asking for more exchanges than there are is the beginning — including
    /// what came before the first exchange, which is where the session says
    /// what it is running.
    #[test]
    fn a_tail_longer_than_the_conversation_is_the_conversation() {
        let it = folded(2);
        let (start, end) = window(&it.all, &it.opens, &want(Some(9), None));

        assert_eq!((start, end), (0, it.all.len()));
        assert!(!page(&it, &want(Some(9), None)).1);
    }

    /// Paging back and the tail meet exactly: no line is in both, and no line
    /// is in neither.
    #[test]
    fn the_pages_tile_the_conversation() {
        let it = folded(6);

        let mut seen: Vec<u64> = Vec::new();
        let mut before = None;
        loop {
            let asking = want(Some(2), before);
            let (start, end) = window(&it.all, &it.opens, &asking);
            let mut covered: Vec<u64> = it.all[start..end].iter().map(|e| e.line_no).collect();
            covered.dedup();
            covered.extend(seen);
            seen = covered;

            if start == 0 {
                break;
            }
            before = Some(it.all[start].line_no);
        }

        assert_eq!(seen, lines(&it.all), "every line, once, in order");
    }

    /// A page cut after the configuration would leave the model picker blank
    /// and the slash commands empty, which reads as an agent that forgot what
    /// it is.
    #[test]
    fn the_configuration_is_carried_onto_every_page() {
        let it = folded(4);
        let (start, _) = window(&it.all, &it.opens, &want(Some(1), None));
        let keep = carried(&it.all, start);

        assert_eq!(keep.len(), 1);
        assert!(matches!(
            it.all[keep[0]].event,
            TurnEvent::SessionConfigured { .. }
        ));
        assert!(keep[0] < start, "carried from before the window");
    }

    /// Only the most recent plan, because a plan replaces rather than
    /// accumulates — three carried plans would draw the oldest one last.
    #[test]
    fn only_the_last_plan_is_carried() {
        let mut it = folded(0);
        it.line(2, vec![TurnEvent::PlanUpdated { steps: vec![] }]);
        it.exchange(1);
        it.line(15, vec![TurnEvent::PlanUpdated { steps: vec![] }]);
        it.exchange(2);

        let (start, _) = window(&it.all, &it.opens, &want(Some(1), None));
        let keep = carried(&it.all, start);
        let plans: Vec<u64> = keep
            .iter()
            .filter(|at| matches!(it.all[**at].event, TurnEvent::PlanUpdated { .. }))
            .map(|at| it.all[*at].line_no)
            .collect();

        assert_eq!(plans, vec![15]);
    }

    /// An exchange is not a size. One turn that read forty files can be bigger
    /// than the twenty before it put together, so the ceiling drops exchanges
    /// off the front until the page fits.
    #[test]
    fn a_ceiling_trims_exchanges_off_the_front() {
        let it = folded(5);
        let asking = Since {
            since_line: 0,
            tail: Some(4),
            before: None,
            max_events: Some(6),
        };
        let (start, end) = window(&it.all, &it.opens, &asking);

        assert!(
            end - start <= 6,
            "{} events is over the ceiling",
            end - start
        );
        assert!(start > 0, "trimmed rather than serving the whole thing");
    }

    /// And never past the last exchange: a page with nothing in it is worse
    /// than one that is too big.
    #[test]
    fn a_ceiling_never_empties_a_page() {
        let it = folded(3);
        let asking = Since {
            since_line: 0,
            tail: Some(3),
            before: None,
            max_events: Some(1),
        };
        let (start, end) = window(&it.all, &it.opens, &asking);

        assert!(end > start, "the last exchange survives any ceiling");
        assert_eq!(start, *it.opens.last().unwrap());
    }

    /// A subagent talks to itself inside somebody else's turn. Cutting there
    /// would put half an exchange on each page.
    #[test]
    fn a_subagents_message_is_not_a_boundary() {
        let spoken = TurnEvent::ItemStarted {
            item: ItemId::new("sub"),
            kind: ItemKind::UserMessage,
            title: None,
            task: Some(ft_core::turn::TaskId::new("task-1")),
        };
        assert!(!opens_an_exchange(&spoken));
    }

    /// The boundary against a real recording, rather than against events we
    /// wrote ourselves.
    ///
    /// Everything above builds its own `TurnEvent`s, which proves the cut is
    /// consistent and proves nothing about whether a real agent's log produces
    /// anything to cut *at*. These are the same captures `ft-core` normalises
    /// against — real `claude -p --output-format stream-json` sessions — so if
    /// Claude Code stops echoing what somebody typed, this is where it shows
    /// up rather than on a phone.
    fn replay(name: &str) -> (Vec<ConversationEvent>, Vec<usize>) {
        let path = format!(
            "{}/../ft-core/tests/streams/{name}.ndjson",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {path}: {e}"));

        let mut normaliser = Reader::for_agent(ft_core::Agent::ClaudeCode);
        let mut it = Folded::new();
        for (at, line) in text.lines().enumerate() {
            it.line(at as u64 + 1, normaliser.push(line));
        }
        (it.all, it.opens)
    }

    #[test]
    fn a_real_session_has_something_to_cut_at() {
        let (all, opens) = replay("bash");

        assert!(!all.is_empty(), "the fixture normalised to nothing");
        assert_eq!(opens.len(), 1, "one thing was typed in this session");
        assert!(matches!(
            all[opens[0]].event,
            TurnEvent::TurnStarted { .. } | TurnEvent::ItemStarted { .. }
        ));
    }

    /// The case the synthetic fixtures cannot reach: a session where the agent
    /// delegates. Every message inside a subagent is `type: user` in the log
    /// too, and counting those as exchanges would cut a turn in half.
    #[test]
    fn a_subagents_messages_are_not_exchanges_in_a_real_session() {
        let (all, opens) = replay("subagent");

        let spoken = all
            .iter()
            .filter(|held| {
                matches!(
                    held.event,
                    TurnEvent::ItemStarted {
                        kind: ft_core::turn::ItemKind::UserMessage,
                        ..
                    }
                )
            })
            .count();

        assert!(
            spoken > opens.len(),
            "the fixture has no delegated messages"
        );
        assert_eq!(opens.len(), 1, "one exchange, however much was delegated");
    }

    /// And the whole thing end to end on a real log: the tail is a suffix of
    /// what the unpaged request would have sent.
    #[test]
    fn a_real_session_pages_to_a_suffix_of_itself() {
        let (all, opens) = replay("subagent");
        let (start, end) = window(&all, &opens, &want(Some(1), None));

        assert_eq!(end, all.len());
        let paged: Vec<u64> = all[start..end].iter().map(|e| e.line_no).collect();
        let whole: Vec<u64> = all.iter().map(|e| e.line_no).collect();
        assert_eq!(paged, whole[whole.len() - paged.len()..]);
    }

    /* ---- against a real database ------------------------------------- */

    /// Everything above stops at the edge of the database. These go through
    /// it: real recorded agent output, written to `agent_lines` one row per
    /// line exactly as a worker writes it, then read back through the same
    /// function the handler calls.
    ///
    /// Worth the Postgres dependency because every interesting thing here is a
    /// claim about the *pipeline* — that the rows come back in order, that the
    /// normaliser sees them all, that the cut lands where the pure tests say it
    /// does — and none of those is testable on a `Vec` we built ourselves.
    async fn session_holding(name: &str) -> (crate::db::Db, SessionId) {
        let (db, owner) = crate::db::Db::open_for_test_owned().await.unwrap();
        let host = db
            .ensure_host("localhost", ft_core::Compute::Local)
            .await
            .unwrap();

        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            &owner,
            Some("acme/backend"),
            "Reading it back",
            "read it back",
            None,
            Some("main"),
            "ClaudeCode",
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &[],
            None,
        )
        .await
        .unwrap();

        let path = format!(
            "{}/../ft-core/tests/streams/{name}.ndjson",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {path}: {e}"));
        for (at, line) in text.lines().enumerate() {
            db.record_agent_line(&id, at as i64 + 1, line)
                .await
                .unwrap();
        }

        (db, id)
    }

    fn claude() -> Reader {
        Reader::for_agent(ft_core::Agent::ClaudeCode)
    }

    /// The request every client made before this change, against real stored
    /// output. If this ever stops matching, the compatibility promise is
    /// broken and an app nobody updated stops working.
    #[tokio::test]
    async fn an_unpaged_read_is_the_whole_stored_conversation() {
        let (db, id) = session_holding("subagent").await;

        let whole = paged(&db, &id, claude(), &want(None, None)).await.unwrap();

        assert!(
            !whole.events.is_empty(),
            "the session normalised to nothing"
        );
        assert!(!whole.has_more, "an unpaged read has nothing before it");
        assert_eq!(whole.last_line, 43, "every line of the fixture was read");
    }

    /// And the paged one, through the database, end to end.
    #[tokio::test]
    async fn a_paged_read_is_a_suffix_of_the_unpaged_one() {
        let (db, id) = session_holding("subagent").await;

        let whole = paged(&db, &id, claude(), &want(None, None)).await.unwrap();
        let tail = paged(&db, &id, claude(), &want(Some(1), None))
            .await
            .unwrap();

        assert!(tail.events.len() <= whole.events.len());
        // The same cursor either way: a client that read one page still knows
        // where the log ends, which is what it resumes the socket from.
        assert_eq!(tail.last_line, whole.last_line);
        assert!(tail.first_line > 0);
    }

    /// The reason any of this exists. Not a correctness property — a size one.
    #[tokio::test]
    async fn a_page_is_smaller_on_the_wire_than_the_whole_thing() {
        let (db, id) = session_holding("bash").await;

        let whole = paged(&db, &id, claude(), &want(None, None)).await.unwrap();
        let tail = paged(&db, &id, claude(), &want(Some(1), Some(20)))
            .await
            .unwrap();

        let big = serde_json::to_string(&whole).unwrap().len();
        let small = serde_json::to_string(&tail).unwrap().len();
        assert!(
            small < big,
            "a page of {small} bytes saved nothing against {big}"
        );
    }

    /// Reading backwards, through the database, arriving at the beginning.
    #[tokio::test]
    async fn paging_back_reaches_the_beginning_and_says_so() {
        let (db, id) = session_holding("subagent").await;

        let mut page = paged(&db, &id, claude(), &want(Some(1), None))
            .await
            .unwrap();
        let mut reads = 1;
        while page.has_more {
            page = paged(&db, &id, claude(), &want(Some(1), Some(page.first_line)))
                .await
                .unwrap();
            reads += 1;
            assert!(reads < 20, "paging back did not terminate");
        }

        assert!(!page.has_more, "the last page admits it is the last");
    }

    /// A session nobody has spoken to is not an error, and not a page.
    #[tokio::test]
    async fn an_empty_session_pages_to_nothing() {
        let (db, owner) = crate::db::Db::open_for_test_owned().await.unwrap();
        let host = db
            .ensure_host("localhost", ft_core::Compute::Local)
            .await
            .unwrap();
        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            &owner,
            None,
            "Nothing said",
            "nothing",
            None,
            None,
            "ClaudeCode",
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &[],
            None,
        )
        .await
        .unwrap();

        let page = paged(&db, &id, claude(), &want(Some(8), None))
            .await
            .unwrap();

        assert!(page.events.is_empty());
        assert!(!page.has_more);
        assert_eq!(page.last_line, 0);
    }

    /// Mobile catches up with `sinceLine` and no window at all. That path is
    /// untouched by any of this.
    #[test]
    fn since_line_alone_is_unchanged() {
        let it = folded(3);
        let asking = Since {
            since_line: 21,
            tail: None,
            before: None,
            max_events: None,
        };
        let (drawn, more, _) = page(&it, &asking);

        assert_eq!(drawn, vec![22, 30, 31, 32]);
        assert!(!more);
    }
}

//! Everything that changes on its own, down one socket.
//!
//! A browser allows six connections per origin on HTTP/1.1, and the API is
//! served over plain HTTP, so that is what we get — there is no HTTP/2 here to
//! multiplex for us. Every held-open stream spent one of the six, and the
//! conversation stream was one *per open agent tab*:
//!
//! ```text
//!   1  /events/stream          always open
//! + 4  /conversation/stream    one per open agent tab
//! + 1  whatever poll is in flight
//! ───
//!   6  ← the seventh request never runs
//! ```
//!
//! Which looked like a limit on agents. It was not: starting a fifth agent
//! failed because `POST /sessions` could not get a connection, and the new-tab
//! menu said "no agents configured" because `GET /agents` could not either.
//!
//! One socket carries all of it, and does not grow with tabs, agents or
//! workspaces. Subscriptions are cheap; connections are not.
//!
//! ## The layer below already worked this way
//!
//! The control plane talks to a worker over **one** connection carrying every
//! session, each frame tagged with a session id. This is that shape, one layer
//! up.
//!
//! ## What it does not carry
//!
//! Anything you *ask* for — a file's contents, a diff, the agent list — stays an
//! ordinary request. Once the streams are out of the pool those six connections
//! are free, and request/response is what they are for. This socket carries
//! streams with a cursor, and invalidations.

use crate::api::conversation::conversation_events;
use crate::auth::Principal;
use crate::AppState;
use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::Response,
    Extension,
};
use ft_core::SessionId;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::mpsc;
use tokio_stream::wrappers::BroadcastStream;
use utoipa::ToSchema;

/// How many frames may be waiting for a slow client before its subscription is
/// declared behind.
///
/// Per subscription, not per socket: one tab that cannot keep up must not stall
/// every other session sharing the connection. On overflow the subscription is
/// reset rather than the socket dropped, which is strictly better than the SSE
/// endpoints, where falling behind costs the whole connection.
const BACKLOG: usize = 256;

/// What a client can subscribe to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum Topic {
    /// Every session of yours, as it changes: the rail, the inbox count, each
    /// tab's status dot, the bring-up steps and the "doing" line all read this.
    /// One subscription for the page.
    Sessions,
    /// One session's transcript. One subscription per open agent tab.
    Conversation,
}

/// What changed in a workspace, when the socket says something did.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChangedWhat {
    Diff,
    Files,
}

/// What a client says.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ClientFrame {
    /// Start receiving a topic, optionally from where you got to.
    ///
    /// `id` names the session for a per-session topic and is ignored otherwise.
    /// `from` is a resume cursor — a sequence number for `sessions`, a line
    /// number for `conversation`. Absent means live only, with no replay.
    Sub {
        topic: Topic,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<u64>,
    },
    /// Stop receiving it. A closed tab should stop costing anything.
    Unsub {
        topic: Topic,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    Ping,
}

/// What the server says.
///
/// The two payloads that matter are the ones the SSE endpoints already send,
/// unchanged: `ft_core::Event` and `ConversationEvent`. This is not a second
/// event system — it is the same events with a topic on the front, sharing one
/// connection.
#[derive(Debug, Serialize, ToSchema)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ServerFrame {
    /// The socket is live. Everything after this is a subscription of yours.
    Ready,
    /// A session of yours changed.
    Event {
        #[schema(inline)]
        event: ft_core::Event,
    },
    /// One line of a session's transcript.
    Line {
        id: String,
        #[schema(inline)]
        line: crate::api::conversation::ConversationEvent,
    },
    /// Frames were dropped because this subscription fell behind. Resubscribe
    /// from your cursor; nothing else on the socket is affected.
    Reset {
        topic: Topic,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// This subscription cannot be served, and why.
    Error {
        topic: Topic,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
    },
    Pong,
}

/// The live feed: session events and conversations, multiplexed.
///
/// Documented as an operation carrying both frame types so the generator emits
/// TypeScript **and** zod validators for them — orval builds validators from
/// operations, not from loose components. The HTTP shape below is therefore a
/// polite fiction: this is a websocket upgrade, the "request body" is what the
/// client sends as frames and the "response body" is what it receives. The cost
/// is one generated hook nobody imports, which is cheaper than a second
/// specification and a second generator to describe eleven messages.
#[utoipa::path(
    get, path = "/api/v1/stream", tag = "stream",
    request_body(content = ClientFrame, description = "Frames the client sends"),
    // 200 rather than 101, deliberately: orval emits no validator for a body on
    // a 101, and a validator for what arrives on the socket is the whole point
    // of documenting this at all.
    responses((status = 200, body = ServerFrame, description = "Frames the server sends")),
)]
pub(super) async fn stream(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    upgrade: WebSocketUpgrade,
) -> Response {
    // Checked before the upgrade, as the terminal does: a socket that opens and
    // then refuses has already answered a question.
    let owner = principal.owner().unwrap_or_default().to_string();
    upgrade.on_upgrade(move |socket| drive(socket, state, owner))
}

/// One subscription's pump, and the handle that stops it.
struct Running(tokio::task::JoinHandle<()>);

impl Drop for Running {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn drive(socket: WebSocket, state: AppState, owner: String) {
    let (mut sink, mut source) = socket.split();

    // One writer. Every subscription's pump sends here rather than holding the
    // socket, which is what lets them be started and stopped independently.
    let (out, mut outbox) = mpsc::channel::<ServerFrame>(BACKLOG);
    let writing = tokio::spawn(async move {
        while let Some(frame) = outbox.recv().await {
            let Ok(text) = serde_json::to_string(&frame) else {
                tracing::error!("unserialisable frame");
                continue;
            };
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    let _ = out.send(ServerFrame::Ready).await;

    // Keyed by topic and session, so `unsub` can stop exactly one and dropping
    // the map at the end stops them all.
    let mut running: HashMap<(Topic, Option<String>), Running> = HashMap::new();

    while let Some(Ok(message)) = source.next().await {
        let Message::Text(text) = message else {
            // Binary and ping/pong are not part of this protocol; axum answers
            // protocol-level pings itself.
            continue;
        };

        let frame: ClientFrame = match serde_json::from_str(&text) {
            Ok(frame) => frame,
            Err(e) => {
                tracing::debug!("unparseable frame: {e}");
                continue;
            }
        };

        match frame {
            ClientFrame::Ping => {
                let _ = out.send(ServerFrame::Pong).await;
            }

            ClientFrame::Unsub { topic, id } => {
                running.remove(&(topic, id));
            }

            ClientFrame::Sub { topic, id, from } => {
                let key = (topic, id.clone());
                // Resubscribing replaces rather than doubles: a reconnect
                // resends the whole map, and two pumps for one topic would
                // deliver everything twice.
                running.remove(&key);

                let started = match topic {
                    Topic::Sessions => Some(follow_sessions(&state, &owner, from, out.clone())),
                    Topic::Conversation => {
                        match follow_conversation(&state, &owner, id.clone(), from, out.clone())
                            .await
                        {
                            Ok(task) => Some(task),
                            Err(message) => {
                                let _ = out
                                    .send(ServerFrame::Error {
                                        topic,
                                        id: id.clone(),
                                        message,
                                    })
                                    .await;
                                None
                            }
                        }
                    }
                };

                if let Some(task) = started {
                    running.insert(key, Running(task));
                }
            }
        }
    }

    // The socket is gone: every pump goes with it.
    drop(running);
    writing.abort();
}

/// Every session event of this person's, from `from` if they said where.
fn follow_sessions(
    state: &AppState,
    owner: &str,
    from: Option<u64>,
    out: mpsc::Sender<ServerFrame>,
) -> tokio::task::JoinHandle<()> {
    let state = state.clone();
    let owner = owner.to_string();

    tokio::spawn(async move {
        // Anything missed first, so ordering holds across a reconnect.
        if let Some(from) = from {
            for event in state.db.events_since(from as i64).await.unwrap_or_default() {
                if !owns(&state, &owner, &event.session_id).await {
                    continue;
                }
                if out.send(ServerFrame::Event { event }).await.is_err() {
                    return;
                }
            }
        }

        let mut live = BroadcastStream::new(state.fleet.subscribe());
        while let Some(next) = live.next().await {
            match next {
                Ok(event) => {
                    // Filtered here rather than at the bus: one socket now
                    // carries many sessions, so authorising the connection is
                    // not authorising what it receives.
                    if !owns(&state, &owner, &event.session_id).await {
                        continue;
                    }
                    if out.send(ServerFrame::Event { event }).await.is_err() {
                        return;
                    }
                }
                // Behind. Say so for this topic and let the client resume from
                // its own cursor, rather than dropping the whole socket.
                Err(_) => {
                    let _ = out
                        .send(ServerFrame::Reset {
                            topic: Topic::Sessions,
                            id: None,
                        })
                        .await;
                    return;
                }
            }
        }
    })
}

/// One session's transcript, once it is established that it is theirs.
async fn follow_conversation(
    state: &AppState,
    owner: &str,
    id: Option<String>,
    from: Option<u64>,
    out: mpsc::Sender<ServerFrame>,
) -> Result<tokio::task::JoinHandle<()>, String> {
    let raw = id.ok_or_else(|| "a conversation subscription needs a session id".to_string())?;
    let session_id = SessionId::from_stored(raw.clone());

    // Somebody else's conversation is "no such session". This carries
    // everything an agent said and everything it was told, so it is the last
    // thing that should answer to an id somebody guessed.
    let session = state
        .db
        .session_of(owner, &session_id)
        .await
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| "no such session".to_string())?;

    let state = state.clone();
    Ok(tokio::spawn(async move {
        let mut events =
            conversation_events(&state, &session.host_id, &session_id, from.unwrap_or(0))
                .await
                .boxed();

        while let Some(line) = events.next().await {
            let frame = ServerFrame::Line {
                id: raw.clone(),
                line,
            };
            if out.send(frame).await.is_err() {
                return;
            }
        }
    }))
}

/// Whether this session is this person's.
///
/// One lookup per event is more than it needs to be; the bus does not carry an
/// owner, and inventing a cache here would be a second place for "whose is
/// this" to be wrong. Worth revisiting when the bus does carry it.
async fn owns(state: &AppState, owner: &str, id: &SessionId) -> bool {
    matches!(state.db.session_of(owner, id).await, Ok(Some(_)))
}

//! The agent's terminal, over a websocket.
//!
//! The one thing in Firetower that genuinely flows both ways, byte at a time,
//! and the one place latency is felt — which is why it is not on the event
//! stream with everything else.

use crate::auth::Principal;
use crate::{fleet, AppState};
use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{Path, Query, State},
    response::Response,
    Extension,
};
use ft_core::SessionId;
use serde::Deserialize;
use utoipa::ToSchema;

/// The terminal.
///
/// A websocket rather than the event stream: this is the one thing in Firetower
/// that genuinely flows both ways, byte at a time, and where latency is felt.
///
/// Output arrives as binary frames of raw terminal bytes. Input goes back the
/// same way; a text frame is a control message, which today means resizing.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/pty", tag = "sessions",
    params(
        ("id" = String, Path, description = "Session id"),
        ("cols" = Option<u16>, Query, description = "Terminal width"),
        ("rows" = Option<u16>, Query, description = "Terminal height"),
        ("shell" = Option<bool>, Query, description = "A shell of your own rather than the agent's terminal"),
    ),
    responses((status = 101, description = "Terminal stream")),
)]
pub(super) async fn session_pty(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Query(size): Query<TerminalSize>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let id = SessionId::from_stored(id);
    // Checked before the upgrade, not after: a socket that opens and then says
    // "no such session" has already told somebody the id was worth trying.
    let owner = principal.owner().unwrap_or_default().to_string();
    upgrade.on_upgrade(move |socket| drive_terminal(socket, state, owner, id, size))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct TerminalSize {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// Accepted and ignored.
    ///
    /// There used to be two kinds of terminal and this chose between them. Only
    /// the shell is left, so it means nothing — kept so an open tab or a
    /// bookmarked address from before does not start failing to parse.
    #[serde(default)]
    #[allow(dead_code)]
    pub shell: bool,
}

/// What a browser can say about its terminal, beyond typing into it.
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum FromViewer {
    Resize { cols: u16, rows: u16 },
}

async fn drive_terminal(
    mut socket: WebSocket,
    state: AppState,
    owner: String,
    session_id: SessionId,
    size: TerminalSize,
) {
    let Ok(Some(session)) = state.db.session_of(&owner, &session_id).await else {
        let _ = socket
            .send(Message::Text("no such session".to_string().into()))
            .await;
        return;
    };

    let host = session.host_id;
    let (cols, rows) = (size.cols.unwrap_or(120), size.rows.unwrap_or(32));
    // Only one kind of terminal is left: your own shell in the session's
    // workspace. The agent had one, and does not any more — it speaks a
    // protocol, and what it is doing is read as a conversation.
    let pty = ft_proto::Pty::Shell;

    let mut output = match state.fleet.watch(&host, &session_id, pty, cols, rows).await {
        Ok(rx) => rx,
        Err(e) => {
            let _ = socket.send(Message::Text(format!("{e:#}").into())).await;
            return;
        }
    };

    loop {
        tokio::select! {
            // Output first: a burst from the agent should reach the screen
            // before we go looking for keystrokes.
            biased;

            received = output.recv() => match received {
                Ok(fleet::Terminal::Data(bytes)) => {
                    if socket.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                Ok(fleet::Terminal::Closed) => break,
                // Lagging means the viewer couldn't keep up and frames were
                // dropped. The screen is now wrong in a way that redrawing
                // can't fix, so end it rather than show a corrupted terminal.
                Err(_) => break,
            },

            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    if state.fleet.send_input(&host, &session_id, pty, &bytes).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Text(text))) => {
                    if let Ok(FromViewer::Resize { cols, rows }) = serde_json::from_str(&text) {
                        let _ = state.fleet.resize(&host, &session_id, pty, cols, rows).await;
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            },
        }
    }

    state.fleet.unwatch(&host, &session_id, pty).await;
}

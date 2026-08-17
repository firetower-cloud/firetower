//! Where workers that dial in arrive.
//!
//! Every other transport is the control plane going out to find a worker, and
//! `Transport::connect` returns as soon as the far end is reachable. A worker
//! that dials in inverts that: the connection already exists by the time we
//! know about it, and what `connect` has to do is *wait* for one.
//!
//! So this is a set of berths, one per host, each holding at most one arrival.
//! The endpoint that accepts a websocket puts the connection in the berth; the
//! supervisor's `connect` takes it out. Neither knows about the other, which
//! keeps the supervisor's retry loop exactly as it was for every other kind.
//!
//! **Why a slot and not a callback.** The supervisor is often not waiting —
//! it may be part-way through a backoff after the last connection dropped. A
//! worker that dials in during that gap would otherwise be turned away for
//! having arrived at an awkward moment, and would then wait out its own retry
//! for no reason. One slot means it is picked up the instant the supervisor
//! comes back round.

use crate::transport::{Connection, Transport};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, RwLock};

/// Every host that is expected to dial in.
#[derive(Clone, Default)]
pub struct Dock {
    berths: Arc<RwLock<HashMap<String, mpsc::Sender<Connection>>>>,
}

impl Dock {
    pub fn new() -> Self {
        Self::default()
    }

    /// Make somewhere for this host to arrive, and the transport that waits
    /// there.
    ///
    /// Called when a host is first supervised. Calling it again replaces the
    /// berth, which is what should happen when a host is re-added: the old
    /// transport is on its way out and anything still holding the old sender
    /// finds it closed.
    pub async fn berth(&self, host: &str) -> DialedTransport {
        // One deep. A second connection while one is already waiting means the
        // worker reconnected before we noticed the first was dead — the newer
        // one is the live connection, and holding a queue of stale sockets
        // would mean working through the dead ones first.
        let (tx, rx) = mpsc::channel(1);
        self.berths.write().await.insert(host.to_string(), tx);

        DialedTransport {
            host: host.to_string(),
            arrivals: Mutex::new(rx),
        }
    }

    /// Hand a freshly dialled connection to whoever is waiting for it.
    ///
    /// Fails if the host has no berth, which means it is not a host we expect
    /// to dial in — the endpoint reports that rather than holding a socket
    /// nothing will ever read.
    pub async fn arrive(&self, host: &str, connection: Connection) -> Result<()> {
        let sender = {
            let berths = self.berths.read().await;
            berths.get(host).cloned()
        };

        let sender = sender.with_context(|| format!("{host} is not expecting a connection"))?;

        // `try_send` rather than `send`: if a connection is already waiting,
        // this one is newer and the old one is stale. Replace it instead of
        // parking here until someone drains the queue.
        match sender.try_send(connection) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(connection)) => {
                tracing::info!(
                    host,
                    "a connection was already waiting; taking the newer one"
                );
                // The receiver is a channel of one, so draining is the only way
                // to make room. Whoever eventually reads gets the live socket.
                if let Some(sender) = self.berths.read().await.get(host).cloned() {
                    // Best effort: the supervisor may pick the old one up in
                    // the meantime, which is fine — it will fail and retry.
                    let _ = sender.try_send(connection);
                }
                Ok(())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                anyhow::bail!("{host} stopped listening for connections")
            }
        }
    }

    /// Whether a host is one we wait for rather than dial.
    pub async fn expects(&self, host: &str) -> bool {
        self.berths.read().await.contains_key(host)
    }

    /// Stop expecting this host. Called when it is removed.
    pub async fn close(&self, host: &str) {
        self.berths.write().await.remove(host);
    }
}

/// A transport that waits to be connected to.
pub struct DialedTransport {
    host: String,
    /// Behind a mutex because `connect` takes `&self` — the trait is shaped
    /// for transports that dial, where connecting needs nothing exclusive.
    arrivals: Mutex<mpsc::Receiver<Connection>>,
}

#[async_trait]
impl Transport for DialedTransport {
    fn describe(&self) -> String {
        "dialled in".to_string()
    }

    fn awaits_arrival(&self) -> bool {
        true
    }

    /// Park until the worker turns up.
    ///
    /// There is no timeout on purpose. The supervisor's job is to keep a host
    /// connected for as long as it is a host, and a machine that is switched
    /// off for the weekend should be waited for rather than declared broken
    /// every sixty seconds.
    async fn connect(&self) -> Result<Connection> {
        self.arrivals
            .lock()
            .await
            .recv()
            .await
            .with_context(|| format!("stopped waiting for {}", self.host))
    }
}

/// How much may be in flight between the socket and the fleet before the slower
/// side is made to wait.
///
/// Frames are small — a terminal's output is the only thing here with any
/// volume — and back-pressure is the correct answer rather than a bigger
/// buffer: a viewer that cannot keep up should slow the stream, not accumulate
/// megabytes of scrollback nobody will read.
const RELAY_BUFFER: usize = 64 * 1024;

/// What a worker presents when it dials in.
#[derive(serde::Deserialize)]
pub struct Enrolment {
    /// The token this deployment was configured with. In the query string
    /// rather than a header because a websocket handshake from anything other
    /// than a browser is still easiest to get right this way, and this endpoint
    /// is reached by our own binary.
    token: String,
}

/// A worker, arriving.
///
/// Deliberately not part of the API contract: the typed client is for the web
/// application, and this is spoken by the worker binary. It also sits outside
/// the operator's authentication — a worker has its own credential and no idea
/// what an operator token is.
pub async fn connect(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    axum::extract::Query(enrolment): axum::extract::Query<Enrolment>,
    upgrade: axum::extract::ws::WebSocketUpgrade,
) -> axum::response::Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    let offered = fingerprint(&enrolment.token);

    let host = match state.db.hosts().await {
        Ok(hosts) => hosts.into_iter().find(|host| match &host.compute {
            ft_core::Compute::Dialed { token_hash, .. } => {
                // Both sides are hex of the same length, so this is a
                // comparison of equal-length strings — but the token they stand
                // for is a secret, and comparing it in a way that leaks where
                // it first differs is a habit worth not having.
                constant_time_eq(token_hash.as_bytes(), offered.as_bytes())
            }
            _ => false,
        }),
        Err(e) => {
            tracing::error!("could not read hosts while a worker was dialling in: {e:#}");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    };

    let Some(host) = host else {
        // No detail. Which of "no such token" and "the wrong token" it was is
        // exactly what someone guessing would like to know.
        tracing::warn!("a worker dialled in with a token that matches no host");
        return StatusCode::UNAUTHORIZED.into_response();
    };

    let id = host.id.to_string();
    if !state.dock.expects(&id).await {
        tracing::warn!(host = %host.name, "dialled in before anything was waiting for it");
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }

    tracing::info!(host = %host.name, "a worker dialled in");

    upgrade.on_upgrade(move |socket| async move {
        let (fleet_side, socket_side) = tokio::io::duplex(RELAY_BUFFER);
        let (reader, writer) = tokio::io::split(fleet_side);

        tokio::spawn(relay(socket, socket_side));

        if let Err(e) = state
            .dock
            .arrive(&id, Connection::adopted(Box::new(reader), Box::new(writer)))
            .await
        {
            tracing::warn!("{e:#}");
        }
    })
}

/// Carry bytes between the websocket and the stream the fleet reads.
///
/// The protocol underneath is a stream of length-prefixed frames, so the
/// message boundaries a websocket adds are incidental — nothing here has to
/// preserve them, only the order and the bytes, both of which a websocket
/// guarantees.
async fn relay(socket: axum::extract::ws::WebSocket, side: tokio::io::DuplexStream) {
    use axum::extract::ws::Message;
    use futures::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (mut outbound, mut inbound) = socket.split();
    let (mut from_fleet, mut to_fleet) = tokio::io::split(side);

    // What the control plane says, on its way to the worker.
    let sending = tokio::spawn(async move {
        let mut buffer = vec![0u8; 16 * 1024];
        loop {
            match from_fleet.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if outbound
                        .send(Message::Binary(buffer[..read].to_vec().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        // Politely, so the far end knows this was an ending rather than a
        // network dropping out — it decides whether to reconnect on that.
        let _ = outbound.send(Message::Close(None)).await;
    });

    // What the worker says, on its way in.
    while let Some(message) = inbound.next().await {
        match message {
            Ok(Message::Binary(bytes)) => {
                if to_fleet.write_all(&bytes).await.is_err() {
                    break;
                }
            }
            // Ping and pong are the transport keeping itself alive; the
            // protocol has its own heartbeat and neither needs to know about
            // the other. Text has no meaning here.
            Ok(_) => continue,
            Err(e) => {
                tracing::debug!("a dialled worker's socket ended: {e}");
                break;
            }
        }
    }

    // Dropping `to_fleet` closes the read side the fleet is waiting on, which
    // is how a dropped connection becomes a disconnect rather than a hang.
    drop(to_fleet);
    sending.abort();
}

/// SHA-256, hex. What is stored for a dialled host, and what an offered token
/// is turned into before comparing.
///
/// No salt and no work factor, deliberately: this is a 40-character random
/// token rather than a password, so there is no dictionary to run and nothing
/// for a slow hash to buy.
pub fn fingerprint(token: &str) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(token.trim().as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    fn connection() -> Connection {
        let (a, b) = duplex(64);
        Connection::piped(Box::new(a), Box::new(b))
    }

    #[tokio::test]
    async fn a_connection_waits_in_the_berth_until_someone_comes_for_it() {
        let dock = Dock::new();
        let transport = dock.berth("h_1").await;

        // Arrives first, which is the case the slot exists for.
        dock.arrive("h_1", connection()).await.unwrap();

        assert!(transport.connect().await.is_ok());
    }

    #[tokio::test]
    async fn connecting_blocks_until_a_worker_dials_in() {
        let dock = Dock::new();
        let transport = dock.berth("h_1").await;

        let waiting = tokio::spawn(async move { transport.connect().await.is_ok() });

        // Nothing has arrived, so it must still be parked.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), async {})
                .await
                .is_ok(),
            "the test itself should not hang"
        );
        assert!(!waiting.is_finished());

        dock.arrive("h_1", connection()).await.unwrap();
        assert!(waiting.await.unwrap());
    }

    #[tokio::test]
    async fn a_host_nobody_is_waiting_for_is_refused() {
        let dock = Dock::new();
        assert!(dock.arrive("h_unknown", connection()).await.is_err());
    }

    #[tokio::test]
    async fn a_removed_host_stops_being_expected() {
        let dock = Dock::new();
        let _transport = dock.berth("h_1").await;
        assert!(dock.expects("h_1").await);

        dock.close("h_1").await;
        assert!(!dock.expects("h_1").await);
        assert!(dock.arrive("h_1", connection()).await.is_err());
    }

    /// A worker that reconnected before we noticed the last one died.
    #[tokio::test]
    async fn the_newer_connection_wins() {
        let dock = Dock::new();
        let transport = dock.berth("h_1").await;

        dock.arrive("h_1", connection()).await.unwrap();
        dock.arrive("h_1", connection()).await.unwrap();

        assert!(transport.connect().await.is_ok());
    }
}

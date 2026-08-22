//! Live connections to workers.
//!
//! One task per host owns that host's stream and is the only thing that touches
//! it. Everything else asks the fleet to send a frame and reads the results out
//! of the database, which keeps the concurrency story to a single rule: frames
//! in and out of a worker are serialised by its own task.

use crate::db::Db;
use anyhow::{Context, Result};
use ft_core::{AgentPresence, Event, HostId, SessionId, WorkSummary};
use ft_proto::{
    decode, encode, Codec, CodecError, Credential, ProbeFailure, Pty, RemoteInfo, ReqId, ToServer,
    ToWorker, PROTOCOL_VERSION,
};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, oneshot, RwLock};

/// Long enough for a cold network, short enough that nobody watches a spinner
/// forever. The worker gives up before this, so hitting it means the worker
/// itself stopped answering.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// How often to provoke an answer when nothing else is being said.
const HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(20);

/// How long a worker may say nothing at all before the connection is treated as
/// dead. Comfortably more than two heartbeats, so one lost frame is not enough.
const SILENCE: std::time::Duration = std::time::Duration::from_secs(50);

/// The longest gap between attempts to reach a host.
///
/// The cap matters more than the growth: a machine that comes back should be
/// noticed within a minute, and one that is genuinely gone shouldn't be
/// hammered.
const RETRY_CAP: std::time::Duration = std::time::Duration::from_secs(60);

/// The shortest gap when the last failure was something a human has to fix.
///
/// A refused key or a changed host key will not resolve itself, so there is
/// nothing to gain by asking every second — but we keep asking, because the
/// human may well be fixing it right now.
const RETRY_FLOOR_HUMAN: std::time::Duration = std::time::Duration::from_secs(30);

use crate::transport::Transport;

/// A session's terminal, as it reaches a viewer.
#[derive(Clone, Debug)]
pub enum Terminal {
    /// Raw bytes. Not text: escape sequences and partial UTF-8 both travel here.
    Data(Vec<u8>),
    /// The agent's terminal went away.
    Closed,
}

/// One terminal of one session.
///
/// A session has more than one now — the agent's, and a shell of your own — and
/// everything here used to key on the session alone.
fn terminal_key(session_id: &SessionId, pty: Pty) -> String {
    match pty {
        Pty::Agent => session_id.to_string(),
        Pty::Shell => format!("{session_id}:shell"),
    }
}

/// One map for everything waiting on an answer, so the timeout and the
/// clean-up-on-disconnect logic exist once rather than once per request type.
enum Waiting {
    Remote(oneshot::Sender<Result<RemoteInfo, ProbeFailure>>),
    /// What is in a directory.
    Listing(oneshot::Sender<Result<Vec<ft_core::FileEntry>, String>>),
    /// A file: whether it is coming, and then the pieces of it.
    ///
    /// Two channels for one request because a browser needs an answer before a
    /// body — the first says whether there will be one, the second carries it.
    File {
        opened: Option<oneshot::Sender<Result<u64, String>>>,
        chunks: mpsc::Sender<Vec<u8>>,
    },
    Agents(oneshot::Sender<Vec<AgentPresence>>),
    Action(oneshot::Sender<Result<String, String>>),
    Summary(oneshot::Sender<WorkSummary>),
}

/// A request waiting on an answer, and which host owes it.
///
/// The host matters when a connection ends: only the requests that were sent
/// down *that* connection are lost. Failing the rest would mean one host
/// dropping takes down work happening on every other one.
struct Asked {
    host: String,
    waiting: Waiting,
}

#[derive(Clone)]
pub struct Fleet {
    db: Db,
    workers: Arc<RwLock<HashMap<String, mpsc::Sender<ToWorker>>>>,
    /// Fan-out to whoever is watching — the event stream, ultimately the browser.
    events: broadcast::Sender<Event>,
    /// Requests waiting for their answer. Most frames are one-way and correlate
    /// on a session; a probe has no session, so it correlates on its own id.
    probes: Arc<RwLock<HashMap<ReqId, Asked>>>,
    /// Live terminals, one broadcast per session. The worker holds a single
    /// attachment; this is where it fans out to however many are watching.
    terminals: Arc<RwLock<HashMap<String, broadcast::Sender<Terminal>>>>,
    /// One per host we are keeping connected, whether or not it is answering.
    ///
    /// A host is in here from the moment it is added until it is removed, which
    /// is what tells "we are trying and it isn't answering yet" apart from "we
    /// stopped trying". Dropping the sender ends its supervisor.
    supervised: Arc<RwLock<HashMap<String, mpsc::Sender<Nudge>>>>,
}

/// A word to a supervisor between attempts.
enum Nudge {
    /// Stop waiting out the backoff and try now.
    TryNow,
}

/// How long to wait before the next attempt.
///
/// Doubles to a cap, with a little noise on top. The noise is what stops a
/// laptop waking up from putting every host on the same schedule for the rest
/// of the day — they all fail together, so without it they all retry together,
/// forever.
fn backoff(attempt: u32, cause: Option<ft_core::Cause>) -> std::time::Duration {
    if attempt == 0 {
        return std::time::Duration::ZERO;
    }

    let doubled = std::time::Duration::from_secs(1) * 2u32.saturating_pow(attempt.min(6) - 1);
    let mut wait = doubled.min(RETRY_CAP);

    if matches!(
        cause,
        Some(ft_core::Cause::AuthRefused)
            | Some(ft_core::Cause::HostKeyChanged)
            | Some(ft_core::Cause::ProtocolMismatch)
    ) {
        wait = wait.max(RETRY_FLOOR_HUMAN);
    }

    // Up to a fifth longer. Cheap, and enough to break a lockstep.
    //
    // The modulus is prime on purpose. The clock reports nanoseconds but only
    // moves in microseconds, so every reading is a multiple of 1000 — take it
    // modulo anything that divides 1000 and the answer is always the same
    // number, which is jitter that does nothing at all.
    let spread = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() % 199)
        .unwrap_or(0);
    wait + (wait / 1000) * spread
}

impl Fleet {
    pub fn new(db: Db) -> Self {
        let (events, _) = broadcast::channel(1024);
        Self {
            db,
            workers: Arc::new(RwLock::new(HashMap::new())),
            events,
            probes: Arc::new(RwLock::new(HashMap::new())),
            terminals: Arc::new(RwLock::new(HashMap::new())),
            supervised: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// The transport a host's kind implies.
    ///
    /// The worker is identical in all three cases and cannot tell which it is
    /// behind — that indifference is what lets one binary serve a child
    /// process, a container, and a server on the other side of the world.
    pub fn transport_for(
        host: &ft_core::Host,
        home: &std::path::Path,
        vault: Option<&Arc<crate::vault::Vault>>,
    ) -> Result<Arc<dyn Transport>> {
        Ok(match &host.compute {
            ft_core::Compute::Local => {
                Arc::new(crate::transport::LocalTransport::new(home.join("worker"))?)
            }
            ft_core::Compute::Container { name, .. } => {
                Arc::new(crate::transport::DockerTransport {
                    container: name.clone(),
                    // Inside the container, not on this machine.
                    root: std::path::PathBuf::from("/var/lib/firetower/worker"),
                })
            }
            ft_core::Compute::Server {
                port,
                key,
                container,
                ..
            } => Arc::new(crate::transport::SshTransport {
                // Assembled by the type that holds the parts, so there is one
                // answer to what `user@host` means.
                destination: host
                    .compute
                    .ssh_destination()
                    .context("a server host has somewhere to dial")?,
                port: *port,
                key: key.clone(),
                // Only carried when the key is one the vault holds. A path or
                // ssh's own choice needs nothing from us.
                vault: key
                    .is_held()
                    .then(|| vault.map(|v| (v.clone(), home.to_path_buf())))
                    .flatten(),
                container: container.clone(),
                // Inside a container, the path the image creates. On the
                // machine itself, the worker's own default: that account may
                // have no way to write under /var/lib.
                root: container
                    .as_ref()
                    .map(|_| std::path::PathBuf::from("/var/lib/firetower/worker")),
            }),
        })
    }

    /// What kind of machine a host is, for wording an error about it.
    ///
    /// A host that has vanished is not worth failing a diagnosis over: the
    /// wording degrades, the message still arrives.
    async fn compute_of(&self, host_id: &HostId) -> ft_core::Compute {
        match self.db.host_by_id(host_id).await {
            Ok(Some(host)) => host.compute,
            _ => ft_core::Compute::Local,
        }
    }

    /// Keep a host connected for as long as it exists.
    ///
    /// One task per host, holding the statement "this should be connected".
    /// It connects, serves until the connection ends, waits, and tries again —
    /// so a laptop that slept, a wifi that changed and a server that rebooted
    /// all heal on their own instead of needing the control plane restarted.
    ///
    /// Returns once the first attempt has been made, so a host added by hand
    /// can report what happened while someone is still looking at the form.
    /// Retrying carries on in the background either way.
    pub async fn supervise(&self, host_id: HostId, transport: Arc<dyn Transport>) {
        // Already ours. Two supervisors on one host would be two connections
        // racing to register in the same slot.
        if self
            .supervised
            .read()
            .await
            .contains_key(&host_id.to_string())
        {
            return;
        }

        let (nudge, mut nudged) = mpsc::channel::<Nudge>(1);
        self.supervised
            .write()
            .await
            .insert(host_id.to_string(), nudge);

        let (first, waited) = oneshot::channel::<()>();
        let fleet = self.clone();

        tokio::spawn(async move {
            let mut first = Some(first);
            let mut attempt: u32 = 0;

            loop {
                // The supervisor outlives any one connection, so a host removed
                // while we were sleeping has to be noticed here.
                if !fleet
                    .supervised
                    .read()
                    .await
                    .contains_key(&host_id.to_string())
                {
                    break;
                }

                let outcome = fleet
                    .connect(host_id.clone(), transport.clone(), &mut first)
                    .await;

                // Fires here only when the attempt failed before the handshake;
                // a connection that came up already reported itself.
                if let Some(tell) = first.take() {
                    let _ = tell.send(());
                }

                match outcome {
                    // Served and ended. Whatever went wrong is over, so the
                    // next failure starts counting from the beginning again.
                    Ok(()) => attempt = 0,
                    Err(e) => {
                        attempt = attempt.saturating_add(1);
                        tracing::debug!(host = %host_id, attempt, "not reachable: {e:#}");
                    }
                }

                let cause = fleet
                    .db
                    .host_by_id(&host_id)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|h| h.diagnosis)
                    .map(|d| d.cause);

                let wait = backoff(attempt, cause);
                tracing::debug!(host = %host_id, "next attempt in {:?}", wait);

                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    // Someone pressed reconnect, or the supervisor was dropped.
                    got = nudged.recv() => match got {
                        Some(Nudge::TryNow) => {}
                        None => break,
                    },
                }
            }

            tracing::debug!(host = %host_id, "no longer supervised");
        });

        // The first attempt, and no more than that: a host that is down should
        // not hold up start-up or a form.
        let _ = waited.await;
    }

    /// Stop keeping a host connected, and drop the connection it has.
    ///
    /// Without this a removed host keeps a supervisor reconnecting to something
    /// that no longer exists, and adding it again would make a second one.
    pub async fn stop_supervising(&self, host_id: &HostId) {
        self.supervised.write().await.remove(&host_id.to_string());
        self.disconnect(host_id).await;
    }

    /// Try again now rather than waiting out the backoff.
    ///
    /// Returns whether there was a supervisor to tell.
    pub async fn try_now(&self, host_id: &HostId) -> bool {
        let supervised = self.supervised.read().await;
        match supervised.get(&host_id.to_string()) {
            Some(tx) => {
                // A full channel already has an attempt queued, which is the
                // same outcome as adding another.
                let _ = tx.try_send(Nudge::TryNow);
                true
            }
            None => false,
        }
    }

    /// Whether we are still trying to reach this host.
    ///
    /// True from being added until being removed, including while it is down.
    /// This is what tells "on its way back" apart from "nobody is looking".
    pub async fn is_supervised(&self, host_id: &HostId) -> bool {
        self.supervised
            .read()
            .await
            .contains_key(&host_id.to_string())
    }

    /// Wait for a host to answer, up to `limit`.
    ///
    /// For work that arrives in the gap between a connection dropping and the
    /// supervisor rebuilding it — usually seconds, and worth waiting out rather
    /// than refusing.
    pub async fn wait_until_connected(&self, host_id: &HostId, limit: std::time::Duration) -> bool {
        let until = std::time::Instant::now() + limit;
        loop {
            if self.is_connected(host_id).await {
                return true;
            }
            if std::time::Instant::now() >= until || !self.is_supervised(host_id).await {
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }

    /// Connect to a host, handshake, and start serving its frames.
    ///
    /// The first thing sent after the handshake is a resume request, so anything
    /// that happened while we were away arrives before anything new.
    /// `ready` is fired as soon as the handshake resolves, because this call
    /// then goes on to serve the connection and does not return until it ends.
    /// Waiting for the return value to learn whether a host answered would mean
    /// waiting for it to stop answering.
    async fn connect(
        &self,
        host_id: HostId,
        transport: Arc<dyn Transport>,
        ready: &mut Option<oneshot::Sender<()>>,
    ) -> Result<()> {
        let compute = self.compute_of(&host_id).await;

        let mut conn = match transport.connect().await {
            Ok(conn) => conn,
            Err(e) => {
                // Nothing started, so there is no stderr to read; the error is
                // already in the right words.
                let told = ft_core::Diagnosis::new(ft_core::Cause::Unknown, format!("{e:#}"));
                self.db.record_diagnosis(&host_id, &told).await?;
                return Err(e).with_context(|| format!("connecting via {}", transport.describe()));
            }
        };

        let mut codec = Codec::new(&mut conn.reader, &mut conn.writer);

        // A command that was never going to run is often gone before this
        // write lands, making it a broken pipe rather than a closed stream.
        // Both mean the same thing and both need the same explanation.
        let greeting = codec
            .write(&ToWorker::Hello {
                protocol: PROTOCOL_VERSION,
                client_version: env!("CARGO_PKG_VERSION").to_string(),
            })
            .await;

        let handshake = match greeting {
            Ok(()) => codec.read::<ToServer>().await,
            Err(e) => Err(e),
        };

        match handshake {
            Ok(ToServer::Hello {
                protocol,
                worker_version,
                cpus,
                memory_mb,
                ..
            }) => {
                if protocol != PROTOCOL_VERSION {
                    // Recoverable: the worker needs upgrading, so the message
                    // names both versions and what to run.
                    let told =
                        crate::diagnose::protocol_mismatch(protocol, PROTOCOL_VERSION, &compute);
                    self.db.record_diagnosis(&host_id, &told).await?;
                    anyhow::bail!("{}", told.summary);
                }
                // Online, so the last failure no longer applies.
                self.db
                    .mark_host_online(&host_id, &worker_version, cpus, memory_mb)
                    .await?;
                tracing::info!(host = %host_id, version = %worker_version, "worker online");
            }
            Ok(_) => anyhow::bail!("worker replied with something other than Hello"),
            Err(e) => {
                // The codec borrows both halves; reading the child's stderr
                // needs them back, and only this arm is done with them.
                drop(codec);

                // A closed frame stream says nothing about why. The stderr the
                // far end wrote before it went does.
                let said = conn.stderr_tail();
                let status = conn.exit_status().await;
                let told = crate::diagnose::from_output(&said, status, &compute);

                tracing::warn!(
                    host = %host_id,
                    cause = ?told.cause,
                    status = ?status,
                    "handshake failed: {}",
                    told.summary,
                );

                self.db.record_diagnosis(&host_id, &told).await?;
                return Err(e).context(told.summary);
            }
        }

        let since = self.db.last_seq(&host_id).await?;
        codec.write(&ToWorker::Resume { since }).await?;

        let (tx, mut rx) = mpsc::channel::<ToWorker>(64);
        self.workers.write().await.insert(host_id.to_string(), tx);

        // Reachable from here on, so whoever was waiting to hear can stop.
        if let Some(tell) = ready.take() {
            let _ = tell.send(());
        }

        // Sessions removed here while this machine was away were removed on the
        // promise that they would be cleaned up if it ever came back. It just
        // did. The agent has been running unattended since, and its workspace
        // and tmux session are still there.
        {
            let fleet = self.clone();
            let host = host_id.clone();
            tokio::spawn(async move {
                let owed = match fleet.db.owed_cleanup_on(&host).await {
                    Ok(owed) => owed,
                    Err(e) => {
                        tracing::warn!(host = %host, "looking for sessions to tear down: {e:#}");
                        return;
                    }
                };

                for session_id in owed {
                    match fleet
                        .send(
                            &host,
                            ToWorker::Destroy {
                                session_id: session_id.clone(),
                                force: true,
                            },
                        )
                        .await
                    {
                        // Recorded as told, not as done: the worker tears it
                        // down and says so in its own time, and asking twice
                        // would kill a session someone started since.
                        Ok(()) => {
                            tracing::info!(host = %host, session = %session_id,
                                "tearing down a session removed while this host was away");
                            if let Err(e) = fleet.db.mark_cleaned(&session_id).await {
                                tracing::warn!(session = %session_id, "recording a teardown: {e:#}");
                            }
                        }
                        // It went away again. The debt stands, and the next
                        // connection tries again.
                        Err(e) => {
                            tracing::warn!(host = %host, session = %session_id,
                                "tearing down after a reconnect: {e:#}");
                            break;
                        }
                    }
                }
            });
        }

        // Ask what this host has as soon as it turns up. Waiting for someone to
        // press a button means a fresh install reports no agents at all, which
        // reads as "nothing works" rather than "nobody has looked yet".
        {
            let fleet = self.clone();
            let host = host_id.clone();
            tokio::spawn(async move {
                match fleet.probe_agents(&host).await {
                    Ok(found) => {
                        if let Err(e) = fleet.db.record_presence(&host, &found).await {
                            tracing::warn!(host = %host, "recording agents: {e:#}");
                        }
                    }
                    Err(e) => tracing::warn!(host = %host, "asking about agents: {e:#}"),
                }
            });
        }

        let db = self.db.clone();
        let events = self.events.clone();
        let workers = self.workers.clone();
        let probes = self.probes.clone();
        let terminals = self.terminals.clone();

        {
            // conn is moved in so the child process outlives this scope
            let mut conn = conn;
            let mut codec = Codec::new(&mut conn.reader, &mut conn.writer);

            // A connection can die without ever failing a read. A laptop that
            // slept, a network that changed underneath us: the socket goes
            // quiet rather than closed, and a loop waiting for a frame waits
            // for one that is never coming while the host still looks healthy.
            //
            // So the silence is timed. Anything inbound counts as proof of
            // life; a Ping is only there to provoke one when nothing else is
            // happening.
            let mut beat = tokio::time::interval(HEARTBEAT);
            beat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut last_heard = std::time::Instant::now();

            loop {
                if last_heard.elapsed() > SILENCE {
                    tracing::warn!(
                        host = %host_id,
                        "no answer for {}s; treating the connection as dead",
                        SILENCE.as_secs(),
                    );
                    break;
                }

                tokio::select! {
                    _ = beat.tick() => {
                        if let Err(e) = codec.write(&ToWorker::Ping).await {
                            tracing::warn!(host = %host_id, "heartbeat: {e}");
                            break;
                        }
                    }

                    outbound = rx.recv() => match outbound {
                        Some(frame) => {
                            if let Err(e) = codec.write(&frame).await {
                                tracing::error!(host = %host_id, "sending to worker: {e}");
                                break;
                            }
                        }
                        None => break,
                    },

                    inbound = codec.read::<ToServer>() => {
                        // Any frame is proof of life, whatever it says.
                        if inbound.is_ok() {
                            last_heard = std::time::Instant::now();
                        }
                        match inbound {
                        Ok(ToServer::Event { seq, session_id, kind, at }) => {
                            if let Err(e) = db.record_event(&host_id, seq, &session_id, &kind, at).await {
                                tracing::error!("recording event: {e:#}");
                                continue;
                            }
                            // a send failure only means nobody is watching
                            let _ = events.send(Event { seq, session_id, kind, at });
                        }
                        Ok(ToServer::RemoteProbed { req, result }) => {
                            // The receiver is gone when the request timed out
                            // or the browser navigated away.
                            match probes.write().await.remove(&req) {
                                Some(Asked { waiting: Waiting::Remote(reply), .. }) => { let _ = reply.send(result); }
                                Some(other) => { probes.write().await.insert(req, other); }
                                None => tracing::debug!("a probe answer arrived after its request gave up"),
                            }
                        }
                        Ok(ToServer::PtyOutput { session_id, pty, data }) => {
                            if let Some(bytes) = decode(&data) {
                                if let Some(tx) = terminals.read().await.get(&terminal_key(&session_id, pty)) {
                                    // An error only means nobody is watching.
                                    let _ = tx.send(Terminal::Data(bytes));
                                }
                            }
                        }
                        Ok(ToServer::PtyClosed { session_id, pty }) => {
                            if let Some(tx) = terminals.write().await.remove(&terminal_key(&session_id, pty)) {
                                let _ = tx.send(Terminal::Closed);
                            }
                        }
                        Ok(ToServer::Listed { req, result }) => {
                            match probes.write().await.remove(&req) {
                                Some(Asked { waiting: Waiting::Listing(reply), .. }) => { let _ = reply.send(result); }
                                Some(other) => { probes.write().await.insert(req, other); }
                                None => tracing::debug!("a listing arrived after its request gave up"),
                            }
                        }
                        Ok(ToServer::FileOpened { req, result }) => {
                            // The entry stays: the chunks that follow are
                            // routed by the same id, and it is removed when the
                            // last one arrives or the reader goes away.
                            let mut held = probes.write().await;
                            if let Some(Asked { waiting: Waiting::File { opened, .. }, .. }) = held.get_mut(&req) {
                                if let Some(tell) = opened.take() {
                                    let _ = tell.send(result);
                                    continue;
                                }
                            }
                            tracing::debug!("a file answer arrived after its request gave up");
                        }
                        Ok(ToServer::FileChunk { req, data, last }) => {
                            let sender = {
                                let held = probes.read().await;
                                match held.get(&req) {
                                    Some(Asked { waiting: Waiting::File { chunks, .. }, .. }) => Some(chunks.clone()),
                                    _ => None,
                                }
                            };

                            if let Some(chunks) = sender {
                                if let Some(bytes) = decode(&data) {
                                    // Blocks when the browser is slower than the
                                    // machine, which is the point: it is what
                                    // stops a download filling memory here.
                                    if chunks.send(bytes).await.is_err() {
                                        probes.write().await.remove(&req);
                                        continue;
                                    }
                                }
                            }

                            if last {
                                probes.write().await.remove(&req);
                            }
                        }
                        Ok(ToServer::ActionDone { req, result }) => {
                            match probes.write().await.remove(&req) {
                                Some(Asked { waiting: Waiting::Action(reply), .. }) => { let _ = reply.send(result); }
                                // A summary that failed comes back as an action
                                // error, since there is no summary to send.
                                Some(Asked { waiting: Waiting::Summary(_), .. }) => {}
                                Some(other) => { probes.write().await.insert(req, other); }
                                None => tracing::debug!("an action finished after its request gave up"),
                            }
                        }
                        Ok(ToServer::Summarized { req, summary }) => {
                            match probes.write().await.remove(&req) {
                                Some(Asked { waiting: Waiting::Summary(reply), .. }) => { let _ = reply.send(summary); }
                                Some(other) => { probes.write().await.insert(req, other); }
                                None => tracing::debug!("a summary arrived after its request gave up"),
                            }
                        }
                        Ok(ToServer::AgentsProbed { req, agents }) => {
                            match probes.write().await.remove(&req) {
                                Some(Asked { waiting: Waiting::Agents(reply), .. }) => { let _ = reply.send(agents); }
                                Some(other) => { probes.write().await.insert(req, other); }
                                None => tracing::debug!("an agent probe answered after its request gave up"),
                            }
                        }
                        Ok(ToServer::Error { code, message, .. }) => {
                            tracing::warn!(host = %host_id, "worker error {code}: {message}");
                        }
                        Ok(_) => {}
                        Err(CodecError::Closed) => {
                            tracing::warn!(host = %host_id, "worker connection closed");
                            break;
                        }
                        Err(e) => {
                            tracing::error!(host = %host_id, "reading from worker: {e}");
                            break;
                        }
                        }
                    },
                }
            }

            // Sessions on this host keep running; we just can't see them.
            workers.write().await.remove(&host_id.to_string());
            // Anything still waiting on *this* worker will never hear back, so
            // fail it now rather than leaving the interface spinning. Requests
            // sent to other hosts are untouched: they are still on connections
            // that are still up, and failing them here would make one machine
            // dropping look like every machine dropping.
            let mine: Vec<ReqId> = {
                let held = probes.read().await;
                held.iter()
                    .filter(|(_, asked)| asked.host == host_id.to_string())
                    .map(|(req, _)| req.clone())
                    .collect()
            };
            for req in mine {
                let Some(asked) = probes.write().await.remove(&req) else {
                    continue;
                };
                match asked.waiting {
                    Waiting::Remote(reply) => {
                        let _ = reply.send(Err(ProbeFailure::Unreachable));
                    }
                    // Dropping the sender is the signal; there is no "we asked
                    // and the answer was none" for these.
                    Waiting::Agents(_) | Waiting::Summary(_) => {}
                    Waiting::Action(reply) => {
                        let _ = reply.send(Err("the host stopped answering".into()));
                    }
                    Waiting::Listing(reply) => {
                        let _ = reply.send(Err("the host stopped answering".into()));
                    }
                    // A download in flight ends where it got to. Dropping the
                    // sender is what tells the browser the body is over; a
                    // half-file is what a dropped connection means.
                    Waiting::File { opened, .. } => {
                        if let Some(tell) = opened {
                            let _ = tell.send(Err("the host stopped answering".into()));
                        }
                    }
                }
            }
            let _ = db.mark_host_unreachable(&host_id).await;
        }

        Ok(())
    }

    /// Send a frame to a host, if we can currently reach it.
    pub async fn send(&self, host_id: &HostId, frame: ToWorker) -> Result<()> {
        let workers = self.workers.read().await;
        let tx = workers
            .get(&host_id.to_string())
            .with_context(|| format!("host {host_id} is unreachable"))?;
        tx.send(frame)
            .await
            .context("the worker connection went away mid-send")?;
        Ok(())
    }

    /// Ask a host whether it can reach a repository.
    ///
    /// The outer error means we couldn't ask; the inner one means we asked and
    /// the answer was no. They lead to different messages, so they stay apart.
    pub async fn probe(
        &self,
        host_id: &HostId,
        remote: &str,
        credential: Option<Credential>,
    ) -> Result<Result<RemoteInfo, ProbeFailure>> {
        let req = ulid::Ulid::new().to_string();
        let (tx, rx) = oneshot::channel();
        self.probes.write().await.insert(
            req.clone(),
            Asked {
                host: host_id.to_string(),
                waiting: Waiting::Remote(tx),
            },
        );

        let sent = self
            .send(
                host_id,
                ToWorker::ProbeRemote {
                    req: req.clone(),
                    remote: remote.to_string(),
                    credential,
                },
            )
            .await;

        if let Err(e) = sent {
            self.probes.write().await.remove(&req);
            return Err(e);
        }

        match tokio::time::timeout(PROBE_TIMEOUT, rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => {
                anyhow::bail!("the worker connection dropped while checking the repository")
            }
            Err(_) => {
                self.probes.write().await.remove(&req);
                anyhow::bail!("{host_id} did not answer within {PROBE_TIMEOUT:?}")
            }
        }
    }

    /// Ask a host which agents it has.
    pub async fn probe_agents(&self, host_id: &HostId) -> Result<Vec<AgentPresence>> {
        let req = ulid::Ulid::new().to_string();
        let (tx, rx) = oneshot::channel();
        self.probes.write().await.insert(
            req.clone(),
            Asked {
                host: host_id.to_string(),
                waiting: Waiting::Agents(tx),
            },
        );

        if let Err(e) = self
            .send(host_id, ToWorker::ProbeAgents { req: req.clone() })
            .await
        {
            self.probes.write().await.remove(&req);
            return Err(e);
        }

        match tokio::time::timeout(PROBE_TIMEOUT, rx).await {
            Ok(Ok(agents)) => Ok(agents),
            Ok(Err(_)) => anyhow::bail!("the worker connection dropped while checking agents"),
            Err(_) => {
                self.probes.write().await.remove(&req);
                anyhow::bail!("{host_id} did not answer within {PROBE_TIMEOUT:?}")
            }
        }
    }

    /// Start watching a session's terminal.
    ///
    /// Every viewer gets its own receiver off one broadcast, and the worker is
    /// only asked to attach when the first one arrives.
    pub async fn watch(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        pty: Pty,
        cols: u16,
        rows: u16,
    ) -> Result<broadcast::Receiver<Terminal>> {
        let key = terminal_key(session_id, pty);
        let mut terminals = self.terminals.write().await;

        let receiver = match terminals.get(&key) {
            Some(existing) => existing.subscribe(),
            None => {
                // Deep enough that a burst of output during a slow render
                // doesn't drop frames and corrupt the screen.
                let (tx, rx) = broadcast::channel(1024);
                terminals.insert(key.clone(), tx);
                rx
            }
        };
        drop(terminals);

        self.send(
            host_id,
            ToWorker::PtyOpen {
                session_id: session_id.clone(),
                pty,
                cols,
                rows,
            },
        )
        .await?;

        Ok(receiver)
    }

    pub async fn send_input(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        pty: Pty,
        bytes: &[u8],
    ) -> Result<()> {
        self.send(
            host_id,
            ToWorker::PtyInput {
                session_id: session_id.clone(),
                pty,
                data: encode(bytes),
            },
        )
        .await
    }

    pub async fn resize(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        pty: Pty,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        self.send(
            host_id,
            ToWorker::PtyResize {
                session_id: session_id.clone(),
                pty,
                cols,
                rows,
            },
        )
        .await
    }

    /// What is in a directory of a session's workspace.
    pub async fn list_files(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        path: &str,
    ) -> Result<Result<Vec<ft_core::FileEntry>, String>> {
        let req = ulid::Ulid::new().to_string();
        let (tx, rx) = oneshot::channel();
        self.probes.write().await.insert(
            req.clone(),
            Asked {
                host: host_id.to_string(),
                waiting: Waiting::Listing(tx),
            },
        );

        let sent = self
            .send(
                host_id,
                ToWorker::ListFiles {
                    req: req.clone(),
                    session_id: session_id.clone(),
                    path: path.to_string(),
                },
            )
            .await;

        if let Err(e) = sent {
            self.probes.write().await.remove(&req);
            return Err(e);
        }

        match tokio::time::timeout(std::time::Duration::from_secs(20), rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => Err(anyhow::anyhow!("the host stopped answering")),
            Err(_) => {
                self.probes.write().await.remove(&req);
                Err(anyhow::anyhow!("the host didn't answer in time"))
            }
        }
    }

    /// A file, as a stream of pieces.
    ///
    /// The size comes back before the first piece so a browser can be given a
    /// length and a name with its headers. The receiver is where the body comes
    /// from; dropping it stops the download at the next chunk.
    pub async fn read_file(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        path: &str,
    ) -> Result<Result<(u64, mpsc::Receiver<Vec<u8>>), String>> {
        let req = ulid::Ulid::new().to_string();
        let (opened, wait) = oneshot::channel();
        // Shallow on purpose: this is what makes the worker wait for a slow
        // browser instead of the control plane holding a whole file in memory.
        let (chunks, body) = mpsc::channel(4);

        self.probes.write().await.insert(
            req.clone(),
            Asked {
                host: host_id.to_string(),
                waiting: Waiting::File {
                    opened: Some(opened),
                    chunks,
                },
            },
        );

        let sent = self
            .send(
                host_id,
                ToWorker::ReadFile {
                    req: req.clone(),
                    session_id: session_id.clone(),
                    path: path.to_string(),
                },
            )
            .await;

        if let Err(e) = sent {
            self.probes.write().await.remove(&req);
            return Err(e);
        }

        match tokio::time::timeout(std::time::Duration::from_secs(20), wait).await {
            Ok(Ok(Ok(size))) => Ok(Ok((size, body))),
            Ok(Ok(Err(refused))) => {
                self.probes.write().await.remove(&req);
                Ok(Err(refused))
            }
            Ok(Err(_)) => Err(anyhow::anyhow!("the host stopped answering")),
            Err(_) => {
                self.probes.write().await.remove(&req);
                Err(anyhow::anyhow!("the host didn't answer in time"))
            }
        }
    }

    /// Stop watching. Only tells the worker to let go when nobody is left.
    pub async fn unwatch(&self, host_id: &HostId, session_id: &SessionId, pty: Pty) {
        let key = terminal_key(session_id, pty);
        let mut terminals = self.terminals.write().await;
        let alone = terminals
            .get(&key)
            .map(|tx| tx.receiver_count() <= 1)
            .unwrap_or(true);

        if alone {
            terminals.remove(&key);
            drop(terminals);
            let _ = self
                .send(
                    host_id,
                    ToWorker::PtyClose {
                        session_id: session_id.clone(),
                        pty,
                    },
                )
                .await;
        }
    }

    /// Do something with a session's work, and wait for it to finish.
    pub async fn run_action(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        action: ft_proto::Action,
        credential: Option<Credential>,
    ) -> Result<Result<String, String>> {
        let req = ulid::Ulid::new().to_string();
        let (tx, rx) = oneshot::channel();
        self.probes.write().await.insert(
            req.clone(),
            Asked {
                host: host_id.to_string(),
                waiting: Waiting::Action(tx),
            },
        );

        if let Err(e) = self
            .send(
                host_id,
                ToWorker::RunAction {
                    req: req.clone(),
                    session_id: session_id.clone(),
                    action,
                    credential,
                },
            )
            .await
        {
            self.probes.write().await.remove(&req);
            return Err(e);
        }

        // Pushing reaches across a network, so this is generous.
        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => anyhow::bail!("the worker connection dropped"),
            Err(_) => {
                self.probes.write().await.remove(&req);
                anyhow::bail!("that didn't finish in time")
            }
        }
    }

    /// What is in a session's workspace that isn't safely elsewhere.
    pub async fn summarize(&self, host_id: &HostId, session_id: &SessionId) -> Result<WorkSummary> {
        let req = ulid::Ulid::new().to_string();
        let (tx, rx) = oneshot::channel();
        self.probes.write().await.insert(
            req.clone(),
            Asked {
                host: host_id.to_string(),
                waiting: Waiting::Summary(tx),
            },
        );

        if let Err(e) = self
            .send(
                host_id,
                ToWorker::Summarize {
                    req: req.clone(),
                    session_id: session_id.clone(),
                },
            )
            .await
        {
            self.probes.write().await.remove(&req);
            return Err(e);
        }

        match tokio::time::timeout(PROBE_TIMEOUT, rx).await {
            Ok(Ok(summary)) => Ok(summary),
            Ok(Err(_)) => anyhow::bail!("the worker connection dropped"),
            Err(_) => {
                self.probes.write().await.remove(&req);
                anyhow::bail!("the host didn't answer in time")
            }
        }
    }

    pub async fn is_connected(&self, host_id: &HostId) -> bool {
        self.workers.read().await.contains_key(&host_id.to_string())
    }

    /// Stop talking to a host, deliberately.
    ///
    /// Dropping the sender closes the channel, which ends the task pumping
    /// frames to it. Without this, removing a host leaves that task to discover
    /// the far end has gone by failing — which works, but logs an error for
    /// something we did on purpose.
    pub async fn disconnect(&self, host_id: &HostId) {
        self.workers.write().await.remove(&host_id.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::transport::Connection;

    /// A machine that is never there.
    struct Never;

    #[async_trait::async_trait]
    impl Transport for Never {
        fn describe(&self) -> String {
            "a host that isn't there".to_string()
        }
        async fn connect(&self) -> Result<Connection> {
            anyhow::bail!("ssh: connect to host fire-01 port 22: Connection timed out")
        }
    }

    async fn fleet() -> (Fleet, HostId) {
        let db = Db::open_for_test().await.unwrap();
        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local)
            .await
            .unwrap();
        (Fleet::new(db), host.id)
    }

    #[test]
    fn waiting_grows_and_then_stops_growing() {
        let plain = |n| backoff(n, None);

        assert_eq!(plain(0), std::time::Duration::ZERO, "the first try is now");
        assert!(
            plain(1) < plain(3),
            "a host that keeps failing is asked less"
        );
        assert!(
            plain(20) <= RETRY_CAP + RETRY_CAP / 5,
            "a machine that comes back should be noticed within about a minute"
        );
    }

    /// A key nobody accepted is not going to start being accepted a second
    /// later, and each attempt is a process.
    #[test]
    fn a_failure_needing_a_human_is_asked_about_less_often() {
        let soon = backoff(1, None);
        let later = backoff(1, Some(ft_core::Cause::AuthRefused));
        assert!(later > soon, "{later:?} should be longer than {soon:?}");
        assert!(later >= RETRY_FLOOR_HUMAN);
    }

    /// Every host fails at the same moment when a laptop sleeps. Without a
    /// spread they then retry in lockstep for as long as they are down.
    #[test]
    fn waiting_is_not_identical_every_time() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..50 {
            seen.insert(backoff(6, None).as_nanos());
            std::thread::sleep(std::time::Duration::from_micros(50));
        }
        assert!(seen.len() > 1, "every wait was exactly the same length");
    }

    /// The point of the supervisor: a host that didn't answer is still ours,
    /// and something is still trying. That is what the interface reads to tell
    /// "on its way back" from "nobody is looking".
    #[tokio::test]
    async fn a_host_that_never_answers_is_still_being_tried() {
        let (fleet, host) = fleet().await;

        fleet.supervise(host.clone(), Arc::new(Never)).await;

        assert!(fleet.is_supervised(&host).await);
        assert!(!fleet.is_connected(&host).await);

        let said = fleet.db.host_by_id(&host).await.unwrap().unwrap();
        assert_eq!(said.state, ft_core::HostState::Unreachable);
        assert!(said.diagnosis.is_some(), "it should have said why");

        fleet.stop_supervising(&host).await;
        assert!(!fleet.is_supervised(&host).await);
    }

    /// Two supervisors on one host would be two connections racing to register
    /// in the same slot, and only one of them would be reachable.
    #[tokio::test]
    async fn supervising_twice_is_supervising_once() {
        let (fleet, host) = fleet().await;

        fleet.supervise(host.clone(), Arc::new(Never)).await;
        fleet.supervise(host.clone(), Arc::new(Never)).await;

        assert_eq!(fleet.supervised.read().await.len(), 1);
        fleet.stop_supervising(&host).await;
    }

    /// Waiting for a host nobody is trying to reach would be waiting forever
    /// for a promise that was never made.
    #[tokio::test]
    async fn nothing_waits_on_a_host_that_is_not_being_tried() {
        let (fleet, host) = fleet().await;

        let began = std::time::Instant::now();
        let came_back = fleet
            .wait_until_connected(&host, std::time::Duration::from_secs(30))
            .await;

        assert!(!came_back);
        assert!(
            began.elapsed() < std::time::Duration::from_secs(1),
            "it should not have waited out the whole grace period"
        );
    }

    #[tokio::test]
    async fn a_host_nobody_supervises_cannot_be_asked_to_try_now() {
        let (fleet, host) = fleet().await;
        assert!(!fleet.try_now(&host).await);

        fleet.supervise(host.clone(), Arc::new(Never)).await;
        assert!(fleet.try_now(&host).await);
        fleet.stop_supervising(&host).await;
    }
}

#[cfg(test)]
mod supervisor_tests {
    use super::*;
    use crate::db::Db;
    use crate::transport::Connection;

    /// A worker that answers, and keeps the connection open afterwards.
    struct Alive {
        once: std::sync::Mutex<Option<Connection>>,
    }

    impl Alive {
        fn new() -> Arc<Self> {
            let (ours, theirs) = tokio::io::duplex(4096);

            tokio::spawn(async move {
                let (r, w) = tokio::io::split(theirs);
                let mut codec = Codec::new(r, w);
                while let Ok(frame) = codec.read::<ToWorker>().await {
                    let answer = match frame {
                        ToWorker::Hello { .. } => Some(ToServer::Hello {
                            protocol: PROTOCOL_VERSION,
                            worker_version: "0.1.0".to_string(),
                            arch: "test".to_string(),
                            cpus: 1,
                            memory_mb: 0,
                        }),
                        ToWorker::Ping => Some(ToServer::Pong),
                        _ => None,
                    };
                    if let Some(answer) = answer {
                        if codec.write(&answer).await.is_err() {
                            break;
                        }
                    }
                }
            });

            let (r, w) = tokio::io::split(ours);
            Arc::new(Self {
                once: std::sync::Mutex::new(Some(Connection::piped(Box::new(r), Box::new(w)))),
            })
        }
    }

    #[async_trait::async_trait]
    impl Transport for Alive {
        fn describe(&self) -> String {
            "a worker that answers".to_string()
        }
        async fn connect(&self) -> Result<Connection> {
            self.once
                .lock()
                .unwrap()
                .take()
                .context("this fake worker can only be connected to once")
        }
    }

    /// Serving a connection happens inside `connect`, so it only returns when
    /// the connection *ends*. Waiting for that to learn whether a host answered
    /// means waiting for it to stop answering — which held up start-up at the
    /// first host that worked, and left everything after it unsupervised.
    #[tokio::test]
    async fn supervising_returns_while_the_host_is_still_connected() {
        let db = Db::open_for_test().await.unwrap();
        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local)
            .await
            .unwrap();
        let fleet = Fleet::new(db);

        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            fleet.supervise(host.id.clone(), Alive::new()),
        )
        .await
        .expect("it must not wait for the connection to end");

        assert!(
            fleet.is_connected(&host.id).await,
            "it should have come back with the host connected, not disconnected"
        );

        fleet.stop_supervising(&host.id).await;
    }
}

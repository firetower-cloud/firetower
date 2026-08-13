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
    decode, encode, Codec, CodecError, Credential, ProbeFailure, RemoteInfo, ReqId, ToServer,
    ToWorker, PROTOCOL_VERSION,
};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, oneshot, RwLock};

/// Long enough for a cold network, short enough that nobody watches a spinner
/// forever. The worker gives up before this, so hitting it means the worker
/// itself stopped answering.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

use crate::transport::Transport;

/// A session's terminal, as it reaches a viewer.
#[derive(Clone, Debug)]
pub enum Terminal {
    /// Raw bytes. Not text: escape sequences and partial UTF-8 both travel here.
    Data(Vec<u8>),
    /// The agent's terminal went away.
    Closed,
}

/// One map for everything waiting on an answer, so the timeout and the
/// clean-up-on-disconnect logic exist once rather than once per request type.
enum Waiting {
    Remote(oneshot::Sender<Result<RemoteInfo, ProbeFailure>>),
    Agents(oneshot::Sender<Vec<AgentPresence>>),
    Action(oneshot::Sender<Result<String, String>>),
    Summary(oneshot::Sender<WorkSummary>),
}

#[derive(Clone)]
pub struct Fleet {
    db: Db,
    workers: Arc<RwLock<HashMap<String, mpsc::Sender<ToWorker>>>>,
    /// Fan-out to whoever is watching — the event stream, ultimately the browser.
    events: broadcast::Sender<Event>,
    /// Requests waiting for their answer. Most frames are one-way and correlate
    /// on a session; a probe has no session, so it correlates on its own id.
    probes: Arc<RwLock<HashMap<ReqId, Waiting>>>,
    /// Live terminals, one broadcast per session. The worker holds a single
    /// attachment; this is where it fans out to however many are watching.
    terminals: Arc<RwLock<HashMap<String, broadcast::Sender<Terminal>>>>,
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
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// Connect to a host, handshake, and start serving its frames.
    ///
    /// The first thing sent after the handshake is a resume request, so anything
    /// that happened while we were away arrives before anything new.
    pub async fn connect(&self, host_id: HostId, transport: Arc<dyn Transport>) -> Result<()> {
        let mut conn = transport
            .connect()
            .await
            .with_context(|| format!("connecting via {}", transport.describe()))?;

        let mut codec = Codec::new(&mut conn.reader, &mut conn.writer);

        codec
            .write(&ToWorker::Hello {
                protocol: PROTOCOL_VERSION,
                client_version: env!("CARGO_PKG_VERSION").to_string(),
            })
            .await?;

        match codec.read::<ToServer>().await {
            Ok(ToServer::Hello {
                protocol,
                worker_version,
                cpus,
                memory_mb,
                ..
            }) => {
                if protocol != PROTOCOL_VERSION {
                    anyhow::bail!("worker speaks protocol {protocol}, we speak {PROTOCOL_VERSION}");
                }
                self.db
                    .mark_host_online(&host_id, &worker_version, cpus, memory_mb)
                    .await?;
                tracing::info!(host = %host_id, version = %worker_version, "worker online");
            }
            Ok(_) => anyhow::bail!("worker replied with something other than Hello"),
            Err(e) => return Err(e).context("waiting for the worker handshake"),
        }

        let since = self.db.last_seq(&host_id).await?;
        codec.write(&ToWorker::Resume { since }).await?;

        let (tx, mut rx) = mpsc::channel::<ToWorker>(64);
        self.workers.write().await.insert(host_id.to_string(), tx);

        let db = self.db.clone();
        let events = self.events.clone();
        let workers = self.workers.clone();
        let probes = self.probes.clone();
        let terminals = self.terminals.clone();

        tokio::spawn(async move {
            // conn is moved in so the child process outlives this scope
            let mut conn = conn;
            let mut codec = Codec::new(&mut conn.reader, &mut conn.writer);

            loop {
                tokio::select! {
                    outbound = rx.recv() => match outbound {
                        Some(frame) => {
                            if let Err(e) = codec.write(&frame).await {
                                tracing::error!(host = %host_id, "sending to worker: {e}");
                                break;
                            }
                        }
                        None => break,
                    },

                    inbound = codec.read::<ToServer>() => match inbound {
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
                                Some(Waiting::Remote(reply)) => { let _ = reply.send(result); }
                                Some(other) => { probes.write().await.insert(req, other); }
                                None => tracing::debug!("a probe answer arrived after its request gave up"),
                            }
                        }
                        Ok(ToServer::PtyOutput { session_id, data }) => {
                            if let Some(bytes) = decode(&data) {
                                if let Some(tx) = terminals.read().await.get(session_id.as_str()) {
                                    // An error only means nobody is watching.
                                    let _ = tx.send(Terminal::Data(bytes));
                                }
                            }
                        }
                        Ok(ToServer::PtyClosed { session_id }) => {
                            if let Some(tx) = terminals.write().await.remove(session_id.as_str()) {
                                let _ = tx.send(Terminal::Closed);
                            }
                        }
                        Ok(ToServer::ActionDone { req, result }) => {
                            match probes.write().await.remove(&req) {
                                Some(Waiting::Action(reply)) => { let _ = reply.send(result); }
                                // A summary that failed comes back as an action
                                // error, since there is no summary to send.
                                Some(Waiting::Summary(_)) => {}
                                Some(other) => { probes.write().await.insert(req, other); }
                                None => tracing::debug!("an action finished after its request gave up"),
                            }
                        }
                        Ok(ToServer::Summarized { req, summary }) => {
                            match probes.write().await.remove(&req) {
                                Some(Waiting::Summary(reply)) => { let _ = reply.send(summary); }
                                Some(other) => { probes.write().await.insert(req, other); }
                                None => tracing::debug!("a summary arrived after its request gave up"),
                            }
                        }
                        Ok(ToServer::AgentsProbed { req, agents }) => {
                            match probes.write().await.remove(&req) {
                                Some(Waiting::Agents(reply)) => { let _ = reply.send(agents); }
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
                    },
                }
            }

            // Sessions on this host keep running; we just can't see them.
            workers.write().await.remove(&host_id.to_string());
            // Anything still waiting on this worker will never hear back, so
            // fail it now rather than leaving the interface spinning.
            for (_, waiting) in probes.write().await.drain() {
                match waiting {
                    Waiting::Remote(reply) => {
                        let _ = reply.send(Err(ProbeFailure::Unreachable));
                    }
                    // Dropping the sender is the signal; there is no "we asked
                    // and the answer was none" for these.
                    Waiting::Agents(_) | Waiting::Summary(_) => {}
                    Waiting::Action(reply) => {
                        let _ = reply.send(Err("the host stopped answering".into()));
                    }
                }
            }
            let _ = db.mark_host_unreachable(&host_id).await;
        });

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
        self.probes
            .write()
            .await
            .insert(req.clone(), Waiting::Remote(tx));

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
        self.probes
            .write()
            .await
            .insert(req.clone(), Waiting::Agents(tx));

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
        cols: u16,
        rows: u16,
    ) -> Result<broadcast::Receiver<Terminal>> {
        let mut terminals = self.terminals.write().await;

        let receiver = match terminals.get(session_id.as_str()) {
            Some(existing) => existing.subscribe(),
            None => {
                // Deep enough that a burst of output during a slow render
                // doesn't drop frames and corrupt the screen.
                let (tx, rx) = broadcast::channel(1024);
                terminals.insert(session_id.to_string(), tx);
                rx
            }
        };
        drop(terminals);

        self.send(
            host_id,
            ToWorker::PtyOpen {
                session_id: session_id.clone(),
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
        bytes: &[u8],
    ) -> Result<()> {
        self.send(
            host_id,
            ToWorker::PtyInput {
                session_id: session_id.clone(),
                data: encode(bytes),
            },
        )
        .await
    }

    pub async fn resize(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        self.send(
            host_id,
            ToWorker::PtyResize {
                session_id: session_id.clone(),
                cols,
                rows,
            },
        )
        .await
    }

    /// Stop watching. Only tells the worker to let go when nobody is left.
    pub async fn unwatch(&self, host_id: &HostId, session_id: &SessionId) {
        let mut terminals = self.terminals.write().await;
        let alone = terminals
            .get(session_id.as_str())
            .map(|tx| tx.receiver_count() <= 1)
            .unwrap_or(true);

        if alone {
            terminals.remove(session_id.as_str());
            drop(terminals);
            let _ = self
                .send(
                    host_id,
                    ToWorker::PtyClose {
                        session_id: session_id.clone(),
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
        self.probes
            .write()
            .await
            .insert(req.clone(), Waiting::Action(tx));

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
    pub async fn summarize(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
    ) -> Result<WorkSummary> {
        let req = ulid::Ulid::new().to_string();
        let (tx, rx) = oneshot::channel();
        self.probes
            .write()
            .await
            .insert(req.clone(), Waiting::Summary(tx));

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
}

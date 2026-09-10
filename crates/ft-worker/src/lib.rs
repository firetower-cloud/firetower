//! The Firetower worker daemon.
//!
//! Reads frames from a stream, does the work, records what happened, and sends
//! it back. It has no idea whether the far end is a local pipe, an SSH tunnel or
//! a websocket — that indifference is the whole reason a laptop today and a
//! hosted control plane later can drive the identical binary.

use anyhow::{Context, Result};
use ft_core::{EventKind, SessionId, SessionStatus, Step};
use ft_proto::{Codec, CodecError, CreateWorkspace, Pty, ToServer, ToWorker, PROTOCOL_VERSION};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// How much of a directory is worth sending. A worktree with `node_modules` in
/// it has hundreds of thousands of entries and nobody reads past the first few.
const LISTING_LIMIT: usize = 500;

/// The most paths a search walks before it stops looking. A monorepo's index
/// is tens of thousands; past this the ranking is decided long before the walk
/// would finish.
const SEARCH_LIMIT: usize = 20_000;

/// Directories a filename search never descends into. Every one of them is
/// generated, and finding `index.js` four thousand times inside `node_modules`
/// is the same as finding it nowhere.
const UNSEARCHED: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    "vendor",
];

/// How much of a file goes in one frame.
///
/// Matched to the tunnels' chunk, and for the same reason: a frame that has
/// started writing cannot be overtaken, so the control lane's head start is
/// only ever as good as the largest bulk frame in front of it. At 256KB a
/// heartbeat could still wait out a quarter-megabyte on a slow line, which is
/// most of what the lane was meant to prevent.
const CHUNK: usize = 32 * 1024;

/// The most that comes down this pipe. Above it, the answer is a message
/// naming a better tool rather than a minute of stuttering terminals.
const MAX_DOWNLOAD: u64 = 100 * 1_048_576;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, Mutex};

pub mod agentd;
pub mod agents;
pub mod approver;
pub mod askpass;
pub mod attach;
pub mod attachments;
pub mod capacity;
pub mod cgroup;
pub mod codex;
pub mod describe;
pub mod docker;
pub mod entry;
pub mod first_run;
pub mod git;
pub mod history;
pub mod hooks;
pub mod runtime;
pub mod store;
pub mod structured;
pub mod tmux;
pub mod tunnel;

use git::GitRoot;
use store::Store;
use tmux::Tmux;

/// Everything a worker needs to do its job on one machine.
/// A checkout with its place on disk resolved.
struct Located {
    dest: PathBuf,
    slug: String,
    base: String,
}

pub struct Worker {
    store: Store,
    git: GitRoot,
    /// Where this worker keeps everything, including the log a hook appends to.
    root: PathBuf,
    /// The highest sequence number already sent to a control plane.
    ///
    /// A hook is a separate process appending to the same log, so events now
    /// arrive from two directions: this worker, and whatever the agent just
    /// did. One cursor, held across both, is what stops an event being sent
    /// twice or not at all.
    forwarded: Mutex<i64>,
    /// One terminal attachment per session, however many people are watching.
    attached: Mutex<HashMap<String, attach::Attachment>>,
    /// Sessions whose structured agent is being forwarded upward.
    ///
    /// Held so a second watcher does not double every line, and so closing a
    /// session stops the forwarding rather than leaving it talking to nobody.
    watching: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    /// Ports of this machine's sessions, reached over the pipe rather than the
    /// network. Still nothing listening here — see [`tunnel`].
    tunnels: std::sync::Arc<tunnel::Tunnels>,
}

/// How many frames may be queued for the control plane at once.
///
/// Anything that can produce more than this in one go has to run off the serve
/// loop — see [`takes_a_while`].
/// How often a worker says what its machine is doing.
///
/// Slow enough that `df` and `docker system df` cost nothing measurable, and
/// fast enough that a meter follows a build starting. The numbers it carries
/// are drawn as meters that move; they are not decisions anything waits on.
const REPORT_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

const OUTBOUND: usize = 1024;

/// How many control frames may wait. Small on purpose: they are tens of bytes
/// and a few a second, so a backlog here would mean something else is wrong.
const EXPRESS: usize = 256;

/// Everything the worker says, in two lanes.
///
/// One pipe carries every terminal, every event, every preview and every
/// download on this machine, and it is strictly ordered — so a heartbeat sent
/// behind thirty megabytes of a preview page arrives thirty megabytes later.
/// The control plane judges a host by whether it has heard from it in fifty
/// seconds, which makes "busy" and "dead" the same observation.
///
/// So the frames that answer for the connection's life, and the ones somebody
/// is actively waiting on — a summary, a commit, a pull request — go in a lane
/// of their own that the writer drains first. They are tiny and rare, so
/// nothing else is starved by letting them past.
///
/// Which lane a frame takes is decided here rather than at the call sites,
/// because every one of those already says what it is sending.
#[derive(Clone)]
pub struct Out {
    control: mpsc::Sender<ToServer>,
    bulk: mpsc::Sender<ToServer>,
}

impl Out {
    fn lane(&self, frame: &ToServer) -> &mpsc::Sender<ToServer> {
        if is_bulk(frame) {
            &self.bulk
        } else {
            &self.control
        }
    }

    pub async fn send(&self, frame: ToServer) -> Result<(), mpsc::error::SendError<ToServer>> {
        self.lane(&frame).send(frame).await
    }

    /// Two lanes, drained in that order by whoever holds the far ends.
    pub fn new(control: mpsc::Sender<ToServer>, bulk: mpsc::Sender<ToServer>) -> Self {
        Self { control, bulk }
    }

    /// Both lanes into one channel.
    ///
    /// For somewhere that only wants to see what came out — a test, or a fake
    /// worker standing in for a real one — where the ordering the lanes exist
    /// to produce is not what is being examined.
    pub fn merged(sender: mpsc::Sender<ToServer>) -> Self {
        Self {
            control: sender.clone(),
            bulk: sender,
        }
    }

    /// From a thread that is not the runtime's — a pty reader, which is
    /// blocking by nature.
    pub fn blocking_send(&self, frame: ToServer) -> Result<(), mpsc::error::SendError<ToServer>> {
        self.lane(&frame).blocking_send(frame)
    }
}

/// Whether this frame is somebody's bytes rather than the worker's answer.
///
/// Bulk is anything whose size is set by what a session is doing: a page being
/// served, a file being fetched, a terminal printing. Everything else is a
/// sentence about the machine and belongs in front of it.
fn is_bulk(frame: &ToServer) -> bool {
    matches!(
        frame,
        ToServer::TunnelData { .. }
            | ToServer::TunnelCredit { .. }
            | ToServer::FileChunk { .. }
            | ToServer::PtyOutput { .. }
    )
}

/// One agent, and where to put it.
///
/// A struct because these six travel together and mean one thing: this agent,
/// in this directory, under this tmux session, with this environment. As
/// arguments they were an unlabelled row that two callers had to get in the
/// same order — and clippy was right that eight of them is too many.
struct Launch<'a> {
    id: &'a SessionId,
    path: &'a std::path::Path,
    tmux: &'a Tmux,
    env: &'a [(String, String)],
    agent: ft_core::Agent,
    prompt: &'a str,
}

impl Worker {
    /// Open (or create) the worker's state under `root`.
    pub async fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        let store = Store::open(&root.join("worker.db")).await?;
        let latest = store.latest_seq().await.unwrap_or(0);

        // A sign-in that nobody finished leaves the directory it was going to
        // land in. The task that would have removed it dies with the worker,
        // so restarting is the only moment anything can.
        //
        // Safe to do wholesale: one of these is only interesting while the
        // process waiting on it is alive, and none of them is.
        let _ = tokio::fs::remove_dir_all(root.join("codex-login")).await;

        Ok(Self {
            store,
            git: GitRoot::new(&root),
            attached: Mutex::new(HashMap::new()),
            watching: Mutex::new(HashMap::new()),
            tunnels: std::sync::Arc::new(tunnel::Tunnels::new()),
            root,
            // Everything already in the log predates this connection. A
            // control plane that wants it asks, with `Resume`.
            forwarded: Mutex::new(latest),
        })
    }

    /// Serve frames until the stream closes.
    ///
    /// The handshake happens first and refuses a version mismatch loudly, since
    /// a silently incompatible worker is far worse than one that won't start.
    /// Speak frames until the control plane goes away.
    ///
    /// Takes `Arc<Self>` because the work a frame asks for does not happen on
    /// this loop — see below.
    pub async fn serve<R, W>(self: std::sync::Arc<Self>, reader: R, writer: W) -> Result<()>
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let (mut inbound, mut outbound) = Codec::new(reader, writer).split();

        match inbound.read::<ToWorker>().await {
            Ok(ToWorker::Hello { protocol, .. }) if protocol == PROTOCOL_VERSION => {}
            Ok(ToWorker::Hello { protocol, .. }) => {
                anyhow::bail!(
                    "control plane speaks protocol {protocol}, this worker speaks {PROTOCOL_VERSION}"
                );
            }
            Ok(_) => anyhow::bail!("expected a Hello frame first"),
            Err(CodecError::Closed) => return Ok(()),
            Err(e) => return Err(e.into()),
        }

        // Asked here, on every handshake, rather than once at start-up: this
        // process is short-lived — one per control-plane connection — and the
        // answer can change under a long-lived container when a daemon is
        // restarted or an operator installs Docker on a host that had none.
        // Every reconnect is therefore a fresh answer rather than a cached one.
        let docker = crate::docker::state().await;
        tracing::info!(docker = %docker.summary(), "reporting what this machine can run");

        outbound
            .write(&ToServer::Hello {
                protocol: PROTOCOL_VERSION,
                worker_version: env!("CARGO_PKG_VERSION").to_string(),
                arch: std::env::consts::ARCH.to_string(),
                cpus: num_cpus(),
                memory_mb: 0,
                docker,
            })
            .await?;

        // Everything the worker says goes through here. A terminal streams
        // output while we're still waiting on the next command, which a single
        // read-then-write loop can't express.
        let (control, mut express) = mpsc::channel::<ToServer>(EXPRESS);
        let (bulk, mut pending) = mpsc::channel::<ToServer>(OUTBOUND);
        let out = Out::new(control, bulk);

        // Draining is its own future, and that is not a tidiness point.
        //
        // It used to be a branch of the loop below, which made the loop both
        // the only thing that fills this channel and the only thing that
        // empties it. Any send from the loop — a `Pong`, a `Usage`, the
        // `TunnelOpened` for a preview — was therefore waiting on a drain that
        // could not happen until the send it was waiting on returned. Once the
        // channel filled, the worker went silent for good with the connection
        // still open and healthy-looking, and the control plane gave the host
        // up as dead fifty seconds later. A preview page load, which opens one
        // tunnel per request, filled it reliably.
        //
        // Joined rather than spawned so the bounds stay `Unpin` instead of
        // `Send + 'static`: two futures in one task are polled independently,
        // which is all this needs. A full channel is now backpressure — the
        // loop pauses, this drains, the loop resumes.
        let writing = async move {
            loop {
                // Control first, always. A `Pong` or a finished commit is tens
                // of bytes and comes a few times a second at most, so nothing
                // is starved by letting it past a preview that is mid-page.
                let frame = tokio::select! {
                    biased;
                    Some(frame) = express.recv() => frame,
                    Some(frame) = pending.recv() => frame,
                    else => break,
                };
                outbound.write(&frame).await?;
            }
            Ok::<(), anyhow::Error>(())
        };

        let serving = async move {
            // Owned here rather than outside, so that returning from this drops
            // the last sender and lets `writing` finish what is still queued.
            let out = out;

            // Work that is happening off this loop. Held so that a disconnect can
            // wait for it rather than dropping a half-built workspace on the floor.
            let mut running = tokio::task::JoinSet::new();

            // The last CPU reading for each workspace, so the next one can be a
            // rate. A cgroup counts CPU as a total since it was made, and a total
            // is not what anybody wants to see: two readings and the time between
            // them are what turn it into cores in use.
            //
            // Here rather than on `self` because it belongs to this connection. A
            // control plane that reconnects starts again from no history, and the
            // first report after that carries no rate rather than a wrong one.
            let mut cpu_seen: std::collections::HashMap<String, (u64, std::time::Instant)> =
                std::collections::HashMap::new();

            // Far enough in the past that the first tick reports rather than
            // waiting five seconds to say anything at all.
            let mut last_reported = std::time::Instant::now() - REPORT_EVERY;

            loop {
                tokio::select! {
                    // Bias towards the timer: what the agent said about itself
                    // should reach the control plane before we go looking for more
                    // work. Draining is no longer a branch here — see `writing`.
                    biased;

                    // What the agent said about itself, through a hook, since we
                    // last looked.
                    _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {
                        if let Err(e) = self.forward_new_events(&out).await {
                            tracing::debug!("forwarding hook events: {e:#}");
                        }

                        // And what this machine is doing, rather less often.
                        //
                        // On the same tick because a second timer in this select
                        // would be a second thing to keep in step with it, and this
                        // is one comparison. Every five seconds is slow enough that
                        // `df` and `docker system df` cost nothing measurable and
                        // fast enough that a meter follows a build starting.
                        if last_reported.elapsed() >= REPORT_EVERY {
                            last_reported = std::time::Instant::now();
                            self.report_usage(&out, &mut cpu_seen).await;
                        }
                    }

                    incoming = inbound.read::<ToWorker>() => {
                        let frame = match incoming {
                            Ok(f) => f,
                            Err(CodecError::Closed) => {
                                // Finish what is already under way before going
                                // quiet. Returning here instead would drop the
                                // tasks — and a workspace abandoned halfway through
                                // its clone is worse than one that finishes with
                                // nobody listening. What it says is written out as
                                // it says it, so a control plane that reconnects
                                // has it waiting in the log.
                                //
                                // Nothing is drained here any more: `writing` is
                                // running alongside this and carries on until the
                                // last sender is dropped, which is what returning
                                // does.
                                while running.join_next().await.is_some() {}
                                tracing::info!("control plane disconnected; sessions keep running");
                                return Ok(());
                            }
                            Err(CodecError::Malformed(e)) => {
                                // One bad frame shouldn't take down a worker that
                                // has live sessions on it — but swallowing it in a
                                // log nobody reads is how a session sits in
                                // `Starting` forever. Say it upward too.
                                tracing::warn!("ignoring malformed frame: {e}");
                                let _ = out
                                    .send(ToServer::Error {
                                        session_id: None,
                                        code: "MalformedFrame".into(),
                                        message: format!(
                                            "this worker couldn't read a frame — it is probably \
                                             older than the control plane: {e}"
                                        ),
                                    })
                                    .await;
                                continue;
                            }
                            Err(e) => return Err(e.into()),
                        };

                        // Anything that takes real time runs on its own task.
                        //
                        // Handling it here instead means this loop stops: for as
                        // long as a workspace is being built, nothing is written
                        // out and nothing is read in. A repository that takes eight
                        // minutes to clone therefore made the worker mute and deaf
                        // for eight minutes — every event it recorded sat in the
                        // channel, the session looked frozen, and it could not even
                        // be told to stop. The connection stays perfectly healthy
                        // throughout, which is what makes it so hard to see.
                        if takes_a_while(&frame) {
                            let worker = self.clone();
                            let out = out.clone();
                            running.spawn(async move {
                                if let Err(e) = worker.handle(frame, &out).await {
                                    tracing::error!("{e:#}");
                                    let _ = out.send(ToServer::Error {
                                        session_id: None,
                                        code: "Internal".into(),
                                        message: format!("{e:#}"),
                                    }).await;
                                }
                            });
                            continue;
                        }

                        match self.handle(frame, &out).await {
                            Ok(true) => {}
                            Ok(false) => return Ok(()),
                            Err(e) => {
                                tracing::error!("{e:#}");
                                let _ = out.send(ToServer::Error {
                                    session_id: None,
                                    code: "Internal".into(),
                                    message: format!("{e:#}"),
                                }).await;
                            }
                        }
                    }
                }
            }
        };

        // Both, together, in this task. `writing` only ends once `serving` has
        // returned and dropped the last sender, so nothing queued is lost.
        tokio::try_join!(serving, writing)?;
        Ok(())
    }

    /// Returns `false` when the worker should stop serving.
    async fn handle(&self, frame: ToWorker, out: &Out) -> Result<bool> {
        match frame {
            ToWorker::Ping => out.send(ToServer::Pong).await?,

            ToWorker::Hello { .. } => {
                tracing::warn!("a second Hello arrived; ignoring it");
            }

            // Everything that happened since the control plane last looked.
            // This is what makes closing the laptop safe.
            ToWorker::Resume { since } => {
                let missed = self.store.events_since(since).await?;
                tracing::info!("replaying {} events after {since}", missed.len());
                for e in missed {
                    out.send(ToServer::Event {
                        seq: e.seq,
                        session_id: e.session_id,
                        kind: e.kind,
                        at: e.at,
                    })
                    .await?;
                }
            }

            ToWorker::ProbeAgents { req } => {
                let agents = agents::probe(&self.root).await;
                out.send(ToServer::AgentsProbed { req, agents }).await?;
            }

            // Slow — npm, a few hundred megabytes — so this arm only runs
            // because `takes_a_while` keeps it off the message loop. On the
            // loop it would hold up the heartbeats and the control plane would
            // give the connection up as dead half way through.
            ToWorker::InstallAgent { req, kind, version } => {
                let result = runtime::install(&self.root, kind, version.as_deref())
                    .await
                    .map(|installed| installed.version)
                    .map_err(|e| format!("{e:#}"));
                out.send(ToServer::AgentInstalled { req, result }).await?;
            }

            // Signing in happens on the machine that will run the agent,
            // because that is the machine OpenAI hands the credential to.
            //
            // Two answers, minutes apart: the code to show, and then whatever
            // came of somebody approving it. The waiting is a task rather than
            // this function, which has a whole worker's other frames to carry.
            ToWorker::CodexLoginStart { req } => {
                let home = self.root.join("codex-login").join(&req);
                let started = codex::start(&self.root, &home).await;

                match started {
                    Err(e) => {
                        out.send(ToServer::CodexLoginPending {
                            req,
                            result: Err(format!("{e:#}")),
                        })
                        .await?;
                    }
                    Ok((pending, waiting)) => {
                        out.send(ToServer::CodexLoginPending {
                            req: req.clone(),
                            result: Ok(ft_proto::CodexPending {
                                user_code: pending.user_code,
                                verification_url: pending.verification_url,
                            }),
                        })
                        .await?;

                        let out = out.clone();
                        tokio::spawn(async move {
                            let result = waiting
                                .finish()
                                .await
                                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                                .map_err(|e| format!("{e:#}"));

                            // The credential is the control plane's to keep.
                            // Ours was a place for it to land, and leaving a
                            // copy on a host is the thing this whole design
                            // exists to avoid.
                            let _ = tokio::fs::remove_dir_all(&home).await;

                            let _ = out.send(ToServer::CodexLoginFinished { req, result }).await;
                        });
                    }
                }
            }

            // Answering this needs the credentials and the network of the
            // machine that will do the cloning, which is why it is asked here
            // rather than worked out by the control plane.
            ToWorker::ProbeRemote {
                req,
                remote,
                credential,
            } => {
                let result = self.git.probe(&remote, credential).await;
                out.send(ToServer::RemoteProbed { req, result }).await?;
            }

            ToWorker::SetShare { session_id, share } => {
                // Cheap and inline: two small writes to a cgroup file, with no
                // process to start and nothing to wait for.
                //
                // Silent about a workspace it cannot find. The row is gone if
                // the session ended between the control plane sending this and
                // it arriving, and a session that has ended has no share left
                // to change.
                match self.store.workspace_path(&session_id).await {
                    Ok(Some(path)) => {
                        let path = std::path::PathBuf::from(path);
                        let size = self
                            .store
                            .session_size(&session_id)
                            .await
                            .unwrap_or_default();
                        crate::cgroup::apply(&path, crate::cgroup::Limits { share, size }).await;
                        tracing::info!(session = %session_id, ?share, "workspace re-weighted");
                    }
                    Ok(None) => {
                        tracing::debug!(session = %session_id, "no workspace to re-weight")
                    }
                    Err(e) => tracing::warn!(session = %session_id, "re-weighting: {e:#}"),
                }
            }

            ToWorker::StartAgent(spec) => {
                let session_id = spec.session_id.clone();
                if let Err(e) = self.start_agent(*spec, out).await {
                    // The same shape as a failed build, because it is the same
                    // thing to whoever is watching: an agent that was asked for
                    // and is not there. The workspace itself is untouched —
                    // this never made it, so it cannot have broken it.
                    let kind = EventKind::Failed {
                        code: "SetupFailed".into(),
                        message: format!("{e:#}"),
                    };
                    self.emit(&session_id, kind, out).await?;
                    self.store
                        .set_status(&session_id, SessionStatus::Failed)
                        .await?;
                    self.emit(
                        &session_id,
                        EventKind::StatusChanged {
                            status: SessionStatus::Failed,
                            note: None,
                        },
                        out,
                    )
                    .await?;
                }
            }
            ToWorker::CreateWorkspace(spec) => {
                let session_id = spec.session_id.clone();
                if let Err(e) = self.create_workspace(*spec, out).await {
                    let kind = EventKind::Failed {
                        code: "SetupFailed".into(),
                        message: format!("{e:#}"),
                    };
                    self.emit(&session_id, kind, out).await?;
                    self.store
                        .set_status(&session_id, SessionStatus::Failed)
                        .await?;
                    self.emit(
                        &session_id,
                        EventKind::StatusChanged {
                            status: SessionStatus::Failed,
                            note: None,
                        },
                        out,
                    )
                    .await?;
                }
            }

            ToWorker::Destroy { session_id, .. } => {
                // Everything goes: the agent, its terminal, its ports, and the
                // worktree.
                self.tunnels.close_session(&session_id).await;
                self.attached.lock().await.remove(session_id.as_str());
                self.attached
                    .lock()
                    .await
                    .remove(&terminal_key(&session_id, Pty::Shell));
                // Whatever was worth keeping should already have been pushed.
                Tmux::for_session(session_id.as_str()).kill().await?;
                // And the shell, which would otherwise sit in a directory that
                // is about to stop existing.
                Tmux::named(Pty::Shell.tmux_name(session_id.as_str()))
                    .kill()
                    .await?;

                // And whatever it started in Docker.
                //
                // **Before the worktree goes, not after.** A compose service
                // almost always bind-mounts the checkout, and removing the
                // directory under a running container leaves it writing into
                // a path that no longer exists — and the removal itself
                // fighting a container still holding files open in it.
                //
                // This is the whole of teardown for Docker: the daemon is
                // shared by every session on this worker, so there is no
                // container of its own to throw away. See `docker::sweep`.
                crate::docker::sweep(&session_id).await;

                // Ended before the count is taken, so that the last agent out
                // is decided the same way however many are ending at once. Two
                // concurrent teardowns each see the other already finished and
                // both reclaim; the directory is removed once and the second
                // gets NotFound, which is handled below. The alternative —
                // counting first — has both see a live sibling and neither
                // reclaim, which leaks the worktree.
                self.store
                    .set_status(&session_id, SessionStatus::Ended)
                    .await?;

                // The worktree belongs to the workspace, not to this agent.
                // With a sibling still running in it, removing it would delete
                // the directory out from under a live process; the last agent
                // out reclaims it instead.
                let alone = self
                    .store
                    .others_in_workspace(&session_id)
                    .await?
                    .is_empty();
                if !alone {
                    tracing::info!(
                        session = %session_id,
                        "ending this agent; its workspace stays for the others in it"
                    );
                }

                // Each worktree is registered against its own mirror, so
                // removing one means finding the mirror it was cut from. A
                // session holds any number of them.
                let workspace = if alone {
                    self.store.workspace_path(&session_id).await?
                } else {
                    None
                };
                if let Some(workspace) = workspace.as_deref().map(std::path::Path::new) {
                    // The accounting goes with the workspace it accounted for.
                    //
                    // Here rather than beside the Docker sweep because this is
                    // the workspace's, not this agent's: `alone` is what put us
                    // in this branch, so the last agent out is the one that
                    // takes it away. A sibling still working keeps its cgroup
                    // and the limits on it.
                    crate::cgroup::remove(workspace, &session_id).await;

                    for c in self
                        .store
                        .checkouts_of(&session_id)
                        .await
                        .unwrap_or_default()
                    {
                        let mirror = self.git.mirror_path(&c.slug);
                        let dest = if c.path.is_empty() {
                            workspace.to_path_buf()
                        } else {
                            workspace.join(&c.path)
                        };
                        if let Err(e) = self.git.remove_worktree_at(&mirror, &dest).await {
                            // Worth saying out loud: a worktree left behind is
                            // disk that never comes back on its own.
                            tracing::error!(session = %session_id, repo = %c.slug, "removing the worktree: {e:#}");
                        }
                    }

                    // Recorded before checkouts were: the workspace *is* the
                    // worktree, and the old shape is what has to be reclaimed.
                    if self
                        .store
                        .checkouts_of(&session_id)
                        .await
                        .unwrap_or_default()
                        .is_empty()
                    {
                        if let Some(slug) = self.store.repo_of(&session_id).await? {
                            let mirror = self.git.mirror_path(&slug);
                            if let Err(e) = self.git.remove_worktree_at(&mirror, workspace).await {
                                tracing::error!(session = %session_id, "removing the worktree: {e:#}");
                            }
                        }
                    }

                    // And the directory that held them, which git knows
                    // nothing about.
                    if let Err(e) = tokio::fs::remove_dir_all(workspace).await {
                        if e.kind() != std::io::ErrorKind::NotFound {
                            tracing::warn!(session = %session_id, "removing the workspace: {e:#}");
                        }
                    }
                }

                self.store
                    .set_status(&session_id, SessionStatus::Ended)
                    .await?;
                self.emit(
                    &session_id,
                    EventKind::StatusChanged {
                        status: SessionStatus::Ended,
                        note: None,
                    },
                    out,
                )
                .await?;
            }

            ToWorker::PtyOpen {
                session_id,
                pty,
                cols,
                rows,
            } => {
                if let Err(e) = self.open_terminal(&session_id, pty, cols, rows, out).await {
                    tracing::warn!(session = %session_id, ?pty, "attaching: {e:#}");
                    out.send(ToServer::Error {
                        session_id: Some(session_id.clone()),
                        code: "TerminalUnavailable".into(),
                        message: format!("{e:#}"),
                    })
                    .await?;
                    out.send(ToServer::PtyClosed { session_id, pty }).await?;
                }
            }

            ToWorker::PtyInput {
                session_id,
                pty,
                data,
            } => {
                // Typed characters, verbatim — including the ones that mean
                // "stop", which is half the reason a terminal is the interface.
                if let Some(bytes) = ft_proto::decode(&data) {
                    if let Some(a) = self
                        .attached
                        .lock()
                        .await
                        .get(&terminal_key(&session_id, pty))
                    {
                        if let Err(e) = a.write(&bytes) {
                            tracing::warn!(session = %session_id, "sending input: {e:#}");
                        }
                    }
                }
            }

            ToWorker::PtyResize {
                session_id,
                pty,
                cols,
                rows,
            } => {
                if let Some(a) = self
                    .attached
                    .lock()
                    .await
                    .get(&terminal_key(&session_id, pty))
                {
                    if let Err(e) = a.resize(cols, rows) {
                        tracing::warn!(session = %session_id, "resizing: {e:#}");
                    }
                }
            }

            ToWorker::PtyClose { session_id, pty } => {
                // Dropping the attachment detaches. The agent is tmux's child,
                // so nobody watching it is what it needs to keep working.
                self.attached
                    .lock()
                    .await
                    .remove(&terminal_key(&session_id, pty));

                // A shell is yours for as long as you are looking at it. Nobody
                // is looking now, so it goes — along with whatever it was
                // running, which is the shape of "a shell per visit".
                if pty == Pty::Shell {
                    if let Err(e) = Tmux::named(pty.tmux_name(session_id.as_str())).kill().await {
                        tracing::warn!(session = %session_id, "closing the shell: {e:#}");
                    }
                }
            }

            ToWorker::WatchAgent {
                session_id,
                since_line,
            } => {
                self.watch_agent(&session_id, since_line, out).await;
            }

            ToWorker::UnwatchAgent { session_id } => {
                if let Some(watcher) = self.watching.lock().await.remove(&session_id.to_string()) {
                    // The agent carries on. Nobody watching is its ordinary
                    // state — the log is still being written.
                    watcher.abort();
                }
            }

            ToWorker::SendTurn {
                session_id,
                message,
            } => {
                if let Err(e) =
                    structured::tell(&session_id, &agentd::ToAgent::Send { message }).await
                {
                    tracing::warn!(session = %session_id, "sending a turn: {e:#}");
                    out.send(ToServer::Error {
                        session_id: Some(session_id),
                        code: "AgentUnavailable".into(),
                        message: format!("{e:#}"),
                    })
                    .await?;
                }
            }

            ToWorker::Answer {
                session_id,
                req,
                result,
            } => {
                if let Err(e) =
                    structured::tell(&session_id, &agentd::ToAgent::Decide { req, result }).await
                {
                    tracing::warn!(session = %session_id, "answering: {e:#}");
                    // The same report a failed turn makes. Answering a question
                    // whose agent has gone was the quieter half of the same
                    // fault: the card stayed, the answer went nowhere, and
                    // nothing said which had happened.
                    out.send(ToServer::Error {
                        session_id: Some(session_id),
                        code: "AgentUnavailable".into(),
                        message: format!("{e:#}"),
                    })
                    .await?;
                }
            }

            ToWorker::Interrupt { session_id } => {
                if let Err(e) = structured::tell(&session_id, &agentd::ToAgent::Interrupt).await {
                    tracing::warn!(session = %session_id, "interrupting: {e:#}");
                }
            }

            ToWorker::ListFiles {
                req,
                session_id,
                path,
            } => {
                let result = self
                    .list_files(&session_id, &path)
                    .await
                    .map_err(|e| format!("{e:#}"));
                out.send(ToServer::Listed { req, result }).await?;
            }

            ToWorker::FindFiles {
                req,
                session_id,
                query,
                limit,
            } => {
                let result = self
                    .find_files(&session_id, &query, limit)
                    .await
                    .map_err(|e| format!("{e:#}"));
                out.send(ToServer::Found { req, result }).await?;
            }

            ToWorker::ReadFile {
                req,
                session_id,
                path,
            } => {
                self.read_file(&req, &session_id, &path, out).await?;
            }

            ToWorker::RunAction {
                req,
                session_id,
                action,
                credential,
            } => {
                let result = self
                    .run_action(&session_id, action, credential, out)
                    .await
                    .map_err(|e| format!("{e:#}"));
                out.send(ToServer::ActionDone { req, result }).await?;
            }

            ToWorker::Summarize { req, session_id } => match self.summarize(&session_id).await {
                Ok(summaries) => out.send(ToServer::Summarized { req, summaries }).await?,
                Err(e) => {
                    tracing::warn!(session = %session_id, "summarising: {e:#}");
                    out.send(ToServer::ActionDone {
                        req,
                        result: Err(format!("{e:#}")),
                    })
                    .await?;
                }
            },

            ToWorker::TunnelOpen {
                tunnel,
                session_id,
                port,
            } => {
                // Refused here rather than at the socket, so an id that names
                // nothing says so instead of connecting to a port that some
                // other session on this machine happens to be serving.
                if let Err(e) = self.workspace_of(&session_id).await {
                    out.send(ToServer::TunnelOpened {
                        tunnel,
                        result: Err(format!("{e:#}")),
                    })
                    .await?;
                    return Ok(true);
                }

                self.tunnels.open(tunnel, session_id, port, out).await;
            }

            ToWorker::TunnelData { tunnel, data } => {
                if let Some(bytes) = data.bytes() {
                    self.tunnels.write(&tunnel, bytes).await;
                }
            }

            ToWorker::TunnelCredit { tunnel, bytes } => {
                self.tunnels.grant(&tunnel, bytes).await;
            }

            ToWorker::TunnelClose { tunnel, half } => {
                if half {
                    self.tunnels.half_close(&tunnel).await;
                } else {
                    self.tunnels.close(&tunnel).await;
                }
            }

            ToWorker::Stop { session_id } => {
                tracing::debug!("superseded by RunAction ({session_id})");
            }
        }
        Ok(true)
    }

    /// What is in a directory of this session's workspace.
    ///
    /// Directories first, then files, each alphabetically — the order somebody
    /// scanning for a name expects, rather than whatever the filesystem hands
    /// back.
    async fn list_files(
        &self,
        session_id: &SessionId,
        path: &str,
    ) -> Result<Vec<ft_core::FileEntry>> {
        let workspace = self.workspace_of(session_id).await?;
        let dir = inside(&workspace, path)?;

        let mut reading = tokio::fs::read_dir(&dir)
            .await
            .with_context(|| format!("reading {}", showable(&workspace, &dir)))?;

        let mut entries = Vec::new();
        while let Some(entry) = reading.next_entry().await? {
            // `symlink_metadata`, so a link is described rather than followed.
            // Following one would answer questions about whatever it points
            // at, which can be anywhere on the machine.
            let Ok(meta) = entry.metadata().await.or(entry.path().symlink_metadata()) else {
                continue;
            };
            let link = entry
                .path()
                .symlink_metadata()
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);

            entries.push(ft_core::FileEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                directory: meta.is_dir(),
                size: if meta.is_dir() { 0 } else { meta.len() },
                modified: meta
                    .modified()
                    .ok()
                    .map(chrono::DateTime::<chrono::Utc>::from),
                link,
            });

            // A worktree with `node_modules` in it has hundreds of thousands of
            // entries, and nobody is reading past the first few hundred.
            if entries.len() >= LISTING_LIMIT {
                break;
            }
        }

        entries.sort_by(|a, b| {
            b.directory
                .cmp(&a.directory)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(entries)
    }

    /// Files in this session's workspace whose path matches a query.
    ///
    /// The index comes from git where there is one: `ls-files` knows what is
    /// tracked and what is untracked-but-not-ignored, which is exactly the set
    /// somebody means by "the files in this repository", and it answers in
    /// milliseconds because git already has it. A workspace that is not a
    /// checkout — or a git that says no — falls back to walking it.
    async fn find_files(
        &self,
        session_id: &SessionId,
        query: &str,
        limit: usize,
    ) -> Result<Vec<String>> {
        let workspace = self.workspace_of(session_id).await?;

        let paths = match git_index(&workspace).await {
            Some(paths) if !paths.is_empty() => paths,
            _ => walk(&workspace).await,
        };

        Ok(rank(&paths, query, limit))
    }

    /// Send a file back in pieces.
    ///
    /// Pieces because everything on this connection shares one pipe: terminal
    /// output for every session on this machine queues behind whatever is being
    /// sent. A file arrives as chunks with the other traffic interleaved
    /// between them, rather than as one frame that stops the world.
    async fn read_file(
        &self,
        req: &str,
        session_id: &SessionId,
        path: &str,
        out: &Out,
    ) -> Result<()> {
        let opened = self.open_for_reading(session_id, path).await;

        let mut file = match opened {
            Ok((file, size)) => {
                out.send(ToServer::FileOpened {
                    req: req.to_string(),
                    result: Ok(size),
                })
                .await?;
                file
            }
            Err(e) => {
                out.send(ToServer::FileOpened {
                    req: req.to_string(),
                    result: Err(format!("{e:#}")),
                })
                .await?;
                return Ok(());
            }
        };

        use tokio::io::AsyncReadExt;
        let mut buffer = vec![0u8; CHUNK];
        loop {
            let read = file.read(&mut buffer).await.context("reading the file")?;
            if read == 0 {
                out.send(ToServer::FileChunk {
                    req: req.to_string(),
                    data: String::new(),
                    last: true,
                })
                .await?;
                return Ok(());
            }

            out.send(ToServer::FileChunk {
                req: req.to_string(),
                data: ft_proto::encode(&buffer[..read]),
                last: false,
            })
            .await?;
        }
    }

    /// Everything that can refuse a download, before a byte is sent.
    async fn open_for_reading(
        &self,
        session_id: &SessionId,
        path: &str,
    ) -> Result<(tokio::fs::File, u64)> {
        let workspace = self.workspace_of(session_id).await?;
        let file = inside(&workspace, path)?;

        let meta = tokio::fs::symlink_metadata(&file)
            .await
            .with_context(|| format!("looking at {path}"))?;

        if meta.file_type().is_symlink() {
            anyhow::bail!("{path} is a link. Open it where it points, or use the shell");
        }
        if meta.is_dir() {
            anyhow::bail!("{path} is a directory. Downloading one isn't a thing yet");
        }
        if meta.len() > MAX_DOWNLOAD {
            anyhow::bail!(
                "{path} is {}. Anything over {} MB has to come off the machine another \
                 way — `scp`, `docker cp`, or a command in the shell tab",
                readable(meta.len()),
                MAX_DOWNLOAD / 1_048_576,
            );
        }

        Ok((tokio::fs::File::open(&file).await?, meta.len()))
    }

    /// Write a repository's variables into the workspace.
    ///
    /// And tell git to ignore the file. In `.git/info/exclude` rather than
    /// `.gitignore`: the latter is the repository's own file, and editing it
    /// would show up as a change the agent didn't make and might well commit.
    /// Exclude is local to this worktree and belongs to whoever checked it out,
    /// which is us.
    async fn write_env_file(workspace: &Path, file: &ft_proto::EnvFile) -> Result<()> {
        // The server checks this too. Checked again here because this is the
        // side holding the filesystem, and a frame is not a promise.
        //
        // On the components rather than on the joined path: `workspace/../x`
        // *does* start with `workspace` as far as `Path::starts_with` is
        // concerned, which is a check that passes everything it should refuse.
        let relative = Path::new(&file.path);
        if relative.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        }) {
            anyhow::bail!("{} is outside the workspace", file.path);
        }

        let path = workspace.join(relative);

        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }

        let variables: Vec<ft_core::dotenv::Variable> = file
            .variables
            .iter()
            .map(|(name, value)| ft_core::dotenv::Variable {
                name: name.clone(),
                value: value.clone(),
            })
            .collect();

        tokio::fs::write(&path, ft_core::dotenv::render(&variables)).await?;

        // Readable by its owner and nobody else. The default would be whatever
        // the umask says, and on a shared machine that is often everybody.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .await
                .ok();
        }

        Self::exclude_from_git(workspace, &file.path).await;
        Ok(())
    }

    /// Add a path to this worktree's local excludes, once.
    ///
    /// Best effort: a workspace with nothing checked out has no `.git` at all,
    /// and a file that git can see is a smaller problem than a session that
    /// refuses to start.
    async fn exclude_from_git(workspace: &Path, path: &str) {
        // The *common* directory, not `--git-dir`. A session runs in a linked
        // worktree, whose own git directory has an `info/exclude` that git
        // never reads — excludes are shared, and live with the mirror. Writing
        // to the worktree's copy looks right and does nothing, which is how
        // this was found: the file was still listed as untracked.
        let Ok(output) = tokio::process::Command::new("git")
            .args(["rev-parse", "--git-common-dir"])
            .current_dir(workspace)
            .output()
            .await
        else {
            return;
        };

        if !output.status.success() {
            return;
        }

        let git_dir = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim().to_string());
        let git_dir = if git_dir.is_absolute() {
            git_dir
        } else {
            workspace.join(git_dir)
        };

        let exclude = git_dir.join("info").join("exclude");
        tracing::debug!(exclude = %exclude.display(), "excluding {path} from git");
        if let Some(parent) = exclude.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }

        let existing = tokio::fs::read_to_string(&exclude)
            .await
            .unwrap_or_default();
        if existing.lines().any(|line| line.trim() == path) {
            return;
        }

        let mut next = existing;
        if !next.is_empty() && !next.ends_with('\n') {
            next.push('\n');
        }
        next.push_str(&format!("# written by Firetower\n{path}\n"));

        if let Err(e) = tokio::fs::write(&exclude, next).await {
            tracing::warn!("could not exclude {path} from git: {e:#}");
        }
    }

    /// Check one repository into a workspace, narrating each step.
    ///
    /// The same work at launch and afterwards: a session that gains a
    /// repository mid-conversation runs exactly this, which is why it is a
    /// function rather than a branch inside bring-up.
    ///
    /// Failure belongs to this checkout, not to the session — the caller
    /// decides what to say about it and carries on with the rest.
    async fn prepare_checkout(
        &self,
        id: &SessionId,
        workspace: &Path,
        position: i64,
        repo: &ft_proto::RepoSpec,
        env: &[(String, String)],
        out: &Out,
    ) -> Result<PathBuf> {
        self.emit(id, EventKind::StepStarted { step: Step::Fetch }, out)
            .await?;
        let started = std::time::Instant::now();

        // git's progress goes into a slot rather than down a channel: the
        // callback is synchronous and emitting is not, so the loop below does
        // the emitting, on this task, where `out` lives.
        let latest = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let report = {
            let latest = latest.clone();
            move |line: String| *latest.lock().unwrap() = line
        };

        let mirroring = self.git.ensure_mirror(
            &repo.remote,
            &repo.slug,
            repo.credential.clone(),
            Some(&report),
        );
        tokio::pin!(mirroring);

        // Often enough to look alive, rarely enough that a fetch isn't also a
        // way to fill the event log.
        let mut said = String::new();
        let (mirror, cloned) = loop {
            tokio::select! {
                done = &mut mirroring => break done.context("preparing the repository mirror")?,
                _ = tokio::time::sleep(std::time::Duration::from_millis(900)) => {
                    let line = latest.lock().unwrap().clone();
                    if !line.is_empty() && line != said {
                        said = line.clone();
                        self.emit(
                            id,
                            EventKind::StepProgress { step: Step::Fetch, detail: format!("{} · {line}", repo.slug) },
                            out,
                        )
                        .await?;
                    }
                }
            }
        };

        self.emit(
            id,
            EventKind::RepoFetched {
                detail: format!(
                    "{} · {}",
                    repo.slug,
                    if cloned {
                        format!("cloned · {:.1}s", started.elapsed().as_secs_f32())
                    } else {
                        format!("from the mirror · {:.1}s", started.elapsed().as_secs_f32())
                    }
                ),
            },
            out,
        )
        .await?;

        self.emit(
            id,
            EventKind::StepStarted {
                step: Step::Worktree,
            },
            out,
        )
        .await?;

        // An empty path means the checkout *is* the workspace, which is how a
        // session made before a session could hold more than one is laid out.
        // Those directories are not moving.
        let name = if repo.path.is_empty() {
            workspace.to_path_buf()
        } else {
            workspace.join(&repo.path)
        };

        let (path, branch) = self
            .git
            .add_worktree_at(&mirror, &repo.branch, &repo.base, &name)
            .await
            .context("cutting the worktree")?;

        // Where it actually landed, which is not always where it was asked to
        // go: a directory already in use is numbered rather than fatal, and the
        // server prefixes every diff path with this, so recording the requested
        // one would describe files that are not there.
        let at = path
            .strip_prefix(workspace)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| repo.path.clone());

        // Two sessions from one prompt want the same name, so git may have
        // numbered it — and it may have numbered it differently in each
        // repository, which is why the branch is recorded per checkout. What is
        // on disk is the authority: pushing the name we asked for would push
        // somebody else's branch.
        self.store
            .record_checkout(
                id,
                position,
                &repo.slug,
                &repo.remote,
                &repo.base,
                &branch,
                &at,
            )
            .await?;
        if position == 0 {
            self.store.set_branch(id, &branch).await?;
        }

        self.emit(
            id,
            EventKind::WorktreeAdded {
                branch: branch.clone(),
                repo: Some(repo.slug.clone()),
                // Only when it differs, so the ordinary case says nothing.
                asked_for: (branch != repo.branch).then(|| repo.branch.clone()),
            },
            out,
        )
        .await?;

        // Inside the checkout, not the workspace: `.env` is read by the tooling
        // of the repository it belongs to, and two repositories both asking for
        // one at the workspace root would be a single file with the wrong
        // contents in it.
        //
        // Before setup, because a setup script is the first thing that wants to
        // read it — `npm run db:migrate` against a URL that is only in a file.
        if let Some(file) = &repo.env_file {
            Self::write_env_file(&path, file)
                .await
                .with_context(|| format!("writing {} in {}", file.path, repo.slug))?;
            // It holds this repository's secrets and it is inside a checkout,
            // so git can see it. Excluded locally rather than added to the
            // repository's own ignore file, which belongs to whoever wrote it.
            Self::exclude_from_git(&path, &file.path).await;
        }

        if let Some(setup) = repo.setup.as_deref().filter(|s| !s.trim().is_empty()) {
            self.emit(id, EventKind::StepStarted { step: Step::Setup }, out)
                .await?;
            let started = std::time::Instant::now();
            let output = tokio::process::Command::new("sh")
                .arg("-lc")
                .arg(setup)
                // In its own checkout, which is where its package file is.
                .current_dir(&path)
                // The same environment the agent gets. A setup script that
                // installs dependencies and migrates a database needs the
                // repository's variables as much as the agent does.
                .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
                .output()
                .await
                .context("running the setup script")?;

            if !output.status.success() {
                anyhow::bail!(
                    "setup script exited {}: {}",
                    output.status.code().unwrap_or(-1),
                    String::from_utf8_lossy(&output.stderr).trim()
                );
            }

            self.emit(
                id,
                EventKind::SetupFinished {
                    detail: format!(
                        "{} · {setup} · {:.1}s",
                        repo.slug,
                        started.elapsed().as_secs_f32()
                    ),
                },
                out,
            )
            .await?;
        }

        Ok(path)
    }

    /// What the workspace guide says about Docker.
    ///
    /// Here rather than only on a screen somebody might look at, because the
    /// question "can I run this?" is asked by the agent and answered by the
    /// machine — and the guide is the one place it reads before deciding. An
    /// agent told nothing runs `docker compose up`, gets `command not found`,
    /// and concludes something is broken; an agent told plainly there is no
    /// Docker here runs the tests it *can* run and says which it couldn't.
    ///
    /// The caveats are stated for the same reason. A shared daemon and a
    /// shared port space are surprising, and finding them out by colliding
    /// with another session is a bad way to learn.
    fn docker_guidance(state: &ft_core::DockerState, id: &SessionId) -> String {
        match state.status {
            ft_core::DockerStatus::Running => format!(
                "
## Docker

Docker and `docker compose` work here — bring the stack up and check your work against it rather than reasoning about whether it would run.

This daemon is shared with the other sessions on this machine, so:

- Published ports are shared. If a port is taken, another session has it; pick another rather than assuming something is broken.
- `docker ps` lists their containers too. Yours are the ones in the `{project}` project.
- Anything you start with `docker compose` is removed when this session ends. For a bare `docker run`, add `--label {label}={id}` and it will be cleared up too — without it, it is left behind.
",
                project = crate::docker::project(id),
                label = crate::docker::SESSION_LABEL,
                id = id.as_str(),
            ),
            ft_core::DockerStatus::Absent => "
## Docker

There is no Docker on this machine. `docker` and `docker compose` will not run, so don't reach for them — run what you can without them, and say which checks you could not do rather than leaving it implied.
"
            .to_string(),
            ft_core::DockerStatus::Stopped => format!(
                "
## Docker

Docker is installed here and the daemon is not answering, so `docker` commands will fail. This is a fault on the machine rather than something to work around: report it rather than trying to start the daemon yourself.

  {why}
",
                why = state
                    .detail
                    .as_deref()
                    .filter(|d| !d.is_empty())
                    .unwrap_or("it did not say why"),
            ),
            // Nothing established, so nothing claimed. A guess in either
            // direction costs more than the silence does.
            ft_core::DockerStatus::Unknown => String::new(),
        }
    }

    /// Write down what is checked out and where.
    ///
    /// The agent starts at the workspace rather than inside a repository, so
    /// the first thing it needs is a map. A file rather than a sentence in the
    /// prompt, because it has to still be true on the tenth turn — and because
    /// it sits beside the checkouts rather than inside one, so it never appears
    /// in anybody's diff.
    ///
    /// Best effort. A workspace without it is a worse first turn, not a broken
    /// session.
    async fn write_workspace_guide(&self, id: &SessionId, workspace: &Path) {
        let checkouts = match self.store.checkouts_of(id).await {
            Ok(c) if !c.is_empty() => c,
            _ => return,
        };

        let mut text = String::from(
            "# This workspace

             Firetower checked these out for this session. Each is a git worktree on              its own branch, and each is a separate repository — a change in one is              committed and pushed on its own.

",
        );
        for c in &checkouts {
            text.push_str(&format!(
                "- `{}/` — {} · on `{}`, from `{}`
",
                if c.path.is_empty() { "." } else { &c.path },
                c.slug,
                c.branch,
                c.base
            ));
        }
        text.push_str(
            "
You are in the directory that holds them, not inside one of them.              Paths in what you say should be relative to here.
",
        );
        text.push_str(&Self::docker_guidance(&crate::docker::state().await, id));

        let at = workspace.join("AGENTS.md");
        if let Err(e) = tokio::fs::write(&at, text).await {
            tracing::warn!("could not write {}: {e:#}", at.display());
        }
    }

    /// Build a workspace, narrating each step as it completes.
    ///
    /// The narration is the point: it's what the interface shows while you wait,
    /// and what tells you *where* it broke when it breaks.
    /// Start forwarding what a session's agent says, if nothing already is.
    ///
    /// One place, because there are two reasons to start: a session that has
    /// just been built, and a control plane reconnecting and asking about
    /// everything still running. Both can happen at once — building one now
    /// waits for the agent to answer its handshake, which is a wide enough
    /// window for a reconnect to land in the middle of it.
    ///
    /// A second watcher would forward every line twice. The control plane
    /// stores a line once whatever happens, so the duplicate is invisible
    /// there and arrives in a browser as every word written twice.
    async fn watch_agent(&self, session_id: &SessionId, since_line: u64, out: &Out) {
        let mut watching = self.watching.lock().await;

        // Already forwarding, and the one that exists is at or ahead of this
        // cursor. `insert` here would drop a handle without stopping the task
        // behind it, which is how two of them end up running.
        //
        // *Running*, not merely present. A watcher started before the agent
        // was listening fails at once and leaves its entry behind; treating
        // that as "something is watching" means nothing ever does, and the
        // control plane hears not one word of a session that ran perfectly.
        if let Some(existing) = watching.get(session_id.as_str()) {
            if !existing.is_finished() {
                return;
            }
            watching.remove(session_id.as_str());
        }

        let out = out.clone();
        let id = session_id.clone();
        watching.insert(
            session_id.to_string(),
            tokio::spawn(async move {
                // Which of the two ended is the whole point. Saying the agent
                // closed when only the watching stopped tears down the
                // conversation on the far side, and it does not come back —
                // the agent goes on writing into a log nobody is reading.
                match structured::watch(id.clone(), since_line, out.clone()).await {
                    Ok(structured::Ended::AgentExited) => {}
                    Ok(structured::Ended::WatcherStopped) => {
                        let _ = out.send(ToServer::AgentUnwatched { session_id: id }).await;
                    }
                    Err(e) => {
                        // Ordinary rather than exceptional: a session running
                        // in a terminal has no agent to watch, and the control
                        // plane asks about all of them rather than remembering
                        // which is which.
                        tracing::debug!(session = %id, "no conversation to follow: {e:#}");
                        let _ = out.send(ToServer::AgentUnwatched { session_id: id }).await;
                    }
                }
            }),
        );
    }

    /// Start one agent in a workspace that is already on disk.
    ///
    /// The tail of building a workspace, and the whole of adding a second agent
    /// to one. Shared rather than copied: the two paths differ in everything
    /// before this point and in nothing after it, and a second copy is how the
    /// two come to disagree about which status a session ends up in.
    async fn launch_agent(&self, into: Launch<'_>, out: &Out) -> Result<()> {
        let Launch {
            id,
            path,
            tmux,
            env,
            agent,
            prompt,
        } = into;
        // Take out anything a previous version installed. The agent reports its
        // own lifecycle now, so a hook doing the same job is a second writer of
        // one field, and one left behind keeps firing for sessions that have
        // long moved on.
        if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) {
            if let Err(e) = hooks::remove(&home, agent).await {
                tracing::warn!("could not remove {} hooks: {e:#}", agent.label());
            }
        }

        self.emit(id, EventKind::StepStarted { step: Step::Launch }, out)
            .await?;

        // The control plane asks this too, from what this host last reported.
        // Asked again here because that answer has an age: an agent removed by
        // hand since the last probe would otherwise be launched, and a missing
        // binary under tmux is a pane that dies quietly and an agent that
        // never becomes ready. This says which of the two it is.
        anyhow::ensure!(
            agents::present(&self.root, agent).await,
            "{} is not installed on this machine",
            agent.label()
        );

        // Whether an agent can be driven at all is the control plane's
        // question, asked before a session is created — a worker does what it
        // is told. What it decides here is only how: a supervisor holding the
        // agent's pipes, or a bare shell in a pane.
        //
        // Everything Firetower offers takes the first path now. The second is
        // what a shell is — a workspace to poke around in by hand, with no
        // prompt to take and nothing to configure.
        let structured = agent.speaks_a_protocol();

        // Either way it runs under tmux, so it outlives this worker, this
        // connection, and the laptop that started it. For a driven session
        // tmux supervises the supervisor, which changes nothing about that:
        // the process tree still has tmux at the top.
        let command = if structured {
            let exe = std::env::current_exe().context("finding this worker's own path")?;
            structured::tmux_command(&exe, id, path, agent)
        } else {
            agent.command().to_string()
        };

        let previous_log = tokio::fs::read_to_string(agentd::log_path(path, id.as_str()))
            .await
            .unwrap_or_default();
        let after_line = previous_log.lines().count();
        let mut opening = agent.opening(prompt, &path.to_string_lossy());
        if agent == ft_core::Agent::Codex {
            let mut reader = ft_core::codex::CodexNormaliser::default();
            for line in previous_log.lines() {
                reader.push(line);
            }
            if let Some(thread) = reader.thread() {
                for message in &mut opening {
                    if message.get("method").and_then(|v| v.as_str()) == Some("thread/start") {
                        message["method"] = serde_json::json!("thread/resume");
                        message["params"]["threadId"] = serde_json::json!(thread);
                    }
                }
            }
        }
        tmux.start(path, &command, env)
            .await
            .with_context(|| format!("starting {}", agent.label()))?;

        self.emit(
            id,
            EventKind::TmuxOpened {
                name: tmux.name().to_string(),
            },
            out,
        )
        .await?;
        self.emit(id, EventKind::AgentLaunched { agent }, out)
            .await?;

        // An agent driven this way reads messages, so the first one has to be
        // sent — after waiting for it to be listening, because a turn written
        // into a socket nobody has bound yet is simply lost.
        if structured {
            structured::wait_until_listening(id)
                .await
                .context("waiting for the agent to start")?;
            // Whatever this agent needs said first — for one that is a prompt,
            // for another it is a handshake with the prompt still to come. The
            // shapes belong to the control plane; this only puts them on the
            // wire, in order, before anybody watches.
            // One at a time, and a request is answered before the next goes
            // out. An app-server refuses everything with "Not initialized"
            // until it has finished starting, and a burst loses that race on a
            // machine that is busy — which is every machine, sometimes.
            for message in opening {
                let awaiting = message.get("id").and_then(serde_json::Value::as_u64);
                structured::tell(id, &agentd::ToAgent::Send { message })
                    .await
                    .context("opening the conversation")?;

                if let Some(req) = awaiting {
                    structured::wait_for_answer_since(path, id.as_str(), req, after_line)
                        .await
                        .context("opening the conversation")?;
                }
            }

            // Start forwarding now rather than when somebody opens the session.
            // What the agent says is how the control plane learns that it
            // finished, or stopped to ask something — and a session nobody is
            // watching is exactly the one that most needs to be able to say so.
            self.watch_agent(id, 0, out).await;
        }

        // Whether anything was actually asked for. A workspace can be made
        // without a task, and an agent that was sent nothing is not working: it
        // is up and waiting, and nothing will ever arrive to correct a status
        // that claimed otherwise.
        //
        // The prompt itself, not what `opening` produced: for one agent that is
        // the prompt, and for another it is a handshake sent whether or not
        // there is anything to ask.
        let status = if !prompt.trim().is_empty() {
            SessionStatus::Working
        } else {
            SessionStatus::Ready
        };

        self.store.set_status(id, status).await?;
        self.emit(id, EventKind::StatusChanged { status, note: None }, out)
            .await?;

        Ok(())
    }

    /// Another agent, in a workspace that is already on disk.
    ///
    /// Everything that made the place has already happened. This records where
    /// the new run lives — the same directory, under its own session id, so the
    /// agent's socket and tmux session are its own — and launches into it.
    ///
    /// The one step it reports is the launch. A second agent does not fetch,
    /// does not cut a worktree and does not run setup, and drawing those as
    /// skipped would say something happened that did not.
    async fn start_agent(&self, spec: ft_proto::StartAgent, out: &Out) -> Result<()> {
        let id = spec.session_id.clone();
        let path = self.git.worktree_path(&spec.workspace);

        anyhow::ensure!(
            tokio::fs::metadata(&path).await.is_ok(),
            "the workspace at {} is not there any more",
            path.display()
        );

        // Its own row first. Every event this worker records points at a
        // session, and the store enforces that — so without this the very first
        // thing the launch tried to say came back as a foreign key violation
        // and the run sat in `Starting` with nothing to explain it.
        //
        // The workspace's facts, because they are the workspace's: this agent
        // works on the same branch, cut from the same base, in the same place.
        self.store
            .create_session(
                &id,
                spec.repo.as_deref(),
                &spec.title,
                &spec.prompt,
                spec.branch.as_deref(),
                spec.base.as_deref(),
                &format!("{:?}", spec.agent),
                spec.size,
            )
            .await?;

        // Its own tmux session, named from its own id — which is what keeps two
        // agents in one directory from being one agent.
        let tmux = Tmux::for_session(id.as_str());
        self.store
            .record_workspace(&id, path.to_str().unwrap_or_default(), tmux.name())
            .await?;

        // A tmux session already under this name is one of two quite different
        // things, and refusing both was the bug.
        //
        // If the agent inside it is still listening, this is a relaunch of
        // something that never stopped — somebody typing at a session the
        // control plane had given up on. Nothing needs starting; saying that it
        // is ready is the entire answer.
        //
        // If nothing is listening, the pane outlived the process: the agent
        // exited, or refused to go on — an account out of credit does exactly
        // this — and tmux kept the session. Starting was then refused with "is
        // already running" *about a corpse*, so the one route back was the one
        // route that could never be taken, and every attempt marked the run
        // failed again. Three sessions sat like that, each looking crashed.
        match standing(&tmux, &id).await {
            Standing::Fresh => {}
            Standing::Running => {
                tracing::info!(session = %id, "the agent is already running; nothing to start");
                self.store.set_status(&id, SessionStatus::Ready).await?;
                self.emit(
                    &id,
                    EventKind::StatusChanged {
                        status: SessionStatus::Ready,
                        note: None,
                    },
                    out,
                )
                .await?;
                return Ok(());
            }
            Standing::Abandoned => {
                tracing::warn!(
                    session = %id,
                    "a tmux session with no agent listening in it; replacing it"
                );
                if let Err(e) = tmux.kill().await {
                    // Said, not fatal: the start below fails on its own if this
                    // really did leave something in the way, and with a better
                    // sentence than this one could give.
                    tracing::warn!(session = %id, "could not clear the old tmux session: {e:#}");
                }
            }
        }

        let mut env = spec.env.clone();
        env.push((ft_core::SESSION_ENV.to_string(), id.to_string()));
        env.push((
            ft_core::WORKER_ROOT_ENV.to_string(),
            self.root.display().to_string(),
        ));
        env.push((
            "PATH".to_string(),
            crate::runtime::path_with_agents(&self.root)
                .await
                .to_string_lossy()
                .to_string(),
        ));

        // Compose scopes a stack by project name, and every session on this
        // worker shares one daemon — so without this, two sessions running the
        // same `compose.yaml` are one stack: the second `up` adopts and
        // restarts the first session's containers, in the first session's
        // directories. Naming it per session also gives teardown the label it
        // sweeps by. See `docker::project`.
        env.push((
            "COMPOSE_PROJECT_NAME".to_string(),
            crate::docker::project(&id),
        ));

        // What this workspace may take, and what it competes with when the
        // machine is busy. The size is the one the control plane asked for,
        // which a worker has always reported in `WorkspaceStarted` and never
        // applied to anything.
        //
        // Before the pane starts, because the pane's first instruction is to
        // put itself in this — see `cgroup::join_command`. A machine that
        // cannot divide itself up says so once and runs the session anyway.
        let limits = crate::cgroup::Limits {
            share: spec.share,
            size: spec.size,
        };
        if crate::cgroup::create(&path, limits).await {
            // Read by the Docker shim, which passes it to the daemon as
            // `--cgroup-parent`. Without it a container a session starts is a
            // child of the daemon rather than of the workspace, and inherits
            // none of this.
            env.push((
                crate::cgroup::CGROUP_PARENT_ENV.to_string(),
                crate::cgroup::parent_arg(&path),
            ));
        }

        prepare_agent_home(&path, &id, spec.agent, &spec.agent_home, &mut env).await?;

        self.launch_agent(
            Launch {
                id: &id,
                path: &path,
                tmux: &tmux,
                env: &env,
                agent: spec.agent,
                prompt: &spec.prompt,
            },
            out,
        )
        .await
    }

    async fn create_workspace(&self, spec: CreateWorkspace, out: &Out) -> Result<()> {
        let id = spec.session_id.clone();
        let title = ft_core::session::title_from(&spec.prompt);
        let first = spec.repos.first();

        self.store
            .create_session(
                &id,
                first.map(|r| r.slug.as_str()),
                &title,
                &spec.prompt,
                first.map(|r| r.branch.as_str()),
                first.map(|r| r.base.as_str()),
                &format!("{:?}", spec.agent),
                spec.size,
            )
            .await?;

        self.emit(
            &id,
            EventKind::SessionCreated {
                repo: if spec.repos.is_empty() {
                    "no repository".to_string()
                } else {
                    spec.repos
                        .iter()
                        .map(|r| r.slug.clone())
                        .collect::<Vec<_>>()
                        .join(", ")
                },
                prompt: spec.prompt.clone(),
            },
            out,
        )
        .await?;

        // The workspace is a directory that holds checkouts, and it exists
        // whether or not there are any. A bare agent gets it and nothing else;
        // a session with two repositories gets both inside it; a session with
        // one gets it too, which is the only shape that changed — the checkout
        // used to *be* the workspace.
        //
        // Worth what it costs: Firetower's own files stop living inside
        // somebody's repository, so the supervisor log is not in every diff and
        // an attachment is not a file the agent might commit.
        self.emit(
            &id,
            EventKind::StepStarted {
                step: Step::Workspace,
            },
            out,
        )
        .await?;
        let path = self.git.worktree_path(&spec.workspace);
        tokio::fs::create_dir_all(&path)
            .await
            .with_context(|| format!("creating {}", path.display()))?;

        let (cpus, mem) = spec.size.resources();
        self.emit(
            &id,
            EventKind::WorkspaceStarted {
                detail: format!("{cpus} CPU / {} GB", mem / 1024),
            },
            out,
        )
        .await?;

        let tmux = Tmux::for_session(id.as_str());
        self.store
            .record_workspace(&id, path.to_str().unwrap_or_default(), tmux.name())
            .await?;

        // Which session this is, and where this worker keeps its state.
        // Inherited by the agent, by every setup script, and by everything
        // either of them runs — a script that wants to know which session it is
        // running inside has nowhere else to look.
        let mut env = spec.env.clone();
        env.push((ft_core::SESSION_ENV.to_string(), id.to_string()));
        env.push((
            ft_core::WORKER_ROOT_ENV.to_string(),
            self.root.display().to_string(),
        ));

        // So the session can find an agent Firetower installed. Appended
        // rather than prepended — see `runtime::path_with_agents` — so a
        // machine that has its own copy keeps using it.
        env.push((
            "PATH".to_string(),
            crate::runtime::path_with_agents(&self.root)
                .await
                .to_string_lossy()
                .to_string(),
        ));

        // Compose scopes a stack by project name, and every session on this
        // worker shares one daemon — so without this, two sessions running the
        // same `compose.yaml` are one stack: the second `up` adopts and
        // restarts the first session's containers, in the first session's
        // directories. Naming it per session also gives teardown the label it
        // sweeps by. See `docker::project`.
        env.push((
            "COMPOSE_PROJECT_NAME".to_string(),
            crate::docker::project(&id),
        ));

        // What this workspace may take, and what it competes with when the
        // machine is busy. The size is the one the control plane asked for,
        // which a worker has always reported in `WorkspaceStarted` and never
        // applied to anything.
        //
        // Before the pane starts, because the pane's first instruction is to
        // put itself in this — see `cgroup::join_command`. A machine that
        // cannot divide itself up says so once and runs the session anyway.
        let limits = crate::cgroup::Limits {
            share: spec.share,
            size: spec.size,
        };
        if crate::cgroup::create(&path, limits).await {
            // Read by the Docker shim, which passes it to the daemon as
            // `--cgroup-parent`. Without it a container a session starts is a
            // child of the daemon rather than of the workspace, and inherits
            // none of this.
            env.push((
                crate::cgroup::CGROUP_PARENT_ENV.to_string(),
                crate::cgroup::parent_arg(&path),
            ));
        }

        prepare_agent_home(&path, &id, spec.agent, &spec.agent_home, &mut env).await?;

        // In order, and each one is allowed to fail on its own: a session that
        // came up with two repositories out of three is still a session worth
        // having, and saying which one is missing beats pretending it was never
        // asked for.
        let mut ready = 0usize;
        for (position, repo) in spec.repos.iter().enumerate() {
            match self
                .prepare_checkout(&id, &path, position as i64, repo, &env, out)
                .await
            {
                Ok(_) => ready += 1,
                Err(e) => {
                    tracing::warn!(session = %id, repo = %repo.slug, "checking out: {e:#}");
                    self.emit(
                        &id,
                        EventKind::Failed {
                            code: "checkout".into(),
                            message: format!("{}: {e:#}", repo.slug),
                        },
                        out,
                    )
                    .await?;
                }
            }
        }

        // Asked for repositories and got none of them. There is nothing here to
        // work on, so this is a failed session rather than a bare agent —
        // which is what a session with one repository and a broken setup script
        // has always been.
        if ready == 0 && !spec.repos.is_empty() {
            anyhow::bail!("none of this session's repositories could be checked out");
        }

        // What is checked out and where, written where the agent will find it.
        //
        // The agent starts at the workspace rather than inside a repository
        // now, so the first thing it needs is a map. Written here rather than
        // said in the prompt because it has to still be true on the tenth turn,
        // and because it is one more file in a workspace Firetower already
        // writes files into.
        self.write_workspace_guide(&id, &path).await;

        // Nothing to exclude from git here any more. The supervisor's log used
        // to be the largest change in every diff because the workspace *was*
        // the checkout; it sits beside the checkouts now, where git cannot see
        // it at all.

        // Answer what the agent would otherwise stop and ask. Best effort: a
        // question in the pane is a worse first session, but it is one someone
        // can answer — refusing to launch over it would not be.
        if let Some(first_run) = spec.agent.first_run(&path.to_string_lossy()) {
            if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) {
                if let Err(e) = first_run::settle(&home, &first_run).await {
                    tracing::warn!("{}: {e:#}", spec.agent.label());
                }
            }
        }

        self.launch_agent(
            Launch {
                id: &id,
                path: &path,
                tmux: &tmux,
                env: &env,
                agent: spec.agent,
                prompt: &spec.prompt,
            },
            out,
        )
        .await?;

        Ok(())
    }

    /// Where a session's workspace is, as recorded when it was built.
    ///
    /// Read rather than recomputed: the directory is named by whoever started
    /// the session, so there is nothing to derive it from.
    async fn workspace_of(&self, session_id: &SessionId) -> Result<PathBuf> {
        self.store
            .workspace_path(session_id)
            .await?
            .map(PathBuf::from)
            .context("this session has no workspace")
    }

    /// One checkout, by the path it sits at inside the workspace.
    ///
    /// An empty path is the workspace itself, which is what a session made
    /// before a session could hold more than one is — and what a caller that
    /// does not care which repository it means gets.
    async fn checkout_at(&self, session_id: &SessionId, at: &str) -> Result<PathBuf> {
        let workspace = self.workspace_of(session_id).await?;
        Ok(if at.is_empty() {
            workspace
        } else {
            workspace.join(at)
        })
    }

    /// A checkout and the branch it is on.
    ///
    /// Read from the checkout rather than from the session, because git may
    /// have had to number the branch and may have numbered it differently in
    /// each repository. Falls back to the session's own branch for a session
    /// recorded before checkouts were.
    async fn checkout_refs(&self, session_id: &SessionId, at: &str) -> Result<(PathBuf, String)> {
        let dest = self.checkout_at(session_id, at).await?;
        let branch = self
            .store
            .checkouts_of(session_id)
            .await?
            .into_iter()
            .find(|c| c.path == at)
            .map(|c| c.branch);

        let branch = match branch {
            Some(branch) => branch,
            None => self
                .store
                .branch_of(session_id)
                .await?
                .context("this session has no branch")?,
        };
        Ok((dest, branch))
    }

    /// A checkout and what to diff it against.
    async fn checkout_diff_refs(
        &self,
        session_id: &SessionId,
        at: &str,
    ) -> Result<(PathBuf, String)> {
        let dest = self.checkout_at(session_id, at).await?;
        let base = self
            .store
            .checkouts_of(session_id)
            .await?
            .into_iter()
            .find(|c| c.path == at)
            .map(|c| c.base)
            .or(self.store.refs_of(session_id).await?.map(|(_, base)| base))
            .unwrap_or_else(|| "HEAD".to_string());
        Ok((dest, base))
    }

    /// Every checkout with the path it lives at, or the workspace itself when
    /// there are none recorded.
    async fn checkouts_or_workspace(
        &self,
        session_id: &SessionId,
        workspace: &Path,
    ) -> Result<Vec<Located>> {
        let recorded = self.store.checkouts_of(session_id).await?;
        if !recorded.is_empty() {
            return Ok(recorded
                .into_iter()
                .map(|c| Located {
                    dest: if c.path.is_empty() {
                        workspace.to_path_buf()
                    } else {
                        workspace.join(&c.path)
                    },
                    slug: c.slug,
                    base: c.base,
                })
                .collect());
        }

        // Recorded before checkouts were. The workspace is the checkout.
        let Some((_, base)) = self.store.refs_of(session_id).await? else {
            return Ok(Vec::new());
        };
        Ok(vec![Located {
            dest: workspace.to_path_buf(),
            slug: self.store.repo_of(session_id).await?.unwrap_or_default(),
            base,
        }])
    }

    /// Do something with the work a session produced.
    async fn run_action(
        &self,
        session_id: &SessionId,
        action: ft_proto::Action,
        credential: Option<ft_proto::Credential>,
        out: &Out,
    ) -> Result<String> {
        match action {
            ft_proto::Action::StartAgent { spec } => {
                anyhow::ensure!(
                    &spec.session_id == session_id,
                    "launch must name the requested session"
                );
                self.start_agent(*spec, out).await?;
                Ok("agent is ready".to_string())
            }
            ft_proto::Action::Stop => {
                // The workspace and the branch stay; only the agent goes. What
                // it produced is still there to look at, commit, or push.
                self.attached.lock().await.remove(session_id.as_str());
                Tmux::for_session(session_id.as_str()).kill().await?;
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
                while agentd::AgentClient::connect(session_id.as_str())
                    .await
                    .is_ok()
                {
                    anyhow::ensure!(
                        tokio::time::Instant::now() < deadline,
                        "the previous agent has not stopped; refusing to replace its credentials"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }

                self.store
                    .set_status(session_id, SessionStatus::HandedBack)
                    .await?;
                self.emit(
                    session_id,
                    EventKind::StatusChanged {
                        status: SessionStatus::HandedBack,
                        note: None,
                    },
                    out,
                )
                .await?;

                Ok("stopped".to_string())
            }

            ft_proto::Action::Commit {
                checkout,
                message,
                paths,
                author,
            } => {
                let dest = self.checkout_at(session_id, &checkout).await?;
                self.git
                    .commit(&dest, &message, &paths, author.as_ref())
                    .await
            }

            ft_proto::Action::Push { checkout } => {
                let (dest, branch) = self.checkout_refs(session_id, &checkout).await?;
                self.git.push(&dest, &branch, credential).await
            }

            ft_proto::Action::Attach { name, data } => {
                let dest = self.workspace_of(session_id).await?;
                let bytes = ft_proto::decode(&data).context("that attachment was not base64")?;
                attachments::keep(&dest, &name, &bytes).await
            }

            ft_proto::Action::Describe {
                asked_for,
                task,
                env,
            } => {
                let workspace = self.workspace_of(session_id).await?;
                let (agent, prompt) = self.store.session_brief(session_id).await?;

                // Every checkout, one after another. A change that spans two
                // repositories is one piece of work and wants one sentence
                // describing it — so the model sees all of it, with each part
                // labelled by the repository it came from.
                let mut diff = String::new();
                for c in self.checkouts_or_workspace(session_id, &workspace).await? {
                    let part = self.git.diff(&c.dest, &c.base).await.unwrap_or_default();
                    if part.trim().is_empty() {
                        continue;
                    }
                    if !diff.is_empty() {
                        diff.push('\n');
                    }
                    diff.push_str(&format!("# {}\n{part}", c.slug));
                }

                // What the control plane knows, then what this machine knows.
                // The session's prompt is empty for every workspace cut from an
                // issue — those put the issue in the composer rather than in a
                // prompt — which is exactly when the control plane has
                // something better to send.
                let asked_for = asked_for
                    .as_deref()
                    .map(str::trim)
                    .filter(|a| !a.is_empty())
                    .unwrap_or(prompt.trim());

                let proposal = describe::propose(describe::About {
                    agent,
                    workspace: &workspace,
                    session_id: session_id.as_str(),
                    asked_for: Some(asked_for).filter(|a| !a.is_empty()),
                    task: task.as_deref(),
                    diff: &diff,
                    state: &self.root,
                    env: &env,
                })
                .await?;

                // Three values through a channel that carries one string. The
                // shape the control plane reads it back with is right beside
                // this, in `sessions::describe`.
                Ok(serde_json::to_string(&ft_proto::Described {
                    title: proposal.title,
                    body: proposal.body,
                    issues: proposal.issues,
                })?)
            }

            ft_proto::Action::Diff { checkout } => {
                let (dest, base) = self.checkout_diff_refs(session_id, &checkout).await?;
                self.git.diff(&dest, &base).await
            }

            ft_proto::Action::AddRepo { repo, mut env } => {
                let workspace = self.workspace_of(session_id).await?;
                let position = self.store.checkouts_of(session_id).await?.len() as i64;

                // The same ones the session started with, so a setup script run
                // now can find its way home exactly as one run at launch could
                // — and so a repository whose setup brings up a database gets
                // it in this session's Compose project rather than in a shared
                // one that teardown would never find.
                env.push((ft_core::SESSION_ENV.to_string(), session_id.to_string()));
                env.push((
                    ft_core::WORKER_ROOT_ENV.to_string(),
                    self.root.display().to_string(),
                ));
                env.push((
                    "COMPOSE_PROJECT_NAME".to_string(),
                    crate::docker::project(session_id),
                ));

                self.prepare_checkout(session_id, &workspace, position, &repo, &env, out)
                    .await?;
                self.write_workspace_guide(session_id, &workspace).await;

                Ok(format!(
                    "{} is checked out at ./{}",
                    repo.slug,
                    if repo.path.is_empty() {
                        "."
                    } else {
                        &repo.path
                    }
                ))
            }
        }
    }

    /// What is unsaved, per checkout.
    ///
    /// One per repository, because "two commits ahead" means nothing without
    /// saying ahead in *what*. A checkout that cannot be read reports nothing
    /// rather than failing the lot: one broken worktree should not hide what
    /// the others are holding.
    async fn summarize(&self, session_id: &SessionId) -> Result<Vec<ft_core::CheckoutSummary>> {
        let workspace = self.workspace_of(session_id).await?;
        let recorded = self.store.checkouts_of(session_id).await?;

        if recorded.is_empty() {
            // Recorded before checkouts were, or a bare agent. The workspace is
            // the checkout, if it is anything.
            let Some((branch, base)) = self.store.refs_of(session_id).await? else {
                return Ok(Vec::new());
            };
            let summary = self.git.summary(&workspace, &branch, &base).await?;
            return Ok(vec![ft_core::CheckoutSummary {
                path: String::new(),
                slug: self.store.repo_of(session_id).await?.unwrap_or_default(),
                summary,
                trouble: None,
            }]);
        }

        let mut out = Vec::new();
        for c in recorded {
            let dest = if c.path.is_empty() {
                workspace.clone()
            } else {
                workspace.join(&c.path)
            };
            match self.git.summary(&dest, &c.branch, &c.base).await {
                Ok(summary) => out.push(ft_core::CheckoutSummary {
                    path: c.path,
                    slug: c.slug,
                    summary,
                    trouble: None,
                }),
                // Reported, not dropped. Left out, this row reached the
                // control plane as nothing, and nothing became zeros — so a
                // worktree git could not read looked like a repository with
                // no changes in it. The sentence git gave is the one thing
                // that would have said otherwise.
                Err(e) => {
                    tracing::warn!(session = %session_id, repo = %c.slug, "summarising: {e:#}");
                    out.push(ft_core::CheckoutSummary {
                        path: c.path,
                        slug: c.slug,
                        summary: ft_core::WorkSummary {
                            branch: c.branch,
                            uncommitted: 0,
                            ahead: 0,
                            pushed: false,
                            commits: None,
                        },
                        trouble: Some(format!("{e:#}")),
                    });
                }
            }
        }
        Ok(out)
    }

    /// Attach to a session's terminal.
    ///
    /// No scrollback is sent first, though it looks like it should be: `tmux
    /// attach` enters the alternate screen and clears it, so anything written
    /// beforehand is wiped a few milliseconds later — and until it is, it lands
    /// as a staircase, because captured lines end in `\n` and a raw terminal
    /// needs `\r\n` to return to column zero.
    ///
    /// tmux redraws the pane itself on attach, which is the same content by a
    /// shorter route. History above the visible screen stays reachable through
    /// tmux's own copy mode, since every key reaches it.
    async fn open_terminal(
        &self,
        session_id: &SessionId,
        pty: Pty,
        cols: u16,
        rows: u16,
        out: &Out,
    ) -> Result<()> {
        let tmux = Tmux::named(pty.tmux_name(session_id.as_str()));

        match pty {
            // A shell is made when you ask for one, in the directory the agent
            // works in and carrying what the agent carries — read back out of
            // the agent's own tmux session, which is the only place those
            // values live on this machine.
            Pty::Shell => {
                if !tmux.exists().await {
                    let workspace = self.workspace_of(session_id).await?;
                    let agent = Tmux::for_session(session_id.as_str());
                    let env = match agent.environment().await {
                        Ok(env) => env,
                        // A session whose agent has already gone still gets a
                        // shell; it just gets a plain one.
                        Err(e) => {
                            tracing::warn!(session = %session_id, "no environment to copy: {e:#}");
                            Vec::new()
                        }
                    };

                    tmux.start(&workspace, &login_shell(), &env)
                        .await
                        .context("starting a shell")?;
                }
            }
        }

        let key = terminal_key(session_id, pty);

        // Reuse a live attachment rather than replacing it. Two viewers share
        // one, and tearing the old one down would send its dying client's
        // "[lost tty]" to everyone still watching — which is what a second tab,
        // or a development double-mount, would do on every open.
        {
            let attached = self.attached.lock().await;
            if let Some(existing) = attached.get(&key) {
                if existing.is_alive() {
                    // The last repaint went to whoever was watching then, so
                    // ask for another one on behalf of whoever just arrived.
                    let _ = existing.repaint(cols.max(20), rows.max(5));
                    return Ok(());
                }
            }
        }
        self.attached.lock().await.remove(&key);

        let attachment = attach::Attachment::open(
            tmux.name(),
            session_id.clone(),
            pty,
            cols.max(20),
            rows.max(5),
            out.clone(),
        )?;

        self.attached.lock().await.insert(key, attachment);

        Ok(())
    }

    /// Record then send. Durable before it leaves, so a crash between the two
    /// costs a replayed event rather than a lost one.
    async fn emit(&self, session_id: &SessionId, kind: EventKind, out: &Out) -> Result<()> {
        let stored = self.store.append(session_id, &kind).await?;

        // Under the cursor's lock, so the tail below cannot look between the
        // append and the send and decide this one is unsent.
        let mut forwarded = self.forwarded.lock().await;
        let seq = stored.seq;
        out.send(ToServer::Event {
            seq,
            session_id: stored.session_id,
            kind: stored.kind,
            at: stored.at,
        })
        .await
        .map_err(|_| anyhow::anyhow!("nobody is listening for events"))?;
        *forwarded = (*forwarded).max(seq);
        Ok(())
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Send anything that appeared in the log without going through us.
    ///
    /// Which means hooks: a separate process, started by the agent, appending
    /// what the agent just did. Polled rather than watched because SQLite has
    /// no notification a second process can wait on — and a second is well
    /// inside the time it takes somebody to look at a screen.
    ///
    /// When no control plane is connected this never runs, and it does not
    /// need to: the rows stay in the log, and the next `Resume` collects them.
    /// That is the whole reason a hook writes to a file rather than to us.
    /// Say what this machine has and what each workspace is taking of it.
    ///
    /// Best effort from end to end. A worker that cannot read a cgroup, cannot
    /// reach its daemon, or whose control plane has gone quiet reports what it
    /// has and drops the rest — none of which is a reason to disturb a session.
    /// The interface draws a workspace with no reading as one with no meters,
    /// which is honest: nothing is being measured there.
    async fn report_usage(
        &self,
        out: &Out,
        cpu_seen: &mut std::collections::HashMap<String, (u64, std::time::Instant)>,
    ) {
        let places = match self.store.live_workspaces().await {
            Ok(places) => places,
            Err(e) => {
                tracing::debug!("listing workspaces to report: {e:#}");
                return;
            }
        };

        let mut workspaces = Vec::with_capacity(places.len());
        for (session_id, path) in &places {
            let path = std::path::Path::new(path);
            let Some(raw) = crate::cgroup::usage(path).await else {
                continue;
            };

            // A total becomes a rate only once there is something to compare it
            // with, so the first reading after a connect reports no CPU rather
            // than a number computed against zero — which would read as the
            // workspace having used every core since the machine booted.
            let now = std::time::Instant::now();
            let key = crate::cgroup::name(path);
            let cpu = match cpu_seen.insert(key, (raw.cpu_usec, now)) {
                Some((was, then)) => {
                    let elapsed = now.duration_since(then).as_micros() as f64;
                    let spent = raw.cpu_usec.saturating_sub(was) as f64;
                    if elapsed > 0.0 {
                        (spent / elapsed) as f32
                    } else {
                        0.0
                    }
                }
                None => 0.0,
            };

            workspaces.push((
                session_id.clone(),
                ft_core::WorkspaceUsage {
                    memory_mb: raw.memory_current / 1024 / 1024,
                    memory_peak_mb: raw.memory_peak / 1024 / 1024,
                    memory_max_mb: raw.memory_max.map(|b| b / 1024 / 1024),
                    cpu,
                    oom_kills: raw.oom_kills,
                },
            ));
        }

        // Workspaces that have gone are dropped from the history, or a worker
        // up for weeks would keep a reading per workspace it had ever seen.
        let live: std::collections::HashSet<String> = places
            .iter()
            .map(|(_, p)| crate::cgroup::name(std::path::Path::new(p)))
            .collect();
        cpu_seen.retain(|name, _| live.contains(name));

        let capacity = crate::capacity::read().await;
        // The control plane is gone or not keeping up. Neither is worth a line
        // in the log every five seconds, and the next tick tries again.
        let _ = out
            .send(ToServer::Usage {
                capacity,
                workspaces,
            })
            .await;
    }

    async fn forward_new_events(&self, out: &Out) -> Result<()> {
        let mut forwarded = self.forwarded.lock().await;

        for e in self.store.events_since(*forwarded).await? {
            let seq = e.seq;
            out.send(ToServer::Event {
                seq,
                session_id: e.session_id,
                kind: e.kind,
                at: e.at,
            })
            .await
            .map_err(|_| anyhow::anyhow!("nobody is listening for events"))?;
            *forwarded = (*forwarded).max(seq);
        }

        Ok(())
    }

    pub fn git(&self) -> &GitRoot {
        &self.git
    }
}

fn num_cpus() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(1)
}

/// What is already here under a session's name.
#[derive(Debug, PartialEq, Eq)]
enum Standing {
    /// Nothing. Start it.
    Fresh,
    /// The agent is there and listening. There is nothing to start.
    Running,
    /// A tmux session with no agent in it — the pane outlived the process.
    Abandoned,
}

/// Tell an agent that is running from the shell that outlived one.
///
/// `tmux has-session` answers neither question: it is true for a healthy agent
/// and equally true for the pane left behind when one exits. Refusing on it
/// alone meant a relaunch could never replace a dead agent, so the route back
/// from a failed run was the route that could not be taken. The socket is what
/// actually distinguishes them, because it is the thing the agent holds open.
async fn standing(tmux: &Tmux, id: &SessionId) -> Standing {
    if !tmux.exists().await {
        return Standing::Fresh;
    }
    if agentd::AgentClient::connect(id.as_str()).await.is_ok() {
        return Standing::Running;
    }
    Standing::Abandoned
}

/// Whether this frame does work, as opposed to answering from memory.
///
/// The slow ones clone repositories, run setup commands, talk to a git host, or
/// tear a workspace down. None of them need to be in step with the frames
/// around them: each carries its own session or request id, and the control
/// plane matches answers up by that rather than by arrival order.
///
/// The rest are cheap and stay in order deliberately — terminal input has to
/// arrive in the sequence it was typed, and a replay has to finish before the
/// events that follow it.
fn takes_a_while(frame: &ToWorker) -> bool {
    matches!(
        frame,
        ToWorker::CreateWorkspace(_)
            // Starts a process and waits for it to bind its socket. Handled
            // inline it blocked the read loop, and the events it emitted then
            // sat in a channel only that loop drains — so a second agent
            // produced no tmux session, no events and no explanation.
            | ToWorker::StartAgent(_)
            | ToWorker::Destroy { .. }
            | ToWorker::Stop { .. }
            | ToWorker::RunAction { .. }
            | ToWorker::Summarize { .. }
            | ToWorker::ProbeRemote { .. }
            | ToWorker::ProbeAgents { .. }
            // npm, fetching a few hundred megabytes. Minutes on a slow line,
            // and every heartbeat is due during it.
            | ToWorker::InstallAgent { .. }
            // Starting a login is two round trips to a process this has to
            // spawn first. The waiting after that is its own task; getting as
            // far as a code is still too slow to do on the loop.
            | ToWorker::CodexLoginStart { .. }
            // Not because replaying is slow, but because it is unbounded: a
            // worker with a long history sends more events than the outbound
            // channel holds. Handled on the loop, the send that fills the
            // channel blocks the same loop that drains it, and the worker goes
            // silent for good with the connection still open.
            | ToWorker::Resume { .. }
            // Unbounded for the same reason, and slow on top of it: a hundred
            // megabytes leaves at a chunk a time. On the loop, once the
            // channel is full the loop blocks inside its own send and stops
            // reading — so nothing else on this machine is answered until the
            // last chunk of somebody's download has been handed over.
            | ToWorker::ReadFile { .. } // Unbounded for the same reason, and slow on top of it: a hundred
                                        // megabytes leaves at a chunk a time. On the loop, once the
                                        // channel is full the loop blocks inside the send and stops
                                        // reading — so nothing else on this machine is answered until the
                                        // last chunk of somebody's download has been handed over.
                                        // Unbounded for the same reason, and slow on top of it: a hundred
                                        // megabytes leaves at a chunk a time. On the loop, nothing else on
                                        // this machine is read or answered until the last one — so a
                                        // download made every other session's terminal stop, and the
                                        // control plane's heartbeat go unanswered.
                                        // Unbounded for the same reason, and slow on top of it: a hundred
                                        // megabytes leaves at a chunk a time. On the loop, nothing else on
                                        // this machine is read or answered until the last one — so a
                                        // download made every other session's terminal stop, and the
                                        // control plane's heartbeat go unanswered.
    )
}

/// One terminal of one session.
///
/// Still keyed by kind rather than by session alone, even though only one kind
/// is left: a session that grows a second terminal should not need every map in
/// two files rewritten again.
fn terminal_key(session_id: &SessionId, pty: Pty) -> String {
    match pty {
        Pty::Shell => format!("{session_id}:shell"),
    }
}

/// The shell somebody would get if they logged in to this machine.
fn login_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/bin/sh".to_string())
}

/// Resolve a path against a workspace, or refuse.
///
/// On components rather than on the joined string: `workspace/../escaped` does
/// start with `workspace` as far as `Path::starts_with` is concerned, which is
/// a check that passes exactly what it exists to stop.
fn inside(workspace: &Path, path: &str) -> Result<PathBuf> {
    let relative = Path::new(path.trim_start_matches('/'));

    if relative.components().any(|c| {
        matches!(
            c,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    }) {
        anyhow::bail!("{path} is outside the workspace");
    }

    Ok(workspace.join(relative))
}

/// Every file in a workspace, according to git.
///
/// Tracked plus untracked-but-not-ignored, which is what somebody means by
/// "the files in this repository" — and git already holds the answer, so it
/// arrives in milliseconds where a walk would take seconds. `None` when the
/// workspace is not a checkout, or git will not say; the caller walks instead.
async fn git_index(workspace: &Path) -> Option<Vec<String>> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .output()
        .await
        .ok()?;

    if !out.status.success() {
        return None;
    }

    Some(
        String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .filter(|line| !line.is_empty())
            .take(SEARCH_LIMIT)
            .map(str::to_string)
            .collect(),
    )
}

/// Every file under a directory, for a workspace git has nothing to say about.
///
/// Breadth-first, so a cap falls on the deepest corners rather than on the
/// second half of the alphabet. Links are skipped rather than followed: one
/// pointing at `/` would turn a filename search into a walk of the machine.
async fn walk(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut queue = std::collections::VecDeque::from([root.to_path_buf()]);

    while let Some(dir) = queue.pop_front() {
        let Ok(mut reading) = tokio::fs::read_dir(&dir).await else {
            continue;
        };

        while let Ok(Some(entry)) = reading.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if UNSEARCHED.contains(&name.as_str()) {
                continue;
            }

            let Ok(kind) = entry.file_type().await else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }

            let path = entry.path();
            if kind.is_dir() {
                queue.push_back(path);
            } else {
                found.push(showable(root, &path));
                if found.len() >= SEARCH_LIMIT {
                    return found;
                }
            }
        }
    }

    found
}

/// The paths that match, best first.
///
/// Loose matching, because nobody types a path — they type the four letters
/// they remember, in order, and expect `sesv` to find `SessionView.tsx`.
fn rank(paths: &[String], query: &str, limit: usize) -> Vec<String> {
    let needle: Vec<char> = query
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect();

    if needle.is_empty() {
        let mut all: Vec<String> = paths.to_vec();
        all.sort();
        all.truncate(limit);
        return all;
    }

    let mut scored: Vec<(i64, &String)> = paths
        .iter()
        .filter_map(|path| score(path, &needle).map(|s| (s, path)))
        .collect();

    // Score, then the shorter path, then alphabetical — so the same query
    // twice gives the same list rather than whatever order the walk found.
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.len().cmp(&b.1.len()))
            .then_with(|| a.1.cmp(b.1))
    });

    scored
        .into_iter()
        .take(limit)
        .map(|(_, path)| path.clone())
        .collect()
}

/// How well a path answers a query, or `None` if it does not.
///
/// Scored twice: once against the whole path and once against the filename
/// alone, with the filename worth much more. Somebody typing `session` wants
/// `session.rs`, not the eleven files that happen to live under `sessions/`.
fn score(path: &str, needle: &[char]) -> Option<i64> {
    let hay: Vec<char> = path.chars().flat_map(char::to_lowercase).collect();
    let name_at = hay.iter().rposition(|&c| c == '/').map_or(0, |i| i + 1);

    let whole = run(&hay, 0, needle);
    let name = run(&hay, name_at, needle).map(|s| s + 500);

    let best = whole.into_iter().chain(name).max()?;
    // Ties go to the shorter path: the same letters spread over a longer one is
    // a worse answer to the same question.
    Some(best * 100 - hay.len() as i64)
}

/// One pass of the match, from `from` onwards.
///
/// Leftmost-first. It is not the highest-scoring arrangement of the characters,
/// but it always finds one if one exists, and the bonuses below do the ranking
/// that the arrangement would have.
fn run(hay: &[char], from: usize, needle: &[char]) -> Option<i64> {
    let mut total = 0i64;
    let mut at = from;
    let mut last: Option<usize> = None;

    for &want in needle {
        let found = at + hay[at..].iter().position(|&c| c == want)?;

        let mut point = 1;
        // A run of letters is what somebody was actually typing.
        if last == Some(found.wrapping_sub(1)) {
            point += 6;
        }
        // The start of a word: `st` should find `SessionTab`, not `assets`.
        if found == 0 || matches!(hay[found - 1], '/' | '_' | '-' | '.' | ' ') {
            point += 4;
        }
        total += point;

        last = Some(found);
        at = found + 1;
    }

    Some(total)
}

/// A size in the unit somebody would say it in.
///
/// 101 MB was reading as "0.1 GB", which is both true and no use to anyone
/// deciding whether their file is nearly small enough.
fn readable(bytes: u64) -> String {
    const MB: f64 = 1_048_576.0;
    const GB: f64 = 1_073_741_824.0;

    match bytes as f64 {
        b if b >= GB => format!("{:.1} GB", b / GB),
        b if b >= MB => format!("{:.0} MB", b / MB),
        b => format!("{b:.0} bytes"),
    }
}

/// A path as somebody looking at the workspace would write it.
fn showable(workspace: &Path, path: &Path) -> String {
    path.strip_prefix(workspace)
        .unwrap_or(path)
        .display()
        .to_string()
}

/// Write an agent's own files, readable by nobody else.
///
/// `0600` on the files and `0700` on the directory, because these are
/// credentials — the mode is the whole reason this is a function rather than
/// two lines at the call site.
///
/// Relative paths only, and no climbing out: the names come from the control
/// plane rather than from a person, but a path that escaped the directory
/// would write a credential somewhere nothing cleans up.
/// Separate mutable authentication and thread storage for each run. Copy the old
/// workspace home once on upgrade so native Codex thread resume remains possible.
async fn prepare_agent_home(
    path: &std::path::Path,
    id: &SessionId,
    agent: ft_core::Agent,
    files: &[(String, String)],
    env: &mut Vec<(String, String)>,
) -> Result<()> {
    let Some(variable) = agent.home_var() else {
        return Ok(());
    };
    let has_key = agent
        .api_key_var()
        .is_some_and(|key| env.iter().any(|(k, _)| k == key));
    if files.is_empty() && !has_key {
        return Ok(());
    }
    let home = agentd::dir_for(path).join(format!("agent-home-{}", id.as_str()));
    if !home.exists() {
        let old = agentd::dir_for(path).join("agent-home");
        let dest = home.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            fn copy_dir(source: &std::path::Path, dest: &std::path::Path) -> Result<()> {
                std::fs::create_dir_all(dest)?;
                if !source.exists() {
                    return Ok(());
                }
                for entry in std::fs::read_dir(source)? {
                    let entry = entry?;
                    let kind = entry.file_type()?;
                    let target = dest.join(entry.file_name());
                    if kind.is_dir() {
                        copy_dir(&entry.path(), &target)?;
                    } else if kind.is_file() && entry.file_name() != "auth.json" {
                        std::fs::copy(entry.path(), target)?;
                    }
                }
                Ok(())
            }
            copy_dir(&old, &dest)
        })
        .await??;
    }
    if files.is_empty() {
        match tokio::fs::remove_file(home.join("auth.json")).await {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    } else {
        write_agent_home(&home, files).await?;
    }
    env.retain(|(k, _)| k != variable);
    env.push((variable.to_string(), home.display().to_string()));
    Ok(())
}

async fn write_agent_home(home: &std::path::Path, files: &[(String, String)]) -> Result<()> {
    tokio::fs::create_dir_all(home)
        .await
        .with_context(|| format!("making {}", home.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700))
            .await
            .with_context(|| format!("locking {}", home.display()))?;
    }

    for (name, contents) in files {
        let relative = std::path::Path::new(name);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            anyhow::bail!("{name} is not a name inside the agent's own directory");
        }

        let file = home.join(relative);
        if let Some(parent) = file.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        tokio::fs::write(&file, contents)
            .await
            .with_context(|| format!("writing {}", file.display()))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))
                .await
                .with_context(|| format!("locking {}", file.display()))?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod watcher_tests {
    use super::*;

    /// Whether a watcher was actually started, judged by what it did rather
    /// than by what is in the map: one with no agent to watch says so, and one
    /// that was never started says nothing at all.
    async fn started(out: &mut mpsc::Receiver<ToServer>) -> bool {
        tokio::time::timeout(std::time::Duration::from_millis(500), out.recv())
            .await
            .is_ok()
    }

    /// Two forwarders on one session send every line twice, and the control
    /// plane cannot tell — it stores one row either way, so it arrives in a
    /// browser as every word written twice.
    #[tokio::test]
    async fn a_second_watcher_is_refused_while_the_first_is_running() {
        let dir = tempfile::tempdir().unwrap();
        let worker = Worker::open(dir.path()).await.unwrap();
        let (tx, mut heard) = mpsc::channel(8);
        let out = Out::merged(tx);
        let id = SessionId::from_stored("s_01watch");

        // Something that does not finish, standing in for a live watcher.
        worker.watching.lock().await.insert(
            id.to_string(),
            tokio::spawn(async { std::future::pending::<()>().await }),
        );

        worker.watch_agent(&id, 0, &out).await;
        assert!(
            !started(&mut heard).await,
            "a second watcher started beside a running one"
        );
    }

    /// And the other way round, which cost a whole session: a watcher started
    /// before the agent was listening fails at once, and its leftover entry
    /// must not stop a real one starting. Treating it as alive meant the
    /// control plane heard not one word of a session that ran perfectly.
    #[tokio::test]
    async fn a_watcher_that_already_died_does_not_hold_the_slot() {
        let dir = tempfile::tempdir().unwrap();
        let worker = Worker::open(dir.path()).await.unwrap();
        let (tx, mut heard) = mpsc::channel(8);
        let out = Out::merged(tx);
        let id = SessionId::from_stored("s_01dead");

        let over = tokio::spawn(async {});
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(over.is_finished(), "the stand-in has to be over");
        worker.watching.lock().await.insert(id.to_string(), over);

        worker.watch_agent(&id, 0, &out).await;
        assert!(
            started(&mut heard).await,
            "a dead entry stopped a real watcher from starting"
        );
    }
}

#[cfg(test)]
mod agent_home_tests {
    use super::*;

    /// The mode is the point. A credential written 0644 into a workspace is a
    /// credential anybody with an account on that host can read.
    #[tokio::test]
    async fn a_credential_is_written_readable_by_nobody_else() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("agent-home");

        write_agent_home(&home, &[("auth.json".into(), "{\"tokens\":{}}".into())])
            .await
            .unwrap();

        let file = home.join("auth.json");
        assert_eq!(
            tokio::fs::read_to_string(&file).await.unwrap(),
            "{\"tokens\":{}}"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = tokio::fs::metadata(&file)
                .await
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "the file has to be private");
            let mode = tokio::fs::metadata(&home)
                .await
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700, "so does the directory holding it");
        }
    }

    /// The names come from the control plane rather than a person, which is a
    /// reason to expect them to be fine and not a reason to trust them: a path
    /// that climbed out would write a credential somewhere nothing cleans up.
    #[tokio::test]
    async fn a_path_that_climbs_out_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("agent-home");

        for escape in ["../stolen.json", "/etc/stolen.json", "a/../../stolen.json"] {
            assert!(
                write_agent_home(&home, &[(escape.into(), "x".into())])
                    .await
                    .is_err(),
                "{escape} should be refused"
            );
        }
        assert!(!dir.path().join("stolen.json").exists());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ft_core::{Agent, WorkspaceSize};
    use tempfile::TempDir;

    /// An agent told nothing runs `docker compose up`, meets `command not
    /// found`, and concludes the workspace is broken. Being told plainly is
    /// the whole point of putting this in the file it reads first.
    #[test]
    fn a_session_without_docker_is_told_so_rather_than_left_to_find_out() {
        let id = SessionId::new();
        let said = Worker::docker_guidance(&ft_core::DockerState::absent(), &id);

        assert!(said.contains("no Docker on this machine"), "{said}");
        assert!(
            !said.contains("docker compose up"),
            "do not suggest the thing that cannot work: {said}"
        );
    }

    /// The two surprises about a shared daemon, in the file that gets read
    /// before anybody trips over either.
    #[test]
    fn a_session_with_docker_is_told_what_it_shares_and_how_to_be_swept() {
        let id = SessionId::new();
        let said = Worker::docker_guidance(&ft_core::DockerState::running("27.0.3"), &id);

        assert!(said.contains("shared"), "the port space is shared: {said}");
        assert!(
            said.contains(&crate::docker::project(&id)),
            "it has to name the project its own containers are in: {said}"
        );
        // The one thing an agent must do for a bare `docker run` to be cleared
        // up. Without the label in front of it, it will not add one.
        assert!(said.contains(crate::docker::SESSION_LABEL), "{said}");
        assert!(said.contains(id.as_str()), "{said}");
    }

    /// A daemon that died has a reason, and the reason is the whole value of
    /// saying anything at all.
    #[test]
    fn a_broken_daemon_carries_why_rather_than_only_that() {
        let id = SessionId::new();
        let said = Worker::docker_guidance(
            &ft_core::DockerState::stopped("failed to start daemon: no space left"),
            &id,
        );
        assert!(said.contains("no space left"), "{said}");

        // And one that would not say why still produces a usable sentence
        // rather than a dangling colon.
        let vague = Worker::docker_guidance(
            &ft_core::DockerState {
                status: ft_core::DockerStatus::Stopped,
                detail: None,
            },
            &id,
        );
        assert!(vague.contains("it did not say why"), "{vague}");
    }

    /// Nothing established means nothing claimed. A guess in either direction
    /// is worse than the silence — and this is what an older worker reports.
    #[test]
    fn an_unestablished_answer_says_nothing_at_all() {
        let said = Worker::docker_guidance(&ft_core::DockerState::default(), &SessionId::new());
        assert!(said.is_empty(), "{said}");
    }

    /// The filename wins over the directory it is in.
    ///
    /// Somebody typing `session` means the file called that, not the eleven
    /// files that happen to live under `sessions/` — which is what a match
    /// against the whole path, scored evenly, hands back.
    #[test]
    fn a_name_beats_the_directory_around_it() {
        let paths = vec![
            "crates/ft-server/src/api/sessions.rs".to_string(),
            "crates/ft-server/src/sessions/mod.rs".to_string(),
            "crates/ft-core/src/session.rs".to_string(),
        ];

        let found = rank(&paths, "session.rs", 10);
        assert_eq!(found[0], "crates/ft-core/src/session.rs");
    }

    /// The letters somebody remembers, in order, with the rest left out.
    #[test]
    fn letters_in_order_are_enough() {
        let paths = vec![
            "web/components/workspace/SessionTab.tsx".to_string(),
            "web/components/Settings.chat.tsx".to_string(),
            "web/app/page.tsx".to_string(),
        ];

        let found = rank(&paths, "sestab", 10);
        assert_eq!(found, vec!["web/components/workspace/SessionTab.tsx"]);
    }

    /// A run of letters beats the same letters scattered, and a shorter path
    /// beats a longer one holding the same match — so the order is the order
    /// somebody would have picked, not the order the walk found them in.
    #[test]
    fn the_closer_match_comes_first() {
        let paths = vec![
            "a/b/c/d/e/tree.tsx".to_string(),
            "tree.tsx".to_string(),
            "the/rest/of/everything.tsx".to_string(),
        ];

        let found = rank(&paths, "tree", 10);
        assert_eq!(found[0], "tree.tsx");
        assert_eq!(found[1], "a/b/c/d/e/tree.tsx");
    }

    /// Nothing typed is not "nothing matches": it is the workspace, in order.
    #[test]
    fn an_empty_query_is_the_whole_list() {
        let paths = vec!["b.rs".to_string(), "a.rs".to_string()];
        assert_eq!(rank(&paths, "  ", 10), vec!["a.rs", "b.rs"]);
    }

    /// Case is not something anybody remembers about a filename.
    #[test]
    fn case_is_not_asked_about() {
        let paths = vec!["web/components/FileGlyph.tsx".to_string()];
        assert_eq!(rank(&paths, "FILEGLYPH", 10).len(), 1);
        assert_eq!(rank(&paths, "fileglyph", 10).len(), 1);
    }

    /// The file a repository asked for, where it asked for it, and invisible
    /// to git.
    ///
    /// In a linked worktree, because that is what a session runs in and it is
    /// not the same thing: a worktree's own `info/exclude` is never read, so a
    /// test in a plain checkout passes while every real session leaves a `.env`
    /// sitting there untracked, waiting to be committed.
    ///
    /// And git is the oracle. `check-ignore` is the question actually being
    /// asked — whether the file is invisible — where reading the exclude file
    /// back only proves we wrote something somewhere.
    #[tokio::test]
    async fn an_env_file_is_written_and_kept_out_of_git() {
        let dir = TempDir::new().unwrap();
        let mirror = dir.path().join("mirror");
        let workspace = dir.path().join("work");

        let git = |args: &[&str], cwd: &Path| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .unwrap()
        };

        std::fs::create_dir_all(&mirror).unwrap();
        git(&["init", "-q", "-b", "main"], &mirror);
        std::fs::write(mirror.join("README.md"), "# demo\n").unwrap();
        git(&["add", "-A"], &mirror);
        git(
            &[
                "-c",
                "user.email=a@b",
                "-c",
                "user.name=t",
                "commit",
                "-qm",
                "init",
            ],
            &mirror,
        );
        git(
            &["worktree", "add", "-q", workspace.to_str().unwrap()],
            &mirror,
        );

        Worker::write_env_file(
            &workspace,
            &ft_proto::EnvFile {
                path: "config/.env".into(),
                variables: vec![
                    (
                        "DATABASE_URL".into(),
                        "postgres://user:pa'ss@host/db".into(),
                    ),
                    ("NOTE".into(), "two words # not a comment".into()),
                ],
            },
        )
        .await
        .unwrap();

        let written = std::fs::read_to_string(workspace.join("config/.env")).unwrap();
        let read_back = ft_core::dotenv::parse(&written);
        assert_eq!(read_back.variables.len(), 2);
        assert_eq!(
            read_back.variables[0].value,
            "postgres://user:pa'ss@host/db"
        );
        assert_eq!(read_back.variables[1].value, "two words # not a comment");

        let ignored = git(&["check-ignore", "config/.env"], &workspace);
        assert!(
            ignored.status.success(),
            "git itself has to be the one that can't see it"
        );

        let untracked = git(&["status", "--porcelain"], &workspace);
        let untracked = String::from_utf8_lossy(&untracked.stdout);
        assert!(
            !untracked.contains(".env"),
            "and it stays out of what an agent would commit: {untracked}"
        );

        // Starting a second session on the same checkout must not write the
        // line again.
        Worker::exclude_from_git(&workspace, "config/.env").await;
        let common = git(&["rev-parse", "--git-common-dir"], &workspace);
        let common = PathBuf::from(String::from_utf8_lossy(&common.stdout).trim().to_string());
        let exclude = std::fs::read_to_string(
            if common.is_absolute() {
                common
            } else {
                workspace.join(common)
            }
            .join("info")
            .join("exclude"),
        )
        .unwrap();
        assert_eq!(
            exclude
                .lines()
                .filter(|l| l.trim() == "config/.env")
                .count(),
            1,
            "and only once"
        );
    }

    /// A path out of the workspace is refused by the side holding the disk.
    #[tokio::test]
    async fn an_env_file_cannot_be_written_outside_the_workspace() {
        let dir = TempDir::new().unwrap();
        let workspace = dir.path().join("work");
        std::fs::create_dir_all(&workspace).unwrap();

        let refused = Worker::write_env_file(
            &workspace,
            &ft_proto::EnvFile {
                path: "../escaped".into(),
                variables: vec![("A".into(), "1".into())],
            },
        )
        .await;

        assert!(refused.is_err(), "a frame is not a promise");
        assert!(!dir.path().join("escaped").exists());
    }

    /// A worker served over a live pipe, with both ends still open.
    ///
    /// [`exchange`] hands the loop a finished slice of bytes and reads what it
    /// wrote once it has stopped. That cannot express the case that matters
    /// here: a frame sent *while* the loop is mid-await, with another task
    /// filling the outbound channel underneath it. This keeps both halves open
    /// so a test can drive the connection the way a control plane does.
    struct Served {
        to_worker: mpsc::UnboundedSender<ToWorker>,
        from_worker: mpsc::UnboundedReceiver<ToServer>,
    }

    impl Served {
        fn send(&self, frame: ToWorker) {
            self.to_worker.send(frame).expect("the worker has stopped");
        }

        /// The next frame this test cares about, or `None` if none arrives.
        ///
        /// Frames the worker sends on its own — `Usage` every five seconds —
        /// are skipped rather than asserted against, so a test says what it is
        /// about instead of restating the whole conversation.
        async fn wait_for(
            &mut self,
            within: std::time::Duration,
            mut matching: impl FnMut(&ToServer) -> bool,
        ) -> Option<ToServer> {
            let deadline = tokio::time::Instant::now() + within;
            loop {
                let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                if left.is_zero() {
                    return None;
                }
                match tokio::time::timeout(left, self.from_worker.recv()).await {
                    Ok(Some(frame)) if matching(&frame) => return Some(frame),
                    Ok(Some(_)) => continue,
                    Ok(None) | Err(_) => return None,
                }
            }
        }
    }

    /// Serve a worker over a duplex pair and hand back both ends.
    fn serve_over_duplex(worker: std::sync::Arc<Worker>) -> Served {
        serve_over_duplex_at(worker, std::time::Duration::ZERO)
    }

    /// The same, over a link that reads at a limited rate.
    ///
    /// The pipe to a real worker is an ssh connection to another machine, and
    /// the failures worth testing here are all failures of *queueing* — which
    /// an in-memory duplex that drains instantly can never produce. `per_frame`
    /// is what makes the far end slower than the worker, so the queue actually
    /// forms.
    fn serve_over_duplex_at(
        worker: std::sync::Arc<Worker>,
        per_frame: std::time::Duration,
    ) -> Served {
        let (ours, theirs) = tokio::io::duplex(16 * 1024);
        let (their_read, their_write) = tokio::io::split(theirs);
        tokio::spawn(async move {
            let _ = worker.serve(their_read, their_write).await;
        });

        let (our_read, our_write) = tokio::io::split(ours);
        let (to_worker, mut outgoing) = mpsc::unbounded_channel::<ToWorker>();
        let (incoming, from_worker) = mpsc::unbounded_channel::<ToServer>();

        let mut writer = ft_proto::FrameWriter::new(our_write);
        tokio::spawn(async move {
            while let Some(frame) = outgoing.recv().await {
                if writer.write(&frame).await.is_err() {
                    break;
                }
            }
        });

        let mut reader = ft_proto::FrameReader::new(our_read);
        tokio::spawn(async move {
            loop {
                if !per_frame.is_zero() {
                    tokio::time::sleep(per_frame).await;
                }
                match reader.read::<ToServer>().await {
                    Ok(frame) => {
                        if incoming.send(frame).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let served = Served {
            to_worker,
            from_worker,
        };
        served.send(hello());
        served
    }

    /// A session with enough recorded for the worker to answer about it.
    async fn recorded(worker: &Worker, title: &str) -> SessionId {
        let session = SessionId::new();
        worker
            .store
            .create_session(
                &session,
                None,
                title,
                "do a thing",
                None,
                None,
                "Shell",
                WorkspaceSize::Small,
            )
            .await
            .unwrap();
        session
    }

    /// The serve loop must never be the only drain of a channel it also fills.
    ///
    /// [`a_history_longer_than_the_channel_still_replays`] pinned this for
    /// `Resume` and only for `Resume`, so the same deadlock came back through
    /// every other arm that sends: a worker whose outbound channel filled while
    /// the loop was mid-await stopped draining it, and stopped for good. The
    /// connection stayed open and perfectly healthy-looking; the control plane
    /// heard nothing at all and gave the host up as dead fifty seconds later.
    ///
    /// So this asserts the property rather than the frame that happened to
    /// expose it: whatever is in the channel, a `Ping` is still answered.
    #[tokio::test]
    async fn a_full_outbound_channel_never_wedges_the_serve_loop() {
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let session = recorded(&worker, "A busy one").await;

        // More than the channel holds, appended from underneath the loop the
        // way a tunnel's reader task does — not through a frame the loop is
        // handling, which is the case that was already covered.
        for _ in 0..(OUTBOUND + 500) {
            worker
                .store
                .append(
                    &session,
                    &EventKind::StepProgress {
                        step: ft_core::Step::Fetch,
                        detail: "counting objects".into(),
                    },
                )
                .await
                .unwrap();
        }

        let mut served = serve_over_duplex(worker.clone());

        // Long enough for the one-second tick to have forwarded them. That is
        // what fills the channel: `forward_new_events` sends every event it
        // finds without returning to the loop in between, so past the
        // channel's capacity it is waiting on a drain that only the loop it is
        // running on can perform.
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        served.send(ToWorker::Ping);

        let pong = served
            .wait_for(std::time::Duration::from_secs(20), |f| {
                matches!(f, ToServer::Pong)
            })
            .await;

        assert!(
            pong.is_some(),
            "a worker with a full outbound channel must still answer a heartbeat"
        );
    }

    /// A download must not make the worker deaf until it finishes.
    ///
    /// `ReadFile` was not in [`takes_a_while`], so a download ran on the loop
    /// that also reads. Past the outbound channel's capacity the loop blocks
    /// inside its own send, and from then until the last chunk it reads
    /// nothing at all — every other session on the machine goes unanswered.
    ///
    /// The file here is deliberately larger than the channel, because below
    /// that the chunks all fit and the loop never has to wait: the bug only
    /// shows once the queue is full, which is exactly the case a real download
    /// spends nearly all of its time in.
    #[tokio::test]
    async fn a_download_does_not_make_the_worker_deaf() {
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let session = recorded(&worker, "A big file").await;

        let workspace = home.path().join("workspace");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        worker
            .store
            .record_workspace(&session, workspace.to_str().unwrap(), session.as_str())
            .await
            .unwrap();

        let big = vec![b'x'; CHUNK * (OUTBOUND + 600)];
        tokio::fs::write(workspace.join("big.bin"), &big)
            .await
            .unwrap();

        let mut served = serve_over_duplex_at(worker.clone(), std::time::Duration::from_millis(2));
        served.send(ToWorker::ReadFile {
            req: "r1".into(),
            session_id: session.clone(),
            path: "big.bin".into(),
        });

        // Only once it is demonstrably streaming is the question worth asking.
        assert!(
            served
                .wait_for(std::time::Duration::from_secs(30), |f| matches!(
                    f,
                    ToServer::FileChunk { .. }
                ))
                .await
                .is_some(),
            "the download should be under way"
        );

        let asked = std::time::Instant::now();
        served.send(ToWorker::Ping);
        let answered = served
            .wait_for(std::time::Duration::from_secs(30), |f| {
                matches!(f, ToServer::Pong)
            })
            .await;
        let took = asked.elapsed();

        assert!(answered.is_some(), "the heartbeat must be answered at all");
        assert!(
            took < std::time::Duration::from_millis(500),
            "a frame arriving mid-download must be read and answered promptly, not \
             after the download drains — took {took:?}"
        );
    }

    /// What is being asked for must not queue behind what is being streamed.
    ///
    /// One pipe carries every preview, terminal and download on this machine,
    /// strictly ordered — so a `Pong` sent behind a page load arrived a page
    /// load later, and the control plane, which gives a host fifty seconds to
    /// say something, could not tell a busy worker from a dead one. The same
    /// queue sat in front of every summary and every commit, which is what
    /// made shipping work impossible while a preview was open.
    #[tokio::test]
    async fn control_frames_overtake_a_saturated_bulk_lane() {
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let session = recorded(&worker, "A busy one").await;

        let workspace = home.path().join("workspace");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        worker
            .store
            .record_workspace(&session, workspace.to_str().unwrap(), session.as_str())
            .await
            .unwrap();

        // Bulk, and plenty of it: a download is the same shape as a preview
        // page as far as the pipe is concerned.
        let big = vec![b'x'; CHUNK * 400];
        tokio::fs::write(workspace.join("big.bin"), &big)
            .await
            .unwrap();

        // A link slower than the worker, so a queue actually forms — which is
        // the condition being tested, and the one an in-memory pipe that
        // drains instantly can never produce.
        let mut served = serve_over_duplex_at(worker.clone(), std::time::Duration::from_millis(2));
        served.send(ToWorker::ReadFile {
            req: "r1".into(),
            session_id: session.clone(),
            path: "big.bin".into(),
        });

        // Wait until it is demonstrably streaming before asking anything.
        // Sleeping a fixed time instead would race the download's first frame
        // and end up measuring which task was scheduled first.
        assert!(
            served
                .wait_for(std::time::Duration::from_secs(20), |f| matches!(
                    f,
                    ToServer::FileChunk { .. }
                ))
                .await
                .is_some(),
            "the download should be under way"
        );
        // And then let it get well ahead.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        served.send(ToWorker::Ping);

        let mut chunks_first = 0usize;
        let answered = served
            .wait_for(std::time::Duration::from_secs(30), |f| {
                if matches!(f, ToServer::FileChunk { .. }) {
                    chunks_first += 1;
                }
                matches!(f, ToServer::Pong | ToServer::FileChunk { last: true, .. })
            })
            .await;

        assert!(
            matches!(answered, Some(ToServer::Pong)),
            "the heartbeat must arrive before the download ends"
        );
        assert!(
            chunks_first < 40,
            "it should have overtaken the queue, not waited most of it out — \
             {chunks_first} chunks went first"
        );
    }

    /// A pane that outlived its agent must not block the way back.
    ///
    /// `tmux has-session` is true for a healthy agent and just as true for the
    /// shell left behind when one exits, and `start` refused on that alone. So
    /// a session whose agent had gone — an account out of credit does it —
    /// could never be relaunched: every attempt was refused with "is already
    /// running" about a corpse, and marked the run failed again. Three of them
    /// sat like that, reading to their owner as crashed agents.
    #[tokio::test]
    async fn a_tmux_session_with_no_agent_in_it_is_not_mistaken_for_a_running_one() {
        let id = SessionId::new();
        let tmux = tmux::Tmux::for_session(id.as_str());

        // Nothing yet.
        assert_eq!(standing(&tmux, &id).await, Standing::Fresh);

        // A pane with no agent in it: a shell, exactly what tmux keeps when an
        // agent exits and nothing tears the session down.
        let dir = TempDir::new().unwrap();
        tmux.start(dir.path(), "sleep 30", &[]).await.unwrap();
        assert!(tmux.exists().await, "the fixture should be there");

        assert_eq!(
            standing(&tmux, &id).await,
            Standing::Abandoned,
            "a session with nothing listening is one to replace, not to refuse"
        );

        cleanup(&id).await;
        assert_eq!(standing(&tmux, &id).await, Standing::Fresh);
    }

    /// A checkout git cannot read is news, not silence.
    ///
    /// It used to be dropped from the answer with only a line in this worker's
    /// log — `summarising: fatal: not a git repository`. The control plane then
    /// had no row for it and filled one with zeros, and zero is exactly what a
    /// session with nothing left to commit looks like. So the one fact that
    /// would have explained an empty screen was the one thing never sent.
    #[tokio::test]
    async fn a_checkout_that_cannot_be_read_is_reported_not_dropped() {
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let session = recorded(&worker, "A broken worktree").await;

        let workspace = home.path().join("workspace");
        tokio::fs::create_dir_all(workspace.join("backend"))
            .await
            .unwrap();
        worker
            .store
            .record_workspace(&session, workspace.to_str().unwrap(), session.as_str())
            .await
            .unwrap();
        // A directory, and deliberately not a repository.
        worker
            .store
            .record_checkout(
                &session,
                0,
                "acme/backend",
                "https://example.invalid/acme/backend.git",
                "main",
                "agent/fix",
                "backend",
            )
            .await
            .unwrap();

        let summaries = worker.summarize(&session).await.unwrap();

        assert_eq!(summaries.len(), 1, "the checkout must still get a row");
        let trouble = summaries[0]
            .trouble
            .as_deref()
            .expect("a checkout that could not be read must say why");
        assert!(
            trouble.contains("not a git repository"),
            "it should carry what git actually said, got: {trouble}"
        );
    }

    /// Drive a worker over an in-memory pipe, the way the control plane does.
    async fn exchange(worker: &std::sync::Arc<Worker>, frames: Vec<ToWorker>) -> Vec<ToServer> {
        let mut input = Vec::new();
        for f in frames {
            input.extend_from_slice(&serde_json::to_vec(&f).unwrap());
            input.push(b'\n');
        }

        let mut output = Vec::new();
        worker.clone().serve(&input[..], &mut output).await.unwrap();

        String::from_utf8_lossy(&output)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// Kill whatever a test started, so a run never leaves agents behind.
    async fn cleanup(id: &SessionId) {
        let _ = tmux::Tmux::for_session(id.as_str()).kill().await;
    }

    fn hello() -> ToWorker {
        ToWorker::Hello {
            protocol: PROTOCOL_VERSION,
            client_version: "test".into(),
        }
    }

    /// A worker with a longer history than it can hold in flight.
    ///
    /// Replaying used to happen on the serve loop, so the send that filled the
    /// outbound channel blocked the only task that drains it. The worker went
    /// silent with the connection still open, the control plane recorded
    /// nothing, and every reconnect replayed the same events into the same
    /// deadlock.
    #[tokio::test]
    async fn a_history_longer_than_the_channel_still_replays() {
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());

        let session = SessionId::new();
        worker
            .store
            .create_session(
                &session,
                None,
                "A long one",
                "do a thing",
                None,
                None,
                "Shell",
                WorkspaceSize::Small,
            )
            .await
            .unwrap();

        let count = OUTBOUND + 100;
        for _ in 0..count {
            worker
                .store
                .append(
                    &session,
                    &EventKind::StepProgress {
                        step: ft_core::Step::Fetch,
                        detail: "counting objects".into(),
                    },
                )
                .await
                .unwrap();
        }

        let out = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            exchange(&worker, vec![hello(), ToWorker::Resume { since: 0 }]),
        )
        .await
        .expect("replaying must not wedge the worker");

        let replayed = out
            .iter()
            .filter(|f| matches!(f, ToServer::Event { .. }))
            .count();

        assert_eq!(replayed, count, "every event should have been sent");
    }

    async fn origin() -> (TempDir, String) {
        let dir = TempDir::new().unwrap();
        let p = dir.path();
        for args in [
            vec!["init", "--initial-branch=main", "."],
            vec!["config", "user.email", "t@firetower.dev"],
            vec!["config", "user.name", "T"],
        ] {
            tokio::process::Command::new("git")
                .args(&args)
                .current_dir(p)
                .output()
                .await
                .unwrap();
        }
        tokio::fs::write(p.join("README.md"), "# fixture\n")
            .await
            .unwrap();
        for args in [vec!["add", "."], vec!["commit", "-m", "first"]] {
            tokio::process::Command::new("git")
                .args(&args)
                .current_dir(p)
                .output()
                .await
                .unwrap();
        }
        let remote = p.to_str().unwrap().to_string();
        (dir, remote)
    }

    fn spec(remote: &str, id: &SessionId, setup: Option<&str>) -> ToWorker {
        ToWorker::CreateWorkspace(Box::new(CreateWorkspace {
            session_id: id.clone(),
            repos: vec![ft_proto::RepoSpec {
                remote: remote.to_string(),
                slug: "acme/backend".into(),
                base: "main".into(),
                branch: "agent/fix-retries".into(),
                path: "backend".into(),
                setup: setup.map(str::to_string),
                env_file: None,
                credential: None,
            }],
            prompt: "Fix retry handling for Stripe webhooks".into(),
            // A shell, not a real agent: these tests should not launch
            // anything that talks to a network or expects a subscription.
            agent: Agent::Shell,
            size: WorkspaceSize::Medium,
            share: ft_core::Share::Equal,
            workspace: id.as_str().to_string(),
            env: vec![],
            agent_home: vec![],
        }))
    }

    #[tokio::test]
    async fn the_handshake_comes_first() {
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let out = exchange(&worker, vec![hello(), ToWorker::Ping]).await;

        assert!(matches!(
            out[0],
            ToServer::Hello {
                protocol: PROTOCOL_VERSION,
                ..
            }
        ));
        assert!(matches!(out[1], ToServer::Pong));
    }

    #[tokio::test]
    async fn a_protocol_mismatch_refuses_loudly() {
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());

        let input = serde_json::to_vec(&ToWorker::Hello {
            protocol: 99,
            client_version: "future".into(),
        })
        .unwrap();

        let err = worker.serve(&input[..], Vec::new()).await.unwrap_err();
        assert!(format!("{err:#}").contains("protocol 99"), "{err:#}");
    }

    #[tokio::test]
    async fn building_a_workspace_narrates_every_step() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let id = SessionId::new();

        let out = exchange(&worker, vec![hello(), spec(&remote, &id, None)]).await;

        let labels: Vec<&str> = out
            .iter()
            .filter_map(|f| match f {
                ToServer::Event { kind, .. } => Some(kind.label()),
                _ => None,
            })
            .collect();

        // Every step says it has begun before it does the work, which is the
        // whole point: a fetch that takes minutes should be visible while it
        // takes them, not only once it is over.
        assert_eq!(
            labels,
            vec![
                "Session created",
                // The workspace comes first now: it is the directory the
                // checkouts go into, so it has to exist before any of them do.
                "Making the workspace",
                "Started the workspace",
                "Fetching the repository",
                "Fetched the repository",
                "Creating the worktree",
                "Added a worktree",
                "Starting the agent",
                "Opened tmux",
                "Launched the agent",
                "Status",
            ]
        );

        cleanup(&id).await;
    }

    /// The plan and the narration have to agree, or the checklist ticks off
    /// steps that never appear and waits forever on ones that did.
    #[tokio::test]
    async fn every_planned_step_is_both_started_and_finished() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let id = SessionId::new();

        let out = exchange(&worker, vec![hello(), spec(&remote, &id, None)]).await;

        let kinds: Vec<&EventKind> = out
            .iter()
            .filter_map(|f| match f {
                ToServer::Event { kind, .. } => Some(kind),
                _ => None,
            })
            .collect();

        for step in ft_core::Step::plan(true, false) {
            assert!(
                kinds
                    .iter()
                    .any(|k| matches!(k, EventKind::StepStarted { step: s } if *s == step)),
                "{step:?} never said it had started"
            );
            assert!(
                kinds
                    .iter()
                    .any(|k| ft_core::Step::completed_by(k) == Some(step)),
                "{step:?} never finished"
            );
        }

        cleanup(&id).await;
    }

    /// The bug that made every long session look frozen: while a workspace was
    /// being built, the worker answered nothing and heard nothing.
    ///
    /// A slow build here is a repository whose setup script sleeps. Everything
    /// the worker says during it — and its answer to a question asked in the
    /// middle — has to come out anyway.
    #[tokio::test]
    async fn a_slow_build_does_not_stop_the_worker_talking() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let id = SessionId::new();

        let mut build = spec(&remote, &id, None);
        if let ToWorker::CreateWorkspace(ref mut c) = build {
            c.repos[0].setup = Some("sleep 2".into());
        }

        // The Ping arrives while the build is still sleeping. Before this was
        // fixed its Pong waited for the build to finish; now it overtakes it.
        let out = exchange(&worker, vec![hello(), build, ToWorker::Ping]).await;

        let order: Vec<usize> = out
            .iter()
            .enumerate()
            .filter(|(_, f)| {
                matches!(f, ToServer::Pong)
                    || matches!(
                        f,
                        ToServer::Event {
                            kind: EventKind::AgentLaunched { .. },
                            ..
                        }
                    )
            })
            .map(|(i, _)| i)
            .collect();

        assert_eq!(order.len(), 2, "expected a Pong and a launch");
        assert!(
            order[0] < order[1],
            "the Pong should not have waited for the build"
        );

        cleanup(&id).await;
    }

    #[tokio::test]
    async fn a_bare_agent_gets_a_workspace_with_nothing_in_it() {
        // No repository: somewhere to work, no mirror, no worktree, no branch.
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let id = SessionId::new();

        let out = exchange(
            &worker,
            vec![
                hello(),
                ToWorker::CreateWorkspace(Box::new(CreateWorkspace {
                    session_id: id.clone(),
                    repos: vec![],
                    prompt: "poke around".into(),
                    agent: Agent::Shell,
                    size: WorkspaceSize::Medium,
                    share: ft_core::Share::Equal,
                    workspace: id.as_str().to_string(),
                    env: vec![],
                    agent_home: vec![],
                })),
            ],
        )
        .await;

        let labels: Vec<&str> = out
            .iter()
            .filter_map(|f| match f {
                ToServer::Event { kind, .. } => Some(kind.label()),
                _ => None,
            })
            .collect();

        assert!(
            !labels.contains(&"Fetched the repository") && !labels.contains(&"Added a worktree"),
            "nothing should be cloned: {labels:?}"
        );
        assert!(labels.contains(&"Launched the agent"), "{labels:?}");

        let path = worker.store().workspace_path(&id).await.unwrap().unwrap();
        assert!(std::path::Path::new(&path).exists(), "it still needs a cwd");
        assert!(
            worker.store().branch_of(&id).await.unwrap().is_none(),
            "there is no branch without a repository"
        );

        cleanup(&id).await;
    }

    /// A second agent, in a workspace the first one made.
    ///
    /// The point of the whole arrangement: one directory, two agents, each with
    /// its own session id — which is what gives each its own socket and its own
    /// tmux without anything being invented for it.
    #[tokio::test]
    async fn a_second_agent_joins_a_workspace_that_exists() {
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let first = SessionId::new();

        // A place, made the usual way.
        exchange(
            &worker,
            vec![
                hello(),
                ToWorker::CreateWorkspace(Box::new(CreateWorkspace {
                    session_id: first.clone(),
                    repos: vec![],
                    prompt: String::new(),
                    agent: Agent::Shell,
                    size: WorkspaceSize::Medium,
                    share: ft_core::Share::Equal,
                    workspace: first.as_str().to_string(),
                    env: vec![],
                    agent_home: vec![],
                })),
            ],
        )
        .await;

        let path = worker
            .store()
            .workspace_path(&first)
            .await
            .unwrap()
            .unwrap();

        // And another agent in it.
        let second = SessionId::new();
        let out = exchange(
            &worker,
            vec![
                hello(),
                ToWorker::RunAction {
                    req: "acknowledged-launch".into(),
                    session_id: second.clone(),
                    credential: None,
                    action: ft_proto::Action::StartAgent {
                        spec: Box::new(ft_proto::StartAgent {
                            session_id: second.clone(),
                            workspace: first.as_str().to_string(),
                            prompt: String::new(),
                            agent: Agent::Shell,
                            title: "Shell".into(),
                            repo: None,
                            branch: None,
                            base: None,
                            size: WorkspaceSize::Medium,
                            share: ft_core::Share::Equal,
                            env: vec![],
                            agent_home: vec![],
                        }),
                    },
                },
            ],
        )
        .await;
        assert!(out.iter().any(|frame| matches!(frame,ToServer::ActionDone { req, result } if req=="acknowledged-launch" && result.is_ok())), "launch must acknowledge readiness");

        let labels: Vec<&str> = out
            .iter()
            .filter_map(|f| match f {
                ToServer::Event { kind, .. } => Some(kind.label()),
                _ => None,
            })
            .collect();

        assert!(labels.contains(&"Launched the agent"), "{labels:?}");
        assert!(
            !labels.contains(&"Fetched the repository") && !labels.contains(&"Added a worktree"),
            "a second agent builds nothing: {labels:?}"
        );

        // The same directory, under its own id.
        assert_eq!(
            worker
                .store()
                .workspace_path(&second)
                .await
                .unwrap()
                .unwrap(),
            path,
            "both agents work in one place"
        );

        cleanup(&first).await;
        cleanup(&second).await;
    }

    #[tokio::test]
    async fn ending_one_agent_leaves_the_workspace_for_the_others() {
        // Closing an agent's tab ends that agent. If that also reclaimed the
        // worktree, the sibling still working in it would have the directory
        // deleted underneath it — its files, its git metadata, its socket.
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let first = SessionId::new();

        exchange(
            &worker,
            vec![
                hello(),
                ToWorker::CreateWorkspace(Box::new(CreateWorkspace {
                    session_id: first.clone(),
                    repos: vec![],
                    prompt: String::new(),
                    agent: Agent::Shell,
                    size: WorkspaceSize::Medium,
                    share: ft_core::Share::Equal,
                    workspace: first.as_str().to_string(),
                    env: vec![],
                    agent_home: vec![],
                })),
            ],
        )
        .await;

        let path = worker
            .store()
            .workspace_path(&first)
            .await
            .unwrap()
            .unwrap();

        let second = SessionId::new();
        exchange(
            &worker,
            vec![
                hello(),
                ToWorker::StartAgent(Box::new(ft_proto::StartAgent {
                    session_id: second.clone(),
                    workspace: first.as_str().to_string(),
                    prompt: String::new(),
                    agent: Agent::Shell,
                    title: "Shell".into(),
                    repo: None,
                    branch: None,
                    base: None,
                    size: WorkspaceSize::Medium,
                    share: ft_core::Share::Equal,
                    env: vec![],
                    agent_home: vec![],
                })),
            ],
        )
        .await;

        // End the second one, the way closing its tab does.
        exchange(
            &worker,
            vec![
                hello(),
                ToWorker::Destroy {
                    session_id: second.clone(),
                    force: false,
                },
            ],
        )
        .await;

        assert_eq!(
            worker.store().status_of(&second).await.unwrap(),
            Some(SessionStatus::Ended),
            "the agent that was asked to end should be gone"
        );
        assert!(
            !tmux::Tmux::for_session(second.as_str()).exists().await,
            "its process should be gone with it"
        );
        assert!(
            std::path::Path::new(&path).exists(),
            "the workspace belongs to the place, and another agent is still in it"
        );
        assert!(
            tmux::Tmux::for_session(first.as_str()).exists().await,
            "the agent nobody ended should still be running"
        );

        // And when the last one goes, the worktree is reclaimed.
        exchange(
            &worker,
            vec![
                hello(),
                ToWorker::Destroy {
                    session_id: first.clone(),
                    force: false,
                },
            ],
        )
        .await;

        assert!(
            !std::path::Path::new(&path).exists(),
            "the last agent out should reclaim the worktree, not leak it"
        );

        cleanup(&first).await;
        cleanup(&second).await;
    }

    #[tokio::test]
    async fn a_built_workspace_holds_its_checkouts() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let id = SessionId::new();

        exchange(&worker, vec![hello(), spec(&remote, &id, None)]).await;

        // The workspace holds the repository rather than being it, so a second
        // one can be added later without the first having to move.
        let path = worker.store().workspace_path(&id).await.unwrap().unwrap();
        let workspace = std::path::Path::new(&path);
        assert!(
            workspace.join("backend").join("README.md").exists(),
            "the checkout should be in its own directory"
        );
        assert!(
            workspace.join("AGENTS.md").exists(),
            "the agent starts here and needs to be told what is where"
        );
        assert!(
            !workspace.join("backend").join(agentd::DIR).exists(),
            "Firetower's own files belong beside the checkout, not inside it"
        );
        assert_eq!(
            worker.store().status_of(&id).await.unwrap(),
            Some(SessionStatus::Working)
        );
        assert!(
            tmux::Tmux::for_session(id.as_str()).exists().await,
            "the agent should be running under tmux"
        );

        cleanup(&id).await;
    }

    #[tokio::test]
    async fn destroying_a_session_takes_the_agent_with_it() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let id = SessionId::new();

        exchange(&worker, vec![hello(), spec(&remote, &id, None)]).await;
        assert!(tmux::Tmux::for_session(id.as_str()).exists().await);
        let path = worker.store().workspace_path(&id).await.unwrap().unwrap();
        assert!(std::path::Path::new(&path).exists());

        exchange(
            &worker,
            vec![
                hello(),
                ToWorker::Destroy {
                    session_id: id.clone(),
                    force: false,
                },
            ],
        )
        .await;

        assert!(
            !tmux::Tmux::for_session(id.as_str()).exists().await,
            "ending a session should leave nothing running"
        );
        assert!(
            !std::path::Path::new(&path).exists(),
            "ending a session should reclaim the worktree, not leak it"
        );
        assert_eq!(
            worker.store().status_of(&id).await.unwrap(),
            Some(SessionStatus::Ended)
        );
    }

    #[tokio::test]
    async fn a_failing_setup_script_fails_the_session_and_says_where() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let id = SessionId::new();

        let out = exchange(&worker, vec![hello(), spec(&remote, &id, Some("exit 1"))]).await;

        let failed = out.iter().any(|f| {
            matches!(
                f,
                ToServer::Event {
                    kind: EventKind::Failed { .. },
                    ..
                }
            )
        });
        assert!(failed, "the failure should be an event, not a silent stop");
        assert_eq!(
            worker.store().status_of(&id).await.unwrap(),
            Some(SessionStatus::Failed)
        );
    }

    #[tokio::test]
    async fn a_setup_script_runs_inside_its_own_checkout() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let id = SessionId::new();

        exchange(
            &worker,
            vec![
                hello(),
                spec(&remote, &id, Some("echo ready > setup-ran.txt")),
            ],
        )
        .await;

        // In the repository it belongs to, not in the workspace above it: two
        // repositories have two setup scripts, and each wants to run where its
        // own package file is.
        let path = worker.store().workspace_path(&id).await.unwrap().unwrap();
        let workspace = std::path::Path::new(&path);
        assert!(workspace.join("backend").join("setup-ran.txt").exists());
        assert!(
            !workspace.join("setup-ran.txt").exists(),
            "it should not run in the directory that merely holds the checkout"
        );

        cleanup(&id).await;
    }

    #[tokio::test]
    async fn resume_replays_what_a_sleeping_laptop_missed() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let id = SessionId::new();

        // the laptop was awake for this
        exchange(&worker, vec![hello(), spec(&remote, &id, None)]).await;
        cleanup(&id).await;
        let head = worker.store().head().await.unwrap();
        assert!(head > 0);

        // it slept, then came back and asked from the beginning
        let replayed = exchange(&worker, vec![hello(), ToWorker::Resume { since: 0 }]).await;
        let events = replayed
            .iter()
            .filter(|f| matches!(f, ToServer::Event { .. }))
            .count();
        assert_eq!(events as i64, head, "everything recorded should replay");

        // and from where it left off, there is nothing new
        let nothing = exchange(&worker, vec![hello(), ToWorker::Resume { since: head }]).await;
        assert!(!nothing.iter().any(|f| matches!(f, ToServer::Event { .. })));
    }

    #[tokio::test]
    async fn a_malformed_frame_does_not_kill_a_worker_with_live_sessions() {
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());

        let mut input = serde_json::to_vec(&hello()).unwrap();
        input.push(b'\n');
        input.extend_from_slice(b"{ not a frame }\n");
        input.extend_from_slice(&serde_json::to_vec(&ToWorker::Ping).unwrap());
        input.push(b'\n');

        let mut output = Vec::new();
        worker.clone().serve(&input[..], &mut output).await.unwrap();

        assert!(
            String::from_utf8_lossy(&output).contains("Pong"),
            "the frame after the bad one should still be served"
        );
    }
}

#[cfg(test)]
mod account_home_tests {
    use super::*;
    #[tokio::test]
    async fn accounts_in_one_workspace_have_independent_credentials_and_keep_legacy_threads() {
        let dir = tempfile::tempdir().unwrap();
        let old = agentd::dir_for(dir.path()).join("agent-home");
        tokio::fs::create_dir_all(old.join("sessions"))
            .await
            .unwrap();
        tokio::fs::write(old.join("auth.json"), "old-token")
            .await
            .unwrap();
        tokio::fs::write(old.join("sessions/thread.jsonl"), "history")
            .await
            .unwrap();
        let a = SessionId::new();
        let b = SessionId::new();
        let mut env_a = vec![];
        let mut env_b = vec![];
        prepare_agent_home(
            dir.path(),
            &a,
            ft_core::Agent::Codex,
            &[("auth.json".into(), "token-a".into())],
            &mut env_a,
        )
        .await
        .unwrap();
        prepare_agent_home(
            dir.path(),
            &b,
            ft_core::Agent::Codex,
            &[("auth.json".into(), "token-b".into())],
            &mut env_b,
        )
        .await
        .unwrap();
        let home_a = std::path::Path::new(&env_a[0].1);
        let home_b = std::path::Path::new(&env_b[0].1);
        assert_ne!(home_a, home_b);
        assert_eq!(
            tokio::fs::read_to_string(home_a.join("auth.json"))
                .await
                .unwrap(),
            "token-a"
        );
        assert_eq!(
            tokio::fs::read_to_string(home_b.join("auth.json"))
                .await
                .unwrap(),
            "token-b"
        );
        assert_eq!(
            tokio::fs::read_to_string(home_a.join("sessions/thread.jsonl"))
                .await
                .unwrap(),
            "history"
        );
        assert_eq!(
            tokio::fs::read_to_string(old.join("auth.json"))
                .await
                .unwrap(),
            "old-token"
        );
    }
}

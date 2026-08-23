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

/// How much of a file goes in one frame. Small enough that terminal output for
/// other sessions on this machine gets a turn between the pieces.
const CHUNK: usize = 256 * 1024;

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
pub mod entry;
pub mod first_run;
pub mod git;
pub mod hooks;
pub mod store;
pub mod structured;
pub mod tmux;

use git::GitRoot;
use store::Store;
use tmux::Tmux;

/// Everything a worker needs to do its job on one machine.
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
}

/// How many frames may be queued for the control plane at once.
///
/// Anything that can produce more than this in one go has to run off the serve
/// loop — see [`takes_a_while`].
const OUTBOUND: usize = 1024;

impl Worker {
    /// Open (or create) the worker's state under `root`.
    pub async fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        let store = Store::open(&root.join("worker.db")).await?;
        let latest = store.latest_seq().await.unwrap_or(0);

        Ok(Self {
            store,
            git: GitRoot::new(&root),
            attached: Mutex::new(HashMap::new()),
            watching: Mutex::new(HashMap::new()),
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

        outbound
            .write(&ToServer::Hello {
                protocol: PROTOCOL_VERSION,
                worker_version: env!("CARGO_PKG_VERSION").to_string(),
                arch: std::env::consts::ARCH.to_string(),
                cpus: num_cpus(),
                memory_mb: 0,
            })
            .await?;

        // Everything the worker says goes through here. A terminal streams
        // output while we're still waiting on the next command, which a single
        // read-then-write loop can't express.
        let (out, mut pending) = mpsc::channel::<ToServer>(OUTBOUND);

        // Work that is happening off this loop. Held so that a disconnect can
        // wait for it rather than dropping a half-built workspace on the floor.
        let mut running = tokio::task::JoinSet::new();

        loop {
            tokio::select! {
                // Bias towards draining output: a burst of terminal bytes
                // should reach the viewer before we go looking for more work.
                biased;

                Some(frame) = pending.recv() => {
                    outbound.write(&frame).await?;
                }

                // What the agent said about itself, through a hook, since we
                // last looked.
                _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {
                    if let Err(e) = self.forward_new_events(&out).await {
                        tracing::debug!("forwarding hook events: {e:#}");
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
                            while !running.is_empty() {
                                tokio::select! {
                                    Some(frame) = pending.recv() => outbound.write(&frame).await?,
                                    _ = running.join_next() => {}
                                }
                            }
                            while let Ok(frame) = pending.try_recv() {
                                outbound.write(&frame).await?;
                            }
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
    }

    /// Returns `false` when the worker should stop serving.
    async fn handle(&self, frame: ToWorker, out: &mpsc::Sender<ToServer>) -> Result<bool> {
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
                let agents = agents::probe().await;
                out.send(ToServer::AgentsProbed { req, agents }).await?;
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
                // Everything goes: the agent, its terminal, and the worktree.
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

                // The worktree is registered against its mirror, so removing it
                // means finding the mirror the session was cut from.
                if let Some(slug) = self.store.repo_of(&session_id).await? {
                    let mirror = self.git.mirror_path(&slug);
                    // Named by whoever started it, so the directory is whatever
                    // the path we recorded ends with.
                    let name = self
                        .store
                        .workspace_path(&session_id)
                        .await?
                        .and_then(|p| {
                            std::path::Path::new(&p)
                                .file_name()
                                .map(|n| n.to_string_lossy().to_string())
                        })
                        .unwrap_or_else(|| session_id.to_string());

                    if let Err(e) = self.git.remove_worktree(&mirror, &name).await {
                        // Worth saying out loud: a worktree left behind is disk
                        // that never comes back on its own.
                        tracing::error!(session = %session_id, "removing the worktree: {e:#}");
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
                let key = session_id.to_string();
                let mut watching = self.watching.lock().await;
                // Already forwarding. A second watcher would double every line,
                // and the one that exists is already at or ahead of this
                // cursor.
                let out = out.clone();
                let id = session_id.clone();
                watching.entry(key).or_insert_with(move || {
                    tokio::spawn(async move {
                        if let Err(e) = structured::watch(id.clone(), since_line, out.clone()).await
                        {
                            // Ordinary rather than exceptional: a session
                            // running in a terminal has no agent to watch, and
                            // the control plane asks about all of them rather
                            // than remembering which is which.
                            tracing::debug!(session = %id, "no conversation to follow: {e:#}");
                            let _ = out.send(ToServer::AgentClosed { session_id: id }).await;
                        }
                    })
                });
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
                Ok(summary) => out.send(ToServer::Summarized { req, summary }).await?,
                Err(e) => {
                    tracing::warn!(session = %session_id, "summarising: {e:#}");
                    out.send(ToServer::ActionDone {
                        req,
                        result: Err(format!("{e:#}")),
                    })
                    .await?;
                }
            },

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
        out: &mpsc::Sender<ToServer>,
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

    /// Build a workspace, narrating each step as it completes.
    ///
    /// The narration is the point: it's what the interface shows while you wait,
    /// and what tells you *where* it broke when it breaks.
    async fn create_workspace(
        &self,
        spec: CreateWorkspace,
        out: &mpsc::Sender<ToServer>,
    ) -> Result<()> {
        let id = spec.session_id.clone();
        let title = ft_core::session::title_from(&spec.prompt);

        self.store
            .create_session(
                &id,
                spec.repo.as_ref().map(|r| r.slug.as_str()),
                &title,
                &spec.prompt,
                spec.repo.as_ref().map(|r| r.branch.as_str()),
                spec.repo.as_ref().map(|r| r.base.as_str()),
                &format!("{:?}", spec.agent),
                spec.size,
            )
            .await?;

        self.emit(
            &id,
            EventKind::SessionCreated {
                repo: spec
                    .repo
                    .as_ref()
                    .map(|r| r.slug.clone())
                    .unwrap_or_else(|| "no repository".into()),
                prompt: spec.prompt.clone(),
            },
            out,
        )
        .await?;

        // A bare agent gets a directory and nothing else: no mirror, no
        // worktree, no branch. It is somewhere to work rather than a checkout.
        let path = match &spec.repo {
            None => {
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
                path
            }
            Some(repo) => {
                self.emit(&id, EventKind::StepStarted { step: Step::Fetch }, out)
                    .await?;
                let started = std::time::Instant::now();

                // git's progress goes into a slot rather than down a channel:
                // the callback is synchronous and emitting is not, so the loop
                // below does the emitting, on this task, where `out` lives.
                let latest = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
                let report = {
                    let latest = latest.clone();
                    move |line: String| *latest.lock().unwrap() = line
                };

                let mirroring = self.git.ensure_mirror(
                    &repo.remote,
                    &repo.slug,
                    spec.credential.clone(),
                    Some(&report),
                );
                tokio::pin!(mirroring);

                // Often enough to look alive, rarely enough that a fetch isn't
                // also a way to fill the event log.
                let mut said = String::new();
                let (mirror, cloned) = loop {
                    tokio::select! {
                        done = &mut mirroring => break done.context("preparing the repository mirror")?,
                        _ = tokio::time::sleep(std::time::Duration::from_millis(900)) => {
                            let line = latest.lock().unwrap().clone();
                            if !line.is_empty() && line != said {
                                said = line.clone();
                                self.emit(
                                    &id,
                                    EventKind::StepProgress { step: Step::Fetch, detail: line },
                                    out,
                                )
                                .await?;
                            }
                        }
                    }
                };

                self.emit(
                    &id,
                    EventKind::RepoFetched {
                        detail: if cloned {
                            format!("cloned · {:.1}s", started.elapsed().as_secs_f32())
                        } else {
                            format!("from the mirror · {:.1}s", started.elapsed().as_secs_f32())
                        },
                    },
                    out,
                )
                .await?;

                self.emit(
                    &id,
                    EventKind::StepStarted {
                        step: Step::Worktree,
                    },
                    out,
                )
                .await?;
                let (path, branch) = self
                    .git
                    .add_worktree(&mirror, &repo.branch, &repo.base, &spec.workspace)
                    .await
                    .context("cutting the worktree")?;

                // Two sessions from one prompt want the same name, so git may have
                // numbered it. What is on disk is the authority — pushing the name we
                // asked for would push somebody else's branch.
                self.store.set_branch(&id, &branch).await?;

                self.emit(&id, EventKind::WorktreeAdded { branch }, out)
                    .await?;
                path
            }
        };

        let tmux = Tmux::for_session(id.as_str());
        self.store
            .record_workspace(&id, path.to_str().unwrap_or_default(), tmux.name())
            .await?;

        let (cpus, mem) = spec.size.resources();
        self.emit(
            &id,
            EventKind::WorkspaceStarted {
                detail: format!("{cpus} CPU / {} GB", mem / 1024),
            },
            out,
        )
        .await?;

        // Which session this is, and where this worker keeps its state.
        // Inherited by the agent, by the setup script, and by everything either
        // of them runs — a script that wants to know which session it is
        // running inside has nowhere else to look.
        let mut env = spec.env.clone();
        env.push((ft_core::SESSION_ENV.to_string(), id.to_string()));
        env.push((
            ft_core::WORKER_ROOT_ENV.to_string(),
            self.root.display().to_string(),
        ));

        // Before setup, because a setup script is the first thing that wants to
        // read it — `npm run db:migrate` against a URL that is only in a file.
        if let Some(file) = &spec.env_file {
            Self::write_env_file(&path, file)
                .await
                .with_context(|| format!("writing {}", file.path))?;
        }

        if let Some(setup) = spec.setup.as_deref().filter(|s| !s.trim().is_empty()) {
            self.emit(&id, EventKind::StepStarted { step: Step::Setup }, out)
                .await?;
            let started = std::time::Instant::now();
            let output = tokio::process::Command::new("sh")
                .arg("-lc")
                .arg(setup)
                .current_dir(&path)
                // The same environment the agent gets. A setup script that
                // installs dependencies and migrates a database needs the
                // repository's variables as much as the agent does, and until
                // now it ran with none of them.
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
                &id,
                EventKind::SetupFinished {
                    detail: format!("{setup} · {:.1}s", started.elapsed().as_secs_f32()),
                },
                out,
            )
            .await?;
        }

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

        // Take out anything a previous version installed. The agent reports its
        // own lifecycle now, so a hook doing the same job is a second writer of
        // one field, and one left behind keeps firing for sessions that have
        // long moved on.
        if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) {
            if let Err(e) = hooks::remove(&home, spec.agent).await {
                tracing::warn!("could not remove {} hooks: {e:#}", spec.agent.label());
            }
        }

        self.emit(&id, EventKind::StepStarted { step: Step::Launch }, out)
            .await?;

        // Whether an agent can be driven at all is the control plane's
        // question, asked before a session is created — a worker does what it
        // is told. What it decides here is only how: a supervisor holding the
        // agent's pipes, or the agent itself in a pane.
        let structured = spec.agent.speaks_a_protocol();

        // Either way it runs under tmux, so it outlives this worker, this
        // connection, and the laptop that started it. For a structured session
        // tmux supervises the supervisor, which changes nothing about that: the
        // process tree still has tmux at the top.
        let command = if structured {
            let exe = std::env::current_exe().context("finding this worker's own path")?;
            structured::tmux_command(&exe, &id, &path, spec.agent)
        } else {
            spec.agent.launch(&spec.prompt)
        };
        tmux.start(&path, &command, &env)
            .await
            .with_context(|| format!("starting {}", spec.agent.label()))?;

        self.emit(
            &id,
            EventKind::TmuxOpened {
                name: tmux.name().to_string(),
            },
            out,
        )
        .await?;
        self.emit(&id, EventKind::AgentLaunched { agent: spec.agent }, out)
            .await?;

        // An interactive agent was handed the prompt on its command line. This
        // one reads messages, so the first one has to be sent — after waiting
        // for it to be listening, because a turn written into a socket nobody
        // has bound yet is simply lost.
        if structured {
            structured::wait_until_listening(&id)
                .await
                .context("waiting for the agent to start")?;
            if !spec.prompt.trim().is_empty() {
                structured::tell(
                    &id,
                    &agentd::ToAgent::Send {
                        message: ft_core::turn::user_message(&spec.prompt),
                    },
                )
                .await
                .context("sending the first turn")?;
            }

            // Start forwarding now rather than when somebody opens the session.
            // What the agent says is how the control plane learns that it
            // finished, or stopped to ask something — and a session nobody is
            // watching is exactly the one that most needs to be able to say so.
            let watcher = out.clone();
            let watched = id.clone();
            self.watching.lock().await.insert(
                id.to_string(),
                tokio::spawn(async move {
                    if let Err(e) = structured::watch(watched.clone(), 0, watcher).await {
                        tracing::warn!(session = %watched, "following the agent: {e:#}");
                    }
                }),
            );
        }

        self.store.set_status(&id, SessionStatus::Working).await?;
        self.emit(
            &id,
            EventKind::StatusChanged {
                status: SessionStatus::Working,
                note: None,
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

    /// Do something with the work a session produced.
    async fn run_action(
        &self,
        session_id: &SessionId,
        action: ft_proto::Action,
        credential: Option<ft_proto::Credential>,
        out: &mpsc::Sender<ToServer>,
    ) -> Result<String> {
        // Looked up per action rather than up front: stopping an agent has
        // nothing to do with a branch, and a bare agent has none at all.
        let branch = || async {
            self.store
                .branch_of(session_id)
                .await?
                .context("this session has no branch")
        };

        match action {
            ft_proto::Action::Stop => {
                // The workspace and the branch stay; only the agent goes. What
                // it produced is still there to look at, commit, or push.
                self.attached.lock().await.remove(session_id.as_str());
                Tmux::for_session(session_id.as_str()).kill().await?;

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

            ft_proto::Action::Commit { message } => {
                let dest = self.workspace_of(session_id).await?;
                self.git.commit(&dest, &message).await
            }

            ft_proto::Action::Push => {
                let dest = self.workspace_of(session_id).await?;
                self.git.push(&dest, &branch().await?, credential).await
            }

            ft_proto::Action::Diff => {
                let dest = self.workspace_of(session_id).await?;
                let base = self
                    .store
                    .refs_of(session_id)
                    .await?
                    .map(|(_, base)| base)
                    .unwrap_or_else(|| "HEAD".to_string());
                self.git.diff(&dest, &base).await
            }
        }
    }

    async fn summarize(&self, session_id: &SessionId) -> Result<ft_core::WorkSummary> {
        let (branch, base) = self
            .store
            .refs_of(session_id)
            .await?
            .context("this session has no branch")?;
        let dest = self.workspace_of(session_id).await?;
        self.git.summary(&dest, &branch, &base).await
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
        out: &mpsc::Sender<ToServer>,
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
    async fn emit(
        &self,
        session_id: &SessionId,
        kind: EventKind,
        out: &mpsc::Sender<ToServer>,
    ) -> Result<()> {
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
    async fn forward_new_events(&self, out: &mpsc::Sender<ToServer>) -> Result<()> {
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
            | ToWorker::Destroy { .. }
            | ToWorker::Stop { .. }
            | ToWorker::RunAction { .. }
            | ToWorker::Summarize { .. }
            | ToWorker::ProbeRemote { .. }
            | ToWorker::ProbeAgents { .. }
            // Not because replaying is slow, but because it is unbounded: a
            // worker with a long history sends more events than the outbound
            // channel holds. Handled on the loop, the send that fills the
            // channel blocks the same loop that drains it, and the worker goes
            // silent for good with the connection still open.
            | ToWorker::Resume { .. }
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

#[cfg(test)]
mod tests {
    use super::*;
    use ft_core::{Agent, WorkspaceSize};
    use tempfile::TempDir;

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
            repo: Some(ft_proto::RepoSpec {
                remote: remote.to_string(),
                slug: "acme/backend".into(),
                base: "main".into(),
                branch: "agent/fix-retries".into(),
            }),
            prompt: "Fix retry handling for Stripe webhooks".into(),
            // A shell, not a real agent: these tests should not launch
            // anything that talks to a network or expects a subscription.
            agent: Agent::Shell,
            size: WorkspaceSize::Medium,
            setup: setup.map(str::to_string),
            workspace: id.as_str().to_string(),
            env: vec![],
            env_file: None,
            credential: None,
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
                "Fetching the repository",
                "Fetched the repository",
                "Creating the worktree",
                "Added a worktree",
                "Started the workspace",
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
            c.setup = Some("sleep 2".into());
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
                    repo: None,
                    prompt: "poke around".into(),
                    agent: Agent::Shell,
                    size: WorkspaceSize::Medium,
                    setup: None,
                    workspace: id.as_str().to_string(),
                    env: vec![],
                    env_file: None,
                    credential: None,
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

    #[tokio::test]
    async fn a_built_workspace_is_a_real_checkout() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let worker = std::sync::Arc::new(Worker::open(home.path()).await.unwrap());
        let id = SessionId::new();

        exchange(&worker, vec![hello(), spec(&remote, &id, None)]).await;

        let path = worker.store().workspace_path(&id).await.unwrap().unwrap();
        assert!(std::path::Path::new(&path).join("README.md").exists());
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
    async fn a_setup_script_runs_inside_the_worktree() {
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

        let path = worker.store().workspace_path(&id).await.unwrap().unwrap();
        assert!(std::path::Path::new(&path).join("setup-ran.txt").exists());

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

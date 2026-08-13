//! The Firetower worker daemon.
//!
//! Reads frames from a stream, does the work, records what happened, and sends
//! it back. It has no idea whether the far end is a local pipe, an SSH tunnel or
//! a websocket — that indifference is the whole reason a laptop today and a
//! hosted control plane later can drive the identical binary.

use anyhow::{Context, Result};
use ft_core::{EventKind, SessionId, SessionStatus};
use ft_proto::{Codec, CodecError, CreateWorkspace, ToServer, ToWorker, PROTOCOL_VERSION};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, Mutex};

pub mod agents;
pub mod askpass;
pub mod attach;
pub mod git;
pub mod store;
pub mod tmux;

use git::GitRoot;
use store::Store;
use tmux::Tmux;

/// Everything a worker needs to do its job on one machine.
pub struct Worker {
    store: Store,
    git: GitRoot,
    /// One terminal attachment per session, however many people are watching.
    attached: Mutex<HashMap<String, attach::Attachment>>,
}

impl Worker {
    /// Open (or create) the worker's state under `root`.
    pub async fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        Ok(Self {
            store: Store::open(&root.join("worker.db")).await?,
            git: GitRoot::new(&root),
            attached: Mutex::new(HashMap::new()),
        })
    }

    /// Serve frames until the stream closes.
    ///
    /// The handshake happens first and refuses a version mismatch loudly, since
    /// a silently incompatible worker is far worse than one that won't start.
    pub async fn serve<R, W>(&self, reader: R, writer: W) -> Result<()>
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
        let (out, mut pending) = mpsc::channel::<ToServer>(1024);

        loop {
            tokio::select! {
                // Bias towards draining output: a burst of terminal bytes
                // should reach the viewer before we go looking for more work.
                biased;

                Some(frame) = pending.recv() => {
                    outbound.write(&frame).await?;
                }

                incoming = inbound.read::<ToWorker>() => {
                    let frame = match incoming {
                        Ok(f) => f,
                        Err(CodecError::Closed) => {
                            // Say the last of what we know before going quiet.
                            while let Ok(frame) = pending.try_recv() {
                                outbound.write(&frame).await?;
                            }
                            tracing::info!("control plane disconnected; sessions keep running");
                            return Ok(());
                        }
                        Err(CodecError::Malformed(e)) => {
                            // One bad frame shouldn't take down a worker that
                            // has live sessions on it. Say so and carry on.
                            tracing::warn!("ignoring malformed frame: {e}");
                            continue;
                        }
                        Err(e) => return Err(e.into()),
                    };

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
                        },
                        out,
                    )
                    .await?;
                }
            }

            ToWorker::Destroy { session_id, .. } => {
                // Everything goes: the agent, its terminal, and the worktree.
                self.attached.lock().await.remove(session_id.as_str());
                // Whatever was worth keeping should already have been pushed.
                Tmux::for_session(session_id.as_str()).kill().await?;

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
                    },
                    out,
                )
                .await?;
            }

            ToWorker::PtyOpen {
                session_id,
                cols,
                rows,
            } => {
                if let Err(e) = self.open_terminal(&session_id, cols, rows, out).await {
                    tracing::warn!(session = %session_id, "attaching: {e:#}");
                    out.send(ToServer::Error {
                        session_id: Some(session_id.clone()),
                        code: "TerminalUnavailable".into(),
                        message: format!("{e:#}"),
                    })
                    .await?;
                    out.send(ToServer::PtyClosed { session_id }).await?;
                }
            }

            ToWorker::PtyInput { session_id, data } => {
                // Typed characters, verbatim — including the ones that mean
                // "stop", which is half the reason a terminal is the interface.
                if let Some(bytes) = ft_proto::decode(&data) {
                    if let Some(a) = self.attached.lock().await.get(session_id.as_str()) {
                        if let Err(e) = a.write(&bytes) {
                            tracing::warn!(session = %session_id, "sending input: {e:#}");
                        }
                    }
                }
            }

            ToWorker::PtyResize {
                session_id,
                cols,
                rows,
            } => {
                if let Some(a) = self.attached.lock().await.get(session_id.as_str()) {
                    if let Err(e) = a.resize(cols, rows) {
                        tracing::warn!(session = %session_id, "resizing: {e:#}");
                    }
                }
            }

            ToWorker::PtyClose { session_id } => {
                // Dropping the attachment detaches. The agent is tmux's child,
                // so nobody watching it is what it needs to keep working.
                self.attached.lock().await.remove(session_id.as_str());
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

            ToWorker::Summarize { req, session_id } => {
                match self.summarize(&session_id).await {
                    Ok(summary) => out.send(ToServer::Summarized { req, summary }).await?,
                    Err(e) => {
                        tracing::warn!(session = %session_id, "summarising: {e:#}");
                        out.send(ToServer::ActionDone {
                            req,
                            result: Err(format!("{e:#}")),
                        })
                        .await?;
                    }
                }
            }

            ToWorker::Reply { session_id, .. } | ToWorker::Stop { session_id } => {
                tracing::debug!("superseded by RunAction ({session_id})");
            }
        }
        Ok(true)
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
                &spec.repo_slug,
                &title,
                &spec.prompt,
                &spec.branch,
                &spec.base,
                &format!("{:?}", spec.agent),
                spec.size,
            )
            .await?;

        self.emit(
            &id,
            EventKind::SessionCreated {
                repo: spec.repo_slug.clone(),
                prompt: spec.prompt.clone(),
            },
            out,
        )
        .await?;

        let started = std::time::Instant::now();
        let (mirror, cloned) = self
            .git
            .ensure_mirror(&spec.remote, &spec.repo_slug, spec.credential.clone())
            .await
            .context("preparing the repository mirror")?;

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

        let (path, branch) = self
            .git
            .add_worktree(&mirror, &spec.branch, &spec.base, &spec.workspace)
            .await
            .context("cutting the worktree")?;

        // Two sessions from one prompt want the same name, so git may have
        // numbered it. What is on disk is the authority — pushing the name we
        // asked for would push somebody else's branch.
        self.store.set_branch(&id, &branch).await?;

        self.emit(&id, EventKind::WorktreeAdded { branch }, out)
            .await?;

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

        if let Some(setup) = spec.setup.as_deref().filter(|s| !s.trim().is_empty()) {
            let started = std::time::Instant::now();
            let output = tokio::process::Command::new("sh")
                .arg("-lc")
                .arg(setup)
                .current_dir(&path)
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

        // The agent runs under tmux so it outlives this worker, this
        // connection, and the laptop that started it.
        tmux.start(&path, &spec.agent.launch(&spec.prompt), &spec.env)
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

        self.store.set_status(&id, SessionStatus::Working).await?;
        self.emit(
            &id,
            EventKind::StatusChanged {
                status: SessionStatus::Working,
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
        let branch = self
            .store
            .branch_of(session_id)
            .await?
            .context("this session has no branch")?;

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
                self.git.push(&dest, &branch, credential).await
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
        cols: u16,
        rows: u16,
        out: &mpsc::Sender<ToServer>,
    ) -> Result<()> {
        let tmux = Tmux::for_session(session_id.as_str());
        if !tmux.exists().await {
            anyhow::bail!("nothing is running for this session");
        }

        // Reuse a live attachment rather than replacing it. Two viewers share
        // one, and tearing the old one down would send its dying client's
        // "[lost tty]" to everyone still watching — which is what a second tab,
        // or a development double-mount, would do on every open.
        {
            let attached = self.attached.lock().await;
            if let Some(existing) = attached.get(session_id.as_str()) {
                if existing.is_alive() {
                    // The last repaint went to whoever was watching then, so
                    // ask for another one on behalf of whoever just arrived.
                    let _ = existing.repaint(cols.max(20), rows.max(5));
                    return Ok(());
                }
            }
        }
        self.attached.lock().await.remove(session_id.as_str());

        let attachment = attach::Attachment::open(
            tmux.name(),
            session_id.clone(),
            cols.max(20),
            rows.max(5),
            out.clone(),
        )?;

        self.attached
            .lock()
            .await
            .insert(session_id.to_string(), attachment);

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
        out.send(ToServer::Event {
            seq: stored.seq,
            session_id: stored.session_id,
            kind: stored.kind,
            at: stored.at,
        })
        .await
        .map_err(|_| anyhow::anyhow!("nobody is listening for events"))?;
        Ok(())
    }

    pub fn store(&self) -> &Store {
        &self.store
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

#[cfg(test)]
mod tests {
    use super::*;
    use ft_core::{Agent, WorkspaceSize};
    use tempfile::TempDir;

    /// Drive a worker over an in-memory pipe, the way the control plane does.
    async fn exchange(worker: &Worker, frames: Vec<ToWorker>) -> Vec<ToServer> {
        let mut input = Vec::new();
        for f in frames {
            input.extend_from_slice(&serde_json::to_vec(&f).unwrap());
            input.push(b'\n');
        }

        let mut output = Vec::new();
        worker.serve(&input[..], &mut output).await.unwrap();

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
            remote: remote.to_string(),
            repo_slug: "acme/backend".into(),
            base: "main".into(),
            branch: "agent/fix-retries".into(),
            prompt: "Fix retry handling for Stripe webhooks".into(),
            // A shell, not a real agent: these tests should not launch
            // anything that talks to a network or expects a subscription.
            agent: Agent::Shell,
            size: WorkspaceSize::Medium,
            setup: setup.map(str::to_string),
            workspace: id.as_str().to_string(),
            env: vec![],
            credential: None,
        }))
    }

    #[tokio::test]
    async fn the_handshake_comes_first() {
        let home = TempDir::new().unwrap();
        let worker = Worker::open(home.path()).await.unwrap();
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
        let worker = Worker::open(home.path()).await.unwrap();

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
        let worker = Worker::open(home.path()).await.unwrap();
        let id = SessionId::new();

        let out = exchange(&worker, vec![hello(), spec(&remote, &id, None)]).await;

        let labels: Vec<&str> = out
            .iter()
            .filter_map(|f| match f {
                ToServer::Event { kind, .. } => Some(kind.label()),
                _ => None,
            })
            .collect();

        assert_eq!(
            labels,
            vec![
                "Session created",
                "Fetched the repository",
                "Added a worktree",
                "Started the workspace",
                "Opened tmux",
                "Launched the agent",
                "Status",
            ]
        );

        cleanup(&id).await;
    }

    #[tokio::test]
    async fn a_built_workspace_is_a_real_checkout() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let worker = Worker::open(home.path()).await.unwrap();
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
        let worker = Worker::open(home.path()).await.unwrap();
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
        let worker = Worker::open(home.path()).await.unwrap();
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
        let worker = Worker::open(home.path()).await.unwrap();
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
        let worker = Worker::open(home.path()).await.unwrap();
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
        let worker = Worker::open(home.path()).await.unwrap();

        let mut input = serde_json::to_vec(&hello()).unwrap();
        input.push(b'\n');
        input.extend_from_slice(b"{ not a frame }\n");
        input.extend_from_slice(&serde_json::to_vec(&ToWorker::Ping).unwrap());
        input.push(b'\n');

        let mut output = Vec::new();
        worker.serve(&input[..], &mut output).await.unwrap();

        assert!(
            String::from_utf8_lossy(&output).contains("Pong"),
            "the frame after the bad one should still be served"
        );
    }
}

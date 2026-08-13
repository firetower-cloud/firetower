//! The Firetower worker daemon.
//!
//! Reads frames from a stream, does the work, records what happened, and sends
//! it back. It has no idea whether the far end is a local pipe, an SSH tunnel or
//! a websocket — that indifference is the whole reason a laptop today and a
//! hosted control plane later can drive the identical binary.

use anyhow::{Context, Result};
use ft_core::{EventKind, SessionId, SessionStatus};
use ft_proto::{Codec, CodecError, CreateWorkspace, ToServer, ToWorker, PROTOCOL_VERSION};
use std::path::PathBuf;
use tokio::io::{AsyncRead, AsyncWrite};

pub mod askpass;
pub mod git;
pub mod store;

use git::GitRoot;
use store::Store;

/// Everything a worker needs to do its job on one machine.
pub struct Worker {
    store: Store,
    git: GitRoot,
}

impl Worker {
    /// Open (or create) the worker's state under `root`.
    pub async fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        Ok(Self {
            store: Store::open(&root.join("worker.db")).await?,
            git: GitRoot::new(&root),
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
        let mut codec = Codec::new(reader, writer);

        match codec.read::<ToWorker>().await {
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

        codec
            .write(&ToServer::Hello {
                protocol: PROTOCOL_VERSION,
                worker_version: env!("CARGO_PKG_VERSION").to_string(),
                arch: std::env::consts::ARCH.to_string(),
                cpus: num_cpus(),
                memory_mb: 0,
            })
            .await?;

        loop {
            let frame = match codec.read::<ToWorker>().await {
                Ok(f) => f,
                Err(CodecError::Closed) => {
                    tracing::info!("control plane disconnected; sessions keep running");
                    return Ok(());
                }
                Err(CodecError::Malformed(e)) => {
                    // One bad frame shouldn't take down a worker that has live
                    // sessions on it. Say so and carry on.
                    tracing::warn!("ignoring malformed frame: {e}");
                    continue;
                }
                Err(e) => return Err(e.into()),
            };

            match self.handle(frame, &mut codec).await {
                Ok(true) => {}
                Ok(false) => return Ok(()),
                Err(e) => {
                    tracing::error!("{e:#}");
                    codec
                        .write(&ToServer::Error {
                            session_id: None,
                            code: "Internal".into(),
                            message: format!("{e:#}"),
                        })
                        .await?;
                }
            }
        }
    }

    /// Returns `false` when the worker should stop serving.
    async fn handle<R, W>(&self, frame: ToWorker, codec: &mut Codec<R, W>) -> Result<bool>
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        match frame {
            ToWorker::Ping => codec.write(&ToServer::Pong).await?,

            ToWorker::Hello { .. } => {
                tracing::warn!("a second Hello arrived; ignoring it");
            }

            // Everything that happened since the control plane last looked.
            // This is what makes closing the laptop safe.
            ToWorker::Resume { since } => {
                let missed = self.store.events_since(since).await?;
                tracing::info!("replaying {} events after {since}", missed.len());
                for e in missed {
                    codec
                        .write(&ToServer::Event {
                            seq: e.seq,
                            session_id: e.session_id,
                            kind: e.kind,
                            at: e.at,
                        })
                        .await?;
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
                codec.write(&ToServer::RemoteProbed { req, result }).await?;
            }

            ToWorker::CreateWorkspace(spec) => {
                let session_id = spec.session_id.clone();
                if let Err(e) = self.create_workspace(*spec, codec).await {
                    let kind = EventKind::Failed {
                        code: "SetupFailed".into(),
                        message: format!("{e:#}"),
                    };
                    self.emit(&session_id, kind, codec).await?;
                    self.store
                        .set_status(&session_id, SessionStatus::Failed)
                        .await?;
                    self.emit(
                        &session_id,
                        EventKind::StatusChanged {
                            status: SessionStatus::Failed,
                        },
                        codec,
                    )
                    .await?;
                }
            }

            ToWorker::Destroy { session_id, .. } => {
                self.store
                    .set_status(&session_id, SessionStatus::Ended)
                    .await?;
                self.emit(
                    &session_id,
                    EventKind::StatusChanged {
                        status: SessionStatus::Ended,
                    },
                    codec,
                )
                .await?;
            }

            // Terminal attachment lands in the next milestone; acknowledging the
            // frame rather than erroring keeps the control plane's contract honest.
            ToWorker::PtyOpen { session_id, .. }
            | ToWorker::PtyClose { session_id }
            | ToWorker::PtyInput { session_id, .. }
            | ToWorker::PtyResize { session_id, .. } => {
                tracing::debug!("terminal frames are not wired up yet ({session_id})");
            }

            ToWorker::Reply { session_id, .. } | ToWorker::Stop { session_id } => {
                tracing::debug!("agent control is not wired up yet ({session_id})");
            }
        }
        Ok(true)
    }

    /// Build a workspace, narrating each step as it completes.
    ///
    /// The narration is the point: it's what the interface shows while you wait,
    /// and what tells you *where* it broke when it breaks.
    async fn create_workspace<R, W>(
        &self,
        spec: CreateWorkspace,
        codec: &mut Codec<R, W>,
    ) -> Result<()>
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
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
            codec,
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
            codec,
        )
        .await?;

        let (path, branch) = self
            .git
            .add_worktree(&mirror, &spec.branch, &spec.base, id.as_str())
            .await
            .context("cutting the worktree")?;

        self.emit(&id, EventKind::WorktreeAdded { branch }, codec)
            .await?;

        let tmux_session = format!("firetower-{}", id.as_str());
        self.store
            .record_workspace(&id, path.to_str().unwrap_or_default(), &tmux_session)
            .await?;

        let (cpus, mem) = spec.size.resources();
        self.emit(
            &id,
            EventKind::WorkspaceStarted {
                detail: format!("{cpus} CPU / {} GB", mem / 1024),
            },
            codec,
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
                codec,
            )
            .await?;
        }

        self.store.set_status(&id, SessionStatus::Working).await?;
        self.emit(
            &id,
            EventKind::StatusChanged {
                status: SessionStatus::Working,
            },
            codec,
        )
        .await?;

        Ok(())
    }

    /// Record then send. Durable before it leaves, so a crash between the two
    /// costs a replayed event rather than a lost one.
    async fn emit<R, W>(
        &self,
        session_id: &SessionId,
        kind: EventKind,
        codec: &mut Codec<R, W>,
    ) -> Result<()>
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let stored = self.store.append(session_id, &kind).await?;
        codec
            .write(&ToServer::Event {
                seq: stored.seq,
                session_id: stored.session_id,
                kind: stored.kind,
                at: stored.at,
            })
            .await?;
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
            agent: Agent::ClaudeCode,
            size: WorkspaceSize::Medium,
            setup: setup.map(str::to_string),
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
                "Status",
            ]
        );
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
    }

    #[tokio::test]
    async fn resume_replays_what_a_sleeping_laptop_missed() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let worker = Worker::open(home.path()).await.unwrap();
        let id = SessionId::new();

        // the laptop was awake for this
        exchange(&worker, vec![hello(), spec(&remote, &id, None)]).await;
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

//! One session's agent, supervised.
//!
//! An agent driven through a structured protocol is a pipe, not a terminal, and
//! a pipe has an owner. That owner cannot be the worker: the worker is spawned
//! per connection and dies with it, so an agent parented to it would die when
//! somebody closed a laptop. It is this — started under tmux exactly the way an
//! interactive agent always has been, so what makes sessions survive is
//! unchanged. tmux supervises; this holds the pipes.
//!
//! Three jobs, and they are here together because they need one owner:
//!
//! 1. **Hold the agent's stdin open** across workers coming and going. A turn
//!    typed an hour from now goes down the same pipe as the first one.
//! 2. **Write the log before anybody reads it.** Every line the agent prints is
//!    appended to `agent.ndjson` and flushed *before* it is offered to a
//!    subscriber, so a session nobody is watching loses nothing. That file is
//!    the durable record; this process is not.
//! 3. **Answer the permission tool**, which the agent starts for itself and
//!    which has no other way back to us.
//!
//! ## What it deliberately does not do
//!
//! It does not understand a word the agent says. Lines go up as they arrived,
//! and turning them into something an interface can draw happens in the control
//! plane — see [`ft_core::normalise`]. Keeping this end dumb is what lets a
//! mapping be corrected by a deploy rather than by upgrading every host
//! somebody has ever added.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

use std::collections::HashMap;
use std::sync::Arc;

/// Where a session's own files live, under its workspace.
///
/// Inside the workspace rather than beside it because everything about a
/// session is already there, and destroying a workspace should not leave
/// anything behind to sweep up.
pub const DIR: &str = ".firetower";
/// Everything the agent has ever printed, in order.
pub const LOG: &str = "agent.ndjson";

pub fn dir_for(workspace: &Path) -> PathBuf {
    workspace.join(DIR)
}
pub fn log_path(workspace: &Path) -> PathBuf {
    dir_for(workspace).join(LOG)
}

/// Where a session's socket lives.
///
/// Not in the workspace with the log, which is where it started and where it
/// does not fit: a unix socket path is capped at around a hundred bytes, and a
/// worktree nested under a worker root can exceed that on its own. The failure
/// is `path must be shorter than SUN_LEN` at bind time, on the deep paths that
/// are least convenient to reproduce.
///
/// Runtime state belongs in a runtime directory anyway. The log is the durable
/// half and stays with the workspace; this is a rendezvous point that means
/// nothing once the process is gone.
pub fn socket_path(session_id: &str) -> PathBuf {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // Per-user, so two people on one host do not collide, and short —
            // the platform temp directory is itself long enough on macOS to
            // put the cap back in reach.
            let user = std::env::var("USER").unwrap_or_else(|_| "firetower".into());
            PathBuf::from(format!("/tmp/firetower-{user}"))
        });
    base.join(format!("{session_id}.sock"))
}

/// What to start, and where.
#[derive(Debug, Clone)]
pub struct Launch {
    /// Names the socket, so a worker can find this agent again.
    pub session_id: String,
    pub workspace: PathBuf,
    /// The agent's command line, already assembled. This module has no opinion
    /// about which agent it is.
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// What a worker asks of a running agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "frame")]
pub enum ToAgent {
    /// Send me everything after this line, then keep sending.
    ///
    /// Line zero is "everything", which is what a browser opening a finished
    /// session asks for.
    Watch { from_line: u64 },
    /// One message for the agent's stdin, verbatim.
    ///
    /// Verbatim because the shape of a turn belongs to whoever is driving the
    /// agent, and this end is not it.
    Send { message: serde_json::Value },
    /// End the turn in progress without killing the session.
    Interrupt,
    /// The answer to an [`FromAgent::Approval`].
    Decide {
        req: String,
        result: serde_json::Value,
    },
    /// I am the permission tool the agent started, not a worker.
    Approver,
    /// The permission tool asking whether a call may proceed.
    Ask {
        req: String,
        tool_name: String,
        input: serde_json::Value,
    },
}

/// What a running agent says.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "frame")]
pub enum FromAgent {
    /// One line the agent printed, and its position in the log.
    Line { line_no: u64, line: String },
    /// The agent is blocked until somebody answers.
    Approval {
        req: String,
        tool_name: String,
        input: serde_json::Value,
    },
    /// The answer, back to the permission tool that asked.
    Decided { result: serde_json::Value },
    /// The agent stopped.
    Exited { code: Option<i32> },
}

/// A question the agent is blocked on, and the way back to it.
struct Pending {
    tool_name: String,
    input: serde_json::Value,
    answer: oneshot::Sender<serde_json::Value>,
}

/// One line, as it was written and where.
#[derive(Debug, Clone)]
struct Logged {
    line_no: u64,
    line: String,
}

/// Everything the socket handlers share.
struct Session {
    log: PathBuf,
    /// Lines as they arrive. Late subscribers read the file first and join
    /// here, which is why this only has to be big enough to cover that gap.
    live: broadcast::Sender<Logged>,
    /// How many lines the log holds. Read before opening the file, so a
    /// subscriber can tell what it is about to have already seen.
    written: Arc<Mutex<u64>>,
    /// Questions as they are asked, so every watcher hears them and not only
    /// the permission tool that raised one.
    asked: broadcast::Sender<FromAgent>,
    /// Messages queued for the agent's stdin.
    to_agent: mpsc::Sender<serde_json::Value>,
    /// Approvals waiting on somebody, keyed by request.
    ///
    /// The question is kept beside the channel because a watcher that arrives
    /// after it was asked has to be told about it. Nothing in the log records
    /// an approval — the agent is blocked, not talking — so this is the only
    /// place a pending question exists, and a browser that reloads would
    /// otherwise show a session that is simply stuck.
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    /// The agent's process id, for interrupting it.
    pid: Option<u32>,
    /// Removed on the way out, so a later run can bind it again.
    socket: PathBuf,
}

/// Start the agent and serve it until it exits.
///
/// Returns when the agent does. tmux keeps this alive in between; nothing else
/// needs to.
pub async fn run(launch: Launch) -> Result<()> {
    let socket = socket_path(&launch.session_id);
    if let Some(parent) = socket.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("making {}", parent.display()))?;
    }

    let (session, mut child, pump) = start(launch, socket.clone()).await?;
    let session = Arc::new(session);

    let listener = {
        // A socket left behind by a previous run would refuse to bind. It
        // names nothing that is listening, so removing it is safe.
        let _ = tokio::fs::remove_file(&socket).await;
        UnixListener::bind(&socket).with_context(|| format!("listening on {}", socket.display()))?
    };

    let accepting = {
        let session = Arc::clone(&session);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let session = Arc::clone(&session);
                tokio::spawn(async move {
                    if let Err(e) = serve(stream, session).await {
                        tracing::debug!("a client went away: {e:#}");
                    }
                });
            }
        })
    };

    let status = child.wait().await.context("waiting for the agent")?;

    // Awaited rather than cancelled. A process can exit with output still in
    // the pipe, and aborting here truncated the log — including, once,
    // mid-line, which merged two lines into one that parsed as neither. The
    // pipe closes when the agent goes, so this ends on its own.
    let _ = pump.await;
    tracing::info!(code = status.code(), "the agent exited");

    // The log is already complete on disk; this is only for whoever is
    // watching right now.
    let _ = session.live.send(Logged {
        line_no: u64::MAX,
        line: String::new(),
    });

    accepting.abort();
    let _ = tokio::fs::remove_file(&session.socket).await;
    Ok(())
}

/// Spawn the agent and start draining it into the log.
async fn start(launch: Launch, socket: PathBuf) -> Result<(Session, Child, JoinHandle<()>)> {
    let dir = dir_for(&launch.workspace);
    tokio::fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("making {}", dir.display()))?;
    let log = dir.join(LOG);

    let (program, args) = launch
        .argv
        .split_first()
        .context("an agent needs something to run")?;

    let mut child = Command::new(program)
        .args(args)
        .current_dir(&launch.workspace)
        .envs(launch.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Left alone: whatever the agent complains about goes wherever tmux
        // is pointing, which is where somebody debugging a host will look.
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("starting {program}"))?;

    let pid = child.id();
    let stdout = child.stdout.take().context("the agent has no stdout")?;
    let mut stdin = child.stdin.take().context("the agent has no stdin")?;

    // A session resumed after a worker restart appends to what is already
    // there, so counting is where the last run stopped.
    let written = Arc::new(Mutex::new(count_lines(&log).await));
    let (live, _) = broadcast::channel(4096);

    let draining = {
        let log = log.clone();
        let live = live.clone();
        let written = Arc::clone(&written);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut count = written.lock().await;
                // Written and flushed before anybody hears about it. This is
                // the whole reason an unattended session loses nothing.
                if let Err(e) = append(&log, &line).await {
                    tracing::error!("could not write the log: {e:#}");
                }
                *count += 1;
                let line_no = *count;
                drop(count);
                let _ = live.send(Logged { line_no, line });
            }
        })
    };

    let (asked, _) = broadcast::channel(64);
    let (to_agent, mut queued) = mpsc::channel::<serde_json::Value>(64);
    tokio::spawn(async move {
        while let Some(message) = queued.recv().await {
            let mut bytes = match serde_json::to_vec(&message) {
                Ok(bytes) => bytes,
                Err(e) => {
                    tracing::warn!("dropping a message we could not encode: {e:#}");
                    continue;
                }
            };
            bytes.push(b'\n');
            if stdin.write_all(&bytes).await.is_err() || stdin.flush().await.is_err() {
                tracing::warn!("the agent stopped listening");
                break;
            }
        }
    });

    Ok((
        Session {
            log,
            live,
            written,
            asked,
            to_agent,
            pending: Arc::new(Mutex::new(HashMap::new())),
            pid,
            socket,
        },
        child,
        draining,
    ))
}

/// One line, appended whole.
///
/// The line and its terminator go in a single write on purpose: two writes can
/// be interrupted between them, and a log missing a newline joins two records
/// into one that parses as neither.
async fn append(log: &Path, line: &str) -> Result<()> {
    let mut record = String::with_capacity(line.len() + 1);
    record.push_str(line);
    record.push('\n');

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .await?;
    file.write_all(record.as_bytes()).await?;
    file.flush().await?;
    Ok(())
}

async fn count_lines(log: &Path) -> u64 {
    let Ok(text) = tokio::fs::read_to_string(log).await else {
        return 0;
    };
    text.lines().count() as u64
}

// ---- serving a client ---------------------------------------------------

async fn serve(stream: UnixStream, session: Arc<Session>) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut requests = BufReader::new(reader).lines();

    while let Some(line) = requests.next_line().await? {
        let Ok(frame) = serde_json::from_str::<ToAgent>(&line) else {
            tracing::debug!("ignoring a frame we could not read: {line}");
            continue;
        };
        match frame {
            ToAgent::Watch { from_line } => {
                // Subscribing before reading the file is what closes the gap:
                // a line written while we are still reading is held here
                // rather than missed, and skipped below if the file had it.
                let live = session.live.subscribe();
                let questions = session.asked.subscribe();

                // Anything the agent is already blocked on. A watcher that
                // arrives after the question was asked would otherwise see a
                // session doing nothing, with no way to find out why.
                for (req, pending) in session.pending.lock().await.iter() {
                    send(
                        &mut writer,
                        &FromAgent::Approval {
                            req: req.clone(),
                            tool_name: pending.tool_name.clone(),
                            input: pending.input.clone(),
                        },
                    )
                    .await?;
                }

                return replay_then_follow(&mut writer, &session, from_line, live, questions).await;
            }
            ToAgent::Send { message } => {
                let _ = session.to_agent.send(message).await;
            }
            ToAgent::Interrupt => interrupt(&session).await,
            ToAgent::Decide { req, result } => {
                if let Some(waiting) = session.pending.lock().await.remove(&req) {
                    let _ = waiting.answer.send(result);
                }
            }
            ToAgent::Approver => {}
            ToAgent::Ask {
                req,
                tool_name,
                input,
            } => {
                let (answer, wait) = oneshot::channel();
                session.pending.lock().await.insert(
                    req.clone(),
                    Pending {
                        tool_name: tool_name.clone(),
                        input: input.clone(),
                        answer,
                    },
                );
                // Everybody watching, not just whoever asked: the question has
                // to reach a browser, and the browser is on the other socket.
                let asked = FromAgent::Approval {
                    req: req.clone(),
                    tool_name,
                    input,
                };
                let _ = session.asked.send(asked.clone());
                send(&mut writer, &asked).await?;
                // No timeout on purpose. Somebody may be asleep, and an agent
                // that gave up and denied would be worse than one that waited.
                let result = wait.await.unwrap_or_else(|_| {
                    serde_json::json!({
                        "behavior": "deny",
                        "message": "Firetower stopped before this was answered",
                    })
                });
                send(&mut writer, &FromAgent::Decided { result }).await?;
            }
        }
    }
    Ok(())
}

/// Everything since `from_line`, then everything after that as it happens.
async fn replay_then_follow(
    writer: &mut (impl AsyncWriteExt + Unpin),
    session: &Session,
    from_line: u64,
    mut live: broadcast::Receiver<Logged>,
    mut questions: broadcast::Receiver<FromAgent>,
) -> Result<()> {
    let mut sent = from_line;
    if let Ok(text) = tokio::fs::read_to_string(&session.log).await {
        for (index, line) in text.lines().enumerate() {
            let line_no = index as u64 + 1;
            if line_no <= from_line {
                continue;
            }
            send(
                writer,
                &FromAgent::Line {
                    line_no,
                    line: line.to_string(),
                },
            )
            .await?;
            sent = line_no;
        }
    }

    loop {
        // Lines and questions arrive on separate channels because a question
        // is not part of the log — the agent is blocked rather than talking,
        // so there is nothing to write down and nothing to resume from.
        let logged = tokio::select! {
            asked = questions.recv() => {
                match asked {
                    Ok(frame) => { send(writer, &frame).await?; continue }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return Ok(()),
                }
            }
            line = live.recv() => line,
        };

        match logged {
            Ok(logged) if logged.line_no == u64::MAX => {
                return send(writer, &FromAgent::Exited { code: None }).await;
            }
            // Already sent from the file.
            Ok(logged) if logged.line_no <= sent => continue,
            Ok(logged) => {
                sent = logged.line_no;
                send(
                    writer,
                    &FromAgent::Line {
                        line_no: logged.line_no,
                        line: logged.line,
                    },
                )
                .await?;
            }
            // Fell behind. The log has everything, so say where we are and let
            // the reader ask again from there.
            Err(broadcast::error::RecvError::Lagged(_)) => {
                let written = *session.written.lock().await;
                tracing::warn!(sent, written, "a watcher fell behind");
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => return Ok(()),
        }
    }
}

async fn send(writer: &mut (impl AsyncWriteExt + Unpin), frame: &FromAgent) -> Result<()> {
    let mut bytes = serde_json::to_vec(frame)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

/// End the turn without ending the session.
///
/// `SIGINT` rather than `SIGTERM`: the agent treats an interrupt as "stop what
/// you are doing" and a termination as "stop existing", and the second leaves
/// the turn unfinished in its own history.
async fn interrupt(session: &Session) {
    let Some(pid) = session.pid else {
        return;
    };
    let _ = Command::new("kill")
        .args(["-INT", &pid.to_string()])
        .output()
        .await;
}

/// Talk to an agent that is already running.
///
/// The worker's side of the socket above.
pub struct AgentClient {
    stream: UnixStream,
}

impl AgentClient {
    pub async fn connect(session_id: &str) -> Result<Self> {
        let path = socket_path(session_id);
        let stream = UnixStream::connect(&path)
            .await
            .with_context(|| format!("connecting to {}", path.display()))?;
        Ok(Self { stream })
    }

    pub async fn send(&mut self, frame: &ToAgent) -> Result<()> {
        let mut bytes = serde_json::to_vec(frame)?;
        bytes.push(b'\n');
        self.stream.write_all(&bytes).await?;
        self.stream.flush().await?;
        Ok(())
    }

    /// Take the stream, for a caller that wants to read frames off it.
    pub fn into_stream(self) -> UnixStream {
        self.stream
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(script: &str) -> Vec<String> {
        vec!["sh".into(), "-c".into(), script.into()]
    }

    /// A session name nothing else in this run will pick.
    fn a_session(what: &str) -> String {
        format!(
            "ft-test-{what}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    async fn watch(session: &str, from_line: u64) -> Vec<FromAgent> {
        let mut client = AgentClient::connect(session).await.unwrap();
        client.send(&ToAgent::Watch { from_line }).await.unwrap();
        let mut lines = BufReader::new(client.into_stream()).lines();
        let mut out = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            let frame: FromAgent = serde_json::from_str(&line).unwrap();
            let done = matches!(frame, FromAgent::Exited { .. });
            out.push(frame);
            if done {
                break;
            }
        }
        out
    }

    /// Wait for the daemon to be listening, rather than sleeping and hoping.
    async fn ready(session: &str) {
        for _ in 0..200 {
            if socket_path(session).exists() && AgentClient::connect(session).await.is_ok() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the agent never started listening");
    }

    #[tokio::test]
    async fn what_the_agent_printed_is_on_disk_before_anybody_asks_for_it() {
        let session = a_session("on-disk");
        // The claim that makes an unattended session safe: nobody was watching
        // here, and nothing was lost.
        let workspace = tempfile::tempdir().unwrap();
        run(Launch {
            session_id: session.clone(),
            workspace: workspace.path().to_path_buf(),
            argv: shell("echo '{\"a\":1}'; echo '{\"b\":2}'"),
            env: vec![],
        })
        .await
        .unwrap();

        let log = tokio::fs::read_to_string(log_path(workspace.path()))
            .await
            .unwrap();
        assert_eq!(log.lines().count(), 2, "both lines should be in the log");
        assert!(log.contains("\"a\":1"));
    }

    #[tokio::test]
    async fn a_watcher_gets_what_it_missed_and_then_what_happens_next() {
        let session = a_session("missed");
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().to_path_buf();
        let running_as = session.clone();
        let serving = tokio::spawn(async move {
            run(Launch {
                session_id: running_as,
                workspace: path,
                // Prints, waits long enough to be attached to mid-flight, prints again.
                argv: shell("echo one; sleep 0.4; echo two"),
                env: vec![],
            })
            .await
            .unwrap();
        });

        ready(&session).await;
        let frames = watch(&session, 0).await;
        serving.await.unwrap();

        let lines: Vec<String> = frames
            .iter()
            .filter_map(|f| match f {
                FromAgent::Line { line, .. } => Some(line.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(lines, vec!["one", "two"], "got {frames:?}");
        assert!(matches!(frames.last(), Some(FromAgent::Exited { .. })));
    }

    #[tokio::test]
    async fn a_watcher_can_ask_for_only_what_it_has_not_seen() {
        let session = a_session("cursor");
        // The resume cursor. A browser reconnecting says where it got to, and
        // does not get the whole session again.
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().to_path_buf();
        let running_as = session.clone();
        let serving = tokio::spawn(async move {
            run(Launch {
                session_id: running_as,
                workspace: path,
                argv: shell("echo one; echo two; sleep 0.3; echo three"),
                env: vec![],
            })
            .await
            .unwrap();
        });

        ready(&session).await;
        let frames = watch(&session, 2).await;
        serving.await.unwrap();

        let lines: Vec<String> = frames
            .iter()
            .filter_map(|f| match f {
                FromAgent::Line { line, .. } => Some(line.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(lines, vec!["three"], "got {frames:?}");
    }

    #[tokio::test]
    async fn a_turn_typed_now_reaches_an_agent_started_earlier() {
        let session = a_session("typed");
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().to_path_buf();
        let running_as = session.clone();
        let serving = tokio::spawn(async move {
            run(Launch {
                session_id: running_as,
                workspace: path,
                // Echoes one line of stdin back, which is enough to prove the
                // pipe is open and reaches the process.
                argv: shell("head -n 1"),
                env: vec![],
            })
            .await
            .unwrap();
        });

        ready(&session).await;
        let mut client = AgentClient::connect(&session).await.unwrap();
        client
            .send(&ToAgent::Send {
                message: serde_json::json!({ "hello": "world" }),
            })
            .await
            .unwrap();
        serving.await.unwrap();

        let log = tokio::fs::read_to_string(log_path(workspace.path()))
            .await
            .unwrap();
        assert!(
            log.contains("\"hello\":\"world\""),
            "the message should have reached the agent, log was {log:?}"
        );
    }

    #[tokio::test]
    async fn a_workspace_nested_too_deep_for_a_socket_still_runs() {
        // The socket used to live beside the log. A unix socket path is capped
        // at around a hundred bytes, so a worktree far enough down a tree
        // failed to bind at all — and worker roots are exactly that deep.
        let session = a_session("deep");
        let root = tempfile::tempdir().unwrap();
        let mut workspace = root.path().to_path_buf();
        for part in ["a-fairly-long-directory-name"; 6] {
            workspace.push(part);
        }
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        assert!(
            workspace.as_os_str().len() > 110,
            "this test is pointless unless the path is over the cap"
        );

        run(Launch {
            session_id: session.clone(),
            workspace: workspace.clone(),
            argv: shell("echo deep"),
            env: vec![],
        })
        .await
        .expect("a deep workspace should still start");

        let log = tokio::fs::read_to_string(log_path(&workspace))
            .await
            .unwrap();
        assert_eq!(log.trim(), "deep");
    }

    #[tokio::test]
    async fn a_line_count_survives_the_daemon_being_restarted() {
        let session = a_session("restart");
        // A worker reconnecting after this process died must not renumber the
        // log, or every cursor anybody holds points at the wrong place.
        let workspace = tempfile::tempdir().unwrap();
        run(Launch {
            session_id: session.clone(),
            workspace: workspace.path().to_path_buf(),
            argv: shell("echo one; echo two"),
            env: vec![],
        })
        .await
        .unwrap();

        run(Launch {
            session_id: session.clone(),
            workspace: workspace.path().to_path_buf(),
            argv: shell("echo three"),
            env: vec![],
        })
        .await
        .unwrap();

        let frames = {
            // Nothing is running now, so this reads purely from the file.
            let log = tokio::fs::read_to_string(log_path(workspace.path()))
                .await
                .unwrap();
            log.lines().map(str::to_string).collect::<Vec<_>>()
        };
        assert_eq!(frames, vec!["one", "two", "three"]);
    }
}

//! The wire protocol between the control plane and a worker.
//!
//! Frames travel over any bidirectional byte stream. The worker never opens a
//! port and cannot tell whether the far end is a local pipe, an SSH tunnel, or
//! a websocket — that's what lets the same daemon serve a laptop today and a
//! hosted control plane later.
//!
//! Encoding is newline-delimited JSON: debuggable with `tee`, and behind
//! [`Codec`] so a compact binary format is a later swap rather than a rewrite.

use ft_core::{Agent, AgentPresence, EventKind, SessionId, WorkSummary, WorkspaceSize};
use serde::{Deserialize, Serialize};

/// Bumped when a frame changes shape incompatibly. Checked during the handshake.
///
/// 6 — `CreateWorkspace` gathered the checkout into an optional `RepoSpec`, so
/// a session can have no repository. An older worker accepts the handshake and
/// then cannot parse the frame, which is a session that hangs in `Starting`
/// with nothing recorded. That is precisely what this number exists to stop,
/// and it only works if it is bumped.
///
/// 8 — an agent that speaks a structured protocol is watched rather than
/// attached to. A worker from before this understands neither the frames that
/// drive one nor the ones that report it, and a session on it would show an
/// empty conversation with no indication why.
///
/// 9 — the agent's own terminal is gone, along with typing at it. `Pty` now
/// names only the shell somebody opens for themselves, and an older worker
/// would read a shell frame as a request to attach to the agent.
pub const PROTOCOL_VERSION: u32 = 9;

mod codec;
pub use codec::{Codec, CodecError, FrameReader, FrameWriter};

mod base64;
pub use base64::{decode, encode};

/// Correlates a request with its reply.
///
/// Most frames are one-way and correlate on `session_id`. Probing a remote has
/// no session yet, so it carries its own id.
pub type ReqId = String;

/// A git credential, valid for one operation.
///
/// Sent with the command that needs it rather than held by the worker, so a
/// compromised host yields nothing and an expired token is never cached. The
/// worker keeps it in memory for the length of a session and writes it nowhere.
#[derive(Clone, Serialize, Deserialize)]
pub struct Credential {
    pub username: String,
    pub secret: String,
}

/// Redacted, because frames get logged and this one holds a token.
impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("username", &self.username)
            .field("secret", &"<redacted>")
            .finish()
    }
}

/// What `git ls-remote` tells us about a repository we can reach.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    /// Read from HEAD's symref rather than assumed to be `main`.
    pub default_branch: String,
    /// Every branch on the remote, so a session can start from one that isn't
    /// the default. Comes free with the same `ls-remote`.
    #[serde(default)]
    pub branches: Vec<String>,
    /// Whether it has any commits. A repository with none has no branch to
    /// work from, which is worth saying plainly rather than failing at clone.
    pub empty: bool,
}

/// Why a remote could not be reached. Each one gets its own message in the
/// interface, because "could not connect" is not actionable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProbeFailure {
    /// Reachable, but it refused us. Almost always a private repository.
    Denied,
    /// No such host, no such path, or nothing listening.
    Unreachable,
    /// It answered, but it is not a git repository.
    NotARepository,
    /// git is not installed on that host.
    GitMissing,
}

/// Control plane to worker.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "frame")]
pub enum ToWorker {
    /// Always first.
    Hello {
        protocol: u32,
        client_version: String,
    },
    /// Build a workspace and start an agent in it.
    CreateWorkspace(Box<CreateWorkspace>),
    /// Send everything the agent has said since `since_line`, then keep
    /// sending.
    ///
    /// Line zero means the whole conversation, which is what a browser opening
    /// a session asks for. Anything else is a cursor: a reconnecting client
    /// says where it got to and is not sent the session again.
    WatchAgent {
        session_id: SessionId,
        since_line: u64,
    },
    /// Stop sending. The agent keeps working.
    UnwatchAgent {
        session_id: SessionId,
    },
    /// One message for a structured agent, verbatim.
    ///
    /// Opaque here on purpose: what a turn looks like belongs to whoever is
    /// driving the agent, and a worker forwarding it is not.
    SendTurn {
        session_id: SessionId,
        message: serde_json::Value,
    },
    /// The answer to something the agent is blocked on.
    Answer {
        session_id: SessionId,
        req: String,
        result: serde_json::Value,
    },
    /// End the turn in progress. The session stays.
    Interrupt {
        session_id: SessionId,
    },
    /// Attach a terminal.
    PtyOpen {
        session_id: SessionId,
        #[serde(default)]
        pty: Pty,
        cols: u16,
        rows: u16,
    },
    PtyInput {
        session_id: SessionId,
        #[serde(default)]
        pty: Pty,
        /// base64, because terminal input is bytes and JSON is text
        data: String,
    },
    PtyResize {
        session_id: SessionId,
        #[serde(default)]
        pty: Pty,
        cols: u16,
        rows: u16,
    },
    PtyClose {
        session_id: SessionId,
        #[serde(default)]
        pty: Pty,
    },
    /// What is in a directory of a session's workspace.
    ListFiles {
        req: ReqId,
        session_id: SessionId,
        /// Relative to the workspace. Empty is the workspace itself.
        path: String,
    },
    /// Send a file back, in pieces.
    ReadFile {
        req: ReqId,
        session_id: SessionId,
        path: String,
    },
    /// Stop the agent but keep the workspace.
    Stop {
        session_id: SessionId,
    },
    /// Do something with the work a session produced.
    RunAction {
        req: ReqId,
        session_id: SessionId,
        action: Action,
        /// Needed by anything that talks to the remote.
        credential: Option<Credential>,
    },
    /// What is in this workspace that isn't safely elsewhere.
    Summarize {
        req: ReqId,
        session_id: SessionId,
    },
    /// Tear the workspace down.
    Destroy {
        session_id: SessionId,
        force: bool,
    },
    /// Everything that happened since `seq`. Sent on every (re)connect.
    Resume {
        since: i64,
    },
    /// Which agents are on this host, and at what version?
    ///
    /// Asked of the worker for the same reason as everything else here: only
    /// the machine that would run them knows what it has.
    ProbeAgents {
        req: ReqId,
    },
    /// Can this host reach this repository, and what is its default branch?
    ///
    /// Asked of a worker rather than answered locally because the worker is
    /// what holds the credentials and what will do the clone. An answer from
    /// anywhere else would be a guess about someone else's network.
    ProbeRemote {
        req: ReqId,
        remote: String,
        credential: Option<Credential>,
    },
    Ping,
}

/// The verbs that act on a session's work.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action")]
pub enum Action {
    /// Kill the agent. The workspace and its branch stay.
    Stop,
    Commit {
        message: String,
    },
    Push,
    /// Everything this session changed, as a unified diff.
    Diff,
}

/// Everything a worker needs to build a workspace. No control-plane concepts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWorkspace {
    pub session_id: SessionId,
    /// `None` for a bare agent: make a directory, start the agent, clone
    /// nothing. Everything about a checkout lives in here so that "no
    /// repository" is one absent value rather than four empty strings.
    pub repo: Option<RepoSpec>,
    /// Directory name for the worktree. Readable, so someone on the host can
    /// tell what they're looking at.
    pub workspace: String,
    pub prompt: String,
    pub agent: Agent,
    pub size: WorkspaceSize,
    /// Runs before the agent starts.
    pub setup: Option<String>,
    /// Injected into the workspace environment. Secrets are already resolved.
    pub env: Vec<(String, String)>,
    /// A file to write in the workspace before setup runs, for tooling that
    /// reads one instead of the environment.
    ///
    /// Its own list rather than a flag over `env`: what belongs in a file is
    /// the repository's own variables, not the agent's API key or the two
    /// variables a hook needs to find its way home.
    #[serde(default)]
    pub env_file: Option<EnvFile>,
    /// For the clone, and held in memory for this session's later pushes.
    pub credential: Option<Credential>,
}

/// Which terminal in a session.
///
/// Every terminal frame carries one. Without it a second terminal's output
/// lands in the first one's screen: the maps on both sides key on the session,
/// and until there was more than one terminal that was the same thing.
///
/// Defaulted so that a worker from before this existed still understands a
/// frame from a control plane that has it, and means the agent by it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Pty {
    /// A shell of your own, in the same directory with the same environment.
    ///
    /// The only kind left. An agent used to have one too — you attached to its
    /// terminal and typed at it — and it does not any more: it speaks a
    /// protocol, and what it is doing is a conversation rather than a screen.
    /// This one is untouched by that, and is still how you go and look at a
    /// workspace yourself.
    #[default]
    Shell,
}

impl Pty {
    /// The tmux session it lives in.
    pub fn tmux_name(&self, session: &str) -> String {
        format!("firetower-{session}-shell")
    }
}

/// What to write, and where, when a repository asks for a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvFile {
    /// Relative to the workspace. `.env` for most.
    pub path: String,
    pub variables: Vec<(String, String)>,
}

/// What to check out, when there is something to check out.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSpec {
    /// Where to clone from, if the mirror is cold.
    pub remote: String,
    /// `acme/backend` — used for the mirror directory name.
    pub slug: String,
    pub base: String,
    pub branch: String,
}

/// Worker to control plane.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "frame")]
pub enum ToServer {
    Hello {
        protocol: u32,
        worker_version: String,
        arch: String,
        cpus: u32,
        memory_mb: u64,
    },
    /// Something happened. The worker recorded it before sending it.
    Event {
        seq: i64,
        session_id: SessionId,
        kind: EventKind,
        at: chrono::DateTime<chrono::Utc>,
    },
    PtyOutput {
        session_id: SessionId,
        #[serde(default)]
        pty: Pty,
        /// base64
        data: String,
    },
    PtyClosed {
        session_id: SessionId,
        #[serde(default)]
        pty: Pty,
    },
    /// One line a structured agent printed, and where it sits in the log.
    ///
    /// Forwarded exactly as it arrived. Making sense of it happens in the
    /// control plane, so that a mapping which turns out to be wrong is a deploy
    /// rather than a fleet upgrade — and so that the stored lines can be read
    /// again afterwards to derive a corrected history.
    AgentLine {
        session_id: SessionId,
        line_no: u64,
        line: String,
    },
    /// The agent is blocked and will not continue until somebody answers.
    AgentAsks {
        session_id: SessionId,
        req: String,
        tool_name: String,
        input: serde_json::Value,
    },
    /// Nothing more is coming from this agent.
    AgentClosed {
        session_id: SessionId,
    },
    /// The answer to [`ToWorker::ListFiles`].
    Listed {
        req: ReqId,
        result: Result<Vec<ft_core::FileEntry>, String>,
    },
    /// Whether a [`ToWorker::ReadFile`] is coming, and how much of it.
    ///
    /// Separate from the pieces because the control plane has to answer a
    /// browser with headers before it can send a body: it needs to know this
    /// worked before the first byte, not after the last.
    FileOpened {
        req: ReqId,
        result: Result<u64, String>,
    },
    /// A piece of a file, in order.
    FileChunk {
        req: ReqId,
        /// base64
        data: String,
        /// The last one. There is no other end-of-file marker.
        last: bool,
    },
    /// How a [`ToWorker::RunAction`] ended.
    ActionDone {
        req: ReqId,
        result: Result<String, String>,
    },
    /// The answer to [`ToWorker::Summarize`].
    Summarized {
        req: ReqId,
        summary: WorkSummary,
    },
    /// The answer to [`ToWorker::ProbeAgents`].
    AgentsProbed {
        req: ReqId,
        agents: Vec<AgentPresence>,
    },
    /// The answer to [`ToWorker::ProbeRemote`].
    RemoteProbed {
        req: ReqId,
        result: Result<RemoteInfo, ProbeFailure>,
    },
    /// A command failed. Distinct from a session failing.
    Error {
        session_id: Option<SessionId>,
        code: String,
        message: String,
    },
    Pong,
}

/// Why a handshake was refused.
#[derive(Debug, thiserror::Error)]
pub enum HandshakeError {
    #[error("worker speaks protocol {theirs}, we speak {ours}")]
    VersionMismatch { ours: u32, theirs: u32 },
    #[error("expected a Hello frame, got something else")]
    NotHello,
    #[error("the worker closed the connection before saying hello")]
    Closed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_credential_never_prints_itself() {
        // Frames are logged. A token that shows up in a log has escaped.
        let c = Credential {
            username: "x-access-token".into(),
            secret: "ghp_averyrealsecret".into(),
        };
        let shown = format!("{c:?}");
        assert!(!shown.contains("averyrealsecret"), "{shown}");
        assert!(shown.contains("redacted"), "{shown}");
    }

    #[test]
    fn a_probe_result_round_trips_both_ways() {
        for result in [
            Ok(RemoteInfo {
                default_branch: "trunk".into(),
                branches: vec!["trunk".into()],
                empty: false,
            }),
            Err(ProbeFailure::Denied),
        ] {
            let frame = ToServer::RemoteProbed {
                req: "r_1".into(),
                result,
            };
            let json = serde_json::to_string(&frame).unwrap();
            let back: ToServer = serde_json::from_str(&json).unwrap();
            assert!(matches!(back, ToServer::RemoteProbed { .. }), "{json}");
        }
    }

    #[test]
    fn frames_round_trip() {
        let frame = ToWorker::PtyResize {
            session_id: SessionId::from_stored("s_abc"),
            pty: Pty::Shell,
            cols: 120,
            rows: 40,
        };
        let json = serde_json::to_string(&frame).unwrap();
        let back: ToWorker = serde_json::from_str(&json).unwrap();
        assert!(matches!(
            back,
            ToWorker::PtyResize {
                cols: 120,
                pty: Pty::Shell,
                ..
            }
        ));
    }

    /// Which terminal a frame is about was added after workers were already
    /// running on machines somebody else has to upgrade. A frame without it is
    /// about the agent's terminal, which is what every frame meant before.
    #[test]
    fn a_terminal_frame_without_a_target_is_the_agents() {
        let older = r#"{"frame":"PtyOpen","session_id":"s_abc","cols":80,"rows":24}"#;
        let back: ToWorker = serde_json::from_str(older).unwrap();
        assert!(matches!(
            back,
            ToWorker::PtyOpen {
                pty: Pty::Shell,
                ..
            }
        ));

        let older = r#"{"frame":"PtyOutput","session_id":"s_abc","data":"aGk="}"#;
        let back: ToServer = serde_json::from_str(older).unwrap();
        assert!(matches!(
            back,
            ToServer::PtyOutput {
                pty: Pty::Shell,
                ..
            }
        ));
    }

    #[test]
    fn the_tag_is_a_readable_discriminator() {
        // Frames get read by humans in logs. The tag should say what it is.
        let json = serde_json::to_string(&ToWorker::Ping).unwrap();
        assert!(json.contains("\"frame\":\"Ping\""), "{json}");
    }
}

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
pub const PROTOCOL_VERSION: u32 = 5;

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
    /// Send text to the agent, as if typed.
    Reply {
        session_id: SessionId,
        text: String,
    },
    /// Attach a terminal.
    PtyOpen {
        session_id: SessionId,
        cols: u16,
        rows: u16,
    },
    PtyInput {
        session_id: SessionId,
        /// base64, because terminal input is bytes and JSON is text
        data: String,
    },
    PtyResize {
        session_id: SessionId,
        cols: u16,
        rows: u16,
    },
    PtyClose {
        session_id: SessionId,
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
    Commit { message: String },
    Push,
    /// Everything this session changed, as a unified diff.
    Diff,
}

/// Everything a worker needs to build a workspace. No control-plane concepts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWorkspace {
    pub session_id: SessionId,
    /// Where to clone from, if the mirror is cold.
    pub remote: String,
    /// `acme/backend` — used for the mirror directory name.
    pub repo_slug: String,
    pub base: String,
    pub branch: String,
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
    /// For the clone, and held in memory for this session's later pushes.
    pub credential: Option<Credential>,
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
        /// base64
        data: String,
    },
    PtyClosed {
        session_id: SessionId,
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
            cols: 120,
            rows: 40,
        };
        let json = serde_json::to_string(&frame).unwrap();
        let back: ToWorker = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, ToWorker::PtyResize { cols: 120, .. }));
    }

    #[test]
    fn the_tag_is_a_readable_discriminator() {
        // Frames get read by humans in logs. The tag should say what it is.
        let json = serde_json::to_string(&ToWorker::Ping).unwrap();
        assert!(json.contains("\"frame\":\"Ping\""), "{json}");
    }

    #[test]
    fn a_frame_never_spans_lines() {
        // The codec is newline-delimited, so an embedded newline would split a
        // frame in half. serde_json escapes them; this guards the assumption.
        let frame = ToWorker::Reply {
            session_id: SessionId::from_stored("s_abc"),
            text: "first\nsecond".into(),
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert!(!json.contains('\n'), "{json}");
    }
}

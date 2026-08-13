//! Domain types and the session state machine.
//!
//! This crate performs no I/O and has no async. Everything here is a value or a
//! pure function over values, which is what makes the state machine exhaustively
//! testable and reusable verbatim in a hosted control plane.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

mod ids;
pub mod session;
mod status;

pub use ids::{HostId, RepoId, SessionId, WorkspaceId};
pub use session::{slugify, title_from, NewSession, Session, Workspace, WorkspaceSize};
pub use status::{SessionStatus, TransitionError};

/// Which agent runs inside a workspace.
///
/// Serialised as the variant name — see the wire conventions in the brief: a
/// field takes the consumer's casing, an enum value stays the symbol it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum Agent {
    ClaudeCode,
    Codex,
    Shell,
}

impl Agent {
    /// The command Firetower launches inside tmux.
    pub fn command(&self) -> &'static str {
        match self {
            Agent::ClaudeCode => "claude",
            Agent::Codex => "codex",
            Agent::Shell => "bash",
        }
    }

    /// Whether this agent can report its own status, or has to be guessed at.
    ///
    /// Claude Code fires hooks the worker listens for; everything else falls
    /// back to output heuristics and an idle timer.
    pub fn has_status_hooks(&self) -> bool {
        matches!(self, Agent::ClaudeCode)
    }
}

/// A machine that can run workspaces.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: HostId,
    /// What the user calls it. `localhost` is a real host, not a special case.
    pub name: String,
    pub state: HostState,
    /// `None` for the local host — there is nothing to connect to.
    pub ssh_target: Option<String>,
    pub cpus: Option<u32>,
    pub memory_mb: Option<u64>,
    pub worker_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum HostState {
    /// Connected and taking work.
    Online,
    /// We can't reach it. Its sessions stay visible, marked unreachable.
    Unreachable,
    /// Finishing what it has, accepting nothing new.
    Draining,
}

/// A repository Firetower can cut worktrees from.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub id: RepoId,
    /// `acme/backend`
    pub slug: String,
    /// Where the worker clones from.
    pub remote: String,
    pub default_branch: String,
    /// Runs once per session before the agent starts.
    pub setup: Option<String>,
}

/// Something that happened, recorded by the worker that it happened on.
///
/// Sessions are a projection of these, never the other way round.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// Monotonic per worker. This is the resume cursor.
    pub seq: i64,
    pub session_id: SessionId,
    pub kind: EventKind,
    pub at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type")]
pub enum EventKind {
    SessionCreated { repo: String, prompt: String },
    HostSelected { host: String, detail: String },
    RepoFetched { detail: String },
    WorktreeAdded { branch: String },
    WorkspaceStarted { detail: String },
    SetupFinished { detail: String },
    TmuxOpened { name: String },
    AgentLaunched { agent: Agent },
    StatusChanged { status: SessionStatus },
    Failed { code: String, message: String },
}

impl EventKind {
    /// Human-readable, for the activity view and logs.
    pub fn label(&self) -> &'static str {
        match self {
            EventKind::SessionCreated { .. } => "Session created",
            EventKind::HostSelected { .. } => "Picked a host",
            EventKind::RepoFetched { .. } => "Fetched the repository",
            EventKind::WorktreeAdded { .. } => "Added a worktree",
            EventKind::WorkspaceStarted { .. } => "Started the workspace",
            EventKind::SetupFinished { .. } => "Ran the setup script",
            EventKind::TmuxOpened { .. } => "Opened tmux",
            EventKind::AgentLaunched { .. } => "Launched the agent",
            EventKind::StatusChanged { .. } => "Status",
            EventKind::Failed { .. } => "Failed",
        }
    }
}

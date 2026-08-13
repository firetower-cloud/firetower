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
    /// Every kind, for screens that have to list them all.
    pub fn all() -> [Agent; 3] {
        [Agent::ClaudeCode, Agent::Codex, Agent::Shell]
    }

    /// What it's called in the interface.
    pub fn label(&self) -> &'static str {
        match self {
            Agent::ClaudeCode => "Claude Code",
            Agent::Codex => "Codex",
            Agent::Shell => "Shell",
        }
    }

    /// The binary Firetower launches inside tmux.
    pub fn command(&self) -> &'static str {
        match self {
            Agent::ClaudeCode => "claude",
            Agent::Codex => "codex",
            Agent::Shell => "bash",
        }
    }

    /// The full command line, with the prompt already handed over.
    ///
    /// These CLIs take the first task as an argument, which is worth using:
    /// typing it in afterwards means guessing when the agent is ready to listen,
    /// and keystrokes sent a moment too early are simply lost.
    ///
    /// A shell has no prompt to give — it is there for poking around a
    /// workspace by hand.
    pub fn launch(&self, prompt: &str) -> String {
        let prompt = prompt.trim();
        if prompt.is_empty() || matches!(self, Agent::Shell) {
            return self.command().to_string();
        }
        format!("{} {}", self.command(), quote(prompt))
    }

    /// Whether authenticating this one is even a question.
    pub fn needs_credential(&self) -> bool {
        !matches!(self, Agent::Shell)
    }

    /// Parsed back from how it is stored and sent.
    pub fn from_name(name: &str) -> Option<Agent> {
        Agent::all().into_iter().find(|a| format!("{a:?}") == name)
    }

    /// Whether this agent can report its own status, or has to be guessed at.
    ///
    /// Claude Code fires hooks the worker listens for; everything else falls
    /// back to output heuristics and an idle timer.
    pub fn has_status_hooks(&self) -> bool {
        matches!(self, Agent::ClaudeCode)
    }
}

/// Wrap a string so a shell passes it through as one argument.
///
/// Prompts are written by people and contain quotes, backticks, dollar signs
/// and newlines. Single quotes stop the shell reading any of it — the dance in
/// the middle is how a single quote itself gets through.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
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

/// How an agent proves who it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum AgentMode {
    /// A plan you already pay for. The CLI holds the login on the host it was
    /// performed on, so Firetower stores no secret — only the intent.
    Subscription,
    /// A key Firetower holds and hands to a workspace.
    ApiKey,
    /// Nothing to authenticate, which is only true of a plain shell.
    ///
    /// Distinct from an absent mode, which means nobody has configured this
    /// agent yet — the response carries `null` for that.
    NotNeeded,
}

/// What a host reported about an agent, last time we asked.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentPresence {
    pub kind: Agent,
    pub installed: bool,
    /// Whatever the binary printed, when it's there.
    pub version: Option<String>,
    /// `None` when the agent offers no way to ask without starting it.
    pub logged_in: Option<bool>,
    /// Who it's logged in as, when it will say. Shown so you can tell which
    /// account a host is using before it starts spending against it.
    pub account: Option<String>,
}

impl Agent {
    /// How to ask whether this agent is signed in, without starting it.
    ///
    /// `None` means it offers no such command, and the honest answer is that
    /// we don't know until a session runs.
    pub fn auth_status_command(&self) -> Option<&'static [&'static str]> {
        match self {
            Agent::ClaudeCode => Some(&["auth", "status"]),
            Agent::Codex | Agent::Shell => None,
        }
    }

    /// The command you run on your own machine to get a token, and the
    /// variable the agent reads it from.
    ///
    /// Signing in needs a browser, so it happens where you are rather than on
    /// a server. What crosses the gap is the token — obtained once, used by
    /// every host, instead of a separate sign-in on each one.
    pub fn token_setup(&self) -> Option<(&'static str, &'static str)> {
        match self {
            Agent::ClaudeCode => Some(("claude setup-token", "CLAUDE_CODE_OAUTH_TOKEN")),
            Agent::Codex | Agent::Shell => None,
        }
    }

    /// The variable that carries a metered key, for the other mode.
    pub fn api_key_var(&self) -> Option<&'static str> {
        match self {
            Agent::ClaudeCode => Some("ANTHROPIC_API_KEY"),
            Agent::Codex => Some("OPENAI_API_KEY"),
            Agent::Shell => None,
        }
    }
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

/// What is in a workspace that isn't safely elsewhere yet.
///
/// The thing that makes ending a session a decision rather than a gamble.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkSummary {
    pub branch: String,
    /// Files changed but not committed.
    pub uncommitted: u32,
    /// Commits the remote hasn't got.
    pub ahead: u32,
    /// Whether this branch exists on the remote at all.
    pub pushed: bool,
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

#[cfg(test)]
mod launch_tests {
    use super::*;

    #[test]
    fn the_prompt_is_handed_to_the_agent() {
        assert_eq!(
            Agent::ClaudeCode.launch("Fix retry handling"),
            "claude 'Fix retry handling'"
        );
    }

    #[test]
    fn a_prompt_cannot_escape_into_the_shell() {
        // Prompts are prose written by people, and tmux runs this line through
        // a shell. Anything in one has to arrive as text rather than as
        // something the shell decides to run — so ask a real shell.
        let nasty = "don't; rm -rf /; `whoami` $HOME \"quoted\" \\ end";

        let shown = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("printf %s {}", quote(nasty)))
            .output()
            .expect("running a shell");

        assert_eq!(
            String::from_utf8_lossy(&shown.stdout),
            nasty,
            "the prompt should reach the agent exactly as written"
        );
    }

    #[test]
    fn a_shell_gets_no_prompt_and_no_empty_argument() {
        assert_eq!(Agent::Shell.launch("anything"), "bash");
        assert_eq!(Agent::ClaudeCode.launch("   "), "claude");
    }
}

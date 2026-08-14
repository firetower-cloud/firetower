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
pub use session::{
    sanitize_branch, slugify, title_from, workspace_name, NewSession, Session, Workspace,
    WorkspaceSize,
};
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

/// Where an agent can run.
///
/// Three kinds, and they are not a ladder — each is the right answer sometimes.
/// Poking at a repository by hand wants the first; leaving an agent running for
/// an hour wants the third.
// The wire convention holds here too: an enum value stays the symbol it is,
// and only fields take the consumer's casing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum Compute {
    /// A worker as a child process here. Inherits your environment, and its
    /// workspaces are directories you can open.
    Local,
    /// A worker in a container here. Linux, and isolated from your machine.
    ///
    /// Reached with `docker exec` rather than ssh: the same bidirectional pipe
    /// without an sshd, a key, or a host key to verify.
    Container { image: String, name: String },
    /// A worker on another machine. What a real deployment looks like.
    Server {
        target: String,
        /// Recorded when the host is added, checked on every connection. A
        /// machine that answers with a different key is not the one we trusted.
        host_key: Option<String>,
    },
}

impl Compute {
    /// What to call this kind on screen.
    pub fn label(&self) -> &'static str {
        match self {
            Compute::Local => "local",
            Compute::Container { .. } => "container",
            Compute::Server { .. } => "server",
        }
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
    pub compute: Compute,
    /// Finishing what it has, taking nothing new. Separate from being
    /// unreachable: a draining host is still online and still working.
    #[serde(default)]
    pub drained: bool,
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

    /// What a home directory this agent has never run in needs, so that it
    /// starts working instead of asking questions.
    ///
    /// A CLI written for a person at a keyboard has a first run: pick a theme,
    /// pick how you sign in, confirm you trust this folder. Every one of those
    /// is reasonable in a terminal and useless here — nobody is watching the
    /// pane when a session starts, and the first screen offers to sign you in
    /// even though the token was handed over and works. It reads as broken
    /// authentication and isn't.
    ///
    /// A fresh home is not a container thing. A server added over ssh has one
    /// too, which is why this is answered by the worker on whatever host it is
    /// about to launch on rather than baked into an image.
    ///
    /// Returns where the answers go, relative to the home directory, and what
    /// they are. See [`FirstRun`] for how they are applied — additively, and
    /// never over something already there.
    pub fn first_run(&self, workspace: &str) -> Option<FirstRun> {
        match self {
            Agent::ClaudeCode => Some(FirstRun {
                file: ".claude.json",
                answers: vec![
                    // Skips the theme picker and the "select login method"
                    // screen — the one that reads as a rejected token.
                    (vec!["hasCompletedOnboarding".into()], true),
                    // And the folder it is about to work in is one Firetower
                    // just checked out, so the trust prompt has one answer.
                    (
                        vec![
                            "projects".into(),
                            workspace.to_string(),
                            "hasTrustDialogAccepted".into(),
                        ],
                        true,
                    ),
                ],
            }),
            // Not because they don't have one, but because nobody has worked
            // out what it wants. An unanswered first run costs a keypress.
            Agent::Codex | Agent::Shell => None,
        }
    }
}

/// Questions to answer in an agent's own configuration before it runs.
///
/// This reaches into another program's private file, which is worth being
/// honest about: the shape is undocumented and can change under us. What that
/// costs if it does is the first-run prompt coming back — visible, and harmless
/// next to the alternative, which is every new host greeting you with a login
/// screen you can't act on.
///
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirstRun {
    /// Relative to the home directory of whoever runs the agent.
    pub file: &'static str,
    /// Each answer is the path of keys to walk and the value at the end of it.
    /// Everything asked so far is a yes, hence `bool`; widen it when something
    /// needs otherwise.
    pub answers: Vec<(Vec<String>, bool)>,
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
    SessionCreated {
        repo: String,
        prompt: String,
    },
    HostSelected {
        host: String,
        detail: String,
    },
    /// A step is under way. Every other event here is a *completion*, which is
    /// why a session that spent eight minutes fetching a repository looked
    /// frozen: nothing had happened yet, so nothing had been said.
    StepStarted {
        step: Step,
    },
    /// How a step is getting on, while it is still going. Sent sparingly — one
    /// line replacing the last, not a log.
    StepProgress {
        step: Step,
        detail: String,
    },
    RepoFetched {
        detail: String,
    },
    WorktreeAdded {
        branch: String,
    },
    WorkspaceStarted {
        detail: String,
    },
    SetupFinished {
        detail: String,
    },
    TmuxOpened {
        name: String,
    },
    AgentLaunched {
        agent: Agent,
    },
    StatusChanged {
        status: SessionStatus,
    },
    Failed {
        code: String,
        message: String,
    },
}

/// One stage of bringing a session up.
///
/// The point of naming them is that the whole list is knowable *before* any of
/// it runs — so a session can show what it is going to do the moment it is
/// created, rather than assembling a shape out of events as they arrive. A step
/// nobody has reached yet is still worth showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum Step {
    /// Clone or refresh the mirror. The long one, and the one that fails.
    Fetch,
    /// Cut this session's own branch and worktree from it.
    Worktree,
    /// A plain directory, for an agent running without a repository.
    Workspace,
    /// The repository's own setup command, if it has one.
    Setup,
    /// Start the agent under tmux.
    Launch,
}

impl Step {
    /// What the screen calls it, in the present tense — these are read while
    /// they are happening.
    pub fn label(&self) -> &'static str {
        match self {
            Step::Fetch => "Fetching the repository",
            Step::Worktree => "Creating the worktree",
            Step::Workspace => "Making the workspace",
            Step::Setup => "Running setup",
            Step::Launch => "Starting the agent",
        }
    }

    /// Everything this session will do, in order.
    ///
    /// Decided once, when the session is created, from what it was asked for.
    /// A bare agent has no repository to fetch and nothing to branch from; a
    /// repository without a setup command skips that too. Showing a step that
    /// will never run is its own kind of lie.
    pub fn plan(has_repo: bool, has_setup: bool) -> Vec<Step> {
        let mut steps = if has_repo {
            vec![Step::Fetch, Step::Worktree]
        } else {
            vec![Step::Workspace]
        };
        if has_setup {
            steps.push(Step::Setup);
        }
        steps.push(Step::Launch);
        steps
    }

    /// The step an event finishes, for a screen matching one to the other.
    ///
    /// Here rather than in the interface so that adding an event and forgetting
    /// to tick a step off is a change in one place.
    pub fn completed_by(event: &EventKind) -> Option<Step> {
        match event {
            EventKind::RepoFetched { .. } => Some(Step::Fetch),
            EventKind::WorktreeAdded { .. } => Some(Step::Worktree),
            EventKind::WorkspaceStarted { .. } => Some(Step::Workspace),
            EventKind::SetupFinished { .. } => Some(Step::Setup),
            EventKind::AgentLaunched { .. } => Some(Step::Launch),
            _ => None,
        }
    }
}

impl EventKind {
    /// Human-readable, for the activity view and logs.
    pub fn label(&self) -> &'static str {
        match self {
            EventKind::SessionCreated { .. } => "Session created",
            EventKind::HostSelected { .. } => "Picked a host",
            // Its own name, so the activity log reads as a sequence of things
            // starting rather than a column of the word "started".
            EventKind::StepStarted { step } => step.label(),
            EventKind::StepProgress { step, .. } => step.label(),
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
mod step_tests {
    use super::*;

    #[test]
    fn the_plan_matches_what_the_session_will_actually_do() {
        assert_eq!(
            Step::plan(true, true),
            vec![Step::Fetch, Step::Worktree, Step::Setup, Step::Launch]
        );
        assert_eq!(
            Step::plan(true, false),
            vec![Step::Fetch, Step::Worktree, Step::Launch]
        );
        // No repository: nothing to fetch, nothing to branch from.
        assert_eq!(
            Step::plan(false, false),
            vec![Step::Workspace, Step::Launch]
        );
        assert_eq!(
            Step::plan(false, true),
            vec![Step::Workspace, Step::Setup, Step::Launch]
        );
    }

    #[test]
    fn every_plan_ends_by_starting_the_agent() {
        for (repo, setup) in [(true, true), (true, false), (false, true), (false, false)] {
            assert_eq!(Step::plan(repo, setup).last(), Some(&Step::Launch));
        }
    }

    /// Every step has to be tickable by something, or the checklist waits on it
    /// forever.
    #[test]
    fn each_step_has_an_event_that_finishes_it() {
        let finishers = [
            EventKind::RepoFetched {
                detail: String::new(),
            },
            EventKind::WorktreeAdded {
                branch: String::new(),
            },
            EventKind::WorkspaceStarted {
                detail: String::new(),
            },
            EventKind::SetupFinished {
                detail: String::new(),
            },
            EventKind::AgentLaunched {
                agent: Agent::Shell,
            },
        ];

        for step in [
            Step::Fetch,
            Step::Worktree,
            Step::Workspace,
            Step::Setup,
            Step::Launch,
        ] {
            assert!(
                finishers
                    .iter()
                    .any(|e| Step::completed_by(e) == Some(step)),
                "nothing finishes {step:?}"
            );
        }
    }

    #[test]
    fn an_event_that_is_not_a_completion_ticks_nothing_off() {
        assert_eq!(
            Step::completed_by(&EventKind::StepStarted { step: Step::Fetch }),
            None,
            "starting a step is not finishing it"
        );
        assert_eq!(
            Step::completed_by(&EventKind::Failed {
                code: "SetupFailed".into(),
                message: "no".into()
            }),
            None
        );
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

/// One file's worth of a unified diff.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub added: u32,
    pub removed: u32,
    /// The hunks, as git printed them.
    pub patch: String,
}

/// Split a unified diff into files.
///
/// Done here rather than in the browser: it is a pure function over text, it is
/// the sort of thing that gets subtly wrong, and a test is cheap.
pub fn split_diff(diff: &str) -> Vec<FileDiff> {
    let mut files = Vec::new();

    for chunk in diff.split("\ndiff --git ") {
        let chunk = chunk.trim_start_matches("diff --git ").trim_end();
        if chunk.is_empty() {
            continue;
        }

        // `+++ b/path` is the name after the change, which is the one to show.
        // A deleted file has `+++ /dev/null`, so fall back to the old name.
        let path = chunk
            .lines()
            .find_map(|l| l.strip_prefix("+++ b/"))
            .or_else(|| chunk.lines().find_map(|l| l.strip_prefix("--- a/")))
            .unwrap_or_else(|| chunk.lines().next().unwrap_or("unknown"))
            .to_string();

        let mut added = 0;
        let mut removed = 0;
        for line in chunk.lines() {
            // `+++` and `---` are the header, not content.
            if line.starts_with("+++") || line.starts_with("---") {
                continue;
            }
            match line.as_bytes().first() {
                Some(b'+') => added += 1,
                Some(b'-') => removed += 1,
                _ => {}
            }
        }

        files.push(FileDiff {
            path,
            added,
            removed,
            patch: format!("diff --git {chunk}"),
        });
    }

    files
}

#[cfg(test)]
mod diff_tests {
    use super::*;

    const SAMPLE: &str = "diff --git a/README.md b/README.md\n\
index 1..2 100644\n\
--- a/README.md\n\
+++ b/README.md\n\
@@ -1,2 +1,3 @@\n\
 # fixture\n\
+a new line\n\
-an old line\n\
diff --git a/src/main.rs b/src/main.rs\n\
index 3..4 100644\n\
--- a/src/main.rs\n\
+++ b/src/main.rs\n\
@@ -1 +1,2 @@\n\
+fn extra() {}\n";

    #[test]
    fn a_diff_splits_into_its_files() {
        let files = split_diff(SAMPLE);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "README.md");
        assert_eq!(files[1].path, "src/main.rs");
    }

    #[test]
    fn the_counts_ignore_the_header_lines() {
        // `---` and `+++` name the file; counting them would add one to every
        // file in every diff.
        let files = split_diff(SAMPLE);
        assert_eq!((files[0].added, files[0].removed), (1, 1));
        assert_eq!((files[1].added, files[1].removed), (1, 0));
    }

    #[test]
    fn each_file_keeps_a_patch_that_still_reads_as_a_diff() {
        let files = split_diff(SAMPLE);
        assert!(files[1].patch.starts_with("diff --git a/src/main.rs"));
        assert!(files[1].patch.contains("+fn extra() {}"));
    }

    #[test]
    fn nothing_changed_is_no_files_rather_than_one_empty_one() {
        assert!(split_diff("").is_empty());
        assert!(split_diff("\n").is_empty());
    }
}

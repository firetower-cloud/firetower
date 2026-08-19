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

pub use ids::{HostId, OrgId, RepoId, SessionId, UserId, WorkspaceId};
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
//
// Casing is asked for per variant rather than once with `rename_all_fields`,
// which reads better but only serde understands. The schema generator ignores
// it and emits the Rust names, so the contract — and every client built from
// it — would disagree with the wire about a field nobody checks by hand. Both
// understand a variant asking for itself. See the test at the bottom of this
// file, which is what keeps that true.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type")]
pub enum Compute {
    /// A worker as a child process here. Inherits your environment, and its
    /// workspaces are directories you can open.
    Local,
    /// A worker in a container here. Linux, and isolated from your machine.
    ///
    /// Reached with `docker exec` rather than ssh: the same bidirectional pipe
    /// without an sshd, a key, or a host key to verify.
    #[serde(rename_all = "camelCase")]
    Container { image: String, name: String },
    /// A worker on another machine. What a real deployment looks like.
    ///
    /// Held as the parts of an ssh destination rather than one string, because
    /// each part is a separate decision: the address is the machine, the user is
    /// the account work runs as, and the key is which of several you keep.
    /// Assembling them is [`Compute::ssh_destination`]'s job.
    #[serde(rename_all = "camelCase")]
    Server {
        /// A hostname, an address, or a name from your ssh config.
        host: String,
        /// Who to connect as.
        ///
        /// Absent leaves it to ssh, which is what keeps a name from your ssh
        /// config working on its own — that file may already say, and repeating
        /// it here badly is worse than not repeating it.
        user: Option<String>,
        /// Absent is whatever ssh would use: 22, or what the config says.
        port: Option<u16>,
        /// Which private key to authenticate with, as a path on the machine
        /// running the control plane.
        ///
        /// The path, never the key. A private key is the one credential
        /// Firetower has no reason to hold: ssh reads the file itself, and only
        /// this machine ever dials out. Absent lets ssh choose, which means the
        /// agent and then the usual names in `~/.ssh`.
        identity_file: Option<String>,
        /// Recorded when the host is added. Not yet checked against what the
        /// machine answers with — connecting trusts a key it hasn't seen before
        /// and remembers it, so this is a record rather than a guarantee.
        host_key: Option<String>,
        /// The container the worker runs in on that machine. Absent runs the
        /// binary on the host itself, for a machine whose image already has it.
        ///
        /// Reached by ssh-ing to the machine and running `docker exec` there,
        /// never by ssh-ing into the container — that would need a key inside
        /// the image, a published port, and a host key that changes on every
        /// recreate.
        #[serde(default)]
        container: Option<String>,
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

    /// What to hand ssh as the destination: `user@host`, or the host by itself
    /// when nobody named a user.
    ///
    /// `None` for the kinds that aren't reached over a network at all.
    pub fn ssh_destination(&self) -> Option<String> {
        match self {
            Compute::Server { host, user, .. } => Some(match user {
                Some(user) => format!("{user}@{host}"),
                None => host.clone(),
            }),
            Compute::Local | Compute::Container { .. } => None,
        }
    }
}

/// An ssh destination, pulled apart.
///
/// Firetower asks for the pieces separately, since it has to pass a port and a
/// key as their own flags anyway. But `root@203.0.113.44` is what fingers type
/// and what every other tool takes, so it is understood in the address field
/// rather than rejected there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Destination {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
}

/// Read whatever someone typed into an address field.
///
/// Forgiving on purpose, and lossless: whatever isn't recognised stays in the
/// host, where ssh will have its own opinion about it. Nothing here validates
/// — that belongs to whoever is about to dial.
pub fn parse_destination(typed: &str) -> Destination {
    let typed = typed.trim();
    // The same thing written as a URL, which is how a provider's console tends
    // to offer it.
    let typed = typed.strip_prefix("ssh://").unwrap_or(typed);

    let (user, rest) = match typed.split_once('@') {
        Some((user, rest)) if !user.is_empty() && !rest.is_empty() => {
            (Some(user.to_string()), rest)
        }
        _ => (None, typed),
    };

    let (host, port) = split_port(rest);

    Destination {
        user,
        host: host.to_string(),
        port,
    }
}

/// Split a trailing `:port`, leaving an IPv6 address intact.
fn split_port(rest: &str) -> (&str, Option<u16>) {
    // `[::1]:2222` is the one way to write an address and a port together
    // without ambiguity, so it is the one place brackets mean anything.
    if let Some(after) = rest.strip_prefix('[') {
        if let Some((address, tail)) = after.split_once(']') {
            return (address, tail.strip_prefix(':').and_then(|p| p.parse().ok()));
        }
    }

    // Elsewhere a colon is only a port when there is exactly one of them. An
    // IPv6 address written bare has several, and splitting on the first would
    // quietly hand back a truncated address.
    match rest.split_once(':') {
        Some((host, port)) if !port.contains(':') => match port.parse() {
            Ok(port) => (host, Some(port)),
            // Not a port, so it was never a separator. Keep what was typed.
            Err(_) => (rest, None),
        },
        _ => (rest, None),
    }
}

#[cfg(test)]
mod destination_tests {
    use super::*;

    #[test]
    fn a_bare_address_is_just_a_host() {
        assert_eq!(
            parse_destination("203.0.113.44"),
            Destination {
                user: None,
                host: "203.0.113.44".into(),
                port: None
            }
        );
    }

    #[test]
    fn a_pasted_destination_comes_apart() {
        assert_eq!(
            parse_destination("  root@203.0.113.44:2222  "),
            Destination {
                user: Some("root".into()),
                host: "203.0.113.44".into(),
                port: Some(2222)
            }
        );
        assert_eq!(
            parse_destination("ssh://root@fire-01").user.as_deref(),
            Some("root")
        );
    }

    #[test]
    fn a_name_from_the_ssh_config_survives_untouched() {
        // The whole point of leaving the user absent: that file may already say.
        let parsed = parse_destination("fire-01");
        assert_eq!(parsed.host, "fire-01");
        assert!(parsed.user.is_none() && parsed.port.is_none());
    }

    #[test]
    fn an_ipv6_address_is_not_mistaken_for_a_port() {
        // Splitting on the first colon here would store a different machine.
        assert_eq!(parse_destination("fe80::1").host, "fe80::1");
        assert_eq!(parse_destination("::1").host, "::1");

        let bracketed = parse_destination("root@[fe80::1]:2222");
        assert_eq!(bracketed.host, "fe80::1");
        assert_eq!(bracketed.port, Some(2222));
    }

    #[test]
    fn something_that_is_not_a_port_stays_part_of_the_host() {
        // Lossless: ssh gets what was typed and can say what's wrong with it.
        assert_eq!(
            parse_destination("fire-01:production").host,
            "fire-01:production"
        );
    }

    #[test]
    fn a_destination_is_assembled_from_the_parts() {
        let named = Compute::Server {
            host: "203.0.113.44".into(),
            user: Some("deploy".into()),
            port: None,
            identity_file: None,
            host_key: None,
            container: None,
        };
        assert_eq!(
            named.ssh_destination().as_deref(),
            Some("deploy@203.0.113.44")
        );

        let anonymous = Compute::Server {
            host: "fire-01".into(),
            user: None,
            port: None,
            identity_file: None,
            host_key: None,
            container: None,
        };
        assert_eq!(anonymous.ssh_destination().as_deref(), Some("fire-01"));

        // Nothing to dial, so there is nothing to assemble.
        assert!(Compute::Local.ssh_destination().is_none());
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
    /// Why it isn't answering, when it isn't. Cleared as soon as it does.
    #[serde(default)]
    pub diagnosis: Option<Diagnosis>,
    /// Whether we are still trying to reach it.
    ///
    /// A fact about the running control plane rather than about the host, so it
    /// is answered per request and never stored. Distinguishes a machine on its
    /// way back from one nobody is looking for.
    #[serde(default)]
    pub reconnecting: bool,
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

/// Why a connection didn't happen, in terms of what to do about it.
///
/// Each cause has a different fix, and the failure they arrive as — a closed
/// stream — distinguishes none of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub cause: Cause,
    /// One sentence, written for whoever is looking at the screen.
    pub summary: String,
    /// What to run, when there is something to run. Shown with a copy button,
    /// so it must be the whole command and nothing else.
    #[serde(default)]
    pub remedy: Option<String>,
    /// What the far end actually said, verbatim.
    ///
    /// Kept even when the cause is recognised: the summary is an inference
    /// about another machine, and this is what survives it being wrong.
    #[serde(default)]
    pub detail: Option<String>,
    pub at: chrono::DateTime<chrono::Utc>,
}

/// What went wrong, at the granularity of what fixes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum Cause {
    /// We got there, and there is no `firetower` to run.
    WorkerMissing,
    /// We got there, and there is no `docker` to run it with.
    DockerMissing,
    /// Docker is installed and this account may not talk to it.
    DockerDenied,
    /// Docker answered, and the container isn't running.
    ContainerMissing,
    /// The machine is there and refused us.
    AuthRefused,
    /// Nothing answered at that address.
    Unreachable,
    /// Something answered, and it isn't who it was last time.
    HostKeyChanged,
    /// It spoke, and we don't speak the same version.
    ProtocolMismatch,
    /// Unrecognised. `detail` carries the whole answer.
    Unknown,
}

impl Diagnosis {
    pub fn new(cause: Cause, summary: impl Into<String>) -> Self {
        Self {
            cause,
            summary: summary.into(),
            remedy: None,
            detail: None,
            at: chrono::Utc::now(),
        }
    }

    pub fn with_remedy(mut self, remedy: impl Into<String>) -> Self {
        self.remedy = Some(remedy.into());
        self
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        let detail = detail.trim();
        if !detail.is_empty() {
            self.detail = Some(detail.to_string());
        }
        self
    }
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

    /// Which of this agent's hooks Firetower wants to hear about.
    ///
    /// Empty for an agent with no hooks, and that is the honest answer rather
    /// than a gap: a session running Codex cannot be known to have stopped, so
    /// it should say so instead of showing a status that is a guess.
    pub fn hooks(&self) -> &'static [&'static str] {
        match self {
            Agent::ClaudeCode => &[
                // Blocked on a person: a permission prompt, an idle prompt, an
                // MCP server asking something.
                "Notification",
                "Elicitation",
                // The same block as a notification, with the detail attached:
                // which tool, and its arguments.
                "PermissionRequest",
                // Finished a turn, and what it finished with.
                "Stop",
                // The turn ended on an API error — a rate limit, an expired
                // credential. The case this product exists to route to you.
                "StopFailure",
                // Working again, without anybody having to guess. Both are
                // needed: answering a permission prompt is not submitting a
                // prompt, so only the tool call that follows says the agent
                // resumed.
                "UserPromptSubmit",
                "PreToolUse",
                // It exited. Currently invisible, which leaves a session
                // claiming to be working forever.
                "SessionEnd",
            ],
            // No hooks. See `status_for` — nothing will move these off
            // `Working` and the interface should admit that.
            Agent::Codex | Agent::Shell => &[],
        }
    }

    /// The file, under the agent's home, that its hooks are configured in.
    pub fn hooks_file(&self) -> Option<&'static str> {
        match self {
            Agent::ClaudeCode => Some(".claude/settings.json"),
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

/// What an agent's hooks tell Firetower.
///
/// The whole point of the product is knowing when an agent stopped being useful
/// without you, and the agent is the only thing that actually knows. Watching
/// its terminal is guesswork; a hook is the agent saying so.
pub mod hooks {
    use super::SessionStatus;

    /// The environment a hook needs to find its way home.
    ///
    /// Which session this is, and where the worker keeps its log. Set on the
    /// agent's process, and inherited by every hook it runs.
    pub const SESSION_ENV: &str = "FIRETOWER_SESSION";
    pub const ROOT_ENV: &str = "FIRETOWER_WORKER_ROOT";

    /// What a fired hook means for the session.
    ///
    /// `None` for the events we install but do not act on — they are worth
    /// having in the log without being worth a status.
    ///
    /// `notification_type` matters because `Notification` covers both "it wants
    /// permission" and "it just authenticated": one is you, the other is not.
    pub fn status_for(event: &str, notification_type: Option<&str>) -> Option<SessionStatus> {
        match event {
            // Blocked on a person. `agent_completed` arrives here too — it is
            // the agent saying it has nothing left to do, which in an inbox is
            // the same as your move.
            "Notification" => match notification_type {
                Some("auth_success") => None,
                Some("agent_completed") => Some(SessionStatus::HandedBack),
                // permission_prompt, idle_prompt, agent_needs_input,
                // elicitation_dialog, and anything added later: all of them
                // mean it is waiting on somebody.
                _ => Some(SessionStatus::NeedsYou),
            },

            // An MCP server asking a question mid-tool-call.
            "Elicitation" => Some(SessionStatus::NeedsYou),

            // Finished a turn. A resting state, not an end.
            "Stop" => Some(SessionStatus::HandedBack),

            // The turn ended on an API error — a rate limit, an expired
            // credential, a billing problem. Yours to deal with, and the one
            // the README promises to route to you.
            "StopFailure" => Some(SessionStatus::Failed),

            // You said something, so it is working again.
            "UserPromptSubmit" => Some(SessionStatus::Working),

            // And so is running a tool — which is the one that matters.
            //
            // Answering a permission prompt is not submitting a prompt, so
            // `UserPromptSubmit` never fires for it and a session that was
            // unblocked by pressing `1` stayed on `NeedsYou` while the agent
            // worked. A tool call is the first thing that happens afterwards,
            // whatever unblocked it.
            //
            // This fires on every tool call — hundreds a session — so it costs
            // nothing only because a report that changes nothing is dropped
            // before it is written. See the caller.
            "PreToolUse" => Some(SessionStatus::Working),

            // About to ask whether it may do something specific, which is the
            // same block as `Notification` with the detail attached.
            "PermissionRequest" => Some(SessionStatus::NeedsYou),

            // The agent exited. Not `Ended`: the workspace and the branch are
            // still there, and what to do with them is yours to decide.
            "SessionEnd" => Some(SessionStatus::HandedBack),

            _ => None,
        }
    }

    /// Where the agent's own words live, by event, most specific first.
    ///
    /// Each hook carries what it stopped for under a different key and none of
    /// them are guaranteed. The caller does the JSON — this crate describes
    /// the protocol and stays free of a parser.
    pub const NOTE_KEYS: &[&str] = &[
        "notification_message",   // Notification
        "last_assistant_message", // Stop, SubagentStop
        "error_message",          // StopFailure
        "elicitation_prompt",     // Elicitation
        "message",                // UserPromptSubmit
    ];

    /// What the agent wants to do, in a phrase.
    ///
    /// `Notification` says "Claude needs your permission" whatever it is
    /// asking, which tells you only that you are needed. `PermissionRequest`
    /// carries the tool and its arguments, so this can say what for.
    pub fn note_for_tool(tool: &str, detail: Option<&str>) -> String {
        let verb = match tool {
            "Bash" => "wants to run",
            "Edit" | "Write" | "NotebookEdit" => "wants to edit",
            "Read" => "wants to read",
            "WebFetch" => "wants to fetch",
            _ => "wants to use",
        };

        match detail.map(str::trim).filter(|d| !d.is_empty()) {
            Some(detail) => format!("{verb} {detail}"),
            // Better than nothing: the tool's name is still more than
            // "needs your permission".
            None => format!("{verb} {tool}"),
        }
    }

    /// Where the interesting part of a tool call lives, by tool.
    ///
    /// The caller does the JSON; this crate keeps the knowledge of which key
    /// matters without taking a parser as a dependency.
    pub const TOOL_DETAIL_KEYS: &[&str] = &["command", "file_path", "url", "path", "pattern"];

    /// One line for an inbox, out of whatever the agent said.
    ///
    /// The rest is in the terminal, one click away. A card that grows to fit a
    /// wall of text buries every other session on the screen.
    pub fn trim_note(text: &str) -> Option<String> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }

        const LIMIT: usize = 240;
        Some(match text.char_indices().nth(LIMIT) {
            None => text.to_string(),
            Some((cut, _)) => format!("{}…", text[..cut].trim_end()),
        })
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
    /// The trunk, once something has read the remote.
    ///
    /// Absent until then: a repository can be connected while no worker is
    /// reachable, and the first session to clone it fills this in.
    #[serde(default)]
    pub default_branch: Option<String>,
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
        /// Why, when whatever changed it knows.
        ///
        /// The agent's own words: the permission it is asking for, the last
        /// thing it said before finishing, the error that stopped it. Without
        /// this a blocked session is a red dot you have to open a terminal to
        /// understand, which is most of the cost of being interrupted.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
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

#[cfg(test)]
mod contract_tests {
    use super::*;
    use utoipa::PartialSchema;

    /// The contract has to name a field the way serde writes it.
    ///
    /// Nothing else checks this. The document is generated from these types, the
    /// client is generated from the document, and both steps succeed on a name
    /// that is simply wrong — so the first thing to notice is a value arriving
    /// as `undefined` in a browser, a long way from the cause.
    ///
    /// Worth having for tagged enums in particular, where the casing has to be
    /// asked for per variant: it is easy to add a fourth kind, give it a
    /// two-word field, and not know that only half the toolchain heard you.
    #[test]
    fn the_contract_names_fields_the_way_serde_writes_them() {
        let schema = serde_json::to_value(Compute::schema()).expect("the schema serialises");

        for kind in [
            Compute::Local,
            Compute::Container {
                image: "firetower/worker:dev".into(),
                name: "firetower-worker".into(),
            },
            Compute::Server {
                host: "203.0.113.44".into(),
                user: Some("root".into()),
                port: None,
                identity_file: None,
                host_key: None,
                container: None,
            },
        ] {
            let written = serde_json::to_value(&kind).expect("a kind serialises");
            let tag = written["type"].as_str().expect("every kind is tagged");

            let mut on_the_wire: Vec<&str> = written
                .as_object()
                .expect("a kind is an object")
                .keys()
                .map(String::as_str)
                .collect();
            on_the_wire.sort_unstable();

            let mut described = described_fields(&schema, tag);
            described.sort_unstable();

            assert_eq!(
                on_the_wire, described,
                "the contract and the wire disagree about {tag}"
            );
        }
    }

    /// The fields the schema gives one variant of a tagged enum.
    fn described_fields<'a>(schema: &'a serde_json::Value, tag: &str) -> Vec<&'a str> {
        let variants = schema["oneOf"]
            .as_array()
            .expect("a tagged enum is described as a choice of objects");

        let variant = variants
            .iter()
            .find(|variant| {
                variant["properties"]["type"]["enum"]
                    .as_array()
                    .is_some_and(|tags| tags.iter().any(|t| t == tag))
            })
            .unwrap_or_else(|| panic!("nothing in the schema is tagged {tag}"));

        variant["properties"]
            .as_object()
            .expect("a variant describes its fields")
            .keys()
            .map(String::as_str)
            .collect()
    }
}

#[cfg(test)]
mod hook_tests {
    use super::hooks::*;
    use super::SessionStatus;

    /// The one that was broken: answering a permission prompt is not
    /// submitting a prompt, so nothing said the agent had resumed and the
    /// session sat on `NeedsYou` while it worked.
    #[test]
    fn a_tool_call_means_the_agent_is_working_again() {
        assert_eq!(
            status_for("PreToolUse", None),
            Some(SessionStatus::Working),
            "whatever unblocked it, this is the first thing that happens after"
        );
    }

    #[test]
    fn the_notifications_that_mean_you_and_the_ones_that_do_not() {
        for kind in ["permission_prompt", "idle_prompt", "agent_needs_input"] {
            assert_eq!(
                status_for("Notification", Some(kind)),
                Some(SessionStatus::NeedsYou),
                "{kind}"
            );
        }

        assert_eq!(
            status_for("Notification", Some("auth_success")),
            None,
            "signing in is not somebody's move"
        );
        assert_eq!(
            status_for("Notification", Some("agent_completed")),
            Some(SessionStatus::HandedBack)
        );
    }

    #[test]
    fn an_api_error_is_yours_to_deal_with() {
        assert_eq!(status_for("StopFailure", None), Some(SessionStatus::Failed));
    }

    #[test]
    fn a_hook_we_do_not_act_on_changes_nothing() {
        assert_eq!(status_for("PostToolUse", None), None);
        assert_eq!(status_for("PreCompact", None), None);
    }

    /// "Claude needs your permission" tells you only that you are needed.
    #[test]
    fn a_tool_call_reads_as_what_it_wants_to_do() {
        assert_eq!(
            note_for_tool("Bash", Some("git push --force origin main")),
            "wants to run git push --force origin main"
        );
        assert_eq!(
            note_for_tool("Edit", Some("src/lib.rs")),
            "wants to edit src/lib.rs"
        );
        // No arguments is still more than "needs your permission".
        assert_eq!(note_for_tool("Bash", None), "wants to run Bash");
    }

    #[test]
    fn a_note_is_one_line_rather_than_a_transcript() {
        assert_eq!(trim_note("   "), None);
        assert_eq!(trim_note(" hello "), Some("hello".to_string()));

        let long = "x".repeat(400);
        let trimmed = trim_note(&long).unwrap();
        assert!(trimmed.len() < long.len());
        assert!(trimmed.ends_with('…'), "and says that it was cut");
    }
}

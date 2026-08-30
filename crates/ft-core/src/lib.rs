//! Domain types and the session state machine.
//!
//! This crate performs no I/O and has no async. Everything here is a value or a
//! pure function over values, which is what makes the state machine exhaustively
//! testable and reusable verbatim in a hosted control plane.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub mod codex;
pub mod controls;
pub mod dotenv;
mod ids;
pub mod normalise;
pub mod session;
mod status;
pub mod turn;

pub use ids::{HostId, OrgId, RepoId, SessionId, UserId, WorkspaceId};
pub use session::{
    sanitize_branch, slugify, title_from, workspace_name, NewSession, Session, Workspace,
    WorkspaceSize,
};
pub use status::{SessionStatus, TransitionError};
pub use turn::{ItemId, ItemKind, RequestId, TurnEvent, TurnId};

/// Which session a process is running inside.
///
/// Set on the agent and inherited by everything it starts, so a setup script or
/// a tool can tell. Named here rather than in the worker because both ends read
/// it.
pub const SESSION_ENV: &str = "FIRETOWER_SESSION";
/// Where the worker on this machine keeps its state.
pub const WORKER_ROOT_ENV: &str = "FIRETOWER_WORKER_ROOT";

/// Which agent runs inside a workspace.
///
/// Serialised as the variant name — see the wire conventions in the brief: a
/// field takes the consumer's casing, an enum value stays the symbol it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum Agent {
    ClaudeCode,
    Codex,
    /// A plain shell. Not offered — see [`Agent::all`].
    Shell,
}

impl Agent {
    /// Every kind Firetower offers, for screens that have to list them.
    ///
    /// [`Shell`] is not among them. It was a session that is only a shell,
    /// which the Shell tab on any session now does better — and since agents
    /// became things Firetower drives rather than types at, it has had no
    /// driver, so starting one has been refused for as long as the refusal has
    /// existed. Listing it offered something that could not happen.
    ///
    /// The variant stays: the worker still understands it, which is how the
    /// tests launch a workspace without launching anything that talks to a
    /// network, and a session row that already says `Shell` still decodes.
    ///
    /// [`Shell`]: Agent::Shell
    pub fn all() -> [Agent; 2] {
        [Agent::ClaudeCode, Agent::Codex]
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
    ///
    /// A bare name, resolved through `PATH` rather than an absolute path. That
    /// is what lets a machine's own install win over the one Firetower
    /// fetched: the ones we install are *appended* to `PATH`, so they answer
    /// only when nothing else does.
    pub fn command(&self) -> &'static str {
        match self {
            Agent::ClaudeCode => "claude",
            Agent::Codex => "codex",
            Agent::Shell => "bash",
        }
    }

    /// Where to get it, when the machine does not already have it.
    ///
    /// npm for both of these — not because they are JavaScript (neither is any
    /// more; both ship a native binary in a per-platform package) but because
    /// it is the channel their publishers actually support, it resolves the
    /// right build for the architecture, and the registry hands over a digest
    /// with the tarball so verifying costs nothing.
    ///
    /// `None` for a shell: every machine has one, and fetching it would be
    /// absurd.
    pub fn package(&self) -> Option<&'static str> {
        match self {
            Agent::ClaudeCode => Some("@anthropic-ai/claude-code"),
            Agent::Codex => Some("@openai/codex"),
            Agent::Shell => None,
        }
    }

    /// The command line for driving this agent through a structured protocol
    /// rather than a terminal.
    ///
    /// `None` means this agent has no such protocol here yet, and there is no
    /// longer another way: a session is refused before it is created rather
    /// than started as something nobody can watch.
    ///
    /// argv, not a shell line. There is no shell in the way — the daemon holds
    /// the pipes itself — so there is nothing to quote and nothing that could
    /// be made to run.
    ///
    /// Two flags are worth explaining because they are not obvious:
    ///
    /// - `--replay-user-messages` echoes our own turns back out, so the log the
    ///   worker keeps is the whole conversation rather than half of it.
    /// - `--session-id` fixes the identifier up front instead of learning it
    ///   afterwards, which is what makes a session resumable even if the first
    ///   thing that happens is a crash. [`Start::Resume`] is that promise being
    ///   collected: same identifier, `--resume` instead.
    ///
    /// `--bare` is deliberately absent. It skips hooks, skills, MCP servers and
    /// `CLAUDE.md` — everything that makes an agent useful in somebody's actual
    /// repository — and refuses to read a subscription login.
    pub fn launch_headless(
        &self,
        session_id: &str,
        asking: &Asking,
        start: Start,
    ) -> Option<Vec<String>> {
        let agent_session = agent_session_uuid(session_id);
        match self {
            Agent::ClaudeCode => {
                // The same name either way, and two different things to do with
                // it. `--session-id` means *begin one called this*, which is
                // right once and a refusal every time after — and the times
                // after are ordinary now: upgrading Firetower recreates the
                // container and every agent on it has to come back.
                let naming = match start {
                    Start::Fresh => "--session-id",
                    Start::Resume => "--resume",
                };
                let mut argv: Vec<String> = [
                    self.command(),
                    "-p",
                    "--input-format",
                    "stream-json",
                    "--output-format",
                    "stream-json",
                    "--include-partial-messages",
                    "--verbose",
                    "--replay-user-messages",
                    naming,
                    &agent_session,
                ]
                .iter()
                .map(|s| s.to_string())
                .collect();

                // The biggest one, asked for rather than inherited.
                //
                // Left to itself the CLI picks, and what it picks moves — a
                // machine configured for Opus was quietly running Sonnet,
                // because usage-based switching is a thing and nothing said so.
                // A session that takes an hour should not be run by whichever
                // model was cheapest at the moment it started.
                argv.extend(["--model".into(), BIGGEST.into()]);

                match asking {
                    // The agent stops and asks, and the question is routed to
                    // whoever is watching. This is the point of the whole
                    // arrangement, so it is the ordinary case.
                    //
                    // `auto` rather than `default`: a session here is unattended
                    // by construction, so an agent that stops to ask *may I run
                    // this* stops for somebody who is not there. A classifier
                    // takes the ordinary ones and everything else still reaches
                    // the person watching, which is the whole arrangement — it
                    // is who answers the easy ones that differs, not whether
                    // anybody is asked.
                    Asking::Ask { tool, config } => argv.extend([
                        "--permission-mode".into(),
                        "auto".into(),
                        "--permission-prompt-tool".into(),
                        tool.clone(),
                        "--mcp-config".into(),
                        config.clone(),
                    ]),
                    // Nothing can answer, so nothing may be asked. Narrower
                    // than the interactive default rather than wider: this
                    // approves edits, not commands.
                    Asking::CannotAsk => {
                        argv.extend(["--permission-mode".into(), "acceptEdits".into()])
                    }
                }
                Some(argv)
            }
            // No prompt on the command line, and no flags: an app-server is
            // told what to do over its own protocol rather than argv. What
            // Claude Code takes as switches — the model, how it may ask — is
            // in `thread/start` here, which is why this is so short.
            Agent::Codex => Some(vec![self.command().to_string(), "app-server".to_string()]),
            Agent::Shell => None,
        }
    }

    /// What to say to this agent the moment it is listening, before any work.
    ///
    /// Claude Code is handed the first prompt and starts; there is nothing to
    /// arrange. Codex needs a conversation opened first, and its prompt cannot
    /// go out until that has answered — so the prompt is not here, and the
    /// control plane sends it when the thread exists.
    pub fn opening(&self, prompt: &str, cwd: &str) -> Vec<serde_json::Value> {
        match self {
            Agent::ClaudeCode => {
                if prompt.trim().is_empty() {
                    Vec::new()
                } else {
                    vec![crate::turn::user_message(prompt)]
                }
            }
            Agent::Codex => crate::codex::opening(cwd),
            Agent::Shell => Vec::new(),
        }
    }

    /// Whether authenticating this one is even a question.
    pub fn needs_credential(&self) -> bool {
        !matches!(self, Agent::Shell)
    }

    /// Every variant, including the ones not offered.
    ///
    /// Reading a value back and offering a choice are different questions.
    /// A session started before [`Shell`] stopped being offered still says so
    /// in the database, and it has to keep decoding — dropping it from
    /// [`all`](Agent::all) must not turn an old row into an error.
    ///
    /// [`Shell`]: Agent::Shell
    pub fn every() -> [Agent; 3] {
        [Agent::ClaudeCode, Agent::Codex, Agent::Shell]
    }

    /// Parsed back from how it is stored and sent.
    pub fn from_name(name: &str) -> Option<Agent> {
        Agent::every()
            .into_iter()
            .find(|a| format!("{a:?}") == name)
    }

    /// Whether this agent can be driven through a protocol at all.
    ///
    /// The single question behind every choice that used to be a mode: which
    /// tab a session gets, whether it is watched or attached to, and whether
    /// it is asked to report on itself.
    pub fn speaks_a_protocol(&self) -> bool {
        self.launch_headless("probe", &Asking::CannotAsk, Start::Fresh)
            .is_some()
    }
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
/// Which private key ssh should offer when reaching a server.
///
/// This used to be one field, `identity_file`: a path on the machine running the
/// control plane. That was right while the control plane ran on the operator's
/// own machine, and stopped being right in a container — the path is read
/// inside the container, `~/.ssh/id_ed25519` names a file that exists on their
/// machine and not in this one, and no path they can type would bridge the two.
///
/// So a host now says *which* key rather than *where* it is, and only one of
/// these is still a path.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type")]
pub enum SshKey {
    /// Let ssh choose: the agent first, then the usual names in `~/.ssh`.
    ///
    /// The default, and what an absent `identity_file` used to mean. Still
    /// useful for a control plane running on a machine whose ssh is already
    /// configured — a development install, or a binary on a host.
    #[default]
    Default,
    /// The key Firetower made for itself, sealed in the vault.
    ///
    /// What a server added through the interface uses. Firetower holds this one
    /// because in a container there is no other way for it to hold anything:
    /// it is scoped to this installation, opens nothing else, and is revoked by
    /// deleting one line on one machine.
    Managed,
    /// A private key the operator pasted, sealed in the vault under this name.
    ///
    /// For an existing key they would rather reuse, or one signed by a CA.
    #[serde(rename_all = "camelCase")]
    Held { name: String },
    /// A path on the machine running the control plane.
    ///
    /// Still correct when that machine is not a container. Kept so that every
    /// host added before this existed keeps working and means what it did.
    #[serde(rename_all = "camelCase")]
    File { path: String },
}

impl SshKey {
    /// The path to hand `ssh -i`, when the answer is a path on this filesystem.
    ///
    /// `None` for [`SshKey::Default`], which is ssh's own business, and for the
    /// two the vault holds — those are written somewhere ssh can read them at
    /// the moment of connecting, and that is the transport's job rather than
    /// this type's.
    pub fn path(&self) -> Option<&str> {
        match self {
            SshKey::File { path } => Some(path),
            _ => None,
        }
    }

    /// Whether the key comes out of the vault.
    pub fn is_held(&self) -> bool {
        matches!(self, SshKey::Managed | SshKey::Held { .. })
    }
}

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
        /// Which key to authenticate with. See [`SshKey`].
        #[serde(default)]
        key: SshKey,
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
            key: SshKey::Default,
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
            key: SshKey::Default,
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

impl Cause {
    /// Whether ssh got onto the machine.
    ///
    /// The line adding a host now has to draw. A machine that answered and has
    /// no worker on it is worth keeping — ssh works, the address and the account
    /// and the key are all right, and what is left is a command to run over
    /// there. A machine that never answered is not: nothing about it has been
    /// confirmed, and saving it means saving a guess.
    ///
    /// `Unknown` counts as not reached. It is the bucket for output nobody
    /// recognised, and the safe reading of "we do not know what happened" is
    /// that it did not.
    pub fn reached_the_machine(&self) -> bool {
        match self {
            // ssh got in, and what it found on the other side was wrong.
            Cause::WorkerMissing
            | Cause::DockerMissing
            | Cause::DockerDenied
            | Cause::ContainerMissing
            | Cause::ProtocolMismatch => true,

            // ssh never got in, or refused to.
            Cause::AuthRefused | Cause::Unreachable | Cause::HostKeyChanged | Cause::Unknown => {
                false
            }
        }
    }
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

/// The model a session runs unless somebody changes it.
///
/// The flagship, with the long context window. Sessions here are unattended and
/// often long, which is exactly the shape of work that a smaller model does
/// worse and that runs out of room.
///
/// Changeable per session — see the composer — so this is a starting point
/// rather than a policy.
pub const BIGGEST: &str = "opus[1m]";

/// Whether this agent is beginning a conversation or picking one back up.
///
/// A session outlives the process running it. The worktree, the branch and
/// everything said so far are on the volume; the agent is a child process with
/// a socket in `/tmp`, and recreating the container to upgrade Firetower ends
/// every one of them. Coming back has to be ordinary, so which of the two this
/// is has to be said rather than assumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Start {
    /// Nothing has run under this session id before.
    Fresh,
    /// It has, and its conversation is still on disk.
    Resume,
}

/// Whether there is anybody to answer a permission prompt.
///
/// An agent that asks a question nobody can hear is worse than one that was
/// never allowed to ask: it waits, and the session looks hung. So the two are
/// one decision, made once, rather than a flag that can be set without the
/// machinery behind it.
#[derive(Debug, Clone)]
pub enum Asking {
    /// Route questions through this tool, configured by this file.
    Ask { tool: String, config: String },
    /// Approve what can be approved without asking, and refuse the rest.
    CannotAsk,
}

/// The identifier an agent is told to call its own session.
///
/// Firetower names sessions with a ULID, so `s_01k…` — and Claude Code will not
/// accept that: it wants a UUID and refuses to start otherwise, which is the
/// kind of thing only a real session tells you.
///
/// Derived from the Firetower id rather than generated, so it is the same every
/// time. That is what lets a session be resumed without having stored anything:
/// the name is recomputed, not remembered.
///
/// Not a UUIDv5 — that is defined over SHA-1 and this is SHA-256 — so it is
/// stamped as version 8, which is the one reserved for exactly this.
pub fn agent_session_uuid(session_id: &str) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::new()
        .chain_update(b"firetower/agent-session/")
        .chain_update(session_id.as_bytes())
        .finalize();

    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // Version 8, custom.
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    // Variant 1, the usual one.
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
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

    /// Whether this one signs a machine in rather than handing you a token.
    ///
    /// The other half of [`token_setup`](Agent::token_setup), and deliberately
    /// not its negation: an agent could offer both, or neither. Codex has no
    /// command that prints a credential, so the only way to get one is to let a
    /// machine ask for it and approve that from a browser.
    ///
    /// Separate from [`speaks_a_protocol`](Agent::speaks_a_protocol) because
    /// they answer different questions. Signing in is worth offering before
    /// there is a driver to use it — it is the longer half of the setup, and
    /// nothing about it depends on being able to start a session yet.
    pub fn signs_in_with_a_code(&self) -> bool {
        matches!(self, Agent::Codex)
    }

    /// The file this agent keeps its credential in, for the ones that use a
    /// file rather than a variable.
    ///
    /// Relative to the agent's own directory — see
    /// [`home_var`](Agent::home_var), which is how it is told where that is.
    /// A file rather than a variable is not a worse arrangement, only a
    /// different one: it still travels from the vault per session and is still
    /// gone when the workspace is.
    pub fn credential_file(&self) -> Option<&'static str> {
        match self {
            Agent::Codex => Some("auth.json"),
            Agent::ClaudeCode | Agent::Shell => None,
        }
    }

    /// The variable that points this agent at a directory of its own.
    ///
    /// Given one per session, so that what an agent writes about one session —
    /// its credential above all — cannot be read by the next.
    pub fn home_var(&self) -> Option<&'static str> {
        match self {
            Agent::Codex => Some("CODEX_HOME"),
            Agent::ClaudeCode | Agent::Shell => None,
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
    /// Where to write this repository's variables in the workspace.
    ///
    /// Absent for most: the environment is enough for anything that reads
    /// `process.env`. Present — usually `.env` — for tooling that only reads
    /// files, and then it is written before setup runs and excluded from git.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_file: Option<String>,
    /// The names of the variables held for it, never the values.
    ///
    /// Derived per request from the vault rather than stored, so that a screen
    /// can say what a session will bring without opening anything.
    #[serde(default)]
    pub env: Vec<String>,
}

/// One thing in a workspace directory.
///
/// Enough to draw a row and decide what to do with it, and nothing about where
/// it is: paths are the caller's, resolved against the workspace on the machine
/// that holds it.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub directory: bool,
    /// Zero for a directory — counting what is inside would mean walking it.
    pub size: u64,
    pub modified: Option<chrono::DateTime<chrono::Utc>>,
    /// Shown, never followed. A repository can contain a link to `/`, and a
    /// listing that followed one would be a file browser for the whole machine.
    pub link: bool,
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
    /// Commits on this branch that its base does not have.
    ///
    /// Not the same question as `ahead`, which switches to measuring against
    /// the upstream the moment a branch is pushed — so a pushed branch holding
    /// nothing reports `ahead: 0` and looks ready to open a pull request from.
    /// This is what says there is something to open one *for*.
    ///
    /// `None` from a worker too old to answer, which is not the same as zero
    /// and must not be drawn as it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commits: Option<u32>,
}

/// One checkout's summary, and which checkout it is.
///
/// A session holds any number of them, so a summary on its own no longer says
/// what it is a summary *of*.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutSummary {
    /// Relative to the workspace. Empty means the checkout is the workspace.
    #[serde(default)]
    pub path: String,
    pub slug: String,
    #[serde(flatten)]
    pub summary: WorkSummary,
}

/// A checkout, what is unsaved in it, and where its pull request went.
///
/// What the interface reads to say the next honest thing — per repository, and
/// aggregated across them for the one button in the header.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutWork {
    #[serde(default)]
    pub path: String,
    pub slug: String,
    pub branch: String,
    pub base: String,
    pub uncommitted: u32,
    pub ahead: u32,
    pub pushed: bool,
    /// Commits on this branch that its base does not have. See
    /// [`WorkSummary::commits`]; `None` means the worker did not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commits: Option<u32>,
    /// Where its pull request is, once it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<String>,
    /// Why this repository is not checked out, when it is not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trouble: Option<String>,
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
        /// Which repository, when a session has more than one.
        ///
        /// Absent from a worker that predates a session holding more than one,
        /// and from a session that holds exactly one — in both cases there is
        /// nothing to disambiguate.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repo: Option<String>,
        /// The name asked for, when it is not the name granted.
        ///
        /// Two sessions started from the same prompt want the same branch, so
        /// the second is numbered. That is worth saying: the branch is what a
        /// pull request is opened from, and finding out it was renamed by
        /// reading the pull request is finding out too late.
        ///
        /// Renamed explicitly: this enum carries no `rename_all`, and every
        /// other field in it happens to be one word, so it is the first that
        /// would otherwise have reached the API as snake_case.
        #[serde(rename = "askedFor", default, skip_serializing_if = "Option::is_none")]
        asked_for: Option<String>,
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
                repo: None,
                asked_for: None,
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
    fn a_session_started_on_a_shell_still_decodes() {
        // Shell is no longer offered, and rows that already say so must keep
        // reading. Dropping it from the list of choices is not the same as
        // dropping it from the vocabulary.
        assert_eq!(Agent::from_name("Shell"), Some(Agent::Shell));
        assert!(!Agent::all().contains(&Agent::Shell));
        assert!(Agent::every().contains(&Agent::Shell));
    }

    /// Both of the agents on offer can be driven. Nothing else can be started
    /// at all now, so this is the whole of what "supported" means.
    #[test]
    fn everything_offered_speaks_a_protocol() {
        for agent in Agent::all() {
            assert!(agent.speaks_a_protocol(), "{agent:?} cannot be driven");
        }
        assert!(!Agent::Shell.speaks_a_protocol());
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
                key: SshKey::Default,
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
mod ssh_key_tests {
    use super::*;

    /// What the migration writes has to be what this reads. They are two
    /// different pieces of code agreeing about a shape, which is exactly the
    /// kind of agreement that rots quietly.
    #[test]
    fn the_shapes_the_migration_writes_are_the_ones_we_read() {
        let file: Compute = serde_json::from_str(
            r#"{"type":"Server","host":"fire-01","user":"deploy",
                "key":{"type":"File","path":"~/.ssh/fire"},
                "container":"firetower-worker"}"#,
        )
        .unwrap();

        let Compute::Server { key, .. } = &file else {
            panic!("not a server")
        };
        assert_eq!(key.path(), Some("~/.ssh/fire"));
        assert!(!key.is_held());

        let default: Compute =
            serde_json::from_str(r#"{"type":"Server","host":"fire-02","key":{"type":"Default"}}"#)
                .unwrap();
        let Compute::Server { key, .. } = &default else {
            panic!("not a server")
        };
        assert_eq!(*key, SshKey::Default);
    }

    /// A row written before the `key` field existed, in case one survives the
    /// migration — a host added by a replica mid-upgrade, say. Absent has always
    /// meant "ssh decides", and it still does.
    #[test]
    fn a_row_with_no_key_at_all_still_reads() {
        let old: Compute = serde_json::from_str(r#"{"type":"Server","host":"fire-03"}"#).unwrap();
        let Compute::Server { key, .. } = &old else {
            panic!("not a server")
        };
        assert_eq!(*key, SshKey::Default);
    }

    /// Only the vault-held kinds ask the vault for anything.
    #[test]
    fn which_kinds_need_the_vault() {
        assert!(SshKey::Managed.is_held());
        assert!(SshKey::Held { name: "ci".into() }.is_held());
        assert!(!SshKey::Default.is_held());
        assert!(!SshKey::File { path: "/k".into() }.is_held());
    }
}

#[cfg(test)]
mod reachability_tests {
    use super::*;

    /// Adding a host turns on this distinction, so it is worth stating
    /// case by case rather than trusting a match arm to stay right.
    #[test]
    fn what_counts_as_having_reached_the_machine() {
        // ssh worked; the far side is missing something.
        assert!(Cause::WorkerMissing.reached_the_machine());
        assert!(Cause::DockerMissing.reached_the_machine());
        assert!(Cause::DockerDenied.reached_the_machine());
        assert!(Cause::ContainerMissing.reached_the_machine());
        assert!(Cause::ProtocolMismatch.reached_the_machine());

        // ssh did not.
        assert!(!Cause::AuthRefused.reached_the_machine());
        assert!(!Cause::Unreachable.reached_the_machine());
        assert!(!Cause::HostKeyChanged.reached_the_machine());

        // And the bucket for output nobody recognised, which is not evidence
        // of anything.
        assert!(!Cause::Unknown.reached_the_machine());
    }
}

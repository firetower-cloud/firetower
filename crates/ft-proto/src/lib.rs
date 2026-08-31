//! The wire protocol between the control plane and a worker.
//!
//! Frames travel over any bidirectional byte stream. The worker never opens a
//! port and cannot tell whether the far end is a local pipe, an SSH tunnel, or
//! a websocket — that's what lets the same daemon serve a laptop today and a
//! hosted control plane later.
//!
//! Encoding is newline-delimited JSON: debuggable with `tee`, and behind
//! [`Codec`] so a compact binary format is a later swap rather than a rewrite.

use ft_core::{Agent, AgentPresence, EventKind, SessionId, WorkspaceSize};
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
///
/// 10 — a session holds any number of repositories. `CreateWorkspace.repo`
/// became `repos`, each carrying the setup, environment file and credential
/// that used to sit beside it; and the git actions name which checkout they
/// mean. An older worker would read a two-repository session as none at all.
///
/// 11 — a workspace can be searched by filename. An older worker has no
/// `FindFiles` and would fail to read the frame asking for one, taking the
/// connection down with it rather than answering "I can't".
///
/// 12 — raw TCP travels over this connection, so a port a session is serving
/// on can be reached without anything listening on the machine it runs on. An
/// older worker cannot read `TunnelOpen`, and a preview against one would take
/// the connection down rather than answering "I can't".
pub const PROTOCOL_VERSION: u32 = 12;

mod codec;
pub use codec::{Codec, CodecError, FrameReader, FrameWriter};

mod base64;
pub use base64::{decode, encode};

/// Correlates a request with its reply.
///
/// Most frames are one-way and correlate on `session_id`. Probing a remote has
/// no session yet, so it carries its own id.
pub type ReqId = String;

/// Correlates the two ends of one tunnel.
///
/// A ULID from the same mint as [`ReqId`], and held in the same map: a tunnel
/// is a request whose answer arrives in pieces and does not stop, which is what
/// a file download already was.
pub type TunnelId = String;

/// base64 bytes travelling through a tunnel.
///
/// A newtype for one reason: frames are logged, and what goes through a tunnel
/// is somebody's application — its pages, its cookies, its `Authorization`
/// headers. Deriving `Debug` on the enum would print all of it. This prints how
/// much there was, which is the only part of it a log has any business knowing.
#[derive(Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Payload(pub String);

impl std::fmt::Debug for Payload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "<{} base64 bytes>", self.0.len())
    }
}

impl Payload {
    pub fn of(bytes: &[u8]) -> Self {
        Self(encode(bytes))
    }

    pub fn bytes(&self) -> Option<Vec<u8>> {
        decode(&self.0)
    }
}

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
    /// Files in a session's workspace whose path matches a query.
    ///
    /// Separate from [`ToWorker::ListFiles`] because it answers a different
    /// question: not "what is in here" but "where is the thing called this",
    /// which needs the whole workspace rather than one directory of it.
    FindFiles {
        req: ReqId,
        session_id: SessionId,
        /// What somebody typed. Matched loosely against the whole path.
        query: String,
        /// The most paths worth sending back. Nobody reads past the first few.
        limit: usize,
    },
    /// Send a file back, in pieces.
    ReadFile {
        req: ReqId,
        session_id: SessionId,
        path: String,
    },
    /// Open a TCP connection to a port this session is serving on.
    ///
    /// A port and nothing else. Never a host: the worker connects to
    /// `127.0.0.1` and only ever to `127.0.0.1`, so a mistake in a URL
    /// upstream cannot turn a worker into a gateway into the machine's private
    /// network. That is a one-line property and it is worth keeping unarguable.
    TunnelOpen {
        tunnel: TunnelId,
        session_id: SessionId,
        port: u16,
    },
    /// Bytes for an open tunnel, in order.
    TunnelData {
        tunnel: TunnelId,
        data: Payload,
    },
    /// Done with this tunnel, in one of the two senses.
    ///
    /// `half` is the end of a request body: nothing more is coming from this
    /// end, but the far end still has an answer to finish writing. Without it
    /// a server that reads to end-of-input never replies.
    ///
    /// Not `half` is a hang-up — the browser navigated away — and the worker
    /// drops the socket.
    TunnelClose {
        tunnel: TunnelId,
        half: bool,
    },
    /// The worker may send this many more bytes down this tunnel.
    ///
    /// Without this, a page load of a dev server's unbundled modules arrives
    /// faster than a browser drains it, and the frames pile up in the control
    /// plane's memory — or block the one loop that also carries every terminal
    /// on this host. With it, a worker out of credit stops reading its socket
    /// and the dev server feels the backpressure through TCP, where it belongs.
    TunnelCredit {
        tunnel: TunnelId,
        bytes: u32,
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
    /// Fetch an agent onto this host, or replace it with another version.
    ///
    /// Asked of the worker because the install lands on that machine's own
    /// volume — under `agents/<kind>/<version>/` — and only the machine can
    /// say what npm resolved to. Nothing here touches a credential: what an
    /// agent authenticates with stays with the control plane and is handed
    /// over per session.
    InstallAgent {
        req: ReqId,
        kind: Agent,
        /// The newest published one when nobody says.
        version: Option<String>,
    },
    /// Sign Codex in on this host, using a device code.
    ///
    /// Asked of the worker because the machine that will run the agent is the
    /// machine that has to be signed in: OpenAI hands the credential to
    /// whoever asked for the code, and nothing about it travels through a
    /// browser or through us on the way there.
    ///
    /// Answered twice — [`ToServer::CodexLoginPending`] with the code to show,
    /// then [`ToServer::CodexLoginFinished`] whenever somebody gets around to
    /// approving it.
    /// Start another agent in a workspace that is already there.
    ///
    /// Separate from [`CreateWorkspace`] rather than a flag on it: they share a
    /// launch and nothing else, and a worker that received one meaning the
    /// other would clone over a checkout somebody is working in.
    StartAgent(Box<StartAgent>),
    CodexLoginStart {
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
        /// Which checkout, by its path inside the workspace. Empty means the
        /// workspace itself, which is what a single-repo session is.
        #[serde(default)]
        checkout: String,
        message: String,
        /// Which files to include. Empty means all of them.
        ///
        /// Sent rather than assumed, because the review sheet lets somebody
        /// untick one and an agent often touches a file that was never the
        /// point — a lockfile, a scratch note.
        #[serde(default)]
        paths: Vec<String>,
        /// Who to record as the author.
        ///
        /// Sent per commit rather than configured on the machine: a worker is
        /// shared by every session on a host, and the person a commit belongs
        /// to is a fact about the session, not about the container.
        ///
        /// Absent from a control plane too old to send one, which the worker
        /// answers with an identity of its own rather than the failure git
        /// gives a container with no `user.email` anywhere.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        author: Option<Author>,
    },
    Push {
        #[serde(default)]
        checkout: String,
    },
    /// Everything one checkout changed, as a unified diff.
    Diff {
        #[serde(default)]
        checkout: String,
    },
    /// Put a file somebody handed over into the workspace, and say where it
    /// landed.
    ///
    /// For everything that is not a picture. A picture goes inside the message,
    /// because the model looks at it; anything else is better as a file the
    /// agent can read, grep, unzip or edit with the tools it already has — and
    /// it costs no context until it actually does.
    Attach {
        /// What it was called. Only the last part is used, and it is scrubbed.
        name: String,
        /// base64
        data: String,
    },
    /// What the agent would call this work: a title and a body, for a commit
    /// message and a pull request.
    ///
    /// Runs on the host, where the code is — the control plane never sees the
    /// diff and needs no model credentials of its own.
    Describe,
    /// Check another repository into a session that is already running.
    ///
    /// The same work as bring-up, done once more: fetch, cut the worktree, and
    /// say where it landed. The agent is told afterwards, because an agent that
    /// is not told has no reason to look.
    AddRepo {
        repo: Box<RepoSpec>,
        /// What its setup script should run with. Resolved by the control
        /// plane, like the environment a session starts with, and not kept
        /// anywhere on the worker.
        #[serde(default)]
        env: Vec<(String, String)>,
    },
}

/// Everything a worker needs to build a workspace. No control-plane concepts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWorkspace {
    pub session_id: SessionId,
    /// What to check out, in order. Empty for a bare agent: make a directory,
    /// start the agent, clone nothing.
    ///
    /// Everything about a checkout lives inside its own spec, so that adding a
    /// second repository adds an element rather than a parallel set of fields.
    #[serde(default)]
    pub repos: Vec<RepoSpec>,
    /// Directory name for the worktree. Readable, so someone on the host can
    /// tell what they're looking at.
    pub workspace: String,
    pub prompt: String,
    pub agent: Agent,
    pub size: WorkspaceSize,
    /// Injected into the workspace environment. Secrets are already resolved.
    ///
    /// Everything every checkout brings, plus the agent's own. What belongs in
    /// a *file* is per repository and lives on its spec.
    pub env: Vec<(String, String)>,
    /// Files to write into the agent's own directory, by relative path.
    ///
    /// Some agents authenticate with a file rather than a variable, and a
    /// credential is still a credential: written 0600 into a directory made
    /// for this session alone, and destroyed with the workspace. The control
    /// plane's copy stays the only durable one.
    ///
    /// Defaulted so a worker from before this understands a frame that has it,
    /// and writes nothing.
    #[serde(default)]
    pub agent_home: Vec<(String, String)>,
}

/// Another agent, in a workspace that already exists.
///
/// A workspace is a place and a session is the work done in it, so a second
/// agent is a second session sharing one directory. Everything that made the
/// place — the clone, the worktree, the setup script — has already happened and
/// must not happen again; this is the launch on its own.
///
/// It carries its own `session_id`, which is what keeps the two apart on the
/// host: the agent's socket and its tmux session are both named from it, so two
/// runs get two of each without anything being invented for them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartAgent {
    /// The new run. Not the workspace's first session.
    pub session_id: SessionId,
    /// The directory the workspace already occupies, by name.
    ///
    /// Sent rather than looked up from a sibling session: the control plane
    /// knows which workspace this is, and a worker that had to search its own
    /// records for "some other session in the same place" could find one that
    /// has since been torn down.
    pub workspace: String,
    /// What to ask for first. Empty means the agent comes up idle.
    #[serde(default)]
    pub prompt: String,
    pub agent: Agent,
    /// The workspace's own facts, repeated for this run's record of them.
    ///
    /// A worker keeps a row per session and every event it stores points at
    /// one, so a second agent needs its own — and what it says about the branch
    /// and the repository is what the workspace says, because it is working in
    /// the workspace.
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub size: WorkspaceSize,
    pub env: Vec<(String, String)>,
    #[serde(default)]
    pub agent_home: Vec<(String, String)>,
}

/// Who a commit belongs to.
///
/// Not a credential: this is what goes in the log for everyone to read, and it
/// is public the moment the branch is pushed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Author {
    pub name: String,
    pub email: String,
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
    /// Where it goes inside the workspace.
    ///
    /// Empty means the checkout *is* the workspace, which is how a session made
    /// before a session could hold more than one is laid out — a worker asked
    /// to rebuild one of those must not move it.
    #[serde(default)]
    pub path: String,
    /// This repository's own setup command, run inside this checkout.
    ///
    /// Here rather than beside the workspace because setup belongs to a
    /// repository: two of them have two, and each wants to run where its own
    /// package file is.
    #[serde(default)]
    pub setup: Option<String>,
    /// A file to write inside this checkout before its setup runs.
    ///
    /// Inside the checkout, not the workspace: `.env` is read by the tooling of
    /// the repository it belongs to, and two repositories both wanting `.env`
    /// at the workspace root would be one file with the wrong contents.
    #[serde(default)]
    pub env_file: Option<EnvFile>,
    /// For the clone, and held in memory for this checkout's later pushes.
    #[serde(default)]
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
    /// Nothing more is coming from this agent. It has exited.
    AgentClosed {
        session_id: SessionId,
    },
    /// The worker stopped following this agent, but the agent is still there.
    ///
    /// Distinct from `AgentClosed`, which used to carry both meanings — and
    /// the second one is a lie that costs a conversation. A watcher can die on
    /// its own (its socket read fails, its stream ends) while the agent carries
    /// on writing to its log; reporting that as the agent closing tore down the
    /// broadcast, and every reader of that conversation stopped mid-word while
    /// the answer went on being written.
    AgentUnwatched {
        session_id: SessionId,
    },
    /// The answer to [`ToWorker::ListFiles`].
    Listed {
        req: ReqId,
        result: Result<Vec<ft_core::FileEntry>, String>,
    },
    /// The answer to [`ToWorker::FindFiles`], best match first.
    Found {
        req: ReqId,
        result: Result<Vec<String>, String>,
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
    /// Whether a [`ToWorker::TunnelOpen`] connected, and if not, why not.
    ///
    /// Separate from the bytes for the same reason [`ToServer::FileOpened`] is:
    /// the control plane has to answer a browser before it has a body, and
    /// "nothing is listening on 3000" is a sentence somebody can act on rather
    /// than a page that never loads.
    TunnelOpened {
        tunnel: TunnelId,
        result: Result<(), String>,
    },
    /// Bytes from an open tunnel, in order.
    TunnelData {
        tunnel: TunnelId,
        data: Payload,
    },
    /// The far end is done, or gone. No more bytes under this id.
    TunnelClosed {
        tunnel: TunnelId,
        reason: Option<String>,
    },
    /// The control plane may send this many more bytes down this tunnel.
    ///
    /// The mirror of [`ToWorker::TunnelCredit`], and load-bearing for a
    /// different reason: without it a request body the far end is slow to read
    /// would either pile up in the worker's memory or stop the one loop that
    /// serves every session on the machine.
    TunnelCredit {
        tunnel: TunnelId,
        bytes: u32,
    },
    /// How a [`ToWorker::RunAction`] ended.
    ActionDone {
        req: ReqId,
        result: Result<String, String>,
    },
    /// The answer to [`ToWorker::Summarize`].
    Summarized {
        req: ReqId,
        /// One per checkout. A session holds any number of them.
        summaries: Vec<ft_core::CheckoutSummary>,
    },
    /// The answer to [`ToWorker::ProbeAgents`].
    AgentsProbed {
        req: ReqId,
        agents: Vec<AgentPresence>,
    },
    /// The answer to [`ToWorker::InstallAgent`]: the version that landed, or
    /// why none did.
    ///
    /// The version comes back rather than being assumed, because `@latest`
    /// does not say what it resolved to and the directory is named for the
    /// answer.
    AgentInstalled {
        req: ReqId,
        result: Result<String, String>,
    },
    /// The code to show for a [`ToWorker::CodexLoginStart`], or why there is
    /// none.
    CodexLoginPending {
        req: ReqId,
        result: Result<CodexPending, String>,
    },
    /// How that sign-in ended: the credential Codex was given, or why not.
    ///
    /// Minutes after the code, because that is how long a person takes.
    CodexLoginFinished {
        req: ReqId,
        /// The contents of `auth.json`, as Codex wrote it.
        result: Result<String, String>,
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

/// A device code somebody has to approve before Codex is signed in.
///
/// The two things worth showing and nothing else: this is what a person reads
/// off a screen and types somewhere else.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexPending {
    /// The short code. Shown, not clicked.
    pub user_code: String,
    /// Where to type it.
    pub verification_url: String,
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

    /// A second agent survives the wire.
    ///
    /// `ToWorker` is internally tagged, and an internally-tagged newtype
    /// variant only works when what it wraps serialises as a map. That is true
    /// of a struct and quietly false of most other things, so it is worth
    /// asserting rather than assuming.
    #[test]
    fn starting_another_agent_round_trips() {
        let frame = ToWorker::StartAgent(Box::new(StartAgent {
            session_id: SessionId::from_stored("s_second".to_string()),
            workspace: "agent-auth-refactor-wheped1g".into(),
            prompt: String::new(),
            agent: Agent::Codex,
            title: "Auth refactor".into(),
            repo: Some("acme/backend".into()),
            branch: Some("agent/auth-refactor".into()),
            base: Some("main".into()),
            size: WorkspaceSize::Medium,
            env: vec![("KEY".into(), "value".into())],
            agent_home: Vec::new(),
        }));

        let wire = serde_json::to_string(&frame).expect("encoding");
        assert!(wire.contains("\"frame\":\"StartAgent\""), "{wire}");

        let back: ToWorker = serde_json::from_str(&wire).expect("decoding");
        match back {
            ToWorker::StartAgent(spec) => {
                assert_eq!(spec.workspace, "agent-auth-refactor-wheped1g");
                assert_eq!(spec.agent, Agent::Codex);
                assert!(spec.prompt.is_empty());
            }
            other => panic!("came back as {other:?}"),
        }
    }

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
    fn a_tunnel_round_trips_in_both_directions() {
        let out = ToWorker::TunnelOpen {
            tunnel: "t_1".into(),
            session_id: SessionId::from_stored("s_abc"),
            port: 3000,
        };
        let back: ToWorker = serde_json::from_str(&serde_json::to_string(&out).unwrap()).unwrap();
        assert!(matches!(back, ToWorker::TunnelOpen { port: 3000, .. }));

        let out = ToWorker::TunnelData {
            tunnel: "t_1".into(),
            data: Payload::of(b"GET / HTTP/1.1\r\n"),
        };
        let back: ToWorker = serde_json::from_str(&serde_json::to_string(&out).unwrap()).unwrap();
        match back {
            ToWorker::TunnelData { data, .. } => {
                assert_eq!(data.bytes().unwrap(), b"GET / HTTP/1.1\r\n")
            }
            other => panic!("{other:?}"),
        }

        for frame in [
            ToWorker::TunnelClose {
                tunnel: "t_1".into(),
                half: true,
            },
            ToWorker::TunnelCredit {
                tunnel: "t_1".into(),
                bytes: 65536,
            },
        ] {
            let json = serde_json::to_string(&frame).unwrap();
            serde_json::from_str::<ToWorker>(&json).unwrap();
        }

        for frame in [
            ToServer::TunnelOpened {
                tunnel: "t_1".into(),
                result: Ok(()),
            },
            ToServer::TunnelOpened {
                tunnel: "t_1".into(),
                result: Err("nothing is listening on 3000".into()),
            },
            ToServer::TunnelData {
                tunnel: "t_1".into(),
                data: Payload::of(b"HTTP/1.1 200 OK"),
            },
            ToServer::TunnelClosed {
                tunnel: "t_1".into(),
                reason: None,
            },
            ToServer::TunnelCredit {
                tunnel: "t_1".into(),
                bytes: 65536,
            },
        ] {
            let json = serde_json::to_string(&frame).unwrap();
            serde_json::from_str::<ToServer>(&json).unwrap();
        }
    }

    /// What goes through a tunnel is somebody's application, headers and all.
    #[test]
    fn a_tunnels_bytes_are_not_in_the_log() {
        let frame = ToWorker::TunnelData {
            tunnel: "t_1".into(),
            data: Payload::of(b"Cookie: session=averyrealsecret"),
        };
        let shown = format!("{frame:?}");
        assert!(!shown.contains("averyrealsecret"), "{shown}");
        // base64 of the same string, in case it is printed undecoded.
        assert!(!shown.contains(&encode(b"averyrealsecret")), "{shown}");
        assert!(shown.contains("base64 bytes"), "{shown}");
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

//! Live connections to workers.
//!
//! One task per host owns that host's stream and is the only thing that touches
//! it. Everything else asks the fleet to send a frame and reads the results out
//! of the database, which keeps the concurrency story to a single rule: frames
//! in and out of a worker are serialised by its own task.

use crate::db::Db;
use anyhow::{Context, Result};
use ft_core::SessionStatus;
use ft_core::{AgentPresence, CheckoutSummary, Event, HostId, SessionId};
use ft_proto::{
    decode, encode, Codec, CodecError, Credential, ProbeFailure, Pty, RemoteInfo, ReqId, ToServer,
    ToWorker, PROTOCOL_VERSION,
};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, oneshot, RwLock};

/// Long enough for a cold network, short enough that nobody watches a spinner
/// forever. The worker gives up before this, so hitting it means the worker
/// itself stopped answering.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// How often to provoke an answer when nothing else is being said.
const HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(20);

/// How long a worker may say nothing at all before the connection is treated as
/// dead. Comfortably more than two heartbeats, so one lost frame is not enough.
const SILENCE: std::time::Duration = std::time::Duration::from_secs(50);

/// The longest gap between attempts to reach a host.
///
/// The cap matters more than the growth: a machine that comes back should be
/// noticed within a minute, and one that is genuinely gone shouldn't be
/// hammered.
const RETRY_CAP: std::time::Duration = std::time::Duration::from_secs(60);

/// The shortest gap when the last failure was something a human has to fix.
///
/// A refused key or a changed host key will not resolve itself, so there is
/// nothing to gain by asking every second — but we keep asking, because the
/// human may well be fixing it right now.
const RETRY_FLOOR_HUMAN: std::time::Duration = std::time::Duration::from_secs(30);

use crate::transport::Transport;

/// A session's terminal, as it reaches a viewer.
#[derive(Clone, Debug)]
pub enum Terminal {
    /// Raw bytes. Not text: escape sequences and partial UTF-8 both travel here.
    Data(Vec<u8>),
    /// The agent's terminal went away.
    Closed,
}

/// What a structured agent is saying, live.
///
/// Lines are unread here on purpose — the same bytes the agent wrote. Each
/// subscriber makes its own sense of them, because arriving in the middle of a
/// conversation means replaying what came before to get there.
#[derive(Clone, Debug)]
pub enum AgentSpeech {
    Line {
        line_no: u64,
        line: String,
    },
    /// The agent is blocked and will not continue until somebody answers.
    Asks {
        req: String,
        tool_name: String,
        input: serde_json::Value,
    },
    /// Nothing more is coming.
    Closed,
}

/// What stopping this session takes.
enum Stop {
    /// Its supervisor sends a signal.
    Signal,
    /// It is asked, in the conversation.
    Ask(serde_json::Value),
    /// Nothing is running.
    Nothing,
}

/// What reading a line meant.
#[derive(Default)]
struct Read {
    /// Where the session has got to, when the line moved it.
    moved: Option<(SessionStatus, Option<String>)>,
    /// What to say back to the agent because of it.
    ///
    /// Empty for Claude Code, which is told things only when somebody types.
    /// Codex needs a conversation opened before it can be given any work, and
    /// the step after each answer is decided here.
    send: Vec<serde_json::Value>,
    /// What the agent has stopped for.
    ///
    /// Claude Code asks through a tool it starts itself, so its questions
    /// arrive as their own frame and never through here. Codex asks down the
    /// same pipe it says everything else on, which makes a line the only thing
    /// that can report it.
    asks: Vec<AgentSpeech>,
}

/// One session's lines, read for what they say about the session.
struct Progress {
    reader: ft_core::normalise::Reader,
    /// Which agent this session runs. Kept because the pickers it has and the
    /// way a choice is put into force are both facts about it.
    agent: ft_core::Agent,
    /// Somebody pressed stop, and the turn that ends next is theirs.
    ///
    /// The agent reports an interrupted turn as `error_during_execution`,
    /// which is indistinguishable from a crash by reading it — so this is
    /// remembered from the side that asked for it. Without it, stopping a
    /// session marked it `Failed`, and a failed session used to be one nobody
    /// could say anything else to.
    stopped: bool,
    /// The last thing the agent said, kept for the moment it stops.
    ///
    /// A session that handed work back is worth a sentence in the inbox, and
    /// this is the accurate version of what the old `Stop` hook was scraping
    /// out of a transcript file.
    said: String,
    /// What this session was first asked to do, until it has been asked.
    ///
    /// Only Codex has one: its first prompt cannot go out until a thread
    /// exists, and the answer that creates one arrives here. Taken rather than
    /// copied, so it is sent once.
    opening_prompt: Option<String>,
    /// What somebody has chosen for this session, for the agent that takes
    /// them as parameters rather than as commands.
    settings: ft_core::codex::Settings,
    /// The next request id to send under.
    ///
    /// Ours to choose and ours to keep distinct: an answer is matched by the
    /// id its request went out with, so reusing one would attribute an answer
    /// to the wrong question.
    next_id: u64,
}

impl Progress {
    /// A reader for whichever agent this session runs.
    fn for_agent(agent: ft_core::Agent, prompt: String) -> Self {
        Self {
            agent,
            reader: ft_core::normalise::Reader::for_agent(agent),
            stopped: false,
            said: String::new(),
            // Codex cannot be given work until a thread exists, so its first
            // prompt waits here for the answer that creates one. Claude Code
            // was handed its prompt with the first message and has none.
            opening_prompt: match agent {
                ft_core::Agent::Codex => Some(prompt),
                _ => None,
            },
            settings: ft_core::codex::Settings::default(),
            next_id: ft_core::codex::FIRST_TURN_ID,
        }
    }

    /// The pickers this session has, and what is in each.
    fn controls(&self) -> Vec<ft_core::controls::Control> {
        let (models, efforts, reported) = match &self.reader {
            ft_core::normalise::Reader::Codex(reader) => (
                reader.models().to_vec(),
                reader.efforts().to_vec(),
                reader.reported().clone(),
            ),
            ft_core::normalise::Reader::Claude(_) => {
                (Vec::new(), Vec::new(), ft_core::codex::Settings::default())
            }
        };

        let mut controls = ft_core::controls::for_agent(self.agent, models, efforts);

        // What somebody chose, so a picker shows it rather than the default it
        // was drawn with. Claude Code restates its own at the start of every
        // turn and this stays empty for it.
        for control in &mut controls {
            // What somebody chose, or failing that what the session said it
            // was running. A picker showing neither looks broken.
            control.current = match control.kind {
                ft_core::controls::ControlKind::Model => self
                    .settings
                    .model
                    .clone()
                    .or_else(|| reported.model.clone()),
                ft_core::controls::ControlKind::Effort => self
                    .settings
                    .effort
                    .clone()
                    .or_else(|| reported.effort.clone()),
                ft_core::controls::ControlKind::Mode => self
                    .settings
                    .approval
                    .clone()
                    .or_else(|| reported.approval.clone()),
                ft_core::controls::ControlKind::Sandbox => {
                    Some(self.settings.fence.unwrap_or_default().name().to_string())
                }
            };
        }
        controls
    }

    /// Put a choice into force, and say how.
    fn choose(
        &mut self,
        kind: ft_core::controls::ControlKind,
        value: &str,
    ) -> Result<Option<serde_json::Value>> {
        use ft_core::controls::ControlKind as K;

        // The agent that reads slash commands out of its own input. Nothing to
        // remember: it answers with a sentence saying what it did, and that is
        // what the picker then shows.
        if let Some(text) = ft_core::controls::command(self.agent, kind, value) {
            return Ok(Some(ft_core::turn::user_message(&text)));
        }
        if self.agent != ft_core::Agent::Codex {
            anyhow::bail!("{} cannot be asked to change that", self.agent.label());
        }

        match kind {
            K::Model => self.settings.model = Some(value.to_string()),
            K::Effort => self.settings.effort = Some(value.to_string()),
            K::Mode => self.settings.approval = Some(value.to_string()),
            K::Sandbox => {
                self.settings.fence = Some(
                    ft_core::codex::Fence::named(value)
                        .with_context(|| format!("{value} is not a sandbox"))?,
                )
            }
        }

        // Nothing to send. It rides on the next turn, because there is no
        // request that changes a thread's settings on its own.
        Ok(None)
    }

    /// What this line means for the session, if anything.
    fn read(&mut self, line: &str) -> Read {
        use ft_core::turn::{StreamKind, TurnEvent as E, TurnStatus};

        let mut moved = None;
        let mut asks = Vec::new();
        for event in self.reader.push(line) {
            match event {
                // Assistant text only. A tool's output is not the agent
                // speaking, and reasoning is not what it chose to say.
                E::ContentDelta {
                    stream: StreamKind::AssistantText,
                    delta,
                    ..
                } => self.said.push_str(&delta),

                E::TurnStarted { .. } => {
                    self.said.clear();
                    moved = Some((SessionStatus::Working, None));
                }
                E::TurnCompleted { status, .. } => {
                    let note = summarise(&self.said);
                    // A turn we stopped is not a turn that broke, whatever the
                    // agent calls it on the way out.
                    let asked_for = std::mem::take(&mut self.stopped);
                    moved = Some(match status {
                        TurnStatus::Failed if !asked_for => (SessionStatus::Failed, note),
                        // Handed back rather than finished: it did a turn and
                        // is waiting for the next thing, which is a resting
                        // state and not an end.
                        _ => (SessionStatus::HandedBack, note),
                    });
                }
                // Not `moved`: what a blocked session does — record it,
                // announce it, tell somebody — is one thing done in one place,
                // and doing half of it here would write the status twice.
                E::RequestOpened {
                    req, detail, args, ..
                } => {
                    asks.push(AgentSpeech::Asks {
                        req: req.to_string(),
                        tool_name: detail,
                        input: args,
                    });
                }
                E::UserInputRequested { req, questions } => {
                    let input = serde_json::json!({ "questions": questions });
                    asks.push(AgentSpeech::Asks {
                        req: req.to_string(),
                        tool_name: "AskUserQuestion".into(),
                        input,
                    });
                }
                _ => {}
            }
        }

        // The answer that created a thread is what unblocks the first prompt.
        // Checked after the events rather than inside them because it is not
        // an event: it is a fact the reader learned on the way past.
        let mut send = Vec::new();
        if let (Some(thread), Some(prompt)) = (self.reader.thread(), self.opening_prompt.as_ref()) {
            send.push(ft_core::codex::turn_start(
                self.next_id,
                thread,
                prompt,
                &self.settings,
            ));
        }
        if !send.is_empty() {
            self.next_id += 1;
            self.opening_prompt = None;
        }

        Read { moved, send, asks }
    }

    /// How this agent is stopped.
    fn stop(&mut self) -> Stop {
        match &self.reader {
            // Its supervisor signals it, which is not a thing it is told.
            ft_core::normalise::Reader::Claude(_) => Stop::Signal,
            ft_core::normalise::Reader::Codex(reader) => {
                let (Some(thread), Some(turn)) = (reader.thread(), reader.active_turn()) else {
                    // Between turns there is nothing running to stop, and a
                    // request naming no turn would be refused.
                    return Stop::Nothing;
                };
                let (thread, turn) = (thread.to_string(), turn.to_string());
                let id = self.next_id;
                self.next_id += 1;
                Stop::Ask(ft_core::codex::turn_interrupt(id, &thread, &turn))
            }
        }
    }

    /// One message for this agent, carrying what somebody typed.
    ///
    /// Here rather than at the call site because the shape is the agent's and
    /// this is the only object that knows which agent a session runs — and,
    /// for Codex, the thread it is talking in.
    fn turn(
        &mut self,
        text: &str,
        images: &[ft_core::turn::Attached],
    ) -> Result<serde_json::Value> {
        match &self.reader {
            ft_core::normalise::Reader::Claude(_) => {
                Ok(ft_core::turn::user_message_with(text, images))
            }
            ft_core::normalise::Reader::Codex(reader) => {
                let thread = reader.thread().context(
                    "this session is still opening its conversation — try again in a moment",
                )?;
                let id = self.next_id;
                self.next_id += 1;
                Ok(ft_core::codex::turn_start(id, thread, text, &self.settings))
            }
        }
    }
}

/// The last thing said, short enough for a card.
///
/// The end rather than the beginning: an agent that worked for ten minutes
/// opens with what it set out to do and closes with what happened, and the
/// second is the one worth reading in a list.
fn summarise(said: &str) -> Option<String> {
    let said = said.trim();
    if said.is_empty() {
        return None;
    }
    // A paragraph is a better unit than a character count — it ends where the
    // agent decided it ended.
    let tail = said.rsplit("\n\n").next().unwrap_or(said).trim();
    let tail = if tail.is_empty() { said } else { tail };

    const ROOM: usize = 200;
    if tail.chars().count() <= ROOM {
        return Some(tail.to_string());
    }
    Some(format!(
        "{}…",
        tail.chars().take(ROOM).collect::<String>().trim_end()
    ))
}

/// Ask the host what this session's work should be called.
///
/// Off the connection loop, because it starts a short-lived agent on that
/// machine and takes seconds — and nothing is waiting for the answer. It lands
/// in the session, where the review sheet finds it already written.
///
/// Quiet about failing. A session that finished is finished whether or not
/// anybody could think of a name for it, and the sheet works with an empty box.
async fn describe(fleet: &Fleet, db: &Db, host_id: &HostId, session_id: &SessionId) {
    // Nothing to describe without a checkout, and nothing to open either.
    match db.session(session_id).await {
        Ok(Some(session)) if session.repo.is_some() => {}
        _ => return,
    }

    let answer = match fleet
        .run_action(host_id, session_id, ft_proto::Action::Describe, None)
        .await
    {
        Ok(Ok(answer)) => answer,
        Ok(Err(why)) => {
            tracing::debug!(session = %session_id, "nothing to describe: {why}");
            return;
        }
        Err(e) => {
            tracing::debug!(session = %session_id, "could not describe: {e:#}");
            return;
        }
    };

    let (title, body) = answer.split_once("\n\n").unwrap_or((answer.as_str(), ""));
    if title.trim().is_empty() {
        return;
    }
    if let Err(e) = db
        .record_proposal(session_id, title.trim(), body.trim())
        .await
    {
        tracing::warn!(session = %session_id, "could not keep the proposal: {e:#}");
    }
}

/// Record that a session has stopped for somebody, and say so.
///
/// Two things arrive at this: an agent that asks through a tool of its own —
/// its own frame — and one that asks down the pipe it says everything else on,
/// which reaches us as a line. Same question either way, and a browser opening
/// afterwards has to find it whichever way it came.
async fn blocked(
    db: &Db,
    notify: &crate::notify::Notifier,
    asked: &Arc<RwLock<HashMap<String, Vec<AgentSpeech>>>>,
    conversations: &Arc<RwLock<HashMap<String, broadcast::Sender<AgentSpeech>>>>,
    session_id: &SessionId,
    question: AgentSpeech,
) {
    let AgentSpeech::Asks {
        req,
        tool_name,
        input,
    } = &question
    else {
        return;
    };

    // Kept before it is announced, so a browser that opens a moment later
    // still finds it.
    let news = {
        let mut held = asked.write().await;
        let waiting = held.entry(session_id.to_string()).or_default();
        let known = waiting
            .iter()
            .any(|q| matches!(q, AgentSpeech::Asks { req: seen, .. } if seen == req));
        if !known {
            waiting.push(question.clone());
        }
        !known
    };

    // A permission prompt is never in a transcript — the agent is blocked, not
    // talking — so this is the only thing that can say the session stopped.
    let note = asking_about(tool_name, input);
    if let Err(e) = db
        .set_session_state(session_id, SessionStatus::NeedsYou, Some(&note))
        .await
    {
        tracing::warn!(session = %session_id, "marking as waiting: {e:#}");
    }

    // `news` alone, and deliberately. A watcher attaching re-announces
    // everything the agent is blocked on, which is right for drawing it and
    // wrong for telling somebody — but a re-announced question carries a
    // request id we have already seen, so `news` is false and it stays quiet.
    //
    // This used to also require that the session was not already resting,
    // which swallowed a second question asked while the first was unanswered:
    // the card changed and the phone did not.
    tracing::debug!(session = %session_id, news, "deciding whether to notify");
    if news {
        tell(db, notify, session_id, Some(&note)).await;
    }

    if let Some(tx) = conversations.read().await.get(session_id.as_str()) {
        let _ = tx.send(question);
    }
}

/// Tell whoever asked to be told.
///
/// Named by the session rather than by its id, because a notification arriving
/// on a phone has to say which of four agents wants something before anybody
/// will open it.
async fn tell(
    db: &Db,
    notify: &crate::notify::Notifier,
    session_id: &SessionId,
    note: Option<&str>,
) {
    if !notify.configured() {
        return;
    }
    let name = match db.session(session_id).await {
        Ok(Some(session)) => session.name,
        // Worth telling somebody even when we cannot name it nicely.
        _ => session_id.to_string(),
    };
    notify.stopped(
        session_id,
        &name,
        note.unwrap_or("It stopped and is waiting for you."),
        std::env::var("FIRETOWER_PUBLIC_URL").ok().as_deref(),
    );
}

/// A question, short enough for a card in the inbox.
fn asking_about(tool: &str, args: &serde_json::Value) -> String {
    for key in ["command", "file_path", "path", "url"] {
        if let Some(value) = args.get(key).and_then(|v| v.as_str()) {
            return format!("{tool}: {value}");
        }
    }
    tool.to_string()
}

/// One terminal of one session.
///
/// One kind is left, and the key still names it: a session that grows a second
/// terminal should not need every map in two files rewritten again.
fn terminal_key(session_id: &SessionId, pty: Pty) -> String {
    match pty {
        Pty::Shell => format!("{session_id}:shell"),
    }
}

/// One map for everything waiting on an answer, so the timeout and the
/// clean-up-on-disconnect logic exist once rather than once per request type.
enum Waiting {
    Remote(oneshot::Sender<Result<RemoteInfo, ProbeFailure>>),
    /// What is in a directory.
    Listing(oneshot::Sender<Result<Vec<ft_core::FileEntry>, String>>),
    /// A file: whether it is coming, and then the pieces of it.
    ///
    /// Two channels for one request because a browser needs an answer before a
    /// body — the first says whether there will be one, the second carries it.
    File {
        opened: Option<oneshot::Sender<Result<u64, String>>>,
        chunks: mpsc::Sender<Vec<u8>>,
    },
    Agents(oneshot::Sender<Vec<AgentPresence>>),
    /// A Codex sign-in: the code to show, and then the credential.
    ///
    /// Two channels for one request, like a file, and for the same reason —
    /// the first answer is due in seconds and the second waits on a person.
    CodexLogin {
        started: Option<oneshot::Sender<Result<ft_proto::CodexPending, String>>>,
        finished: Option<oneshot::Sender<Result<String, String>>>,
    },
    Action(oneshot::Sender<Result<String, String>>),
    Summary(oneshot::Sender<Vec<CheckoutSummary>>),
}

/// A request waiting on an answer, and which host owes it.
///
/// The host matters when a connection ends: only the requests that were sent
/// down *that* connection are lost. Failing the rest would mean one host
/// dropping takes down work happening on every other one.
struct Asked {
    host: String,
    waiting: Waiting,
}

#[derive(Clone)]
pub struct Fleet {
    db: Db,
    workers: Arc<RwLock<HashMap<String, mpsc::Sender<ToWorker>>>>,
    /// Fan-out to whoever is watching — the event stream, ultimately the browser.
    events: broadcast::Sender<Event>,
    /// Requests waiting for their answer. Most frames are one-way and correlate
    /// on a session; a probe has no session, so it correlates on its own id.
    probes: Arc<RwLock<HashMap<ReqId, Asked>>>,
    /// Live terminals, one broadcast per session. The worker holds a single
    /// attachment; this is where it fans out to however many are watching.
    terminals: Arc<RwLock<HashMap<String, broadcast::Sender<Terminal>>>>,
    /// One reader per session, folding its lines into what the session is
    /// doing.
    ///
    /// Separate from the readers each browser builds: those describe a
    /// transcript to somebody looking at it, this decides what the inbox says.
    /// The same events, read for a different purpose, and neither can stall
    /// the other.
    progress: Arc<RwLock<HashMap<String, Progress>>>,
    /// How somebody is told a session stopped, when they asked to be.
    notify: crate::notify::Notifier,
    /// Questions each session is blocked on, until they are answered.
    ///
    /// Held here because nothing else can hold them for a browser: a question
    /// is not in the agent's log — it is blocked, not talking — and the live
    /// broadcast has no history. Without this, opening a session that is
    /// already waiting shows an agent doing nothing, with no way to find out
    /// why.
    asked: Arc<RwLock<HashMap<String, Vec<AgentSpeech>>>>,
    /// Live conversations, one broadcast per session.
    ///
    /// Carries lines as the agent wrote them. Turning them into something an
    /// interface can draw happens per subscriber, because a subscriber that
    /// joined late has to replay the stored lines through a normaliser of its
    /// own to arrive in the right state.
    conversations: Arc<RwLock<HashMap<String, broadcast::Sender<AgentSpeech>>>>,
    /// One per host we are keeping connected, whether or not it is answering.
    ///
    /// A host is in here from the moment it is added until it is removed, which
    /// is what tells "we are trying and it isn't answering yet" apart from "we
    /// stopped trying". Dropping the sender ends its supervisor.
    supervised: Arc<RwLock<HashMap<String, mpsc::Sender<Nudge>>>>,
}

/// A word to a supervisor between attempts.
enum Nudge {
    /// Stop waiting out the backoff and try now.
    TryNow,
}

/// How long to wait before the next attempt.
///
/// Doubles to a cap, with a little noise on top. The noise is what stops a
/// laptop waking up from putting every host on the same schedule for the rest
/// of the day — they all fail together, so without it they all retry together,
/// forever.
fn backoff(attempt: u32, cause: Option<ft_core::Cause>) -> std::time::Duration {
    if attempt == 0 {
        return std::time::Duration::ZERO;
    }

    let doubled = std::time::Duration::from_secs(1) * 2u32.saturating_pow(attempt.min(6) - 1);
    let mut wait = doubled.min(RETRY_CAP);

    if matches!(
        cause,
        Some(ft_core::Cause::AuthRefused)
            | Some(ft_core::Cause::HostKeyChanged)
            | Some(ft_core::Cause::ProtocolMismatch)
    ) {
        wait = wait.max(RETRY_FLOOR_HUMAN);
    }

    // Up to a fifth longer. Cheap, and enough to break a lockstep.
    //
    // The modulus is prime on purpose. The clock reports nanoseconds but only
    // moves in microseconds, so every reading is a multiple of 1000 — take it
    // modulo anything that divides 1000 and the answer is always the same
    // number, which is jitter that does nothing at all.
    let spread = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() % 199)
        .unwrap_or(0);
    wait + (wait / 1000) * spread
}

impl Fleet {
    pub fn new(db: Db) -> Self {
        let (events, _) = broadcast::channel(1024);
        Self {
            db,
            workers: Arc::new(RwLock::new(HashMap::new())),
            events,
            probes: Arc::new(RwLock::new(HashMap::new())),
            terminals: Arc::new(RwLock::new(HashMap::new())),
            conversations: Arc::new(RwLock::new(HashMap::new())),
            asked: Arc::new(RwLock::new(HashMap::new())),
            progress: Arc::new(RwLock::new(HashMap::new())),
            notify: crate::notify::Notifier::from_env(),
            supervised: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// Connect once and say what happened, writing nothing down.
    ///
    /// The same handshake `supervise` runs, without a host to attach it to.
    /// Adding a machine can then find out whether it works *before* the row
    /// exists, so a name that was mistyped leaves nothing behind and a retry is
    /// a button rather than a form to fill in again.
    ///
    /// `None` means it answered as a worker. Anything else is why it did not.
    pub async fn probe_host(
        transport: Arc<dyn Transport>,
        compute: &ft_core::Compute,
    ) -> Option<ft_core::Diagnosis> {
        let mut conn = match transport.connect().await {
            Ok(conn) => conn,
            Err(e) => {
                // Nothing started, so there is no stderr to read; the error is
                // already in the right words.
                return Some(ft_core::Diagnosis::new(
                    ft_core::Cause::Unknown,
                    format!("{e:#}"),
                ));
            }
        };

        let mut codec = Codec::new(&mut conn.reader, &mut conn.writer);

        let greeting = codec
            .write(&ToWorker::Hello {
                protocol: PROTOCOL_VERSION,
                client_version: env!("CARGO_PKG_VERSION").to_string(),
            })
            .await;

        let handshake = match greeting {
            Ok(()) => codec.read::<ToServer>().await,
            Err(e) => Err(e),
        };

        match handshake {
            Ok(ToServer::Hello { protocol, .. }) if protocol == PROTOCOL_VERSION => None,
            Ok(ToServer::Hello { protocol, .. }) => Some(crate::diagnose::protocol_mismatch(
                protocol,
                PROTOCOL_VERSION,
                compute,
            )),
            Ok(_) => Some(ft_core::Diagnosis::new(
                ft_core::Cause::Unknown,
                "That host replied with something other than a worker's greeting.",
            )),
            Err(_) => {
                // The codec borrows both halves; reading the child's stderr
                // needs them back.
                drop(codec);

                let (said, status) = conn.said().await;
                Some(crate::diagnose::from_output(&said, status, compute))
            }
        }
    }

    /// The transport a host's kind implies.
    ///
    /// The worker is identical in all three cases and cannot tell which it is
    /// behind — that indifference is what lets one binary serve a child
    /// process, a container, and a server on the other side of the world.
    pub fn transport_for(
        host: &ft_core::Host,
        home: &std::path::Path,
        vault: Option<&Arc<crate::vault::Vault>>,
    ) -> Result<Arc<dyn Transport>> {
        Ok(match &host.compute {
            ft_core::Compute::Local => {
                Arc::new(crate::transport::LocalTransport::new(home.join("worker"))?)
            }
            ft_core::Compute::Container { name, .. } => {
                Arc::new(crate::transport::DockerTransport {
                    container: name.clone(),
                    // Inside the container, not on this machine.
                    root: std::path::PathBuf::from("/var/lib/firetower/worker"),
                })
            }
            ft_core::Compute::Server {
                port,
                key,
                container,
                ..
            } => Arc::new(crate::transport::SshTransport {
                // Assembled by the type that holds the parts, so there is one
                // answer to what `user@host` means.
                destination: host
                    .compute
                    .ssh_destination()
                    .context("a server host has somewhere to dial")?,
                port: *port,
                key: key.clone(),
                // Always: ssh records host keys under here whichever key it
                // authenticates with.
                home: home.to_path_buf(),
                // Only when the key is one the vault holds. A path, or ssh's
                // own choice, needs nothing from us.
                vault: key.is_held().then(|| vault.cloned()).flatten(),
                container: container.clone(),
                // Inside a container, the path the image creates. On the
                // machine itself, the worker's own default: that account may
                // have no way to write under /var/lib.
                root: container
                    .as_ref()
                    .map(|_| std::path::PathBuf::from("/var/lib/firetower/worker")),
            }),
        })
    }

    /// What kind of machine a host is, for wording an error about it.
    ///
    /// A host that has vanished is not worth failing a diagnosis over: the
    /// wording degrades, the message still arrives.
    async fn compute_of(&self, host_id: &HostId) -> ft_core::Compute {
        match self.db.host_by_id(host_id).await {
            Ok(Some(host)) => host.compute,
            _ => ft_core::Compute::Local,
        }
    }

    /// Keep a host connected for as long as it exists.
    ///
    /// One task per host, holding the statement "this should be connected".
    /// It connects, serves until the connection ends, waits, and tries again —
    /// so a laptop that slept, a wifi that changed and a server that rebooted
    /// all heal on their own instead of needing the control plane restarted.
    ///
    /// Returns once the first attempt has been made, so a host added by hand
    /// can report what happened while someone is still looking at the form.
    /// Retrying carries on in the background either way.
    pub async fn supervise(&self, host_id: HostId, transport: Arc<dyn Transport>) {
        // Already ours. Two supervisors on one host would be two connections
        // racing to register in the same slot.
        if self
            .supervised
            .read()
            .await
            .contains_key(&host_id.to_string())
        {
            return;
        }

        let (nudge, mut nudged) = mpsc::channel::<Nudge>(1);
        self.supervised
            .write()
            .await
            .insert(host_id.to_string(), nudge);

        let (first, waited) = oneshot::channel::<()>();
        let fleet = self.clone();

        tokio::spawn(async move {
            let mut first = Some(first);
            let mut attempt: u32 = 0;

            loop {
                // The supervisor outlives any one connection, so a host removed
                // while we were sleeping has to be noticed here.
                if !fleet
                    .supervised
                    .read()
                    .await
                    .contains_key(&host_id.to_string())
                {
                    break;
                }

                let outcome = fleet
                    .connect(host_id.clone(), transport.clone(), &mut first)
                    .await;

                // Fires here only when the attempt failed before the handshake;
                // a connection that came up already reported itself.
                if let Some(tell) = first.take() {
                    let _ = tell.send(());
                }

                match outcome {
                    // Served and ended. Whatever went wrong is over, so the
                    // next failure starts counting from the beginning again.
                    Ok(()) => attempt = 0,
                    Err(e) => {
                        attempt = attempt.saturating_add(1);
                        tracing::debug!(host = %host_id, attempt, "not reachable: {e:#}");
                    }
                }

                let cause = fleet
                    .db
                    .host_by_id(&host_id)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|h| h.diagnosis)
                    .map(|d| d.cause);

                let wait = backoff(attempt, cause);
                tracing::debug!(host = %host_id, "next attempt in {:?}", wait);

                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    // Someone pressed reconnect, or the supervisor was dropped.
                    got = nudged.recv() => match got {
                        Some(Nudge::TryNow) => {}
                        None => break,
                    },
                }
            }

            tracing::debug!(host = %host_id, "no longer supervised");
        });

        // The first attempt, and no more than that: a host that is down should
        // not hold up start-up or a form.
        let _ = waited.await;
    }

    /// Stop keeping a host connected, and drop the connection it has.
    ///
    /// Without this a removed host keeps a supervisor reconnecting to something
    /// that no longer exists, and adding it again would make a second one.
    pub async fn stop_supervising(&self, host_id: &HostId) {
        self.supervised.write().await.remove(&host_id.to_string());
        self.disconnect(host_id).await;
    }

    /// Try again now rather than waiting out the backoff.
    ///
    /// Returns whether there was a supervisor to tell.
    pub async fn try_now(&self, host_id: &HostId) -> bool {
        let supervised = self.supervised.read().await;
        match supervised.get(&host_id.to_string()) {
            Some(tx) => {
                // A full channel already has an attempt queued, which is the
                // same outcome as adding another.
                let _ = tx.try_send(Nudge::TryNow);
                true
            }
            None => false,
        }
    }

    /// Whether we are still trying to reach this host.
    ///
    /// True from being added until being removed, including while it is down.
    /// This is what tells "on its way back" apart from "nobody is looking".
    pub async fn is_supervised(&self, host_id: &HostId) -> bool {
        self.supervised
            .read()
            .await
            .contains_key(&host_id.to_string())
    }

    /// Wait for a host to answer, up to `limit`.
    ///
    /// For work that arrives in the gap between a connection dropping and the
    /// supervisor rebuilding it — usually seconds, and worth waiting out rather
    /// than refusing.
    pub async fn wait_until_connected(&self, host_id: &HostId, limit: std::time::Duration) -> bool {
        let until = std::time::Instant::now() + limit;
        loop {
            if self.is_connected(host_id).await {
                return true;
            }
            if std::time::Instant::now() >= until || !self.is_supervised(host_id).await {
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }

    /// Connect to a host, handshake, and start serving its frames.
    ///
    /// The first thing sent after the handshake is a resume request, so anything
    /// that happened while we were away arrives before anything new.
    /// `ready` is fired as soon as the handshake resolves, because this call
    /// then goes on to serve the connection and does not return until it ends.
    /// Waiting for the return value to learn whether a host answered would mean
    /// waiting for it to stop answering.
    async fn connect(
        &self,
        host_id: HostId,
        transport: Arc<dyn Transport>,
        ready: &mut Option<oneshot::Sender<()>>,
    ) -> Result<()> {
        let compute = self.compute_of(&host_id).await;

        let mut conn = match transport.connect().await {
            Ok(conn) => conn,
            Err(e) => {
                // Nothing started, so there is no stderr to read; the error is
                // already in the right words.
                let told = ft_core::Diagnosis::new(ft_core::Cause::Unknown, format!("{e:#}"));
                self.db.record_diagnosis(&host_id, &told).await?;
                return Err(e).with_context(|| format!("connecting via {}", transport.describe()));
            }
        };

        let mut codec = Codec::new(&mut conn.reader, &mut conn.writer);

        // A command that was never going to run is often gone before this
        // write lands, making it a broken pipe rather than a closed stream.
        // Both mean the same thing and both need the same explanation.
        let greeting = codec
            .write(&ToWorker::Hello {
                protocol: PROTOCOL_VERSION,
                client_version: env!("CARGO_PKG_VERSION").to_string(),
            })
            .await;

        let handshake = match greeting {
            Ok(()) => codec.read::<ToServer>().await,
            Err(e) => Err(e),
        };

        match handshake {
            Ok(ToServer::Hello {
                protocol,
                worker_version,
                cpus,
                memory_mb,
                ..
            }) => {
                if protocol != PROTOCOL_VERSION {
                    // Recoverable: the worker needs upgrading, so the message
                    // names both versions and what to run.
                    let told =
                        crate::diagnose::protocol_mismatch(protocol, PROTOCOL_VERSION, &compute);
                    self.db.record_diagnosis(&host_id, &told).await?;
                    anyhow::bail!("{}", told.summary);
                }
                // Online, so the last failure no longer applies.
                self.db
                    .mark_host_online(&host_id, &worker_version, cpus, memory_mb)
                    .await?;
                tracing::info!(host = %host_id, version = %worker_version, "worker online");
            }
            Ok(_) => anyhow::bail!("worker replied with something other than Hello"),
            Err(e) => {
                // The codec borrows both halves; reading the child's stderr
                // needs them back, and only this arm is done with them.
                drop(codec);

                // A closed frame stream says nothing about why. The stderr the
                // far end wrote before it went does.
                let (said, status) = conn.said().await;
                let told = crate::diagnose::from_output(&said, status, &compute);

                tracing::warn!(
                    host = %host_id,
                    cause = ?told.cause,
                    status = ?status,
                    "handshake failed: {}",
                    told.summary,
                );

                self.db.record_diagnosis(&host_id, &told).await?;
                return Err(e).context(told.summary);
            }
        }

        let since = self.db.last_seq(&host_id).await?;
        codec.write(&ToWorker::Resume { since }).await?;

        // Start mirroring every conversation this host is still holding.
        //
        // Not left until somebody opens one in a browser: the control plane is
        // what turns "the agent asked a question" into a session that needs
        // you, and it cannot do that from lines it never asked for. Each
        // session resumes from what is already stored, so a reconnection costs
        // the difference rather than the history.
        for session in self
            .db
            .live_session_ids_on(&host_id)
            .await
            .unwrap_or_default()
        {
            let since_line = self.db.last_agent_line(&session).await.unwrap_or(0).max(0) as u64;
            // A session running in a terminal has no conversation, and its
            // worker answers this by finding no agent to watch.
            codec
                .write(&ToWorker::WatchAgent {
                    session_id: session,
                    since_line,
                })
                .await?;
        }

        let (tx, mut rx) = mpsc::channel::<ToWorker>(64);
        self.workers.write().await.insert(host_id.to_string(), tx);

        // Reachable from here on, so whoever was waiting to hear can stop.
        if let Some(tell) = ready.take() {
            let _ = tell.send(());
        }

        // Sessions removed here while this machine was away were removed on the
        // promise that they would be cleaned up if it ever came back. It just
        // did. The agent has been running unattended since, and its workspace
        // and tmux session are still there.
        {
            let fleet = self.clone();
            let host = host_id.clone();
            tokio::spawn(async move {
                let owed = match fleet.db.owed_cleanup_on(&host).await {
                    Ok(owed) => owed,
                    Err(e) => {
                        tracing::warn!(host = %host, "looking for sessions to tear down: {e:#}");
                        return;
                    }
                };

                for session_id in owed {
                    match fleet
                        .send(
                            &host,
                            ToWorker::Destroy {
                                session_id: session_id.clone(),
                                force: true,
                            },
                        )
                        .await
                    {
                        // Recorded as told, not as done: the worker tears it
                        // down and says so in its own time, and asking twice
                        // would kill a session someone started since.
                        Ok(()) => {
                            tracing::info!(host = %host, session = %session_id,
                                "tearing down a session removed while this host was away");
                            if let Err(e) = fleet.db.mark_cleaned(&session_id).await {
                                tracing::warn!(session = %session_id, "recording a teardown: {e:#}");
                            }
                        }
                        // It went away again. The debt stands, and the next
                        // connection tries again.
                        Err(e) => {
                            tracing::warn!(host = %host, session = %session_id,
                                "tearing down after a reconnect: {e:#}");
                            break;
                        }
                    }
                }
            });
        }

        // Ask what this host has as soon as it turns up. Waiting for someone to
        // press a button means a fresh install reports no agents at all, which
        // reads as "nothing works" rather than "nobody has looked yet".
        {
            let fleet = self.clone();
            let host = host_id.clone();
            tokio::spawn(async move {
                match fleet.probe_agents(&host).await {
                    Ok(found) => {
                        if let Err(e) = fleet.db.record_presence(&host, &found).await {
                            tracing::warn!(host = %host, "recording agents: {e:#}");
                        }
                    }
                    Err(e) => tracing::warn!(host = %host, "asking about agents: {e:#}"),
                }
            });
        }

        let db = self.db.clone();
        let events = self.events.clone();
        let workers = self.workers.clone();
        let probes = self.probes.clone();
        let terminals = self.terminals.clone();
        let conversations = self.conversations.clone();
        let asked = self.asked.clone();
        let progress = self.progress.clone();
        let notify = self.notify.clone();
        let describing = self.clone();
        // For the frames a line makes us want to send back — an agent that has
        // to be answered to carry on, rather than one that only ever reports.
        let replying = self.clone();

        {
            // conn is moved in so the child process outlives this scope
            let mut conn = conn;
            let mut codec = Codec::new(&mut conn.reader, &mut conn.writer);

            // A connection can die without ever failing a read. A laptop that
            // slept, a network that changed underneath us: the socket goes
            // quiet rather than closed, and a loop waiting for a frame waits
            // for one that is never coming while the host still looks healthy.
            //
            // So the silence is timed. Anything inbound counts as proof of
            // life; a Ping is only there to provoke one when nothing else is
            // happening.
            let mut beat = tokio::time::interval(HEARTBEAT);
            beat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut last_heard = std::time::Instant::now();

            loop {
                if last_heard.elapsed() > SILENCE {
                    tracing::warn!(
                        host = %host_id,
                        "no answer for {}s; treating the connection as dead",
                        SILENCE.as_secs(),
                    );
                    break;
                }

                tokio::select! {
                    _ = beat.tick() => {
                        if let Err(e) = codec.write(&ToWorker::Ping).await {
                            tracing::warn!(host = %host_id, "heartbeat: {e}");
                            break;
                        }
                    }

                    outbound = rx.recv() => match outbound {
                        Some(frame) => {
                            if let Err(e) = codec.write(&frame).await {
                                tracing::error!(host = %host_id, "sending to worker: {e}");
                                break;
                            }
                        }
                        None => break,
                    },

                    inbound = codec.read::<ToServer>() => {
                        // Any frame is proof of life, whatever it says.
                        if inbound.is_ok() {
                            last_heard = std::time::Instant::now();
                        }
                        match inbound {
                        Ok(ToServer::Event { seq, session_id, kind, at }) => {
                            if let Err(e) = db.record_event(&host_id, seq, &session_id, &kind, at).await {
                                tracing::error!("recording event: {e:#}");
                                continue;
                            }
                            // a send failure only means nobody is watching
                            let _ = events.send(Event { seq, session_id, kind, at });
                        }
                        Ok(ToServer::RemoteProbed { req, result }) => {
                            // The receiver is gone when the request timed out
                            // or the browser navigated away.
                            match probes.write().await.remove(&req) {
                                Some(Asked { waiting: Waiting::Remote(reply), .. }) => { let _ = reply.send(result); }
                                Some(other) => { probes.write().await.insert(req, other); }
                                None => tracing::debug!("a probe answer arrived after its request gave up"),
                            }
                        }
                        Ok(ToServer::PtyOutput { session_id, pty, data }) => {
                            if let Some(bytes) = decode(&data) {
                                if let Some(tx) = terminals.read().await.get(&terminal_key(&session_id, pty)) {
                                    // An error only means nobody is watching.
                                    let _ = tx.send(Terminal::Data(bytes));
                                }
                            }
                        }
                        Ok(ToServer::AgentLine { session_id, line_no, line }) => {
                            // Stored before it is broadcast. A subscriber that
                            // arrives a moment later replays from the table, so
                            // a line that was announced but not yet written
                            // would be one nobody ever sees again.
                            match db.record_agent_line(&session_id, line_no as i64, &line).await {
                                Err(e) => {
                                    tracing::error!(session = %session_id, "recording a line: {e:#}");
                                    continue;
                                }
                                // We already had it. Reading it again would
                                // move the session on a turn that already
                                // happened, and announcing it again reaches a
                                // browser as every word written twice.
                                Ok(false) => {
                                    tracing::debug!(session = %session_id, line_no, "a line arrived twice");
                                    continue;
                                }
                                Ok(true) => {}
                            }
                            // What this line means for the session, before it
                            // means anything to a screen. This is the only
                            // thing that moves a structured session off
                            // `Working`, now that hooks do not.
                            // A reader has to be built for the agent that
                            // wrote the line. Once per session — the entry
                            // existing afterwards is the cache.
                            replying.ensure_reader(&session_id).await;
                            let read = {
                                let mut readers = progress.write().await;
                                match readers.get_mut(session_id.as_str()) {
                                    Some(reader) => reader.read(&line),
                                    None => continue,
                                }
                            };

                            // What the agent has to be told before it will go
                            // on. Codex opens a conversation and then waits to
                            // be given work; Claude Code never sends anything
                            // here.
                            for message in read.send {
                                if let Err(e) = replying
                                    .send(&host_id, ToWorker::SendTurn {
                                        session_id: session_id.clone(),
                                        message,
                                    })
                                    .await
                                {
                                    tracing::warn!(session = %session_id,
                                        "carrying on the conversation: {e:#}");
                                }
                            }

                            // A question Codex asked reaches us as a line and
                            // has to land where one asked through a tool of
                            // its own does, or the browser shows a session
                            // that stopped for no visible reason.
                            for question in read.asks {
                                blocked(
                                    &db, &notify, &asked, &conversations,
                                    &session_id, question,
                                ).await;
                            }

                            if let Some((status, note)) = read.moved {
                                let was_waiting = db
                                    .session_status(&session_id)
                                    .await
                                    .ok()
                                    .flatten()
                                    .is_some_and(|s| s.needs_you());
                                if let Err(e) = db
                                    .set_session_state(&session_id, status, note.as_deref())
                                    .await
                                {
                                    tracing::warn!(session = %session_id, "recording progress: {e:#}");
                                }
                                // On the change into needing somebody, not
                                // every time we are told it still does.
                                if status.needs_you() && !was_waiting {
                                    tell(&db, &notify, &session_id, note.as_deref()).await;
                                }

                                // The moment it stops is the moment something
                                // on that host knows most about what changed,
                                // so it is asked then rather than when somebody
                                // eventually opens the review sheet — by which
                                // time they are waiting on it.
                                if status == SessionStatus::HandedBack {
                                    let describing = describing.clone();
                                    let db = db.clone();
                                    let session_id = session_id.clone();
                                    let host_id = host_id.clone();
                                    tokio::spawn(async move {
                                        describe(&describing, &db, &host_id, &session_id).await;
                                    });
                                }
                            }

                            if let Some(tx) = conversations.read().await.get(session_id.as_str()) {
                                // An error only means nobody is watching.
                                let _ = tx.send(AgentSpeech::Line { line_no, line });
                            }
                        }
                        Ok(ToServer::AgentAsks { session_id, req, tool_name, input }) => {
                            blocked(
                                &db, &notify, &asked, &conversations, &session_id,
                                AgentSpeech::Asks { req, tool_name, input },
                            ).await;
                        }
                        Ok(ToServer::AgentClosed { session_id }) => {
                            asked.write().await.remove(session_id.as_str());
                            progress.write().await.remove(session_id.as_str());
                            if let Some(tx) = conversations.write().await.remove(session_id.as_str()) {
                                let _ = tx.send(AgentSpeech::Closed);
                            }
                        }
                        Ok(ToServer::PtyClosed { session_id, pty }) => {
                            if let Some(tx) = terminals.write().await.remove(&terminal_key(&session_id, pty)) {
                                let _ = tx.send(Terminal::Closed);
                            }
                        }
                        Ok(ToServer::Listed { req, result }) => {
                            match probes.write().await.remove(&req) {
                                Some(Asked { waiting: Waiting::Listing(reply), .. }) => { let _ = reply.send(result); }
                                Some(other) => { probes.write().await.insert(req, other); }
                                None => tracing::debug!("a listing arrived after its request gave up"),
                            }
                        }
                        Ok(ToServer::FileOpened { req, result }) => {
                            // The entry stays: the chunks that follow are
                            // routed by the same id, and it is removed when the
                            // last one arrives or the reader goes away.
                            let mut held = probes.write().await;
                            if let Some(Asked { waiting: Waiting::File { opened, .. }, .. }) = held.get_mut(&req) {
                                if let Some(tell) = opened.take() {
                                    let _ = tell.send(result);
                                    continue;
                                }
                            }
                            tracing::debug!("a file answer arrived after its request gave up");
                        }
                        Ok(ToServer::FileChunk { req, data, last }) => {
                            let sender = {
                                let held = probes.read().await;
                                match held.get(&req) {
                                    Some(Asked { waiting: Waiting::File { chunks, .. }, .. }) => Some(chunks.clone()),
                                    _ => None,
                                }
                            };

                            if let Some(chunks) = sender {
                                if let Some(bytes) = decode(&data) {
                                    // Blocks when the browser is slower than the
                                    // machine, which is the point: it is what
                                    // stops a download filling memory here.
                                    if chunks.send(bytes).await.is_err() {
                                        probes.write().await.remove(&req);
                                        continue;
                                    }
                                }
                            }

                            if last {
                                probes.write().await.remove(&req);
                            }
                        }
                        Ok(ToServer::ActionDone { req, result }) => {
                            match probes.write().await.remove(&req) {
                                Some(Asked { waiting: Waiting::Action(reply), .. }) => { let _ = reply.send(result); }
                                // A summary that failed comes back as an action
                                // error, since there is no summary to send.
                                Some(Asked { waiting: Waiting::Summary(_), .. }) => {}
                                Some(other) => { probes.write().await.insert(req, other); }
                                None => tracing::debug!("an action finished after its request gave up"),
                            }
                        }
                        Ok(ToServer::Summarized { req, summaries }) => {
                            match probes.write().await.remove(&req) {
                                Some(Asked { waiting: Waiting::Summary(reply), .. }) => { let _ = reply.send(summaries); }
                                Some(other) => { probes.write().await.insert(req, other); }
                                None => tracing::debug!("a summary arrived after its request gave up"),
                            }
                        }
                        Ok(ToServer::AgentsProbed { req, agents }) => {
                            match probes.write().await.remove(&req) {
                                Some(Asked { waiting: Waiting::Agents(reply), .. }) => { let _ = reply.send(agents); }
                                Some(other) => { probes.write().await.insert(req, other); }
                                None => tracing::debug!("an agent probe answered after its request gave up"),
                            }
                        }
                        Ok(ToServer::CodexLoginPending { req, result }) => {
                            // The entry stays: the credential arrives under
                            // the same id, minutes later.
                            let mut held = probes.write().await;
                            if let Some(Asked { waiting: Waiting::CodexLogin { started, .. }, .. }) = held.get_mut(&req) {
                                if let Some(tell) = started.take() {
                                    let _ = tell.send(result);
                                    continue;
                                }
                            }
                            tracing::debug!("a Codex sign-in answered after its request gave up");
                        }
                        Ok(ToServer::CodexLoginFinished { req, result }) => {
                            match probes.write().await.remove(&req) {
                                Some(Asked { waiting: Waiting::CodexLogin { finished, .. }, .. }) => {
                                    if let Some(tell) = finished { let _ = tell.send(result); }
                                }
                                Some(other) => { probes.write().await.insert(req, other); }
                                None => tracing::debug!("a Codex sign-in finished after its request gave up"),
                            }
                        }
                        Ok(ToServer::Error { code, message, .. }) => {
                            tracing::warn!(host = %host_id, "worker error {code}: {message}");
                        }
                        Ok(_) => {}
                        Err(CodecError::Closed) => {
                            tracing::warn!(host = %host_id, "worker connection closed");
                            break;
                        }
                        Err(e) => {
                            tracing::error!(host = %host_id, "reading from worker: {e}");
                            break;
                        }
                        }
                    },
                }
            }

            // Sessions on this host keep running; we just can't see them.
            workers.write().await.remove(&host_id.to_string());
            // Anything still waiting on *this* worker will never hear back, so
            // fail it now rather than leaving the interface spinning. Requests
            // sent to other hosts are untouched: they are still on connections
            // that are still up, and failing them here would make one machine
            // dropping look like every machine dropping.
            let mine: Vec<ReqId> = {
                let held = probes.read().await;
                held.iter()
                    .filter(|(_, asked)| asked.host == host_id.to_string())
                    .map(|(req, _)| req.clone())
                    .collect()
            };
            for req in mine {
                let Some(asked) = probes.write().await.remove(&req) else {
                    continue;
                };
                match asked.waiting {
                    Waiting::Remote(reply) => {
                        let _ = reply.send(Err(ProbeFailure::Unreachable));
                    }
                    // Dropping the sender is the signal; there is no "we asked
                    // and the answer was none" for these.
                    Waiting::Agents(_) | Waiting::Summary(_) => {}
                    Waiting::Action(reply) => {
                        let _ = reply.send(Err("the host stopped answering".into()));
                    }
                    Waiting::Listing(reply) => {
                        let _ = reply.send(Err("the host stopped answering".into()));
                    }
                    // A download in flight ends where it got to. Dropping the
                    // sender is what tells the browser the body is over; a
                    // half-file is what a dropped connection means.
                    Waiting::File { opened, .. } => {
                        if let Some(tell) = opened {
                            let _ = tell.send(Err("the host stopped answering".into()));
                        }
                    }
                    // A sign-in belongs to the host that asked for the code:
                    // OpenAI is delivering the credential *there*, and no
                    // other host can be told to collect it. Losing the
                    // connection loses the attempt, and saying so beats a
                    // browser waiting out the full fifteen minutes.
                    Waiting::CodexLogin { started, finished } => {
                        if let Some(tell) = started {
                            let _ = tell.send(Err("the host stopped answering".into()));
                        }
                        if let Some(tell) = finished {
                            let _ = tell
                                .send(Err("the host went away before the sign-in finished".into()));
                        }
                    }
                }
            }
            let _ = db.mark_host_unreachable(&host_id).await;
        }

        Ok(())
    }

    /// Send a frame to a host, if we can currently reach it.
    pub async fn send(&self, host_id: &HostId, frame: ToWorker) -> Result<()> {
        let workers = self.workers.read().await;
        let tx = workers
            .get(&host_id.to_string())
            .with_context(|| format!("host {host_id} is unreachable"))?;
        tx.send(frame)
            .await
            .context("the worker connection went away mid-send")?;
        Ok(())
    }

    /// Ask a host whether it can reach a repository.
    ///
    /// The outer error means we couldn't ask; the inner one means we asked and
    /// the answer was no. They lead to different messages, so they stay apart.
    pub async fn probe(
        &self,
        host_id: &HostId,
        remote: &str,
        credential: Option<Credential>,
    ) -> Result<Result<RemoteInfo, ProbeFailure>> {
        let req = ulid::Ulid::new().to_string();
        let (tx, rx) = oneshot::channel();
        self.probes.write().await.insert(
            req.clone(),
            Asked {
                host: host_id.to_string(),
                waiting: Waiting::Remote(tx),
            },
        );

        let sent = self
            .send(
                host_id,
                ToWorker::ProbeRemote {
                    req: req.clone(),
                    remote: remote.to_string(),
                    credential,
                },
            )
            .await;

        if let Err(e) = sent {
            self.probes.write().await.remove(&req);
            return Err(e);
        }

        match tokio::time::timeout(PROBE_TIMEOUT, rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => {
                anyhow::bail!("the worker connection dropped while checking the repository")
            }
            Err(_) => {
                self.probes.write().await.remove(&req);
                anyhow::bail!("{host_id} did not answer within {PROBE_TIMEOUT:?}")
            }
        }
    }

    /// Ask a host which agents it has.
    /// Start signing Codex in on a host, and hand back the code to show.
    ///
    /// The second half — the credential — arrives on the returned channel
    /// whenever somebody approves the code, which may be a quarter of an hour.
    /// Waiting on it is the caller's business; this returns as soon as there is
    /// something to put on a screen.
    pub async fn codex_login(
        &self,
        host_id: &HostId,
    ) -> Result<(
        ft_proto::CodexPending,
        oneshot::Receiver<Result<String, String>>,
    )> {
        let req = ulid::Ulid::new().to_string();
        let (started, wait_started) = oneshot::channel();
        let (finished, wait_finished) = oneshot::channel();

        self.probes.write().await.insert(
            req.clone(),
            Asked {
                host: host_id.to_string(),
                waiting: Waiting::CodexLogin {
                    started: Some(started),
                    finished: Some(finished),
                },
            },
        );

        if let Err(e) = self
            .send(host_id, ToWorker::CodexLoginStart { req: req.clone() })
            .await
        {
            self.probes.write().await.remove(&req);
            return Err(e);
        }

        // Only as far as the code. Spawning the process and two round trips to
        // OpenAI is a probe's worth of waiting; the person is not part of it.
        let pending = match tokio::time::timeout(PROBE_TIMEOUT, wait_started).await {
            Ok(Ok(Ok(pending))) => pending,
            Ok(Ok(Err(why))) => {
                self.probes.write().await.remove(&req);
                anyhow::bail!("{why}")
            }
            Ok(Err(_)) => anyhow::bail!("the worker connection dropped while signing Codex in"),
            Err(_) => {
                self.probes.write().await.remove(&req);
                anyhow::bail!("{host_id} did not answer within {PROBE_TIMEOUT:?}")
            }
        };

        Ok((pending, wait_finished))
    }

    pub async fn probe_agents(&self, host_id: &HostId) -> Result<Vec<AgentPresence>> {
        let req = ulid::Ulid::new().to_string();
        let (tx, rx) = oneshot::channel();
        self.probes.write().await.insert(
            req.clone(),
            Asked {
                host: host_id.to_string(),
                waiting: Waiting::Agents(tx),
            },
        );

        if let Err(e) = self
            .send(host_id, ToWorker::ProbeAgents { req: req.clone() })
            .await
        {
            self.probes.write().await.remove(&req);
            return Err(e);
        }

        match tokio::time::timeout(PROBE_TIMEOUT, rx).await {
            Ok(Ok(agents)) => Ok(agents),
            Ok(Err(_)) => anyhow::bail!("the worker connection dropped while checking agents"),
            Err(_) => {
                self.probes.write().await.remove(&req);
                anyhow::bail!("{host_id} did not answer within {PROBE_TIMEOUT:?}")
            }
        }
    }

    /// Start watching a session's terminal.
    ///
    /// Every viewer gets its own receiver off one broadcast, and the worker is
    /// only asked to attach when the first one arrives.
    pub async fn watch(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        pty: Pty,
        cols: u16,
        rows: u16,
    ) -> Result<broadcast::Receiver<Terminal>> {
        let key = terminal_key(session_id, pty);
        let mut terminals = self.terminals.write().await;

        let receiver = match terminals.get(&key) {
            Some(existing) => existing.subscribe(),
            None => {
                // Deep enough that a burst of output during a slow render
                // doesn't drop frames and corrupt the screen.
                let (tx, rx) = broadcast::channel(1024);
                terminals.insert(key.clone(), tx);
                rx
            }
        };
        drop(terminals);

        self.send(
            host_id,
            ToWorker::PtyOpen {
                session_id: session_id.clone(),
                pty,
                cols,
                rows,
            },
        )
        .await?;

        Ok(receiver)
    }

    /// Follow a session's conversation, and ask its worker to start sending.
    ///
    /// The cursor is what this control plane already has, so a worker that has
    /// been talking to nobody sends only the difference.
    pub async fn watch_agent(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        since_line: u64,
    ) -> Result<broadcast::Receiver<AgentSpeech>> {
        let mut conversations = self.conversations.write().await;
        let receiver = match conversations.get(session_id.as_str()) {
            Some(existing) => existing.subscribe(),
            None => {
                // Deep enough to absorb replaying a long session into a
                // subscriber that is still setting itself up.
                let (tx, rx) = broadcast::channel(4096);
                conversations.insert(session_id.to_string(), tx);
                rx
            }
        };
        drop(conversations);

        self.send(
            host_id,
            ToWorker::WatchAgent {
                session_id: session_id.clone(),
                since_line,
            },
        )
        .await?;

        Ok(receiver)
    }

    /// The pickers this session has, and what is in each.
    ///
    /// Asked of the reader rather than assembled here, because the answer
    /// depends on what the agent has said about itself — Codex lists its own
    /// models, and a session that has not heard back yet has no model picker.
    pub async fn controls(&self, session_id: &SessionId) -> Vec<ft_core::controls::Control> {
        self.ensure_reader(session_id).await;
        self.progress
            .read()
            .await
            .get(session_id.as_str())
            .map(|progress| progress.controls())
            .unwrap_or_default()
    }

    /// Change one of them.
    ///
    /// What that means is the agent's business: a slash command for the one
    /// that reads them out of its own input, and a parameter on the next turn
    /// for the one that does not. The browser knows neither.
    pub async fn choose(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        kind: ft_core::controls::ControlKind,
        value: &str,
    ) -> Result<()> {
        self.ensure_reader(session_id).await;

        let message = {
            let mut readers = self.progress.write().await;
            let progress = readers
                .get_mut(session_id.as_str())
                .context("this session has no reader")?;
            progress.choose(kind, value)?
        };

        // Nothing to send is an ordinary outcome, not a failure: it has been
        // remembered and rides on the next turn.
        let Some(message) = message else {
            return Ok(());
        };

        self.send(
            host_id,
            ToWorker::SendTurn {
                session_id: session_id.clone(),
                message,
            },
        )
        .await
    }

    /// One message for the agent, in whatever shape that agent takes.
    ///
    /// Takes what somebody typed rather than a finished frame: which protocol
    /// a session speaks is this object's business, and a caller that built the
    /// message itself would have to know too.
    pub async fn send_turn(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        text: &str,
        images: &[ft_core::turn::Attached],
    ) -> Result<()> {
        self.ensure_reader(session_id).await;
        let message = {
            let mut readers = self.progress.write().await;
            let progress = readers
                .get_mut(session_id.as_str())
                .context("this session has no reader")?;
            progress.turn(text, images)?
        };

        self.send(
            host_id,
            ToWorker::SendTurn {
                session_id: session_id.clone(),
                message,
            },
        )
        .await
    }

    /// What this session is blocked on, if anything.
    pub async fn asked(&self, session_id: &SessionId) -> Vec<AgentSpeech> {
        self.asked
            .read()
            .await
            .get(session_id.as_str())
            .cloned()
            .unwrap_or_default()
    }

    /// Answer something the agent is blocked on.
    pub async fn answer(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        req: String,
        decision: &ft_core::turn::Decision,
    ) -> Result<()> {
        // Forgotten here rather than when the agent acknowledges, because it
        // does not acknowledge — it simply carries on, and the next thing it
        // says is the proof.
        let still_waiting = {
            let mut held = self.asked.write().await;
            let waiting = held.entry(session_id.to_string()).or_default();
            waiting.retain(|q| !matches!(q, AgentSpeech::Asks { req: seen, .. } if *seen == req));
            !waiting.is_empty()
        };

        // Back to working, unless something else is still blocked. Nothing in
        // the stream says this: the agent does not announce that it has been
        // unblocked, it simply carries on.
        if !still_waiting {
            if let Err(e) = self
                .db
                .set_session_state(session_id, SessionStatus::Working, None)
                .await
            {
                tracing::warn!(session = %session_id, "clearing the question: {e:#}");
            }
        }

        // Which shape an answer takes is the agent's, and which agent this is
        // is the reader's to know. Claude Code is answering a tool it started
        // itself, over a socket of its own; Codex is answering a request that
        // came down the same pipe everything else does.
        self.ensure_reader(session_id).await;
        let codex = {
            let readers = self.progress.read().await;
            matches!(
                readers.get(session_id.as_str()).map(|p| &p.reader),
                Some(ft_core::normalise::Reader::Codex(_))
            )
        };

        let frame = if codex {
            let message = ft_core::codex::reply(&req, decision)
                .with_context(|| format!("{req} is not a request Codex is waiting on"))?;
            ToWorker::SendTurn {
                session_id: session_id.clone(),
                message,
            }
        } else {
            ToWorker::Answer {
                session_id: session_id.clone(),
                req,
                result: ft_core::turn::permission_result(decision),
            }
        };

        self.send(host_id, frame).await
    }

    /// Make sure this session has a reader, built for the agent it runs.
    ///
    /// Not `or_default`: a reader is agent-specific, and one built for the
    /// wrong agent would read every line as something it is not. Asked of the
    /// database once per session rather than once per line — the entry
    /// existing is the cache.
    async fn ensure_reader(&self, session_id: &SessionId) {
        if self.progress.read().await.contains_key(session_id.as_str()) {
            return;
        }

        let (agent, prompt) = match self.db.session_agent(session_id).await {
            Ok(Some(found)) => found,
            // A session we cannot look up still has to be readable. Claude
            // Code is the older shape and the safer guess: it reads a Codex
            // line as nothing rather than as the wrong thing.
            _ => (ft_core::Agent::ClaudeCode, String::new()),
        };

        let mut progress = Progress::for_agent(agent, prompt);

        // Everything this session has already said, so a control plane that
        // restarted knows where the conversation got to.
        //
        // Nothing here is acted on: the questions were answered or are still
        // in `asked`, and the frames were sent by whoever was running at the
        // time. What is being rebuilt is what only the reader knows — for
        // Codex, the thread every later turn has to name, which was said once
        // in a line that has long gone past.
        let mut opened = false;
        for (_, line) in self
            .db
            .agent_lines_since(session_id, 0)
            .await
            .unwrap_or_default()
        {
            let read = progress.read(&line);
            // A turn that already started is the proof the first prompt went
            // out. Without this, reconnecting would send it a second time.
            opened |= matches!(read.moved, Some((SessionStatus::Working, _)));
        }
        if opened {
            progress.opening_prompt = None;
        }

        self.progress
            .write()
            .await
            .entry(session_id.to_string())
            .or_insert(progress);
    }

    /// End the turn in progress, leaving the session alive.
    pub async fn interrupt(&self, host_id: &HostId, session_id: &SessionId) -> Result<()> {
        // Noted before it is sent, because the turn can end before this
        // returns. What comes back says `error_during_execution`, and only
        // this side knows it was asked for.
        self.ensure_reader(session_id).await;

        // Claude Code is stopped by a signal its supervisor sends; Codex is
        // asked, in the conversation, and the request has to name the turn.
        let stop = {
            let mut readers = self.progress.write().await;
            match readers.get_mut(session_id.as_str()) {
                Some(progress) => {
                    progress.stopped = true;
                    progress.stop()
                }
                None => Stop::Signal,
            }
        };

        let frame = match stop {
            Stop::Signal => ToWorker::Interrupt {
                session_id: session_id.clone(),
            },
            Stop::Ask(message) => ToWorker::SendTurn {
                session_id: session_id.clone(),
                message,
            },
            // Nothing to stop is not a failure. Somebody pressed stop on a
            // session that was already resting, and there is no turn to end.
            Stop::Nothing => return Ok(()),
        };

        self.send(host_id, frame).await
    }

    pub async fn send_input(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        pty: Pty,
        bytes: &[u8],
    ) -> Result<()> {
        self.send(
            host_id,
            ToWorker::PtyInput {
                session_id: session_id.clone(),
                pty,
                data: encode(bytes),
            },
        )
        .await
    }

    pub async fn resize(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        pty: Pty,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        self.send(
            host_id,
            ToWorker::PtyResize {
                session_id: session_id.clone(),
                pty,
                cols,
                rows,
            },
        )
        .await
    }

    /// What is in a directory of a session's workspace.
    pub async fn list_files(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        path: &str,
    ) -> Result<Result<Vec<ft_core::FileEntry>, String>> {
        let req = ulid::Ulid::new().to_string();
        let (tx, rx) = oneshot::channel();
        self.probes.write().await.insert(
            req.clone(),
            Asked {
                host: host_id.to_string(),
                waiting: Waiting::Listing(tx),
            },
        );

        let sent = self
            .send(
                host_id,
                ToWorker::ListFiles {
                    req: req.clone(),
                    session_id: session_id.clone(),
                    path: path.to_string(),
                },
            )
            .await;

        if let Err(e) = sent {
            self.probes.write().await.remove(&req);
            return Err(e);
        }

        match tokio::time::timeout(std::time::Duration::from_secs(20), rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => Err(anyhow::anyhow!("the host stopped answering")),
            Err(_) => {
                self.probes.write().await.remove(&req);
                Err(anyhow::anyhow!("the host didn't answer in time"))
            }
        }
    }

    /// A file, as a stream of pieces.
    ///
    /// The size comes back before the first piece so a browser can be given a
    /// length and a name with its headers. The receiver is where the body comes
    /// from; dropping it stops the download at the next chunk.
    pub async fn read_file(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        path: &str,
    ) -> Result<Result<(u64, mpsc::Receiver<Vec<u8>>), String>> {
        let req = ulid::Ulid::new().to_string();
        let (opened, wait) = oneshot::channel();
        // Shallow on purpose: this is what makes the worker wait for a slow
        // browser instead of the control plane holding a whole file in memory.
        let (chunks, body) = mpsc::channel(4);

        self.probes.write().await.insert(
            req.clone(),
            Asked {
                host: host_id.to_string(),
                waiting: Waiting::File {
                    opened: Some(opened),
                    chunks,
                },
            },
        );

        let sent = self
            .send(
                host_id,
                ToWorker::ReadFile {
                    req: req.clone(),
                    session_id: session_id.clone(),
                    path: path.to_string(),
                },
            )
            .await;

        if let Err(e) = sent {
            self.probes.write().await.remove(&req);
            return Err(e);
        }

        match tokio::time::timeout(std::time::Duration::from_secs(20), wait).await {
            Ok(Ok(Ok(size))) => Ok(Ok((size, body))),
            Ok(Ok(Err(refused))) => {
                self.probes.write().await.remove(&req);
                Ok(Err(refused))
            }
            Ok(Err(_)) => Err(anyhow::anyhow!("the host stopped answering")),
            Err(_) => {
                self.probes.write().await.remove(&req);
                Err(anyhow::anyhow!("the host didn't answer in time"))
            }
        }
    }

    /// Stop watching. Only tells the worker to let go when nobody is left.
    pub async fn unwatch(&self, host_id: &HostId, session_id: &SessionId, pty: Pty) {
        let key = terminal_key(session_id, pty);
        let mut terminals = self.terminals.write().await;
        let alone = terminals
            .get(&key)
            .map(|tx| tx.receiver_count() <= 1)
            .unwrap_or(true);

        if alone {
            terminals.remove(&key);
            drop(terminals);
            let _ = self
                .send(
                    host_id,
                    ToWorker::PtyClose {
                        session_id: session_id.clone(),
                        pty,
                    },
                )
                .await;
        }
    }

    /// Do something with a session's work, and wait for it to finish.
    pub async fn run_action(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
        action: ft_proto::Action,
        credential: Option<Credential>,
    ) -> Result<Result<String, String>> {
        let req = ulid::Ulid::new().to_string();
        let (tx, rx) = oneshot::channel();
        self.probes.write().await.insert(
            req.clone(),
            Asked {
                host: host_id.to_string(),
                waiting: Waiting::Action(tx),
            },
        );

        if let Err(e) = self
            .send(
                host_id,
                ToWorker::RunAction {
                    req: req.clone(),
                    session_id: session_id.clone(),
                    action,
                    credential,
                },
            )
            .await
        {
            self.probes.write().await.remove(&req);
            return Err(e);
        }

        // Pushing reaches across a network, so this is generous.
        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => anyhow::bail!("the worker connection dropped"),
            Err(_) => {
                self.probes.write().await.remove(&req);
                anyhow::bail!("that didn't finish in time")
            }
        }
    }

    /// What is in a session's workspace that isn't safely elsewhere.
    pub async fn summarize(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
    ) -> Result<Vec<CheckoutSummary>> {
        let req = ulid::Ulid::new().to_string();
        let (tx, rx) = oneshot::channel();
        self.probes.write().await.insert(
            req.clone(),
            Asked {
                host: host_id.to_string(),
                waiting: Waiting::Summary(tx),
            },
        );

        if let Err(e) = self
            .send(
                host_id,
                ToWorker::Summarize {
                    req: req.clone(),
                    session_id: session_id.clone(),
                },
            )
            .await
        {
            self.probes.write().await.remove(&req);
            return Err(e);
        }

        match tokio::time::timeout(PROBE_TIMEOUT, rx).await {
            Ok(Ok(summary)) => Ok(summary),
            Ok(Err(_)) => anyhow::bail!("the worker connection dropped"),
            Err(_) => {
                self.probes.write().await.remove(&req);
                anyhow::bail!("the host didn't answer in time")
            }
        }
    }

    pub async fn is_connected(&self, host_id: &HostId) -> bool {
        self.workers.read().await.contains_key(&host_id.to_string())
    }

    /// Stop talking to a host, deliberately.
    ///
    /// Dropping the sender closes the channel, which ends the task pumping
    /// frames to it. Without this, removing a host leaves that task to discover
    /// the far end has gone by failing — which works, but logs an error for
    /// something we did on purpose.
    pub async fn disconnect(&self, host_id: &HostId) {
        self.workers.write().await.remove(&host_id.to_string());
    }
}

#[cfg(test)]
mod progress_tests {
    use super::*;

    /// Stopping a session is not the same as a session breaking.
    ///
    /// The agent reports both as `error_during_execution`, so the difference is
    /// only knowable from the side that asked. Getting it wrong marked the
    /// session `Failed`, which used to be a state nobody could talk it out of.
    #[test]
    fn a_turn_we_stopped_is_handed_back_rather_than_failed() {
        let broke = concat!(
            r#"{"type":"user","message":{"role":"user","content":[{"text":"go","type":"text"}]}}"#,
            "\n",
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":2}"#
        );

        // Nobody asked: a failure is a failure.
        let mut on_its_own = Progress::for_agent(ft_core::Agent::ClaudeCode, String::new());
        let mut last = None;
        for line in broke.lines() {
            if let Some(moved) = on_its_own.read(line).moved {
                last = Some(moved.0);
            }
        }
        assert_eq!(last, Some(SessionStatus::Failed));

        // Somebody pressed stop: the same bytes mean something else.
        let mut asked = Progress {
            stopped: true,
            ..Progress::for_agent(ft_core::Agent::ClaudeCode, String::new())
        };
        let mut last = None;
        for line in broke.lines() {
            if let Some(moved) = asked.read(line).moved {
                last = Some(moved.0);
            }
        }
        assert_eq!(last, Some(SessionStatus::HandedBack));
    }

    /// And it is spent once, so the turn *after* a stop reports honestly.
    #[test]
    fn stopping_once_does_not_excuse_the_next_failure() {
        let broke = concat!(
            r#"{"type":"user","message":{"role":"user","content":[{"text":"go","type":"text"}]}}"#,
            "\n",
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":2}"#
        );

        let mut progress = Progress {
            stopped: true,
            ..Progress::for_agent(ft_core::Agent::ClaudeCode, String::new())
        };
        for line in broke.lines() {
            progress.read(line);
        }
        assert!(
            !progress.stopped,
            "the flag is spent by the turn it explains"
        );

        let mut last = None;
        for line in broke.lines() {
            if let Some(moved) = progress.read(line).moved {
                last = Some(moved.0);
            }
        }
        assert_eq!(last, Some(SessionStatus::Failed));
    }

    /// The handshake is what makes a Codex session usable, and it finishes on
    /// an answer rather than on a notification — so this is the one line in
    /// the protocol that must not be read as "nothing happened".
    #[test]
    fn a_codex_session_sends_its_first_prompt_once_it_has_a_thread() {
        let mut progress = Progress::for_agent(ft_core::Agent::Codex, "fix the tests".into());

        // Until the thread exists there is nowhere to say it.
        let before =
            progress.read(r#"{"id":1,"result":{"userAgent":"firetower/0.1","codexHome":"/tmp"}}"#);
        assert!(before.send.is_empty(), "no thread yet, so nothing to send");

        let after =
            progress.read(r#"{"id":2,"result":{"thread":{"id":"th_9"},"model":"gpt-5.6-sol"}}"#);
        assert_eq!(after.send.len(), 1, "the prompt goes out on the answer");

        let sent = &after.send[0];
        assert_eq!(sent["method"], "turn/start");
        assert_eq!(sent["params"]["threadId"], "th_9");
        assert_eq!(sent["params"]["input"][0]["text"], "fix the tests");

        // And exactly once: a second line must not re-send it.
        let again = progress.read(r#"{"method":"turn/started","params":{"turn":{"id":"t1","items":[],"status":"inProgress"}}}"#);
        assert!(again.send.is_empty(), "the opening prompt is spent");
    }

    /// The whole point of the controls work: a Codex session offers what Codex
    /// said it can run, and never Claude Code's list.
    ///
    /// The payloads are trimmed copies of what a real app-server answered
    /// with — the shapes have been wrong three times now, always because I
    /// wrote the test from the same guess as the code.
    #[test]
    fn a_codex_session_offers_the_models_it_was_told_about() {
        let log = [
            r#"{"id":1,"result":{"userAgent":"firetower/0.149.1","codexHome":"/tmp"}}"#,
            r#"{"id":3,"result":{"data":[
                {"id":"gpt-5.6-sol","displayName":"GPT-5.6-Sol","description":"Latest frontier agentic coding model.","isDefault":true,"hidden":false,
                 "supportedReasoningEfforts":[{"reasoningEffort":"low","description":"Fast responses with lighter reasoning"},
                                              {"reasoningEffort":"high","description":"Greater reasoning depth for complex problems"}]},
                {"id":"gpt-5.6-terra","displayName":"GPT-5.6-Terra","description":"Balanced agentic coding model.","isDefault":false,"hidden":false}
            ],"nextCursor":null}}"#,
            r#"{"id":2,"result":{"thread":{"id":"th_abc"},"model":"gpt-5.6-sol","approvalPolicy":"on-request","reasoningEffort":"high"}}"#,
        ];

        let mut progress = Progress::for_agent(ft_core::Agent::Codex, "go".into());
        for line in log {
            progress.read(line);
        }

        let controls = progress.controls();
        let picker = |kind: ft_core::controls::ControlKind| {
            controls
                .iter()
                .find(|c| c.kind == kind)
                .unwrap_or_else(|| panic!("no {kind:?} picker"))
        };

        use ft_core::controls::ControlKind as K;
        let models: Vec<_> = picker(K::Model)
            .choices
            .iter()
            .map(|c| c.value.as_str())
            .collect();
        assert_eq!(models, ["gpt-5.6-sol", "gpt-5.6-terra"]);
        assert!(
            !models.iter().any(|m| m.contains("opus")),
            "this is the bug: Claude Code's models on a Codex session"
        );

        // What is in force, which the session reported rather than anybody
        // choosing. A picker showing nothing looks broken.
        assert_eq!(picker(K::Model).current.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(picker(K::Mode).current.as_deref(), Some("on-request"));
        assert_eq!(picker(K::Effort).current.as_deref(), Some("high"));

        // Effort belongs to the default model, not to everything.
        let efforts: Vec<_> = picker(K::Effort)
            .choices
            .iter()
            .map(|c| c.value.as_str())
            .collect();
        assert_eq!(efforts, ["low", "high"]);

        // And the fence, which only this agent has.
        assert_eq!(
            picker(K::Sandbox).current.as_deref(),
            Some(ft_core::controls::SANDBOX_WORKSPACE_NETWORK)
        );
    }

    /// Claude Code keeps exactly what it had, including having no fence.
    #[test]
    fn a_claude_session_is_unchanged_by_any_of_this() {
        let progress = Progress::for_agent(ft_core::Agent::ClaudeCode, "go".into());
        let controls = progress.controls();

        let kinds: Vec<_> = controls.iter().map(|c| c.kind).collect();
        use ft_core::controls::ControlKind as K;
        assert_eq!(kinds, [K::Model, K::Mode, K::Effort]);

        let models: Vec<_> = controls[0]
            .choices
            .iter()
            .map(|c| c.value.as_str())
            .collect();
        assert!(models.contains(&"opus[1m]"));
    }

    /// Stopping names the turn, and a session between turns has nothing to
    /// stop — a request naming no turn would be refused.
    #[test]
    fn stopping_a_codex_session_names_the_turn_it_is_stopping() {
        let mut progress = Progress::for_agent(ft_core::Agent::Codex, String::new());
        progress.read(r#"{"id":2,"result":{"thread":{"id":"th_9"},"model":"gpt-5.6-sol"}}"#);
        assert!(
            matches!(progress.stop(), Stop::Nothing),
            "nothing is running yet"
        );

        progress.read(r#"{"method":"turn/started","params":{"turn":{"id":"turn_7","items":[],"status":"inProgress"}}}"#);
        match progress.stop() {
            Stop::Ask(message) => {
                assert_eq!(message["method"], "turn/interrupt");
                assert_eq!(message["params"]["threadId"], "th_9");
                assert_eq!(message["params"]["turnId"], "turn_7");
            }
            other => panic!("expected a request, got {}", matches!(other, Stop::Signal)),
        }

        // And once it has ended there is nothing to stop again.
        progress.read(r#"{"method":"turn/completed","params":{"turn":{"id":"turn_7","items":[],"status":"completed"}}}"#);
        assert!(matches!(progress.stop(), Stop::Nothing));
    }

    /// Claude Code is signalled, not asked. The two must not be swapped.
    #[test]
    fn stopping_claude_code_is_a_signal() {
        let mut progress = Progress::for_agent(ft_core::Agent::ClaudeCode, String::new());
        assert!(matches!(progress.stop(), Stop::Signal));
    }

    /// Typing at a Codex session has to reach the thread it is talking in.
    #[test]
    fn a_typed_turn_carries_the_thread_and_a_fresh_id() {
        let mut progress = Progress::for_agent(ft_core::Agent::Codex, String::new());
        // Nothing can be said before the conversation exists, and saying so is
        // better than sending a turn into a thread that is not there.
        assert!(progress.turn("hello", &[]).is_err());

        progress.read(r#"{"id":2,"result":{"thread":{"id":"th_9"},"model":"gpt-5.6-sol"}}"#);

        let first = progress.turn("hello", &[]).unwrap();
        let second = progress.turn("again", &[]).unwrap();
        assert_eq!(first["params"]["threadId"], "th_9");
        assert_ne!(
            first["id"], second["id"],
            "two questions cannot share one id, or an answer names both"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::transport::Connection;

    /// A machine that is never there.
    struct Never;

    #[async_trait::async_trait]
    impl Transport for Never {
        fn describe(&self) -> String {
            "a host that isn't there".to_string()
        }
        async fn connect(&self) -> Result<Connection> {
            anyhow::bail!("ssh: connect to host fire-01 port 22: Connection timed out")
        }
    }

    async fn fleet() -> (Fleet, HostId) {
        let (db, _owner) = Db::open_for_test_owned().await.unwrap();
        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local)
            .await
            .unwrap();
        (Fleet::new(db), host.id)
    }

    #[test]
    fn waiting_grows_and_then_stops_growing() {
        let plain = |n| backoff(n, None);

        assert_eq!(plain(0), std::time::Duration::ZERO, "the first try is now");
        assert!(
            plain(1) < plain(3),
            "a host that keeps failing is asked less"
        );
        assert!(
            plain(20) <= RETRY_CAP + RETRY_CAP / 5,
            "a machine that comes back should be noticed within about a minute"
        );
    }

    /// A key nobody accepted is not going to start being accepted a second
    /// later, and each attempt is a process.
    #[test]
    fn a_failure_needing_a_human_is_asked_about_less_often() {
        let soon = backoff(1, None);
        let later = backoff(1, Some(ft_core::Cause::AuthRefused));
        assert!(later > soon, "{later:?} should be longer than {soon:?}");
        assert!(later >= RETRY_FLOOR_HUMAN);
    }

    /// Every host fails at the same moment when a laptop sleeps. Without a
    /// spread they then retry in lockstep for as long as they are down.
    #[test]
    fn waiting_is_not_identical_every_time() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..50 {
            seen.insert(backoff(6, None).as_nanos());
            std::thread::sleep(std::time::Duration::from_micros(50));
        }
        assert!(seen.len() > 1, "every wait was exactly the same length");
    }

    /// The point of the supervisor: a host that didn't answer is still ours,
    /// and something is still trying. That is what the interface reads to tell
    /// "on its way back" from "nobody is looking".
    #[tokio::test]
    async fn a_host_that_never_answers_is_still_being_tried() {
        let (fleet, host) = fleet().await;

        fleet.supervise(host.clone(), Arc::new(Never)).await;

        assert!(fleet.is_supervised(&host).await);
        assert!(!fleet.is_connected(&host).await);

        let said = fleet.db.host_by_id(&host).await.unwrap().unwrap();
        assert_eq!(said.state, ft_core::HostState::Unreachable);
        assert!(said.diagnosis.is_some(), "it should have said why");

        fleet.stop_supervising(&host).await;
        assert!(!fleet.is_supervised(&host).await);
    }

    /// Two supervisors on one host would be two connections racing to register
    /// in the same slot, and only one of them would be reachable.
    #[tokio::test]
    async fn supervising_twice_is_supervising_once() {
        let (fleet, host) = fleet().await;

        fleet.supervise(host.clone(), Arc::new(Never)).await;
        fleet.supervise(host.clone(), Arc::new(Never)).await;

        assert_eq!(fleet.supervised.read().await.len(), 1);
        fleet.stop_supervising(&host).await;
    }

    /// Waiting for a host nobody is trying to reach would be waiting forever
    /// for a promise that was never made.
    #[tokio::test]
    async fn nothing_waits_on_a_host_that_is_not_being_tried() {
        let (fleet, host) = fleet().await;

        let began = std::time::Instant::now();
        let came_back = fleet
            .wait_until_connected(&host, std::time::Duration::from_secs(30))
            .await;

        assert!(!came_back);
        assert!(
            began.elapsed() < std::time::Duration::from_secs(1),
            "it should not have waited out the whole grace period"
        );
    }

    #[tokio::test]
    async fn a_host_nobody_supervises_cannot_be_asked_to_try_now() {
        let (fleet, host) = fleet().await;
        assert!(!fleet.try_now(&host).await);

        fleet.supervise(host.clone(), Arc::new(Never)).await;
        assert!(fleet.try_now(&host).await);
        fleet.stop_supervising(&host).await;
    }
}

#[cfg(test)]
mod supervisor_tests {
    use super::*;
    use crate::db::Db;
    use crate::transport::Connection;

    /// A worker that answers, and keeps the connection open afterwards.
    struct Alive {
        once: std::sync::Mutex<Option<Connection>>,
    }

    impl Alive {
        fn new() -> Arc<Self> {
            let (ours, theirs) = tokio::io::duplex(4096);

            tokio::spawn(async move {
                let (r, w) = tokio::io::split(theirs);
                let mut codec = Codec::new(r, w);
                while let Ok(frame) = codec.read::<ToWorker>().await {
                    let answer = match frame {
                        ToWorker::Hello { .. } => Some(ToServer::Hello {
                            protocol: PROTOCOL_VERSION,
                            worker_version: "0.1.0".to_string(),
                            arch: "test".to_string(),
                            cpus: 1,
                            memory_mb: 0,
                        }),
                        ToWorker::Ping => Some(ToServer::Pong),
                        _ => None,
                    };
                    if let Some(answer) = answer {
                        if codec.write(&answer).await.is_err() {
                            break;
                        }
                    }
                }
            });

            let (r, w) = tokio::io::split(ours);
            Arc::new(Self {
                once: std::sync::Mutex::new(Some(Connection::piped(Box::new(r), Box::new(w)))),
            })
        }
    }

    #[async_trait::async_trait]
    impl Transport for Alive {
        fn describe(&self) -> String {
            "a worker that answers".to_string()
        }
        async fn connect(&self) -> Result<Connection> {
            self.once
                .lock()
                .unwrap()
                .take()
                .context("this fake worker can only be connected to once")
        }
    }

    /// Serving a connection happens inside `connect`, so it only returns when
    /// the connection *ends*. Waiting for that to learn whether a host answered
    /// means waiting for it to stop answering — which held up start-up at the
    /// first host that worked, and left everything after it unsupervised.
    #[tokio::test]
    async fn supervising_returns_while_the_host_is_still_connected() {
        let (db, _owner) = Db::open_for_test_owned().await.unwrap();
        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local)
            .await
            .unwrap();
        let fleet = Fleet::new(db);

        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            fleet.supervise(host.id.clone(), Alive::new()),
        )
        .await
        .expect("it must not wait for the connection to end");

        assert!(
            fleet.is_connected(&host.id).await,
            "it should have come back with the host connected, not disconnected"
        );

        fleet.stop_supervising(&host.id).await;
    }
}

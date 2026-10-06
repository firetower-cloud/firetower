//! Turning what Claude Code prints into [`TurnEvent`]s.
//!
//! Claude Code run headless writes one JSON object per line. Those lines are
//! *frames* — a block opened, a fragment of text, a message finished — while
//! the interface needs *lifecycles*: this item started, grew, ended. Bridging
//! the two is the whole job here, and it is why this is a struct with state
//! rather than a function: correlating a `tool_result` with the `tool_use` it
//! answers means remembering the latter.
//!
//! ## Where this runs, and why it matters
//!
//! In the control plane, not on the worker. Workers live on other people's
//! machines and are upgraded rarely; when an agent changes the shape of its
//! output, a control plane is a deploy and a fleet is a negotiation. Keeping
//! the raw lines as what Firetower stores has a second payoff: a mapping that
//! turns out to be wrong can be corrected and the history re-derived, rather
//! than migrated or lost.
//!
//! ## On guessing
//!
//! Claude Code does not say what kind of thing a tool is. It says `Bash`,
//! `Edit`, `mcp__linear__create_issue`, and it grows new ones between releases.
//! So [`classify`] guesses from the name, and the guess is allowed to be wrong:
//! anything unrecognised becomes [`ItemKind::Unknown`], which draws a generic
//! card with the tool's name, input and output. Being wrong costs a nicer card.
//! It never costs the event.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::turn::{
    ItemId, ItemKind, ItemStatus, ModelUsage, PlanStep, PlanStepStatus, Question, QuestionOption,
    RawSource, RequestId, RequestKind, SlashCommand, StreamKind, TaskId, TurnEvent, TurnId,
    TurnStatus, Usage,
};

/// What a tool's name suggests it does.
///
/// Ordered most-specific first: `mcp__…__read_file` is an MCP call before it is
/// a read, because which server it came from is the more useful thing to draw.
pub fn classify(tool_name: &str) -> ItemKind {
    let name = tool_name.to_ascii_lowercase();

    // Before everything, including MCP: `skills.read` would otherwise be read
    // as a file read, and a skill being loaded is not work done to the
    // workspace. Claude Code calls the tool `Skill`; Codex namespaces its two
    // as `skills.read` and `skills.list`.
    if name == "skill" || name.starts_with("skills.") {
        return ItemKind::SkillUse;
    }
    if name.starts_with("mcp__") || name.contains("mcp") {
        return ItemKind::McpToolCall;
    }
    // `Task` in older builds, `Agent` since. Both, because a host somewhere is
    // running the other one.
    if name == "task" || name == "agent" || name.contains("subagent") {
        return ItemKind::SubagentCall;
    }
    // Before the generic checks: this is a question put to a person, not a
    // tool that did something.
    if name.contains("question") && (name.contains("ask") || name.contains("user")) {
        return ItemKind::Question;
    }
    if name.contains("bash") || name.contains("command") || name.contains("shell") {
        return ItemKind::CommandExecution;
    }
    if name.contains("websearch")
        || name.contains("webfetch")
        || name.contains("search") && name.contains("web")
    {
        return ItemKind::WebSearch;
    }
    // Read-ish before write-ish: `read` and `notebookread` must not be caught
    // by the `edit`/`write` list below.
    if name == "read" || name == "glob" || name == "grep" || name.contains("read") {
        return ItemKind::FileRead;
    }
    if name.contains("edit")
        || name.contains("write")
        || name.contains("patch")
        || name.contains("replace")
    {
        return ItemKind::FileChange;
    }
    ItemKind::Unknown
}

/// Which skill a call is reaching for, if it is reaching for one.
///
/// Three agents spell the same act three ways, and the interface should not
/// have to know that. Every reader runs this and writes the answer into the
/// item's data under one key, so a client reads `skill` and nothing else.
///
/// * **Claude Code** calls a tool named `Skill` with `{"skill": "<name>"}`.
///   Verified against a real session: `{"type":"tool_use","name":"Skill",
///   "input":{"skill":"frontend-design"}}`.
/// * **Codex** has a `skills.read` tool in the binary and does not use it.
///   What it actually does — verified in a live session — is run
///   `cat …/skills/frontend-design/SKILL.md` in a shell. So the evidence is a
///   *command*, and anything that only looked at tool names would never see
///   a Codex skill at all.
/// * **Kimi, over ACP**, has a tool and announces it in three stages: a call
///   titled `Skill` with no name, then the arguments streaming as text, and
///   only at the end `rawInput: {"skill": "frontend-design"}` with the title
///   rewritten to `Invoke skill frontend-design`. So the name is not there
///   when the item opens, and whatever reads it has to cope with that.
///
/// Which leaves one rule doing most of the work: **a path ending in
/// `SKILL.md` under a `skills/` directory**, wherever it turns up — a tool's
/// argument, a read's location, or a word inside a shell command. The folder
/// holding it is the skill, which is what the standard says a folder is.
pub fn skill_reached_for(tool_name: &str, input: &Value) -> Option<String> {
    let at = |key: &str| input.get(key).and_then(Value::as_str);
    let name = tool_name.to_ascii_lowercase();

    // Arguments one level down, which is where ACP puts them once they have
    // finished arriving.
    for nested in ["rawInput", "arguments", "input"] {
        if let Some(found) = input
            .get(nested)
            .and_then(|o| o.get("skill"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return Some(skill_from(found));
        }
    }
    // `Invoke skill frontend-design`, which is Kimi's title once it knows.
    if let Some(found) = at("title").and_then(|t| t.strip_prefix("Invoke skill ")) {
        return Some(found.trim().to_string());
    }

    if name == "skill" || name.starts_with("skills.") {
        // `package` is Codex's word for which skill a read belongs to.
        if let Some(found) = at("skill").or_else(|| at("package")).or_else(|| at("name")) {
            return Some(skill_from(found));
        }
        // Listing them is not using one, and `skills.read` with nothing to go
        // on is better unnamed than wrongly named.
        return (name == "skill").then(|| "a skill".to_string());
    }

    // A read of a SKILL.md, whatever the agent called the tool that did it.
    for key in ["path", "file_path", "filePath", "resource", "title"] {
        if let Some(path) = at(key) {
            if let Some(found) = skill_from_path(path) {
                return Some(found);
            }
        }
    }
    // Or a shell command that opens one, which is how Codex does it.
    for key in ["command", "parsedCmd", "cmd"] {
        if let Some(found) = input.get(key).and_then(skill_in_command) {
            return Some(found);
        }
    }
    None
}

/// A `SKILL.md` named anywhere inside a shell command.
///
/// `cat '…/skills/frontend-design/SKILL.md'`, and the quoting is whatever the
/// agent felt like — so this splits on whitespace and strips the punctuation a
/// shell leaves behind rather than trying to parse the line.
fn skill_in_command(command: &Value) -> Option<String> {
    let text = match command {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    text.split_whitespace()
        .map(|word| word.trim_matches(|c| matches!(c, '\'' | '"' | '`' | ';' | '(' | ')')))
        .find_map(skill_from_path)
}

/// `skill://rust-review/SKILL.md` or `rust-review` → `rust-review`.
fn skill_from(raw: &str) -> String {
    raw.trim_start_matches("skill://")
        .split('/')
        .find(|part| !part.is_empty() && *part != "SKILL.md")
        .unwrap_or(raw)
        .to_string()
}

/// The folder a `SKILL.md` sits in, which is the skill's name.
///
/// Only under a `skills/` directory. Without that, an agent reading the
/// `SKILL.md` it is *writing* — which is a perfectly ordinary thing to do in
/// this repository — would be reported as having used a skill, and a label
/// that is wrong some of the time is worse than no label.
fn skill_from_path(path: &str) -> Option<String> {
    if !path.ends_with("SKILL.md") || !path.contains("skills/") {
        return None;
    }
    path.trim_end_matches("SKILL.md")
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty() && *s != "skills")
        .map(str::to_string)
}

/// What a person is actually being asked to allow.
///
/// Coarser than [`classify`], because the question is "may this run", not
/// "which of forty tools is this". Read-only calls are separated out because
/// they are the ones somebody can wave through without reading.
pub fn classify_request(tool_name: &str) -> RequestKind {
    match classify(tool_name) {
        ItemKind::CommandExecution => RequestKind::CommandExecution,
        ItemKind::FileRead => RequestKind::FileRead,
        ItemKind::FileChange => RequestKind::FileChange,
        _ => RequestKind::Tool,
    }
}

/// What to call a card before anything has arrived in it.
fn title_for(kind: ItemKind, tool_name: &str) -> Option<String> {
    match kind {
        ItemKind::AssistantMessage | ItemKind::UserMessage => None,
        ItemKind::Reasoning => Some("Thinking".into()),
        // Named once the arguments arrive, which for a streamed call is after
        // this. "Skill" alone is what a card says in the meantime.
        ItemKind::SkillUse => Some("Skill".into()),
        _ => Some(tool_name.to_string()),
    }
}

/// Whichever protocol a session's lines are in.
///
/// Every consumer of a transcript — the inbox, the browser's replay, a person
/// tailing a session on a host — has to pick the same reader for the same
/// session, and picking it is one line rather than three copies of a match.
///
/// An enum rather than a trait object because both are known and neither is
/// pluggable: a third agent is a variant here and a compiler error at each
/// place that has to care, which is the outcome worth having.
pub enum Reader {
    // Both boxed. An enum is as big as its largest arm, and each of these
    // holds a session's worth of correlation state — so the one that happens
    // to be smaller today would still pay for the other.
    Claude(Box<ClaudeNormaliser>),
    Codex(Box<crate::codex::CodexNormaliser>),
    Acp(Box<crate::acp::AcpNormaliser>),
}

impl Reader {
    /// The reader for the agent a session runs.
    pub fn for_agent(agent: crate::Agent) -> Self {
        match agent {
            crate::Agent::Codex => {
                let mut reader = crate::codex::CodexNormaliser::new();
                // The worker opened the conversation at a known id, and only
                // the sender of a request can say what its id meant.
                reader.sent_thread_start(crate::codex::THREAD_START_ID);
                reader.sent_model_list(crate::codex::MODEL_LIST_ID);
                Reader::Codex(Box::new(reader))
            }
            crate::Agent::KimiCode => Reader::Acp(Box::default()),
            _ => Reader::Claude(Box::new(ClaudeNormaliser::new())),
        }
    }

    /// Read one line and report everything it means.
    pub fn push(&mut self, line: &str) -> Vec<TurnEvent> {
        match self {
            Reader::Claude(reader) => reader.push(line),
            Reader::Codex(reader) => reader.push(line),
            Reader::Acp(reader) => reader.push(line),
        }
    }

    /// The Codex thread this conversation is in, when there is one.
    pub fn thread(&self) -> Option<&str> {
        match self {
            Reader::Claude(_) | Reader::Acp(_) => None,
            Reader::Codex(reader) => reader.thread(),
        }
    }

    /// The turn now running, for the agents that need one named to stop it.
    pub fn active_turn(&self) -> Option<&str> {
        match self {
            Reader::Claude(_) | Reader::Acp(_) => None,
            Reader::Codex(reader) => reader.active_turn(),
        }
    }

    /// Whether a turn is running at all.
    ///
    /// Not [`Self::active_turn`]: that answers *which* turn, which only one of
    /// these agents needs and only because its interrupt request has to name
    /// one. This answers the question both of them have — is there anything to
    /// stop — so that pressing stop on a resting session is nothing rather than
    /// a request the agent will refuse.
    pub fn working(&self) -> bool {
        match self {
            Reader::Claude(reader) => reader.working(),
            Reader::Codex(reader) => reader.active_turn().is_some(),
            Reader::Acp(reader) => reader.working(),
        }
    }
}

/// One open assistant block, keyed by its index within the current message.
struct OpenBlock {
    item: ItemId,
    stream: StreamKind,
}

/// Reads Claude Code's `stream-json` output and reports what happened.
///
/// Feed it lines in the order they were written. It is cheap to construct and
/// holds only what correlation needs, so one per session is the intended use.
#[derive(Default)]
pub struct ClaudeNormaliser {
    /// Turns are numbered rather than named: the agent gives us nothing stable
    /// to key them by, and an ordinal is reproducible on a re-read. Spelled
    /// out in full — `turn-3`, not `t3` — because the short form reads as a
    /// product name rather than as a counter.
    turns_seen: u32,
    active_turn: Option<TurnId>,
    /// The message the current blocks belong to. Block indices restart at zero
    /// with every message, so on its own an index names nothing.
    current_message: Option<String>,
    open_blocks: HashMap<u64, OpenBlock>,
    /// Tool calls we have seen start and not yet seen finish.
    open_tools: HashMap<String, ItemKind>,
    /// Tool calls that asked somebody a question and have not been answered.
    ///
    /// The whole transcript is replayed on every attach, so without this every
    /// question ever asked comes back as a question still waiting: nothing else
    /// in a stored line distinguishes one the agent is blocked on from one it
    /// acted on an hour ago. The `tool_result` is what says which — it carries
    /// the id of the call it answers.
    asked: HashSet<String>,
    /// The subagent each spawning tool call owns, so its work can be attributed.
    tasks: HashMap<String, TaskId>,
    /// The agent's own task list, accumulated.
    ///
    /// Held rather than derived because the newer tools add one item per call
    /// and never restate the list, so the only place the whole plan exists is
    /// here. See [`ClaudeNormaliser::plan_tool`].
    plan: Vec<PlanStep>,
    /// What the main agent had in front of it on its most recent request.
    ///
    /// The only honest answer to "how full is the context", and nothing in the
    /// `result` totals can be made to give it: those accumulate over the turn,
    /// so a cached prefix that was read fifteen times is counted fifteen times.
    /// A request, by contrast, states the whole window it saw in one number.
    /// Subagents are excluded — they read a window of their own.
    last_request: Option<Request>,
    /// The model it last said it was running, as it spelled it.
    ///
    /// Kept because nothing else keeps it. Claude Code is told which model to
    /// use and never asked what it has, so the only statement of what a session
    /// is actually running is the `init` line at the start of each turn — and
    /// that was read for the event and then dropped, which left every picker
    /// drawing the word "Model" over a running session. See
    /// [`crate::controls::claude_choice_for`].
    model: Option<String>,
    /// The permission mode it last said it was running under.
    ///
    /// Kept for the same reason as `model`, and from both places it is said:
    /// `init` at the top of every turn, and the `status` line a change
    /// mid-turn produces.
    mode: Option<String>,
}

/// One request's view of the window, kept so the turn can report the last one.
#[derive(Clone)]
struct Request {
    /// As the message spells it, to be matched against the `modelUsage` keys.
    model: Option<String>,
    /// Input plus both kinds of cache plus what came back.
    used: u64,
    output: u64,
}

impl ClaudeNormaliser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether a turn is open — see [`Reader::working`].
    pub fn working(&self) -> bool {
        self.active_turn.is_some()
    }

    /// The model it last said it was running, if it has said yet.
    ///
    /// A resolved name rather than one of the picker's aliases —
    /// `claude-haiku-4-5-20251001`, not `haiku`. [`crate::controls::claude_choice_for`]
    /// is what bridges the two.
    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    /// The permission mode it last said it was running under, if it has said.
    ///
    /// Already one of the picker's own values — `auto`, `plan`, `acceptEdits` —
    /// so unlike the model it needs no mapping.
    pub fn mode(&self) -> Option<&str> {
        self.mode.as_deref()
    }

    /// Read one line and report everything it means.
    ///
    /// A line we cannot parse at all is reported as nothing rather than as an
    /// error: a normaliser that stops on one bad line loses the rest of a
    /// session it could have shown.
    pub fn push(&mut self, line: &str) -> Vec<TurnEvent> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        self.push_value(&value)
    }

    fn push_value(&mut self, v: &Value) -> Vec<TurnEvent> {
        let mut out = Vec::new();
        match str_at(v, "type") {
            Some("error") => match crate::quota::failure(&v["error"]) {
                Some(event) => out.push(event),
                None => out.push(raw(v)),
            },
            Some("system") => self.system(v, &mut out),
            Some("stream_event") => self.stream_event(v, &mut out),
            Some("assistant") => self.assistant(v, &mut out),
            Some("user") => self.user(v, &mut out),
            Some("result") => self.result(v, &mut out),
            Some("rate_limit_event") => match limits(v) {
                Some(event) => out.push(event),
                None => out.push(raw(v)),
            },
            // Anything else new. Kept, not named.
            _ => out.push(raw(v)),
        }
        out
    }

    // ---- system ---------------------------------------------------------

    fn system(&mut self, v: &Value, out: &mut Vec<TurnEvent>) {
        match str_at(v, "subtype") {
            Some("init") => {
                let model = str_at(v, "model").unwrap_or_default();
                // Only here, and only when it said something. The `status`
                // restatement below carries no model on purpose, and letting it
                // through would blank what the last `init` established.
                if !model.is_empty() {
                    self.model = Some(model.to_string());
                }
                let mode = str_at(v, "permissionMode").unwrap_or_default();
                if !mode.is_empty() {
                    self.mode = Some(mode.to_string());
                }
                out.push(TurnEvent::SessionConfigured {
                    model: model.to_string(),
                    mode: mode.to_string(),
                    tools: string_list(v.get("tools")),
                    // `slash_commands`, not `commands`. Reading the wrong key
                    // cost nothing visible until something started drawing the
                    // menu.
                    commands: slash_commands(v.get("slash_commands")),
                })
            }
            Some("task_started") => {
                let (Some(task_id), Some(tool_use_id)) =
                    (str_at(v, "task_id"), str_at(v, "tool_use_id"))
                else {
                    out.push(raw(v));
                    return;
                };
                let task = TaskId::new(task_id);
                self.tasks.insert(tool_use_id.to_string(), task.clone());
                out.push(TurnEvent::TaskStarted {
                    task,
                    item: ItemId::new(tool_use_id),
                    description: str_at(v, "description").unwrap_or_default().to_string(),
                    agent: str_at(v, "subagent_type").map(str::to_string),
                });
            }
            Some("task_progress") => {
                if let Some(task_id) = str_at(v, "task_id") {
                    out.push(TurnEvent::TaskProgress {
                        task: TaskId::new(task_id),
                        detail: str_at(v, "description").unwrap_or_default().to_string(),
                    });
                }
            }
            Some("task_notification") => {
                if let Some(task_id) = str_at(v, "task_id") {
                    let status = match str_at(v, "status") {
                        Some("completed") => ItemStatus::Completed,
                        _ => ItemStatus::Failed,
                    };
                    out.push(TurnEvent::TaskCompleted {
                        task: TaskId::new(task_id),
                        status,
                        summary: str_at(v, "summary").map(str::to_string),
                    });
                }
            }
            // The mode changed, which is the one thing this says that somebody
            // can see. `init` restates it too, but only at the start of the
            // next turn — long after they moved the picker and are watching to
            // see whether it took. Nothing else in here is worth a card.
            Some("status") => match str_at(v, "permissionMode") {
                Some(mode) => {
                    // Unlike the model, this one *is* restated mid-turn — it is
                    // how a change made from the picker comes back — so it has
                    // to land here as well as on `init`.
                    self.mode = Some(mode.to_string());
                    out.push(TurnEvent::SessionConfigured {
                        // Only what it said. A restatement fills in what it
                        // leaves out, and this one is about the mode alone.
                        model: String::new(),
                        mode: mode.to_string(),
                        tools: Vec::new(),
                        commands: Vec::new(),
                    })
                }
                None => out.push(raw(v)),
            },
            // `task_updated` repeats what `task_notification` says with less in
            // it, and the rest of `status`/`thinking_tokens` is telemetry.
            _ => out.push(raw(v)),
        }
    }

    // ---- streaming ------------------------------------------------------

    fn stream_event(&mut self, v: &Value, out: &mut Vec<TurnEvent>) {
        let Some(event) = v.get("event") else {
            out.push(raw(v));
            return;
        };
        // A subagent narrates its own work. Letting that through interleaves
        // several voices into one transcript; its *tool* blocks still flow
        // below, attributed, because those are what the Agents panel draws.
        let inside_subagent = str_at(v, "parent_tool_use_id").is_some();

        match str_at(event, "type") {
            Some("message_start") => {
                self.current_message = event
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                self.open_blocks.clear();
                self.ensure_turn(out);
                if !inside_subagent {
                    self.note_request(event);
                }
            }
            Some("message_delta") => {
                if !inside_subagent {
                    if let (Some(request), Some(output)) = (
                        self.last_request.as_mut(),
                        event
                            .pointer("/usage/output_tokens")
                            .and_then(Value::as_u64),
                    ) {
                        request.used = request.used - request.output + output;
                        request.output = output;
                    }
                }
            }
            Some("content_block_start") => {
                let Some(block) = event.get("content_block") else {
                    return;
                };
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                self.open_block(block, index, inside_subagent, v, out);
            }
            Some("content_block_delta") => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                let Some(delta) = event.get("delta") else {
                    return;
                };
                self.block_delta(delta, index, out);
            }
            Some("content_block_stop") => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                // Only prose ends here. A tool call is not finished when the
                // model stops describing it — it is finished when it has run,
                // which arrives later as a `tool_result`.
                if let Some(open) = self.open_blocks.remove(&index) {
                    if matches!(
                        open.stream,
                        StreamKind::AssistantText | StreamKind::Reasoning
                    ) {
                        out.push(TurnEvent::ItemCompleted {
                            item: open.item,
                            status: ItemStatus::Completed,
                        });
                    }
                }
            }
            // `message_stop` says nothing we don't already know.
            _ => {}
        }
    }

    fn open_block(
        &mut self,
        block: &Value,
        index: u64,
        inside_subagent: bool,
        envelope: &Value,
        out: &mut Vec<TurnEvent>,
    ) {
        match str_at(block, "type") {
            Some("text") | Some("thinking") => {
                if inside_subagent {
                    return;
                }
                let reasoning = str_at(block, "type") == Some("thinking");
                let kind = if reasoning {
                    ItemKind::Reasoning
                } else {
                    ItemKind::AssistantMessage
                };
                let item = self.block_item_id(index);
                self.open_blocks.insert(
                    index,
                    OpenBlock {
                        item: item.clone(),
                        stream: if reasoning {
                            StreamKind::Reasoning
                        } else {
                            StreamKind::AssistantText
                        },
                    },
                );
                out.push(TurnEvent::ItemStarted {
                    item,
                    kind,
                    title: title_for(kind, ""),
                    task: None,
                });
            }
            Some("tool_use") | Some("server_tool_use") | Some("mcp_tool_use") => {
                let Some(id) = str_at(block, "id") else {
                    return;
                };
                let name = str_at(block, "name").unwrap_or("tool");
                let kind = classify(name);
                let item = ItemId::new(id);
                self.open_tools.insert(id.to_string(), kind);
                self.open_blocks.insert(
                    index,
                    OpenBlock {
                        item: item.clone(),
                        stream: StreamKind::ToolInput,
                    },
                );
                out.push(TurnEvent::ItemStarted {
                    item,
                    kind,
                    title: title_for(kind, name),
                    task: self.owning_task(envelope),
                });
            }
            _ => {}
        }
    }

    fn block_delta(&mut self, delta: &Value, index: u64, out: &mut Vec<TurnEvent>) {
        let Some(open) = self.open_blocks.get(&index) else {
            return;
        };
        let (stream, text) = match str_at(delta, "type") {
            Some("text_delta") => (StreamKind::AssistantText, str_at(delta, "text")),
            Some("thinking_delta") => (StreamKind::Reasoning, str_at(delta, "thinking")),
            Some("input_json_delta") => (StreamKind::ToolInput, str_at(delta, "partial_json")),
            // `signature_delta` is the model signing its own reasoning. Nothing
            // to draw.
            _ => return,
        };
        let Some(text) = text.filter(|t| !t.is_empty()) else {
            return;
        };
        out.push(TurnEvent::ContentDelta {
            item: open.item.clone(),
            stream,
            delta: text.to_string(),
        });
    }

    // ---- whole messages -------------------------------------------------

    /// The authoritative copy of a block the stream has been dribbling out.
    ///
    /// Only used for what the stream cannot give us cleanly: a tool's arguments
    /// arrive as JSON fragments that are not valid JSON until the last one, so
    /// this is where a card finally learns what command it is showing. Text is
    /// deliberately *not* re-emitted here — it already streamed.
    fn assistant(&mut self, v: &Value, out: &mut Vec<TurnEvent>) {
        let task = self.owning_task(v);
        self.note_request(v);
        let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else {
            return;
        };
        for block in blocks {
            if !matches!(
                str_at(block, "type"),
                Some("tool_use") | Some("server_tool_use") | Some("mcp_tool_use")
            ) {
                continue;
            }
            let Some(id) = str_at(block, "id") else {
                continue;
            };
            // A subagent's tool call may never have opened here, because its
            // narration was dropped. Open it now so the item exists.
            if !self.open_tools.contains_key(id) {
                let name = str_at(block, "name").unwrap_or("tool");
                let kind = classify(name);
                self.open_tools.insert(id.to_string(), kind);
                out.push(TurnEvent::ItemStarted {
                    item: ItemId::new(id),
                    kind,
                    title: title_for(kind, name),
                    task: task.clone(),
                });
            }
            let Some(input) = block.get("input") else {
                continue;
            };
            // One key for every agent: whichever tool this was, if it was the
            // agent reaching for a skill, say which one here. A client that
            // had to know Claude Code's spelling as well as Codex's and
            // Kimi's would be three rules that drift apart.
            let mut data = input.clone();
            let tool = str_at(block, "name").unwrap_or_default();
            if let (Some(found), Some(fields)) =
                (skill_reached_for(tool, input), data.as_object_mut())
            {
                fields.insert("skill".into(), Value::String(found));
            }
            out.push(TurnEvent::ItemUpdated {
                item: ItemId::new(id),
                data,
            });

            // Some tools carry structure worth lifting out of the generic
            // card, because the interface draws them as something other than a
            // tool call: a task list is the plan, and a question is a question.
            let name = str_at(block, "name").unwrap_or_default();
            if name == "AskUserQuestion" {
                if let Some(questions) = questions_from_input(input) {
                    self.asked.insert(id.to_string());
                    out.push(TurnEvent::UserInputRequested {
                        req: RequestId::new(id),
                        questions,
                    });
                }
            } else {
                self.plan_tool(name, input, out);
            }
        }
    }

    /// Keep the plan up to date, if this tool call is one that changes it.
    ///
    /// Two shapes, because Claude Code changed how it tracks its own work and
    /// hosts run whichever build they have:
    ///
    /// - `TodoWrite` restates the whole list every time, so it simply replaces.
    /// - `TaskCreate` adds one item per call and `TaskUpdate` sets a status by
    ///   `taskId`. Nothing ever restates the list, so accumulating it here is
    ///   the only way to have one.
    ///
    /// The ids the newer tools use are 1-based and handed out in creation
    /// order — the tool says so in its own result ("Task #1 created"). Counting
    /// positions rather than reading that sentence keeps this out of the
    /// business of parsing prose.
    fn plan_tool(&mut self, tool_name: &str, input: &Value, out: &mut Vec<TurnEvent>) {
        match tool_name {
            "TodoWrite" => {
                let Some(steps) = plan_from_todo_input(input) else {
                    return;
                };
                self.plan = steps;
            }
            "TaskCreate" => {
                let Some(subject) = str_at(input, "subject") else {
                    return;
                };
                self.plan.push(PlanStep {
                    step: subject.to_string(),
                    status: PlanStepStatus::Pending,
                });
            }
            "TaskUpdate" => {
                let Some(status) = str_at(input, "status").map(plan_step_status) else {
                    return;
                };
                let position = str_at(input, "taskId")
                    .and_then(|id| id.parse::<usize>().ok())
                    .or_else(|| {
                        input
                            .get("taskId")
                            .and_then(Value::as_u64)
                            .map(|n| n as usize)
                    });
                let Some(step) = position.and_then(|n| self.plan.get_mut(n.saturating_sub(1)))
                else {
                    return;
                };
                step.status = status;
            }
            _ => return,
        }
        out.push(TurnEvent::PlanUpdated {
            steps: self.plan.clone(),
        });
    }

    /// Either somebody typing, or a tool reporting back.
    fn user(&mut self, v: &Value, out: &mut Vec<TurnEvent>) {
        let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else {
            return;
        };

        let results: Vec<&Value> = blocks
            .iter()
            .filter(|b| str_at(b, "type") == Some("tool_result"))
            .collect();

        if results.is_empty() {
            // Injected by the harness rather than typed by anybody. The note
            // that follows a downscaled screenshot — "[Image: original
            // 2880x1800, displayed at 2000x1250 …]" — is addressed to the
            // model, and it arrives in the shape of a user message: drawn
            // as one, it puts words in somebody's mouth.
            //
            // The flag decides this, never the text. Somebody quoting that
            // same sentence back — asking what produces it — is a real
            // message, and a content match would swallow the question being
            // asked. An agent that stops setting the flag goes back to the
            // old behaviour rather than losing anything.
            if v.get("isSynthetic").and_then(Value::as_bool) == Some(true) {
                return;
            }

            // Two different things arrive in this shape. One is our own turn,
            // echoed back — worth keeping, because it is what makes the stored
            // log the whole conversation rather than half of it. The other is
            // the instruction handed to a subagent, which is that subagent's
            // first message and not a person typing.
            let task = self.owning_task(v);
            if task.is_none() {
                self.begin_turn(out);
            }

            // Keyed by the agent's own identifier for the message. It was the
            // turn number and a word, which two of these in one turn collide
            // on — and they do, every time work is delegated.
            let item = ItemId::new(match str_at(v, "uuid") {
                Some(uuid) => format!("msg:{uuid}"),
                None => format!("turn-{}:user", self.turns_seen),
            });

            out.push(TurnEvent::ItemStarted {
                item: item.clone(),
                kind: ItemKind::UserMessage,
                title: None,
                task,
            });
            // Pictures first, because that is the order they were sent in and
            // the order they read in. Carried rather than counted: a transcript
            // that says "1 image" cannot answer "which one did I send?", which
            // is the question somebody scrolling back is asking.
            let images = attached(blocks);
            if !images.is_empty() {
                out.push(TurnEvent::ItemUpdated {
                    item: item.clone(),
                    data: serde_json::json!({ "images": images }),
                });
            }

            let text = blocks
                .iter()
                .filter_map(|b| str_at(b, "text"))
                .collect::<Vec<_>>()
                .join("");
            if !text.is_empty() {
                out.push(TurnEvent::ContentDelta {
                    item: item.clone(),
                    stream: StreamKind::UserText,
                    delta: text,
                });
            }
            out.push(TurnEvent::ItemCompleted {
                item,
                status: ItemStatus::Completed,
            });
            return;
        }

        for result in results {
            let Some(id) = str_at(result, "tool_use_id") else {
                continue;
            };
            let failed = result
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if let Some(text) = tool_result_text(result) {
                out.push(TurnEvent::ContentDelta {
                    item: ItemId::new(id),
                    stream: StreamKind::ToolOutput,
                    delta: text,
                });
            }
            // The picture a tool handed back — the screenshot an agent just
            // captured, the chart it just drew. Carried on the tool's own
            // item, the way a message carries the pictures sent with it, and
            // through the same `attached`: base64 sources only, so a tool
            // reporting a URL cannot turn into a request the interface makes.
            //
            // A result that is a plain string, or one carrying no picture,
            // produces no event and the card stays exactly what it was.
            let images = result
                .get("content")
                .and_then(Value::as_array)
                .map(|blocks| attached(blocks))
                .unwrap_or_default();
            if !images.is_empty() {
                out.push(TurnEvent::ItemUpdated {
                    item: ItemId::new(id),
                    data: serde_json::json!({ "images": images }),
                });
            }

            self.open_tools.remove(id);
            out.push(TurnEvent::ItemCompleted {
                item: ItemId::new(id),
                status: if failed {
                    ItemStatus::Failed
                } else {
                    ItemStatus::Completed
                },
            });

            // After the item is finished, so the transcript entry is complete
            // before the card asking for an answer is taken away.
            if self.asked.remove(id) {
                out.push(TurnEvent::UserInputResolved {
                    req: RequestId::new(id),
                    // What came back, not a reading of it. The interface parses
                    // the choices out of the result for the transcript entry;
                    // this event is about the card going away, and passing the
                    // block along keeps a second parser from existing here.
                    answers: result.clone(),
                });
            }
        }
    }

    fn result(&mut self, v: &Value, out: &mut Vec<TurnEvent>) {
        // Resuming a session replays its handshake, which ends in a `result`
        // reporting no turns. Treating that as a completed turn invents one
        // that never happened and lands a spurious "finished" in the inbox.
        if v.get("num_turns").and_then(Value::as_u64) == Some(0) && self.active_turn.is_none() {
            return;
        }
        let Some(turn) = self.active_turn.take() else {
            return;
        };
        let status = match str_at(v, "subtype") {
            Some("success") => TurnStatus::Completed,
            Some(s) if s.contains("interrupt") || s.contains("abort") => TurnStatus::Interrupted,
            _ => TurnStatus::Failed,
        };
        // Claude Code puts its reason in `result` on a failure, and says
        // nothing there when it succeeded.
        let detail = (status != TurnStatus::Completed)
            .then(|| str_at(v, "result").map(str::to_string))
            .flatten();

        out.push(TurnEvent::TurnCompleted {
            turn,
            status,
            usage: usage(v, self.last_request.as_ref()),
            detail,
        });
    }

    // ---- turn bookkeeping ----------------------------------------------

    /// Start a turn if one isn't already running.
    ///
    /// Normally the echoed user message opens it. This covers a session that
    /// starts talking without one — a resumed session finishing work it began
    /// before anybody was watching.
    fn ensure_turn(&mut self, out: &mut Vec<TurnEvent>) {
        if self.active_turn.is_none() {
            self.begin_turn(out);
        }
    }

    fn begin_turn(&mut self, out: &mut Vec<TurnEvent>) {
        if self.active_turn.is_some() {
            return;
        }
        self.last_request = None;
        self.turns_seen += 1;
        let turn = TurnId::new(format!("turn-{}", self.turns_seen));
        self.active_turn = Some(turn.clone());
        out.push(TurnEvent::TurnStarted { turn });
    }

    fn block_item_id(&self, index: u64) -> ItemId {
        // Block indices restart with each message, so the message id is what
        // makes this unique — and both come from the agent, so a re-read names
        // the same block the same way.
        match &self.current_message {
            Some(message) => ItemId::new(format!("{message}:{index}")),
            None => ItemId::new(format!("turn-{}:{index}", self.turns_seen)),
        }
    }

    /// The subagent that owns this message, if one does.
    fn owning_task(&self, envelope: &Value) -> Option<TaskId> {
        let parent = str_at(envelope, "parent_tool_use_id")?;
        self.tasks.get(parent).cloned()
    }

    /// Remember how much the main agent was carrying on this request.
    ///
    /// Every assistant message restates it in full, so the last one to arrive
    /// is the current occupancy — no accumulation, nothing to drift. The stream
    /// repeats a message as its blocks settle; taking the latest makes that
    /// harmless. A message owned by a subagent is skipped: its window is not
    /// the one on screen.
    fn note_request(&mut self, v: &Value) {
        if v.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) {
            return;
        }
        let Some(usage) = v.pointer("/message/usage") else {
            return;
        };
        let read = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
        let used = read("input_tokens")
            + read("cache_read_input_tokens")
            + read("cache_creation_input_tokens")
            + read("output_tokens");
        if used == 0 {
            return;
        }
        self.last_request = Some(Request {
            model: v
                .pointer("/message/model")
                .and_then(Value::as_str)
                .map(str::to_string),
            used,
            output: read("output_tokens"),
        });
    }
}

// ---- small readers ------------------------------------------------------

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn raw(v: &Value) -> TurnEvent {
    TurnEvent::Raw {
        source: RawSource::ClaudeStreamJson,
        payload: v.clone(),
    }
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn slash_commands(v: Option<&Value>) -> Vec<SlashCommand> {
    let Some(items) = v.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| match item {
            // Reported as bare names in some builds and as objects in others.
            Value::String(name) => Some(SlashCommand {
                name: name.clone(),
                description: None,
            }),
            Value::Object(_) => str_at(item, "name").map(|name| SlashCommand {
                name: name.to_string(),
                description: str_at(item, "description").map(str::to_string),
            }),
            _ => None,
        })
        .collect()
}

/// The pictures in a message, in the shape the interface draws them.
///
/// Only base64 sources. A URL source would be somebody else's server, and
/// nothing here sends one — but an agent could echo one back, and quietly
/// turning that into an image tag in a page is how a transcript starts making
/// requests nobody asked for.
fn attached(blocks: &[Value]) -> Vec<Value> {
    blocks
        .iter()
        .filter(|b| str_at(b, "type") == Some("image"))
        .filter_map(|b| {
            let source = b.get("source")?;
            if str_at(source, "type") != Some("base64") {
                return None;
            }
            Some(serde_json::json!({
                "mediaType": str_at(source, "media_type")?,
                "data": str_at(source, "data")?,
            }))
        })
        .collect()
}

/// A tool result is a string when it is simple and a list of blocks when it is
/// not. Both mean the same thing to a card.
fn tool_result_text(result: &Value) -> Option<String> {
    match result.get("content") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(blocks)) => {
            let text = blocks
                .iter()
                .filter_map(|b| str_at(b, "text"))
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn usage(v: &Value, last: Option<&Request>) -> Option<Usage> {
    let usage = v.get("usage")?;
    let (context_used, context_window) = context(v, last);
    Some(Usage {
        input_tokens: usage
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: usage
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_read_tokens: usage.get("cache_read_input_tokens").and_then(Value::as_u64),
        cache_write_tokens: usage
            .get("cache_creation_input_tokens")
            .and_then(Value::as_u64),
        thinking_tokens: usage
            .get("output_tokens_details")
            .and_then(|d| d.get("thinking_tokens"))
            .and_then(Value::as_u64),
        context_used,
        context_window,
        cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
        models: models(v),
        duration_ms: v.get("duration_ms").and_then(Value::as_u64),
        first_token_ms: v.get("ttft_ms").and_then(Value::as_u64),
        denied: denied(v),
    })
}

/// What each model did, biggest bill first.
///
/// Ordered rather than left as the agent's map, because the point of the list
/// is "what am I paying for", and a map has no order at all once it has been
/// through JSON.
fn models(v: &Value) -> Vec<ModelUsage> {
    let Some(per_model) = v.get("modelUsage").and_then(Value::as_object) else {
        return Vec::new();
    };

    let mut out: Vec<ModelUsage> = per_model
        .iter()
        .map(|(name, model)| {
            let read = |key: &str| model.get(key).and_then(Value::as_u64).unwrap_or(0);
            ModelUsage {
                // The canonical name where there is one, so `claude-opus-5[1m]`
                // and `claude-opus-5` are not two rows for the same model.
                model: str_at(model, "canonicalModel")
                    .unwrap_or(name.as_str())
                    .to_string(),
                input_tokens: read("inputTokens"),
                output_tokens: read("outputTokens"),
                cache_read_tokens: read("cacheReadInputTokens"),
                cache_write_tokens: read("cacheCreationInputTokens"),
                context_window: model.get("contextWindow").and_then(Value::as_u64),
                cost_usd: model.get("costUSD").and_then(Value::as_f64),
            }
        })
        .collect();

    out.sort_by(|a, b| {
        b.cost_usd
            .unwrap_or(0.0)
            .total_cmp(&a.cost_usd.unwrap_or(0.0))
    });
    out
}

/// The tools somebody refused during the turn.
///
/// Names only. What was refused and why is already in the transcript, on the
/// card where it was decided; this is the count for a summary.
fn denied(v: &Value) -> Vec<String> {
    v.get("permission_denials")
        .and_then(Value::as_array)
        .map(|denials| {
            denials
                .iter()
                .filter_map(|d| str_at(d, "tool_name").map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// What the account's limits say, when the agent mentions them.
///
/// Deliberately shallow. The agent reports a window, a status and a reset time
/// and no proportion of anything, so this carries those three and invents
/// nothing. A bar without a numerator would be a drawing, not a reading.
fn limits(v: &Value) -> Option<TurnEvent> {
    let info = v.get("rate_limit_info")?;
    Some(TurnEvent::Limited {
        window: str_at(info, "rateLimitType")?.to_string(),
        status: str_at(info, "status").unwrap_or("unknown").to_string(),
        resets_at: info.get("resetsAt").and_then(Value::as_i64),
        // Claude Code sends none, and a bar without a numerator would be a
        // drawing rather than a reading.
        used_percent: None,
    })
}

/// How full the model's context got, and how big it is.
///
/// The window is read from the per-model breakdown, because a turn is often
/// more than one model — a small one summarising or naming things alongside the
/// one doing the work — and they do not share a window. The one that matters is
/// whichever the last request went to.
///
/// What is *in* that window comes from the request itself, never from the
/// breakdown. `modelUsage` accumulates across every request in the turn, so a
/// cached prefix the model re-read on twenty tool calls is counted twenty
/// times: on a long turn it reports several times the window and the ring pins
/// at full while the session still has all its room. Those totals are what the
/// bill is made of, and they stay that — see [`Usage::models`].
///
/// Both `None` when the agent does not report a window. Better than guessing it
/// from a model name, which changes.
fn context(v: &Value, last: Option<&Request>) -> (Option<u64>, Option<u64>) {
    let per_model = v.get("modelUsage").and_then(Value::as_object);
    let Some(last) = last else {
        return (None, None);
    };
    let Some(name) = last.model.as_deref() else {
        return (None, None);
    };
    let Some(models) = per_model else {
        return (None, None);
    };
    // Prefer an exact key. Canonical aliases are safe only when unambiguous.
    let model = models.get(name).or_else(|| {
        let mut matches = models
            .values()
            .filter(|m| str_at(m, "canonicalModel") == Some(name));
        let model = matches.next()?;
        matches.next().is_none().then_some(model)
    });
    match model
        .and_then(|m| m.get("contextWindow"))
        .and_then(Value::as_u64)
    {
        Some(window) if window > 0 => (Some(last.used), Some(window)),
        _ => (None, None),
    }
}

/// The agent's todo list, as a plan.
///
/// Not wired into [`ClaudeNormaliser::push`] yet: the tool's arguments only
/// become valid JSON once the last fragment lands, so this is called from the
/// authoritative copy in an `assistant` message. Public because the shape is
/// worth testing on its own.
pub fn plan_from_todo_input(input: &Value) -> Option<Vec<PlanStep>> {
    let todos = input.get("todos")?.as_array()?;
    if todos.is_empty() {
        return None;
    }
    Some(
        todos
            .iter()
            .map(|todo| PlanStep {
                step: str_at(todo, "content").unwrap_or("Task").to_string(),
                status: str_at(todo, "status")
                    .map(plan_step_status)
                    .unwrap_or(PlanStepStatus::Pending),
            })
            .collect(),
    )
}

/// How the agent spells the state of one step.
fn plan_step_status(status: &str) -> PlanStepStatus {
    match status {
        "completed" => PlanStepStatus::Completed,
        "in_progress" | "inProgress" => PlanStepStatus::InProgress,
        _ => PlanStepStatus::Pending,
    }
}

/// The questions inside an `AskUserQuestion` call.
pub fn questions_from_input(input: &Value) -> Option<Vec<Question>> {
    let questions = input.get("questions")?.as_array()?;
    Some(
        questions
            .iter()
            .map(|q| Question {
                question: str_at(q, "question").unwrap_or_default().to_string(),
                header: str_at(q, "header").unwrap_or_default().to_string(),
                options: q
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|options| {
                        options
                            .iter()
                            .map(|o| QuestionOption {
                                label: str_at(o, "label").unwrap_or_default().to_string(),
                                description: str_at(o, "description")
                                    .unwrap_or_default()
                                    .to_string(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                multi_select: q
                    .get("multiSelect")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
            .collect(),
    )
}

#[cfg(test)]
mod skill_tests {
    use super::*;

    /// The three spellings of one act, each taken from a real session.
    #[test]
    fn every_agent_says_which_skill_it_reached_for() {
        // Claude Code, verified in a live transcript.
        assert_eq!(classify("Skill"), ItemKind::SkillUse);
        assert_eq!(
            skill_reached_for("Skill", &serde_json::json!({"skill": "frontend-design"})),
            Some("frontend-design".into())
        );

        // Codex names its two `skills.read` and `skills.list`.
        assert_eq!(classify("skills.read"), ItemKind::SkillUse);
        assert_eq!(
            skill_reached_for(
                "skills.read",
                &serde_json::json!({"package": "rust-review"})
            ),
            Some("rust-review".into())
        );

        // Codex runs a shell command. Taken verbatim from a live session —
        // it never touches its own `skills.read` tool.
        assert_eq!(
            skill_reached_for(
                "",
                &serde_json::json!({"type": "commandExecution", "command":
                    "/bin/zsh -lc 'cat .firetower/agent-home-s_1/skills/frontend-design/SKILL.md'"})
            ),
            Some("frontend-design".into())
        );

        // Kimi has no skill tool at all: it reads the file, so the path is
        // the only evidence there is.
        assert_eq!(
            skill_reached_for(
                "read",
                &serde_json::json!({"path": "/w/.firetower/skills-s_1/skills/house-prose/SKILL.md"})
            ),
            Some("house-prose".into())
        );
    }

    /// The real item, copied out of the journal of the Codex session that
    /// prompted this — not a hand-written approximation of one.
    #[test]
    fn the_item_codex_actually_sent() {
        let item: Value = serde_json::from_str(
            r#"{"type":"commandExecution","id":"exec-39b5dc9f",
                "pluginId":null,"scriptPath":null,
                "command":"/bin/zsh -lc 'cat .firetower/agent-home-s_01m43dpm7cf5ycvqegfdhkcex5/skills/frontend-design/SKILL.md'"}"#,
        )
        .unwrap();
        assert_eq!(
            skill_reached_for("", &item),
            Some("frontend-design".into()),
            "the one thing a Codex skill looks like has to be recognised"
        );
    }

    /// Kimi's three stages, copied out of the journal of the session that
    /// prompted this. The item opens before the name exists, which is the
    /// whole difficulty.
    #[test]
    fn the_three_updates_kimi_actually_sent() {
        let opening: Value = serde_json::from_str(
            r#"{"kind":"other","sessionUpdate":"tool_call","status":"pending",
                "title":"Skill","toolCallId":"1:tool_5JaTlacj"}"#,
        )
        .unwrap();
        // Nothing to name yet — and it still has to be a skill, because an
        // item cannot change what it is halfway through.
        assert_eq!(skill_reached_for("", &opening), None);

        let named: Value = serde_json::from_str(
            r#"{"kind":"other","status":"in_progress",
                "title":"Invoke skill frontend-design",
                "rawInput":{"args":"analyze the website","skill":"frontend-design"},
                "toolCallId":"1:tool_5JaTlacj"}"#,
        )
        .unwrap();
        assert_eq!(
            skill_reached_for("", &named),
            Some("frontend-design".into())
        );

        // The title alone is enough, for the update that carries no rawInput.
        let by_title: Value =
            serde_json::from_str(r#"{"title":"Invoke skill house-prose"}"#).unwrap();
        assert_eq!(skill_reached_for("", &by_title), Some("house-prose".into()));
    }

    /// A read is still a read. Treating every file as a skill would put the
    /// whole transcript under the wrong heading.
    #[test]
    fn an_ordinary_read_is_left_alone() {
        assert_eq!(classify("Read"), ItemKind::FileRead);
        assert_eq!(
            skill_reached_for("read", &serde_json::json!({"path": "src/main.rs"})),
            None
        );
        // Listing what is available is not using one.
        assert_eq!(
            skill_reached_for("skills.list", &serde_json::json!({})),
            None
        );
        // And a SKILL.md that is not in a skills directory is a file somebody
        // is writing, which is an ordinary thing to do in this repository.
        assert_eq!(
            skill_reached_for("read", &serde_json::json!({"path": "docs/SKILL.md"})),
            None
        );
        assert_eq!(
            skill_reached_for(
                "",
                &serde_json::json!({"command": "cat README.md && ls skills/"})
            ),
            None
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage_of(lines: &[&str]) -> Usage {
        let mut reader = ClaudeNormaliser::new();
        lines
            .iter()
            .flat_map(|l| reader.push(l))
            .find_map(|e| match e {
                TurnEvent::TurnCompleted { usage, .. } => usage,
                _ => None,
            })
            .expect("the turn should complete and report usage")
    }

    /// Hand-written rather than recorded, unlike everything in
    /// `tests/normalise_claude.rs`, because this is a fact about our own rule
    /// and not about Claude Code's output: the recordings happen to end on a
    /// main-agent request, so they cannot tell a working filter from a missing
    /// one. A subagent that spoke last must not be mistaken for the window on
    /// screen — it reads a window of its own, and taking its number would make
    /// the context jump and then jump back.
    #[test]
    fn a_subagents_request_is_not_the_context_on_screen() {
        let usage = usage_of(&[
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"text","text":"go"}]}}"#,
            r#"{"type":"assistant","message":{"id":"m1","model":"claude-sonnet-5","content":[],"usage":{"input_tokens":2,"cache_read_input_tokens":40000,"output_tokens":10}}}"#,
            r#"{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"id":"m2","model":"claude-sonnet-5","content":[],"usage":{"input_tokens":2,"cache_creation_input_tokens":900,"output_tokens":3}}}"#,
            r#"{"type":"result","subtype":"success","usage":{"input_tokens":4},"modelUsage":{"claude-sonnet-5":{"inputTokens":4,"outputTokens":13,"cacheReadInputTokens":40000,"cacheCreationInputTokens":900,"contextWindow":1000000}}}"#,
        ]);
        assert_eq!(usage.context_used, Some(40_012), "the main agent's request");
        assert_eq!(usage.context_window, Some(1_000_000));
    }

    /// A mode changed mid-turn has to be readable, or the picker sits on the
    /// old value until the next turn starts and reads as not having worked.
    ///
    /// The line is what a real agent answered a `set_permission_mode` control
    /// request with. It says the mode and nothing else, which is why a
    /// restatement has to be allowed to leave the model out.
    #[test]
    fn a_mode_that_changed_says_so_without_forgetting_the_model() {
        let mut reader = ClaudeNormaliser::new();
        reader.push(
            r#"{"type":"system","subtype":"init","model":"claude-opus-5[1m]","permissionMode":"auto","tools":["Bash"],"slash_commands":["model"]}"#,
        );

        let events = reader.push(
            r#"{"type":"system","subtype":"status","status":null,"permissionMode":"dontAsk","uuid":"u1","session_id":"s1"}"#,
        );
        match events.as_slice() {
            [TurnEvent::SessionConfigured { model, mode, .. }] => {
                assert_eq!(mode, "dontAsk");
                assert!(model.is_empty(), "it said nothing about the model");
            }
            other => panic!("expected the new mode, got {other:?}"),
        }

        // Anything else it carries is telemetry, and telemetry is not a card.
        let quiet = reader
            .push(r#"{"type":"system","subtype":"status","status":null,"thinking_tokens":10}"#);
        assert!(matches!(quiet.as_slice(), [TurnEvent::Raw { .. }]));

        // The event was allowed to leave the model out; the reader was not
        // allowed to forget it. A picker reads this one.
        assert_eq!(reader.model(), Some("claude-opus-5[1m]"));
    }

    /// Nothing is claimed before the agent has said anything.
    ///
    /// A picker that showed a model the moment a session was created would be
    /// guessing — and it would be right only for as long as nobody changed the
    /// default this launches with.
    #[test]
    fn a_reader_that_has_heard_nothing_reports_no_model() {
        let mut reader = ClaudeNormaliser::new();
        assert_eq!(reader.model(), None);

        reader.push(r#"{"type":"system","subtype":"status","permissionMode":"auto"}"#);
        assert_eq!(reader.model(), None, "a restatement establishes nothing");

        reader.push(r#"{"type":"system","subtype":"init","model":"claude-haiku-4-5-20251001","permissionMode":"auto"}"#);
        assert_eq!(reader.model(), Some("claude-haiku-4-5-20251001"));

        // A later turn that changed model replaces it rather than adding to it.
        reader.push(
            r#"{"type":"system","subtype":"init","model":"claude-sonnet-5","permissionMode":"auto"}"#,
        );
        assert_eq!(reader.model(), Some("claude-sonnet-5"));
    }

    #[test]
    fn result_totals_without_a_request_do_not_invent_context() {
        let usage = usage_of(&[
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"text","text":"go"}]}}"#,
            r#"{"type":"result","subtype":"success","usage":{"input_tokens":600000},"modelUsage":{"claude-sonnet-5":{"inputTokens":600000,"contextWindow":200000}}}"#,
        ]);
        assert_eq!(usage.context_used, None);
        assert_eq!(usage.context_window, None);
    }

    #[test]
    fn streamed_output_counts_without_accumulating_requests() {
        let usage = usage_of(&[
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"text","text":"go"}]}}"#,
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1","model":"main","usage":{"input_tokens":10,"cache_read_input_tokens":40000,"output_tokens":1}}}}"#,
            r#"{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":100}}}"#,
            r#"{"type":"stream_event","parent_tool_use_id":"child","event":{"type":"message_delta","usage":{"output_tokens":9999}}}"#,
            r#"{"type":"result","subtype":"success","usage":{"input_tokens":500000},"modelUsage":{"main":{"inputTokens":500000,"contextWindow":200000},"helper":{"inputTokens":900000,"contextWindow":1000000}}}"#,
        ]);
        assert_eq!(usage.context_used, Some(40_110));
        assert_eq!(usage.context_window, Some(200_000));
        assert!(usage.context_fullness().unwrap() < 0.21);
        assert_eq!(usage.input_tokens, 500_000);
    }

    #[test]
    fn unmatched_model_does_not_borrow_another_models_window() {
        let usage = usage_of(&[
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"text","text":"go"}]}}"#,
            r#"{"type":"assistant","message":{"id":"m1","model":"main","usage":{"input_tokens":40000}}}"#,
            r#"{"type":"result","subtype":"success","usage":{},"modelUsage":{"helper":{"contextWindow":200000}}}"#,
        ]);
        assert_eq!(usage.context_window, None);
    }

    #[test]
    fn a_new_turn_does_not_reuse_the_previous_request() {
        let mut reader = ClaudeNormaliser::new();
        let user = r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"text","text":"go"}]}}"#;
        let result = r#"{"type":"result","subtype":"success","usage":{},"modelUsage":{"main":{"contextWindow":200000}}}"#;
        reader.push(user);
        reader.push(r#"{"type":"assistant","message":{"id":"m1","model":"main","usage":{"input_tokens":40000}}}"#);
        reader.push(result);
        reader.push(user);
        let events = reader.push(result);
        let usage = events
            .iter()
            .find_map(|e| match e {
                TurnEvent::TurnCompleted { usage, .. } => usage.as_ref(),
                _ => None,
            })
            .unwrap();
        assert_eq!(usage.context_used, None);
    }

    /// The small model that names and summarises has a window a fifth the size.
    /// Pairing its window with the working model's occupancy is how a session
    /// with all its room reads as nearly full.
    #[test]
    fn the_window_belongs_to_the_model_that_did_the_work() {
        let usage = usage_of(&[
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"text","text":"go"}]}}"#,
            r#"{"type":"assistant","message":{"id":"m1","model":"claude-opus-5[1m]","content":[],"usage":{"input_tokens":2,"cache_read_input_tokens":150000,"output_tokens":8}}}"#,
            r#"{"type":"result","subtype":"success","usage":{"input_tokens":2},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":900,"outputTokens":40,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"contextWindow":200000},"claude-opus-5[1m]":{"canonicalModel":"claude-opus-5[1m]","inputTokens":2,"outputTokens":8,"cacheReadInputTokens":150000,"cacheCreationInputTokens":0,"contextWindow":1000000}}}"#,
        ]);
        assert_eq!(
            usage.context_window,
            Some(1_000_000),
            "Opus's window, not Haiku's"
        );
        assert_eq!(usage.context_used, Some(150_010));
    }
}

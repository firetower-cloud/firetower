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

use std::collections::HashMap;

use serde_json::Value;

use crate::turn::{
    ItemId, ItemKind, ItemStatus, PlanStep, PlanStepStatus, Question, QuestionOption, RawSource,
    RequestId, RequestKind, SlashCommand, StreamKind, TaskId, TurnEvent, TurnId, TurnStatus, Usage,
};

/// What a tool's name suggests it does.
///
/// Ordered most-specific first: `mcp__…__read_file` is an MCP call before it is
/// a read, because which server it came from is the more useful thing to draw.
pub fn classify(tool_name: &str) -> ItemKind {
    let name = tool_name.to_ascii_lowercase();

    if name.starts_with("mcp__") || name.contains("mcp") {
        return ItemKind::McpToolCall;
    }
    // `Task` in older builds, `Agent` since. Both, because a host somewhere is
    // running the other one.
    if name == "task" || name == "agent" || name.contains("subagent") {
        return ItemKind::SubagentCall;
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
        _ => Some(tool_name.to_string()),
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
    /// The subagent each spawning tool call owns, so its work can be attributed.
    tasks: HashMap<String, TaskId>,
    /// The agent's own task list, accumulated.
    ///
    /// Held rather than derived because the newer tools add one item per call
    /// and never restate the list, so the only place the whole plan exists is
    /// here. See [`ClaudeNormaliser::plan_tool`].
    plan: Vec<PlanStep>,
}

impl ClaudeNormaliser {
    pub fn new() -> Self {
        Self::default()
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
            Some("system") => self.system(v, &mut out),
            Some("stream_event") => self.stream_event(v, &mut out),
            Some("assistant") => self.assistant(v, &mut out),
            Some("user") => self.user(v, &mut out),
            Some("result") => self.result(v, &mut out),
            // `rate_limit_event` and anything else new. Kept, not named.
            _ => out.push(raw(v)),
        }
        out
    }

    // ---- system ---------------------------------------------------------

    fn system(&mut self, v: &Value, out: &mut Vec<TurnEvent>) {
        match str_at(v, "subtype") {
            Some("init") => out.push(TurnEvent::SessionConfigured {
                model: str_at(v, "model").unwrap_or_default().to_string(),
                tools: string_list(v.get("tools")),
                commands: slash_commands(v.get("commands")),
            }),
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
            // `task_updated` repeats what `task_notification` says with less in
            // it, and `status`/`thinking_tokens` are telemetry.
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
            // `message_delta` carries the stop reason, which `result` says
            // better, and `message_stop` says nothing we don't already know.
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
            out.push(TurnEvent::ItemUpdated {
                item: ItemId::new(id),
                data: input.clone(),
            });

            // Some tools carry structure worth lifting out of the generic
            // card, because the interface draws them as something other than a
            // tool call: a task list is the plan, and a question is a question.
            let name = str_at(block, "name").unwrap_or_default();
            if name == "AskUserQuestion" {
                if let Some(questions) = questions_from_input(input) {
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
            // Our own turn, echoed back to us. Worth keeping: it is what makes
            // the stored log the whole conversation rather than half of it.
            self.begin_turn(out);
            let item = ItemId::new(format!("{}:user", self.turns_seen));
            out.push(TurnEvent::ItemStarted {
                item: item.clone(),
                kind: ItemKind::UserMessage,
                title: None,
                task: None,
            });
            let text = blocks
                .iter()
                .filter_map(|b| str_at(b, "text"))
                .collect::<Vec<_>>()
                .join("");
            if !text.is_empty() {
                out.push(TurnEvent::ContentDelta {
                    item: item.clone(),
                    stream: StreamKind::AssistantText,
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
            self.open_tools.remove(id);
            out.push(TurnEvent::ItemCompleted {
                item: ItemId::new(id),
                status: if failed {
                    ItemStatus::Failed
                } else {
                    ItemStatus::Completed
                },
            });
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
        out.push(TurnEvent::TurnCompleted {
            turn,
            status,
            usage: usage(v),
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

fn usage(v: &Value) -> Option<Usage> {
    let usage = v.get("usage")?;
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
        cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
    })
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

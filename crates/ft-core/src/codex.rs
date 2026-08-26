//! Turning what a Codex app-server says into [`TurnEvent`]s.
//!
//! The sibling of [`normalise`](crate::normalise), for a protocol that is
//! shaped nothing like Claude Code's and needs far less work.
//!
//! Where Claude Code streams *frames* — a block opened, a fragment arrived, a
//! message finished — and leaves the lifecycle to be reconstructed, Codex
//! sends the lifecycle directly: `item/started`, `item/completed`,
//! `turn/started`, `turn/completed`. Almost every event here is one
//! notification renamed, and this file is mostly a vocabulary translation.
//!
//! Which means the state this holds is nearly nothing, and the two things it
//! does hold are worth naming:
//!
//! - **The thread id**, because a turn cannot be started without it and it is
//!   only ever said once, in the answer to `thread/start`.
//! - **Which items are which kind**, because `item/completed` gives the whole
//!   item again but the interface has already drawn a card and needs to know
//!   what it was.
//!
//! Runs in the control plane like its sibling, for the same reason: a mapping
//! that turns out to be wrong is a deploy rather than a fleet upgrade.

use std::collections::HashMap;

use serde_json::Value;

use crate::turn::{
    Decision, ItemId, ItemKind, ItemStatus, PlanStep, PlanStepStatus, Question, QuestionOption,
    RawSource, RequestId, RequestKind, StreamKind, TurnEvent, TurnId, TurnStatus, Usage,
};

/// The id the worker sends `initialize` under.
///
/// Fixed, and shared with the control plane, because only the sender of a
/// request can say what its id meant — and here the two halves of the opening
/// are sent by the worker and read by the control plane.
pub const INITIALIZE_ID: u64 = 1;
/// The id the worker sends `thread/start` under. See [`INITIALIZE_ID`].
pub const THREAD_START_ID: u64 = 2;
/// Where ids for everything after the opening begin.
pub const FIRST_TURN_ID: u64 = 3;

/// The handshake, which has to finish before Codex will take any work.
///
/// Two requests rather than one because the second needs the first: an
/// app-server answers nothing until it has been introduced.
pub fn opening(cwd: &str) -> Vec<Value> {
    vec![
        serde_json::json!({
            "id": INITIALIZE_ID,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "firetower",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            },
        }),
        serde_json::json!({
            "id": THREAD_START_ID,
            "method": "thread/start",
            "params": {
                "cwd": cwd,
                // It asks, and the question reaches whoever is watching.
                // That is the point of the whole arrangement, so it is the
                // ordinary case — and a session nobody is watching is exactly
                // the one that most needs to be able to stop and say so.
                //
                // Still sandboxed to the workspace underneath. Being asked is
                // not the same as being unconfined: an approval somebody grants
                // in a hurry should not be able to reach the rest of the host.
                "approvalPolicy": "on-request",
                "sandbox": "workspace-write",
            },
        }),
    ]
}

/// Stop the turn that is running, leaving the conversation alive.
///
/// Names the turn as well as the thread: a conversation can have had many, and
/// only the one now running can be stopped.
pub fn turn_interrupt(id: u64, thread: &str, turn: &str) -> Value {
    serde_json::json!({
        "id": id,
        "method": "turn/interrupt",
        "params": { "threadId": thread, "turnId": turn },
    })
}

/// One turn: what somebody typed, in the thread it belongs to.
///
/// The thread is what makes this a conversation rather than a series of
/// unrelated requests, which is why nothing can be sent before the handshake
/// has answered.
pub fn turn_start(id: u64, thread: &str, text: &str) -> Value {
    serde_json::json!({
        "id": id,
        "method": "turn/start",
        "params": {
            "threadId": thread,
            "input": [{ "type": "text", "text": text }],
        },
    })
}

/// One question, in our shape.
///
/// Theirs carries an id we drop: answers here are keyed by the question's own
/// text, which has to survive the round trip either way.
fn question(asked: &Value) -> Question {
    let text = |name: &str| {
        asked
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    Question {
        question: text("question"),
        header: text("header"),
        options: asked
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .map(|option| QuestionOption {
                        label: option
                            .get("label")
                            .or_else(|| option.get("name"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        description: option
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        // Not offered: their question says nothing about picking more than one.
        multi_select: false,
    }
}

/// The reply to something Codex is blocked on.
///
/// `req` is the id the request arrived with, as a string, because that is how
/// it travelled through the parts in between. A reply carrying anything else
/// leaves the agent waiting.
pub fn reply(req: &str, decision: &Decision) -> Option<Value> {
    let id: u64 = req.parse().ok()?;

    let result = match decision {
        Decision::Allow => serde_json::json!({ "decision": "accept" }),
        // Theirs is scoped to the session, which is as far as ours goes too.
        Decision::AllowAlways => serde_json::json!({ "decision": "acceptForSession" }),
        // The reason is ours to keep for the transcript: their decision is one
        // word and carries nowhere to put it.
        Decision::Deny { .. } => serde_json::json!({ "decision": "decline" }),
        Decision::Answered { answers } => serde_json::json!({ "answers": answers }),
    };

    Some(serde_json::json!({ "id": id, "result": result }))
}

/// What Codex calls a thing, and what Firetower draws for it.
///
/// Unrecognised on purpose rather than by omission: Codex grows item types
/// between releases, and one we have never seen still draws a generic card
/// with whatever it sent. Being wrong costs a nicer card and never the event.
fn classify(item_type: &str) -> ItemKind {
    match item_type {
        "agentMessage" => ItemKind::AssistantMessage,
        "userMessage" => ItemKind::UserMessage,
        "reasoning" => ItemKind::Reasoning,
        "commandExecution" => ItemKind::CommandExecution,
        "fileChange" => ItemKind::FileChange,
        "mcpToolCall" | "dynamicToolCall" => ItemKind::McpToolCall,
        "webSearch" => ItemKind::WebSearch,
        "collabAgentToolCall" | "subAgentActivity" => ItemKind::SubagentCall,
        _ => ItemKind::Unknown,
    }
}

/// What the card is called before anything is in it.
fn title_for(kind: ItemKind, item: &Value) -> Option<String> {
    let field = |name: &str| item.get(name).and_then(Value::as_str).map(str::to_string);
    match kind {
        ItemKind::AssistantMessage | ItemKind::UserMessage => None,
        ItemKind::Reasoning => Some("Thinking".into()),
        // The command itself, which is the whole of what somebody wants to see.
        ItemKind::CommandExecution => field("command"),
        ItemKind::WebSearch => field("query"),
        ItemKind::McpToolCall => field("tool").or_else(|| field("toolName")),
        _ => field("type"),
    }
}

/// Codex's four statuses, of which we have three.
///
/// `inProgress` is not an ending and must not be read as one — an item still
/// running is not an item that completed.
fn ended(status: &str) -> Option<ItemStatus> {
    match status {
        "completed" => Some(ItemStatus::Completed),
        "failed" => Some(ItemStatus::Failed),
        "declined" => Some(ItemStatus::Declined),
        _ => None,
    }
}

fn turn_ended(status: &str) -> TurnStatus {
    match status {
        "interrupted" => TurnStatus::Interrupted,
        "failed" => TurnStatus::Failed,
        _ => TurnStatus::Completed,
    }
}

/// Reads a Codex app-server's output and reports what happened.
///
/// Feed it lines in the order they were written. One per session.
#[derive(Default)]
pub struct CodexNormaliser {
    /// Said once, in the answer to `thread/start`, and needed by every turn
    /// after it. Nothing else in the protocol repeats it in a form we could
    /// recover it from, so it is remembered here.
    thread: Option<String>,
    /// What kind of card each open item is. `item/completed` restates the
    /// item, but the card was drawn when it started and the two have to agree.
    open: HashMap<String, ItemKind>,
    /// What the turn now running has cost, as last reported.
    ///
    /// Kept because it arrives on its own notification rather than with the
    /// turn that ends: by the time a turn completes, this is the only place
    /// the number is.
    usage: Option<Usage>,
    /// The turn now running, which is what stopping one has to name.
    ///
    /// `turn/interrupt` takes a turn as well as a thread, and there is nowhere
    /// else to recover it from once the notification has gone past.
    active_turn: Option<String>,
    /// Which request ids we sent, so an answer can be told from a notification.
    ///
    /// Only the ones whose answers say something: everything else is allowed
    /// to arrive and be ignored.
    awaiting: HashMap<u64, Awaiting>,
}

/// A request we sent and have not had the answer to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Awaiting {
    /// `thread/start`, whose answer carries the thread id.
    ThreadStart,
}

impl CodexNormaliser {
    pub fn new() -> Self {
        Self::default()
    }

    /// The thread this conversation is in, once Codex has said.
    ///
    /// `None` before `thread/start` has been answered, which is the window in
    /// which no turn can be sent.
    pub fn thread(&self) -> Option<&str> {
        self.thread.as_deref()
    }

    /// The turn now running, if one is.
    ///
    /// `None` between turns, when there is nothing to stop.
    pub fn active_turn(&self) -> Option<&str> {
        self.active_turn.as_deref()
    }

    /// Remember that a request went out, so its answer can be recognised.
    ///
    /// Ids are the sender's, so only the sender can say what one meant.
    pub fn sent_thread_start(&mut self, id: u64) {
        self.awaiting.insert(id, Awaiting::ThreadStart);
    }

    /// Read one line and report everything it means.
    ///
    /// A line that is not JSON is nothing rather than an error: an app-server
    /// is entitled to print, and a crash report on stdout should not take a
    /// session down with it.
    pub fn push(&mut self, line: &str) -> Vec<TurnEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };

        // A method makes it a request or a notification; only a line without
        // one is an answer to something we sent. Checking the id first would
        // read every approval request — which carries both — as an answer, and
        // the agent would wait for a reply nobody was going to send.
        let Some(method) = value.get("method").and_then(Value::as_str) else {
            return match value.get("id").and_then(Value::as_u64) {
                Some(id) => self.answer(id, &value),
                None => Vec::new(),
            };
        };
        let params = value.get("params").cloned().unwrap_or(Value::Null);

        // A request expects a reply, keyed by the id it came with. A
        // notification has none and expects nothing.
        if let Some(id) = value.get("id").and_then(Value::as_u64) {
            return self.request(id, method, &params);
        }

        match method {
            "turn/started" => self.turn_started(&params),
            "turn/completed" => self.turn_completed(&params),
            "item/started" => self.item_started(&params),
            "item/completed" => self.item_completed(&params),
            "item/agentMessage/delta" => self.delta(&params, StreamKind::AssistantText),
            // What a command printed, as it printed it. Same stream a tool's
            // output goes to for the other agent, so the card that draws one
            // draws the other.
            "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
                self.delta(&params, StreamKind::ToolOutput)
            }
            // The plan is restated whole on `turn/plan/updated`, so the
            // fragments it is built from would only say it twice.
            "item/plan/delta" => Vec::new(),
            "turn/plan/updated" => self.plan(&params),
            "account/rateLimits/updated" => limits(&params),
            "thread/tokenUsage/updated" => {
                self.usage = usage(&params);
                Vec::new()
            }
            // Everything else is kept rather than dropped, so a message type
            // that turns up in a new release shows as a gap to fill instead of
            // as silence. The full log is stored either way; this is the
            // marker that says we have never seen this one.
            _ => vec![TurnEvent::Raw {
                source: RawSource::CodexAppServer,
                payload: value,
            }],
        }
    }

    /// Something Codex is blocked on and will not pass without an answer.
    ///
    /// The id is the whole of the correspondence: whatever is sent back has to
    /// carry it, or Codex is still waiting on a reply it can recognise.
    fn request(&mut self, id: u64, method: &str, params: &Value) -> Vec<TurnEvent> {
        let req = RequestId::new(id.to_string());
        let text = |name: &str| params.get(name).and_then(Value::as_str).unwrap_or_default();

        match method {
            "item/commandExecution/requestApproval" => {
                let command = text("command");
                let detail = if command.is_empty() {
                    "wants to run a command".to_string()
                } else {
                    command.to_string()
                };
                vec![TurnEvent::RequestOpened {
                    req,
                    kind: RequestKind::CommandExecution,
                    detail,
                    args: params.clone(),
                }]
            }
            "item/fileChange/requestApproval" => {
                let reason = text("reason");
                let detail = if reason.is_empty() {
                    "wants to change files".to_string()
                } else {
                    reason.to_string()
                };
                vec![TurnEvent::RequestOpened {
                    req,
                    kind: RequestKind::FileChange,
                    detail,
                    args: params.clone(),
                }]
            }
            "item/tool/requestUserInput" => {
                let questions = params
                    .get("questions")
                    .and_then(Value::as_array)
                    .map(|asked| asked.iter().map(question).collect())
                    .unwrap_or_default();
                vec![TurnEvent::UserInputRequested { req, questions }]
            }
            // A tool asking for a permission, a server asking to elicit
            // something. Both are "the agent is blocked and a person decides",
            // which is one card.
            "item/permissions/requestApproval" | "mcpServer/elicitation/request" => {
                let reason = text("reason");
                let detail = if reason.is_empty() {
                    "wants permission".to_string()
                } else {
                    reason.to_string()
                };
                vec![TurnEvent::RequestOpened {
                    req,
                    kind: RequestKind::Tool,
                    detail,
                    args: params.clone(),
                }]
            }
            // A request we have no card for still has to be visible: an agent
            // silently waiting on one is a session that has stopped for no
            // reason anybody can see.
            _ => vec![TurnEvent::RequestOpened {
                req,
                kind: RequestKind::Tool,
                detail: method.to_string(),
                args: params.clone(),
            }],
        }
    }

    fn answer(&mut self, id: u64, value: &Value) -> Vec<TurnEvent> {
        match self.awaiting.remove(&id) {
            Some(Awaiting::ThreadStart) => {
                let Some(result) = value.get("result") else {
                    return Vec::new();
                };

                // The whole thread, and its id inside it. Not `threadId` —
                // the notifications carry it that way and the answer that
                // creates one does not, which is a difference worth having
                // been caught by reading the schema rather than by a session
                // that sat at "starting the agent" forever.
                let Some(thread) = result
                    .get("thread")
                    .and_then(|t| t.get("id"))
                    .and_then(Value::as_str)
                else {
                    return Vec::new();
                };
                self.thread = Some(thread.to_string());

                // What this session turned out to be configured as. Reported
                // rather than remembered from what we asked for: the answer is
                // what is in force, and it is the only place either is said.
                vec![TurnEvent::SessionConfigured {
                    model: result
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    mode: result
                        .get("approvalPolicy")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    // Codex names neither here, and an empty list is the
                    // honest reading of that.
                    tools: Vec::new(),
                    commands: Vec::new(),
                }]
            }
            // Somebody else's request, or one whose answer says nothing.
            None => Vec::new(),
        }
    }

    fn turn_started(&mut self, params: &Value) -> Vec<TurnEvent> {
        let Some(turn) = turn_id(params) else {
            return Vec::new();
        };
        self.active_turn = Some(turn.as_str().to_string());
        vec![TurnEvent::TurnStarted { turn }]
    }

    fn turn_completed(&mut self, params: &Value) -> Vec<TurnEvent> {
        let Some(turn) = turn_id(params) else {
            return Vec::new();
        };
        let status = params
            .get("turn")
            .and_then(|t| t.get("status"))
            .and_then(Value::as_str)
            .map(turn_ended)
            .unwrap_or(TurnStatus::Completed);

        // Nothing is open across a turn boundary. An item still in the map
        // here is one whose completion we missed, and carrying it forward
        // would attribute it to the next turn.
        self.open.clear();
        self.active_turn = None;

        vec![TurnEvent::TurnCompleted {
            turn,
            status,
            usage: self.usage.take(),
        }]
    }

    fn item_started(&mut self, params: &Value) -> Vec<TurnEvent> {
        let Some(item) = params.get("item") else {
            return Vec::new();
        };
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            return Vec::new();
        };
        let kind = classify(item.get("type").and_then(Value::as_str).unwrap_or(""));
        self.open.insert(id.to_string(), kind);

        let mut events = vec![TurnEvent::ItemStarted {
            item: ItemId::new(id),
            kind,
            title: title_for(kind, item),
            task: None,
        }];

        // What somebody typed, which arrives whole and never as a stream —
        // Codex is echoing back a turn it was given rather than producing one.
        // Without this the bubble draws with nothing in it.
        if kind == ItemKind::UserMessage {
            if let Some(text) = content_text(item) {
                events.push(TurnEvent::ContentDelta {
                    item: ItemId::new(id),
                    stream: StreamKind::UserText,
                    delta: text,
                });
            }
        }

        events
    }

    fn item_completed(&mut self, params: &Value) -> Vec<TurnEvent> {
        let Some(item) = params.get("item") else {
            return Vec::new();
        };
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            return Vec::new();
        };
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
        let kind = self.open.remove(id).unwrap_or_else(|| classify(item_type));

        let mut events = Vec::new();

        // The whole item, so a card can show what it wants to.
        events.push(TurnEvent::ItemUpdated {
            item: ItemId::new(id),
            data: item.clone(),
        });

        // Text arrives complete on the item as well as in deltas. Sending it
        // as a delta for the kinds that have no delta stream is what makes
        // them appear at all.
        if kind == ItemKind::Reasoning {
            if let Some(text) = reasoning_text(item) {
                events.push(TurnEvent::ContentDelta {
                    item: ItemId::new(id),
                    stream: StreamKind::Reasoning,
                    delta: text,
                });
            }
        }

        let status = item
            .get("status")
            .and_then(Value::as_str)
            .and_then(ended)
            // Something with no status of its own finished by arriving.
            .unwrap_or(ItemStatus::Completed);

        events.push(TurnEvent::ItemCompleted {
            item: ItemId::new(id),
            status,
        });
        events
    }

    fn delta(&mut self, params: &Value, stream: StreamKind) -> Vec<TurnEvent> {
        let (Some(id), Some(delta)) = (
            params.get("itemId").and_then(Value::as_str),
            params.get("delta").and_then(Value::as_str),
        ) else {
            return Vec::new();
        };
        vec![TurnEvent::ContentDelta {
            item: ItemId::new(id),
            stream,
            delta: delta.to_string(),
        }]
    }

    fn plan(&mut self, params: &Value) -> Vec<TurnEvent> {
        let steps = params
            .get("plan")
            .and_then(Value::as_array)
            .map(|steps| {
                steps
                    .iter()
                    .map(|step| PlanStep {
                        step: step
                            .get("step")
                            .or_else(|| step.get("text"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        status: match step.get("status").and_then(Value::as_str) {
                            Some("completed") => PlanStepStatus::Completed,
                            Some("inProgress" | "in_progress") => PlanStepStatus::InProgress,
                            _ => PlanStepStatus::Pending,
                        },
                    })
                    .collect()
            })
            .unwrap_or_default();

        vec![TurnEvent::PlanUpdated { steps }]
    }
}

/// What the account's limits say, as two windows rather than one.
///
/// Codex reports a short window and a long one, each as a percentage used and
/// when it starts again. It names neither, so they are named here — `primary`
/// and `secondary` are the field names and mean nothing to anybody; a duration
/// does, when there is one.
fn limits(params: &Value) -> Vec<TurnEvent> {
    let snapshot = params.get("rateLimits").unwrap_or(&Value::Null);

    ["primary", "secondary"]
        .into_iter()
        .filter_map(|which| {
            let window = snapshot.get(which)?;
            let used = window.get("usedPercent").and_then(Value::as_i64)?;

            let name = match window.get("windowDurationMins").and_then(Value::as_i64) {
                Some(mins) if mins % (60 * 24) == 0 => format!("{}_day", mins / (60 * 24)),
                Some(mins) if mins % 60 == 0 => format!("{}_hour", mins / 60),
                Some(mins) => format!("{mins}_minute"),
                None => which.to_string(),
            };

            Some(TurnEvent::Limited {
                window: name,
                // A window is only "reached" once it is full. Anything else is
                // room left, however little.
                status: if used >= 100 { "reached" } else { "allowed" }.to_string(),
                resets_at: window.get("resetsAt").and_then(Value::as_i64),
                used_percent: Some(used as u8),
            })
        })
        .collect()
}

/// What a turn cost, from the breakdown Codex keeps for the whole thread.
///
/// `last` rather than `total`: a turn's cost is what that turn used, and the
/// running total belongs to the conversation.
fn usage(params: &Value) -> Option<Usage> {
    let usage = params.get("tokenUsage")?;
    let last = usage.get("last")?;
    let count = |name: &str| last.get(name).and_then(Value::as_u64);

    Some(Usage {
        input_tokens: count("inputTokens").unwrap_or_default(),
        output_tokens: count("outputTokens").unwrap_or_default(),
        cache_read_tokens: count("cachedInputTokens"),
        cache_write_tokens: count("cacheWriteInputTokens"),
        thinking_tokens: count("reasoningOutputTokens"),
        context_used: count("totalTokens"),
        context_window: usage.get("modelContextWindow").and_then(Value::as_u64),
        // Codex does its own arithmetic nowhere we can see, and inventing a
        // number here would be worse than showing none.
        cost_usd: None,
        ..Default::default()
    })
}

/// The turn id, from either shape a notification carries it in.
fn turn_id(params: &Value) -> Option<TurnId> {
    params
        .get("turn")
        .and_then(|t| t.get("id"))
        .or_else(|| params.get("turnId"))
        .and_then(Value::as_str)
        .map(TurnId::new)
}

/// The text of a message that carries its content as a list of parts.
///
/// Only the text ones. An image arrives as a URL Codex can reach and we
/// cannot, so a transcript claiming to show one would be showing nothing.
fn content_text(item: &Value) -> Option<String> {
    let parts = item.get("content")?.as_array()?;
    let text = parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");

    (!text.is_empty()).then_some(text)
}

/// Reasoning arrives as a summary, as content, or as both.
fn reasoning_text(item: &Value) -> Option<String> {
    let pieces = |name: &str| -> String {
        item.get(name)
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(Value::as_str).or_else(|| p.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    };

    let summary = pieces("summary");
    let content = pieces("content");
    let text = if summary.is_empty() { content } else { summary };
    (!text.trim().is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(lines: &[&str]) -> Vec<TurnEvent> {
        let mut reader = CodexNormaliser::new();
        lines.iter().flat_map(|l| reader.push(l)).collect()
    }

    /// The thread id is said once and needed by every turn after it.
    #[test]
    fn the_thread_id_is_taken_from_the_answer_we_asked_for() {
        let mut reader = CodexNormaliser::new();
        reader.sent_thread_start(2);

        // Somebody else's answer must not be mistaken for ours.
        reader.push(r#"{"id":1,"result":{"thread":{"id":"not-ours"}}}"#);
        assert_eq!(reader.thread(), None);

        // The id is inside the thread, not beside it. Reading the wrong one
        // left a session sitting at "starting the agent" with nothing to say.
        let seen = reader.push(
            r#"{"id":2,"result":{"thread":{"id":"th_123"},"model":"gpt-5.6-sol","approvalPolicy":"on-request"}}"#,
        );
        assert_eq!(reader.thread(), Some("th_123"));

        match seen.first() {
            Some(TurnEvent::SessionConfigured { model, mode, .. }) => {
                assert_eq!(model, "gpt-5.6-sol");
                assert_eq!(mode, "on-request");
            }
            other => panic!("expected the session to report itself, got {other:?}"),
        }
    }

    #[test]
    fn a_turn_starts_and_ends() {
        let seen = events(&[
            r#"{"method":"turn/started","params":{"threadId":"t","turn":{"id":"turn_1","items":[],"status":"inProgress"}}}"#,
            r#"{"method":"turn/completed","params":{"threadId":"t","turn":{"id":"turn_1","items":[],"status":"completed"}}}"#,
        ]);

        assert!(matches!(
            seen.first(),
            Some(TurnEvent::TurnStarted { turn }) if turn.as_str() == "turn_1"
        ));
        assert!(matches!(
            seen.last(),
            Some(TurnEvent::TurnCompleted {
                status: TurnStatus::Completed,
                ..
            })
        ));
    }

    /// Stopping a turn is not a turn that broke, and the protocol says which.
    #[test]
    fn an_interrupted_turn_is_not_a_failed_one() {
        let seen = events(&[
            r#"{"method":"turn/completed","params":{"turn":{"id":"turn_1","items":[],"status":"interrupted"}}}"#,
        ]);
        assert!(matches!(
            seen.first(),
            Some(TurnEvent::TurnCompleted {
                status: TurnStatus::Interrupted,
                ..
            })
        ));
    }

    #[test]
    fn a_command_is_drawn_as_a_command_and_titled_with_itself() {
        let seen = events(&[
            r#"{"method":"item/started","params":{"item":{"id":"i1","type":"commandExecution","command":"cargo test","cwd":"/w","commandActions":[],"status":"inProgress"}}}"#,
        ]);
        match seen.first() {
            Some(TurnEvent::ItemStarted { kind, title, .. }) => {
                assert_eq!(*kind, ItemKind::CommandExecution);
                assert_eq!(title.as_deref(), Some("cargo test"));
            }
            other => panic!("expected an item, got {other:?}"),
        }
    }

    /// The card was drawn when the item started. Its kind has to survive to
    /// the completion, whatever the completion happens to restate.
    #[test]
    fn an_items_kind_is_remembered_from_when_it_started() {
        let mut reader = CodexNormaliser::new();
        reader.push(
            r#"{"method":"item/started","params":{"item":{"id":"i1","type":"webSearch","query":"rust"}}}"#,
        );
        let seen = reader.push(
            r#"{"method":"item/completed","params":{"item":{"id":"i1","status":"completed"}}}"#,
        );

        assert!(seen.iter().any(|e| matches!(
            e,
            TurnEvent::ItemCompleted {
                status: ItemStatus::Completed,
                ..
            }
        )));
    }

    #[test]
    fn text_arrives_as_deltas_against_its_item() {
        let seen = events(&[
            r#"{"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"u","itemId":"i2","delta":"Hel"}}"#,
            r#"{"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"u","itemId":"i2","delta":"lo"}}"#,
        ]);
        let text: String = seen
            .iter()
            .filter_map(|e| match e {
                TurnEvent::ContentDelta { delta, .. } => Some(delta.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "Hello");
    }

    /// A version that grows a message type should show up as something to
    /// look at, not as silence.
    #[test]
    fn something_we_have_never_seen_is_kept_rather_than_dropped() {
        let seen = events(&[r#"{"method":"thread/somethingNew","params":{"a":1}}"#]);
        assert!(matches!(seen.first(), Some(TurnEvent::Raw { .. })));
    }

    #[test]
    fn a_line_that_is_not_json_is_ignored_rather_than_fatal() {
        assert!(events(&["thread 'main' panicked at src/main.rs:1"]).is_empty());
    }

    /// Codex echoes back the turn it was given, whole and never as a stream.
    /// Without the text the bubble drew with nothing in it.
    #[test]
    fn a_typed_message_draws_with_what_was_typed() {
        let seen = events(&[
            r#"{"method":"item/started","params":{"item":{"type":"userMessage","id":"u1","clientId":null,"content":[{"type":"text","text":"Hello","text_elements":[]}]}}}"#,
        ]);

        assert!(matches!(
            seen.first(),
            Some(TurnEvent::ItemStarted {
                kind: ItemKind::UserMessage,
                ..
            })
        ));
        assert!(
            seen.iter().any(|e| matches!(
                e,
                TurnEvent::ContentDelta { stream: StreamKind::UserText, delta, .. }
                    if delta == "Hello"
            )),
            "the bubble needs the words in it"
        );
    }

    /// What a command printed goes to the same stream a tool's output does,
    /// so the card that draws one draws the other.
    #[test]
    fn command_output_reaches_the_card_that_ran_it() {
        let seen = events(&[
            r#"{"method":"item/commandExecution/outputDelta","params":{"threadId":"t","turnId":"u","itemId":"exec-1","delta":"AGENTS.md\n"}}"#,
        ]);
        match seen.first() {
            Some(TurnEvent::ContentDelta {
                item,
                stream,
                delta,
            }) => {
                assert_eq!(item.as_str(), "exec-1");
                assert_eq!(*stream, StreamKind::ToolOutput);
                assert_eq!(delta, "AGENTS.md\n");
            }
            other => panic!("expected output, got {other:?}"),
        }
    }

    /// A request carries an id *and* a method. Reading the id first made every
    /// approval look like an answer to something we sent, and the agent would
    /// wait forever for a reply nobody was going to write.
    #[test]
    fn an_approval_request_is_not_mistaken_for_an_answer() {
        let mut reader = CodexNormaliser::new();
        reader.sent_thread_start(THREAD_START_ID);

        let seen = reader.push(
            r#"{"id":41,"method":"item/commandExecution/requestApproval","params":{"command":"rm -rf build","itemId":"i1","threadId":"t","turnId":"u","startedAtMs":0}}"#,
        );

        match seen.first() {
            Some(TurnEvent::RequestOpened {
                req, kind, detail, ..
            }) => {
                assert_eq!(req.as_str(), "41", "the reply is keyed by this");
                assert_eq!(*kind, RequestKind::CommandExecution);
                assert_eq!(detail, "rm -rf build");
            }
            other => panic!("expected a request, got {other:?}"),
        }
    }

    /// A request nothing recognises still has to be visible: an agent silently
    /// waiting on one is a session stopped for no reason anybody can see.
    #[test]
    fn a_request_we_have_no_card_for_still_opens_one() {
        let seen = events(&[r#"{"id":9,"method":"some/newApproval","params":{}}"#]);
        assert!(matches!(
            seen.first(),
            Some(TurnEvent::RequestOpened { .. })
        ));
    }

    #[test]
    fn a_decision_goes_back_under_the_id_it_arrived_with() {
        let allow = reply("41", &Decision::Allow).unwrap();
        assert_eq!(allow["id"], 41);
        assert_eq!(allow["result"]["decision"], "accept");

        let always = reply("41", &Decision::AllowAlways).unwrap();
        assert_eq!(always["result"]["decision"], "acceptForSession");

        let no = reply(
            "41",
            &Decision::Deny {
                reason: Some("not that one".into()),
            },
        )
        .unwrap();
        assert_eq!(no["result"]["decision"], "decline");

        // An id that is not a number is not one of ours, and inventing a reply
        // for it would answer a question nobody asked.
        assert!(reply("mcp-tool-call-7", &Decision::Allow).is_none());
    }

    #[test]
    fn a_question_keeps_the_words_the_answer_is_keyed_by() {
        let seen = events(&[
            r#"{"id":5,"method":"item/tool/requestUserInput","params":{"itemId":"i","threadId":"t","turnId":"u","isBlocking":true,"questions":[{"id":"q1","header":"Deploy","question":"Which environment?","options":[{"label":"staging","description":"safe"},{"label":"production","description":"not"}]}]}}"#,
        ]);
        match seen.first() {
            Some(TurnEvent::UserInputRequested { questions, .. }) => {
                assert_eq!(questions[0].question, "Which environment?");
                assert_eq!(questions[0].header, "Deploy");
                assert_eq!(questions[0].options[1].label, "production");
            }
            other => panic!("expected questions, got {other:?}"),
        }
    }

    #[test]
    fn a_plan_is_read_with_the_state_of_each_step() {
        let seen = events(&[
            r#"{"method":"turn/plan/updated","params":{"threadId":"t","turnId":"u","plan":[{"step":"read the tests","status":"completed"},{"step":"fix the bug","status":"inProgress"},{"step":"run them","status":"pending"}]}}"#,
        ]);
        match seen.first() {
            Some(TurnEvent::PlanUpdated { steps }) => {
                assert_eq!(steps.len(), 3);
                assert_eq!(steps[0].step, "read the tests");
                assert_eq!(steps[0].status, PlanStepStatus::Completed);
                assert_eq!(steps[1].status, PlanStepStatus::InProgress);
                assert_eq!(steps[2].status, PlanStepStatus::Pending);
            }
            other => panic!("expected a plan, got {other:?}"),
        }
    }

    /// Two windows, neither of which Codex names — so they are named from
    /// their own duration, which is the part anybody reading it cares about.
    #[test]
    fn both_rate_limit_windows_are_reported_with_what_is_left() {
        let seen = events(&[
            r#"{"method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":42,"windowDurationMins":300,"resetsAt":1787724427},"secondary":{"usedPercent":100,"windowDurationMins":10080}}}}"#,
        ]);

        assert_eq!(seen.len(), 2, "a short window and a long one");
        match &seen[0] {
            TurnEvent::Limited {
                window,
                status,
                used_percent,
                resets_at,
            } => {
                assert_eq!(window, "5_hour");
                assert_eq!(status, "allowed");
                assert_eq!(*used_percent, Some(42));
                assert_eq!(*resets_at, Some(1787724427));
            }
            other => panic!("expected a limit, got {other:?}"),
        }
        match &seen[1] {
            TurnEvent::Limited { window, status, .. } => {
                assert_eq!(window, "7_day");
                assert_eq!(status, "reached", "a full window is not room left");
            }
            other => panic!("expected a limit, got {other:?}"),
        }
    }

    /// Cost arrives on its own notification, and by the time a turn ends this
    /// is the only place the number is.
    #[test]
    fn what_a_turn_cost_is_carried_to_the_turn_that_ends() {
        let mut reader = CodexNormaliser::new();
        reader.push(
            r#"{"method":"thread/tokenUsage/updated","params":{"threadId":"t","turnId":"u","tokenUsage":{"modelContextWindow":200000,"last":{"inputTokens":120,"outputTokens":45,"cachedInputTokens":900,"reasoningOutputTokens":30,"totalTokens":1095},"total":{"inputTokens":1,"outputTokens":1,"cachedInputTokens":1,"reasoningOutputTokens":1,"totalTokens":1}}}}"#,
        );

        let ended = reader.push(
            r#"{"method":"turn/completed","params":{"turn":{"id":"turn_1","items":[],"status":"completed"}}}"#,
        );
        match ended.first() {
            Some(TurnEvent::TurnCompleted {
                usage: Some(usage), ..
            }) => {
                assert_eq!(usage.input_tokens, 120);
                assert_eq!(usage.output_tokens, 45);
                assert_eq!(usage.thinking_tokens, Some(30));
                assert_eq!(usage.context_window, Some(200000));
            }
            other => panic!("expected a cost, got {other:?}"),
        }

        // Spent by the turn it belonged to: the next one starts from nothing
        // rather than inheriting a number that was never about it.
        let next = reader.push(
            r#"{"method":"turn/completed","params":{"turn":{"id":"turn_2","items":[],"status":"completed"}}}"#,
        );
        assert!(matches!(
            next.first(),
            Some(TurnEvent::TurnCompleted { usage: None, .. })
        ));
    }

    /// Codex sends reasoning as a completed item rather than as a stream, so
    /// without this it would draw an empty card.
    #[test]
    fn reasoning_text_is_turned_into_something_to_show() {
        let seen = events(&[
            r#"{"method":"item/completed","params":{"item":{"id":"i3","type":"reasoning","summary":[{"text":"Weighing two options"}],"status":"completed"}}}"#,
        ]);
        assert!(seen.iter().any(|e| matches!(
            e,
            TurnEvent::ContentDelta { stream: StreamKind::Reasoning, delta, .. }
                if delta.contains("Weighing")
        )));
    }
}

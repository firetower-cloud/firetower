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
    ItemId, ItemKind, ItemStatus, PlanStep, PlanStepStatus, RawSource, StreamKind, TurnEvent,
    TurnId, TurnStatus,
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
                // A session here is unattended by construction, so an agent
                // that stops to ask *may I run this* stops for somebody who is
                // not there. Confined instead of interrogated: it may do what
                // it likes inside the workspace and nothing outside it.
                //
                // Narrower than what a person at a keyboard gets, and it is
                // what Claude Code's own unattended mode does for the same
                // reason. Routing these to the card that already exists is
                // the next thing, and this line is what it replaces.
                "approvalPolicy": "never",
                "sandbox": "workspace-write",
            },
        }),
    ]
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

        // An answer to something we sent.
        if let Some(id) = value.get("id").and_then(Value::as_u64) {
            return self.answer(id, &value);
        }

        let Some(method) = value.get("method").and_then(Value::as_str) else {
            return Vec::new();
        };
        let params = value.get("params").cloned().unwrap_or(Value::Null);

        match method {
            "turn/started" => self.turn_started(&params),
            "turn/completed" => self.turn_completed(&params),
            "item/started" => self.item_started(&params),
            "item/completed" => self.item_completed(&params),
            "item/agentMessage/delta" => self.delta(&params, StreamKind::AssistantText),
            "item/plan/delta" => Vec::new(),
            "turn/plan/updated" => self.plan(&params),
            "account/rateLimits/updated" => self.limits(&params),
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

    fn answer(&mut self, id: u64, value: &Value) -> Vec<TurnEvent> {
        match self.awaiting.remove(&id) {
            Some(Awaiting::ThreadStart) => {
                if let Some(thread) = value
                    .get("result")
                    .and_then(|r| r.get("threadId").or_else(|| r.get("thread_id")))
                    .and_then(Value::as_str)
                {
                    self.thread = Some(thread.to_string());
                }
                Vec::new()
            }
            // Somebody else's request, or one whose answer says nothing.
            None => Vec::new(),
        }
    }

    fn turn_started(&mut self, params: &Value) -> Vec<TurnEvent> {
        let Some(turn) = turn_id(params) else {
            return Vec::new();
        };
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

        vec![TurnEvent::TurnCompleted {
            turn,
            status,
            usage: None,
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

        vec![TurnEvent::ItemStarted {
            item: ItemId::new(id),
            kind,
            title: title_for(kind, item),
            task: None,
        }]
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

    fn limits(&mut self, params: &Value) -> Vec<TurnEvent> {
        let window = params
            .get("window")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let status = params
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        vec![TurnEvent::Limited {
            window,
            status,
            resets_at: params.get("resetsAt").and_then(Value::as_i64),
        }]
    }
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
        reader.push(r#"{"id":1,"result":{"threadId":"not-ours"}}"#);
        assert_eq!(reader.thread(), None);

        reader.push(r#"{"id":2,"result":{"threadId":"th_123"}}"#);
        assert_eq!(reader.thread(), Some("th_123"));
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

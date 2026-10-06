//! ACP wire records and their replayable projection into the conversation.
//!
//! The durable worker owns the connection. It journals both directions because
//! ACP does not echo prompts or name turns. Request IDs plus the process epoch
//! make those identities stable when the same journal is read again.
use crate::controls::{Choice, Control, ControlKind};
use crate::turn::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "acp")]
pub enum Record {
    Started { epoch: String },
    Sent { message: Value },
    Received { message: Value, replay: bool },
    Ready { session: String },
    Failed { detail: String },
    ConfigurationRejected { id: String, detail: String },
}

/// Commands from Firetower to the ACP connection, not ACP wire methods.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "acp")]
pub enum Input {
    Prompt {
        text: String,
    },
    Cancel,
    Decide {
        req: String,
        decision: Decision,
    },
    Configure {
        id: String,
        config_id: String,
        value: String,
    },
}

/// Which skill an ACP tool call opened, if it opened one.
///
/// A read reports where it read from in `locations`, and names it in `title`;
/// either will do, and both are checked because Kimi fills the title in before
/// the locations arrive.
fn skill_in(update: &Value) -> Option<String> {
    if let Some(found) = crate::normalise::skill_reached_for("read", update) {
        return Some(found);
    }
    update["locations"].as_array().and_then(|at| {
        at.iter()
            .find_map(|one| crate::normalise::skill_reached_for("read", one))
    })
}

/// Whether this call is the agent reaching for a skill, named or not.
///
/// Kimi opens the item titled `Skill` and does not say which one until the
/// arguments have finished streaming. The kind has to be right from the first
/// update — an item cannot change what it is halfway through — so this is a
/// separate, looser question from [`skill_in`], which answers *which*.
fn is_a_skill(update: &Value) -> bool {
    if skill_in(update).is_some() {
        return true;
    }
    matches!(
        update["title"].as_str(),
        Some(title) if title == "Skill" || title.starts_with("Invoke skill")
    )
}

#[cfg(test)]
mod skill_tests {
    use super::*;

    /// The sequence Kimi actually sends, in order, from a real journal.
    ///
    /// The last update is the trap: it carries neither the title nor the
    /// `rawInput`, so anything deriving the name from the update in hand
    /// shows it and then loses it.
    #[test]
    fn the_name_survives_the_update_that_says_it_finished() {
        let mut reader = AcpNormaliser::default();
        // A turn has to be in flight before an update belongs to anything.
        reader.push(
            &serde_json::json!({"acp":"Sent","message":{"id":1,"method":"session/prompt"}})
                .to_string(),
        );

        let updates = [
            r#"{"kind":"other","sessionUpdate":"tool_call","status":"pending",
                "title":"Skill","toolCallId":"1:tool_x"}"#,
            r#"{"kind":"other","sessionUpdate":"tool_call_update","status":"in_progress",
                "title":"Invoke skill frontend-design",
                "rawInput":{"skill":"frontend-design","args":"look at the site"},
                "toolCallId":"1:tool_x"}"#,
            r#"{"sessionUpdate":"tool_call_update","status":"completed",
                "content":[{"type":"content","content":{"type":"text",
                  "text":"Skill \"frontend-design\" loaded inline."}}],
                "toolCallId":"1:tool_x"}"#,
        ];

        let mut kinds = Vec::new();
        let mut named = Vec::new();
        for raw in updates {
            let update: Value = serde_json::from_str(raw).unwrap();
            let line = serde_json::json!({
                "acp": "Received",
                "message": {"method": "session/update", "params": {"update": update}},
                "replay": false,
            });
            for event in reader.push(&line.to_string()) {
                match event {
                    TurnEvent::ItemStarted { kind, .. } => kinds.push(kind),
                    TurnEvent::ItemUpdated { data, .. } => named.push(
                        data.get("skill")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    ),
                    _ => {}
                }
            }
        }

        // It is a skill from the first update, before anything names it.
        assert_eq!(kinds, vec![ItemKind::SkillUse]);
        // And it is still named on the update that finishes it.
        assert_eq!(
            named,
            vec![
                None,
                Some("frontend-design".into()),
                Some("frontend-design".into())
            ],
        );
    }
}

pub fn prompt(text: &str) -> Value {
    json!(Input::Prompt { text: text.into() })
}

pub fn request_key(epoch: &str, id: &Value) -> String {
    format!("{epoch}:{}", id)
}

/// Preserve the agent's option IDs, including the distinction between one-off
/// and persistent approval. Unsupported decisions cancel rather than allow.
pub fn permission_outcome(options: &Value, decision: &Decision) -> Value {
    let kinds: &[&str] = match decision {
        Decision::Allow => &["allow_once"],
        Decision::AllowAlways => &["allow_always"],
        Decision::Deny { .. } => &["reject_once", "reject_always"],
        Decision::Answered { .. } => &[],
    };
    for kind in kinds {
        if let Some(option) = options
            .as_array()
            .and_then(|xs| xs.iter().find(|o| o["kind"] == *kind))
        {
            if let Some(id) = option["optionId"].as_str() {
                return json!({"outcome":"selected", "optionId":id});
            }
        }
    }
    json!({"outcome":"cancelled"})
}

#[derive(Default)]
pub struct AcpNormaliser {
    epoch: String,
    active: Option<(Value, TurnId)>,
    session: Option<String>,
    items: BTreeSet<ItemId>,
    /// Which skill each open call turned out to be reaching for.
    ///
    /// Remembered because ACP sends a *replacement snapshot* every time, and
    /// the last one — the `completed` update — carries neither the title nor
    /// the `rawInput` that named it. Without this the name arrives, is drawn,
    /// and is then wiped by the update that says the call finished.
    reaching_for: BTreeMap<ItemId, String>,
    requests: BTreeSet<String>,
    configuration_requests: BTreeSet<String>,
    configuration: Vec<(String, Control)>,
}

impl AcpNormaliser {
    pub fn controls(&self) -> Vec<Control> {
        self.configuration
            .iter()
            .map(|(_, control)| control.clone())
            .collect()
    }

    pub fn configure(&self, kind: ControlKind, value: &str) -> Option<Value> {
        let (id, _) = self.configuration.iter().find(|(_, c)| {
            c.kind == kind && c.choices.iter().any(|choice| choice.value == value)
        })?;
        serde_json::to_value(Input::Configure {
            id: crate::SessionId::new().to_string(),
            config_id: id.clone(),
            value: value.into(),
        })
        .ok()
    }

    fn configured(&mut self, options: &Value, events: &mut Vec<TurnEvent>) {
        let Some(options) = options.as_array() else {
            return;
        };
        self.configuration = options
            .iter()
            .filter_map(|option| {
                let kind = match option["category"].as_str()? {
                    "model" => ControlKind::Model,
                    "thought_level" => ControlKind::Effort,
                    // How much the agent may do unasked. Kimi offers this
                    // alongside the other two and Firetower already has a
                    // picker for it, so dropping it hid a control that works.
                    "mode" => ControlKind::Mode,
                    _ => return None,
                };
                if option["type"] != "select" {
                    return None;
                }
                let mut choices = Vec::new();
                for entry in option["options"].as_array()? {
                    let entries = entry
                        .get("options")
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or_else(|| std::slice::from_ref(entry));
                    for choice in entries {
                        if let (Some(value), Some(name)) =
                            (choice["value"].as_str(), choice["name"].as_str())
                        {
                            choices.push(Choice::of(
                                name,
                                value,
                                choice["description"].as_str().unwrap_or(""),
                            ));
                        }
                    }
                }
                Some((
                    option["id"].as_str()?.to_owned(),
                    Control {
                        kind,
                        fallback: option["name"].as_str().unwrap_or("Setting").into(),
                        choices,
                        current: option["currentValue"].as_str().map(str::to_owned),
                    },
                ))
            })
            .collect();
        events.push(TurnEvent::SessionConfigured {
            model: self
                .configuration
                .iter()
                .find(|(_, c)| c.kind == ControlKind::Model)
                .and_then(|(_, c)| c.current.clone())
                .unwrap_or_default(),
            mode: self
                .configuration
                .iter()
                .find(|(_, c)| c.kind == ControlKind::Mode)
                .and_then(|(_, c)| c.current.clone())
                .unwrap_or_default(),
            tools: Vec::new(),
            commands: Vec::new(),
        });
    }

    pub fn working(&self) -> bool {
        self.active.is_some()
    }

    pub fn push(&mut self, line: &str) -> Vec<TurnEvent> {
        let Ok(record) = serde_json::from_str::<Record>(line) else {
            return Vec::new();
        };
        let mut events = Vec::new();
        match record {
            Record::ConfigurationRejected { .. } => {}
            Record::Started { epoch } => {
                self.finish(
                    TurnStatus::Interrupted,
                    Some("Agent connection restarted; previous work was not replayed.".into()),
                    &mut events,
                );
                self.epoch = epoch;
                self.session = None;
                self.configuration.clear();
                self.configuration_requests.clear();
            }
            Record::Ready { session } => self.session = Some(session),
            Record::Failed { detail } => {
                if self.active.is_none() {
                    self.active =
                        Some((Value::Null, TurnId::new(format!("{}:startup", self.epoch))));
                }
                self.finish(TurnStatus::Failed, Some(detail), &mut events);
            }
            Record::Sent { message } => {
                if matches!(
                    message["method"].as_str(),
                    Some("session/new" | "session/load" | "session/set_config_option")
                ) {
                    self.configuration_requests
                        .insert(message["id"].to_string());
                }
                if message["method"] == "session/prompt" {
                    let key = request_key(&self.epoch, &message["id"]);
                    let turn = TurnId::new(&key);
                    self.active = Some((message["id"].clone(), turn.clone()));
                    events.push(TurnEvent::TurnStarted { turn });
                    let item = ItemId::new(format!("{key}:user"));
                    events.push(TurnEvent::ItemStarted {
                        item: item.clone(),
                        kind: ItemKind::UserMessage,
                        title: None,
                        task: None,
                    });
                    if let Some(blocks) = message["params"]["prompt"].as_array() {
                        for block in blocks {
                            if let Some(text) = block["text"].as_str() {
                                events.push(TurnEvent::ContentDelta {
                                    item: item.clone(),
                                    stream: StreamKind::UserText,
                                    delta: text.into(),
                                });
                            }
                        }
                    }
                    events.push(TurnEvent::ItemCompleted {
                        item,
                        status: ItemStatus::Completed,
                    });
                } else if message.get("method").is_none() {
                    let key = request_key(&self.epoch, &message["id"]);
                    if self.requests.remove(&key) {
                        events.push(TurnEvent::RequestResolved {
                            req: RequestId::new(key),
                            decision: None,
                        });
                    }
                }
            }
            Record::Received { message, replay } => {
                // Loading suppresses historical conversation, not the current
                // session configuration returned by the agent.
                if message.get("method").is_none()
                    && self
                        .configuration_requests
                        .remove(&message["id"].to_string())
                    && message.get("error").is_none()
                {
                    self.configured(&message["result"]["configOptions"], &mut events);
                }
                if message["method"] == "session/update"
                    && self.session.as_deref() == message["params"]["sessionId"].as_str()
                    && message["params"]["update"]["sessionUpdate"] == "config_option_update"
                {
                    self.configured(&message["params"]["update"]["configOptions"], &mut events);
                    return events;
                }
                // The journal already has this history. A load replays it for
                // the agent/client handshake, not as new user-visible work.
                if replay {
                    return events;
                }
                if message["method"] == "session/request_permission" {
                    if self.session.as_deref() != message["params"]["sessionId"].as_str() {
                        return events;
                    }
                    let key = request_key(&self.epoch, &message["id"]);
                    if self.requests.insert(key.clone()) {
                        events.push(TurnEvent::RequestOpened {
                            req: RequestId::new(key),
                            kind: RequestKind::Tool,
                            detail: message["params"]["toolCall"]["title"]
                                .as_str()
                                .unwrap_or("Agent tool permission")
                                .into(),
                            args: message["params"].clone(),
                        });
                    }
                } else if message["method"] == "session/update" {
                    if self.session.as_deref() == message["params"]["sessionId"].as_str() {
                        self.update(&message["params"]["update"], &mut events);
                    }
                } else if message.get("method").is_none()
                    && self
                        .active
                        .as_ref()
                        .is_some_and(|(id, _)| *id == message["id"])
                {
                    let (status, detail) = if let Some(error) = message.get("error") {
                        (TurnStatus::Failed, Some(error.to_string()))
                    } else {
                        match message["result"]["stopReason"].as_str() {
                            Some("cancelled") => (TurnStatus::Interrupted, None),
                            Some("end_turn") => (TurnStatus::Completed, None),
                            Some(reason) => (
                                TurnStatus::Completed,
                                Some(format!("Agent stopped: {reason}")),
                            ),
                            None => (
                                TurnStatus::Failed,
                                Some("ACP prompt response has no stopReason".into()),
                            ),
                        }
                    };
                    self.finish(status, detail, &mut events);
                } else {
                    events.push(TurnEvent::Raw {
                        source: RawSource::Acp,
                        payload: message,
                    });
                }
            }
        }
        events
    }

    fn update(&mut self, update: &Value, events: &mut Vec<TurnEvent>) {
        let Some((_, turn)) = &self.active else {
            return;
        };
        let kind = update["sessionUpdate"].as_str().unwrap_or("");
        match kind {
            "agent_message_chunk" | "agent_thought_chunk" => {
                let thought = kind == "agent_thought_chunk";
                let item = ItemId::new(format!("{turn}:{kind}"));
                if self.items.insert(item.clone()) {
                    events.push(TurnEvent::ItemStarted {
                        item: item.clone(),
                        kind: if thought {
                            ItemKind::Reasoning
                        } else {
                            ItemKind::AssistantMessage
                        },
                        title: None,
                        task: None,
                    });
                }
                if let Some(text) = update["content"]["text"].as_str() {
                    events.push(TurnEvent::ContentDelta {
                        item,
                        stream: if thought {
                            StreamKind::Reasoning
                        } else {
                            StreamKind::AssistantText
                        },
                        delta: text.into(),
                    });
                } else {
                    events.push(TurnEvent::Raw {
                        source: RawSource::Acp,
                        payload: update.clone(),
                    });
                }
            }
            "tool_call" | "tool_call_update" => {
                let Some(id) = update["toolCallId"].as_str() else {
                    return;
                };
                let item = ItemId::new(format!("{turn}:tool:{id}"));
                // ACP has no skill tool. Kimi reads a `SKILL.md` like any
                // other file, so what says a skill was reached for is the
                // path — in the title, or in the locations a read reports.
                // Checked before `kind`, because the agent is honestly calling
                // it a read and it is honestly not work done to the workspace.
                // Learned once and kept: the snapshot that says the call
                // finished no longer names what it was.
                if let Some(found) = skill_in(update) {
                    self.reaching_for.insert(item.clone(), found);
                }
                let reached = self.reaching_for.get(&item).cloned();

                if self.items.insert(item.clone()) {
                    let kind = match update["kind"].as_str() {
                        _ if reached.is_some() || is_a_skill(update) => ItemKind::SkillUse,
                        Some("read") => ItemKind::FileRead,
                        Some("edit" | "delete" | "move") => ItemKind::FileChange,
                        Some("execute") => ItemKind::CommandExecution,
                        Some("search" | "fetch") => ItemKind::WebSearch,
                        _ => ItemKind::Unknown,
                    };
                    events.push(TurnEvent::ItemStarted {
                        item: item.clone(),
                        kind,
                        title: reached
                            .clone()
                            .or_else(|| update["title"].as_str().map(str::to_owned)),
                        task: None,
                    });
                }
                // The same one key every other reader writes.
                let mut data = update.clone();
                if let (Some(found), Some(fields)) = (reached, data.as_object_mut()) {
                    fields.insert("skill".into(), Value::String(found));
                }
                events.push(TurnEvent::ItemUpdated {
                    item: item.clone(),
                    data,
                });
                // ACP tool content is a replacement snapshot, not a delta.
                // Kimi streams growing argument snapshots here; only the
                // terminal snapshot belongs in the append-only output stream.
                // Intermediate activity remains available in ItemUpdated.
                if let Some(contents) = update["content"]
                    .as_array()
                    .filter(|_| matches!(update["status"].as_str(), Some("completed" | "failed")))
                {
                    for content in contents {
                        let text = match content["type"].as_str() {
                            Some("content") => {
                                content["content"]["text"].as_str().map(str::to_owned)
                            }
                            Some("diff") => Some(format!(
                                "{}\n--- before\n{}\n+++ after\n{}",
                                content["path"].as_str().unwrap_or(""),
                                content["oldText"].as_str().unwrap_or(""),
                                content["newText"].as_str().unwrap_or("")
                            )),
                            _ => None,
                        };
                        if let Some(delta) = text {
                            events.push(TurnEvent::ContentDelta {
                                item: item.clone(),
                                stream: StreamKind::ToolOutput,
                                delta,
                            });
                        }
                    }
                }
                if let Some(status @ ("completed" | "failed")) = update["status"].as_str() {
                    self.items.remove(&item);
                    events.push(TurnEvent::ItemCompleted {
                        item,
                        status: if status == "failed" {
                            ItemStatus::Failed
                        } else {
                            ItemStatus::Completed
                        },
                    });
                }
            }
            _ => events.push(TurnEvent::Raw {
                source: RawSource::Acp,
                payload: update.clone(),
            }),
        }
    }

    fn finish(&mut self, status: TurnStatus, detail: Option<String>, events: &mut Vec<TurnEvent>) {
        for req in std::mem::take(&mut self.requests) {
            events.push(TurnEvent::RequestResolved {
                req: RequestId::new(req),
                decision: None,
            });
        }
        for item in std::mem::take(&mut self.items) {
            events.push(TurnEvent::ItemCompleted {
                item,
                status: if status == TurnStatus::Failed {
                    ItemStatus::Failed
                } else {
                    ItemStatus::Completed
                },
            });
        }
        if let Some((_, turn)) = self.active.take() {
            events.push(TurnEvent::TurnCompleted {
                turn,
                status,
                usage: None,
                detail,
            });
        }
    }
}

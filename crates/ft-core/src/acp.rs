//! ACP wire records and their replayable projection into the conversation.
//!
//! The durable worker owns the connection. It journals both directions because
//! ACP does not echo prompts or name turns. Request IDs plus the process epoch
//! make those identities stable when the same journal is read again.
use crate::controls::{Choice, Control, ControlKind};
use crate::turn::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "acp")]
pub enum Record {
    Started { epoch: String },
    Sent { message: Value },
    Received { message: Value, replay: bool },
    Ready { session: String },
    Failed { detail: String },
    ConfigurationRejected { id: String, detail: String },
    /// What the agent says the session has spent, as `/usage` reported it.
    ///
    /// Running totals, not a turn's own figures — see `AcpNormaliser::spent`.
    /// Written by the worker just before the reply that ends a turn, so the
    /// turn it belongs to is still open when this arrives.
    ///
    /// Not a `Received`, because the exchange that produced it is not part of
    /// anybody's conversation: the worker asks, reads the answer and journals
    /// this instead, so the transcript stays what the person actually said.
    Metered { input: u64, output: u64 },
}

/// The two numbers out of what `/usage` prints.
///
/// Kimi builds this line from a template rather than a model, so it is parsed
/// strictly and anything else is treated as nothing reported. Its own code:
///
/// ```text
/// const input = total.inputOther + total.inputCacheRead + total.inputCacheCreation;
/// lines.push(`Session total: ${input} input, ${total.output} output`);
/// ```
///
/// Which is also why there is no cache split here to keep: the three kinds are
/// added up before the sentence is written, and the structured object they came
/// from never leaves the agent. A session with no turns yet says "no LLM calls
/// yet" instead, and that is a `None` rather than a zero.
pub fn metered(text: &str) -> Option<(u64, u64)> {
    let line = text.lines().find_map(|l| l.trim().strip_prefix("Session total:"))?;
    let (input, output) = line.split_once(',')?;
    Some((
        input.trim().strip_suffix("input")?.trim().parse().ok()?,
        output.trim().strip_suffix("output")?.trim().parse().ok()?,
    ))
}

/// What the worker sends to ask. A slash command is an ordinary prompt that the
/// agent answers itself rather than passing to a model, which is why this costs
/// no tokens to run — only the few its text adds to the context.
pub const USAGE_COMMAND: &str = "/usage";

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

pub fn prompt(text: &str) -> Value {
    json!(Input::Prompt { text: text.into() })
}

pub fn request_key(epoch: &str, id: &Value) -> String {
    format!("{epoch}:{}", id)
}

/// One turn's token counts as ACP spells them.
///
/// `totalTokens` is ignored: it is the sum of the others and storing a total
/// beside its parts is one more number to disagree with itself. The three
/// optional fields stay optional — an agent that does not break out its cache
/// is saying it does not know, which a zero would misreport as "none".
fn parse_usage(usage: &Value) -> Option<Usage> {
    let count = |name: &str| usage.get(name).and_then(Value::as_u64);
    // Two required fields in the schema; neither present means no usage block
    // rather than a turn that did nothing.
    let (input, output) = (count("inputTokens")?, count("outputTokens")?);
    Some(Usage {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: count("cachedReadTokens"),
        cache_write_tokens: count("cachedWriteTokens"),
        thinking_tokens: count("thoughtTokens"),
        ..Default::default()
    })
}

/// The difference between two running totals that each may be unreported.
///
/// `None` only where the agent has never said, so a field it starts reporting
/// mid-session begins from what it has said rather than from nothing.
fn pair(now: Option<u64>, before: Option<u64>) -> Option<u64> {
    Some(now?.saturating_sub(before.unwrap_or(0)))
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
    requests: BTreeSet<String>,
    configuration_requests: BTreeSet<String>,
    configuration: Vec<(String, Control)>,
    /// How full the context is, from `usage_update`.
    ///
    /// `(used, size)`. A gauge and not a bill: `used` is what is in the window
    /// now, so a turn that re-read a cached prefix twenty times counts it once.
    /// It reaches `context_used`/`context_window` and goes no further — see the
    /// note on `consumption_events` for why that column is not on a fact row.
    context: Option<(u64, u64)>,
    /// What the agent says the session has spent, where it says anything.
    ///
    /// ACP's `Usage` is documented per field as "across session" and "across
    /// all turns", so this is a running total in the same way Claude Code's
    /// `modelUsage` is, and is differenced the same way before anything is
    /// billed. Behind the `unstable_end_turn_token_usage` feature in the
    /// protocol, so most agents send nothing and this stays `None`.
    billed: Usage,
    /// The session's running totals as `/usage` last reported them.
    ///
    /// `(input, output)`, where input is all three kinds added together because
    /// that is all the sentence carries. Set by `Record::Metered` just before
    /// the turn it belongs to closes, and taken by `spent` when it does.
    metered: Option<(u64, u64)>,
    /// How much of that has already been billed to earlier turns.
    charged: (u64, u64),
}

impl AcpNormaliser {
    pub fn controls(&self) -> Vec<Control> {
        self.configuration
            .iter()
            .map(|(_, control)| control.clone())
            .collect()
    }

    /// Which model the agent says it is running.
    ///
    /// ACP carries no per-model breakdown on usage, so this is the only name a
    /// billed row can take. It is a `configOptions` entry rather than anything
    /// usage-shaped — Kimi answers `session/new` with
    /// `currentValue: "kimi-code/kimi-for-coding"` before any turn runs.
    pub fn model(&self) -> Option<&str> {
        self.configuration
            .iter()
            .find(|(_, c)| c.kind == ControlKind::Model)
            .and_then(|(_, c)| c.current.as_deref())
    }

    /// How full the context is, as the agent last said.
    pub fn context(&self) -> Option<(u64, u64)> {
        self.context
    }

    /// What one turn cost, out of totals that are the whole session's.
    ///
    /// Every field of ACP's `Usage` is documented as a total — "across
    /// session", "across all turns" — so reading it as a turn's figures bills
    /// turn one again on every turn after it. Subtracting what has already been
    /// handed over is the same correction `ClaudeNormaliser` makes against
    /// `modelUsage`, and for the same reason.
    ///
    /// `None` when the agent said nothing, which today is every ACP agent:
    /// `usage` here is gated behind `unstable_end_turn_token_usage` and Kimi's
    /// build does not send it. The gauge from `usage_update` rides along
    /// regardless, because that one is in the spec proper and does arrive.
    fn spent(&mut self, usage: &Value) -> Option<Usage> {
        let (used, size) = match self.context {
            Some((used, size)) => (Some(used), Some(size)),
            None => (None, None),
        };

        let Some(total) = parse_usage(usage) else {
            // Nothing in the reply. What `/usage` said, if the worker asked —
            // running totals again, so again the difference is this turn's.
            if let Some((input, output)) = self.metered.take() {
                let delta = Usage {
                    input_tokens: input.saturating_sub(self.charged.0),
                    output_tokens: output.saturating_sub(self.charged.1),
                    // `/usage` adds the three kinds of input together before
                    // printing, so there is no split to report. NULL rather
                    // than zero: the agent knows, it just does not say.
                    cache_read_tokens: None,
                    cache_write_tokens: None,
                    context_used: used,
                    context_window: size,
                    // It prints tokens and never a price.
                    cost_usd: None,
                    ..Default::default()
                };
                self.charged = (input, output);
                return Some(delta);
            }
            // Nothing billable was reported. A turn still carries how full the
            // window is, which is what the conversation view draws, and no
            // consumption row is written from it.
            return (used.is_some()).then(|| Usage {
                context_used: used,
                context_window: size,
                ..Default::default()
            });
        };

        let since = |now: u64, then: u64| now.saturating_sub(then);
        let delta = Usage {
            input_tokens: since(total.input_tokens, self.billed.input_tokens),
            output_tokens: since(total.output_tokens, self.billed.output_tokens),
            cache_read_tokens: pair(total.cache_read_tokens, self.billed.cache_read_tokens),
            cache_write_tokens: pair(total.cache_write_tokens, self.billed.cache_write_tokens),
            thinking_tokens: pair(total.thinking_tokens, self.billed.thinking_tokens),
            context_used: used,
            context_window: size.or(total.context_window),
            // ACP states no price on `Usage` at all. The one it has is on
            // `usage_update`, cumulative for the session and in a currency of
            // the agent's choosing, which is not the column we have.
            cost_usd: None,
            ..Default::default()
        };
        self.billed = total;
        Some(delta)
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
            // Held until the turn it belongs to closes, which is the next
            // record the worker writes.
            Record::Metered { input, output } => self.metered = Some((input, output)),
            Record::Started { epoch } => {
                self.finish(
                    TurnStatus::Interrupted,
                    Some("Agent connection restarted; previous work was not replayed.".into()),
                    None,
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
                self.finish(TurnStatus::Failed, Some(detail), None, &mut events);
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
                    // The reply is where a per-turn breakdown rides, where the
                    // agent sends one at all.
                    let spent = self.spent(&message["result"]["usage"]);
                    self.finish(status, detail, spent, &mut events);
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
        // Before the active-turn guard: Kimi sends this *after* the reply that
        // ends the turn, so a gauge dropped for want of a turn would be the
        // only one that ever arrives.
        if update["sessionUpdate"] == "usage_update" {
            if let (Some(used), Some(size)) = (
                update["used"].as_u64(),
                update["size"].as_u64(),
            ) {
                self.context = Some((used, size));
            }
            return;
        }

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
                if self.items.insert(item.clone()) {
                    let kind = match update["kind"].as_str() {
                        Some("read") => ItemKind::FileRead,
                        Some("edit" | "delete" | "move") => ItemKind::FileChange,
                        Some("execute") => ItemKind::CommandExecution,
                        Some("search" | "fetch") => ItemKind::WebSearch,
                        _ => ItemKind::Unknown,
                    };
                    events.push(TurnEvent::ItemStarted {
                        item: item.clone(),
                        kind,
                        title: update["title"].as_str().map(str::to_owned),
                        task: None,
                    });
                }
                events.push(TurnEvent::ItemUpdated {
                    item: item.clone(),
                    data: update.clone(),
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

    fn finish(
        &mut self,
        status: TurnStatus,
        detail: Option<String>,
        spent: Option<Usage>,
        events: &mut Vec<TurnEvent>,
    ) {
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
                usage: spent,
                detail,
            });
        }
    }
}

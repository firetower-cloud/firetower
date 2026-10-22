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
    Started {
        epoch: String,
    },
    Sent {
        message: Value,
    },
    Received {
        message: Value,
        replay: bool,
    },
    Ready {
        session: String,
    },
    Failed {
        detail: String,
    },
    ConfigurationRejected {
        id: String,
        detail: String,
    },
    /// What the agent says the session has spent, as `/usage` reported it.
    ///
    /// Running totals, not a turn's own figures — see `AcpNormaliser::spent`.
    /// Written by the worker just before the reply that ends a turn, so the
    /// turn it belongs to is still open when this arrives.
    ///
    /// Not a `Received`, because the exchange that produced it is not part of
    /// anybody's conversation: the worker asks, reads the answer and journals
    /// this instead, so the transcript stays what the person actually said.
    Metered {
        input: u64,
        output: u64,
    },
}

/// One quota window, on its way to `agent_account_limits`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Window {
    pub window: String,
    pub used_percent: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
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
    let line = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("Session total:"))?;
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
    /// Cursor's delegated calls, and how each one ended.
    ///
    /// Keyed by `toolCallId`. A `Task:`-titled tool call opens one; the call's
    /// own `completed`/`failed` records the outcome, and `cursor/task` — which
    /// arrives separately and may arrive late — closes it. Drained on `finish`
    /// so a turn that ends without one still resolves every task it opened.
    cursor_tasks: BTreeMap<String, Option<ItemStatus>>,
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
    /// Whether the turn now finishing actually reached a model.
    ran: Ran,
}

/// Whether a model was called for a turn, where that can be known.
///
/// It can only be known where the agent was metered, which is the one good
/// thing to come out of asking it what it spent: ACP reports a turn that failed
/// before any request identically to one that succeeded — Kimi answers both
/// with `{"stopReason":"end_turn"}` — so until there was a number to compare,
/// a session whose credentials had expired looked perfectly healthy and
/// silently did nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Ran {
    /// Nobody asked, so nobody knows. Every unmetered agent is here.
    #[default]
    Unknown,
    Yes,
    /// Metered, and the session's input total did not move.
    No,
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
                let grew = input > self.charged.0;
                // Every request sends the whole context, so a turn that called
                // a model always moves the input total. One that did not move
                // it called nothing — see `Ran`.
                self.ran = if grew { Ran::Yes } else { Ran::No };
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
                self.cursor_tasks.clear();
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
                } else if message["method"] == "cursor/task" {
                    let params = &message["params"];
                    if let Some(call) = params["toolCallId"].as_str() {
                        if let Some(status) = self.cursor_tasks.remove(call) {
                            let task = TaskId::new(call);
                            if let Some(agent) = params["agentId"].as_str() {
                                events.push(TurnEvent::TaskProgress {
                                    task: task.clone(),
                                    detail: format!("Cursor subagent {agent}"),
                                });
                            }
                            events.push(TurnEvent::TaskCompleted {
                                task,
                                status: status.unwrap_or(ItemStatus::Completed),
                                summary: params["description"].as_str().map(str::to_owned),
                            });
                        } else {
                            events.push(TurnEvent::Raw {
                                source: RawSource::Acp,
                                payload: message,
                            });
                        }
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
                    self.ran = Ran::Unknown;
                    let spent = self.spent(&message["result"]["usage"]);

                    // A turn the agent says succeeded, having called no model.
                    //
                    // ACP gives failure no shape of its own: Kimi answers an
                    // expired credential with `{"stopReason":"end_turn"}`, the
                    // same words it uses for work it actually did, and puts the
                    // reason only in a log file of its own. So a session whose
                    // sign-in had lapsed reported every turn as finished, said
                    // nothing, and looked entirely well — which is how one hid
                    // here for a day.
                    //
                    // The meter is what tells them apart. Every request sends
                    // the whole context, so a turn that reached a model always
                    // moves the session's input total; one that did not move it
                    // did not get that far. Only ever applied to a turn the
                    // agent called successful — a cancellation is already
                    // honestly reported, and overriding it would be a lie in
                    // the other direction.
                    let (status, detail) = match (status, self.ran) {
                        (TurnStatus::Completed, Ran::No) => (
                            TurnStatus::Failed,
                            Some(
                                "The agent ended this turn without calling a model. Its \
                                 sign-in or its quota is the usual reason — reconnect the \
                                 account and try again."
                                    .to_string(),
                            ),
                        ),
                        (status, _) => (status, detail),
                    };
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
            if let (Some(used), Some(size)) = (update["used"].as_u64(), update["size"].as_u64()) {
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
                    // A delegated call first: `Task:` is structural, and a
                    // subagent reading a skill of its own would otherwise be
                    // filed as the skill rather than as the task that opened it.
                    let delegated = update["title"]
                        .as_str()
                        .is_some_and(|title| title.starts_with("Task:"));
                    let kind = if delegated {
                        ItemKind::SubagentCall
                    } else {
                        match update["kind"].as_str() {
                            _ if reached.is_some() || is_a_skill(update) => ItemKind::SkillUse,
                            Some("read") => ItemKind::FileRead,
                            Some("edit" | "delete" | "move") => ItemKind::FileChange,
                            Some("execute") => ItemKind::CommandExecution,
                            Some("search" | "fetch") => ItemKind::WebSearch,
                            _ => ItemKind::Unknown,
                        }
                    };
                    events.push(TurnEvent::ItemStarted {
                        item: item.clone(),
                        kind,
                        title: reached
                            .clone()
                            .or_else(|| update["title"].as_str().map(str::to_owned)),
                        task: None,
                    });
                    if delegated {
                        self.cursor_tasks.insert(id.to_owned(), None);
                        events.push(TurnEvent::TaskStarted {
                            task: TaskId::new(id),
                            item: item.clone(),
                            description: update["title"].as_str().unwrap_or("Task").to_owned(),
                            agent: Some("Cursor subagent".into()),
                        });
                    }
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
                    if let Some(task) = self.cursor_tasks.get_mut(id) {
                        *task = Some(if status == "failed" {
                            ItemStatus::Failed
                        } else {
                            ItemStatus::Completed
                        });
                    }
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
        // Any delegated call still open when the turn ends is resolved here.
        // `cursor/task` is the notification that would have closed it, and a
        // turn can finish without one — an unresolved task would otherwise sit
        // in the transcript as work that never came back.
        for (call, outcome) in std::mem::take(&mut self.cursor_tasks) {
            events.push(TurnEvent::TaskCompleted {
                task: TaskId::new(call),
                status: outcome.unwrap_or(ItemStatus::Failed),
                summary: None,
            });
        }
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

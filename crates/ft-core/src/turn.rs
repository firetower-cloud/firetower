//! What an agent said and did, as values rather than as a screen.
//!
//! [`EventKind`](crate::EventKind) describes a *session*: it was created, a step
//! started, the status changed. This describes the *conversation* inside one —
//! the messages, the tool calls, the questions that stopped it. Firetower needs
//! both, and they answer different questions: one is "what is this session
//! doing", the other is "what is the agent saying".
//!
//! Everything here is provider-neutral on purpose. Claude Code, Codex and the
//! rest each speak their own protocol, and exactly one place — the normaliser —
//! knows which. Past that boundary a tool call is a tool call.
//!
//! ## Identifiers are derived, never minted
//!
//! Unlike [`SessionId`](crate::SessionId) and friends, nothing here calls
//! `new()`. Every id is a pure function of the bytes the agent produced: a tool
//! item is keyed by the agent's own tool-use id, a block of prose by its message
//! id and index. That is what makes normalising the same log twice produce the
//! same events twice — which is the whole reason the raw log is what Firetower
//! keeps. Get a mapping wrong, fix it, and re-derive history rather than living
//! with it.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A newtype over a string that came out of an agent's own output.
///
/// Deliberately without a `new()`: see the note about derived identifiers above.
macro_rules! derived_id {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(
            Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, ToSchema,
        )]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Wrap something the agent said, or something derived from it.
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

derived_id!(
    TurnId,
    "One exchange: a prompt in, and everything that happened before the agent stopped."
);
derived_id!(
    ItemId,
    "One thing in the transcript — a message, a thought, a tool call."
);
derived_id!(
    RequestId,
    "One thing the agent is blocked on and needs an answer to."
);
derived_id!(
    TaskId,
    "One subagent run, from the moment it was spawned to its report."
);

/// What kind of thing an item is, which is what decides how it is drawn.
///
/// The list is short on purpose. It is not a catalogue of every tool an agent
/// might have — that changes weekly and is not knowable — but of the shapes
/// Firetower can draw usefully. Anything that doesn't fit is [`Unknown`], which
/// still renders: name, input, output. A wrong guess costs a nicer card, never
/// the event itself.
///
/// [`Unknown`]: ItemKind::Unknown
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum ItemKind {
    /// Prose from the agent.
    AssistantMessage,
    /// Prose from the agent that it does not consider part of its answer.
    Reasoning,
    /// What somebody typed.
    UserMessage,
    /// A shell command.
    CommandExecution,
    /// Something that writes to the workspace.
    FileChange,
    /// Something that only reads.
    FileRead,
    /// A tool from a connected MCP server.
    McpToolCall,
    /// Searching or fetching the web.
    WebSearch,
    /// Handing work to a subagent.
    SubagentCall,
    /// A tool we have no shape for. Draws generically, on purpose.
    Unknown,
}

/// How an item ended, when it has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum ItemStatus {
    Completed,
    Failed,
    /// The person said no.
    Declined,
}

/// Which stream a piece of text belongs to.
///
/// Separate from [`ItemKind`] because one item can carry more than one: a
/// command has both its own text and its output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum StreamKind {
    AssistantText,
    Reasoning,
    /// What a tool printed.
    ToolOutput,
    /// The arguments to a tool call, which arrive a fragment at a time.
    ToolInput,
}

/// What an agent is asking permission for.
///
/// Coarser than the tool that triggered it, because the question a person is
/// being asked is "may this run", not "which of forty tools is this".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum RequestKind {
    CommandExecution,
    FileRead,
    FileChange,
    /// A tool we have no shape for. The card shows its raw input.
    Tool,
}

/// How a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum TurnStatus {
    Completed,
    Failed,
    /// Somebody stopped it.
    Interrupted,
}

/// What the person decided, when they were asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "decision")]
pub enum Decision {
    Allow,
    /// Allow, and stop asking about calls like this one.
    AllowAlways,
    Deny {
        /// Shown to the agent, which reads it and often tries something else.
        /// That is the point of asking for one.
        reason: Option<String>,
    },
}

/// What a turn cost.
///
/// Not `Eq`, because the cost is a float. Comparing two of these for equality
/// is a test convenience, not something to build on.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Absent when the agent does not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    /// The agent's own estimate, in dollars. Its arithmetic, not ours.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

/// One line of the agent's plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub step: String,
    pub status: PlanStepStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum PlanStepStatus {
    Pending,
    InProgress,
    Completed,
}

/// One choice offered by a question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    /// What the agent expects back. Answers are keyed by this, not by position.
    pub label: String,
    pub description: String,
}

/// Something the agent wants to know before it carries on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// The answer is keyed by this text, so it has to survive the round trip
    /// unchanged.
    pub question: String,
    /// A few words, for the top of the card.
    pub header: String,
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub multi_select: bool,
}

/// A slash command this session offers, as the agent reported it at startup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Which agent's output a raw frame came from.
///
/// Carried so that a frame kept for later is still interpretable later: the
/// bytes alone do not say whose they are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum RawSource {
    ClaudeStreamJson,
}

/// Something an agent said or did.
///
/// The vocabulary the interface draws, and the only thing that crosses out of
/// the normaliser.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type")]
pub enum TurnEvent {
    /// What this session can do, reported once when the agent starts.
    SessionConfigured {
        model: String,
        tools: Vec<String>,
        slash_commands: Vec<SlashCommand>,
    },

    TurnStarted {
        turn: TurnId,
    },
    TurnCompleted {
        turn: TurnId,
        status: TurnStatus,
        usage: Option<Usage>,
    },

    ItemStarted {
        item: ItemId,
        kind: ItemKind,
        /// What the card is called before there is anything in it.
        title: Option<String>,
        /// Set when a subagent owns this item rather than the main thread.
        ///
        /// Without it a subagent's tool calls interleave into the transcript
        /// and read as though the main agent made them.
        task: Option<TaskId>,
    },
    /// Something about an open item changed — usually a tool's arguments
    /// arriving, which come a fragment at a time and are only worth showing
    /// once they parse.
    ItemUpdated {
        item: ItemId,
        data: serde_json::Value,
    },
    ItemCompleted {
        item: ItemId,
        status: ItemStatus,
    },
    ContentDelta {
        item: ItemId,
        stream: StreamKind,
        delta: String,
    },

    /// The agent is blocked and cannot continue without an answer.
    RequestOpened {
        req: RequestId,
        kind: RequestKind,
        /// The command, the path — whatever a person needs to decide.
        detail: String,
        /// The tool's full input, for a card that wants to show more.
        args: serde_json::Value,
    },
    RequestResolved {
        req: RequestId,
        decision: Decision,
    },
    UserInputRequested {
        req: RequestId,
        questions: Vec<Question>,
    },
    UserInputResolved {
        req: RequestId,
        answers: serde_json::Value,
    },

    PlanUpdated {
        steps: Vec<PlanStep>,
    },

    TaskStarted {
        task: TaskId,
        /// The tool call that spawned it, which is how its items find their way
        /// home.
        item: ItemId,
        description: String,
        agent_type: Option<String>,
    },
    TaskProgress {
        task: TaskId,
        detail: String,
    },
    TaskCompleted {
        task: TaskId,
        status: ItemStatus,
        summary: Option<String>,
    },

    /// A line we kept but could not name.
    ///
    /// Only for what nothing else matched — the complete raw log is already
    /// what Firetower stores, so repeating every mapped line here would double
    /// the volume to say nothing new. This is the marker for "an agent said
    /// something in a shape we have never seen", which is how a version that
    /// grew a new message type shows up as a gap to fill rather than as
    /// silence.
    Raw {
        source: RawSource,
        payload: serde_json::Value,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_are_what_the_agent_called_them() {
        // Not minted: normalising the same log twice has to name the same
        // things the same way, or re-deriving history changes it.
        let id = ItemId::new("toolu_01Cg6dWJEN5UkuNfvxyEYoGb");
        assert_eq!(id.as_str(), "toolu_01Cg6dWJEN5UkuNfvxyEYoGb");
        assert_eq!(id, ItemId::new("toolu_01Cg6dWJEN5UkuNfvxyEYoGb"));
    }

    #[test]
    fn an_event_is_tagged_by_its_name_on_the_wire() {
        let event = TurnEvent::ItemCompleted {
            item: ItemId::new("toolu_1"),
            status: ItemStatus::Completed,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "ItemCompleted");
        assert_eq!(json["item"], "toolu_1");
    }

    #[test]
    fn a_denial_carries_its_reason_because_the_agent_reads_it() {
        let decision = Decision::Deny {
            reason: Some("not on production".into()),
        };
        let json = serde_json::to_value(&decision).unwrap();
        assert_eq!(json["decision"], "Deny");
        assert_eq!(json["reason"], "not on production");
    }
}

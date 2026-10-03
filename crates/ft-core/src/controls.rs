//! The things about a running session somebody can change.
//!
//! Which knobs a session has is a fact about the agent it runs, not about the
//! screen. It lived in the browser as three constants for as long as there was
//! one agent to be right about; a second one made every list wrong, and the
//! mechanism wrong with it — Claude Code reads slash commands out of ordinary
//! input, and Codex takes the same settings as parameters on every turn.
//!
//! So this says what the choices *are*. How one is put into force belongs to
//! whatever is driving the agent.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// One option in a picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    /// What the picker shows when this is in force.
    pub label: String,
    /// What gets sent.
    pub value: String,
    /// Why somebody would pick it, when that is not obvious.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Drawn apart, because it changes what the agent may do unsupervised.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub grave: bool,
}

impl Choice {
    /// One the agent told us about, rather than one written down here.
    pub fn of(label: &str, value: &str, note: &str) -> Self {
        Self::new(label, value, note)
    }

    fn new(label: &str, value: &str, note: &str) -> Self {
        Self {
            label: label.into(),
            value: value.into(),
            note: (!note.is_empty()).then(|| note.to_string()),
            grave: false,
        }
    }

    fn grave(mut self) -> Self {
        self.grave = true;
        self
    }
}

/// Which setting a picker changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ControlKind {
    Model,
    /// When the agent stops to ask.
    Mode,
    /// How hard it thinks.
    Effort,
    /// What it may do at all, enforced by the operating system rather than by
    /// the agent deciding to behave. Only the agents that have such a thing.
    Sandbox,
}

/// One picker: what it changes, what it offers, and what is in force.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub kind: ControlKind,
    /// Shown when nothing is in force yet.
    pub fallback: String,
    pub choices: Vec<Choice>,
    /// What is in force, when the agent has said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
}

/// What Claude Code offers.
///
/// The long-context variants where they exist, because a session here is
/// unattended and often long — which is exactly the shape of work that runs out
/// of room.
fn claude_models() -> Vec<Choice> {
    vec![
        Choice::new("Opus", "opus[1m]", "The flagship, long context"),
        Choice::new("Fable", "fable[1m]", "More capable, more expensive"),
        Choice::new("Sonnet", "sonnet[1m]", "Quicker, cheaper"),
        Choice::new("Haiku", "haiku", "Fastest, for small things"),
        Choice::new(
            "Opus plan",
            "opusplan",
            "Plans with Opus, works with Sonnet",
        ),
    ]
}

/// Which of the choices above a model Claude Code named is.
///
/// The picker offers aliases — `opus[1m]` — and Claude Code reports whatever
/// that resolved to: `claude-opus-5[1m]` one week, `claude-haiku-4-5-20251001`
/// the next. Neither is any of the values above, so the picker matched nothing
/// and drew the word "Model" over a session that was plainly running something.
///
/// Matched on the family alone, which is the part that does not move. The
/// alternative is a table of resolved names, and that is the thing this avoids
/// having: a model released on a Tuesday would be absent from it, which is
/// exactly the case the picker was already getting wrong.
///
/// Long context is deliberately not part of the comparison. `claude-opus-5` and
/// `claude-opus-5[1m]` are both Opus and the label says "Opus" either way; it
/// is the note underneath, seen only when the menu is open, that mentions the
/// window. A right family beats a blank picker.
pub fn claude_choice_for(reported: &str) -> Option<String> {
    let family = family_of(reported)?;
    claude_models()
        .into_iter()
        .find(|choice| family_of(&choice.value) == Some(family))
        .map(|choice| choice.value)
}

/// The family a model name belongs to — the word before any version.
///
/// Reads an alias and a resolved name the same way, which is the point:
/// `opus[1m]`, `claude-opus-5` and `claude-opus-5[1m]` are all `opus`.
fn family_of(name: &str) -> Option<&str> {
    // The window suffix first, because it is the only part that is not
    // hyphen-separated and would otherwise ride along on the last segment.
    let name = name.split('[').next()?;
    let name = name.strip_prefix("claude-").unwrap_or(name);
    let family = name.split('-').next()?;
    (!family.is_empty()).then_some(family)
}

/// `bypassPermissions` is deliberately absent. It is a flag for a sandbox
/// somebody built on purpose rather than an item in a menu — and Claude Code
/// refuses it as root anyway, which is what the worker container runs as.
fn claude_modes() -> Vec<Choice> {
    vec![
        Choice::new("Auto", "auto", "Approves the ordinary, asks about the rest"),
        Choice::new("Ask everything", "default", "Nothing runs unasked"),
        Choice::new("Plan", "plan", "Explores and proposes, changes nothing"),
        Choice::new(
            "Accept edits",
            "acceptEdits",
            "Writes files without asking. Commands still ask",
        )
        .grave(),
        Choice::new(
            "Never ask",
            "dontAsk",
            "Refuses anything not already allowed, rather than asking",
        )
        .grave(),
    ]
}

/// All five the CLI takes, which is one more than this used to offer.
///
/// `xhigh` was missing, and it is the one a session here actually runs: nothing
/// passes `--effort` at launch, so Claude Code's own default applies, and its
/// default for coding is `xhigh`. So the menu both left out the level most of
/// this work wants and called the one below it "the usual" — a picker
/// describing a session that was never running.
fn claude_efforts() -> Vec<Choice> {
    vec![
        Choice::new("Low", "low", "Quick, for small things"),
        Choice::new("Medium", "medium", ""),
        Choice::new("High", "high", ""),
        Choice::new("Extra high", "xhigh", "The usual, for work like this"),
        Choice::new("Max", "max", "Slow, and as good as it gets"),
    ]
}

/// When Codex stops and asks.
///
/// Its own axis, separate from the fence below: this is when it comes to you,
/// and the fence is what it can do without needing to.
fn codex_modes() -> Vec<Choice> {
    vec![
        Choice::new(
            "Ask when needed",
            "on-request",
            "Asks when it wants to do something it is not allowed to",
        ),
        Choice::new(
            "Ask everything",
            "untrusted",
            "Asks before anything it was not already told it could do",
        ),
        Choice::new(
            "Never ask",
            "never",
            "Never asks. What it is not allowed to do simply fails",
        )
        .grave(),
    ]
}

/// What Codex may do at all.
///
/// Network is a switch rather than part of the fence, which is the row most
/// people actually want: a session that cannot install a dependency stops for
/// a reason nobody expects, and that costs nothing in write confinement.
fn codex_fences() -> Vec<Choice> {
    vec![
        Choice::new(
            "Workspace + network",
            SANDBOX_WORKSPACE_NETWORK,
            "Writes only where it is working, and can reach the internet",
        ),
        Choice::new(
            "Workspace",
            SANDBOX_WORKSPACE,
            "Writes only where it is working. No network",
        ),
        Choice::new(
            "Everything",
            SANDBOX_EVERYTHING,
            "No filesystem sandbox. Uses the worker’s available access",
        )
        .grave(),
    ]
}

pub const SANDBOX_WORKSPACE: &str = "workspace";
pub const SANDBOX_WORKSPACE_NETWORK: &str = "workspace+network";
pub const SANDBOX_EVERYTHING: &str = "everything";

/// What a session running this agent can be asked to change.
///
/// `models` is passed in because one agent knows its own and the other does
/// not: Codex lists them over its protocol, and a list written down here would
/// be out of date the week after.
pub fn for_agent(agent: crate::Agent, models: Vec<Choice>, efforts: Vec<Choice>) -> Vec<Control> {
    match agent {
        crate::Agent::ClaudeCode => vec![
            Control {
                kind: ControlKind::Model,
                fallback: "Model".into(),
                choices: claude_models(),
                current: None,
            },
            Control {
                kind: ControlKind::Mode,
                fallback: "Permissions".into(),
                choices: claude_modes(),
                current: None,
            },
            Control {
                kind: ControlKind::Effort,
                fallback: "Effort".into(),
                choices: claude_efforts(),
                current: None,
            },
        ],
        crate::Agent::Codex => {
            let mut controls = Vec::new();
            // Only once it has said. A picker with nothing in it is worse than
            // no picker, and the answer arrives a moment after the session
            // starts rather than with it.
            if !models.is_empty() {
                controls.push(Control {
                    kind: ControlKind::Model,
                    fallback: "Model".into(),
                    choices: models,
                    current: None,
                });
            }
            controls.push(Control {
                kind: ControlKind::Mode,
                fallback: "Permissions".into(),
                choices: codex_modes(),
                current: None,
            });
            if !efforts.is_empty() {
                controls.push(Control {
                    kind: ControlKind::Effort,
                    fallback: "Effort".into(),
                    choices: efforts,
                    current: None,
                });
            }
            controls.push(Control {
                kind: ControlKind::Sandbox,
                fallback: "Sandbox".into(),
                choices: codex_fences(),
                current: None,
            });
            controls
        }
        // Nothing to change about a shell.
        crate::Agent::KimiCode | crate::Agent::Shell => Vec::new(),
    }
}

/// What to send to put one into force, for the agent that is told rather than
/// asked.
///
/// `None` for a setting this agent has no way of being told about — Codex takes
/// all of these as parameters on its next turn instead.
///
/// Not all one shape. `/model` and `/effort` say "for this session only" and
/// mean it, so they are sent as input like anything else. The permission mode
/// is not a slash command at all: see [`crate::turn::permission_mode`] for what
/// happened to the session that was sent one.
pub fn put(agent: crate::Agent, kind: ControlKind, value: &str) -> Option<serde_json::Value> {
    match agent {
        crate::Agent::ClaudeCode => match kind {
            ControlKind::Model => Some(crate::turn::user_message(&format!("/model {value}"))),
            ControlKind::Mode => Some(crate::turn::permission_mode(value)),
            ControlKind::Effort => Some(crate::turn::user_message(&format!("/effort {value}"))),
            // It has no such thing.
            ControlKind::Sandbox => None,
        },
        crate::Agent::Codex | crate::Agent::KimiCode | crate::Agent::Shell => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bug this file exists for: a Codex session was offering Opus.
    #[test]
    fn one_agents_models_are_never_offered_for_another() {
        let claude = for_agent(crate::Agent::ClaudeCode, Vec::new(), Vec::new());
        let claude_models: Vec<_> = claude
            .iter()
            .filter(|c| c.kind == ControlKind::Model)
            .flat_map(|c| c.choices.iter().map(|ch| ch.value.as_str()))
            .collect();
        assert!(claude_models.contains(&"opus[1m]"));

        let codex = for_agent(crate::Agent::Codex, Vec::new(), Vec::new());
        assert!(
            !codex.iter().any(|c| c.kind == ControlKind::Model),
            "with no list from the agent, there is no model picker at all"
        );
        for control in &codex {
            for choice in &control.choices {
                assert!(!choice.value.contains("opus"), "{:?}", choice.value);
            }
        }
    }

    /// The bug this half exists for: the picker showed the word "Model" over a
    /// session that was visibly running one.
    #[test]
    fn a_model_claude_code_reported_is_matched_to_the_choice_it_answers_to() {
        // What it actually says: a resolved name, sometimes dated, sometimes
        // carrying the window.
        for (reported, expected) in [
            ("claude-opus-5[1m]", "opus[1m]"),
            ("claude-opus-5", "opus[1m]"),
            ("claude-sonnet-5", "sonnet[1m]"),
            ("claude-haiku-4-5-20251001", "haiku"),
            ("claude-fable-5-1", "fable[1m]"),
            // A value straight off the picker reads as itself, which is what
            // makes this safe to run over either.
            ("opus[1m]", "opus[1m]"),
        ] {
            assert_eq!(
                claude_choice_for(reported).as_deref(),
                Some(expected),
                "{reported}"
            );
        }
    }

    /// A family nothing here offers has no answer, rather than the nearest one.
    ///
    /// Codex's names go through the same function on a session that has both
    /// agents' history behind it, and quietly reading `gpt-5.6-sol` as Opus is
    /// the bug this file was written to end.
    #[test]
    fn a_model_from_somewhere_else_matches_nothing() {
        for reported in ["gpt-5.6-sol", "kimi-k2", "definitely-not-a-model", ""] {
            assert_eq!(claude_choice_for(reported), None, "{reported}");
        }
    }

    /// Every level the CLI takes, and no level it does not.
    ///
    /// `xhigh` is the one that was missing, and the one a session runs by
    /// default — see [`claude_efforts`].
    #[test]
    fn the_effort_levels_are_the_ones_the_cli_accepts() {
        let claude = for_agent(crate::Agent::ClaudeCode, Vec::new(), Vec::new());
        let efforts: Vec<_> = claude
            .iter()
            .filter(|c| c.kind == ControlKind::Effort)
            .flat_map(|c| c.choices.iter().map(|ch| ch.value.as_str()))
            .collect();
        assert_eq!(efforts, ["low", "medium", "high", "xhigh", "max"]);
    }

    /// Codex has a fence and Claude Code does not, so the picker exists for
    /// exactly one of them.
    #[test]
    fn only_the_agent_with_a_fence_is_asked_about_one() {
        let codex = for_agent(crate::Agent::Codex, Vec::new(), Vec::new());
        assert!(codex.iter().any(|c| c.kind == ControlKind::Sandbox));

        let claude = for_agent(crate::Agent::ClaudeCode, Vec::new(), Vec::new());
        assert!(!claude.iter().any(|c| c.kind == ControlKind::Sandbox));
    }

    /// A model list arriving is what makes the picker appear.
    #[test]
    fn codex_offers_what_it_said_it_had() {
        let models = vec![Choice::new("GPT-5.6", "gpt-5.6-sol", "The default")];
        let codex = for_agent(crate::Agent::Codex, models, Vec::new());

        let picker = codex
            .iter()
            .find(|c| c.kind == ControlKind::Model)
            .expect("a list means a picker");
        assert_eq!(picker.choices[0].value, "gpt-5.6-sol");
    }

    /// Sending Codex a slash command spends a turn and changes nothing, which
    /// is what it did before this existed.
    #[test]
    fn a_slash_command_is_only_ever_built_for_the_agent_that_reads_them() {
        let chosen = put(crate::Agent::ClaudeCode, ControlKind::Model, "opus[1m]")
            .expect("Claude Code is told which model to use");
        assert_eq!(chosen["message"]["content"][0]["text"], "/model opus[1m]");

        assert!(put(crate::Agent::Codex, ControlKind::Model, "gpt-5.6-sol").is_none());
        assert!(put(crate::Agent::ClaudeCode, ControlKind::Sandbox, "workspace").is_none());
    }

    /// The bug this half exists for: picking "Never ask" mid-conversation
    /// changed nothing at all.
    ///
    /// It was sent as `/config permissionMode=dontAsk`, which the agent answers
    /// with "Set Default permission mode to dontAsk" — a default for the next
    /// session. This one was given its mode as a command-line switch when
    /// Firetower started it, kept it, and went on asking.
    #[test]
    fn the_permission_mode_is_changed_in_the_session_that_is_running() {
        let chosen = put(crate::Agent::ClaudeCode, ControlKind::Mode, "dontAsk")
            .expect("Claude Code is told when to ask");

        assert_eq!(chosen["type"], "control_request");
        assert_eq!(chosen["request"]["subtype"], "set_permission_mode");
        assert_eq!(chosen["request"]["mode"], "dontAsk");

        // Two of them must not collide: the agent matches its answers by id.
        let again = put(crate::Agent::ClaudeCode, ControlKind::Mode, "dontAsk").unwrap();
        assert_ne!(chosen["request_id"], again["request_id"]);

        // And nothing about it is typed at the agent, which is what left the
        // running session alone.
        assert!(!chosen.to_string().contains("/config"));
    }

    /// Every mode offered is one the agent will take.
    ///
    /// Checked against the list it refuses an unknown one with: `acceptEdits,
    /// auto, bypassPermissions, default, dontAsk, plan`. A picker that offers a
    /// word the agent has never heard of is a control that silently does
    /// nothing, which is the fault this whole file is about.
    #[test]
    fn every_mode_offered_is_one_the_agent_knows() {
        const KNOWN: [&str; 6] = [
            "acceptEdits",
            "auto",
            "bypassPermissions",
            "default",
            "dontAsk",
            "plan",
        ];
        for choice in claude_modes() {
            assert!(
                KNOWN.contains(&choice.value.as_str()),
                "{} is not a permission mode Claude Code takes",
                choice.value
            );
        }
    }
}
